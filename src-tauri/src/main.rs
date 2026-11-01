// aipipe 桌面版。
// - 後端邏輯在 aipipe 函式庫（src/core）；前端（../src）透過 `api` command 呼叫，路徑與舊版 HTTP API 相同。
// - 長時間的流程（PRD、拆任務、執行）以同一支 exe 的子指令在背景另開程序執行，關掉 app 不會中斷。
// - 關閉視窗只是縮到系統匣；從系統匣選「結束」才會真的結束。
// - 背景監看所有專案，停下來等使用者時發 Windows 通知。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use std::time::Duration;

use aipipe::core::api;
use aipipe::core::watch::{ProjectWatcher, ProjectsWatcher};
use serde_json::Value;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

/// 已在監看的專案 id（每個專案一條背景執行緒）。
struct Watching(Mutex<HashSet<String>>);

/// 帶參數啟動時當 CLI 用（GUI 也用這個方式在背景啟動獨立的流程程序）；不認得的指令回報錯誤，不開視窗。
fn run_cli_if_requested() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        return;
    }
    // release 版是 Windows 子系統程式，沒有自己的主控台；從終端機執行時接到父程序的主控台。
    #[cfg(windows)]
    unsafe {
        windows_sys::Win32::System::Console::AttachConsole(windows_sys::Win32::System::Console::ATTACH_PARENT_PROCESS);
    }
    let code = match aipipe::core::cli::main(&args) {
        Ok(code) => code,
        Err(err) => {
            eprintln!("aipipe: {}", err.message);
            1
        }
    };
    std::process::exit(code);
}

/// 前端的 API 呼叫。method 是 GET 或 POST，path 例如 /api/p/<id>/state。
#[tauri::command]
async fn api(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || api::handle(&method, &path, &body.unwrap_or(Value::Null)).map_err(|e| e.message))
        .await
        .map_err(|e| e.to_string())?
}

/// 開始監看專案：state 變化推送 `state-<id>`，新增的 log 推送 `log-<id>`。
#[tauri::command]
fn watch_project(app: AppHandle, watching: State<Watching>, id: String) -> Result<(), String> {
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
            std::thread::sleep(Duration::from_millis(700));
        }
    });
    Ok(())
}

/// 原生「選擇資料夾」對話框，給總覽的「加入專案」用。
#[tauri::command]
async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("選擇專案資料夾")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// 專案停下來等使用者時的通知文字。
fn attention_label(status: &str) -> Option<&'static str> {
    match status {
        "awaiting_approval" => Some("PRD 等待核准"),
        "waiting" => Some("任務等待人工測試"),
        "feature_test" => Some("功能完成，等待功能測試"),
        "stuck" => Some("需要人工處理"),
        "error" => Some("流程發生錯誤"),
        _ => None,
    }
}

/// 總覽的監看：推送 `projects` 事件，並在專案新進入等待狀態時發通知（啟動當下已經在等的不重複通知）。
fn watch_projects(app: AppHandle) {
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
                            let _ = app.notification().builder().title(format!("aipipe｜{name}")).body(body).show();
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

fn main() {
    run_cli_if_requested();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Watching(Mutex::new(HashSet::new())))
        .invoke_handler(tauri::generate_handler![api, watch_project, pick_folder])
        .setup(|app| {
            let open = MenuItem::with_id(app, "open", "開啟 aipipe", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "結束 aipipe", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().expect("缺少視窗圖示"))
                .tooltip("aipipe")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "open" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            watch_projects(app.handle().clone());
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
                        .title("aipipe 仍在系統匣執行")
                        .body("流程需要你處理時會通知你。要完全結束，請在系統匣圖示按右鍵選「結束 aipipe」。")
                        .show();
                });
            }
        })
        .run(tauri::generate_context!())
        .expect("無法建立 aipipe 視窗");
}
