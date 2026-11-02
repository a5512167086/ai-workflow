//! Human decisions invalidate prior approvals; model output never grants approval.
use std::path::Path;
use serde_json::{json, Value};
use crate::core::{Result, state::{read_state, update_state, is_pid_alive_value}, tasks};

pub fn idle(root: &Path) -> Result<()> {
    let state=read_state(root);
    for job in ["runner","prd","task_gen","skill_job"] {
        if is_pid_alive_value(&state[job]["pid"]) { crate::bail!(409; "工作正在執行，請先暫停並等待目前工作結束，再編輯或核准"); }
    }
    Ok(())
}
pub fn approve_tasks(root: &Path, revision: &str) -> Result<Value> {
    idle(root)?;
    crate::core::home::with_project_lock(root,"human",|| {
        require_current_tasks(root)?;
        let current=tasks::revision(root)?;
        if revision != current { crate::bail!(409; "任務內容已變更，請重新檢視後核准"); }
        update_state(root,|s|s["task_approval"]=json!({"revision":current,"approved_at":crate::core::util::now_iso(),"by":"human"}))?;
        Ok(json!({"ok":true}))
    })
}
pub fn require_current_tasks(root: &Path) -> Result<()> {
    let state=read_state(root); let meta=tasks::group_metadata(root)?;
    if state["prd"]["status"] != "approved" { crate::bail!(409; "請先核准目前 PRD"); }
    if tasks::read_tasks(root)?.is_empty() { crate::bail!(409; "尚未產生任務"); }
    if (meta.get("prd_version").is_some() && meta["prd_version"] != state["prd"]["version"]) ||
       (meta["prd_scope"].is_string() && meta["prd_scope"] != state["prd"]["reference_scope"]) {
        crate::bail!(409; "任務來自舊版 PRD，請重新產生任務再檢視與核准");
    }
    Ok(())
}
pub fn require_task_approval(root: &Path) -> Result<()> {
    require_current_tasks(root)?;
    let state=read_state(root);
    // Upgraded projects also require one explicit review before the next run.
    if state["task_approval"]["revision"] != tasks::revision(root)? { crate::bail!(409; "請先人工檢視並核准任務，再開始執行"); }
    Ok(())
}
