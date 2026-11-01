//! 移植 legacy/test/multi.test.js 的「伺服器」測試：路由改由 Tauri command 呼叫，路徑與回傳格式不變。
mod common;

use std::fs;

use aipipe::core::api::handle;
use aipipe::core::projects::{add_project, remove_project};
use aipipe::core::state::ensure_dirs;
use common::*;
use serde_json::{json, Value};

#[test]
fn api_專案範圍路由_總覽_backlog_與需要初始化() {
    let dir = project();
    fs::write(dir.join(".aipipe.json"), r#"{"mode":"manual"}"#).unwrap();
    ensure_dirs(&dir).unwrap();
    let p = add_project(&dir, None).unwrap();
    let id = p["id"].as_str().unwrap();
    let get = |path: &str| handle("GET", path, &Value::Null);
    let post = |path: &str, body: Value| handle("POST", path, &body);

    let state = get(&format!("/api/p/{id}/state")).unwrap();
    assert_eq!(state["project"]["id"], id);
    assert_eq!(state["root"], dir.to_string_lossy().as_ref());
    let usage = get(&format!("/api/p/{id}/usage")).unwrap();
    assert!(usage["totalTokens"].is_null());
    assert_eq!(usage["providers"].as_array().unwrap().len(), 2);
    let skills = get(&format!("/api/p/{id}/skills")).unwrap();
    let names: Vec<Value> = skills["skills"].as_array().unwrap().iter().map(|s| s["name"].clone()).collect();
    assert_eq!(names, vec![json!("grill-me"), json!("uiux-design")]);
    post(&format!("/api/p/{id}/skills/config"), json!({ "skills": { "implement": ["uiux-design"] } })).unwrap();
    assert_eq!(get(&format!("/api/p/{id}/skills")).unwrap()["config"]["implement"], json!(["uiux-design"]));

    let all = get("/api/projects").unwrap();
    assert!(all["projects"].as_array().unwrap().iter().any(|x| x["id"] == id));
    assert_eq!(all["queue"]["max"], 1);
    assert_eq!(get("/api/p/0000000000/state").unwrap_err().status, 404);
    assert_eq!(post(&format!("/api/p/{id}/nosuch"), json!({})).unwrap_err().status, 404);

    post(&format!("/api/p/{id}/backlog/add"), json!({ "title": "從 API 新增" })).unwrap();
    assert_eq!(get(&format!("/api/p/{id}/backlog")).unwrap()["items"][0]["title"], "從 API 新增");
    assert_eq!(post(&format!("/api/p/{id}/prd/new"), json!({ "idea": "  " })).unwrap_err().status, 400);
    assert_eq!(post(&format!("/api/p/{id}/task/rerun"), json!({ "id": "x" })).unwrap_err().status, 400);
    assert!(get(&format!("/api/p/{id}/archive")).unwrap()["items"].as_array().unwrap().is_empty());
    assert_eq!(get(&format!("/api/p/{id}/log/runner")).unwrap()["size"], 0);

    let fresh = project();
    let needs = post("/api/projects/add", json!({ "path": fresh.to_string_lossy() })).unwrap();
    assert_eq!(needs["needs_init"], true);
    assert_eq!(needs["needs_git"], true);
    let added = post("/api/projects/add", json!({ "path": fresh.to_string_lossy(), "init": true, "name": "新專案" })).unwrap();
    assert_eq!(added["project"]["name"], "新專案");
    assert!(fresh.join(".git").exists() && fresh.join(".aipipe.json").exists());
    assert!(post("/api/queue/config", json!({ "max": 0 })).is_err());

    remove_project(id).unwrap();
    remove_project(added["project"]["id"].as_str().unwrap()).unwrap();
}
