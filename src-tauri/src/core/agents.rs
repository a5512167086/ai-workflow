//! 以官方 CLI 跑一次全新對話（對應 legacy/src/agents.js）。不 resume，prompt 由 stdin 傳入；
//! write=false 的角色（PRD 審查、程式碼審查）以唯讀方式執行。
use std::fs;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Instant;

use regex::Regex;
use serde_json::{json, Value};

use super::agent_errors::{explain_usage_limit, usage_limit, UsageLimit};
use super::capabilities::{other_provider, probe_provider, select_provider};
use super::config::model_for;
use super::proc::{last_lines, resolve_cli_for, run, RunOpts};
use super::runtime::cli_environment;
use super::skills::prepare_skills;
use super::state::{append_log, data_dir};
use super::usage::{record_telemetry, Telemetry};
use super::util::{now_iso, write_json};
use super::Result;

pub struct AgentOpts<'a> {
    pub root: &'a Path,
    pub cfg: &'a Value,
    pub provider: &'a str,
    pub prompt: String,
    pub write: bool,
    pub scope: &'a str,
    pub label: &'a str,
    pub stage: Option<&'a str>,
    /// 角色（author／reviewer／implementer／code_reviewer），決定要用的模型與推理強度。
    pub role: Option<&'a str>,
    /// 明確指定的 Skills；None 時用 cfg.skills[stage]。
    pub skills: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default)]
pub struct AgentResult {
    pub ok: bool,
    pub text: String,
    pub error: Option<String>,
    pub provider: String,
    pub session_id: String,
    pub skills: Vec<Value>,
    /// { tokens, context, limits }
    pub telemetry: Value,
    pub fallback_from: Option<String>,
    pub failure: Option<UsageLimit>,
    /// CLI 回報被權限擋下的工具（Claude 的 permission_denials）；Codex 沒有這項資訊，一律空。
    pub denied: Vec<String>,
}

impl AgentResult {
    pub fn error_text(&self) -> String {
        self.error.clone().unwrap_or_default()
    }
}

pub fn run_agent(opts: AgentOpts) -> Result<AgentResult> {
    let AgentOpts { root, cfg, provider: preferred, write, scope, .. } = opts;
    let preferred = cfg["_run_provider"].as_str().unwrap_or(preferred);
    if cfg["_run_provider"].is_string() && probe_provider(root, cfg, preferred)["available"] != true {
        crate::bail!("本次指定的 {preferred} 不可用，請確認 CLI 安裝與登入狀態");
    }
    let selected = select_provider(root, cfg, preferred)?;
    let provider = selected.provider;
    if provider != preferred {
        append_log(root, scope, &format!("單 AI 模式：{preferred} 不可用（{}），改用 {provider}，建立全新 session", selected.checks[0]["error"].as_str().unwrap_or("")));
    }
    let result = run_agent_session(&opts, &provider)?;
    if result.ok {
        let _ = super::state::update_state(root, |s| {
            if s["usage_blocked"]["provider"] == provider { s["usage_blocked"] = Value::Null; }
        });
    }
    let Some(limit) = (!result.ok).then(|| usage_limit(&result.error_text())).flatten() else { return Ok(result) };
    let _ = super::state::update_state(root, |s| s["usage_blocked"] = json!({ "provider": provider, "message": explain_usage_limit(&provider, &limit) }));
    let message = explain_usage_limit(&provider, &limit);
    let stop = |result: AgentResult, error: String| Ok(AgentResult { error: Some(error), failure: Some(limit.clone()), ..result });
    if cfg["_run_provider"].is_string() {
        return stop(result, format!("{message}。本次指定的 AI 額度不足，請等待重設或重新選擇 AI"));
    }
    if write || opts.role == Some("code_reviewer") {
        return stop(result, format!("{message}。工作可能已修改檔案，已停止；確認變更後再重試"));
    }
    let other = other_provider(&provider);
    let (target, alternate) = (cli_environment(cfg, &provider, root), cli_environment(cfg, other, root));
    if target.runtime != alternate.runtime || target.distro != alternate.distro {
        return stop(result, format!("{message}。另一個 AI 設定在不同執行環境，請在設定中調整後再重試"));
    }
    let check = probe_provider(root, cfg, other);
    if check["available"] != true {
        return stop(result, format!("{message}。同環境的 {other} 不可用：{}。請等待額度重設，或安裝並登入另一個 AI", check["error"].as_str().unwrap_or("")));
    }
    append_log(root, scope, &format!("{message}；本次唯讀工作改用 {other}，建立全新 session"));
    // 直接呼叫 session：最多切換一次，用原始 prompt 與新的 Skill 快照。
    let fallback = run_agent_session(&opts, other)?;
    let mut out = AgentResult { fallback_from: Some(provider.clone()), ..fallback };
    if !out.ok {
        let second = usage_limit(&out.error_text());
        let detail = second.as_ref().map(|l| explain_usage_limit(other, l)).unwrap_or_else(|| out.error_text());
        out.error = Some(format!("{message}；{other} 也未完成：{detail}"));
        out.failure = Some(second.unwrap_or(limit));
    }
    Ok(out)
}

struct CliOutcome {
    ok: bool,
    text: String,
    error: Option<String>,
}

fn run_agent_session(opts: &AgentOpts, provider: &str) -> Result<AgentResult> {
    let (root, cfg, scope, label) = (opts.root, opts.cfg, opts.scope, opts.label);
    let spec = resolve_cli_for(cfg, provider, root)?;
    let to_path = |p: &Path| spec.to_path(p).unwrap_or_else(|_| p.to_string_lossy().into_owned());
    let prepared = prepare_skills(root, cfg, opts.stage, opts.skills.as_deref(), &to_path)?;
    let references = super::references::prepare(root,cfg,opts.stage,scope,&to_path)?;
    let prompt = [opts.prompt.as_str(), prepared.text.as_str(), references.text.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
    let session_id = uuid::Uuid::new_v4().to_string();
    let session_file = data_dir(root).join("sessions").join(format!("{session_id}.json"));
    let session = json!({
        "id": session_id, "provider": provider, "runtime": spec.runtime, "distro": cli_environment(cfg, provider, root).distro,
        "stage": opts.stage.unwrap_or("skill"), "label": label, "skills": prepared.snapshots, "references": references.snapshots, "started_at": now_iso(), "status": "running",
    });
    write_json(&session_file, &session)?;
    let mut telemetry = Telemetry::new(provider);
    let mut previous = String::new();
    let mut denied: Vec<String> = Vec::new();
    let mut on_event = |event: &Value| {
        for d in event["permission_denials"].as_array().into_iter().flatten() { if let Some(name) = d["tool_name"].as_str() { denied.push(name.to_string()); } }
        let value = telemetry.accept(event);
        let signature = value.to_string();
        if signature != previous {
            previous = signature;
            let _ = record_telemetry(root, &session, &value);
        }
    };
    on_event(&json!({}));
    append_log(root, scope, &format!("── {label}：{provider}（{}）開始，session {session_id} ──", if opts.write { "可編輯" } else { "唯讀" }));
    let prompt_file = data_dir(root).join("tmp").join(format!("{session_id}.prompt.md"));
    fs::create_dir_all(prompt_file.parent().unwrap())?;
    fs::write(&prompt_file, &prompt)?;
    let started = Instant::now();
    let outcome = if provider == "codex" {
        run_codex(opts, &prompt, &references, &mut on_event)
    } else {
        run_claude(opts, &prompt, &references, &mut on_event)
    };
    let snapshot = telemetry.snapshot();
    let with_status = |status: &str, extra: Value| {
        let mut s = session.clone();
        s["status"] = json!(status);
        for (k, v) in extra.as_object().unwrap() {
            s[k] = v.clone();
        }
        s
    };
    let outcome = match outcome {
        Ok(o) => o,
        Err(err) => {
            write_json(&session_file, &with_status("error", json!({ "error": err.message, "finished_at": now_iso() })))?;
            let _ = record_telemetry(root, &with_status("error", json!({})), &snapshot);
            return Err(err);
        }
    };
    let status = if outcome.ok { "done" } else { "error" };
    let mut finished = with_status(status, json!({ "error": outcome.error, "finished_at": now_iso() }));
    for (k, v) in snapshot.as_object().unwrap() {
        finished[k] = v.clone();
    }
    write_json(&session_file, &finished)?;
    let _ = record_telemetry(root, &with_status(status, json!({})), &snapshot);
    let secs = started.elapsed().as_secs_f64().round();
    append_log(root, scope, &format!("── {label}：{}（{secs}s）{} ──", if outcome.ok { "完成" } else { "失敗" }, outcome.error.as_ref().map(|e| format!(" {e}")).unwrap_or_default()));
    Ok(AgentResult {
        ok: outcome.ok, text: outcome.text, error: outcome.error, provider: provider.into(), session_id, skills: prepared.snapshots,
        telemetry: snapshot, denied, ..Default::default()
    })
}

/// 把串流 stdout 切成行（行可能跨 chunk）。
struct LineBuffer(String);

impl LineBuffer {
    fn push(&mut self, data: &str, mut f: impl FnMut(&str)) {
        self.0.push_str(data);
        while let Some(i) = self.0.find('\n') {
            let line: String = self.0.drain(..=i).collect();
            f(line.trim_end_matches(['\n', '\r']));
        }
    }
    fn finish(&mut self, mut f: impl FnMut(&str)) {
        let rest = std::mem::take(&mut self.0);
        f(&rest);
    }
}

fn summarize_tool_input(input: &Value) -> String {
    let v = ["file_path", "path", "command", "pattern"].iter().find_map(|k| input[k].as_str()).unwrap_or("");
    v.chars().take(160).collect()
}

fn run_claude(opts: &AgentOpts, prompt: &str, references: &super::references::Prepared, on_event: &mut dyn FnMut(&Value)) -> Result<CliOutcome> {
    let (root,cfg,role,write,scope)=(opts.root,opts.cfg,opts.role,opts.write,opts.scope);
    let spec = resolve_cli_for(cfg, "claude", root)?;
    // 寫入角色（實作、修正）需要權限時改問使用者：CLI 透過 stdout 送 can_use_tool 請求，App 跳出對話框，回答再寫回 stdin。
    let interactive = write;
    let input = if interactive { claude_interactive_input(prompt, &references.images)? } else { claude_input(prompt, &references.images)? };
    // -p + stream-json 需要 --verbose 才會輸出逐步事件。
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"].map(String::from).to_vec();
    if interactive || !references.images.is_empty() { args.extend(["--input-format", "stream-json"].map(String::from)); }
    if interactive { args.extend(["--permission-prompt-tool", "stdio"].map(String::from)); }
    // Skill 快照、參考資料與 handover 都在專案資料目錄（不在專案裡），讓 Claude 把它當成額外的工作目錄。
    args.extend(["--add-dir".into(), spec.to_path(&data_dir(root))?]);
    if write {
        // auto：一般開發指令（建專案、npm install、跑測試）由 Claude Code 的安全分類器放行，其餘改問使用者。
        // acceptEdits：編輯檔案自動允許，每個指令都先問使用者。
        let mode = cfg["claude"]["write_permission_mode"].as_str().filter(|m| ["auto", "acceptEdits"].contains(m)).unwrap_or("auto");
        args.extend(["--permission-mode".to_string(), mode.to_string()]);
        let tools: Vec<&str> = cfg["claude"]["allowed_tools"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if !tools.is_empty() {
            args.extend(["--allowedTools".into(), tools.join(",")]);
        }
    } else {
        // dontAsk：沒有預先允許的工具一律拒絕；再明確禁止編輯類工具。
        let denied = if scope.starts_with("chat-") { "Edit,Write,NotebookEdit,mcp__*" } else { "Edit,Write,NotebookEdit" };
        args.extend(["--permission-mode", "dontAsk", "--disallowedTools", denied].map(String::from));
        if scope.starts_with("chat-") { args.extend(["--tools", "Read,Glob,Grep"].map(String::from)); }
    }
    let (model, effort) = model_for(cfg, role, "claude");
    if !model.is_empty() {
        args.extend(["--model".into(), model]);
    }
    if !effort.is_empty() {
        args.extend(["--effort".into(), effort]);
    }
    let (mut final_text, mut is_error, mut error_text) = (String::new(), false, String::new());
    let (stdin_tx, stdin_rx) = std::sync::mpsc::channel::<Option<String>>();
    let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let wait_limit = std::time::Duration::from_secs(cfg["agent_timeout_sec"].as_u64().unwrap_or(1800));
    let mut handle = |line: &str| {
        if line.trim().is_empty() {
            return;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else {
            append_log(root, scope, line);
            return;
        };
        if interactive && ev["type"] == "control_request" {
            answer_control_request(root, scope, opts.label, &ev, &stdin_tx, &finished, wait_limit);
            return;
        }
        // 結果出來後關閉 stdin，CLI 才會結束（互動模式下它會一直等下一則輸入）。
        if interactive && ev["type"] == "result" { let _ = stdin_tx.send(None); }
        on_event(&ev);
        match ev["type"].as_str() {
            Some("assistant") => {
                for part in ev["message"]["content"].as_array().into_iter().flatten() {
                    if part["type"] == "text" && part["text"].as_str().is_some_and(|t| !t.trim().is_empty()) {
                        append_log(root, scope, part["text"].as_str().unwrap().trim());
                    }
                    if part["type"] == "tool_use" {
                        append_log(root, scope, &format!("🔧 {} {}", part["name"].as_str().unwrap_or(""), summarize_tool_input(&part["input"])));
                    }
                }
            }
            Some("result") => {
                final_text = ev["result"].as_str().unwrap_or("").to_string();
                is_error = super::util::truthy(ev.get("is_error"));
                if is_error {
                    error_text = final_text.clone();
                }
                if let Some(denials) = ev["permission_denials"].as_array().filter(|d| !d.is_empty()) {
                    let names: Vec<&str> = denials.iter().map(|d| d["tool_name"].as_str().unwrap_or("")).collect();
                    append_log(root, scope, &format!("⚠ 被拒絕的工具呼叫：{}", names.join(", ")));
                }
            }
            _ => {}
        }
    };
    let mut buffer = LineBuffer(String::new());
    let timeout = cfg["agent_timeout_sec"].as_u64().unwrap_or(1800);
    let res = {
        let mut on_out = |d: &str| buffer.push(d, &mut handle);
        let mut on_err = |d: &str| append_log(root, scope, d.trim_end());
        run(&spec, &args, RunOpts { cwd: Some(root), input: Some(&input), timeout_sec: timeout, cancel_file: scope.strip_prefix("chat-").and_then(|turn| super::chat::cancel_file(root, turn)), on_stdout: Some(&mut on_out), on_stderr: Some(&mut on_err), stdin_rx: interactive.then_some(stdin_rx), ..Default::default() })
    };
    // 執行結束（含逾時、取消、出錯）：還在等使用者回答的請求一律失效，App 不再顯示。
    finished.store(true, std::sync::atomic::Ordering::SeqCst);
    if interactive { super::permissions::expire_scope(root, scope); }
    let res = res?;
    buffer.finish(&mut handle);
    if res.cancelled { return Ok(CliOutcome { ok: false, text: final_text, error: Some("使用者已停止回覆".into()) }); }
    if res.timed_out {
        return Ok(CliOutcome { ok: false, text: final_text, error: Some(format!("逾時（{timeout}s）")) });
    }
    if is_error || res.code != 0 {
        let error = if !error_text.is_empty() {
            error_text
        } else if !final_text.is_empty() {
            final_text.clone()
        } else {
            format!("claude 結束碼 {}：{}", res.code, last_lines(if res.stderr.is_empty() { &res.stdout } else { &res.stderr }, 8))
        };
        return Ok(CliOutcome { ok: false, text: final_text, error: Some(error) });
    }
    Ok(CliOutcome { ok: true, text: final_text, error: None })
}

static READ_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^sandbox:\s*read-only").unwrap());

fn run_codex(opts: &AgentOpts, prompt: &str, references: &super::references::Prepared, on_event: &mut dyn FnMut(&Value)) -> Result<CliOutcome> {
    let (root,cfg,role,write,scope)=(opts.root,opts.cfg,opts.role,opts.write,opts.scope);
    let spec = resolve_cli_for(cfg, "codex", root)?;
    let tmp = data_dir(root).join("tmp");
    fs::create_dir_all(&tmp)?;
    let out_file = tmp.join(format!("{}.codex-last.md", uuid::Uuid::new_v4()));
    let mut args: Vec<String> = vec![
        "exec".into(), "--json".into(), "--sandbox".into(), if write { "workspace-write" } else { "read-only" }.into(),
        "-C".into(), spec.to_path(root)?, "--color".into(), "never".into(), "-o".into(), spec.to_path(&out_file)?,
    ];
    let (model, effort) = model_for(cfg, role, "codex");
    if !model.is_empty() {
        args.extend(["-m".into(), model]);
    }
    if !effort.is_empty() {
        args.extend(["-c".into(), format!("model_reasoning_effort=\"{effort}\"")]);
    }
    // workspace-write 預設不能連網，npm install 之類會失敗；寫入角色預設開放（codex.network_access=false 可關）。
    if write && cfg["codex"]["network_access"] != false {
        args.extend(["-c".into(), "sandbox_workspace_write.network_access=true".into()]);
    }
    // 唯讀角色也帶上，否則 Windows 上 Codex 連讀檔用的 shell 指令都無法啟動。
    if let Some(sandbox) = cfg["codex"]["windows_sandbox"].as_str().filter(|s| !s.is_empty() && spec.runtime == "windows") {
        args.extend(["-c".into(), format!("windows.sandbox=\"{sandbox}\"")]);
    }
    for image in &references.images { args.extend(["--image".into(), spec.to_path(image)?]); }
    args.push("-".into()); // 從 stdin 讀 prompt
    let mut last_message = String::new();
    let mut handle = |line: &str| {
        if line.trim().is_empty() {
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            append_log(root, scope, line);
            return;
        };
        on_event(&event);
        let item = &event["item"];
        if event["type"] == "item.completed" && item["type"] == "agent_message" {
            last_message = item["text"].as_str().unwrap_or("").to_string();
            append_log(root, scope, &last_message);
        } else if event["type"] == "item.completed" && item["type"] == "command_execution" {
            append_log(root, scope, &format!("$ {}\n{}", item["command"].as_str().unwrap_or(""), item["aggregated_output"].as_str().unwrap_or("")));
        } else if event["type"] == "error" || event["type"] == "turn.failed" {
            let msg = event["message"].as_str().or(event["error"]["message"].as_str()).unwrap_or(line);
            append_log(root, scope, msg);
        }
    };
    let mut buffer = LineBuffer(String::new());
    let timeout = cfg["agent_timeout_sec"].as_u64().unwrap_or(1800);
    let res = {
        let mut on_out = |d: &str| buffer.push(d, &mut handle);
        let mut on_err = |d: &str| append_log(root, scope, d.trim_end());
        run(&spec, &args, RunOpts { cwd: Some(root), input: Some(prompt), timeout_sec: timeout, cancel_file: scope.strip_prefix("chat-").and_then(|turn| super::chat::cancel_file(root, turn)), on_stdout: Some(&mut on_out), on_stderr: Some(&mut on_err), ..Default::default() })?
    };
    buffer.finish(&mut handle);
    let text = fs::read_to_string(&out_file).unwrap_or_else(|_| if last_message.is_empty() { res.stdout.clone() } else { last_message.clone() });
    if res.cancelled { return Ok(CliOutcome { ok: false, text, error: Some("使用者已停止回覆".into()) }); }
    if res.timed_out {
        return Ok(CliOutcome { ok: false, text, error: Some(format!("逾時（{timeout}s）")) });
    }
    if res.code != 0 {
        let error = format!("codex 結束碼 {}：{}", res.code, last_lines(&format!("{}\n{text}", res.stderr), 8));
        return Ok(CliOutcome { ok: false, text, error: Some(error) });
    }
    if write && READ_ONLY.is_match(&format!("{}{}", res.stderr, res.stdout)) {
        return Ok(CliOutcome {
            ok: false,
            text,
            error: Some("Codex 把 workspace-write 降成了 read-only，無法修改檔案。Windows 請在設定頁或全域設定 config.json 的 codex.windows_sandbox 填 elevated 或 unelevated".into()),
        });
    }
    Ok(CliOutcome { ok: true, text, error: None })
}

/// 一份審查結果。
#[derive(Clone, Debug)]
pub struct Review {
    pub provider: String,
    pub text: String,
    pub pass: bool,
    pub verdict: String,
    pub result: AgentResult,
}

pub fn provider_name(provider: &str) -> &'static str {
    if provider == "claude" { "Claude" } else { "Codex" }
}

/// 依角色設定審查一次，或在 both 時由 Claude 與 Codex 各審一次（依序執行，log 不會交錯）。
/// both 但只有一個 AI 可用時只跑那一個；任何一份審查失敗就回傳錯誤。
pub fn run_reviews(base: AgentOpts, pass_words: &[&str]) -> Result<Vec<Review>> {
    let role = base.role.unwrap_or("reviewer");
    let mut providers = super::config::role_providers(base.cfg, role);
    if let Some(p) = base.cfg["_run_provider"].as_str() { providers = vec![p.to_string()]; }
    if providers.len() > 1 {
        let available: Vec<String> = providers.iter().filter(|p| probe_provider(base.root, base.cfg, p)["available"] == true).cloned().collect();
        if available.is_empty() {
            providers.truncate(1); // 交給 run_agent 回報「沒有可用的 AI」
        } else {
            if available.len() < providers.len() {
                append_log(base.root, base.scope, &format!("雙人審查：只有 {} 可用，改為單人審查", available.join("、")));
            }
            providers = available;
        }
    }
    let dual = providers.len() > 1;
    let mut reviews = Vec::new();
    for provider in providers {
        if reviews.iter().any(|r: &Review| r.provider == provider) { continue; }
        let label = if dual { format!("{}（{}）", base.label, provider_name(&provider)) } else { base.label.to_string() };
        let result = run_agent(AgentOpts {
            root: base.root, cfg: base.cfg, provider: &provider, prompt: base.prompt.clone(), write: base.write, scope: base.scope,
            label: &label, stage: base.stage, skills: base.skills.clone(), role: base.role,
        })?;
        if !result.ok {
            crate::bail!("{}審查 AI 失敗：{}", if dual { format!("{} ", provider_name(&provider)) } else { String::new() }, result.error_text());
        }
        let (pass, verdict) = parse_verdict(&result.text, pass_words);
        if reviews.iter().any(|r| r.provider == result.provider) { continue; }
        reviews.push(Review { provider: result.provider.clone(), text: result.text.clone(), pass, verdict, result });
    }
    Ok(reviews)
}

/// 給修訂者看的審查意見：雙人審查時依 AI 分段。
pub fn combine_reviews(reviews: &[Review]) -> String {
    if reviews.len() == 1 {
        return reviews[0].text.clone();
    }
    reviews.iter().map(|r| format!("### {} 審查意見（{}）\n\n{}", provider_name(&r.provider), r.verdict, r.text)).collect::<Vec<_>>().join("\n\n")
}

static VERDICT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)VERDICT\s*\**\s*[:：]\s*\**\s*([A-Z_]+)").unwrap());

/// 從審查回覆找出最後一個 VERDICT 行；找不到時保守視為不通過。
pub fn parse_verdict(text: &str, pass_words: &[&str]) -> (bool, String) {
    match VERDICT.captures_iter(text).last() {
        None => (false, "UNKNOWN".into()),
        Some(c) => {
            let verdict = c[1].to_uppercase();
            (pass_words.contains(&verdict.as_str()), verdict)
        }
    }
}

/// Structured stdin is required for Claude image attachments.
/// 互動模式的 stdin：先送 initialize（啟用 can_use_tool 權限請求），再送使用者訊息；兩者都是 stream-json。
fn claude_interactive_input(prompt: &str, images: &[std::path::PathBuf]) -> Result<String> {
    let message = if images.is_empty() { format!("{}
", json!({"type":"user","message":{"role":"user","content":prompt},"parent_tool_use_id":null})) } else { claude_input(prompt, images)? };
    Ok(format!("{}
{message}", json!({ "type": "control_request", "request_id": "ai-workflow-init", "request": { "subtype": "initialize" } })))
}

/// 回覆 CLI 的控制請求。can_use_tool：存成待回答的權限請求，在背景執行緒等使用者決定後寫回 stdin，
/// 不擋住讀取輸出、逾時與取消的主迴圈。其他不支援的請求直接回錯誤，避免 CLI 一直等。
fn answer_control_request(root: &Path, scope: &str, label: &str, ev: &Value, stdin: &std::sync::mpsc::Sender<Option<String>>, finished: &std::sync::Arc<std::sync::atomic::AtomicBool>, limit: std::time::Duration) {
    let request_id = ev["request_id"].as_str().unwrap_or("").to_string();
    let request = ev["request"].clone();
    if request["subtype"] != "can_use_tool" {
        let _ = stdin.send(Some(format!("{}
", json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "ai-workflow 不支援這個控制請求" } }))));
        return;
    }
    let tool = request["tool_name"].as_str().unwrap_or("").to_string();
    let shown = summarize_tool_input(&request["input"]);
    append_log(root, scope, &format!("⏸ 等待你允許：{tool} {shown}"));
    let (root, scope, label, stdin, finished) = (root.to_path_buf(), scope.to_string(), label.to_string(), stdin.clone(), finished.clone());
    std::thread::spawn(move || {
        let entry = match super::permissions::create(&root, &scope, &label, "claude", &request) {
            Ok(id) => super::permissions::wait(&root, &id, &|| finished.load(std::sync::atomic::Ordering::SeqCst), limit),
            Err(err) => json!({ "status": "deny", "message": format!("無法建立權限請求：{}", err.message) }),
        };
        let verdict = match entry["status"].as_str() { Some("allow") => "你允許了這一次", Some("allow_session") => "你允許了這次執行的同類操作", _ => "已拒絕" };
        append_log(&root, &scope, &format!("{} {tool} {shown}：{verdict}", if verdict.starts_with("你允許") { "✓" } else { "✗" }));
        let _ = stdin.send(Some(format!("{}
", super::permissions::claude_response(&request_id, &request["input"], &entry))));
    });
}

pub fn claude_input(prompt: &str, images: &[std::path::PathBuf]) -> Result<String> {
    use base64::Engine;
    if images.is_empty() { return Ok(prompt.into()); }
    let mut content=vec![json!({"type":"text","text":prompt})];
    for path in images {
        let ext=path.extension().and_then(|s|s.to_str()).unwrap_or("").to_lowercase();
        let mime=match ext.as_str() { "jpg"|"jpeg"=>"image/jpeg", "webp"=>"image/webp", "gif"=>"image/gif", _=>"image/png" };
        content.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":base64::engine::general_purpose::STANDARD.encode(fs::read(path)?)}}));
    }
    Ok(format!("{}\n",json!({"type":"user","message":{"role":"user","content":content},"parent_tool_use_id":null})))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_verdict_取最後一個_找不到視為不通過() {
        assert_eq!(parse_verdict("範例 VERDICT: PASS\n...\nVERDICT: FAIL", &["PASS"]), (false, "FAIL".into()));
        assert_eq!(parse_verdict("**VERDICT:** APPROVE", &["APPROVE"]), (true, "APPROVE".into()));
        assert!(!parse_verdict("沒有結論", &["PASS"]).0);
    }
}
