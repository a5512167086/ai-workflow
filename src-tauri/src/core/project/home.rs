//! 全域資料目錄：專案清單、執行佇列、全域設定，以及每個專案的流程資料（projects/<id>/）。
//! 預設 ~/.ai-workflow，測試或多份安裝可用 AI_WORKFLOW_HOME 指定（舊名 AIPIPE_HOME 仍接受）。
//! 使用者的專案資料夾裡不會有任何這個工具產生的檔案。
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use crate::core::Result;

pub const HOME_ENV: &str = "AI_WORKFLOW_HOME";
pub const LEGACY_HOME_ENV: &str = "AIPIPE_HOME";
pub const HOME_DIR_NAME: &str = ".ai-workflow";
#[cfg(not(test))]
const LEGACY_HOME_DIR_NAME: &str = ".aipipe";

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

/// 單元測試沒有設定環境變數時用暫存目錄，不碰使用者的 ~/.ai-workflow。
#[cfg(test)]
fn default_home() -> PathBuf {
    static TEST_HOME: std::sync::OnceLock<PathBuf> = std::sync::OnceLock::new();
    TEST_HOME.get_or_init(|| crate::core::util::temp_dir("ai-workflow-test-home-")).clone()
}

/// 只有舊的 ~/.aipipe 時整個搬成 ~/.ai-workflow（只做一次）。
#[cfg(not(test))]
fn default_home() -> PathBuf {
    static MIGRATE: std::sync::Once = std::sync::Once::new();
    let base = home_dir().join(HOME_DIR_NAME);
    MIGRATE.call_once(|| {
        let legacy = home_dir().join(LEGACY_HOME_DIR_NAME);
        if !base.exists() && legacy.is_dir() {
            match fs::rename(&legacy, &base) {
                Ok(()) => eprintln!("ai-workflow: 已把 {} 搬到 {}", legacy.display(), base.display()),
                Err(err) => eprintln!("ai-workflow: 無法搬移舊資料目錄 {}：{err}", legacy.display()),
            }
        }
    });
    base
}

pub fn app_home() -> PathBuf {
    let base = std::env::var_os(HOME_ENV)
        .or_else(|| std::env::var_os(LEGACY_HOME_ENV))
        .map(PathBuf::from)
        .unwrap_or_else(default_home);
    let _ = fs::create_dir_all(&base);
    base
}

/// 專案流程資料的根目錄：<home>/projects/<專案 id>。
pub fn project_data_dir(root: &Path) -> PathBuf {
    app_home().join("projects").join(crate::core::projects::project_id(root))
}

/// 跨程序的互斥鎖：用 mkdir 的原子性建立鎖目錄。超過 10 秒沒釋放的鎖視為持有者已當掉，直接清掉。
pub fn with_lock<T>(name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock = app_home().join(format!("{name}.lock"));
    with_lock_path(lock, name, f)
}

/// 專案資料的鎖放在該專案的資料目錄裡。
pub fn with_project_lock<T>(root: &Path, name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let dir = project_data_dir(root).join("locks");
    fs::create_dir_all(&dir)?;
    with_lock_path(dir.join(format!("{name}.lock")), name, f)
}

fn with_lock_path<T>(lock: PathBuf, name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let start = Instant::now();
    let stale = Duration::from_secs(10);
    loop {
        match fs::create_dir(&lock) {
            Ok(()) => break,
            Err(err) if err.kind() == std::io::ErrorKind::AlreadyExists || lock.exists() => {
                let old = fs::metadata(&lock)
                    .and_then(|m| m.modified())
                    .ok()
                    .and_then(|t| SystemTime::now().duration_since(t).ok())
                    .is_some_and(|age| age > stale);
                if old {
                    let _ = fs::remove_dir_all(&lock);
                }
                if start.elapsed() > Duration::from_secs(15) {
                    crate::bail!("等待 {name} 鎖逾時");
                }
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(err) => return Err(err.into()),
        }
    }
    let out = f();
    let _ = fs::remove_dir_all(&lock);
    out
}
