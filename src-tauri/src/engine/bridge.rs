// ─── src-tauri/src/engine/bridge.rs ────────────────────────────────
//
// Gestione dei Bridge: coppie BridgeOut/BridgeIn che collegano lane
// diverse tramite canali mpsc Tokio.
//
// Il frontend dichiara i bridge nel Plan. Prima di avviare le lane,
// l'Engine crea un canale mpsc per ogni bridge e distribuisce i
// sender/receiver alle lane interessate.
//
// CONCETTI RUST NUOVI:
//
// 1. `HashMap` con chiave String — usiamo il bridge_id come chiave
//    per trovare rapidamente il canale giusto quando una lane
//    cerca il proprio BridgeOut o BridgeIn.
//
// 2. `Option::take()` — consuma il valore dall'Option lasciando None.
//    Fondamentale qui perché un Sender/Receiver può essere dato a
//    una sola lane — non si può clonare un Receiver.

use std::collections::HashMap;
use tokio::sync::{mpsc, oneshot};
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver};

// ─── I due capi di un bridge ──────────────────────────────────────
//
// Oltre al canale DATI ogni bridge porta un canale di CONTROLLO: un
// `oneshot` con cui il BridgeOut dichiara "sono arrivato in fondo alla
// consegna". Serve perché finora il BridgeIn non sapeva distinguere due
// situazioni molto diverse — la lane sorgente ha finito, oppure è stata
// uccisa a metà — e in entrambi i casi proseguiva tranquilla su dati
// potenzialmente parziali.
//
// 🔑 PERCHÉ UN SEGNALE "POSITIVO" E NON UN MESSAGGIO D'ERRORE: un task
// abortito da Tokio NON esegue altro codice. La lane morente non ha modo
// di avvisare nessuno. L'unico segnale affidabile è quindi l'ASSENZA
// della conferma: se il oneshot si chiude senza aver mandato nulla, il
// mittente è morto prima di finire.
//
// Sender e receiver viaggiano appaiati in queste struct invece che come
// parametri separati: il numero di argomenti resta lo stesso e diventa
// impossibile consegnare il canale di un bridge col segnale di un altro.

pub struct BridgeOutEnds {
    pub rows: RowSender,
    // Consumato con `send(())` a consegna conclusa.
    pub done: oneshot::Sender<()>,
    // P358: conferma di RICEZIONE dal BridgeIn (tutte le righe prese e
    // passate a valle). La aspetta il BridgeOut in "wait for ack".
    pub ack:  oneshot::Receiver<()>,
}

pub struct BridgeInEnds {
    pub rows: RowReceiver,
    // `await` → Ok = consegna conclusa, Err = mittente morto prima.
    pub done: oneshot::Receiver<()>,
    pub ack:  oneshot::Sender<()>,
}

// Buffer del canale bridge — più grande dei canali interni alla lane
// perché le lane possono avere velocità diverse e vogliamo evitare
// stalli: se lane A produce più veloce di quanto lane B consuma,
// il buffer assorbe le differenze temporanee.
const BRIDGE_CHANNEL_BUFFER: usize = 5000;

// ─── BridgeRegistry ───────────────────────────────────────────────
// Creato dall'Engine prima di avviare le lane.
// Ogni lane "preleva" il proprio sender/receiver da qui.

pub struct BridgeRegistry {
    // bridge_id → capi di uscita (per la lane che ha il BridgeOut)
    senders:   HashMap<String, Option<BridgeOutEnds>>,
    // bridge_id → capi di ingresso (per la lane che ha il BridgeIn)
    receivers: HashMap<String, Option<BridgeInEnds>>,
}

impl BridgeRegistry {
    /// Crea tutti i canali bridge dichiarati nel Plan.
    /// Chiamato una sola volta prima di avviare le lane.
    pub fn new(bridges: &[BridgePlan]) -> Self {
        let mut senders   = HashMap::new();
        let mut receivers = HashMap::new();

        for bridge in bridges {
            let (tx, rx)               = mpsc::channel::<Row>(BRIDGE_CHANNEL_BUFFER);
            let (done_tx, done_rx)     = oneshot::channel::<()>();
            let (ack_tx, ack_rx)       = oneshot::channel::<()>();
            senders.insert(bridge.bridge_id.clone(),
                           Some(BridgeOutEnds { rows: tx, done: done_tx, ack: ack_rx }));
            receivers.insert(bridge.bridge_id.clone(),
                             Some(BridgeInEnds { rows: rx, done: done_rx, ack: ack_tx }));
        }

        BridgeRegistry { senders, receivers }
    }

    /// Preleva il Sender per un BridgeOut.
    /// take() consuma il valore — se chiamato due volte restituisce None
    /// (ogni bridge ha esattamente un sender, assegnato a una sola lane).
    pub fn take_sender(&mut self, bridge_id: &str) -> Option<BridgeOutEnds> {
        self.senders.get_mut(bridge_id)?.take()
    }

    /// Preleva il Receiver per un BridgeIn.
    pub fn take_receiver(&mut self, bridge_id: &str) -> Option<BridgeInEnds> {
        self.receivers.get_mut(bridge_id)?.take()
    }
}

// ─── BridgeOut node ───────────────────────────────────────────────
// Riceve righe dal canale della lane e le manda nel canale bridge
// verso un'altra lane. Si comporta come un sink per la lane corrente.

pub async fn run_bridge_out(
    ctx:    crate::engine::executor::NodeContext,
    mut rx: RowReceiver,
    ends:   BridgeOutEnds,
    out:    Option<RowSender>,
) -> Result<NodeStats, String> {
    use std::time::Instant;
    use crate::engine::bus::push_event;
    use crate::engine::events::EngineEvent;

    let BridgeOutEnds { rows: bridge_tx, done, ack } = ends;
    // Opzioni (P358), dalle props del nodo:
    //   outputMode none | passthrough (le stesse righe anche a valle, nella
    //              lane) | signal (una riga di stato a consegna fatta)
    //   syncMode   fire_and_forget | wait_for_ack (il nodo finisce solo
    //              quando il BridgeIn ha preso tutte le righe)
    let prop = |k: &str, d: &str| ctx.spec.get("props").and_then(|p| p.get(k))
        .and_then(|v| v.as_str()).filter(|s| !s.is_empty()).unwrap_or(d).to_string();
    let output_mode = prop("outputMode", "none");
    let wait_ack    = prop("syncMode", "fire_and_forget") == "wait_for_ack";
    let channel     = prop("channelName", &ctx.node_id.0);

    ctx.emit_started();

    let (mut rows_in, mut rows_out) = (0u64, 0u64);
    let start = Instant::now();
    let passthrough = output_mode == "passthrough";

    while let Some(row) = rx.recv().await {
        rows_in += 1;
        if passthrough {
            if let Some(o) = &out {
                let _ = o.send(row.clone()).await;
            }
        }
        if bridge_tx.send(row).await.is_err() {
            // Lane destinazione non disponibile — fermati
            break;
        }
        rows_out += 1;

        if rows_in % 500 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
        }
    }
    // Consegna conclusa: lo si DICHIARA prima di chiudere il canale dati.
    // Il BridgeIn a valle vedrà quindi la conferma già arrivata quando il
    // canale si chiude. Se questo task venisse abortito, `done` verrebbe
    // droppato senza aver mandato nulla — ed è così che la lane di valle
    // capisce. `let _`: se la lane destinazione ha già concluso non c'è
    // nessuno ad ascoltare, e non è un problema di chi consegna.
    let _ = done.send(());
    drop(bridge_tx);   // fine dello stream: il BridgeIn esce dal suo ciclo

    // Wait for ack: si aspetta che il BridgeIn abbia preso tutto. Se la
    // sua lane muore prima, il mittente della conferma sparisce → errore.
    let mut status = "sent";
    if wait_ack {
        if ack.await.is_err() {
            return Err(format!(
                "channel '{}': {} rows sent, but the receiving lane did not confirm the delivery", channel, rows_out));
        }
        status = "delivered";
    }

    push_event(EngineEvent::BridgeCompleted {
        run_id:        ctx.run_id.clone(),
        bridge_id:     ctx.node_id.0.clone(),
        rows_transfer: rows_out,
    });

    if output_mode == "signal" {
        if let Some(o) = &out {
            let mut sig = Row::new();
            sig.set("channel".into(),   Value::String(channel.clone()));
            sig.set("rows_sent".into(), Value::Int(rows_out as i64));
            sig.set("status".into(),    Value::String(status.into()));
            sig.set("sent_at".into(),   Value::DateTime(chrono::Local::now().to_rfc3339()));
            let _ = o.send(sig).await;
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── BridgeIn node ────────────────────────────────────────────────
// Si comporta come una source per la lane destinazione:
// legge dal canale bridge e invia righe nel canale della lane.
// La lane non sa che le righe vengono da un'altra lane —
// per lei è una source come un'altra.

pub async fn run_bridge_in(
    ctx:   crate::engine::executor::NodeContext,
    ends:  BridgeInEnds,
    tx:    Option<RowSender>,
) -> Result<NodeStats, String> {
    use std::time::Instant;

    let BridgeInEnds { rows: mut bridge_rx, done, ack } = ends;
    // Opzioni (P358), dalla config che il builder calcola per questo nodo:
    //   all_at_once  le righe si passano a valle solo quando la consegna è
    //                COMPLETA e confermata: se la lane sorgente si
    //                interrompe, a valle non arriva niente (non dati a metà)
    //   timeout_sec  attesa massima della prima riga (o della fine del
    //                flusso), 0 = nessuna
    let all_at_once = ctx.config.get("all_at_once").and_then(|v| v.as_bool()).unwrap_or(false);
    let timeout_sec = ctx.config.get("timeout_sec").and_then(|v| v.as_u64()).unwrap_or(0);

    ctx.emit_started();

    let tx = match tx {
        Some(t) => t,
        None    => {
            // Nessun nodo a valle: si scarica comunque il canale (il
            // BridgeOut non resta bloccato) e si conferma.
            while bridge_rx.recv().await.is_some() {}
            let _ = ack.send(());
            return Ok(NodeStats::default());
        }
    };

    let (mut rows_in, mut rows_out) = (0u64, 0u64);
    let start = Instant::now();
    let mut held: Vec<Row> = Vec::new();

    // Prima riga, con il timeout se configurato.
    let first = if timeout_sec > 0 {
        match tokio::time::timeout(std::time::Duration::from_secs(timeout_sec), bridge_rx.recv()).await {
            Ok(r)  => r,
            Err(_) => return Err(format!(
                "no data from the source lane within {} s (Wait timeout)", timeout_sec)),
        }
    } else {
        bridge_rx.recv().await
    };

    // Aspetta righe dal bridge — si sospende automaticamente se la lane
    // sorgente è più lenta. Nessun polling attivo.
    let mut next = first;
    while let Some(row) = next {
        rows_in += 1;
        if all_at_once {
            held.push(row);
        } else {
            if tx.send(row).await.is_err() { break; }
            rows_out += 1;
        }
        if rows_in % 500 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
        }
        next = bridge_rx.recv().await;
    }

    // ── Il canale dati è chiuso: ma PERCHÉ? ───────────────────────
    // La lane sorgente ha consegnato tutto, oppure è morta a metà: lo dice
    // la conferma `done`, già arrivata (il BridgeOut la manda PRIMA di
    // chiudere il canale), quindi questa attesa non blocca.
    if done.await.is_err() {
        // Errore di NODO: va all'error handler di QUESTA lane. Marcare
        // «critico» il bridge_in è ciò che ferma anche la lane di valle.
        return Err(if all_at_once {
            format!("source lane interrupted after {} rows: delivery incomplete, nothing was passed downstream (all at once)", rows_in)
        } else {
            format!("source lane interrupted after {} rows: the bridge delivery is incomplete", rows_in)
        });
    }

    for row in held {
        if tx.send(row).await.is_err() { break; }
        rows_out += 1;
    }
    // Ricevuto e passato a valle: conferma al BridgeOut (wait for ack).
    let _ = ack.send(());

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::engine::executor::NodeContext;

    fn ctx(config: serde_json::Value) -> NodeContext {
        NodeContext {
            run_id: RunId("t".into()), lane_id: LaneId("B".into()), node_id: NodeId("bi".into()),
            label: "bi".into(), config, spec: serde_json::json!({"props": {}, "config": {}}),
            variables: HashMap::new(),
            lane_resources: crate::engine::pool::LaneResources::new(HashMap::new()),
            lane_txns: crate::engine::txregistry::LaneTransactions::new(Vec::new(), "t".into()),
            lane_datasets: crate::engine::datasets::LaneDatasets::new(&[]),
            lane_abort: crate::engine::abort::LaneAbort::new(),
            cancel: tokio_util::sync::CancellationToken::new(),
            err_collector: None,
            lane_done: crate::engine::completion::LaneCompletion::empty(),
        }
    }
    fn plan() -> Vec<BridgePlan> {
        vec![BridgePlan { bridge_id: "ch".into(), source_lane: LaneId("A".into()), source_node: NodeId("bo".into()),
                          target_lane: LaneId("B".into()), target_node: NodeId("bi".into()) }]
    }
    fn row(n: i64) -> Row { let mut r = Row::new(); r.set("id".into(), Value::Int(n)); r }

    /// Tutto insieme: se la lane sorgente muore a metà, a valle non passa niente.
    #[tokio::test]
    async fn all_at_once_non_passa_dati_parziali() {
        let mut reg = BridgeRegistry::new(&plan());
        let out = reg.take_sender("ch").unwrap();
        let inn = reg.take_receiver("ch").unwrap();
        let (tx, mut rx) = mpsc::channel::<Row>(10);
        let h = tokio::spawn(run_bridge_in(ctx(serde_json::json!({"all_at_once": true})), inn, Some(tx)));
        out.rows.send(row(1)).await.unwrap();
        out.rows.send(row(2)).await.unwrap();
        drop(out);   // mittente "morto": niente done
        let res = h.await.unwrap();
        assert!(res.unwrap_err().contains("nothing was passed downstream"));
        assert!(rx.recv().await.is_none(), "nessuna riga deve arrivare a valle");
    }

    /// Man mano: le righe già arrivate passano, ma il nodo fallisce.
    #[tokio::test]
    async fn stream_interrotto_fallisce() {
        let mut reg = BridgeRegistry::new(&plan());
        let out = reg.take_sender("ch").unwrap();
        let inn = reg.take_receiver("ch").unwrap();
        let (tx, mut rx) = mpsc::channel::<Row>(10);
        let h = tokio::spawn(run_bridge_in(ctx(serde_json::json!({})), inn, Some(tx)));
        out.rows.send(row(1)).await.unwrap();
        drop(out);
        assert!(h.await.unwrap().unwrap_err().contains("delivery is incomplete"));
        assert!(rx.recv().await.is_some());
    }
}
