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
pub mod errors;
pub mod abort;
pub mod completion;
pub mod text_encoding;
pub mod field_mapping;
pub mod spec;
pub mod pool;
pub mod txregistry;
pub mod expr_functions;
pub mod datasets;
pub mod watch_subs;

use std::time::Instant;
use std::collections::HashMap;
use types::{Plan, RunId, RunStats, NodeStats};
use bus::{global_bus, push_event, PollResult};
use events::EngineEvent;

// ── Fase 0-2 (invariati) ─────────────────────────────────────────

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn engine_ping(delay_ms: u64) -> Result<String, String> {
    let start = Instant::now();
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    Ok(format!("pong after {}ms (requested {}ms)", start.elapsed().as_millis(), delay_ms))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn engine_ping_parallel(id: u32, delay_ms: u64) -> Result<String, String> {
    let start = Instant::now();
    tokio::time::sleep(std::time::Duration::from_millis(delay_ms)).await;
    Ok(format!("task #{id} completed after {}ms", start.elapsed().as_millis()))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn engine_validate_plan(plan_json: String) -> Result<String, String> {
    let plan: Plan = serde_json::from_str(&plan_json)
        .map_err(|e| format!("Invalid plan: {}", e))?;
    Ok(format!(
        "Valid plan: run_id={}, {} lanes, {} bridges",
        plan.run_id.0, plan.lanes.len(), plan.bridges.len(),
    ))
}

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn engine_poll_events(cursor: u64) -> Result<PollResult, String> {
    let bus = global_bus();
    let bus_guard = bus.lock().map_err(|e| format!("Bus lock error: {}", e))?;
    let (events, new_cursor) = bus_guard.drain_since(cursor);
    let bus_len = bus_guard.len();
    Ok(PollResult { events, cursor: new_cursor, bus_len })
}

#[cfg_attr(feature = "desktop", tauri::command)]
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
    Ok(format!("Test bus started: {} events every {}ms", event_count, interval_ms))
}

// ── Fase 3-4 — engine_run con multi-lane e bridge ─────────────────

#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn engine_run(plan_json: String) -> Result<String, String> {
    let plan: Plan = serde_json::from_str(&plan_json)
        .map_err(|e| format!("Invalid plan: {}", e))?;

    let run_id     = plan.run_id.clone();
    let run_id_str = run_id.0.clone();
    reporter::start(&run_id_str);

    // Service mode: token di cancellazione del run + registro globale, così
    // `stop_run` (e in futuro il nodo stop) possono fermare i nodi-servizio.
    let cancel = tokio_util::sync::CancellationToken::new();
    run_cancels().lock().unwrap().insert(run_id_str.clone(), cancel.clone());

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
        // bridge_senders_per_lane[lane_id] = HashMap<bridge_id, BridgeOutEnds>
        // bridge_receivers_per_lane[lane_id] = HashMap<bridge_id, BridgeInEnds>
        // (canale dati + canale di controllo appaiati — v. bridge.rs)
        let mut senders_per_lane:   HashMap<String, HashMap<String, bridge::BridgeOutEnds>> = HashMap::new();
        let mut receivers_per_lane: HashMap<String, HashMap<String, bridge::BridgeInEnds>>  = HashMap::new();

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
            let cancel_cl      = cancel.clone();
            let bridge_senders   = senders_per_lane.remove(&lane_id_str).unwrap_or_default();
            let bridge_receivers = receivers_per_lane.remove(&lane_id_str).unwrap_or_default();

            // Ogni lane → task Tokio separato = parallelismo reale
            let handle = tokio::spawn(async move {
                match continuous_watcher(&lane) {
                    // ── WATCH CONTINUO — LOOP DI SESSIONE (fetta 3) ──────
                    // La lane si ri-esegue una volta per gruppo: ogni
                    // `execute_lane` è una sessione transazionale completa
                    // (apre → elabora → commit/rollback → chiude). La
                    // sottoscrizione + coda stanno SOPRA la lane (watch_subs),
                    // così non si perdono eventi fra una sessione e l'altra.
                    Some(Err(e)) => Err(e),
                    Some(Ok((node_id, dir, recursive, debounce_ms))) => {
                        let key = watch_subs::watch_key(&run_id_cl.0, &node_id);
                        let mut rx = match watch_subs::start_watch(key.clone(), &dir, recursive) {
                            Ok(rx) => rx,
                            Err(e) => return Err(e),
                        };
                        // P363: il debounce del pannello (prima fisso a 300 ms).
                        let debounce = std::time::Duration::from_millis(debounce_ms);
                        let mut last: Result<HashMap<String, NodeStats>, String> = Ok(HashMap::new());
                        let mut session: u32 = 0;
                        // P110: label del watcher per mostrarlo "in ascolto" fra le sessioni.
                        let watcher_label = lane.nodes.iter()
                            .find(|n| n.node_id.0 == node_id)
                            .map(|n| n.label.clone())
                            .unwrap_or_else(|| node_id.clone());
                        loop {
                            // P110 — UNIFORMA CONTINUO↔ONE-SHOT: prima di bloccarsi in attesa,
                            // il dir_watcher si dichiara "in ascolto" (NodeStarted → 'running').
                            // Così nel Monitor/canvas compare SUBITO e il suo edge d'uscita è
                            // animato mentre aspetta il prossimo evento, come in one-shot dove il
                            // watcher È running bloccato DENTRO il nodo. La sessione poi ri-emette
                            // started/completed del nodo (il frontend deduplica per node_id); a
                            // fine run la "scopa" di RunCompleted / lo stop riportano il nodo a
                            // done/idle. Un solo evento per giro (poi il select! blocca).
                            push_event(EngineEvent::NodeStarted {
                                run_id:  run_id_cl.clone(),
                                lane_id: lane.lane_id.clone(),
                                node_id: types::NodeId(node_id.clone()),
                                label:   watcher_label.clone(),
                            });
                            // Attendi il PRIMO evento del prossimo gruppo, o il cancel.
                            let first = tokio::select! {
                                _  = cancel_cl.cancelled() => None,
                                ev = rx.recv()             => ev,
                            };
                            let first = match first { Some(e) => e, None => break };
                            // Raccogli il burst entro una finestra fissa di debounce.
                            let mut group = vec![first];
                            let deadline = tokio::time::Instant::now() + debounce;
                            loop {
                                tokio::select! {
                                    _  = tokio::time::sleep_until(deadline) => break,
                                    ev = rx.recv() => match ev {
                                        Some(e) => group.push(e),
                                        None    => break,
                                    },
                                }
                            }
                            // Nuova SESSIONE: marca per la UI (indice + n. eventi
                            // del gruppo) prima di ri-eseguire la lane.
                            session += 1;
                            let group_size = group.len() as u32;
                            push_event(EngineEvent::LaneSessionStarted {
                                run_id:  run_id_cl.clone(),
                                lane_id: lane.lane_id.clone(),
                                node_id: types::NodeId(node_id.clone()),
                                session,
                                group_size,
                            });
                            // Deposita il gruppo e ri-esegui la lane (una sessione).
                            watch_subs::put_group(&key, group);
                            last = executor::execute_lane(
                                run_id_cl.clone(), lane.clone(),
                                HashMap::new(), HashMap::new(), cancel_cl.clone(),
                            ).await;
                            if cancel_cl.is_cancelled() || last.is_err() { break; }
                        }
                        watch_subs::stop_watch(&key);
                        nodes::dir_watcher::forget_seen(&key);
                        last
                    }
                    // ── FTP/SFTP in ascolto continuo (P364): stesso modello a sessioni ──
                    None => match continuous_ftp(&lane) {
                        Some(Err(e)) => Err(e),
                        Some(Ok((node_id, spec_json))) => {
                            ftp_sessions(run_id_cl, lane, cancel_cl, node_id, spec_json).await
                        }
                        // ── lane normale: una sola esecuzione (come sempre) ──
                        None => {
                            executor::execute_lane(run_id_cl, lane, bridge_senders, bridge_receivers, cancel_cl).await
                        }
                    },
                }
            });

            lane_futures.push(handle);
        }

        // Aspetta che tutte le lane completino
        let mut all_node_stats: HashMap<String, NodeStats> = HashMap::new();
        let mut lanes_ok     = 0u32;
        let mut lanes_failed = 0u32;
        // TUTTI gli errori di lane, non solo il primo: v. la nota alla
        // composizione di RunFailed, sotto.
        let mut lane_errors: Vec<String> = Vec::new();

        while let Some(result) = lane_futures.next().await {
            match result {
                Ok(Ok(stats)) => {
                    all_node_stats.extend(stats);
                    lanes_ok += 1;
                }
                Ok(Err(e)) => {
                    eprintln!("[engine] lane fallita: {}", e);
                    lanes_failed += 1;
                    lane_errors.push(e);
                }
                Err(e) => {
                    eprintln!("[engine] panic in lane: {}", e);
                    lanes_failed += 1;
                    lane_errors.push(format!("panic: {}", e));
                }
            }
        }

        let elapsed_ms = start.elapsed().as_millis() as u64;
        // Ferma il sampler: nessun MemorySample deve arrivare DOPO
        // l'evento terminale del run. stop() ritorna entro ~20ms.
        // Service mode: fine run → deregistra il token.
        run_cancels().lock().unwrap().remove(&run_id.0);
        // dir_watcher continuo: chiudi le sottoscrizioni watch di questo run
        // (drop dei watcher = dissottoscrizione), così non restano orfane.
        watch_subs::stop_run_watches(&run_id.0);
        sampler.stop();

        if lanes_failed > 0 {
            // Con più lane fallite l'ordine di ARRIVO non dice nulla sulla
            // causa: `FuturesUnordered` restituisce chi finisce prima, e una
            // lane fermata dal fallimento di un'altra finisce quasi sempre
            // per prima. Riportare solo la prima significava indicare il
            // SINTOMO nascondendo la causa — il bridge_in di valle al posto
            // del source che è morto. Si riportano tutte: ordinarle per
            // "chi ha cominciato" richiederebbe di riconoscere i fallimenti
            // derivati, che è un'altra questione (l'errore di nodo
            // strutturato).
            let error = match lane_errors.len() {
                0 => "Unknown error".to_string(),
                1 => lane_errors.join(""),
                n => format!("{} lanes failed — {}", n, lane_errors.join("  |  ")),
            };
            push_event(EngineEvent::RunFailed {
                run_id,
                error,
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

// ─── dir_watcher continuo (fetta 3): riconoscimento della lane ────
// Se la lane ha un dir_watcher in modalità watch CONTINUO (mode='watch' +
// submode='continuo'), ne ritorna (node_id, directory, recursive). Il continuo
// cambia lo scheduling: la lane va RI-ESEGUITA per gruppo (loop di sessione).
// v1: single-lane, directory statica (niente interpolazione di variabili).
/// Il dir_watcher in ascolto continuo della lane, se c'è: (nodo, cartella,
/// ricorsivo, debounce ms). P363: la cartella può venire da una variabile di
/// lane (come nel one-shot); dal flusso no — nel continuo non c'è una riga
/// in ingresso prima della sessione.
fn continuous_watcher(lane: &types::LanePlan) -> Option<Result<(String, String, bool, u64), String>> {
    for node in &lane.nodes {
        if node.node_type != "dir_watcher" { continue; }
        let props = node.spec.get("props");
        let s = |k: &str| props.and_then(|p| p.get(k)).and_then(|v| v.as_str()).unwrap_or("");
        if s("mode") == "watch" && s("submode") == "continuo" {
            let err = |m: String| Some(Err(format!("dir_watcher {}: {}", node.node_id.0, m)));
            if s("pathSource") == "flow" {
                return err("in continuous listening the directory cannot come from the incoming flow: use a static path or a lane variable".into());
            }
            let spec = match spec::Spec::from_ctx(&node.spec) { Ok(sp) => sp, Err(e) => return err(e) };
            let dir = match nodes::dir_watcher::resolve_directory(&spec, &lane.variables, None) {
                Ok(d) => d,
                Err(e) => return err(e),
            };
            let debounce = s("debounceMs").trim().parse::<u64>().unwrap_or(300).max(50);
            return Some(Ok((node.node_id.0.clone(), dir, s("recursive") == "true", debounce)));
        }
    }
    None
}

/// Il source_ftp in ascolto continuo della lane, se c'è: (nodo, spec).
fn continuous_ftp(lane: &types::LanePlan) -> Option<Result<(String, serde_json::Value), String>> {
    for node in &lane.nodes {
        if node.node_type != "source_ftp" { continue; }
        let props = node.spec.get("props");
        let s = |k: &str| props.and_then(|p| p.get(k)).and_then(|v| v.as_str()).unwrap_or("");
        if s("fetchMode") == "continuous" && s("outputMode") != "list_files" {
            let spec = match spec::Spec::from_ctx(&node.spec) {
                Ok(sp) => sp,
                Err(e) => return Some(Err(format!("source_ftp {}: {}", node.node_id.0, e))),
            };
            if !spec.has_resource() {
                return Some(Err(format!("source_ftp {}: no FTP resource configured (select a connection in the node panel)", node.node_id.0)));
            }
            return Some(Ok((node.node_id.0.clone(), node.spec.clone())));
        }
    }
    None
}

/// P364 — LOOP DI SESSIONE dell'FTP continuo. Ogni `pollInterval` secondi
/// chiede al nodo i file PRONTI (stabili, non ancora nel file di stato); se
/// ce ne sono, li deposita e ri-esegue la lane (una sessione = un commit).
/// Un controllo fallito (rete, server giù) è un avviso: si riprova al giro
/// dopo. Una sessione fallita chiude il run, come nel dir_watcher continuo.
async fn ftp_sessions(
    run_id:    types::RunId,
    lane:      types::LanePlan,
    cancel:    tokio_util::sync::CancellationToken,
    node_id:   String,
    spec_json: serde_json::Value,
) -> Result<HashMap<String, NodeStats>, String> {
    let label = lane.nodes.iter().find(|n| n.node_id.0 == node_id)
        .map(|n| n.label.clone()).unwrap_or_else(|| node_id.clone());
    let key = watch_subs::watch_key(&run_id.0, &node_id);
    let log = |level: &str, message: String| push_event(EngineEvent::NodeLog {
        run_id: run_id.clone(), lane_id: lane.lane_id.clone(), node_id: types::NodeId(node_id.clone()),
        node_label: label.clone(), level: level.to_string(), row_num: 0, message, target: "panel".into(),
    });
    let spec = spec::Spec::from_ctx(&spec_json)?;
    let poll = nodes::source_ftp::poll_interval(&spec);
    log("info", format!("FTP: listening (checking every {} s; a file is read once it has not changed between two checks)", poll.as_secs()));

    let mut pending: HashMap<String, (u64, Option<String>)> = HashMap::new();
    let mut last: Result<HashMap<String, NodeStats>, String> = Ok(HashMap::new());
    let mut session: u32 = 0;
    let mut first = true;
    loop {
        // Come il dir_watcher continuo (P110): il nodo si mostra "in ascolto".
        push_event(EngineEvent::NodeStarted {
            run_id: run_id.clone(), lane_id: lane.lane_id.clone(),
            node_id: types::NodeId(node_id.clone()), label: label.clone(),
        });
        if !first {
            tokio::select! {
                _ = cancel.cancelled() => break,
                _ = tokio::time::sleep(poll) => {}
            }
        }
        first = false;
        let ready = tokio::select! {
            _ = cancel.cancelled() => break,
            r = nodes::source_ftp::poll_ready(&spec, &node_id, &mut pending) => r,
        };
        let ready = match ready {
            Ok(r) => r,
            Err(e) => { log("warn", format!("FTP: check failed, retrying in {} s — {}", poll.as_secs(), e)); continue }
        };
        if ready.is_empty() { continue }
        session += 1;
        push_event(EngineEvent::LaneSessionStarted {
            run_id: run_id.clone(), lane_id: lane.lane_id.clone(),
            node_id: types::NodeId(node_id.clone()), session, group_size: ready.len() as u32,
        });
        nodes::source_ftp::put_group(&key, ready);
        last = executor::execute_lane(run_id.clone(), lane.clone(), HashMap::new(), HashMap::new(), cancel.clone()).await;
        if cancel.is_cancelled() || last.is_err() { break; }
    }
    last
}

// ─── Service mode: registro dei token di cancellazione per-run ────
fn run_cancels() -> &'static std::sync::Mutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>> {
    static RUN_CANCELS: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, tokio_util::sync::CancellationToken>>> = std::sync::OnceLock::new();
    RUN_CANCELS.get_or_init(|| std::sync::Mutex::new(std::collections::HashMap::new()))
}

/// Ferma un run in corso: scatena il token di cancellazione. I nodi-servizio
/// (watch fase 2, webhook) lo attendono in `select!` per uscire puliti.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn stop_run(run_id: String) -> Result<(), String> {
    let tok = run_cancels().lock().unwrap().get(&run_id).cloned();
    match tok {
        Some(t) => { t.cancel(); Ok(()) }
        None    => Err(format!("run '{}' not found (already finished?)", run_id)),
    }
}

// ── Anteprima di un nodo in ISOLAMENTO (P237) ─────────────────────
//
// Principio del progetto: a ESEGUIRE è sempre e solo il motore. Perciò
// l'anteprima non "simula" nulla nello studio: riceve lo spec COMPILATO
// del nodo (identico a quello che l'esecutore legge in un run) e alcune
// righe di mock, e le fa elaborare al nodo VERO. Nessuna I/O, nessuna
// lane: i registri per-lane sono vuoti, `var()` è una mappa mock. Vale
// solo per i nodi PURI (transform ora; tmap più avanti), che non toccano
// risorse/txn/dataset — è ciò che li rende adatti all'anteprima.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn engine_preview_node(
    node_type:      String,
    spec_json:      String,
    rows_json:      String,
    variables_json: Option<String>,
    limit:          Option<u32>,
) -> Result<String, String> {
    use crate::engine::executor::{NodeContext, RowSender, RowReceiver};
    use crate::engine::types::{Row, Value, LaneId, NodeId};

    // 1) righe di mock → Vec<Row> (stessa conversione dei nodi sorgente)
    let raw: Vec<serde_json::Value> = serde_json::from_str(&rows_json)
        .map_err(|e| format!("invalid test rows: {}", e))?;
    let mut rows_in: Vec<Row> = Vec::with_capacity(raw.len());
    for (i, v) in raw.into_iter().enumerate() {
        let obj = v.as_object()
            .ok_or_else(|| format!("row {} is not a JSON object", i + 1))?;
        let mut map: HashMap<String, Value> = HashMap::new();
        for (k, val) in obj {
            map.insert(k.clone(), Value::from_json(val.clone()));
        }
        rows_in.push(Row(map));
    }

    // 2) variabili di lane mock, per var()
    let variables: HashMap<String, Value> = match variables_json {
        Some(s) if !s.trim().is_empty() => {
            let obj: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&s)
                .map_err(|e| format!("invalid test variables: {}", e))?;
            obj.into_iter().map(|(k, v)| (k, Value::from_json(v))).collect()
        }
        _ => HashMap::new(),
    };

    // 3) spec compilato del nodo (stessa forma dell'esecutore)
    let spec: serde_json::Value = serde_json::from_str(&spec_json)
        .map_err(|e| format!("invalid node spec: {}", e))?;
    let config = spec.get("config").cloned().unwrap_or(serde_json::Value::Null);

    // 4) contesto ISOLATO: registri vuoti, nessun error handler
    let ctx = NodeContext {
        run_id:  RunId("preview".to_string()),
        lane_id: LaneId("preview".to_string()),
        node_id: NodeId("preview".to_string()),
        label:   "preview".to_string(),
        config,
        spec,
        variables,
        lane_resources: crate::engine::pool::LaneResources::new(HashMap::new()),
        lane_txns:      crate::engine::txregistry::LaneTransactions::new(Vec::new(), "preview".to_string()),
        lane_datasets:  crate::engine::datasets::LaneDatasets::new(&[]),
        lane_abort:     crate::engine::abort::LaneAbort::new(),
        cancel:         tokio_util::sync::CancellationToken::new(),
        err_collector:  None,
        lane_done:      crate::engine::completion::LaneCompletion::empty(),
    };

    // 5) due canali; il nodo è eseguito dal MOTORE VERO
    let (tx_in,  rx_in):      (RowSender, RowReceiver) = tokio::sync::mpsc::channel::<Row>(1024);
    let (tx_out, mut rx_out): (RowSender, RowReceiver) = tokio::sync::mpsc::channel::<Row>(1024);

    // Alimentatore: invia le righe e CHIUDE il canale (barriera R7 = "ho finito").
    tokio::spawn(async move {
        for r in rows_in { let _ = tx_in.send(r).await; }
    });

    // Il nodo, secondo il tipo. Solo nodi PURI in anteprima.
    let node = match node_type.as_str() {
        "transform" => tokio::spawn(async move {
            crate::engine::nodes::transform::run(ctx, rx_in, tx_out).await
        }),
        // Sorgente PURA (solo I/O su file, nessuna lane): niente ingresso, il
        // nodo PRODUCE le righe. Il campione è limitato da `limit`.
        "source_file" => {
            drop(rx_in);
            tokio::spawn(async move {
                crate::engine::nodes::source_file::run(ctx, None, Some(tx_out)).await
            })
        }
        other => return Err(format!("preview not supported for node '{}'", other)),
    };

    // Drena l'uscita fermandosi al tetto di righe: una sorgente ne produce
    // molte, si prende il campione e si interrompe il nodo.
    let cap = limit.unwrap_or(100).clamp(1, 10_000) as usize;
    let mut out: Vec<Row> = Vec::new();
    let mut capped = false;
    while let Some(r) = rx_out.recv().await {
        out.push(r);
        if out.len() >= cap { capped = true; break; }
    }

    if capped {
        node.abort();   // basta il campione: interrompe la sorgente
    } else {
        match node.await {
            Ok(Ok(_stats))             => {}
            Ok(Err(e))                 => return Err(e),
            Err(e) if e.is_cancelled() => {}
            Err(e)                     => return Err(format!("preview interrupted: {}", e)),
        }
    }

    serde_json::to_string(&out).map_err(|e| format!("output serialization: {}", e))
}
