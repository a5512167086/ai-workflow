//! 前端呼叫的 API（對應 legacy/src/server.js 的路由）。路徑與回傳格式和 Node 版 HTTP API 相同，
//! 只是改由 Tauri command 呼叫：GET /api/projects、POST /api/projects/add、GET /api/p/<id>/state …
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::{json, Value};

use super::archive::{list_archives, read_archive};
use super::backlog::{add_item, delete_item, get_item, read_backlog_with, reorder_items, update_item};
use super::cli::spawn_detached_cli;
use super::config::{load_config, patch_config, CLI_NAMES, CONFIG_FILE, MODES, RUNTIMES, SKILL_STAGES};
use super::doctor::doctor_report;
use super::git::is_git_repo;
use super::init::{init_project, InitOptions};
use super::prd::{approve_prd, current_prd};
use super::proc::{query_codex_rpc_with, resolve_cli_for};
use super::projects::{add_project, get_project, list_projects, project_id, project_summary, remove_project, touch_project};
use super::queue::{queue_entry_for, queue_snapshot, set_max_concurrent};
use super::runner::request_pause;
use super::skills::{import_skill, list_skill_runs, list_skills, load_skill, save_skill};
use super::state::{aipipe_dir, ensure_dirs, is_pid_alive_value, log_path, read_state};
use super::tasks::read_tasks;
use super::usage::{refresh_usage_limits, usage_snapshot};
use super::util::{read_text, resolve, str_of, truthy};
use super::{AppError, Result};

fn http(status: u16, message: impl Into<String>) -> AppError {
    AppError::with_status(status, message)
}

/// 讀檔案最後 max_bytes 位元組（log 可能很大）。
pub fn tail(file: &Path, max_bytes: u64) -> Value {
    let read = || -> std::io::Result<(String, u64)> {
        let mut f = fs::File::open(file)?;
        let size = f.metadata()?.len();
        let start = size.saturating_sub(max_bytes);
        f.seek(SeekFrom::Start(start))?;
        let mut buf = Vec::new();
        f.read_to_end(&mut buf)?;
        Ok((String::from_utf8_lossy(&buf).into_owned(), size))
    };
    let (text, size) = read().unwrap_or_default();
    json!({ "text": text, "size": size })
}

fn project_name(root: &Path) -> String {
    get_project(&project_id(root)).and_then(|p| p["name"].as_str().map(String::from))
        .unwrap_or_else(|| root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default())
}

/// 專案頁的完整狀態（對應 server.js 的 snapshot）。
pub fn snapshot(root: &Path) -> Result<Value> {
    let cfg = load_config(root)?;
    let state = read_state(root);
    let runner_alive = is_pid_alive_value(&state["runner"]["pid"]);
    Ok(json!({
        "root": root.to_string_lossy(),
        "project": { "id": project_id(root), "name": project_name(root) },
        "config": cfg,
        "runnerAlive": runner_alive,
        "prdBusy": is_pid_alive_value(&state["prd"]["pid"]),
        "taskGenBusy": is_pid_alive_value(&state["task_gen"]["pid"]),
        "skillBusy": is_pid_alive_value(&state["skill_job"]["pid"]),
        "queue": if runner_alive { queue_entry_for(root).unwrap_or(Value::Null) } else { Value::Null },
        "prd": current_prd(root),
        "tasks": read_tasks(root).unwrap_or_default(),
        "usage": usage_snapshot(root, &cfg),
        "state": state,
    }))
}

fn prd_rounds(root: &Path, state: &Value) -> Vec<Value> {
    state["prd"]["rounds"].as_array().into_iter().flatten().map(|r| {
        let mut r = r.clone();
        let text = r["file"].as_str().filter(|f| !f.is_empty()).map(|f| read_text(aipipe_dir(root).join("prd").join(f))).unwrap_or_default();
        r["text"] = json!(text);
        r
    }).collect()
}

fn task_detail(root: &Path, id: &str) -> Result<Value> {
    let dir = aipipe_dir(root).join("tasks").join(id);
    // review-<n>.md，或雙人審查的 review-<n>-<claude|codex>.md
    let mut reviews: Vec<(u64, String, String)> = fs::read_dir(&dir).map(|d| d.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).collect()).unwrap_or_else(|_| vec![])
        .into_iter()
        .filter_map(|f| {
            let stem = f.strip_prefix("review-")?.strip_suffix(".md")?.to_string();
            let (n, provider) = stem.split_once('-').map(|(n, p)| (n.to_string(), p.to_string())).unwrap_or((stem, String::new()));
            Some((n.parse().ok()?, provider, f.clone()))
        })
        .collect();
    reviews.sort();
    let reviews: Vec<Value> = reviews.into_iter().map(|(n, provider, f)| json!({ "name": f, "round": n, "provider": provider, "text": read_text(dir.join(&f)) })).collect();
    let task = read_tasks(root)?.into_iter().find(|t| super::util::js_string(&t["id"]) == id).unwrap_or(Value::Null);
    Ok(json!({
        "id": id,
        "state": read_state(root)["tasks"].get(id).cloned().unwrap_or(Value::Null),
        "task": task,
        "checks": read_text(dir.join("checks.txt")),
        "diff": read_text(dir.join("diff.patch")),
        "implement": read_text(dir.join("implement.md")),
        "reviews": reviews,
        "log": tail(&log_path(root, &format!("task-{id}")), 200_000)["text"],
    }))
}

fn busy_guard(snap: &Value) -> Result<()> {
    for (key, message) in [("skillBusy", "Skill 執行中"), ("runnerAlive", "流程執行中"), ("prdBusy", "PRD 流程執行中"), ("taskGenBusy", "任務產生中")] {
        if snap[key] == true {
            return Err(http(409, message));
        }
    }
    Ok(())
}

fn text_field(body: &Value, key: &str) -> String {
    match &body[key] {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn spawn(root: &Path, args: &[&str]) -> Result<Value> {
    let args: Vec<String> = args.iter().map(|s| s.to_string()).collect();
    Ok(json!({ "pid": spawn_detached_cli(root, &args)? }))
}

fn is_task_id(id: &str) -> bool {
    let mut parts = id.split('.');
    let ok = |p: Option<&str>| p.is_some_and(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()));
    ok(parts.next()) && parts.next().is_none_or(|p| ok(Some(p))) && parts.next().is_none()
}

fn approve_and_generate(root: &Path, cfg: &Value, launch: &dyn Fn(&Path) -> Result<Value>) -> Result<Value> {
    let file = approve_prd(root, cfg)?;
    super::state::update_state(root, |s| s["task_gen"] = json!({ "status": "running", "pid": null, "error": "" }))?;
    match launch(root) {
        Ok(job) => {
            super::state::update_state(root, |s| {
                if s["task_gen"]["status"] == "running" && s["task_gen"]["pid"].is_null() { s["task_gen"]["pid"] = job["pid"].clone(); }
            })?;
            Ok(json!({ "file": file.to_string_lossy(), "taskGeneration": job }))
        }
        Err(err) => {
            super::state::update_state(root, |s| s["task_gen"] = json!({ "status": "error", "error": err.message }))?;
            Ok(json!({ "file": file.to_string_lossy(), "taskError": err.message }))
        }
    }
}

fn spawn_run(root: &Path, args: &[&str], body: &Value) -> Result<Value> {
    let mut args = args.to_vec();
    if let Some(provider) = body["useProvider"].as_str() {
        if !["claude", "codex"].contains(&provider) { return Err(http(400, "AI 不正確")); }
        args.extend(["--use-provider", provider]);
    }
    spawn(root, &args)
}

fn handle_action(root: &Path, action: &str, body: &Value) -> Result<Value> {
    let snap = snapshot(root)?;
    match action {
        "prd/new" => {
            busy_guard(&snap)?;
            let idea = text_field(body, "idea").trim().to_string();
            if idea.is_empty() {
                return Err(http(400, "請輸入想法"));
            }
            spawn(root, &["prd", &idea])
        }
        "prd/approve" => {
            busy_guard(&snap)?;
            approve_and_generate(root, &snap["config"], &|root| spawn(root, &["tasks"]))
        }
        "prd/revise" => {
            busy_guard(&snap)?;
            let feedback = text_field(body, "feedback").trim().to_string();
            if feedback.is_empty() {
                return Err(http(400, "請輸入修改意見"));
            }
            spawn(root, &["prd", "--revise", &feedback])
        }
        "tasks/generate" => {
            busy_guard(&snap)?;
            spawn(root, &["tasks"])
        }
        "run/start" => {
            busy_guard(&snap)?;
            spawn_run(root, &["run"], body)
        }
        "run/pause" => {
            request_pause(root)?;
            Ok(json!({ "ok": true }))
        }
        "run/continue" => {
            busy_guard(&snap)?;
            spawn_run(root, &["continue"], body)
        }
        "task/rerun" => {
            busy_guard(&snap)?;
            let id = text_field(body, "id");
            if !is_task_id(&id) {
                return Err(http(400, "任務 id 不正確"));
            }
            if truthy(body.get("revert")) { spawn_run(root, &["rerun", &id, "--revert"], body) } else { spawn_run(root, &["rerun", &id], body) }
        }
        "config/runtime" => {
            let mut runtime = json!({});
            for name in CLI_NAMES {
                if let Some(v) = body["runtime"].get(name).filter(|v| !v.is_null()) {
                    if !v.as_str().is_some_and(|r| RUNTIMES.contains(&r)) {
                        return Err(http(400, format!("{name} 的 runtime 不正確")));
                    }
                    runtime[name] = v.clone();
                }
            }
            let mut patch = json!({ "runtime": runtime });
            if !body["wsl_distro"].is_null() && body.get("wsl_distro").is_some() {
                patch["wsl_distro"] = json!(text_field(body, "wsl_distro").trim());
            }
            Ok(json!({ "config": patch_config(root, &patch)? }))
        }
        "doctor" => doctor_report(root),
        "usage/refresh" => refresh_usage_limits(root, &snap["config"]),
        "skills/import" => {
            busy_guard(&snap)?;
            Ok(json!({ "skill": import_skill(root, &text_field(body, "path"))?.to_json() }))
        }
        "skills/save" => {
            busy_guard(&snap)?;
            let name = body["name"].as_str();
            Ok(json!({ "skill": save_skill(root, &text_field(body, "text"), name)?.to_json() }))
        }
        "skills/config" => {
            busy_guard(&snap)?;
            for (stage, names) in body["skills"].as_object().into_iter().flatten() {
                let Some(names) = names.as_array().filter(|_| SKILL_STAGES.contains(&stage.as_str())) else {
                    return Err(http(400, "Skill 階段設定不正確"));
                };
                for name in names {
                    let skill = load_skill(root, name.as_str().unwrap_or(""))?;
                    if !skill.extensions.is_empty() {
                        return Err(http(400, format!("{} 含執行器專屬設定", skill.name)));
                    }
                }
            }
            Ok(json!({ "config": patch_config(root, &json!({ "skills": body["skills"] }))? }))
        }
        "skills/run" => {
            busy_guard(&snap)?;
            let name = text_field(body, "name");
            load_skill(root, &name)?;
            let input = text_field(body, "input");
            if input.trim().is_empty() {
                return Err(http(400, "請輸入需求或回答"));
            }
            let mut args: Vec<String> = ["skills", "run", &name, "--input", &input].map(String::from).to_vec();
            if let Some(provider) = body["provider"].as_str().filter(|p| !p.is_empty()) {
                if !["claude", "codex"].contains(&provider) {
                    return Err(http(400, "provider 不正確"));
                }
                args.extend(["--provider".into(), provider.into()]);
            }
            let previous = text_field(body, "previousId");
            if !previous.is_empty() {
                args.extend(["--session".into(), previous]);
            }
            Ok(json!({ "pid": spawn_detached_cli(root, &args)? }))
        }
        "config/models" => {
            // roles 與 models 一起存；validate 會擋掉不合法的值。
            let mut patch = json!({});
            for key in ["roles", "models"] {
                if body[key].is_object() {
                    patch[key] = body[key].clone();
                }
            }
            Ok(json!({ "config": patch_config(root, &patch)? }))
        }
        "config/mode" => {
            if !body["mode"].as_str().is_some_and(|m| MODES.contains(&m)) {
                return Err(http(400, "模式不正確"));
            }
            Ok(json!({ "config": patch_config(root, &json!({ "mode": body["mode"] }))? }))
        }
        "backlog/add" => Ok(json!({ "item": add_item(root, body.get("title"), body.get("detail"))? })),
        "backlog/update" => {
            let mut patch = json!({});
            for k in ["title", "detail", "status"] {
                if let Some(v) = body.get(k).filter(|v| !v.is_null()) {
                    patch[k] = v.clone();
                }
            }
            Ok(json!({ "item": update_item(root, &text_field(body, "id"), &patch)? }))
        }
        "backlog/delete" => Ok(json!({ "items": delete_item(root, &text_field(body, "id"))? })),
        "backlog/reorder" => Ok(json!({ "items": reorder_items(root, &body["ids"])? })),
        "backlog/draft" => {
            busy_guard(&snap)?;
            let item = get_item(root, &text_field(body, "id"))?;
            spawn(root, &["prd", "--backlog", item["id"].as_str().unwrap_or("")])
        }
        _ => Err(http(404, "未知操作")),
    }
}

/// %XX 解碼（前端用 encodeURIComponent 帶封存名稱）。
fn percent_decode(s: &str) -> String {
    let hex = |b: u8| (b as char).to_digit(16).map(|d| d as u8);
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2])) {
                out.push(hi * 16 + lo);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn project_route(root: &Path, method: &str, rest: &str, body: &Value) -> Result<Value> {
    if method == "GET" {
        match rest {
            "state" => return snapshot(root),
            "usage" => return Ok(usage_snapshot(root, &load_config(root)?)),
            "skills" => return Ok(json!({ "skills": list_skills(root), "stages": SKILL_STAGES, "config": load_config(root)?["skills"] })),
            "skills/runs" => return Ok(json!({ "runs": list_skill_runs(root) })),
            "models" => return Ok(available_models(root, &load_config(root)?)),
            "prd" => {
                let state = read_state(root);
                return Ok(json!({ "prd": current_prd(root), "status": state["prd"], "rounds": prd_rounds(root, &state) }));
            }
            "backlog" => {
                let cfg = load_config(root)?;
                return Ok(json!({ "items": read_backlog_with(root, &cfg)?, "path": cfg["backlog_path"] }));
            }
            "archive" => {
                let cfg = load_config(root)?;
                return Ok(json!({ "items": list_archives(root, &cfg)?, "dir": cfg["archive_dir"] }));
            }
            _ => {}
        }
        if let Some(name) = rest.strip_prefix("archive/") {
            return read_archive(root, &percent_decode(name), &load_config(root)?);
        }
        if let Some(id) = rest.strip_prefix("task/").filter(|id| is_task_id(id)) {
            return task_detail(root, id);
        }
        if let Some(scope) = rest.strip_prefix("log/").filter(|s| !s.is_empty() && s.chars().all(|c| c.is_alphanumeric() || "_.-".contains(c))) {
            return Ok(tail(&log_path(root, scope), 200_000));
        }
        return Err(http(404, "not found"));
    }
    handle_action(root, rest, body)
}

/// 設定頁的模型選單：Codex 從 CLI 的 model/list 取得（含各模型支援的推理強度）；Claude 用 CLI 接受的別名，也能填完整名稱。
fn available_models(root: &Path, cfg: &Value) -> Value {
    let efforts = |list: &[&str]| list.iter().map(|e| json!(e)).collect::<Vec<_>>();
    let claude_models: Vec<Value> = [
        ("claude-sonnet-5-5", "Sonnet 5.5"), ("claude-opus-5-5", "Opus 5.5"),
        ("claude-haiku-5-5", "Haiku 5.5"),
        ("claude-opus-4-7", "Opus 4.7"), ("claude-opus-4-6", "Opus 4.6"), ("claude-sonnet-4-6", "Sonnet 4.6"),
        ("opus", "Opus（隨 CLI 更新的別名）"), ("sonnet", "Sonnet（隨 CLI 更新的別名）"), ("haiku", "Haiku（隨 CLI 更新的別名）"),
    ].iter()
        .map(|(id, name)| json!({ "id": id, "name": name, "efforts": efforts(&["low", "medium", "high", "xhigh", "max"]) }))
        .collect();
    let mut settings = json!({});
    // WSL 使用另一份設定，不能誤拿 Windows 使用者設定充當預設值。
    if super::runtime::cli_environment(cfg, "claude", root).runtime == "windows" {
        for file in [super::home::home_dir().join(".claude/settings.json"), root.join(".claude/settings.json"), root.join(".claude/settings.local.json")] {
            if let Some(value) = super::util::read_json(file) { settings = super::config::deep_merge(&settings, &value); }
        }
    }
    let claude = json!({ "models": claude_models, "error": null,
        "defaultModel": settings["model"], "defaultEffort": settings["effortLevel"], "defaultSource": "Claude CLI 設定（帳號與環境可能另有覆寫）" });
    let codex = match resolve_cli_for(cfg, "codex", root).and_then(|spec| query_codex_rpc_with(&spec, root, "model/list", Some(json!({})), 20)) {
        Ok(result) => {
            let models: Vec<Value> = result["data"].as_array().into_iter().flatten().filter(|m| m["hidden"] != true).map(|m| json!({
                "id": m["model"].as_str().or(m["id"].as_str()).unwrap_or(""),
                "name": m["displayName"].as_str().or(m["id"].as_str()).unwrap_or(""),
                "description": m["description"],
                "default": m["isDefault"] == true,
                "efforts": m["supportedReasoningEfforts"].as_array().into_iter().flatten().filter_map(|e| e["reasoningEffort"].as_str()).collect::<Vec<_>>(),
                "defaultEffort": m["defaultReasoningEffort"],
            })).collect();
            let config = resolve_cli_for(cfg, "codex", root).and_then(|spec| query_codex_rpc_with(&spec, root, "config/read", Some(json!({ "includeLayers": false })), 10)).ok();
            json!({ "models": models, "error": null, "defaultModel": config.as_ref().map(|c| &c["config"]["model"]), "defaultEffort": config.as_ref().map(|c| &c["config"]["model_reasoning_effort"]), "defaultSource": "Codex CLI 設定與模型清單" })
        }
        Err(_) => json!({ "models": [], "error": "無法從 Codex CLI 取得模型清單，可以直接填模型名稱" }),
    };
    json!({ "claude": claude, "codex": codex })
}

pub fn projects_payload() -> Value {
    let projects: Vec<Value> = list_projects().iter().map(project_summary).collect();
    json!({ "projects": projects, "queue": queue_snapshot(), "desktop": true })
}

fn handle_global(action: &str, body: &Value) -> Result<Value> {
    match action {
        "projects/add" => {
            let raw = text_field(body, "path").trim().to_string();
            if raw.is_empty() {
                return Err(http(400, "請輸入專案資料夾路徑"));
            }
            let dir = resolve(&raw);
            if !dir.is_dir() {
                return Err(http(400, format!("資料夾不存在：{}", dir.display())));
            }
            if !dir.join(CONFIG_FILE).exists() {
                if !truthy(body.get("init")) {
                    return Ok(json!({ "needs_init": true, "needs_git": !is_git_repo(&dir)?, "path": dir.to_string_lossy() }));
                }
                // 前端確認對話框已告知會 git init，所以這裡一併允許
                init_project(&dir, &InitOptions { git_init: true, ..Default::default() })?;
            }
            let name = body["name"].as_str().map(str::trim).filter(|n| !n.is_empty());
            Ok(json!({ "project": add_project(&dir, name)? }))
        }
        "projects/remove" => Ok(json!({ "removed": remove_project(&text_field(body, "id"))? })),
        "projects/open" => {
            touch_project(&text_field(body, "id"))?;
            Ok(json!({ "ok": true }))
        }
        "queue/config" => {
            let mut q = queue_snapshot();
            q["max"] = set_max_concurrent(&body["max"])?["max_concurrent_runs"].clone();
            Ok(json!({ "queue": q }))
        }
        _ => Err(http(404, "未知操作")),
    }
}

/// 找出 /api/p/<id>/ 對應的專案資料夾。
pub fn project_root(id: &str) -> Result<std::path::PathBuf> {
    let Some(project) = get_project(id) else { return Err(http(404, "總覽裡沒有這個專案")) };
    let root = std::path::PathBuf::from(str_of(&project, "path"));
    if !root.join(CONFIG_FILE).exists() {
        return Err(http(404, format!("找不到 {}{}{CONFIG_FILE}", root.display(), std::path::MAIN_SEPARATOR)));
    }
    ensure_dirs(&root)?;
    Ok(root)
}

/// 路由入口。method 是 GET 或 POST；path 例如 /api/projects、/api/p/<id>/state。
pub fn handle(method: &str, path: &str, body: &Value) -> Result<Value> {
    let path = path.split('?').next().unwrap_or("");
    if path == "/api/projects" && method == "GET" {
        return Ok(projects_payload());
    }
    if method == "POST" {
        if let Some(action) = path.strip_prefix("/api/").filter(|a| a.starts_with("projects/") || a.starts_with("queue/")) {
            return handle_global(action, body);
        }
    }
    if let Some(rest) = path.strip_prefix("/api/p/") {
        if let Some((id, rest)) = rest.split_once('/').filter(|(id, rest)| id.len() == 10 && id.bytes().all(|b| b.is_ascii_hexdigit()) && !rest.is_empty()) {
            return project_route(&project_root(id)?, method, rest, body);
        }
    }
    Err(http(404, "not found"))
}


#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 核准後自動拆任務_啟動失敗保留核准並提供重試狀態() {
        for fail in [false, true] {
            let root = super::super::util::temp_dir("auto-tasks-");
            ensure_dirs(&root).unwrap();
            fs::create_dir_all(root.join(".aipipe/prd")).unwrap();
            fs::write(root.join(".aipipe/prd/current.md"), "# PRD").unwrap();
            super::super::state::update_state(&root, |s| s["prd"]["status"] = json!("awaiting_approval")).unwrap();
            let result = approve_and_generate(&root, &super::super::config::default_config(), &|_| {
                if fail { Err(http(500, "無法啟動")) } else { Ok(json!({ "pid": 123 })) }
            }).unwrap();
            let state = read_state(&root);
            assert_eq!(state["prd"]["status"], "approved");
            assert_eq!(state["task_gen"]["status"], if fail { "error" } else { "running" });
            assert_eq!(result["taskError"].is_string(), fail);
        }
    }

    #[test]
    fn 路徑工具() {
        assert!(is_task_id("12") && is_task_id("2.1") && !is_task_id("2.") && !is_task_id("a") && !is_task_id("1.2.3"));
        assert_eq!(percent_decode("2026-11-01-%E5%8C%AF%E5%87%BA-csv"), "2026-11-01-匯出-csv");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%中"), "%中");
    }
}
