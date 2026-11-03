//! 功能封存：每個功能一個資料夾 <home>/projects/<id>/archive/<日期>-<功能>/。
//!   prd.md            核准的 PRD
//!   rounds/NN-*.md    每一輪的初稿、審查、修訂、使用者意見
//!   tasks.json        最後的任務清單（含狀態）與每個任務的執行狀態（states）
//!   task-records/<id>/ 每個任務的實作紀錄：task.log、implement.md、review-*.md、checks.txt、diff.patch
//!   meta.json         功能名稱、想法、核准時間、任務群組、待辦項目 id
//! 資料夾名稱不會重複；同一個功能重新核准時更新同一個資料夾，開始下一個功能時一定建新的。
//! state.prd.archive_dir 記的是相對於專案資料目錄的路徑（archive/<名稱>）。
//! 任務的實作紀錄平常放在 tasks/<id>/ 與 logs/task-<id>.log；下一個功能的任務編號會重複，所以開始新功能時移進封存。
use std::collections::BTreeSet;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;

use crate::core::config::cfg_str;
use crate::core::state::{data_dir, log_path, read_state, update_state};
use crate::core::tasks::{current_tag, read_tasks, tasks_in};
use crate::core::util::{js_string, now_iso, pretty, read_json, read_text, rel_slash, today, truthy};
use crate::core::Result;

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

pub fn archive_root(root: &Path) -> PathBuf {
    data_dir(root).join("archive")
}

/// state 裡記的封存路徑對應到實際資料夾。
pub fn archive_path(root: &Path, rel: &str) -> PathBuf {
    data_dir(root).join(rel)
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

/// 核准 PRD 時呼叫：建立（或更新）這個功能的封存資料夾，回傳相對於專案資料目錄的路徑。
pub fn archive_prd(root: &Path, cfg: &Value) -> Result<String> {
    let state = read_state(root);
    let base = archive_root(root);
    let feature = cfg_str(cfg, "feature");
    let idea = state["prd"]["idea"].as_str().unwrap_or("");
    let dir = match state["prd"]["archive_dir"].as_str().filter(|d| !d.is_empty()) {
        Some(rel) => archive_path(root, rel),
        None => unique_dir(&base, &format!("{}-{}", today(), feature_slug(if feature.is_empty() { idea } else { feature }))),
    };
    let rounds_dir = dir.join("rounds");
    fs::create_dir_all(&rounds_dir)?;
    let prd_dir = data_dir(root).join("prd");
    fs::write(dir.join("prd.md"), read_text(prd_dir.join("current.md")))?;
    for entry in fs::read_dir(&rounds_dir)? {
        fs::remove_file(entry?.path())?;
    }
    let rounds = state["prd"]["rounds"].as_array().cloned().unwrap_or_default();
    for (i, r) in rounds.iter().enumerate() {
        let Some(file) = r["file"].as_str().filter(|f| !f.is_empty()) else { continue };
        let mut parts = vec![format!("{:02}", i + 1), kind_file(r["kind"].as_str().unwrap_or("")).to_string(), format!("r{}", crate::core::util::js_string(&r["round"]))];
        // 雙人審查時檔名帶上 AI，避免同一輪兩份審查互相覆蓋。
        if ["-claude.md", "-codex.md"].iter().any(|s| file.ends_with(s)) {
            parts.push(r["provider"].as_str().unwrap_or("").to_string());
        }
        if let Some(v) = r["verdict"].as_str().filter(|v| !v.is_empty()) {
            parts.push(v.to_lowercase());
        }
        if truthy(r.get("version")) {
            parts.push(format!("v{}", crate::core::util::js_string(&r["version"])));
        }
        fs::write(rounds_dir.join(format!("{}.md", parts.join("-"))), read_text(prd_dir.join(file)))?;
    }
    let rel = rel_slash(&data_dir(root), &dir);
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
    let dir = archive_path(root, &rel);
    if !dir.exists() {
        return Ok(None);
    }
    let tasks = read_tasks(root)?;
    let tag = current_tag(root)?;
    if !tasks.is_empty() {
        fs::write(dir.join("tasks.json"), pretty(&json!({ "tag": tag, "tasks": tasks, "states": state["tasks"] })) + "\n")?;
    }
    settle_leftover_records(root, &state, Some(&dir))?;
    for id in owned_records(root, &state) {
        copy_records(root, &id, &dir.join("task-records").join(&id))?;
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

fn records_root(root: &Path) -> PathBuf {
    data_dir(root).join("tasks")
}

fn valid_record_id(id: &str) -> bool {
    !id.is_empty() && id.split('.').all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
}

/// 目前留著實作紀錄的任務：有 tasks/<id>/ 資料夾或 logs/task-<id>.log。
fn record_ids(root: &Path) -> BTreeSet<String> {
    let mut ids = BTreeSet::new();
    for entry in fs::read_dir(records_root(root)).into_iter().flatten().flatten() {
        if entry.path().is_dir() {
            ids.insert(entry.file_name().to_string_lossy().into_owned());
        }
    }
    for entry in fs::read_dir(data_dir(root).join("logs")).into_iter().flatten().flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        if let Some(id) = name.strip_prefix("task-").and_then(|n| n.strip_suffix(".log")) {
            ids.insert(id.to_string());
        }
    }
    ids.retain(|id| valid_record_id(id));
    ids
}

/// 屬於目前任務清單的紀錄：產生任務清單時 state.tasks 會清空，之後有執行狀態的任務才是這個功能跑過的。
fn owned_records(root: &Path, state: &Value) -> Vec<String> {
    let owned = state["tasks"].as_object();
    record_ids(root).into_iter().filter(|id| owned.is_some_and(|o| o.contains_key(id))).collect()
}

fn copy_records(root: &Path, id: &str, dest: &Path) -> Result<()> {
    fs::create_dir_all(dest)?;
    for entry in fs::read_dir(records_root(root).join(id)).into_iter().flatten().flatten() {
        if entry.path().is_file() {
            fs::copy(entry.path(), dest.join(entry.file_name()))?;
        }
    }
    let log = log_path(root, &format!("task-{id}"));
    if log.is_file() {
        fs::copy(&log, dest.join("task.log"))?;
    }
    Ok(())
}

fn remove_records(root: &Path, id: &str) {
    let _ = fs::remove_dir_all(records_root(root).join(id));
    let _ = fs::remove_file(log_path(root, &format!("task-{id}")));
}

/// 封存的任務清單裡有沒有這個任務（子任務 "1.2" 看父任務 1）。
fn archive_has_task(dir: &Path, id: &str) -> bool {
    let parent = id.split('.').next().unwrap_or(id);
    tasks_in(&dir.join("tasks.json")).iter().any(|t| js_string(&t["id"]) == parent)
}

/// 不屬於目前任務清單的紀錄（舊版開始新功能時沒有清掉，會和新任務混在一起）：
/// 搬進最近一個有這個任務、還沒有它紀錄的其他封存；找不到就留著，不刪除。
fn settle_leftover_records(root: &Path, state: &Value, current: Option<&Path>) -> Result<()> {
    let owned = state["tasks"].as_object();
    let leftovers: Vec<String> = record_ids(root).into_iter().filter(|id| !owned.is_some_and(|o| o.contains_key(id))).collect();
    if leftovers.is_empty() {
        return Ok(());
    }
    let mut archives: Vec<PathBuf> = fs::read_dir(archive_root(root)).into_iter().flatten().flatten()
        .map(|e| e.path())
        .filter(|p| p.join("prd.md").exists() && current.is_none_or(|c| c != p.as_path()))
        .collect();
    archives.sort();
    archives.reverse(); // 資料夾名稱以日期開頭：最近的在前
    for id in leftovers {
        if let Some(target) = archives.iter().find(|a| archive_has_task(a, &id) && !a.join("task-records").join(&id).exists()) {
            copy_records(root, &id, &target.join("task-records").join(&id))?;
            remove_records(root, &id);
        }
    }
    Ok(())
}

/// 執行任務前呼叫：先把不屬於目前任務清單的舊紀錄移走，新的 log 才不會接在上一個功能的後面。
pub fn settle_task_records(root: &Path) -> Result<()> {
    let state = read_state(root);
    let current = state["prd"]["archive_dir"].as_str().filter(|d| !d.is_empty()).map(|rel| archive_path(root, rel));
    settle_leftover_records(root, &state, current.as_deref())
}

/// 開始新功能：上一個功能的任務紀錄已由 archive_tasks 複製進封存，這裡把原本的清掉，新功能的任務從空白開始。
pub fn release_task_records(root: &Path) {
    let state = read_state(root);
    for id in owned_records(root, &state) {
        remove_records(root, &id);
    }
}

/// 一個任務的實作紀錄（目前的 tasks/<id>/ 與封存裡的 task-records/<id>/ 格式相同）。
pub fn task_records(dir: &Path, log: &Path) -> Value {
    // review-<n>.md，或雙人審查的 review-<n>-<claude|codex>.md
    let mut reviews: Vec<(u64, String, String)> = fs::read_dir(dir).into_iter().flatten().flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter_map(|f| {
            let stem = f.strip_prefix("review-")?.strip_suffix(".md")?.to_string();
            let (n, provider) = stem.split_once('-').map(|(n, p)| (n.to_string(), p.to_string())).unwrap_or((stem, String::new()));
            Some((n.parse().ok()?, provider, f.clone()))
        })
        .collect();
    reviews.sort();
    let reviews: Vec<Value> = reviews.into_iter().map(|(n, provider, f)| json!({ "name": f, "round": n, "provider": provider, "text": read_text(dir.join(&f)) })).collect();
    json!({
        "checks": read_text(dir.join("checks.txt")),
        "diff": read_text(dir.join("diff.patch")),
        "implement": read_text(dir.join("implement.md")),
        "reviews": reviews,
        "log": crate::core::api::tail(log, 200_000)["text"],
    })
}

/// 封存裡的一個任務：任務內容、當時的執行狀態與實作紀錄（沒有紀錄時欄位是空字串，hasRecords 為 false）。
pub fn read_archived_task(root: &Path, name: &str, id: &str) -> Result<Value> {
    if !safe_name(name) || !valid_record_id(id) {
        crate::bail!(400; "封存或任務名稱不正確");
    }
    let dir = archive_root(root).join(name);
    let file = read_json(dir.join("tasks.json")).unwrap_or(json!({}));
    let list = file["tasks"].as_array().cloned().unwrap_or_default();
    let mut parts = id.splitn(2, '.');
    let (parent, sub) = (parts.next().unwrap_or(""), parts.next());
    let top = list.iter().find(|t| js_string(&t["id"]) == parent).cloned();
    let task = match (top, sub) {
        (Some(t), None) => Some(t),
        (Some(t), Some(s)) => t["subtasks"].as_array().and_then(|subs| subs.iter().find(|x| js_string(&x["id"]) == s)).cloned().map(|mut x| {
            x["parent"] = json!(parent);
            x
        }),
        _ => None,
    };
    let Some(task) = task else { crate::bail!(404; "封存裡找不到這個任務") };
    let records_dir = dir.join("task-records").join(id);
    let mut out = task_records(&records_dir, &records_dir.join("task.log"));
    out["id"] = json!(id);
    out["task"] = task;
    out["state"] = file["states"].get(id).cloned().unwrap_or(Value::Null);
    out["hasRecords"] = json!(records_dir.is_dir());
    Ok(out)
}

fn safe_name(name: &str) -> bool {
    !name.is_empty() && name != "." && name != ".." && !name.chars().any(|c| matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
}

pub fn list_archives(root: &Path) -> Result<Vec<Value>> {
    let base = archive_root(root);
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

pub fn read_archive(root: &Path, name: &str) -> Result<Value> {
    if !safe_name(name) {
        crate::bail!(400; "封存名稱不正確");
    }
    let dir = archive_root(root).join(name);
    if !dir.join("prd.md").exists() {
        crate::bail!(404; "找不到這個封存");
    }
    let rounds_dir = dir.join("rounds");
    let mut names: Vec<String> = if rounds_dir.exists() {
        fs::read_dir(&rounds_dir)?.filter_map(std::result::Result::ok).map(|e| e.file_name().to_string_lossy().into_owned()).collect()
    } else {
        vec![]
    };
    names.sort();
    let rounds: Vec<Value> = names.iter().map(|f| json!({ "name": f, "text": read_text(rounds_dir.join(f)) })).collect();
    Ok(json!({
        "name": name,
        "path": dir.to_string_lossy(),
        "meta": read_json(dir.join("meta.json")).unwrap_or(json!({})),
        "prd": read_text(dir.join("prd.md")),
        "rounds": rounds,
        "tasks": tasks_in(&dir.join("tasks.json")),
        "taskStates": read_json(dir.join("tasks.json")).map(|v| v["states"].clone()).unwrap_or(Value::Null),
    }))
}
