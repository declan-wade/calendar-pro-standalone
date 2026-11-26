fn main() {
    // Naming the app's commands gives each a permission (allow-start and so on), so the
    // capabilities can grant the calendar page, served by the backend, only the one it needs.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["start", "save_passwords", "create_config"]),
    ))
    .expect("failed to run tauri-build")
}
