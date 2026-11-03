# 前端架構與桌面 UI/UX 設計

自 0.5.0 起，桌面 app 的畫面改用 **React 19 + TypeScript + Vite 7 + Tailwind v4 + shadcn/ui**（`src/`），後端（`src-tauri/`）與 API 路由不變。舊的純 HTML/JS 畫面保留在 git 歷史（0.4.0 的 `src/`）。

## 為什麼這樣設計：桌面 app 的 UI/UX 原則

舊畫面是兩個網頁（總覽 `overview.html`、專案 `index.html?p=`），頂列加分頁；這是網站的作法。桌面工具（VS Code、Linear、Tower、Fork）的使用情境不同：視窗長時間開著、常切換專案、要一眼看到「現在在跑什麼、誰在等我」、而且不該出現網頁式的整頁捲動。因此：

| 原則 | 做法 |
| --- | --- |
| **單一視窗、固定外框** | 整個 App 是 `側欄｜主區域／狀態列` 的固定框架，`body` 不捲動；每個畫面自己決定哪個區塊捲動（訊息區、看板欄、log）。 |
| **專案是第一層** | 左側欄最上方是**專案切換器**（名稱＋狀態點＋等待處理的徽章），點開列出所有專案。不必回總覽才能換專案。 |
| **畫面在側欄，不在頂列** | 專案的八個畫面（對話、需求、PRD、看板、紀錄、架構圖、用量、Skills）是側欄項目，各自帶徽章（待核准、回覆中、進度 1/4）。側欄可收合成圖示欄（Ctrl+B），寬度記在 localStorage。 |
| **狀態列集中「現在發生什麼」** | 底部 24px 狀態列：流程狀態膠囊、原因、執行中的 pid 與時間、全域佇列、模式（自動／手動）、Tokens。點擊可跳到對應畫面。取代舊版頂列的 status-line。 |
| **鍵盤優先** | `Ctrl+K` 指令面板（切專案、跳畫面、開始／暫停／繼續、主題）；`Ctrl+1…8` 切換畫面；`Ctrl+,` 設定；`Ctrl+B` 側欄；`Ctrl+Shift+O` 所有專案；對話框 `Esc` 關閉並還原焦點。 |
| **檢視器而不是彈窗** | 任務詳情是看板右側的**可拉寬的檢視面板**（Inspector），看板仍可見、可以連續點不同任務；窄視窗才退成覆蓋式面板。PRD／對話／紀錄／Skills 的左右分欄都可拖拉（`react-resizable-panels`），比例記在 localStorage。 |
| **原生感的互動** | 右鍵選單（專案卡、需求、任務卡、對話紀錄）、`AlertDialog` 取代 `window.confirm`、`Dialog` 取代 `prompt`、toast 在右下角（sonner）、沒有瀏覽器右鍵選單、細捲軸。 |
| **密度** | 內文 13px、控制項 32px、間距 8px 倍數、1px 邊框、無陰影（Swiss style，見 `design-system.md`）。 |
| **主題** | 跟隨系統／淺色／深色，色票與 0.4 相同（slate + run green），以 CSS 變數掛在 `:root`／`.dark`。 |
| **注意力優先** | 「等你處理」的專案在切換器、狀態列、總覽都有標記；視窗標題跟著專案名稱；流程停下來等人時，該畫面的主要按鈕升為 primary（例如「我測完了，繼續」）。 |

沒有做的：自訂標題列（Tauri `decorations: false`）——會失去 Windows 的 Snap Layout 與原生拖曳，收益不大；系統匣與通知仍在 Rust 端。

## 目錄

```
index.html                 Vite 入口
src/
  main.tsx, App.tsx        入口與 Hash 路由（tauri:// 沒有伺服器端路由回退）
  index.css                Tailwind、色票、Markdown／log／diff 的共用樣式
  lib/                     不含 React 的純邏輯：api.ts（invoke 包裝）、tauri.ts（橋接＋瀏覽器預覽的假後端）、
                           constants.ts、format.ts（elapsedText、boardFacts、column…）、log-parse.ts、diff-parse.ts、actions.ts（runAction）
  types/api.ts             後端回傳的資料形狀
  stores/                  zustand：ui（主題、側欄、指令面板）、projects（總覽）、project（目前專案的快照與 log）、models、references、badges
  hooks/use-shortcuts.ts   快捷鍵
  components/ui/           shadcn/ui（new-york、slate）；按鈕／輸入框預設高度改成 32px
  components/app/          AppShell、Sidebar、StatusBar、CommandPalette、Page（Page/PageHeader/PageBody/Panel/EmptyState/Hint/Notice）、
                           StatusPill/Chip、GuardButton、LiveSince、confirm（confirmDialog/promptDialog）、Markdown、MermaidFigure、LogTree、DiffView、ModelPicker
  features/<畫面>/         home、settings、chat、backlog（含 InterviewDialog）、prd、board（含 TaskInspector）、records、graph、usage、skills、
                           references（ReferenceWidget／Dialog／拖放／@ 補全）、permissions
  dev/mock.ts              不在 Tauri 裡時的假後端（npm run dev:web 直接在瀏覽器預覽）
  test/setup.ts            Vitest（jsdom + Testing Library）
```

## 路由

| 路徑 | 畫面 |
| --- | --- |
| `#/` | 所有專案（加入專案、專案卡片、等你處理） |
| `#/settings` | 全域設定 |
| `#/p/<id>/chat` … `/skills` | 專案的八個畫面；`#/p/<id>` 導到 chat |

`ProjectLayout` 進入專案時呼叫 `useProject.open(id)`：訂閱 `state-<id>`、`log-<id>`、`error-<id>` 事件、`watch_project`、讀 `/api/state` 與固定的 log；離開時取消訂閱。權限對話框與參考資料拖放掛在這一層。

## 與後端的約定

- `api(path, body?)`：有 body 是 POST，沒有是 GET；`projectApi(id)` 把 `/api/xxx` 換成 `/api/p/<id>/xxx`（`/api/projects`、`/api/queue` 仍是全域）。
- `act(api, path, body, okMsg)`：成功 toast、失敗 toast 並回傳 null。`runAction(api, snap, …)`：額度用完時先確認改用另一個 AI。
- 防呆：`snap.guards[name]` 是不能做的原因（空字串＝可以）；用 `GuardButton guard={reason}` 停用並在 tooltip 顯示原因。
- 事件：`projects`（總覽）、`state-<id>`（整份快照）、`log-<id>`（`{scope, text}` 增量）、`stream-<id>`（`{scope, text}`：AI 正在打的那段回覆的全文，空字串代表已寫完）。
- 專案圖譜的互動圖（`src-tauri/.../graph/viewer.html`）放在沙箱 iframe：平移用 pointer events＋pointer capture、重畫合併到每個 frame，排版時自己顯示轉圈；讀取 `/api/graph` 時後端會把舊的 graph.html 換上目前的 viewer（資料不變），不必重新建立就能用到修正。
- 功能封存：`GET /api/archive` 列出、`/api/archive/<名稱>` 讀 PRD／每輪紀錄／任務（含 `taskStates`）、`/api/archive/<名稱>/task/<id>` 讀一個任務當時的內容與實作紀錄（log、審查、test 輸出、diff；`hasRecords` 為 false 表示沒保存）。任務紀錄在開始新功能時移進封存，新功能的任務從空白開始。紀錄頁的「任務」分頁點一列展開（`features/records/ArchivedTask.tsx`）。
- 逐字輸出：Claude 以 `--include-partial-messages`、Codex 以 app-server 的 `item/agentMessage/delta` 取得增量，寫到 `logs/<scope>.stream`（不混進 log），訊息寫完或執行結束就刪掉；App 每 200ms 檢查一次。前端 `useProject().streams[scope]` 給 LogTree 的 `live` 與對話、Grill Me、技能會議的打字中訊息（`StreamingText`，節流 120ms，打字中不畫 Mermaid）。

## 共用元件介面

| 元件 | 介面 |
| --- | --- |
| `Markdown` | `<Markdown text small? className? />`，react-markdown＋GFM，不輸出原始 HTML；```mermaid 交給 `MermaidFigure`（離線、strict、深淺色、複製／下載 SVG、錯誤退回原始碼） |
| `LogTree` | `<LogTree text openAll? />`，`parseLog` 分段：執行中展開、完成收合、手動切換保留、捲到底自動跟隨 |
| `DiffView` | `<DiffView text />`，並排／單欄、檔案清單、摘要、長檔預設收合，內容用文字節點 |
| `ModelPicker` | `<ModelPicker provider value onChange placeholder />`，列出 `useModels` 的清單、可輸入任意 ID、鍵盤選取 |
| `ReferenceWidget` | `referenceOptions(type, ctx)`、`<ReferenceWidget options />`、`openReferenceDialog(options)`、`useReferenceInput(ref, getOptions)`、`<ReferenceChips ids remove? />` |
| `useSkillCommandInput(ref)` | 訊息開頭輸入 `/` 列出相容技能 |
| `usePointerReorder` | 拖曳排序（`hooks/use-pointer-reorder.ts`）。**不要用 HTML5 drag and drop**：桌面 App 開著視窗層級的檔案拖放，Tauri 在 Windows 上這樣設定時網頁裡的 dragstart／drop 不會觸發。每列加 `data-reorder-id` 與 `{...rowProps(id)}`，從按鈕以外的地方拖過 4px 才開始，Esc 取消 |
| `confirmDialog / promptDialog` | 取代 `window.confirm / prompt`，回傳 Promise |
| `Loading` | `<Loading label inline? />`（Page.tsx），轉圈＋說明、`role=status`；讀取資料時用它，不要只放「載入中…」文字或空清單。預設置中填滿區塊，`inline` 用在清單裡。圖示本身是 `components/ui/spinner` |

## 開發

```bash
nvm use 22            # 或把 Node 22 放到 PATH；Vite 7 需要 Node ≥ 20.19
npm install
npm run dev           # tauri dev：先起 Vite（1420），再開桌面視窗
npm run dev:web       # 只開 Vite，用假後端在瀏覽器看畫面
npm run typecheck
npm run test:ui       # Vitest
npm run build         # tauri build（先 tsc -b && vite build 到 dist/）
```
