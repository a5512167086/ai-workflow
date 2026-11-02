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
        Some("app-server") => app_server(),
        _ => run(provider, me, &args),
    }
}

/// Codex app-server：完成 initialize → initialized 握手後才回答額度查詢，其他請求一律失敗。
fn app_server() {
    let mut initialized = false;
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let message: Value = serde_json::from_str(&line).unwrap_or(Value::Null);
        match message["method"].as_str() {
            Some("initialize") => println!("{}", json!({ "id": message["id"], "result": {} })),
            Some("initialized") => initialized = true,
            Some("account/rateLimits/read") if initialized => println!("{}", json!({ "id": message["id"], "result": { "rateLimits": { "primary": { "usedPercent": 25 } } } })),
            _ => std::process::exit(3),
        }
        std::io::stdout().flush().unwrap();
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
