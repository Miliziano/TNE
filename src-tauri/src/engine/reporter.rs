// ─── src-tauri/src/engine/reporter.rs ─────────────────────────────
//
// Writer NDJSON: persistenza primaria degli eventi del run su disco.
//
// PERCHÉ ESISTE QUESTO FILE:
//
// Il bus in memoria (bus.rs) è un ring buffer da 10.000 eventi: sotto
// carico, o se WebKit legge lento, gli eventi più vecchi vengono
// sfrattati prima di essere letti. Va benissimo per il display live,
// ma NON è un record affidabile. Questo modulo è il record affidabile:
// ogni evento che passa dal bus viene anche scritto, una riga per
// evento, in un file NDJSON dedicato al run. Se il buffer in memoria
// wrappa, il file resta completo.
//
// È anche la fondazione del monitoraggio HEADLESS: un futuro artifact
// nativo (senza suite grafica, senza WebKit) può includere questo
// stesso reporter e ottenere lo stesso file, senza dipendere dal
// polling della UI. Per questo il modulo non tocca nulla di Tauri: è
// puro std + serde.
//
// ARCHITETTURA (stessa filosofia del sampler):
//
//   push_event(...)  ──►  forward(&event)  ──[canale mpsc]──►  thread
//   (lane, sampler)       (clona + invia)                     writer
//                                                             (fa I/O)
//
// I thread produttori (lane, sampler) non fanno mai I/O su disco:
// clonano l'evento e lo passano su un canale. Un unico thread
// dedicato ("fp-ndjson-writer") drena il canale e scrive. Così la
// scrittura non rallenta mai l'esecuzione del flusso.
//
// SCOPED AL RUN: start() a inizio run apre il file, stop() a fine run
// chiude il canale (il writer fa il flush finale ed esce). Un file per
// run: <dir>/<run_id>.ndjson.
//
// CONCETTI RUST IN QUESTO FILE:
//
// 1. `mpsc::channel` — canale multi-produttore / singolo-consumatore.
//    Tanti thread inviano, un solo thread riceve. È il pattern giusto
//    per "tante sorgenti di eventi, un solo scrittore".
//
// 2. `AtomicBool ACTIVE` — controllo velocissimo (senza lock) sul
//    percorso caldo: se nessun run sta registrando, forward() esce
//    subito senza clonare né prendere mutex.
//
// 3. `OnceLock<Mutex<Option<...>>>` — lo slot globale che tiene il
//    canale del run in corso. OnceLock lo inizializza pigramente, il
//    Mutex protegge la sostituzione start/stop, l'Option dice se un
//    run è attivo.

use std::io::Write;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{Receiver, Sender};
use std::sync::{Mutex, OnceLock};

use serde::Serialize;

use crate::engine::events::EngineEvent;

// ─── Stato globale ────────────────────────────────────────────────

static REPORTER: OnceLock<Mutex<Option<ReporterHandle>>> = OnceLock::new();

/// Fast-path: letto a ogni forward(). Se false, forward() ritorna
/// immediatamente senza clonare né prendere il mutex.
static ACTIVE: AtomicBool = AtomicBool::new(false);

/// Una riga del file NDJSON. `ts` è il momento di emissione (ms Unix),
/// `event` è l'evento nella sua forma serializzata standard
/// (`{"type":...,"payload":{...}}`). Risultato su disco:
///   {"ts":1783179231640,"event":{"type":"MemorySample","payload":{...}}}
#[derive(Serialize)]
struct Record {
    ts:    u64,
    event: EngineEvent,
}

struct ReporterHandle {
    tx:   Sender<Record>,
    join: std::thread::JoinHandle<()>,
}

// ─── Percorso della cartella dei run ──────────────────────────────

/// Cartella dove finiscono i file NDJSON dei run.
///   - se è impostata la variabile d'ambiente FLOWPILOT_RUNS_DIR, usa
///     quella (serve al caso headless: l'artifact decide dove scrivere);
///   - altrimenti ~/.flowpilot/runs/ (HOME su Unix, USERPROFILE su Windows).
fn runs_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("FLOWPILOT_RUNS_DIR") {
        return PathBuf::from(dir);
    }
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".flowpilot").join("runs")
}

// ─── API pubblica ─────────────────────────────────────────────────

/// Apre il file del run e avvia il thread writer. Da chiamare a inizio
/// run, PRIMA di emettere RunStarted, così anche RunStarted finisce nel
/// file. Se qualcosa fallisce (permessi, disco) logga su stderr e
/// prosegue senza registrare: il monitoraggio non deve mai bloccare un run.
pub fn start(run_id: &str) {
    // Difensivo: se un reporter era già attivo (run precedente non
    // chiuso correttamente), chiudilo prima di aprirne un altro.
    stop();

    let dir = runs_dir();
    if let Err(e) = std::fs::create_dir_all(&dir) {
        eprintln!("[reporter] impossibile creare {}: {}", dir.display(), e);
        return;
    }

    let path = dir.join(format!("{run_id}.ndjson"));
    let file = match std::fs::File::create(&path) {
        Ok(f) => f,
        Err(e) => {
            eprintln!("[reporter] impossibile aprire {}: {}", path.display(), e);
            return;
        }
    };

    let (tx, rx) = std::sync::mpsc::channel::<Record>();
    let join = std::thread::Builder::new()
        .name("fp-ndjson-writer".to_string())
        .spawn(move || writer_loop(file, rx))
        .expect("impossibile creare il thread writer NDJSON");

    let slot = REPORTER.get_or_init(|| Mutex::new(None));
    if let Ok(mut guard) = slot.lock() {
        *guard = Some(ReporterHandle { tx, join });
        // ACTIVE va messo a true SOLO dopo che lo slot è pronto,
        // altrimenti un forward() concorrente troverebbe ACTIVE=true
        // ma lo slot ancora vuoto.
        ACTIVE.store(true, Ordering::Release);
        eprintln!("[reporter] registrazione run su {}", path.display());
    }
}

/// Inoltra un evento al file, se un run sta registrando. Chiamata su
/// OGNI push_event, da qualunque thread. Costo quasi nullo quando
/// nessun run è attivo (solo una lettura atomica).
pub fn forward(event: &EngineEvent) {
    if !ACTIVE.load(Ordering::Acquire) {
        return;
    }
    let slot = match REPORTER.get() {
        Some(s) => s,
        None => return,
    };
    if let Ok(guard) = slot.lock() {
        if let Some(h) = guard.as_ref() {
            // send fallisce solo se il writer è già uscito: in quel
            // caso ignoriamo (l'evento arriva a run finito).
            let _ = h.tx.send(Record {
                ts:    EngineEvent::timestamp_ms(),
                event: event.clone(),
            });
        }
    }
}

/// Chiude la registrazione: ferma il fast-path, chiude il canale (il
/// writer drena il residuo, fa il flush finale ed esce) e aspetta il
/// thread. Da chiamare a fine run, DOPO aver emesso RunCompleted/RunFailed.
pub fn stop() {
    ACTIVE.store(false, Ordering::Release);

    let slot = match REPORTER.get() {
        Some(s) => s,
        None => return,
    };
    let handle = match slot.lock() {
        Ok(mut guard) => guard.take(),
        Err(_) => None,
    };
    if let Some(h) = handle {
        drop(h.tx);            // chiude il canale → writer_loop esce dal while
        let _ = h.join.join(); // aspetta flush finale e chiusura del file
    }
}

// ─── Thread writer ────────────────────────────────────────────────

fn writer_loop(mut file: std::fs::File, rx: Receiver<Record>) {
    // recv() blocca finché arriva un evento o il canale viene chiuso.
    // Alla chiusura (Err) esce dal while e fa il flush finale.
    while let Ok(rec) = rx.recv() {
        if let Ok(line) = serde_json::to_string(&rec) {
            let _ = writeln!(file, "{line}");
        }
    }
    let _ = file.flush();
}