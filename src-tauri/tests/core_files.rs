//! 任務引擎、Skills、專案清單、佇列、待辦與封存的純檔案邏輯測試。所有流程資料都寫在暫存的資料目錄，專案資料夾保持乾淨。
mod common;

use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::Duration;

use ai_workflow::core::archive::{archive_path, archive_prd, archive_tasks, feature_slug, list_archives, read_archive, tag_slug};
use ai_workflow::core::backlog;
use ai_workflow::core::config::{default_config, save_project};
use ai_workflow::core::projects::{add_project, list_projects, project_id, project_summary, remove_project};
use ai_workflow::core::queue;
use ai_workflow::core::skills::{import_skill, list_skills, load_skill, native_path, parse_skill, prepare_skills, save_skill};
use ai_workflow::core::state::{data_dir, ensure_dirs, update_state};
use ai_workflow::core::tasks::{current_tag, next_task_id, read_tasks, set_status, tag_name, tasks_file, validate_tasks, write_tasks};
use ai_workflow::core::util::today;
use common::*;
use serde_json::{json, Value};

fn make_project() -> PathBuf {
    let dir = project();
    save_project(&dir, &json!({})).unwrap();
    ensure_dirs(&dir).unwrap();
    dir
}

fn tasks(v: Value) -> Vec<Value> {
    v.as_array().unwrap().clone()
}

fn complete(root: &Path, id: &str) {
    for s in ["in-progress", "review", "done"] {
        set_status(root, id, s).unwrap();
    }
}

/// 一個會一直活著的子程序，當作「另一個 ai-workflow run」的 pid。
fn sleeper() -> Child {
    let mut cmd = if cfg!(windows) {
        let mut c = Command::new("ping");
        c.args(["-n", "60", "127.0.0.1"]);
        c
    } else {
        let mut c = Command::new("sleep");
        c.arg("60");
        c
    };
    cmd.stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap()
}

// ---------- 任務引擎 ----------

#[test]
fn 依賴不存在_循環_自我依賴與重複_id_都會被拒絕_保留舊任務() {
    let root = project();
    write_tasks(&root, &tasks(json!([{ "title": "original" }])), None, json!({})).unwrap();
    let before = fs::read_to_string(tasks_file(&root)).unwrap();
    let cases = [
        json!([{ "title": "bad", "dependencies": [99] }]),
        json!([{ "id": 1, "title": "a", "dependencies": [2] }, { "id": 2, "title": "b", "dependencies": [1] }]),
        json!([{ "title": "bad", "dependencies": [1] }]),
        json!([{ "id": 1, "title": "a" }, { "id": 1, "title": "b" }]),
    ];
    for case in cases {
        assert!(write_tasks(&root, &tasks(case), None, json!({})).is_err());
    }
    assert_eq!(fs::read_to_string(tasks_file(&root)).unwrap(), before);
    assert!(tasks_file(&root).starts_with(data_dir(&root)));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0, "任務資料不放在專案資料夾");
}

#[test]
fn 保留非連續_id_與向後依賴_選擇高優先序且依賴已完成的任務() {
    let root = project();
    write_tasks(&root, &tasks(json!([
        { "id": 10, "title": "later", "dependencies": [20], "priority": "high" },
        { "id": 20, "title": "first", "priority": "low" },
        { "id": 30, "title": "other", "priority": "medium" },
    ])), None, json!({})).unwrap();
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("30"));
    set_status(&root, "30", "blocked").unwrap();
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("20"));
    assert!(set_status(&root, "10", "in-progress").unwrap_err().message.contains("依賴尚未完成"));
    complete(&root, "20");
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("10"));
    assert!(set_status(&root, "10", "done").unwrap_err().message.contains("review"));
    complete(&root, "10");
    assert!(set_status(&root, "20", "pending").unwrap_err().message.contains("先重設"));
    assert_eq!(read_tasks(&root).unwrap().iter().find(|t| t["id"] == 20).unwrap()["status"], "done");
}

#[test]
fn 子任務依賴_父任務依賴與父任務完成狀態一致() {
    let root = project();
    write_tasks(&root, &tasks(json!([
        { "id": 1, "title": "setup" },
        { "id": 2, "title": "feature", "dependencies": [1], "subtasks": [{ "id": 1, "title": "UI" }, { "id": 2, "title": "checks", "dependencies": [1] }] },
        { "id": 3, "title": "integration", "dependencies": [2] },
    ])), None, json!({})).unwrap();
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("1"));
    complete(&root, "1");
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("2.1"));
    complete(&root, "2.1");
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("2.2"));
    complete(&root, "2.2");
    assert_eq!(read_tasks(&root).unwrap()[1]["status"], "done");
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("3"));
    let err = validate_tasks(&tasks(json!([{ "title": "p", "subtasks": [{ "title": "s", "dependencies": ["1"] }] }]))).unwrap_err();
    assert!(err.message.contains("循環"), "{}", err.message);
}

#[test]
fn 首次更新匯入舊_task_master_多群組資料_不改動來源() {
    let root = project();
    let dir = root.join(".taskmaster");
    fs::create_dir_all(dir.join("tasks")).unwrap();
    let legacy = json!({ "master": { "tasks": [{ "id": 1, "title": "old", "status": "done" }] }, "feature": { "tasks": [{ "id": 4, "title": "current", "status": "pending", "dependencies": [], "subtasks": [] }] } }).to_string();
    fs::write(dir.join("tasks").join("tasks.json"), &legacy).unwrap();
    fs::write(dir.join("state.json"), r#"{"currentTag":"feature"}"#).unwrap();
    assert_eq!(current_tag(&root).unwrap(), "feature");
    assert_eq!(read_tasks(&root).unwrap()[0]["id"], 4);
    set_status(&root, "4", "in-progress").unwrap();
    let store: Value = serde_json::from_str(&fs::read_to_string(tasks_file(&root)).unwrap()).unwrap();
    assert_eq!(store["groups"]["master"]["tasks"][0]["status"], "done");
    assert_eq!(store["groups"]["feature"]["tasks"][0]["status"], "in-progress");
    assert_eq!(fs::read_to_string(dir.join("tasks").join("tasks.json")).unwrap(), legacy);
}

#[test]
fn 同時更新不同任務不會遺失更新() {
    let root = project();
    write_tasks(&root, &tasks(json!([{ "title": "one" }, { "title": "two" }])), None, json!({})).unwrap();
    let handles: Vec<_> = ["1", "2"].into_iter().map(|id| {
        let root = root.clone();
        std::thread::spawn(move || set_status(&root, id, "in-progress").unwrap())
    }).collect();
    for h in handles {
        h.join().unwrap();
    }
    let statuses: Vec<Value> = read_tasks(&root).unwrap().iter().map(|t| t["status"].clone()).collect();
    assert_eq!(statuses, vec![json!("in-progress"), json!("in-progress")]);
}

#[test]
fn 損壞的內建任務檔會報錯_不會退回舊檔覆蓋() {
    let root = project();
    write_tasks(&root, &tasks(json!([{ "title": "a" }])), None, json!({})).unwrap();
    fs::write(tasks_file(&root), "{broken").unwrap();
    assert!(read_tasks(&root).is_err());
    assert!(write_tasks(&root, &tasks(json!([{ "title": "b" }])), None, json!({})).is_err());
    assert_eq!(fs::read_to_string(tasks_file(&root)).unwrap(), "{broken");
}

#[test]
fn 內建任務群組_保留不同功能的任務() {
    let dir = make_project();
    write_tasks(&dir, &tasks(json!([{ "title": "old" }])), None, json!({})).unwrap();
    write_tasks(&dir, &tasks(json!([{ "title": "new 1" }, { "title": "new 2", "dependencies": [1] }])), Some("f-20261101-csv"), json!({})).unwrap();
    let data: Value = serde_json::from_str(&fs::read_to_string(tasks_file(&dir)).unwrap()).unwrap();
    let keys: Vec<&String> = data["groups"].as_object().unwrap().keys().collect();
    assert_eq!(keys, ["master", "f-20261101-csv"]);
    assert_eq!(data["groups"]["master"]["tasks"][0]["title"], "old");
    let titles: Vec<Value> = read_tasks(&dir).unwrap().iter().map(|t| t["title"].clone()).collect();
    assert_eq!(titles, vec![json!("new 1"), json!("new 2")]);
    assert_eq!(tag_name("2026-11-01", "csv", &["f-20261101-csv".into()]), "f-20261101-csv-2");
    assert_eq!(tag_slug("匯出 CSV 功能"), "csv");
    assert_eq!(tag_slug("中文想法"), "feature");
    assert_eq!(feature_slug("匯出 CSV 功能！"), "匯出-csv-功能");
}

// ---------- Skills ----------

fn manifest(name: &str) -> String {
    format!("---\nname: {name}\ndescription: |\n  A shared skill\n  with multiline YAML.\n---\nRead references/design.md when needed.\n")
}

#[test]
fn 預設技能可被標準_yaml_解析_匯入完整資源並保存不可變版本快照() {
    let root = project();
    let source = project();
    let names: Vec<Value> = list_skills(&root).iter().map(|s| s["name"].clone()).collect();
    assert_eq!(names, vec![json!("grill-me"), json!("uiux-design")]);
    fs::write(source.join("SKILL.md"), manifest("custom-design")).unwrap();
    fs::create_dir_all(source.join("references")).unwrap();
    fs::write(source.join("references").join("design.md"), "original").unwrap();
    import_skill(&root, &source.to_string_lossy()).unwrap();
    let cfg = json!({ "skills": { "implement": ["custom-design"] } });
    let first = prepare_skills(&root, &cfg, Some("implement"), None, &native_path).unwrap();
    fs::write(data_dir(&root).join("skills/custom-design/references/design.md"), "changed").unwrap();
    let second = prepare_skills(&root, &cfg, Some("implement"), None, &native_path).unwrap();
    assert_ne!(first.snapshots[0]["version"], second.snapshots[0]["version"]);
    let snap = PathBuf::from(first.snapshots[0]["path"].as_str().unwrap());
    assert!(snap.starts_with(data_dir(&root)), "Skill 快照放在資料目錄");
    assert_eq!(fs::read_to_string(snap.join("references").join("design.md")).unwrap(), "original");
    assert!(import_skill(&root, &source.to_string_lossy()).unwrap_err().message.contains("同名"));
    assert!(load_skill(&root, "../escape").unwrap_err().message.contains("名稱"));
    assert_eq!(fs::read_dir(&root).unwrap().count(), 0);
}

#[test]
fn 不會默默執行專屬_frontmatter_壞_yaml_與缺少說明會拒絕() {
    let root = project();
    save_skill(&root, "---\nname: special\ndescription: test\nhooks: {}\n---\nRun things.", None).unwrap();
    assert_eq!(list_skills(&root).iter().find(|s| s["name"] == "special").unwrap()["compatible"], false);
    let err = prepare_skills(&root, &json!({}), None, Some(&["special".to_string()]), &native_path).unwrap_err();
    assert!(err.message.contains("專屬欄位"));
    assert!(parse_skill("---\nname: test\n---\nbody").is_err());
    assert!(parse_skill("---\nname: [\n---\nbody").is_err());
    assert_eq!(prepare_skills(&root, &default_config(), Some("prd"), None, &native_path).unwrap().text, "");
}

// ---------- 專案清單、佇列、待辦、封存 ----------

#[test]
fn 專案清單_加入_重複加入不重複_移除_不是_git_repo_不能自動加入() {
    let a = make_project();
    let b = make_project();
    add_project(&a, None).unwrap();
    add_project(&b, Some("第二個")).unwrap();
    add_project(&a, None).unwrap();
    let list = list_projects();
    let mine: Vec<&Value> = list.iter().filter(|p| p["path"] == a.to_string_lossy().as_ref() || p["path"] == b.to_string_lossy().as_ref()).collect();
    assert_eq!(mine.len(), 2);
    assert_eq!(list.iter().find(|p| p["path"] == b.to_string_lossy().as_ref()).unwrap()["name"], "第二個");
    assert_eq!(list.iter().find(|p| p["path"] == a.to_string_lossy().as_ref()).unwrap()["id"], project_id(&a));
    // 從專案目錄或子目錄執行 CLI 時，用 projects.json 找專案。
    fs::create_dir_all(a.join("src/deep")).unwrap();
    assert_eq!(ai_workflow::core::config::find_project_root(&a.join("src/deep")), a);
    let empty = project();
    let err = add_project(&empty, None).unwrap_err();
    assert!(err.message.contains("git"), "{}", err.message);
    assert_eq!(fs::read_dir(&empty).unwrap().count(), 0);
    // git repo 可以直接加入，自動偵測指令，專案裡不新增檔案。
    let repo = project();
    git(&repo, &["init", "-q"]);
    fs::write(repo.join("Cargo.toml"), "[package]\nname = \"x\"\n").unwrap();
    let p = add_project(&repo, None).unwrap();
    assert_eq!(ai_workflow::core::config::load_config(&repo).unwrap()["commands"]["test"], "cargo test");
    let names: Vec<String> = fs::read_dir(&repo).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec![".git", "Cargo.toml"]);
    remove_project(p["id"].as_str().unwrap()).unwrap();
    remove_project(&project_id(&b)).unwrap();
    remove_project(&a.to_string_lossy()).unwrap();
    assert!(!list_projects().iter().any(|p| p["path"] == a.to_string_lossy().as_ref() || p["path"] == b.to_string_lossy().as_ref()));
}

#[test]
fn 專案摘要_prd_等待核准時標成需要處理_任務進度正確() {
    let dir = make_project();
    let p = add_project(&dir, None).unwrap();
    update_state(&dir, |s| s["prd"]["status"] = json!("awaiting_approval")).unwrap();
    let sum = project_summary(&p);
    assert_eq!(sum["status"], "awaiting_approval");
    assert_eq!(sum["attention"], true);
    update_state(&dir, |s| s["prd"]["status"] = json!("approved")).unwrap();
    write_tasks(&dir, &tasks(json!([{ "title": "A", "description": "a" }, { "title": "B", "description": "b" }])), None, json!({})).unwrap();
    // 任務產生後要先人工核准，總覽標成需要處理；核准後才是「可以開始」。
    let sum = project_summary(&p);
    assert_eq!(sum["status"], "awaiting_tasks");
    assert_eq!(sum["attention"], true);
    ai_workflow::core::human::approve_tasks(&dir, &ai_workflow::core::tasks::revision(&dir).unwrap()).unwrap();
    let sum = project_summary(&p);
    assert_eq!(sum["status"], "ready");
    assert_eq!(sum["attention"], false);
    assert_eq!(sum["progress"], json!({ "done": 0, "total": 2 }));
    remove_project(p["id"].as_str().unwrap()).unwrap();
}

/// 佇列是全域的，三個佇列測試依序跑，避免互相搶名額。
#[test]
fn 佇列() {
    setup();
    let me = std::process::id();
    // 上限 1 時第二個要排隊，前面的釋放後依序接上；max 可以設定
    let mut other = sleeper();
    let op = other.id();
    queue::set_max_concurrent(&json!(1)).unwrap();
    assert!(queue::try_acquire(Path::new("/x/one"), op).unwrap().granted);
    let r = queue::try_acquire(Path::new("/x/two"), me).unwrap();
    assert!(!r.granted);
    assert_eq!(r.position, 1);
    assert_eq!(queue::queue_entry_for(Path::new("/x/two")).unwrap()["state"], "waiting");
    queue::release(op).unwrap();
    assert!(queue::try_acquire(Path::new("/x/two"), me).unwrap().granted);
    assert_eq!(queue::queue_entry_for(Path::new("/x/two")).unwrap()["state"], "running");
    queue::release(me).unwrap();
    queue::set_max_concurrent(&json!(2)).unwrap();
    assert_eq!(ai_workflow::core::config::load_global().unwrap()["max_concurrent_runs"], 2, "上限存在全域設定");
    assert!(queue::try_acquire(Path::new("/x/one"), op).unwrap().granted);
    assert!(queue::try_acquire(Path::new("/x/two"), me).unwrap().granted);
    queue::release(me).unwrap();
    queue::release(op).unwrap();
    assert!(queue::set_max_concurrent(&json!(0)).unwrap_err().message.contains("1–8"));
    queue::set_max_concurrent(&json!(1)).unwrap();

    // 結束的程序自動清掉，不會卡住名額
    assert!(queue::try_acquire(Path::new("/x/dead"), op).unwrap().granted);
    other.kill().unwrap();
    other.wait().unwrap();
    assert!(queue::try_acquire(Path::new("/x/alive"), me).unwrap().granted);
    queue::release(me).unwrap();

    // acquire_slot 排隊時可以放棄（暫停）
    let mut busy = sleeper();
    queue::try_acquire(Path::new("/x/busy"), busy.id()).unwrap();
    let mut positions = vec![];
    let mut aborted = false;
    let ok = queue::acquire_slot(Path::new("/x/me"), |pos, _| positions.push(pos), || { aborted = true; true }, Duration::from_millis(10)).unwrap();
    assert!(!ok);
    assert!(aborted);
    assert_eq!(positions, vec![1]);
    assert!(queue::queue_entry_for(Path::new("/x/me")).is_none());
    queue::release(busy.id()).unwrap();
    let _ = busy.kill();
    let _ = busy.wait();
}

#[test]
fn 需求待辦_新增_編輯_排序_刪除_存在資料目錄() {
    let dir = make_project();
    let a = backlog::add_item(&dir, Some(&json!(" 匯出 CSV ")), Some(&json!("可選欄位"))).unwrap();
    let b = backlog::add_item(&dir, Some(&json!("深色模式")), None).unwrap();
    assert_eq!(a["title"], "匯出 CSV");
    assert!(backlog::add_item(&dir, Some(&json!("  ")), None).unwrap_err().message.contains("標題"));
    backlog::reorder_items(&dir, &json!([b["id"], a["id"]])).unwrap();
    let titles: Vec<Value> = backlog::read_backlog(&dir).unwrap().iter().map(|i| i["title"].clone()).collect();
    assert_eq!(titles, vec![json!("深色模式"), json!("匯出 CSV")]);
    let aid = a["id"].as_str().unwrap();
    backlog::update_item(&dir, aid, &json!({ "title": "匯出 CSV 與 Excel", "status": "in_progress" })).unwrap();
    assert_eq!(backlog::get_item(&dir, aid).unwrap()["status"], "in_progress");
    assert!(backlog::update_item(&dir, aid, &json!({ "status": "x" })).unwrap_err().message.contains("狀態"));
    assert_eq!(backlog::idea_for(&backlog::get_item(&dir, aid).unwrap()), "匯出 CSV 與 Excel\n\n可選欄位");
    backlog::delete_item(&dir, b["id"].as_str().unwrap()).unwrap();
    let file: Value = serde_json::from_str(&fs::read_to_string(backlog::backlog_file(&dir)).unwrap()).unwrap();
    assert_eq!(file["items"].as_array().unwrap().len(), 1);
    assert_eq!(backlog::backlog_file(&dir), data_dir(&dir).join("backlog.json"));
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "需求待辦不放在專案資料夾");
}

#[test]
fn 損壞需求待辦拒絕當成空清單_不覆寫原始檔() {
    let root = make_project();
    let path = backlog::backlog_file(&root);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    for raw in ["{broken", "{}", "{\"items\":null}"] {
        fs::write(&path, raw).unwrap();
        assert!(backlog::read_backlog(&root).is_err());
        assert!(backlog::add_item(&root, Some(&json!("new")), None).is_err());
        assert_eq!(fs::read_to_string(&path).unwrap(), raw);
    }
}

#[test]
fn 需求待辦支援_bom_並在更新前保留備份() {
    let root = make_project();
    let path = backlog::backlog_file(&root);
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let raw = "\u{feff}{\"version\":1,\"items\":[{\"id\":\"old\",\"title\":\"original\",\"status\":\"open\"}]}";
    fs::write(&path, raw).unwrap();
    backlog::add_item(&root, Some(&json!("new")), None).unwrap();
    assert_eq!(backlog::read_backlog(&root).unwrap().len(), 2);
    assert_eq!(fs::read_to_string(path.with_file_name("backlog.json.bak")).unwrap(), raw);
}

#[test]
fn 同時新增需求不會互相覆蓋() {
    let root = make_project();
    std::thread::scope(|scope| {
        let handles: Vec<_> = (0..8).map(|i| {
            let root = &root;
            scope.spawn(move || backlog::add_item(root, Some(&json!(format!("item-{i}"))), None).unwrap())
        }).collect();
        for handle in handles { handle.join().unwrap(); }
    });
    let items = backlog::read_backlog(&root).unwrap();
    assert_eq!(items.len(), 8);
    for i in 0..8 { assert!(items.iter().any(|item| item["title"] == format!("item-{i}"))); }
}

#[test]
fn 封存_建立_日期_功能_資料夾_下一個功能不覆蓋上一個() {
    let dir = make_project();
    let cfg = default_config();
    let prd = data_dir(&dir).join("prd");
    let draft = |text: &str| {
        fs::write(prd.join("current.md"), text).unwrap();
        fs::write(prd.join("v1.md"), text).unwrap();
        fs::write(prd.join("review-1.md"), "VERDICT: APPROVE").unwrap();
        update_state(&dir, |s| {
            s["prd"]["status"] = json!("awaiting_approval");
            s["prd"]["idea"] = json!("匯出 CSV");
            s["prd"]["archive_dir"] = Value::Null;
            s["prd"]["rounds"] = json!([
                { "kind": "draft", "round": 0, "provider": "claude", "version": 1, "file": "v1.md" },
                { "kind": "review", "round": 1, "provider": "codex", "verdict": "APPROVE", "version": 1, "file": "review-1.md" },
            ]);
        }).unwrap();
    };
    draft("# PRD A");
    let rel = archive_prd(&dir, &cfg).unwrap();
    assert!(rel.starts_with("archive/"), "{rel}");
    assert!(archive_path(&dir, &rel).join("prd.md").exists());
    write_tasks(&dir, &tasks(json!([{ "title": "A1" }])), None, json!({})).unwrap();
    archive_tasks(&dir, json!({})).unwrap();
    // 同一個功能重新核准：同一個資料夾
    archive_prd(&dir, &cfg).unwrap();
    draft("# PRD B");
    archive_prd(&dir, &cfg).unwrap();
    let list = list_archives(&dir).unwrap();
    let mut names: Vec<String> = list.iter().map(|a| a["name"].as_str().unwrap().to_string()).collect();
    names.sort();
    let date = today();
    assert_eq!(names, vec![format!("{date}-匯出-csv"), format!("{date}-匯出-csv-2")]);
    let first = read_archive(&dir, &format!("{date}-匯出-csv")).unwrap();
    assert_eq!(first["prd"], "# PRD A");
    let rounds: Vec<Value> = first["rounds"].as_array().unwrap().iter().map(|r| r["name"].clone()).collect();
    assert_eq!(rounds, vec![json!("01-draft-r0-v1.md"), json!("02-review-r1-approve-v1.md")]);
    assert_eq!(first["tasks"][0]["title"], "A1");
    assert_eq!(read_archive(&dir, &format!("{date}-匯出-csv-2")).unwrap()["prd"], "# PRD B");
    assert!(read_archive(&dir, "../x").unwrap_err().message.contains("不正確"));
    assert_eq!(fs::read_dir(&dir).unwrap().count(), 0, "封存不放在專案資料夾");
}
