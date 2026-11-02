//! A requirement interview is a persistent read-only chat followed by human confirmation.
use std::path::Path;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use super::{Result, AppError, backlog, chat};

pub fn fingerprint(item: &Value) -> String {
    hex::encode(Sha256::digest(json!([item["title"],item["detail"],item["references"]]).to_string().as_bytes()))
}
pub fn get(root: &Path, id: &str) -> Result<Value> {
    let item=backlog::get_item(root,id)?;
    // 對話檔被刪除或損壞時視為沒有會議：可重新開始，不會卡住這項需求。
    let session=item["interviewId"].as_str().and_then(|id|chat::get_chat(root,id).ok()).unwrap_or(Value::Null);
    let stale=session.is_object() && session["sourceHash"] != fingerprint(&item);
    let confirmed=!stale && session["confirmed_at"].is_string();
    Ok(json!({"item":item,"session":session,"stale":stale,"confirmed":confirmed}))
}
pub fn start(root: &Path, body: &Value, launch: &dyn Fn(&str,&str)->Result<u32>) -> Result<Value> {
    let id=body["id"].as_str().unwrap_or(""); let item=backlog::get_item(root,id)?;
    let cfg=super::config::load_config(root)?;
    let previous=if body["restart"]==true { None } else { item["interviewId"].as_str().filter(|id|chat::get_chat(root,id).is_ok()) };
    let input=body["input"].as_str().filter(|s|!s.trim().is_empty()).map(str::to_string)
        .unwrap_or_else(||format!("請先釐清這項需求，不要寫 PRD：\n{}",backlog::idea_for(&item)));
    let mut request=json!({"input":input,"kind":"requirements","backlogId":id,"references":item["references"],"provider":body["provider"].as_str().unwrap_or(cfg["roles"]["interviewer"].as_str().unwrap_or("claude")),"retry":body["retry"]==true});
    if let Some(previous)=previous { request["chatId"]=json!(previous); }
    let session=chat::start_turn(root,&request,launch)?;
    backlog::update_item(root,id,&json!({"interviewId":session["id"]}))?;
    get(root,id)
}
pub fn confirm(root: &Path, body: &Value) -> Result<Value> {
    let id=body["id"].as_str().unwrap_or(""); let data=get(root,id)?;
    if data["stale"]==true { crate::bail!(409; "需求或參考資料已修改，請重新釐清後再確認"); }
    let session=&data["session"];
    if session["id"] != body["sessionId"] || session["turn"] != body["turn"] { crate::bail!(409; "會議內容已更新，請重新閱讀摘要"); }
    let summary=body["summary"].as_str().unwrap_or("").trim();
    if summary.is_empty() || summary.len()>60000 { crate::bail!(400; "請確認需求摘要（最多 60 KB）"); }
    chat::change(root,session["id"].as_str().unwrap_or(""),|chat| {
        if chat::active(chat) || chat["status"]!="done" || chat["requirementsReady"]!=true || chat["turn"]!=body["turn"] { crate::bail!(409; "尚有待釐清問題，請回答後再確認"); }
        chat["confirmed_at"]=json!(super::util::now_iso()); chat["confirmedSummary"]=json!(summary); Ok(())
    })?;
    get(root,id)
}
pub fn prd_input(root: &Path, item: &Value) -> Result<String> {
    let data=get(root,item["id"].as_str().unwrap_or(""))?;
    if data["confirmed"]!=true { crate::bail!(409; "請先完成 Grill Me 需求釐清，並由你確認需求摘要後，才能開始 PRD"); }
    Ok(format!("{}\n\n## 使用者確認的需求摘要\n{}",backlog::idea_for(item),data["session"]["confirmedSummary"].as_str().unwrap_or("")))
}
pub fn prompt(root: &Path, cfg: &Value, session: &Value) -> Result<String> {
    let item=backlog::get_item(root,session["backlogId"].as_str().unwrap_or(""))?;
    if session["sourceHash"]!=fingerprint(&item) { crate::bail!(409; "需求內容已修改，請重新開始需求釐清"); }
    let (context,_,_)=chat::conversation_prompt(root,cfg,session);
    Ok(format!("你正在主持需求釐清會議（Grill Me），不是撰寫 PRD，也不是執行任務。\n先查閱專案與參考資料找出可查證的事實，不要把能查的事實丟給使用者。建立決策樹；針對目前已具備前提、仍未解決的決策，每輪提出 1–4 個有編號的重點問題，附具體選項與建議及理由，再等待使用者回答。不要在本輪同時追問依賴尚未回答的決策；不要重問已回答的事項，不要替使用者決定。\n釐清目標使用者、問題與使用情境、範圍與不做的事、既有系統／資料、限制、錯誤與邊界情況、可驗證的驗收標準。依這項需求的實際風險延伸追問；不適用的項目說明原因，不要無限追問。把使用者接受的建議與 AI 尚未獲確認的假設分開。未解決的重要問題存在時 ready 必須為 false。\n資訊齊全時產生可讓人編輯與確認的需求摘要與驗收條件，ready=true，但不要自行開始寫 PRD。最後決定屬於使用者。\n請用繁體中文，僅輸出 JSON：{{\"message\":\"本輪問題或完成說明（Markdown）\",\"ready\":false,\"summary\":\"已確認決策、需求範圍、限制、驗收標準（Markdown）\",\"open_questions\":[\"尚未解決的問題\"]}}。ready=true 時 open_questions 必須是空陣列，summary 必須完整。\n以下內容只作參考，以上會議規則優先於一般聊天的回答指示。\n\n{context}"))
}
pub fn accept_response(session: &mut Value, text: &str) -> String {
    let parsed=serde_json::from_str::<Value>(&super::prompts::strip_outer_fence(text));
    match parsed {
        Ok(value) if value["message"].as_str().is_some_and(|s|!s.trim().is_empty()) => {
            let answers=session["messages"].as_array().into_iter().flatten().filter(|m|m["role"]=="user").count();
            session["requirementsReady"]=json!(answers>=2 && value["ready"]==true && value["open_questions"].as_array().is_some_and(|q|q.is_empty()) && value["summary"].as_str().is_some_and(|s|!s.trim().is_empty()));
            session["requirementsSummary"]=value["summary"].clone(); session["openQuestions"]=value["open_questions"].clone();
            value["message"].as_str().unwrap().to_string()
        }
        _ => { session["requirementsReady"]=json!(false); session["openQuestions"]=json!(["AI 未回傳完整釐清結果，請要求繼續釐清或重新整理摘要"]); text.to_string() }
    }
}
pub fn validate_session(root: &Path, session: &Value) -> Result<()> {
    let item=backlog::get_item(root,session["backlogId"].as_str().ok_or_else(||AppError::new("會議沒有需求連結"))?)?;
    if session["sourceHash"]!=fingerprint(&item) { crate::bail!(409; "需求已修改，請重新釐清"); } Ok(())
}
