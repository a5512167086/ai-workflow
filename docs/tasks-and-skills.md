# 內建任務引擎與共用 Skills

Task Master 的任務格式、PRD 拆解與依賴排程是設計參考；本專案自行實作，執行時不依賴 Task Master CLI、MCP 或其程式碼。參考來源：

- https://github.com/eyaltoledano/claude-task-master/blob/main/src/prompts/parse-prd.json
- https://github.com/eyaltoledano/claude-task-master/blob/main/scripts/modules/task-manager/find-next-task.js
- https://github.com/eyaltoledano/claude-task-master/blob/main/LICENSE

## 任務資料

`ai-workflow tasks` 把已核准 PRD 交給設定的拆任務 AI，要求輸出 JSON 任務。內建引擎驗證 ID、依賴存在性與循環，再以原子寫入及跨程序鎖保存到該專案的資料目錄 `~/.ai-workflow/projects/<id>/tasks.json`。每個功能有自己的群組，保存 PRD 版本、產生任務的 provider／session 與狀態事件。資料都在使用者目錄，不在專案裡；核准功能的任務清單另外隨功能封存在同一個資料目錄的 `archive/`。

任務包含 title、description、details、testStrategy、priority、dependencies、status、subtasks，可額外帶 requirement_ids、acceptanceCriteria、skills。AI 產生的需求對照仍須人工檢視；程式的圖形驗證不等於需求完整性審查。

排程優先接續進行／審查中的工作，再依優先序、穩定 ID 選擇依賴已完成的任務。blocked、cancelled、deferred 不會執行。存在子任務時執行子任務，全部完成後更新父任務。

狀態支援 pending、in-progress、review、done、blocked、cancelled、deferred。依賴未完成時不可開始；需先進入 review 才能標記 done。runner 仍負責檢查測試／review 的實際結果。重開前置任務之前，需先重設已執行的後續依賴工作，避免沿用失效結果。

沒有內建任務檔時，可讀取舊 `.taskmaster/tasks/tasks.json` 與 currentTag；第一次寫入時將所有群組匯入新檔，保留原檔。舊設定的 taskmaster、task_master 欄位不再控制任務流程；舊 prd_path 仍有效。

## 共用技能

App 預設提供 `grill-me` 與 `uiux-design`。技能庫在該專案的資料目錄 `~/.ai-workflow/projects/<id>/skills/<name>/`，每個技能包含標準 YAML frontmatter 與 Markdown 指令：

```markdown
---
name: my-skill
description: 說明技能用途及使用時機。
---
技能指令。
```

可帶 references、scripts、assets 等相對資源。匯入的來源資料夾結構與 Claude Code 的 `.claude/skills/<name>/` 相同：資料夾最上層要有 `SKILL.md`（檔名不分大小寫，`skill.md` 也接受，存進技能庫時統一叫 `SKILL.md`），其餘檔案與子目錄原樣複製；缺 SKILL.md 或路徑不是資料夾會拒絕。不自動執行腳本。單一技能上限 500 個檔案、10 MB，SKILL.md 上限 100 KB；符號連結不支援。

```bash
ai-workflow skills list
ai-workflow skills import <包含-SKILL.md-的資料夾>
ai-workflow skills run grill-me --input "我要做報表工具" --provider codex
ai-workflow skills run grill-me --input "使用者是財務人員" --session <上次回覆-id>
```

桌面 UI 的「Skills」頁是「左側清單 + 右側內容」：

- 左側列出所有技能（名稱、一行說明、來源「內建／匯入／內建・已修改」與相容狀態「相容／需調整／錯誤」），上方有搜尋框與「匯入技能」（原生資料夾選擇器，也接受把資料夾拖放到清單）。匯入後清單立即更新並選到新技能。
- 右側「內容」子頁顯示 SKILL.md 的 Markdown 預覽（與專案對話相同的渲染，含 Mermaid）、frontmatter 欄位（執行器專屬欄位會標示）與資源檔清單；「編輯」切到文字框，「儲存」寫回技能庫。匯入的技能可「刪除」（整個資料夾從技能庫移除）；內建技能沒有刪除，編輯過的內建技能顯示「還原內建」，刪掉副本後回到內建版本。對應 API：`POST skills/save`、`skills/import`、`skills/delete`。
- 右側「會議」子頁是完整高度的對話區：訊息同樣以 Markdown 渲染，下方是輸入框與 AI（claude／codex）選單，送出時顯示「AI 正在回覆（已 N 秒）」並可展開該次 CLI 的執行紀錄；上方下拉可切換歷史會議、接續已完成的會議或開新會議，「帶入需求待辦」把會議紀錄放進新需求。每次送出建立全新 CLI session，透過明確的會議紀錄交接；不 resume 原 session。會議紀錄（`skill-runs/<id>.json`）的每則訊息帶 `at` 時間與 `provider`，執行中的會議在建立時就記下 `provider` 與 `created_at`。
- 清單最上面的「工作流技能綁定」在右側顯示一張階段表（PRD 起草／修訂、PRD 審查、拆解任務、實作、程式碼審查、修正、交接），每列用 chips 顯示已綁定的技能，「＋」從相容技能的清單加入、chip 上的「×」移除；「儲存」只在有變更時啟用，資料走全域設定的 `skills/config`。
- 側欄與內容區各自捲動，App 外框不捲動；視窗窄於 900px 時側欄改為上方可收合的清單。

全域設定的 skills 可將技能綁定到 prd、prd_review、tasks、implement、code_review、fix、handover 階段，預設皆為空。任務自己的 skills 在實作、修正與程式碼審查時一起載入。

```json
{
  "skills": {
    "prd_review": ["grill-me"],
    "implement": ["uiux-design"],
    "code_review": ["uiux-design"]
  }
}
```

同一份可攜式 Skill 指令由 App 明確放入 Codex／Claude Code 的 prompt，搭配對應 runtime 的資源路徑；不修改使用者全域的原生技能目錄，也不依賴 slash command 自動觸發。每次執行將內容與資源雜湊，保存快照於資料目錄的 `tmp/skills/`，session 紀錄在 `sessions/`。

共用模式接受 name、description、metadata、license、compatibility。Claude 專屬的 hooks、context、agent、allowed-tools 等欄位可保存但會顯示不相容，執行前需人工轉寫；不默默忽略它們或改變權限。MCP、圖片生成、設計預覽等工具能力仍由實際 CLI 環境提供。

Grill Me 會議屬唯讀釐清，會議中 AI 的建議不等於已確認需求；轉入 PRD 時仍由使用者作決策。

需求待辦的「釐清需求」就是以 `grill-me` 主持的需求會議：`interviewer` 角色的 AI 先查專案與參考資料，每輪提出 1–4 個問題，至少回答一輪後才會產生可編輯的需求摘要；使用者確認摘要後才能起草 PRD。會議以 `kind: requirements` 的對話保存在資料目錄的 `chats/`，不出現在專案對話清單；需求標題、說明或參考資料修改後，舊會議與確認即失效，需要重新釐清。
