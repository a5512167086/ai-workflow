//! 以官方 CLI 跑一次全新對話（對應 legacy/src/agents.js）。不 resume，prompt 由 stdin 傳入；
//! write=false 的角色（PRD 審查、程式碼審查）以唯讀方式執行。
use std::fs;
use std::path::Path;
use std::sync::LazyLock;
use std::time::Instant;

use regex::Regex;
use serde_json::{json, Value};

use super::agent_errors::{explain_usage_limit, usage_limit, UsageLimit};
use super::capabilities::{other_provider, probe_provider, select_provider};
use super::proc::{last_lines, resolve_cli_for, run, RunOpts};
use super::runtime::cli_environment;
use super::skills::prepare_skills;
use super::state::{aipipe_dir, append_log};
use super::usage::{record_telemetry, Telemetry};
use super::util::{now_iso, write_json};
use super::Result;

pub struct AgentOpts<'a> {
    pub root: &'a Path,
    pub cfg: &'a Value,
    pub provider: &'a str,
    pub prompt: String,
    pub write: bool,
    pub scope: &'a str,
    pub label: &'a str,
    pub stage: Option<&'a str>,
    /// 明確指定的 Skills；None 時用 cfg.skills[stage]。
    pub skills: Option<Vec<String>>,
}

#[derive(Clone, Debug, Default)]
pub struct AgentResult {
    pub ok: bool,
    pub text: String,
    pub error: Option<String>,
    pub provider: String,
    pub session_id: String,
    pub skills: Vec<Value>,
    /// { tokens, context, limits }
    pub telemetry: Value,
    pub fallback_from: Option<String>,
    pub failure: Option<UsageLimit>,
}

impl AgentResult {
    pub fn error_text(&self) -> String {
        self.error.clone().unwrap_or_default()
    }
}

pub fn run_agent(opts: AgentOpts) -> Result<AgentResult> {
    let AgentOpts { root, cfg, provider: preferred, write, scope, .. } = opts;
    let selected = select_provider(root, cfg, preferred)?;
    let provider = selected.provider;
    if provider != preferred {
        append_log(root, scope, &format!("單 AI 模式：{preferred} 不可用（{}），改用 {provider}，建立全新 session", selected.checks[0]["error"].as_str().unwrap_or("")));
    }
    let result = run_agent_session(&opts, &provider)?;
    let Some(limit) = (!result.ok).then(|| usage_limit(&result.error_text())).flatten() else { return Ok(result) };
    let message = explain_usage_limit(&provider, &limit);
    let stop = |result: AgentResult, error: String| Ok(AgentResult { error: Some(error), failure: Some(limit.clone()), ..result });
    if write {
        return stop(result, format!("{message}。工作可能已修改檔案，已停止；確認變更後再重試"));
    }
    let other = other_provider(&provider);
    let (target, alternate) = (cli_environment(cfg, &provider, root), cli_environment(cfg, other, root));
    if target.runtime != alternate.runtime || target.distro != alternate.distro {
        return stop(result, format!("{message}。另一個 AI 設定在不同執行環境，請在設定中調整後再重試"));
    }
    let check = probe_provider(root, cfg, other);
    if check["available"] != true {
        return stop(result, format!("{message}。同環境的 {other} 不可用：{}。請等待額度重設，或安裝並登入另一個 AI", check["error"].as_str().unwrap_or("")));
    }
    append_log(root, scope, &format!("{message}；本次唯讀工作改用 {other}，建立全新 session"));
    // 直接呼叫 session：最多切換一次，用原始 prompt 與新的 Skill 快照。
    let fallback = run_agent_session(&opts, other)?;
    let mut out = AgentResult { fallback_from: Some(provider.clone()), ..fallback };
    if !out.ok {
        let second = usage_limit(&out.error_text());
        let detail = second.as_ref().map(|l| explain_usage_limit(other, l)).unwrap_or_else(|| out.error_text());
        out.error = Some(format!("{message}；{other} 也未完成：{detail}"));
        out.failure = Some(second.unwrap_or(limit));
    }
    Ok(out)
}

struct CliOutcome {
    ok: bool,
    text: String,
    error: Option<String>,
}

fn run_agent_session(opts: &AgentOpts, provider: &str) -> Result<AgentResult> {
    let (root, cfg, scope, label) = (opts.root, opts.cfg, opts.scope, opts.label);
    let spec = resolve_cli_for(cfg, provider, root)?;
    let to_path = |p: &Path| spec.to_path(p).unwrap_or_else(|_| p.to_string_lossy().into_owned());
    let prepared = prepare_skills(root, cfg, opts.stage, opts.skills.as_deref(), &to_path)?;
    let prompt = [opts.prompt.as_str(), prepared.text.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join("\n\n");
    let session_id = uuid::Uuid::new_v4().to_string();
    let session_file = aipipe_dir(root).join("sessions").join(format!("{session_id}.json"));
    let session = json!({
        "id": session_id, "provider": provider, "runtime": spec.runtime, "distro": cli_environment(cfg, provider, root).distro,
        "stage": opts.stage.unwrap_or("skill"), "label": label, "skills": prepared.snapshots, "started_at": now_iso(), "status": "running",
    });
    write_json(&session_file, &session)?;
    let mut telemetry = Telemetry::new(provider);
    let mut previous = String::new();
    let mut on_event = |event: &Value| {
        let value = telemetry.accept(event);
        let signature = value.to_string();
        if signature != previous {
            previous = signature;
            let _ = record_telemetry(root, &session, &value);
        }
    };
    on_event(&json!({}));
    append_log(root, scope, &format!("── {label}：{provider}（{}）開始，session {session_id} ──", if opts.write { "可編輯" } else { "唯讀" }));
    let prompt_file = aipipe_dir(root).join("tmp").join(format!("{session_id}.prompt.md"));
    fs::create_dir_all(prompt_file.parent().unwrap())?;
    fs::write(&prompt_file, &prompt)?;
    let started = Instant::now();
    let outcome = if provider == "codex" {
        run_codex(root, cfg, &prompt, opts.write, scope, &mut on_event)
    } else {
        run_claude(root, cfg, &prompt, opts.write, scope, &mut on_event)
    };
    let snapshot = telemetry.snapshot();
    let with_status = |status: &str, extra: Value| {
        let mut s = session.clone();
        s["status"] = json!(status);
        for (k, v) in extra.as_object().unwrap() {
            s[k] = v.clone();
        }
        s
    };
    let outcome = match outcome {
        Ok(o) => o,
        Err(err) => {
            write_json(&session_file, &with_status("error", json!({ "error": err.message, "finished_at": now_iso() })))?;
            let _ = record_telemetry(root, &with_status("error", json!({})), &snapshot);
            return Err(err);
        }
    };
    let status = if outcome.ok { "done" } else { "error" };
    let mut finished = with_status(status, json!({ "error": outcome.error, "finished_at": now_iso() }));
    for (k, v) in snapshot.as_object().unwrap() {
        finished[k] = v.clone();
    }
    write_json(&session_file, &finished)?;
    let _ = record_telemetry(root, &with_status(status, json!({})), &snapshot);
    let secs = started.elapsed().as_secs_f64().round();
    append_log(root, scope, &format!("── {label}：{}（{secs}s）{} ──", if outcome.ok { "完成" } else { "失敗" }, outcome.error.as_ref().map(|e| format!(" {e}")).unwrap_or_default()));
    Ok(AgentResult {
        ok: outcome.ok, text: outcome.text, error: outcome.error, provider: provider.into(), session_id, skills: prepared.snapshots,
        telemetry: snapshot, ..Default::default()
    })
}

/// 把串流 stdout 切成行（行可能跨 chunk）。
struct LineBuffer(String);

impl LineBuffer {
    fn push(&mut self, data: &str, mut f: impl FnMut(&str)) {
        self.0.push_str(data);
        while let Some(i) = self.0.find('\n') {
            let line: String = self.0.drain(..=i).collect();
            f(line.trim_end_matches(['\n', '\r']));
        }
    }
    fn finish(&mut self, mut f: impl FnMut(&str)) {
        let rest = std::mem::take(&mut self.0);
        f(&rest);
    }
}

fn summarize_tool_input(input: &Value) -> String {
    let v = ["file_path", "path", "command", "pattern"].iter().find_map(|k| input[k].as_str()).unwrap_or("");
    v.chars().take(160).collect()
}

fn run_claude(root: &Path, cfg: &Value, prompt: &str, write: bool, scope: &str, on_event: &mut dyn FnMut(&Value)) -> Result<CliOutcome> {
    let spec = resolve_cli_for(cfg, "claude", root)?;
    // -p + stream-json 需要 --verbose 才會輸出逐步事件。
    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"].map(String::from).to_vec();
    if write {
        args.extend(["--permission-mode", "acceptEdits"].map(String::from));
        let tools: Vec<&str> = cfg["claude"]["allowed_tools"].as_array().into_iter().flatten().filter_map(Value::as_str).collect();
        if !tools.is_empty() {
            args.extend(["--allowedTools".into(), tools.join(",")]);
        }
    } else {
        // dontAsk：沒有預先允許的工具一律拒絕；再明確禁止編輯類工具。
        args.extend(["--permission-mode", "dontAsk", "--disallowedTools", "Edit,Write,NotebookEdit"].map(String::from));
    }
    if let Some(model) = cfg["claude"]["model"].as_str().filter(|m| !m.is_empty()) {
        args.extend(["--model".into(), model.into()]);
    }
    let (mut final_text, mut is_error, mut error_text) = (String::new(), false, String::new());
    let mut handle = |line: &str| {
        if line.trim().is_empty() {
            return;
        }
        let Ok(ev) = serde_json::from_str::<Value>(line) else {
            append_log(root, scope, line);
            return;
        };
        on_event(&ev);
        match ev["type"].as_str() {
            Some("assistant") => {
                for part in ev["message"]["content"].as_array().into_iter().flatten() {
                    if part["type"] == "text" && part["text"].as_str().is_some_and(|t| !t.trim().is_empty()) {
                        append_log(root, scope, part["text"].as_str().unwrap().trim());
                    }
                    if part["type"] == "tool_use" {
                        append_log(root, scope, &format!("🔧 {} {}", part["name"].as_str().unwrap_or(""), summarize_tool_input(&part["input"])));
                    }
                }
            }
            Some("result") => {
                final_text = ev["result"].as_str().unwrap_or("").to_string();
                is_error = super::util::truthy(ev.get("is_error"));
                if is_error {
                    error_text = final_text.clone();
                }
                if let Some(denials) = ev["permission_denials"].as_array().filter(|d| !d.is_empty()) {
                    let names: Vec<&str> = denials.iter().map(|d| d["tool_name"].as_str().unwrap_or("")).collect();
                    append_log(root, scope, &format!("⚠ 被拒絕的工具呼叫：{}", names.join(", ")));
                }
            }
            _ => {}
        }
    };
    let mut buffer = LineBuffer(String::new());
    let timeout = cfg["agent_timeout_sec"].as_u64().unwrap_or(1800);
    let res = {
        let mut on_out = |d: &str| buffer.push(d, &mut handle);
        let mut on_err = |d: &str| append_log(root, scope, d.trim_end());
        run(&spec, &args, RunOpts { cwd: Some(root), input: Some(prompt), timeout_sec: timeout, on_stdout: Some(&mut on_out), on_stderr: Some(&mut on_err), ..Default::default() })?
    };
    buffer.finish(&mut handle);
    if res.timed_out {
        return Ok(CliOutcome { ok: false, text: final_text, error: Some(format!("逾時（{timeout}s）")) });
    }
    if is_error || res.code != 0 {
        let error = if !error_text.is_empty() {
            error_text
        } else if !final_text.is_empty() {
            final_text.clone()
        } else {
            format!("claude 結束碼 {}：{}", res.code, last_lines(if res.stderr.is_empty() { &res.stdout } else { &res.stderr }, 8))
        };
        return Ok(CliOutcome { ok: false, text: final_text, error: Some(error) });
    }
    Ok(CliOutcome { ok: true, text: final_text, error: None })
}

static READ_ONLY: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?m)^sandbox:\s*read-only").unwrap());

fn run_codex(root: &Path, cfg: &Value, prompt: &str, write: bool, scope: &str, on_event: &mut dyn FnMut(&Value)) -> Result<CliOutcome> {
    let spec = resolve_cli_for(cfg, "codex", root)?;
    let tmp = aipipe_dir(root).join("tmp");
    fs::create_dir_all(&tmp)?;
    let out_file = tmp.join(format!("{}.codex-last.md", uuid::Uuid::new_v4()));
    let mut args: Vec<String> = vec![
        "exec".into(), "--json".into(), "--sandbox".into(), if write { "workspace-write" } else { "read-only" }.into(),
        "-C".into(), spec.to_path(root)?, "--color".into(), "never".into(), "-o".into(), spec.to_path(&out_file)?,
    ];
    if let Some(model) = cfg["codex"]["model"].as_str().filter(|m| !m.is_empty()) {
        args.extend(["-m".into(), model.into()]);
    }
    // 唯讀角色也帶上，否則 Windows 上 Codex 連讀檔用的 shell 指令都無法啟動。
    if let Some(sandbox) = cfg["codex"]["windows_sandbox"].as_str().filter(|s| !s.is_empty() && spec.runtime == "windows") {
        args.extend(["-c".into(), format!("windows.sandbox=\"{sandbox}\"")]);
    }
    args.push("-".into()); // 從 stdin 讀 prompt
    let mut last_message = String::new();
    let mut handle = |line: &str| {
        if line.trim().is_empty() {
            return;
        }
        let Ok(event) = serde_json::from_str::<Value>(line) else {
            append_log(root, scope, line);
            return;
        };
        on_event(&event);
        let item = &event["item"];
        if event["type"] == "item.completed" && item["type"] == "agent_message" {
            last_message = item["text"].as_str().unwrap_or("").to_string();
            append_log(root, scope, &last_message);
        } else if event["type"] == "item.completed" && item["type"] == "command_execution" {
            append_log(root, scope, &format!("$ {}\n{}", item["command"].as_str().unwrap_or(""), item["aggregated_output"].as_str().unwrap_or("")));
        } else if event["type"] == "error" || event["type"] == "turn.failed" {
            let msg = event["message"].as_str().or(event["error"]["message"].as_str()).unwrap_or(line);
            append_log(root, scope, msg);
        }
    };
    let mut buffer = LineBuffer(String::new());
    let timeout = cfg["agent_timeout_sec"].as_u64().unwrap_or(1800);
    let res = {
        let mut on_out = |d: &str| buffer.push(d, &mut handle);
        let mut on_err = |d: &str| append_log(root, scope, d.trim_end());
        run(&spec, &args, RunOpts { cwd: Some(root), input: Some(prompt), timeout_sec: timeout, on_stdout: Some(&mut on_out), on_stderr: Some(&mut on_err), ..Default::default() })?
    };
    buffer.finish(&mut handle);
    let text = fs::read_to_string(&out_file).unwrap_or_else(|_| if last_message.is_empty() { res.stdout.clone() } else { last_message.clone() });
    if res.timed_out {
        return Ok(CliOutcome { ok: false, text, error: Some(format!("逾時（{timeout}s）")) });
    }
    if res.code != 0 {
        let error = format!("codex 結束碼 {}：{}", res.code, last_lines(&format!("{}\n{text}", res.stderr), 8));
        return Ok(CliOutcome { ok: false, text, error: Some(error) });
    }
    if write && READ_ONLY.is_match(&format!("{}{}", res.stderr, res.stdout)) {
        return Ok(CliOutcome {
            ok: false,
            text,
            error: Some("Codex 把 workspace-write 降成了 read-only，無法修改檔案。Windows 請在 .aipipe.json 設定 codex.windows_sandbox（elevated 或 unelevated）".into()),
        });
    }
    Ok(CliOutcome { ok: true, text, error: None })
}

static VERDICT: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)VERDICT\s*\**\s*[:：]\s*\**\s*([A-Z_]+)").unwrap());

/// 從審查回覆找出最後一個 VERDICT 行；找不到時保守視為不通過。
pub fn parse_verdict(text: &str, pass_words: &[&str]) -> (bool, String) {
    match VERDICT.captures_iter(text).last() {
        None => (false, "UNKNOWN".into()),
        Some(c) => {
            let verdict = c[1].to_uppercase();
            (pass_words.contains(&verdict.as_str()), verdict)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_verdict_取最後一個_找不到視為不通過() {
        assert_eq!(parse_verdict("範例 VERDICT: PASS\n...\nVERDICT: FAIL", &["PASS"]), (false, "FAIL".into()));
        assert_eq!(parse_verdict("**VERDICT:** APPROVE", &["APPROVE"]), (true, "APPROVE".into()));
        assert!(!parse_verdict("沒有結論", &["PASS"]).0);
    }
}
