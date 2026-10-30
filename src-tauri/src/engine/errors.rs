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

/// Politica d'esecuzione di un nodo, dalla scheda Advanced (P355).
///
/// - `catches`: modalità catch / retry_catch — un fallimento del nodo esce
///   come riga `_error_*` sulla porta `catch` ed è GESTITO (la lane non
///   fallisce). Senza un arco sulla catch si ricade sull'error handler.
/// - `retry`: (tentativi, attesa_secondi) per retry_handler / retry_catch,
///   None se 0 tentativi o modalità senza retry.
/// - `timeout_sec`: tempo massimo d'esecuzione del nodo (`maxRunSec`), 0 = nessuno.
#[derive(Debug, Clone, Copy, Default)]
pub struct ExecPolicy {
    pub catches:     bool,
    pub retry:       Option<(u32, u64)>,
    pub timeout_sec: u64,
}

pub fn exec_policy(config: &serde_json::Value, spec: &serde_json::Value) -> ExecPolicy {
    let Some(adv) = advanced(config, spec) else { return ExecPolicy::default() };
    let s = |k: &str| adv.get(k).map(|v| match v {
        serde_json::Value::String(s) => s.trim().to_string(),
        other => other.to_string(),
    }).unwrap_or_default();
    let mode = s("onError");
    let n: u32 = s("retryCount").parse().unwrap_or(0);
    let d: u64 = s("retryDelaySec").parse().unwrap_or(0);
    ExecPolicy {
        catches:     mode == "catch" || mode == "retry_catch",
        retry:       if (mode == "retry_handler" || mode == "retry_catch") && n > 0 { Some((n, d)) } else { None },
        // `maxRunSec`, scritto dal builder dal P355. NON `timeoutSec`: nei
        // piani esportati prima valeva '30' di default senza essere mai
        // applicato — leggerlo fermerebbe a 30 s nodi che oggi girano.
        timeout_sec: s("maxRunSec").parse().unwrap_or(0),
    }
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
    // `_error_source` = "node": errore di NODO (il nodo è fallito). Vale
    // sia sul collettore dell'error handler sia sulla porta `catch` (P355),
    // che porta la stessa riga. Gli scarti riga per riga restano sulle
    // porte `reject` dei nodi che le hanno.
    m.insert("_error_source".to_string(), Value::String("node".to_string()));
    m.insert("_error_message".to_string(),   Value::String(message.to_string()));
    m.insert("_error_node_id".to_string(),   Value::String(node_id.to_string()));
    m.insert("_error_node_type".to_string(), Value::String(node_type.to_string()));
    m.insert("_error_at".to_string(),        Value::String(EngineEvent::timestamp_ms().to_string()));
    Row(m.into_iter().collect())
}

/// Riga di CHIUSURA DELIBERATA originata dal nodo `stop` (fetta 2b). Va
/// sullo stesso collettore dei fallimenti, ma è marcata `_error_source =
/// "stop"` e **non critica**: l'error_handler la riconosce, la registra
/// come interruzione voluta (non un errore) e la emette su `error_out`,
/// dove la sotto-pipeline dell'utente esegue gli effetti (log/mail/http/
/// sink). NON fa scattare l'abort — quello lo fa il nodo stop da sé. Così
/// gli effetti di chiusura si disegnano UNA volta (nell'EH) e valgono per
/// errori e per stop.
pub fn build_stop_row(node_id: &str, message: &str, lane_id: &str) -> Row {
    let mut m: HashMap<String, Value> = HashMap::new();
    m.insert("_error_source".to_string(),    Value::String("stop".to_string()));
    m.insert("_error_critical".to_string(),  Value::String("false".to_string()));
    m.insert("_error_excluded".to_string(),  Value::String("false".to_string()));
    m.insert("_error_lane_id".to_string(),   Value::String(lane_id.to_string()));
    m.insert("_error_message".to_string(),   Value::String(message.to_string()));
    m.insert("_error_node_id".to_string(),   Value::String(node_id.to_string()));
    m.insert("_error_node_type".to_string(), Value::String("stop".to_string()));
    m.insert("_error_at".to_string(),        Value::String(EngineEvent::timestamp_ms().to_string()));
    Row(m.into_iter().collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pol(adv: serde_json::Value) -> ExecPolicy {
        exec_policy(&serde_json::json!({}), &serde_json::json!({ "config": { "advanced": adv } }))
    }

    #[test]
    fn politica_dalla_scheda_advanced() {
        let p = pol(serde_json::json!({ "onError": "retry_catch", "retryCount": "3", "retryDelaySec": "2", "maxRunSec": "10" }));
        assert!(p.catches);
        assert_eq!(p.retry, Some((3, 2)));
        assert_eq!(p.timeout_sec, 10);
        // retry con 0 tentativi = niente retry; handler non cattura
        let p = pol(serde_json::json!({ "onError": "retry_handler", "retryCount": "0" }));
        assert!(!p.catches && p.retry.is_none());
        // il vecchio timeoutSec (default '30', mai applicato) NON è un limite
        assert_eq!(pol(serde_json::json!({ "timeoutSec": "30" })).timeout_sec, 0);
        assert_eq!(exec_policy(&serde_json::json!({}), &serde_json::json!({})).timeout_sec, 0);
    }
}
