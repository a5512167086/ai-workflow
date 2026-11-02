//! ai-workflow：桌面 App 的組裝（Tauri）與共用的核心邏輯。
//!
//! - `core/`：流程、AI CLI、專案資料等核心邏輯，桌面 App 與 CLI 子指令共用，不依賴 Tauri。
//! - `commands/`：前端呼叫的 `#[tauri::command]`（`api` 路由、原生對話框、專案監看）。
//! - `tray.rs`：系統匣圖示與選單；`notifications.rs`：背景監看所有專案並發 Windows 通知。
//!
//! 長時間的流程（PRD、拆任務、執行）以同一支 exe 的子指令在背景另開程序執行，關掉 App 不會中斷。
//! 關閉視窗只是縮到系統匣；從系統匣選「結束」才會真的結束。
pub mod core;

mod commands;
mod notifications;
mod tray;

use std::collections::HashSet;
use std::sync::Mutex;

use tauri::{Manager, WindowEvent};
use tauri_plugin_notification::NotificationExt;

pub const APP_NAME: &str = "ai-workflow";

/// 帶參數啟動時當 CLI 用（GUI 也用這個方式在背景啟動獨立的流程程序）；執行完直接結束，不開視窗。
pub fn run_cli_if_requested() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return;
    }
    // release 版是 Windows 子系統程式，沒有自己的主控台；從終端機執行時接到父程序的主控台。
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
    }
    let code = match core::cli::main(&args) {
        Ok(code) => code,
        Err(err) => {
            eprintln!("{APP_NAME}: {}", err.message);
            1
        }
    };
    std::process::exit(code);
}

/// 開啟桌面 App。
pub fn run() {
    // 啟動時就決定資料目錄（只有舊的 ~/.aipipe 時會搬成 ~/.ai-workflow）。
    let _ = core::home::app_home();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(commands::watch::Watching(Mutex::new(HashSet::new())))
        .invoke_handler(tauri::generate_handler![
            commands::api::api,
            commands::watch::watch_project,
            commands::dialogs::pick_folder,
            commands::dialogs::pick_skill_folder,
            commands::dialogs::pick_reference_files,
            commands::dialogs::pick_reference_folder,
        ])
        .setup(|app| {
            tray::create(app)?;
            notifications::watch_projects(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            // 關閉視窗＝縮到系統匣，背景繼續監看並發通知。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                static ONCE: std::sync::Once = std::sync::Once::new();
                ONCE.call_once(|| {
                    let _ = window
                        .app_handle()
                        .notification()
                        .builder()
                        .title(format!("{APP_NAME} 仍在系統匣執行"))
                        .body(format!("流程需要你處理時會通知你。要完全結束，請在系統匣圖示按右鍵選「結束 {APP_NAME}」。"))
                        .show();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("無法建立 ai-workflow 視窗");
}
