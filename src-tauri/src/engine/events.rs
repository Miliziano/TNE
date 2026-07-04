// ─── src-tauri/src/engine/events.rs ────────────────────────────────
//
// Tutti gli eventi che l'Engine emette verso il frontend.
// Questo è il "contratto" concordato nel piano — ogni cosa
// che succede nell'Engine durante l'esecuzione produce uno
// di questi eventi, che finisce nel bus e viene letto dal
// frontend via polling.
//
// CONCETTI RUST NUOVI:
//
// 1. `#[serde(tag = "type", content = "payload")]` — quando serializzi
//    un enum con serde, ogni variante diventa un JSON del tipo:
//    { "type": "NodeStarted", "payload": { ... } }
//    È lo stesso pattern che già usi in MonitoringBus.ts con
//    event.type === 'node_start' — ora è tipato lato Rust.
//
// 2. `u64` vs `i64` — Rust distingue tra interi con segno (i64,
//    può essere negativo) e senza segno (u64, sempre >= 0). I
//    contatori di righe non possono essere negativi → u64.
//    I timestamp Unix in ms stanno in u64 (> 0 per definizione).

use serde::{Deserialize, Serialize};
use crate::engine::types::{RunId, LaneId, NodeId, EdgeId, NodeStats, RunStats, Row};
use std::collections::HashMap;

// ─── EngineEvent — tutti gli eventi possibili ─────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "payload")]
pub enum EngineEvent {

    // ── Ciclo di vita del run ────────────────────────────────────

    RunStarted {
        run_id:     RunId,
        lane_count: u32,
        started_at: u64,   // timestamp Unix ms
    },

    RunCompleted {
        run_id:      RunId,
        stats:       RunStats,
        elapsed_ms:  u64,
    },

    RunFailed {
        run_id:    RunId,
        error:     String,
        elapsed_ms: u64,
    },

    // ── Ciclo di vita del nodo ───────────────────────────────────

    NodeStarted {
        run_id:  RunId,
        lane_id: LaneId,
        node_id: NodeId,
        label:   String,
    },

    /// Emesso ogni N righe O ogni T millisecondi (il primo che scatta).
    /// Non uno per riga — il frontend aggiorna i badge contatori
    /// su ogni evento di questo tipo.
    NodeProgress {
        run_id:          RunId,
        lane_id:         LaneId,
        node_id:         NodeId,
        rows_in:         u64,
        rows_out:        u64,
        rows_rejected:   u64,
        throughput_rps:  f64,   // righe/secondo correnti
    },

    NodeCompleted {
        run_id:  RunId,
        lane_id: LaneId,
        node_id: NodeId,
        stats:   NodeStats,
    },

    /// Conteggi per handle di uscita — nodi multi-output (filter,
    /// tmap, ...). Emesso a fine nodo, prima di NodeCompleted.
    NodeOutputStats {
        run_id:  RunId,
        lane_id: LaneId,
        node_id: NodeId,
        counts:  HashMap<String, u64>,   // handle id → righe emesse
    },
    
    NodeFailed {
        run_id:  RunId,
        lane_id: LaneId,
        node_id: NodeId,
        error:   String,
    },

    // ── Flusso su edge (per animazione canvas) ───────────────────

    /// "Su questo edge sono passate altre `delta` righe."
    /// Il frontend accumula i delta per aggiornare i badge
    /// sugli edge del canvas React Flow.
    EdgeFlow {
        run_id:  RunId,
        edge_id: EdgeId,
        delta:   u64,   // righe passate dall'ultimo evento EdgeFlow
    },

    // ── Campionamento dati (per ispezione interattiva) ────────────

    /// Ultime N righe transitate su un edge — aggiornato a buffer
    /// circolare dentro l'Engine, inviato quando l'utente clicca
    /// sull'edge (pull su richiesta, non push continuo).
    RowSample {
        run_id:  RunId,
        node_id: NodeId,
        edge_id: EdgeId,
        rows:    Vec<serde_json::Value>,  // Row serializzate
    },

    // ── Bridge (sincronismo tra lane) ────────────────────────────

    BridgeStarted {
        run_id:    RunId,
        bridge_id: String,
        from_lane: LaneId,
        to_lane:   LaneId,
    },

    BridgeCompleted {
        run_id:        RunId,
        bridge_id:     String,
        rows_transfer: u64,
    },

    // ── Sistema (memoria, connessioni) ───────────────────────────

    MemorySample {
        run_id:    Option<RunId>,  // None se monitor idle senza run attivo
        rss:       u64,
        rss_webkit: u64,
        total_pss: u64,
        timestamp: u64,
    },

    ConnectionOpened {
        run_id:      RunId,
        node_id:     NodeId,
        resource_id: String,
        conn_type:   String,  // "db_postgresql", "ftp", "smtp", ecc.
    },

    ConnectionClosed {
        run_id:      RunId,
        node_id:     NodeId,
        resource_id: String,
        query_count: u32,
        elapsed_ms:  u64,
    },

    ConnectionError {
        run_id:      RunId,
        node_id:     NodeId,
        resource_id: String,
        error:       String,
    },
}

impl EngineEvent {
    /// Timestamp Unix ms — usato dal bus per ordinare gli eventi.
    pub fn timestamp_ms() -> u64 {
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64
    }
}
