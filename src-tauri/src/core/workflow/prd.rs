//! PRD 起草、交叉審查、修訂與核准。各版 PRD 與審查意見放在專案資料目錄的 prd/。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::agents::{combine_reviews, run_agent, run_reviews, AgentOpts};
use crate::core::archive::{archive_prd, archive_tasks};
use crate::core::config::cfg_str;
use crate::core::prompts::{prd_draft_prompt, prd_review_prompt, prd_revise_prompt, strip_outer_fence};
use crate::core::state::{append_log, data_dir, is_pid_alive, pid_of, prd_file, read_state, update_state};
use crate::core::util::{now_iso, read_text};
use crate::core::Result;

const SCOPE: &str = "prd";

fn prd_dir(root: &Path) -> PathBuf {
    data_dir(root).join("prd")
}

pub fn current_prd(root: &Path) -> String {
    read_text(prd_dir(root).join("current.md"))
}

fn save_version(root: &Path, text: &str) -> Result<u64> {
    let v = read_state(root)["prd"]["version"].as_u64().unwrap_or(0) + 1;
    fs::create_dir_all(prd_dir(root))?;
    fs::write(prd_dir(root).join(format!("v{v}.md")), text)?;
    fs::write(prd_dir(root).join("current.md"), text)?;
    update_state(root, |s| s["prd"]["version"] = json!(v))?;
    Ok(v)
}

fn add_round(root: &Path, mut entry: Value) -> Result<()> {
    entry["at"] = json!(now_iso());
    update_state(root, |s| {
        if !s["prd"]["rounds"].is_array() {
            s["prd"]["rounds"] = json!([]);
        }
        s["prd"]["rounds"].as_array_mut().unwrap().push(entry);
    })
}

fn set_prd_status(root: &Path, status: &str) -> Result<()> {
    update_state(root, |s| s["prd"]["status"] = json!(status))
}

fn author(root: &Path, cfg: &Value, prompt: String, label: &str) -> Result<(String, String)> {
    let res = run_agent(AgentOpts { root, cfg, provider: cfg_str(&cfg["roles"], "author"), prompt, write: false, scope: SCOPE, label, stage: Some("prd"), skills: None, role: Some("author"), saved: vec![] })?;
    let text = strip_outer_fence(&res.text);
    if !res.ok || text.is_empty() {
        crate::bail!("作者 AI 失敗：{}", res.error.unwrap_or_else(|| "沒有輸出".into()));
    }
    Ok((text, res.provider))
}

/// 審查→修訂來回，最多 max_prd_rounds 輪；審查通過就提早結束。最後一律停在 awaiting_approval 等人核准。
fn review_loop(root: &Path, cfg: &Value) -> Result<()> {
    let max = cfg["max_prd_rounds"].as_u64().unwrap_or(2);
    for _ in 1..=max {
        let round = read_state(root)["prd"]["round"].as_u64().unwrap_or(0) + 1;
        update_state(root, |s| {
            s["prd"]["round"] = json!(round);
            s["prd"]["status"] = json!("reviewing");
        })?;
        let prd = current_prd(root);
        let label = format!("PRD 審查 第 {round} 輪");
        let reviews = run_reviews(AgentOpts {
            root, cfg, provider: "", prompt: prd_review_prompt(root, cfg, &prd, round),
            write: false, scope: SCOPE, label: &label, stage: Some("prd_review"), skills: None, role: Some("reviewer"), saved: vec![],
        }, &["APPROVE"])?;
        let version = read_state(root)["prd"]["version"].clone();
        for r in &reviews {
            // 雙人審查時每個 AI 一個檔案。
            let review_file = if reviews.len() > 1 { format!("review-{round}-{}.md", r.provider) } else { format!("review-{round}.md") };
            fs::write(prd_dir(root).join(&review_file), &r.text)?;
            add_round(root, json!({ "kind": "review", "round": round, "provider": r.provider, "verdict": r.verdict, "version": version, "file": review_file }))?;
        }
        if reviews.iter().all(|r| r.pass) {
            append_log(root, SCOPE, &format!("審查者核可（第 {round} 輪）"));
            break;
        }
        set_prd_status(root, "revising")?;
        let (text, provider) = author(root, cfg, prd_revise_prompt(root, cfg, &prd, &combine_reviews(&reviews), "審查者"), &format!("PRD 修訂 第 {round} 輪"))?;
        let v = save_version(root, &text)?;
        add_round(root, json!({ "kind": "revise", "round": round, "provider": provider, "version": v, "file": format!("v{v}.md") }))?;
    }
    set_prd_status(root, "awaiting_approval")?;
    append_log(root, SCOPE, "等待使用者在 UI 核准 PRD（或執行 ai-workflow prd --approve）");
    Ok(())
}

fn guard(root: &Path) -> Result<()> {
    let s = read_state(root);
    let busy = ["drafting", "reviewing", "revising"].contains(&s["prd"]["status"].as_str().unwrap_or(""));
    if let Some(pid) = pid_of(&s["prd"]["pid"]).filter(|p| busy && *p != std::process::id()) {
        if is_pid_alive(pid) {
            crate::bail!("PRD 流程已在執行中");
        }
    }
    // started_at 給 UI 顯示「AI 處理中（已 N 秒）」。
    update_state(root, |st| { st["prd"]["pid"] = json!(std::process::id()); st["prd"]["started_at"] = json!(now_iso()); })
}

/// PRD 程序被強制結束（關閉 dev 視窗、重新建置、工作管理員結束）時沒機會收尾，狀態會一直停在
/// drafting／reviewing／revising。讀狀態時發現程序已不在，就恢復成可操作的狀態並說明原因。
/// 回傳 true 表示有修正。
pub fn recover_interrupted(root: &Path) -> Result<bool> {
    let s = read_state(root);
    let status = s["prd"]["status"].as_str().unwrap_or("").to_string();
    if !["drafting", "reviewing", "revising"].contains(&status.as_str()) { return Ok(false); }
    match pid_of(&s["prd"]["pid"]) {
        Some(pid) if is_pid_alive(pid) => return Ok(false),
        Some(_) => {}
        None => return Ok(false), // 還沒寫入 pid：程序剛啟動，交給它自己處理
    }
    let has_prd = !current_prd(root).is_empty();
    let step = match status.as_str() { "drafting" => "起草", "reviewing" => "審查", _ => "修訂" };
    let message = if has_prd {
        format!("PRD {step}時程序已結束（可能是 App 重新啟動或程序被關閉），已保留目前版本。可按「只重新審查目前版本」或附意見「要求再改」繼續。")
    } else {
        format!("PRD {step}時程序已結束（可能是 App 重新啟動或程序被關閉），請重新從需求待辦開始起草。")
    };
    let changed = update_state(root, |st| {
        // 在鎖內重新確認，避免和剛啟動的新程序搶狀態。
        if st["prd"]["status"] != status || pid_of(&st["prd"]["pid"]).is_some_and(is_pid_alive) { return false; }
        st["prd"]["status"] = json!(if has_prd { "awaiting_approval" } else { "none" });
        st["prd"]["error"] = json!(message);
        st["prd"]["pid"] = Value::Null;
        true
    })?;
    if changed { append_log(root, SCOPE, &format!("⚠ {message}")); }
    Ok(changed)
}

fn with_error_state(root: &Path, f: impl FnOnce() -> Result<()>) -> Result<()> {
    let result = f();
    if let Err(err) = &result {
        let has_prd = !current_prd(root).is_empty();
        let message = err.message.clone();
        update_state(root, |s| {
            s["prd"]["status"] = json!(if has_prd { "awaiting_approval" } else { "none" });
            s["prd"]["error"] = json!(message);
        })?;
        append_log(root, SCOPE, &format!("錯誤：{}", err.message));
    }
    update_state(root, |s| s["prd"]["pid"] = Value::Null)?;
    result
}

pub fn draft_prd(root: &Path, cfg: &Value, idea: &str, backlog_id: Option<&str>) -> Result<()> {
    let confirmed;
    let idea=if let Some(id)=backlog_id { confirmed=crate::core::requirements::prd_input(root,&crate::core::backlog::get_item(root,id)?)?; confirmed.as_str() } else { idea };
    guard(root)?;
    // 開始新功能前，把上一個功能最後的任務狀態寫進它的封存；之後 archive_dir 清空，核准時會建新的資料夾。
    if let Err(err) = archive_tasks(root, json!({})) {
        append_log(root, SCOPE, &format!("⚠ 封存上一個功能的任務清單失敗：{}", err.message));
    }
    let references=if let Some(id)=backlog_id { crate::core::references::ids(root,&crate::core::backlog::get_item(root,id)?["references"])? } else { vec![] };
    with_error_state(root, || {
        update_state(root, |s| {
            for (k, v) in [
                ("status", json!("drafting")), ("idea", json!(idea)), ("round", json!(0)), ("rounds", json!([])), ("version", json!(0)),
                ("approved_at", Value::Null), ("error", json!("")), ("pid", json!(std::process::id())), ("archive_dir", Value::Null),
                ("backlog_id", json!(backlog_id)),
                ("references", json!(references)), ("reference_scope", json!(uuid::Uuid::new_v4().to_string())),
            ] {
                s["prd"][k] = v;
            }
        })?;
        fs::create_dir_all(prd_dir(root))?;
        for entry in fs::read_dir(prd_dir(root))? {
            let path = entry?.path();
            if path.is_file() {
                fs::remove_file(path)?;
            }
        }
        // 需求待辦帶入的想法含完整的需求摘要，log 只記第一行，避免整份摘要在 log 開頭重複一次。
        let first = idea.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
        let rest = idea.chars().count().saturating_sub(first.chars().count());
        append_log(root, SCOPE, &if rest > 20 { format!("新想法：{first}（另含需求摘要 {rest} 字，見 PRD 頁）") } else { format!("新想法：{first}") });
        let (text, provider) = author(root, cfg, prd_draft_prompt(root, cfg, idea), "PRD 初稿")?;
        let v = save_version(root, &text)?;
        add_round(root, json!({ "kind": "draft", "round": 0, "provider": provider, "version": v, "file": format!("v{v}.md") }))?;
        review_loop(root, cfg)
    })
}

/// 使用者附意見要求再改：作者依意見修訂後，再走一次審查迴圈。
pub fn revise_prd(root: &Path, cfg: &Value, feedback: &str) -> Result<()> {
    let prd = current_prd(root);
    if prd.is_empty() {
        crate::bail!("還沒有 PRD，請先執行 ai-workflow prd \"<想法>\"");
    }
    guard(root)?;
    with_error_state(root, || {
        update_state(root, |s| {
            s["prd"]["status"] = json!("revising");
            s["prd"]["error"] = json!("");
            s["prd"]["approved_at"] = Value::Null;
        })?;
        let fb_file = format!("user-feedback-{}.md", chrono::Utc::now().timestamp_millis());
        fs::write(prd_dir(root).join(&fb_file), feedback)?;
        let round = read_state(root)["prd"]["round"].clone();
        add_round(root, json!({ "kind": "user_feedback", "round": round, "provider": "user", "file": fb_file }))?;
        let (text, provider) = author(root, cfg, prd_revise_prompt(root, cfg, &prd, feedback, "使用者"), "PRD 依使用者意見修訂")?;
        let v = save_version(root, &text)?;
        let round = read_state(root)["prd"]["round"].clone();
        add_round(root, json!({ "kind": "revise", "round": round, "provider": provider, "version": v, "file": format!("v{v}.md") }))?;
        review_loop(root, cfg)
    })
}

pub fn approve_prd(root: &Path, cfg: &Value) -> Result<PathBuf> {
    let prd = current_prd(root);
    if prd.is_empty() {
        crate::bail!("還沒有 PRD 可以核准");
    }
    let status = read_state(root)["prd"]["status"].as_str().unwrap_or("none").to_string();
    if status != "awaiting_approval" && status != "approved" {
        crate::bail!("PRD 目前狀態是 {status}，不能核准");
    }
    let target = prd_file(root);
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&target, &prd)?;
    update_state(root, |s| {
        s["prd"]["status"] = json!("approved");
        s["prd"]["approved_at"] = json!(now_iso());
        // 核准代表使用者已處理過先前的錯誤，不再顯示。
        s["prd"]["error"] = json!("");
    })?;
    append_log(root, SCOPE, &format!("PRD 已核准，寫入 {}", target.display()));
    match archive_prd(root, cfg) {
        Ok(dir) => append_log(root, SCOPE, &format!("PRD 與每輪紀錄已封存到 {dir}")),
        Err(err) => append_log(root, SCOPE, &format!("⚠ 封存 PRD 失敗：{}", err.message)),
    }
    Ok(target)
}

/// 人工直接修改 PRD：存成新版本，不經作者 AI 改寫。同一個功能的封存資料夾沿用（與 revise_prd 相同），重新核准時更新。
pub fn save_manual(root: &Path, text: &str, version: &Value, scope: &Value) -> Result<Value> {
    crate::core::human::idle(root)?;
    if text.trim().is_empty() || text.len()>500000 { crate::bail!(400; "PRD 不能空白，且必須小於 500 KB"); }
    crate::core::home::with_project_lock(root,"human",|| {
        let state=read_state(root);
        if state["prd"]["version"]!=*version || state["prd"]["reference_scope"]!=*scope { crate::bail!(409; "PRD 已更新，請重新載入再編輯；你的草稿仍保留"); }
        if current_prd(root)==text { return Ok(json!({"ok":true,"unchanged":true,"version":version})); }
        let _=archive_tasks(root,json!({}));
        let v=save_version(root,text)?;
        update_state(root,|s| {
            s["prd"]["status"]=json!("awaiting_approval"); s["prd"]["approved_at"]=Value::Null; s["prd"]["error"]=json!("");
            s["prd"]["human_edited_at"]=json!(now_iso()); s["prd"]["reviewed_version"]=Value::Null;
            s["task_approval"]=Value::Null; s["task_gen"]=json!({"status":"stale","error":"PRD 已人工修改，需重新核准並產生任務"});
        })?;
        add_round(root,json!({"kind":"human_edit","provider":"human","version":v,"file":format!("v{v}.md")}))?;
        Ok(json!({"ok":true,"version":v}))
    })
}
/// 使用者關掉錯誤通知：只清掉錯誤訊息，不改 PRD 狀態或內容。
pub fn dismiss_error(root: &Path) -> Result<Value> {
    update_state(root, |s| s["prd"]["error"] = json!(""))?;
    Ok(json!({ "ok": true }))
}
pub fn review_current(root: &Path, cfg: &Value) -> Result<()> {
    guard(root)?;
    with_error_state(root,|| {
        let prd=current_prd(root); if prd.is_empty() { crate::bail!("沒有可審查的 PRD"); }
        update_state(root,|s| { s["prd"]["status"]=json!("reviewing"); s["prd"]["error"]=json!(""); })?;
        let round=read_state(root)["prd"]["round"].as_u64().unwrap_or(0)+1;
        let reviews=run_reviews(AgentOpts { root,cfg,provider:"",prompt:prd_review_prompt(root,cfg,&prd,round),write:false,scope:SCOPE,label:"人工版本交叉審查",stage:Some("prd_review"),role:Some("reviewer"),skills:None,saved:vec![] },&["APPROVE"])?;
        let version=read_state(root)["prd"]["version"].clone();
        for review in &reviews {
            let file=format!("human-review-{round}-{}.md",review.provider); fs::write(prd_dir(root).join(&file),&review.text)?;
            add_round(root,json!({"kind":"review","round":round,"provider":review.provider,"verdict":review.verdict,"version":version,"file":file}))?;
        }
        update_state(root,|s| { s["prd"]["round"]=json!(round); s["prd"]["reviewed_version"]=version; s["prd"]["status"]=json!("awaiting_approval"); })
    })
}
