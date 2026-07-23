// ─── src-tauri/src/engine/errors.rs ────────────────────────────────
//
// Attrezzi del canale CONTROLLO dell'error handling: la riga `_error_*`
// (build_error_row), la regola di instradamento (goes_to_handler) e la
// lettura dei campi (field_str).
//
// Il TRASPORTO non sta più qui: dal passo 2 del modello a canale è un
// mpsc per lane (il COLLETTORE, creato dall'executor prima dello spawn)
// che l'error_handler drena in streaming. Il vecchio registro LaneErrors
// (accumula-e-drena a fine lane, P37-P39) è stato smontato: accumulare
// obbligava a un trattamento speciale a fine lane, il canale si chiude
// da solo quando l'ultimo produttore droppa il sender.

use std::collections::HashMap;
use crate::engine::types::{Row, Value};
use crate::engine::events::EngineEvent;

/// Il blocco `advanced` del nodo (onError, critical, retryCount…), letto
/// dal punto GIUSTO del piano.
///
/// 🔑 Lo studio salva le impostazioni avanzate in `node.data.config.advanced`,
/// e `buildRustPlan` (Toolbar.tsx) manda `node.data.config` dentro **spec.config**,
/// NON dentro `config`: quel campo è la selezione LEGACY per-tipo costruita da
/// `node.data.props`, e `advanced` non ci finisce mai. Leggere
/// `config["advanced"]` — come si faceva fino a P44 — restituiva quindi sempre
/// None, e ogni impostazione avanzata cadeva sul default: critical mai attivo,
/// retry mai attivo, onError sempre "handler". Si legge da spec.config, con
/// `config` come ripiego per i piani vecchi o costruiti altrimenti.
pub fn advanced<'a>(config: &'a serde_json::Value, spec: &'a serde_json::Value) -> Option<&'a serde_json::Value> {
    spec.get("config")
        .and_then(|c| c.get("advanced"))
        .or_else(|| config.get("advanced"))
}

/// True se gli errori del nodo vanno all'error_handler (modalità handler /
/// retry_handler, o assente = default handler). False per catch / retry_catch,
/// dove il nodo li gestisce da sé sulla porta catch.
pub fn goes_to_handler(config: &serde_json::Value, spec: &serde_json::Value) -> bool {
    let mode = advanced(config, spec)
        .and_then(|a| a.get("onError"))
        .and_then(|v| v.as_str())
        .unwrap_or("handler");
    mode != "catch" && mode != "retry_catch"
}

/// Estrae un campo stringa da una riga `_error_*` (vuoto se assente o non
/// stringa). Comodo per leggere `_error_node_id`, `_error_message`, ecc.
pub fn field_str(row: &Row, key: &str) -> String {
    match row.0.get(key) {
        Some(Value::String(s)) => s.clone(),
        _ => String::new(),
    }
}

/// True se un errore di questo nodo deve INTERROMPERE la lane. Il flag
/// vive in `advanced.critical` ed è una STRINGA 'true'|'false' (come
/// retryCount: lo studio salva tutti gli advanced come stringhe — v.
/// P36). Vale solo in modalità handler: per catch/retry_catch il nodo
/// gestisce da sé e lo studio disabilita la casella (MappingPanel).
pub fn is_critical(config: &serde_json::Value, spec: &serde_json::Value) -> bool {
    advanced(config, spec)
        .and_then(|a| a.get("critical"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// True se gli errori di questo nodo non devono intasare l'audit trail:
/// niente riga nel pannello, niente emissione su `error_out`. Il flag vive
/// in `advanced.excludeFromErrorLog` ed è una STRINGA 'true'|'false'.
/// NB è una soppressione di RUMORE, non di sicurezza: l'errore viaggia lo
/// stesso sul canale di controllo, e l'handler continua a poter
/// interrompere la lane (v. error_handler.rs).
pub fn is_excluded_from_log(config: &serde_json::Value, spec: &serde_json::Value) -> bool {
    advanced(config, spec)
        .and_then(|a| a.get("excludeFromErrorLog"))
        .and_then(|v| v.as_str())
        .map(|s| s.trim() == "true")
        .unwrap_or(false)
}

/// I flag del nodo che viaggiano insieme all'errore. Sono un STRUCT e non
/// due parametri `bool` di fila perché il Rust qui non si compila: due
/// booleani adiacenti si invertono in silenzio, e invertire questi due
/// significherebbe far interrompere la lane a un nodo non critico. Coi
/// campi nominati allo `struct` lo scambio è impossibile.
pub struct ErrorFlags {
    pub critical: bool,
    pub excluded: bool,
}

/// Costruisce una riga `_error_*` (schema generale, uguale per tutti i
/// nodi — v. types/index.ts:119). Fetta 1: i campi base. `_error_code` e
/// `_error_row` arriveranno con le regole (fetta 3).
///
/// `_error_critical` viaggia sulla riga perché l'EH non ha accesso al
/// piano: dell'errore vede solo ciò che gli arriva sul collettore, e la
/// decisione di interrompere è sua (v. abort.rs). È dichiarato in
/// ERROR_HANDLER_SCHEMA, quindi l'utente può anche filtrarci sopra nella
/// propria pipeline d'errore.
pub fn build_error_row(
    node_id:   &str,
    node_type: &str,
    message:   &str,
    flags:     &ErrorFlags,
    lane_id:   &str,
) -> Row {
    let mut m: HashMap<String, Value> = HashMap::new();
    m.insert("_error_critical".to_string(),
             Value::String(if flags.critical { "true" } else { "false" }.to_string()));
    m.insert("_error_excluded".to_string(),
             Value::String(if flags.excluded { "true" } else { "false" }.to_string()));
    m.insert("_error_lane_id".to_string(), Value::String(lane_id.to_string()));
    // `_error_source` distingue i DUE CANALI del modello: "node" è il
    // canale di CONTROLLO (eccezione di nodo, livello nodo) — l'unico che
    // oggi produce righe. Quando la porta `catch` emetterà davvero
    // (canale DATI, livello riga) quelle righe porteranno "row", e chi
    // legge la pipeline d'errore potrà distinguerle senza indovinare.
    m.insert("_error_source".to_string(), Value::String("node".to_string()));
    m.insert("_error_message".to_string(),   Value::String(message.to_string()));
    m.insert("_error_node_id".to_string(),   Value::String(node_id.to_string()));
    m.insert("_error_node_type".to_string(), Value::String(node_type.to_string()));
    m.insert("_error_at".to_string(),        Value::String(EngineEvent::timestamp_ms().to_string()));
    Row(m)
}
