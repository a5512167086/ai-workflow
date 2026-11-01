// aipipe 桌面版外殼。
// - 啟動時挑一個沒被佔用的本機連接埠，在背景啟動 sidecar（打包成 exe 的 `aipipe ui`），準備好後把視窗導到它。
// - 關閉視窗只是縮到系統匣；從系統匣選「結束」才會真的結束並停掉 sidecar。
//   （由 UI 啟動的 aipipe run 是獨立程序，結束 app 不會中斷正在跑的流程，和 CLI 版行為一致。）
// - 背景輪詢 /api/projects，專案停下來等使用者時發 Windows 通知。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, RunEvent, State, Url, WindowEvent};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

struct Sidecar(Mutex<Option<Child>>);
struct ServerPort(u16);

fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|l| l.local_addr())
        .map(|a| a.port())
        .unwrap_or(4317)
}

/// 打包後 sidecar 與主程式放在同一個資料夾（Tauri externalBin 會去掉 target triple）。
fn sidecar_path() -> PathBuf {
    let dir = std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(|d| d.to_path_buf()))
        .unwrap_or_default();
    dir.join(if cfg!(windows) { "aipipe-sidecar.exe" } else { "aipipe-sidecar" })
}

fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

fn spawn_sidecar(port: u16) -> std::io::Result<Child> {
    let log_dir = home_dir().join(".aipipe");
    std::fs::create_dir_all(&log_dir)?;
    let log = std::fs::File::create(log_dir.join("desktop-sidecar.log"))?;
    let mut cmd = Command::new(sidecar_path());
    cmd.args(["ui", "--port", &port.to_string(), "--no-open"])
        .env("AIPIPE_DESKTOP", "1")
        // sidecar 會監看這個 pid，外殼不在了就自己結束（當掉或被強制關閉時也一樣）。
        .env("AIPIPE_PARENT_PID", std::process::id().to_string())
        // 從家目錄啟動：不是任何專案，所以首頁是總覽。
        .current_dir(home_dir())
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    cmd.spawn()
}

/// 最小的 HTTP GET（HTTP/1.0，不需要額外的 HTTP 套件）。
fn http_get(port: u16, path: &str) -> Option<String> {
    let mut stream = TcpStream::connect_timeout(&([127, 0, 0, 1], port).into(), Duration::from_secs(2)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(5))).ok()?;
    write!(stream, "GET {path} HTTP/1.0\r\nHost: localhost:{port}\r\n\r\n").ok()?;
    let mut buf = Vec::new();
    stream.read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf).into_owned();
    let (head, body) = text.split_once("\r\n\r\n")?;
    if !head.starts_with("HTTP/1.1 200") && !head.starts_with("HTTP/1.0 200") {
        return None;
    }
    Some(body.to_string())
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn show_error(app: &AppHandle, message: &str) {
    if let Some(w) = app.get_webview_window("main") {
        let msg = serde_json::to_string(message).unwrap_or_default();
        let _ = w.eval(format!(
            "(() => {{ const m = document.getElementById('msg'); if (!m) return; m.textContent = '無法啟動 aipipe 本機服務'; \
             document.getElementById('bar')?.remove(); const p = document.createElement('p'); p.className = 'err'; p.textContent = {msg}; m.after(p); }})()"
        ));
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

fn watch_projects(app: AppHandle, port: u16) {
    std::thread::spawn(move || {
        let mut last: HashMap<String, String> = HashMap::new();
        let mut first = true;
        loop {
            if let Some(body) = http_get(port, "/api/projects") {
                if let Ok(json) = serde_json::from_str::<serde_json::Value>(&body) {
                    for p in json["projects"].as_array().into_iter().flatten() {
                        let id = p["id"].as_str().unwrap_or_default().to_string();
                        let status = p["status"].as_str().unwrap_or_default().to_string();
                        let changed = last.get(&id) != Some(&status);
                        // 啟動當下已經在等的專案不重複通知，只通知之後新進入等待狀態的。
                        if changed && !first {
                            if let Some(label) = attention_label(&status) {
                                let name = p["name"].as_str().unwrap_or("專案");
                                let reason = p["reason"].as_str().unwrap_or_default();
                                let body = if reason.is_empty() { label.to_string() } else { format!("{label}：{reason}") };
                                let _ = app
                                    .notification()
                                    .builder()
                                    .title(format!("aipipe｜{name}"))
                                    .body(body)
                                    .show();
                            }
                        }
                        last.insert(id, status);
                    }
                    first = false;
                }
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    });
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

#[tauri::command]
fn server_url(port: State<ServerPort>) -> String {
    format!("http://localhost:{}/", port.0)
}

fn main() {
    let port = free_port();
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_notification::init())
        .manage(Sidecar(Mutex::new(None)))
        .manage(ServerPort(port))
        .invoke_handler(tauri::generate_handler![pick_folder, server_url])
        .setup(move |app| {
            let handle = app.handle().clone();

            // 系統匣
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

            // sidecar
            match spawn_sidecar(port) {
                Ok(child) => {
                    *handle.state::<Sidecar>().0.lock().unwrap() = Some(child);
                }
                Err(err) => {
                    let h = handle.clone();
                    let msg = format!("找不到或無法執行 {}：{err}", sidecar_path().display());
                    std::thread::spawn(move || {
                        std::thread::sleep(Duration::from_millis(500));
                        show_error(&h, &msg);
                    });
                    return Ok(());
                }
            }
            let h = handle.clone();
            std::thread::spawn(move || {
                for _ in 0..150 {
                    if http_get(port, "/api/projects").is_some() {
                        if let (Some(w), Ok(url)) = (h.get_webview_window("main"), Url::parse(&format!("http://localhost:{port}/"))) {
                            let _ = w.navigate(url);
                        }
                        watch_projects(h.clone(), port);
                        return;
                    }
                    // sidecar 提早結束就直接報錯
                    let exited = match h.state::<Sidecar>().0.lock().unwrap().as_mut() {
                        Some(child) => child.try_wait().ok().flatten(),
                        None => None,
                    };
                    if let Some(status) = exited {
                        show_error(&h, &format!("sidecar 已結束（{status}），詳見 %USERPROFILE%\\.aipipe\\desktop-sidecar.log"));
                        return;
                    }
                    std::thread::sleep(Duration::from_millis(200));
                }
                show_error(&h, "等待本機服務逾時（30 秒），詳見 %USERPROFILE%\\.aipipe\\desktop-sidecar.log");
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            // 關閉視窗＝縮到系統匣，背景繼續監看並發通知。
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
                let app = window.app_handle();
                static ONCE: std::sync::Once = std::sync::Once::new();
                ONCE.call_once(|| {
                    let _ = app
                        .notification()
                        .builder()
                        .title("aipipe 仍在系統匣執行")
                        .body("流程需要你處理時會通知你。要完全結束，請在系統匣圖示按右鍵選「結束 aipipe」。")
                        .show();
                });
            }
        })
        .build(tauri::generate_context!())
        .expect("無法建立 aipipe 視窗");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            if let Some(mut child) = app.state::<Sidecar>().0.lock().unwrap().take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
    });
}
