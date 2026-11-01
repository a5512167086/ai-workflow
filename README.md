# aipipe

把「多個 AI 討論 → 寫 PRD 並交叉審查 → Task Master 拆任務 → 每個任務開新對話並帶 handover → 驗證與審查 → 更新 handover → 人工測試」這套流程自動化的命令列工具，附本機網頁 UI。

- **只用你自己的訂閱**：一律呼叫本機已登入的官方 CLI（`claude -p`、`codex exec`、`task-master`），不需要也不使用 API key。
- **通用**：任何有 git 的軟體專案都能用，build/test/lint 指令寫在專案的 `.aipipe.json`。
- **兩種模式**：自動（通過檢查就 commit，少停）與手動（不 commit，每個任務都停下來等你測）。

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
aipipe ui              # 開 http://localhost:4317
```

在 UI 裡依序：

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
```

在專案子目錄執行也可以，aipipe 會往上找 `.aipipe.json`；或用 `--cwd <路徑>` 指定專案。

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
    "parse_with": "auto"            // auto | task-master | agent，見下方
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
.taskmaster/                 Task Master 的資料
docs/handovers/current_handover.md
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

## 限制

- 自動模式需要 git 使用者身分（`git config user.name`／`user.email`），沒設定時 `run` 一開始就會報錯。
- 從手動模式中途切到自動模式時，先前手動模式留下、尚未 commit 的變更會被併進下一個自動 commit。
- 「暫停」在目前任務結束後才生效，不會中斷正在跑的 AI 呼叫。
- 同一個專案同時只能有一個 `aipipe run`。
- Claude 與 Codex 的訂閱用量上限照常適用；用量耗盡時 CLI 會回錯，該任務會停在「需要人工處理」。

## 開發

```bash
npm test     # node:test 單元測試，不呼叫任何 AI
```
