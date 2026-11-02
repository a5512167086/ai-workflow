//! 設定分兩層，都放在 <home>（~/.ai-workflow）底下，專案資料夾裡沒有設定檔：
//! - 全域設定 <home>/config.json：角色、模型、執行環境、輪數、分支前綴、Skills 綁定、同時執行上限…所有專案共用。
//! - 專案欄位 <home>/projects/<id>/project.json：只有真正屬於專案的 build/test/lint 指令、feature、context_files。
//!
//! `load_config(root)` 回傳兩者合併後的結果，其餘程式碼照舊讀同一份 Value。
//! 設定以 serde_json::Value 保存，保留使用者手寫的其他欄位。
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{json, Value};

use crate::core::home::{app_home, with_lock};
use crate::core::state::data_dir;
use crate::core::util::{pretty, resolve, valid_skill_name, write_json};
use crate::core::{AppError, Result};

pub const GLOBAL_FILE: &str = "config.json";
pub const PROJECT_FILE: &str = "project.json";
/// 真正屬於專案的欄位；其他欄位都是全域設定。
pub const PROJECT_KEYS: [&str; 3] = ["commands", "feature", "context_files"];
pub const ROLES: [&str; 9] = ["interviewer", "author", "reviewer", "task_planner", "implementer", "fixer", "code_reviewer", "handover", "chat"];
pub const PROVIDERS: [&str; 2] = ["claude", "codex"];
pub const MODES: [&str; 2] = ["auto", "manual"];
pub const CLI_NAMES: [&str; 2] = ["claude", "codex"];
pub const RUNTIMES: [&str; 3] = ["auto", "windows", "wsl"];
pub const SKILL_STAGES: [&str; 7] = ["prd", "prd_review", "tasks", "implement", "code_review", "fix", "handover"];

/// 專案欄位的預設值。context_files 預設為空：使用者可以填專案裡既有檔案的路徑（相對於專案或絕對路徑）。
pub fn default_project() -> Value {
    json!({
        "feature": "",
        "commands": { "build": "", "test": "", "lint": "" },
        "context_files": [],
    })
}

pub fn default_global() -> Value {
    json!({
        "mode": "manual",
        "skills": { "prd": [], "prd_review": [], "tasks": [], "implement": [], "code_review": [], "fix": [], "handover": [] },
        // reviewer／code_reviewer 可以是 both：Claude 與 Codex 各審一次，兩份都通過才算通過。
        "roles": { "interviewer": "claude", "author": "claude", "reviewer": "codex", "task_planner": "claude", "implementer": "claude", "fixer": "claude", "code_reviewer": "codex", "handover": "claude", "chat": "claude" },
        // 每個角色、每個 AI 的模型與推理強度；空字串＝沿用 claude.model／codex.model（再空就是 CLI 預設）。
        "models": default_models(),
        "max_fix_rounds": 3,
        "max_prd_rounds": 2,
        "num_tasks": 0,
        "command_timeout_sec": 900,
        "agent_timeout_sec": 1800,
        "branch_prefix": "ai-workflow/",
        // 所有專案的 run 同時最多幾個在跑。
        "max_concurrent_runs": 1,
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
            // 實作者與修正者的權限模式。auto：由 Claude Code 的安全分類器放行一般開發指令（npm install、建專案、跑測試）；
            // acceptEdits：只有編輯檔案自動允許。兩種模式下沒有自動允許的操作都會在 App 跳出對話框問使用者。
            "write_permission_mode": "auto",
            // 額外預先允許、不必再問的工具，例如 "Bash(npm test:*)"。
            "allowed_tools": []
        },
        "codex": {
            "model": "",
            "effort": "",
            // Windows 上 Codex 需要 windows.sandbox 才會真的啟用 workspace-write，否則會默默降成 read-only。
            "windows_sandbox": if cfg!(windows) { "elevated" } else { "" },
            // 實作者與修正者在 workspace-write 沙箱裡可以連網（npm install、下載套件）；關掉時只能用已安裝的套件。
            "network_access": true,
            // 寫入角色的核准政策：on-request（沙箱內直接執行，超出沙箱才問你）、untrusted（只有已知安全的指令直接執行）、never（不問，超出就失敗）。
            "approval_policy": "on-request"
        }
    })
}

/// 全域＋專案欄位的完整預設值（測試與沒有專案時使用）。
pub fn default_config() -> Value {
    deep_merge(&default_global(), &default_project())
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

pub fn global_config_path() -> PathBuf {
    app_home().join(GLOBAL_FILE)
}

pub fn project_config_path(root: &Path) -> PathBuf {
    data_dir(root).join(PROJECT_FILE)
}

/// 專案是否已登錄（有 project.json）。
pub fn project_registered(root: &Path) -> bool {
    project_config_path(root).exists()
}

fn int_in(value: Option<&Value>, lo: i64, hi: i64) -> bool {
    value.and_then(Value::as_i64).is_some_and(|n| (lo..=hi).contains(&n)) && value.is_some_and(|v| v.is_i64() || v.is_u64())
}

/// 檢查合併後的設定。
pub fn validate_config(cfg: &Value) -> Vec<String> {
    let mut errors = Vec::new();
    let s = |k: &str| cfg.get(k).and_then(Value::as_str);
    if !s("mode").is_some_and(|m| MODES.contains(&m)) {
        errors.push(format!("mode 必須是 {}", MODES.join(" / ")));
    }
    if !cfg["claude"]["write_permission_mode"].as_str().is_none_or(|m| ["auto", "acceptEdits"].contains(&m)) {
        errors.push("claude.write_permission_mode 必須是 auto / acceptEdits".into());
    }
    if !cfg["codex"]["approval_policy"].as_str().is_none_or(|p| ["on-request", "untrusted", "never"].contains(&p)) {
        errors.push("codex.approval_policy 必須是 on-request / untrusted / never".into());
    }
    if !cfg["codex"]["network_access"].is_null() && !cfg["codex"]["network_access"].is_boolean() {
        errors.push("codex.network_access 必須是 true / false".into());
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
    if cfg.get("max_concurrent_runs").is_some_and(|v| !int_in(Some(v), 1, 8)) {
        errors.push("max_concurrent_runs 必須是 1–8 的整數".into());
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
    if cfg.get("context_files").is_some_and(|v| !v.as_array().is_some_and(|a| a.iter().all(|f| f.as_str().is_some_and(|s| !s.trim().is_empty())))) {
        errors.push("context_files 必須是檔案路徑陣列".into());
    }
    errors
}

fn read_raw(file: &Path) -> Result<Value> {
    let text = fs::read_to_string(file)?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).map_err(|e| AppError::new(format!("{} 不是合法的 JSON：{e}", file.display())))
}

fn read_raw_or_empty(file: &Path) -> Result<Value> {
    if file.exists() { read_raw(file) } else { Ok(json!({})) }
}

/// 舊版共用作者／實作者設定；拆開後先沿用，避免升級改掉使用者選擇。
fn apply_role_fallbacks(cfg: &mut Value, raw: &Value) {
    for (role, previous) in [("interviewer", "author"), ("task_planner", "author"), ("fixer", "implementer"), ("handover", "implementer"), ("chat", "author")] {
        if raw["roles"][role].is_null() { cfg["roles"][role] = cfg["roles"][previous].clone(); }
        if raw["models"][role].is_null() { cfg["models"][role] = cfg["models"][previous].clone(); }
    }
}

/// 全域設定（預設值＋ config.json）。
pub fn load_global() -> Result<Value> {
    let raw = read_raw_or_empty(&global_config_path())?;
    let mut cfg = deep_merge(&default_global(), &raw);
    apply_role_fallbacks(&mut cfg, &raw);
    let errors = validate_config(&deep_merge(&cfg, &default_project()));
    if !errors.is_empty() {
        crate::bail!("{} 設定錯誤：\n- {}", global_config_path().display(), errors.join("\n- "));
    }
    Ok(cfg)
}

/// 只改全域設定裡的幾個欄位，保留其餘內容；回傳更新後的全域設定。
pub fn patch_global(patch: &Value) -> Result<Value> {
    with_lock("config", || {
        let file = global_config_path();
        let raw = read_raw_or_empty(&file)?;
        let next = deep_merge(&raw, patch);
        let errors = validate_config(&deep_merge(&default_config(), &next));
        if !errors.is_empty() {
            crate::bail!("{}", errors.join("; "));
        }
        write_json(&file, &next)?;
        load_global()
    })
}

/// 專案欄位（project.json 原始內容；測試可以放全域欄位的覆寫）。
pub fn load_project(root: &Path) -> Result<Value> {
    read_raw_or_empty(&project_config_path(root))
}

/// 寫入 project.json（整份覆蓋）。
pub fn save_project(root: &Path, fields: &Value) -> Result<()> {
    let errors = validate_config(&deep_merge(&default_config(), fields));
    if !errors.is_empty() {
        crate::bail!("{}", errors.join("; "));
    }
    write_json(&project_config_path(root), fields)
}

/// 全域設定 ＋ 該專案的欄位。專案沒登錄時報錯。
pub fn load_config(root: &Path) -> Result<Value> {
    if !project_registered(root) {
        crate::bail!("{} 還沒加入 ai-workflow，請先執行 ai-workflow projects add，或在總覽加入專案", root.display());
    }
    let project = load_project(root)?;
    let cfg = deep_merge(&deep_merge(&load_global()?, &default_project()), &project);
    let errors = validate_config(&cfg);
    if !errors.is_empty() {
        crate::bail!("{} 設定錯誤：\n- {}", project_config_path(root).display(), errors.join("\n- "));
    }
    Ok(cfg)
}

/// 專案沒登錄時用全域設定＋專案欄位預設值（doctor 等不需要專案的場合）。
pub fn load_config_or_default(root: &Path) -> Result<Value> {
    if project_registered(root) { load_config(root) } else { Ok(deep_merge(&load_global()?, &default_project())) }
}

/// 把整份設定存成這個專案的 project.json。只有測試會這樣用：讓每個測試專案有自己獨立的角色與 CLI 設定；
/// 正式流程的 UI／CLI 透過 patch_config 把全域欄位寫進 config.json。
pub fn save_config(root: &Path, cfg: &Value) -> Result<()> {
    let mut fields = cfg.clone();
    for key in ["_run_provider", "_reference_ids", "_visual_reference_ids"] {
        if let Some(map) = fields.as_object_mut() { map.remove(key); }
    }
    save_project(root, &fields)
}

/// 只改單一欄位（例如 UI 切換模式）：專案欄位寫進 project.json，其餘寫進全域 config.json。
pub fn patch_config(root: &Path, patch: &Value) -> Result<Value> {
    let mut global = json!({});
    let mut project = json!({});
    for (k, v) in patch.as_object().into_iter().flatten() {
        if PROJECT_KEYS.contains(&k.as_str()) { project[k] = v.clone(); } else { global[k] = v.clone(); }
    }
    if global.as_object().is_some_and(|m| !m.is_empty()) {
        patch_global(&global)?;
    }
    if project.as_object().is_some_and(|m| !m.is_empty()) {
        let next = deep_merge(&load_project(root)?, &project);
        save_project(root, &next)?;
    }
    load_config(root)
}

/// 從目前目錄往上找已登錄在 projects.json 的專案，找不到就回傳起點（之後 load_config 會提示先加入專案）。
pub fn find_project_root(start: &Path) -> PathBuf {
    let start = resolve(start);
    let mut dir = start.as_path();
    loop {
        if crate::core::projects::find_project_by_path(dir).is_some() {
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

/// 給 UI 看的全域設定原文。
pub fn global_config_text() -> String {
    read_raw_or_empty(&global_config_path()).map(|v| pretty(&v)).unwrap_or_default()
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
        bad["max_concurrent_runs"] = json!(9);
        bad["context_files"] = json!(["ok", 3]);
        assert!(validate_config(&bad).len() >= 6);
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
    fn 全域設定與專案欄位分開存_合併後給其餘程式使用() {
        let root = crate::core::util::temp_dir("config-split-");
        assert!(load_config(&root).unwrap_err().message.contains("projects add"));
        save_project(&root, &json!({ "commands": { "test": "npm test" }, "feature": "csv" })).unwrap();
        patch_config(&root, &json!({ "mode": "auto", "feature": "export", "roles": { "author": "codex" } })).unwrap();
        let cfg = load_config(&root).unwrap();
        assert_eq!(cfg["mode"], "auto");
        assert_eq!(cfg["feature"], "export");
        assert_eq!(cfg["commands"]["test"], "npm test");
        assert_eq!(cfg["roles"]["author"], "codex");
        // 全域欄位不會寫進 project.json；專案欄位不會寫進全域設定。
        let project = load_project(&root).unwrap();
        assert!(project.get("mode").is_none() && project.get("roles").is_none());
        let global = read_raw(&global_config_path()).unwrap();
        assert!(global.get("feature").is_none() && global.get("commands").is_none());
        assert_eq!(global["mode"], "auto");
        assert_eq!(fs::read_dir(&root).unwrap().count(), 0, "專案資料夾不能有設定檔");
        // 另一個專案看到同一份全域設定。
        let other = crate::core::util::temp_dir("config-split-other-");
        save_project(&other, &json!({})).unwrap();
        assert_eq!(load_config(&other).unwrap()["roles"]["author"], "codex");
        assert_eq!(load_config(&other).unwrap()["feature"], "");
        patch_global(&json!({ "mode": "manual", "roles": { "author": "claude" } })).unwrap();
    }

    #[test]
    fn 舊角色設定拆開後沿用_新角色可各自覆寫() {
        let root = crate::core::util::temp_dir("role-upgrade-");
        save_config(&root, &json!({ "roles": { "interviewer": "claude", "author": "codex", "implementer": "codex" }, "models": { "author": { "codex": { "model": "a", "effort": "high" } }, "implementer": { "codex": { "model": "b", "effort": "low" } } } })).unwrap();
        let cfg = load_config(&root).unwrap();
        // project.json 的覆寫只套用寫到的角色；沒寫到的角色沿用全域預設（這裡是預設值）。
        assert_eq!(cfg["roles"]["author"], "codex");
        assert_eq!(model_for(&cfg, Some("author"), "codex").0, "a");
        assert_eq!(model_for(&cfg, Some("fixer"), "codex").0, "");
        // 全域 config.json 裡只有舊角色時，新角色沿用舊設定。
        let mut raw = json!({ "roles": { "author": "codex", "implementer": "codex" }, "models": { "author": { "codex": { "model": "ga" } }, "implementer": { "codex": { "model": "gb", "effort": "low" } } } });
        let mut global = deep_merge(&default_global(), &raw);
        apply_role_fallbacks(&mut global, &raw);
        assert_eq!(global["roles"]["task_planner"], "codex");
        assert_eq!(model_for(&global, Some("task_planner"), "codex").0, "ga");
        assert_eq!(model_for(&global, Some("handover"), "codex").1, "low");
        raw["roles"]["fixer"] = json!("claude");
        let mut global = deep_merge(&default_global(), &raw);
        apply_role_fallbacks(&mut global, &raw);
        assert_eq!(global["roles"]["fixer"], "claude");
        assert_eq!(model_for(&global, Some("fixer"), "codex").0, "gb");
    }
}
