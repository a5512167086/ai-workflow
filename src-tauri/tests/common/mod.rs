//! 整合測試共用：暫存的全域資料目錄、假 CLI。
#![allow(dead_code)]
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Once;

use aipipe::core::util::temp_dir;

static HOME: Once = Once::new();
static FAKE: Once = Once::new();

/// 全域資料（專案清單、佇列）放到暫存目錄，不碰使用者的 ~/.aipipe。
pub fn setup() {
    HOME.call_once(|| std::env::set_var("AIPIPE_HOME", temp_dir("aipipe-home-")));
}

pub fn project() -> PathBuf {
    setup();
    temp_dir("aipipe-test-")
}

fn fake_cli() -> PathBuf {
    let exe = std::env::current_exe().unwrap();
    let debug = exe.parent().unwrap().parent().unwrap();
    let file = debug.join("examples").join(if cfg!(windows) { "fake_cli.exe" } else { "fake_cli" });
    FAKE.call_once(|| {
        let status = Command::new(env!("CARGO"))
            .args(["build", "--example", "fake_cli", "--manifest-path", concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.toml")])
            .status()
            .expect("無法建置 fake_cli");
        assert!(status.success(), "建置 fake_cli 失敗");
    });
    file
}

/// 把假 CLI 複製成 <dir>/<provider>.exe 並回傳路徑（假 CLI 用檔名判斷扮演哪一個）。
pub fn install_fake(dir: &Path, provider: &str) -> PathBuf {
    let target = dir.join(if cfg!(windows) { format!("{provider}.exe") } else { provider.to_string() });
    std::fs::copy(fake_cli(), &target).unwrap();
    target
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub fn has_wsl() -> bool {
    cfg!(windows) && Command::new("wsl.exe").args(["-e", "true"]).output().map(|o| o.status.success()).unwrap_or(false)
}
