//! 登錄專案：建立 <home>/projects/<id>/project.json（偵測 build/test/lint 指令），並把舊版留在專案資料夾裡的
//! `.aipipe.json`、`.aipipe/`、`docs/aipipe/`、`docs/prd/`、`docs/handovers/` 搬到新位置。專案資料夾裡不會新增任何檔案。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::config::{default_project, deep_merge, global_config_path, load_config, load_project, patch_global, project_registered, save_project, PROJECT_KEYS, ROLES};
use super::git::{init_repo, is_git_repo};
use super::state::{append_log, data_dir, ensure_dirs, handover_file, prd_file, read_state, update_state};
use super::util::{now_iso, read_json, write_json};
use super::Result;

/// 依專案內容猜 build/test/lint 指令；猜不到就留空讓使用者自己填。
pub fn detect_commands(root: &Path) -> Value {
    if let Some(pkg) = read_json(root.join("package.json")) {
        let scripts = &pkg["scripts"];
        let runner = if root.join("pnpm-lock.yaml").exists() { "pnpm" } else if root.join("yarn.lock").exists() { "yarn" } else { "npm" };
        let mut cmds = json!({ "build": "", "test": "", "lint": "" });
        for k in ["build", "test", "lint"] {
            if scripts[k].as_str().is_some_and(|s| !s.is_empty()) {
                cmds[k] = json!(if k == "test" && runner == "npm" { "npm test".to_string() } else { format!("{runner} run {k}") });
            }
        }
        return cmds;
    }
    if root.join("Cargo.toml").exists() {
        return json!({ "build": "cargo build", "test": "cargo test", "lint": "cargo clippy" });
    }
    if root.join("go.mod").exists() {
        return json!({ "build": "go build ./...", "test": "go test ./...", "lint": "go vet ./..." });
    }
    if root.join("pyproject.toml").exists() {
        return json!({ "build": "", "test": "pytest", "lint": "" });
    }
    json!({ "build": "", "test": "", "lint": "" })
}

#[derive(Default)]
pub struct InitOptions {
    /// 已登錄時重新偵測指令。
    pub force: bool,
    pub git_init: bool,
    /// 以下選項改的是全域設定。
    pub mode: Option<String>,
    pub feature: Option<String>,
    /// author / reviewer / implementer / code_reviewer → claude | codex
    pub roles: Vec<(String, String)>,
}

pub struct InitResult {
    pub cfg: Value,
    pub git_initialized: bool,
    pub data_dir: PathBuf,
    /// 從專案資料夾搬過來的舊資料。
    pub migrated: Vec<String>,
}

pub fn init_project(root: &Path, options: &InitOptions) -> Result<InitResult> {
    if project_registered(root) && !options.force {
        crate::bail!("{} 已經登錄；要重新偵測指令請加 --force", root.display());
    }
    let mut git_initialized = false;
    if !is_git_repo(root)? {
        if !options.git_init {
            crate::bail!("目標目錄不是 git repo；加 --git-init 讓 ai-workflow 幫你 git init，或自己先 git init");
        }
        init_repo(root)?;
        git_initialized = true;
    }
    let mut fields = deep_merge(&default_project(), &load_project(root).unwrap_or(json!({})));
    fields["commands"] = detect_commands(root);
    if let Some(feature) = &options.feature {
        fields["feature"] = json!(feature);
    }
    save_project(root, &fields)?;
    let mut global = json!({});
    if let Some(mode) = &options.mode {
        global["mode"] = json!(mode);
    }
    for (role, provider) in &options.roles {
        if ROLES.contains(&role.as_str()) {
            global["roles"][role.as_str()] = json!(provider);
        }
    }
    if global.as_object().is_some_and(|m| !m.is_empty()) {
        patch_global(&global)?;
    }
    ensure_dirs(root)?;
    let migrated = migrate_legacy(root)?;
    Ok(InitResult { cfg: load_config(root)?, git_initialized, data_dir: data_dir(root), migrated })
}

/// 開啟已登錄的專案前呼叫：確保資料目錄存在，並搬移舊資料（失敗只記 log，不阻擋）。
pub fn prepare_project(root: &Path) {
    let _ = ensure_dirs(root);
    if let Err(err) = migrate_legacy(root) {
        append_log(root, "process", &format!("⚠ 搬移舊資料失敗：{}", err.message));
    }
}

const LEGACY_CONFIG: &str = ".aipipe.json";
const LEGACY_DIR: &str = ".aipipe";

fn copy_tree(src: &Path, dst: &Path, skip: &[&str]) -> Result<usize> {
    let mut copied = 0;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if skip.contains(&name.as_str()) || name.ends_with(".lock") || name.ends_with(".tmp") {
            continue;
        }
        let target = dst.join(&name);
        if entry.file_type()?.is_dir() {
            fs::create_dir_all(&target)?;
            copied += copy_tree(&entry.path(), &target, &[])?;
        } else if !target.exists() {
            fs::copy(entry.path(), &target)?;
            copied += 1;
        }
    }
    Ok(copied)
}

/// 舊版把設定與流程資料放在專案裡；第一次開啟時搬到 <home>/projects/<id>/，不刪舊檔（由使用者自己清理）。
/// 只做一次（以 migrated.json 為記號）。回傳搬了哪些東西。
pub fn migrate_legacy(root: &Path) -> Result<Vec<String>> {
    let target = data_dir(root);
    let marker = target.join("migrated.json");
    if marker.exists() {
        return Ok(vec![]);
    }
    let legacy_cfg = root.join(LEGACY_CONFIG);
    let legacy_dir = root.join(LEGACY_DIR);
    let raw_cfg = read_json(&legacy_cfg).filter(Value::is_object).unwrap_or(json!({}));
    let legacy_path = |key: &str, default: &str| root.join(raw_cfg[key].as_str().filter(|s| !s.is_empty()).unwrap_or(default));
    let handover = legacy_path("handover_path", "docs/handovers/current_handover.md");
    let prd = legacy_path("prd_path", "docs/aipipe/prd.md");
    let backlog = legacy_path("backlog_path", "docs/aipipe/backlog.json");
    let archive = legacy_path("archive_dir", "docs/prd");
    if !legacy_cfg.exists() && !legacy_dir.is_dir() && !handover.exists() && !prd.exists() && !backlog.exists() && !archive.is_dir() {
        return Ok(vec![]);
    }
    fs::create_dir_all(&target)?;
    let mut moved = Vec::new();
    if legacy_cfg.exists() {
        // 專案欄位進 project.json；全域欄位只在全域設定還沒有該欄位時補上（第一個搬過來的專案成為全域預設）。
        let mut project = load_project(root).unwrap_or(json!({}));
        let mut global = json!({});
        let existing = read_json(global_config_path()).filter(Value::is_object).unwrap_or(json!({}));
        for (k, v) in raw_cfg.as_object().into_iter().flatten() {
            if PROJECT_KEYS.contains(&k.as_str()) {
                project[k] = v.clone();
            } else if !["handover_path", "prd_path", "backlog_path", "archive_dir", "taskmaster", "task_master"].contains(&k.as_str()) && existing.get(k).is_none() {
                global[k] = v.clone();
            }
        }
        if project["context_files"] == json!(["docs/ai-context.md", "docs/index.md"]) {
            // 舊版 init 的範本；只保留真的存在的檔案。
            let kept: Vec<Value> = project["context_files"].as_array().unwrap().iter().filter(|f| f.as_str().is_some_and(|f| root.join(f).exists())).cloned().collect();
            project["context_files"] = json!(kept);
        }
        if save_project(root, &project).is_ok() {
            moved.push(format!("{LEGACY_CONFIG} → project.json（專案欄位）"));
        }
        if global.as_object().is_some_and(|m| !m.is_empty()) && patch_global(&global).is_ok() {
            moved.push(format!("{LEGACY_CONFIG} → 全域設定（{}）", global.as_object().unwrap().keys().cloned().collect::<Vec<_>>().join("、")));
        }
    }
    if legacy_dir.is_dir() {
        let count = copy_tree(&legacy_dir, &target, &["tmp", "locks", "calls.jsonl"])?;
        moved.push(format!("{LEGACY_DIR}/ → {}（{count} 個檔案）", target.display()));
    }
    for (src, dst, label) in [(&handover, handover_file(root), "handover"), (&prd, prd_file(root), "核准的 PRD"), (&backlog, target.join("backlog.json"), "需求待辦")] {
        if src.is_file() && !dst.exists() {
            fs::copy(src, &dst)?;
            moved.push(format!("{} → {label}", src.display()));
        }
    }
    if archive.is_dir() {
        let dest = target.join("archive");
        fs::create_dir_all(&dest)?;
        let mut count = 0;
        for entry in fs::read_dir(&archive)? {
            let entry = entry?;
            if entry.file_type()?.is_dir() && entry.path().join("prd.md").exists() {
                let to = dest.join(entry.file_name());
                fs::create_dir_all(&to)?;
                copy_tree(&entry.path(), &to, &[])?;
                count += 1;
            }
        }
        if count > 0 {
            moved.push(format!("{} → archive/（{count} 個功能封存）", archive.display()));
            let prefix = format!("{}/", archive.strip_prefix(root).unwrap_or(&archive).to_string_lossy().replace('\\', "/"));
            let state = read_state(root);
            if let Some(rest) = state["prd"]["archive_dir"].as_str().and_then(|d| d.strip_prefix(prefix.as_str())) {
                let next = format!("archive/{rest}");
                update_state(root, move |s| s["prd"]["archive_dir"] = json!(next))?;
            }
        }
    }
    write_json(&marker, &json!({ "at": now_iso(), "from": root.to_string_lossy(), "moved": moved }))?;
    if !moved.is_empty() {
        append_log(root, "process", &format!("已把專案資料夾裡的舊資料搬到 {}：\n{}\n舊檔沒有刪除，確認後可以自行清理 {LEGACY_CONFIG}、{LEGACY_DIR}/、docs/aipipe/、docs/prd/ 與 docs/handovers/。", target.display(), moved.iter().map(|m| format!("- {m}")).collect::<Vec<_>>().join("\n")));
    }
    Ok(moved)
}
