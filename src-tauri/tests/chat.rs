mod common;

use std::fs;
use std::path::PathBuf;
use aipipe::core::{chat, AppError};
use aipipe::core::config::{default_config, save_config};
use aipipe::core::state::{read_state, update_state};
use serde_json::{json, Value};
use common::*;

fn fixture() -> PathBuf {
    let root = project(); let mut cfg = default_config();
    cfg["roles"]["chat"] = json!("codex");
    cfg["runtime"] = json!({ "claude": "windows", "codex": "windows" });
    cfg["cli"]["codex"] = json!(install_fake(&root, "codex").to_string_lossy());
    cfg["cli"]["claude"] = json!(root.join("missing.exe").to_string_lossy());
    cfg["models"]["chat"]["codex"] = json!({ "model": "chat-model", "effort": "high" });
    save_config(&root, &cfg).unwrap();
    fs::write(root.join(".fake-cli.json"), json!({ "codex": { "text": "目前正在驗證。\n```mermaid\nflowchart LR\nA-->B\n```" } }).to_string()).unwrap();
    root
}
fn start(root: &std::path::Path, body: Value) -> Value {
    chat::start_turn(root, &body, &|_, _| Ok(std::process::id())).unwrap()
}
fn run(root: &std::path::Path, session: &Value) -> Value {
    chat::run_turn(root, session["id"].as_str().unwrap(), session["turn"].as_str().unwrap()).unwrap()
}

#[test]
fn 專案對話可在流程執行中詢問_追問帶入前文及最新狀態_使用唯讀模型設定() {
    let root = fixture();
    update_state(&root, |s| { s["pipeline"]["status"] = json!("running"); s["pipeline"]["reason"] = json!("正在測試登入"); }).unwrap();
    let first = start(&root, json!({ "input": "目前跑到哪裡？", "provider": "codex" }));
    let done = run(&root, &first);
    assert_eq!(done["status"], "done");
    assert_eq!(done["messages"].as_array().unwrap().len(), 2);
    assert_eq!(done["messages"][1]["provider"], "codex");
    update_state(&root, |s| s["pipeline"]["reason"] = json!("新的進度：等待人工測試")).unwrap();
    let next = start(&root, json!({ "chatId": done["id"], "input": "請解釋剛剛的架構圖", "provider": "codex" }));
    let done = run(&root, &next);
    assert_eq!(done["messages"].as_array().unwrap().len(), 4);
    let calls: Vec<Value> = fs::read_to_string(root.join(".aipipe/calls.jsonl")).unwrap().lines().map(|s| serde_json::from_str(s).unwrap()).collect();
    assert_eq!(calls.len(), 2);
    let prompt = calls[1]["prompt"].as_str().unwrap();
    for text in ["目前跑到哪裡", "目前正在驗證", "flowchart LR", "新的進度：等待人工測試", "請解釋剛剛的架構圖"] { assert!(prompt.contains(text), "{text}"); }
    let args = calls[0]["args"].as_array().unwrap();
    assert!(args.windows(2).any(|a| a == [json!("--sandbox"), json!("read-only")]));
    assert!(args.windows(2).any(|a| a == [json!("-m"), json!("chat-model")]));
    assert_eq!(read_state(&root)["pipeline"]["status"], "running");
    assert!(!root.join("docs/aipipe/prd.md").exists());
    assert_eq!(chat::list_chats(&root).len(), 1);
}

#[test]
fn 啟動失敗保留問題_重試不重複加入訊息_不改專案模型設定() {
    let root = fixture(); let config = fs::read(root.join(".aipipe.json")).unwrap();
    let failed = chat::start_turn(&root, &json!({ "input": "說明架構", "provider": "codex", "model": "one-turn-model" }), &|_, _| Err(AppError::new("啟動失敗"))).unwrap();
    assert_eq!(failed["status"], "error");
    assert_eq!(failed["messages"][0]["text"], "說明架構");
    let retry = start(&root, json!({ "chatId": failed["id"], "retry": true, "provider": "codex" }));
    assert_eq!(retry["messages"].as_array().unwrap().len(), 1);
    assert_eq!(run(&root, &retry)["status"], "done");
    assert_eq!(fs::read(root.join(".aipipe.json")).unwrap(), config);
}

#[test]
fn 停止待執行對話不啟動模型_原始問題仍可重試() {
    let root = fixture(); let pending = start(&root, json!({ "input": "請畫架構", "provider": "codex" }));
    chat::cancel_turn(&root, pending["id"].as_str().unwrap()).unwrap();
    let stopped = run(&root, &pending);
    assert_eq!(stopped["status"], "cancelled");
    assert_eq!(stopped["messages"].as_array().unwrap().len(), 1);
    assert!(!root.join(".aipipe/calls.jsonl").exists());
}

#[test]
fn 同時傳送只會啟動一個回合_執行中不允許刪除() {
    let root = fixture();
    let results = std::thread::scope(|scope| {
        let a = scope.spawn(|| chat::start_turn(&root, &json!({ "input": "a", "provider": "codex" }), &|_, _| Ok(std::process::id())));
        let b = scope.spawn(|| chat::start_turn(&root, &json!({ "input": "b", "provider": "codex" }), &|_, _| Ok(std::process::id())));
        vec![a.join().unwrap(), b.join().unwrap()]
    });
    assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
    let session = results.into_iter().find_map(|result| result.ok()).unwrap();
    assert!(chat::delete_chat(&root, session["id"].as_str().unwrap()).is_err());
}

#[test]
fn 損壞對話與路徑不會被當作新對話覆蓋() {
    let root = fixture(); let id = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(root.join(".aipipe/chats")).unwrap();
    let path = root.join(format!(".aipipe/chats/{id}.json")); fs::write(&path, "{broken").unwrap();
    assert!(chat::get_chat(&root, &id).is_err());
    assert!(chat::start_turn(&root, &json!({ "chatId": id, "input": "question", "provider": "codex" }), &|_, _| Ok(0)).is_err());
    assert_eq!(fs::read_to_string(path).unwrap(), "{broken");
    assert!(chat::get_chat(&root, "../../state").is_err());
    assert!(chat::start_turn(&root, &json!({ "input": "q", "provider": "codex", "model": "bad;token" }), &|_, _| Ok(0)).is_err());
}

#[test]
fn 完整對話保留_交接只帶最近訊息_包含最新問題() {
    let root = fixture(); let cfg = default_config();
    let session = json!({ "messages": [{ "role": "user", "text": "old".repeat(25000) }, { "role": "assistant", "text": "最近回覆" }, { "role": "user", "text": "最新問題" }] });
    let (prompt, count, truncated) = chat::conversation_prompt(&root, &cfg, &session);
    assert!(truncated); assert_eq!(count, 2); assert!(prompt.contains("最新問題"));
    assert_eq!(session["messages"].as_array().unwrap().len(), 3);
}

#[test]
fn 執行中的對話可以停止_之後重開仍有原始訊息() {
    let root = fixture();
    fs::write(root.join(".fake-cli.json"), json!({ "codex": { "delay_ms": 10000, "text": "too late" } }).to_string()).unwrap();
    let pending = start(&root, json!({ "input": "很久的查詢", "provider": "codex" }));
    let id = pending["id"].as_str().unwrap().to_string();
    std::thread::scope(|scope| {
        let worker = scope.spawn(|| run(&root, &pending));
        let started = std::time::Instant::now();
        while !root.join(".aipipe/calls.jsonl").exists() && started.elapsed() < std::time::Duration::from_secs(5) { std::thread::sleep(std::time::Duration::from_millis(20)); }
        chat::cancel_turn(&root, &id).unwrap();
        assert_eq!(worker.join().unwrap()["status"], "cancelled");
    });
    let saved = chat::get_chat(&root, &id).unwrap();
    assert_eq!(saved["messages"][0]["text"], "很久的查詢");
    chat::rename_chat(&root, &id, "保留的對話").unwrap();
    assert_eq!(chat::get_chat(&root, &id).unwrap()["title"], "保留的對話");
    chat::delete_chat(&root, &id).unwrap(); assert!(chat::list_chats(&root).is_empty());
}

#[test]
fn 失去回覆程序後可重新提問_舊訊息仍保留() {
    let root = fixture(); let pending = start(&root, json!({ "input": "問題一", "provider": "codex" }));
    let id = pending["id"].as_str().unwrap(); let mut crashed = pending.clone();
    crashed["status"] = json!("running"); crashed["pid"] = json!(0);
    fs::write(root.join(format!(".aipipe/chats/{id}.json")), crashed.to_string()).unwrap();
    assert_eq!(chat::get_chat(&root, id).unwrap()["status"], "error");
    let retry = start(&root, json!({ "chatId": id, "retry": true, "provider": "codex" }));
    assert_eq!(run(&root, &retry)["messages"].as_array().unwrap().len(), 2);
}

#[test]
fn claude_對話可讀專案_限制為讀檔工具並保存實際回覆() {
    let root = fixture();
    let mut cfg = aipipe::core::config::load_config(&root).unwrap();
    cfg["cli"]["claude"] = json!(install_fake(&root, "claude").to_string_lossy()); save_config(&root, &cfg).unwrap();
    fs::write(root.join(".fake-cli.json"), json!({ "claude": { "text": "Claude 的架構說明" } }).to_string()).unwrap();
    let pending = start(&root, json!({ "input": "解釋架構", "provider": "claude" }));
    let done = run(&root, &pending);
    assert_eq!(done["messages"][1]["provider"], "claude");
    let line = fs::read_to_string(root.join(".aipipe/calls.jsonl")).unwrap();
    let call: Value = serde_json::from_str(line.lines().next().unwrap()).unwrap(); let args = call["args"].as_array().unwrap();
    assert!(args.windows(2).any(|a| a == [json!("--tools"), json!("Read,Glob,Grep")]));
    assert!(args.windows(2).any(|a| a == [json!("--disallowedTools"), json!("Edit,Write,NotebookEdit,mcp__*")]));
}

#[test]
fn 只有附件可發問且追問沿用快照_重新讀取對話仍保留參考() {
    let root=fixture(); fs::write(root.join("reference.md"),"UNIQUE_CHAT_REFERENCE").unwrap();
    let item=aipipe::core::references::import(&root,&json!({"path":root.join("reference.md")})).unwrap();
    let first=start(&root,json!({"provider":"codex","references":[item["id"]]}));
    fs::remove_file(root.join("reference.md")).unwrap();
    let done=run(&root,&first); assert_eq!(done["status"],"done");
    let saved=chat::get_chat(&root,done["id"].as_str().unwrap()).unwrap();
    assert_eq!(saved["messages"][0]["references"],json!([item["id"]]));
    let second=start(&root,json!({"chatId":done["id"],"input":"繼續解釋","provider":"codex"}));
    assert_eq!(run(&root,&second)["status"],"done");
    let calls=fs::read_to_string(root.join(".aipipe/calls.jsonl")).unwrap();
    for line in calls.lines() { let call:Value=serde_json::from_str(line).unwrap(); assert!(call["prompt"].as_str().unwrap().contains("UNIQUE_CHAT_REFERENCE")); }
}
