//! 功能封存（對應 legacy/src/archive.js）：每個功能一個資料夾 <archive_dir>/<日期>-<功能>/（預設 docs/prd/），可以 commit。
//!   prd.md            核准的 PRD
//!   rounds/NN-*.md    每一輪的初稿、審查、修訂、使用者意見
//!   tasks.json        最後的任務清單（含狀態）
//!   meta.json         功能名稱、想法、核准時間、任務群組、待辦項目 id
//! 資料夾名稱不會重複；同一個功能重新核准時更新同一個資料夾，開始下一個功能時一定建新的。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use super::config::{cfg_str, load_config};
use super::state::{aipipe_dir, read_state, update_state};
use super::tasks::{current_tag, read_tasks, tasks_in};
use super::util::{now_iso, pretty, read_json, read_text, rel_slash, today, truthy};
use super::Result;

fn kind_file(kind: &str) -> &str {
    match kind {
        "user_feedback" => "user-feedback",
        other => other,
    }
}

pub fn feature_slug(text: &str) -> String {
    let lowered: String = text.nfkc().collect::<String>().to_lowercase();
    let mut slug = String::new();
    let mut dash = false;
    for c in lowered.chars() {
        if c.is_alphanumeric() {
            slug.push(c);
            dash = false;
        } else if !dash {
            slug.push('-');
            dash = true;
        }
    }
    let slug: String = slug.trim_matches('-').chars().take(40).collect();
    let slug = slug.trim_end_matches('-').to_string();
    if slug.is_empty() { "feature".into() } else { slug }
}

/// 任務群組用的 ASCII slug（群組名稱不接受中文）；全是中文時回傳 feature。
pub fn tag_slug(text: &str) -> String {
    let ascii: String = feature_slug(text).nfkd().filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == '-').collect();
    let mut collapsed = String::new();
    for c in ascii.chars() {
        if !(c == '-' && collapsed.ends_with('-')) {
            collapsed.push(c);
        }
    }
    let out: String = collapsed.trim_matches('-').chars().take(30).collect();
    if out.is_empty() { "feature".into() } else { out }
}

fn archive_root(root: &Path, cfg: &Value) -> PathBuf {
    root.join(cfg_str(cfg, "archive_dir"))
}

fn unique_dir(base: &Path, name: &str) -> PathBuf {
    let mut dir = base.join(name);
    let mut i = 2;
    while dir.exists() {
        dir = base.join(format!("{name}-{i}"));
        i += 1;
    }
    dir
}

fn write_meta(dir: &Path, patch: Value) -> Result<()> {
    let file = dir.join("meta.json");
    let mut meta = read_json(&file).filter(Value::is_object).unwrap_or(json!({}));
    for (k, v) in patch.as_object().unwrap() {
        meta[k] = v.clone();
    }
    meta["updated_at"] = json!(now_iso());
    fs::write(file, pretty(&meta) + "\n")?;
    Ok(())
}

/// 核准 PRD 時呼叫：建立（或更新）這個功能的封存資料夾，回傳相對於專案的路徑。
pub fn archive_prd(root: &Path, cfg: &Value) -> Result<String> {
    let state = read_state(root);
    let base = archive_root(root, cfg);
    let feature = cfg_str(cfg, "feature");
    let idea = state["prd"]["idea"].as_str().unwrap_or("");
    let dir = match state["prd"]["archive_dir"].as_str().filter(|d| !d.is_empty()) {
        Some(rel) => root.join(rel),
        None => unique_dir(&base, &format!("{}-{}", today(), feature_slug(if feature.is_empty() { idea } else { feature }))),
    };
    let rounds_dir = dir.join("rounds");
    fs::create_dir_all(&rounds_dir)?;
    fs::write(dir.join("prd.md"), read_text(aipipe_dir(root).join("prd").join("current.md")))?;
    for entry in fs::read_dir(&rounds_dir)? {
        fs::remove_file(entry?.path())?;
    }
    let rounds = state["prd"]["rounds"].as_array().cloned().unwrap_or_default();
    for (i, r) in rounds.iter().enumerate() {
        let Some(file) = r["file"].as_str().filter(|f| !f.is_empty()) else { continue };
        let mut parts = vec![format!("{:02}", i + 1), kind_file(r["kind"].as_str().unwrap_or("")).to_string(), format!("r{}", super::util::js_string(&r["round"]))];
        // 雙人審查時檔名帶上 AI，避免同一輪兩份審查互相覆蓋。
        if ["-claude.md", "-codex.md"].iter().any(|s| file.ends_with(s)) {
            parts.push(r["provider"].as_str().unwrap_or("").to_string());
        }
        if let Some(v) = r["verdict"].as_str().filter(|v| !v.is_empty()) {
            parts.push(v.to_lowercase());
        }
        if truthy(r.get("version")) {
            parts.push(format!("v{}", super::util::js_string(&r["version"])));
        }
        fs::write(rounds_dir.join(format!("{}.md", parts.join("-"))), read_text(aipipe_dir(root).join("prd").join(file)))?;
    }
    let rel = rel_slash(root, &dir);
    let summary: Vec<Value> = rounds.iter().map(|r| {
        let mut o = json!({});
        for k in ["kind", "round", "provider", "verdict", "version", "at"] {
            if let Some(v) = r.get(k) {
                o[k] = v.clone();
            }
        }
        o
    }).collect();
    write_meta(&dir, json!({
        "feature": feature,
        "idea": idea,
        "references": state["prd"]["references"],
        "approved_at": now_iso(),
        "rounds": summary,
        "backlog_id": state["prd"].get("backlog_id").filter(|v| truthy(Some(v))).cloned().unwrap_or(Value::Null),
    }))?;
    let rel_clone = rel.clone();
    update_state(root, move |s| s["prd"]["archive_dir"] = json!(rel_clone))?;
    Ok(rel)
}

/// 把目前的任務清單（含狀態）寫進這個功能的封存；還沒有封存（PRD 未核准）時不做事。
pub fn archive_tasks(root: &Path, extra: Value) -> Result<Option<String>> {
    let state = read_state(root);
    let Some(rel) = state["prd"]["archive_dir"].as_str().filter(|d| !d.is_empty()).map(String::from) else { return Ok(None) };
    let dir = root.join(&rel);
    if !dir.exists() {
        return Ok(None);
    }
    let tasks = read_tasks(root)?;
    let tag = current_tag(root)?;
    if !tasks.is_empty() {
        fs::write(dir.join("tasks.json"), pretty(&json!({ "tag": tag, "tasks": tasks })) + "\n")?;
    }
    let mut patch = json!({
        "tm_tag": state["task_gen"]["tag"].as_str().filter(|t| !t.is_empty()).unwrap_or(&tag),
        "pipeline_status": state["pipeline"]["status"],
        "progress": { "done": tasks.iter().filter(|t| t["status"] == "done").count(), "total": tasks.len() },
    });
    for (k, v) in extra.as_object().into_iter().flatten() {
        patch[k] = v.clone();
    }
    write_meta(&dir, patch)?;
    Ok(Some(rel))
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

pub fn list_archives(root: &Path, cfg: &Value) -> Result<Vec<Value>> {
    let base = archive_root(root, cfg);
    if !base.exists() {
        return Ok(vec![]);
    }
    let mut list = Vec::new();
    for entry in fs::read_dir(&base)? {
        let entry = entry?;
        if !entry.file_type()?.is_dir() || !entry.path().join("prd.md").exists() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().into_owned();
        // 手動放進來、沒有 meta 的封存也列出
        let mut item = json!({ "name": name });
        if let Some(Value::Object(meta)) = read_json(entry.path().join("meta.json")) {
            for (k, v) in meta {
                item[k] = v;
            }
        }
        list.push(item);
    }
    list.sort_by(|a, b| b["name"].as_str().cmp(&a["name"].as_str()));
    Ok(list)
}

pub fn read_archive(root: &Path, name: &str, cfg: &Value) -> Result<Value> {
    if !safe_name(name) {
        crate::bail!(400; "封存名稱不正確");
    }
    let dir = archive_root(root, cfg).join(name);
    if !dir.join("prd.md").exists() {
        crate::bail!(404; "找不到這個封存");
    }
    let rounds_dir = dir.join("rounds");
    let mut names: Vec<String> = if rounds_dir.exists() {
        fs::read_dir(&rounds_dir)?.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()
    } else {
        vec![]
    };
    names.sort();
    let rounds: Vec<Value> = names.iter().map(|f| json!({ "name": f, "text": read_text(rounds_dir.join(f)) })).collect();
    Ok(json!({
        "name": name,
        "path": rel_slash(root, &dir),
        "meta": read_json(dir.join("meta.json")).unwrap_or(json!({})),
        "prd": read_text(dir.join("prd.md")),
        "rounds": rounds,
        "tasks": tasks_in(&dir.join("tasks.json")),
    }))
}

/// 預設設定的捷徑。
pub fn list_archives_for(root: &Path) -> Result<Vec<Value>> {
    list_archives(root, &load_config(root)?)
}
