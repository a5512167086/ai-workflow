//! aipipe init（對應 legacy/src/init.js）：建立 .aipipe.json 與 context 範本。
use std::fs;
use std::path::Path;

use serde_json::{json, Value};

use super::config::{cfg_str, config_path, default_config, save_config, ROLES};
use super::git::{ensure_gitignore_entry, init_repo, is_git_repo};
use super::state::ensure_dirs;
use super::util::read_json;
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

const CONTEXT_TEMPLATE: &str = "# AI Context

給每個新 AI 對話讀的專案說明。請保持精簡、即時。

## 專案目的

## 技術棧與架構

## 重要慣例（命名、資料夾、測試方式）

## 不要做的事
";

const INDEX_TEMPLATE: &str = "# 專案索引

列出主要目錄與檔案的用途，讓 AI 快速找到要改的地方。

| 路徑 | 用途 |
| --- | --- |
";

#[derive(Default)]
pub struct InitOptions {
    pub force: bool,
    pub git_init: bool,
    pub mode: Option<String>,
    pub feature: Option<String>,
    /// author / reviewer / implementer / code_reviewer → claude | codex
    pub roles: Vec<(String, String)>,
}

pub struct InitResult {
    pub cfg: Value,
    pub created: Vec<String>,
    pub git_initialized: bool,
}

pub fn init_project(root: &Path, options: &InitOptions) -> Result<InitResult> {
    if config_path(root).exists() && !options.force {
        crate::bail!(".aipipe.json 已存在；要覆蓋請加 --force");
    }
    let mut git_initialized = false;
    if !is_git_repo(root)? {
        if !options.git_init {
            crate::bail!("目標目錄不是 git repo；加 --git-init 讓 aipipe 幫你 git init，或自己先 git init");
        }
        init_repo(root)?;
        git_initialized = true;
    }
    let mut cfg = default_config();
    cfg["commands"] = detect_commands(root);
    if let Some(mode) = &options.mode {
        cfg["mode"] = json!(mode);
    }
    for (role, provider) in &options.roles {
        if ROLES.contains(&role.as_str()) {
            cfg["roles"][role.as_str()] = json!(provider);
        }
    }
    if let Some(feature) = &options.feature {
        cfg["feature"] = json!(feature);
    }
    save_config(root, &cfg)?;

    ensure_dirs(root)?;
    ensure_gitignore_entry(root, ".aipipe/")?;
    let mut created = Vec::new();
    let files: Vec<&str> = cfg["context_files"].as_array().map(|a| a.iter().filter_map(Value::as_str).collect()).unwrap_or_default();
    for (rel, text) in files.iter().zip([CONTEXT_TEMPLATE, INDEX_TEMPLATE]) {
        let file = root.join(rel);
        if !rel.is_empty() && !file.exists() {
            if let Some(dir) = file.parent() {
                fs::create_dir_all(dir)?;
            }
            fs::write(&file, text)?;
            created.push(rel.to_string());
        }
    }
    if let Some(dir) = root.join(cfg_str(&cfg, "handover_path")).parent() {
        fs::create_dir_all(dir)?;
    }
    Ok(InitResult { cfg, created, git_initialized })
}
