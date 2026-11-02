//! 整合測試共用：暫存的全域資料目錄、假 CLI。
#![allow(dead_code)]
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Once;

use ai_workflow::core::util::temp_dir;
use serde_json::Value;

static HOME: Once = Once::new();
static FAKE: Once = Once::new();

/// 全域資料（專案清單、佇列、設定、每個專案的流程資料）放到暫存目錄，不碰使用者的 ~/.ai-workflow。
pub fn setup() {
    HOME.call_once(|| std::env::set_var(ai_workflow::core::home::HOME_ENV, temp_dir("ai-workflow-home-")));
}

pub fn project() -> PathBuf {
    setup();
    temp_dir("ai-workflow-test-")
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

/// 假 CLI 每次被呼叫都會把 { provider, pid, args, prompt } 附加到專案裡的 .fake-cli-calls.jsonl。
pub fn calls(root: &Path) -> Vec<Value> {
    std::fs::read_to_string(root.join(".fake-cli-calls.jsonl")).unwrap_or_default().lines().map(|l| serde_json::from_str(l).unwrap()).collect()
}

pub fn git(dir: &Path, args: &[&str]) -> String {
    let out = Command::new("git").args(args).current_dir(dir).output().unwrap();
    assert!(out.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&out.stderr));
    String::from_utf8_lossy(&out.stdout).into_owned()
}

pub fn has_wsl() -> bool {
    cfg!(windows) && Command::new("wsl.exe").args(["-e", "true"]).output().map(|o| o.status.success()).unwrap_or(false)
}

/// 專案資料夾裡只能有測試自己放的東西（假 CLI、.fake-cli*、.git 與測試檔），不能有 ai-workflow 產生的檔案。
pub fn assert_no_app_files(root: &Path) {
    for entry in std::fs::read_dir(root).unwrap() {
        let name = entry.unwrap().file_name().to_string_lossy().into_owned();
        assert!(!name.starts_with(".aipipe") && !name.starts_with(".ai-workflow") && name != "docs", "專案資料夾不應有 {name}");
    }
}
