use serde_json::Value;

use crate::core::api;

/// 前端的 API 呼叫。method 是 GET 或 POST，path 例如 /api/p/<id>/state（路徑沿用舊版 HTTP API）。
/// 在背景執行緒處理，避免查 CLI、讀大檔時卡住視窗。
#[tauri::command]
pub async fn api(method: String, path: String, body: Option<Value>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || api::handle(&method, &path, &body.unwrap_or(Value::Null)).map_err(|e| e.message))
        .await
        .map_err(|e| e.to_string())?
}
