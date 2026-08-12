fn main() {
    // `tauri_build::build()` va eseguito SOLO per il build "desktop" (lo studio).
    // Il runner headless si compila con `--no-default-features`: lì Tauri non è
    // tra le dipendenze, e tauri_build andrebbe in panic ("missing cargo:dev").
    // Cargo espone le feature abilitate ai build script come CARGO_FEATURE_<NOME>.
    if std::env::var("CARGO_FEATURE_DESKTOP").is_ok() {
        tauri_build::build();
    }
}
