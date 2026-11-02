//! 專案的運行狀態。所有狀態都放在 <home>/projects/<id>/（不在使用者的專案資料夾裡），讓 CLI 與 UI 程序透過檔案共用。
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::util::{now_iso, pretty, write_atomic};
use crate::core::Result;

/// 這個專案的流程資料目錄（state.json、logs、prd、tasks、chats、references…）。
pub fn data_dir(root: &Path) -> PathBuf {
    crate::core::home::project_data_dir(root)
}

/// 核准後的 PRD。
pub fn prd_file(root: &Path) -> PathBuf {
    data_dir(root).join("prd.md")
}

/// 給下一個 AI session 的交接紀錄。
pub fn handover_file(root: &Path) -> PathBuf {
    data_dir(root).join("handover.md")
}

pub fn ensure_dirs(root: &Path) -> Result<()> {
    for sub in ["logs", "prd", "tasks", "tmp"] {
        fs::create_dir_all(data_dir(root).join(sub))?;
    }
    Ok(())
}

pub fn empty_state() -> Value {
    json!({
        "version": 1,
        // idle | running | paused | waiting | feature_test | stuck | error
        "pipeline": { "status": "idle", "reason": "", "current_task": null, "updated_at": null },
        "control": { "pause_requested": false },
        // none | drafting | reviewing | revising | awaiting_approval | approved
        "prd": { "status": "none", "idea": "", "round": 0, "rounds": [], "approved_at": null },
        "tasks": {},
        "runner": { "pid": null, "started_at": null }
    })
}

pub fn state_path(root: &Path) -> PathBuf {
    data_dir(root).join("state.json")
}

/// `{ ...emptyState(), ...JSON.parse(file) }`：只在頂層補預設值。
pub fn read_state(root: &Path) -> Value {
    let mut state = empty_state();
    if let Some(Value::Object(saved)) = fs::read_to_string(state_path(root)).ok().and_then(|t| serde_json::from_str(&t).ok()) {
        let map = state.as_object_mut().unwrap();
        for (k, v) in saved {
            map.insert(k, v);
        }
    }
    state
}

/// 讀取→修改→寫回；每次都重新讀檔，避免覆蓋另一個程序剛寫入的欄位。
pub fn update_state<T>(root: &Path, f: impl FnOnce(&mut Value) -> T) -> Result<T> {
    crate::core::home::with_project_lock(root, "state", || update_state_locked(root, f))
}

fn update_state_locked<T>(root: &Path, f: impl FnOnce(&mut Value) -> T) -> Result<T> {
    ensure_dirs(root)?;
    let mut state = read_state(root);
    let out = f(&mut state);
    if !state["pipeline"].is_object() {
        state["pipeline"] = json!({});
    }
    state["pipeline"]["updated_at"] = json!(now_iso());
    write_atomic(&state_path(root), &pretty(&state))?;
    Ok(out)
}

/// state.tasks[id]，不存在就建立預設值。
pub fn task_state<'a>(state: &'a mut Value, id: &str) -> &'a mut Value {
    if !state["tasks"].is_object() {
        state["tasks"] = json!({});
    }
    let tasks = state["tasks"].as_object_mut().unwrap();
    tasks.entry(id.to_string()).or_insert_with(|| {
        json!({
            "id": id, "phase": "pending", "step": "", "fix_round": 0, "attempts": 0, "commit": null, "base_tree": null,
            "started_at": null, "finished_at": null, "last_check_ok": null, "review_verdict": null, "error": ""
        })
    })
}

pub fn task_dir(root: &Path, id: &str) -> Result<PathBuf> {
    let dir = data_dir(root).join("tasks").join(id);
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

pub fn log_path(root: &Path, scope: &str) -> PathBuf {
    data_dir(root).join("logs").join(format!("{scope}.log"))
}

pub fn append_log(root: &Path, scope: &str, text: &str) {
    let _ = ensure_dirs(root);
    let stamp = &now_iso()[11..19];
    let cleaned = text.replace('\r', "");
    let mut lines: Vec<&str> = cleaned.split('\n').collect();
    if lines.last() == Some(&"") {
        lines.pop();
    }
    let body: String = lines.iter().map(|l| format!("[{stamp}] {l}\n")).collect();
    let out = if body.is_empty() { "\n".to_string() } else { body };
    if let Ok(mut f) = fs::OpenOptions::new().create(true).append(true).open(log_path(root, scope)) {
        let _ = f.write_all(out.as_bytes());
    }
}

/// pid 欄位可能是 null、數字或（舊資料）字串。
pub fn pid_of(value: &Value) -> Option<u32> {
    match value {
        Value::Number(n) => n.as_u64().and_then(|p| u32::try_from(p).ok()),
        Value::String(s) => s.parse().ok(),
        _ => None,
    }
    .filter(|p| *p != 0)
}

pub fn is_pid_alive_value(value: &Value) -> bool {
    pid_of(value).is_some_and(is_pid_alive)
}

#[cfg(windows)]
pub fn is_pid_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, ERROR_ACCESS_DENIED, STILL_ACTIVE};
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if handle.is_null() {
            // 沒有權限查詢＝程序存在（同 Node 的 EPERM）。
            return GetLastError() == ERROR_ACCESS_DENIED;
        }
        let mut code = 0u32;
        let ok = GetExitCodeProcess(handle, &mut code) != 0;
        CloseHandle(handle);
        ok && code == STILL_ACTIVE as u32
    }
}

#[cfg(unix)]
pub fn is_pid_alive(pid: u32) -> bool {
    let r = unsafe { libc::kill(pid as libc::pid_t, 0) };
    r == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::util::temp_dir;

    #[test]
    fn update_state_保留其他程序寫入的欄位_且不寫進專案資料夾() {
        let root = temp_dir("ai-workflow-state-");
        update_state(&root, |s| s["prd"]["status"] = json!("approved")).unwrap();
        update_state(&root, |s| s["pipeline"]["status"] = json!("running")).unwrap();
        let s = read_state(&root);
        assert_eq!(s["prd"]["status"], "approved");
        assert_eq!(s["pipeline"]["status"], "running");
        assert!(s["pipeline"]["updated_at"].is_string());
        assert!(is_pid_alive(std::process::id()));
        assert!(!is_pid_alive_value(&Value::Null));
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0, "專案資料夾不能有任何檔案");
        assert!(state_path(&root).starts_with(crate::core::home::app_home()));
    }

    #[test]
    fn 對話與任務同時更新狀態不會互相覆蓋() {
        let root = temp_dir("state-concurrent-");
        std::thread::scope(|scope| {
            let workers: Vec<_> = (0..12).map(|index| {
                let root = &root;
                scope.spawn(move || update_state(root, |state| { state["tasks"][index.to_string()] = json!({ "phase": "done" }); }).unwrap())
            }).collect();
            for worker in workers { worker.join().unwrap(); }
        });
        assert_eq!(read_state(&root)["tasks"].as_object().unwrap().len(), 12);
    }
}
