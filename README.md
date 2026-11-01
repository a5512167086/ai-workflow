# aipipe

把「多個 AI 討論 → 寫 PRD 並交叉審查 → Task Master 拆任務 → 每個任務開新對話並帶 handover → 驗證與審查 → 更新 handover → 人工測試」這套流程自動化的命令列工具，附本機網頁 UI。

- **只用你自己的訂閱**：一律呼叫本機已登入的官方 CLI（`claude -p`、`codex exec`、`task-master`），不需要也不使用 API key。
- **通用**：任何有 git 的軟體專案都能用，build/test/lint 指令寫在專案的 `.aipipe.json`。
- **兩種模式**：自動（通過檢查就 commit，少停）與手動（不 commit，每個任務都停下來等你測）。
- **多專案**：總覽畫面同時看多個專案；全域佇列讓多個專案輪流跑，不會一起燒掉訂閱額度。
- **桌面版**：Windows 安裝檔（Tauri），不需要另外裝 Node 就能跑 aipipe 本身，流程停下來等你時跳通知。見[桌面版](#桌面版windows)。

## 需求

| 工具 | 用途 | 安裝／登入 |
| --- | --- | --- |
| Node.js 20+ | 執行 aipipe | — |
| git | 版本控制、diff、自動 commit | — |
| Claude Code CLI | 預設的 PRD 作者、實作者 | `npm i -g @anthropic-ai/claude-code`，然後 `claude auth login` 用 Pro/Max 帳號登入 |
| Codex CLI | 預設的 PRD 審查者、程式碼審查者 | `npm i -g @openai/codex`，然後 `codex login` 用 ChatGPT 帳號登入 |
| Task Master | 任務資料（tasks.json、next、set-status） | `npm i -g task-master-ai` |

> 只裝 Claude 桌面版、沒有獨立的 `claude` 指令時，可以把桌面版內建的 `claude.exe` 路徑填進 `.aipipe.json` 的 `cli.claude`，但仍要先用它執行一次 `claude.exe auth login`。

## 安裝

```bash
git clone <這個 repo> ai-workflow
cd ai-workflow
npm install -g .
```

之後在任何專案裡都能用 `aipipe`。不想全域安裝也可以 `node <路徑>/bin/aipipe.js <指令>`。

## 快速開始

```bash
cd 你的專案            # 必須是 git repo
aipipe init            # 建立 .aipipe.json、docs/ai-context.md、docs/index.md 範本
aipipe doctor          # 檢查三個 CLI 是否找得到、是否已用訂閱登入
aipipe ui              # 開 http://localhost:4317：所有專案的總覽（目前專案會自動加入）
aipipe ui --cwd .      # 直接開這個專案的畫面
```

在專案畫面裡依序：

0. **需求待辦**（選用）：先把想做的功能列進待辦、排好順序，按「起草 PRD」就用那一項開始。
1. **PRD 頁**：輸入想法 →「起草 PRD」。作者 AI 起草，審查 AI 審，來回最多 `max_prd_rounds` 輪。右側可以展開每一輪的審查意見。
2. 看完 PRD 後按「核准 PRD」，或在下方寫意見按「要求再改」（作者修訂後會再審一輪）。
3. 按「用 Task Master 產生任務」。
4. **任務看板**：按「開始」。點任務卡可以看目前步驟、修正輪數、即時 log、test 輸出、審查意見、diff。
5. 流程停下來時（等待測試、功能完成、修正輪數用盡），自己測過後按「我測完了，繼續」。

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

`aipipe ui` 不帶 `--cwd` 時首頁是總覽：每個專案一張卡片，顯示目前狀態（閒置、PRD 起草中、等待核准、排隊中、執行中、等待測試、功能待測試、需要人工處理…）、目前的功能、任務進度，點進去就是原本的單一專案畫面（網址 `/p/<id>/`）。需要你處理的專案會標出來，頂列顯示有幾個在等你。

專案清單存在 `~/.aipipe/projects.json`（可以用環境變數 `AIPIPE_HOME` 換位置），依最近開啟排序。從總覽或 `aipipe projects add` 加入；資料夾還沒有 `.aipipe.json` 時，總覽會問你要不要用預設值初始化。移除只是移出清單，不會刪任何檔案。

舊的單一專案 API（`/api/state`、`/api/events`…）仍然對應啟動 `aipipe ui` 時所在的專案；每個專案也都有 `/api/p/<id>/...`。

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
  meta.json                  想法、核准／完成時間、Task Master tag、進度、待辦項目 id
```

- 核准 PRD 時建立；同一個功能重新核准會更新同一個資料夾。
- 產生任務後、每次 `aipipe run` 結束時、功能完成時更新 `tasks.json`。
- 開始下一個功能（起草新的 PRD）時一定建新資料夾；同一天同名的功能會加 `-2`、`-3`，不會覆蓋。
- UI 的「歷史功能」分頁可以瀏覽每個封存的 PRD（Markdown 渲染）、每輪紀錄與任務清單。

### 每個功能一個 Task Master tag

`taskmaster.use_tags`（預設 `true`）讓每個功能的任務放在自己的 Task Master tag（例如 `f-20261101-csv`），開始新功能不會覆蓋上一個功能的 `tasks.json` 內容。產生任務時 aipipe 會執行 `task-master tags add <tag>`、`tags use <tag>`，再 `parse-prd --tag <tag>`；之後的 `next`、`set-status` 都作用在目前的 tag。已用 task-master 0.43.1 實測：`tags add`／`tags use` 可用、`set-status` 只改目前 tag、`next --format json` 讀目前 tag。

限制：Task Master 的 tag 名稱只接受英數字、`-`、`_`，所以中文功能名稱會轉成 ASCII（全是中文時是 `feature`，加上日期與流水號區分）。目前的 tag 還是空的（例如全新專案的 `master`）時直接沿用。`tags` 指令失敗（舊版 Task Master）時會記在 log 並沿用目前的 tag，行為就和以前一樣。

## 執行佇列

所有專案的 `aipipe run` 共用一個全域佇列（`~/.aipipe/queue.json`），預設同時只跑 1 個，用 `aipipe queue --max <n>` 或總覽的「同時執行的流程上限」改（1–8）。

- 輪不到的專案顯示「排隊中」，前面的停下來或做完後自動接上（每 1.5 秒檢查一次）。
- 停下來等人的專案（等待核准、等待測試、需要人工處理）不佔名額：那時 `aipipe run` 已經結束。
- 排隊中按「暫停」會放棄排隊。
- 佇列由各個 run 程序自己維護，不需要 UI 開著；當掉的程序會被自動清掉，不會卡住名額。
- 只有 `aipipe run`（含「繼續」「重跑」接著跑的部分）會排隊；起草 PRD 與產生任務不排隊。

## 每個任務做什麼

```
task-master next
  → task-master set-status in-progress
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
| Task Master 狀態 | 任務通過後直接 `done` | 等你按「繼續」才 `done`，之前是 `review` |

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
  "prd_path": ".taskmaster/docs/prd.md",  // 核准後的 PRD 寫在這裡，交給 Task Master
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
  "num_tasks": 0,                   // 0 = 交給 Task Master 決定
  "command_timeout_sec": 900,       // build/test/lint 逾時
  "agent_timeout_sec": 1800,        // 每次 AI 呼叫逾時
  "branch_prefix": "aipipe/",
  "cli": { "claude": "", "codex": "", "task_master": "" },  // 空字串 = 從 PATH 找
  "claude": { "model": "", "allowed_tools": [] },
  "codex": { "model": "", "windows_sandbox": "elevated" },  // Windows 預設 elevated，其他平台空字串
  "taskmaster": {
    "provider": "claude-code",      // claude-code 或 codex-cli（都走 CLI 訂閱，不用 API key）
    "model": "sonnet",
    "parse_with": "auto",           // auto | task-master | agent，見下方
    "use_tags": true                // 每個功能一個 Task Master tag，見「功能封存」
  }
}
```

`init` 會依 `package.json`、`Cargo.toml`、`go.mod`、`pyproject.toml` 猜 build/test/lint 指令，猜不到就留空，請自己填。

### Task Master 的設定

`aipipe tasks` 會：

1. 沒有 `.taskmaster/` 就執行 `task-master init -y --skip-install --no-git --no-aliases --rules ""`（不產生 CLAUDE.md、.mcp.json 等規則檔）。
2. 把 main、fallback、research 三個模型都設成 `taskmaster.provider`（預設的 research 是 perplexity，需要 API key，所以一併換掉）。
3. 把 `cli.claude`／`cli.codex` 路徑寫進 `.taskmaster/config.json`，並關閉 Task Master 的匿名遙測。
4. 執行 `task-master parse-prd --input <prd_path> --force`。

`parse_with`：

- `task-master`：只用 `task-master parse-prd`。
- `agent`：由 aipipe 的作者 AI 依 Task Master 的 tasks.json 格式產生任務，再用 `task-master list` 確認讀得懂。
- `auto`（預設）：先 parse-prd，失敗再改用 agent。

不管哪一種，之後的 `next`、`set-status` 都由 Task Master 處理。已知 Task Master 0.43.1 的 `codex-cli` provider 在新版 Codex 上 parse-prd 會失敗（Codex API 拒絕它的 JSON schema），這時 `auto` 會自動改用 agent。

## 費用與安全

- 只呼叫官方 CLI：`claude -p`、`codex exec`、`task-master`。
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
.taskmaster/                 Task Master 的資料（每個功能一個 tag）
docs/handovers/current_handover.md
docs/aipipe/backlog.json     需求待辦清單（建議 commit）
docs/prd/<日期>-<功能>/      功能封存（建議 commit）
```

使用者目錄：

```
~/.aipipe/projects.json      總覽的專案清單
~/.aipipe/queue.json         全域執行佇列（執行中、排隊中的 pid）
~/.aipipe/config.json        全域設定（max_concurrent_runs）
~/.aipipe/desktop-sidecar.log 桌面版 sidecar 的輸出
```

`aipipe ui` 與 `aipipe run` 是不同程序，透過 `.aipipe/state.json` 溝通；UI 的按鈕會在背景啟動對應的 aipipe 指令（輸出寫到 `.aipipe/logs/process.log`）。關掉 UI 不會中斷正在跑的流程。

## 在 WSL 裡執行 CLI

每個 CLI 可以分別選擇在 Windows 原生或 WSL 裡執行。例如 claude 裝在 WSL、codex 和 task-master 用 Windows 版：

```jsonc
{
  "runtime": { "claude": "wsl", "codex": "windows", "task_master": "windows" },
  "wsl_distro": "Ubuntu",     // 空字串＝WSL 預設發行版
  "wsl_cli": { "claude": "", "codex": "", "task_master": "" }  // WSL 裡的指令名或路徑，空字串＝claude / codex / task-master
}
```

UI 的「設定」分頁可以切換這些選項，並按「檢查 CLI（doctor）」確認。預設全部是 `windows`。`runtime` 為 `wsl` 時 `cli.*` 不使用（那是 Windows 路徑）。

運作方式：

- 實際執行 `wsl.exe -d <distro> --cd <專案的 Windows 路徑> -e bash -lc '<清理腳本>' aipipe <cli> <參數…>`。用 `-e` 而不是 `--`：`--` 會把參數接成字串交給預設 shell（例如 zsh）重新解析，引號、`$`、`;` 會被破壞。
- prompt 一律從 stdin 傳入，不放在命令列。
- 需要路徑的參數（例如 codex 的 `-C`、`-o`）會用 `wslpath -a` 轉成 `/mnt/c/...`。
- **API key 在 WSL 端再清一次**：login shell 會讀 `.bashrc`／`.profile`，Windows 端也可能透過 `WSLENV` 轉送變數。清理腳本會 `unset` 所有 `ANTHROPIC_*`、`CLAUDE_CODE_*`、`OPENAI_API_KEY` 等變數，最後再用 `exec env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u OPENAI_API_KEY -u CODEX_API_KEY` 執行 CLI。
- `aipipe doctor` 會依 runtime 分別檢查：WSL 能不能啟動、login shell 裡有沒有 API key 變數（只列名稱）、各 CLI 的版本與登入狀態（claude 必須是 `claude.ai` 訂閱登入）。

注意事項：

- **I/O 較慢**：專案在 Windows 磁碟時，WSL 裡的 CLI 透過 `/mnt/c` 存取，讀寫大量檔案明顯比原生慢。專案很大時，考慮把整個專案放在 WSL 檔案系統、全部 CLI 都用 WSL。
- **換行符號**：WSL 裡的工具寫出 LF，Windows 上的 git 若設 `core.autocrlf=true` 會把 LF 轉成 CRLF，diff 可能出現整檔換行差異。建議在專案加 `.gitattributes`（例如 `* text=auto eol=lf`），並讓 Windows 與 WSL 的 git 設定一致。
- **Task Master 的 provider 會在 task-master 自己的 runtime 裡找 CLI**：task-master 在 Windows、claude 在 WSL 時，`claude-code` provider 找不到 claude，`parse-prd` 會失敗，由 `parse_with: "auto"` 改用作者 AI 產生任務。想讓 Task Master 直接用 claude-code，就把 task-master 也裝在 WSL 並設成 `wsl`（WSL 需要有 Node.js）。
- 逾時中止時 aipipe 會結束 `wsl.exe`；WSL 裡的子程序通常會跟著結束，但不保證。

## Windows 注意事項

- **Codex 的 workspace-write**：Windows 上 Codex 沒設 `windows.sandbox` 時，會把 `--sandbox workspace-write` 默默降成 read-only，實作者就改不了檔案。aipipe 會帶 `-c windows.sandbox="<codex.windows_sandbox>"`（Windows 預設 `elevated`）。如果 Codex 仍回報 read-only，該任務會直接停在「需要人工處理」並提示你改設定，不會白白耗掉修正輪數。`elevated` 需要 Codex 的 Windows 沙箱已完成一次性設定（裝過 Codex 桌面版通常已設定好）；不行的話改 `unelevated`。
- npm 全域安裝的 `.cmd` 包裝檔（例如 `task-master.cmd`）會被解析成 `node <js 入口>` 直接執行，不經過 cmd.exe。

## 桌面版（Windows）

`desktop/` 是 Tauri 2 外殼，視窗內容就是上面的網頁 UI，不另外寫前端。

- **不用裝 Node 就能跑 aipipe**：aipipe（`bin/` + `src/` + `ui/`）用 esbuild 合併後，以 Node SEA 打包成 `aipipe-sidecar.exe`，UI 檔案內嵌在 exe 裡。app 啟動時挑一個沒被佔用的本機連接埠啟動它，結束 app 時停掉它。
- **原生功能**：總覽的「選擇資料夾」用系統對話框；系統匣圖示（左鍵開視窗、右鍵「結束 aipipe」）；關閉視窗會縮到系統匣，背景繼續監看；專案進入等待核准、等待測試、功能待測試、需要人工處理、錯誤時跳 Windows 通知。
- **CLI 呼叫不變**：一樣只呼叫本機已登入的 claude（可設在 WSL）、codex、task-master，清掉 API key 的規則一樣。
- 由 UI 啟動的 `aipipe run` 是獨立程序，結束 app 不會中斷正在跑的流程（和 CLI 版一樣）。sidecar 則會監看外殼的 pid，app 當掉或被強制關閉時也會自己結束。

安裝：執行 `aipipe_0.1.0_x64-setup.exe`（NSIS，裝在目前使用者，不需要系統管理員）。

自己建置（需要 Node 20+、Rust stable、VS 2022 C++ Build Tools；WebView2 Windows 11 內建）：

```bash
cd desktop
npm install
npm run build        # = npm run sidecar（打包 aipipe-sidecar.exe）+ tauri build
```

安裝檔在 `desktop/src-tauri/target/release/bundle/nsis/`。`npm run icons` 從 `web/icon.svg` 重新產生圖示。

桌面版的限制：

- claude、codex、task-master 仍要自己安裝。npm 裝的 CLI（例如 task-master、npm 版 codex）本身就需要 Node，所以實務上 Windows 端仍會有 Node；只用 WSL 裡的 CLI、或原生 exe 版的 claude／codex 時才真的不需要。aipipe 會從 PATH 找 `node` 來執行這些 `.js` CLI。
- sidecar exe 約 94 MB（內含 Node 執行環境），安裝檔約 24 MB。exe 沒有程式碼簽章，第一次執行 Windows SmartScreen 可能會提示。
- 同時開兩個 app 會各自有一個 sidecar 和連接埠（彼此透過 `~/.aipipe` 共用專案清單與佇列），通知會重複。

## 限制

- 自動模式需要 git 使用者身分（`git config user.name`／`user.email`），沒設定時 `run` 一開始就會報錯。
- 從手動模式中途切到自動模式時，先前手動模式留下、尚未 commit 的變更會被併進下一個自動 commit。
- 「暫停」在目前任務結束後才生效，不會中斷正在跑的 AI 呼叫。
- 同一個專案同時只能有一個 `aipipe run`；不同專案之間由全域佇列決定誰先跑。
- 需求待辦的拖曳排序用 HTML5 drag and drop（滑鼠）；鍵盤與觸控請用上／下按鈕。
- Claude 與 Codex 的訂閱用量上限照常適用；用量耗盡時 CLI 會回錯，該任務會停在「需要人工處理」。

## 開發

```bash
npm test     # node:test 單元測試，不呼叫任何 AI（全域資料寫到暫存的 AIPIPE_HOME）
```

介面設計規範在 [docs/design-system.md](docs/design-system.md)。
