//! 偵測 CLI 是否安裝並以訂閱登入（對應 legacy/src/capabilities.js）。
use std::path::Path;

use serde_json::{json, Value};

use super::proc::{resolve_cli_for, run, CliSpec, RunOpts, RunResult};
use super::Result;

pub type Resolve<'a> = &'a dyn Fn(&Value, &str, &Path) -> Result<CliSpec>;
pub type Execute<'a> = &'a dyn Fn(&CliSpec, &[String], &Path, u64) -> Result<RunResult>;

fn real_execute(spec: &CliSpec, args: &[String], cwd: &Path, timeout_sec: u64) -> Result<RunResult> {
    run(spec, args, RunOpts { cwd: Some(cwd), timeout_sec, ..Default::default() })
}

pub fn probe_provider(root: &Path, cfg: &Value, provider: &str) -> Value {
    probe_provider_with(root, cfg, provider, &resolve_cli_for, &real_execute)
}

pub fn probe_provider_with(root: &Path, cfg: &Value, provider: &str, resolve: Resolve, execute: Execute) -> Value {
    let mut result = json!({ "provider": provider, "installed": false, "authenticated": false, "available": false });
    let outcome = (|| -> std::result::Result<(), String> {
        let spec = resolve(cfg, provider, root).map_err(|e| e.message)?;
        result["runtime"] = json!(spec.runtime);
        result["label"] = json!(spec.label);
        let wsl = spec.runtime == "wsl";
        let timeout = if wsl { 30 } else { 15 };
        let version = execute(&spec, &["--version".into()], root, timeout).map_err(|_| "CLI 無法啟動或尚未安裝".to_string())?;
        if version.code != 0 {
            return Err(if version.timed_out { format!("{}CLI 版本檢查逾時（{timeout} 秒）", if wsl { "WSL 啟動或 " } else { "" }) } else { "CLI 無法啟動或尚未安裝".into() });
        }
        result["installed"] = json!(true);
        result["version"] = json!(version.stdout.trim().lines().last().unwrap_or(""));
        let args: Vec<String> = if provider == "claude" { vec!["auth".into(), "status".into()] } else { vec!["login".into(), "status".into()] };
        let auth = execute(&spec, &args, root, timeout).map_err(|_| "尚未登入或登入檢查失敗".to_string())?;
        if auth.code != 0 {
            return Err(if auth.timed_out { "登入檢查逾時".into() } else { "尚未登入或登入檢查失敗".into() });
        }
        if provider == "claude" {
            let out = auth.stdout.trim();
            let status: Value = match (out.find('{'), out.rfind('}')) {
                (Some(a), Some(b)) if a < b => serde_json::from_str(&out[a..=b]).map_err(|e| format!("無法解析登入狀態：{e}"))?,
                _ => return Err("無法解析登入狀態".into()),
            };
            if status["loggedIn"] != true || status["authMethod"] != "claude.ai" {
                return Err("請使用 claude.ai 訂閱登入".into());
            }
        } else if !format!("{}{}", auth.stdout, auth.stderr).to_lowercase().contains("logged in using chatgpt") {
            return Err("未確認 ChatGPT 訂閱登入，請執行 codex login".into());
        }
        Ok(())
    })();
    match outcome {
        Ok(()) => {
            result["authenticated"] = json!(true);
            result["available"] = json!(true);
        }
        Err(message) => result["error"] = json!(message),
    }
    result
}

pub fn other_provider(provider: &str) -> &'static str {
    if provider == "claude" { "codex" } else { "claude" }
}

pub struct Selected {
    pub provider: String,
    pub checks: Vec<Value>,
}

/// 只在執行前選擇：首選不可用時改用另一個；從不重做失敗的寫入工作。
pub fn select_provider_with(root: &Path, cfg: &Value, preferred: &str, probe: &dyn Fn(&Path, &Value, &str) -> Value) -> Result<Selected> {
    let first = probe(root, cfg, preferred);
    if first["available"] == true {
        return Ok(Selected { provider: preferred.into(), checks: vec![first] });
    }
    let other = other_provider(preferred);
    let second = probe(root, cfg, other);
    if second["available"] == true {
        return Ok(Selected { provider: other.into(), checks: vec![first, second] });
    }
    crate::bail!("沒有可用的 AI CLI：{preferred}：{}；{other}：{}。請執行 aipipe doctor", first["error"].as_str().unwrap_or(""), second["error"].as_str().unwrap_or(""));
}

pub fn select_provider(root: &Path, cfg: &Value, preferred: &str) -> Result<Selected> {
    select_provider_with(root, cfg, preferred, &probe_provider)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cli_探測區分未安裝_未登入_訂閱登入與_api_登入() {
        let resolve = |_: &Value, _: &str, _: &Path| Ok(CliSpec { runtime: "windows".into(), label: "fake".into(), ..Default::default() });
        for provider in ["claude", "codex"] {
            let probe = |auth: &str, version_code: i32| {
                let auth = auth.to_string();
                probe_provider_with(Path::new("."), &json!({}), provider, &resolve, &move |_, args, _, _| Ok(if args[0] == "--version" {
                    RunResult { code: version_code, stdout: "1.0".into(), ..Default::default() }
                } else {
                    RunResult { code: 0, stdout: auth.clone(), ..Default::default() }
                }))
            };
            assert_eq!(probe("", 1)["installed"], false);
            assert_eq!(probe("", 0)["available"], false);
            let ok = if provider == "claude" { r#"{"loggedIn":true,"authMethod":"claude.ai"}"# } else { "Logged in using ChatGPT" };
            assert_eq!(probe(ok, 0)["available"], true);
            let api = if provider == "claude" { r#"{"loggedIn":true,"authMethod":"api_key"}"# } else { "Logged in using an API key" };
            let result = probe(api, 0);
            assert_eq!(result["installed"], true);
            assert_eq!(result["available"], false);
        }
    }

    #[test]
    fn 缺任一_ai_時選另一個_兩個都缺時顯示診斷() {
        for preferred in ["claude", "codex"] {
            let other = other_provider(preferred);
            let single = |_: &Path, _: &Value, p: &str| json!({ "available": p == other, "error": "未安裝" });
            assert_eq!(select_provider_with(Path::new("."), &json!({}), preferred, &single).unwrap().provider, other);
            let both = |_: &Path, _: &Value, _: &str| json!({ "available": true });
            assert_eq!(select_provider_with(Path::new("."), &json!({}), preferred, &both).unwrap().provider, preferred);
        }
        let none = |_: &Path, _: &Value, _: &str| json!({ "available": false, "error": "未登入" });
        let err = select_provider_with(Path::new("."), &json!({}), "claude", &none).err().unwrap();
        assert!(err.message.contains("沒有可用") && err.message.contains("doctor"));
    }
}
