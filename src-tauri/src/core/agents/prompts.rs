//! 給 AI 的提示詞。流程資料（handover、PRD、任務）不在專案資料夾裡，所以一律把內容直接貼進 prompt，
//! 需要路徑時給絕對路徑。
use std::path::Path;

use serde_json::Value;

use crate::core::config::saving_on;
use crate::core::savings::{prd_excerpt, saved};
use crate::core::state::{handover_file, prd_file};
use crate::core::skills::list_skills;
use crate::core::util::{pretty, read_text};

const MAX_FILE_CHARS: usize = 40000;
pub const MAX_DIFF_CHARS: usize = 120000;

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

// PRD 的章節，參考 Matt Pocock 的 to-spec（MIT）：從使用者角度寫問題與解法、大量使用者故事、
// 不含檔案路徑的實作決策，以及事先講好的測試接縫（seam）。
const PRD_SECTIONS: &str = "1. 問題陳述：從使用者的角度，描述他們遇到的問題。
2. 解決方案：從使用者的角度，描述做完之後的樣子。
3. 使用者故事：很長、逐條編號的清單，格式為「US-1 身為〈角色〉，我想要〈功能〉，以便〈好處〉」，涵蓋這個功能的所有面向（含錯誤與邊界情況）。後續任務用 US 編號對應需求。
4. 實作決策：要新增或修改的模組與它們的介面、架構與資料結構、API 合約、重要互動與技術決定。不要寫具體檔案路徑或程式碼片段，它們很快就會過時。
5. 測試決策：在哪些「接縫」測試——接縫是觀察行為的公開介面，優先沿用既有接縫，越高層越好、越少越好（理想是一個）；說明什麼是好測試（只驗證外部行為，不測實作細節）、要測哪些模組、可以參考的既有測試。
6. 不做的事：明確排除在範圍外的項目。
7. 其他說明與待確認問題（沒有就寫「無」）。";

pub fn prd_draft_prompt(root: &Path, cfg: &Value, idea: &str) -> String {
    format!("你是產品需求文件（PRD）的作者。需求已經和使用者釐清過，這一步不再訪談，而是把已確認的內容整理成一份可以直接拆成開發任務的規格。

## 想法與使用者確認的需求
{idea}

## 專案背景
{}

## 做法
1. 先查看專案現況（既有模組、命名、測試方式），沿用專案的用語與既有架構決策。
2. 找出要在哪些接縫測試這個功能：沿用既有接縫優先，越高層越好、越少越好。
3. 依下面的章節寫 PRD。

## 要求
- 使用與「想法」相同的語言撰寫。
- 章節：
{PRD_SECTIONS}
- 只寫已確認的範圍；沒有確認的推論寫進最後一節，不要自行擴大範圍。
- 不要修改任何檔案。最後的回覆只輸出 PRD 的 Markdown 本文，不要前言或結語。", context_block(root, cfg, false))
}

pub fn prd_review_prompt(root: &Path, cfg: &Value, prd: &str, round: u64) -> String {
    format!("你是 PRD 審查者（第 {round} 輪）。請嚴格但務實地審查下列 PRD，找出會導致實作錯誤、無法驗收、範圍過大或互相矛盾的問題。

## 專案背景
{}

## PRD
{prd}

## 檢查重點
- 使用者故事是否涵蓋所有已確認的需求，包含錯誤與邊界情況；每條都能驗收。
- 實作決策是否講清楚模組、介面與資料，而且沒有寫死檔案路徑或程式碼。
- 測試決策是否明確指出接縫（越高層、越少越好），並說明只驗證外部行為。
- 這份規格能不能拆成可以各自展示的垂直切片（每一片同時穿過資料、邏輯、介面與測試）；做不到時指出卡在哪裡。
- 範圍是否在「不做的事」裡清楚界定，沒有互相矛盾。

## 回覆格式
- 用條列寫出具體問題與建議修改（引用章節或 US 編號）。沒有重大問題就簡短說明理由。
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
- 只處理意見中合理的部分；不同意的意見，在最後一節說明原因。
- 不要修改任何檔案。最後的回覆只輸出修訂後 PRD 的 Markdown 本文，不要前言或結語。", context_block(root, cfg, false))
}

pub fn tasks_from_prd_prompt(root: &Path, cfg: &Value, prd: &str) -> String {
    let n = cfg["num_tasks"].as_i64().unwrap_or(0);
    let count = if n > 0 { format!("剛好 {n} 個") } else { "適當數量（依功能大小決定，每一個都要能單獨展示）".into() };
    let skills: Vec<String> = list_skills(root).iter().filter(|s| s["compatible"] == true)
        .map(|s| format!("{}（{}）", s["name"].as_str().unwrap_or(""), s["description"].as_str().unwrap_or(""))).collect();
    // 參考 Matt Pocock 的 to-tickets（MIT）：曳光彈式的垂直切片，每片可以單獨展示，依賴只寫真正的阻擋關係。
    format!("你負責把 PRD 拆成可以逐一交給 AI 實作的開發任務（內建任務格式）。每個任務會在一個全新的對話裡實作，完成後使用者會實際測試。

## PRD
{prd}

## 專案背景
{}

## 怎麼切：垂直切片（曳光彈）
- 每個任務是一條窄但完整的路徑，同時穿過所有需要的層（資料、邏輯、狀態、介面、測試），而不是只做某一層。
  錯誤示範：「1. 型別與純函式 2. 儲存層 3. 狀態層 4. 介面」——前三個任務做完，使用者什麼都看不到、也無從測試。
  正確示範：「1. 可以新增並看到一筆待辦（含儲存與測試）2. 可以勾選完成 3. 可以依狀態篩選……」——每一個都能展示。
- 每個任務完成後都能單獨展示或驗證，使用者照著驗收條件就能手動測試。
- 每個任務的大小要能在一個全新對話內完成。
- 先看專案現況。如果先小幅重構能讓後面的實作更簡單，把重構排成最前面的任務（先讓修改變容易，再做容易的修改）。專案還是空的時候，第一個任務就是能跑起來、看得到的最小功能，而不是只有設定。
- 例外：一次影響整個專案的機械式大改動（例如改名共用型別）用「先擴充、分批遷移、最後收斂」，每一步都保持可以建置與測試。

## 依賴與順序
- dependencies 只寫真正阻擋它的任務：沒有完成就不能開始的才算，不要為了排順序而加依賴。沒有阻擋的任務留空陣列。
- 依可以開始的順序排列（被依賴的排在前面）；dependencies 只能引用排在前面的任務編號（從 1 開始）。
- 系統會照清單順序挑下一個依賴都完成的任務，所以清單順序就是實作順序。

## 每個任務的內容
- title：簡短描述這個切片讓使用者能做什麼。
- description：從使用者角度寫這個任務完成後的行為（做什麼），不要列各層的實作步驟。
- details：實作上需要注意的決策與限制（引用 PRD 的實作決策），不寫具體檔案路徑。
- testStrategy：在 PRD 測試決策中的哪個接縫測試、測哪些行為。
- acceptanceCriteria：AI 實作完能用測試、建置或讀程式碼確認的條件。
- manualChecks：只有人能做的檢查（在真的瀏覽器或裝置上操作、目測版面、跨瀏覽器驗收等），使用者會在人工驗收時自己做。不要放進 acceptanceCriteria，也不要要求 AI 填寫手動驗收結果；沒有就留空陣列。
- requirement_ids：對應 PRD 的使用者故事編號（例如 US-3）；確保每條使用者故事都有任務涵蓋。
- 拆成{count}任務。
- skills 可以選擇以下適用技能，沒有適用的就留空：{}。
- 使用與 PRD 相同的語言。
- 不要修改任何檔案。最後的回覆只輸出一個 JSON 物件，不要其他文字或圍欄：
{{\"tasks\":[{{\"title\":\"\",\"description\":\"\",\"details\":\"實作決策與限制\",\"testStrategy\":\"在哪個接縫、測哪些行為\",\"priority\":\"high|medium|low\",\"dependencies\":[],\"requirement_ids\":[],\"acceptanceCriteria\":[],\"manualChecks\":[],\"skills\":[]}}]}}", context_block(root, cfg, false), skills.join("、"))
}

fn task_block(task: &Value) -> String {
    let manual = task["manualChecks"].as_array().is_some_and(|a| !a.is_empty());
    let note = if manual { "\n\nmanualChecks 是使用者在人工驗收時自己做的檢查（例如在真的瀏覽器操作、目測版面）。AI 不需要也無法完成這些項目，不要宣稱已經做過，也不要因為它們還沒做就判定任務未完成。" } else { "" };
    format!("```json\n{}\n```{note}", pretty(task))
}

fn id_of(task: &Value) -> String {
    crate::core::util::js_string(&task["id"])
}

const NO_TOUCH: &str = "- 不要執行 git commit、git push、切換分支，也不要修改 .taskmaster/ 或 ai-workflow 的流程資料與 handover（handover 由獨立的一步更新）。";

/// 實作 prompt 與節省 token 的紀錄（PRD 摘要）。
pub fn implement_prompt(root: &Path, cfg: &Value, task: &Value) -> (String, Vec<Value>) {
    let prd = read_text(prd_file(root));
    let mut savings = Vec::new();
    let (prd_title, prd) = if prd.trim().is_empty() {
        ("完整 PRD", "（沒有核准的 PRD）".to_string())
    } else {
        let full = clip(&prd, MAX_FILE_CHARS);
        let excerpt = prd_excerpt(&prd, task).filter(|_| saving_on(cfg, "prd_excerpt"))
            .map(|e| format!("{e}\n\n完整 PRD：{}。需要其他使用者故事或實作決策的背景時再讀。", prd_file(root).display()));
        // PRD 很短時摘要加上路徑說明反而比較長，就照舊附全文。
        match excerpt.and_then(|text| saved("prd_excerpt", &full, &text).map(|s| (text, s))) {
            Some((text, entry)) => {
                savings.push(entry);
                ("PRD（與這個任務相關的部分）", text)
            }
            None => ("完整 PRD", full),
        }
    };
    let prompt = format!("你正在一個全新的對話中實作 開發任務 {}。先閱讀 handover 與 context 了解目前進度，再動手。

## Handover 與專案 context
{}

## 任務
{}

## {prd_title}
{prd}
{}

## 驗證指令（完成後 ai-workflow 會自動執行）
{}

## 用 TDD 實作（紅 → 綠）
- 在 PRD「測試決策」講好的接縫上測試；這個任務的 testStrategy 會指出是哪一個。不要在沒講好的地方另開測試入口。
- 一次一個循環：先寫一個會失敗的測試，再寫剛好讓它通過的程式碼，然後下一個。不要先寫完全部測試再寫實作，也不要預先做之後任務的功能。
- 好的測試透過公開介面驗證使用者在意的行為，重構內部時不會壞。避免：
  - 綁實作細節：mock 自己的模組、測私有函式、繞過介面直接查資料庫或檔案來驗證。
  - 套套邏輯：用和程式相同的算法算出預期值，測試永遠會過。預期值要來自獨立的已知答案（具體數字、PRD 的例子）。
- 只在系統邊界 mock（外部 API、時間、亂數，有時是檔案系統或資料庫），自己能控制的程式不要 mock。
- 重構不屬於這個循環，留給審查階段；這個任務只做讓測試通過的最小實作。
- 過程中經常跑型別檢查與相關的單一測試檔，完成前跑一次完整測試。

## 規則
- 只做這個任務範圍內的事，不要順手實作其他任務。
{NO_TOUCH}
- 完成後簡短回報：改了哪些檔案、加了哪些測試（測什麼行為）、怎麼驗證、還有什麼風險。",
        id_of(task), context_block(root, cfg, true), task_block(task), code_map_block(root, cfg, &task_question(task)), commands_block(cfg));
    (prompt, savings)
}

/// token_saving.code_map 開啟時附上專案圖譜：先更新圖譜，再用 question（任務內容、失敗輸出或審查意見）查出相關的子圖。
/// 關閉或建立失敗時是空字串，流程照常進行。
fn code_map_block(root: &Path, cfg: &Value, question: &str) -> String {
    if !saving_on(cfg, "code_map") {
        return String::new();
    }
    crate::core::graph::prompt_context(root, question).map(|text| format!("\n## 專案圖譜\n{text}\n")).unwrap_or_default()
}

/// 用來查圖譜的任務文字（標題、說明、細節、測試策略與驗收條件）。
fn task_question(task: &Value) -> String {
    let mut parts: Vec<String> = ["title", "description", "details", "testStrategy"].iter().filter_map(|k| task[k].as_str().map(String::from)).collect();
    parts.extend(task["acceptanceCriteria"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(String::from)));
    parts.join("\n")
}

pub fn fix_checks_prompt(root: &Path, cfg: &Value, task: &Value, failures: &str, round: u64) -> String {
    format!("你正在修正 開發任務 {} 的實作（第 {round} 輪修正）。驗證指令失敗，請修好它們。

## 任務
{}
{}
## 失敗的驗證輸出
{}

## 驗證指令
{}

## 規則
- 找出根本原因再修，不要為了讓測試通過而刪除或弱化測試。
{NO_TOUCH}
- 完成後簡短說明修了什麼。",
        id_of(task), task_block(task), code_map_block(root, cfg, &format!("{}\n{}", task_question(task), clip(failures, 8000))), clip(failures, MAX_FILE_CHARS), commands_block(cfg))
}

pub fn fix_review_prompt(root: &Path, cfg: &Value, task: &Value, review: &str, round: u64) -> String {
    format!("你正在修正 開發任務 {} 的實作（第 {round} 輪修正）。程式碼審查者提出以下意見，請處理。

## 任務
{}
{}
## 審查意見
{}

## 驗證指令
{}

## 規則
- 每一條 [必須修正] 都要處理：修好，或在回覆中說明為什麼不需要改（下一輪審查者會看到你的說明）。
- [建議] 可以順手改，不改也沒關係。
- 需要人親自做的檢查（手動瀏覽器驗收、目測）不是你的工作，不要假裝做過或填寫結果。
{NO_TOUCH}
- 完成後逐條簡短回覆：每條意見改了什麼，或為什麼不改。",
        id_of(task), task_block(task), code_map_block(root, cfg, &format!("{}\n{}", task_question(task), clip(review, 8000))), clip(review, MAX_FILE_CHARS), commands_block(cfg))
}

/// git diff --stat 的摘要行（檔案清單與合計），給 handover 使用。
pub fn diff_stat(diff: &str) -> String {
    diff.lines().filter(|l| (l.starts_with(' ') && l.len() > 1 && !l[1..].starts_with(char::is_whitespace) && l.contains('|')) || l.contains("file changed") || l.contains("files changed")).collect::<Vec<_>>().join("\n")
}

/// previous：上一輪的審查意見與修正者的回覆（第一次審查是空字串）。
pub fn code_review_prompt(task: &Value, diff: &str, check_summary: &str, previous: &str) -> String {
    let previous = if previous.trim().is_empty() { String::new() } else {
        format!("\n## 上一輪審查與修正者的回覆\n{}\n\n- 已經修好的不要再提。\n- 修正者說明不改的理由合理時就接受，不再列為 [必須修正]；理由不成立才再列，並說明為什麼不成立。\n", clip(previous, 12000))
    };
    format!("你是程式碼審查者。請審查 開發任務 {} 的變更是否正確完成任務、有沒有錯誤、安全問題、遺漏的測試或超出範圍的修改。

## 任務
{}

## 驗證結果
{check_summary}

## 變更（git diff）
```diff
{}
```
{previous}
## 檢查重點
- 每一條驗收條件是否都做到，而且有測試或可以手動驗證。
- 測試品質：是否在講好的接縫透過公開介面驗證行為；有沒有綁實作細節（mock 自己的模組、測私有函式、繞過介面驗證）、套套邏輯（預期值用和程式相同的方式算出來）、或只測形狀不測行為的測試。這些都算問題。
- mock 是否只用在系統邊界（外部 API、時間、亂數等）。
- 有沒有做了其他任務的事，或任務範圍內該做卻沒做的部分。
- 只有人能做的檢查（任務的 manualChecks，或在真的瀏覽器操作、跨瀏覽器驗收、目測版面這類條件）不在審查範圍：使用者會在人工驗收時自己做。不要因為它們還沒做而判 FAIL，也不要要求 AI 補做或填寫結果。

## 回覆格式
- 每一條意見開頭標上等級，並寫出檔案、位置、原因、建議：
  - [必須修正]：會造成錯誤、安全問題、沒有做到驗收條件，或缺少驗證這個任務行為的測試。
  - [建議]：可以更好但不影響正確性，例如更完整的測試、命名、小幅重構。風格偏好不用列。
- 有任何一條 [必須修正] 就判 FAIL；只有 [建議] 或沒有意見就判 PASS。
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
        let (prompt, savings) = implement_prompt(&root, &crate::core::config::default_config(), &task);
        assert!(prompt.contains("# PRD 內容") && prompt.contains("上次進度") && savings.is_empty());
        assert!(!prompt.contains(".aipipe"));
        let handover = handover_prompt(&root, &task, "", "");
        assert!(handover.contains("上次進度") && handover.contains("不要修改任何檔案"));
    }
}
