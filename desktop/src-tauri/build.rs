fn main() {
    // 視窗內容是 sidecar 的本機網址（遠端來源），自訂指令要明確列出才會產生 allow-* 權限給 capability 使用。
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["pick_folder", "server_url"])),
    )
    .expect("tauri build script failed");
}
