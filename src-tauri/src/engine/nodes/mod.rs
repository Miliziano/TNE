// ─── src-tauri/src/engine/nodes/mod.rs ─────────────────────────────
// Registra i sottomoduli dei nodi disponibili in questa fase.
// Aggiungere un nodo = aggiungere `pub mod nome;` qui + il file.

// src-tauri/src/engine/nodes/mod.rs

// R8 — barriera + parametri, condivisa da tutte le sorgenti.
// Una funzione sola: la regola è identica per tutte, e dieci copie di una
// regola sono il modo in cui questa base di codice si è ammalata finora.
pub mod source_input;

pub mod source_file;
pub mod source_ftp;
pub mod dir_watcher;
pub mod source_mqtt;
pub mod source_http;
pub mod webhook_receiver;   // service mode 4b: riceve webhook HTTP
pub mod watchdog;           // service mode: sonda HTTP (gate/stream/edge)
pub mod webhook_responder;  // service mode 5: risponde HEAD/GET con header sintetici
pub mod source_activemq;    // consumer STOMP (batch)
pub mod http_request;
pub mod source_db;
pub mod filter;
pub mod sink_file;
pub mod sink_ftp;
pub mod sink_mqtt;
pub mod sink_http;
pub mod sink_db;
pub mod tmap;

// ── Nodi semplici ────────────────────────────────────────────────
pub mod log;
pub mod error_handler;
pub mod stop;              // controllo di flusso: ferma la lane (service mode 2a)
pub mod report_generator;
pub mod script;

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