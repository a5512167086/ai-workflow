//! 全域資料目錄（對應 legacy/src/home.js）：專案清單、執行佇列、全域設定。
//! 預設 ~/.aipipe，測試或多份安裝可用 AIPIPE_HOME 指定。與專案裡的 .aipipe/ 不同：那是單一專案的運行狀態。
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime};

use super::Result;

pub fn home_dir() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(std::env::temp_dir)
}

pub fn aipipe_home() -> PathBuf {
    let base = std::env::var_os("AIPIPE_HOME").map(PathBuf::from).unwrap_or_else(|| home_dir().join(".aipipe"));
    let _ = fs::create_dir_all(&base);
    base
}

/// 跨程序的互斥鎖：用 mkdir 的原子性建立鎖目錄（與 Node 版相容，兩版同時跑也互斥）。
/// 超過 10 秒沒釋放的鎖視為持有者已當掉，直接清掉。
pub fn with_lock<T>(name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let lock = aipipe_home().join(format!("{name}.lock"));
    with_lock_path(lock, name, f)
}

/// 專案資料的鎖跟著專案，避免 Windows／WSL 或不同 AIPIPE_HOME 使用不同鎖。
pub fn with_project_lock<T>(root: &Path, name: &str, f: impl FnOnce() -> Result<T>) -> Result<T> {
    let dir = root.join(".aipipe/locks"); fs::create_dir_all(&dir)?;
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
