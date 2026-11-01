# 內建任務引擎與共用 Skills

Task Master 的任務格式、PRD 拆解與依賴排程是設計參考；本專案自行實作，執行時不依賴 Task Master CLI、MCP 或其程式碼。參考來源：

- https://github.com/eyaltoledano/claude-task-master/blob/main/src/prompts/parse-prd.json
- https://github.com/eyaltoledano/claude-task-master/blob/main/scripts/modules/task-manager/find-next-task.js
- https://github.com/eyaltoledano/claude-task-master/blob/main/LICENSE

## 任務資料

`aipipe tasks` 把已核准 PRD 交給設定的作者 AI，要求輸出 JSON 任務。內建引擎驗證 ID、依賴存在性與循環，再以原子寫入及跨程序鎖保存到專案 `.aipipe/tasks.json`。每個功能有自己的群組，保存 PRD 版本、產生任務的 provider／session 與狀態事件。資料在本機；核准功能的任務清單另外隨功能封存，可提交 Git。

任務包含 title、description、details、testStrategy、priority、dependencies、status、subtasks，可額外帶 requirement_ids、acceptanceCriteria、skills。AI 產生的需求對照仍須人工檢視；程式的圖形驗證不等於需求完整性審查。

排程優先接續進行／審查中的工作，再依優先序、穩定 ID 選擇依賴已完成的任務。blocked、cancelled、deferred 不會執行。存在子任務時執行子任務，全部完成後更新父任務。

狀態支援 pending、in-progress、review、done、blocked、cancelled、deferred。依賴未完成時不可開始；需先進入 review 才能標記 done。runner 仍負責檢查測試／review 的實際結果。重開前置任務之前，需先重設已執行的後續依賴工作，避免沿用失效結果。

沒有內建任務檔時，可讀取舊 `.taskmaster/tasks/tasks.json` 與 currentTag；第一次寫入時將所有群組匯入新檔，保留原檔。舊設定的 taskmaster、task_master 欄位不再控制任務流程；舊 prd_path 仍有效。

## 共用技能

App 預設提供 `grill-me` 與 `uiux-design`。技能庫在專案 `.aipipe/skills/<name>/`，每個技能包含標準 YAML frontmatter 與 Markdown 指令：

```markdown
---
name: my-skill
description: 說明技能用途及使用時機。
---
技能指令。
```

可帶 references、scripts、assets 等相對資源。匯入會保留完整目錄；不自動執行腳本。單一技能上限 500 個檔案、10 MB，SKILL.md 上限 100 KB；符號連結不支援。

```bash
aipipe skills list
aipipe skills import <包含-SKILL.md-的資料夾>
aipipe skills run grill-me --input "我要做報表工具" --provider codex
aipipe skills run grill-me --input "使用者是財務人員" --session <上次回覆-id>
```

在桌面 UI 的「Skills」頁可匯入／編輯技能、選擇執行器、接續會議，以及將會議帶入 PRD 需求欄位。每次送出建立全新 CLI session，透過明確的會議紀錄交接；不 resume 原 session。

設定 skills 可將技能綁定到 prd、prd_review、tasks、implement、code_review、fix、handover 階段，預設皆為空。任務自己的 skills 在實作、修正與程式碼審查時一起載入。

```json
{
  "skills": {
    "prd_review": ["grill-me"],
    "implement": ["uiux-design"],
    "code_review": ["uiux-design"]
  }
}
```

同一份可攜式 Skill 指令由 App 明確放入 Codex／Claude Code 的 prompt，搭配對應 runtime 的資源路徑；不修改使用者全域的原生技能目錄，也不依賴 slash command 自動觸發。每次執行將內容與資源雜湊，保存快照於 `.aipipe/tmp/skills/`，session 紀錄在 `.aipipe/sessions/`。

共用模式接受 name、description、metadata、license、compatibility。Claude 專屬的 hooks、context、agent、allowed-tools 等欄位可保存但會顯示不相容，執行前需人工轉寫；不默默忽略它們或改變權限。MCP、圖片生成、設計預覽等工具能力仍由實際 CLI 環境提供。

Grill Me 會議屬唯讀釐清，會議中 AI 的建議不等於已確認需求；轉入 PRD 時仍由使用者作決策。
