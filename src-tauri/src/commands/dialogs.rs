//! 原生的選擇檔案／資料夾對話框。
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;

/// 總覽的「加入專案」。
#[tauri::command]
pub async fn pick_folder(app: AppHandle) -> Option<String> {
    app.dialog()
        .file()
        .set_title("選擇專案資料夾")
        .blocking_pick_folder()
        .and_then(|p| p.into_path().ok())
        .map(|p| p.display().to_string())
}

/// 參考資料：選擇檔案。
#[tauri::command]
pub async fn pick_reference_files(app: AppHandle) -> Vec<String> {
    app.dialog().file().set_title("加入參考檔案").blocking_pick_files().unwrap_or_default().into_iter().filter_map(|p| p.into_path().ok()).map(|p| p.display().to_string()).collect()
}

/// 參考資料：選擇資料夾（會建立快照）。
#[tauri::command]
pub async fn pick_reference_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().set_title("加入參考資料夾（建立快照）").blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}

/// 「匯入技能」：選擇像 .claude/skills/<name>/ 這樣包含 SKILL.md 的資料夾。
#[tauri::command]
pub async fn pick_skill_folder(app: AppHandle) -> Option<String> {
    app.dialog().file().set_title("匯入技能資料夾（需包含 SKILL.md）").blocking_pick_folder().and_then(|p| p.into_path().ok()).map(|p| p.display().to_string())
}
