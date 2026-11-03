//! 測試用的假 claude / codex CLI。整合測試把這個 exe 複製成 claude.exe、codex.exe，
//! 用檔名判斷扮演哪一個；行為由 cwd 裡的 .fake-cli.json 決定：
//! { "<provider>": { "rules": [{ "contains": "...", "text": "..." }], "text": "預設回覆", "fail": "失敗訊息",
//!                  "events": ["原始 stdout 行", ...], "write": { "path": "相對路徑", "content": "..." } } }
//! 每次執行都把 { provider, pid, args, prompt } 附加到 cwd/.fake-cli-calls.jsonl。
use std::fs;
use std::io::{BufRead, Read, Write};
use std::path::Path;

use serde_json::{json, Value};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let exe = std::env::current_exe().unwrap();
    let provider = exe.file_stem().unwrap().to_string_lossy().to_lowercase();
    let provider = if provider.contains("codex") { "codex" } else { "claude" };
    let scenario = fs::read_to_string(".fake-cli.json").ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).unwrap_or(json!({}));
    let me = &scenario[provider];
    match args.first().map(String::as_str) {
        Some("--version") => println!("{provider} 1.0"),
        Some("auth") => println!("{}", me["auth"].as_str().unwrap_or(r#"{"loggedIn":true,"authMethod":"claude.ai"}"#)),
        Some("login") => eprintln!("Logged in using ChatGPT"),
        Some("app-server") => app_server(me, &args),
        _ => run(provider, me, &args),
    }
}

/// Codex app-server：完成 initialize → initialized 握手後才回答其他請求。
/// 支援額度查詢，以及 thread/start → turn/start 的完整回合（AI 實作、審查都走這裡）；其他請求一律失敗。
/// turn/start 會把 { provider, pid, args, prompt, thread, turn } 記到 .fake-cli-calls.jsonl，
/// thread 與 turn 是收到的參數（模型、沙箱、核准政策、推理強度、圖片）。
fn app_server(me: &Value, args: &[String]) {
    let mut initialized = false;
    let mut thread = Value::Null;
    let mut lines = std::io::stdin().lock().lines();
    while let Some(Ok(line)) = lines.next() {
        let message: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        match message["method"].as_str() {
            Some("initialize") => print_line(&json!({ "id": message["id"], "result": {} })),
            Some("initialized") => initialized = true,
            Some("account/rateLimits/read") if initialized => print_line(&json!({ "id": message["id"], "result": { "rateLimits": { "primary": { "usedPercent": 25 } } } })),
            Some("thread/start") if initialized => {
                thread = message["params"].clone();
                let sandbox = if me["sandbox_downgrade"] == true || thread["sandbox"] == "read-only" { "readOnly" } else { "workspaceWrite" };
                print_line(&json!({ "id": message["id"], "result": { "thread": { "id": "thread-1" }, "sandbox": { "type": sandbox } } }));
            }
            Some("turn/start") if initialized => {
                print_line(&json!({ "id": message["id"], "result": { "turn": { "id": "turn-1", "status": "inProgress" } } }));
                codex_turn(me, args, &thread, &message["params"], &mut lines);
            }
            _ => std::process::exit(3),
        }
    }
}

/// 一個 Codex 回合：依 scenario 送核准請求、寫檔、回覆文字或失敗，最後送 turn/completed。
fn codex_turn(me: &Value, args: &[String], thread: &Value, turn: &Value, lines: &mut std::io::Lines<std::io::StdinLock<'static>>) {
    let prompt: String = turn["input"].as_array().into_iter().flatten().filter_map(|i| i["text"].as_str()).collect::<Vec<_>>().join("\n");
    let record = json!({ "provider": "codex", "pid": std::process::id(), "args": args, "prompt": prompt, "thread": thread, "turn": turn });
    let mut log = fs::OpenOptions::new().create(true).append(true).open(".fake-cli-calls.jsonl").unwrap();
    writeln!(log, "{record}").unwrap();
    if let Some(ms) = me["delay_ms"].as_u64() { std::thread::sleep(std::time::Duration::from_millis(ms)); }
    let mut allowed = true;
    for (i, ask) in me["ask"].as_array().into_iter().flatten().enumerate() {
        let id = 1000 + i as u64;
        print_line(&json!({ "id": id, "method": "item/commandExecution/requestApproval", "params": { "threadId": "thread-1", "turnId": "turn-1", "itemId": format!("item-{i}"), "command": ask["input"]["command"], "cwd": thread["cwd"], "reason": ask["description"] } }));
        for line in lines.by_ref() {
            let Ok(line) = line else { break };
            let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            if v["id"] == id && v["method"].is_null() {
                let mut answers = fs::OpenOptions::new().create(true).append(true).open(".fake-cli-answers.jsonl").unwrap();
                writeln!(answers, "{}", v["result"]).unwrap();
                if !["accept", "acceptForSession"].contains(&v["result"]["decision"].as_str().unwrap_or("")) { allowed = false; }
                break;
            }
        }
    }
    if let Some(w) = me.get("write").filter(|_| allowed) {
        let path = Path::new(w["path"].as_str().unwrap());
        if let Some(dir) = path.parent() { fs::create_dir_all(dir).unwrap(); }
        fs::write(path, w["content"].as_str().unwrap_or("")).unwrap();
        print_line(&json!({ "method": "item/completed", "params": { "item": { "type": "fileChange", "id": "item-write", "changes": [{ "path": w["path"] }], "status": "completed" } } }));
    }
    if let Some(fail) = me["fail"].as_str() {
        print_line(&json!({ "method": "error", "params": { "error": { "message": fail }, "willRetry": false, "threadId": "thread-1", "turnId": "turn-1" } }));
        print_line(&json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": "turn-1", "status": "failed", "error": { "message": fail } } } }));
        return;
    }
    if let Some(events) = me["events"].as_array() {
        print_events(events);
        return;
    }
    let text = me["rules"].as_array().into_iter().flatten()
        .find(|r| r["contains"].as_str().is_some_and(|c| prompt.contains(c)))
        .and_then(|r| r["text"].as_str())
        .or(me["text"].as_str())
        .unwrap_or("ok");
    print_line(&json!({ "method": "item/completed", "params": { "item": { "type": "agentMessage", "id": "item-msg", "text": text } } }));
    print_line(&json!({ "method": "thread/tokenUsage/updated", "params": { "threadId": "thread-1", "turnId": "turn-1", "tokenUsage": {
        "total": { "inputTokens": 1000, "cachedInputTokens": 200, "outputTokens": 50, "reasoningOutputTokens": 10, "totalTokens": 1050 },
        "last": { "inputTokens": 1000, "cachedInputTokens": 200, "outputTokens": 50, "reasoningOutputTokens": 10, "totalTokens": 1050 }, "modelContextWindow": 200000 } } }));
    print_line(&json!({ "method": "turn/completed", "params": { "threadId": "thread-1", "turn": { "id": "turn-1", "status": "completed" } } }));
}

/// scenario 的 events 裡可以放 "sleep:<毫秒>"：在那裡停一下，測試才看得到執行中的狀態（例如逐字輸出的串流檔）。
fn sleep_ms(event: &Value) -> Option<u64> {
    event.as_str()?.strip_prefix("sleep:")?.parse().ok()
}

fn print_events(events: &[Value]) {
    let mut out = std::io::stdout();
    for e in events {
        if let Some(ms) = sleep_ms(e) { std::thread::sleep(std::time::Duration::from_millis(ms)); continue; }
        writeln!(out, "{}", e.as_str().map(String::from).unwrap_or_else(|| e.to_string())).unwrap();
        out.flush().unwrap();
    }
}

fn print_line(value: &Value) {
    let mut out = std::io::stdout();
    writeln!(out, "{value}").unwrap();
    out.flush().unwrap();
}

/// 互動模式（--permission-prompt-tool stdio）：stdin 一行一個 stream-json 訊息，不會關閉直到結果送出。
/// 回覆 initialize、取出使用者訊息當 prompt；scenario 的 ask 逐一送出 can_use_tool 並等回答，回答記到 .fake-cli-answers.jsonl。
/// 回傳 (prompt, 是否全部允許)。
fn interactive_input(me: &Value, lines: &mut std::io::Lines<std::io::StdinLock<'static>>) -> (String, bool) {
    let mut prompt = String::new();
    for line in lines.by_ref() {
        let Ok(line) = line else { break };
        let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        if v["type"] == "control_request" { print_line(&json!({ "type": "control_response", "response": { "subtype": "success", "request_id": v["request_id"], "response": {} } })); continue; }
        if v["type"] == "user" {
            let content = &v["message"]["content"];
            prompt = content.as_str().map(String::from).unwrap_or_else(|| content.as_array().into_iter().flatten().filter_map(|p| p["text"].as_str()).collect::<Vec<_>>().join("
"));
            break;
        }
    }
    let mut allowed = true;
    for (i, ask) in me["ask"].as_array().into_iter().flatten().enumerate() {
        let id = format!("perm-{i}");
        print_line(&json!({ "type": "control_request", "request_id": id, "request": { "subtype": "can_use_tool", "tool_name": ask["tool_name"], "input": ask["input"], "description": ask["description"], "permission_suggestions": ask["permission_suggestions"], "decision_reason": "This command requires approval" } }));
        for line in lines.by_ref() {
            let Ok(line) = line else { break };
            let v: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
            if v["type"] == "control_response" && v["response"]["request_id"] == id.as_str() {
                let mut log = fs::OpenOptions::new().create(true).append(true).open(".fake-cli-answers.jsonl").unwrap();
                writeln!(log, "{}", v["response"]["response"]).unwrap();
                if v["response"]["response"]["behavior"] != "allow" { allowed = false; }
                break;
            }
        }
    }
    (prompt, allowed)
}

fn run(provider: &str, me: &Value, args: &[String]) {
    let interactive = args.iter().any(|a| a == "--permission-prompt-tool");
    let mut lines = interactive.then(|| std::io::stdin().lock().lines());
    let (prompt, allowed) = match lines.as_mut() {
        Some(lines) => interactive_input(me, lines),
        None => { let mut prompt = String::new(); std::io::stdin().read_to_string(&mut prompt).unwrap(); (prompt, true) }
    };
    run_output(provider, me, args, &prompt, allowed);
    // 真的 CLI 在互動模式下送出結果後會等 stdin 關閉才結束。
    if let Some(lines) = lines.as_mut() { for _ in lines.by_ref() {} }
}

fn run_output(provider: &str, me: &Value, args: &[String], prompt: &str, allowed: bool) {
    let record = json!({ "provider": provider, "pid": std::process::id(), "args": args, "prompt": prompt });
    let mut log = fs::OpenOptions::new().create(true).append(true).open(".fake-cli-calls.jsonl").unwrap();
    writeln!(log, "{record}").unwrap();
    if let Some(ms) = me["delay_ms"].as_u64() { std::thread::sleep(std::time::Duration::from_millis(ms)); }

    if let Some(w) = me.get("write").filter(|_| allowed) {
        let path = Path::new(w["path"].as_str().unwrap());
        if let Some(dir) = path.parent() {
            fs::create_dir_all(dir).unwrap();
        }
        fs::write(path, w["content"].as_str().unwrap_or("")).unwrap();
    }
    if let Some(fail) = me["fail"].as_str() {
        if provider == "claude" {
            println!("{}", json!({ "type": "result", "is_error": true, "result": fail }));
        } else {
            eprintln!("{fail}");
        }
        // 互動模式下不能直接結束：呼叫端要先讀到結果再關閉 stdin。
        if !args.iter().any(|a| a == "--permission-prompt-tool") { std::process::exit(1); }
        return;
    }
    if let Some(events) = me["events"].as_array().filter(|e| e.iter().any(|e| sleep_ms(e).is_some())) {
        print_events(events);
        return;
    }
    if let Some(events) = me["events"].as_array() {
        // 分兩次輸出，模擬一行被切在兩個 chunk 之間。
        let text: String = events.iter().map(|e| format!("{}\n", e.as_str().map(String::from).unwrap_or_else(|| e.to_string()))).collect();
        let cut = text.char_indices().nth(17).map(|(i, _)| i).unwrap_or(text.len());
        let mut out = std::io::stdout();
        out.write_all(&text.as_bytes()[..cut]).unwrap();
        out.flush().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(30));
        out.write_all(&text.as_bytes()[cut..]).unwrap();
        out.flush().unwrap();
        return;
    }
    let rules = me["rules"].as_array().cloned().unwrap_or_default();
    let text = rules.iter()
        .find(|r| r["contains"].as_str().is_some_and(|c| prompt.contains(c)))
        .and_then(|r| r["text"].as_str())
        .or(me["text"].as_str())
        .unwrap_or("ok")
        .to_string();
    if provider == "claude" {
        println!("{}", json!({ "type": "result", "result": text, "is_error": false }));
    } else {
        let out = args.iter().position(|a| a == "-o").and_then(|i| args.get(i + 1)).expect("codex exec 缺少 -o");
        fs::write(out, text).unwrap();
    }
}
