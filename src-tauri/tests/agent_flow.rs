//! 移植 legacy/test 裡需要真的執行 CLI 的測試（agent-limits、skills、runtime 的單 AI PRD、usage 的事件串流），
//! 以及整個 prd → tasks → run → continue → rerun 流程。CLI 由 examples/fake_cli.rs 扮演。
mod common;

use std::fs;
use std::path::{Path, PathBuf};

use aipipe::core::agents::{run_agent, AgentOpts};
use aipipe::core::cli::{generate_tasks, run_skill};
use aipipe::core::config::{default_config, save_config};
use aipipe::core::prd::{approve_prd, draft_prd};
use aipipe::core::runner::{acknowledge, prepare_rerun, run_pipeline, Next};
use aipipe::core::skills::{list_skill_runs, load_skill, native_path, prepare_skills};
use aipipe::core::state::{read_state, update_state};
use aipipe::core::tasks::{next_task_id, read_tasks, tasks_file};
use aipipe::core::usage::usage_snapshot;
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

fn calls(root: &Path) -> Vec<Value> {
    fs::read_to_string(root.join(".aipipe").join("calls.jsonl")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

fn sessions(root: &Path) -> Vec<Value> {
    let dir = root.join(".aipipe").join("sessions");
    fs::read_dir(dir).map(|d| d.filter_map(|e| e.ok()).map(|e| serde_json::from_str(&fs::read_to_string(e.path()).unwrap()).unwrap()).collect()).unwrap_or_default()
}

fn agent<'a>(root: &'a Path, cfg: &'a Value, provider: &'a str, write: bool, stage: Option<&'a str>) -> AgentOpts<'a> {
    AgentOpts { root, cfg, provider, prompt: "Write a PRD.".into(), write, scope: "prd", label: "test", stage, skills: None }
}

fn mode(m: &str) -> Value {
    match m {
        "limit" => json!({ "fail": LIMIT }),
        "error" => json!({ "fail": "permission denied" }),
        "mentions-limit" => json!({ "text": LIMIT }),
        _ => json!({ "text": "# PRD" }),
    }
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
        let record: Value = serde_json::from_str(&fs::read_to_string(root.join(".aipipe/sessions").join(format!("{}.json", result.session_id))).unwrap()).unwrap();
        assert_eq!(record["status"], "done");
        assert_eq!(record["provider"], provider);
        prompts.push(calls(&root)[0]["prompt"].as_str().unwrap().to_string());
        assert_eq!(prepare_skills(&root, &cfg, Some("prd"), None, &native_path).unwrap().text, "");
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
            json!([
                { "type": "item.completed", "item": { "type": "agent_message", "text": "done" } },
                { "type": "turn.completed", "usage": { "input_tokens": 100, "cached_input_tokens": 20, "output_tokens": 10 } },
            ])
        };
        let (root, cfg) = fixture(&[provider], json!({ provider: { "events": events } }));
        let result = run_agent(AgentOpts { root: &root, cfg: &cfg, provider, prompt: "test".into(), write: false, scope: "test", label: "test", stage: None, skills: None }).unwrap();
        assert!(result.ok, "{:?}", result.error);
        assert_eq!(result.text, "done");
        let expected = if provider == "claude" { 130 } else { 110 };
        assert_eq!(result.telemetry["tokens"]["totalTokens"], expected);
        let session: Value = serde_json::from_str(&fs::read_to_string(root.join(".aipipe/sessions").join(format!("{}.json", result.session_id))).unwrap()).unwrap();
        assert_eq!(session["tokens"]["totalTokens"], expected);
        assert_eq!(usage_snapshot(&root, &cfg)["totalTokens"], expected);
        if provider == "codex" {
            assert!(session["context"].is_null());
        }
    }
}

// ---------- 整個流程 ----------

fn git_project(scenario: Value) -> (PathBuf, Value) {
    let (root, mut cfg) = fixture(&["codex"], scenario);
    for role in ["author", "reviewer", "implementer", "code_reviewer"] {
        cfg["roles"][role] = json!("codex");
    }
    cfg["skills"]["implement"] = json!(["uiux-design"]);
    cfg["skills"]["code_review"] = json!(["uiux-design"]);
    save_config(&root, &cfg).unwrap();
    git(&root, &["init", "-q", "-b", "main"]);
    git(&root, &["config", "user.name", "test"]);
    git(&root, &["config", "user.email", "test@example.com"]);
    fs::write(root.join(".gitignore"), ".aipipe/\n*.exe\n.fake-cli.json\n").unwrap();
    fs::write(root.join("file.txt"), "base").unwrap();
    git(&root, &["add", "."]);
    git(&root, &["commit", "-qm", "initial"]);
    (root, cfg)
}

fn pipeline_scenario() -> Value {
    json!({ "codex": { "rules": [
        { "contains": "拆成可以逐一", "text": json!({ "tasks": [{ "title": "first", "skills": ["uiux-design"] }, { "title": "second", "dependencies": [1] }] }).to_string() },
        { "contains": "程式碼審查者", "text": "看起來沒問題\nVERDICT: PASS" },
        { "contains": "PRD 審查者", "text": "VERDICT: APPROVE" },
    ], "text": "# PRD\nR1: reports" } })
}

#[test]
fn 不安裝_task_master_即可拆任務_手動實作審查_人工確認並解鎖下一項() {
    let (root, cfg) = git_project(pipeline_scenario());
    let file = root.join(cfg["prd_path"].as_str().unwrap());
    fs::create_dir_all(file.parent().unwrap()).unwrap();
    fs::write(&file, "# PRD\nR1: reports").unwrap();
    update_state(&root, |s| {
        s["prd"]["status"] = json!("approved");
        s["prd"]["version"] = json!(1);
        s["prd"]["idea"] = json!("reports");
    }).unwrap();
    assert_eq!(generate_tasks(&root).unwrap(), 2);
    assert!(!root.join(".taskmaster").exists());
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("1"));
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting", "{}", read_state(&root)["pipeline"]["reason"]);
    assert_eq!(read_tasks(&root).unwrap()[0]["status"], "review");
    assert!(matches!(acknowledge(&root).unwrap(), Next::Run));
    assert_eq!(read_tasks(&root).unwrap()[0]["status"], "done");
    assert_eq!(next_task_id(&root).unwrap().as_deref(), Some("2"));
    let store: Value = serde_json::from_str(&fs::read_to_string(tasks_file(&root)).unwrap()).unwrap();
    assert_eq!(store["groups"]["master"]["metadata"]["prd_version"], 1);
    let all = sessions(&root);
    for stage in ["implement", "code_review"] {
        assert!(all.iter().any(|s| s["stage"] == stage && s["skills"][0]["name"] == "uiux-design"), "{stage}");
    }
}

#[test]
fn 完整流程_prd_核准_拆任務_執行_重跑還原與功能完成() {
    let (root, cfg) = git_project(pipeline_scenario());
    draft_prd(&root, &cfg, "報表功能", None).unwrap();
    assert_eq!(read_state(&root)["prd"]["status"], "awaiting_approval");
    approve_prd(&root, &cfg).unwrap();
    let archive = read_state(&root)["prd"]["archive_dir"].as_str().unwrap().to_string();
    assert!(root.join(&archive).join("prd.md").exists());
    generate_tasks(&root).unwrap();

    // 實作者改了一個檔案；手動模式停在等待測試。
    let mut scenario = pipeline_scenario();
    scenario["codex"]["write"] = json!({ "path": "feature.txt", "content": "v1" });
    fs::write(root.join(".fake-cli.json"), scenario.to_string()).unwrap();
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "waiting");
    assert!(root.join("feature.txt").exists());
    let diff = fs::read_to_string(root.join(".aipipe/tasks/1/diff.patch")).unwrap();
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
    let meta: Value = serde_json::from_str(&fs::read_to_string(root.join(&archive).join("meta.json")).unwrap()).unwrap();
    assert_eq!(meta["progress"], json!({ "done": 2, "total": 2 }));
    assert!(meta["completed_at"].is_string());
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
    assert_eq!(run_pipeline(&root, None, false).unwrap(), "feature_test");
    assert_eq!(git(&root, &["branch", "--show-current"]).trim(), "aipipe/reports");
    let log = git(&root, &["log", "--format=%s"]);
    assert!(log.contains("aipipe: task 1 first"), "{log}");
    let t1 = &read_state(&root)["tasks"]["1"];
    assert!(t1["commit"].as_str().is_some_and(|c| c.len() == 40));
    // 任務 2 寫的內容和任務 1 相同，沒有變更可 commit。
    assert!(read_state(&root)["tasks"]["2"]["commit"].is_null());
    // 自動模式的重跑還原用 git revert；先重設依賴它的任務 2 才能重跑任務 1，被擋下時不會留下 revert commit。
    let head = git(&root, &["rev-parse", "HEAD"]);
    assert!(prepare_rerun(&root, "1", true).unwrap_err().message.contains("先重設"));
    assert_eq!(git(&root, &["rev-parse", "HEAD"]), head);
    prepare_rerun(&root, "2", false).unwrap();
    // 封存檔在 commit 之後又被更新過，revert 仍要成功，且封存內容保持最新。
    let archive = read_state(&root)["prd"]["archive_dir"].as_str().unwrap().to_string();
    let meta_before = fs::read_to_string(root.join(&archive).join("meta.json")).unwrap();
    prepare_rerun(&root, "1", true).unwrap();
    assert!(git(&root, &["log", "-1", "--format=%s"]).starts_with("Revert"));
    assert!(!root.join("auto.txt").exists());
    assert_eq!(fs::read_to_string(root.join(&archive).join("meta.json")).unwrap(), meta_before);
}
