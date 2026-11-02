//! API 路由測試：路由由 Tauri command 呼叫，路徑與回傳格式不變。
mod common;

use std::fs;

use ai_workflow::core::api::handle;
use ai_workflow::core::config::{project_registered, save_project};
use ai_workflow::core::projects::{add_project, remove_project};
use ai_workflow::core::state::data_dir;
use common::*;
use serde_json::{json, Value};

#[test]
fn api_專案範圍路由_總覽_backlog_與加入專案不在專案裡寫檔() {
    let dir = project();
    save_project(&dir, &json!({})).unwrap();
    let p = add_project(&dir, None).unwrap();
    let id = p["id"].as_str().unwrap();
    let get = |path: &str| handle("GET", path, &Value::Null);
    let post = |path: &str, body: Value| handle("POST", path, &body);

    let state = get(&format!("/api/p/{id}/state")).unwrap();
    assert_eq!(state["project"]["id"], id);
    assert_eq!(state["root"], dir.to_string_lossy().as_ref());
    assert_eq!(state["dataDir"], data_dir(&dir).to_string_lossy().as_ref());
    let usage = get(&format!("/api/p/{id}/usage")).unwrap();
    assert!(usage["totalTokens"].is_null());
    assert_eq!(usage["providers"].as_array().unwrap().len(), 2);
    let skills = get(&format!("/api/p/{id}/skills")).unwrap();
    let names: Vec<Value> = skills["skills"].as_array().unwrap().iter().map(|s| s["name"].clone()).collect();
    assert_eq!(names, vec![json!("grill-me"), json!("uiux-design")]);
    // Skills 綁定是全域設定：從專案頁存，總覽的 /api/config 也看得到。
    post(&format!("/api/p/{id}/skills/config"), json!({ "skills": { "implement": ["uiux-design"] } })).unwrap();
    assert_eq!(get(&format!("/api/p/{id}/skills")).unwrap()["config"]["implement"], json!(["uiux-design"]));
    assert_eq!(get("/api/config").unwrap()["config"]["skills"]["implement"], json!(["uiux-design"]));
    post("/api/skills/config", json!({ "skills": { "implement": [] } })).unwrap();

    let all = get("/api/projects").unwrap();
    assert!(all["projects"].as_array().unwrap().iter().any(|x| x["id"] == id));
    assert!(all["queue"]["max"].as_u64().is_some());
    assert_eq!(get("/api/p/0000000000/state").unwrap_err().status, 404);
    assert_eq!(post(&format!("/api/p/{id}/nosuch"), json!({})).unwrap_err().status, 404);

    post(&format!("/api/p/{id}/backlog/add"), json!({ "title": "從 API 新增" })).unwrap();
    assert_eq!(get(&format!("/api/p/{id}/backlog")).unwrap()["items"][0]["title"], "從 API 新增");
    assert_eq!(post(&format!("/api/p/{id}/prd/new"), json!({ "idea": "  " })).unwrap_err().status, 400);
    assert_eq!(post(&format!("/api/p/{id}/task/rerun"), json!({ "id": "x" })).unwrap_err().status, 400);
    assert!(get(&format!("/api/p/{id}/archive")).unwrap()["items"].as_array().unwrap().is_empty());
    assert_eq!(get(&format!("/api/p/{id}/log/runner")).unwrap()["size"], 0);
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "專案資料夾不能有任何檔案");

    // 專案欄位（build/test/lint、feature、context_files）只寫進 project.json。
    post(&format!("/api/p/{id}/config/project"), json!({ "commands": { "test": "npm test" }, "feature": "csv", "context_files": ["README.md", ""] })).unwrap();
    let cfg = get(&format!("/api/p/{id}/state")).unwrap()["config"].clone();
    assert_eq!(cfg["commands"]["test"], "npm test");
    assert_eq!(cfg["context_files"], json!(["README.md"]));
    assert!(get("/api/config").unwrap()["config"].get("feature").is_none());

    // 加入不是 git repo 的資料夾要先確認 git init；加入後專案裡只有 .git。
    let fresh = project();
    let needs = post("/api/projects/add", json!({ "path": fresh.to_string_lossy() })).unwrap();
    assert_eq!(needs["needs_init"], true);
    assert_eq!(needs["needs_git"], true);
    let added = post("/api/projects/add", json!({ "path": fresh.to_string_lossy(), "init": true, "name": "新專案" })).unwrap();
    assert_eq!(added["project"]["name"], "新專案");
    assert!(fresh.join(".git").exists() && project_registered(&fresh));
    let names: Vec<String> = fs::read_dir(&fresh).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec![".git"]);
    assert!(post("/api/queue/config", json!({ "max": 0 })).is_err());

    remove_project(id).unwrap();
    remove_project(added["project"]["id"].as_str().unwrap()).unwrap();
}

#[test]
fn 全域設定路由_不需要專案() {
    setup();
    let get = |path: &str| handle("GET", path, &Value::Null);
    let post = |path: &str, body: Value| handle("POST", path, &body);
    let payload = get("/api/config").unwrap();
    assert!(payload["config"]["roles"].is_object() && payload["home"].is_string());
    assert_eq!(post("/api/config/mode", json!({ "mode": "x" })).unwrap_err().status, 400);
    let saved = post("/api/config/models", json!({ "roles": { "interviewer": "codex" } })).unwrap();
    assert_eq!(saved["config"]["roles"]["interviewer"], "codex");
    assert_eq!(get("/api/config").unwrap()["config"]["roles"]["interviewer"], "codex");
    post("/api/config/models", json!({ "roles": { "interviewer": "claude" } })).unwrap();
    assert_eq!(post("/api/config/limits", json!({ "branch_prefix": "bad prefix" })).unwrap_err().status, 400);
    assert_eq!(post("/api/config/runtime", json!({ "runtime": { "claude": "auto" } })).unwrap()["config"]["runtime"]["claude"], "auto");
    assert!(get("/api/models").unwrap()["claude"]["models"].as_array().is_some_and(|m| !m.is_empty()));
}
