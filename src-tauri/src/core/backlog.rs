//! 需求待辦清單（對應 legacy/src/backlog.js）：每個專案一份 JSON（預設 docs/aipipe/backlog.json），可以 commit。
//! 陣列順序就是優先順序。status：open（待辦）、in_progress（已用它起草 PRD）、done（功能完成）。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::config::{cfg_str, load_config};
use super::util::{now_iso, pretty, read_json};
use super::{AppError, Result};

pub const BACKLOG_STATUSES: [&str; 3] = ["open", "in_progress", "done"];

fn file(root: &Path, cfg: &Value) -> PathBuf {
    root.join(cfg_str(cfg, "backlog_path"))
}

pub fn read_backlog_with(root: &Path, cfg: &Value) -> Vec<Value> {
    read_json(file(root, cfg)).and_then(|d| d["items"].as_array().cloned()).unwrap_or_default()
}

pub fn read_backlog(root: &Path) -> Result<Vec<Value>> {
    Ok(read_backlog_with(root, &load_config(root)?))
}

fn write_backlog(root: &Path, cfg: &Value, items: &[Value]) -> Result<()> {
    let f = file(root, cfg);
    if let Some(dir) = f.parent() {
        fs::create_dir_all(dir)?;
    }
    fs::write(f, pretty(&json!({ "version": 1, "items": items })) + "\n")?;
    Ok(())
}

fn clean(text: Option<&Value>, max: usize) -> String {
    let s = match text {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(v) => v.to_string(),
    };
    s.replace("\r\n", "\n").replace('\r', "\n").trim().chars().take(max).collect()
}

fn mutate<T>(root: &Path, f: impl FnOnce(&mut Vec<Value>) -> Result<T>) -> Result<T> {
    let cfg = load_config(root)?;
    let mut items = read_backlog_with(root, &cfg);
    let out = f(&mut items)?;
    write_backlog(root, &cfg, &items)?;
    Ok(out)
}

fn position(items: &[Value], id: &str) -> Result<usize> {
    items.iter().position(|i| i["id"] == id).ok_or_else(|| AppError::with_status(404, "找不到這個需求"))
}

fn random_id() -> String {
    hex::encode(&uuid::Uuid::new_v4().as_bytes()[..5])
}

pub fn add_item(root: &Path, title: Option<&Value>, detail: Option<&Value>) -> Result<Value> {
    let t = clean(title, 200);
    if t.is_empty() {
        crate::bail!(400; "請輸入需求標題");
    }
    mutate(root, |items| {
        let now = now_iso();
        let item = json!({ "id": random_id(), "title": t, "detail": clean(detail, 20000), "status": "open", "created_at": now, "updated_at": now });
        items.push(item.clone());
        Ok(item)
    })
}

/// patch 裡沒有的欄位不改（對應 JS 的 undefined）。
pub fn update_item(root: &Path, id: &str, patch: &Value) -> Result<Value> {
    mutate(root, |items| {
        let i = position(items, id)?;
        let item = &mut items[i];
        if let Some(title) = patch.get("title").filter(|v| !v.is_null()) {
            let t = clean(Some(title), 200);
            if t.is_empty() {
                crate::bail!(400; "請輸入需求標題");
            }
            item["title"] = json!(t);
        }
        if let Some(detail) = patch.get("detail").filter(|v| !v.is_null()) {
            item["detail"] = json!(clean(Some(detail), 20000));
        }
        if let Some(status) = patch.get("status").filter(|v| !v.is_null()) {
            if !status.as_str().is_some_and(|s| BACKLOG_STATUSES.contains(&s)) {
                crate::bail!(400; "狀態不正確");
            }
            item["status"] = status.clone();
        }
        if let Some(feature) = patch.get("feature") {
            item["feature"] = feature.clone();
        }
        item["updated_at"] = json!(now_iso());
        Ok(item.clone())
    })
}

pub fn delete_item(root: &Path, id: &str) -> Result<Vec<Value>> {
    mutate(root, |items| {
        let i = position(items, id)?;
        items.remove(i);
        Ok(items.clone())
    })
}

/// 依給定的 id 順序重排；沒列到的項目保持原順序接在後面。
pub fn reorder_items(root: &Path, ids: &Value) -> Result<Vec<Value>> {
    let Some(ids) = ids.as_array() else { crate::bail!(400; "ids 必須是陣列") };
    mutate(root, |items| {
        let mut ordered: Vec<Value> = ids.iter().filter_map(|id| items.iter().find(|i| &i["id"] == id).cloned()).collect();
        ordered.extend(items.iter().filter(|i| !ids.contains(&i["id"])).cloned());
        *items = ordered;
        Ok(items.clone())
    })
}

/// 起草 PRD 用的想法文字。
pub fn idea_for(item: &Value) -> String {
    let title = item["title"].as_str().unwrap_or("");
    match item["detail"].as_str().filter(|d| !d.is_empty()) {
        Some(detail) => format!("{title}\n\n{detail}"),
        None => title.to_string(),
    }
}

pub fn get_item(root: &Path, id: &str) -> Result<Value> {
    let items = read_backlog(root)?;
    Ok(items[position(&items, id)?].clone())
}
