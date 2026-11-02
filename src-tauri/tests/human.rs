//! 人工介入：需求釐清會議（Grill Me）、PRD 人工編輯與只重審、任務人工編輯與執行前核准。
//! 原則：人的決定會撤回先前的核准；AI 的輸出不會自動取得核准。CLI 由 examples/fake_cli.rs 扮演。
mod common;

use std::fs;
use std::path::{Path, PathBuf};

use aipipe::core::api::handle;
use aipipe::core::config::{default_config, save_config, ROLES};
use aipipe::core::projects::{add_project, remove_project};
use aipipe::core::state::{read_state, update_state};
use aipipe::core::{backlog, chat, human, prd, requirements, tasks};
use common::*;
use serde_json::{json, Value};

fn fixture() -> (PathBuf, Value) {
    let root = project();
    let mut cfg = default_config();
    for role in ROLES { cfg["roles"][role] = json!("codex"); }
    cfg["runtime"] = json!({ "claude": "windows", "codex": "windows" });
    cfg["cli"]["codex"] = json!(install_fake(&root, "codex").to_string_lossy());
    cfg["cli"]["claude"] = json!(root.join("missing.exe").to_string_lossy());
    save_config(&root, &cfg).unwrap();
    (root, cfg)
}

fn scenario(root: &Path, value: Value) {
    fs::write(root.join(".fake-cli.json"), value.to_string()).unwrap();
}

fn launch(_: &str, _: &str) -> aipipe::core::Result<u32> { Ok(std::process::id()) }

fn run(root: &Path, session: &Value) -> Value {
    chat::run_turn(root, session["id"].as_str().unwrap(), session["turn"].as_str().unwrap()).unwrap()
}

fn calls(root: &Path) -> Vec<Value> {
    fs::read_to_string(root.join(".aipipe/calls.jsonl")).unwrap_or_default().lines().map(|line| serde_json::from_str(line).unwrap()).collect()
}

fn ready_reply() -> String {
    json!({ "message": "請確認以下摘要", "ready": true, "summary": "已確認：匯出 CSV，使用者是財務人員", "open_questions": [] }).to_string()
}

#[test]
fn 需求釐清至少回答一輪才能確認_確認後才能起草_需求修改後會議失效() {
    let (root, _cfg) = fixture();
    scenario(&root, json!({ "codex": { "rules": [{ "contains": "需求釐清會議", "text": ready_reply() }], "text": "# PRD" } }));
    let item = backlog::add_item(&root, Some(&json!("匯出 CSV")), Some(&json!("財務報表"))).unwrap();
    let id = item["id"].as_str().unwrap();
    assert_eq!(requirements::prd_input(&root, &item).unwrap_err().status, 409);
    assert!(requirements::get(&root, id).unwrap()["session"].is_null());

    // 自動開場：AI 即使第一輪就回報 ready，沒有使用者回答仍不能確認。
    let opened = requirements::start(&root, &json!({ "id": id }), &launch).unwrap();
    assert_eq!(opened["session"]["kind"], "requirements");
    assert_eq!(opened["session"]["backlogId"], id);
    let session = run(&root, &opened["session"]);
    assert_eq!(session["status"], "done");
    assert_eq!(session["requirementsReady"], false);
    assert_eq!(session["messages"][1]["text"], "請確認以下摘要");
    assert_eq!(requirements::confirm(&root, &json!({ "id": id, "sessionId": session["id"], "turn": session["turn"], "summary": "x" })).unwrap_err().status, 409);
    let records = calls(&root);
    let first = &records[0];
    let prompt = first["prompt"].as_str().unwrap();
    assert!(prompt.contains("需求釐清會議") && prompt.contains("匯出 CSV") && prompt.contains("財務報表"), "{prompt}");
    assert!(first["args"].as_array().unwrap().windows(2).any(|a| a == [json!("--sandbox"), json!("read-only")]));
    // 會議固定載入 grill-me 技能，並以需求釐清角色記錄 session。
    let sessions: Vec<Value> = fs::read_dir(root.join(".aipipe/sessions")).unwrap().map(|e| serde_json::from_str(&fs::read_to_string(e.unwrap().path()).unwrap()).unwrap()).collect();
    assert!(sessions.iter().any(|s| s["stage"] == "chat" && s["skills"][0]["name"] == "grill-me"), "{sessions:?}");

    // 使用者回答後接續同一個會議，AI 回報 ready 才出現可確認的摘要。
    let answered = requirements::start(&root, &json!({ "id": id, "input": "只給財務人員使用" }), &launch).unwrap();
    assert_eq!(answered["session"]["id"], session["id"]);
    let session = run(&root, &answered["session"]);
    assert_eq!(session["requirementsReady"], true);
    assert_eq!(session["requirementsSummary"], "已確認：匯出 CSV，使用者是財務人員");
    assert_eq!(session["messages"].as_array().unwrap().len(), 4);
    assert!(calls(&root)[1]["prompt"].as_str().unwrap().contains("只給財務人員使用"));
    assert_eq!(requirements::confirm(&root, &json!({ "id": id, "sessionId": session["id"], "turn": "other", "summary": "x" })).unwrap_err().status, 409);
    assert_eq!(requirements::confirm(&root, &json!({ "id": id, "sessionId": session["id"], "turn": session["turn"], "summary": "   " })).unwrap_err().status, 400);

    // 以使用者修正過的摘要為準，帶進 PRD 的需求輸入。
    let confirmed = requirements::confirm(&root, &json!({ "id": id, "sessionId": session["id"], "turn": session["turn"], "summary": "已確認：匯出 CSV，含日期範圍" })).unwrap();
    assert_eq!(confirmed["confirmed"], true);
    assert!(confirmed["session"]["confirmed_at"].is_string());
    let input = requirements::prd_input(&root, &backlog::get_item(&root, id).unwrap()).unwrap();
    assert!(input.starts_with("匯出 CSV\n\n財務報表"), "{input}");
    assert!(input.contains("## 使用者確認的需求摘要\n已確認：匯出 CSV，含日期範圍"), "{input}");
    assert_eq!(backlog::get_item(&root, id).unwrap()["interviewId"], session["id"]);

    // 需求會議不出現在專案對話清單，但可由需求待辦讀取。
    let p = add_project(&root, None).unwrap();
    let pid = p["id"].as_str().unwrap().to_string();
    assert!(handle("GET", &format!("/api/p/{pid}/chats"), &Value::Null).unwrap()["items"].as_array().unwrap().is_empty());
    assert_eq!(handle("GET", &format!("/api/p/{pid}/requirements/{id}"), &Value::Null).unwrap()["confirmed"], true);
    assert_eq!(chat::list_chats(&root).len(), 1);

    // 再送一輪回答會撤回確認；需求本身修改後整個會議失效，要重新釐清。
    let again = requirements::start(&root, &json!({ "id": id, "input": "再補充一點" }), &launch).unwrap();
    assert_eq!(again["confirmed"], false);
    run(&root, &again["session"]);
    backlog::update_item(&root, id, &json!({ "detail": "財務報表，再加上欄位選擇" })).unwrap();
    let stale = requirements::get(&root, id).unwrap();
    assert_eq!(stale["stale"], true);
    assert_eq!(stale["confirmed"], false);
    assert_eq!(requirements::prd_input(&root, &backlog::get_item(&root, id).unwrap()).unwrap_err().status, 409);
    assert_eq!(requirements::start(&root, &json!({ "id": id, "input": "繼續" }), &launch).unwrap_err().status, 409);
    let fresh = requirements::start(&root, &json!({ "id": id, "restart": true }), &launch).unwrap();
    assert_ne!(fresh["session"]["id"], session["id"]);
    assert_eq!(fresh["stale"], false);
    // 舊會議仍保留，沒有被覆寫。
    assert!(chat::get_chat(&root, session["id"].as_str().unwrap()).is_ok());
    remove_project(&pid).unwrap();
}

#[test]
fn 需求會議對話檔遺失時可重新開始_ai_回傳非_json_時不算完成() {
    let (root, _cfg) = fixture();
    scenario(&root, json!({ "codex": { "text": "我還有幾個問題：1. 誰會用？" } }));
    let item = backlog::add_item(&root, Some(&json!("通知")), None).unwrap();
    let id = item["id"].as_str().unwrap();
    let opened = requirements::start(&root, &json!({ "id": id }), &launch).unwrap();
    let session = run(&root, &opened["session"]);
    assert_eq!(session["requirementsReady"], false);
    assert_eq!(session["messages"][1]["text"], "我還有幾個問題：1. 誰會用？");
    assert_eq!(session["openQuestions"].as_array().unwrap().len(), 1);
    fs::remove_file(root.join(".aipipe/chats").join(format!("{}.json", session["id"].as_str().unwrap()))).unwrap();
    assert!(requirements::get(&root, id).unwrap()["session"].is_null());
    let restarted = requirements::start(&root, &json!({ "id": id }), &launch).unwrap();
    assert_ne!(restarted["session"]["id"], session["id"]);
}

#[test]
fn 任務需人工核准_執行狀態不影響核准_人工編輯撤回核准並重設後續任務() {
    let (root, _cfg) = fixture();
    update_state(&root, |s| { s["prd"]["status"] = json!("approved"); s["prd"]["version"] = json!(2); }).unwrap();
    assert_eq!(human::approve_tasks(&root, "").unwrap_err().status, 409);
    tasks::write_tasks(&root, &[
        json!({ "id": 1, "title": "first", "description": "a" }),
        json!({ "id": 2, "title": "second", "dependencies": [1], "subtasks": [{ "id": 1, "title": "child" }] }),
        json!({ "id": 3, "title": "third" }),
    ], Some("master"), json!({ "prd_version": 2 })).unwrap();
    assert!(human::require_task_approval(&root).unwrap_err().message.contains("核准"));
    let revision = tasks::revision(&root).unwrap();
    assert!(!revision.is_empty());
    assert_eq!(human::approve_tasks(&root, "stale").unwrap_err().status, 409);
    human::approve_tasks(&root, &revision).unwrap();
    assert_eq!(read_state(&root)["task_approval"]["revision"], revision);
    human::require_task_approval(&root).unwrap();

    // 執行時的狀態變化不改內容版本，核准仍有效。
    for status in ["in-progress", "review", "done"] { tasks::set_status(&root, "1", status).unwrap(); }
    assert_eq!(tasks::revision(&root).unwrap(), revision);
    human::require_task_approval(&root).unwrap();
    update_state(&root, |s| s["tasks"]["1"] = json!({ "phase": "done" })).unwrap();

    // 沒有實質修改、過期版本、錯誤群組、錯誤欄位、循環依賴。
    assert_eq!(tasks::edit_task(&root, "1", "master", &revision, &json!({ "title": "first", "description": "a" })).unwrap()["unchanged"], true);
    human::require_task_approval(&root).unwrap();
    assert_eq!(tasks::edit_task(&root, "1", "master", "old", &json!({ "title": "x" })).unwrap_err().status, 409);
    assert_eq!(tasks::edit_task(&root, "1", "other", &revision, &json!({ "title": "x" })).unwrap_err().status, 409);
    assert_eq!(tasks::edit_task(&root, "1", "master", &revision, &json!({ "priority": "urgent" })).unwrap_err().status, 400);
    assert_eq!(tasks::edit_task(&root, "1", "master", &revision, &json!({ "dependencies": "2" })).unwrap_err().status, 400);
    assert!(tasks::edit_task(&root, "1", "master", &revision, &json!({ "dependencies": [2] })).is_err());
    assert!(tasks::edit_task(&root, "9", "master", &revision, &json!({ "title": "x" })).is_err());
    assert_eq!(tasks::read_tasks(&root).unwrap()[0]["status"], "done");

    // 實質修改：任務 1 與依賴它的任務 2（含子任務）重設為待辦，任務 3 不受影響；核准撤回、流程暫停。
    tasks::set_status(&root, "3", "in-progress").unwrap();
    let edited = tasks::edit_task(&root, "1", "master", &revision, &json!({ "title": "first (revised)", "acceptanceCriteria": ["匯出檔案可開啟"], "priority": "high" })).unwrap();
    let invalidated = edited["invalidated"].as_array().unwrap();
    for id in ["1", "2", "2.1"] { assert!(invalidated.contains(&json!(id)), "{id} in {invalidated:?}"); }
    assert!(!invalidated.contains(&json!("3")));
    let list = tasks::read_tasks(&root).unwrap();
    assert_eq!(list[0]["title"], "first (revised)");
    assert_eq!(list[0]["status"], "pending");
    assert_eq!(list[0]["priority"], "high");
    assert_eq!(list[0]["acceptanceCriteria"], json!(["匯出檔案可開啟"]));
    assert_eq!(list[1]["status"], "pending");
    assert_eq!(list[1]["subtasks"][0]["status"], "pending");
    assert_eq!(list[2]["status"], "in-progress");
    let state = read_state(&root);
    assert!(state["task_approval"].is_null());
    assert!(state["tasks"]["1"].is_null());
    assert_eq!(state["pipeline"]["status"], "paused");
    let next = tasks::revision(&root).unwrap();
    assert_ne!(next, revision);
    assert_eq!(edited["revision"], next);
    assert_eq!(human::require_task_approval(&root).unwrap_err().status, 409);
    let store: Value = serde_json::from_str(&fs::read_to_string(tasks::tasks_file(&root)).unwrap()).unwrap();
    assert!(store["events"].as_array().unwrap().iter().any(|e| e["kind"] == "human-edit" && e["task"] == "1"));

    // 子任務也能編輯；核准後 PRD 改版，舊任務不能再執行。
    tasks::edit_task(&root, "2.1", "master", &next, &json!({ "title": "child (revised)" })).unwrap();
    assert_eq!(tasks::read_tasks(&root).unwrap()[1]["subtasks"][0]["title"], "child (revised)");
    human::approve_tasks(&root, &tasks::revision(&root).unwrap()).unwrap();
    human::require_task_approval(&root).unwrap();
    update_state(&root, |s| s["prd"]["version"] = json!(3)).unwrap();
    assert!(human::require_task_approval(&root).unwrap_err().message.contains("舊版 PRD"));
    assert_eq!(human::approve_tasks(&root, &tasks::revision(&root).unwrap()).unwrap_err().status, 409);

    // 流程執行中不能編輯或核准。
    update_state(&root, |s| { s["prd"]["version"] = json!(2); s["runner"]["pid"] = json!(std::process::id()); }).unwrap();
    assert_eq!(human::approve_tasks(&root, &tasks::revision(&root).unwrap()).unwrap_err().status, 409);
    assert_eq!(tasks::edit_task(&root, "3", "master", &tasks::revision(&root).unwrap(), &json!({ "title": "x" })).unwrap_err().status, 409);
}

#[test]
fn 人工編輯_prd_存成新版本並撤回任務核准_可只重新審查_核准時檢查版本() {
    let (root, cfg) = fixture();
    scenario(&root, json!({ "codex": { "rules": [{ "contains": "PRD 審查者", "text": "看過了\nVERDICT: APPROVE" }], "text": "# PRD\n由 AI 起草" } }));
    prd::draft_prd(&root, &cfg, "匯出 CSV", None).unwrap();
    let state = read_state(&root);
    assert_eq!(state["prd"]["status"], "awaiting_approval");
    assert_eq!(state["prd"]["version"], 1);
    let scope = state["prd"]["reference_scope"].clone();
    update_state(&root, |s| s["task_approval"] = json!({ "revision": "r1" })).unwrap();

    assert_eq!(prd::save_manual(&root, "# PRD\n人工版本", &json!(99), &scope).unwrap_err().status, 409);
    assert_eq!(prd::save_manual(&root, "# PRD\n人工版本", &json!(1), &json!("other-scope")).unwrap_err().status, 409);
    assert_eq!(prd::save_manual(&root, "   ", &json!(1), &scope).unwrap_err().status, 400);
    assert_eq!(prd::current_prd(&root), "# PRD\n由 AI 起草");
    assert_eq!(read_state(&root)["task_approval"]["revision"], "r1");

    let saved = prd::save_manual(&root, "# PRD\n人工版本", &json!(1), &scope).unwrap();
    assert_eq!(saved["version"], 2);
    assert_eq!(prd::current_prd(&root), "# PRD\n人工版本");
    assert_eq!(fs::read_to_string(root.join(".aipipe/prd/v1.md")).unwrap(), "# PRD\n由 AI 起草");
    assert_eq!(fs::read_to_string(root.join(".aipipe/prd/v2.md")).unwrap(), "# PRD\n人工版本");
    let state = read_state(&root);
    assert_eq!(state["prd"]["status"], "awaiting_approval");
    assert!(state["prd"]["human_edited_at"].is_string());
    assert!(state["prd"]["reviewed_version"].is_null());
    assert!(state["task_approval"].is_null());
    assert_eq!(state["task_gen"]["status"], "stale");
    let last = state["prd"]["rounds"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["kind"], "human_edit");
    assert_eq!(last["provider"], "human");
    assert_eq!(last["version"], 2);
    assert_eq!(prd::save_manual(&root, "# PRD\n人工版本", &json!(2), &scope).unwrap()["unchanged"], true);
    assert_eq!(read_state(&root)["prd"]["version"], 2);

    // 只重新審查：不呼叫作者 AI，原文不變，審查意見記在紀錄裡。
    let before = calls(&root).len();
    prd::review_current(&root, &cfg).unwrap();
    let records = calls(&root);
    assert_eq!(records.len(), before + 1);
    let prompt = records.last().unwrap()["prompt"].as_str().unwrap();
    assert!(prompt.contains("PRD 審查者") && prompt.contains("人工版本"), "{prompt}");
    assert_eq!(prd::current_prd(&root), "# PRD\n人工版本");
    let state = read_state(&root);
    assert_eq!(state["prd"]["status"], "awaiting_approval");
    assert_eq!(state["prd"]["reviewed_version"], 2);
    assert!(state["prd"]["pid"].is_null());
    let last = state["prd"]["rounds"].as_array().unwrap().last().unwrap().clone();
    assert_eq!(last["kind"], "review");
    assert_eq!(last["verdict"], "APPROVE");
    assert_eq!(last["version"], 2);
    assert!(fs::read_to_string(root.join(".aipipe/prd").join(last["file"].as_str().unwrap())).unwrap().contains("VERDICT: APPROVE"));

    // API 核准帶版本：過期版本或錯誤範圍都被拒絕，PRD 狀態不變。
    let p = add_project(&root, None).unwrap();
    let pid = p["id"].as_str().unwrap().to_string();
    assert_eq!(handle("POST", &format!("/api/p/{pid}/prd/approve"), &json!({ "version": 1, "scope": scope })).unwrap_err().status, 409);
    assert_eq!(handle("POST", &format!("/api/p/{pid}/prd/approve"), &json!({ "version": 2, "scope": "other" })).unwrap_err().status, 409);
    assert_eq!(read_state(&root)["prd"]["status"], "awaiting_approval");
    assert_eq!(handle("POST", &format!("/api/p/{pid}/prd/save"), &json!({ "text": "# PRD\n第三版", "version": 1, "scope": scope })).unwrap_err().status, 409);
    assert_eq!(handle("POST", &format!("/api/p/{pid}/prd/save"), &json!({ "text": "# PRD\n第三版", "version": 2, "scope": scope })).unwrap()["version"], 3);
    assert_eq!(prd::current_prd(&root), "# PRD\n第三版");
    remove_project(&pid).unwrap();

    // 流程執行中不能人工改 PRD。
    update_state(&root, |s| s["runner"]["pid"] = json!(std::process::id())).unwrap();
    assert_eq!(prd::save_manual(&root, "# PRD\n第四版", &json!(3), &scope).unwrap_err().status, 409);
}
