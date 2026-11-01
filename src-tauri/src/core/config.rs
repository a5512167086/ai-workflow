//! .aipipe.json（對應 legacy/src/config.js）。設定以 serde_json::Value 保存，保留使用者手寫的其他欄位。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use super::util::{pretty, resolve, valid_skill_name};
use super::{AppError, Result};

pub const CONFIG_FILE: &str = ".aipipe.json";
pub const ROLES: [&str; 7] = ["author", "reviewer", "task_planner", "implementer", "fixer", "code_reviewer", "handover"];
pub const PROVIDERS: [&str; 2] = ["claude", "codex"];
pub const MODES: [&str; 2] = ["auto", "manual"];
pub const CLI_NAMES: [&str; 2] = ["claude", "codex"];
pub const RUNTIMES: [&str; 3] = ["auto", "windows", "wsl"];
pub const SKILL_STAGES: [&str; 7] = ["prd", "prd_review", "tasks", "implement", "code_review", "fix", "handover"];

pub fn default_config() -> Value {
    json!({
        "mode": "manual",
        "feature": "",
        "commands": { "build": "", "test": "", "lint": "" },
        "context_files": ["docs/ai-context.md", "docs/index.md"],
        "handover_path": "docs/handovers/current_handover.md",
        "prd_path": "docs/aipipe/prd.md",
        "skills": { "prd": [], "prd_review": [], "tasks": [], "implement": [], "code_review": [], "fix": [], "handover": [] },
        // 需求待辦清單與功能封存，都放在專案裡可以 commit。
        "backlog_path": "docs/aipipe/backlog.json",
        "archive_dir": "docs/prd",
        // reviewer／code_reviewer 可以是 both：Claude 與 Codex 各審一次，兩份都通過才算通過。
        "roles": { "author": "claude", "reviewer": "codex", "task_planner": "claude", "implementer": "claude", "fixer": "claude", "code_reviewer": "codex", "handover": "claude" },
        // 每個角色、每個 AI 的模型與推理強度；空字串＝沿用 claude.model／codex.model（再空就是 CLI 預設）。
        // 依實際執行的 AI 取用，所以單 AI 模式或額度切換時也會套用對應的設定。
        "models": default_models(),
        "max_fix_rounds": 3,
        "max_prd_rounds": 2,
        "num_tasks": 0,
        "command_timeout_sec": 900,
        "agent_timeout_sec": 1800,
        "branch_prefix": "aipipe/",
        // 每個 CLI 在 Windows 原生（windows）或 WSL（wsl）執行；auto 依專案路徑判斷。
        "runtime": { "claude": "auto", "codex": "auto" },
        // 空字串＝WSL 預設發行版。
        "wsl_distro": "",
        // runtime 為 wsl 時在 WSL 裡執行的指令名稱或路徑；空字串＝claude / codex。
        "wsl_cli": { "claude": "", "codex": "" },
        // runtime 為 windows 時使用。空字串代表從 PATH 尋找；Windows 上可填 .exe 或 .cmd 的完整路徑。
        "cli": { "claude": "", "codex": "" },
        "claude": {
            "model": "",
            "effort": "",
            // 實作者在 -p 模式下額外允許的工具，例如 "Bash(npm test:*)"；預設只允許編輯。
            "allowed_tools": []
        },
        "codex": {
            "model": "",
            "effort": "",
            // Windows 上 Codex 需要 windows.sandbox 才會真的啟用 workspace-write，否則會默默降成 read-only。
            "windows_sandbox": if cfg!(windows) { "elevated" } else { "" }
        }
    })
}

fn default_models() -> Value {
    let pair = || json!({ "claude": { "model": "", "effort": "" }, "codex": { "model": "", "effort": "" } });
    Value::Object(ROLES.iter().map(|r| (r.to_string(), pair())).collect())
}

/// 可以設成 both（雙人審查）的角色。
pub const REVIEW_ROLES: [&str; 2] = ["reviewer", "code_reviewer"];

/// 角色實際要跑的 AI：both 展開成兩個。
pub fn role_providers(cfg: &Value, role: &str) -> Vec<String> {
    match cfg["roles"][role].as_str().unwrap_or("claude") {
        "both" => PROVIDERS.iter().map(|p| p.to_string()).collect(),
        p => vec![p.to_string()],
    }
}

/// 某個角色用某個 AI 時的 (模型, 推理強度)；角色沒設定就用該 AI 的全域設定。
pub fn model_for(cfg: &Value, role: Option<&str>, provider: &str) -> (String, String) {
    let pick = |key: &str| {
        role.and_then(|r| cfg["models"][r][provider][key].as_str()).filter(|s| !s.is_empty())
            .or(cfg[provider][key].as_str()).unwrap_or("").to_string()
    };
    (pick("model"), pick("effort"))
}

/// 模型名稱與推理強度只允許安全字元（會變成 CLI 參數）。
fn safe_token(v: &str) -> bool {
    v.chars().all(|c| c.is_ascii_alphanumeric() || "._:-[]/".contains(c))
}

/// 物件遞迴合併，其他型別（含陣列）直接覆蓋。
pub fn deep_merge(base: &Value, extra: &Value) -> Value {
    let mut out = base.clone();
    if let (Some(out_map), Some(extra_map)) = (out.as_object_mut(), extra.as_object()) {
        for (k, v) in extra_map {
            let merged = match out_map.get(k) {
                Some(b) if b.is_object() && v.is_object() => deep_merge(b, v),
                _ => v.clone(),
            };
            out_map.insert(k.clone(), merged);
        }
        return out;
    }
    if extra.is_object() { extra.clone() } else { out }
}

pub fn config_path(root: &Path) -> PathBuf {
    root.join(CONFIG_FILE)
}

fn is_relative_inside(v: &str) -> bool {
    !v.is_empty() && !Path::new(v).is_absolute() && !v.starts_with('/') && !v.starts_with('\\') && !v.split(['/', '\\']).any(|p| p == "..")
        && !(v.len() > 1 && v.as_bytes()[1] == b':')
}

fn int_in(value: Option<&Value>, lo: i64, hi: i64) -> bool {
    value.and_then(Value::as_i64).is_some_and(|n| (lo..=hi).contains(&n)) && value.is_some_and(|v| v.is_i64() || v.is_u64())
}

pub fn validate_config(cfg: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let s = |k: &str| cfg.get(k).and_then(Value::as_str);
    if !s("mode").is_some_and(|m| MODES.contains(&m)) {
        errors.push(format!("mode 必須是 {}", MODES.join(" / ")));
    }
    for role in ROLES {
        let review = REVIEW_ROLES.contains(&role);
        if !cfg["roles"].get(role).and_then(Value::as_str).is_some_and(|p| PROVIDERS.contains(&p) || (review && p == "both")) {
            errors.push(format!("roles.{role} 必須是 {}{}", PROVIDERS.join(" / "), if review { " / both" } else { "" }));
        }
        for provider in PROVIDERS {
            for key in ["model", "effort"] {
                let v = &cfg["models"][role][provider][key];
                if !(v.is_null() || v.as_str().is_some_and(safe_token)) {
                    errors.push(format!("models.{role}.{provider}.{key} 格式不正確"));
                }
            }
        }
    }
    for provider in PROVIDERS {
        for key in ["model", "effort"] {
            if !cfg[provider][key].as_str().is_none_or(safe_token) {
                errors.push(format!("{provider}.{key} 格式不正確"));
            }
        }
    }
    for key in ["max_fix_rounds", "max_prd_rounds"] {
        if !int_in(cfg.get(key), 1, 10) {
            errors.push(format!("{key} 必須是 1–10 的整數"));
        }
    }
    match cfg.get("skills").and_then(Value::as_object) {
        None => errors.push("skills 必須是階段與技能名稱陣列的物件".into()),
        Some(map) => {
            for (stage, names) in map {
                let ok = SKILL_STAGES.contains(&stage.as_str())
                    && names.as_array().is_some_and(|a| a.iter().all(|n| n.as_str().is_some_and(valid_skill_name)));
                if !ok {
                    errors.push(format!("skills.{stage} 必須是 Skill 名稱陣列"));
                }
            }
        }
    }
    for name in CLI_NAMES {
        if !cfg["runtime"].get(name).and_then(Value::as_str).is_some_and(|r| RUNTIMES.contains(&r)) {
            errors.push(format!("runtime.{name} 必須是 {}", RUNTIMES.join(" / ")));
        }
    }
    if !s("wsl_distro").is_some_and(|d| d.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '_' | '.' | '-'))) {
        errors.push("wsl_distro 只能包含英數字、底線、點與連字號".into());
    }
    for key in ["backlog_path", "archive_dir"] {
        if !s(key).is_some_and(is_relative_inside) {
            errors.push(format!("{key} 必須是專案內的相對路徑"));
        }
    }
    errors
}

fn read_raw(file: &Path) -> Result<Value> {
    let text = fs::read_to_string(file)?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| AppError::new(format!("{CONFIG_FILE} 不是合法的 JSON：{e}")))
}

pub fn load_config(root: &Path) -> Result<Value> {
    let file = config_path(root);
    if !file.exists() {
        crate::bail!("找不到 {CONFIG_FILE}，請先在專案根目錄執行 aipipe init");
    }
    let raw = read_raw(&file)?;
    let mut cfg = deep_merge(&default_config(), &raw);
    // 舊版共用作者／實作者設定；拆開後先沿用，避免升級改掉使用者選擇。
    for (role, previous) in [("task_planner", "author"), ("fixer", "implementer"), ("handover", "implementer")] {
        if raw["roles"][role].is_null() { cfg["roles"][role] = cfg["roles"][previous].clone(); }
        if raw["models"][role].is_null() { cfg["models"][role] = cfg["models"][previous].clone(); }
    }
    let errors = validate_config(&cfg);
    if !errors.is_empty() {
        crate::bail!("{CONFIG_FILE} 設定錯誤：\n- {}", errors.join("\n- "));
    }
    Ok(cfg)
}

/// loadConfig(root, { required: false })。
pub fn load_config_or_default(root: &Path) -> Result<Value> {
    if config_path(root).exists() { load_config(root) } else { Ok(default_config()) }
}

pub fn save_config(root: &Path, cfg: &Value) -> Result<()> {
    let errors = validate_config(cfg);
    if !errors.is_empty() {
        crate::bail!("{}", errors.join("; "));
    }
    fs::write(config_path(root), pretty(cfg) + "\n")?;
    Ok(())
}

/// 只改單一欄位（例如 UI 切換模式），保留使用者手寫的其餘內容。
pub fn patch_config(root: &Path, patch: &Value) -> Result<Value> {
    let file = config_path(root);
    let raw = if file.exists() { read_raw(&file)? } else { json!({}) };
    let next = deep_merge(&raw, patch);
    let errors = validate_config(&deep_merge(&default_config(), &next));
    if !errors.is_empty() {
        crate::bail!("{}", errors.join("; "));
    }
    fs::write(&file, pretty(&next) + "\n")?;
    load_config(root)
}

/// 從目前目錄往上找含 .aipipe.json 的目錄，找不到就回傳起點。
pub fn find_project_root(start: &Path) -> PathBuf {
    let start = resolve(start);
    let mut dir = start.as_path();
    loop {
        if dir.join(CONFIG_FILE).exists() {
            return dir.to_path_buf();
        }
        match dir.parent() {
            Some(parent) => dir = parent,
            None => return start,
        }
    }
}

/// 常用欄位的讀取捷徑。
pub fn cfg_str<'a>(cfg: &'a Value, key: &str) -> &'a str {
    cfg.get(key).and_then(Value::as_str).unwrap_or("")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_config_檢查角色_模式_輪數() {
        assert!(validate_config(&default_config()).is_empty());
        let mut bad = default_config();
        bad["mode"] = json!("x");
        bad["max_fix_rounds"] = json!(0);
        bad["roles"] = json!({ "author": "gpt" });
        assert!(validate_config(&bad).len() >= 4);
    }

    #[test]
    fn backlog_path_與_archive_dir_必須是專案內相對路徑() {
        let mut c = default_config();
        c["archive_dir"] = json!("../out");
        assert!(!validate_config(&c).is_empty());
        let mut c = default_config();
        c["backlog_path"] = json!("C:\\abs\\b.json");
        assert!(!validate_config(&c).is_empty());
    }

    #[test]
    fn 角色模型_both_與格式檢查() {
        let mut cfg = default_config();
        cfg["claude"]["model"] = json!("sonnet");
        cfg["models"]["implementer"]["claude"] = json!({ "model": "opus", "effort": "high" });
        assert_eq!(model_for(&cfg, Some("implementer"), "claude"), ("opus".into(), "high".into()));
        assert_eq!(model_for(&cfg, Some("reviewer"), "claude"), ("sonnet".into(), "".into()));
        assert_eq!(model_for(&cfg, None, "codex"), ("".into(), "".into()));
        cfg["roles"]["code_reviewer"] = json!("both");
        assert!(validate_config(&cfg).is_empty());
        assert_eq!(role_providers(&cfg, "code_reviewer"), ["claude", "codex"]);
        cfg["roles"]["implementer"] = json!("both");
        cfg["models"]["author"]["codex"]["model"] = json!("x; rm -rf");
        let errors = validate_config(&cfg);
        assert!(errors.iter().any(|e| e.starts_with("roles.implementer")));
        assert!(errors.iter().any(|e| e.starts_with("models.author.codex.model")));
    }

    #[test]
    fn deep_merge_遞迴合併物件但覆蓋陣列() {
        let merged = deep_merge(&json!({ "a": { "x": 1, "y": [1] } }), &json!({ "a": { "y": [2] }, "b": 1 }));
        assert_eq!(merged, json!({ "a": { "x": 1, "y": [2] }, "b": 1 }));
    }

    #[test]
    fn 舊角色設定拆開後沿用_新角色可各自覆寫() {
        let root = super::super::util::temp_dir("role-upgrade-");
        fs::write(config_path(&root), json!({ "roles": { "author": "codex", "implementer": "codex" }, "models": { "author": { "codex": { "model": "a", "effort": "high" } }, "implementer": { "codex": { "model": "b", "effort": "low" } } } }).to_string()).unwrap();
        let cfg = load_config(&root).unwrap();
        assert_eq!(cfg["roles"]["task_planner"], "codex");
        assert_eq!(model_for(&cfg, Some("task_planner"), "codex").0, "a");
        assert_eq!(model_for(&cfg, Some("fixer"), "codex").0, "b");
        assert_eq!(model_for(&cfg, Some("handover"), "codex").1, "low");
        let cfg = patch_config(&root, &json!({ "roles": { "fixer": "claude" }, "models": { "handover": { "codex": { "model": "c" } } } })).unwrap();
        assert_eq!(cfg["roles"]["fixer"], "claude");
        assert_eq!(model_for(&cfg, Some("handover"), "codex").0, "c");
        assert_eq!(model_for(&cfg, Some("implementer"), "codex").0, "b");
    }
}
