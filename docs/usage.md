# Token 與訂閱額度

桌面版頂列顯示本專案已記錄的 token 處理量，點擊可開啟「用量」頁。此頁提供：

- Claude Code／Codex 各自在目前專案執行環境的最近一次與累計用量。
- 輸入、輸出與快取輸入的細項，以及最近 20 次執行。
- CLI 有提供時，顯示訂閱額度的各視窗剩餘百分比、重設時間與資料擷取時間。
- 有容量與最近一次請求占用資料時，顯示 context 剩餘 tokens 與百分比。

## 三種數字分開解讀

Token 處理量包括快取讀取；Claude 的 cache-read／cache-creation 分開加回輸入，Codex cached-input 是 input 的子集，不重複加總。輸出已包括 CLI 回報的推理用量，不再另加。這不是帳單金額或剩餘訂閱額度。

訂閱額度由服務端依帳號與視窗計算，無法把本機累計 tokens 換算成固定剩餘 tokens。Codex 使用官方 app-server 的 `account/rateLimits/read` 查詢，沒有建立模型 thread／turn。開啟用量頁時查詢一次（60 秒內重開不重複），也可按「更新訂閱額度」。

Claude 使用 `rate_limit_event` 回報的 utilization 與 resetsAt；未提供比例時顯示未知，即使回報 rejected 也不自行推算 0%。更新按鈕查詢 Codex，Claude 顯示最近一次執行事件。

Context 與訂閱額度不同。Claude 的 context 數字以最後一次模型請求的 tokens 和該模型回報的 contextWindow 估算，並標示「估算」。不使用多輪累計 tokens 推算 context。Codex 若沒有提供容量及最近一次請求資料則顯示未知。

## 保存與資料品質

資料存在專案 `.aipipe/usage.json`，每筆以 session ID 更新，具原子寫入與跨程序鎖；同一筆串流或最終結果不重複計數。原始 session 紀錄也保存 tokens、context 與限額資料。自此功能啟用後開始記錄，不補估舊執行用量。

執行失敗或切換另一個 AI 時，已回報的用量仍分別保存。沒有回報的用量顯示未知，明確回報 0 時才顯示 0。Windows 與不同 WSL 發行版的額度快照分開保存，避免混用帳號資料。畫面時間統一以 Asia/Taipei 顯示。

超過重設時間的額度快照不再顯示有效剩餘百分比，需更新查詢。其他工具的使用也會改變訂閱額度，所有比例均為擷取當下的快照。

官方格式參考：

- https://developers.openai.com/codex/noninteractive
- https://developers.openai.com/codex/app-server
- https://code.claude.com/docs/en/agent-sdk/typescript
