// ─── src-tauri/src/engine/spec.rs ──────────────────────────────────
//
// Lettura della "busta" spec del plan (contratto: docs/node-spec.md).
//
// La spec è la fotografia integrale dei tab Configurazione+Avanzate
// che lo studio spedisce per ogni nodo:
//
//   spec: {
//     version:    1,
//     props:      { ...node.data.props verbatim, valori stringa... },
//     config:     { ...node.data.config strutturata... },
//     resource:   { ...risorsa di lane risolta... } | null,
//     resourceId: "res_…"
//   }
//
// PRINCIPI (v. node-spec.md §1):
// - le props sono stringhe con le chiavi camelCase dei pannelli:
//   gli accessor fanno parse lassista ("true"/"1000"/"1,2,3"),
//   MAI serde diretto su tipi nativi;
// - un campo required mancante → errore parlante, mai default muto;
// - ogni chiave letta viene tracciata: a fine nodo log_unconsumed()
//   stampa le props ricevute ma mai consultate, rendendo visibili
//   nel Monitor i campi che il nodo non implementa ancora.
//
// CONCETTI RUST:
// - `Mutex<HashSet<String>>` per il tracking: gli accessor prendono
//   &self (comodo da passare in giro), quindi serve interior
//   mutability; Mutex (non RefCell) perché i nodi girano in task
//   tokio e Spec deve essere Send.
// - Spec NON è Clone e non vive nel NodeContext: ogni nodo la
//   costruisce localmente da ctx.spec con Spec::from_ctx().

use std::collections::HashSet;
use std::sync::Mutex;
use serde_json::Value as Json;

pub struct Spec {
    props:       serde_json::Map<String, Json>,
    config:      Json,
    resource:    Json,
    resource_id: String,
    consumed:    Mutex<HashSet<String>>,
}

// ─── Coercizioni lassiste (valori pannello = stringhe) ────────────

fn json_to_string(v: &Json) -> Option<String> {
    match v {
        Json::String(s) => Some(s.clone()),
        Json::Bool(b)   => Some(b.to_string()),
        Json::Number(n) => Some(n.to_string()),
        _               => None,
    }
}

fn json_to_bool(v: &Json) -> Option<bool> {
    match v {
        Json::Bool(b)   => Some(*b),
        Json::Number(n) => n.as_i64().map(|i| i != 0),
        Json::String(s) => match s.trim().to_ascii_lowercase().as_str() {
            "true"  | "1" | "yes" | "on"      => Some(true),
            "false" | "0" | "no"  | "off" | "" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn json_to_u64(v: &Json) -> Option<u64> {
    match v {
        Json::Number(n) => n.as_u64(),
        Json::String(s) => s.trim().parse::<u64>().ok(),
        _               => None,
    }
}

impl Spec {
    /// Costruisce la Spec da ctx.spec. Errore parlante se il plan
    /// non contiene la busta (studio non aggiornato al Passo 1).
    pub fn from_ctx(spec: &Json) -> Result<Spec, String> {
        if spec.is_null() {
            return Err(
                "spec mancante nel plan: lo studio deve emettere la busta \
                 spec per ogni nodo (v. docs/node-spec.md §2)".to_string(),
            );
        }
        let props = spec.get("props")
            .and_then(|v| v.as_object())
            .cloned()
            .unwrap_or_default();
        let config = spec.get("config").cloned().unwrap_or(Json::Null);
        let resource = spec.get("resource").cloned().unwrap_or(Json::Null);
        let resource_id = spec.get("resourceId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        Ok(Spec { props, config, resource, resource_id, consumed: Mutex::new(HashSet::new()) })
    }

    fn mark(&self, key: &str) {
        if let Ok(mut c) = self.consumed.lock() {
            c.insert(key.to_string());
        }
    }

    fn raw(&self, key: &str) -> Option<&Json> {
        self.mark(key);
        self.props.get(key)
    }

    // ── Props: accessor tipizzati ─────────────────────────────────

    /// Campo obbligatorio: stringa non vuota (trim) o errore parlante.
    pub fn str_req(&self, key: &str) -> Result<String, String> {
        self.raw(key)
            .and_then(json_to_string)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .ok_or_else(|| format!("campo obbligatorio '{}' mancante o vuoto", key))
    }

    /// Stringa con default (applicato anche se presente ma vuota).
    pub fn str_or(&self, key: &str, default: &str) -> String {
        self.raw(key)
            .and_then(json_to_string)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default.to_string())
    }

    pub fn bool_or(&self, key: &str, default: bool) -> bool {
        self.raw(key).and_then(json_to_bool).unwrap_or(default)
    }

    pub fn u64_or(&self, key: &str, default: u64) -> u64 {
        self.raw(key).and_then(json_to_u64).unwrap_or(default)
    }

    pub fn usize_or(&self, key: &str, default: usize) -> usize {
        self.u64_or(key, default as u64) as usize
    }

    /// Lista CSV ("id, codice" → ["id","codice"]). Vuota se assente.
    pub fn str_list(&self, key: &str) -> Vec<String> {
        self.str_or(key, "")
            .split(',')
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .collect()
    }

    /// Struttura JSON: accetta sia un valore JSON diretto sia una
    /// stringa JSON-encoded (i pannelli salvano spesso JSON.stringify
    /// dentro una prop stringa, es. sinkColumns).
    pub fn json_or<T: serde::de::DeserializeOwned>(&self, key: &str, default: T) -> T {
        let parsed: Option<T> = match self.raw(key) {
            None => None,
            Some(Json::String(s)) => serde_json::from_str(s).ok(),
            Some(other)           => serde_json::from_value(other.clone()).ok(),
        };
        parsed.unwrap_or(default)
    }

    // ── Config strutturata (node.data.config) ────────────────────

    #[allow(dead_code)]
    pub fn config(&self) -> &Json {
        &self.config
    }

    // ── Risorsa risolta ───────────────────────────────────────────

    pub fn has_resource(&self) -> bool {
        self.resource.is_object()
    }

    pub fn res_str_or(&self, key: &str, default: &str) -> String {
        self.resource.get(key)
            .and_then(json_to_string)
            .map(|s| s.trim().to_string())
            .filter(|s| !s.is_empty())
            .unwrap_or_else(|| default.to_string())
    }

    pub fn res_u64_or(&self, key: &str, default: u64) -> u64 {
        self.resource.get(key).and_then(json_to_u64).unwrap_or(default)
    }

    pub fn res_u16_or(&self, key: &str, default: u16) -> u16 {
        self.res_u64_or(key, default as u64) as u16
    }

    pub fn resource_id(&self) -> String {
        self.resource_id.clone()
    }

    // ── Telemetria dei drop ───────────────────────────────────────

    /// Logga le props ricevute dallo studio ma mai lette dal nodo:
    /// sono i campi configurati dall'utente che l'esecutore non
    /// implementa (ancora). Rende i drop visibili invece che muti.
    pub fn log_unconsumed(&self, node_type: &str, node_id: &str) {
        let consumed = match self.consumed.lock() {
            Ok(c)  => c.clone(),
            Err(_) => return,
        };
        let mut unread: Vec<&str> = self.props.keys()
            .map(|k| k.as_str())
            .filter(|k| !consumed.contains(*k))
            .collect();
        if unread.is_empty() {
            eprintln!(
                "[spec][{}] {}: {} props ricevute, tutte consumate",
                node_type, node_id, self.props.len()
            );
            return;
        }
        unread.sort_unstable();
        eprintln!(
            "[spec][{}] {}: {} props ricevute, non consumate: {}",
            node_type, node_id, self.props.len(), unread.join(", ")
        );
    }
}
