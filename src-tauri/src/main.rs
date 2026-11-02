// ai-workflow 桌面版的進入點。帶參數執行時是命令列（GUI 也用這個方式在背景啟動流程程序）；
// 沒有參數時開啟桌面 App。App 的組裝在 lib.rs 的 run()，後端邏輯在 src/core。
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ai_workflow::run_cli_if_requested();
    ai_workflow::run();
}
