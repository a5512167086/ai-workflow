//! 前端呼叫的 API。路徑與回傳格式沿用舊版 HTTP API，改由 Tauri command 呼叫：
//! GET /api/projects、POST /api/projects/add、GET /api/config、GET /api/p/<id>/state …
use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::Path;

use serde_json::{json, Value};

use super::archive::{list_archives, read_archive};
use super::backlog::{delete_item, get_item, read_backlog, reorder_items, update_item};
use super::cli::spawn_detached_cli;
use super::config::{global_config_text, load_config, load_global, patch_config, patch_global, project_registered, CLI_NAMES, MODES, RUNTIMES, SKILL_STAGES};
use super::doctor::doctor_report;
use super::git::is_git_repo;
use super::home::{app_home, home_dir};
use super::init::prepare_project;
use super::prd::{approve_prd, current_prd};
use super::proc::{query_claude_initialize, query_codex_rpc_with, resolve_cli_for};
use super::projects::{add_project, get_project, list_projects, project_id, project_summary, remove_project, touch_project};
use super::queue::{queue_entry_for, queue_snapshot, set_max_concurrent};
use super::runner::request_pause;
use super::skills::{import_skill, list_skill_runs, list_skills, load_skill, save_skill};
use super::state::{data_dir, is_pid_alive_value, log_path, read_state};
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

/// 專案頁的完整狀態。
pub fn snapshot(root: &Path) -> Result<Value> {
    let cfg = load_config(root)?;
    // PRD 程序中途被結束時，狀態不會自己回來；在這裡發現並恢復，避免畫面一直停在「修訂中」。
    let _ = super::prd::recover_interrupted(root);
    let state = read_state(root);
    let runner_alive = is_pid_alive_value(&state["runner"]["pid"]);
    Ok(json!({
        "root": root.to_string_lossy(),
        "dataDir": data_dir(root).to_string_lossy(),
        "project": { "id": project_id(root), "name": project_name(root) },
        "config": cfg,
        "runnerAlive": runner_alive,
        "prdBusy": is_pid_alive_value(&state["prd"]["pid"]),
        "taskGenBusy": is_pid_alive_value(&state["task_gen"]["pid"]),
        "skillBusy": is_pid_alive_value(&state["skill_job"]["pid"]),
        "queue": if runner_alive { queue_entry_for(root).unwrap_or(Value::Null) } else { Value::Null },
        "prd": current_prd(root),
        "tasks": read_tasks(root).unwrap_or_default(),
        "taskTag": super::tasks::current_tag(root).unwrap_or_default(),
        "taskRevision": super::tasks::revision(root).unwrap_or_default(),
        "taskReferences": super::tasks::group_metadata(root).unwrap_or(Value::Null)["references"],
        "usage": usage_snapshot(root, &cfg),
        // AI 要求、等使用者允許或拒絕的工具權限（最舊的在前）。
        "permissions": super::permissions::pending(root),
        "state": state,
    }))
}

fn prd_rounds(root: &Path, state: &Value) -> Vec<Value> {
    state["prd"]["rounds"].as_array().into_iter().flatten().map(|r| {
        let mut r = r.clone();
        let text = r["file"].as_str().filter(|f| !f.is_empty()).map(|f| read_text(data_dir(root).join("prd").join(f))).unwrap_or_default();
        r["text"] = json!(text);
        r
    }).collect()
}

fn task_detail(root: &Path, id: &str) -> Result<Value> {
    let dir = data_dir(root).join("tasks").join(id);
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
    let task = super::tasks::find_task(root, id)?.ok_or_else(|| http(404, "找不到這個任務"))?;
    Ok(json!({
        "id": id, "revision": super::tasks::revision(root)?, "tag": super::tasks::current_tag(root)?,
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
    super::state::update_state(root, |s| s["task_gen"] = json!({ "status": "running", "pid": null, "error": "", "started_at": super::util::now_iso() }))?;
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

/// 全域設定的修改：runtime／models／mode／skills 綁定。root 給 skills 綁定檢查技能存在用（總覽沒有專案時用 None）。
fn config_action(action: &str, body: &Value, root: Option<&Path>) -> Result<Value> {
    let patch = match action {
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
            patch
        }
        "config/models" => {
            // roles 與 models 一起存；validate 會擋掉不合法的值。
            let mut patch = json!({});
            for key in ["roles", "models"] {
                if body[key].is_object() {
                    patch[key] = body[key].clone();
                }
            }
            patch
        }
        "config/mode" => {
            if !body["mode"].as_str().is_some_and(|m| MODES.contains(&m)) {
                return Err(http(400, "模式不正確"));
            }
            json!({ "mode": body["mode"] })
        }
        "config/limits" => {
            let mut patch = json!({});
            for key in ["max_fix_rounds", "max_prd_rounds", "num_tasks", "command_timeout_sec", "agent_timeout_sec"] {
                if let Some(v) = body.get(key).filter(|v| v.is_i64() || v.is_u64()) {
                    patch[key] = v.clone();
                }
            }
            if let Some(prefix) = body["branch_prefix"].as_str() {
                let prefix = prefix.trim();
                if !prefix.chars().all(|c| c.is_ascii_alphanumeric() || "/_-.".contains(c)) {
                    return Err(http(400, "分支前綴只能包含英數字、/、_、- 與 ."));
                }
                patch["branch_prefix"] = json!(prefix);
            }
            patch
        }
        "skills/config" => {
            for (stage, names) in body["skills"].as_object().into_iter().flatten() {
                let Some(names) = names.as_array().filter(|_| SKILL_STAGES.contains(&stage.as_str())) else {
                    return Err(http(400, "Skill 階段設定不正確"));
                };
                for name in names {
                    let skill = load_skill(root.unwrap_or(&app_home()), name.as_str().unwrap_or(""))?;
                    if !skill.extensions.is_empty() {
                        return Err(http(400, format!("{} 含執行器專屬設定", skill.name)));
                    }
                }
            }
            json!({ "skills": body["skills"] })
        }
        _ => return Err(http(404, "未知操作")),
    };
    let config = match root {
        Some(root) => patch_config(root, &patch)?,
        None => patch_global(&patch)?,
    };
    Ok(json!({ "config": config }))
}

fn handle_action(root: &Path, action: &str, body: &Value) -> Result<Value> {
    let snap = snapshot(root)?;
    match action {
        "references/suggest" => super::references::suggest(root, &text_field(body, "query")),
        "references/import" => super::references::import(root, body),
        "references/assign" => {
            let refs = json!(super::references::ids(root, &body["references"])?);
            match body["target"].as_str().unwrap_or("") {
                "feature" => { busy_guard(&snap)?; if body["featureScope"] != snap["state"]["prd"]["reference_scope"] { return Err(http(409, "目前功能已變更，請重新選取參考資料")); } super::tasks::update_feature_references(root, &snap["state"]["prd"]["archive_dir"], &refs)?; super::state::update_state(root, |s| s["prd"]["references"] = refs)?; },
                "group" => { busy_guard(&snap)?; super::tasks::assign_references(root, "", &text_field(body, "tag"), refs)?; },
                "task" => { busy_guard(&snap)?; if !is_task_id(&text_field(body, "id")) { return Err(http(400, "任務 id 不正確")); } super::tasks::assign_references(root, &text_field(body, "id"), &text_field(body, "tag"), refs)?; },
                "backlog" => { super::backlog::update_item(root, &text_field(body, "id"), &json!({ "references": refs }))?; },
                _ => return Err(http(400, "參考資料目標不正確")),
            }
            Ok(json!({ "ok": true }))
        }
        "backlog/interview" => super::requirements::start(root, body, &|id, turn| spawn_detached_cli(root, &["chat".into(), "--id".into(), id.into(), "--turn".into(), turn.into()])),
        "backlog/confirm" => super::requirements::confirm(root, body),
        "prd/save" => { busy_guard(&snap)?; super::prd::save_manual(root, &text_field(body, "text"), &body["version"], &body["scope"]) },
        "prd/review" => { busy_guard(&snap)?; spawn(root, &["prd", "--review"]) },
        "task/save" => { busy_guard(&snap)?; if !is_task_id(&text_field(body, "id")) { return Err(http(400, "任務 id 不正確")); } let result = super::tasks::edit_task(root, &text_field(body, "id"), &text_field(body, "tag"), &text_field(body, "revision"), &body["task"])?; let _ = super::archive::archive_tasks(root, json!({})); Ok(result) },
        // 權限請求不受 busy_guard 限制：流程正在執行時才會有請求要回答。
        "permissions/answer" => super::permissions::answer(root, &text_field(body, "id"), &text_field(body, "decision"), &text_field(body, "message")),
        "tasks/approve" => { busy_guard(&snap)?; super::human::approve_tasks(root, &text_field(body, "revision")) },
        "chat/send" => super::chat::start_turn(root, body, &|id, turn| spawn_detached_cli(root, &["chat".into(), "--id".into(), id.into(), "--turn".into(), turn.into()])),
        "chat/cancel" => super::chat::cancel_turn(root, &text_field(body, "chatId")),
        "chat/rename" => super::chat::rename_chat(root, &text_field(body, "chatId"), &text_field(body, "title")),
        "chat/delete" => { super::chat::delete_chat(root, &text_field(body, "chatId"))?; Ok(json!({ "ok": true })) },
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
            if body.get("version").is_some() && (body["version"] != snap["state"]["prd"]["version"] || body["scope"] != snap["state"]["prd"]["reference_scope"]) { return Err(http(409, "PRD 已更新，請重新閱讀後核准")); }
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
        "config/runtime" | "config/models" | "config/mode" | "config/limits" => config_action(action, body, Some(root)),
        "config/project" => {
            // 只有 build/test/lint、feature、context_files 屬於專案。
            let mut patch = json!({});
            if let Some(commands) = body["commands"].as_object() {
                let mut cmds = json!({});
                for key in ["build", "test", "lint"] {
                    if let Some(v) = commands.get(key) {
                        cmds[key] = json!(v.as_str().unwrap_or("").trim());
                    }
                }
                patch["commands"] = cmds;
            }
            if let Some(feature) = body["feature"].as_str() {
                patch["feature"] = json!(feature.trim());
            }
            if let Some(files) = body["context_files"].as_array() {
                patch["context_files"] = json!(files.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>());
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
        "skills/delete" => {
            busy_guard(&snap)?;
            super::skills::delete_skill(root, &text_field(body, "name"))
        }
        "skills/config" => {
            busy_guard(&snap)?;
            config_action(action, body, Some(root))
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
        "backlog/add" => Ok(json!({ "item": super::backlog::add_item_with_references(root, body.get("title"), body.get("detail"), &body["references"])? })),
        "backlog/update" => {
            let mut patch = json!({});
            for k in ["title", "detail", "status", "references"] {
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
            super::requirements::prd_input(root, &item)?;
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
            "chats" => return Ok(json!({ "items": super::chat::list_chats(root).into_iter().filter(|chat| chat["kind"] != "requirements").collect::<Vec<_>>() })),
            "state" => return snapshot(root),
            "usage" => return Ok(usage_snapshot(root, &load_config(root)?)),
            "skills" => return Ok(json!({ "skills": list_skills(root), "stages": SKILL_STAGES, "config": load_config(root)?["skills"] })),
            "skills/runs" => return Ok(json!({ "runs": list_skill_runs(root) })),
            "models" => return Ok(available_models(root, &load_config(root)?)),
            "prd" => {
                let state = read_state(root);
                return Ok(json!({ "prd": current_prd(root), "status": state["prd"], "rounds": prd_rounds(root, &state) }));
            }
            "references" => return Ok(json!({ "items": super::references::list(root) })),
            "backlog" => return Ok(json!({ "items": read_backlog(root)?, "path": super::backlog::backlog_file(root).to_string_lossy() })),
            "archive" => return Ok(json!({ "items": list_archives(root)?, "dir": super::archive::archive_root(root).to_string_lossy() })),
            _ => {}
        }
        if let Some(id) = rest.strip_prefix("requirements/") { return super::requirements::get(root, id); }
        if let Some(id) = rest.strip_prefix("chat/") { return super::chat::get_chat(root, id); }
        if let Some(name) = rest.strip_prefix("archive/") {
            return read_archive(root, &percent_decode(name));
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
/// Claude CLI 回報的模型清單，依 CLI 路徑與執行環境快取 10 分鐘（每次開設定頁都啟動 CLI 太慢）。查詢失敗不快取。
static CLAUDE_MODELS: std::sync::LazyLock<std::sync::Mutex<Option<(std::time::Instant, String, Value)>>> = std::sync::LazyLock::new(|| std::sync::Mutex::new(None));

/// 把 CLI initialize 回傳的 models 轉成設定頁用的格式。`default` 那一項不列出（空白就是 CLI 預設），
/// 但用它的 resolvedModel／displayName 說明預設是哪個模型。
fn claude_models_from_cli(init: &Value) -> Option<(Vec<Value>, Value)> {
    let list = init["models"].as_array().filter(|m| !m.is_empty())?;
    let mut default = Value::Null;
    let models = list.iter().filter_map(|m| {
        let id = m["value"].as_str()?;
        if id == "default" { default = json!(format!("{}（{}）", m["displayName"].as_str().unwrap_or("預設"), m["resolvedModel"].as_str().unwrap_or(""))); return None; }
        let efforts: Vec<Value> = if m["supportsEffort"] == true { m["supportedEffortLevels"].as_array().cloned().unwrap_or_default() } else { vec![] };
        Some(json!({ "id": id, "name": m["displayName"].as_str().unwrap_or(id), "description": m["description"], "resolved": m["resolvedModel"], "efforts": efforts }))
    }).collect();
    Some((models, default))
}

fn available_models(root: &Path, cfg: &Value) -> Value {
    let efforts = |list: &[&str]| list.iter().map(|e| json!(e)).collect::<Vec<_>>();
    // CLI 查不到時的備用清單：別名永遠指向 CLI 當下的最新版。
    let fallback: Vec<Value> = [
        ("opus", "Opus（最新版別名）"), ("sonnet", "Sonnet（最新版別名）"), ("haiku", "Haiku（最新版別名）"),
        ("claude-opus-5-5", "Opus 5.5"), ("claude-sonnet-5-5", "Sonnet 5.5"), ("claude-haiku-5-5", "Haiku 5.5"),
    ].iter()
        .map(|(id, name)| json!({ "id": id, "name": name, "efforts": efforts(&["low", "medium", "high", "xhigh", "max"]) }))
        .collect();
    let from_cli = resolve_cli_for(cfg, "claude", root).and_then(|spec| {
        let key = format!("{}|{}|{}|{}", spec.runtime, spec.distro, spec.command, spec.bin);
        if let Some((at, cached_key, value)) = CLAUDE_MODELS.lock().unwrap().as_ref() {
            if cached_key == &key && at.elapsed() < std::time::Duration::from_secs(600) { return Ok(value.clone()); }
        }
        let init = query_claude_initialize(&spec, root, 20)?;
        let parsed = claude_models_from_cli(&init).ok_or_else(|| AppError::new("Claude CLI 沒有回報模型清單"))?;
        let value = json!({ "models": parsed.0, "default": parsed.1 });
        *CLAUDE_MODELS.lock().unwrap() = Some((std::time::Instant::now(), key, value.clone()));
        Ok(value)
    });
    let (claude_models, cli_default, claude_error, claude_source) = match from_cli {
        Ok(value) => (value["models"].as_array().cloned().unwrap_or_default(), value["default"].clone(), Value::Null, "Claude CLI 模型清單（依帳號）"),
        Err(err) => (fallback, Value::Null, json!(format!("無法從 Claude CLI 取得模型清單（{}），以下是建議清單，也可以直接輸入模型 ID", err.message)), "建議清單"),
    };
    let mut settings = json!({});
    // WSL 使用另一份設定，不能誤拿 Windows 使用者設定充當預設值。
    if super::runtime::cli_environment(cfg, "claude", root).runtime == "windows" {
        for file in [home_dir().join(".claude/settings.json"), root.join(".claude/settings.json"), root.join(".claude/settings.local.json")] {
            if let Some(value) = super::util::read_json(file) { settings = super::config::deep_merge(&settings, &value); }
        }
    }
    let default_model = if settings["model"].is_string() { settings["model"].clone() } else { cli_default };
    let claude = json!({ "models": claude_models, "error": claude_error,
        "defaultModel": default_model, "defaultEffort": settings["effortLevel"], "defaultSource": format!("{claude_source}；預設值來自 Claude CLI 設定，帳號與環境可能另有覆寫") });
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

/// 總覽設定頁用：全域設定、原文與資料目錄位置。
pub fn global_config_payload() -> Result<Value> {
    Ok(json!({ "config": load_global()?, "text": global_config_text(), "home": app_home().to_string_lossy(), "queue": queue_snapshot() }))
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
            // 加入專案不會在專案資料夾建立任何檔案；只有不是 git repo 時要先問過使用者再 git init。
            if !project_registered(&dir) && !is_git_repo(&dir)? {
                if !truthy(body.get("init")) {
                    return Ok(json!({ "needs_init": true, "needs_git": true, "path": dir.to_string_lossy() }));
                }
                super::init::init_project(&dir, &super::init::InitOptions { git_init: true, ..Default::default() })?;
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
        "config/runtime" | "config/models" | "config/mode" | "config/limits" | "skills/config" => config_action(action, body, None),
        "doctor" => doctor_report(&home_dir()),
        _ => Err(http(404, "未知操作")),
    }
}

/// 找出 /api/p/<id>/ 對應的專案資料夾。
pub fn project_root(id: &str) -> Result<std::path::PathBuf> {
    let Some(project) = get_project(id) else { return Err(http(404, "總覽裡沒有這個專案")) };
    let root = std::path::PathBuf::from(str_of(&project, "path"));
    if !root.is_dir() {
        return Err(http(404, format!("找不到專案資料夾 {}", root.display())));
    }
    if !project_registered(&root) {
        return Err(http(404, format!("{} 的專案資料不存在，請重新加入專案", root.display())));
    }
    prepare_project(&root);
    Ok(root)
}

/// 路由入口。method 是 GET 或 POST；path 例如 /api/projects、/api/config、/api/p/<id>/state。
pub fn handle(method: &str, path: &str, body: &Value) -> Result<Value> {
    let path = path.split('?').next().unwrap_or("");
    if method == "GET" {
        match path {
            "/api/projects" => return Ok(projects_payload()),
            "/api/config" => return global_config_payload(),
            "/api/models" => return Ok(available_models(&home_dir(), &super::config::load_config_or_default(&home_dir())?)),
            _ => {}
        }
    }
    if method == "POST" {
        if let Some(action) = path.strip_prefix("/api/").filter(|a| a.starts_with("projects/") || a.starts_with("queue/") || a.starts_with("config/") || *a == "skills/config" || *a == "doctor") {
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
    fn 任務詳情支援藍圖的子任務與依賴() {
        let root = super::super::util::temp_dir("task-detail-");
        super::super::tasks::write_tasks(&root, &[json!({ "id": 1, "title": "parent", "subtasks": [{ "id": 1, "title": "child" }, { "id": 2, "title": "dependent", "dependencies": [1] }] })], Some("master"), json!({})).unwrap();
        let detail = task_detail(&root, "1.2").unwrap();
        assert_eq!(detail["task"]["title"], "dependent");
        assert_eq!(detail["task"]["id"], "1.2");
        assert_eq!(detail["task"]["dependencies"], json!(["1.1"]));
        assert_eq!(task_detail(&root, "9.9").unwrap_err().status, 404);
    }

    #[test]
    fn 核准後自動拆任務_啟動失敗保留核准並提供重試狀態() {
        for fail in [false, true] {
            let root = super::super::util::temp_dir("auto-tasks-");
            super::super::state::ensure_dirs(&root).unwrap();
            fs::write(data_dir(&root).join("prd/current.md"), "# PRD").unwrap();
            super::super::state::update_state(&root, |s| s["prd"]["status"] = json!("awaiting_approval")).unwrap();
            let result = approve_and_generate(&root, &super::super::config::default_config(), &|_| {
                if fail { Err(http(500, "無法啟動")) } else { Ok(json!({ "pid": 123 })) }
            }).unwrap();
            let state = read_state(&root);
            assert_eq!(state["prd"]["status"], "approved");
            assert_eq!(state["task_gen"]["status"], if fail { "error" } else { "running" });
            assert_eq!(result["taskError"].is_string(), fail);
            assert!(super::super::state::prd_file(&root).exists());
            assert_eq!(fs::read_dir(&root).unwrap().count(), 0, "核准 PRD 不能在專案資料夾寫檔");
        }
    }

    #[test]
    fn 參考資料拒絕過期的功能與任務群組_更新共用參考不重設任務狀態() {
        let root = super::super::util::temp_dir("reference-api-");
        super::super::config::save_config(&root, &super::super::config::default_config()).unwrap();
        let reference = super::super::references::import(&root, &json!({ "name": "spec.md", "data": "c3BlYw==" })).unwrap();
        super::super::state::update_state(&root, |s| { s["prd"]["reference_scope"] = json!("new-feature"); s["prd"]["archive_dir"] = json!("archive/feature"); }).unwrap();
        super::super::tasks::write_tasks(&root, &[json!({ "id": 1, "title": "existing", "status": "done" })], Some("master"), json!({ "reference_feature": "archive/feature" })).unwrap();
        super::super::tasks::set_status(&root, "1", "review").unwrap();
        super::super::tasks::set_status(&root, "1", "done").unwrap();
        let refs = json!([reference["id"]]);
        let error = handle_action(&root, "references/assign", &json!({ "target": "feature", "featureScope": "old-feature", "references": refs })).unwrap_err();
        assert_eq!(error.status, 409);
        assert!(read_state(&root)["prd"]["references"].is_null());
        handle_action(&root, "references/assign", &json!({ "target": "feature", "featureScope": "new-feature", "references": refs })).unwrap();
        assert_eq!(super::super::tasks::group_metadata(&root).unwrap()["references"], refs);
        assert_eq!(read_tasks(&root).unwrap()[0]["status"], "done");
        assert_eq!(handle_action(&root, "references/assign", &json!({ "target": "task", "tag": "old-tag", "id": "1", "references": refs })).unwrap_err().status, 409);
        assert_eq!(handle_action(&root, "references/assign", &json!({ "target": "task", "tag": "master", "id": "1.1.1", "references": refs })).unwrap_err().status, 400);
    }

    #[test]
    fn claude_cli_模型清單_略過預設項並保留各模型的推理強度() {
        let init = json!({ "models": [
            { "value": "default", "resolvedModel": "claude-opus-5-5", "displayName": "Default (recommended)", "supportsEffort": true, "supportedEffortLevels": ["low", "high"] },
            { "value": "opus", "resolvedModel": "claude-opus-5-5", "displayName": "Opus 5.5", "description": "complex work", "supportsEffort": true, "supportedEffortLevels": ["low", "medium", "high", "xhigh", "max"] },
            { "value": "claude-haiku-4-5-20251001", "displayName": "Haiku 4.5", "description": "quick" },
        ] });
        let (models, default) = claude_models_from_cli(&init).unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0]["id"], "opus");
        assert_eq!(models[0]["name"], "Opus 5.5");
        assert_eq!(models[0]["efforts"].as_array().unwrap().len(), 5);
        assert_eq!(models[1]["efforts"], json!([]));
        assert_eq!(default, "Default (recommended)（claude-opus-5-5）");
        assert!(claude_models_from_cli(&json!({ "models": [] })).is_none());
        assert!(claude_models_from_cli(&json!({})).is_none());
    }

    #[test]
    fn 路徑工具() {
        assert!(is_task_id("12") && is_task_id("2.1") && !is_task_id("2.") && !is_task_id("a") && !is_task_id("1.2.3"));
        assert_eq!(percent_decode("2026-11-01-%E5%8C%AF%E5%87%BA-csv"), "2026-11-01-匯出-csv");
        assert_eq!(percent_decode("a%2"), "a%2");
        assert_eq!(percent_decode("%中"), "%中");
    }
}
