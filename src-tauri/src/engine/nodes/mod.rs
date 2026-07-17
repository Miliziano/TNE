// ─── src-tauri/src/engine/nodes/mod.rs ─────────────────────────────
// Registra i sottomoduli dei nodi disponibili in questa fase.
// Aggiungere un nodo = aggiungere `pub mod nome;` qui + il file.

// src-tauri/src/engine/nodes/mod.rs

// R8 — barriera + parametri, condivisa da tutte le sorgenti.
// Una funzione sola: la regola è identica per tutte, e dieci copie di una
// regola sono il modo in cui questa base di codice si è ammalata finora.
pub mod source_input;

pub mod source_file;
pub mod source_db;
pub mod filter;
pub mod sink_file;
pub mod sink_db;
pub mod tmap;

// ── Nodi semplici ────────────────────────────────────────────────
pub mod log;

//pub mod map;
pub mod transform;
pub mod union;
pub mod data_quality;

// ── Nodi medio/complessi ─────────────────────────────────────────
//pub mod sort;
pub mod aggregate;
pub mod explode;
pub mod materialize;
pub mod join;
pub mod pivot;
pub mod window;

// ── Serializzatori ───────────────────────────────────────────────
pub mod json_serializer;
pub mod json_parser;
pub mod xml_serializer;
pub mod xml_parser;