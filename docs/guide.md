# 使用指南

ai-workflow 的完整說明：流程每一步、設定、資料放在哪裡、安全設計與限制。快速介紹見 [README](../README.md)。

- [需求](#需求)
- [第一個專案](#第一個專案)
- [工作流程](#工作流程)
- [專案對話](#專案對話)
- [設定](#設定)
- [多專案與執行佇列](#多專案與執行佇列)
- [需求待辦](#需求待辦)
- [防呆](#防呆)
- [每個任務做什麼](#每個任務做什麼)
- [模式](#模式)
- [程式碼審查與重跑](#程式碼審查與重跑)
- [功能封存](#功能封存)
- [Skills](#skills)
- [節省 Token](#節省-token)
- [專案圖譜](#專案圖譜)
- [參考資料](#參考資料)
- [費用與安全](#費用與安全)
- [資料放在哪裡](#資料放在哪裡)
- [在 WSL 裡執行 CLI](#在-wsl-裡執行-cli)
- [Windows 注意事項](#windows-注意事項)
- [架構](#架構)
- [限制](#限制)

## 需求

Claude Code 和 Codex 至少安裝並以訂閱登入一個；只有一個時，實作與審查用不同的 session 完成。

| 工具 | 用途 | 安裝／登入 |
| --- | --- | --- |
| git | 版本控制、diff、自動 commit | — |
| Claude Code CLI | 預設的 PRD 作者、實作者 | `npm i -g @anthropic-ai/claude-code`，然後 `claude auth login` 用 Pro／Max 帳號登入 |
| Codex CLI | 預設的 PRD 審查者、程式碼審查者 | `npm i -g @openai/codex`，然後 `codex login` 用 ChatGPT 帳號登入 |

只裝了 Claude 桌面版、沒有獨立的 `claude` 指令時，把桌面版內建的 `claude.exe` 路徑填進全域設定的 `cli.claude`，並先用它執行一次 `claude.exe auth login`。

Claude Pro 訂閱不包含 Fable 的用量；Claude Code 可以選 Fable，但需要額外的 usage credits，詳見[官方方案說明](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)。

## 第一個專案

安裝後，開始選單的 ai-workflow 就是桌面 App。同一支 `ai-workflow-desktop.exe` 帶子指令執行時就是命令列版（例如 `ai-workflow-desktop.exe status`），可以把安裝目錄加進 PATH 或建立 `ai-workflow` 別名；下面的範例都寫成 `ai-workflow`。

在 App 的總覽按「加入專案」選資料夾，或在專案目錄執行：

```bash
ai-workflow init     # 偵測 build/test/lint 並加入總覽；不是 git repo 時會詢問是否 git init（或加 --git-init）
```

```bash
ai-workflow doctor   # 檢查 Windows／WSL 的 Claude Code、Codex 是否安裝並以訂閱登入
```

加入專案時依 `package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml` 猜 build/test/lint 指令，猜不到就留空，之後在專案頁填。專案資料夾裡不會新增任何檔案。

## 工作流程

在專案畫面依序：

1. **需求待辦**：把想做的功能列進待辦、排好順序。
2. **釐清需求（Grill Me）**：新增需求後自動開啟需求會議（之後也可以按「釐清需求」接續）。需求釐清的 AI 先查專案與參考資料，每輪提出 1–4 個問題並附建議答案；至少回答一輪、沒有未解決的問題後，右側出現需求摘要（可預覽或編輯，Mermaid 決策樹會畫成圖）。先按「確認需求摘要」，再按「開始寫 PRD」才會起草；摘要改過就要重新確認。需求的標題、說明或參考資料改過後，舊會議與確認自動失效。
3. **PRD**：作者 AI 依確認的摘要起草，審查 AI 審，來回最多 `max_prd_rounds` 輪。PRD 頁右側可以展開每一輪的審查意見。你也可以按「人工編輯」直接改 PRD（存成新版本），再按「只重新審查目前版本」請審查 AI 看你的版本而不改寫原文。
4. **核准 PRD**：看完按「核准 PRD」，或寫意見按「要求再改」（作者修訂後再審一輪）。核准會檢查版本，別的視窗改過的 PRD 要重新閱讀再核准。核准後自動產生任務；失敗時才顯示「重新產生任務」。
5. **任務看板**：檢視任務的範圍、驗收條件、粒度與依賴，必要時在任務詳情按「人工編輯任務」，再按「檢視後核准任務」。任務有實質修改時，該任務、同組子任務與後續依賴會重新待辦並撤回核准。核准後才能按「開始」。點任務卡可以看目前步驟、修正輪數、即時 log、test 輸出、審查意見與 diff。看板頂部的「參考」與「專案指令」分別調整功能共用參考，以及 build/test/lint、功能名稱與 context 檔。
6. **人工驗收**：流程停下來時（等待測試、功能完成、修正輪數用盡），自己測過後按「我測完了，繼續」。功能完成後，「PRD」頁會引導你到需求待辦開始下一個需求。

需求、PRD 與拆任務的方法改寫自 [Matt Pocock 的 skills](https://github.com/mattpocock/skills)（MIT）：需求釐清用決策樹；PRD 依 to-spec 寫問題、解法、使用者故事（US 編號）、實作決策與測試接縫；拆任務依 to-tickets 切成可以單獨展示的垂直切片，依賴只列真正擋住的任務。實作的開發方法完全看實作階段綁定的技能：預設綁 tdd，也可以在 Skills 頁換成別的方法或不綁；要不要寫測試照每個任務的 testStrategy。

同樣的流程也可以全用命令列：

```bash
ai-workflow prd "加入 CSV 匯出功能，可選欄位與日期範圍"
ai-workflow prd --revise "日期範圍要支援時區"   # 要求再改
ai-workflow prd --review                         # 人工改過 PRD 後只重新審查，不改寫原文
ai-workflow prd --approve                        # 核准
ai-workflow prd --backlog <id>                   # 用需求待辦裡的一項起草（需先在 App 完成需求釐清並確認摘要）
ai-workflow tasks                                # 產生任務
ai-workflow tasks --approve                      # 檢視後核准任務，run 之前必須核准
ai-workflow run                                  # 開始執行
ai-workflow continue                             # 我測完了，繼續
ai-workflow rerun 3 --revert                     # 還原任務 3 的變更後重跑
ai-workflow mode auto                            # 切換模式（全域）
ai-workflow status
ai-workflow projects list                        # 總覽裡的專案與狀態
ai-workflow projects add [目錄]                  # 加入總覽（預設目前目錄）
ai-workflow projects remove <id|目錄|名稱>       # 移出總覽（不刪任何檔案）
ai-workflow queue                                # 看全域執行佇列
ai-workflow queue --max 2                        # 同時最多跑 2 個專案的流程
```

在專案子目錄執行也可以，ai-workflow 會往上比對已登錄的專案路徑；或用 `--cwd <路徑>` 指定專案。

## 專案對話

開啟專案後預設進入「專案對話」，不必建立 PRD 就可以詢問進度、分析執行問題、閱讀程式碼或請 AI 畫架構圖。可以選 Claude／Codex、模型與推理強度，連續追問、停止或重試；回覆逐字顯示。對話保存在本機，重開 App 可以接續、改名或刪除。這個入口是唯讀模式，可以和任務流程同時使用。

每次提問都以最新的流程狀態、任務、PRD、交接文件與近期對話建立新的 CLI session；超長對話只帶最近的訊息。架構圖與流程圖用離線的 Mermaid 顯示，可以複製原始碼或下載 SVG。

專案對話和需求會議都可以像 Claude Code 一樣用 `/技能名稱` 叫用技能：在訊息開頭輸入 `/` 會列出可用的技能，方向鍵選擇、Enter 或 Tab 補上，例如 `/grill-me 我想做匯出報表`，開頭可以連續放好幾個。叫用過的技能會留在這個對話裡。只有訊息開頭的 `/` 才算技能，句子中間的 `/src/app.js` 這類路徑不受影響。

## 設定

設定只有一份，所有專案共用，從左側欄下方的「設定」（`Ctrl+,`）進入：

- **工作流程模式**與**全域同時執行上限**。
- **AI 角色與模型**：需求釐清、PRD 作者、PRD 審查、拆任務、實作、修正、程式碼審查、Handover、專案對話九個角色，每個選 AI（兩個審查角色多一個「雙人審查」）、模型與推理強度。模型清單直接向 CLI 查詢（Claude 用 stream-json 的 initialize 控制請求，不送訊息、不耗額度；Codex 用 app-server 的 `model/list`），所以就是這個帳號看得到的模型；也可以直接輸入模型 ID。
- **流程參數**：修正輪數、PRD 審查輪數、任務數、自動模式分支前綴。
- **節省 Token**：見[節省 Token](#節省-token)。
- **CLI 執行環境**：每個 CLI 在 Windows 或 WSL 執行，以及 doctor 檢查。
- 「目前設定」可以展開看設定檔原文；CLI 路徑、WSL 發行版、逾時、Claude 允許的工具等欄位直接改 `~/.ai-workflow/config.json`。

只有 build/test/lint 指令、功能名稱（`feature`）與 context 檔（`context_files`）屬於專案，在任務看板的「專案指令」修改。

任務遇到訂閱額度不足時，畫面提供「確認並以另一個 AI 繼續」：只有這次執行改用另一個 AI，不修改原本的角色設定。

### `~/.ai-workflow/config.json`

```jsonc
{
  "mode": "manual",                 // auto | manual
  "max_concurrent_runs": 1,         // 所有專案同時最多幾個 run（1–8）
  "roles": {                        // 每個角色填 claude 或 codex；reviewer／code_reviewer 可填 both
    "interviewer": "claude",        // 需求釐清（Grill Me）會議
    "author": "claude",             // 起草／修訂 PRD
    "reviewer": "codex",            // 審查 PRD
    "task_planner": "claude",       // 拆任務
    "implementer": "claude",        // 實作
    "fixer": "claude",              // 修驗證錯誤與審查意見
    "code_reviewer": "codex",       // 審查 git diff
    "handover": "claude",           // 產生交接紀錄
    "chat": "claude"                // 專案對話
  },
  "models": { "implementer": { "claude": { "model": "opus", "effort": "high" }, "codex": { "model": "", "effort": "" } } },
  "max_fix_rounds": 3,              // 每個任務最多修正幾輪（1–10）
  "max_prd_rounds": 2,              // PRD 審查最多幾輪（1–10）
  "num_tasks": 0,                   // 0 = 交給 AI 決定
  "command_timeout_sec": 900,       // build/test/lint 逾時
  "agent_timeout_sec": 1800,        // 每次 AI 呼叫逾時
  "branch_prefix": "ai-workflow/",
  "runtime": { "claude": "auto", "codex": "auto" },  // auto | windows | wsl
  "wsl_distro": "",                 // 空字串＝WSL 預設發行版
  "wsl_cli": { "claude": "", "codex": "" },
  "cli": { "claude": "", "codex": "" },  // 空字串 = 從 PATH 找
  "claude": { "model": "", "effort": "", "write_permission_mode": "auto", "allowed_tools": [] },  // auto 或 acceptEdits
  "codex": { "model": "", "effort": "", "windows_sandbox": "elevated", "network_access": true },
  "token_saving": {
    "review_diff_filter": true, "prd_excerpt": true, "dedupe_skills": true, "code_map": true,
    "terse": { "reviewer": true, "implementer": true, "fixer": true, "code_reviewer": true }
  },
  "skills": { "interview": ["grill-me"], "prd": ["to-spec"], "prd_review": ["grill-me"], "tasks": ["to-tickets"], "implement": ["tdd"], "code_review": [], "fix": ["tdd"], "handover": [] }
}
```

每個專案的 `project.json`：

```jsonc
{
  "feature": "csv-export",          // 自動模式分支名 <branch_prefix><feature>；空字串時用 PRD 想法產生
  "commands": { "build": "", "test": "npm test", "lint": "npm run lint" },
  "context_files": []               // 專案內的檔案路徑，每次 AI 對話都會附上內容
}
```

環境變數 `AI_WORKFLOW_HOME` 可以把 `~/.ai-workflow` 換到別的位置。

## 多專案與執行佇列

App 的首頁是總覽：每個專案一張卡片，顯示目前狀態（閒置、PRD 起草中、等待核准、排隊中、執行中、等待測試、需要人工處理…）、目前的功能與任務進度。之後用左側欄最上方的專案切換器（或 `Ctrl+K` 指令面板）換專案。需要你處理的專案會標出來，底部狀態列顯示有幾個在等你。移出專案只是移出清單，不會刪任何檔案。

所有專案的 `ai-workflow run` 共用一個全域佇列，預設同時只跑 1 個，用 `ai-workflow queue --max <n>` 或設定頁改（1–8）：

- 輪不到的專案顯示「排隊中」，前面的停下來或做完後自動接上。
- 停下來等人的專案（等待核准、等待測試、需要人工處理）不佔名額。
- 排隊中按「暫停」會放棄排隊。
- 佇列由各個 run 程序自己維護，不需要 App 開著；當掉的程序會被自動清掉。
- 起草 PRD 與產生任務不排隊。

## 需求待辦

每個專案一份清單，陣列順序就是優先順序：

```json
{
  "version": 1,
  "items": [
    { "id": "0aff2c310e", "title": "報表可以匯出 CSV", "detail": "Markdown 說明（選填）", "status": "open", "created_at": "…", "updated_at": "…" }
  ]
}
```

`status`：`open`（待辦）→ `in_progress`（已用它起草 PRD）→ `done`（功能通過人工測試，並記錄對應的封存資料夾 `feature`）。UI 可以新增、編輯、刪除、依狀態篩選，按住卡片空白處拖曳排序，或用上／下按鈕排序。

## 防呆

每個操作能不能做，由後端依流程狀態統一判斷：不該做的操作回 409 與原因，畫面上對應的按鈕停用，滑過去看得到原因。

- **需求待辦**：已產生目前 PRD、或功能已完成的需求，不能再編輯、刪除、改參考或重新釐清，只能排序。需求會議在流程執行中也能進行，「開始寫 PRD」要等流程結束。
- **PRD**：任務開始執行後不能再人工編輯、要求再改或重新產生任務；「只重新審查目前版本」只在等待核准時可用。
- **任務與執行**：任務要先核准才能開始；已完成任務的參考資料不能再改；流程執行中不能改驗證指令。
- **功能完成後**：PRD、任務、參考資料、重跑與開始都停用，要再修改就從需求待辦開始新的需求。開始新的需求時，流程狀態回到閒置。
- **執行中**：任何 AI 流程（PRD、拆任務、執行、Skill）進行時，會改到流程資料的操作都停用。

## 每個任務做什麼

```
內建排程器選擇下一項
  → 標記 in-progress
  → 開新的實作者對話（附上 handover、context 檔、PRD 與任務內容；不接續舊對話）
  → 跑 build / lint / test ──失敗──→ 把錯誤輸出交給修正者修正 ─┐
  → 審查者看這個任務的 git diff ──FAIL──→ 把意見交給修正者修正 ───┤
  ↑                                                                │
  └──────── 修正最多 max_fix_rounds 輪，用盡就停下來等人處理 ───────┘
  → handover AI 以唯讀方式寫出新版交接紀錄
  → 自動模式：完成並 git commit；手動模式：停在「等待測試」
```

- diff 用暫存 index 把「任務開始前」與「現在」的工作目錄存成 git tree 再比較，所以手動模式沒有 commit 也只看到這個任務的變更，而且不會動到你的 git index。
- 實作者被要求不要 commit、不要切分支；handover 存在專案以外，所以 diff 與 commit 裡只有真正的程式變更。
- Claude 以 `--add-dir` 把專案資料目錄加成額外工作目錄，才讀得到 Skill 快照與參考資料；Codex 的沙箱本來就能讀專案以外的檔案。

## 模式

| | 自動模式 `auto` | 手動模式 `manual`（預設） |
| --- | --- | --- |
| git commit | 每個任務通過驗證和審查後自動 commit（`ai-workflow: task <id> <標題>`） | 不 commit，由你決定 |
| 分支 | 自動切到 `ai-workflow/<feature>`，不在 main 上 commit | 不切分支 |
| 何時停下來 | PRD 等待核准、所有任務完成待功能測試、修正輪數用盡 | 以上三種，加上每個任務完成後 |
| 任務狀態 | 通過後直接完成 | 等你按「繼續」才完成 |

在設定頁或 `ai-workflow mode <auto|manual>` 切換，下一個任務開始時生效。

## 程式碼審查與重跑

- 審查者把每條意見標成「[必須修正]」或「[建議]」。只有 [必須修正] 會判 FAIL、消耗修正輪數；只有 [建議] 時視為通過，意見仍保留在「審查意見」。Codex 有時用 P0–P3：P0、P1 算 [必須修正]，P2、P3 算 [建議]。
- 缺少測試只有在任務的 testStrategy 要求測試時才算 [必須修正]。
- 修正者對每條 [必須修正] 要嘛修好，要嘛說明為什麼不改；下一次審查會看到上一輪的意見和回覆。
- 只有人能做的檢查（在真的瀏覽器操作、跨瀏覽器驗收、目測版面）放在任務的「人工驗收」清單（manualChecks），審查者不會因為它們還沒做而判 FAIL。
- 修正輪數用完而卡住時，任務詳情最上面寫出卡住原因與最後一次要求修正的項目。驗證有通過時會出現「接受目前結果」：重新驗證後跳過審查，進入人工驗收。
- 也可以自己修好程式碼再按「我測完了，繼續」：重新驗證和審查這個任務（不重新實作，修正輪數重算）。

任務詳情的「重跑任務」：

- 不勾「還原」：直接在目前程式碼上重新實作。
- 勾「還原」：自動模式用 `git revert` 還原該任務的 commit；手動模式把該任務改過的檔案還原到任務開始前（新增的檔案刪除）。注意手動模式下，之後任務對同一批檔案的修改也會一起被還原。

Log 裡的指令輸出只保留前 20 行與後 10 行，AI 看到的仍是完整輸出。

## 功能封存

每個功能核准的 PRD 會自動封存：

```
archive/2026-11-01-匯出-csv/
  prd.md                     核准的 PRD
  rounds/01-draft-r0-v1.md   每一輪：初稿、審查（含結論）、修訂、使用者意見
  tasks.json                 任務清單（含最後狀態與每個任務的執行狀態）
  task-records/1/            每個任務的實作紀錄：task.log、implement.md、review-*.md、checks.txt、diff.patch
  meta.json                  想法、核准／完成時間、任務群組、進度、待辦項目 id
```

- 核准 PRD 時建立；同一個功能重新核准會更新同一個資料夾。產生任務後、每次執行結束時、功能完成時更新任務清單與實作紀錄。
- 開始下一個功能時一定建新資料夾，同一天同名的功能加 `-2`、`-3`。上一個功能的任務紀錄封存好之後才清掉，新功能的任務從空白開始。
- 每個功能的任務放在內建任務引擎的獨立群組，包含依賴、狀態事件與 PRD 版本。
- 「紀錄」畫面可以瀏覽每個封存的 PRD、每輪紀錄與任務；點任務展開它的內容、log、審查意見、test 輸出與 diff。

## Skills

「Skills」頁管理技能：內建的 grill-me、to-spec、to-tickets、tdd、uiux-design，以及你匯入的技能。右側顯示 SKILL.md 預覽、frontmatter 與資源檔，可以編輯；匯入的技能可以刪除，修改過的內建技能可以還原。

- **匯入**：選一個像 `.claude/skills/<name>/` 的資料夾（也可以拖放），要有 `SKILL.md`，其餘檔案當資源一起複製。
- **工作流技能綁定**：每個階段綁哪些技能（全域設定）。預設：需求釐清 grill-me、PRD 起草與修訂 to-spec、PRD 審查 grill-me、拆任務 to-tickets、實作與修正 tdd。拆任務時 AI 也可以替個別任務指定技能（例如 UI 任務用 uiux-design）。
- **會議**：直接和選定的 AI 用某個技能討論，可以接續或開新會議。
- Codex 和 Claude Code 透過 App 載入同一份技能；每次執行保存技能快照與版本。

```bash
ai-workflow skills list
ai-workflow skills import <資料夾>
ai-workflow skills run grill-me --input "我要做報表工具" --provider codex
```

技能相容性與任務格式見[內建任務引擎與共用 Skills](tasks-and-skills.md)。

## 節省 Token

AI 在一個 session 裡每發一次請求，都會把整份 prompt 與之前的工具結果重讀一次，所以縮小 prompt 的效果會乘上請求次數。「設定 → 節省 Token」可以逐項開關：

| 功能 | 預設 | 做什麼 |
| --- | --- | --- |
| 審查略過 lockfile 與產生檔 | 開 | `package-lock.json`、`Cargo.lock`、`dist/`、`*.min.js` 等只在審查 diff 裡留檔名與一行說明 |
| 實作只附相關的 PRD | 開 | 只附任務對應的使用者故事、「測試決策」與「不做的事」，加上完整 PRD 的路徑；對不到時附全文 |
| 內建技能不重複附加 | 開 | to-spec、to-tickets、grill-me 的方法已寫在該階段的提示詞裡，沒改過的內建技能不再附一次；實作的開發方法（例如 tdd）綁了才附加 |
| 精簡回覆 | PRD 審查、實作、修正、程式碼審查開 | AI 結論先行、不寒暄不重述，程式碼、路徑、錯誤訊息與否定詞保留原文；不影響寫進檔案的內容 |
| 專案圖譜 | 開 | 實作與修正前查出相關的節點與關係附給 AI（約 1,500 tokens），取代整個專案搜尋 |

「用量」頁顯示估計省下的 tokens，以及依階段分開的次數、用量與平均；CLI 回報的訂閱額度剩餘百分比與重設時間也在這裡。詳見 [Token 與額度顯示](usage.md)。

精簡回覆的規則改寫自 [caveman](https://github.com/juliusbrussee/caveman)（Apache-2.0，濃縮並翻成中文）；專案圖譜只參考 [graphify](https://github.com/Graphify-Labs/graphify) 的設計，沒有使用它的程式碼或文字。來源與授權見 [THIRD_PARTY_NOTICES.txt](../THIRD_PARTY_NOTICES.txt)。

## 專案圖譜

專案圖譜把程式碼整理成一張可以查詢的圖，讓 AI 先查圖、只讀圖上標出位置的那幾行，不必一路搜尋、逐檔讀程式。

- **解析**：用 tree-sitter 在本機解析 Rust、JavaScript、TypeScript／TSX、Python、Go、Java，抽出檔案、函式、方法、類別、struct、trait、介面，以及 `contains`、`method`、`imports`、`calls`、`inherits`、`implements` 關係。不花 AI token。
- **信心度**：`EXTRACTED`（1.0）是原始碼明確寫出的關係；`INFERRED`（0.85）只靠全專案唯一的名稱推斷；`AMBIGUOUS`（0.2）是同名的定義有好幾個，各連一條。
- **輸出**：
  - `graph.json`：node-link 格式，每個節點、每條關係各佔一行。
  - `GRAPH_REPORT.md`：摘要、核心節點、意外的關聯、循環匯入、分群與凝聚度、不確定的關聯、知識缺口與建議問題。這些都由固定規則算出，例如連接數不超過 1 的定義列為孤立節點。
  - `graph.html`：離線的互動圖，可以拖曳平移、滾輪縮放、搜尋、點節點看相鄰節點、依分群顯示或隱藏；跟著 App 的主題。超過 3,000 個節點時改畫檔案層級。
- **更新**：每個實作與修正前自動重建，沒變的檔案沿用快取。「架構圖」畫面可以檢視報告與互動圖，也可以手動重建。

```bash
ai-workflow graph build
ai-workflow graph query "prepare_skills 去重" --budget 2000
ai-workflow graph path run_agent_session data_dir
ai-workflow graph explain data_dir
```

## 參考資料

需求待辦、PRD、任務看板與專案對話都可以「加入參考」：選取檔案或資料夾、貼上完整路徑、重用已匯入的資料，或直接拖放。需求說明、PRD 修改意見與聊天輸入支援 `@` 搜尋專案檔案；聊天與需求輸入可以貼上剪貼簿圖片。

- 需求的附件在起草時帶入 PRD；功能參考給 PRD 作者、審查與拆任務使用，產生任務時固定在任務群組上。
- 任務看板的「參考」調整群組的共用參考；單一任務可以再加資料，子任務沿用父任務的參考。
- 資料保存為快照（含 SHA-256 清單與 PDF 擷取文字），原始檔案搬動或刪除後仍可使用。
- 單檔最多 20 MB，每份資料夾最多 64 MB／2000 檔，一個綁定最多 24 份。資料夾匯入會排除 `.git`、`node_modules`、建置產物、`.env*`、`.pem`、`.key` 與連結。
- PNG、JPEG、WebP、GIF 圖片會傳給 Claude 的圖片訊息或 Codex 的 `--image`（單次最多 8 張、合計 20 MB）。掃描的 PDF 沒有 OCR。

## 費用與安全

- 只呼叫官方 CLI：`claude -p`、`codex app-server`（和 Codex 桌面版、IDE 外掛相同的介面）。
- 啟動任何子程序前會移除 `ANTHROPIC_*`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CODEX_API_KEY` 等環境變數，以及上層 Claude Code session 的 `CLAUDECODE`、`CLAUDE_CODE_*`。CLI 只能用訂閱登入，沒登入就直接失敗，不會改走付費 API。
- 不使用 `--dangerously-skip-permissions` 或 `--dangerously-bypass-approvals-and-sandbox`：

  | 角色 | Claude | Codex |
  | --- | --- | --- |
  | 會改檔案（實作者、修正者） | `--permission-mode auto`，沒有自動允許的操作跳出對話框問你 | `--sandbox workspace-write`，並開放網路 |
  | 唯讀（PRD、拆任務、審查、handover、對話） | `--permission-mode dontAsk`，禁止 Edit、Write | `--sandbox read-only` |

- 沒有自動放行的操作會在 App 跳出「AI 要求執行操作」對話框，可以「允許這一次」「這次執行都允許」或「拒絕」（可附原因）。想每個指令都自己確認，把 `claude.write_permission_mode` 改成 `acceptEdits`；`claude.allowed_tools` 列出的工具不會再問。Codex 的寫入角色超出沙箱的操作也用同一個對話框問你。
- prompt 一律從 stdin 傳入；修正輪數、PRD 審查輪數都有上限，每次 AI 呼叫與每個指令都有逾時。

## 資料放在哪裡

目標專案裡沒有任何 ai-workflow 產生的檔案（自動模式只會多出 git commit 與分支）。所有資料在使用者目錄：

```
~/.ai-workflow/
  config.json                全域設定
  projects.json              總覽的專案清單
  queue.json                 全域執行佇列
  limits.json                各 AI 帳號的訂閱額度快照
  projects/<專案 id>/        每個專案的流程資料（id 是專案路徑的 sha1 前 10 碼）
    project.json             build/test/lint、feature、context_files
    state.json               流程、PRD、各任務狀態
    logs/*.log               runner、prd、tasks、task-<id>、process
    prd/                     各版 PRD、每輪審查意見、使用者意見
    prd.md                   核准後的 PRD
    handover.md              給下一個 AI session 的交接紀錄
    tasks.json               內建任務資料（每個功能一個群組）
    tasks/<id>/              目前功能每個任務的 checks.txt、review-N.md、diff.patch、implement.md
    backlog.json             需求待辦
    archive/<日期>-<功能>/   功能封存
    chats/、references/      專案對話、參考資料快照
    skills/、skill-runs/     這個專案的技能庫與技能會議
    sessions/、usage.json    每次 AI 呼叫的紀錄、token 用量與估計節省量
    graph/                   專案圖譜
    tmp/                     每次送出的 prompt、Skill 快照
```

App 與流程是不同的程序，透過 `state.json` 溝通；UI 的按鈕用同一支 exe 在背景啟動對應的子指令，關掉 App 不會中斷正在跑的流程。

## 在 WSL 裡執行 CLI

每個 CLI 可以分別在 Windows 或 WSL 執行，例如 claude 裝在 WSL、codex 用 Windows 版：

```jsonc
{
  "runtime": { "claude": "wsl", "codex": "windows" },
  "wsl_distro": "Ubuntu",     // 空字串＝WSL 預設發行版
  "wsl_cli": { "claude": "", "codex": "" }  // WSL 裡的指令名或路徑，空字串＝claude / codex
}
```

預設是 `auto`，依專案位置選擇環境。設定頁可以切換並按「檢查 CLI（doctor）」。詳見[自動路由與單 AI 模式](runtime.md)。

- 實際執行 `wsl.exe -d <distro> --cd <專案路徑> -e bash -lc '<清理腳本>' ai-workflow <cli> <參數…>`。用 `-e` 而不是 `--`，引號、`$`、`;` 才不會被預設 shell 重新解析。
- 需要路徑的參數會用 `wslpath -a` 轉成 `/mnt/c/...`。
- API key 在 WSL 端再清一次：清理腳本 `unset` 所有 `ANTHROPIC_*`、`CLAUDE_CODE_*`、`OPENAI_API_KEY` 等變數，再用 `exec env -u …` 執行 CLI。
- 專案在 Windows 磁碟時，WSL 裡的 CLI 透過 `/mnt/c` 存取，讀寫大量檔案比原生慢；專案很大時考慮全部放在 WSL。
- WSL 的工具寫出 LF，Windows 的 git 若設 `core.autocrlf=true` 會出現整檔換行差異，建議在專案加 `.gitattributes`（例如 `* text=auto eol=lf`）。

## Windows 注意事項

- Codex 沒設 `windows.sandbox` 時會把 workspace-write 默默降成 read-only，ai-workflow 會帶 `-c windows.sandbox="<codex.windows_sandbox>"`（預設 `elevated`）。仍回報 read-only 時，任務停在「需要人工處理」並提示改設定；`elevated` 不行就改 `unelevated`。
- Codex 在 Windows 用 PowerShell 5.1 執行指令，直接 `Get-Content` 會把 UTF-8 讀成亂碼，App 會提醒 Codex 改用 `rg` 或先設定 UTF-8。
- npm 全域安裝的 `.cmd` 包裝檔（例如 `codex.cmd`）會解析成 `node <js 入口>` 直接執行；npm 版 CLI 需要 PATH 上有 `node`。
- 安裝包沒有程式碼簽章，第一次執行時 SmartScreen 可能會提示。更新前請從系統匣選「結束 ai-workflow」；點視窗關閉只會縮到系統匣。

## 架構

標準的 Tauri 2 專案。`src/` 是前端（React 19 + TypeScript + Vite 7 + Tailwind v4 + shadcn/ui，見 [frontend.md](frontend.md)），`src-tauri/` 是 Rust 後端。

- PRD 流程、內建任務引擎、執行器、git、WSL、用量追蹤都在 `src-tauri/src/core/`：`agents/`（Claude、Codex CLI 與權限請求）、`workflow/`（需求、PRD、任務、執行流程）、`project/`（設定、狀態、專案清單、佇列）、`skills/`、`system/`（子程序、WSL、git）。
- 前端透過 Tauri command `api(method, path, body)` 呼叫後端（例如 `/api/p/<id>/state`），狀態、log 與 AI 逐字輸出以 Tauri 事件推送。
- 同一支 exe 帶子指令執行時就是 CLI，不開視窗；UI 啟動的流程也用這個方式另開背景程序。
- 系統匣（左鍵開視窗、右鍵結束）；關閉視窗縮到系統匣並繼續監看；專案需要你處理時跳 Windows 通知。

## 限制

- 自動模式需要 git 使用者身分（`git config user.name`／`user.email`）。
- 從手動模式中途切到自動模式時，手動模式留下、尚未 commit 的變更會併進下一個自動 commit。
- 「暫停」在目前任務結束後才生效，不會中斷正在跑的 AI 呼叫。
- 同一個專案同時只能有一個 `ai-workflow run`。
- 同時開兩個 App 會各自監看，通知會重複。
- Claude 與 Codex 的訂閱用量上限照常適用；用量耗盡時該任務停在「需要人工處理」。
