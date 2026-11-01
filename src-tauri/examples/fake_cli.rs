//! 測試用的假 claude / codex CLI（取代 legacy 測試裡的 .cjs）。整合測試把這個 exe 複製成 claude.exe、codex.exe，
//! 用檔名判斷扮演哪一個；行為由 cwd 裡的 .fake-cli.json 決定：
//! { "<provider>": { "rules": [{ "contains": "...", "text": "..." }], "text": "預設回覆", "fail": "失敗訊息",
//!                  "events": ["原始 stdout 行", ...], "write": { "path": "相對路徑", "content": "..." } } }
//! 每次執行都把 { provider, pid, args, prompt } 附加到 cwd/.aipipe/calls.jsonl。
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

fn run(provider: &str, me: &Value, args: &[String]) {
    let mut prompt = String::new();
    std::io::stdin().read_to_string(&mut prompt).unwrap();
    fs::create_dir_all(".aipipe").unwrap();
    let record = json!({ "provider": provider, "pid": std::process::id(), "args": args, "prompt": prompt });
    let mut log = fs::OpenOptions::new().create(true).append(true).open(Path::new(".aipipe").join("calls.jsonl")).unwrap();
    writeln!(log, "{record}").unwrap();
    if let Some(ms) = me["delay_ms"].as_u64() { std::thread::sleep(std::time::Duration::from_millis(ms)); }

    if let Some(w) = me.get("write") {
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
        std::process::exit(1);
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
