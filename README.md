# ai-workflow

把「多個 AI 討論 → 寫 PRD 並交叉審查 → 內建引擎拆任務 → 每個任務開新對話並帶 handover → 驗證與審查 → 更新 handover → 人工測試」這套流程自動化的 Windows 桌面工具，同一支程式也能當命令列使用。

- **只用你自己的訂閱**：一律呼叫本機已登入的官方 CLI（`claude -p`、`codex exec`），不需要也不使用 API key。
- **不碰你的專案**：所有設定、狀態、log、PRD、任務、封存都放在使用者目錄 `~/.ai-workflow/`，專案資料夾裡一個檔案都不留。
- **通用**：任何有 git 的軟體專案都能用，build/test/lint 指令在加入專案時自動偵測，之後可在專案頁修改。
- **兩種模式**：自動（通過檢查就 commit，少停）與手動（不 commit，每個任務都停下來等你測）。
- **多專案**：總覽畫面同時看多個專案；全域佇列讓多個專案輪流跑，不會一起燒掉訂閱額度。
- **桌面版**：Windows 安裝檔（Tauri + Rust），不需要 Node，流程停下來等你時跳通知。見[桌面版](#桌面版windows)。

## 需求

Claude Code／Codex 至少安裝並以訂閱登入一個；缺少另一個時使用獨立 session 完成實作與審查。

| 工具 | 用途 | 安裝／登入 |
| --- | --- | --- |
| git | 版本控制、diff、自動 commit | — |
| Claude Code CLI | 預設的 PRD 作者、實作者 | `npm i -g @anthropic-ai/claude-code`，然後 `claude auth login` 用 Pro/Max 帳號登入 |
| Codex CLI | 預設的 PRD 審查者、程式碼審查者 | `npm i -g @openai/codex`，然後 `codex login` 用 ChatGPT 帳號登入 |

> 只裝 Claude 桌面版、沒有獨立的 `claude` 指令時，可以把桌面版內建的 `claude.exe` 路徑填進全域設定 `~/.ai-workflow/config.json` 的 `cli.claude`，但仍要先用它執行一次 `claude.exe auth login`。

## 安裝

執行 `ai-workflow_<版本>_x64-setup.exe`（見[桌面版](#桌面版windows)）。安裝後開始選單的 ai-workflow 就是桌面 app；
同一支 `ai-workflow-desktop.exe` 帶子指令執行時就是命令列版（例如 `ai-workflow-desktop.exe status`），可以把安裝目錄加進 PATH，
或建立名為 `ai-workflow` 的別名。下面的範例都寫成 `ai-workflow`。

## 快速開始

開啟專案後，預設進入「專案對話」。不必建立 PRD，就可以詢問目前進度、分析執行問題、閱讀程式碼或請 AI 畫架構圖。可選 Claude／Codex、指定模型與推理強度、連續追問、停止回覆及重試；對話保存在 `~/.ai-workflow/projects/<id>/chats/`，重開 App 仍可接續，也可改名或刪除。這個入口採唯讀模式，可與任務流程同時使用。

每次提問會以最新流程狀態、任務、PRD、交接文件與近期對話紀錄建立新的 CLI session；完整對話仍保留在本機，超長對話只帶最近訊息。架構／流程圖使用離線 Mermaid 顯示，可複製原始碼或下載 SVG。執行紀錄會隨 CLI 輸出更新，最終回答完成後呈現在訊息區。

```bash
cd 你的專案                 # 不是 git repo 時 init 會詢問是否 git init（或加 --git-init）
ai-workflow init            # 偵測 build/test/lint 並加入總覽；專案裡不會新增任何檔案
ai-workflow doctor          # 檢查 Windows／WSL 的 Claude Code、Codex 是否安裝並以訂閱登入
```

或直接在桌面 app 的總覽按「加入專案」選資料夾（`init` 與 `projects add` 是同一件事）。

在專案畫面裡依序：

0. **需求待辦**：先把想做的功能列進待辦、排好順序。
1. **釐清需求（Grill Me）**：新增需求後會自動開啟需求會議（之後也可按「釐清需求」接續）。`interviewer` 角色的 AI 先查專案與參考資料，每輪提出 1–4 個問題；至少回答一輪、沒有未解決問題後，會議右側會出現需求摘要（預覽／編輯可切換，Mermaid 決策樹會畫成圖）。先按「確認需求摘要」，再按「開始寫 PRD」才會起草；摘要改過就要重新確認，左側對話仍可繼續追問。需求標題、說明或參考資料改過後，舊會議與確認自動失效。
2. **PRD**：作者 AI 依你確認的摘要起草，審查 AI 審，來回最多 `max_prd_rounds` 輪。PRD 頁右側可以展開每一輪的審查意見。你也可以按「人工編輯」直接改 PRD（存成新版本、保留紀錄），再按「只重新審查目前版本」請審查 AI 看你的版本而不改寫原文。
3. 看完 PRD 後按「核准 PRD」，或在下方寫意見按「要求再改」（作者修訂後會再審一輪）。核准會檢查版本，別的視窗改過的 PRD 要重新閱讀再核准。
4. 桌面版核准後自動產生任務；只有失敗時才顯示「重新產生任務」。
5. **任務看板**：先檢視任務的範圍、驗收條件、粒度與依賴，必要時在任務詳情按「人工編輯任務」修改，再按「檢視後核准任務」。任務有實質修改時，該任務、同組子任務與後續依賴會重新待辦並撤回核准；產生新任務或 PRD 改版後也要重新核准。核准後才能按「開始」。點任務卡可以看目前步驤、修正輪數、即時 log、test 輸出、審查意見、diff。看板頂部「目前功能」區塊右側有「參考」與「專案指令」兩個按鈕，分別開對話框調整功能共用參考，以及 build/test/lint、功能名稱與 context 檔，不佔看板版面。
6. 流程停下來時（等待測試、功能完成、修正輪數用盡），自己測過後按「我測完了，繼續」。

## 設定（全域一份）

設定只有一份，所有專案共用，從總覽右上角的「設定」進入；專案卡片與專案頁都沒有設定入口，也不需要先選專案。內容：

- **工作流程模式**與**全域同時執行上限**放在最上方同一個區塊（左右各半）。
- **AI 角色與模型**：需求釐清、PRD 作者、PRD 審查、拆任務、實作、修正、程式碼審查、Handover、專案對話九個角色排成 3×3 格子，每格選 AI（claude／codex，兩個審查角色多一個「雙人審查」）、模型與推理強度；視窗窄時退成 2 欄或 1 欄。模型欄位是下拉選單，也可以直接輸入模型 ID。清單直接向 CLI 查詢：Claude 用 stream-json 的 initialize 控制請求（不送訊息、不耗額度，結果快取 10 分鐘），Codex 用 app-server 的 `model/list`；所以清單就是這個帳號在 CLI 模型選單看得到的模型，推理強度選項也跟著所選模型。CLI 查不到時改列建議清單並顯示原因。
- **流程參數**：修正輪數、PRD 審查輪數、任務數、自動模式分支前綴。
- **CLI 執行環境**：每個 CLI 在 Windows 或 WSL 執行，與 doctor 檢查。
- 最底下的「目前設定」可展開看 `~/.ai-workflow/config.json` 原文；CLI 路徑、WSL 發行版、逾時、Claude 允許的工具等欄位直接改這個檔案。

只有 build/test/lint 指令、功能名稱（`feature`）與 context 檔（`context_files`）屬於專案，存在 `~/.ai-workflow/projects/<id>/project.json`，在專案頁的任務看板修改。

任務遇到訂閱額度不足時，畫面提供「確認並以另一個 AI 繼續」。確認後，只有這次執行改用另一個 AI，實作與審查仍使用不同 session，雙人審查暫時降為單人；不修改原本角色設定。保留現有變更並重新驗證，另一個 AI 也無法完成時停止。額度恢復後，可在用量頁更新資料。

Claude Pro 訂閱不包含 Fable 的用量；Claude Code 可選 Fable，但需額外 usage credits，詳見[官方方案說明](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)。帳號看得到 Fable 時清單會列出，使用前請確認方案。

「紀錄」整合目前功能的可展開 Log、PRD、每輪紀錄及任務，也可切換歷史功能查看封存。任務看板可搜尋、依狀態篩選，或切換「任務藍圖」查看任務與子任務完成度；此部分介面的資訊層級參考 MIT 授權的 [Monstrare](https://github.com/pjwang2022/Monstrare)，來源與授權詳見 [UI 設計系統](docs/design-system.md) 及 [第三方聲明](src/THIRD_PARTY_NOTICES.txt)。

同樣的流程也可以全用命令列：

```bash
ai-workflow prd "加入 CSV 匯出功能，可選欄位與日期範圍"
ai-workflow prd --revise "日期範圍要支援時區"   # 要求再改
ai-workflow prd --review                         # 人工改過 PRD 後只重新審查，不改寫原文
ai-workflow prd --approve                        # 核准
ai-workflow tasks
ai-workflow tasks --approve                      # 檢視後核准任務，run 之前必須核准
ai-workflow run
ai-workflow continue                             # 我測完了，繼續
ai-workflow rerun 3 --revert                     # 還原任務 3 的變更後重跑
ai-workflow mode auto                            # 切換模式（全域）
ai-workflow status
ai-workflow prd --backlog <id>                   # 用需求待辦裡的一項起草 PRD（需先在 App 完成需求釐清並確認摘要）
ai-workflow projects list                        # 總覽裡的專案與狀態
ai-workflow projects add [目錄]                  # 加入總覽（預設目前目錄）
ai-workflow projects remove <id|目錄|名稱>       # 移出總覽（不刪任何檔案）
ai-workflow queue                                # 看全域執行佇列
ai-workflow queue --max 2                        # 同時最多跑 2 個專案的流程
```

在專案子目錄執行也可以，ai-workflow 會往上比對 `~/.ai-workflow/projects.json` 登錄的路徑；或用 `--cwd <路徑>` 指定專案。還沒加入的專案會提示先執行 `ai-workflow projects add`。

## 多專案總覽

桌面 app 的首頁是總覽：每個專案一張卡片，顯示目前狀態（閒置、PRD 起草中、等待核准、排隊中、執行中、等待測試、功能待測試、需要人工處理…）、目前的功能、任務進度，點進去就是單一專案畫面。需要你處理的專案會標出來，頂列顯示有幾個在等你。

專案清單存在 `~/.ai-workflow/projects.json`，依最近開啟排序。從總覽或 `ai-workflow projects add` 加入；資料夾還不是 git repo 時，總覽會問你要不要 `git init`（除了 `.git` 以外不會在專案裡新增任何檔案）。移除只是移出清單，不會刪任何檔案。

## 需求待辦清單

每個專案一份，存在 `~/.ai-workflow/projects/<id>/backlog.json`。選 JSON 是因為要排序、要有穩定的 id 對應封存；內容很單純：

```json
{
  "version": 1,
  "items": [
    { "id": "0aff2c310e", "title": "報表可以匯出 CSV", "detail": "Markdown 說明（選填）", "status": "open", "created_at": "…", "updated_at": "…" }
  ]
}
```

陣列順序就是優先順序。`status`：`open`（待辦）→ `in_progress`（已用它起草 PRD）→ `done`（功能通過人工測試，並記錄對應的封存資料夾 `feature`）。UI 可以新增、編輯、刪除，用拖曳或上／下按鈕排序（鍵盤也能操作）。

## 功能封存

每個功能核准的 PRD 會自動封存到 `~/.ai-workflow/projects/<id>/archive/<日期>-<功能>/`：

```
archive/2026-11-01-匯出-csv/
  prd.md                     核准的 PRD
  rounds/01-draft-r0-v1.md   每一輪：初稿、審查（含結論）、修訂、使用者意見
  rounds/02-review-r1-revise-v1.md
  tasks.json                 這個功能的任務清單（含最後狀態）
  meta.json                  想法、核准／完成時間、任務群組、進度、待辦項目 id
```

- 核准 PRD 時建立；同一個功能重新核准會更新同一個資料夾。
- 產生任務後、每次 `ai-workflow run` 結束時、功能完成時更新 `tasks.json`。
- 開始下一個功能（起草新的 PRD）時一定建新資料夾；同一天同名的功能會加 `-2`、`-3`，不會覆蓋。
- UI 的「紀錄」分頁可以瀏覽每個封存的 PRD（Markdown 渲染）、每輪紀錄與任務清單。

### 每個功能一個任務群組

內建任務引擎將不同功能的任務保存在 `~/.ai-workflow/projects/<id>/tasks.json` 的獨立群組，包含依賴、狀態事件及 PRD 版本；不需要安裝 Task Master。專案裡若有舊 Task Master 的多群組任務，首次使用時會匯入並保留來源。

## Skills

桌面版的「用量」頁可查看各次執行與本專案的 token 處理量、CLI 回報的訂閱額度剩餘百分比及重設時間。詳見[Token 與額度顯示](docs/usage.md)。

「Skills」頁像 Claude Code／Codex 的技能管理：左側是技能清單（內建的 Grill Me、UI/UX Design 與匯入的技能，各顯示來源與相容狀態，可搜尋），右側顯示選取技能的 SKILL.md 預覽、frontmatter 欄位與資源檔，可切到文字框編輯；匯入的技能可以刪除，修改過的內建技能可以還原。「匯入技能」選擇一個像 `.claude/skills/<name>/` 的資料夾（也可以直接拖放到清單），資料夾要有 `SKILL.md`（不分大小寫），其餘檔案與子目錄當資源一起複製進該專案資料目錄的 `skills/`。右側的「會議」子頁是完整高度的對話區：選定 AI 後送出，回覆中顯示「AI 正在回覆（已 N 秒）」與執行紀錄，歷史會議可用下拉切換、接續或開新會議；清單最上面的「工作流技能綁定」是一張階段表，每列用 chips 顯示綁定的技能，＋ 加入、× 移除，有變更時才可儲存（全域設定）。Codex／Claude Code 都透過 App 載入同一份可攜式指令；每次執行保存技能快照與 session，下一輪問答以紀錄交接到新 session。

```bash
ai-workflow skills list
ai-workflow skills import <資料夾>
ai-workflow skills run grill-me --input "我要做報表工具" --provider codex
```

完整設定與相容性見[內建任務引擎與共用 Skills](docs/tasks-and-skills.md)。

## 執行佇列

所有專案的 `ai-workflow run` 共用一個全域佇列（`~/.ai-workflow/queue.json`），預設同時只跑 1 個，用 `ai-workflow queue --max <n>` 或設定頁的「全域同時執行上限」改（1–8）。

- 輪不到的專案顯示「排隊中」，前面的停下來或做完後自動接上（每 1.5 秒檢查一次）。
- 停下來等人的專案（等待核准、等待測試、需要人工處理）不佔名額：那時 `ai-workflow run` 已經結束。
- 排隊中按「暫停」會放棄排隊。
- 佇列由各個 run 程序自己維護，不需要 UI 開著；當掉的程序會被自動清掉，不會卡住名額。
- 只有 `ai-workflow run`（含「繼續」「重跑」接著跑的部分）會排隊；起草 PRD 與產生任務不排隊。

## 每個任務做什麼

```
內建排程器選擇下一項
  → 內建引擎標記 in-progress
  → 開新的實作者對話（prompt 直接附上 handover、context 檔、完整 PRD 與任務 JSON；不 resume 舊對話）
  → 跑 build / lint / test ──失敗──→ 把錯誤輸出交給修正者修正 ─┐
  → set-status review，審查者看這個任務的 git diff ──FAIL──→ 把意見交給修正者修正 ─┤
  ↑                                                                              │
  └──────────── 修正最多 max_fix_rounds 輪，用盡就停下來等人處理 ───────────────────┘
  → handover AI 以唯讀方式輸出新版交接紀錄，ai-workflow 寫進資料目錄的 handover.md
  → 自動模式：set-status done + git commit；手動模式：停在「等待測試」
```

- diff 是用暫存 index 把「任務開始前」與「現在」的工作目錄存成 git tree 再比較，所以手動模式沒有 commit 也能只看到這個任務的變更，而且不會動到你的 git index。
- 實作者被要求不要 commit、不要切分支、不要改 `.taskmaster/` 與流程資料；handover 不在專案裡，由獨立的一步產生並由程式存檔，所以 diff 與 commit 裡只有真正的程式變更。
- Claude 會以 `--add-dir` 把專案資料目錄加成額外工作目錄，才讀得到 Skill 快照與參考資料；Codex 的唯讀／workspace-write 沙箱本來就能讀專案以外的檔案。

## 模式

| | 自動模式 `auto` | 手動模式 `manual`（預設） |
| --- | --- | --- |
| git commit | 每個任務通過驗證和審查後自動 commit（訊息 `ai-workflow: task <id> <標題>`） | 不 commit，由你決定 |
| 分支 | 自動切到 `ai-workflow/<feature>`（不存在就從目前 HEAD 建立），不在 main 上 commit | 不切分支 |
| 何時停下來 | PRD 等待核准、所有任務完成待功能測試、修正輪數用盡 | 以上三種，加上每個任務完成後 |
| 任務狀態 | 任務通過後直接 `done` | 等你按「繼續」才 `done`，之前是 `review` |

在設定頁或 `ai-workflow mode <auto|manual>` 切換，適用所有專案；下一個任務開始時生效。

## 重跑任務

任務詳情的「重跑任務」：

- 不勾「還原」：直接在目前程式碼上重新實作。
- 勾「還原」：自動模式用 `git revert` 還原該任務的 commit（不改寫歷史）；手動模式把該任務改過的檔案還原到任務開始前的狀態（新增的檔案刪除）。注意手動模式下，之後任務對同一批檔案的修改也會一起被還原。

流程卡住（修正輪數用盡）時，你可以手動修好程式碼再按「我測完了，繼續」：ai-workflow 會重新驗證和審查這個任務（不重新實作，修正輪數重算）。

## 全域設定 `~/.ai-workflow/config.json`

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
  "codex": { "model": "", "effort": "", "windows_sandbox": "elevated", "network_access": true },  // windows_sandbox：Windows 預設 elevated，其他平台空字串
  "skills": { "prd": [], "prd_review": [], "tasks": [], "implement": ["uiux-design"], "code_review": [], "fix": [], "handover": [] }
}
```

每個專案的 `~/.ai-workflow/projects/<id>/project.json` 只有：

```jsonc
{
  "feature": "csv-export",          // 自動模式分支名 <branch_prefix><feature>；空字串時用 PRD 想法產生
  "commands": { "build": "", "test": "npm test", "lint": "npm run lint" },
  "context_files": []               // 專案內既有檔案的路徑（相對於專案或絕對路徑），每次 AI 對話都會附上內容
}
```

加入專案時依 `package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml` 猜 build/test/lint 指令，猜不到就留空，請在專案頁填。`context_files` 預設是空的：ai-workflow 不再在專案裡建立範本檔。

舊版 `~/.aipipe` 會在第一次啟動時整個搬成 `~/.ai-workflow`；環境變數 `AI_WORKFLOW_HOME`（舊名 `AIPIPE_HOME` 仍接受）可以換位置。

### 任務與技能設定

`ai-workflow tasks` 直接呼叫「拆任務」角色的 AI 拆解已核准 PRD，由內建引擎驗證、保存與排程；不再呼叫 Task Master。設定 `skills` 可指定各階段使用的技能，任務自己的 `skills` 也會帶入實作、修正與 review。

## 費用與安全

- 只呼叫官方 CLI：`claude -p`、`codex exec`。
- 啟動任何子程序前（含 build/test/lint）會移除這些環境變數：`ANTHROPIC_*`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CODEX_API_KEY`、`OPENAI_CODEX_API_KEY`，以及從上層 Claude Code session 繼承的 `CLAUDECODE`、`CLAUDE_CODE_*`（`CLAUDE_CODE_GIT_BASH_PATH` 除外）、`CLAUDE_AGENT_SDK_*`。CLI 只能用訂閱登入，沒登入就直接失敗，不會改走付費 API。
- 不使用 `--dangerously-skip-permissions` 或 `--dangerously-bypass-approvals-and-sandbox`：

  | 角色 | Claude | Codex |
  | --- | --- | --- |
  | 會改檔案（實作者、修正者） | `--permission-mode auto` | `--sandbox workspace-write`，並開放網路 |
  | 唯讀（PRD 作者／審查、拆任務、程式碼審查、handover、對話） | `--permission-mode dontAsk --disallowedTools Edit,Write,NotebookEdit` | `--sandbox read-only` |

  `auto` 由 Claude Code 的安全分類器判斷：建專案、`npm install`、跑測試這類一般開發指令會放行，有風險的操作仍會被擋。想更嚴格可以在全域設定把 `claude.write_permission_mode` 改成 `acceptEdits`（只允許編輯檔案，所有指令都會被拒絕），再用 `claude.allowed_tools` 個別允許，例如 `"Bash(npm test:*)"`。Codex 的寫入角色預設可以連網（`codex.network_access`，設成 false 就關閉）。實作者的工具呼叫被擋下又沒有任何變更時，任務會直接停在「需要人工處理」並說明原因，不會送審查空的 diff。
- prompt 一律從 stdin 傳入，避開命令列長度限制與跳脫問題。
- 修正輪數、PRD 審查輪數都有上限，每次 AI 呼叫與每個指令都有逾時。

## 檔案

目標專案裡：**沒有任何 ai-workflow 產生的檔案**（自動模式只會多出 git commit 與分支）。

使用者目錄：

```
~/.ai-workflow/
  config.json                全域設定（角色、模型、模式、執行環境、上限…）
  projects.json              總覽的專案清單
  queue.json                 全域執行佇列（執行中、排隊中的 pid）
  limits.json                各 AI 帳號的訂閱額度快照
  projects/<專案 id>/        每個專案的流程資料（id 是專案路徑的 sha1 前 10 碼）
    project.json             build/test/lint、feature、context_files
    state.json               流程、PRD、各任務狀態
    logs/*.log               runner、prd、tasks、task-<id>、process
    prd/                     各版 PRD（v1.md…）、每輪審查意見、使用者意見
    prd.md                   核准後的 PRD
    handover.md              給下一個 AI session 的交接紀錄
    tasks.json               內建任務資料（每個功能一個群組）
    tasks/<id>/              checks.txt、review-N.md、diff.patch、implement.md
    backlog.json             需求待辦清單
    archive/<日期>-<功能>/   功能封存
    chats/、references/      專案對話、參考資料快照
    skills/、skill-runs/     這個專案的技能庫與技能會議
    sessions/、usage.json    每次 AI 呼叫的紀錄與 token 用量
    tmp/                     每次送出的 prompt、Skill 快照、codex 最後回覆
    migrated.json            舊版資料搬移紀錄（只在搬過時存在）
```

舊版把 `.aipipe.json`、`.aipipe/`、`docs/aipipe/backlog.json`、`docs/prd/`、`docs/handovers/current_handover.md` 放在專案裡；第一次開啟這種專案時會自動複製到上面的位置，並在 `logs/process.log` 說明搬了什麼。舊檔不會被刪，確認後請自己清理（也可以從 `.gitignore` 移掉 `.aipipe/`）。

桌面 app 與流程是不同程序，透過 `projects/<id>/state.json` 溝通；UI 的按鈕會用同一支 exe 在背景啟動對應的子指令（輸出寫到 `logs/process.log`）。關掉 app 不會中斷正在跑的流程。

## 在 WSL 裡執行 CLI

每個 CLI 可以分別選擇在 Windows 原生或 WSL 裡執行。例如 claude 裝在 WSL、codex 用 Windows 版（全域設定）：

```jsonc
{
  "runtime": { "claude": "wsl", "codex": "windows" },
  "wsl_distro": "Ubuntu",     // 空字串＝WSL 預設發行版
  "wsl_cli": { "claude": "", "codex": "" }  // WSL 裡的指令名或路徑，空字串＝claude / codex
}
```

設定頁可以切換 runtime，並按「檢查 CLI（doctor）」確認。預設全部是 `auto`，依專案位置選擇環境。詳見[自動路由與單 AI 模式](docs/runtime.md)。`runtime` 為 `wsl` 時 `cli.*` 不使用（那是 Windows 路徑）。

運作方式：

- 實際執行 `wsl.exe -d <distro> --cd <專案的 Windows 路徑> -e bash -lc '<清理腳本>' ai-workflow <cli> <參數…>`。用 `-e` 而不是 `--`：`--` 會把參數接成字串交給預設 shell（例如 zsh）重新解析，引號、`$`、`;` 會被破壞。
- prompt 一律從 stdin 傳入，不放在命令列。
- 需要路徑的參數（例如 codex 的 `-C`、`-o`、Claude 的 `--add-dir`）會用 `wslpath -a` 轉成 `/mnt/c/...`。
- **API key 在 WSL 端再清一次**：login shell 會讀 `.bashrc`／`.profile`，Windows 端也可能透過 `WSLENV` 轉送變數。清理腳本會 `unset` 所有 `ANTHROPIC_*`、`CLAUDE_CODE_*`、`OPENAI_API_KEY` 等變數，最後再用 `exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CODEX_API_KEY` 執行 CLI。
- `ai-workflow doctor` 會檢查 Windows 與目標 WSL 發行版的 Claude Code／Codex 版本及訂閱登入；只有一個可用時進入單 AI 模式，兩個都不可用才阻擋 AI 工作。

注意事項：

- **I/O 較慢**：專案在 Windows 磁碟時，WSL 裡的 CLI 透過 `/mnt/c` 存取，讀寫大量檔案明顯比原生慢。專案很大時，考慮把整個專案放在 WSL 檔案系統、全部 CLI 都用 WSL。
- **換行符號**：WSL 裡的工具寫出 LF，Windows 上的 git 若設 `core.autocrlf=true` 會把 LF 轉成 CRLF，diff 可能出現整檔換行差異。建議在專案加 `.gitattributes`（例如 `* text=auto eol=lf`），並讓 Windows 與 WSL 的 git 設定一致。
- 逾時中止時 ai-workflow 會結束 `wsl.exe`；WSL 裡的子程序通常會跟著結束，但不保證。

## Windows 注意事項

- **Codex 的 workspace-write**：Windows 上 Codex 沒設 `windows.sandbox` 時，會把 `--sandbox workspace-write` 默默降成 read-only，實作者就改不了檔案。ai-workflow 會帶 `-c windows.sandbox="<codex.windows_sandbox>"`（Windows 預設 `elevated`）。如果 Codex 仍回報 read-only，該任務會直接停在「需要人工處理」並提示你改設定，不會白白耗掉修正輪數。`elevated` 需要 Codex 的 Windows 沙箱已完成一次性設定（裝過 Codex 桌面版通常已設定好）；不行的話改 `unelevated`。
- npm 全域安裝的 `.cmd` 包裝檔（例如 `codex.cmd`）會被解析成 `node <js 入口>` 直接執行，不經過 cmd.exe。

## 桌面版（Windows）

標準的 Tauri 2 專案：`src/` 是前端（原生 HTML／JS，不需要打包工具），`src-tauri/` 是 Rust 後端。

- **全部在 Rust**：PRD 流程、內建任務引擎、執行器、git、WSL、用量追蹤都在 `src-tauri/src/core/`。前端透過 Tauri command `api`（路徑和格式沿用舊版 HTTP API，例如 `/api/p/<id>/state`、全域設定用 `/api/config`）呼叫，狀態與 log 的變化以 Tauri 事件推送。
- **同一支 exe 也是 CLI**：帶子指令執行時不開視窗（從終端機執行會接到目前的主控台）。UI 按鈕啟動的流程也是用這個方式另開背景程序，關掉 app 不會中斷。
- **原生功能**：總覽的「選擇資料夾」用系統對話框；系統匣圖示（左鍵開視窗、右鍵「結束 ai-workflow」）；關閉視窗會縮到系統匣，背景繼續監看；專案進入等待核准、等待測試、功能待測試、需要人工處理、錯誤時跳 Windows 通知。

安裝：執行 `ai-workflow_<版本>_x64-setup.exe`（NSIS，裝在目前使用者，不需要系統管理員）。更新前請從系統匣選「結束 ai-workflow」；點視窗關閉只會縮到系統匣。

自己建置（需要 Rust stable、VS 2022 C++ Build Tools、Node 20+（只用來跑 Tauri CLI）；WebView2 Windows 11 內建）：

```bash
npm install
npm run build        # tauri build
```

安裝檔在 `src-tauri/target/release/bundle/nsis/`。`npm run dev` 開發模式啟動；`npm run icons` 從 `src-tauri/icons/icon.svg` 重新產生圖示。

桌面版的限制：

- claude、codex 至少安裝並登入一個。npm 裝的 CLI（例如 npm 版 codex）本身需要 Node，ai-workflow 會從 PATH 找 `node` 來執行這些 `.js` CLI；原生 exe 版或 WSL 裡的 CLI 則不需要。
- exe 沒有程式碼簽章，第一次執行 Windows SmartScreen 可能會提示。
- 同時開兩個 app 會各自監看（彼此透過 `~/.ai-workflow` 共用專案清單、設定與佇列），通知會重複。

## 限制

- 自動模式需要 git 使用者身分（`git config user.name`／`user.email`），沒設定時 `run` 一開始就會報錯。
- 從手動模式中途切到自動模式時，先前手動模式留下、尚未 commit 的變更會被併進下一個自動 commit。
- 「暫停」在目前任務結束後才生效，不會中斷正在跑的 AI 呼叫。
- 同一個專案同時只能有一個 `ai-workflow run`；不同專案之間由全域佇列決定誰先跑。
- 需求待辦的拖曳排序用 HTML5 drag and drop（滑鼠）；鍵盤與觸控請用上／下按鈕。
- Claude 與 Codex 的訂閱用量上限照常適用；用量耗盡時 CLI 會回錯，該任務會停在「需要人工處理」。

## 開發

本機開發不需要安裝 `ai-workflow_<版本>_x64-setup.exe`：裝好 Rust stable、VS 2022 C++ Build Tools 與 Node 20+ 後，`npm install` 再 `npm run dev` 就會以開發模式開桌面視窗（Tauri dev，改前端檔案會即時重載）。命令列版用 `cargo run --manifest-path src-tauri/Cargo.toml -- <指令>`（例如 `-- status`、`-- doctor`）或 `src-tauri/target/debug/ai-workflow-desktop.exe <指令>`。`npm run build` 只有要產生安裝檔時才需要。

```bash
npm test     # cargo test：不呼叫任何 AI；CLI 由 src-tauri/examples/fake_cli.rs 扮演，全域資料寫到暫存的 AI_WORKFLOW_HOME
npm run lint # cargo clippy -D warnings
npm run test:ui  # 只跑前端 jsdom 測試，不需要 Rust
```

介面設計規範在 [docs/design-system.md](docs/design-system.md)。


### 檔案與資料夾參考

需求待辦、PRD、任務看板與專案對話都有「加入參考」。可選取檔案／資料夾、貼上完整路徑、重用已匯入的資料，也可拖放檔案或資料夾到對應區域。需求說明、PRD 修改意見及聊天輸入支援 `@` 搜尋專案檔案；聊天與需求輸入可以貼上剪貼簿圖片。

- 需求的附件會在起草時帶入 PRD；功能參考會供 PRD 作者、雙人審查及拆任務使用，產生任務時固定在任務群組上。
- 任務看板頂部的「參考」按鈕可調整該群組的共用參考。單一任務可再加入額外資料，子任務也會沿用父任務參考；實作、修正、審查、handover 都使用這些資料。
- 聊天附件保存於對應使用者訊息，追問會沿用，切換聊天的未送出附件各自保留。完整對話附件不刪除；每次模型脈絡最多帶最近 24 份。
- 資料保存於 `~/.ai-workflow/projects/<id>/references/<id>/`，包含原始快照、SHA-256 清單及 PDF 擷取文字。原始來源搬動或刪除後仍可使用。來源內容更新時，請重新加入建立新快照；移除附件只解除綁定，以保留歷史紀錄。
- Windows 及 WSL 專案皆使用資料目錄裡的快照路徑；WSL 專案可貼上同發行版的 `/home/...` 路徑，其他情況請選擇檔案或使用完整 `\\wsl.localhost\Ubuntu\...` 路徑。

單檔最多 20 MB，每份資料夾最多 64 MB／2000 檔，一個綁定最多 24 份，本次執行合計最多 96 MB。資料夾匯入會排除 `.git`、`.aipipe`、`node_modules`、建置產物、`.env*`、`.pem`、`.key` 與連結。使用者明確選取的個別檔案可直接加入。

PNG、JPEG、WebP、GIF 圖片會傳入 Claude 的結構化圖片訊息或 Codex 的 `--image`（單次最多 8 張、合計 20 MB）；資料夾內其他圖片可由 CLI 依需要讀取。PDF 保留原檔並擷取文字，掃描 PDF 沒有 OCR，會顯示提示。其他格式提供原始快照路徑，實際解析能力依 CLI 工具而定。文字內容與清單有節錄預算，完整快照仍可由 AI 讀取。

互動參考 [Claude Code Desktop 官方說明](https://code.claude.com/docs/en/desktop)，圖片輸入使用 [Claude streaming input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode) 與 [Codex CLI image 參數](https://learn.chatgpt.com/docs/cli/reference)。本功能沿用本機 CLI 訂閱登入。
