//! Codex CLI：`codex app-server` 的 JSON-RPC 介面（和 Codex 桌面版、IDE 外掛相同）。
use super::*;

/// Codex 走 app-server（和 Codex 桌面版、IDE 外掛相同的 JSON-RPC 介面），而不是 exec：
/// exec 不能在執行中詢問使用者，app-server 會在指令、改檔或額外權限需要核准時送請求給 App。
/// 流程：initialize → thread/start（cwd、沙箱、核准政策、模型）→ turn/start（prompt、圖片、推理強度）→ 收通知直到 turn/completed。
pub(super) fn run_codex(opts: &AgentOpts, prompt: &str, references: &crate::core::references::Prepared, on_event: &mut dyn FnMut(&Value)) -> Result<CliOutcome> {
    let (root,cfg,role,write,scope)=(opts.root,opts.cfg,opts.role,opts.write,opts.scope);
    let spec = resolve_cli_for(cfg, "codex", root)?;
    let mut args: Vec<String> = vec!["app-server".into()];
    // workspace-write 預設不能連網，npm install 之類會失敗；寫入角色預設開放（codex.network_access=false 可關）。
    if write && cfg["codex"]["network_access"] != false {
        args.extend(["-c".into(), "sandbox_workspace_write.network_access=true".into()]);
    }
    // 唯讀角色也帶上，否則 Windows 上 Codex 連讀檔用的 shell 指令都無法啟動。
    if let Some(sandbox) = cfg["codex"]["windows_sandbox"].as_str().filter(|s| !s.is_empty() && spec.runtime == "windows") {
        args.extend(["-c".into(), format!("windows.sandbox=\"{sandbox}\"")]);
    }
    let (model, effort) = model_for(cfg, role, "codex");
    // 寫入角色：on-request（沙箱內直接執行，需要超出沙箱時問使用者）；唯讀角色：never（不問、超出就失敗）。
    let approval = if write { cfg["codex"]["approval_policy"].as_str().filter(|p| ["on-request", "untrusted", "never"].contains(p)).unwrap_or("on-request") } else { "never" };
    let mut thread_params = json!({ "cwd": spec.to_path(root)?, "sandbox": if write { "workspace-write" } else { "read-only" }, "approvalPolicy": approval, "ephemeral": true });
    if !model.is_empty() { thread_params["model"] = json!(model); }
    // Windows 上 Codex 用 Windows PowerShell 5.1 跑指令：Get-Content 會把沒有 BOM 的 UTF-8 當成系統編碼讀成亂碼，
    // 輸出接到管線時又用 IBM437，中文變成「?」。AI 讀到亂碼會誤判，所以每次都提醒它用 rg 或明確指定 UTF-8。
    let prompt = if spec.runtime == "windows" { format!("{prompt}{WINDOWS_SHELL_NOTE}") } else { prompt.to_string() };
    let mut input = vec![json!({ "type": "text", "text": prompt })];
    for image in &references.images { input.push(json!({ "type": "localImage", "path": spec.to_path(image)? })); }
    let mut turn_params = json!({ "input": input });
    if !effort.is_empty() { turn_params["effort"] = json!(effort); }

    let (stdin_tx, stdin_rx) = std::sync::mpsc::channel::<Option<String>>();
    let finished = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    let wait_limit = std::time::Duration::from_secs(cfg["agent_timeout_sec"].as_u64().unwrap_or(1800));
    let send = |message: Value| { let _ = stdin_tx.send(Some(format!("{message}\n"))); };
    let initialize = json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "ai-workflow", "version": env!("CARGO_PKG_VERSION") } } });
    let (mut last_message, mut turn_error, mut completed, mut read_only) = (String::new(), None::<String>, false, false);
    let mut handle = |line: &str| {
        if line.trim().is_empty() { return; }
        let Ok(message) = serde_json::from_str::<Value>(line) else { append_log(root, scope, line); return; };
        on_event(&message);
        let id = message.get("id").filter(|v| !v.is_null()).cloned();
        match (id, message["method"].as_str()) {
            // Codex 送來的請求：核准類跳對話框問使用者，其他回不支援。
            (Some(id), Some(method)) => {
                if crate::core::permissions::CODEX_APPROVAL_METHODS.contains(&method) {
                    let (params, method) = (message["params"].clone(), method.to_string());
                    let request = crate::core::permissions::codex_request(&method, &params);
                    ask_user(root, scope, opts.label, "codex", request, &stdin_tx, &finished, wait_limit, move |entry| json!({ "id": id, "result": crate::core::permissions::codex_result(&method, &params, entry) }));
                } else {
                    send(json!({ "id": id, "error": { "code": -32601, "message": "ai-workflow 不支援這個請求" } }));
                }
            }
            // 我們送出請求的回應：依序接下一步。
            (Some(id), None) => {
                if !message["error"].is_null() {
                    turn_error = Some(format!("Codex app-server 錯誤：{}", message["error"]["message"].as_str().unwrap_or("未知錯誤")));
                    let _ = stdin_tx.send(None);
                    return;
                }
                match id.as_u64() {
                    Some(1) => {
                        send(json!({ "method": "initialized", "params": {} }));
                        send(json!({ "id": 2, "method": "thread/start", "params": thread_params.clone() }));
                    }
                    Some(2) => {
                        // Windows 沒有可用的沙箱時，Codex 會把 workspace-write 降成唯讀，實作者就改不了檔案。
                        if write && message["result"]["sandbox"]["type"] == "readOnly" { read_only = true; let _ = stdin_tx.send(None); return; }
                        let mut params = turn_params.clone();
                        params["threadId"] = message["result"]["thread"]["id"].clone();
                        send(json!({ "id": 3, "method": "turn/start", "params": params }));
                    }
                    _ => {}
                }
            }
            (None, Some("item/completed")) => {
                let item = &message["params"]["item"];
                match item["type"].as_str() {
                    Some("agentMessage") => {
                        last_message = item["text"].as_str().unwrap_or("").to_string();
                        append_log(root, scope, &last_message);
                    }
                    Some("commandExecution") => append_log(root, scope, &format!("$ {}\n{}", item["command"].as_str().unwrap_or(""), clip_output(item["aggregatedOutput"].as_str().unwrap_or("")))),
                    Some("fileChange") => {
                        let paths: Vec<&str> = item["changes"].as_array().into_iter().flatten().filter_map(|c| c["path"].as_str()).collect();
                        append_log(root, scope, &format!("✎ {}", paths.join("、")));
                    }
                    _ => {}
                }
            }
            (None, Some("error")) => {
                // willRetry 時 Codex 會自己重試，只記錄不當成失敗。
                let text = message["params"]["error"]["message"].as_str().unwrap_or("Codex 發生錯誤").to_string();
                append_log(root, scope, &text);
                if message["params"]["willRetry"] != true { turn_error = Some(text); }
            }
            (None, Some("turn/completed")) => {
                completed = true;
                let turn = &message["params"]["turn"];
                if ["failed", "interrupted"].contains(&turn["status"].as_str().unwrap_or("")) && turn_error.is_none() {
                    turn_error = Some(turn["error"]["message"].as_str().unwrap_or("Codex 的回合沒有完成").to_string());
                }
                // 關閉 stdin，app-server 才會結束。
                let _ = stdin_tx.send(None);
            }
            _ => {}
        }
    };
    let mut buffer = LineBuffer(String::new());
    let timeout = cfg["agent_timeout_sec"].as_u64().unwrap_or(1800);
    let res = {
        let mut on_out = |d: &str| buffer.push(d, &mut handle);
        // app-server 的 stderr 是除錯紀錄（含顏色碼），只留錯誤等級的行。
        let mut on_err = |d: &str| { let clean = ANSI.replace_all(d, ""); for line in clean.lines().filter(|l| l.contains("ERROR")) { append_log(root, scope, &clip_error_line(line)); } };
        run(&spec, &args, RunOpts { cwd: Some(root), input: Some(&format!("{initialize}\n")), timeout_sec: timeout, cancel_file: scope.strip_prefix("chat-").and_then(|turn| crate::core::chat::cancel_file(root, turn)), on_stdout: Some(&mut on_out), on_stderr: Some(&mut on_err), stdin_rx: Some(stdin_rx), ..Default::default() })
    };
    finished.store(true, std::sync::atomic::Ordering::SeqCst);
    crate::core::permissions::expire_scope(root, scope);
    let res = res?;
    buffer.finish(&mut handle);
    let text = last_message;
    if res.cancelled { return Ok(CliOutcome { ok: false, text, error: Some("使用者已停止回覆".into()) }); }
    if res.timed_out { return Ok(CliOutcome { ok: false, text, error: Some(format!("逾時（{timeout}s）")) }); }
    if read_only {
        return Ok(CliOutcome { ok: false, text, error: Some("Codex 把 workspace-write 降成了 read-only，無法修改檔案。Windows 請在全域設定 config.json 的 codex.windows_sandbox 填 elevated 或 unelevated".into()) });
    }
    if let Some(error) = turn_error { return Ok(CliOutcome { ok: false, text, error: Some(error) }); }
    if !completed {
        let detail = last_lines(&ANSI.replace_all(&res.stderr, ""), 8);
        return Ok(CliOutcome { ok: false, text, error: Some(format!("codex app-server 沒有完成回合（結束碼 {}）：{detail}", res.code)) });
    }
    Ok(CliOutcome { ok: true, text, error: None })
}

const WINDOWS_SHELL_NOTE: &str = "\n\n## Windows 指令注意\n- 這裡的 shell 是 Windows PowerShell 5.1：`Get-Content` 不加 `-Encoding utf8` 會把 UTF-8 檔案讀成亂碼，輸出中文也可能變成「?」。\n- 讀檔與搜尋優先用 `rg`（例如 `rg -n \"\" 檔案` 讀整個檔案、`rg --files` 列檔案）。\n- 一定要用 PowerShell 讀檔時，先執行 `[Console]::OutputEncoding = [Text.Encoding]::UTF8`，再用 `Get-Content -Encoding utf8`。\n- 看到亂碼或一排「?」時，代表編碼讀錯了，請換上面的方法重讀，不要依亂碼內容下判斷。";

static ANSI: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*m").unwrap());
