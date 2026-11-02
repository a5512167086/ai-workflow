//! 逐任務執行：實作 → 驗證 → 審查 → 修正 → handover → commit／等待人工測試。
use std::fs;
use std::path::Path;
use std::time::Duration;

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use unicode_normalization::UnicodeNormalization;

use crate::core::agents::{combine_reviews, run_agent, run_reviews, AgentOpts};
use crate::core::archive::archive_tasks;
use crate::core::backlog::update_item;
use crate::core::config::{cfg_str, load_config};
use crate::core::git;
use crate::core::home::with_lock;
use crate::core::config::saving_on;
use crate::core::prompts::{clip, code_review_prompt, diff_stat, fix_checks_prompt, fix_review_prompt, handover_prompt, implement_prompt, strip_outer_fence, MAX_DIFF_CHARS};
use crate::core::savings::{filter_review_diff, saved};
use crate::core::proc::{run_shell, RunOpts};
use crate::core::queue::{acquire_slot, release};
use crate::core::state::{append_log, handover_file, is_pid_alive_value, pid_of, read_state, task_dir, task_state, update_state};
use crate::core::tasks;
use crate::core::util::{js_string, now_iso, resolve};
use crate::core::{AppError, Result};

const RUN_SCOPE: &str = "runner";

pub fn feature_branch(cfg: &Value, state: &Value) -> String {
    let feature = cfg_str(cfg, "feature");
    let idea = state["prd"]["idea"].as_str().unwrap_or("");
    let base = if !feature.is_empty() { feature } else if !idea.is_empty() { idea } else { "feature" };
    let lowered: String = base.to_lowercase().nfkd().collect();
    let mut slug = String::new();
    for c in lowered.chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let slug = if slug.is_empty() { "feature".to_string() } else { slug };
    format!("{}{slug}", cfg_str(cfg, "branch_prefix"))
}

fn set_pipeline(root: &Path, status: &str, reason: &str, extra: Value) -> Result<()> {
    update_state(root, |s| {
        s["pipeline"]["status"] = json!(status);
        s["pipeline"]["reason"] = json!(reason);
        for (k, v) in extra.as_object().into_iter().flatten() {
            s["pipeline"][k] = v.clone();
        }
    })?;
    append_log(root, RUN_SCOPE, &format!("流程狀態：{status}{}", if reason.is_empty() { String::new() } else { format!("（{reason}）") }));
    Ok(())
}

fn set_task(root: &Path, id: &str, patch: Value) -> Result<()> {
    update_state(root, |s| {
        let t = task_state(s, id);
        for (k, v) in patch.as_object().unwrap() {
            t[k] = v.clone();
        }
    })
}

struct Check {
    name: &'static str,
    cmd: String,
    ok: bool,
    output: String,
}

fn tail_chars(s: &str, n: usize) -> String {
    let len = s.chars().count();
    s.chars().skip(len.saturating_sub(n)).collect()
}

/// 依序跑 build → lint → test；全部跑完再回報，讓修正時一次看到所有錯誤。
fn run_checks(root: &Path, cfg: &Value, id: &str, scope: &str) -> Result<(bool, Vec<Check>)> {
    let mut results = Vec::new();
    let mut parts = Vec::new();
    // 沒有手動設定任何指令時，每次驗證前重新從專案偵測（加入專案時資料夾可能還是空的，任務建出 package.json 後才有指令）。
    let configured = ["build", "lint", "test"].iter().any(|k| cfg["commands"][k].as_str().is_some_and(|c| !c.is_empty()));
    let commands = if configured { cfg["commands"].clone() } else { crate::core::init::detect_commands(root) };
    if !configured && ["build", "lint", "test"].iter().any(|k| commands[k].as_str().is_some_and(|c| !c.is_empty())) {
        append_log(root, scope, &format!("沒有設定驗證指令，自動偵測到：{}", ["build", "lint", "test"].iter().filter_map(|k| commands[k].as_str().filter(|c| !c.is_empty()).map(|c| format!("{k}={c}"))).collect::<Vec<_>>().join("、")));
    }
    for name in ["build", "lint", "test"] {
        let Some(cmd) = commands[name].as_str().filter(|c| !c.is_empty()) else { continue };
        set_task(root, id, json!({ "step": format!("執行 {name}") }))?;
        append_log(root, scope, &format!("$ {cmd}"));
        let mut log = |d: &str| append_log(root, scope, d.trim_end());
        let mut log2 = |d: &str| append_log(root, scope, d.trim_end());
        let res = run_shell(cmd, RunOpts {
            cwd: Some(root), timeout_sec: cfg["command_timeout_sec"].as_u64().unwrap_or(900), on_stdout: Some(&mut log), on_stderr: Some(&mut log2), ..Default::default()
        })?;
        let ok = res.code == 0;
        let output = format!("{}\n{}", res.stdout, res.stderr).trim().to_string();
        append_log(root, scope, &format!("{name}：{}", if ok { "通過".to_string() } else { format!("失敗（結束碼 {}{}）", res.code, if res.timed_out { "，逾時" } else { "" }) }));
        parts.push(format!("## {name}: {} (`{cmd}`, exit {})\n{}", if ok { "PASS" } else { "FAIL" }, res.code, tail_chars(&output, 20000)));
        results.push(Check { name, cmd: cmd.to_string(), ok, output });
    }
    let text = if parts.is_empty() { "（未設定 build/test/lint 指令，略過）".to_string() } else { parts.join("\n\n") };
    fs::write(task_dir(root, id)?.join("checks.txt"), text)?;
    Ok((results.iter().all(|r| r.ok), results))
}

/// 任務卡住（需要人工處理）與其他錯誤分開：前者停在 stuck，後者讓整個流程進入 error。
enum TaskError {
    Stuck(String),
    Fatal(AppError),
}

impl From<AppError> for TaskError {
    fn from(e: AppError) -> Self {
        TaskError::Fatal(e)
    }
}

fn skills_for(cfg: &Value, stage: &str, task: &Value) -> Vec<String> {
    cfg["skills"][stage].as_array().into_iter().flatten().chain(task["skills"].as_array().into_iter().flatten()).filter_map(|v| v.as_str().map(String::from)).collect()
}

/// 程式碼審查的 prompt 與節省紀錄。review_diff_filter：lockfile 與產生檔只留檔名（比較截斷後實際會送出的長度）。
fn review_prompt(cfg: &Value, task: &Value, diff: &str, summary: &str) -> (String, Vec<Value>) {
    if !saving_on(cfg, "review_diff_filter") {
        return (code_review_prompt(task, diff, summary), vec![]);
    }
    let (filtered, skipped) = filter_review_diff(diff);
    let savings = if skipped.is_empty() { vec![] } else { saved("review_diff_filter", &clip(diff, MAX_DIFF_CHARS), &clip(&filtered, MAX_DIFF_CHARS)).into_iter().collect() };
    (code_review_prompt(task, &filtered, summary), savings)
}

/// run_agent 的捷徑：角色換成 cfg.roles 裡的 provider。
#[allow(clippy::too_many_arguments)]
fn agent(root: &Path, cfg: &Value, role: &str, prompt: String, write: bool, scope: &str, label: &str, stage: &str, skills: Option<Vec<String>>, saved: Vec<Value>) -> Result<crate::core::agents::AgentResult> {
    run_agent(AgentOpts { root, cfg, provider: cfg_str(&cfg["roles"], role), prompt, write, scope, label, stage: Some(stage), skills, role: Some(role), saved })
}

/// 執行單一任務：實作 → 驗證 → 審查 → 修正（最多 max_fix_rounds 輪）→ 更新 handover →
/// 自動模式 commit + done；手動模式停在「等待測試」。
fn run_task(root: &Path, cfg: &Value, id: &str, verify_only: bool) -> std::result::Result<&'static str, TaskError> {
    let scope = format!("task-{id}");
    let scope = scope.as_str();
    let Some(task) = tasks::find_task(root, id)? else { return Err(AppError::new(format!("tasks.json 找不到任務 {id}")).into()) };
    let dir = task_dir(root, id)?;
    let prev = read_state(root)["tasks"][id].clone();
    if !verify_only {
        // 新的一次嘗試：清掉上一次的審查與驗證紀錄，避免 UI 顯示過期內容（log 保留）。
        for entry in fs::read_dir(&dir).map_err(AppError::from)? {
            let _ = fs::remove_file(entry.map_err(AppError::from)?.path());
        }
    }
    let base_tree = match prev["base_tree"].as_str().filter(|b| verify_only && !b.is_empty()) {
        Some(b) => b.to_string(),
        None => git::snapshot_tree(root)?,
    };
    let title = task["title"].as_str().unwrap_or("").to_string();
    update_state(root, |s| {
        let t = task_state(s, id);
        let attempts = t["attempts"].as_u64().unwrap_or(0) + if verify_only { 0 } else { 1 };
        for (k, v) in [
            ("title", json!(title)), ("phase", json!("implementing")), ("step", json!(if verify_only { "重新驗證" } else { "實作中" })),
            ("fix_round", json!(0)), ("attempts", json!(attempts)), ("base_tree", json!(base_tree)), ("started_at", json!(now_iso())),
            ("finished_at", Value::Null), ("error", json!("")), ("review_verdict", Value::Null), ("last_check_ok", Value::Null),
        ] {
            t[k] = v;
        }
        s["pipeline"]["current_task"] = json!(id);
    })?;
    append_log(root, scope, &format!("═══ 任務 {id}：{title} ═══"));
    tasks::set_status(root, id, "in-progress")?;

    let mut notes = String::new();
    let mut implement_denied: Vec<String> = Vec::new();
    if !verify_only {
        let (implement, implement_saved) = implement_prompt(root, cfg, &task);
        let impl_ = agent(root, cfg, "implementer", implement, true, scope, &format!("實作任務 {id}"), "implement", Some(skills_for(cfg, "implement", &task)), implement_saved)?;
        if !impl_.ok {
            return Err(TaskError::Stuck(format!("實作 AI 失敗：{}", impl_.error_text())));
        }
        implement_denied = impl_.denied.clone();
        notes = impl_.text;
        fs::write(dir.join("implement.md"), &notes).map_err(AppError::from)?;
    }

    let max_fix = cfg["max_fix_rounds"].as_u64().unwrap_or(3);
    let mut round = 0u64;
    loop {
        set_task(root, id, json!({ "phase": "implementing", "step": "驗證中", "fix_round": round }))?;
        let (ok, results) = run_checks(root, cfg, id, scope)?;
        set_task(root, id, json!({ "last_check_ok": ok }))?;
        if !ok {
            if round >= max_fix {
                return Err(TaskError::Stuck(format!("驗證失敗且修正輪數已用盡（{max_fix}）")));
            }
            round += 1;
            set_task(root, id, json!({ "step": format!("修正驗證錯誤（第 {round} 輪）"), "fix_round": round }))?;
            let failed: Vec<String> = results.iter().filter(|r| !r.ok).map(|r| format!("## {} (`{}`)\n{}", r.name, r.cmd, tail_chars(&r.output, 15000))).collect();
            let fix = agent(root, cfg, "fixer", fix_checks_prompt(root, cfg, &task, &failed.join("\n\n"), round), true, scope, &format!("修正驗證錯誤 第 {round} 輪"), "fix", Some(skills_for(cfg, "fix", &task)), vec![])?;
            if !fix.ok {
                return Err(TaskError::Stuck(format!("修正 AI 失敗：{}", fix.error_text())));
            }
            notes.push_str(&format!("\n\n### 修正第 {round} 輪\n{}", fix.text));
            continue;
        }

        set_task(root, id, json!({ "phase": "reviewing", "step": "程式碼審查中" }))?;
        tasks::set_status(root, id, "review")?;
        let diff = git::diff_trees(root, &base_tree, &git::snapshot_tree(root)?)?;
        fs::write(dir.join("diff.patch"), &diff).map_err(AppError::from)?;
        // 實作完全沒有改動時不送審查：審查只會一直判不通過，白白用掉修正輪數。最常見的原因是指令被權限擋下。
        if diff.is_empty() && !verify_only && round == 0 && !implement_denied.is_empty() {
            return Err(TaskError::Stuck(format!("實作 AI 的工具呼叫被權限擋下（{}），沒有產生任何變更，已停止，不送審查。Claude 請確認全域設定 config.json 的 claude.write_permission_mode 是 auto，或在 claude.allowed_tools 加入需要的指令；也可以自己完成這一步後按「我測完了，繼續」", implement_denied.join("、"))));
        }
        let summary = if results.is_empty() { "- 未設定驗證指令".to_string() } else { results.iter().map(|r| format!("- {}: PASS", r.name)).collect::<Vec<_>>().join("\n") };
        let shown = if diff.is_empty() { "（沒有任何變更）" } else { &diff };
        let label = format!("程式碼審查 第 {} 次", round + 1);
        let (prompt, review_saved) = review_prompt(cfg, &task, shown, &summary);
        let reviews = run_reviews(AgentOpts {
            root, cfg, provider: "", prompt, write: false, scope, label: &label,
            stage: Some("code_review"), skills: Some(skills_for(cfg, "code_review", &task)), role: Some("code_reviewer"), saved: review_saved,
        }, &["PASS"]).map_err(|e| TaskError::Stuck(e.message))?;
        // 雙人審查時每個 AI 一個檔案（review-<n>-<ai>.md），兩份都 PASS 才算通過。
        let mut verdicts = json!({});
        for r in &reviews {
            let name = if reviews.len() > 1 { format!("review-{}-{}.md", round + 1, r.provider) } else { format!("review-{}.md", round + 1) };
            fs::write(dir.join(name), &r.text).map_err(AppError::from)?;
            verdicts[r.provider.as_str()] = json!(r.verdict);
        }
        let pass = reviews.iter().all(|r| r.pass);
        let verdict = if reviews.len() == 1 { reviews[0].verdict.clone() } else if pass { "PASS".into() } else { "FAIL".into() };
        set_task(root, id, json!({ "review_verdict": verdict, "review_verdicts": verdicts, "reviews": round + 1 }))?;
        if pass {
            break;
        }
        if round >= max_fix {
            return Err(TaskError::Stuck(format!("審查未通過且修正輪數已用盡（{max_fix}）")));
        }
        round += 1;
        set_task(root, id, json!({ "phase": "implementing", "step": format!("處理審查意見（第 {round} 輪）"), "fix_round": round }))?;
        let fix = agent(root, cfg, "fixer", fix_review_prompt(root, cfg, &task, &combine_reviews(&reviews), round), true, scope, &format!("處理審查意見 第 {round} 輪"), "fix", Some(skills_for(cfg, "fix", &task)), vec![])?;
        if !fix.ok {
            return Err(TaskError::Stuck(format!("修正 AI 失敗：{}", fix.error_text())));
        }
        notes.push_str(&format!("\n\n### 處理審查意見第 {round} 輪\n{}", fix.text));
    }

    set_task(root, id, json!({ "phase": "reviewing", "step": "更新 handover" }))?;
    let full = git::diff_trees(root, &base_tree, &git::snapshot_tree(root)?)?;
    // handover 不在專案裡：AI 以唯讀方式輸出新版內容，由這裡寫進專案資料目錄。
    let ho = agent(root, cfg, "handover", handover_prompt(root, &task, &notes, &diff_stat(&full)), false, scope, "更新 handover", "handover", None, vec![])?;
    let handover_text = strip_outer_fence(&ho.text);
    if !ho.ok || handover_text.trim().is_empty() {
        append_log(root, scope, &format!("⚠ handover 更新失敗：{}（不影響任務結果）", if ho.ok { "AI 沒有輸出內容".to_string() } else { ho.error_text() }));
    } else {
        fs::write(handover_file(root), &handover_text).map_err(AppError::from)?;
        append_log(root, scope, &format!("handover 已更新：{}", handover_file(root).display()));
    }

    let fresh = load_config(root)?;
    if cfg_str(&fresh, "mode") == "auto" {
        set_task(root, id, json!({ "step": "git commit" }))?;
        // commit 失敗時回到 review；任務狀態另存於本機引擎與功能封存。
        tasks::set_status(root, id, "done")?;
        let sha = match git::commit_all(root, &format!("ai-workflow: task {id} {title}")) {
            Ok(sha) => sha,
            Err(err) => {
                tasks::set_status(root, id, "review")?;
                return Err(TaskError::Stuck(err.message));
            }
        };
        append_log(root, scope, &sha.as_ref().map(|s| format!("已 commit {}", &s[..8.min(s.len())])).unwrap_or_else(|| "沒有變更可 commit".into()));
        set_task(root, id, json!({ "phase": "done", "step": "完成", "commit": sha, "finished_at": now_iso() }))?;
        return Ok("done");
    }
    set_task(root, id, json!({ "phase": "awaiting_test", "step": "等待人工測試", "finished_at": now_iso() }))?;
    Ok("awaiting_test")
}

fn root_key(root: &Path) -> String {
    hex::encode(Sha256::digest(resolve(root).to_string_lossy().to_lowercase().as_bytes()))
}

fn acquire_runner(root: &Path) -> Result<()> {
    with_lock(&format!("runner-{}", root_key(root)), || {
        let s = read_state(root);
        if is_pid_alive_value(&s["runner"]["pid"]) {
            crate::bail!("已有 ai-workflow run 在執行（pid {}）", js_string(&s["runner"]["pid"]));
        }
        update_state(root, |st| {
            st["runner"] = json!({ "pid": std::process::id(), "started_at": now_iso() });
            st["control"]["pause_requested"] = json!(false);
        })
    })
}

fn release_runner(root: &Path) -> Result<()> {
    update_state(root, |st| {
        if pid_of(&st["runner"]["pid"]) == Some(std::process::id()) {
            st["runner"] = json!({ "pid": null, "started_at": null });
        }
        if ["running", "queued"].contains(&st["pipeline"]["status"].as_str().unwrap_or("")) {
            st["pipeline"]["status"] = json!("idle");
        }
    })
}

fn pause_requested(root: &Path) -> bool {
    read_state(root)["control"]["pause_requested"] == true
}

/// 主迴圈。停下來的時機：手動模式每個任務完成後（等待測試）；自動模式全部任務完成（功能待測試）；
/// 兩種模式在修正輪數用盡／AI 失敗、使用者按暫停時也會停。回傳最後的流程狀態。
pub fn run_pipeline(root: &Path, first_task: Option<&str>, verify_only: bool) -> Result<String> {
    run_pipeline_with_provider(root, first_task, verify_only, None)
}

pub fn run_pipeline_with_provider(root: &Path, first_task: Option<&str>, verify_only: bool, provider: Option<&str>) -> Result<String> {
    if provider.is_some_and(|p| !["claude", "codex"].contains(&p)) {
        crate::bail!("本次執行的 AI 必須是 claude 或 codex");
    }
    acquire_runner(root)?;
    let result = pipeline_loop(root, first_task, verify_only, provider);
    if let Err(err) = &result {
        let _ = set_pipeline(root, "error", &err.message, json!({}));
    }
    let _ = release(std::process::id());
    let _ = release_runner(root);
    if let Err(err) = archive_tasks(root, json!({})) {
        append_log(root, RUN_SCOPE, &format!("⚠ 封存任務清單失敗：{}", err.message));
    }
    result
}

fn pipeline_loop(root: &Path, first_task: Option<&str>, verify_only: bool, provider: Option<&str>) -> Result<String> {
    let mut cfg = load_config(root)?;
    if let Some(p) = provider {
        append_log(root, RUN_SCOPE, &format!("使用者確認：本次執行僅使用 {p}，實作與審查使用獨立 session；原始角色設定不變"));
    }
    let state = read_state(root);
    if state["prd"]["status"] != "approved" {
        crate::bail!("PRD 尚未核准");
    }
    if tasks::read_tasks(root)?.is_empty() {
        crate::bail!("還沒有任務，請先執行 ai-workflow tasks");
    }
    if let Some(waiting) = state["tasks"].as_object().into_iter().flat_map(|m| m.values()).find(|t| t["phase"] == "awaiting_test") {
        set_pipeline(root, "waiting", &format!("任務 {} 等待人工測試，測完請按「我測完了，繼續」", js_string(&waiting["id"])), json!({}))?;
        return Ok("waiting".into());
    }

    crate::core::human::require_task_approval(root)?;

    // 全域佇列：其他專案正在跑時在這裡排隊；排隊中按暫停就放棄排隊。
    let granted = acquire_slot(root, |position, running| {
        let names: Vec<String> = running.iter().filter_map(|e| e["root"].as_str()).map(|r| Path::new(r).file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()).collect();
        let _ = set_pipeline(root, "queued", &format!("排隊第 {position} 位{}", if names.is_empty() { String::new() } else { format!("，執行中：{}", names.join("、")) }), json!({}));
    }, || pause_requested(root), Duration::from_millis(1500))?;
    if !granted {
        update_state(root, |s| s["control"]["pause_requested"] = json!(false))?;
        set_pipeline(root, "paused", "使用者在排隊時暫停", json!({}))?;
        return Ok("paused".into());
    }

    if cfg_str(&cfg, "mode") == "auto" {
        if !git::has_identity(root)? {
            crate::bail!("自動模式需要 git 使用者身分：請先設定 git config user.name 與 user.email");
        }
        let branch = git::ensure_feature_branch(root, &feature_branch(&cfg, &state))?;
        append_log(root, RUN_SCOPE, &format!("自動模式：在分支 {branch} 上工作"));
    }
    set_pipeline(root, "running", "", json!({ "mode": cfg["mode"] }))?;

    let mut pending = first_task.map(String::from);
    loop {
        cfg = load_config(root)?;
        cfg["_run_provider"] = json!(provider);
        if pause_requested(root) {
            update_state(root, |s| s["control"]["pause_requested"] = json!(false))?;
            set_pipeline(root, "paused", "使用者暫停", json!({}))?;
            return Ok("paused".into());
        }
        let once = verify_only && pending.is_some();
        let next = match pending.take() {
            Some(id) => Some(id),
            None => tasks::next_task_id(root)?,
        };
        let Some(id) = next else {
            let all = tasks::read_tasks(root)?;
            let open = all.iter().filter(|t| !["done", "cancelled", "deferred"].contains(&t["status"].as_str().unwrap_or(""))).count();
            if open == 0 {
                set_pipeline(root, "feature_test", "所有任務完成，請進行功能測試", json!({ "current_task": null }))?;
                return Ok("feature_test".into());
            }
            set_pipeline(root, "stuck", &format!("沒有可執行的任務（剩 {open} 個未完成，可能卡在依賴或 blocked）"), json!({}))?;
            return Ok("stuck".into());
        };
        match run_task(root, &cfg, &id, once) {
            Ok("awaiting_test") => {
                set_pipeline(root, "waiting", &format!("任務 {id} 完成，等待人工測試"), json!({}))?;
                return Ok("waiting".into());
            }
            Ok(_) => {}
            Err(TaskError::Stuck(message)) => {
                set_task(root, &id, json!({ "phase": "stuck", "step": "需要人工處理", "error": message }))?;
                append_log(root, &format!("task-{id}"), &format!("✖ {message}"));
                set_pipeline(root, "stuck", &format!("任務 {id}：{message}"), json!({}))?;
                return Ok("stuck".into());
            }
            Err(TaskError::Fatal(err)) => return Err(err),
        }
    }
}

pub enum Next {
    Run,
    Verify(String),
    Done,
}

/// 「我測完了，繼續」：手動模式等待測試的任務 → done；功能待測試 → 流程結束；
/// 卡住的任務 → 使用者處理過後重新驗證（不重新實作），修正輪數重新計算。
pub fn acknowledge(root: &Path) -> Result<Next> {
    let state = read_state(root);
    let all: Vec<Value> = state["tasks"].as_object().map(|m| m.values().cloned().collect()).unwrap_or_default();
    let waiting: Vec<&Value> = all.iter().filter(|t| t["phase"] == "awaiting_test").collect();
    for t in &waiting {
        let id = js_string(&t["id"]);
        tasks::set_status(root, &id, "done")?;
        set_task(root, &id, json!({ "phase": "done", "step": "人工測試通過" }))?;
        append_log(root, &format!("task-{id}"), "使用者確認測試通過");
    }
    if state["pipeline"]["status"] == "feature_test" {
        set_pipeline(root, "complete", "功能已完成並通過人工測試", json!({}))?;
        finish_feature(root);
        return Ok(Next::Done);
    }
    // 卡住的任務，或流程出錯時停在半途的任務（runner 已不在）：重新驗證與審查。
    let runner_alive = is_pid_alive_value(&state["runner"]["pid"]);
    let stuck = all.iter().find(|t| t["phase"] == "stuck" || (!runner_alive && ["implementing", "reviewing"].contains(&t["phase"].as_str().unwrap_or(""))));
    if let (Some(t), true) = (stuck, waiting.is_empty()) {
        return Ok(Next::Verify(js_string(&t["id"])));
    }
    set_pipeline(root, "idle", "", json!({}))?;
    Ok(Next::Run)
}

/// 功能完成：封存最後的任務清單，並把對應的待辦項目標成完成。
fn finish_feature(root: &Path) {
    let s = read_state(root);
    let result = (|| -> Result<()> {
        archive_tasks(root, json!({ "completed_at": now_iso() }))?;
        if let Some(id) = s["prd"]["backlog_id"].as_str().filter(|i| !i.is_empty()) {
            let mut patch = json!({ "status": "done" });
            if let Some(dir) = s["prd"]["archive_dir"].as_str().filter(|d| !d.is_empty()) {
                patch["feature"] = json!(dir);
            }
            update_item(root, id, &patch)?;
        }
        Ok(())
    })();
    if let Err(err) = result {
        append_log(root, RUN_SCOPE, &format!("⚠ 功能完成後的封存／待辦更新失敗：{}", err.message));
    }
}

pub fn request_pause(root: &Path) -> Result<()> {
    update_state(root, |s| s["control"]["pause_requested"] = json!(true))?;
    append_log(root, RUN_SCOPE, "已要求暫停：目前任務結束後停下");
    Ok(())
}

/// 重跑任務。revert 時：自動模式 git revert 該任務的 commit；手動模式把該任務改過的檔案還原到任務開始前。
pub fn prepare_rerun(root: &Path, id: &str, revert: bool) -> Result<()> {
    let state = read_state(root);
    let t = state["tasks"][id].clone();
    if is_pid_alive_value(&state["runner"]["pid"]) {
        crate::bail!("流程執行中，請先暫停");
    }
    // 先改任務狀態：依賴此任務的任務還沒重設時在這裡就擋下，不會留下多餘的 revert commit。
    tasks::set_status(root, id, "pending")?;
    if revert && t.is_object() {
        if let Some(commit) = t["commit"].as_str().filter(|c| !c.is_empty()) {
            // 流程資料都在專案資料目錄，不會被 revert 影響；只有舊 Task Master 的檔案要保留目前狀態。
            let keep = vec![".taskmaster/tasks/tasks.json".to_string()];
            let sha = git::revert_commit(root, commit, &keep)?.unwrap_or_default();
            append_log(root, &format!("task-{id}"), &format!("已 revert {} → {}", &commit[..8.min(commit.len())], &sha[..8.min(sha.len())]));
        } else if let Some(base) = t["base_tree"].as_str().filter(|b| !b.is_empty()) {
            git::restore_to_tree(root, base)?;
            append_log(root, &format!("task-{id}"), "已把此任務改過的檔案還原到任務開始前的狀態");
        }
    }
    update_state(root, |s| {
        let ts = task_state(s, id);
        for (k, v) in [("phase", json!("pending")), ("step", json!("等待重跑")), ("commit", Value::Null), ("error", json!("")), ("fix_round", json!(0))] {
            ts[k] = v;
        }
        if ["stuck", "waiting"].contains(&s["pipeline"]["status"].as_str().unwrap_or("")) {
            s["pipeline"]["status"] = json!("idle");
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::default_config;

    #[test]
    fn feature_branch_產生安全的分支名稱() {
        let mut cfg = default_config();
        cfg["feature"] = json!("CSV Export!");
        assert_eq!(feature_branch(&cfg, &json!({ "prd": {} })), "ai-workflow/csv-export");
        assert_eq!(feature_branch(&default_config(), &json!({ "prd": { "idea": "中文想法" } })), "ai-workflow/feature");
    }
}
