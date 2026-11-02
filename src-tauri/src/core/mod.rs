//! ai-workflow 的核心邏輯，桌面 App（commands／tray）與 CLI 子指令共用。依領域分資料夾：
//!
//! - `agents/`：呼叫 Claude Code／Codex CLI（claude.rs、codex.rs）、權限請求、prompt、能力偵測、用量。
//! - `workflow/`：需求待辦、需求釐清、PRD、任務、執行流程、人工檢查點、專案對話、參考資料、封存。
//! - `project/`：設定、狀態檔、資料目錄、專案清單、執行佇列、初始化、變化監看。
//! - `skills/`：共用技能庫與內建技能。
//! - `system/`：子程序、Windows／WSL 執行環境、git、環境檢查（doctor）。
//! - `api.rs`：前端呼叫的路由（路徑沿用舊版 HTTP API）；`cli.rs`：命令列子指令。
//!
//! 各模組也以原本的扁平名稱匯出（例如 `core::prd`、`core::config`），既有的路徑與測試不用改。
pub mod agents;
pub mod api;
pub mod cli;
pub mod error;
pub mod project;
pub mod skills;
pub mod system;
pub mod util;
pub mod workflow;

pub use agents::{capabilities, errors as agent_errors, permissions, prompts, savings, usage};
pub use error::{AppError, Result};
pub use project::{config, home, init, projects, queue, state, watch};
pub use skills::builtin as builtin_skills;
pub use system::{doctor, git, proc, runtime};
pub use workflow::{archive, backlog, chat, graph, guards, human, prd, references, requirements, runner, tasks};
