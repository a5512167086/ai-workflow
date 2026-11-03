//! 需要真的執行 CLI 的測試（額度切換、Skills、單 AI PRD、用量事件串流），以及整個 prd → tasks → run → continue → rerun 流程。
//! CLI 由 examples/fake_cli.rs 扮演。所有流程資料都寫在資料目錄，專案裡只有測試自己放的檔案。
mod common;

use std::fs;
use std::path::{Path, PathBuf};

use ai_workflow::core::agents::{run_agent, AgentOpts};
use ai_workflow::core::archive::archive_path;
use ai_workflow::core::cli::{generate_tasks, run_skill};
use ai_workflow::core::config::{default_config, save_config};
use ai_workflow::core::prd::{approve_prd, draft_prd};
use ai_workflow::core::runner::{acknowledge, prepare_rerun, run_pipeline, Next};
use ai_workflow::core::skills::{list_skill_runs, load_skill, native_path, prepare_skills};
use ai_workflow::core::state::{data_dir, handover_file, prd_file, read_state, update_state};
use ai_workflow::core::tasks::{next_task_id, read_tasks, tasks_file};
use ai_workflow::core::usage::usage_snapshot;
use common::*;
use serde_json::{json, Value};

const LIMIT: &str = "You've hit your session limit · resets 9:10pm (Asia/Taipei)";

/// 專案裡裝好假 CLI；providers 以外的 CLI 指到不存在的路徑（模擬未安裝）。
fn fixture(providers: &[&str], scenario: Value) -> (PathBuf, Value) {
    let root = project();
    let mut cfg = default_config();
    cfg["runtime"] = json!({ "claude": "windows", "codex": "windows" });
    for p in ["claude", "codex"] {
        let path = if providers.contains(&p) { install_fake(&root, p) } else { root.join("missing.exe") };
        cfg["cli"][p] = json!(path.to_string_lossy());
    }
    fs::write(root.join(".fake-cli.json"), scenario.to_string()).unwrap();
    (root, cfg)
}

fn sessions(root: &Path) -> Vec<Value> {
    let dir = data_dir(root).join("sessions");
    fs::read_dir(dir).map(|d| d.filter_map(|e| e.ok()).map(|e| serde_json::from_str(&fs::read_to_string(e.path()).unwrap()).unwrap()).collect()).unwrap_or_default()
}

fn agent<'a>(root: &'a Path, cfg: &'a Value, provider: &'a str, write: bool, stage: Option<&'a str>) -> AgentOpts<'a> {
    AgentOpts { root, cfg, provider, prompt: "Write a PRD.".into(), write, scope: "prd", label: "test", stage, skills: None, role: None, saved: vec![] }
}

fn mode(m: &str) -> Value {
    match m {
        "limit" => json!({ "fail": LIMIT }),
        "error" => json!({ "fail": "permission denied" }),
        "mentions-limit" => json!({ "text": LIMIT }),
        _ => json!({ "text": "# PRD" }),
    }
}

/// 把核准的 PRD 直接放進資料目錄（略過起草流程）。
fn approved_prd(root: &Path, text: &str) {
    fs::create_dir_all(prd_file(root).parent().unwrap()).unwrap();
    fs::write(prd_file(root), text).unwrap();
    update_state(root, |s| s["prd"]["status"] = json!("approved")).unwrap();
}

// ---------- 額度用完時的切換 ----------

#[test]
fn 唯讀作者遇到限額_改用另一_ai_原始_prompt_與技能只注入一次() {
    let (root, mut cfg) = fixture(&["claude", "codex"], json!({ "claude": mode("limit"), "codex": mode("success") }));
    cfg["skills"]["prd"] = json!(["uiux-design"]);
    let result = run_agent(agent(&root, &cfg, "claude", false, Some("prd"))).unwrap();
    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.provider, "codex");
    assert_eq!(result.fallback_from.as_deref(), Some("claude"));
    let records = calls(&root);
    let providers: Vec<&str> = records.iter().map(|c| c["provider"].as_str().unwrap()).collect();
    assert_eq!(providers, ["claude", "codex"]);
    for c in &records {
        let prompt = c["prompt"].as_str().unwrap();
        assert!(prompt.starts_with("Write a PRD."));
        assert_eq!(prompt.matches("### Skill: uiux-design").count(), 1);
    }
    let mut statuses: Vec<String> = sessions(&root).iter().map(|s| s["status"].as_str().unwrap().to_string()).collect();
    statuses.sort();
    assert_eq!(statuses, ["done", "error"]);
    assert_no_app_files(&root);
}

#[test]
fn 兩個_ai_都限額時只嘗試各一次_顯示重設時間() {
    let (root, cfg) = fixture(&["claude", "codex"], json!({ "claude": mode("limit"), "codex": mode("limit") }));
    let result = run_agent(agent(&root, &cfg, "claude", false, Some("prd"))).unwrap();
    assert!(!result.ok);
    let error = result.error_text();
    assert!(error.contains("9:10pm") && error.contains("Asia/Taipei"), "{error}");
    assert!(error.contains("也未完成"));
    assert_eq!(calls(&root).len(), 2);
}

#[test]
fn 另一_ai_未安裝或設定在不同環境時顯示處理方式() {
    let (root, cfg) = fixture(&["claude"], json!({ "claude": mode("limit") }));
    let result = run_agent(agent(&root, &cfg, "claude", false, Some("prd"))).unwrap();
    assert!(!result.ok);
    assert!(result.error_text().contains("安裝並登入另一個 AI"), "{}", result.error_text());
    assert_eq!(calls(&root).len(), 1);
    let (root, mut cfg) = fixture(&["claude", "codex"], json!({ "claude": mode("limit"), "codex": mode("success") }));
    cfg["runtime"]["codex"] = json!("wsl");
    let result = run_agent(agent(&root, &cfg, "claude", false, Some("prd"))).unwrap();
    assert!(result.error_text().contains("不同執行環境"), "{}", result.error_text());
    assert_eq!(calls(&root).len(), 1);
}

#[test]
fn 寫入中限額不會自動重做_普通失敗與成功回答也不觸發切換() {
    let (root, cfg) = fixture(&["claude", "codex"], json!({ "claude": mode("limit"), "codex": mode("success") }));
    let failure = run_agent(agent(&root, &cfg, "claude", true, Some("prd"))).unwrap();
    assert!(failure.error_text().contains("確認變更後再重試"));
    assert_eq!(calls(&root).len(), 1);
    for m in ["error", "mentions-limit"] {
        let (root, cfg) = fixture(&["claude", "codex"], json!({ "claude": mode(m), "codex": mode("success") }));
        let result = run_agent(agent(&root, &cfg, "claude", false, Some("prd"))).unwrap();
        assert_eq!(result.ok, m == "mentions-limit");
        assert_eq!(result.provider, "claude");
        assert_eq!(calls(&root).len(), 1);
    }
}

// ---------- Skills ----------

#[test]
fn codex_與_claude_接到相同_skill_指令_未綁定階段不帶入技能() {
    let mut prompts = Vec::new();
    for provider in ["codex", "claude"] {
        let (root, mut cfg) = fixture(&[provider], json!({}));
        cfg["skills"]["implement"] = json!(["uiux-design"]);
        let mut opts = agent(&root, &cfg, provider, false, Some("implement"));
        opts.prompt = "Design a UI".into();
        let result = run_agent(opts).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.skills[0]["name"], "uiux-design");
        let record: Value = serde_json::from_str(&fs::read_to_string(data_dir(&root).join("sessions").join(format!("{}.json", result.session_id))).unwrap()).unwrap();
        assert_eq!(record["status"], "done");
        assert_eq!(record["provider"], provider);
        prompts.push(calls(&root)[0]["prompt"].as_str().unwrap().to_string());
        assert_eq!(prepare_skills(&root, &cfg, Some("code_review"), None, None, &native_path).unwrap().text, "");
    }
    let body = load_skill(&project(), "uiux-design").unwrap().body;
    assert!(prompts.iter().all(|p| p.contains(&body)));
}

#[test]
fn grill_me_接續回答以新_session_執行_交接包含前輪問題及使用者回答() {
    let (root, cfg) = fixture(&["codex"], json!({ "codex": { "text": "請問目標使用者是誰？" } }));
    save_config(&root, &cfg).unwrap();
    let first = run_skill(&root, "grill-me", "我要做報表工具", Some("codex"), None).unwrap();
    let second = run_skill(&root, "grill-me", "使用者是財務人員", Some("codex"), first["id"].as_str()).unwrap();
    assert_ne!(first["sessionId"], second["sessionId"]);
    let c = calls(&root);
    assert_ne!(c[0]["pid"], c[1]["pid"]);
    let prompt = c[1]["prompt"].as_str().unwrap();
    assert!(prompt.contains("我要做報表工具") && prompt.contains("目標使用者") && prompt.contains("使用者是財務人員"));
    assert!(c.iter().all(|call| !call["args"].as_array().unwrap().contains(&json!("resume"))));
    assert_eq!(list_skill_runs(&root).len(), 2);
    // 會議介面需要每則訊息的時間與使用的 AI。
    assert!(second["created_at"].is_string() && second["messages"][0]["at"].is_string() && second["messages"][1]["at"].is_string());
    assert_eq!(second["provider"], "codex");
    assert_eq!(second["messages"][1]["provider"], "codex");
}

// ---------- 單 AI 模式與用量 ----------

#[test]
fn 僅_codex_可用時_prd_起草與審查使用不同程序且保存實際_provider() {
    let (root, cfg) = fixture(&["codex"], json!({ "codex": { "text": "# PRD\nVERDICT: APPROVE" } }));
    draft_prd(&root, &cfg, "test idea", None).unwrap();
    let state = read_state(&root);
    assert_eq!(state["prd"]["status"], "awaiting_approval");
    let providers: Vec<Value> = state["prd"]["rounds"].as_array().unwrap().iter().map(|r| r["provider"].clone()).collect();
    assert_eq!(providers, vec![json!("codex"), json!("codex")]);
    let c = calls(&root);
    assert_eq!(c.len(), 2);
    assert_ne!(c[0]["pid"], c[1]["pid"]);
}

#[test]
fn cli_實際事件串流會寫入_session_與專案統計_且保留最後回覆() {
    for provider in ["claude", "codex"] {
        let events = if provider == "claude" {
            json!([
                { "type": "assistant", "message": { "id": "a", "model": "test", "usage": { "input_tokens": 100, "cache_read_input_tokens": 20, "output_tokens": 10 }, "content": [] } },
                { "type": "rate_limit_event", "rate_limit_info": { "utilization": 0.9, "status": "allowed_warning", "resetsAt": 2000000000 } },
                { "type": "result", "result": "done", "is_error": false, "usage": { "input_tokens": 100, "cache_read_input_tokens": 20, "output_tokens": 10 }, "modelUsage": { "test": { "contextWindow": 800 } } },
            ])
        } else {
            // app-server 的通知：最後回覆、累計 tokens（cachedInputTokens 是 inputTokens 的一部分）、回合結束。
            json!([
                { "method": "item/completed", "params": { "item": { "type": "agentMessage", "id": "m", "text": "done" } } },
                { "method": "thread/tokenUsage/updated", "params": { "tokenUsage": { "total": { "inputTokens": 100, "cachedInputTokens": 20, "outputTokens": 10, "reasoningOutputTokens": 0, "totalTokens": 110 }, "last": { "inputTokens": 100, "cachedInputTokens": 20, "outputTokens": 10, "reasoningOutputTokens": 0, "totalTokens": 110 } } } },
                { "method": "turn/completed", "params": { "turn": { "id": "t", "status": "completed" } } },
            ])
        };
        let (root, cfg) = fixture(&[provider], json!({ provider: { "events": events } }));
        let result = run_agent(AgentOpts { root: &root, cfg: &cfg, provider, prompt: "test".into(), write: false, scope: "test", label: "test", stage: None, skills: None, role: None, saved: vec![] }).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.text, "done");
        let expected = if provider == "claude" { 130 } else { 110 };
        assert_eq!(result.telemetry["tokens"]["totalTokens"], expected);
        let session: Value = serde_json::from_str(&fs::read_to_string(data_dir(&root).join("sessions").join(format!("{}.json", result.session_id))).unwrap()).unwrap();
        assert_eq!(session["tokens"]["totalTokens"], expected);
        assert_eq!(usage_snapshot(&root, &cfg)["totalTokens"], expected);
        if provider == "codex" {
            assert!(session["context"].is_null());
        }
    }
}

// ---------- 整個流程 ----------

fn git_project(scenario: Value) -> (PathBuf, Value) {
    git_project_with(&["codex"], scenario)
}

fn git_project_with(providers: &[&str], scenario: Value) -> (PathBuf, Value) {
    let (root, mut cfg) = fixture(providers, scenario);
    for role in ai_workflow::core::config::ROLES {
        cfg["roles"][role] = json!("codex");
    }
    cfg["skills"]["implement"] = json!(["uiux-design"]);
    cfg["skills"]["code_review"] = json!(["uiux-design"]);
    save_config(&root, &cfg).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.name", "test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    fs::write(root.join(".gitignore"), "*.exe\n.fake-cli*\n").unwrap();
    fs::write(root.join("file.txt"), "base").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "initial"]);
    (root, cfg)
}

fn pipeline_scenario() -> Value {
    json!({ "codex": { "rules": [
        { "contains": "需求釐清會議", "text": json!({ "message": "請確認以下摘要", "ready": true, "summary": "已確認：報表功能，使用者是財務人員", "open_questions": [] }).to_string() },
        { "contains": "拆成可以逐一", "text": json!({ "tasks": [{ "title": "first", "skills": ["uiux-design"] }, { "title": "second", "dependencies": [1] }] }).to_string() },
        { "contains": "程式碼審查者", "text": "看起來沒問題\nVERDICT: PASS" },
        { "contains": "PRD 審查者", "text": "VERDICT: APPROVE" },
        { "contains": "請更新 handover 文件", "text": "# Handover\n已完成任務 1" },
    ], "text": "# PRD\nR1: reports" } })
}

/// 拆完任務後由「使用者」檢視並核准，run 才會開始（對應 UI 的「檢視後核准任務」）。
fn approve_tasks(root: &Path) {
    ai_workflow::core::human::approve_tasks(root, &ai_workflow::core::tasks::revision(root).unwrap()).unwrap();
}

/// 需求釐清會議：自動開場一輪、使用者回答一輪，AI 回報 ready 後由使用者確認摘要。
fn confirm_requirements(root: &Path, id: &str) -> Value {
    use ai_workflow::core::{chat, requirements};
    let launch = |_: &str, _: &str| -> ai_workflow::core::Result<u32> { Ok(std::process::id()) };
    let run = |session: &Value| chat::run_turn(root, session["id"].as_str().unwrap(), session["turn"].as_str().unwrap()).unwrap();
    let opened = requirements::start(root, &json!({ "id": id, "provider": "codex" }), &launch).unwrap();
    run(&opened["session"]);
    let answered = requirements::start(root, &json!({ "id": id, "input": "使用者是財務人員", "provider": "codex" }), &launch).unwrap();
    let session = run(&answered["session"]);
    assert_eq!(session["requirementsReady"], true, "{session}");
    requirements::confirm(root, &json!({ "id": id, "sessionId": session["id"], "turn": session["turn"], "summary": session["requirementsSummary"] })).unwrap()
}

#[test]
fn 不安裝_task_master_即可拆任務_手動實作審查_人工確認並解鎖下一項() {
    let (root, _cfg) = git_project(pipeline_scenario());
    approved_prd(&root, "# PRD\nR1: reports");
    update_state(&root, |s| {
        s["prd"]["version"] = json!(1);
        s["prd"]["idea"] = json!("reports");
    }).unwrap();
    assert_eq!(generate_tasks(&root).unwrap(), 2);
    assert!(!root.join(".taskmaster").exists());
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("1"));
    // 未經人工核准的任務不會開始執行。
    assert!(run_pipeline(&root, None, false).unwrap_err().message.contains("核准任務"));
    approve_tasks(&root);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting", "{}", read_state(&root)["pipeline"]["reason"]);
    assert_eq!(read_tasks(&root).unwrap()[0]["status"], "review");
    // 實作者拿到的是 PRD 內容，而不是專案裡的路徑；handover 由 runner 寫進資料目錄。
    let implement = calls(&root).into_iter().find(|c| c["prompt"].as_str().unwrap().contains("你正在一個全新的對話中實作")).unwrap();
    assert!(implement["prompt"].as_str().unwrap().contains("R1: reports"));
    assert_eq!(fs::read_to_string(handover_file(&root)).unwrap(), "# Handover\n已完成任務 1");
    assert!(matches!(acknowledge(&root).unwrap(), Next::Run));
    assert_eq!(read_tasks(&root).unwrap()[0]["status"], "done");
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("2"));
    let store: Value = serde_json::from_str(&fs::read_to_string(tasks_file(&root)).unwrap()).unwrap();
    assert_eq!(store["groups"]["master"]["metadata"]["prd_version"], 1);
    let all = sessions(&root);
    for stage in ["implement", "code_review"] {
        assert!(all.iter().any(|s| s["stage"] == stage && s["skills"][0]["name"] == "uiux-design"), "{stage}");
    }
    assert_no_app_files(&root);
    assert!(git(&root, &["status", "--porcelain"]).trim().is_empty(), "流程不能在專案裡留下任何檔案");
}

#[test]
fn 完整流程_prd_核准_拆任務_執行_重跑還原與功能完成() {
    let (root, cfg) = git_project(pipeline_scenario());
    draft_prd(&root, &cfg, "報表功能", None).unwrap();
    assert_eq!(read_state(&root)["prd"]["status"], "awaiting_approval");
    approve_prd(&root, &cfg).unwrap();
    assert_eq!(fs::read_to_string(prd_file(&root)).unwrap(), "# PRD\nR1: reports");
    let archive = read_state(&root)["prd"]["archive_dir"].as_str().unwrap().to_string();
    assert!(archive.starts_with("archive/"), "{archive}");
    assert!(archive_path(&root, &archive).join("prd.md").exists());
    generate_tasks(&root).unwrap();
    approve_tasks(&root);

    // 實作者改了一個檔案；手動模式停在等待測試。
    let mut scenario = pipeline_scenario();
    scenario["codex"]["write"] = json!({ "path": "feature.txt", "content": "v1" });
    fs::write(root.join(".fake-cli.json"), scenario.to_string()).unwrap();
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    assert!(root.join("feature.txt").exists());
    let diff = fs::read_to_string(data_dir(&root).join("tasks/1/diff.patch")).unwrap();
    assert!(diff.contains("feature.txt"), "{diff}");

    // 重跑並還原：任務改過的檔案回到開始前的狀態。
    prepare_rerun(&root, "1", true).unwrap();
    assert!(!root.join("feature.txt").exists());
    assert_eq!(read_tasks(&root).unwrap()[0]["status"], "pending");

    // 兩個任務都完成後進入功能測試，確認後功能完成。
    assert_eq!(run_pipeline(&root, Some("1"), false).unwrap(), "waiting");
    assert!(matches!(acknowledge(&root).unwrap(), Next::Run));
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    assert!(matches!(acknowledge(&root).unwrap(), Next::Run));
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "feature_test");
    assert!(matches!(acknowledge(&root).unwrap(), Next::Done));
    assert_eq!(read_state(&root)["pipeline"]["status"], "complete");
    let meta: Value = serde_json::from_str(&fs::read_to_string(archive_path(&root, &archive).join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["progress"], json!({ "done": 2, "total": 2 }));
    assert!(meta["completed_at"].is_string());
    assert!(!root.join("docs").exists() && !root.join(".aipipe").exists(), "封存、PRD 與 handover 都不在專案裡");
}

#[test]
fn 自動模式在功能分支上逐任務_commit() {
    let (root, mut cfg) = git_project(pipeline_scenario());
    cfg["mode"] = json!("auto");
    cfg["feature"] = json!("Reports");
    save_config(&root, &cfg).unwrap();
    let mut scenario = pipeline_scenario();
    scenario["codex"]["write"] = json!({ "path": "auto.txt", "content": "auto" });
    fs::write(root.join(".fake-cli.json"), scenario.to_string()).unwrap();
    draft_prd(&root, &cfg, "reports", None).unwrap();
    approve_prd(&root, &cfg).unwrap();
    generate_tasks(&root).unwrap();
    approve_tasks(&root);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "feature_test");
    assert_eq!(git(&root, &["branch", "--show-current"]).trim(), "ai-workflow/reports");
    let log = git(&root, &["log", "--format=%s"]);
    assert!(log.contains("ai-workflow: task 1 first"), "{log}");
    let t1 = &read_state(&root)["tasks"]["1"];
    assert!(t1["commit"].as_str().is_some_and(|c| c.len() == 40));
    // 任務 2 寫的內容和任務 1 相同，沒有變更可 commit。
    assert!(read_state(&root)["tasks"]["2"]["commit"].is_null());
    // 自動模式的重跑還原用 git revert；先重設依賴它的任務 2 才能重跑任務 1，被擋下時不會留下 revert commit。
    let head = git(&root, &["rev-parse", "HEAD"]);
    assert!(prepare_rerun(&root, "1", true).unwrap_err().message.contains("先重設"));
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    prepare_rerun(&root, "2", false).unwrap();
    // 封存在資料目錄裡，不受 revert 影響。
    let archive = read_state(&root)["prd"]["archive_dir"].as_str().unwrap().to_string();
    let meta_before = fs::read_to_string(archive_path(&root, &archive).join("meta.json")).unwrap();
    prepare_rerun(&root, "1", true).unwrap();
    assert!(git(&root, &["log", "-1", "--format=%s"]).starts_with("Revert"));
    assert!(!root.join("auto.txt").exists());
    assert_eq!(fs::read_to_string(archive_path(&root, &archive).join("meta.json")).unwrap(), meta_before);
}

// ---------- 每個角色的模型、雙人審查 ----------

#[test]
fn 每個角色的模型與推理強度會帶給實際執行的_cli() {
    let (root, mut cfg) = fixture(&["codex"], json!({ "codex": { "rules": [{ "contains": "PRD 審查者", "text": "VERDICT: APPROVE" }], "text": "# PRD" } }));
    cfg["models"]["author"]["codex"] = json!({ "model": "m-author", "effort": "high" });
    cfg["codex"]["model"] = json!("m-default");
    draft_prd(&root, &cfg, "idea", None).unwrap();
    // Codex 走 app-server：模型在 thread/start、推理強度在 turn/start。
    let c = calls(&root);
    assert_eq!(c[0]["thread"]["model"], "m-author", "{}", c[0]);
    assert_eq!(c[0]["turn"]["effort"], "high");
    // 審查者沒有自己的設定：用 codex.model，不帶推理強度。
    assert_eq!(c[1]["thread"]["model"], "m-default");
    assert!(c[1]["turn"]["effort"].is_null());
    // 唯讀角色不問使用者；沙箱是唯讀。
    assert_eq!(c[1]["thread"]["sandbox"], "read-only");
    assert_eq!(c[1]["thread"]["approvalPolicy"], "never");
}

#[test]
fn prd_雙人審查分別保存兩份意見_修訂時依_ai_分段() {
    let scenario = json!({
        "claude": { "rules": [{ "contains": "PRD 審查者", "text": "Claude 覺得可以
VERDICT: APPROVE" }], "text": "# PRD" },
        "codex": { "rules": [{ "contains": "PRD 審查者", "text": "Codex 要求補驗收標準
VERDICT: REVISE" }], "text": "# PRD" },
    });
    let (root, mut cfg) = fixture(&["claude", "codex"], scenario);
    cfg["roles"]["reviewer"] = json!("both");
    cfg["max_prd_rounds"] = json!(1);
    draft_prd(&root, &cfg, "idea", None).unwrap();
    let rounds = read_state(&root)["prd"]["rounds"].as_array().unwrap().clone();
    let reviews: Vec<(String, String)> = rounds.iter().filter(|r| r["kind"] == "review").map(|r| (r["provider"].as_str().unwrap().into(), r["verdict"].as_str().unwrap().into())).collect();
    assert_eq!(reviews, vec![("claude".to_string(), "APPROVE".to_string()), ("codex".to_string(), "REVISE".to_string())]);
    let prd_dir = data_dir(&root).join("prd");
    assert!(prd_dir.join("review-1-claude.md").exists() && prd_dir.join("review-1-codex.md").exists());
    // 有一份沒通過就修訂，修訂者看到兩份分開的意見。
    let revise = calls(&root).into_iter().find(|c| c["prompt"].as_str().unwrap().contains("請根據審查者的意見修訂")).unwrap();
    let prompt = revise["prompt"].as_str().unwrap();
    assert!(prompt.contains("### Claude 審查意見（APPROVE）") && prompt.contains("### Codex 審查意見（REVISE）"), "{prompt}");
}

#[test]
fn 程式碼雙人審查_兩份都通過才算通過() {
    let mut scenario = pipeline_scenario();
    scenario["claude"] = json!({ "rules": [{ "contains": "程式碼審查者", "text": "Claude 看過
VERDICT: PASS" }] });
    let (root, mut cfg) = git_project_with(&["claude", "codex"], scenario);
    cfg["roles"]["code_reviewer"] = json!("both");
    save_config(&root, &cfg).unwrap();
    approved_prd(&root, "# PRD");
    generate_tasks(&root).unwrap();
    approve_tasks(&root);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    let dir = data_dir(&root).join("tasks/1");
    assert!(fs::read_to_string(dir.join("review-1-claude.md")).unwrap().contains("Claude 看過"));
    assert!(dir.join("review-1-codex.md").exists());
    let ts = &read_state(&root)["tasks"]["1"];
    assert_eq!(ts["review_verdict"], "PASS");
    assert_eq!(ts["review_verdicts"], json!({ "claude": "PASS", "codex": "PASS" }));
    let labels: Vec<String> = sessions(&root).iter().filter(|s| s["stage"] == "code_review").map(|s| s["label"].as_str().unwrap().into()).collect();
    assert_eq!(labels.len(), 2, "{labels:?}");
}

#[test]
fn 確認後本次單_ai_不嘗試限額_ai_且保留角色設定() {
    let mut scenario = pipeline_scenario();
    scenario["claude"] = json!({ "code": 1, "text": LIMIT });
    let (root, mut cfg) = git_project_with(&["claude", "codex"], scenario);
    cfg["roles"]["code_reviewer"] = json!("both");
    save_config(&root, &cfg).unwrap();
    approved_prd(&root, "# PRD");
    generate_tasks(&root).unwrap();
    approve_tasks(&root);
    let before = calls(&root).len();
    assert_eq!(ai_workflow::core::runner::run_pipeline_with_provider(&root, None, false, Some("codex")).unwrap(), "waiting");
    assert!(calls(&root)[before..].iter().all(|c| c["provider"] == "codex"));
    let saved = ai_workflow::core::config::load_config(&root).unwrap();
    assert_eq!(saved["roles"]["code_reviewer"], "both");
    assert!(saved["_run_provider"].is_null());
    assert_eq!(read_state(&root)["tasks"]["1"]["review_verdicts"], json!({ "codex": "PASS" }));
}

#[test]
fn 拆任務_實作_修正_交接各自套用模型() {
    let mut scenario = pipeline_scenario();
    scenario["codex"]["rules"][2]["text"] = json!("VERDICT: FAIL");
    let (root, mut cfg) = git_project(scenario);
    cfg["max_fix_rounds"] = json!(1);
    for role in ["task_planner", "implementer", "fixer", "handover"] {
        cfg["models"][role]["codex"] = json!({ "model": format!("model-{role}"), "effort": "low" });
    }
    save_config(&root, &cfg).unwrap();
    approved_prd(&root, "# PRD");
    generate_tasks(&root).unwrap();
    approve_tasks(&root);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "stuck");
    fs::write(root.join(".fake-cli.json"), pipeline_scenario().to_string()).unwrap();
    assert!(matches!(acknowledge(&root).unwrap(), Next::Verify(_)));
    assert_eq!(run_pipeline(&root, Some("1"), true).unwrap(), "waiting");
    let calls = calls(&root);
    for role in ["task_planner", "implementer", "fixer", "handover"] {
        let model = format!("model-{role}");
        assert!(calls.iter().any(|c| c["thread"]["model"] == model.as_str()), "{role}");
    }
}

#[test]
fn 需求參考傳到雙人審查_拆任務與各執行角色_新功能不繼承() {
    let (root, mut cfg) = git_project(pipeline_scenario());
    cfg["roles"]["reviewer"] = json!("both");
    cfg["cli"]["claude"] = json!(install_fake(&root, "claude").to_string_lossy());
    save_config(&root, &cfg).unwrap();
    let mut scenario = pipeline_scenario(); scenario["claude"] = json!({ "text": "VERDICT: APPROVE" });
    fs::write(root.join(".fake-cli.json"), scenario.to_string()).unwrap();
    fs::write(root.join("reference.md"), "UNIQUE_REFERENCE_SPEC").unwrap();
    let reference = ai_workflow::core::references::import(&root, &json!({ "path": root.join("reference.md") })).unwrap();
    let item = ai_workflow::core::backlog::add_item_with_references(&root, Some(&json!("報表")), None, &json!([reference["id"]])).unwrap();
    // 需求待辦的項目要先完成需求釐清並由使用者確認，才能起草 PRD；確認的摘要會帶進 PRD 作者的 prompt。
    assert_eq!(draft_prd(&root, &cfg, "報表", item["id"].as_str()).unwrap_err().status, 409);
    confirm_requirements(&root, item["id"].as_str().unwrap());
    draft_prd(&root, &cfg, "報表", item["id"].as_str()).unwrap();
    assert!(calls(&root).iter().any(|c| c["prompt"].as_str().unwrap().contains("使用者確認的需求摘要") && c["prompt"].as_str().unwrap().contains("財務人員")));
    approve_prd(&root, &cfg).unwrap(); generate_tasks(&root).unwrap();
    approve_tasks(&root);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    let records = calls(&root);
    assert!(records.len() >= 8);
    for record in &records { assert!(record["prompt"].as_str().unwrap().contains("UNIQUE_REFERENCE_SPEC")); }
    for stage in ["prd", "prd_review", "tasks", "implement", "code_review"] {
        assert!(sessions(&root).iter().any(|s| s["stage"] == stage && s["references"][0]["id"] == reference["id"]), "{stage}");
    }
    draft_prd(&root, &cfg, "下一個功能", None).unwrap();
    assert_eq!(read_state(&root)["prd"]["references"], json!([]));
    assert!(!calls(&root).last().unwrap()["prompt"].as_str().unwrap().contains("UNIQUE_REFERENCE_SPEC"));
}
#[test]
fn 圖片附件使用_claude_結構化輸入與_codex_image_旗標() {
    let (root, mut cfg) = fixture(&["claude", "codex"], json!({ "claude": { "text": "ok" }, "codex": { "text": "ok" } }));
    fs::write(root.join("diagram.png"), [137, 80, 78, 71]).unwrap();
    let image = ai_workflow::core::references::import(&root, &json!({ "path": root.join("diagram.png") })).unwrap();
    cfg["_reference_ids"] = json!([image["id"]]);
    for provider in ["claude", "codex"] { assert!(run_agent(agent(&root, &cfg, provider, false, Some("prd"))).unwrap().ok); }
    let records = calls(&root);
    assert!(records[0]["args"].as_array().unwrap().contains(&json!("--input-format")));
    let message: Value = serde_json::from_str(records[0]["prompt"].as_str().unwrap()).unwrap();
    assert_eq!(message["message"]["content"][1]["type"], "image");
    // Codex：圖片以 localImage 放在 turn/start 的 input。
    let image = records[1]["turn"]["input"].as_array().unwrap().iter().find(|i| i["type"] == "localImage").expect("localImage");
    assert!(Path::new(image["path"].as_str().unwrap()).exists());
}

#[test]
fn 實作者的指令被權限擋下且沒有變更時_立刻停下_不送審查_claude_用_auto_模式() {
    let mut scenario = pipeline_scenario();
    // 假 Claude 實作者：工具呼叫被拒絕、沒有寫任何檔案。
    scenario["claude"] = json!({ "events": [json!({ "type": "result", "result": "需要的指令被擋下", "is_error": false, "permission_denials": [{ "tool_name": "Bash" }, { "tool_name": "PowerShell" }] }).to_string()] });
    let (root, mut cfg) = git_project_with(&["claude", "codex"], scenario);
    cfg["roles"]["implementer"] = json!("claude");
    save_config(&root, &cfg).unwrap();
    approved_prd(&root, "# PRD");
    generate_tasks(&root).unwrap();
    approve_tasks(&root);
    let before = calls(&root).len();
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "stuck");
    let reason = read_state(&root)["pipeline"]["reason"].as_str().unwrap().to_string();
    assert!(reason.contains("權限") && reason.contains("Bash"), "{reason}");
    let after = calls(&root);
    // 只呼叫了實作者一次，沒有送程式碼審查，也沒有修正輪。
    assert_eq!(after.len() - before, 1, "{:?}", &after[before..]);
    assert_eq!(after[before]["provider"], "claude");
    let args = after[before]["args"].as_array().unwrap();
    assert!(args.windows(2).any(|w| w[0] == "--permission-mode" && w[1] == "auto"), "{args:?}");
    assert_eq!(read_state(&root)["tasks"]["1"]["fix_round"], 0);
}

#[test]
fn 寫入角色要求權限時_等使用者在_app_回答_允許後才執行_結束後沒有殘留請求() {
    let scenario = json!({ "claude": {
        "ask": [{ "tool_name": "Bash", "input": { "command": "npm init -y" }, "description": "建立 package.json", "permission_suggestions": [{ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm init *" }], "behavior": "allow", "destination": "localSettings" }] }],
        "write": { "path": "package.json", "content": "{}" }, "text": "done" } });
    let (root, mut cfg) = fixture(&["claude"], scenario);
    cfg["roles"]["implementer"] = json!("claude");
    save_config(&root, &cfg).unwrap();
    // 扮演使用者：看到等待中的請求就選「這次執行都允許」。
    let answerer = {
        let root = root.clone();
        std::thread::spawn(move || {
            for _ in 0..200 {
                if let Some(entry) = ai_workflow::core::permissions::pending(&root).first() {
                    assert_eq!(entry["tool"], "Bash");
                    assert_eq!(entry["input"]["command"], "npm init -y");
                    assert_eq!(entry["label"], "實作任務 1");
                    ai_workflow::core::permissions::answer(&root, entry["id"].as_str().unwrap(), "allow_session", "").unwrap();
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            false
        })
    };
    let mut opts = agent(&root, &cfg, "claude", true, Some("implement"));
    opts.scope = "task-1"; opts.label = "實作任務 1"; opts.role = Some("implementer"); opts.skills = Some(vec![]);
    let result = run_agent(opts).unwrap();
    assert!(answerer.join().unwrap(), "應該出現等待回答的權限請求");
    assert!(result.ok, "{:?}", result.error);
    assert!(root.join("package.json").exists(), "允許後才執行");
    let answers = fs::read_to_string(root.join(".fake-cli-answers.jsonl")).unwrap();
    let answer: Value = serde_json::from_str(answers.lines().next().unwrap()).unwrap();
    assert_eq!(answer["behavior"], "allow");
    assert_eq!(answer["updatedPermissions"][0]["destination"], "session");
    assert!(ai_workflow::core::permissions::pending(&root).is_empty());
    let args = calls(&root)[0]["args"].clone();
    assert!(args.as_array().unwrap().windows(2).any(|w| w[0] == "--permission-prompt-tool" && w[1] == "stdio"), "{args}");
    let log = fs::read_to_string(ai_workflow::core::state::data_dir(&root).join("logs/task-1.log")).unwrap();
    assert!(log.contains("等待你允許：Bash npm init -y") && log.contains("你允許了這次執行的同類操作"), "{log}");
}

#[test]
fn codex_走_app_server_需要核准時_等使用者在_app_回答_拒絕就不執行() {
    let scenario = json!({ "codex": {
        "ask": [{ "input": { "command": "npm install" }, "description": "安裝套件需要網路" }],
        "write": { "path": "package-lock.json", "content": "{}" }, "text": "done" } });
    let (root, mut cfg) = fixture(&["codex"], scenario);
    cfg["roles"]["implementer"] = json!("codex");
    save_config(&root, &cfg).unwrap();
    // 扮演使用者：拒絕並說明原因。
    let answerer = {
        let root = root.clone();
        std::thread::spawn(move || {
            for _ in 0..200 {
                if let Some(entry) = ai_workflow::core::permissions::pending(&root).first() {
                    assert_eq!(entry["provider"], "codex");
                    assert_eq!(entry["input"]["command"], "npm install");
                    assert_eq!(entry["description"], "安裝套件需要網路");
                    ai_workflow::core::permissions::answer(&root, entry["id"].as_str().unwrap(), "deny", "先不要安裝").unwrap();
                    return true;
                }
                std::thread::sleep(std::time::Duration::from_millis(50));
            }
            false
        })
    };
    let mut opts = agent(&root, &cfg, "codex", true, Some("implement"));
    opts.scope = "task-1"; opts.label = "實作任務 1"; opts.role = Some("implementer"); opts.skills = Some(vec![]);
    let result = run_agent(opts).unwrap();
    assert!(answerer.join().unwrap(), "應該出現等待回答的核准請求");
    assert!(result.ok, "{:?}", result.error);
    assert_eq!(result.text, "done");
    assert!(!root.join("package-lock.json").exists(), "拒絕後不執行");
    let answer: Value = serde_json::from_str(fs::read_to_string(root.join(".fake-cli-answers.jsonl")).unwrap().lines().next().unwrap()).unwrap();
    assert_eq!(answer, json!({ "decision": "decline" }));
    let call = &calls(&root)[0];
    assert_eq!(call["args"][0], "app-server");
    assert_eq!(call["thread"]["sandbox"], "workspace-write");
    assert_eq!(call["thread"]["approvalPolicy"], "on-request");
    assert!(call["args"].as_array().unwrap().iter().any(|a| a == "sandbox_workspace_write.network_access=true"));
    assert!(ai_workflow::core::permissions::pending(&root).is_empty());
    // 用量來自 thread/tokenUsage/updated。
    assert_eq!(result.telemetry["tokens"]["totalTokens"], 1050);
}

#[test]
fn codex_沙箱被降成唯讀時_寫入角色直接回報_不開始回合() {
    let (root, mut cfg) = fixture(&["codex"], json!({ "codex": { "sandbox_downgrade": true, "text": "done" } }));
    cfg["roles"]["implementer"] = json!("codex");
    save_config(&root, &cfg).unwrap();
    let mut opts = agent(&root, &cfg, "codex", true, Some("implement"));
    opts.role = Some("implementer"); opts.skills = Some(vec![]);
    let result = run_agent(opts).unwrap();
    assert!(!result.ok);
    assert!(result.error.unwrap().contains("read-only"));
    assert!(calls(&root).is_empty(), "沒有開始回合");
}

/// 審查規則：只有 [建議] 視為通過；[必須修正] 才消耗修正輪數；下一次審查看得到上一輪與修正者的回覆；
/// 卡住後使用者可以接受目前結果，重新驗證通過就跳過審查進入人工驗收。
#[test]
fn 審查分級_上一輪交接與人工接受目前結果() {
    // 只有建議：FAIL 也視為通過，不送修正。
    let mut scenario = pipeline_scenario();
    scenario["codex"]["rules"][2]["text"] = json!("- [建議] `a.js:1` 命名可以更清楚\nVERDICT: FAIL");
    let (root, _cfg) = git_project(scenario);
    approved_prd(&root, "# PRD");
    generate_tasks(&root).unwrap();
    approve_tasks(&root);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    assert_eq!(read_state(&root)["tasks"]["1"]["review_verdict"], "PASS");
    assert!(!calls(&root).iter().any(|c| c["prompt"].as_str().unwrap().contains("程式碼審查者提出以下意見")));
    assert!(calls(&root).iter().any(|c| c["prompt"].as_str().unwrap().contains("[必須修正]：會造成錯誤")));

    // 必須修正：修正者說明不改的理由，下一次審查看得到；輪數用完後卡住。
    let mut scenario = pipeline_scenario();
    let rules = scenario["codex"]["rules"].as_array_mut().unwrap();
    rules.insert(0, json!({ "contains": "程式碼審查者提出以下意見", "text": "不改：手動驗收要由使用者做" }));
    rules[3]["text"] = json!("- [必須修正] `docs/check.md:1` 手動驗收結果空白\nVERDICT: FAIL");
    let (root, mut cfg) = git_project(scenario);
    cfg["max_fix_rounds"] = json!(1);
    save_config(&root, &cfg).unwrap();
    approved_prd(&root, "# PRD");
    generate_tasks(&root).unwrap();
    approve_tasks(&root);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "stuck");
    let reviews: Vec<String> = calls(&root).iter().filter_map(|c| c["prompt"].as_str()).filter(|p| p.contains("你是程式碼審查者")).map(String::from).collect();
    assert_eq!(reviews.len(), 2);
    assert!(!reviews[0].contains("上一輪審查與修正者的回覆"));
    assert!(reviews[1].contains("上一輪審查與修正者的回覆") && reviews[1].contains("不改：手動驗收要由使用者做") && reviews[1].contains("手動驗收結果空白"));
    // 卡住時把最後一次審查要求修正的項目存起來，任務詳情直接顯示，不用翻 Log。
    assert_eq!(read_state(&root)["tasks"]["1"]["stuck_reasons"], json!(["[必須修正] `docs/check.md:1` 手動驗收結果空白"]));

    // 使用者接受目前結果：重新驗證，通過後不再審查，進入人工驗收。
    let snap = ai_workflow::core::api::snapshot(&root).unwrap();
    assert!(ai_workflow::core::guards::task_accept(&snap, "1").is_none());
    update_state(&root, |s| { s["tasks"]["1"]["review_override"] = json!(true); }).unwrap();
    let before = calls(&root).len();
    assert_eq!(run_pipeline(&root, Some("1"), true).unwrap(), "waiting");
    let ts = &read_state(&root)["tasks"]["1"];
    assert_eq!(ts["review_verdict"], "ACCEPTED");
    assert!(ts["review_override"].is_null());
    assert!(!calls(&root)[before..].iter().any(|c| c["prompt"].as_str().unwrap().contains("你是程式碼審查者")));
}

#[test]
fn 拆任務把只能人做的檢查放在_manual_checks_實作與審查都知道不是_ai_的工作() {
    let mut scenario = pipeline_scenario();
    scenario["codex"]["rules"][1]["text"] = json!(json!({ "tasks": [{ "title": "樣式", "acceptanceCriteria": ["npm test 通過"], "manualChecks": ["在 Chrome 與 Edge 用 375px 檢查"] }] }).to_string());
    let (root, _cfg) = git_project(scenario);
    approved_prd(&root, "# PRD");
    generate_tasks(&root).unwrap();
    assert_eq!(read_tasks(&root).unwrap()[0]["manualChecks"], json!(["在 Chrome 與 Edge 用 375px 檢查"]));
    let planner = calls(&root).into_iter().find(|c| c["prompt"].as_str().unwrap().contains("拆成可以逐一")).unwrap();
    assert!(planner["prompt"].as_str().unwrap().contains("manualChecks：只有人能做的檢查"));
    approve_tasks(&root);
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    for marker in ["你正在一個全新的對話中實作", "你是程式碼審查者"] {
        let call = calls(&root).into_iter().find(|c| c["prompt"].as_str().unwrap().contains(marker)).unwrap();
        assert!(call["prompt"].as_str().unwrap().contains("manualChecks 是使用者在人工驗收時自己做的檢查"), "{marker}");
    }
}
