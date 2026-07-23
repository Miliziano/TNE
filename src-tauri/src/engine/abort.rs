// ─── src-tauri/src/engine/abort.rs ─────────────────────────────────
//
// Registro per-lane degli AbortHandle dei nodi in esecuzione: è
// l'attrezzo con cui l'error_handler INTERROMPE la lane quando un nodo
// con `critical: 'true'` fallisce.
//
// Perché serve un registro e non basta il loop di attesa: gli esiti si
// raccolgono a fine lane, in ordine di spawn, e il primo handle atteso
// è quello dell'EH — che si sblocca solo a lane finita. Quando
// l'executor si accorge del fallimento, quindi, tutti gli altri nodi
// hanno GIÀ girato: i sink hanno già scritto. L'unico punto che sa
// dell'errore mentre la lane è ancora viva è il collettore, cioè l'EH.
// Da lì parte l'interruzione, e per farlo gli serve poter raggiungere i
// task altrui: questo registro.
//
// Chi NON entra nel registro (lo decide l'executor, stesso insieme del
// collettore): l'EH e i nodi della sua sotto-pipeline. Se l'EH abortisse
// se stesso o il proprio log d'errore, la notifica morirebbe insieme
// alla lane — e sarebbe l'unica cosa che volevamo salvare.
//
// Calco di LaneDatasets / LaneResources: `new()` restituisce Arc<Self>,
// stato dietro Mutex, vive in NodeContext.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use tokio::task::AbortHandle;

struct Inner {
    handles: HashMap<String, AbortHandle>,
    // True dopo la prima interruzione: rende `fire` idempotente (più
    // errori critici nella stessa lane interrompono una volta sola) e
    // chiude la corsa con `register` — v. sotto.
    fired: bool,
    // Chi è stato effettivamente fermato. Serve all'executor DOPO, per
    // riconoscere i nodi che hanno lavorato verso una valle poi sparita
    // (v. `stopped`).
    stopped: Vec<String>,
    // PERCHÉ è scattata. Lo sa solo l'error_handler (errore critico? regola
    // «interrompi»?), ma a raccontarlo è l'executor, che vede i task
    // cancellati senza sapere da cosa: senza questo campo ogni nodo
    // interrotto direbbe "errore critico" anche quando a fermarlo è stata
    // una regola.
    reason: String,
}

pub struct LaneAbort {
    inner: Mutex<Inner>,
}

impl LaneAbort {
    pub fn new() -> Arc<LaneAbort> {
        Arc::new(LaneAbort {
            inner: Mutex::new(Inner {
                handles: HashMap::new(),
                fired:   false,
                stopped: Vec::new(),
                reason:  String::new(),
            }),
        })
    }

    /// Registra un task interrompibile. La registrazione avviene DOPO lo
    /// spawn, nel loop dell'executor, quindi un nodo che fallisce subito
    /// può far scattare l'interruzione mentre altri devono ancora essere
    /// registrati: in quel caso il task va abortito all'istante, invece
    /// di entrare in un registro che nessuno guarderà più.
    pub async fn register(&self, node_id: String, handle: AbortHandle) {
        let mut g = self.inner.lock().await;
        if g.fired {
            handle.abort();
            return;
        }
        g.handles.insert(node_id, handle);
    }

    /// Interrompe tutti i task registrati ancora vivi. Restituisce gli id
    /// di quelli effettivamente fermati (i già conclusi non contano: non
    /// vanno segnalati all'utente come interrotti). Chiamata solo
    /// dall'error_handler, che passa il MOTIVO in forma già leggibile —
    /// sarà quello a comparire accanto a ogni nodo interrotto.
    pub async fn fire(&self, motivo: &str) -> Vec<String> {
        let mut g = self.inner.lock().await;
        if g.fired {
            return Vec::new();
        }
        g.fired  = true;
        g.reason = motivo.to_string();
        let mut stopped = Vec::new();
        for (id, h) in g.handles.drain() {
            if !h.is_finished() {
                h.abort();
                stopped.push(id);
            }
        }
        g.stopped = stopped.clone();
        stopped
    }

    /// Il motivo passato a `fire` (stringa vuota se non è mai scattata).
    pub async fn reason(&self) -> String {
        self.inner.lock().await.reason.clone()
    }

    /// Gli id fermati da `fire` (vuoto se non è mai scattata).
    pub async fn stopped(&self) -> Vec<String> {
        self.inner.lock().await.stopped.clone()
    }

    /// True se l'interruzione è già scattata (l'executor la usa per non
    /// chiudere la lane con esito Ok).
    pub async fn has_fired(&self) -> bool {
        self.inner.lock().await.fired
    }
}
