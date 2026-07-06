// ─── src-tauri/src/engine/types.rs ─────────────────────────────────
//
// Modello dati condiviso tra tutte le parti dell'Engine.
//
// CONCETTI RUST NUOVI IN QUESTO FILE:
//
// 1. `enum` con dati — in Rust un enum può contenere valori, non solo
//    essere una lista di costanti. `Value::String("ciao")` è un valore
//    di tipo Value che contiene una String. È il modo idiomatico per
//    rappresentare "una cosa che può essere uno di questi tipi" —
//    equivalente a un tipo union TypeScript ma controllato dal compilatore.
//
// 2. `#[derive(...)]` — istruisce il compilatore a generare
//    automaticamente implementazioni di trait comuni:
//    - Debug: permette di stampare la struct con {:?}
//    - Clone: permette di copiare il valore con .clone()
//    - Serialize/Deserialize: permette di convertire da/verso JSON (serde)
//    - PartialEq: permette di confrontare due valori con ==
//
// 3. `HashMap<K, V>` — equivalente di Map<K, V> in TypeScript.
//    Qui: HashMap<String, Value> = { [key: string]: Value }
//
// 4. `Vec<T>` — array dinamico, equivalente di Array<T> in TypeScript.
//    A differenza di JS, la dimensione non è fissa ma cresce come serve.
//
// 5. `Option<T>` — equivalente di T | null in TypeScript. O hai
//    `Some(valore)` o hai `None`. Il compilatore forza a gestire
//    entrambi i casi — niente "undefined is not a function".

use std::collections::HashMap;
use serde::{Deserialize, Serialize};

// ─── Value — tipo di dato di una singola cella ────────────────────
//
// Ogni riga dell'ETL è una HashMap<String, Value>.
// Value rappresenta i tipi che FlowPilot già conosce (vedi FieldType
// in src/types.ts) — portiamo esattamente gli stessi tipi in Rust.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]  // in JSON non appare il tag del tipo, solo il valore
pub enum Value {
    Null,
    Bool(bool),
    Int(i64),
    Float(f64),
     /// Decimale a precisione arbitraria (NUMERIC/DECIMAL di Postgres,
    /// NUMBER di Oracle, DECIMAL/MONEY di Informix). Esatto: non passa
    /// mai per f64. I nodi di calcolo che non lo gestiscono ancora lo
    /// trattano come Float (v. as_f64_lossy).
    Decimal(rust_decimal::Decimal),
    String(String),
    // Date e DateTime sono stringhe ISO 8601 a livello di trasporto —
    // l'interprete le converte quando serve fare operazioni su date
    Date(String),
    DateTime(String),
    // Per campi JSON annidati (colonne JSONB, dati oggetto)
    Object(serde_json::Value),
}

impl Value {
    /// Converte in stringa per output e confronti — equivalente di
    /// String(value) in JS, ma esplicito e senza coercioni nascoste.
    pub fn as_str_repr(&self) -> String {
        match self {
            Value::Null          => String::new(),
            Value::Bool(b)       => b.to_string(),
            Value::Int(i)        => i.to_string(),
            Value::Float(f)      => f.to_string(),
            Value::Decimal(d)    => d.to_string(),
            Value::String(s)     => s.clone(),
            Value::Date(s)       => s.clone(),
            Value::DateTime(s)   => s.clone(),
            Value::Object(v)     => v.to_string(),
        }
    }

    /// Converte da serde_json::Value (quello che arriva dal frontend
    /// o dal DB) a Value interno dell'Engine.
    pub fn from_json(v: serde_json::Value) -> Self {
        match v {
            serde_json::Value::Null       => Value::Null,
            serde_json::Value::Bool(b)    => Value::Bool(b),
            serde_json::Value::String(s)  => Value::String(s),
            serde_json::Value::Number(n)  => {
                if let Some(i) = n.as_i64() { Value::Int(i) }
                else if let Some(f) = n.as_f64() { Value::Float(f) }
                else { Value::String(n.to_string()) }
            }
            other => Value::Object(other),
        }
    }

    /// Converte a serde_json::Value per il trasporto verso il frontend.
    pub fn to_json(&self) -> serde_json::Value {
        match self {
            Value::Null          => serde_json::Value::Null,
            Value::Bool(b)       => serde_json::json!(b),
            Value::Int(i)        => serde_json::json!(i),
            Value::Float(f)      => serde_json::json!(f),
            Value::Decimal(d)    => {
                // Numero JSON esatto se possibile, altrimenti stringa.
                serde_json::to_value(d).unwrap_or_else(|_| serde_json::json!(d.to_string()))
            }
            Value::String(s)     => serde_json::json!(s),
            Value::Date(s)       => serde_json::json!(s),
            Value::DateTime(s)   => serde_json::json!(s),
            Value::Object(v)     => v.clone(),
        }
    }
    /// Valore numerico come f64 quando serve un calcolo che non è
    /// ancora decimal-aware. Lossy sul Decimal — da sostituire con
    /// aritmetica esatta nei nodi di calcolo (Fase B).
    pub fn as_f64_lossy(&self) -> Option<f64> {
        use rust_decimal::prelude::ToPrimitive;
        match self {
            Value::Int(i)     => Some(*i as f64),
            Value::Float(f)   => Some(*f),
            Value::Decimal(d) => d.to_f64(),
            Value::String(s)  => s.parse().ok(),
            _                 => None,
        }
    }
}   // ← questa chiude impl Value


// ─── Row — una singola riga dati ─────────────────────────────────
//
// Newtype attorno a HashMap per poter aggiungere metodi
// senza inquinare l'API di HashMap.
// "Newtype" in Rust = struct con un solo campo — crea un tipo
// distinto con zero overhead a runtime.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Row(pub HashMap<String, Value>);

impl Row {
    pub fn new() -> Self {
        Row(HashMap::new())
    }

    pub fn get(&self, key: &str) -> Option<&Value> {
        self.0.get(key)
    }

    pub fn set(&mut self, key: String, value: Value) {
        self.0.insert(key, value);
    }

    pub fn from_json_object(obj: serde_json::Map<String, serde_json::Value>) -> Self {
        let map = obj.into_iter()
            .map(|(k, v)| (k, Value::from_json(v)))
            .collect();
        Row(map)
    }

    pub fn to_json_object(&self) -> serde_json::Value {
        let map: serde_json::Map<String, serde_json::Value> = self.0.iter()
            .map(|(k, v)| (k.clone(), v.to_json()))
            .collect();
        serde_json::Value::Object(map)
    }
    /// Come to_json_object ma con le chiavi ordinate: output stabile
    /// per log, serializer e file (HashMap ha ordine non deterministico).
    pub fn to_json_object_sorted(&self) -> serde_json::Value {
        let mut keys: Vec<&String> = self.0.keys().collect();
        keys.sort();
        let map: serde_json::Map<String, serde_json::Value> = keys.into_iter()
            .map(|k| (k.clone(), self.0.get(k).unwrap().to_json()))
            .collect();
        serde_json::Value::Object(map)
    }
    
    /// Proietta solo le colonne richieste (column pruning a runtime).
    /// Restituisce una nuova Row con solo i campi specificati.
    pub fn project(&self, columns: &[String]) -> Self {
        let map = columns.iter()
            .filter_map(|col| self.0.get(col).map(|v| (col.clone(), v.clone())))
            .collect();
        Row(map)
    }
     /// Itera su tutte le coppie (campo, valore)
    pub fn fields(&self) -> impl Iterator<Item = (&String, &Value)> {
        self.0.iter()
    }

    /// True se il campo esiste
    pub fn has(&self, key: &str) -> bool {
        self.0.contains_key(key)
    }

    /// Rimuove un campo, restituendo il valore se presente
    pub fn remove(&mut self, key: &str) -> Option<Value> {
        self.0.remove(key)
    }
}

// ─── Identificatori con newtype ───────────────────────────────────
//
// Invece di usare String ovunque (confonde run_id con node_id),
// creiamo tipi distinti a costo zero. Il compilatore impedisce
// di passare un RunId dove serve un NodeId.

// #[serde(transparent)] — serializza il newtype come se fosse
// direttamente il tipo interno (String), senza wrapper JSON.
// RunId("run_123") → "run_123"  (non { "0": "run_123" })
// Questo permette al frontend di usare semplici stringhe.

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct RunId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct LaneId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct NodeId(pub String);

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(transparent)]
pub struct EdgeId(pub String);

impl RunId  { pub fn new() -> Self { RunId(format!("run_{}", chrono::Utc::now().timestamp_millis())) } }
impl LaneId { pub fn as_str(&self) -> &str { &self.0 } }
impl NodeId { pub fn as_str(&self) -> &str { &self.0 } }
impl EdgeId { pub fn as_str(&self) -> &str { &self.0 } }

// ─── Plan — il piano di esecuzione inviato dal frontend ───────────
//
// Il frontend costruisce l'IR come oggi (in TypeScript), lo
// serializza a JSON e lo passa a engine_run(). Rust lo deserializza
// qui. NON duplichiamo la logica di costruzione dell'IR — resta
// tutta in TypeScript.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Plan {
    pub run_id:   RunId,
    pub lanes:    Vec<LanePlan>,
    pub bridges:  Vec<BridgePlan>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LanePlan {
    pub lane_id:   LaneId,
    pub label:     String,
    pub nodes:     Vec<NodePlan>,
    pub edges:     Vec<EdgePlan>,
    pub variables: HashMap<String, Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EdgePlan {
    pub edge_id:       EdgeId,
    pub source_node:   NodeId,
    pub source_handle: String,
    pub target_node:   NodeId,
    pub target_handle: String,
}

// ─── NodePlan — configurazione di un singolo nodo ────────────────
//
// `node_type` corrisponde ai tipi già definiti in NODE_DEFS
// (src/nodes/registry.ts). `config` è un blob JSON che Rust
// deserializza in modo specifico per ogni tipo di nodo.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NodePlan {
    pub node_id:   NodeId,
    pub node_type: String,
    pub label:     String,
    pub config:    serde_json::Value,  // deserializzato specificamente in ogni handler
    /// Spec completa dei tab Configurazione+Avanzate (contratto:
    /// docs/node-spec.md). Default Null per plan senza busta.
    #[serde(default)]
    pub spec:      serde_json::Value,
}

// ─── BridgePlan — coppia BridgeOut/BridgeIn ──────────────────────
//
// Il frontend dichiara esplicitamente quali bridge esistono
// e tra quale lane_out → lane_in. L'Engine crea un canale
// mpsc per ognuno prima di avviare le lane.

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgePlan {
    pub bridge_id:     String,
    pub source_lane:   LaneId,
    pub source_node:   NodeId,    // il nodo BridgeOut
    pub target_lane:   LaneId,
    pub target_node:   NodeId,    // il nodo BridgeIn
}

// ─── Stats — statistiche di esecuzione per nodo ───────────────────

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct NodeStats {
    pub rows_in:        u64,
    pub rows_out:       u64,
    pub rows_rejected:  u64,
    pub elapsed_ms:     u64,
    pub error:          Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RunStats {
    pub run_id:       RunId,
    pub node_stats:   HashMap<String, NodeStats>,  // node_id → stats
    pub total_ms:     u64,
    pub lanes_ok:     u32,
    pub lanes_failed: u32,
}