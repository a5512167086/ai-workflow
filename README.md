# aipipe

把「多個 AI 討論 → 寫 PRD 並交叉審查 → 內建引擎拆任務 → 每個任務開新對話並帶 handover → 驗證與審查 → 更新 handover → 人工測試」這套流程自動化的 Windows 桌面工具，同一支程式也能當命令列使用。

- **只用你自己的訂閱**：一律呼叫本機已登入的官方 CLI（`claude -p`、`codex exec`），不需要也不使用 API key。
- **通用**：任何有 git 的軟體專案都能用，build/test/lint 指令寫在專案的 `.aipipe.json`。
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

> 只裝 Claude 桌面版、沒有獨立的 `claude` 指令時，可以把桌面版內建的 `claude.exe` 路徑填進 `.aipipe.json` 的 `cli.claude`，但仍要先用它執行一次 `claude.exe auth login`。

## 安裝

執行 `aipipe_<版本>_x64-setup.exe`（見[桌面版](#桌面版windows)）。安裝後開始選單的 aipipe 就是桌面 app；
同一支 `aipipe-desktop.exe` 帶子指令執行時就是命令列版（例如 `aipipe-desktop.exe status`），可以把安裝目錄加進 PATH，
或建立名為 `aipipe` 的別名。下面的範例都寫成 `aipipe`。

## 快速開始

```bash
cd 你的專案            # 不是 git repo 時 init 會詢問是否 git init（或加 --git-init）
aipipe init            # 建立 .aipipe.json、docs/ai-context.md、docs/index.md 範本
aipipe doctor          # 檢查 Windows／WSL 的 Claude Code、Codex 是否安裝並以訂閱登入
aipipe projects add    # 加入桌面 app 的總覽，之後在 app 裡操作
```

在專案畫面裡依序：

0. **需求待辦**（選用）：先把想做的功能列進待辦、排好順序，按「起草 PRD」就用那一項開始。
1. **需求待辦**：新增需求後按「起草 PRD」。作者 AI 起草，審查 AI 審，來回最多 `max_prd_rounds` 輪。PRD 頁右側可以展開每一輪的審查意見。
2. 看完 PRD 後按「核准 PRD」，或在下方寫意見按「要求再改」（作者修訂後會再審一輪）。
3. 桌面版核准後自動產生任務；只有失敗時才顯示「重新產生任務」。
4. **任務看板**：按「開始」。點任務卡可以看目前步驟、修正輪數、即時 log、test 輸出、審查意見、diff。
5. 流程停下來時（等待測試、功能完成、修正輪數用盡），自己測過後按「我測完了，繼續」。

首頁「設定」可選擇專案，分別指定 PRD 作者、PRD 審查、拆任務、實作、修正、程式碼審查與 handover 的 AI、模型與推理強度；兩個審查角色也可選雙人審查，兩份意見都通過才會繼續。舊設定的拆任務沿用作者設定，修正與 handover 沿用實作者設定，之後可以各自調整。Handover 是給下一個 AI session 的交接紀錄，記錄完成內容、驗證結果與待處理事項，預設寫入 `docs/handovers/current_handover.md`。

「紀錄」整合目前功能的可展開 Log、PRD、每輪紀錄及任務，也可切換歷史功能查看封存。App 外框不捲動，長內容在各工作區內捲動；新增需求與待辦清單填滿可用高度。

專案選擇頁的每張卡片都有「設定」入口。工作流程的自動／手動模式與全域執行佇列也在設定裡，與 CLI 的 Windows／WSL 自動選擇分開。模型欄位可填完整版本；下方顯示可取得的預設值與來源。Claude 版本清單參考[官方模型設定文件](https://code.claude.com/docs/en/model-config)，實際可用性依 CLI 版本與帳號而定；帳號動態預設未回報時會明確標示。

任務遇到訂閱額度不足時，畫面提供「確認並以另一個 AI 繼續」。確認後，只有這次執行改用另一個 AI，實作與審查仍使用不同 session，雙人審查暫時降為單人；不修改原本角色設定。保留現有變更並重新驗證，另一個 AI 也無法完成時停止。額度恢復後，可在用量頁更新資料。

Claude Pro 訂閱不包含 Fable 的用量；Claude Code 可選 Fable，但需額外 usage credits，詳見[官方方案說明](https://support.claude.com/en/articles/15424964-claude-fable-models-on-your-plan)。模型建議清單不列 Fable。

同樣的流程也可以全用命令列：

```bash
aipipe prd "加入 CSV 匯出功能，可選欄位與日期範圍"
aipipe prd --revise "日期範圍要支援時區"   # 要求再改
aipipe prd --approve                        # 核准
aipipe tasks
aipipe run
aipipe continue                             # 我測完了，繼續
aipipe rerun 3 --revert                     # 還原任務 3 的變更後重跑
aipipe mode auto                            # 切換模式
aipipe status
aipipe prd --backlog <id>                   # 用需求待辦裡的一項起草 PRD
aipipe projects list                        # 總覽裡的專案與狀態
aipipe projects add [目錄]                  # 加入總覽（預設目前專案）
aipipe projects remove <id|目錄|名稱>       # 移出總覽（不刪任何檔案）
aipipe queue                                # 看全域執行佇列
aipipe queue --max 2                        # 同時最多跑 2 個專案的流程
```

在專案子目錄執行也可以，aipipe 會往上找 `.aipipe.json`；或用 `--cwd <路徑>` 指定專案。

## 多專案總覽

桌面 app 的首頁是總覽：每個專案一張卡片，顯示目前狀態（閒置、PRD 起草中、等待核准、排隊中、執行中、等待測試、功能待測試、需要人工處理…）、目前的功能、任務進度，點進去就是單一專案畫面。需要你處理的專案會標出來，頂列顯示有幾個在等你。

專案清單存在 `~/.aipipe/projects.json`（可以用環境變數 `AIPIPE_HOME` 換位置），依最近開啟排序。從總覽或 `aipipe projects add` 加入；資料夾還沒有 `.aipipe.json` 時，總覽會問你要不要用預設值初始化。移除只是移出清單，不會刪任何檔案。

## 需求待辦清單

每個專案一份，存在 `docs/aipipe/backlog.json`（可以用 `.aipipe.json` 的 `backlog_path` 改），建議 commit。選 JSON 是因為要排序、要有穩定的 id 對應封存；內容很單純：

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

每個功能核准的 PRD 會自動封存到 `docs/prd/<日期>-<功能>/`（`.aipipe.json` 的 `archive_dir` 可改），可以 commit：

```
docs/prd/2026-11-01-匯出-csv/
  prd.md                     核准的 PRD
  rounds/01-draft-r0-v1.md   每一輪：初稿、審查（含結論）、修訂、使用者意見
  rounds/02-review-r1-revise-v1.md
  tasks.json                 這個功能的任務清單（含最後狀態）
  meta.json                  想法、核准／完成時間、任務群組、進度、待辦項目 id
```

- 核准 PRD 時建立；同一個功能重新核准會更新同一個資料夾。
- 產生任務後、每次 `aipipe run` 結束時、功能完成時更新 `tasks.json`。
- 開始下一個功能（起草新的 PRD）時一定建新資料夾；同一天同名的功能會加 `-2`、`-3`，不會覆蓋。
- UI 的「紀錄」分頁可以瀏覽每個封存的 PRD（Markdown 渲染）、每輪紀錄與任務清單。

### 每個功能一個任務群組

內建任務引擎將不同功能的任務保存在 `.aipipe/tasks.json` 的獨立群組，包含依賴、狀態事件及 PRD 版本；不需要安裝 Task Master。舊 Task Master 多群組任務會在首次更新時匯入並保留來源。

## Skills

桌面版的「用量」頁可查看各次執行與本專案的 token 處理量、CLI 回報的訂閱額度剩餘百分比及重設時間。詳見[Token 與額度顯示](docs/usage.md)。

「Skills」頁提供共用技能庫、階段綁定和互動會議。預設提供 Grill Me 與 UI/UX Design；可匯入包含 `SKILL.md` 的資料夾。Codex／Claude Code 都透過 App 載入同一份可攜式指令。每次執行保存技能快照與 session，下一輪問答以紀錄交接到新 session。

```bash
aipipe skills list
aipipe skills import <資料夾>
aipipe skills run grill-me --input "我要做報表工具" --provider codex
```

完整設定與相容性見[內建任務引擎與共用 Skills](docs/tasks-and-skills.md)。

## 執行佇列

所有專案的 `aipipe run` 共用一個全域佇列（`~/.aipipe/queue.json`），預設同時只跑 1 個，用 `aipipe queue --max <n>` 或總覽的「同時執行的流程上限」改（1–8）。

- 輪不到的專案顯示「排隊中」，前面的停下來或做完後自動接上（每 1.5 秒檢查一次）。
- 停下來等人的專案（等待核准、等待測試、需要人工處理）不佔名額：那時 `aipipe run` 已經結束。
- 排隊中按「暫停」會放棄排隊。
- 佇列由各個 run 程序自己維護，不需要 UI 開著；當掉的程序會被自動清掉，不會卡住名額。
- 只有 `aipipe run`（含「繼續」「重跑」接著跑的部分）會排隊；起草 PRD 與產生任務不排隊。

## 每個任務做什麼

```
內建排程器選擇下一項
  → 內建引擎標記 in-progress
  → 開新的實作者對話（附 handover、context 檔、任務 JSON；不 resume 舊對話）
  → 跑 build / lint / test ──失敗──→ 把錯誤輸出交給實作者修正 ─┐
  → set-status review，審查者看這個任務的 git diff ──FAIL──→ 把意見交給實作者修正 ─┤
  ↑                                                                              │
  └──────────── 修正最多 max_fix_rounds 輪，用盡就停下來等人處理 ───────────────────┘
  → 實作者更新 handover（docs/handovers/current_handover.md）
  → 自動模式：set-status done + git commit；手動模式：停在「等待測試」
```

- diff 是用暫存 index 把「任務開始前」與「現在」的工作目錄存成 git tree 再比較，所以手動模式沒有 commit 也能只看到這個任務的變更，而且不會動到你的 git index。
- 實作者被要求不要 commit、不要切分支、不要改 `.aipipe/`、`.taskmaster/` 和 handover（handover 由獨立的一步更新）。

## 模式

| | 自動模式 `auto` | 手動模式 `manual`（預設） |
| --- | --- | --- |
| git commit | 每個任務通過驗證和審查後自動 commit | 不 commit，由你決定 |
| 分支 | 自動切到 `aipipe/<feature>`（不存在就從目前 HEAD 建立），不在 main 上 commit | 不切分支 |
| 何時停下來 | PRD 等待核准、所有任務完成待功能測試、修正輪數用盡 | 以上三種，加上每個任務完成後 |
| 任務狀態 | 任務通過後直接 `done` | 等你按「繼續」才 `done`，之前是 `review` |

在 `.aipipe.json` 的 `mode` 或 UI 右上角切換。下一個任務開始時生效。

## 重跑任務

任務詳情的「重跑任務」：

- 不勾「還原」：直接在目前程式碼上重新實作。
- 勾「還原」：自動模式用 `git revert` 還原該任務的 commit（不改寫歷史）；手動模式把該任務改過的檔案還原到任務開始前的狀態（新增的檔案刪除）。注意手動模式下，之後任務對同一批檔案的修改也會一起被還原。

流程卡住（修正輪數用盡）時，你可以手動修好程式碼再按「我測完了，繼續」：aipipe 會重新驗證和審查這個任務（不重新實作，修正輪數重算）。

## `.aipipe.json`

```jsonc
{
  "mode": "manual",                 // auto | manual
  "feature": "csv-export",          // 自動模式分支名 aipipe/<feature>；空字串時用 PRD 想法產生
  "commands": { "build": "", "test": "npm test", "lint": "npm run lint" },
  "context_files": ["docs/ai-context.md", "docs/index.md"],
  "handover_path": "docs/handovers/current_handover.md",
  "prd_path": "docs/aipipe/prd.md",  // 核准後的 PRD
  "backlog_path": "docs/aipipe/backlog.json",  // 需求待辦清單
  "archive_dir": "docs/prd",        // 功能封存的上層資料夾
  "roles": {                        // 每個角色填 claude 或 codex
    "author": "claude",             // 起草／修訂 PRD
    "reviewer": "codex",            // 審查 PRD
    "implementer": "claude",        // 實作、修正、更新 handover
    "code_reviewer": "codex"        // 審查 git diff
  },
  "max_fix_rounds": 3,              // 每個任務最多修正幾輪（1–10）
  "max_prd_rounds": 2,              // PRD 審查最多幾輪（1–10）
  "num_tasks": 0,                   // 0 = 交給 AI 決定
  "command_timeout_sec": 900,       // build/test/lint 逾時
  "agent_timeout_sec": 1800,        // 每次 AI 呼叫逾時
  "branch_prefix": "aipipe/",
  "cli": { "claude": "", "codex": "" },  // 空字串 = 從 PATH 找
  "claude": { "model": "", "allowed_tools": [] },
  "codex": { "model": "", "windows_sandbox": "elevated" },  // Windows 預設 elevated，其他平台空字串
  "skills": { "prd": [], "prd_review": ["grill-me"], "tasks": [], "implement": ["uiux-design"], "code_review": [], "fix": [], "handover": [] }
}
```

`init` 會依 `package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml` 猜 build/test/lint 指令，猜不到就留空，請自己填。

### 任務與技能設定

`aipipe tasks` 直接呼叫「拆任務」角色的 AI 拆解已核准 PRD，由內建引擎驗證、保存與排程；不再呼叫 Task Master。設定 `skills` 可指定各階段使用的技能，任務自己的 `skills` 也會帶入實作、修正與 review。

## 費用與安全

- 只呼叫官方 CLI：`claude -p`、`codex exec`。
- 啟動任何子程序前（含 build/test/lint）會移除這些環境變數：`ANTHROPIC_*`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CODEX_API_KEY`、`OPENAI_CODEX_API_KEY`，以及從上層 Claude Code session 繼承的 `CLAUDECODE`、`CLAUDE_CODE_*`（`CLAUDE_CODE_GIT_BASH_PATH` 除外）、`CLAUDE_AGENT_SDK_*`。CLI 只能用訂閱登入，沒登入就直接失敗，不會改走付費 API。
- 不使用 `--dangerously-skip-permissions` 或 `--dangerously-bypass-approvals-and-sandbox`：

  | 角色 | Claude | Codex |
  | --- | --- | --- |
  | 會改檔案（實作者） | `--permission-mode acceptEdits` | `--sandbox workspace-write` |
  | 唯讀（PRD 作者／審查、程式碼審查） | `--permission-mode dontAsk --disallowedTools Edit,Write,NotebookEdit` | `--sandbox read-only` |

  `acceptEdits` 只自動允許編輯檔案；Claude 實作者要跑指令時會被拒絕（驗證由 aipipe 自己跑）。需要的話在 `claude.allowed_tools` 加例如 `"Bash(npm test:*)"`。
- prompt 一律從 stdin 傳入，避開命令列長度限制與跳脫問題。
- 修正輪數、PRD 審查輪數都有上限，每次 AI 呼叫與每個指令都有逾時。
- UI 只綁定 `127.0.0.1`，檢查 Host 標頭，POST 需要自訂標頭，擋掉其他網站的跨站請求。

## 檔案

目標專案裡：

```
.aipipe.json                 設定（建議 commit）
.aipipe/                     狀態與 log（init 會加進 .gitignore）
  state.json                 流程、PRD、各任務狀態
  logs/*.log                 runner、prd、tasks、task-<id>、process
  prd/                       各版 PRD（v1.md…）、每輪審查意見、使用者意見
  tasks/<id>/                checks.txt、review-N.md、diff.patch、implement.md
  tmp/                       每次送出的 prompt 與 codex 最後回覆
.aipipe/tasks.json           內建任務資料（每個功能一個群組）
docs/handovers/current_handover.md
docs/aipipe/backlog.json     需求待辦清單（建議 commit）
docs/prd/<日期>-<功能>/      功能封存（建議 commit）
```

使用者目錄：

```
~/.aipipe/projects.json      總覽的專案清單
~/.aipipe/queue.json         全域執行佇列（執行中、排隊中的 pid）
~/.aipipe/config.json        全域設定（max_concurrent_runs）
```

桌面 app 與流程是不同程序，透過 `.aipipe/state.json` 溝通；UI 的按鈕會用同一支 exe 在背景啟動對應的 aipipe 子指令（輸出寫到 `.aipipe/logs/process.log`）。關掉 app 不會中斷正在跑的流程。

## 在 WSL 裡執行 CLI

每個 CLI 可以分別選擇在 Windows 原生或 WSL 裡執行。例如 claude 裝在 WSL、codex 用 Windows 版：

```jsonc
{
  "runtime": { "claude": "wsl", "codex": "windows" },
  "wsl_distro": "Ubuntu",     // 空字串＝WSL 預設發行版
  "wsl_cli": { "claude": "", "codex": "" }  // WSL 裡的指令名或路徑，空字串＝claude / codex
}
```

UI 的「設定」分頁可以切換這些選項，並按「檢查 CLI（doctor）」確認。新專案預設全部是 `auto`，依專案位置選擇環境；舊設定的明確指定仍保留。詳見[自動路由與單 AI 模式](docs/runtime.md)。`runtime` 為 `wsl` 時 `cli.*` 不使用（那是 Windows 路徑）。

運作方式：

- 實際執行 `wsl.exe -d <distro> --cd <專案的 Windows 路徑> -e bash -lc '<清理腳本>' aipipe <cli> <參數…>`。用 `-e` 而不是 `--`：`--` 會把參數接成字串交給預設 shell（例如 zsh）重新解析，引號、`$`、`;` 會被破壞。
- prompt 一律從 stdin 傳入，不放在命令列。
- 需要路徑的參數（例如 codex 的 `-C`、`-o`）會用 `wslpath -a` 轉成 `/mnt/c/...`。
- **API key 在 WSL 端再清一次**：login shell 會讀 `.bashrc`／`.profile`，Windows 端也可能透過 `WSLENV` 轉送變數。清理腳本會 `unset` 所有 `ANTHROPIC_*`、`CLAUDE_CODE_*`、`OPENAI_API_KEY` 等變數，最後再用 `exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CODEX_API_KEY` 執行 CLI。
- `aipipe doctor` 會檢查 Windows 與目標 WSL 發行版的 Claude Code／Codex 版本及訂閱登入；只有一個可用時進入單 AI 模式，兩個都不可用才阻擋 AI 工作。

注意事項：

- **I/O 較慢**：專案在 Windows 磁碟時，WSL 裡的 CLI 透過 `/mnt/c` 存取，讀寫大量檔案明顯比原生慢。專案很大時，考慮把整個專案放在 WSL 檔案系統、全部 CLI 都用 WSL。
- **換行符號**：WSL 裡的工具寫出 LF，Windows 上的 git 若設 `core.autocrlf=true` 會把 LF 轉成 CRLF，diff 可能出現整檔換行差異。建議在專案加 `.gitattributes`（例如 `* text=auto eol=lf`），並讓 Windows 與 WSL 的 git 設定一致。
- 逾時中止時 aipipe 會結束 `wsl.exe`；WSL 裡的子程序通常會跟著結束，但不保證。

## Windows 注意事項

- **Codex 的 workspace-write**：Windows 上 Codex 沒設 `windows.sandbox` 時，會把 `--sandbox workspace-write` 默默降成 read-only，實作者就改不了檔案。aipipe 會帶 `-c windows.sandbox="<codex.windows_sandbox>"`（Windows 預設 `elevated`）。如果 Codex 仍回報 read-only，該任務會直接停在「需要人工處理」並提示你改設定，不會白白耗掉修正輪數。`elevated` 需要 Codex 的 Windows 沙箱已完成一次性設定（裝過 Codex 桌面版通常已設定好）；不行的話改 `unelevated`。
- npm 全域安裝的 `.cmd` 包裝檔（例如 `codex.cmd`）會被解析成 `node <js 入口>` 直接執行，不經過 cmd.exe。

## 桌面版（Windows）

標準的 Tauri 2 專案：`src/` 是前端（原生 HTML／JS，不需要打包工具），`src-tauri/` 是 Rust 後端。

- **全部在 Rust**：PRD 流程、內建任務引擎、執行器、git、WSL、用量追蹤都在 `src-tauri/src/core/`。前端透過 Tauri command `api`（路徑和格式沿用舊版 HTTP API，例如 `/api/p/<id>/state`）呼叫，狀態與 log 的變化以 Tauri 事件推送。
- **同一支 exe 也是 CLI**：帶子指令執行時不開視窗（從終端機執行會接到目前的主控台）。UI 按鈕啟動的流程也是用這個方式另開背景程序，關掉 app 不會中斷。
- **原生功能**：總覽的「選擇資料夾」用系統對話框；系統匣圖示（左鍵開視窗、右鍵「結束 aipipe」）；關閉視窗會縮到系統匣，背景繼續監看；專案進入等待核准、等待測試、功能待測試、需要人工處理、錯誤時跳 Windows 通知。
- **資料格式不變**：`.aipipe.json`、`.aipipe/`、`~/.aipipe/` 的格式與舊的 Node 版相同，既有專案直接可用。

安裝：執行 `aipipe_<版本>_x64-setup.exe`（NSIS，裝在目前使用者，不需要系統管理員）。更新前請從系統匣選「結束 aipipe」；點視窗關閉只會縮到系統匣。

自己建置（需要 Rust stable、VS 2022 C++ Build Tools、Node 20+（只用來跑 Tauri CLI）；WebView2 Windows 11 內建）：

```bash
npm install
npm run build        # tauri build
```

安裝檔在 `src-tauri/target/release/bundle/nsis/`。`npm run dev` 開發模式啟動；`npm run icons` 從 `src-tauri/icons/icon.svg` 重新產生圖示。

桌面版的限制：

- claude、codex 至少安裝並登入一個。npm 裝的 CLI（例如 npm 版 codex）本身需要 Node，aipipe 會從 PATH 找 `node` 來執行這些 `.js` CLI；原生 exe 版或 WSL 裡的 CLI 則不需要。
- exe 沒有程式碼簽章，第一次執行 Windows SmartScreen 可能會提示。
- 同時開兩個 app 會各自監看（彼此透過 `~/.aipipe` 共用專案清單與佇列），通知會重複。

## 限制

- 自動模式需要 git 使用者身分（`git config user.name`／`user.email`），沒設定時 `run` 一開始就會報錯。
- 從手動模式中途切到自動模式時，先前手動模式留下、尚未 commit 的變更會被併進下一個自動 commit。
- 「暫停」在目前任務結束後才生效，不會中斷正在跑的 AI 呼叫。
- 同一個專案同時只能有一個 `aipipe run`；不同專案之間由全域佇列決定誰先跑。
- 需求待辦的拖曳排序用 HTML5 drag and drop（滑鼠）；鍵盤與觸控請用上／下按鈕。
- Claude 與 Codex 的訂閱用量上限照常適用；用量耗盡時 CLI 會回錯，該任務會停在「需要人工處理」。

## 開發

```bash
npm test     # cargo test：不呼叫任何 AI；CLI 由 src-tauri/examples/fake_cli.rs 扮演，全域資料寫到暫存的 AIPIPE_HOME
npm run lint # cargo clippy -D warnings
```

介面設計規範在 [docs/design-system.md](docs/design-system.md)。
