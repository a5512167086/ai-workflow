//! 專案與全域資料：設定（全域 config.json ＋ 專案 project.json）、狀態檔、資料目錄（~/.ai-workflow）、
//! 專案清單、跨專案的執行佇列、加入專案時的初始化與舊資料搬移、給 App 推送變化的監看器。
pub mod config;
pub mod home;
pub mod init;
pub mod projects;
pub mod queue;
pub mod state;
pub mod watch;
