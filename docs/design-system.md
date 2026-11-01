# aipipe UI 設計系統

本文件是 aipipe 桌面 app 介面（`src/`）的設計依據。方向由 `ui-ux-pro-max` skill 查詢產生：

```
search.py "developer tool dashboard kanban CLI pipeline monitoring" --design-system -p aipipe --density 7 --variance 3 --motion 3
search.py "developer tool terminal dashboard" --domain color
search.py "<kanban / live status / log viewer / dark mode / confirm dialog / tabs keyboard>" --domain ux
```

## 限制

- 純 HTML / CSS / JS，不用框架、不從 CDN 載入任何資源（離線工具）。
- 字型一律用系統字型堆疊；skill 建議的 JetBrains Mono / IBM Plex Sans 只在使用者本機已安裝時才會被用到，不下載。
- 圖示用內嵌 SVG（線條風格，1.75px stroke，近似 Lucide），不用 emoji。
- 介面文字為繁體中文。

## 風格：Minimalism & Swiss Style

- 關鍵字：乾淨、功能導向、格線、高對比、清楚的字級層級。
- 適用：開發者工具、dashboard、專業工具。可及性風險低，需確保 4.5:1 對比、鍵盤操作、可見焦點、reduced-motion。
- 效果：平面、1px 邊框、極少陰影（只用在浮出層，如 toast）；hover 150–200ms 過場；無捲動動畫。
- 密度 7/10：資訊密集但留出 8px 倍數間距。
- Variance 3/10：版面規整、對齊格線，不做裝飾性排版。

## 配色：Developer Tool / IDE（Code dark + run green）

skill 給的是深色主題配色，淺色版依同一色系（Tailwind slate + green）推導，並把綠色加深以符合淺底對比。

| Token | 深色 | 淺色 | 用途 |
|---|---|---|---|
| `--bg` | `#0F172A` | `#F8FAFC` | 頁面背景 |
| `--surface` | `#1B2336` | `#FFFFFF` | 卡片、欄位 |
| `--surface-2` | `#272F42` | `#F1F5F9` | 次層背景、code、任務卡 |
| `--border` | `#334155` | `#E2E8F0` | 一般邊框 |
| `--border-strong` | `#475569` | `#CBD5E1` | 輸入框、按鈕邊框 |
| `--text` | `#F8FAFC` | `#0F172A` | 主要文字 |
| `--text-muted` | `#94A3B8` | `#475569` | 次要文字（兩種模式都 ≥ 4.5:1） |
| `--primary` | `#22C55E` | `#15803D` | 主要動作（run green）、選中狀態 |
| `--on-primary` | `#0F172A` | `#FFFFFF` | 主要按鈕上的文字 |
| `--info` | `#60A5FA` | `#1D4ED8` | 執行中、進行中 |
| `--warn` | `#FBBF24` | `#B45309` | 等待人工、暫停、審查中 |
| `--danger` | `#F87171` | `#B91C1C` | 錯誤、卡住、還原 |
| `--ring` | `#F8FAFC` | `#0F172A` | 焦點外框（skill：Ring 用前景色） |

狀態一律「色彩 + 文字 / 圖示」並用，不只靠顏色（`color-not-only`）。

## 字型

```css
--font-sans: "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system,
             "Microsoft JhengHei UI", "Microsoft JhengHei", "PingFang TC", "Noto Sans TC", sans-serif;
--font-mono: "JetBrains Mono", "Cascadia Code", "Cascadia Mono", Consolas, ui-monospace,
             "SFMono-Regular", Menlo, monospace;
```

| 用途 | 大小 / 行高 | 字重 |
|---|---|---|
| 內文 | 14px / 1.55 | 400 |
| 區塊標題 | 15px | 600 |
| 小標、欄位標籤、meta | 12.5px | 500–600 |
| log / diff / PRD 原文 | 12.5px mono / 1.6 | 400 |
| 任務 id、commit、pid | mono | 500 |

skill 建議內文 16px；這是高密度工具，內文定為 14px，最小字級 12px，並支援瀏覽器縮放。

## 間距、圓角、層級

- 間距：4 / 8 / 12 / 16 / 24 / 32（`--s-1`…`--s-6`）。
- 圓角：控制項 6px、卡片 8px、膠囊 999px。
- 陰影：只有 toast 使用一層陰影；其他靠邊框分層。

## 元件準則

- **按鈕**：高度 32px（≥ WCAG 2.2 的 24px 目標尺寸），間距 ≥ 8px。每個畫面只有一個 primary（PRD 頁＝核准、看板＝開始；等待人工時「我測完了，繼續」升為 primary）。停用狀態降低不透明度並顯示 `not-allowed`。
- **分頁**：`role="tablist"`，方向鍵切換，`aria-selected`；看板分頁顯示任務數。
- **狀態膠囊**：圓點 + 文字，`role="status"`、`aria-atomic`，整句播報（`contextual-live-badge-updates`）。
- **看板**：五欄格線，欄頂色條代表階段，欄標題含數量。任務卡顯示 id、優先度、TM 狀態、依賴 chip、目前步驟與修正輪數進度條；卡住的任務加紅框與「需要處理」文字。任務卡是 `<button>`，可用鍵盤開啟。看板不提供拖曳（狀態由流程決定），不需拖曳替代方案。
- **任務詳情**：寬視窗顯示在看板右側，窄視窗覆蓋任務工作區；關閉或 Escape 後還原焦點到原任務。執行資訊可展開，完成條件分別呈現依賴、驗證、審查與人工驗收；未知值不顯示成通過。子分頁同樣是 tablist；log 在底部時自動跟隨。
- **任務藍圖與篩選**：可切換看板／藍圖，藍圖沿用現有「功能 → 任務 → 子任務」資料，不虛構 Epic 或 User Story。搜尋與篩選只影響顯示，不更動任務資料或流程；完成度及總數以完整資料計算。
- **破壞性動作**：重跑並還原、取代 PRD 草稿仍用確認對話框（`Confirmation Dialogs`）。
- **回饋**：每個動作都有 toast（`role="status"`），錯誤 toast 用紅色並停留較久。
- **焦點**：`:focus-visible` 2px 外框 + 2px offset，用 `--ring`。
- **動效**：只有 150–200ms 的顏色／邊框過場；`prefers-reduced-motion` 時全部關閉。
- **主題**：預設跟隨系統；右上角可切換「系統 / 淺色 / 深色」，選擇存在 localStorage（讀寫失敗時退回系統）。

## 響應式

- ≥ 1100px：PRD 頁兩欄（PRD 原文 | 審查紀錄與動作）；看板五欄。
- 760–1100px：PRD 頁單欄；看板在容器內橫向捲動（頁面本身不橫向捲動）。
- < 760px：看板在工作區內橫向捲動，也可切換為適合窄螢幕的任務藍圖；頂列換行；設定表單改單欄。App 外框固定，不產生頁面捲軸。

## Monstrare 介面參考

任務看板參考 [Monstrare](https://github.com/pjwang2022/Monstrare) 的車道資訊層級、風險側條、依賴與人工核准標記、階層藍圖，以及詳情檢查清單。aipipe 將側條用於既有的任務優先度，並沿用自己的狀態引擎與淺／深色主題；沒有把人工拖曳任務狀態或參考專案的流程政策加進執行引擎。來源版本為 `a187710a3e3f3495003707d4f69eee873373df03`，MIT 授權與作者聲明隨程式保存在 `src/THIRD_PARTY_NOTICES.txt`。

## 專案對話

開啟專案後預設顯示對話，左側為對話紀錄，右側為訊息與固定的輸入區；窄視窗以選單切換紀錄。外框不捲動，訊息區獨立捲動；模型與推理選項放在可展開的浮出區，保留輸入與閱讀空間。Enter 傳送，Shift+Enter 換行，中文組字時不送出。

對話可與流程並行，以唯讀 CLI 及最新專案背景回答，不觸發 PRD 或任務操作。長對話以最近訊息交接，完整紀錄仍保存；工作中的工具與文字輸出顯示在可展開的執行紀錄，最終回覆完成後顯示為訊息。停止回覆只停止本次查詢。

Markdown 沿用安全的文字渲染器；Mermaid 12.2.0 在建置時由 npm 套件複製到離線資源，僅在需要畫圖時載入。使用 [Mermaid 官方 strict 安全模式](https://mermaid.js.org/config/usage.html#securitylevel)，關閉 HTML 標籤及自訂初始化指令。圖表保留原始碼與 SVG 下載，語法錯誤時退回可閱讀的原始碼。

## 交付前檢查

- [ ] 無 emoji 圖示
- [ ] 所有可點元素 `cursor: pointer`
- [ ] hover 過場 150–300ms
- [ ] 淺色、深色文字對比 ≥ 4.5:1
- [ ] 鍵盤可見焦點
- [ ] `prefers-reduced-motion`
- [ ] 375 / 768 / 1024 / 1440px 檢查
