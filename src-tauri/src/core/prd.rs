//! PRD 起草、交叉審查、修訂與核准（對應 legacy/src/prd.js）。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::agents::{combine_reviews, run_agent, run_reviews, AgentOpts};
use super::archive::{archive_prd, archive_tasks};
use super::config::cfg_str;
use super::prompts::{prd_draft_prompt, prd_review_prompt, prd_revise_prompt, strip_outer_fence};
use super::state::{aipipe_dir, append_log, is_pid_alive, pid_of, read_state, update_state};
use super::util::{now_iso, read_text};
use super::Result;

const SCOPE: &str = "prd";

fn prd_dir(root: &Path) -> PathBuf {
    aipipe_dir(root).join("prd")
}

pub fn current_prd(root: &Path) -> String {
    read_text(prd_dir(root).join("current.md"))
}

fn save_version(root: &Path, text: &str) -> Result<u64> {
    let v = read_state(root)["prd"]["version"].as_u64().unwrap_or(0) + 1;
    fs::create_dir_all(prd_dir(root))?;
    fs::write(prd_dir(root).join(format!("v{v}.md")), text)?;
    fs::write(prd_dir(root).join("current.md"), text)?;
    update_state(root, |s| s["prd"]["version"] = json!(v))?;
    Ok(v)
}

fn add_round(root: &Path, mut entry: Value) -> Result<()> {
    entry["at"] = json!(now_iso());
    update_state(root, |s| {
        if !s["prd"]["rounds"].is_array() {
            s["prd"]["rounds"] = json!([]);
        }
        s["prd"]["rounds"].as_array_mut().unwrap().push(entry);
    })
}

fn set_prd_status(root: &Path, status: &str) -> Result<()> {
    update_state(root, |s| s["prd"]["status"] = json!(status))
}

fn author(root: &Path, cfg: &Value, prompt: String, label: &str) -> Result<(String, String)> {
    let res = run_agent(AgentOpts { root, cfg, provider: cfg_str(&cfg["roles"], "author"), prompt, write: false, scope: SCOPE, label, stage: Some("prd"), skills: None, role: Some("author") })?;
    let text = strip_outer_fence(&res.text);
    if !res.ok || text.is_empty() {
        crate::bail!("作者 AI 失敗：{}", res.error.unwrap_or_else(|| "沒有輸出".into()));
    }
    Ok((text, res.provider))
}

/// 審查→修訂來回，最多 max_prd_rounds 輪；審查通過就提早結束。最後一律停在 awaiting_approval 等人核准。
fn review_loop(root: &Path, cfg: &Value) -> Result<()> {
    let max = cfg["max_prd_rounds"].as_u64().unwrap_or(2);
    for _ in 1..=max {
        let round = read_state(root)["prd"]["round"].as_u64().unwrap_or(0) + 1;
        update_state(root, |s| {
            s["prd"]["round"] = json!(round);
            s["prd"]["status"] = json!("reviewing");
        })?;
        let prd = current_prd(root);
        let label = format!("PRD 審查 第 {round} 輪");
        let reviews = run_reviews(AgentOpts {
            root, cfg, provider: "", prompt: prd_review_prompt(root, cfg, &prd, round),
            write: false, scope: SCOPE, label: &label, stage: Some("prd_review"), skills: None, role: Some("reviewer"),
        }, &["APPROVE"])?;
        let version = read_state(root)["prd"]["version"].clone();
        for r in &reviews {
            // 雙人審查時每個 AI 一個檔案。
            let review_file = if reviews.len() > 1 { format!("review-{round}-{}.md", r.provider) } else { format!("review-{round}.md") };
            fs::write(prd_dir(root).join(&review_file), &r.text)?;
            add_round(root, json!({ "kind": "review", "round": round, "provider": r.provider, "verdict": r.verdict, "version": version, "file": review_file }))?;
        }
        if reviews.iter().all(|r| r.pass) {
            append_log(root, SCOPE, &format!("審查者核可（第 {round} 輪）"));
            break;
        }
        set_prd_status(root, "revising")?;
        let (text, provider) = author(root, cfg, prd_revise_prompt(root, cfg, &prd, &combine_reviews(&reviews), "審查者"), &format!("PRD 修訂 第 {round} 輪"))?;
        let v = save_version(root, &text)?;
        add_round(root, json!({ "kind": "revise", "round": round, "provider": provider, "version": v, "file": format!("v{v}.md") }))?;
    }
    set_prd_status(root, "awaiting_approval")?;
    append_log(root, SCOPE, "等待使用者在 UI 核准 PRD（或執行 aipipe prd --approve）");
    Ok(())
}

fn guard(root: &Path) -> Result<()> {
    let s = read_state(root);
    let busy = ["drafting", "reviewing", "revising"].contains(&s["prd"]["status"].as_str().unwrap_or(""));
    if let Some(pid) = pid_of(&s["prd"]["pid"]).filter(|p| busy && *p != std::process::id()) {
        if is_pid_alive(pid) {
            crate::bail!("PRD 流程已在執行中");
        }
    }
    update_state(root, |st| st["prd"]["pid"] = json!(std::process::id()))
}

fn with_error_state(root: &Path, f: impl FnOnce() -> Result<()>) -> Result<()> {
    let result = f();
    if let Err(err) = &result {
        let has_prd = !current_prd(root).is_empty();
        let message = err.message.clone();
        update_state(root, |s| {
            s["prd"]["status"] = json!(if has_prd { "awaiting_approval" } else { "none" });
            s["prd"]["error"] = json!(message);
        })?;
        append_log(root, SCOPE, &format!("錯誤：{}", err.message));
    }
    update_state(root, |s| s["prd"]["pid"] = Value::Null)?;
    result
}

pub fn draft_prd(root: &Path, cfg: &Value, idea: &str, backlog_id: Option<&str>) -> Result<()> {
    guard(root)?;
    // 開始新功能前，把上一個功能最後的任務狀態寫進它的封存；之後 archive_dir 清空，核准時會建新的資料夾。
    if let Err(err) = archive_tasks(root, json!({})) {
        append_log(root, SCOPE, &format!("⚠ 封存上一個功能的任務清單失敗：{}", err.message));
    }
    let references=if let Some(id)=backlog_id { super::references::ids(root,&super::backlog::get_item(root,id)?["references"])? } else { vec![] };
    with_error_state(root, || {
        update_state(root, |s| {
            for (k, v) in [
                ("status", json!("drafting")), ("idea", json!(idea)), ("round", json!(0)), ("rounds", json!([])), ("version", json!(0)),
                ("approved_at", Value::Null), ("error", json!("")), ("pid", json!(std::process::id())), ("archive_dir", Value::Null),
                ("backlog_id", json!(backlog_id)),
                ("references", json!(references)), ("reference_scope", json!(uuid::Uuid::new_v4().to_string())),
            ] {
                s["prd"][k] = v;
            }
        })?;
        fs::create_dir_all(prd_dir(root))?;
        for entry in fs::read_dir(prd_dir(root))? {
            let path = entry?.path();
            if path.is_file() {
                fs::remove_file(path)?;
            }
        }
        append_log(root, SCOPE, &format!("新想法：{idea}"));
        let (text, provider) = author(root, cfg, prd_draft_prompt(root, cfg, idea), "PRD 初稿")?;
        let v = save_version(root, &text)?;
        add_round(root, json!({ "kind": "draft", "round": 0, "provider": provider, "version": v, "file": format!("v{v}.md") }))?;
        review_loop(root, cfg)
    })
}

/// 使用者附意見要求再改：作者依意見修訂後，再走一次審查迴圈。
pub fn revise_prd(root: &Path, cfg: &Value, feedback: &str) -> Result<()> {
    let prd = current_prd(root);
    if prd.is_empty() {
        crate::bail!("還沒有 PRD，請先執行 aipipe prd \"<想法>\"");
    }
    guard(root)?;
    with_error_state(root, || {
        update_state(root, |s| {
            s["prd"]["status"] = json!("revising");
            s["prd"]["error"] = json!("");
            s["prd"]["approved_at"] = Value::Null;
        })?;
        let fb_file = format!("user-feedback-{}.md", chrono::Utc::now().timestamp_millis());
        fs::write(prd_dir(root).join(&fb_file), feedback)?;
        let round = read_state(root)["prd"]["round"].clone();
        add_round(root, json!({ "kind": "user_feedback", "round": round, "provider": "user", "file": fb_file }))?;
        let (text, provider) = author(root, cfg, prd_revise_prompt(root, cfg, &prd, feedback, "使用者"), "PRD 依使用者意見修訂")?;
        let v = save_version(root, &text)?;
        let round = read_state(root)["prd"]["round"].clone();
        add_round(root, json!({ "kind": "revise", "round": round, "provider": provider, "version": v, "file": format!("v{v}.md") }))?;
        review_loop(root, cfg)
    })
}

pub fn approve_prd(root: &Path, cfg: &Value) -> Result<PathBuf> {
    let prd = current_prd(root);
    if prd.is_empty() {
        crate::bail!("還沒有 PRD 可以核准");
    }
    let status = read_state(root)["prd"]["status"].as_str().unwrap_or("none").to_string();
    if status != "awaiting_approval" && status != "approved" {
        crate::bail!("PRD 目前狀態是 {status}，不能核准");
    }
    let target = root.join(cfg_str(cfg, "prd_path"));
    if let Some(dir) = target.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(&target, &prd)?;
    update_state(root, |s| {
        s["prd"]["status"] = json!("approved");
        s["prd"]["approved_at"] = json!(now_iso());
    })?;
    append_log(root, SCOPE, &format!("PRD 已核准，寫入 {}", cfg_str(cfg, "prd_path")));
    match archive_prd(root, cfg) {
        Ok(dir) => append_log(root, SCOPE, &format!("PRD 與每輪紀錄已封存到 {dir}")),
        Err(err) => append_log(root, SCOPE, &format!("⚠ 封存 PRD 失敗：{}", err.message)),
    }
    Ok(target)
}
