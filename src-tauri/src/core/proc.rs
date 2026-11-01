//! 子程序（對應 legacy/src/proc.js）：清掉 API key 的環境、解析 CLI、WSL 參數、串流執行與逾時。
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::mpsc;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::runtime::{cli_environment, wsl_location};
use super::{AppError, Result};

/// 子程序環境：移除所有會讓 CLI 改走付費 API 的變數，確保使用訂閱登入。
/// 同時移除從上層 Claude Code session 繼承的變數（例如 CLAUDE_CODE_SIMPLE 會讓 claude 忽略 OAuth 登入）。
pub fn clean_env_from(vars: impl Iterator<Item = (OsString, OsString)>, extra: &[(String, String)]) -> Vec<(OsString, OsString)> {
    let mut out: Vec<(OsString, OsString)> = vars
        .filter(|(key, _)| {
            let k = key.to_string_lossy().to_uppercase();
            k == "CLAUDE_CODE_GIT_BASH_PATH"
                || !(k.starts_with("ANTHROPIC_")
                    || ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "OPENAI_CODEX_API_KEY", "CLAUDECODE"].contains(&k.as_str())
                    || k.starts_with("CLAUDE_CODE_")
                    || k.starts_with("CLAUDE_AGENT_SDK_"))
        })
        .collect();
    for (k, v) in extra.iter().map(|(k, v)| (k.as_str(), v.as_str())).chain([("NO_COLOR", "1"), ("FORCE_COLOR", "0")]) {
        out.retain(|(key, _)| !key.to_string_lossy().eq_ignore_ascii_case(k));
        out.push((k.into(), v.into()));
    }
    out
}

pub fn clean_env() -> Vec<(OsString, OsString)> {
    clean_env_from(std::env::vars_os(), &[])
}

pub const STRIPPED_ENV_DESCRIPTION: &str = "ANTHROPIC_*、OPENAI_API_KEY、OPENAI_BASE_URL、CODEX_API_KEY、OPENAI_CODEX_API_KEY、CLAUDECODE、CLAUDE_CODE_*、CLAUDE_AGENT_SDK_*";

pub fn which(name: &str) -> Option<PathBuf> {
    let exts: &[&str] = if cfg!(windows) { &[".exe", ".cmd", ".bat", ""] } else { &[""] };
    let path = std::env::var_os("PATH")?;
    for dir in std::env::split_paths(&path) {
        if dir.as_os_str().is_empty() {
            continue;
        }
        for ext in exts {
            let file = dir.join(format!("{name}{ext}"));
            if file.is_file() {
                return Some(file);
            }
        }
    }
    None
}

#[derive(Clone, Debug, Default)]
pub struct CliSpec {
    pub runtime: String,
    pub command: String,
    pub prefix_args: Vec<String>,
    pub shell: bool,
    pub label: String,
    pub wsl: bool,
    pub distro: String,
    pub bin: String,
}

impl CliSpec {
    /// 把 Windows 路徑轉成這個 runtime 看得懂的路徑（WSL 時是 /mnt/... 或 Linux 路徑）。
    pub fn to_path(&self, p: &Path) -> Result<String> {
        if self.wsl {
            to_wsl_path(&self.distro, &p.to_string_lossy())
        } else {
            Ok(p.to_string_lossy().into_owned())
        }
    }
}

fn has_ext(file: &str, exts: &[&str]) -> bool {
    let lower = file.to_ascii_lowercase();
    exts.iter().any(|e| lower.ends_with(e))
}

/// 把設定或 PATH 裡的 CLI 解析成可直接執行的 spec。npm 在 Windows 產生的 .cmd 包裝檔會改成用 node 直接執行其 JS 入口，
/// 避免經過 cmd.exe 的參數跳脫問題。
pub fn resolve_cli(configured: &str, fallback: &str) -> Result<CliSpec> {
    let file = if configured.is_empty() { which(fallback).map(|p| p.to_string_lossy().into_owned()) } else { Some(configured.to_string()) };
    let Some(file) = file else {
        crate::bail!("找不到 {fallback}，請安裝後確認在 PATH 中，或在 .aipipe.json 的 cli 欄位填完整路徑");
    };
    let node = || which("node").map(|p| p.to_string_lossy().into_owned());
    let base = CliSpec { label: file.clone(), ..Default::default() };
    if cfg!(windows) && has_ext(&file, &[".cmd", ".bat"]) {
        let text = std::fs::read_to_string(&file).unwrap_or_default();
        static NPM_SHIM: LazyLock<regex::Regex> = LazyLock::new(|| regex::Regex::new(r#"(?i)"%(?:dp0|~dp0)%\\([^"]+\.(?:js|mjs|cjs))""#).unwrap());
        if let (Some(m), Some(node)) = (NPM_SHIM.captures(&text), node()) {
            let script = Path::new(&file).parent().unwrap_or(Path::new("")).join(&m[1]);
            return Ok(CliSpec { command: node, prefix_args: vec![script.to_string_lossy().into_owned()], ..base });
        }
        return Ok(CliSpec { command: file, shell: true, ..base });
    }
    if has_ext(&file, &[".js", ".mjs", ".cjs"]) {
        let Some(node) = node() else { crate::bail!("{file} 是 Node.js 腳本，需要安裝 Node.js 並放在 PATH 中") };
        return Ok(CliSpec { command: node, prefix_args: vec![file], ..base });
    }
    Ok(CliSpec { command: file, ..base })
}

/// 在 WSL 裡啟動指令前執行的清理腳本。login shell 會讀 .bashrc／.profile，可能又設回 API key，
/// 所以在 WSL 端再清一次（Windows 端的 clean_env 管不到 WSL 自己的設定檔，也擋不住 WSLENV 轉送）。
pub const WSL_SCRUB_SCRIPT: &str = "for v in $(compgen -e); do   case \"$v\" in ANTHROPIC_*|CLAUDE_CODE_*|CLAUDE_AGENT_SDK_*|CLAUDECODE|OPENAI_API_KEY|OPENAI_BASE_URL|CODEX_API_KEY|OPENAI_CODEX_API_KEY) unset \"$v\";; esac; done; exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CODEX_API_KEY \"$@\"";

/// 依 .aipipe.json 的 runtime 解析 CLI：windows 用 resolve_cli；wsl 透過 wsl.exe 執行。name 是 claude / codex。
pub fn resolve_cli_for(cfg: &Value, name: &str, root: &Path) -> Result<CliSpec> {
    let environment = cli_environment(cfg, name, root);
    if environment.runtime == "wsl" {
        let configured = cfg["wsl_cli"][name].as_str().unwrap_or("");
        if !cfg!(windows) {
            return Ok(CliSpec { runtime: "wsl".into(), ..resolve_cli(configured, name)? });
        }
        let distro = environment.distro;
        let bin = if configured.is_empty() { name.to_string() } else { configured.to_string() };
        let label = format!("WSL{}：{bin}", if distro.is_empty() { "（預設發行版）".to_string() } else { format!("（{distro}）") });
        return Ok(CliSpec { runtime: "wsl".into(), wsl: true, command: "wsl.exe".into(), distro, bin, label, ..Default::default() });
    }
    Ok(CliSpec { runtime: "windows".into(), ..resolve_cli(cfg["cli"][name].as_str().unwrap_or(""), name)? })
}

fn wsl_base_args(distro: &str) -> Vec<String> {
    if distro.is_empty() { vec![] } else { vec!["-d".into(), distro.into()] }
}

/// toWslPath 測試時注入的執行結果（對應 spawnSync 的 status/stdout/stderr/error）。
#[derive(Default)]
pub struct ExecOutcome {
    pub status: Option<i32>,
    pub stdout: Option<String>,
    pub stderr: String,
    /// (code, message)，例如 ("ETIMEDOUT", "")、("ENOENT", "wsl.exe not found")
    pub error: Option<(String, String)>,
}

fn exec_wslpath(command: &str, args: &[String], timeout: Duration) -> ExecOutcome {
    let mut cmd = Command::new(command);
    cmd.args(args).env_clear().envs(clean_env()).stdin(Stdio::null());
    hide_window(&mut cmd);
    match run_capture(cmd, timeout) {
        Ok((status, stdout, stderr, timed_out)) => {
            if timed_out {
                ExecOutcome { error: Some(("ETIMEDOUT".into(), String::new())), ..Default::default() }
            } else {
                ExecOutcome { status, stdout: Some(stdout), stderr, error: None }
            }
        }
        Err(err) => {
            let code = if err.kind() == std::io::ErrorKind::NotFound { "ENOENT" } else { "" };
            ExecOutcome { error: Some((code.into(), err.to_string())), ..Default::default() }
        }
    }
}

static WSL_PATH_CACHE: LazyLock<Mutex<HashMap<String, String>>> = LazyLock::new(|| Mutex::new(HashMap::new()));

pub fn to_wsl_path(distro: &str, win_path: &str) -> Result<String> {
    let key = format!("{distro}|{win_path}");
    if let Some(hit) = WSL_PATH_CACHE.lock().unwrap().get(&key) {
        return Ok(hit.clone());
    }
    let out = to_wsl_path_with(distro, win_path, &exec_wslpath)?;
    if wsl_location(win_path).is_none() && !win_path.starts_with('/') {
        WSL_PATH_CACHE.lock().unwrap().insert(key, out.clone());
    }
    Ok(out)
}

pub fn to_wsl_path_with(distro: &str, win_path: &str, execute: &dyn Fn(&str, &[String], Duration) -> ExecOutcome) -> Result<String> {
    if let Some(location) = wsl_location(win_path) {
        if !distro.is_empty() && !location.distro.eq_ignore_ascii_case(distro) {
            crate::bail!("不可跨 WSL 發行版存取專案");
        }
        return Ok(location.path);
    }
    if win_path.starts_with('/') {
        return Ok(win_path.to_string());
    }
    // 與桌面 app 的 cwd 無關地啟動；WSL 冷啟動可能要一點時間。
    let mut args = wsl_base_args(distro);
    args.extend(["--cd", "/", "-e", "/usr/bin/wslpath", "-a", win_path].map(String::from));
    let r = execute("wsl.exe", &args, Duration::from_secs(30));
    let stdout = r.stdout.clone().unwrap_or_default();
    let distro_label = if distro.is_empty() { "預設發行版" } else { distro };
    if r.error.is_some() || r.status != Some(0) || stdout.trim().is_empty() {
        let detail = match &r.error {
            Some((code, _)) if code == "ETIMEDOUT" => "WSL 啟動或路徑轉換超過 30 秒，請確認發行版可正常啟動".to_string(),
            Some((code, message)) => format!("{code} {message}"),
            None => {
                let text = if !r.stderr.is_empty() { r.stderr.clone() } else if !stdout.is_empty() { stdout.clone() } else { format!("結束碼 {}，沒有回傳路徑", r.status.map(|s| s.to_string()).unwrap_or("null".into())) };
                text.replace('\0', "").trim().to_string()
            }
        };
        crate::bail!("wslpath 轉換失敗（{distro_label}）：{win_path}；{detail}");
    }
    let out = stdout.trim();
    if !out.starts_with('/') || out.contains(['\r', '\n']) {
        crate::bail!("wslpath 未回傳有效的 Linux 路徑：{win_path}");
    }
    Ok(out.to_string())
}

/// 組出 wsl.exe 的參數。必須用 -e（--exec）：用 -- 時 wsl.exe 會把參數接成字串交給預設 shell，
/// 引號與 $、;、| 會被重新解析。--cd 直接接受 Windows 路徑，只有 UNC Linux 路徑需要先拆解。
pub fn wsl_args(spec: &CliSpec, cwd: Option<&Path>, args: &[String]) -> Result<Vec<String>> {
    let location = cwd.and_then(wsl_location);
    if let Some(loc) = &location {
        if !spec.distro.is_empty() && !loc.distro.eq_ignore_ascii_case(&spec.distro) {
            crate::bail!("不可跨 WSL 發行版存取專案");
        }
    }
    let mut out = wsl_base_args(&spec.distro);
    if let Some(dir) = location.map(|l| l.path).or_else(|| cwd.map(|c| c.to_string_lossy().into_owned())) {
        out.extend(["--cd".to_string(), dir]);
    }
    out.extend(["-e", "bash", "-lc", WSL_SCRUB_SCRIPT, "aipipe"].map(String::from));
    out.push(spec.bin.clone());
    out.extend(args.iter().cloned());
    Ok(out)
}

fn quote_for_cmd(arg: &str) -> String {
    if !arg.is_empty() && arg.chars().all(|c| c.is_ascii_alphanumeric() || "_-.:=\\/@,".contains(c)) {
        arg.to_string()
    } else {
        format!("\"{}\"", arg.replace('"', "\"\""))
    }
}

pub fn hide_window(cmd: &mut Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(windows))]
    let _ = cmd;
}

/// 結束程序與它的子程序（Windows 用 taskkill /T）。
pub fn kill_tree(pid: u32) {
    #[cfg(windows)]
    {
        let mut cmd = Command::new("taskkill");
        cmd.args(["/pid", &pid.to_string(), "/T", "/F"]).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
        hide_window(&mut cmd);
        let _ = cmd.status();
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(-(pid as libc::pid_t), libc::SIGTERM) != 0 {
            libc::kill(pid as libc::pid_t, libc::SIGTERM);
        }
    }
}

#[cfg(windows)]
fn shell_command(line: &str) -> Command {
    use std::os::windows::process::CommandExt;
    let mut cmd = Command::new("cmd.exe");
    cmd.raw_arg(format!("/d /s /c \"{line}\""));
    cmd
}

#[cfg(not(windows))]
fn shell_command(line: &str) -> Command {
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", line]);
    cmd
}

/// 對應 Node 的 spawnCommand：決定要執行的程式與參數。
fn build_command(spec: Option<&CliSpec>, args: &[String], cwd: Option<&Path>, shell_line: Option<&str>) -> Result<Command> {
    let mut cmd = match (shell_line, spec) {
        (Some(line), _) => shell_command(line),
        (None, Some(spec)) if spec.wsl => {
            let mut c = Command::new("wsl.exe");
            c.args(wsl_args(spec, cwd, args)?);
            c
        }
        (None, Some(spec)) if spec.shell => {
            let line: Vec<String> = std::iter::once(&spec.command).chain(&spec.prefix_args).chain(args).map(|a| quote_for_cmd(a)).collect();
            shell_command(&line.join(" "))
        }
        (None, Some(spec)) => {
            let mut c = Command::new(&spec.command);
            c.args(&spec.prefix_args).args(args);
            c
        }
        (None, None) => crate::bail!("沒有要執行的指令"),
    };
    // Linux/UNC 專案目錄是給 WSL --cd 用的，不是 Windows 端程序的 cwd。
    if let Some(dir) = cwd.filter(|_| !spec.is_some_and(|s| s.wsl) || shell_line.is_some()) {
        cmd.current_dir(dir);
    }
    hide_window(&mut cmd);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    Ok(cmd)
}

#[derive(Clone, Debug, Default)]
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
    pub timed_out: bool,
}

#[derive(Default)]
pub struct RunOpts<'a> {
    pub cwd: Option<&'a Path>,
    pub input: Option<&'a str>,
    pub env: Option<Vec<(OsString, OsString)>>,
    pub timeout_sec: u64,
    pub on_stdout: Option<&'a mut dyn FnMut(&str)>,
    pub on_stderr: Option<&'a mut dyn FnMut(&str)>,
}

enum Chunk {
    Out(String),
    Err(String),
    Done,
}

/// 逐塊讀取並解碼 UTF-8（多位元組字元可能被切在兩塊之間）。
fn pump(mut reader: impl Read + Send + 'static, tx: mpsc::Sender<Chunk>, is_err: bool) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        let mut pending: Vec<u8> = Vec::new();
        loop {
            match reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    pending.extend_from_slice(&buf[..n]);
                    let valid = match std::str::from_utf8(&pending) {
                        Ok(_) => pending.len(),
                        Err(e) if e.error_len().is_none() => e.valid_up_to(),
                        Err(_) => pending.len(),
                    };
                    let text = String::from_utf8_lossy(&pending[..valid]).into_owned();
                    pending.drain(..valid);
                    if !text.is_empty() {
                        let _ = tx.send(if is_err { Chunk::Err(text) } else { Chunk::Out(text) });
                    }
                }
            }
        }
        if !pending.is_empty() {
            let text = String::from_utf8_lossy(&pending).into_owned();
            let _ = tx.send(if is_err { Chunk::Err(text) } else { Chunk::Out(text) });
        }
        let _ = tx.send(Chunk::Done);
    })
}

fn spawn_piped(mut cmd: Command, env: Option<Vec<(OsString, OsString)>>) -> std::io::Result<Child> {
    cmd.env_clear().envs(env.unwrap_or_else(clean_env));
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
    cmd.spawn()
}

/// 執行子程序。input 會寫入 stdin（長 prompt 一律走 stdin，避開命令列長度限制）。不因非零結束碼回傳錯誤。
pub fn run_with(spec: Option<&CliSpec>, args: &[String], shell_line: Option<&str>, mut opts: RunOpts) -> Result<RunResult> {
    let cmd = build_command(spec, args, opts.cwd, shell_line)?;
    let mut child = spawn_piped(cmd, opts.env.take()).map_err(|e| AppError::new(format!("無法執行 {}：{e}", spec.map(|s| s.label.as_str()).unwrap_or(shell_line.unwrap_or("")))))?;
    let (tx, rx) = mpsc::channel();
    let readers = [pump(child.stdout.take().unwrap(), tx.clone(), false), pump(child.stderr.take().unwrap(), tx, true)];
    let mut stdin = child.stdin.take().unwrap();
    let input = opts.input.unwrap_or("").to_string();
    std::thread::spawn(move || {
        let _ = stdin.write_all(input.as_bytes());
    });
    let start = Instant::now();
    let mut result = RunResult::default();
    let mut done = 0;
    while done < 2 {
        match rx.recv_timeout(Duration::from_millis(100)) {
            Ok(Chunk::Out(text)) => {
                if let Some(cb) = opts.on_stdout.as_mut() {
                    cb(&text);
                }
                result.stdout.push_str(&text);
            }
            Ok(Chunk::Err(text)) => {
                if let Some(cb) = opts.on_stderr.as_mut() {
                    cb(&text);
                }
                result.stderr.push_str(&text);
            }
            Ok(Chunk::Done) => done += 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
        if opts.timeout_sec > 0 && !result.timed_out && start.elapsed() > Duration::from_secs(opts.timeout_sec) {
            result.timed_out = true;
            kill_tree(child.id());
        }
    }
    for r in readers {
        let _ = r.join();
    }
    let status = child.wait()?;
    result.code = if result.timed_out { -1 } else { status.code().unwrap_or(-1) };
    Ok(result)
}

pub fn run(spec: &CliSpec, args: &[String], opts: RunOpts) -> Result<RunResult> {
    run_with(Some(spec), args, None, opts)
}

/// 用系統 shell 執行驗證指令（build/test/lint）；WSL 專案在對應發行版的 bash 裡執行。
pub fn run_shell(command: &str, opts: RunOpts) -> Result<RunResult> {
    if cfg!(windows) {
        if let Some(location) = opts.cwd.and_then(wsl_location) {
            let spec = CliSpec { wsl: true, distro: location.distro, bin: "bash".into(), ..Default::default() };
            return run_with(Some(&spec), &["-c".into(), command.into()], None, opts);
        }
    }
    run_with(None, &[], Some(command), opts)
}

/// 執行並收集輸出（給 wslpath 這類短指令用）。回傳 (status, stdout, stderr, timed_out)。
pub fn run_capture(mut cmd: Command, timeout: Duration) -> std::io::Result<(Option<i32>, String, String, bool)> {
    cmd.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = cmd.spawn()?;
    let (tx, rx) = mpsc::channel();
    let readers = [pump(child.stdout.take().unwrap(), tx.clone(), false), pump(child.stderr.take().unwrap(), tx, true)];
    let start = Instant::now();
    let (mut out, mut err, mut done, mut timed_out) = (String::new(), String::new(), 0, false);
    while done < 2 {
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Chunk::Out(t)) => out.push_str(&t),
            Ok(Chunk::Err(t)) => err.push_str(&t),
            Ok(Chunk::Done) => done += 1,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(_) => break,
        }
        if !timed_out && start.elapsed() > timeout {
            timed_out = true;
            kill_tree(child.id());
        }
    }
    for r in readers {
        let _ = r.join();
    }
    let status = child.wait()?;
    Ok((status.code(), out, err, timed_out))
}

/// 查詢 Codex 控制面（JSON-RPC over stdio），不建立對話也不跑模型。
pub fn query_codex_rpc(spec: &CliSpec, cwd: &Path, method: &str, timeout_sec: u64) -> Result<Value> {
    query_codex_rpc_with(spec, cwd, method, None, timeout_sec)
}

/// 同 query_codex_rpc，可以帶 params（例如 model/list）。
pub fn query_codex_rpc_with(spec: &CliSpec, cwd: &Path, method: &str, params: Option<Value>, timeout_sec: u64) -> Result<Value> {
    let cmd = build_command(Some(spec), &["app-server".into()], Some(cwd), None)?;
    let mut cmd = cmd;
    cmd.env_clear().envs(clean_env());
    // 不顯示控制面的 stderr，裡面可能有帳號資訊。
    cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| AppError::new(e.to_string()))?;
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let mut total = 0usize;
        for line in BufReader::new(stdout).lines() {
            let Ok(line) = line else { break };
            total += line.len();
            if total > 1_000_000 {
                let _ = tx.send(None);
                return;
            }
            if tx.send(Some(line)).is_err() {
                return;
            }
        }
    });
    let mut send = |message: Value| writeln!(stdin, "{message}").and_then(|_| stdin.flush());
    let finish = |child: &mut Child, out: Result<Value>| {
        kill_tree(child.id());
        let _ = child.wait();
        out
    };
    if send(json!({ "id": 1, "method": "initialize", "params": { "clientInfo": { "name": "aipipe", "version": env!("CARGO_PKG_VERSION") } } })).is_err() {
        return finish(&mut child, Err(AppError::new("CLI 未提供額度查詢結果")));
    }
    let deadline = Instant::now() + Duration::from_secs(timeout_sec);
    loop {
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return finish(&mut child, Err(AppError::new("額度查詢逾時")));
        }
        let line = match rx.recv_timeout(left) {
            Ok(Some(line)) => line,
            Ok(None) => return finish(&mut child, Err(AppError::new("額度查詢回應過大"))),
            Err(mpsc::RecvTimeoutError::Timeout) => return finish(&mut child, Err(AppError::new("額度查詢逾時"))),
            Err(mpsc::RecvTimeoutError::Disconnected) => return finish(&mut child, Err(AppError::new("CLI 未提供額度查詢結果"))),
        };
        let Ok(message) = serde_json::from_str::<Value>(&line) else { continue };
        if message["id"] == 1 {
            if !message["error"].is_null() {
                return finish(&mut child, Err(AppError::new("CLI 不支援額度查詢初始化")));
            }
            let _ = send(json!({ "method": "initialized", "params": {} }));
            let mut request = json!({ "id": 2, "method": method });
            if let Some(p) = &params {
                request["params"] = p.clone();
            }
            let _ = send(request);
        } else if message["id"] == 2 {
            if !message["error"].is_null() {
                return finish(&mut child, Err(AppError::new("無法取得訂閱額度，請確認 CLI 版本與登入狀態")));
            }
            return finish(&mut child, Ok(message["result"].clone()));
        }
    }
}

/// 最後幾行，用 " | " 接成一行（錯誤訊息用）。
pub fn last_lines(text: &str, n: usize) -> String {
    let lines: Vec<&str> = text.trim().lines().collect();
    lines[lines.len().saturating_sub(n)..].join(" | ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clean_env_移除_api_key_與上層_claude_session_變數() {
        let vars = [("ANTHROPIC_API_KEY", "x"), ("OPENAI_API_KEY", "y"), ("CLAUDE_CODE_SIMPLE", "1"), ("CLAUDE_CODE_GIT_BASH_PATH", "keep"), ("PATH", "p")]
            .map(|(k, v)| (OsString::from(k), OsString::from(v)));
        let env: HashMap<String, String> = clean_env_from(vars.into_iter(), &[]).into_iter().map(|(k, v)| (k.to_string_lossy().into(), v.to_string_lossy().into())).collect();
        assert!(!env.contains_key("ANTHROPIC_API_KEY"));
        assert!(!env.contains_key("OPENAI_API_KEY"));
        assert!(!env.contains_key("CLAUDE_CODE_SIMPLE"));
        assert_eq!(env["CLAUDE_CODE_GIT_BASH_PATH"], "keep");
        assert_eq!(env["NO_COLOR"], "1");
    }

    #[test]
    fn 啟動_wsl_的_cwd_直接交給_cd_不呼叫_wslpath() {
        let spec = CliSpec { distro: "Ubuntu".into(), bin: "claude".into(), wsl: true, ..Default::default() };
        let args = wsl_args(&spec, Some(Path::new("C:\\codebase-win\\ai-workflow")), &["--version".into()]).unwrap();
        assert_eq!(&args[..4], ["-d", "Ubuntu", "--cd", "C:\\codebase-win\\ai-workflow"]);
        assert_eq!(args.last().unwrap(), "--version");
        assert_eq!(wsl_args(&spec, Some(Path::new("\\\\wsl.localhost\\Ubuntu\\home\\中文 app")), &[]).unwrap()[3], "/home/中文 app");
        assert!(wsl_args(&spec, Some(Path::new("\\\\wsl$\\Debian\\home\\app")), &[]).unwrap_err().message.contains("跨 WSL"));
    }

    #[test]
    fn 必要的_wslpath_轉換獨立_cwd_支援冷啟動等待並保留空白中文() {
        let input = "C:\\中文 app\\file.md";
        let converted = to_wsl_path_with("Ubuntu", input, &|command, args, timeout| {
            assert_eq!(command, "wsl.exe");
            assert_eq!(args, ["-d", "Ubuntu", "--cd", "/", "-e", "/usr/bin/wslpath", "-a", input]);
            assert_eq!(timeout, Duration::from_secs(30));
            ExecOutcome { status: Some(0), stdout: Some("/mnt/c/中文 app/file.md\n".into()), ..Default::default() }
        }).unwrap();
        assert_eq!(converted, "/mnt/c/中文 app/file.md");
        let root = "\\\\wsl.localhost\\Ubuntu-24.04\\home\\me\\中文 app";
        assert_eq!(to_wsl_path("Ubuntu-24.04", root).unwrap(), "/home/me/中文 app");
        assert!(to_wsl_path("Debian", root).unwrap_err().message.contains("跨 WSL"));
    }

    #[test]
    fn 轉換錯誤包含逾時_找不到_wsl_或發行版錯誤() {
        let cases: Vec<(ExecOutcome, &str)> = vec![
            (ExecOutcome { error: Some(("ETIMEDOUT".into(), String::new())), ..Default::default() }, "30 秒"),
            (ExecOutcome { error: Some(("ENOENT".into(), "wsl.exe not found".into())), ..Default::default() }, "ENOENT"),
            (ExecOutcome { status: Some(1), stdout: Some("Distribution not found".into()), ..Default::default() }, "Distribution not found"),
            (ExecOutcome { status: Some(0), stdout: Some("not a linux path".into()), ..Default::default() }, "有效的 Linux 路徑"),
        ];
        for (outcome, expected) in cases {
            let cell = std::cell::RefCell::new(Some(outcome));
            let err = to_wsl_path_with("Ubuntu", "C:\\app", &|_, _, _| cell.borrow_mut().take().unwrap()).unwrap_err();
            assert!(err.message.contains(expected), "{}", err.message);
        }
    }

    #[test]
    fn run_串流輸出_寫入_stdin_並在逾時時結束程序() {
        // findstr "^" 原樣輸出每一行（不經過 cmd.exe，位元組不會被轉碼）。
        let (prog, args): (&str, Vec<String>) = if cfg!(windows) { ("findstr", vec!["^".into()]) } else { ("cat", vec![]) };
        let spec = CliSpec { command: prog.into(), label: prog.into(), ..Default::default() };
        let mut seen = String::new();
        let mut cb = |t: &str| seen.push_str(t);
        let r = run(&spec, &args, RunOpts { input: Some("中文 stdin\n"), on_stdout: Some(&mut cb), ..Default::default() }).unwrap();
        assert_eq!(r.code, 0);
        assert_eq!(r.stdout.trim_end(), "中文 stdin");
        assert_eq!(seen, r.stdout);
        let slow = if cfg!(windows) { "ping -n 30 127.0.0.1 >NUL" } else { "sleep 30" };
        let start = Instant::now();
        let r = run_shell(slow, RunOpts { timeout_sec: 1, ..Default::default() }).unwrap();
        assert!(r.timed_out);
        assert_eq!(r.code, -1);
        assert!(start.elapsed() < Duration::from_secs(15));
    }
}
