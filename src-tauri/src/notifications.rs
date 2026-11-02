//! 背景監看所有專案：推送總覽的 `projects` 事件，專案新進入等待使用者的狀態時發 Windows 通知。
use std::collections::HashMap;
use std::time::Duration;

use tauri::{AppHandle, Emitter};
use tauri_plugin_notification::NotificationExt;

use crate::core::watch::ProjectsWatcher;
use crate::APP_NAME;

/// 專案停下來等使用者時的通知文字。
fn attention_label(status: &str) -> Option<&'static str> {
    match status {
        "awaiting_permission" => Some("AI 等待你允許操作"),
        "awaiting_approval" => Some("PRD 等待核准"),
        "waiting" => Some("任務等待人工測試"),
        "feature_test" => Some("功能完成，等待功能測試"),
        "stuck" => Some("需要人工處理"),
        "error" => Some("流程發生錯誤"),
        _ => None,
    }
}

/// 啟動當下已經在等的專案不重複通知，之後狀態一變成等待就通知一次。
pub fn watch_projects(app: AppHandle) {
    std::thread::spawn(move || {
        let mut watcher = ProjectsWatcher::default();
        let mut last: HashMap<String, String> = HashMap::new();
        let mut first = true;
        loop {
            if let Some(payload) = watcher.tick() {
                for p in payload["projects"].as_array().into_iter().flatten() {
                    let id = p["id"].as_str().unwrap_or_default().to_string();
                    let status = p["status"].as_str().unwrap_or_default().to_string();
                    if !first && last.get(&id) != Some(&status) {
                        if let Some(label) = attention_label(&status) {
                            let name = p["name"].as_str().unwrap_or("專案");
                            let reason = p["reason"].as_str().unwrap_or_default();
                            let body = if reason.is_empty() { label.to_string() } else { format!("{label}：{reason}") };
                            let _ = app.notification().builder().title(format!("{APP_NAME}｜{name}")).body(body).show();
                        }
                    }
                    last.insert(id, status);
                }
                first = false;
                let _ = app.emit("projects", payload);
            }
            std::thread::sleep(Duration::from_millis(1500));
        }
    });
}
