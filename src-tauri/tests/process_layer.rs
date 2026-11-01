//! 移植 legacy/test/core（git）、wsl、usage（RPC）與 init 的測試。
mod common;

use std::ffi::OsString;
use std::fs;
use std::process::Command;

use aipipe::core::config::default_config;
use aipipe::core::git::{diff_trees, is_git_repo, restore_to_tree, snapshot_tree};
use aipipe::core::init::{init_project, InitOptions};
use aipipe::core::proc::{query_codex_rpc, resolve_cli_for, run, RunOpts};
use common::*;
use serde_json::json;

#[test]
fn snapshot_tree_與_restore_to_tree_不動_index_可還原任務變更() {
    let dir = project();
    git(&dir, &["init", "-q", "-b", "main"]);
    git(&dir, &["config", "user.email", "t@example.com"]);
    git(&dir, &["config", "user.name", "t"]);
    git(&dir, &["config", "core.autocrlf", "false"]);
    fs::write(dir.join("a.txt"), "one\n").unwrap();
    git(&dir, &["add", "."]);
    git(&dir, &["commit", "-qm", "init"]);
    let base = snapshot_tree(&dir).unwrap();
    fs::write(dir.join("a.txt"), "two\n").unwrap();
    fs::write(dir.join("b.txt"), "new\n").unwrap();
    let diff = diff_trees(&dir, &base, &snapshot_tree(&dir).unwrap()).unwrap();
    assert!(diff.contains("b.txt"));
    assert!(diff.contains("+two"));
    assert_eq!(git(&dir, &["diff", "--cached", "--name-only"]).trim(), "");
    restore_to_tree(&dir, &base).unwrap();
    assert_eq!(fs::read_to_string(dir.join("a.txt")).unwrap(), "one\n");
    assert!(!dir.join("b.txt").exists());
}

#[test]
fn init_project_在非_git_目錄預設拒絕_git_init_時先建立_repo() {
    let dir = project();
    let err = init_project(&dir, &InitOptions::default()).err().unwrap();
    assert!(err.message.contains("--git-init"));
    assert!(!dir.join(".aipipe.json").exists());
    let r = init_project(&dir, &InitOptions { git_init: true, ..Default::default() }).unwrap();
    assert!(r.git_initialized);
    assert!(is_git_repo(&dir).unwrap());
    assert!(dir.join(".aipipe.json").exists());
    assert!(fs::read_to_string(dir.join(".gitignore")).unwrap().contains(".aipipe/"));
    assert_eq!(r.created, vec!["docs/ai-context.md", "docs/index.md"]);
    assert_eq!(snapshot_tree(&dir).unwrap().len(), 40);
    let again = init_project(&dir, &InitOptions { force: true, git_init: true, ..Default::default() }).unwrap();
    assert!(!again.git_initialized);
    assert!(init_project(&dir, &InitOptions::default()).err().unwrap().message.contains("--force"));
}

#[test]
fn codex_額度_rpc_完成_handshake_只查額度() {
    let root = project();
    let mut cfg = default_config();
    cfg["runtime"] = json!({ "claude": "windows", "codex": "windows" });
    cfg["cli"]["codex"] = json!(install_fake(&root, "codex").to_string_lossy());
    let spec = resolve_cli_for(&cfg, "codex", &root).unwrap();
    let result = query_codex_rpc(&spec, &root, "account/rateLimits/read", 5).unwrap();
    assert_eq!(result["rateLimits"]["primary"]["usedPercent"], 25);
    assert!(query_codex_rpc(&spec, &root, "thread/start", 5).is_err());
}

#[test]
fn wsl_runtime_參數原樣傳遞_cwd_轉成_mnt_路徑_api_key_在_wsl_端被清掉() {
    if !has_wsl() {
        eprintln!("略過：沒有 WSL");
        return;
    }
    let mut cfg = default_config();
    cfg["runtime"] = json!({ "claude": "wsl", "codex": "windows" });
    cfg["wsl_cli"] = json!({ "claude": "bash" });
    let cwd = std::env::current_dir().unwrap();
    let spec = resolve_cli_for(&cfg, "claude", &cwd).unwrap();
    // WSLENV 會把 Windows 端變數轉送進 WSL，模擬「WSL 環境裡有 API key」。
    let mut env: Vec<(OsString, OsString)> = std::env::vars_os().collect();
    for (k, v) in [("ANTHROPIC_API_KEY", "leak"), ("OPENAI_API_KEY", "leak"), ("WSLENV", "ANTHROPIC_API_KEY:OPENAI_API_KEY")] {
        env.push((k.into(), v.into()));
    }
    let script = r#"printf "%s|" "$@"; echo; pwd; echo "a=${ANTHROPIC_API_KEY-unset} o=${OPENAI_API_KEY-unset}"; cat"#;
    let args: Vec<String> = ["-c", script, "x", "a b", "q\"uote", "$HOME", "x;y"].map(String::from).to_vec();
    let res = run(&spec, &args, RunOpts { cwd: Some(&cwd), env: Some(env), input: Some("中文 stdin"), timeout_sec: 60, ..Default::default() }).unwrap();
    assert_eq!(res.code, 0, "{}", res.stderr);
    let lines: Vec<&str> = res.stdout.trim().lines().collect();
    assert_eq!(lines[0], "a b|q\"uote|$HOME|x;y|");
    assert!(lines[1].starts_with("/mnt/c/"), "{}", lines[1]);
    assert_eq!(lines[2], "a=unset o=unset");
    assert_eq!(lines[3], "中文 stdin");
    let converted = spec.to_path(std::path::Path::new("C:\\Users\\x y\\f.md")).unwrap();
    assert_eq!(converted, "/mnt/c/Users/x y/f.md");
}

#[test]
fn wsl_專案_unc_路徑自動選擇正確發行版並在_linux_專案目錄執行() {
    if !has_wsl() {
        eprintln!("略過：沒有 WSL");
        return;
    }
    let out = Command::new("wsl.exe").args(["-e", "bash", "-lc", "printf '%s\\n' \"$WSL_DISTRO_NAME\""]).output().unwrap();
    let distro = String::from_utf8_lossy(&out.stdout).trim().to_string();
    let root = format!("\\\\wsl.localhost\\{distro}\\tmp");
    let mut cfg = default_config();
    cfg["wsl_distro"] = json!("WrongDistro");
    cfg["wsl_cli"] = json!({ "claude": "bash" });
    let spec = resolve_cli_for(&cfg, "claude", std::path::Path::new(&root)).unwrap();
    assert_eq!(spec.distro, distro);
    let res = run(&spec, &["-c".into(), "pwd".into()], RunOpts { cwd: Some(std::path::Path::new(&root)), timeout_sec: 30, ..Default::default() }).unwrap();
    assert_eq!(res.code, 0, "{}", res.stderr);
    assert_eq!(res.stdout.trim(), "/tmp");
}
