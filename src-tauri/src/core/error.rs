use std::fmt;

/// 對應 Node 版 `Object.assign(new Error(msg), { status })`：status 是給 UI 路由用的 HTTP 風格狀態碼。
#[derive(Debug, Clone)]
pub struct AppError {
    pub status: u16,
    pub message: String,
}

pub type Result<T> = std::result::Result<T, AppError>;

impl AppError {
    pub fn new(message: impl Into<String>) -> Self {
        Self { status: 500, message: message.into() }
    }
    pub fn with_status(status: u16, message: impl Into<String>) -> Self {
        Self { status, message: message.into() }
    }
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for AppError {}

impl From<std::io::Error> for AppError {
    fn from(err: std::io::Error) -> Self {
        Self::new(err.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        Self::new(err.to_string())
    }
}

/// `bail!("訊息 {x}")` 或 `bail!(404; "訊息")`。
#[macro_export]
macro_rules! bail {
    ($status:literal; $($arg:tt)+) => {
        return Err($crate::core::AppError::with_status($status, format!($($arg)+)))
    };
    ($($arg:tt)+) => {
        return Err($crate::core::AppError::new(format!($($arg)+)))
    };
}
