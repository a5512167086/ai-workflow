//! 給 AI 的提示詞。流程資料（handover、PRD、任務）不在專案資料夾裡，所以一律把內容直接貼進 prompt，
//! 需要路徑時給絕對路徑。
use std::path::Path;

use serde_json::Value;

use crate::core::state::{handover_file, prd_file};
use crate::core::skills::list_skills;
use crate::core::util::{pretty, read_text};

const MAX_FILE_CHARS: usize = 40000;
const MAX_DIFF_CHARS: usize = 120000;

pub fn clip(text: &str, max: usize) -> String {
    let len = text.chars().count();
    if len <= max {
        return text.to_string();
    }
    let head: String = text.chars().take(max).collect();
    format!("{head}\n\n…（已截斷，原長度 {len} 字元）")
}

fn read_if_exists(root: &Path, rel: &str) -> Option<String> {
    std::fs::read_to_string(root.join(rel)).ok()
}

/// handover 與 context 檔：存在就附上內容，不存在就註明，讓新對話不必重新摸索專案。
/// context_files 是使用者在設定填的專案內既有檔案（相對於專案根目錄，也可以是絕對路徑）。
pub fn context_block(root: &Path, cfg: &Value, include_handover: bool) -> String {
    let mut parts = Vec::new();
    if include_handover {
        let file = handover_file(root);
        let h = std::fs::read_to_string(&file).ok().filter(|t| !t.trim().is_empty());
        parts.push(format!("### Handover（{}）\n{}", file.display(), h.map(|h| clip(&h, MAX_FILE_CHARS)).unwrap_or_else(|| "（尚不存在，這是第一個任務）".into())));
    }
    for rel in cfg["context_files"].as_array().into_iter().flatten().filter_map(Value::as_str) {
        if let Some(t) = read_if_exists(root, rel) {
            parts.push(format!("### {rel}\n{}", clip(&t, MAX_FILE_CHARS)));
        }
    }
    if parts.is_empty() { "（沒有 context 檔）".into() } else { parts.join("\n\n") }
}

fn commands_block(cfg: &Value) -> String {
    let rows: Vec<String> = ["build", "lint", "test"].iter()
        .filter_map(|k| cfg["commands"][k].as_str().filter(|c| !c.is_empty()).map(|c| format!("- {k}: `{c}`")))
        .collect();
    if rows.is_empty() { "- （未設定 build/test/lint 指令）".into() } else { rows.join("\n") }
}

const PRD_SECTIONS: &str = "1. 概述與目標
2. 非目標（明確不做的事）
3. 使用者與使用情境
4. 功能需求（逐條編號，可驗收）
5. 技術考量（架構、資料、相依、風險）
6. 驗收標準
7. 待確認問題";

pub fn prd_draft_prompt(root: &Path, cfg: &Value, idea: &str) -> String {
    format!("你是產品需求文件（PRD）的作者。請根據以下想法與專案背景，寫一份可以直接拆解為開發任務的 PRD。

## 想法
{idea}

## 專案背景
{}

## 要求
- 使用與「想法」相同的語言撰寫。
- 章節：
{PRD_SECTIONS}
- 範圍要能在一個小功能分支內完成；不確定的地方寫進「待確認問題」，不要自行擴大範圍。
- 不要修改任何檔案。最後的回覆只輸出 PRD 的 Markdown 本文，不要前言或結語。", context_block(root, cfg, false))
}

pub fn prd_review_prompt(root: &Path, cfg: &Value, prd: &str, round: u64) -> String {
    format!("你是 PRD 審查者（第 {round} 輪）。請嚴格但務實地審查下列 PRD，找出會導致實作錯誤、無法驗收、範圍過大或互相矛盾的問題。

## 專案背景
{}

## PRD
{prd}

## 回覆格式
- 用條列寫出具體問題與建議修改（引用章節或需求編號）。沒有重大問題就簡短說明理由。
- 不要修改任何檔案。
- 最後一行必須是以下其中之一：
VERDICT: APPROVE
VERDICT: REVISE", context_block(root, cfg, false))
}

pub fn prd_revise_prompt(root: &Path, cfg: &Value, prd: &str, feedback: &str, source: &str) -> String {
    format!("你是 PRD 的作者。請根據{source}的意見修訂 PRD，輸出完整的新版本。

## 目前的 PRD
{prd}

## {source}意見
{feedback}

## 專案背景
{}

## 要求
- 保留原本的章節結構：
{PRD_SECTIONS}
- 只處理意見中合理的部分；不同意的意見，在「待確認問題」說明原因。
- 不要修改任何檔案。最後的回覆只輸出修訂後 PRD 的 Markdown 本文，不要前言或結語。", context_block(root, cfg, false))
}

pub fn tasks_from_prd_prompt(root: &Path, cfg: &Value, prd: &str) -> String {
    let n = cfg["num_tasks"].as_i64().unwrap_or(0);
    let count = if n > 0 { format!("剛好 {n} 個") } else { "適當數量（通常 3–10 個）".into() };
    let skills: Vec<String> = list_skills(root).iter().filter(|s| s["compatible"] == true)
        .map(|s| format!("{}（{}）", s["name"].as_str().unwrap_or(""), s["description"].as_str().unwrap_or(""))).collect();
    format!("你負責把 PRD 拆成可以逐一交給 AI 實作的開發任務（內建任務格式）。

## PRD
{prd}

## 專案背景
{}

## 要求
- 拆成{count}任務，依實作順序排列；每個任務可以在一個對話內完成並用測試驗證。
- dependencies 只能引用排在前面的任務編號（從 1 開始）。
- 每個任務列出對應 PRD 需求編號 requirement_ids 與可觀察的 acceptanceCriteria；確保所有需求都有任務涵蓋。
- skills 可以選擇以下適用技能，沒有適用的就留空：{}。
- 使用與 PRD 相同的語言。
- 不要修改任何檔案。最後的回覆只輸出一個 JSON 物件，不要其他文字或圍欄：
{{\"tasks\":[{{\"title\":\"\",\"description\":\"\",\"details\":\"實作細節\",\"testStrategy\":\"怎麼驗證\",\"priority\":\"high|medium|low\",\"dependencies\":[],\"requirement_ids\":[],\"acceptanceCriteria\":[],\"skills\":[]}}]}}", context_block(root, cfg, false), skills.join("、"))
}

fn task_block(task: &Value) -> String {
    format!("```json\n{}\n```", pretty(task))
}

fn id_of(task: &Value) -> String {
    crate::core::util::js_string(&task["id"])
}

const NO_TOUCH: &str = "- 不要執行 git commit、git push、切換分支，也不要修改 .taskmaster/ 或 ai-workflow 的流程資料與 handover（handover 由獨立的一步更新）。";

pub fn implement_prompt(root: &Path, cfg: &Value, task: &Value) -> String {
    let prd = read_text(prd_file(root));
    let prd = if prd.trim().is_empty() { "（沒有核准的 PRD）".to_string() } else { clip(&prd, MAX_FILE_CHARS) };
    format!("你正在一個全新的對話中實作 開發任務 {}。先閱讀 handover 與 context 了解目前進度，再動手。

## Handover 與專案 context
{}

## 任務
{}

## 完整 PRD
{prd}

## 驗證指令（完成後 ai-workflow 會自動執行）
{}

## 規則
- 只做這個任務範圍內的事，不要順手實作其他任務。
- 需要時新增或更新測試，讓上面的驗證指令能通過。
{NO_TOUCH}
- 完成後簡短回報：改了哪些檔案、怎麼驗證、還有什麼風險。",
        id_of(task), context_block(root, cfg, true), task_block(task), commands_block(cfg))
}

pub fn fix_checks_prompt(cfg: &Value, task: &Value, failures: &str, round: u64) -> String {
    format!("你正在修正 開發任務 {} 的實作（第 {round} 輪修正）。驗證指令失敗，請修好它們。

## 任務
{}

## 失敗的驗證輸出
{}

## 驗證指令
{}

## 規則
- 找出根本原因再修，不要為了讓測試通過而刪除或弱化測試。
{NO_TOUCH}
- 完成後簡短說明修了什麼。",
        id_of(task), task_block(task), clip(failures, MAX_FILE_CHARS), commands_block(cfg))
}

pub fn fix_review_prompt(cfg: &Value, task: &Value, review: &str, round: u64) -> String {
    format!("你正在修正 開發任務 {} 的實作（第 {round} 輪修正）。程式碼審查者提出以下意見，請處理。

## 任務
{}

## 審查意見
{}

## 驗證指令
{}

## 規則
- 處理合理的意見；不同意的意見在回覆中說明理由。
{NO_TOUCH}
- 完成後簡短說明改了什麼。",
        id_of(task), task_block(task), clip(review, MAX_FILE_CHARS), commands_block(cfg))
}

pub fn code_review_prompt(task: &Value, diff: &str, check_summary: &str) -> String {
    format!("你是程式碼審查者。請審查 開發任務 {} 的變更是否正確完成任務、有沒有錯誤、安全問題、遺漏的測試或超出範圍的修改。

## 任務
{}

## 驗證結果
{check_summary}

## 變更（git diff）
```diff
{}
```

## 回覆格式
- 只列出需要修改的具體問題（檔案、位置、原因、建議）。風格偏好不算問題。
- 不要修改任何檔案。
- 最後一行必須是以下其中之一：
VERDICT: PASS
VERDICT: FAIL", id_of(task), task_block(task), clip(diff, MAX_DIFF_CHARS))
}

/// handover 檔不在專案裡，AI 不直接改檔：請它輸出完整的新版內容，由 runner 寫入。
pub fn handover_prompt(root: &Path, task: &Value, implement_notes: &str, diff_stat: &str) -> String {
    let notes = if implement_notes.is_empty() { "（無）" } else { implement_notes };
    let current = read_text(handover_file(root));
    let current = if current.trim().is_empty() { "（尚不存在，請建立）".to_string() } else { clip(&current, MAX_FILE_CHARS) };
    format!("請更新 handover 文件，讓下一個全新對話能直接接手。任務 {}「{}」剛完成並通過驗證與審查。

## 目前的 handover
{current}

## 這個任務的實作說明
{}

## 變更摘要
{}

## 要求
- 內容包含：目前進度（已完成的任務）、這次改了什麼與原因、重要決策與注意事項、下一步建議、已知問題。
- 保持精簡，刪掉過時內容，不要貼大段程式碼。
- 不要修改任何檔案，不要執行 git 指令。最後的回覆只輸出更新後 handover 的完整 Markdown 本文，不要前言或結語；ai-workflow 會替你存檔。",
        id_of(task), task["title"].as_str().unwrap_or(""), clip(notes, 8000), clip(diff_stat, 8000))
}

/// 對應 regex 片段 `\s*\n([\s\S]*?)\n```$`：s 是語言標記之後的文字，回傳區塊內容。
fn fence_body(s: &str) -> Option<&str> {
    let ws_len = s.len() - s.trim_start().len();
    // \s* 吃掉空白後必須接一個 \n；從最後一個換行往前試（貪婪再回溯）。
    s[..ws_len].char_indices().rev().filter(|(_, c)| *c == '\n').find_map(|(i, _)| s[i + 1..].strip_suffix("\n```"))
}

/// 語言標記：(?:markdown|md)（不分大小寫）；optional 為 true 時也接受沒有標記。
fn after_lang(s: &str, optional: bool) -> Option<&str> {
    let end = s.find(|c: char| !c.is_ascii_alphabetic()).unwrap_or(s.len());
    let lang = s[..end].to_ascii_lowercase();
    if lang == "markdown" || lang == "md" {
        Some(&s[end..])
    } else if optional && lang.is_empty() {
        Some(s)
    } else {
        None
    }
}

/// AI 偶爾會用 ```markdown 包住整份輸出，存檔前去掉外層圍欄。
pub fn strip_outer_fence(text: &str) -> String {
    let t = text.trim();
    // ^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$
    if let Some(body) = t.strip_prefix("```").and_then(|r| after_lang(r, true)).and_then(fence_body) {
        return body.trim().to_string();
    }
    // 「這是 PRD：」之類的短前言 + 結尾的 ```markdown 區塊：只留區塊內容。
    // ^([\s\S]{0,300}?)\n```(?:markdown|md)\s*\n([\s\S]*?)\n```$
    for (pos, _) in t.match_indices("\n```") {
        let preface = &t[..pos];
        if preface.chars().count() > 300 {
            break;
        }
        let Some(body) = after_lang(&t[pos + 4..], false).and_then(fence_body) else { continue };
        let heading = preface.trim_start().starts_with('#');
        return if !preface.contains("```") && !heading { body.trim().to_string() } else { t.to_string() };
    }
    t.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn strip_outer_fence_去掉整份輸出的_markdown_圍欄() {
        assert_eq!(strip_outer_fence("```markdown\n# A\n```"), "# A");
        assert_eq!(strip_outer_fence("# A\n```js\nx\n```"), "# A\n```js\nx\n```");
    }

    #[test]
    fn strip_outer_fence_去掉短前言後的區塊但不誤砍以標題開頭的本文() {
        assert_eq!(strip_outer_fence("Here is the PRD.\n\n```markdown\n# A\nbody\n```"), "# A\nbody");
        assert_eq!(strip_outer_fence("# A\n\nsee\n```markdown\n# B\n```"), "# A\n\nsee\n```markdown\n# B\n```");
    }

    #[test]
    fn clip_以字元計算並註明原長度() {
        assert_eq!(clip("abc", 5), "abc");
        assert_eq!(clip("中文字串", 2), "中文\n\n…（已截斷，原長度 4 字元）");
    }

    #[test]
    fn 實作與_handover_提示詞直接帶內容_不要求_ai_改專案外的檔案() {
        let root = crate::core::util::temp_dir("prompt-");
        std::fs::create_dir_all(handover_file(&root).parent().unwrap()).unwrap();
        std::fs::write(prd_file(&root), "# PRD 內容").unwrap();
        std::fs::write(handover_file(&root), "上次進度").unwrap();
        let task = serde_json::json!({ "id": 1, "title": "t" });
        let prompt = implement_prompt(&root, &crate::core::config::default_config(), &task);
        assert!(prompt.contains("# PRD 內容") && prompt.contains("上次進度"));
        assert!(!prompt.contains(".aipipe"));
        let handover = handover_prompt(&root, &task, "", "");
        assert!(handover.contains("上次進度") && handover.contains("不要修改任何檔案"));
    }
}
