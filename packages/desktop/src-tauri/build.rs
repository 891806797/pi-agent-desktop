fn main() {
    std::fs::write(
        std::path::Path::new(&std::env::var("OUT_DIR").unwrap()).join("target.txt"),
        std::env::var("TARGET").unwrap(),
    )
    .unwrap();
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "backend_request",
            "backend_subscribe",
            "backend_unsubscribe",
            "backend_status",
            "backend_restart",
            "backend_visibility",
        ]),
    ))
    .expect("Tauri build configuration");
}
