// ─── src-tauri/src/engine/errors.rs ────────────────────────────────
//
// Registro per-lane degli errori raccolti dai nodi in modalità "handler".
// L'error_handler li legge a FINE LANE ed emette su `error_out` (fetta 2).
// Calco leggero di LaneDatasets: qui basta accumulare e drenare — niente
// indice, niente attesa, niente Notify.
//
// Perché a fine lane e non un nodo spawato: l'error_handler deve agire
// DOPO che tutti gli altri nodi hanno concluso (altrimenti raccoglierebbe
// errori non ancora arrivati), come `finalize_with_outcome` per le
// transazioni. Vedi DISEGNO-error-handling.md §10.

use std::sync::Arc;
use std::collections::HashMap;
use tokio::sync::Mutex;
use crate::engine::types::{Row, Value};
use crate::engine::events::EngineEvent;

/// Accumulatore condiviso delle righe-errore della lane. I nodi che
/// falliscono in modalità handler vi depositano una riga `_error_*`
/// (build_error_row); l'error_handler la drena a fine lane.
pub struct LaneErrors {
    rows: Mutex<Vec<Row>>,
}

impl LaneErrors {
    pub fn new() -> Arc<LaneErrors> {
        Arc::new(LaneErrors { rows: Mutex::new(Vec::new()) })
    }

    /// Deposita una riga-errore.
    pub async fn push(&self, row: Row) {
        self.rows.lock().await.push(row);
    }

    /// Preleva e svuota tutte le righe accumulate (chiamato a fine lane
    /// dall'error_handler).
    pub async fn drain(&self) -> Vec<Row> {
        let mut guard = self.rows.lock().await;
        std::mem::take(&mut *guard)
    }

    /// True se non è stato accumulato alcun errore.
    pub async fn is_empty(&self) -> bool {
        self.rows.lock().await.is_empty()
    }
}

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
