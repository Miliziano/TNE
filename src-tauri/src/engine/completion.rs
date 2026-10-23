// ─── src-tauri/src/engine/completion.rs ────────────────────────────
//
// Registro di COMPLETAMENTO dei nodi di una lane, più la topologia
// (gli archi) per calcolare cosa sta a valle di un'uscita.
//
// Nasce per la modalità "ordered with wait" del Filter: il ramo #N
// parte solo quando l'intera sotto-pipeline del ramo #N-1 ha finito.
// Per saperlo serve (a) l'insieme dei nodi raggiungibili da un handle
// di uscita e (b) un segnale "il task di quel nodo è terminato".
//
// Il segnale lo dà l'executor: nel wrapper di spawn tiene una guardia
// (`DoneGuard`) che alla Drop marca il nodo come terminato — vale per
// l'esito ok, per l'errore e anche per l'abort del task (la future
// viene droppata, la guardia con lei). Un nodo abortito risulta
// "terminato senza successo".
//
// Nel contesto ISOLATO (anteprima di un nodo) il registro è vuoto:
// nessun nodo a valle, nessuna attesa.

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;
use tokio::sync::watch;

/// Stato di un nodo: None = in corso, Some(true) = finito ok,
/// Some(false) = finito in errore / interrotto.
type DoneState = Option<bool>;

pub struct LaneCompletion {
    /// (source_node, source_handle, target_node)
    edges: Vec<(String, String, String)>,
    done:  HashMap<String, watch::Sender<DoneState>>,
}

impl LaneCompletion {
    pub fn new(edges: Vec<(String, String, String)>, node_ids: &[String]) -> Arc<LaneCompletion> {
        let done = node_ids.iter()
            .map(|id| (id.clone(), watch::channel::<DoneState>(None).0))
            .collect();
        Arc::new(LaneCompletion { edges, done })
    }

    /// Registro vuoto (anteprima di un nodo isolato).
    pub fn empty() -> Arc<LaneCompletion> {
        Arc::new(LaneCompletion { edges: Vec::new(), done: HashMap::new() })
    }

    pub fn mark_done(&self, node_id: &str, ok: bool) {
        if let Some(tx) = self.done.get(node_id) {
            tx.send_replace(Some(ok));
        }
    }

    /// Nodi raggiungibili dall'handle di uscita `handle` di `node_id`
    /// (BFS sugli archi; dal secondo livello in poi conta ogni handle).
    pub fn downstream_of(&self, node_id: &str, handle: &str) -> HashSet<String> {
        let mut seen: HashSet<String> = HashSet::new();
        let mut queue: VecDeque<String> = VecDeque::new();
        for (s, h, t) in &self.edges {
            if s == node_id && h == handle && seen.insert(t.clone()) {
                queue.push_back(t.clone());
            }
        }
        while let Some(n) = queue.pop_front() {
            for (s, _, t) in &self.edges {
                if *s == n && seen.insert(t.clone()) {
                    queue.push_back(t.clone());
                }
            }
        }
        // Un ciclo che torna al nodo stesso non è "a valle" di lui:
        // aspettarlo sarebbe aspettare sé stessi.
        seen.remove(node_id);
        seen
    }

    /// Nodi raggiungibili da QUALSIASI uscita di `node_id` (P363: il
    /// dir_watcher ricorda un file solo se la sua valle è finita bene).
    pub fn downstream_all(&self, node_id: &str) -> HashSet<String> {
        let handles: HashSet<&str> = self.edges.iter()
            .filter(|(s, _, _)| s == node_id).map(|(_, h, _)| h.as_str()).collect();
        let mut all = HashSet::new();
        for h in handles { all.extend(self.downstream_of(node_id, h)); }
        all
    }

    /// Attende che TUTTI i nodi indicati abbiano terminato. Restituisce
    /// quelli terminati senza successo (errore o interruzione), ordinati.
    /// Un id sconosciuto al registro è ignorato.
    pub async fn wait_all(&self, nodes: &HashSet<String>) -> Vec<String> {
        let mut failed = Vec::new();
        for id in nodes {
            let Some(tx) = self.done.get(id) else { continue };
            let mut rx = tx.subscribe();
            let ok = match rx.wait_for(|s| s.is_some()).await {
                Ok(v)  => v.unwrap_or(false),
                Err(_) => false,   // sender droppato: il registro è finito
            };
            if !ok { failed.push(id.clone()); }
        }
        failed.sort();
        failed
    }
}

/// Guardia del wrapper di spawn: marca il nodo terminato quando il task
/// finisce in QUALSIASI modo. `ok` va impostato a true solo sull'esito
/// Ok del nodo; il default (false) copre errore, panic e abort.
pub struct DoneGuard {
    pub registry: Arc<LaneCompletion>,
    pub node_id:  String,
    pub ok:       bool,
}

impl Drop for DoneGuard {
    fn drop(&mut self) {
        self.registry.mark_done(&self.node_id, self.ok);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn e(s: &str, h: &str, t: &str) -> (String, String, String) {
        (s.to_string(), h.to_string(), t.to_string())
    }

    #[test]
    fn downstream_segue_solo_l_handle_di_partenza() {
        let ids: Vec<String> = ["f", "a", "b", "c", "d"].iter().map(|s| s.to_string()).collect();
        let reg = LaneCompletion::new(vec![
            e("f", "c1", "a"), e("a", "out", "b"),
            e("f", "c2", "c"), e("c", "out", "d"),
        ], &ids);
        let d1 = reg.downstream_of("f", "c1");
        assert_eq!(d1, ["a", "b"].iter().map(|s| s.to_string()).collect());
        let d2 = reg.downstream_of("f", "c2");
        assert_eq!(d2, ["c", "d"].iter().map(|s| s.to_string()).collect());
        assert!(reg.downstream_of("f", "reject").is_empty());
    }

    #[tokio::test]
    async fn wait_all_riporta_i_falliti() {
        let ids: Vec<String> = ["a", "b"].iter().map(|s| s.to_string()).collect();
        let reg = LaneCompletion::new(Vec::new(), &ids);
        {
            let mut g = DoneGuard { registry: reg.clone(), node_id: "a".into(), ok: false };
            g.ok = true;
        }
        { let _g = DoneGuard { registry: reg.clone(), node_id: "b".into(), ok: false }; }
        let set: HashSet<String> = ids.into_iter().collect();
        assert_eq!(reg.wait_all(&set).await, vec!["b".to_string()]);
    }
}
