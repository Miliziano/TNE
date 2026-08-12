// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[cfg(feature = "desktop")]
fn main() {
    // Usiamo il percorso assoluto della crate per evitare ombreggiature di namespace
    ::app_lib::run();
}

#[cfg(not(feature = "desktop"))]
fn main() {
    eprintln!("Il binario 'app' (studio) richiede la feature 'desktop'. Per il runner headless: cargo run --bin flowpilot_runner -- <artifact.ffart>");
}

