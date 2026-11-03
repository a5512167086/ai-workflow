//! 專案頁的即時更新：狀態變化推送 `state-<id>`，新增的 log 推送 `log-<id>`。
use std::collections::HashSet;
use std::sync::Mutex;
use std::time::Duration;

use tauri::{AppHandle, Emitter, State};

use crate::core::api;
use crate::core::watch::ProjectWatcher;

/// 已在監看的專案 id（每個專案一條背景執行緒）。
pub struct Watching(pub Mutex<HashSet<String>>);

/// 開始監看專案；同一個專案只會開一條監看執行緒。
#[tauri::command]
pub fn watch_project(app: AppHandle, watching: State<Watching>, id: String) -> Result<(), String> {
    let root = api::project_root(&id).map_err(|e| e.message)?;
    if !watching.0.lock().unwrap().insert(id.clone()) {
        return Ok(());
    }
    std::thread::spawn(move || {
        let mut watcher = ProjectWatcher::new(&root);
        loop {
            for (event, payload) in watcher.tick() {
                let _ = app.emit(&format!("{event}-{id}"), payload);
            }
            // 200ms：AI 逐字輸出時看起來是連續的；每次只比對幾個檔案的修改時間與大小，成本很低。
            std::thread::sleep(Duration::from_millis(200));
        }
    });
    Ok(())
}
