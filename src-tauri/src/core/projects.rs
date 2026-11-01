//! 全域專案清單（對應 legacy/src/projects.js）：~/.aipipe/projects.json。只記錄路徑與使用時間，專案本身的狀態仍在各自的 .aipipe/。
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use sha1::{Digest, Sha1};

use super::config::{load_config, CONFIG_FILE};
use super::home::{aipipe_home, with_lock};
use super::queue::queue_entry_for;
use super::state::{is_pid_alive_value, read_state};
use super::tasks::read_tasks;
use super::util::{now_iso, read_json, resolve, write_json};
use super::Result;

fn file() -> PathBuf {
    aipipe_home().join("projects.json")
}

fn key(p: &Path) -> String {
    let s = resolve(p).to_string_lossy().into_owned();
    if cfg!(windows) { s.to_lowercase() } else { s }
}

/// 與 Node 版相同：sha1(正規化路徑) 的前 10 碼，舊的 /p/<id>/ 網址與通知都沿用。
pub fn project_id(root: &Path) -> String {
    hex::encode(Sha1::digest(key(root).as_bytes()))[..10].to_string()
}

fn load() -> Vec<Value> {
    read_json(file()).and_then(|d| d["projects"].as_array().cloned()).unwrap_or_default()
}

fn save(projects: &[Value]) -> Result<()> {
    write_json(&file(), &json!({ "version": 1, "projects": projects }))
}

fn path_of(p: &Value) -> PathBuf {
    PathBuf::from(p["path"].as_str().unwrap_or(""))
}

fn with_id(p: &Value) -> Value {
    let mut out = p.clone();
    out["id"] = json!(project_id(&path_of(p)));
    out
}

/// 依最近開啟（沒有就依加入時間）排序。
pub fn list_projects() -> Vec<Value> {
    let mut list: Vec<Value> = load().iter().map(with_id).collect();
    let stamp = |p: &Value| p["last_opened_at"].as_str().or(p["added_at"].as_str()).unwrap_or("").to_string();
    list.sort_by_key(|p| std::cmp::Reverse(stamp(p)));
    list
}

pub fn get_project(id: &str) -> Option<Value> {
    list_projects().into_iter().find(|p| p["id"] == id)
}

pub fn find_project_by_path(dir: &Path) -> Option<Value> {
    list_projects().into_iter().find(|p| key(&path_of(p)) == key(dir))
}

/// 加入專案（已存在就只更新名稱）。資料夾必須存在且已有 .aipipe.json。
pub fn add_project(dir: &Path, name: Option<&str>) -> Result<Value> {
    let root = resolve(dir);
    if !root.is_dir() {
        crate::bail!("資料夾不存在：{}", root.display());
    }
    if !root.join(CONFIG_FILE).exists() {
        crate::bail!("{} 還沒有 {CONFIG_FILE}，請先執行 aipipe init", root.display());
    }
    let name = name.map(str::trim).filter(|n| !n.is_empty());
    with_lock("projects", || {
        let mut projects = load();
        let idx = match projects.iter().position(|p| key(&path_of(p)) == key(&root)) {
            Some(i) => {
                if let Some(n) = name {
                    projects[i]["name"] = json!(n);
                }
                i
            }
            None => {
                let base = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| root.display().to_string());
                projects.push(json!({ "path": root.to_string_lossy(), "name": name.unwrap_or(&base), "added_at": now_iso(), "last_opened_at": null }));
                projects.len() - 1
            }
        };
        save(&projects)?;
        Ok(with_id(&projects[idx]))
    })
}

/// 依 id、路徑或名稱移除；只移出清單，不刪任何檔案。
pub fn remove_project(reference: &str) -> Result<Value> {
    with_lock("projects", || {
        let mut projects = load();
        let r = Path::new(reference);
        let Some(idx) = projects.iter().position(|p| project_id(&path_of(p)) == reference || key(&path_of(p)) == key(r) || p["name"] == reference) else {
            crate::bail!("找不到專案：{reference}");
        };
        let removed = projects.remove(idx);
        save(&projects)?;
        Ok(removed)
    })
}

pub fn touch_project(id: &str) -> Result<()> {
    with_lock("projects", || {
        let mut projects = load();
        if let Some(p) = projects.iter_mut().find(|x| project_id(&path_of(x)) == id) {
            p["last_opened_at"] = json!(now_iso());
            save(&projects)?;
        }
        Ok(())
    })
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    #[test]
    fn project_id_與_node_版相同() {
        // 數值由 legacy/src/projects.js 的 projectId 算出
        assert_eq!(project_id(Path::new("C:/codebase-win/ai-workflow")), "717d44b62a");
        assert_eq!(project_id(Path::new("C:/Users/x/My Proj/")), "9c415ea475");
    }
}

/// 總覽用的狀態摘要。attention 為 true 表示流程停下來等使用者（核准 PRD、測試、處理卡住）。
/// status：missing | idle | drafting | awaiting_approval | generating | ready | queued | running |
///         paused | waiting | feature_test | stuck | error | complete
pub fn project_summary(project: &Value) -> Value {
    let root = path_of(project);
    let mut out = json!({ "id": project["id"], "name": project["name"], "path": project["path"], "last_opened_at": project["last_opened_at"] });
    let mut set = |patch: Value| {
        for (k, v) in patch.as_object().unwrap() {
            out[k] = v.clone();
        }
    };
    if !root.join(CONFIG_FILE).exists() {
        set(json!({ "status": "missing", "attention": false, "reason": "找不到資料夾或 .aipipe.json" }));
        return out;
    }
    let cfg = match load_config(&root) {
        Ok(c) => c,
        Err(err) => {
            set(json!({ "status": "error", "attention": true, "reason": err.message }));
            return out;
        }
    };
    let state = read_state(&root);
    // tasks.json 壞掉時總覽仍要能顯示
    let tasks = read_tasks(&root).unwrap_or_default();
    let done = tasks.iter().filter(|t| t["status"] == "done").count();
    let runner_alive = is_pid_alive_value(&state["runner"]["pid"]);
    let queue = if runner_alive { queue_entry_for(&root) } else { None };
    let ps = state["pipeline"]["status"].as_str().unwrap_or("idle").to_string();
    let prd_status = state["prd"]["status"].as_str().unwrap_or("none");
    let queue_waiting = queue.as_ref().is_some_and(|q| q["state"] == "waiting");
    let mut status = ps.clone();
    let mut reason = state["pipeline"]["reason"].as_str().unwrap_or("").to_string();
    if is_pid_alive_value(&state["prd"]["pid"]) {
        status = "drafting".into();
        reason = "PRD 起草／審查中".into();
    } else if is_pid_alive_value(&state["task_gen"]["pid"]) {
        status = "generating".into();
        reason = "AI 產生任務中".into();
    } else if runner_alive && (ps == "queued" || queue_waiting) {
        status = "queued".into();
        if let Some(pos) = queue.as_ref().and_then(|q| q["position"].as_u64()).filter(|p| *p > 0) {
            reason = format!("排隊第 {pos} 位，等其他專案的流程跑完");
        }
    } else if runner_alive {
        status = "running".into();
    } else if prd_status == "awaiting_approval" {
        status = "awaiting_approval".into();
        reason = "PRD 等待核准".into();
    } else if ps == "running" || ps == "queued" {
        // runner 已經不在但狀態沒收尾（例如程序被關掉）
        status = "idle".into();
    } else if ps == "idle" && prd_status == "approved" && !tasks.is_empty() && done < tasks.len() {
        status = "ready".into();
        reason = "可以開始執行".into();
    } else if ps == "idle" && prd_status == "none" {
        reason = "尚未開始功能".into();
    }
    let attention = ["awaiting_approval", "waiting", "feature_test", "stuck", "error"].contains(&status.as_str());
    let feature = cfg["feature"].as_str().filter(|f| !f.is_empty()).or(state["prd"]["idea"].as_str()).unwrap_or("");
    let queue_position = if queue_waiting { queue.as_ref().unwrap()["position"].clone() } else { Value::Null };
    set(json!({
        "status": status,
        "reason": reason,
        "attention": attention,
        "mode": cfg["mode"],
        "feature": feature,
        "prd_status": prd_status,
        "progress": { "done": done, "total": tasks.len() },
        "current_task": state["pipeline"]["current_task"],
        "queue_position": queue_position,
        "updated_at": state["pipeline"]["updated_at"],
    }));
    out
}
