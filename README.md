<div align="center">

<img src="src-tauri/icons/128x128@2x.png" width="96" alt="ai-workflow 圖示">

# ai-workflow

**用你自己的 Claude Code／Codex 訂閱，把「需求 → PRD → 拆任務 → 實作 → 審查 → 人工驗收」跑成一條流程。**

<a href="https://github.com/a5512167086/ai-workflow/actions/workflows/ci.yml"><img src="https://github.com/a5512167086/ai-workflow/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
<a href="https://github.com/a5512167086/ai-workflow/releases/latest"><img src="https://img.shields.io/github/v/release/a5512167086/ai-workflow?style=flat-square&label=release" alt="最新版本"></a>
<a href="https://sonarcloud.io/summary/new_code?id=a5512167086_ai-workflow"><img src="https://sonarcloud.io/api/project_badges/measure?project=a5512167086_ai-workflow&metric=alert_status" alt="SonarCloud Quality Gate"></a>
<img src="https://img.shields.io/badge/platform-Windows-0078D6?style=flat-square" alt="Windows">
<a href="#授權"><img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="MIT License"></a>

<table>
<tr>
<td align="center" width="25%"><h3>不用 API key</h3>只呼叫本機已登入的<br>官方 CLI</td>
<td align="center" width="25%"><h3>專案零檔案</h3>設定與紀錄都在<br><code>~/.ai-workflow</code></td>
<td align="center" width="25%"><h3>AI 互相審查</h3>一個寫、另一個審<br>PRD 與程式碼都是</td>
<td align="center" width="25%"><h3>每步由你決定</h3>核准 PRD、核准任務<br>人工驗收才算完成</td>
</tr>
</table>

**[安裝](#安裝) · [怎麼運作](#怎麼運作) · [功能](#功能) · [命令列](#命令列) · [開發](#開發) · [使用指南](docs/guide.md)**

</div>

---

## 安裝

1. 從 [Releases](https://github.com/a5512167086/ai-workflow/releases/latest) 下載 `ai-workflow_<版本>_x64-setup.exe` 並執行。裝在目前使用者，不需要系統管理員。
2. Claude Code 和 Codex 至少裝一個，並用訂閱登入：

```bash
npm i -g @anthropic-ai/claude-code
```

```bash
npm i -g @openai/codex
```

<sub>登入用 `claude auth login`（Pro／Max）或 `codex login`（ChatGPT）。兩個都有時，一個寫、另一個審；只有一個時用不同的 session 互審。</sub>

3. 開 App，在總覽按「加入專案」選一個 git 專案資料夾。完成。

## 怎麼運作

```
需求待辦 → 釐清需求 → PRD → 交叉審查 → 你核准 → 拆任務 → 你核准
        → 每個任務：實作 → build/lint/test → 程式碼審查 → 修正（有上限）→ handover
        → 你人工驗收 → 功能封存
```

| 步驟 | 誰做 | 你要做什麼 |
| --- | --- | --- |
| 釐清需求 | AI 查專案後一輪一輪追問 | 回答問題，確認需求摘要 |
| PRD | 一個 AI 寫、另一個 AI 審 | 核准，或寫意見要求再改 |
| 拆任務 | AI 切成可以單獨展示的小任務 | 檢視、必要時修改，再核准 |
| 實作 | 每個任務開新的對話，帶上交接紀錄 | 等它跑；需要權限時會問你 |
| 驗證與審查 | 自動跑測試，再由另一個 AI 審 diff | 卡住時看原因，決定怎麼處理 |
| 人工驗收 | — | 自己測過後按「我測完了，繼續」 |

<sub>自動模式通過就 commit、少停；手動模式（預設）不 commit，每個任務都停下來等你測。</sub>

## 功能

| 功能 | 做什麼 |
| --- | --- |
| 專案對話 | 不必建 PRD 就能問進度、讀程式、畫架構圖；回覆逐字顯示 |
| 需求待辦 | 排優先順序、依狀態篩選、拖曳排序 |
| Grill Me 需求會議 | 把模糊的想法問到可以寫規格 |
| 任務看板 | 每個任務的步驟、即時 log、test 輸出、審查意見、diff |
| 功能封存 | 每個功能的 PRD、每輪審查、任務與實作紀錄都留著，隨時回頭看 |
| Skills | 每個階段綁哪些技能由你決定，可以匯入自己的技能 |
| 專案圖譜 | 本機用 tree-sitter 建程式碼圖，AI 先查圖再讀檔 |
| 節省 Token | 只附相關的 PRD、審查略過 lockfile、精簡回覆，逐項可關 |
| 多專案 | 總覽同時看多個專案，全域佇列輪流跑，不會一起燒額度 |
| WSL | 每個 CLI 可以分別在 Windows 或 WSL 執行 |

每一項的細節見[使用指南](docs/guide.md)。

## 命令列

同一支 `ai-workflow-desktop.exe` 帶子指令就是命令列版：

```bash
ai-workflow init                    # 加入目前的專案
ai-workflow doctor                  # 檢查 Claude Code、Codex 有沒有裝好並登入
ai-workflow prd "加入 CSV 匯出"     # 起草 PRD
ai-workflow prd --approve           # 核准 PRD
ai-workflow tasks --approve         # 核准任務
ai-workflow run                     # 開始執行
ai-workflow continue                # 我測完了，繼續
ai-workflow status                  # 目前狀態
```

完整指令見[使用指南的工作流程](docs/guide.md#工作流程)。

## 安全

- 只用訂閱：啟動 CLI 前清掉所有 API key 環境變數，沒登入就直接失敗，不會改走付費 API。
- 不跳過權限：不使用 `--dangerously-skip-permissions`；會改檔案的 AI 遇到沒自動允許的操作，會跳對話框問你。
- 唯讀的角色真的唯讀：PRD、拆任務、審查、對話都不能改檔案。
- 每次 AI 呼叫、每個指令、每段修正都有上限與逾時。

詳見[費用與安全](docs/guide.md#費用與安全)。

## 開發

需要 Rust stable、VS 2022 C++ Build Tools、Node 22+（有 `.nvmrc`）。

```bash
npm install
npm run dev          # 開發模式開桌面視窗
npm run dev:web      # 只看畫面：用假後端在瀏覽器開 http://localhost:1420
npm run build        # 產生安裝檔到 src-tauri/target/release/bundle/nsis/
```

```bash
npm run typecheck    # tsc
npm run test:ui      # 前端測試（Vitest）
npm test             # 前端 + Rust 測試；不呼叫任何 AI，CLI 由假程式扮演
npm run lint         # cargo clippy -D warnings
```

<details>
<summary><strong>CI 與發布</strong></summary>
<br>

- **CI**：push 到 `main` 與每個 PR 都跑型別檢查、前端測試、clippy 與 Rust 測試（Windows runner）。程式碼品質由 SonarCloud 的自動分析負責，範圍設定在 `.sonarcloud.properties`。
- **發布**：推送 `v` 開頭的 tag 時建置安裝包，建立 GitHub Release 並附上安裝檔，release notes 依 commit 自動產生；tag 含 `-`（例如 `v0.2.0-beta.1`）標成 pre-release。

發布新版本：

1. 把 `package.json`、`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml` 的版本改成同一個值，再跑 `npm install` 與 `cargo check` 更新 lockfile。
2. commit 並 push 到 `main`，等 CI 通過。
3. 推送 tag（tag 和版本號不一致時不會發布）：

```bash
git tag v0.1.0
```

```bash
git push origin v0.1.0
```

</details>

前端架構與設計見 [docs/frontend.md](docs/frontend.md) 與 [docs/design-system.md](docs/design-system.md)。

## 授權

[MIT](LICENSE)。

內建的 grill-me、to-spec、to-tickets、tdd 技能改寫自 [Matt Pocock 的 skills](https://github.com/mattpocock/skills)（MIT）；任務看板的資訊層級參考 [Monstrare](https://github.com/pjwang2022/Monstrare)（MIT）；精簡回覆的想法來自 [caveman](https://github.com/juliusbrussee/caveman)，專案圖譜參考 [graphify](https://github.com/Graphify-Labs/graphify)。授權全文見 [THIRD_PARTY_NOTICES.txt](THIRD_PARTY_NOTICES.txt)。

---

<div align="center">
<sub><a href="docs/guide.md">使用指南</a> · <a href="docs/tasks-and-skills.md">任務與 Skills</a> · <a href="docs/runtime.md">執行環境</a> · <a href="docs/usage.md">用量與額度</a> · <a href="https://github.com/a5512167086/ai-workflow/issues">回報問題</a></sub>
</div>
