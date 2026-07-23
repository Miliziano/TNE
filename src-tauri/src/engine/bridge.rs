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
}

pub struct BridgeInEnds {
    pub rows: RowReceiver,
    // `await` → Ok = consegna conclusa, Err = mittente morto prima.
    pub done: oneshot::Receiver<()>,
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
            senders.insert(bridge.bridge_id.clone(),
                           Some(BridgeOutEnds { rows: tx, done: done_tx }));
            receivers.insert(bridge.bridge_id.clone(),
                             Some(BridgeInEnds { rows: rx, done: done_rx }));
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
) -> Result<NodeStats, String> {
    use std::time::Instant;
    use crate::engine::bus::push_event;
    use crate::engine::events::EngineEvent;

    let BridgeOutEnds { rows: bridge_tx, done } = ends;

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
    // Consegna conclusa: lo si DICHIARA, prima che bridge_tx venga
    // droppato a fine funzione. Il BridgeIn a valle vedrà quindi la
    // conferma già arrivata quando il canale dati si chiude. Se invece
    // questo task venisse abortito, `done` verrebbe droppato senza aver
    // mandato nulla — ed è così che la lane di valle capisce.
    // `let _`: se la lane destinazione non esiste o ha già concluso non
    // c'è nessuno ad ascoltare, e non è un problema di chi consegna.
    let _ = done.send(());

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
    ctx:   crate::engine::executor::NodeContext,
    ends:  BridgeInEnds,
    tx:    Option<RowSender>,
) -> Result<NodeStats, String> {
    use std::time::Instant;

    let BridgeInEnds { rows: mut bridge_rx, done } = ends;

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

    // ── Il canale dati è chiuso: ma PERCHÉ? ───────────────────────
    // Fino a qui le due risposte erano indistinguibili — la lane
    // sorgente ha consegnato tutto, oppure è morta a metà — e questo
    // nodo concludeva verde in entrambi i casi, lasciando che il resto
    // della lane scrivesse sui propri sink dati magari monchi.
    // La conferma è già arrivata (il BridgeOut la manda PRIMA di
    // droppare il canale dati), quindi questa attesa non blocca.
    if done.await.is_err() {
        ctx.emit_log(
            &ctx.label, "error", rows_in,
            format!("Ricevute {} righe, poi la lane sorgente si è interrotta", rows_in),
            "panel",
        );
        // Errore di NODO: prende il canale di controllo come qualunque
        // altro fallimento e arriva all'error handler di QUESTA lane, che
        // decide con le sue regole. Marcare «critico» il bridge_in è ciò
        // che ferma anche la lane di valle.
        return Err(format!(
            "lane sorgente interrotta dopo {} righe: la consegna del bridge è incompleta",
            rows_in,
        ));
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
