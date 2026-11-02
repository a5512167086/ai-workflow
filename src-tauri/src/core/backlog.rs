//! 需求待辦清單：每個專案一份 JSON，放在 <home>/projects/<id>/backlog.json。
//! 陣列順序就是優先順序。status：open（待辦）、in_progress（已用它起草 PRD）、done（功能完成）。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::state::data_dir;
use super::util::{now_iso, write_atomic, write_json};
use super::{AppError, Result};

pub const BACKLOG_STATUSES: [&str; 3] = ["open", "in_progress", "done"];

pub fn backlog_file(root: &Path) -> PathBuf {
    data_dir(root).join("backlog.json")
}

pub fn read_backlog(root: &Path) -> Result<Vec<Value>> {
    let path = backlog_file(root);
    let text = match fs::read_to_string(&path) {
        Ok(text) => text,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(err) => return Err(AppError::new(format!("無法讀取需求待辦 {}：{err}；原始資料不會被覆寫", path.display()))),
    };
    let data: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|err| AppError::new(format!("需求待辦 {} 的 JSON 損壞：{err}；請先修復或從備份還原，原始資料不會被覆寫", path.display())))?;
    data["items"].as_array().cloned()
        .ok_or_else(|| AppError::new(format!("需求待辦 {} 缺少 items 陣列；原始資料不會被覆寫", path.display())))
}

fn write_backlog(root: &Path, items: &[Value]) -> Result<()> {
    let f = backlog_file(root);
    if let Some(dir) = f.parent() {
        fs::create_dir_all(dir)?;
    }
    if f.exists() {
        let backup = f.with_file_name(format!("{}.bak", f.file_name().unwrap_or_default().to_string_lossy()));
        write_atomic(&backup, &fs::read_to_string(&f)?)?;
    }
    write_json(&f, &json!({ "version": 1, "items": items }))?;
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
    super::home::with_project_lock(root, "backlog", || {
        let mut items = read_backlog(root)?;
        let out = f(&mut items)?;
        write_backlog(root, &items)?;
        Ok(out)
    })
}

fn position(items: &[Value], id: &str) -> Result<usize> {
    items.iter().position(|i| i["id"] == id).ok_or_else(|| AppError::with_status(404, "找不到這個需求"))
}

fn random_id() -> String {
    hex::encode(&uuid::Uuid::new_v4().as_bytes()[..5])
}

pub fn add_item(root: &Path, title: Option<&Value>, detail: Option<&Value>) -> Result<Value> {
    add_item_with_references(root, title, detail, &json!([]))
}

pub fn add_item_with_references(root: &Path, title: Option<&Value>, detail: Option<&Value>, references: &Value) -> Result<Value> {
    let references = super::references::ids(root, references)?;
    let t = clean(title, 200);
    if t.is_empty() {
        crate::bail!(400; "請輸入需求標題");
    }
    mutate(root, |items| {
        let now = now_iso();
        let item = json!({ "id": random_id(), "references": references, "title": t, "detail": clean(detail, 20000), "status": "open", "created_at": now, "updated_at": now });
        items.push(item.clone());
        Ok(item)
    })
}

/// patch 裡沒有的欄位不改（對應 JS 的 undefined）。
pub fn update_item(root: &Path, id: &str, patch: &Value) -> Result<Value> {
    let references = patch.get("references").map(|v| super::references::ids(root, v)).transpose()?;
    mutate(root, |items| {
        let i = position(items, id)?;
        let item = &mut items[i];
        if let Some(refs) = references { item["references"] = json!(refs); }
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
        if let Some(id) = patch.get("interviewId") { item["interviewId"] = id.clone(); }
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
