// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Usiamo il percorso assoluto della crate per evitare ombreggiature di namespace
    ::app_lib::run();
}

