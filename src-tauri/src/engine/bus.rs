// ─── src-tauri/src/engine/bus.rs ───────────────────────────────────
//
// Event Bus — buffer condiviso tra Engine (scrittore) e frontend
// (lettore via polling). Progettato per non perdere eventi anche
// sotto carico e per non bloccare mai l'Engine mentre scrive.
//
// CONCETTI RUST NUOVI IN QUESTO FILE:
//
// 1. `Arc<T>` — "Atomically Reference Counted". Permette di condividere
//    un valore tra più thread/task senza copiarlo. Funziona come un
//    Rc<T> in JavaScript (garbage collection a contatori), ma thread-safe.
//    Quando cloni un Arc, non cloni il dato — cloni solo il puntatore
//    e incrementi il contatore. Il dato viene deallocato quando l'ultimo
//    Arc che lo punta viene droppato.
//    Uso tipico: Arc::clone(&bus) per dare il bus a un nuovo task.
//
// 2. `Mutex<T>` — "Mutual Exclusion". Protegge un dato da accessi
//    concorrenti. Solo un thread alla volta può tenere il lock.
//    bus.lock().unwrap() acquisisce il lock (bloccante se qualcun
//    altro ce l'ha) e restituisce un MutexGuard che si rilascia
//    automaticamente quando esce dallo scope — no rischi di
//    dimenticarsi di rilasciare il lock come in altri linguaggi.
//
// 3. `Arc<Mutex<T>>` — il pattern più comune per stato condiviso
//    tra task Tokio. Arc permette di avere più owner, Mutex garantisce
//    accesso esclusivo. È l'equivalente di un oggetto condiviso con
//    lock in Java/C#, ma il compilatore Rust garantisce che non puoi
//    accedere al dato senza aver acquisito il lock.
//
// 4. `VecDeque<T>` — coda double-ended. Più efficiente di Vec quando
//    devi togliere elementi dalla testa (pop_front) — Vec sposterebbe
//    tutti gli elementi, VecDeque no. Perfetto per un buffer FIFO.
//
// 5. `OnceLock<T>` — inizializzazione lazy thread-safe. Il valore
//    viene creato solo al primo accesso e poi riusato. Usiamo questo
//    per il bus globale singleton — creato una volta sola all'avvio.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex, OnceLock};
use serde::{Deserialize, Serialize};
use crate::engine::events::EngineEvent;

// ─── Configurazione ───────────────────────────────────────────────

/// Massimo eventi bufferizzati. Se il frontend non fa polling
/// abbastanza spesso e il buffer si riempie, i più vecchi vengono
/// scartati (FIFO) per non consumare memoria illimitata.
const MAX_BUFFERED_EVENTS: usize = 10_000;

// ─── EventBus ─────────────────────────────────────────────────────

pub struct EventBus {
    /// Buffer degli eventi in attesa di essere letti dal frontend.
    /// VecDeque perché aggiungiamo in fondo (push_back) e leggiamo
    /// dalla testa (drain con skip sul cursore).
    events: VecDeque<TimestampedEvent>,

    /// Cursore globale — ogni evento riceve un sequence number
    /// monotonicamente crescente. Il frontend tiene traccia
    /// dell'ultimo cursore ricevuto e chiede "dammi tutto dopo X".
    /// Questo garantisce che non si perdano eventi e non si ricevano
    /// duplicati, anche se il polling non è perfettamente regolare.
    next_seq: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimestampedEvent {
    pub seq:       u64,          // sequence number per il cursore
    pub timestamp: u64,          // Unix ms
    pub event:     EngineEvent,
}

impl EventBus {
    pub fn new() -> Self {
        EventBus {
            events:   VecDeque::new(),
            next_seq: 0,
        }
    }

    /// Aggiunge un evento al buffer. Chiamato dall'Engine durante
    /// l'esecuzione — deve essere velocissimo (nessuna I/O, nessun
    /// await, solo push in memoria).
    pub fn push(&mut self, event: EngineEvent) {
        // Scarta i più vecchi se il buffer è pieno
        if self.events.len() >= MAX_BUFFERED_EVENTS {
            self.events.pop_front();
        }

        let seq = self.next_seq;
        self.next_seq += 1;

        self.events.push_back(TimestampedEvent {
            seq,
            timestamp: EngineEvent::timestamp_ms(),
            event,
        });
    }

    /// Restituisce tutti gli eventi con seq > after_seq.
    /// Il frontend passa l'ultimo seq ricevuto — riceve solo i nuovi.
    /// Restituisce anche il nuovo cursore da usare alla prossima chiamata.
    pub fn drain_since(&self, after_seq: u64) -> (Vec<TimestampedEvent>, u64) {
        let events: Vec<TimestampedEvent> = self.events
            .iter()
            .filter(|e| e.seq > after_seq)
            .cloned()   // cloniamo perché il frontend riceve una copia serializzata,
                        // il buffer originale resta intatto per altri lettori
            .collect();

        // Il nuovo cursore è il seq più alto tra gli eventi restituiti,
        // oppure after_seq se non ci sono eventi nuovi
        let new_cursor = events.last()
            .map(|e| e.seq)
            .unwrap_or(after_seq);

        (events, new_cursor)
    }

    /// Svuota tutto il buffer — chiamato a fine run per liberare memoria.
    pub fn clear(&mut self) {
        self.events.clear();
        // next_seq NON si azzera — il cursore è monotonicamente crescente
        // per tutta la vita dell'applicazione
    }

    pub fn len(&self) -> usize {
        self.events.len()
    }
}

// ─── Bus globale singleton ────────────────────────────────────────
//
// L'Engine (task Tokio) e i comandi Tauri (altri task Tokio) devono
// condividere lo stesso bus. Usiamo un singleton globale con OnceLock
// — creato una volta al primo accesso, poi sempre lo stesso.
//
// Arc<Mutex<EventBus>>:
//   - Arc: permette di avere il bus in più task contemporaneamente
//   - Mutex: garantisce che solo uno alla volta scriva/legga

static GLOBAL_BUS: OnceLock<Arc<Mutex<EventBus>>> = OnceLock::new();

/// Ottieni un riferimento al bus globale.
/// La prima chiamata crea il bus, le successive restituiscono lo stesso.
pub fn global_bus() -> Arc<Mutex<EventBus>> {
    GLOBAL_BUS
        .get_or_init(|| Arc::new(Mutex::new(EventBus::new())))
        .clone()   // clone dell'Arc — non clona il bus, solo il puntatore
}

/// Shortcut per pushare un evento senza dover gestire il lock manualmente.
/// Usato dall'Engine: push_event(EngineEvent::NodeStarted { ... })
pub fn push_event(event: EngineEvent) {
    if let Ok(mut bus) = global_bus().lock() {
        bus.push(event);
    }
    // Se il lock fallisce (mutex avvelenato per panic) ignoriamo silenziosamente —
    // meglio perdere un evento che crashare l'Engine per un evento di monitoring
}

// ─── Risposta al polling ──────────────────────────────────────────

#[derive(Debug, Serialize, Deserialize)]
pub struct PollResult {
    pub events:     Vec<TimestampedEvent>,
    pub cursor:     u64,     // da passare alla prossima chiamata
    pub bus_len:    usize,   // quanti eventi ci sono ancora nel buffer
}
