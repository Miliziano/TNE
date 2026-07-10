// ─── src-tauri/src/engine/datasets.rs ──────────────────────────────
//
// Registro dei dataset materializzati, per-lane.
// Vedi docs/design-materialize-registry.md.
//
// Il nodo `materialize` accumula un flusso in memoria e — se l'utente lo
// pubblica nella lane — lo rende disponibile per nome ad altri nodi
// (window, aggregate, pivot, explode, join), che lo leggono SENZA arco e
// SENZA consumarlo. Un dataset caricato da un source_db si legge una volta
// sola, anche se tre nodi lo usano.
//
// SINCRONIZZAZIONE
// I nodi di una lane girano in pipeline concorrente: un consumer può
// chiedere un dataset mentre il materialize sta ancora accumulando.
// `get()` attende finché il dataset non è pubblicato.
//
// DEADLOCK — tre difese:
//   1. Nome non dichiarato → errore immediato, non attesa.
//   2. Cicli (window → materialize("A") e window legge "A") → rifiutati da
//      execute_lane PRIMA di partire (vedi check_dataset_cycles).
//   3. finalize() a fine lane risveglia chi attende ancora, con errore.
// Un consumer non può restare appeso: riceve il dataset, o un errore.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{Mutex, Notify};
use crate::engine::types::Row;

// ─── Il dataset ────────────────────────────────────────────────────

/// Immutabile una volta pubblicato. I consumer ne ricevono un `Arc`:
/// nessuna copia, lettura concorrente sicura.
pub struct Dataset {
    pub name: String,
    rows:     Vec<Row>,
    /// Indice per accesso O(1), presente se il materialize ha un keyField.
    /// Una chiave può avere PIÙ righe: non è una primary key.
    index:     Option<HashMap<String, Vec<usize>>>,
    key_field: Option<String>,
}

impl Dataset {
    pub fn new(name: String, rows: Vec<Row>, key_field: Option<String>) -> Self {
        let index = key_field.as_ref().map(|kf| {
            let mut idx: HashMap<String, Vec<usize>> = HashMap::new();
            for (i, row) in rows.iter().enumerate() {
                let key = row.get(kf).map(|v| v.as_str_repr()).unwrap_or_default();
                idx.entry(key).or_default().push(i);
            }
            idx
        });
        Dataset { name, rows, index, key_field }
    }

    pub fn rows(&self) -> &[Row] { &self.rows }
    pub fn len(&self) -> usize { self.rows.len() }
    pub fn is_empty(&self) -> bool { self.rows.is_empty() }
    pub fn key_field(&self) -> Option<&str> { self.key_field.as_deref() }

    /// Accesso per chiave (modalità `lookup`). Vuoto se la chiave non
    /// esiste, o se il dataset non è indicizzato.
    pub fn get(&self, key: &str) -> Vec<&Row> {
        match &self.index {
            Some(idx) => idx.get(key).map(|positions| {
                positions.iter().map(|&i| &self.rows[i]).collect()
            }).unwrap_or_default(),
            None => Vec::new(),
        }
    }

    /// Prima riga per una chiave. Comodo per i lookup 1:1.
    pub fn get_one(&self, key: &str) -> Option<&Row> {
        self.get(key).into_iter().next()
    }
}

// ─── Il registro ───────────────────────────────────────────────────

enum Slot {
    /// Il materialize sta ancora accumulando. Chi chiede attende qui.
    Pending(Arc<Notify>),
    /// Pubblicato: i consumer possono leggerlo.
    Ready(Arc<Dataset>),
    /// Il materialize è fallito, o la lane è finita senza pubblicare.
    Failed(String),
}

pub struct LaneDatasets {
    slots: Mutex<HashMap<String, Slot>>,
}

impl LaneDatasets {
    /// Costruito da execute_lane con uno slot Pending per ogni dataset
    /// DICHIARATO nel plan (sezione `datasets` della lane).
    /// Un nome non dichiarato darà errore immediato, non attesa infinita.
    pub fn new(declared: &[String]) -> Arc<LaneDatasets> {
        let mut slots = HashMap::new();
        for name in declared {
            slots.insert(name.clone(), Slot::Pending(Arc::new(Notify::new())));
        }
        Arc::new(LaneDatasets { slots: Mutex::new(slots) })
    }

    /// Il materialize pubblica il dataset. Risveglia chi attende.
    pub async fn publish(&self, name: &str, dataset: Dataset) {
        let n = dataset.len();
        let notify = {
            let mut slots = self.slots.lock().await;
            let prev = slots.insert(name.to_string(), Slot::Ready(Arc::new(dataset)));
            match prev {
                Some(Slot::Pending(n)) => Some(n),
                _ => None,   // non dichiarato, o già pubblicato
            }
        };
        eprintln!("[dataset] '{}': {} righe pubblicate", name, n);
        if let Some(n) = notify { n.notify_waiters(); }
    }

    /// Il materialize è fallito. Chi attende riceve l'errore.
    pub async fn fail(&self, name: &str, reason: String) {
        let notify = {
            let mut slots = self.slots.lock().await;
            let prev = slots.insert(name.to_string(), Slot::Failed(reason.clone()));
            match prev {
                Some(Slot::Pending(n)) => Some(n),
                _ => None,
            }
        };
        eprintln!("[dataset] '{}': FALLITO — {}", name, reason);
        if let Some(n) = notify { n.notify_waiters(); }
    }

    /// Legge un dataset, attendendo che sia pubblicato.
    ///
    /// - `Ready`   → ritorna subito
    /// - `Pending` → attende la notifica
    /// - `Failed`  → errore
    /// - assente   → errore immediato (nome non dichiarato)
    pub async fn get(&self, name: &str) -> Result<Arc<Dataset>, String> {
        loop {
            let notify = {
                let slots = self.slots.lock().await;
                match slots.get(name) {
                    Some(Slot::Ready(ds))    => return Ok(ds.clone()),
                    Some(Slot::Failed(e))    => return Err(format!("dataset '{}': {}", name, e)),
                    Some(Slot::Pending(n))   => n.clone(),
                    None => return Err(format!(
                        "dataset '{}' non dichiarato in questa lane. Pubblica il nodo \
                         Materialize nella lane (tab Configurazione) e verifica il nome.",
                        name)),
                }
            };
            // Il lock è rilasciato: attendi la pubblicazione, poi ricontrolla.
            notify.notified().await;
        }
    }

    /// Variante non bloccante: `None` se non ancora pronto.
    pub async fn try_get(&self, name: &str) -> Option<Arc<Dataset>> {
        let slots = self.slots.lock().await;
        match slots.get(name) {
            Some(Slot::Ready(ds)) => Some(ds.clone()),
            _ => None,
        }
    }

    /// A fine lane: chi attende ancora viene risvegliato con un errore.
    /// Rete di sicurezza contro un materialize che non ha mai pubblicato
    /// (fallito prima, o mai eseguito).
    pub async fn finalize(&self) {
        let pending: Vec<(String, Arc<Notify>)> = {
            let slots = self.slots.lock().await;
            slots.iter().filter_map(|(name, slot)| match slot {
                Slot::Pending(n) => Some((name.clone(), n.clone())),
                _ => None,
            }).collect()
        };
        if pending.is_empty() { return }

        {
            let mut slots = self.slots.lock().await;
            for (name, _) in &pending {
                slots.insert(name.clone(), Slot::Failed(
                    "il Materialize non ha mai pubblicato il dataset (fallito, o non \
                     collegato a una sorgente)".to_string()));
            }
        }
        for (name, notify) in pending {
            eprintln!("[dataset] '{}': mai pubblicato — risveglio chi attende", name);
            notify.notify_waiters();
        }
    }
}

// ─── Rilevamento cicli ─────────────────────────────────────────────
//
// Un consumer che legge un dataset prodotto da un materialize a valle di
// sé stesso si bloccherebbe per sempre:
//
//     window → materialize("A")        e   window legge "A"
//
// execute_lane costruisce il grafo delle dipendenze dataset e rifiuta i
// cicli PRIMA di partire, con un errore leggibile.

/// `producers`: nome dataset → node_id che lo pubblica
/// `consumers`: node_id → nomi dei dataset che legge
/// `edges`: archi del grafo (source_node, target_node)
///
/// Un ciclo esiste se il produttore di un dataset è raggiungibile, nel
/// grafo, da un suo consumatore.
pub fn check_dataset_cycles(
    producers: &HashMap<String, String>,
    consumers: &HashMap<String, Vec<String>>,
    edges:     &[(String, String)],
) -> Result<(), String> {
    // Adiacenza del grafo di flusso
    let mut adj: HashMap<&str, Vec<&str>> = HashMap::new();
    for (from, to) in edges {
        adj.entry(from.as_str()).or_default().push(to.as_str());
    }

    for (consumer, datasets) in consumers {
        for ds_name in datasets {
            let Some(producer) = producers.get(ds_name) else { continue };
            if reachable(&adj, consumer, producer) {
                return Err(format!(
                    "dipendenza circolare: il nodo '{}' legge il dataset '{}', \
                     ma il Materialize che lo pubblica ('{}') è a valle di '{}'. \
                     Il dataset non sarà mai pronto.",
                    consumer, ds_name, producer, consumer));
            }
        }
    }
    Ok(())
}

fn reachable(adj: &HashMap<&str, Vec<&str>>, from: &str, to: &str) -> bool {
    if from == to { return true }
    let mut seen = std::collections::HashSet::new();
    let mut stack = vec![from];
    while let Some(n) = stack.pop() {
        if !seen.insert(n) { continue }
        for &next in adj.get(n).map(|v| v.as_slice()).unwrap_or(&[]) {
            if next == to { return true }
            stack.push(next);
        }
    }
    false
}
