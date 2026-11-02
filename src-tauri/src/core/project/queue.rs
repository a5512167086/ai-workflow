//! 全域執行佇列：所有專案的 `ai-workflow run` 共用，同時最多 max_concurrent_runs 個在跑（預設 1），
//! 避免多個專案同時燒同一份 Claude／Codex 訂閱額度。佇列存在 <home>/queue.json，由各個 run 程序自己排隊與釋放；
//! 上限存在全域設定 <home>/config.json。
use std::path::{Path, PathBuf};
use std::time::Duration;

use serde_json::{json, Value};

use crate::core::config::{load_global, patch_global};
use crate::core::home::{app_home, with_lock};
use crate::core::state::{is_pid_alive_value, pid_of};
use crate::core::util::{now_iso, read_json, resolve, write_json};
use crate::core::Result;

fn queue_file() -> PathBuf {
    app_home().join("queue.json")
}

fn max_concurrent() -> usize {
    load_global().ok().and_then(|c| c["max_concurrent_runs"].as_u64()).filter(|n| *n >= 1).unwrap_or(1) as usize
}

pub fn set_max_concurrent(n: &Value) -> Result<Value> {
    let v = n.as_i64().or_else(|| n.as_str().and_then(|s| s.trim().parse().ok())).filter(|v| (1..=8).contains(v));
    let Some(v) = v else { crate::bail!("同時執行上限必須是 1–8 的整數") };
    patch_global(&json!({ "max_concurrent_runs": v }))
}

fn same_path(a: &str, b: &Path) -> bool {
    resolve(a).to_string_lossy().to_lowercase() == resolve(b).to_string_lossy().to_lowercase()
}

struct Queue {
    running: Vec<Value>,
    waiting: Vec<Value>,
}

fn load() -> Queue {
    let q = read_json(queue_file()).unwrap_or(json!({}));
    let alive = |list: &Value| list.as_array().into_iter().flatten().filter(|e| is_pid_alive_value(&e["pid"])).cloned().collect();
    Queue { running: alive(&q["running"]), waiting: alive(&q["waiting"]) }
}

/// 目前佇列（已清掉結束的程序）。position 從 1 開始。
pub fn queue_snapshot() -> Value {
    let q = load();
    let waiting: Vec<Value> = q.waiting.into_iter().enumerate().map(|(i, mut e)| {
        e["position"] = json!(i + 1);
        e
    }).collect();
    json!({ "max": max_concurrent(), "running": q.running, "waiting": waiting })
}

pub fn queue_entry_for(root: &Path) -> Option<Value> {
    let snap = queue_snapshot();
    for (state, list) in [("running", &snap["running"]), ("waiting", &snap["waiting"])] {
        if let Some(e) = list.as_array().into_iter().flatten().find(|e| same_path(e["root"].as_str().unwrap_or(""), root)) {
            let mut out = json!({ "state": state });
            for (k, v) in e.as_object().unwrap() {
                out[k] = v.clone();
            }
            return Some(out);
        }
    }
    None
}

pub struct Acquire {
    pub granted: bool,
    pub position: usize,
    pub running: Vec<Value>,
}

/// 嘗試取得名額：排在最前面且有空位才拿得到。
pub fn try_acquire(root: &Path, pid: u32) -> Result<Acquire> {
    with_lock("queue", || {
        let mut q = load();
        let is_me = |e: &Value| pid_of(&e["pid"]) == Some(pid);
        if q.running.iter().any(is_me) {
            return Ok(Acquire { granted: true, position: 0, running: q.running });
        }
        if !q.waiting.iter().any(is_me) {
            q.waiting.push(json!({ "pid": pid, "root": root.to_string_lossy(), "since": now_iso() }));
        }
        let idx = q.waiting.iter().position(is_me).unwrap();
        let mut granted = false;
        if idx == 0 && q.running.len() < max_concurrent() {
            let mut me = q.waiting.remove(0);
            me["started_at"] = json!(now_iso());
            q.running.push(me);
            granted = true;
        }
        write_json(&queue_file(), &json!({ "running": q.running, "waiting": q.waiting }))?;
        Ok(Acquire { granted, position: if granted { 0 } else { idx + 1 }, running: q.running })
    })
}

pub fn release(pid: u32) -> Result<()> {
    with_lock("queue", || {
        let q = load();
        let keep = |list: Vec<Value>| list.into_iter().filter(|e| pid_of(&e["pid"]) != Some(pid)).collect::<Vec<_>>();
        write_json(&queue_file(), &json!({ "running": keep(q.running), "waiting": keep(q.waiting) }))
    })
}

/// 等到拿到名額為止。on_wait(position, running) 在排隊位置改變時呼叫；should_abort() 回傳 true 時放棄排隊。
/// 回傳 true＝拿到名額，false＝放棄。
pub fn acquire_slot(root: &Path, mut on_wait: impl FnMut(usize, &[Value]), mut should_abort: impl FnMut() -> bool, interval: Duration) -> Result<bool> {
    let pid = std::process::id();
    let mut last = None;
    loop {
        let r = try_acquire(root, pid)?;
        if r.granted {
            return Ok(true);
        }
        let roots: Vec<&str> = r.running.iter().map(|e| e["root"].as_str().unwrap_or("")).collect();
        let key = format!("{}|{}", r.position, roots.join(","));
        if last.as_ref() != Some(&key) {
            last = Some(key);
            on_wait(r.position, &r.running);
        }
        if should_abort() {
            release(pid)?;
            return Ok(false);
        }
        std::thread::sleep(interval);
    }
}
