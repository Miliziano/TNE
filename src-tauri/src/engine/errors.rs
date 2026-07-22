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

/// True se gli errori del nodo vanno all'error_handler (modalità handler /
/// retry_handler, o assente = default handler). False per catch / retry_catch,
/// dove il nodo li gestisce da sé sulla porta catch. `config` è la config del
/// NodePlan (serde_json), che include il blocco `advanced`.
pub fn goes_to_handler(config: &serde_json::Value) -> bool {
    let mode = config.get("advanced")
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

/// Costruisce una riga `_error_*` (schema generale, uguale per tutti i
/// nodi — v. types/index.ts:119). Fetta 1: i campi base. `_error_code` e
/// `_error_row` arriveranno con le regole (fetta 3).
pub fn build_error_row(node_id: &str, node_type: &str, message: &str) -> Row {
    let mut m: HashMap<String, Value> = HashMap::new();
    m.insert("_error_message".to_string(),   Value::String(message.to_string()));
    m.insert("_error_node_id".to_string(),   Value::String(node_id.to_string()));
    m.insert("_error_node_type".to_string(), Value::String(node_type.to_string()));
    m.insert("_error_at".to_string(),        Value::String(EngineEvent::timestamp_ms().to_string()));
    Row(m)
}
