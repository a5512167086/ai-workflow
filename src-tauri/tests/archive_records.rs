//! 功能封存也保存每個任務的實作紀錄（log、實作說明、審查、檢查、diff），之後可以在「紀錄」回頭看；
//! 下一個功能的任務編號會重複，所以紀錄要跟著功能走，不能和新任務混在一起。
mod common;

use std::fs;
use std::path::Path;

use ai_workflow::core::api::handle;
use ai_workflow::core::archive::{archive_prd, archive_tasks, release_task_records, settle_task_records};
use ai_workflow::core::config::{default_config, save_config};
use ai_workflow::core::projects::{add_project, remove_project};
use ai_workflow::core::state::{data_dir, read_state, update_state};
use ai_workflow::core::tasks;
use common::*;
use serde_json::{json, Value};

/// 模擬一個任務跑過：tasks/<id>/ 的檔案與 logs/task-<id>.log。
fn run_records(root: &Path, id: &str, label: &str) {
    let dir = data_dir(root).join("tasks").join(id);
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("implement.md"), format!("{label} 實作說明")).unwrap();
    fs::write(dir.join("review-1.md"), format!("{label} 審查\nVERDICT: APPROVE")).unwrap();
    fs::write(dir.join("diff.patch"), "diff --git a/x b/x\n").unwrap();
    fs::create_dir_all(data_dir(root).join("logs")).unwrap();
    fs::write(data_dir(root).join("logs").join(format!("task-{id}.log")), format!("[10:00:00] {label} log\n")).unwrap();
}

/// 核准一個功能並產生任務清單（state.tasks 清空，與產生任務時相同）。
fn approve_feature(root: &Path, idea: &str, titles: &[&str]) -> String {
    fs::create_dir_all(data_dir(root).join("prd")).unwrap();
    fs::write(data_dir(root).join("prd/current.md"), format!("# {idea}")).unwrap();
    update_state(root, |s| { s["prd"]["status"] = json!("approved"); s["prd"]["idea"] = json!(idea); s["prd"]["archive_dir"] = Value::Null; s["prd"]["rounds"] = json!([]); }).unwrap();
    let rel = archive_prd(root, &default_config()).unwrap();
    let list: Vec<Value> = titles.iter().enumerate().map(|(i, t)| json!({ "id": i + 1, "title": t })).collect();
    tasks::write_tasks(root, &list, Some("master"), json!({})).unwrap();
    update_state(root, |s| s["tasks"] = json!({})).unwrap();
    archive_tasks(root, json!({})).unwrap();
    rel.trim_start_matches("archive/").to_string()
}

#[test]
fn 任務的實作紀錄跟著功能封存_開始新功能後從空白開始_封存裡可以讀回() {
    let root = project();
    save_config(&root, &default_config()).unwrap();
    let p = add_project(&root, None).unwrap();
    let pid = p["id"].as_str().unwrap().to_string();
    let get = |path: &str| handle("GET", &format!("/api/p/{pid}/{path}"), &Value::Null);

    // 第一個功能：任務 1 跑過（有執行狀態），任務 2 還沒跑。
    let first = approve_feature(&root, "匯出 CSV", &["匯出按鈕", "欄位選擇"]);
    run_records(&root, "1", "第一個功能");
    update_state(&root, |s| s["tasks"]["1"] = json!({ "phase": "done", "step": "人工測試通過" })).unwrap();
    archive_tasks(&root, json!({ "completed_at": "2026-11-03T00:00:00Z" })).unwrap();
    let records = data_dir(&root).join("archive").join(&first).join("task-records").join("1");
    assert_eq!(fs::read_to_string(records.join("task.log")).unwrap(), "[10:00:00] 第一個功能 log\n");
    assert!(records.join("review-1.md").exists() && records.join("diff.patch").exists());
    assert!(!data_dir(&root).join("archive").join(&first).join("task-records").join("2").exists(), "沒跑過的任務沒有紀錄");

    // 封存裡的任務：內容、當時的狀態與紀錄都讀得到（API）。
    let detail = get(&format!("archive/{first}/task/1")).unwrap();
    assert_eq!(detail["task"]["title"], "匯出按鈕");
    assert_eq!(detail["state"]["phase"], "done");
    assert_eq!(detail["hasRecords"], true);
    assert_eq!(detail["implement"], "第一個功能 實作說明");
    assert_eq!(detail["reviews"][0]["round"], 1);
    assert!(detail["log"].as_str().unwrap().contains("第一個功能 log"));
    let none = get(&format!("archive/{first}/task/2")).unwrap();
    assert_eq!(none["hasRecords"], false);
    assert_eq!(get(&format!("archive/{first}/task/9")).unwrap_err().status, 404);
    assert_eq!(get("archive/..%2Fx/task/1").unwrap_err().status, 400);

    // 開始新功能：封存好之後原本的紀錄清掉，新功能的任務 1 從空白開始。
    release_task_records(&root);
    assert!(!data_dir(&root).join("tasks/1").exists());
    assert!(!data_dir(&root).join("logs/task-1.log").exists());
    assert!(records.join("task.log").exists(), "封存裡的紀錄還在");
    remove_project(&pid).unwrap();
}

#[test]
fn 舊版留下的任務紀錄在下一次執行前搬回原本的功能_不會接在新任務後面() {
    let root = project();
    save_config(&root, &default_config()).unwrap();
    let p = add_project(&root, None).unwrap();
    let pid = p["id"].as_str().unwrap().to_string();

    // 舊版：第一個功能的紀錄沒有封存，也沒有清掉。
    let first = approve_feature(&root, "第一個功能", &["a", "b"]);
    for id in ["1", "2"] { run_records(&root, id, "舊功能"); }
    // 第二個功能核准並產生任務（state.tasks 清空）：留下的紀錄不屬於它。
    let second = approve_feature(&root, "第二個功能", &["c"]);
    let archive = data_dir(&root).join("archive");
    // 產生任務時的 archive_tasks 已經把它們搬回第一個功能。
    assert!(archive.join(&first).join("task-records/1/task.log").exists());
    assert!(archive.join(&first).join("task-records/2/review-1.md").exists());
    assert!(!archive.join(&second).join("task-records").exists());
    assert!(!data_dir(&root).join("tasks/1").exists() && !data_dir(&root).join("logs/task-1.log").exists());

    // 找不到對應功能的紀錄不刪除：留在原處。
    run_records(&root, "7", "不知道是誰的");
    settle_task_records(&root).unwrap();
    assert!(data_dir(&root).join("logs/task-7.log").exists());
    assert_eq!(read_state(&root)["prd"]["archive_dir"], format!("archive/{second}"));
    remove_project(&pid).unwrap();
}
