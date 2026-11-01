//! 用量與訂閱額度（對應 legacy/src/usage.js）。存在 .aipipe/usage.json。
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::LazyLock;

use regex::Regex;

use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};

use super::home::{aipipe_home, with_lock};
use super::proc::{query_codex_rpc, resolve_cli_for, run, CliSpec, RunOpts};
use super::runtime::cli_environment;
use super::util::{now_iso, read_json, resolve, write_json};
use super::Result;

pub fn usage_file(root: &Path) -> PathBuf {
    root.join(".aipipe").join("usage.json")
}

fn number(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite() && *n >= 0.0)
}

fn percent(v: &Value) -> Option<f64> {
    number(v).filter(|n| *n <= 100.0)
}

/// 整數值寫成整數（與 JS 的 JSON 輸出一致），其他寫成浮點數。
pub fn num(n: f64) -> Value {
    if n.fract() == 0.0 && n.abs() < 9.0e15 { json!(n as i64) } else { json!(n) }
}

fn opt(n: Option<f64>) -> Value {
    n.map(num).unwrap_or(Value::Null)
}

fn epoch(v: &Value) -> Value {
    match number(v).filter(|n| *n > 0.0).and_then(|n| chrono::DateTime::from_timestamp_millis((n * 1000.0) as i64)) {
        Some(t) => json!(t.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string()),
        None => Value::Null,
    }
}

fn environment_key(provider: &str, runtime: &str, distro: &str) -> String {
    format!("{provider}|{runtime}|{}", if runtime == "wsl" { distro } else { "" })
}

fn session_key(s: &Value) -> String {
    environment_key(s["provider"].as_str().unwrap_or(""), s["runtime"].as_str().unwrap_or(""), s["distro"].as_str().unwrap_or(""))
}

fn read(root: &Path) -> Value {
    read_json(usage_file(root)).filter(Value::is_object).unwrap_or_else(|| json!({ "version": 1, "sessions": {}, "limits": {} }))
}

fn change(root: &Path, f: impl FnOnce(&mut Value)) -> Result<()> {
    let key = hex::encode(Sha256::digest(resolve(root).to_string_lossy().to_lowercase().as_bytes()));
    with_lock(&format!("usage-{key}"), || {
        let mut store = read(root);
        for k in ["sessions", "limits"] {
            if !store[k].is_object() {
                store[k] = json!({});
            }
        }
        f(&mut store);
        write_json(&usage_file(root), &store)
    })
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Tokens {
    pub input: Option<f64>,
    pub output: Option<f64>,
    pub cache_read: Option<f64>,
    pub cache_write: Option<f64>,
    pub total: Option<f64>,
    pub provisional: bool,
}

impl Tokens {
    pub fn to_json(&self) -> Value {
        let mut v = json!({
            "inputTokens": opt(self.input), "outputTokens": opt(self.output), "cacheReadTokens": opt(self.cache_read),
            "cacheWriteTokens": opt(self.cache_write), "totalTokens": opt(self.total),
        });
        if self.provisional {
            v["provisional"] = json!(true);
        }
        v
    }
}

/// Claude 的快取輸入另外計算要加回去；Codex 的 cached_input_tokens 已包含在 input_tokens 裡。
pub fn normalize_tokens(provider: &str, usage: &Value) -> Option<Tokens> {
    if !usage.is_object() || (number(&usage["input_tokens"]).is_none() && number(&usage["output_tokens"]).is_none()) {
        return None;
    }
    let input = number(&usage["input_tokens"]);
    let output = number(&usage["output_tokens"]);
    let claude = provider == "claude";
    let cache_read = number(if claude { &usage["cache_read_input_tokens"] } else { &usage["cached_input_tokens"] });
    let cache_write = if claude { number(&usage["cache_creation_input_tokens"]) } else { Some(0.0) };
    let total_input = input.map(|i| i + if claude { cache_read.unwrap_or(0.0) + cache_write.unwrap_or(0.0) } else { 0.0 });
    let total = match (total_input, output) {
        (Some(a), Some(b)) => Some(a + b),
        _ => None,
    };
    Some(Tokens { input: total_input, output, cache_read, cache_write, total, provisional: false })
}

pub fn normalize_codex_limits(result: &Value) -> Vec<Value> {
    let buckets: Vec<&Value> = if let Some(map) = result["rateLimitsByLimitId"].as_object() {
        map.values().collect()
    } else if result["rateLimits"].is_object() {
        vec![&result["rateLimits"]]
    } else {
        vec![]
    };
    let mut out = Vec::new();
    for bucket in buckets {
        for slot in ["primary", "secondary"] {
            let window = &bucket[slot];
            if !window.is_object() {
                continue;
            }
            let used = percent(&window["usedPercent"]);
            let label = bucket["limitName"].as_str().or(bucket["limitId"].as_str()).filter(|s| !s.is_empty()).unwrap_or("Codex");
            out.push(json!({
                "name": format!("{label} · {}", if slot == "primary" { "主要額度" } else { "次要額度" }),
                "usedPercent": opt(used),
                "remainingPercent": opt(used.map(|u| 100.0 - u)),
                "windowMinutes": opt(number(&window["windowDurationMins"])),
                "resetsAt": epoch(&window["resetsAt"]),
                "source": "codex-app-server",
            }));
        }
    }
    out
}

/// 事件累加器：result 的用量是準的；assistant 訊息的用量只當作暫時值，不另外相加。
pub struct Telemetry {
    provider: String,
    tokens: Option<Tokens>,
    context: Value,
    limits: Vec<Value>,
    last_request: Option<Tokens>,
    last_model: Value,
    messages: Vec<(String, Tokens)>,
}

impl Telemetry {
    pub fn new(provider: &str) -> Self {
        Self { provider: provider.into(), tokens: None, context: Value::Null, limits: vec![], last_request: None, last_model: Value::Null, messages: vec![] }
    }

    fn set_context(&mut self, model: Option<Value>, used: f64, capacity: f64, estimated: bool) {
        let mut c = json!({});
        if let Some(m) = model {
            c["model"] = m;
        }
        c["usedTokens"] = num(used);
        c["capacity"] = num(capacity);
        c["remainingTokens"] = num((capacity - used).max(0.0));
        c["remainingPercent"] = num((100.0 * (1.0 - used / capacity)).max(0.0));
        c["estimated"] = json!(estimated);
        self.context = c;
    }

    pub fn accept(&mut self, event: &Value) -> Value {
        let ty = event["type"].as_str().unwrap_or("");
        if self.provider == "claude" {
            if ty == "assistant" && event["message"]["usage"].is_object() {
                self.last_request = normalize_tokens("claude", &event["message"]["usage"]);
                self.last_model = event["message"]["model"].clone();
                if let (Some(id), Some(req)) = (event["message"]["id"].as_str().filter(|s| !s.is_empty()), self.last_request.clone()) {
                    match self.messages.iter_mut().find(|(k, _)| k == id) {
                        Some(slot) => slot.1 = req,
                        None => self.messages.push((id.to_string(), req)),
                    }
                    let sum = |f: fn(&Tokens) -> Option<f64>| -> Option<f64> {
                        self.messages.iter().map(|(_, t)| f(t)).try_fold(0.0, |acc, v| v.map(|v| acc + v))
                    };
                    self.tokens = Some(Tokens {
                        input: sum(|t| t.input), output: sum(|t| t.output), cache_read: sum(|t| t.cache_read),
                        cache_write: sum(|t| t.cache_write), total: sum(|t| t.total), provisional: true,
                    });
                }
            }
            if ty == "result" {
                if let Some(t) = normalize_tokens("claude", &event["usage"]) {
                    self.tokens = Some(t);
                }
                let models = event["modelUsage"].as_object().cloned().unwrap_or_default();
                let model = self.last_model.as_str().and_then(|m| models.get(m)).cloned()
                    .or_else(|| (models.len() == 1).then(|| models.values().next().cloned()).flatten());
                let capacity = model.as_ref().and_then(|m| number(&m["contextWindow"]));
                if let (Some(used), Some(cap)) = (self.last_request.as_ref().and_then(|r| r.total), capacity.filter(|c| *c > 0.0)) {
                    self.set_context(Some(self.last_model.clone()), used, cap, true);
                }
            }
            if ty == "rate_limit_event" && event["rate_limit_info"].is_object() {
                let info = &event["rate_limit_info"];
                let used = number(&info["utilization"]).filter(|r| *r <= 1.0).map(|r| r * 100.0);
                let name = claude_window_name(info["rateLimitType"].as_str().filter(|s| !s.is_empty()).unwrap_or("Claude 訂閱視窗"));
                let window = json!({
                    "name": name, "usedPercent": opt(used), "remainingPercent": opt(used.map(|u| 100.0 - u)),
                    "resetsAt": epoch(&info["resetsAt"]), "status": info["status"], "source": "claude-cli-event",
                });
                self.limits.retain(|w| w["name"] != name.as_str());
                self.limits.push(window);
            }
        } else {
            if ty == "turn.completed" {
                if let Some(t) = normalize_tokens("codex", &event["usage"]) {
                    self.tokens = Some(t);
                }
            }
            if ty == "event_msg" && event["payload"]["type"] == "token_count" {
                let info = &event["payload"]["info"];
                if let (Some(cap), Some(used)) = (number(&info["model_context_window"]).filter(|c| *c > 0.0), number(&info["last_token_usage"]["total_tokens"])) {
                    self.set_context(None, used, cap, false);
                }
            }
        }
        self.snapshot()
    }

    pub fn snapshot(&self) -> Value {
        json!({ "tokens": self.tokens.as_ref().map(Tokens::to_json), "context": self.context, "limits": self.limits })
    }
}

/// 依 session id 更新（不重複累加）；不同執行環境的帳號額度分開記錄。
pub fn record_telemetry(root: &Path, session: &Value, telemetry: &Value) -> Result<()> {
    change(root, |store| {
        let id = session["id"].as_str().unwrap_or("").to_string();
        store["sessions"][id.as_str()] = json!({
            "id": id, "provider": session["provider"], "runtime": session["runtime"], "distro": session["distro"].as_str().unwrap_or(""),
            "label": session["label"], "status": session["status"], "updatedAt": now_iso(),
            "tokens": telemetry["tokens"], "context": telemetry["context"],
        });
    })?;
    if let Some(windows) = telemetry["limits"].as_array().filter(|l| !l.is_empty()) {
        merge_limits(&session_key(session), windows, Value::Null, false)?;
    }
    Ok(())
}

/// 訂閱額度屬於帳號而不是專案：存在 ~/.aipipe/limits.json，所有專案共用。鍵是 provider|runtime|distro。
fn limits_file() -> PathBuf {
    aipipe_home().join("limits.json")
}

/// 寫入一組額度視窗。replace=true 時整組取代（主動查詢的完整結果）；false 時依名稱合併（執行中 CLI 回報的單一視窗）。
fn merge_limits(key: &str, windows: &[Value], error: Value, replace: bool) -> Result<()> {
    with_lock("limits", || {
        let mut all = read_json(limits_file()).filter(Value::is_object).unwrap_or(json!({}));
        let mut merged: Vec<Value> = if replace { vec![] } else { all[key]["windows"].as_array().cloned().unwrap_or_default() };
        for w in windows {
            merged.retain(|old| old["name"] != w["name"]);
            merged.push(w.clone());
        }
        all[key] = json!({ "windows": merged, "checkedAt": now_iso(), "error": error });
        write_json(&limits_file(), &all)
    })
}

/// Claude 事件的視窗名稱對應到 /usage 的名稱，兩種來源才能合併成同一個視窗。
pub fn claude_window_name(event_name: &str) -> String {
    match event_name {
        "five_hour" => "Current session".into(),
        "seven_day" => "Current week (all models)".into(),
        "seven_day_opus" => "Current week (Opus)".into(),
        "seven_day_sonnet" => "Current week (Sonnet only)".into(),
        other => other.into(),
    }
}

static CLAUDE_USAGE_LINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\s*(.+?):\s*(\d+(?:\.\d+)?)%\s*used(?:\s*·\s*resets\s+(.+?))?\s*$").unwrap());

/// 解析 `claude -p /usage` 的文字：「Current week (all models): 52% used · resets Nov 6, 6pm (Asia/Taipei)」。
/// 重設時間是 CLI 給的文字（含時區），原樣保留在 resetsText。
pub fn parse_claude_usage(text: &str) -> Vec<Value> {
    text.lines().filter_map(|line| {
        let c = CLAUDE_USAGE_LINE.captures(line)?;
        let used: f64 = c[2].parse().ok()?;
        let used = used.min(100.0);
        Some(json!({
            "name": c[1].trim(), "usedPercent": num(used), "remainingPercent": num(100.0 - used), "resetsAt": null,
            "resetsText": c.get(3).map(|m| m.as_str().trim()), "source": "claude-usage-command",
        }))
    }).collect()
}

/// 用 `claude -p /usage` 查 Claude 訂閱額度：這是 CLI 本機處理的指令，不會啟動模型對話、不耗額度。
pub fn query_claude_usage(spec: &CliSpec, cwd: &Path) -> Result<Vec<Value>> {
    let args: Vec<String> = ["-p", "/usage", "--output-format", "json"].map(String::from).to_vec();
    let res = run(spec, &args, RunOpts { cwd: Some(cwd), timeout_sec: 60, ..Default::default() })?;
    let out = res.stdout.trim();
    let parsed: Value = match (out.find('{'), out.rfind('}')) {
        (Some(a), Some(b)) if a < b => serde_json::from_str(&out[a..=b]).unwrap_or(Value::Null),
        _ => Value::Null,
    };
    if res.code != 0 || parsed["is_error"] == true {
        crate::bail!("Claude CLI 查詢失敗");
    }
    Ok(parse_claude_usage(parsed["result"].as_str().unwrap_or("")))
}

fn total_of(s: &Value) -> Option<f64> {
    s["tokens"]["totalTokens"].as_f64()
}

pub fn usage_snapshot(root: &Path, cfg: &Value) -> Value {
    usage_snapshot_at(root, cfg, chrono::Utc::now())
}

pub fn usage_snapshot_at(root: &Path, cfg: &Value, now: chrono::DateTime<chrono::Utc>) -> Value {
    let store = read(root);
    let mut sessions: Vec<Value> = store["sessions"].as_object().map(|m| m.values().cloned().collect()).unwrap_or_default();
    let by_updated = |a: &Value, b: &Value| b["updatedAt"].as_str().cmp(&a["updatedAt"].as_str());
    let known: Vec<&Value> = sessions.iter().filter(|s| total_of(s).is_some()).collect();
    let total = (!known.is_empty()).then(|| known.iter().filter_map(|s| total_of(s)).sum::<f64>());
    let measured_sessions = known.len();
    // 全域的額度優先；舊版存在專案裡的額度只在全域沒有資料時使用。
    let mut limit_map: HashMap<String, Value> = HashMap::new();
    for source in [store["limits"].clone(), read_json(limits_file()).unwrap_or(Value::Null)] {
        for (k, v) in source.as_object().into_iter().flatten() {
            limit_map.insert(k.clone(), v.clone());
        }
    }
    let providers: Vec<Value> = ["claude", "codex"].iter().map(|provider| {
        let env = cli_environment(cfg, provider, root);
        let key = environment_key(provider, &env.runtime, &env.distro);
        let mut own: Vec<&Value> = sessions.iter().filter(|s| session_key(s) == key).collect();
        own.sort_by(|a, b| by_updated(a, b));
        let measured: Vec<&&Value> = own.iter().filter(|s| total_of(s).is_some()).collect();
        let limits = limit_map.get(&key).map(|l| {
            let mut l = l.clone();
            let windows: Vec<Value> = l["windows"].as_array().cloned().unwrap_or_default().into_iter().map(|mut w| {
                let expired = w["resetsAt"].as_str().and_then(|r| chrono::DateTime::parse_from_rfc3339(r).ok()).is_some_and(|t| t <= now);
                w["expired"] = json!(expired);
                w
            }).collect();
            l["windows"] = json!(windows);
            l
        }).unwrap_or(Value::Null);
        let mut row = Map::new();
        row.insert("provider".into(), json!(provider));
        for (k, v) in env.to_json().as_object().unwrap() {
            row.insert(k.clone(), v.clone());
        }
        row.insert("latest".into(), own.first().map(|s| (*s).clone()).unwrap_or(Value::Null));
        row.insert("tokens".into(), if measured.is_empty() { Value::Null } else { num(measured.iter().filter_map(|s| total_of(s)).sum()) });
        row.insert("limits".into(), limits);
        Value::Object(row)
    }).collect();
    let unknown = sessions.len() - measured_sessions;
    sessions.sort_by(by_updated);
    sessions.truncate(20);
    json!({ "totalTokens": total.map(num).unwrap_or(Value::Null), "measuredSessions": measured_sessions, "unknownSessions": unknown, "providers": providers, "recent": sessions })
}

pub fn refresh_usage_limits(root: &Path, cfg: &Value) -> Result<Value> {
    refresh_usage_limits_with(root, cfg, &|spec, cwd, method| query_codex_rpc(spec, cwd, method, 15), &query_claude_usage)
}

/// 同時查詢 Codex（app-server）與 Claude（/usage）的訂閱額度，都不會啟動模型對話。
pub fn refresh_usage_limits_with(
    root: &Path,
    cfg: &Value,
    codex: &(dyn Fn(&CliSpec, &Path, &str) -> Result<Value> + Sync),
    claude: &(dyn Fn(&CliSpec, &Path) -> Result<Vec<Value>> + Sync),
) -> Result<Value> {
    let (codex_result, claude_result) = std::thread::scope(|s| {
        let a = s.spawn(|| resolve_cli_for(cfg, "codex", root).and_then(|spec| codex(&spec, root, "account/rateLimits/read")).map(|r| normalize_codex_limits(&r)));
        let b = s.spawn(|| resolve_cli_for(cfg, "claude", root).and_then(|spec| claude(&spec, root)));
        (a.join().unwrap_or_else(|_| crate::bail!("查詢失敗")), b.join().unwrap_or_else(|_| crate::bail!("查詢失敗")))
    });
    for (provider, result, failed) in [
        ("codex", codex_result, "無法查詢 Codex 額度：請確認 CLI 已安裝、登入且版本支援 app-server"),
        ("claude", claude_result, "無法查詢 Claude 額度：請確認 Claude Code 已安裝並以訂閱登入"),
    ] {
        let env = cli_environment(cfg, provider, root);
        let key = environment_key(provider, &env.runtime, &env.distro);
        match result {
            Ok(windows) if !windows.is_empty() => {
                merge_limits(&key, &windows, Value::Null, true)?;
                if windows.iter().all(|w| w["remainingPercent"].as_f64().is_some_and(|n| n > 0.0)) {
                    super::state::update_state(root, |s| {
                        if s["usage_blocked"]["provider"] == provider { s["usage_blocked"] = Value::Null; }
                    })?;
                }
            }
            Ok(_) => merge_limits(&key, &[], json!("CLI 未提供訂閱額度資料"), false)?,
            Err(_) => merge_limits(&key, &[], json!(failed), false)?,
        }
    }
    Ok(usage_snapshot(root, cfg))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::config::default_config;
    use crate::core::util::temp_dir;

    fn total(t: Option<Tokens>) -> Option<f64> {
        t.and_then(|t| t.total)
    }

    #[test]
    fn claude_快取輸入分開加總_codex_快取是輸入子集() {
        assert_eq!(total(normalize_tokens("claude", &json!({ "input_tokens": 10, "cache_read_input_tokens": 20, "cache_creation_input_tokens": 30, "output_tokens": 5 }))), Some(65.0));
        assert_eq!(total(normalize_tokens("codex", &json!({ "input_tokens": 100, "cached_input_tokens": 80, "output_tokens": 5 }))), Some(105.0));
        assert_eq!(normalize_tokens("codex", &json!({})), None);
    }

    #[test]
    fn claude_重複_assistant_事件去重_result_取代暫時計數() {
        let mut t = Telemetry::new("claude");
        let event = json!({ "type": "assistant", "message": { "id": "m1", "model": "test-model", "usage": { "input_tokens": 100, "output_tokens": 10, "cache_read_input_tokens": 50 } } });
        t.accept(&event);
        t.accept(&event);
        assert_eq!(t.snapshot()["tokens"]["totalTokens"], 160);
        let mut e2 = event.clone();
        e2["message"]["id"] = json!("m2");
        t.accept(&e2);
        assert_eq!(t.snapshot()["tokens"]["totalTokens"], 320);
        let f = t.accept(&json!({ "type": "result", "usage": { "input_tokens": 200, "output_tokens": 20, "cache_read_input_tokens": 100 }, "modelUsage": { "test-model": { "contextWindow": 1000 } } }));
        assert_eq!(f["tokens"]["totalTokens"], 320);
        assert_eq!(f["context"]["remainingTokens"], 840);
        assert_eq!(f["context"]["remainingPercent"], 84);
        assert_eq!(f["context"]["estimated"], true);
    }

    #[test]
    fn codex_以_turn_completed_記錄_tokens() {
        let mut t = Telemetry::new("codex");
        t.accept(&json!({ "type": "turn.completed", "usage": { "input_tokens": 9000, "cached_input_tokens": 8000, "output_tokens": 100 } }));
        assert_eq!(t.snapshot()["tokens"]["totalTokens"], 9100);
        assert!(t.snapshot()["context"].is_null());
        t.accept(&json!({ "type": "event_msg", "payload": { "type": "token_count", "info": { "model_context_window": 1000, "last_token_usage": { "total_tokens": 100 } } } }));
        assert_eq!(t.snapshot()["context"]["remainingPercent"], 90);
    }

    #[test]
    fn 未回報與明確零用量不同_限額但沒比例時不顯示_0() {
        assert_eq!(normalize_tokens("claude", &Value::Null), None);
        assert_eq!(total(normalize_tokens("codex", &json!({ "input_tokens": 0, "output_tokens": 0 }))), Some(0.0));
        let mut t = Telemetry::new("claude");
        let first = t.accept(&json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "rejected" } }));
        assert!(first["limits"][0]["remainingPercent"].is_null());
        let second = t.accept(&json!({ "type": "rate_limit_event", "rate_limit_info": { "status": "allowed_warning", "utilization": 0.8, "resetsAt": 2000000000 } }));
        assert_eq!(second["limits"][0]["remainingPercent"].as_f64().map(|v| v.round()), Some(20.0));
    }

    #[test]
    fn codex_多視窗各自顯示_缺少或無效百分比保留未知() {
        let windows = normalize_codex_limits(&json!({ "rateLimitsByLimitId": { "codex": { "primary": { "usedPercent": 25 }, "secondary": { "usedPercent": 99 } }, "other": { "primary": { "usedPercent": 120 } } } }));
        let remaining: Vec<Value> = windows.iter().map(|w| w["remainingPercent"].clone()).collect();
        assert_eq!(remaining, vec![json!(75), json!(1), Value::Null]);
    }

    #[test]
    fn 專案用量按_session_id_更新_跨環境帳號額度分開() {
        std::env::set_var("AIPIPE_HOME", temp_dir("aipipe-usage-home-"));
        let root = temp_dir("aipipe-usage-");
        let mut cfg = default_config();
        cfg["runtime"] = json!({ "claude": "windows", "codex": "windows" });
        cfg["cli"]["codex"] = json!(std::env::current_exe().unwrap().to_string_lossy());
        let tokens = normalize_tokens("codex", &json!({ "input_tokens": 100, "output_tokens": 10 })).unwrap().to_json();
        let session = json!({ "id": "a", "provider": "codex", "runtime": "windows", "label": "first", "status": "running" });
        record_telemetry(&root, &session, &json!({ "tokens": tokens, "context": null, "limits": [] })).unwrap();
        let mut done = session.clone();
        done["status"] = json!("done");
        record_telemetry(&root, &done, &json!({ "tokens": tokens, "context": null, "limits": [] })).unwrap();
        record_telemetry(&root, &json!({ "id": "b", "provider": "codex", "runtime": "wsl", "distro": "Ubuntu", "label": "x", "status": "running" }), &json!({ "tokens": null, "context": null, "limits": [{ "remainingPercent": 50 }] })).unwrap();
        let snap = usage_snapshot(&root, &cfg);
        assert_eq!(snap["totalTokens"], 110);
        assert_eq!(snap["measuredSessions"], 1);
        assert_eq!(snap["unknownSessions"], 1);
        let codex = |s: &Value| s["providers"].as_array().unwrap().iter().find(|r| r["provider"] == "codex").unwrap().clone();
        assert!(codex(&snap)["limits"].is_null());
        cfg["cli"]["claude"] = cfg["cli"]["codex"].clone();
        let result = refresh_usage_limits_with(&root, &cfg, &|_, _, method| {
            assert_eq!(method, "account/rateLimits/read");
            Ok(json!({ "rateLimits": { "primary": { "usedPercent": 30, "windowDurationMins": 300, "resetsAt": 1000000000 } } }))
        }, &|_, _| Ok(parse_claude_usage("Current week (all models): 52% used · resets Nov 6, 6pm (Asia/Taipei)"))).unwrap();
        let limits = codex(&result)["limits"].clone();
        assert_eq!(limits["windows"][0]["remainingPercent"], 70);
        assert_eq!(limits["windows"][0]["expired"], true);
        // 額度存在全域，另一個專案也看得到；CLI 執行中回報的同名視窗會合併而不是整組覆蓋。
        let other = temp_dir("aipipe-usage-other-");
        let claude = |s: &Value| s["providers"].as_array().unwrap().iter().find(|r| r["provider"] == "claude").unwrap().clone();
        assert_eq!(claude(&usage_snapshot(&other, &cfg))["limits"]["windows"][0]["remainingPercent"], 48);
        let mut t = Telemetry::new("claude");
        let event = t.accept(&json!({ "type": "rate_limit_event", "rate_limit_info": { "rateLimitType": "five_hour", "utilization": 0.5, "status": "allowed" } }));
        record_telemetry(&other, &json!({ "id": "c", "provider": "claude", "runtime": "windows", "label": "x", "status": "done" }), &event).unwrap();
        let names: Vec<Value> = claude(&usage_snapshot(&root, &cfg))["limits"]["windows"].as_array().unwrap().iter().map(|w| w["name"].clone()).collect();
        assert_eq!(names, vec![json!("Current week (all models)"), json!("Current session")]);
    }

    #[test]
    fn 解析_claude_usage_輸出() {
        let text = "You are currently using your subscription to power your Claude Code usage\n\nCurrent session: 68% used · resets Nov 2, 2:20am (Asia/Taipei)\nCurrent week (all models): 52% used · resets Nov 6, 6pm (Asia/Taipei)";
        let w = parse_claude_usage(text);
        assert_eq!(w.len(), 2);
        assert_eq!(w[0]["name"], "Current session");
        assert_eq!(w[0]["remainingPercent"], 32);
        assert_eq!(w[1]["resetsText"], "Nov 6, 6pm (Asia/Taipei)");
        assert!(parse_claude_usage("no usage here").is_empty());
    }
}
