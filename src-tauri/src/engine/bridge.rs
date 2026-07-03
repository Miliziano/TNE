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
use tokio::sync::mpsc;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver};

// Buffer del canale bridge — più grande dei canali interni alla lane
// perché le lane possono avere velocità diverse e vogliamo evitare
// stalli: se lane A produce più veloce di quanto lane B consuma,
// il buffer assorbe le differenze temporanee.
const BRIDGE_CHANNEL_BUFFER: usize = 5000;

// ─── BridgeRegistry ───────────────────────────────────────────────
// Creato dall'Engine prima di avviare le lane.
// Ogni lane "preleva" il proprio sender/receiver da qui.

pub struct BridgeRegistry {
    // bridge_id → Sender (per la lane che ha il BridgeOut)
    senders:   HashMap<String, Option<RowSender>>,
    // bridge_id → Receiver (per la lane che ha il BridgeIn)
    receivers: HashMap<String, Option<RowReceiver>>,
}

impl BridgeRegistry {
    /// Crea tutti i canali bridge dichiarati nel Plan.
    /// Chiamato una sola volta prima di avviare le lane.
    pub fn new(bridges: &[BridgePlan]) -> Self {
        let mut senders   = HashMap::new();
        let mut receivers = HashMap::new();

        for bridge in bridges {
            let (tx, rx) = mpsc::channel::<Row>(BRIDGE_CHANNEL_BUFFER);
            senders.insert(bridge.bridge_id.clone(), Some(tx));
            receivers.insert(bridge.bridge_id.clone(), Some(rx));
        }

        BridgeRegistry { senders, receivers }
    }

    /// Preleva il Sender per un BridgeOut.
    /// take() consuma il valore — se chiamato due volte restituisce None
    /// (ogni bridge ha esattamente un sender, assegnato a una sola lane).
    pub fn take_sender(&mut self, bridge_id: &str) -> Option<RowSender> {
        self.senders.get_mut(bridge_id)?.take()
    }

    /// Preleva il Receiver per un BridgeIn.
    pub fn take_receiver(&mut self, bridge_id: &str) -> Option<RowReceiver> {
        self.receivers.get_mut(bridge_id)?.take()
    }
}

// ─── BridgeOut node ───────────────────────────────────────────────
// Riceve righe dal canale della lane e le manda nel canale bridge
// verso un'altra lane. Si comporta come un sink per la lane corrente.

pub async fn run_bridge_out(
    ctx:    crate::engine::executor::NodeContext,
    mut rx: RowReceiver,
    bridge_tx: RowSender,
) -> Result<NodeStats, String> {
    use std::time::Instant;
    use crate::engine::bus::push_event;
    use crate::engine::events::EngineEvent;

    ctx.emit_started();

    let (mut rows_in, mut rows_out) = (0u64, 0u64);
    let start = Instant::now();

    while let Some(row) = rx.recv().await {
        rows_in += 1;
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
    // bridge_tx droppato qui → lane destinazione riceve None → sa che ha finito

    push_event(EngineEvent::BridgeCompleted {
        run_id:        ctx.run_id.clone(),
        bridge_id:     ctx.node_id.0.clone(),
        rows_transfer: rows_out,
    });

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
    ctx:       crate::engine::executor::NodeContext,
    mut bridge_rx: RowReceiver,
    tx:        Option<RowSender>,
) -> Result<NodeStats, String> {
    use std::time::Instant;

    ctx.emit_started();

    let tx = match tx {
        Some(t) => t,
        None    => return Ok(NodeStats::default()),
    };

    let (mut rows_in, mut rows_out) = (0u64, 0u64);
    let start = Instant::now();

    // Aspetta righe dal bridge — si sospende automaticamente se la
    // lane sorgente è più lenta. Nessun polling attivo, nessuna CPU sprecata.
    // La sospensione è trasparente: gli altri task Tokio girano normalmente.
    while let Some(row) = bridge_rx.recv().await {
        rows_in += 1;
        if tx.send(row).await.is_err() {
            break;
        }
        rows_out += 1;

        if rows_in % 500 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
