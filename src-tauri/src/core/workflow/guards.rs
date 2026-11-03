//! 防呆規則：依目前的流程狀態判斷每個操作現在能不能做，不能做時給出原因。
//!
//! 同一份規則同時給後端與前端用：API 收到請求時用 `check` 擋下並回傳原因（409），
//! 專案狀態（snapshot）帶上 `guards`、需求待辦的每一項帶上 `lock`，前端據此停用按鈕並把原因放在提示文字。
//! 規則只看 snapshot（狀態檔、任務、PRD）與需求本身，不讀其他檔案，所以前後端看到的結果一致。
use serde_json::{json, Map, Value};

use crate::core::{AppError, Result};

/// 有 AI 流程正在執行時的原因（與舊的 busy_guard 相同的判斷順序）。
fn busy(snap: &Value) -> Option<String> {
    [("skillBusy", "Skill 執行中，請等它結束"), ("runnerAlive", "流程執行中，請等目前任務結束或先暫停"), ("prdBusy", "PRD 正在起草或審查，請等它結束"), ("taskGenBusy", "任務產生中，請等它結束")]
        .iter().find(|(key, _)| snap[*key] == true).map(|(_, why)| why.to_string())
}

fn task_started(task: &Value) -> bool {
    task["status"].as_str().is_some_and(|s| s != "pending")
        || task["subtasks"].as_array().into_iter().flatten().any(|t| t["status"].as_str().is_some_and(|s| s != "pending"))
}

/// 依序檢查，回傳第一個不能做的原因。
fn first(reasons: &[Option<String>]) -> Value {
    reasons.iter().flatten().next().map(|r| json!(r)).unwrap_or(Value::Null)
}

fn when(cond: bool, why: &str) -> Option<String> {
    cond.then(|| why.to_string())
}

/// 專案層級的操作：值是原因字串（不能做）或 null（可以做）。
pub fn project(snap: &Value) -> Value {
    let state = &snap["state"];
    let prd_status = state["prd"]["status"].as_str().unwrap_or("none");
    let busy = busy(snap);
    let no_prd = when(!snap["prd"].as_str().is_some_and(|s| !s.trim().is_empty()), "還沒有 PRD");
    let tasks = snap["tasks"].as_array().cloned().unwrap_or_default();
    let no_tasks = when(tasks.is_empty(), "還沒有任務");
    let complete = when(state["pipeline"]["status"] == "complete", "這個功能已完成並封存；要再修改請從需求待辦開始新的需求");
    let started = when(tasks.iter().any(task_started), "已有任務開始執行，PRD 不能再改；要調整範圍請人工編輯任務，或從需求待辦開始新的需求");
    let not_approved = when(prd_status != "approved", "請先核准 PRD");
    let approved_tasks = !tasks.is_empty() && snap["taskRevision"].is_string() && snap["taskRevision"] == state["task_approval"]["revision"];
    let mut out = Map::new();
    out.insert("prd.edit".into(), first(&[busy.clone(), no_prd.clone(), complete.clone(), started.clone()]));
    out.insert("prd.revise".into(), first(&[busy.clone(), no_prd.clone(), complete.clone(), started.clone()]));
    out.insert("prd.review".into(), first(&[busy.clone(), no_prd.clone(), complete.clone(), when(prd_status != "awaiting_approval", "PRD 只有在等待核准時需要重新審查")]));
    out.insert("prd.approve".into(), first(&[busy.clone(), no_prd, when(prd_status != "awaiting_approval", "PRD 目前不是等待核准")]));
    out.insert("prd.references".into(), first(&[busy.clone(), complete.clone()]));
    out.insert("tasks.generate".into(), first(&[busy.clone(), not_approved.clone(), complete.clone(), when(tasks.iter().any(task_started), "已有任務開始執行，重新產生會丟掉目前的進度")]));
    out.insert("tasks.approve".into(), first(&[busy.clone(), no_tasks.clone(), not_approved.clone(), complete.clone(), when(approved_tasks, "任務已核准")]));
    out.insert("tasks.references".into(), first(&[busy.clone(), when(tasks.is_empty(), "拆任務前的參考資料請加在 PRD 或需求待辦"), complete.clone()]));
    out.insert("task.edit".into(), first(&[busy.clone(), no_tasks.clone(), complete.clone()]));
    out.insert("task.rerun".into(), first(&[busy.clone(), no_tasks.clone(), complete.clone()]));
    out.insert("run.start".into(), first(&[busy.clone(), no_tasks, not_approved, complete, when(!approved_tasks, "請先檢視並核准任務")]));
    out.insert("project.settings".into(), first(&[when(snap["runnerAlive"] == true, "流程執行中，暫停或結束後再修改驗證指令")]));
    // 需求釐清會議本身是唯讀對話，流程執行中也能進行；用確認過的需求開始寫 PRD 才要等流程結束。
    out.insert("backlog.draft".into(), first(&[busy]));
    Value::Object(out)
}

/// 單一任務的參考資料：已完成的任務不再加參考。
pub fn task_references(snap: &Value, task: &Value) -> Option<String> {
    if let Some(why) = project(snap)["tasks.references"].as_str() { return Some(why.to_string()); }
    when(task["status"] == "done", "這個任務已完成，參考資料不會再被使用")
}

/// 需求待辦的一項：已產生目前 PRD 或功能已完成的需求，不能再編輯、刪除、改參考或重新釐清（排序不受影響）。
pub fn backlog_item(state: &Value, item: &Value) -> Option<String> {
    match item["status"].as_str() {
        Some("done") => Some("這項需求的功能已完成，不能再修改".into()),
        Some("in_progress") if state["prd"]["backlog_id"] == item["id"] && state["prd"]["status"].as_str().is_some_and(|s| s != "none") =>
            Some("這項需求已產生目前的 PRD，不能再修改或重新釐清；要調整請到 PRD 頁人工編輯或要求再改".into()),
        _ => None,
    }
}

/// 「接受目前結果」：只給因為審查未通過而卡住、驗證有通過的任務用；接受後重新驗證，通過就跳過審查進入人工驗收。
pub fn task_accept(snap: &Value, id: &str) -> Option<String> {
    if let Some(why) = busy(snap) { return Some(why); }
    let t = &snap["state"]["tasks"][id];
    if t["phase"] != "stuck" { return Some("只有卡住的任務可以接受目前結果".into()); }
    if !t["review_verdict"].as_str().is_some_and(|v| !["PASS", "APPROVE", "ACCEPTED"].contains(&v)) {
        return Some("這個任務不是因為審查未通過而卡住，請按「繼續」或重新執行".into());
    }
    if t["last_check_ok"] == false { return Some("驗證指令沒有通過，請先修好或重新執行".into()); }
    None
}

/// API 用：不能做就回 409 與原因。
pub fn check(snap: &Value, action: &str) -> Result<()> {
    match project(snap)[action].as_str() {
        Some(why) => Err(AppError::with_status(409, why)),
        None => Ok(()),
    }
}

pub fn check_backlog(state: &Value, item: &Value) -> Result<()> {
    match backlog_item(state, item) {
        Some(why) => Err(AppError::with_status(409, why)),
        None => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snap(prd_status: &str, pipeline: &str, tasks: Value) -> Value {
        json!({ "prd": "# PRD", "tasks": tasks, "taskRevision": "r1", "runnerAlive": false, "prdBusy": false, "taskGenBusy": false, "skillBusy": false,
            "state": { "prd": { "status": prd_status, "backlog_id": "b1" }, "pipeline": { "status": pipeline }, "task_approval": null } })
    }

    #[test]
    fn 依流程階段決定能做的事() {
        // 等待核准：可以編輯、審查、核准；還不能開始。
        let g = project(&snap("awaiting_approval", "idle", json!([])));
        assert!(g["prd.edit"].is_null() && g["prd.review"].is_null() && g["prd.approve"].is_null());
        assert_eq!(g["run.start"], "還沒有任務");
        // 核准、任務未核准：不能開始，要先核准任務；審查只在等待核准時有意義。
        let mut s = snap("approved", "idle", json!([{ "id": 1, "status": "pending" }]));
        let g = project(&s);
        assert_eq!(g["run.start"], "請先檢視並核准任務");
        assert!(g["tasks.approve"].is_null() && g["prd.edit"].is_null());
        assert!(g["prd.review"].as_str().unwrap().contains("等待核准"));
        s["state"]["task_approval"] = json!({ "revision": "r1" });
        let g = project(&s);
        assert!(g["run.start"].is_null());
        assert_eq!(g["tasks.approve"], "任務已核准");
        // 任務開始後：PRD 不能再改、不能重新產生任務。
        let g = project(&snap("approved", "waiting", json!([{ "id": 1, "status": "review" }, { "id": 2, "status": "pending" }])));
        assert!(g["prd.edit"].as_str().unwrap().contains("已有任務開始執行"));
        assert!(g["tasks.generate"].as_str().unwrap().contains("丟掉"));
        // 子任務開始也算。
        let g = project(&snap("approved", "idle", json!([{ "id": 1, "status": "pending", "subtasks": [{ "id": 1, "status": "done" }] }])));
        assert!(g["prd.revise"].is_string());
        // 功能完成：全部收起來，只剩不受影響的操作。
        let g = project(&snap("approved", "complete", json!([{ "id": 1, "status": "done" }])));
        for key in ["prd.edit", "prd.references", "tasks.references", "task.edit", "task.rerun", "run.start", "tasks.approve"] {
            assert!(g[key].as_str().unwrap().contains("已完成"), "{key}: {}", g[key]);
        }
        assert!(g["project.settings"].is_null());
        // 執行中：AI 相關操作都停用，執行中的原因排第一。
        let mut s = snap("approved", "running", json!([{ "id": 1, "status": "in-progress" }]));
        s["runnerAlive"] = json!(true);
        let g = project(&s);
        assert!(g["prd.edit"].as_str().unwrap().contains("流程執行中"));
        assert!(g["project.settings"].as_str().unwrap().contains("流程執行中"));
        assert_eq!(check(&s, "task.rerun").unwrap_err().status, 409);
    }

    #[test]
    fn 接受目前結果_只給審查未通過而卡住的任務() {
        let mut s = snap("approved", "stuck", json!([{ "id": 9, "status": "review" }]));
        s["state"]["tasks"] = json!({ "9": { "phase": "stuck", "review_verdict": "FAIL", "last_check_ok": true } });
        assert!(task_accept(&s, "9").is_none());
        s["state"]["tasks"]["9"]["last_check_ok"] = json!(false);
        assert!(task_accept(&s, "9").unwrap().contains("驗證"));
        s["state"]["tasks"]["9"] = json!({ "phase": "stuck", "review_verdict": null, "last_check_ok": false });
        assert!(task_accept(&s, "9").unwrap().contains("不是因為審查"));
        s["state"]["tasks"]["9"] = json!({ "phase": "implementing", "review_verdict": "FAIL" });
        assert!(task_accept(&s, "9").unwrap().contains("卡住"));
        s["state"]["tasks"]["9"] = json!({ "phase": "stuck", "review_verdict": "FAIL" });
        s["runnerAlive"] = json!(true);
        assert!(task_accept(&s, "9").unwrap().contains("流程執行中"));
    }

    #[test]
    fn 需求待辦_只鎖住目前功能與已完成的需求() {
        let state = json!({ "prd": { "status": "approved", "backlog_id": "b1" } });
        assert!(backlog_item(&state, &json!({ "id": "b1", "status": "in_progress" })).unwrap().contains("目前的 PRD"));
        assert!(backlog_item(&state, &json!({ "id": "b2", "status": "done" })).unwrap().contains("已完成"));
        // 之前起草過、但已被別的需求取代的 PRD：可以重新釐清。
        assert!(backlog_item(&state, &json!({ "id": "b3", "status": "in_progress" })).is_none());
        assert!(backlog_item(&state, &json!({ "id": "b4", "status": "open" })).is_none());
        assert_eq!(check_backlog(&state, &json!({ "id": "b1", "status": "in_progress" })).unwrap_err().status, 409);
        // 已完成的任務不再加參考。
        let s = snap("approved", "idle", json!([{ "id": 1, "status": "done" }]));
        assert!(task_references(&s, &json!({ "id": 1, "status": "done" })).unwrap().contains("已完成"));
        assert!(task_references(&s, &json!({ "id": 2, "status": "pending" })).is_none());
    }
}
