// ─── src-tauri/src/engine/watch_subs.rs ──────────────────────────
//
// Sottoscrizioni WATCH continue, RUN-SCOPED (fetta 2 del dir_watcher continuo).
//
// Perché run-scoped e non nel nodo: nel modello a SESSIONI la lane viene
// ri-eseguita per ogni gruppo di eventi (commit per gruppo), quindi il nodo
// watcher verrebbe distrutto/ricreato a ogni sessione. Se tenesse LUI la
// sottoscrizione perderebbe gli eventi nel mezzo. La sottoscrizione + coda
// vanno quindi ISSATE SOPRA la lane: qui, in un registro globale a vita-run
// (stesso schema di `run_cancels()` in mod.rs). Vedi
// `docs/design-nodo-dir-watcher.md`.
//
// Questo modulo è SOLO la plumbing (fetta 2): tiene vivo il watcher `notify`
// e mette gli eventi GREZZI su un canale tokio unbounded; il receiver va al
// chiamante. Il LOOP DI SESSIONE che drena la coda ed esegue la lane è la
// fetta 3 — chiamerà `start_watch` e possiederà il receiver.
#![allow(dead_code)] // start_watch/stop_watch: cablati dalla fetta 3

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Mutex, OnceLock};

use notify::{RecommendedWatcher, RecursiveMode, Watcher};
use tokio::sync::mpsc::{unbounded_channel, UnboundedReceiver};

/// Una sottoscrizione viva. Tiene il watcher `notify` (drop = dissottoscrizione
/// dal SO). Il receiver NON sta qui: lo possiede il chiamante (il loop di
/// sessione), così la coda vive quanto il RUN e non quanto la singola lane.
pub struct WatchSub {
    _watcher: RecommendedWatcher,
}

fn watch_subs() -> &'static Mutex<HashMap<String, WatchSub>> {
    static SUBS: OnceLock<Mutex<HashMap<String, WatchSub>>> = OnceLock::new();
    SUBS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Chiave run-scoped di una sottoscrizione.
pub fn watch_key(run_id: &str, node_id: &str) -> String {
    format!("{}::{}", run_id, node_id)
}

/// Avvia una sottoscrizione continua: watcher `notify` la cui callback spinge
/// gli eventi GREZZI su un canale unbounded (send sincrono dal thread di
/// notify), registrato run-scoped. Ritorna il receiver al chiamante. Il
/// watcher resta nel registro — e vivo — finché non si chiama `stop_watch` o
/// `stop_run_watches`.
pub fn start_watch(
    key: String,
    dir: &str,
    recursive: bool,
) -> Result<UnboundedReceiver<notify::Event>, String> {
    let (tx, rx) = unbounded_channel::<notify::Event>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        // unbounded → non blocca mai; gli errori del watcher si scartano qui
        // (la fetta 3 potrà propagarli col loop di sessione).
        if let Ok(ev) = res {
            let _ = tx.send(ev);
        }
    })
    .map_err(|e| format!("watch_subs: creazione watcher: {}", e))?;

    watcher
        .watch(
            Path::new(dir),
            if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive },
        )
        .map_err(|e| format!("watch_subs: watch '{}': {}", dir, e))?;

    watch_subs()
        .lock()
        .unwrap()
        .insert(key, WatchSub { _watcher: watcher });
    Ok(rx)
}

/// Ferma e rimuove UNA sottoscrizione (drop del watcher = dissottoscrizione).
pub fn stop_watch(key: &str) {
    watch_subs().lock().unwrap().remove(key);
}

// ─── SLOT dei gruppi di sessione (fetta 3) ───────────────────────
// Il loop di sessione (engine) deposita qui gli eventi GREZZI del gruppo
// corrente PRIMA di ri-eseguire la lane; il nodo dir_watcher continuo li
// preleva (`take_group`) ed emette. Chiave = stessa di `start_watch`.
fn watch_groups() -> &'static Mutex<HashMap<String, Vec<notify::Event>>> {
    static GROUPS: OnceLock<Mutex<HashMap<String, Vec<notify::Event>>>> = OnceLock::new();
    GROUPS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Deposita il gruppo di eventi della sessione corrente (loop → nodo).
pub fn put_group(key: &str, events: Vec<notify::Event>) {
    watch_groups().lock().unwrap().insert(key.to_string(), events);
}

/// Preleva (e rimuove) il gruppo della sessione corrente (nodo). Vec vuoto se
/// non c'è niente (sessione a vuoto, es. su cancel).
pub fn take_group(key: &str) -> Vec<notify::Event> {
    watch_groups().lock().unwrap().remove(key).unwrap_or_default()
}

/// Teardown a fine/annullamento run: rimuove tutte le sottoscrizioni E i gruppi
/// del run (chiave `"{run_id}::…"`), così non restano watcher né code orfani.
/// Va chiamato dove il run deregistra il suo CancellationToken (mod.rs).
pub fn stop_run_watches(run_id: &str) {
    let prefix = format!("{}::", run_id);
    watch_subs()
        .lock()
        .unwrap()
        .retain(|k, _| !k.starts_with(prefix.as_str()));
    watch_groups()
        .lock()
        .unwrap()
        .retain(|k, _| !k.starts_with(prefix.as_str()));
}
