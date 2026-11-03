//! 節省 token（token_saving）：用假 CLI 跑完整的實作 → 審查流程，檢查實際送出的 prompt 與用量頁的估計節省量。
mod common;

use std::fs;
use std::path::{Path, PathBuf};

use ai_workflow::core::cli::generate_tasks;
use ai_workflow::core::graph::{html_file, json_file, report_file};
use ai_workflow::core::config::{default_config, save_config, ROLES};
use ai_workflow::core::runner::run_pipeline;
use ai_workflow::core::state::{data_dir, prd_file, read_state, update_state};
use ai_workflow::core::usage::usage_snapshot;
use common::*;
use serde_json::{json, Value};

const PRD: &str = "# PRD
## 3. 使用者故事
- US-1 身為會計，我想要匯出月報
- US-2 身為會計，我想要篩選部門
## 4. 實作決策
報表服務新增匯出介面與篩選參數，資料來源沿用既有的帳務模組，金額一律以整數分儲存，時區固定為台北時間，匯出格式為 CSV 與 XLSX，大量資料分頁讀取，每頁一千筆，失敗時回傳可重試的錯誤碼並記錄稽核紀錄，權限沿用既有角色設定，只有會計與主管可以匯出。
## 5. 測試決策
在報表服務的公開介面測試。
## 6. 不做的事
不做排程寄送。
";
const LOCK: &str = "\"lockfileVersion\": 3";

fn scenario() -> Value {
    let mut rules = vec![json!({ "contains": "拆成可以逐一", "text": json!({ "tasks": [{ "title": "篩選部門", "details": "在 monthly() 加上部門參數", "requirement_ids": ["US-2"] }] }).to_string() })];
    rules.push(json!({ "contains": "程式碼審查者", "text": "沒問題\nVERDICT: PASS" }));
    rules.push(json!({ "contains": "請更新 handover 文件", "text": "# Handover" }));
    // codex 每次回合都寫同樣的檔案：實作時產生 lockfile 與程式，之後的回合不再改變內容。
    json!({ "codex": { "rules": rules, "text": "ok", "write": { "path": "package-lock.json", "content": format!("{{{LOCK}}}") } } })
}

/// git 專案、所有角色用 codex、實作綁內建 tdd 與 uiux-design、PRD 已核准、任務已核准。
fn project_with(scenario: Value, providers: &[&str], saving: Value) -> (PathBuf, Value) {
    let root = project();
    let mut cfg = default_config();
    cfg["runtime"] = json!({ "claude": "windows", "codex": "windows" });
    for p in ["claude", "codex"] {
        let path = if providers.contains(&p) { install_fake(&root, p) } else { root.join("missing.exe") };
        cfg["cli"][p] = json!(path.to_string_lossy());
    }
    for role in ROLES {
        cfg["roles"][role] = json!("codex");
    }
    cfg["skills"]["implement"] = json!(["tdd", "uiux-design"]);
    cfg["token_saving"] = ai_workflow::core::config::deep_merge(&cfg["token_saving"], &saving);
    save_config(&root, &cfg).unwrap();
    // 拆任務時還不寫檔：讓 lockfile 等改動出現在任務開始之後，算進這個任務的 diff。
    fs::write(root.join(".fake-cli.json"), json!({ "codex": { "rules": [scenario["codex"]["rules"][0].clone()] } }).to_string()).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.name", "test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    fs::write(root.join(".gitignore"), "*.exe\n.fake-cli*\n").unwrap();
    fs::write(root.join("report.rs"), "pub fn monthly() {}\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "initial"]);
    fs::create_dir_all(prd_file(&root).parent().unwrap()).unwrap();
    fs::write(prd_file(&root), PRD).unwrap();
    update_state(&root, |s| s["prd"]["status"] = json!("approved")).unwrap();
    generate_tasks(&root).unwrap();
    fs::write(root.join(".fake-cli.json"), scenario.to_string()).unwrap();
    ai_workflow::core::human::approve_tasks(&root, &ai_workflow::core::tasks::revision(&root).unwrap()).unwrap();
    (root, cfg)
}

fn prompt_of(root: &Path, marker: &str) -> String {
    calls(root).into_iter().map(|c| c["prompt"].as_str().unwrap_or("").to_string()).find(|p| p.contains(marker)).unwrap_or_else(|| panic!("找不到含「{marker}」的呼叫"))
}

fn session_of(root: &Path, stage: &str) -> Value {
    let dir = data_dir(root).join("sessions");
    fs::read_dir(dir).unwrap().filter_map(Result::ok).map(|e| serde_json::from_str::<Value>(&fs::read_to_string(e.path()).unwrap()).unwrap()).find(|s| s["stage"] == stage).unwrap()
}

fn features(session: &Value) -> Vec<String> {
    session["saved"].as_array().unwrap().iter().map(|e| e["feature"].as_str().unwrap().to_string()).collect()
}

#[test]
fn 預設開啟的節省項目_縮小實作與審查_prompt_並記錄估計節省量() {
    let (root, cfg) = project_with(scenario(), &["codex"], json!({}));
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting", "{}", read_state(&root)["pipeline"]["reason"]);

    // 實作：只附 US-2 與測試決策、不做的事，給完整 PRD 路徑；開發方法交給綁定的技能，內建 tdd 照常附加。
    let implement = prompt_of(&root, "你正在一個全新的對話中實作");
    assert!(implement.contains("US-2 身為會計") && implement.contains("在報表服務的公開介面測試") && implement.contains("不做排程寄送"), "{implement}");
    assert!(!implement.contains("US-1 身為會計") && !implement.contains("金額一律以整數分儲存"));
    assert!(implement.contains(&prd_file(&root).display().to_string()));
    assert!(implement.contains("### Skill: tdd") && implement.contains("### Skill: uiux-design"));
    assert!(!implement.contains("用 TDD 實作"), "prompt 本身不寫死開發方法");
    assert!(implement.contains("回覆風格：精簡"));
    assert!(implement.contains("## 專案圖譜") && implement.contains("NODE monthly() [src=report.rs loc=L1"), "專案圖譜預設開啟：{implement}");

    // 審查：lockfile 只留檔名與說明，內容不送；審查者也拿到精簡規則，handover 不套用。
    let review = prompt_of(&root, "你是程式碼審查者");
    assert!(review.contains("ai-workflow 已略過") && review.contains("package-lock.json"), "{review}");
    assert!(!review.contains(LOCK));
    assert!(review.contains("回覆風格：精簡"));
    assert!(!prompt_of(&root, "請更新 handover 文件").contains("回覆風格"));
    // 存給 UI 的 diff 仍是完整內容。
    assert!(fs::read_to_string(data_dir(&root).join("tasks/1/diff.patch")).unwrap().contains(LOCK));

    let implement_session = session_of(&root, "implement");
    assert_eq!(features(&implement_session), vec!["prd_excerpt"]);
    assert_eq!(implement_session["terse"], true);
    assert_eq!(features(&session_of(&root, "code_review")), vec!["review_diff_filter"]);
    assert_eq!(session_of(&root, "handover")["terse"], false);

    // 用量頁：每個 session 的估計節省量、依階段分類，以及目前的開關。
    let usage = usage_snapshot(&root, &cfg);
    assert!(usage["savedEstimate"].as_f64().unwrap() > 0.0, "{usage}");
    let stages: Vec<&str> = usage["byStage"].as_array().unwrap().iter().map(|s| s["stage"].as_str().unwrap()).collect();
    for stage in ["tasks", "implement", "code_review", "handover"] {
        assert!(stages.contains(&stage), "{stages:?}");
    }
    let implement_row = usage["byStage"].as_array().unwrap().iter().find(|s| s["stage"] == "implement").unwrap();
    assert!(implement_row["savedEstimate"].as_f64().unwrap() > 0.0);
    assert_eq!(usage["tokenSaving"]["prd_excerpt"], true);
}

#[test]
fn 全部關閉時照舊送完整_prd_技能與_diff_不加精簡規則() {
    let off = json!({ "review_diff_filter": false, "prd_excerpt": false, "dedupe_skills": false, "code_map": false, "terse": { "implementer": false, "code_reviewer": false } });
    let (root, cfg) = project_with(scenario(), &["codex"], off);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    let implement = prompt_of(&root, "你正在一個全新的對話中實作");
    assert!(implement.contains("## 完整 PRD") && implement.contains("US-1 身為會計") && implement.contains("金額一律以整數分儲存"));
    assert!(implement.contains("### Skill: tdd") && !implement.contains("回覆風格") && !implement.contains("## 專案圖譜"));
    let review = prompt_of(&root, "你是程式碼審查者");
    assert!(review.contains(LOCK) && !review.contains("ai-workflow 已略過"));
    assert!(session_of(&root, "implement")["saved"].as_array().unwrap().is_empty());
    assert_eq!(usage_snapshot(&root, &cfg)["savedEstimate"], 0);
}

#[test]
fn 專案圖譜依任務內容查出相關節點_三個輸出檔放在資料目錄() {
    let (root, _) = project_with(scenario(), &["codex"], json!({}));
    fs::write(root.join("filter.rs"), "use crate::report::monthly;\npub fn by_department() { monthly(); }\n").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "filter"]);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    let implement = prompt_of(&root, "你正在一個全新的對話中實作");
    // 任務細節提到 monthly()：查詢從它出發，帶出呼叫它的 by_department() 與那條關係。
    assert!(implement.contains("起點：[monthly()]") && implement.contains("NODE by_department() [src=filter.rs loc=L2"), "{implement}");
    assert!(implement.contains("EDGE by_department() --calls [") && implement.contains("--> monthly()"));
    assert!(implement.contains(&report_file(&root).display().to_string()) && implement.contains(&json_file(&root).display().to_string()));
    // 三個輸出都在資料目錄；lockfile 不進圖譜，專案資料夾不會多任何檔案。
    let report = fs::read_to_string(report_file(&root)).unwrap();
    assert!(report.starts_with("# 專案圖譜報告") && report.contains("## 核心節點"));
    let graph = fs::read_to_string(json_file(&root)).unwrap();
    assert!(graph.contains("\"id\":\"report.rs#monthly\"") && !graph.contains("package-lock.json"));
    assert!(fs::read_to_string(html_file(&root)).unwrap().contains("const DATA = {"));
    assert_no_app_files(&root);
}
