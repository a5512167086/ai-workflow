//! AI 在流程中要求的工具權限（Claude CLI 的 can_use_tool 請求）。
//! 每個請求存成資料目錄 permissions/<id>.json，App 顯示允許／拒絕的對話框，使用者回答後
//! 執行中的流程程序讀到決定，再回覆給 CLI。流程程序與 App 是不同程序，所以用檔案交換。
use std::fs;
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant};

use serde_json::{json, Value};

use super::state::data_dir;
use super::util::{now_iso, read_json, write_json};
use super::{AppError, Result};

fn dir(root: &Path) -> PathBuf {
    data_dir(root).join("permissions")
}

fn file(root: &Path, id: &str) -> Result<PathBuf> {
    if uuid::Uuid::parse_str(id).is_err() { crate::bail!(400; "權限請求 id 不正確"); }
    Ok(dir(root).join(format!("{id}.json")))
}

/// 變更標記：App 的監看器看這個檔案的修改時間，有新請求或回答時立刻更新畫面。
pub fn marker(root: &Path) -> PathBuf {
    dir(root).join(".changed")
}

fn touch(root: &Path) {
    let _ = fs::create_dir_all(dir(root));
    let _ = fs::write(marker(root), now_iso());
}

/// 新增一個等待回答的請求，回傳 id。request 是 CLI 送來的 can_use_tool 內容。
pub fn create(root: &Path, scope: &str, label: &str, provider: &str, request: &Value) -> Result<String> {
    let id = uuid::Uuid::new_v4().to_string();
    fs::create_dir_all(dir(root))?;
    let entry = json!({
        "id": id, "scope": scope, "label": label, "provider": provider, "status": "pending", "created_at": now_iso(),
        "tool": request["tool_name"], "display_name": request["display_name"], "input": request["input"],
        "description": request["description"], "reason": request["decision_reason"],
        // CLI 建議的規則（例如 Bash「npm init *」），使用者選「這次執行都允許」時套用到這個 session。
        "suggestions": request["permission_suggestions"],
    });
    write_json(&file(root, &id)?, &entry)?;
    touch(root);
    Ok(id)
}

/// 使用者的回答：allow（這一次）、allow_session（這次執行都允許同類操作）、deny。只有還在等待的請求能回答。
pub fn answer(root: &Path, id: &str, decision: &str, message: &str) -> Result<Value> {
    if !["allow", "allow_session", "deny"].contains(&decision) { crate::bail!(400; "回答必須是 allow、allow_session 或 deny"); }
    let path = file(root, id)?;
    let mut entry = read_json(&path).ok_or_else(|| AppError::with_status(404, "找不到這個權限請求，可能已經逾時或執行已結束"))?;
    if entry["status"] != "pending" { crate::bail!(409; "這個權限請求已經處理過了"); }
    entry["status"] = json!(decision);
    entry["message"] = json!(message.chars().take(2000).collect::<String>());
    entry["answered_at"] = json!(now_iso());
    write_json(&path, &entry)?;
    touch(root);
    Ok(entry)
}

/// 流程程序等待回答。stop() 為 true（執行被取消或逾時）時放棄，視為拒絕。
pub fn wait(root: &Path, id: &str, stop: &dyn Fn() -> bool, timeout: Duration) -> Value {
    let started = Instant::now();
    loop {
        let entry = file(root, id).ok().and_then(read_json).unwrap_or(Value::Null);
        if entry.is_null() { return json!({ "status": "deny", "message": "權限請求已失效" }); }
        if entry["status"] != "pending" { return entry; }
        if stop() || started.elapsed() > timeout {
            let _ = expire(root, id, if stop() { "執行已結束" } else { "等待回答逾時" });
            return json!({ "status": "deny", "message": "沒有在時間內得到回答" });
        }
        std::thread::sleep(Duration::from_millis(300));
    }
}

fn expire(root: &Path, id: &str, why: &str) -> Result<()> {
    let path = file(root, id)?;
    if let Some(mut entry) = read_json(&path).filter(|e| e["status"] == "pending") {
        entry["status"] = json!("expired");
        entry["message"] = json!(why);
        write_json(&path, &entry)?;
        touch(root);
    }
    Ok(())
}

/// 執行結束時把同一個 scope 還沒回答的請求標成失效，App 就不會再顯示它。
pub fn expire_scope(root: &Path, scope: &str) {
    for entry in list(root) {
        if entry["scope"] == scope && entry["status"] == "pending" {
            if let Some(id) = entry["id"].as_str() { let _ = expire(root, id, "執行已結束"); }
        }
    }
}

fn list(root: &Path) -> Vec<Value> {
    let Ok(entries) = fs::read_dir(dir(root)) else { return vec![] };
    let mut out: Vec<Value> = entries.filter_map(|e| e.ok())
        .filter(|e| e.file_name().to_string_lossy().ends_with(".json"))
        .filter_map(|e| read_json(e.path()))
        .collect();
    out.sort_by(|a, b| a["created_at"].as_str().cmp(&b["created_at"].as_str()));
    out
}

/// 等待使用者回答的請求（最舊的在前）。
pub fn pending(root: &Path) -> Vec<Value> {
    list(root).into_iter().filter(|e| e["status"] == "pending").collect()
}

/// 把使用者的回答轉成 Claude CLI 的 control_response。allow_session 會把 CLI 建議的規則加到這個 session（不寫進專案的設定檔）。
pub fn claude_response(request_id: &str, input: &Value, entry: &Value) -> Value {
    let decision = entry["status"].as_str().unwrap_or("deny");
    let response = if decision == "allow" || decision == "allow_session" {
        let mut allow = json!({ "behavior": "allow", "updatedInput": input });
        if decision == "allow_session" {
            let rules: Vec<Value> = entry["suggestions"].as_array().into_iter().flatten().map(|s| {
                let mut s = s.clone();
                s["destination"] = json!("session");
                s
            }).collect();
            if !rules.is_empty() { allow["updatedPermissions"] = json!(rules); }
        }
        allow
    } else {
        let message = entry["message"].as_str().filter(|m| !m.trim().is_empty()).unwrap_or("使用者拒絕了這個操作");
        json!({ "behavior": "deny", "message": message })
    };
    json!({ "type": "control_response", "response": { "subtype": "success", "request_id": request_id, "response": response } })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 請求_回答_等待_失效的完整流程() {
        let root = super::super::util::temp_dir("permissions-");
        let request = json!({ "tool_name": "Bash", "input": { "command": "npm init -y" }, "description": "init", "permission_suggestions": [{ "type": "addRules", "rules": [{ "toolName": "Bash", "ruleContent": "npm init *" }], "behavior": "allow", "destination": "localSettings" }] });
        let id = create(&root, "task-1", "實作任務 1", "claude", &request).unwrap();
        assert_eq!(pending(&root).len(), 1);
        assert!(marker(&root).exists());
        assert_eq!(answer(&root, &id, "maybe", "").unwrap_err().status, 400);
        answer(&root, &id, "allow_session", "").unwrap();
        assert!(pending(&root).is_empty());
        assert_eq!(answer(&root, &id, "deny", "").unwrap_err().status, 409);
        let entry = wait(&root, &id, &|| false, Duration::from_secs(1));
        let response = claude_response("req-1", &request["input"], &entry);
        assert_eq!(response["response"]["request_id"], "req-1");
        assert_eq!(response["response"]["response"]["behavior"], "allow");
        assert_eq!(response["response"]["response"]["updatedInput"]["command"], "npm init -y");
        // 這次執行都允許：規則改成只存在這個 session，不寫進專案的設定檔。
        assert_eq!(response["response"]["response"]["updatedPermissions"][0]["destination"], "session");

        let id = create(&root, "task-1", "實作任務 1", "claude", &request).unwrap();
        answer(&root, &id, "deny", "請改用 pnpm").unwrap();
        let entry = wait(&root, &id, &|| false, Duration::from_secs(1));
        let response = claude_response("req-2", &request["input"], &entry);
        assert_eq!(response["response"]["response"], json!({ "behavior": "deny", "message": "請改用 pnpm" }));

        // 執行結束或取消：等待中的請求失效並視為拒絕，App 不再顯示。
        let id = create(&root, "task-2", "實作任務 2", "claude", &request).unwrap();
        let entry = wait(&root, &id, &|| true, Duration::from_secs(5));
        assert_eq!(entry["status"], "deny");
        let id = create(&root, "task-3", "實作任務 3", "claude", &request).unwrap();
        expire_scope(&root, "task-3");
        assert!(pending(&root).is_empty());
        assert_eq!(answer(&root, &id, "allow", "").unwrap_err().status, 409);
        assert_eq!(answer(&root, "not-a-uuid", "allow", "").unwrap_err().status, 400);
    }
}
