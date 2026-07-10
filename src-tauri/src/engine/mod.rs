// ─── src-tauri/src/engine/mod.rs (versione aggiornata Fase 1) ──────
//
// Aggiunge i sottomoduli types ed events, e un comando di validazione
// che verifica che il JSON del plan deserializzi correttamente.
//
// CONCETTI RUST NUOVI:
//
// 1. `pub mod types;` — Rust cerca il file `engine/types.rs` e lo
//    include come sottomodulo. È come fare `import * as types from './types'`
//    in TypeScript — dopo questa riga puoi usare `types::Row`,
//    `types::Plan`, ecc. Con `use crate::engine::types::*` puoi
//    abbreviare e scrivere solo `Row`, `Plan`, ecc.
//
// 2. `serde_json::from_str` — deserializza una stringa JSON in una
//    struct Rust. Equivalente di JSON.parse() in JS, ma con tipo
//    di destinazione esplicito: il compilatore sa già che il risultato
//    deve essere un `Plan` e controlla che tutti i campi ci siano.



// ─── src-tauri/src/engine/mod.rs (versione Fase 4) ─────────────────

pub mod types;
pub mod events;
pub mod bus;
pub mod executor;
pub mod bridge;
pub mod nodes;
pub mod expr;
pub mod monitor;
pub mod reporter;
pub mod spec;
pub mod pool;
pub mod txregistry;
pub mod expr_functions;
pub mod datasets;

use std::time::Instant;
use std::collections::HashMap;
use types::{Plan, RunId, RunStats, NodeStats};
use bus::{global_bus, push_event, PollResult};
use events::EngineEvent;
use executor::{RowSender, RowReceiver};

// ── Fase 0-2 (invariati) ─────────────────────────────────────────

#[tauri::command]
pub async fn engine_ping(delay_ms: u64) -> Result<String, String> {
    let start = Instant::now();
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    Ok(format!("pong dopo {}ms (richiesti {}ms)", start.elapsed().as_millis(), delay_ms))
}

#[tauri::command]
pub async fn engine_ping_parallel(id: u32, delay_ms: u64) -> Result<String, String> {
    let start = Instant::now();
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    Ok(format!("task #{id} completato dopo {}ms", start.elapsed().as_millis()))
}

#[tauri::command]
pub async fn engine_validate_plan(plan_json: String) -> Result<String, String> {
    let plan: Plan = serde_json::from_str(&plan_json)
        .map_err(|e| format!("Plan non valido: {}", e))?;
    Ok(format!(
        "Plan valido: run_id={}, {} lane, {} bridge",
        plan.run_id.0, plan.lanes.len(), plan.bridges.len(),
    ))
}

#[tauri::command]
pub async fn engine_poll_events(cursor: u64) -> Result<PollResult, String> {
    let bus = global_bus();
    let bus_guard = bus.lock().map_err(|e| format!("Bus lock error: {}", e))?;
    let (events, new_cursor) = bus_guard.drain_since(cursor);
    let bus_len = bus_guard.len();
    Ok(PollResult { events, cursor: new_cursor, bus_len })
}

#[tauri::command]
pub async fn engine_test_bus(event_count: u32, interval_ms: u64) -> Result<String, String> {
    tokio::spawn(async move {
        for i in 0..event_count {
            push_event(EngineEvent::NodeProgress {
                run_id: types::RunId("test_run".to_string()),
                lane_id: types::LaneId("lane_test".to_string()),
                node_id: types::NodeId("node_test".to_string()),
                rows_in: i as u64 * 100, rows_out: i as u64 * 95,
                rows_rejected: i as u64 * 5, throughput_rps: 1000.0,
            });
            tokio::time::sleep(std::time::Duration::from_millis(interval_ms)).await;
        }
        push_event(EngineEvent::RunCompleted {
            run_id: types::RunId("test_run".to_string()),
            stats: RunStats {
                run_id: types::RunId("test_run".to_string()),
                node_stats: HashMap::new(),
                total_ms: event_count as u64 * interval_ms,
                lanes_ok: 1, lanes_failed: 0,
            },
            elapsed_ms: event_count as u64 * interval_ms,
        });
    });
    Ok(format!("Test bus avviato: {} eventi ogni {}ms", event_count, interval_ms))
}

// ── Fase 3-4 — engine_run con multi-lane e bridge ─────────────────

#[tauri::command]
pub async fn engine_run(plan_json: String) -> Result<String, String> {
    let plan: Plan = serde_json::from_str(&plan_json)
        .map_err(|e| format!("Plan non valido: {}", e))?;

    let run_id     = plan.run_id.clone();
    let run_id_str = run_id.0.clone();
    reporter::start(&run_id_str);

    push_event(EngineEvent::RunStarted {
        run_id:     run_id.clone(),
        lane_count: plan.lanes.len() as u32,
        started_at: EngineEvent::timestamp_ms(),
    });

    tokio::spawn(async move {
        let start = Instant::now();
        // ── Sampler di memoria (Fase 9) ────────────────────────────
        // Thread OS dedicato, indipendente da WebKit: campiona la
        // memoria a cadenza fissa per tutta la durata del run e spinge
        // MemorySample nel bus. Scoped al run: parte qui, si ferma
        // sotto (stop() prima di emettere RunCompleted/RunFailed).
        // Il Drop di RunningSampler è la rete di sicurezza in caso di
        // panic di una lane.
        let mut sampler = monitor::MemorySampler::start(Some(run_id.clone()));


        // ── Crea i canali bridge PRIMA di avviare le lane ──────────
        // Ogni bridge genera un (Sender, Receiver) che viene distribuito
        // alla lane sorgente (sender) e alla lane destinazione (receiver).
        let mut bridge_registry = bridge::BridgeRegistry::new(&plan.bridges);

        // Per ogni lane, raccogli i bridge_sender e bridge_receiver
        // che appartengono ai suoi nodi bridge_out e bridge_in.
        // Lo facciamo pre-scansionando i nodi di ogni lane.
        //
        // bridge_senders_per_lane[lane_id] = HashMap<bridge_id, Sender>
        // bridge_receivers_per_lane[lane_id] = HashMap<bridge_id, Receiver>
        let mut senders_per_lane:   HashMap<String, HashMap<String, RowSender>>   = HashMap::new();
        let mut receivers_per_lane: HashMap<String, HashMap<String, RowReceiver>> = HashMap::new();

        for lane in &plan.lanes {
            let mut lane_senders   = HashMap::new();
            let mut lane_receivers = HashMap::new();

            for node in &lane.nodes {
                let bridge_id = node.config
                    .get("bridge_id")
                    .and_then(|v| v.as_str())
                    .map(|s| s.to_string());

                if let Some(bid) = bridge_id {
                    match node.node_type.as_str() {
                        "bridge_out" => {
                            if let Some(tx) = bridge_registry.take_sender(&bid) {
                                lane_senders.insert(bid, tx);
                            }
                        }
                        "bridge_in" => {
                            if let Some(rx) = bridge_registry.take_receiver(&bid) {
                                lane_receivers.insert(bid, rx);
                            }
                        }
                        _ => {}
                    }
                }
            }

            senders_per_lane.insert(lane.lane_id.0.clone(), lane_senders);
            receivers_per_lane.insert(lane.lane_id.0.clone(), lane_receivers);
        }

        // ── Avvia tutte le lane in parallelo ──────────────────────
        // Ogni lane è un tokio::spawn indipendente — girano tutte
        // contemporaneamente, collegate solo tramite i canali bridge.
        //
        // FuturesUnordered: raccoglie i JoinHandle di tutte le lane
        // e aspetta che completino tutte, nel primo ordine in cui finiscono.
        // Equivale a Promise.all() in JS ma per un numero dinamico di lane.

        use futures::stream::{FuturesUnordered, StreamExt};

        let mut lane_futures = FuturesUnordered::new();

        for lane in plan.lanes {
            let lane_id_str    = lane.lane_id.0.clone();
            let run_id_cl      = run_id.clone();
            let bridge_senders   = senders_per_lane.remove(&lane_id_str).unwrap_or_default();
            let bridge_receivers = receivers_per_lane.remove(&lane_id_str).unwrap_or_default();

            // Ogni lane → task Tokio separato = parallelismo reale
            let handle = tokio::spawn(async move {
                executor::execute_lane(run_id_cl, lane, bridge_senders, bridge_receivers).await
            });

            lane_futures.push(handle);
        }

        // Aspetta che tutte le lane completino
        let mut all_node_stats: HashMap<String, NodeStats> = HashMap::new();
        let mut lanes_ok     = 0u32;
        let mut lanes_failed = 0u32;
        let mut first_error: Option<String> = None;

        while let Some(result) = lane_futures.next().await {
            match result {
                Ok(Ok(stats)) => {
                    all_node_stats.extend(stats);
                    lanes_ok += 1;
                }
                Ok(Err(e)) => {
                    eprintln!("[engine] lane fallita: {}", e);
                    lanes_failed += 1;
                    if first_error.is_none() { first_error = Some(e); }
                }
                Err(e) => {
                    eprintln!("[engine] panic in lane: {}", e);
                    lanes_failed += 1;
                    if first_error.is_none() { first_error = Some(e.to_string()); }
                }
            }
        }

        let elapsed_ms = start.elapsed().as_millis() as u64;
        // Ferma il sampler: nessun MemorySample deve arrivare DOPO
        // l'evento terminale del run. stop() ritorna entro ~20ms.
        sampler.stop();

        if lanes_failed > 0 {
            push_event(EngineEvent::RunFailed {
                run_id,
                error: first_error.unwrap_or("Errore sconosciuto".to_string()),
                elapsed_ms,
            });
        } else {
            push_event(EngineEvent::RunCompleted {
                run_id: run_id.clone(),
                stats: RunStats {
                    run_id,
                    node_stats: all_node_stats,
                    total_ms: elapsed_ms,
                    lanes_ok,
                    lanes_failed,
                },
                elapsed_ms,
            });
        }
        reporter::stop();
    });

    Ok(run_id_str)
}