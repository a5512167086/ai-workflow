//! git、wsl、usage（RPC）與 init 的測試。
mod common;

use std::ffi::OsString;
use std::fs;
use std::process::Command;

use ai_workflow::core::config::{default_config, project_registered};
use ai_workflow::core::git::{diff_trees, is_git_repo, restore_to_tree, snapshot_tree};
use ai_workflow::core::init::{init_project, InitOptions};
use ai_workflow::core::proc::{query_codex_rpc, resolve_cli_for, run, RunOpts};
use common::*;
use serde_json::json;

#[test]
fn 停止_wsl_查詢會結束_linux_程序群組() {
    if !has_wsl() { return; }
    let root = project(); let marker = root.join("turn.cancel"); let pid_file = marker.with_extension("pid");
    let spec = ai_workflow::core::proc::CliSpec { wsl: true, bin: "/bin/sleep".into(), label: "WSL sleep".into(), ..Default::default() };
    let stop = marker.clone();
    let stopper = std::thread::spawn(move || {
        let started = std::time::Instant::now();
        while !pid_file.exists() && started.elapsed() < std::time::Duration::from_secs(10) { std::thread::sleep(std::time::Duration::from_millis(20)); }
        let group = fs::read_to_string(pid_file).ok(); fs::write(stop, "stop").unwrap(); group
    });
    let result = run(&spec, &["30".into()], RunOpts { cwd: Some(&root), cancel_file: Some(marker), timeout_sec: 15, ..Default::default() }).unwrap();
    let group = stopper.join().unwrap(); assert!(result.cancelled, "{result:?}"); assert!(!result.timed_out);
    let group = group.unwrap_or_else(|| panic!("沒有取得 Linux pid：{result:?}"));
    let probe = Command::new("wsl.exe").args(["-e", "/bin/kill", "-0", "--", &format!("-{}", group.trim())]).output().unwrap();
    assert!(!probe.status.success(), "Linux CLI 群組仍然存在");
}

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
    assert_no_app_files(&dir);
}

#[test]
fn init_project_在非_git_目錄預設拒絕_git_init_時先建立_repo_且不在專案裡寫檔() {
    let dir = project();
    fs::write(dir.join("package.json"), r#"{"scripts":{"test":"vitest","lint":"eslint ."}}"#).unwrap();
    let err = init_project(&dir, &InitOptions::default()).err().unwrap();
    assert!(err.message.contains("--git-init"));
    assert!(!project_registered(&dir));
    let r = init_project(&dir, &InitOptions { git_init: true, ..Default::default() }).unwrap();
    assert!(r.git_initialized);
    assert!(is_git_repo(&dir).unwrap());
    assert!(project_registered(&dir));
    assert_eq!(r.cfg["commands"], json!({ "build": "", "test": "npm test", "lint": "npm run lint" }));
    assert_eq!(r.cfg["context_files"], json!([]));
    assert!(r.data_dir.starts_with(ai_workflow::core::home::app_home()));
    let names: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(names, vec![".git", "package.json"], "init 不能在專案裡建立 .gitignore、docs 或設定檔");
    assert_eq!(snapshot_tree(&dir).unwrap().len(), 40);
    let again = init_project(&dir, &InitOptions { force: true, git_init: true, ..Default::default() }).unwrap();
    assert!(!again.git_initialized);
    assert!(init_project(&dir, &InitOptions::default()).err().unwrap().message.contains("--force"));
}

#[test]
fn 舊版放在專案裡的資料第一次開啟時搬到資料目錄_舊檔保留() {
    use ai_workflow::core::state::{data_dir, handover_file, prd_file, read_state};
    let dir = project();
    git(&dir, &["init", "-q", "-b", "main"]);
    fs::create_dir_all(dir.join(".aipipe/prd")).unwrap();
    fs::create_dir_all(dir.join(".aipipe/tmp")).unwrap();
    fs::create_dir_all(dir.join("docs/aipipe")).unwrap();
    fs::create_dir_all(dir.join("docs/prd/2026-11-01-csv/rounds")).unwrap();
    fs::create_dir_all(dir.join("docs/handovers")).unwrap();
    fs::write(dir.join(".aipipe.json"), json!({ "num_tasks": 4, "feature": "csv", "commands": { "test": "cargo test" }, "context_files": ["docs/ai-context.md", "docs/index.md"] }).to_string()).unwrap();
    fs::write(dir.join(".aipipe/state.json"), json!({ "prd": { "status": "approved", "archive_dir": "docs/prd/2026-11-01-csv" } }).to_string()).unwrap();
    fs::write(dir.join(".aipipe/prd/current.md"), "# 目前 PRD").unwrap();
    fs::write(dir.join(".aipipe/tmp/junk.prompt.md"), "x").unwrap();
    fs::write(dir.join("docs/aipipe/backlog.json"), json!({ "version": 1, "items": [{ "id": "a", "title": "舊需求", "status": "open" }] }).to_string()).unwrap();
    fs::write(dir.join("docs/aipipe/prd.md"), "# 核准的 PRD").unwrap();
    fs::write(dir.join("docs/prd/2026-11-01-csv/prd.md"), "# 封存").unwrap();
    fs::write(dir.join("docs/handovers/current_handover.md"), "交接").unwrap();
    let before: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();

    let r = init_project(&dir, &InitOptions::default()).unwrap();
    assert!(!r.migrated.is_empty(), "{:?}", r.migrated);
    let cfg = r.cfg;
    assert_eq!(cfg["feature"], "csv");
    assert_eq!(cfg["commands"]["test"], "cargo test");
    assert_eq!(cfg["num_tasks"], 4, "舊設定裡的全域欄位補進全域設定");
    assert_eq!(cfg["context_files"], json!([]), "不存在的範本檔不帶進新設定");
    assert_eq!(fs::read_to_string(data_dir(&dir).join("prd/current.md")).unwrap(), "# 目前 PRD");
    assert!(!data_dir(&dir).join("tmp/junk.prompt.md").exists());
    assert_eq!(fs::read_to_string(prd_file(&dir)).unwrap(), "# 核准的 PRD");
    assert_eq!(fs::read_to_string(handover_file(&dir)).unwrap(), "交接");
    assert_eq!(ai_workflow::core::backlog::read_backlog(&dir).unwrap()[0]["title"], "舊需求");
    assert_eq!(ai_workflow::core::archive::list_archives(&dir).unwrap()[0]["name"], "2026-11-01-csv");
    assert_eq!(read_state(&dir)["prd"]["archive_dir"], "archive/2026-11-01-csv");
    assert!(fs::read_to_string(data_dir(&dir).join("logs/process.log")).unwrap().contains("舊檔沒有刪除"));
    // 舊檔一個都不刪，也不新增；第二次開啟不再重搬。
    let after: Vec<String> = fs::read_dir(&dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
    assert_eq!(before, after);
    assert!(ai_workflow::core::init::migrate_legacy(&dir).unwrap().is_empty());
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
    assert!(query_codex_rpc(&spec, &root, "unknown/method", 5).is_err());
    // 查額度不會開始任何模型回合（假 CLI 只在 turn/start 時記錄呼叫）。
    assert!(calls(&root).is_empty());
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
