// ─── src-tauri/src/engine/executor.rs (v6 — wiring edge-based) ─────
//
// CAMBIO ARCHITETTURALE rispetto al v5:
// I canali NON sono più costruiti tra nodi adiacenti nell'ordine
// dell'array (catena lineare), ma seguono gli EDGES del piano.
//
//   - un canale mpsc per ogni coppia (target_node, target_handle)
//   - fan-out: se un handle di uscita ha più edges, un task dedicato
//     clona le righe su tutti i destinatari
//   - fan-in: più edges sullo stesso handle di ingresso condividono
//     lo stesso sender (mpsc::Sender è Clone)
//   - uscite richieste ma non collegate → drain (consuma e scarta),
//     così i nodi non si bloccano mai su un send
//   - input lookup del TMap: ora sono semplici edges
//     lookup_node.output → tmap.input_xyz. L'hack _tmap_lookup_for
//     e il riordino dei lookup in fondo all'array SPARISCONO.
//
// Richiede che il frontend popoli lanes[].edges (EdgePlan) invece
// di mandare edges: [] — vedi buildRustPlan in Toolbar.tsx.

use std::collections::HashMap;
use std::time::Instant;
use tokio::sync::mpsc;
use crate::engine::types::*;
use crate::engine::events::EngineEvent;
use crate::engine::bus::push_event;

const CHANNEL_BUFFER: usize = 1000;

pub type RowSender   = mpsc::Sender<Row>;
pub type RowReceiver = mpsc::Receiver<Row>;

// ─── NodeContext ──────────────────────────────────────────────────
#[derive(Clone)]
pub struct NodeContext {
    pub run_id:    RunId,
    pub lane_id:   LaneId,
    pub node_id:   NodeId,
    pub label:     String,
    pub config:    serde_json::Value,
    pub spec:      serde_json::Value,
    pub variables: HashMap<String, Value>,
    /// Registro connessioni per-lane (design L1). Condiviso tra tutti
    /// i nodi della lane; i nodi DB chiedono qui il pool della risorsa.
    pub lane_resources: std::sync::Arc<super::pool::LaneResources>,
    pub lane_txns: std::sync::Arc<super::txregistry::LaneTransactions>,
      /// Registro dei dataset materializzati, per-lane. Condiviso tra chi
    /// pubblica (materialize) e chi legge (window, aggregate, pivot,
    /// explode, join).
    pub lane_datasets:  std::sync::Arc<super::datasets::LaneDatasets>,
    pub lane_errors:    std::sync::Arc<super::errors::LaneErrors>,
}

impl NodeContext {
    /// Policy di retry "prima operazione", se la modalità `onError` la prevede
    /// (retry_handler / retry_catch). Ritorna (tentativi, attesa_secondi).
    /// `advanced` è già nel piano: il lowering copia l'intero data.config nel
    /// NodePlan. retryCount/retryDelaySec sono STRINGHE nel config (tipo TS
    /// `string`) → si leggono con as_str().parse(). None = niente retry.
    pub fn retry_policy(&self) -> Option<(u32, u64)> {
        let adv = self.config.get("advanced")?;
        let mode = adv.get("onError").and_then(|v| v.as_str()).unwrap_or("handler");
        if mode != "retry_handler" && mode != "retry_catch" {
            return None;
        }
        let count = adv.get("retryCount")
            .and_then(|v| v.as_str())
            .and_then(|s| s.trim().parse::<u32>().ok())
            .unwrap_or(0);
        let delay = adv.get("retryDelaySec")
            .and_then(|v| v.as_str())
            .and_then(|s| s.trim().parse::<u64>().ok())
            .unwrap_or(5);
        Some((count, delay))
    }
    pub fn emit_progress(&self, rows_in: u64, rows_out: u64, rows_rejected: u64, rps: f64) {
        push_event(EngineEvent::NodeProgress {
            run_id: self.run_id.clone(), lane_id: self.lane_id.clone(),
            node_id: self.node_id.clone(), rows_in, rows_out, rows_rejected,
            throughput_rps: rps,
        });
    }
    pub fn emit_started(&self) {
        push_event(EngineEvent::NodeStarted {
            run_id: self.run_id.clone(), lane_id: self.lane_id.clone(),
            node_id: self.node_id.clone(), label: self.label.clone(),
        });
    }
    pub fn emit_completed(&self, stats: NodeStats) {
        push_event(EngineEvent::NodeCompleted {
            run_id: self.run_id.clone(), lane_id: self.lane_id.clone(),
            node_id: self.node_id.clone(), stats,
        });
    }

    #[allow(clippy::too_many_arguments)]
    pub fn emit_log(&self, node_label: &str, level: &str, row_num: u64, message: String, target: &str) {
        push_event(EngineEvent::NodeLog {
            run_id:     self.run_id.clone(),
            lane_id:    self.lane_id.clone(),
            node_id:    self.node_id.clone(),
            node_label: node_label.to_string(),
            level:      level.to_string(),
            row_num,
            message,
            target:     target.to_string(),
        });
    }

    pub fn emit_failed(&self, error: String) {
        push_event(EngineEvent::NodeFailed {
            run_id: self.run_id.clone(), lane_id: self.lane_id.clone(),
            node_id: self.node_id.clone(), error,
        });
    }
    pub fn emit_output_stats(&self, counts: std::collections::HashMap<String, u64>) {
        push_event(EngineEvent::NodeOutputStats {
            run_id: self.run_id.clone(), lane_id: self.lane_id.clone(),
            node_id: self.node_id.clone(), counts,
        });
    }
    pub fn emit_connection_opened(&self, resource_id: &str, conn_type: &str) {
        push_event(EngineEvent::ConnectionOpened {
            run_id: self.run_id.clone(), node_id: self.node_id.clone(),
            resource_id: resource_id.to_string(), conn_type: conn_type.to_string(),
        });
    }
    pub fn emit_connection_closed(&self, resource_id: &str, query_count: u32, elapsed_ms: u64) {
        push_event(EngineEvent::ConnectionClosed {
            run_id: self.run_id.clone(), node_id: self.node_id.clone(),
            resource_id: resource_id.to_string(), query_count, elapsed_ms,
        });
    }
    pub fn emit_connection_error(&self, resource_id: &str, error: String) {
        push_event(EngineEvent::ConnectionError {
            run_id: self.run_id.clone(), node_id: self.node_id.clone(),
            resource_id: resource_id.to_string(), error,
        });
    }
}

// ─── Helpers config TMap ──────────────────────────────────────────

fn tmap_lookup_input_ids(config: &serde_json::Value) -> Vec<String> {
    config.get("lookups")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter()
            .filter_map(|l| l.get("input_id")?.as_str().map(String::from))
            .collect())
        .unwrap_or_default()
}

fn tmap_output_ids(config: &serde_json::Value) -> Vec<String> {
    config.get("outputs")
        .and_then(|v| v.as_array())
        .map(|arr| arr.iter()
            .filter_map(|o| o.get("output_id")?.as_str().map(String::from))
            .collect())
        .unwrap_or_default()
}

// ─── Helpers canali ───────────────────────────────────────────────

/// Sender verso il nulla: consuma e scarta. Serve per le uscite
/// obbligatorie dei nodi (es. filter richiede tx) quando nessun
/// edge le consuma — senza, il nodo si bloccherebbe sul send o
/// fallirebbe per tx mancante.
pub(crate) fn make_drain() -> RowSender {
    let (tx, mut rx) = mpsc::channel::<Row>(CHANNEL_BUFFER);
    tokio::spawn(async move {
        while rx.recv().await.is_some() {}
    });
    tx
}

/// Receiver già chiuso: recv() restituisce subito None. Serve per
/// gli input lookup del TMap non collegati (lookup vuoto).
fn closed_receiver() -> RowReceiver {
    let (_tx, rx) = mpsc::channel::<Row>(1);
    rx
}

/// Estrae l'input "principale" di un nodo semplice: preferisce
/// l'handle 'input', altrimenti l'unico rimasto.
/// I tipi che il motore **non implementa ancora**.
///
/// UNICA fonte: l'arm dei passthrough qui sotto si guida da questa lista
/// con una match guard (`t if is_stub(t)`), invece di riscriverla come
/// elenco di pattern. Se fosse scritta due volte divergerebbe in
/// silenzio — è la malattia che abbiamo passato la fase porte a curare.
///
/// Chi sta qui NON fa il suo lavoro: inoltra le righe e basta. Per questo
/// il nodo si segnala come **errore** e non come completato — v. l'arm.
pub const NOT_IMPLEMENTED: &[&str] = &[
    // NB `data_quality` NON è qui: ha un arm dedicato (:632) che chiama
    // data_quality::run — è implementato. Stava nella vecchia lista per un
    // commento ormai falso.
    "script", "watchdog",
    "source_http", "source_ftp", "source_mqtt",
    "source_activemq", "source_kafka",
    "sink_kafka", "sink_ftp", "sink_mqtt",
    "sink_activemq", "sink_http",
    "http_request", "webhook_responder", "report_generator",
    "error_handler",
];

/// true se il motore non ha ancora un'implementazione per questo tipo.
pub fn is_stub(node_type: &str) -> bool {
    NOT_IMPLEMENTED.contains(&node_type)
}

fn take_single_input(inputs: &mut HashMap<String, RowReceiver>) -> Option<RowReceiver> {
    if let Some(rx) = inputs.remove("input") { return Some(rx); }
    let key = inputs.keys().next().cloned()?;
    inputs.remove(&key)
}

/// Estrae l'uscita "principale" di un nodo semplice: preferisce
/// l'handle 'output', poi il primo handle non-reject/non-catch.
pub(crate) fn take_primary_output(outputs: &mut HashMap<String, RowSender>) -> Option<RowSender> {
    if let Some(tx) = outputs.remove("output") { return Some(tx); }
    let key = outputs.keys()
        .find(|k| k.as_str() != "reject" && k.as_str() != "catch")
        .cloned()
        .or_else(|| outputs.keys().next().cloned())?;
    outputs.remove(&key)
}

// ─── execute_lane ─────────────────────────────────────────────────

pub async fn execute_lane(
    run_id:               RunId,
    lane_plan:            LanePlan,
    mut bridge_senders:   HashMap<String, RowSender>,
    mut bridge_receivers: HashMap<String, RowReceiver>,
) -> Result<HashMap<String, NodeStats>, String> {

    let lane_id    = lane_plan.lane_id.clone();
    let variables  = lane_plan.variables.clone();

    // Registro transazioni della lane (L3 native): gruppi dichiarati +
    // conteggio membri (nodi con quel transactionId).
    let declared_txns: Vec<(String, String, String, u64, usize)> = lane_plan.transactions.iter()
        .map(|t| {
            let members = lane_plan.nodes.iter()
                .filter(|n| n.spec.get("props")
                    .and_then(|p| p.get("transactionId"))
                    .and_then(|v| v.as_str())
                    .map(|s| s == t.id).unwrap_or(false))
                .count();
            (t.id.clone(), t.mode.clone(), t.on_error.clone(), t.timeout, members)
        })
        .collect();
    let lane_txns = super::txregistry::LaneTransactions::new(declared_txns, run_id.0.clone());


    let nodes      = lane_plan.nodes;
    let plan_edges = lane_plan.edges;

    // Registro connessioni della lane (L1). Vive per tutta la lane;
    // chiuso in ogni ramo di uscita (invariante 2).
    // Dimensionamento pool per risorsa (auto): conta i nodi che usano
    // ogni resource_id; +1 per la connessione esclusiva se la risorsa
    // ha una transazione. Elimina il "pool timed out" e garantisce
    // l'isolamento dentro/fuori (la tx ha la sua connessione, i nodi
    // liberi le altre).
    let mut sizing: std::collections::HashMap<String, u32> = std::collections::HashMap::new();
    let mut tx_resources: std::collections::HashSet<String> = std::collections::HashSet::new();
    for n in &nodes {
        // resource_id del nodo (dalla spec/config)
        if let Some(rid) = n.spec.get("props").and_then(|p| p.get("resourceId")).and_then(|v| v.as_str()) {
            if !rid.is_empty() {
                *sizing.entry(rid.to_string()).or_insert(0) += 1;
                // se il nodo è in una transazione, la sua risorsa ha bisogno
                // della connessione esclusiva del gruppo
                if let Some(txid) = n.spec.get("props").and_then(|p| p.get("transactionId")).and_then(|v| v.as_str()) {
                    if !txid.is_empty() { tx_resources.insert(rid.to_string()); }
                }
            }
        }
    }
    // +1 connessione per la transazione esclusiva, + margine di sicurezza.
    for rid in &tx_resources {
        *sizing.entry(rid.clone()).or_insert(0) += 1;
    }
    // margine: almeno 2 connessioni per risorsa, per sicurezza.
    for v in sizing.values_mut() { *v = (*v).max(2) + 1; }

    let lane_resources = super::pool::LaneResources::new(sizing);
    
    // Registro dataset: uno slot Pending per ogni dataset dichiarato.
    let declared_datasets: Vec<String> = lane_plan.datasets.iter()
        .map(|d| d.name.clone())
        .collect();
    let lane_datasets = super::datasets::LaneDatasets::new(&declared_datasets);
    let lane_errors = super::errors::LaneErrors::new();


    if nodes.is_empty() {
        return Ok(HashMap::new());
    }

    // ── 1. Un canale per ogni (target_node, target_handle) ────────
    // Se più edges puntano allo STESSO handle di ingresso (fan-in),
    // condividono il canale: ogni sorgente riceve un clone del tx.
    // node_id → (handle → rx)
    let mut input_rx: HashMap<String, HashMap<String, RowReceiver>> = HashMap::new();
    // (target_node, target_handle) → tx del canale
    let mut target_tx: HashMap<(String, String), RowSender> = HashMap::new();

    for e in &plan_edges {
        let key = (e.target_node.0.clone(), e.target_handle.clone());
        if !target_tx.contains_key(&key) {
            let (tx, rx) = mpsc::channel::<Row>(CHANNEL_BUFFER);
            input_rx.entry(key.0.clone()).or_default().insert(key.1.clone(), rx);
            target_tx.insert(key, tx);
        }
    }

    // ── 2. Sender per ogni (source_node, source_handle) ───────────
    // Raggruppa gli edges in uscita dallo stesso handle.
    let mut out_groups: HashMap<(String, String), Vec<RowSender>> = HashMap::new();
    for e in &plan_edges {
        let skey = (e.source_node.0.clone(), e.source_handle.clone());
        let tkey = (e.target_node.0.clone(), e.target_handle.clone());
        if let Some(tx) = target_tx.get(&tkey) {
            out_groups.entry(skey).or_default().push(tx.clone());
        }
    }
    // IMPORTANTE: rilascia i tx originali. Restano vivi solo i clone
    // nelle mani dei nodi sorgente — quando il sorgente termina, il
    // canale si chiude e il target vede la fine dello stream.
    drop(target_tx);

    // node_id → (handle → tx), con fan-out dove serve
    let mut output_tx: HashMap<String, HashMap<String, RowSender>> = HashMap::new();
    for ((node, handle), mut senders) in out_groups {
        let tx = if senders.len() == 1 {
            senders.pop().unwrap()
        } else {
            // Fan-out: un task clona ogni riga su tutti i destinatari
            // (l'originale va all'ultimo, senza clone superfluo).
            // Un destinatario chiuso viene ignorato: gli altri
            // continuano a ricevere.
            let (fan_tx, mut fan_rx) = mpsc::channel::<Row>(CHANNEL_BUFFER);
            tokio::spawn(async move {
                while let Some(row) = fan_rx.recv().await {
                    let n = senders.len();
                    for tx in senders.iter().take(n - 1) {
                        let _ = tx.send(row.clone()).await;
                    }
                    if let Some(last) = senders.last() {
                        let _ = last.send(row).await;
                    }
                }
            });
            fan_tx
        };
        output_tx.entry(node).or_default().insert(handle, tx);
    }

    // ── 3. Spawn dei nodi ─────────────────────────────────────────
    let mut handles = Vec::new();
    // node_id → (tipo, va-all-error-handler): salvato qui perché al loop di
    // raccolta esiti node_plan è già consumato. Serve a costruire la riga
    // `_error_*` per i nodi in modalità handler che falliscono.
    let mut node_meta: std::collections::HashMap<String, (String, bool)> = std::collections::HashMap::new();

    for node_plan in nodes.into_iter() {
        let node_id_str = node_plan.node_id.0.clone();
        let node_type   = node_plan.node_type.clone();

        let ctx = NodeContext {
            run_id:    run_id.clone(),
            lane_id:   lane_id.clone(),
            node_id:   node_plan.node_id.clone(),
            label:     node_plan.label.clone(),
            config:    node_plan.config.clone(),
            spec:      node_plan.spec.clone(),
            variables: variables.clone(),
            lane_resources: lane_resources.clone(),
            lane_txns: lane_txns.clone(),
            lane_datasets:  lane_datasets.clone(),
            lane_errors:    lane_errors.clone(),
        };

        let inputs  = input_rx.remove(&node_id_str).unwrap_or_default();
        let outputs = output_tx.remove(&node_id_str).unwrap_or_default();

        let bridge_id = node_plan.config
            .get("bridge_id")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());
        let bridge_tx = bridge_id.as_deref().and_then(|id| bridge_senders.remove(id));
        let bridge_rx = bridge_id.as_deref().and_then(|id| bridge_receivers.remove(id));

        eprintln!("[executor] spawn nodo={} type={} inputs={:?} outputs={:?}",
            node_id_str, node_type,
            inputs.keys().collect::<Vec<_>>(),
            outputs.keys().collect::<Vec<_>>());

        node_meta.insert(
            node_id_str.clone(),
            (node_type.clone(), super::errors::goes_to_handler(&node_plan.config)),
        );

        let handle = tokio::spawn(async move {
            run_node(ctx, node_type, inputs, outputs, bridge_tx, bridge_rx).await
        });

        handles.push((node_id_str, handle));
    }

    // ── 4. Attendi completamento ──────────────────────────────────
    // Raccoglie l'esito SENZA return immediato: la chiusura delle
    // connessioni (invariante 2) deve avvenire in OGNI caso, quindi
    // prima si determina l'esito, poi si chiude, poi si ritorna.
    let mut stats_map = HashMap::new();
    let mut lane_result: Result<(), String> = Ok(());

    for (node_id_str, handle) in handles {
        match handle.await {
            Ok(Ok(stats)) => {
                eprintln!("[executor] nodo {} completato ok", node_id_str);
                stats_map.insert(node_id_str, stats);
            }
            Ok(Err(e)) => {
                eprintln!("[executor] nodo {} fallito: {}", node_id_str, e);
                // Emette lo stato terminale al monitor: senza questo il
                // nodo resta 'running' (giallo) perché nessun nodo emette
                // emit_failed sul proprio percorso d'errore.
                push_event(crate::engine::events::EngineEvent::NodeFailed {
                    run_id:  run_id.clone(),
                    lane_id: lane_id.clone(),
                    node_id: crate::engine::types::NodeId(node_id_str.clone()),
                    error:   e.clone(),
                });
                // Canale controllo: se il nodo delega all'error_handler (non
                // cattura da sé), deposita la riga `_error_*`. L'error_handler
                // la emetterà su error_out a fine lane (fetta 2b).
                if let Some((ntype, is_handler)) = node_meta.get(&node_id_str) {
                    if *is_handler {
                        let row = super::errors::build_error_row(&node_id_str, ntype, &e);
                        lane_errors.push(row).await;
                    }
                }
                if lane_result.is_ok() {
                    lane_result = Err(format!("Nodo {} fallito: {}", node_id_str, e));
                }
            }
            Err(e) => {
                eprintln!("[executor] panic nodo {}: {}", node_id_str, e);
                push_event(crate::engine::events::EngineEvent::NodeFailed {
                    run_id:  run_id.clone(),
                    lane_id: lane_id.clone(),
                    node_id: crate::engine::types::NodeId(node_id_str.clone()),
                    error:   format!("panic: {}", e),
                });
                if lane_result.is_ok() {
                    lane_result = Err(format!("Panic nel nodo {}: {}", node_id_str, e));
                }
            }
        }
    }
    // Finalizza le transazioni di gruppo in base all'esito COMPLETO
    // della lane (source e non-membri inclusi): commit solo se tutto ok.
    lane_txns.finalize_with_outcome(lane_result.is_ok()).await;
    lane_resources.close_all().await;
  

    // Chiusura garantita delle connessioni della lane — in ogni caso.
    lane_resources.close_all().await;

    lane_result.map(|_| stats_map)
}
// ─── run_node ─────────────────────────────────────────────────────
//
// Riceve mappe handle → canale invece di Option singoli:
//   inputs:  handle di ingresso → receiver
//   outputs: handle di uscita   → sender (già con fan-out applicato)
//
// I nodi semplici prendono input/output "principale" con gli helper;
// il TMap ricostruisce i suoi vettori nell'ordine della config;
// union e join (multi-input) hanno arm dedicati; i tipi non ancora
// implementati (v. NOT_IMPLEMENTED) concatenano gli ingressi e si
// segnalano come errore, così il Monitor non li dà per riusciti.

async fn run_node(
    ctx:         NodeContext,
    node_type:   String,
    mut inputs:  HashMap<String, RowReceiver>,
    mut outputs: HashMap<String, RowSender>,
    bridge_tx:   Option<RowSender>,
    bridge_rx:   Option<RowReceiver>,
) -> Result<NodeStats, String> {

    ctx.emit_started();

    match node_type.as_str() {

        "source_file" => {
            // `inputs` non veniva MAI toccata: il receiver restava nella
            // mappa, veniva droppato a fine funzione, il canale si chiudeva
            // e le righe del nodo a monte sparivano in silenzio. Ora si
            // prende — R8. V. nodes/source_input.rs.
            let rx = take_single_input(&mut inputs);
            let tx = take_primary_output(&mut outputs);
            super::nodes::source_file::run(ctx, rx, tx).await
        }

        "source_db" => {
            let rx = take_single_input(&mut inputs);
            let tx = take_primary_output(&mut outputs);
            super::nodes::source_db::run(ctx, rx, tx).await
        }

        "sink_file" => {
            let rx = take_single_input(&mut inputs)
                .ok_or_else(|| format!("sink_file {} richiede un input collegato", ctx.node_id.0))?;
            // signal/replay: il sink può emettere a valle DOPO la scrittura
            let tx = take_primary_output(&mut outputs);
            super::nodes::sink_file::run(ctx, rx, tx).await
        }

        "sink_db" => {
            let rx = take_single_input(&mut inputs)
                .ok_or_else(|| format!("sink_db {} richiede un input collegato", ctx.node_id.0))?;
            // Output opzionale: presente solo in master-detail (righe
            // arricchite inoltrate); None per sink terminale.
            let tx = take_primary_output(&mut outputs);
            super::nodes::sink_db::run(ctx, rx, tx).await
        }

        "bridge_out" => {
            let rx  = take_single_input(&mut inputs)
                .ok_or_else(|| format!("bridge_out {} richiede un input collegato", ctx.node_id.0))?;
            let btx = bridge_tx.ok_or_else(|| format!("bridge_out {}: bridge_id non trovato", ctx.node_id.0))?;
            super::bridge::run_bridge_out(ctx, rx, btx).await
        }

        "bridge_in" => {
            let brx = bridge_rx.ok_or_else(|| format!("bridge_in {}: bridge_id non trovato", ctx.node_id.0))?;
            let tx  = take_primary_output(&mut outputs);
            super::bridge::run_bridge_in(ctx, brx, tx).await
        }

        "tmap" => {
            // tmap è migrato alla spec: la config vive in ctx.spec["config"]
            // (v. tmap.rs). Gli helper di routing leggono di lì gli id di
            // lookup/output per smistare i canali.
            let tmap_cfg = ctx.spec.get("config").cloned().unwrap_or(serde_json::Value::Null);

            // Lookup: PRIMA di estrarre il main, rimuovi gli input
            // lookup per id (ordine della config = ordine del Vec
            // che tmap::run si aspetta). Lookup non collegato →
            // receiver chiuso → lookup vuoto.
            let lookup_ids = tmap_lookup_input_ids(&tmap_cfg);
            let mut lookup_rxs: Vec<RowReceiver> = Vec::with_capacity(lookup_ids.len());
            for id in &lookup_ids {
                lookup_rxs.push(inputs.remove(id).unwrap_or_else(closed_receiver));
            }

            let main_rx = inputs.remove("input_main")
                .or_else(|| take_single_input(&mut inputs))
                .ok_or_else(|| format!("tmap {} richiede input main collegato", ctx.node_id.0))?;

            // Uscite: nell'ordine della config (main per primo).
            // Uscita non collegata → drain, così il TMap non si
            // blocca mai scrivendo su un canale senza consumatore.
            let output_ids = tmap_output_ids(&tmap_cfg);
            let mut output_txs: Vec<RowSender> = Vec::with_capacity(output_ids.len().max(1));
            for id in &output_ids {
                output_txs.push(outputs.remove(id).unwrap_or_else(make_drain));
            }
            if output_txs.is_empty() {
                output_txs.push(take_primary_output(&mut outputs).unwrap_or_else(make_drain));
            }

            super::nodes::tmap::run(ctx, main_rx, lookup_rxs, output_txs).await
        }

        // ── Nodi core — dispatch reale ─────────────────────────────

        "log" => {
            match take_single_input(&mut inputs) {
                Some(rx) => {
                    let tx = take_primary_output(&mut outputs);
                    super::nodes::log::run(ctx, rx, tx).await
                }
                None => {
                    let stats = NodeStats::default();
                    ctx.emit_completed(stats.clone());
                    Ok(stats)
                }
            }
        }
        "join" => {
            // Il join legge input_left e input_right da canali separati: passa
            // l'intera mappa inputs. Multi-uscita output+reject → mappa outputs
            // intera, il nodo estrae le due porte (come filter/explode).
            super::nodes::join::run(ctx, inputs, outputs).await
        }
       

        "transform" | "transform_fields" => {
            let rx = take_single_input(&mut inputs)
                .ok_or_else(|| format!("transform {} richiede un input collegato", ctx.node_id.0))?;
            let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);
            super::nodes::transform::run(ctx, rx, tx).await
        }

        "aggregate" => {
            // Input opzionale: con dataSource='materialize' il nodo può non
            // avere archi, e si sblocca quando il dataset è pubblicato.
            let rx = take_single_input(&mut inputs);
            let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);
            super::nodes::aggregate::run(ctx, rx, tx).await
        }


        
        "explode" => {
            // Input opzionale: con source='materialize' il nodo può non avere
            // archi, e si sblocca quando il dataset è pubblicato.
            // Multi-uscita: output + reject → passa l'intera mappa (come filter).
            let rx = take_single_input(&mut inputs);
            super::nodes::explode::run(ctx, rx, outputs).await
        }


        "materialize" => {
            let rx = take_single_input(&mut inputs)
                .ok_or_else(|| format!("materialize {} richiede un input collegato", ctx.node_id.0))?;
            // Multi-uscita: output + reject (righe troncate) → mappa intera.
            super::nodes::materialize::run(ctx, rx, outputs).await
        }

        "json_serializer" => {
            // Assemblatore documenti: riceve TUTTI gli handle di
            // ingresso e gli output 'output'/'reject'
            super::nodes::json_serializer::run(ctx, inputs, outputs).await
        }

        "json_parser" => {
            let rx = take_single_input(&mut inputs);
            // Multi-output: un handle per flow + reject. Passa l'intera
            // mappa outputs (come i serializer).
            super::nodes::json_parser::run(ctx, rx, outputs).await
        }

        "filter" => {
            let rx = take_single_input(&mut inputs)
                .ok_or_else(|| format!("filter {} richiede un input collegato", ctx.node_id.0))?;
            // First-match multi-uscita: riceve tutti gli handle (cond_* + reject)
            super::nodes::filter::run(ctx, rx, outputs).await
        }

        "xml_serializer" => {
            // Assemblatore documenti: tutti gli handle di ingresso + output/reject
            super::nodes::xml_serializer::run(ctx, inputs, outputs).await
        }

        "xml_parser" => {
            let rx = take_single_input(&mut inputs);
            // Multi-output: un handle per flow + reject. Passa l'intera
            // mappa outputs (come json_parser e i serializer).
            super::nodes::xml_parser::run(ctx, rx, outputs).await
        }

        "pivot" => {
            // Input opzionale: con dataSource='materialize' il nodo può non
            // avere archi, e si sblocca quando il dataset è pubblicato.
            let rx = take_single_input(&mut inputs);
            let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);
            super::nodes::pivot::run(ctx, rx, tx).await
        }

        "data_quality" => {
            let rx = take_single_input(&mut inputs)
                .ok_or_else(|| format!("data_quality {} richiede un input collegato", ctx.node_id.0))?;
            let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);
            super::nodes::data_quality::run(ctx, rx, tx).await
        }


        "window" => {
            // Input OPZIONALE.
            //   caso 1: buffer_signal → window   (la riga è il trigger)
            //   caso 2: nessun arco               (si sblocca col get())
            //   caso 3: un flusso qualunque       (bufferizza da sé)
            let rx = take_single_input(&mut inputs);   // ← era .ok_or_else(...)
            let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);
            super::nodes::window::run(ctx, rx, tx).await
        }
        "union" => {
            let tx = take_primary_output(&mut outputs)
                .ok_or_else(|| format!("union {} richiede un output collegato", ctx.node_id.0))?;

            // L'ordine degli input determina l'ordine di `concat`.
            // Non si può usare l'ordine del HashMap (non deterministico):
            // si ricostruisce da config.union_inputs, che il pannello
            // popola nell'ordine di collegamento.
            //   input_main → primo
            //   union_input_<id> → nell'ordine dichiarato
            let mut ordered: Vec<(String, RowReceiver)> = Vec::new();

            if let Some(rx) = inputs.remove("input_main") {
                ordered.push(("input_main".to_string(), rx));
            }

            if let Some(list) = ctx.config.get("union_inputs").and_then(|v| v.as_array()) {
                for item in list {
                    if let Some(id) = item.get("id").and_then(|v| v.as_str()) {
                        if let Some(rx) = inputs.remove(id) {
                            ordered.push((id.to_string(), rx));
                        }
                    }
                }
            }

            // Handle collegati ma non dichiarati in union_inputs: li accodiamo
            // in ordine alfabetico, per determinismo.
            let mut leftover: Vec<String> = inputs.keys().cloned().collect();
            leftover.sort();
            for h in leftover {
                if let Some(rx) = inputs.remove(&h) {
                    ordered.push((h, rx));
                }
            }

            if ordered.is_empty() {
                return Err(format!("union {}: nessun flusso collegato", ctx.node_id.0));
            }

            super::nodes::union::run(ctx, ordered, tx).await
        }

        // ── Nodi NON ANCORA IMPLEMENTATI ──────────────────────────
        //
        // L'elenco stava qui, come pattern; ora si guida da
        // NOT_IMPLEMENTED (una fonte, non due). Deve restare DOPO gli arm
        // veri: quelli hanno la precedenza, e questo raccoglie il resto.
        //
        // Cosa facevano: concatenavano gli ingressi sull'uscita primaria e
        // poi dichiaravano `error: None` + emit_completed → nel Monitor il
        // nodo diventava VERDE. Un `source_kafka` senza ingressi drenava
        // zero righe, ne emetteva zero, e diceva che era andato tutto bene:
        // una sorgente che non legge niente e non lo dice. Un `sink_kafka`
        // inoltrava le righe a valle senza scrivere su Kafka, e sembrava
        // riuscito.
        //
        // L'inoltro RESTA — toglierlo romperebbe di più — ma il nodo ora si
        // segnala come ERRORE, così il Monitor smette di mentire.
        // Contratto §2: un comportamento dichiarato e non implementato è
        // peggio di uno assente, perché il primo si scopre in produzione.
        t if is_stub(t) => {
            let start = Instant::now();
            let tx = take_primary_output(&mut outputs);
            let mut rows_in  = 0u64;
            let mut rows_out = 0u64;

            // Ordina gli handle per nome per un ordine deterministico
            let mut handle_names: Vec<String> = inputs.keys().cloned().collect();
            handle_names.sort();

            for h in handle_names {
                if let Some(mut rx) = inputs.remove(&h) {
                    while let Some(row) = rx.recv().await {
                        rows_in += 1;
                        if let Some(tx) = &tx {
                            if tx.send(row).await.is_ok() { rows_out += 1; }
                        }
                    }
                }
            }

            // ⚠️ `error` VALORIZZATO, non None. Il frontend, su NodeCompleted,
            // fa `status: stats.error ? 'error' : 'done'` (Toolbar.tsx:167):
            // così il nodo diventa ROSSO col messaggio, ma il Run NON viene
            // abortito e le righe già inoltrate continuano a valle — meglio
            // non rompere più di quanto già non funzioni. Diverso da
            // emit_failed, che segnerebbe il nodo come fallito a monte.
            let stats = NodeStats {
                rows_in, rows_out, rows_rejected: 0,
                elapsed_ms: start.elapsed().as_millis() as u64,
                error: Some(format!(
                    "Il nodo '{}' non è ancora implementato nel motore: le righe \
                     vengono inoltrate senza essere elaborate. Il risultato NON è \
                     affidabile.",
                    node_type
                )),
            };
            // OBBLIGATORIO anche qui — senza, il frontend non chiude mai
            // pulse e contatori del nodo.
            ctx.emit_completed(stats.clone());
            Ok(stats)
        }

        other => Err(format!("Tipo nodo non supportato: {}", other))
    }
}