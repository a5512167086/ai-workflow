//! 移植時常用的小工具：ISO 時間、JSON 讀寫、Value 存取。
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{Map, Value};

use crate::core::Result;

/// 與 JS `new Date().toISOString()` 相同格式（UTC、毫秒、Z）。
pub fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()
}

pub fn today() -> String {
    now_iso()[..10].to_string()
}

pub fn read_text(file: impl AsRef<Path>) -> String {
    fs::read_to_string(file).unwrap_or_default()
}

pub fn read_json(file: impl AsRef<Path>) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(file).ok()?).ok()
}

/// `JSON.stringify(v, null, 2)`。
pub fn pretty(value: &Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_default()
}

/// 寫到暫存檔再 rename；Windows 上讀取中的檔案偶爾無法覆蓋，稍等重試。
pub fn write_atomic(file: &Path, text: &str) -> Result<()> {
    if let Some(dir) = file.parent() {
        fs::create_dir_all(dir)?;
    }
    let tmp = PathBuf::from(format!("{}.{}.tmp", file.display(), std::process::id()));
    fs::write(&tmp, text)?;
    let mut i = 0;
    loop {
        match fs::rename(&tmp, file) {
            Ok(()) => return Ok(()),
            Err(err) if i < 20 && err.kind() == std::io::ErrorKind::PermissionDenied => {
                i += 1;
                std::thread::sleep(Duration::from_millis(25));
            }
            Err(err) => return Err(err.into()),
        }
    }
}

/// home.js 的 writeJson：縮排 2、結尾換行、原子寫入。
pub fn write_json(file: &Path, value: &Value) -> Result<()> {
    write_atomic(file, &(pretty(value) + "\n"))
}

pub fn obj(value: &mut Value) -> &mut Map<String, Value> {
    if !value.is_object() {
        *value = Value::Object(Map::new());
    }
    value.as_object_mut().unwrap()
}

pub fn str_of<'a>(value: &'a Value, key: &str) -> &'a str {
    value.get(key).and_then(Value::as_str).unwrap_or("")
}

/// JS 的 truthy 判斷（null、false、0、空字串為 false）。
pub fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().is_some_and(|f| f != 0.0),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

/// JS `String(v)`：數字、字串直接轉，其他用 JSON。
pub fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Null => "null".into(),
        other => other.to_string(),
    }
}

/// 路徑正規化（等同 path.resolve；不存在的路徑也能用）。
pub fn resolve(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    let abs = if path.is_absolute() { path.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(path) };
    let mut out = PathBuf::new();
    for comp in abs.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// 相對路徑一律用 / 分隔（存進 state／meta 的格式）。
pub fn rel_slash(root: &Path, path: &Path) -> String {
    path.strip_prefix(root).unwrap_or(path).to_string_lossy().replace('\\', "/")
}

/// Skill／任務 skills 欄位共用的名稱規則：^[a-z0-9][a-z0-9-]{0,63}$
pub fn valid_skill_name(name: &str) -> bool {
    let bytes = name.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 64
        && (bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit())
        && bytes.iter().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || *b == b'-')
}

/// 從 `#[cfg(test)]` 或整合測試共用：建立暫存資料夾。
pub fn temp_dir(prefix: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("{prefix}{}", uuid::Uuid::new_v4().simple()));
    fs::create_dir_all(&dir).expect("建立暫存資料夾失敗");
    dir
}
