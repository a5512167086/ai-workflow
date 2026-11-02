# Token 與訂閱額度

桌面版頂列顯示本專案已記錄的 token 處理量，點擊可開啟「用量」頁。此頁提供：

- Claude Code／Codex 各自在目前專案執行環境的最近一次與累計用量。
- 輸入、輸出與快取輸入的細項，以及可展開的最近 20 次執行。
- CLI 有提供時，顯示訂閱額度的各視窗剩餘百分比、重設時間與資料擷取時間。
- 有容量與最近一次請求占用資料時，顯示 context 剩餘 tokens 與百分比。
- 「節省 Token」卡片：估計省下的 tokens、目前開啟的節省項目，以及依階段分開的次數、用量、占比、平均與估計節省（設定見 README 的「節省 Token」）。

## 估計節省量怎麼算

組 prompt 時，每一項節省功能記下原本會送出與實際送出的內容差了多少 tokens（中文一字約一個、ASCII 四字元約一個），存在 session 紀錄的 `saved` 與 `usage.json` 的 `savedTokens`。用量頁再乘上這個 session 的請求次數：Claude 以 assistant 訊息數計算；Codex 沒有回報請求次數，以 1 次計，所以是下限。精簡回覆只加在 prompt 上、無法直接算出少了多少輸出，session 只標記 `terse`。舊紀錄沒有階段資訊，歸在「舊紀錄（未分類）」。

## 三種數字分開解讀

Token 處理量包括快取讀取；Claude 的 cache-read／cache-creation 分開加回輸入，Codex cached-input 是 input 的子集，不重複加總。輸出已包括 CLI 回報的推理用量，不再另加。這不是帳單金額或剩餘訂閱額度。

訂閱額度由服務端依帳號與視窗計算，無法把本機累計 tokens 換算成固定剩餘 tokens。Codex 使用官方 app-server 的 `account/rateLimits/read` 查詢，沒有建立模型 thread／turn。開啟用量頁時查詢一次（60 秒內重開不重複），也可按「更新訂閱額度」。

Claude 使用 `rate_limit_event` 回報的 utilization 與 resetsAt；未提供比例時顯示未知，即使回報 rejected 也不自行推算 0%。更新按鈕也會嘗試以 Claude CLI 的 `/usage` 查詢，CLI 未提供資料時顯示查詢狀態並保留既有快照。

Context 與訂閱額度不同。Claude 的 context 數字以最後一次模型請求的 tokens 和該模型回報的 contextWindow 估算，並標示「估算」。不使用多輪累計 tokens 推算 context。Codex 若沒有提供容量及最近一次請求資料則顯示未知。

## 保存與資料品質

資料存在該專案的資料目錄 `~/.ai-workflow/projects/<id>/usage.json`，每筆以 session ID 更新，具原子寫入與跨程序鎖；同一筆串流或最終結果不重複計數。原始 session 紀錄也保存 tokens、context 與限額資料。自此功能啟用後開始記錄，不補估舊執行用量。

執行失敗或切換另一個 AI 時，已回報的用量仍分別保存。沒有回報的用量顯示未知，明確回報 0 時才顯示 0。Windows 與不同 WSL 發行版的額度快照分開保存，避免混用帳號資料。畫面時間統一以 Asia/Taipei 顯示。

超過重設時間的額度快照不再顯示有效剩餘百分比，需更新查詢。其他工具的使用也會改變訂閱額度，所有比例均為擷取當下的快照。

官方格式參考：

- https://developers.openai.com/codex/noninteractive
- https://developers.openai.com/codex/app-server
- https://code.claude.com/docs/en/agent-sdk/typescript
