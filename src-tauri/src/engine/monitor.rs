// ─── src-tauri/src/engine/monitor.rs ──────────────────────────────
//
// Sampler di memoria indipendente da WebKit.
//
// PERCHÉ ESISTE QUESTO FILE:
//
// Fino alla Fase 8 la memoria veniva campionata dal frontend: un
// setInterval JS dentro MonitoringBus.ts chiamava il comando Rust
// `get_memory_info` a intervalli. Il problema è che quel timer gira
// sul thread principale di WebKit: se la UI è sotto carico (render
// pesante del canvas, run con molte righe), il timer slitta e i
// campioni diventano radi e in ritardo PROPRIO nell'istante critico
// — cioè quando la memoria sta salendo e vorresti vederla meglio.
//
// Qui invertiamo il flusso: è Rust a campionare, su un thread di
// sistema DEDICATO (`std::thread`, non un task Tokio — così non
// compete con i worker che eseguono le lane e non può essere
// affamato da loro), a cadenza fissa. Ogni campione diventa un
// EngineEvent::MemorySample nel bus. WebKit si limita a leggere e
// disegnare: se lag­ga, il record resta comunque fedele perché il
// timestamp è preso qui, nel momento esatto del campionamento.
//
// Il sampler è SCOPED AL RUN: parte quando parte il run e si ferma
// quando il run finisce. Niente campionamento a idle (scelta di
// progetto: il monitor è un monitor DEL run).
//
// È scritto `pub` e senza dipendenze dalla GUI di proposito: un
// futuro artifact nativo headless (Rust) può riusare esattamente
// questo sampler puntandolo allo stesso bus / a un writer NDJSON,
// senza WebKit nel giro.
//
// CONCETTI RUST IN QUESTO FILE:
//
// 1. `std::thread::spawn` — crea un thread di sistema vero, non un
//    task async. Gira in parallelo reale, schedulato dall'OS. È
//    quello che vogliamo per un campionatore che non deve mai
//    essere ritardato dal lavoro del motore.
//
// 2. `Arc<AtomicBool>` — un flag booleano condiviso tra il thread
//    sampler e chi lo comanda, aggiornabile senza lock (operazione
//    atomica). Lo usiamo come segnale di "fermati".
//
// 3. `Ordering::Relaxed` — per un semplice flag di stop non serve
//    sincronizzazione forte tra più variabili; Relaxed è il modo
//    più economico di leggere/scrivere un atomico.
//
// 4. RAII / `Drop` — quando `RunningSampler` esce dallo scope, il
//    suo `drop` ferma il thread. Così anche se il run va in panic
//    o esce da un percorso inaspettato, il sampler non resta
//    orfano a girare per sempre.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::Duration;

use crate::engine::bus::push_event;
use crate::engine::events::EngineEvent;
use crate::engine::types::RunId;
use crate::memory_monitor::get_app_memory_info;

// ─── Configurazione ───────────────────────────────────────────────

/// Cadenza di campionamento durante il run. Più fitta del vecchio
/// default JS (2000ms) per catturare i picchi: 150ms significa ~6-7
/// campioni al secondo, abbastanza da vedere la forma di una salita
/// senza inondare il bus.
const SAMPLE_INTERVAL_MS: u64 = 150;

/// Il thread non dorme 150ms di fila: dorme a fettine di CHECK_MS e
/// tra una fettina e l'altra controlla il flag di stop. Così `stop()`
/// ritorna in al massimo ~CHECK_MS invece di dover aspettare l'intero
/// intervallo. Tiene il thread reattivo senza campionare più spesso.
const CHECK_MS: u64 = 20;

// ─── Handle del sampler in esecuzione ─────────────────────────────

/// Restituito da `MemorySampler::start`. Finché è vivo, il thread
/// campiona. Chiamare `stop()` (o lasciarlo droppare) ferma il thread
/// e lo aspetta.
pub struct RunningSampler {
    stop:   Arc<AtomicBool>,
    handle: Option<JoinHandle<()>>,
}

impl RunningSampler {
    /// Ferma il campionamento e aspetta che il thread termini.
    /// Idempotente: chiamarlo due volte non fa danni.
    pub fn stop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            // join ritorna entro ~CHECK_MS perché il thread controlla
            // il flag a ogni fettina di sleep.
            let _ = handle.join();
        }
    }
}

impl Drop for RunningSampler {
    fn drop(&mut self) {
        // Rete di sicurezza: se il run esce senza chiamare stop()
        // esplicitamente (panic, early return futuro), il thread
        // viene comunque fermato qui.
        self.stop();
    }
}

// ─── MemorySampler ────────────────────────────────────────────────

pub struct MemorySampler;

impl MemorySampler {
    /// Avvia il campionamento su un thread dedicato. `run_id` viene
    /// allegato a ogni MemorySample così i campioni sono attribuibili
    /// al run corrente (e filtrabili come tutti gli altri eventi).
    ///
    /// Ritorna un `RunningSampler`: tienilo vivo per tutta la durata
    /// del run, poi chiama `.stop()` (o lascialo droppare).
    pub fn start(run_id: Option<RunId>) -> RunningSampler {
        Self::start_with_interval(run_id, SAMPLE_INTERVAL_MS)
    }

    /// Variante con intervallo esplicito — utile per test o per un
    /// futuro emettitore che voglia una cadenza diversa.
    pub fn start_with_interval(run_id: Option<RunId>, interval_ms: u64) -> RunningSampler {
        let stop = Arc::new(AtomicBool::new(false));
        let stop_thread = Arc::clone(&stop);

        let handle = std::thread::Builder::new()
            .name("fp-mem-sampler".to_string())
            .spawn(move || {
                // Primo campione immediato: cattura la baseline nel
                // momento in cui il run parte, senza aspettare il
                // primo intervallo.
                emit_sample(&run_id);

                let slices = (interval_ms / CHECK_MS).max(1);
                'outer: loop {
                    for _ in 0..slices {
                        if stop_thread.load(Ordering::Relaxed) {
                            break 'outer;
                        }
                        std::thread::sleep(Duration::from_millis(CHECK_MS));
                    }
                    if stop_thread.load(Ordering::Relaxed) {
                        break;
                    }
                    emit_sample(&run_id);
                }
            })
            .expect("impossibile creare il thread del sampler di memoria");

        RunningSampler { stop, handle: Some(handle) }
    }
}

/// Legge la memoria dell'app e spinge un MemorySample nel bus.
/// `rss` è il numero neutro rispetto al linguaggio (RSS totale
/// dell'app); `detail` porta il dettaglio specifico della piattaforma
/// (albero processi, PSS, private/shared, RAM di sistema) come
/// estensione opzionale che altri emettitori possono lasciare a None.
fn emit_sample(run_id: &Option<RunId>) {
    let info = get_app_memory_info();
    push_event(EngineEvent::MemorySample {
        run_id:    run_id.clone(),
        rss:       info.total_rss,
        timestamp: info.timestamp,
        detail:    Some(info),
    });
}
