//! Claude Code CLI：`claude -p` 加上 stream-json 串流事件。寫入角色以 `--permission-prompt-tool stdio` 執行，
//! 需要權限時 CLI 送出 can_use_tool 控制請求，由 App 的對話框問使用者。
use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use super::{
    append_log, append_stream, ask_user, clear_stream, data_dir, last_lines, model_for, resolve_cli_for, run, summarize_tool_input, AgentOpts, CliOutcome,
    LineBuffer, Result, RunOpts,
};
use crate::core::proc::{CliSpec, RunResult};

pub(super) fn run_claude(opts: &AgentOpts, prompt: &str, references: &crate::core::references::Prepared, on_event: &mut dyn FnMut(&Value)) -> Result<CliOutcome> {
    let (root, cfg, scope) = (opts.root, opts.cfg, opts.scope);
    let spec = resolve_cli_for(cfg, "claude", root)?;
    // 寫入角色（實作、修正）需要權限時改問使用者：CLI 透過 stdout 送 can_use_tool 請求，App 跳出對話框，回答再寫回 stdin。
    let interactive = opts.write;
    let input = if interactive { claude_interactive_input(prompt, &references.images)? } else { claude_input(prompt, &references.images)? };
    let args = claude_args(opts, &spec, !references.images.is_empty())?;
    let mut result = ClaudeResult::default();
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
        result.apply(root, scope, &ev);
    };
    let mut buffer = LineBuffer(String::new());
    let timeout = cfg["agent_timeout_sec"].as_u64().unwrap_or(1800);
    let res = {
        let mut on_out = |d: &str| buffer.push(d, &mut handle);
        let mut on_err = |d: &str| append_log(root, scope, d.trim_end());
        run(&spec, &args, RunOpts { cwd: Some(root), input: Some(&input), timeout_sec: timeout, cancel_file: scope.strip_prefix("chat-").and_then(|turn| crate::core::chat::cancel_file(root, turn)), on_stdout: Some(&mut on_out), on_stderr: Some(&mut on_err), stdin_rx: interactive.then_some(stdin_rx), ..Default::default() })
    };
    // 執行結束（含逾時、取消、出錯）：還在等使用者回答的請求一律失效，App 不再顯示。
    finished.store(true, std::sync::atomic::Ordering::SeqCst);
    if interactive { crate::core::permissions::expire_scope(root, scope); }
    // 不論成功、失敗、取消或逾時，都不要留下打到一半的文字。
    clear_stream(root, scope);
    let res = res?;
    buffer.finish(&mut handle);
    Ok(result.outcome(&res, timeout))
}

/// 組出 `claude` 的命令列參數：串流輸出、權限模式、允許／禁止的工具、模型與推理強度。
fn claude_args(opts: &AgentOpts, spec: &CliSpec, has_images: bool) -> Result<Vec<String>> {
    let (root, cfg, write, scope) = (opts.root, opts.cfg, opts.write, opts.scope);
    let interactive = write;
    // -p + stream-json 需要 --verbose 才會輸出逐步事件；--include-partial-messages 再加上逐字的 stream_event，App 才能邊打邊顯示。
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages"].map(String::from).to_vec();
    if interactive || has_images { args.extend(["--input-format", "stream-json"].map(String::from)); }
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
    let (model, effort) = model_for(cfg, opts.role, "claude");
    if !model.is_empty() {
        args.extend(["--model".into(), model]);
    }
    if !effort.is_empty() {
        args.extend(["--effort".into(), effort]);
    }
    Ok(args)
}

/// 從 stream-json 事件累積出的最終結果。
#[derive(Default)]
struct ClaudeResult {
    final_text: String,
    is_error: bool,
    error_text: String,
}

impl ClaudeResult {
    /// 處理一筆事件：逐字輸出寫串流檔、完整訊息寫 log、result 事件記下最終文字與錯誤。
    fn apply(&mut self, root: &Path, scope: &str, ev: &Value) {
        match ev["type"].as_str() {
            // 逐字輸出：只取文字的增量（工具參數、思考過程不顯示），寫到串流檔。
            Some("stream_event") => {
                let e = &ev["event"];
                if e["type"] == "content_block_delta" && e["delta"]["type"] == "text_delta" {
                    append_stream(root, scope, e["delta"]["text"].as_str().unwrap_or(""));
                }
            }
            Some("assistant") => log_assistant_message(root, scope, ev),
            Some("result") => {
                self.final_text = ev["result"].as_str().unwrap_or("").to_string();
                self.is_error = crate::core::util::truthy(ev.get("is_error"));
                if self.is_error {
                    self.error_text = self.final_text.clone();
                }
                if let Some(denials) = ev["permission_denials"].as_array().filter(|d| !d.is_empty()) {
                    let names: Vec<&str> = denials.iter().map(|d| d["tool_name"].as_str().unwrap_or("")).collect();
                    append_log(root, scope, &format!("⚠ 被拒絕的工具呼叫：{}", names.join(", ")));
                }
            }
            _ => {}
        }
    }

    /// 依執行結果（取消、逾時、錯誤、結束碼）組出回傳給呼叫端的結果。
    fn outcome(self, res: &RunResult, timeout: u64) -> CliOutcome {
        let ClaudeResult { final_text, is_error, error_text } = self;
        if res.cancelled { return CliOutcome { ok: false, text: final_text, error: Some("使用者已停止回覆".into()) }; }
        if res.timed_out {
            return CliOutcome { ok: false, text: final_text, error: Some(format!("逾時（{timeout}s）")) };
        }
        if is_error || res.code != 0 {
            let error = if !error_text.is_empty() {
                error_text
            } else if !final_text.is_empty() {
                final_text.clone()
            } else {
                format!("claude 結束碼 {}：{}", res.code, last_lines(if res.stderr.is_empty() { &res.stdout } else { &res.stderr }, 8))
            };
            return CliOutcome { ok: false, text: final_text, error: Some(error) };
        }
        CliOutcome { ok: true, text: final_text, error: None }
    }
}

/// 完整的訊息到了，寫進 log；正在打字的文字清掉，避免重複顯示。
fn log_assistant_message(root: &Path, scope: &str, ev: &Value) {
    clear_stream(root, scope);
    for part in ev["message"]["content"].as_array().into_iter().flatten() {
        if part["type"] == "text" && part["text"].as_str().is_some_and(|t| !t.trim().is_empty()) {
            append_log(root, scope, part["text"].as_str().unwrap().trim());
        }
        if part["type"] == "tool_use" {
            append_log(root, scope, &format!("🔧 {} {}", part["name"].as_str().unwrap_or(""), summarize_tool_input(&part["input"])));
        }
    }
}

/// 互動模式的 stdin：先送 initialize（啟用 can_use_tool 權限請求），再送使用者訊息；兩者都是 stream-json。
fn claude_interactive_input(prompt: &str, images: &[std::path::PathBuf]) -> Result<String> {
    let message = if images.is_empty() { format!("{}\n", json!({"type":"user","message":{"role":"user","content":prompt},"parent_tool_use_id":null})) } else { claude_input(prompt, images)? };
    Ok(format!("{}\n{message}", json!({ "type": "control_request", "request_id": "ai-workflow-init", "request": { "subtype": "initialize" } })))
}

/// 回覆 CLI 的控制請求。can_use_tool：存成待回答的權限請求，在背景執行緒等使用者決定後寫回 stdin，
/// 不擋住讀取輸出、逾時與取消的主迴圈。其他不支援的請求直接回錯誤，避免 CLI 一直等。
fn answer_control_request(root: &Path, scope: &str, label: &str, ev: &Value, stdin: &std::sync::mpsc::Sender<Option<String>>, finished: &std::sync::Arc<std::sync::atomic::AtomicBool>, limit: std::time::Duration) {
    let request_id = ev["request_id"].as_str().unwrap_or("").to_string();
    let request = ev["request"].clone();
    if request["subtype"] != "can_use_tool" {
        let _ = stdin.send(Some(format!("{}\n", json!({ "type": "control_response", "response": { "subtype": "error", "request_id": request_id, "error": "ai-workflow 不支援這個控制請求" } }))));
        return;
    }
    ask_user(root, scope, label, "claude", request.clone(), stdin, finished, limit, move |entry| crate::core::permissions::claude_response(&request_id, &request["input"], entry));
}

/// Structured stdin is required for Claude image attachments.
pub fn claude_input(prompt: &str, images: &[std::path::PathBuf]) -> Result<String> {
    use base64::Engine;
    if images.is_empty() { return Ok(prompt.into()); }
    let mut content=vec![json!({"type":"text","text":prompt})];
    for path in images {
        let ext=path.extension().and_then(std::ffi::OsStr::to_str).unwrap_or("").to_lowercase();
        let mime=match ext.as_str() { "jpg"|"jpeg"=>"image/jpeg", "webp"=>"image/webp", "gif"=>"image/gif", _=>"image/png" };
        content.push(json!({"type":"image","source":{"type":"base64","media_type":mime,"data":base64::engine::general_purpose::STANDARD.encode(fs::read(path)?)}}));
    }
    Ok(format!("{}\n",json!({"type":"user","message":{"role":"user","content":content},"parent_tool_use_id":null})))
}

