# CLI 自動路由與單 AI 模式

新專案的 `runtime.claude`、`runtime.codex` 預設為 `auto`。

- Windows 專案（如 `C:\work\app`）使用 Windows CLI。
- WSL 專案（`\\wsl$\Ubuntu\home\me\app` 或 `\\wsl.localhost\Ubuntu\home\me\app`）使用路徑所屬發行版的 CLI，不使用其他預設發行版。
- 在 WSL 內直接執行 ai-workflow 時，使用該環境的原生 CLI。
- 舊設定中明確指定的 `windows`／`wsl` 仍然有效。可在設定頁切回「自動（依專案位置）」。

手動將 Windows 專案指定到 WSL 時，工作目錄直接交給 `wsl --cd`，不在每次啟動前另外呼叫 wslpath。只有 CLI 參數與 Skill 資源所需的檔案路徑才進行轉換；轉換採 30 秒等待，失敗時回報發行版、啟動錯誤或逾時原因。doctor 會提示手動環境與專案位置不一致的情況。

`ai-workflow doctor` 或設定頁的 doctor 按鈕會檢查 Windows 與 WSL 的 Claude Code／Codex 版本及訂閱登入狀態。WSL 檢查對象是專案所屬發行版；Windows 專案則使用設定的 `wsl_distro`，未設定時使用預設發行版。這不是所有 WSL 發行版的掃描。

doctor 顯示雙 AI、單 AI 或無 AI 可用。另一個環境缺少 CLI 不會阻擋目前專案；同一個 CLI 已安裝但尚未登入，也會分開顯示。檢查只呼叫版本與登入狀態，不產生模型對話。

每次 AI 工作開始前檢查指定 provider；不可用時改用另一個已安裝並以訂閱登入的 provider。若兩者都不可用，停止並提示 doctor。實作、審查、修正仍建立全新 session，PRD 歷史記錄實際執行的 provider。這只表示獨立 session，單 AI 模式不具備跨模型審查的多樣性。

PRD 起草、審查、拆任務及技能會議等唯讀工作，若 CLI 明確回報訂閱用量上限，會顯示原始重設時間，並至多改用同環境的另一個已登入 AI 一次；不會來回重試或跨 Windows／WSL 切換。實作等可寫入工作遇到限額時停止，確認已有變更後再重試。其他執行錯誤不會自動換 AI 重做。CLI 版本與登入檢查不代表訂閱額度、網路或模型請求一定成功。

任務流程使用內建引擎，詳見[任務與共用 Skills](tasks-and-skills.md)。
