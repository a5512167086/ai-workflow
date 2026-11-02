//! A requirement interview is a persistent read-only chat followed by human confirmation.
use std::path::Path;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use crate::core::{Result, AppError, backlog, chat};

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
    let cfg=crate::core::config::load_config(root)?;
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
        chat["confirmed_at"]=json!(crate::core::util::now_iso()); chat["confirmedSummary"]=json!(summary); Ok(())
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
/// 從 AI 回覆裡取出 JSON 物件：接受 ```／````（含 json 標記）圍欄、前後夾雜說明文字，
/// 以及 message 裡含 ```mermaid 這類巢狀圍欄的情況（直接取第一個 { 到最後一個 }）。
fn extract_json(text: &str) -> Option<Value> {
    let object = |v: Value| v.is_object().then_some(v);
    if let Some(v) = serde_json::from_str::<Value>(&crate::core::prompts::strip_outer_fence(text)).ok().and_then(object) { return Some(v); }
    let t = text.trim();
    let (start, end) = (t.find('{')?, t.rfind('}')?);
    if end <= start { return None; }
    serde_json::from_str::<Value>(&t[start..=end]).ok().and_then(object)
}
pub fn accept_response(session: &mut Value, text: &str) -> String {
    match extract_json(text) {
        Some(value) if value["message"].as_str().is_some_and(|s|!s.trim().is_empty()) => {
            let answers=session["messages"].as_array().into_iter().flatten().filter(|m|m["role"]=="user").count();
            session["requirementsReady"]=json!(answers>=2 && value["ready"]==true && value["open_questions"].as_array().is_some_and(|q|q.is_empty()) && value["summary"].as_str().is_some_and(|s|!s.trim().is_empty()));
            session["requirementsSummary"]=value["summary"].clone(); session["openQuestions"]=value["open_questions"].clone();
            value["message"].as_str().unwrap().to_string()
        }
        parsed => {
            session["requirementsReady"]=json!(false); session["openQuestions"]=json!(["AI 未回傳完整釐清結果，請要求繼續釐清或重新整理摘要"]);
            // 是 JSON 但少了 message：排版後顯示，至少看得懂；完全不是 JSON 就照原文。
            match parsed { Some(value) => format!("```json\n{}\n```", crate::core::util::pretty(&value)), None => text.to_string() }
        }
    }
}

pub fn validate_session(root: &Path, session: &Value) -> Result<()> {
    let item=backlog::get_item(root,session["backlogId"].as_str().ok_or_else(||AppError::new("會議沒有需求連結"))?)?;
    if session["sourceHash"]!=fingerprint(&item) { crate::bail!(409; "需求已修改，請重新釐清"); } Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn session(answers: usize) -> Value {
        json!({ "messages": (0..answers).map(|_| json!({ "role": "user", "text": "answer" })).collect::<Vec<_>>() })
    }

    #[test]
    fn 四個反引號_json_標記與巢狀_mermaid_圍欄都能解析() {
        let reply = json!({ "message": "## 決策樹\n```mermaid\nflowchart TD\n  A --> B\n```\n**1. 樣式？**", "ready": true, "summary": "已確認：全部", "open_questions": [] }).to_string();
        for wrapped in [format!("````\n{reply}\n````"), format!("```json\n{reply}\n```"), format!("以下是本輪結果：\n{reply}\n請確認。"), reply.clone()] {
            let mut s = session(2);
            let text = accept_response(&mut s, &wrapped);
            assert!(text.starts_with("## 決策樹") && text.contains("flowchart TD"), "{wrapped}");
            assert_eq!(s["requirementsReady"], true, "{wrapped}");
            assert_eq!(s["requirementsSummary"], "已確認：全部");
        }
    }

    #[test]
    fn 少了_message_的_json_會排版顯示_非_json_照原文_且都不算完成() {
        let mut s = session(3);
        let text = accept_response(&mut s, "```json\n{\"ready\":true,\"summary\":\"x\"}\n```");
        assert!(text.starts_with("```json\n{\n") && text.contains("\"ready\": true"), "{text}");
        assert_eq!(s["requirementsReady"], false);
        assert_eq!(s["openQuestions"].as_array().unwrap().len(), 1);
        let mut s = session(3);
        assert_eq!(accept_response(&mut s, "我還有問題：1. 誰會用？"), "我還有問題：1. 誰會用？");
        assert_eq!(s["requirementsReady"], false);
        // 只有一則使用者訊息（自動開場）時，即使 ready 也不能確認。
        let mut s = session(1);
        accept_response(&mut s, &json!({ "message": "請確認", "ready": true, "summary": "s", "open_questions": [] }).to_string());
        assert_eq!(s["requirementsReady"], false);
    }
}
