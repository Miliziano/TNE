// ─── src-tauri/src/engine/txregistry.rs ────────────────────────────
//
// Registro delle transazioni per-lane (design-transazioni-v2 + design-xa).
//
// NATIVE: 1 gruppo = 1 risorsa = 1 connessione = 1 BEGIN…COMMIT.
//         Il DB garantisce l'atomicità.
// XA:     1 gruppo = N risorse (DB diversi) = N connessioni = N transazioni
//         locali. L'atomicità la garantisce il coordinatore con il
//         two-phase commit (PREPARE TRANSACTION → COMMIT PREPARED).
//
// Struttura unificata: il gruppo tiene una mappa resource_id → connessione.
// Native è il caso degenere con una sola entry.
//
// Approccio B: i membri scrivono sulla connessione condivisa della loro
// risorsa, serializzati dal lock, con savepoint per-chunk.
//
// Regola TUTTO-O-NIENTE: se un membro fallisce, il gruppo fa rollback
// totale. Un nodo FUORI dal gruppo che fallisce non lo tocca.
//
// Scope: PostgreSQL. MySQL/SQLite: TODO.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use sqlx::pool::PoolConnection;
use sqlx::Postgres;

type SharedConn = Arc<Mutex<PoolConnection<Postgres>>>;

/// Stato di un gruppo transazionale (native o xa).
pub struct TxGroup {
    pub mode:          String,   // "native" | "xa"
    pub on_error:      String,   // modello: sempre tutto-o-niente
    pub timeout:       u64,
    pub members_total: usize,
    pub members_done:  usize,
    pub aborted:       bool,
    pub finalized:     bool,
    /// Connessione con BEGIN aperto, PER RISORSA.
    /// Native: una sola entry. XA: una per ogni DB coinvolto.
    pub conns:         HashMap<String, SharedConn>,
    /// XA: gid (global id) assegnato alla transazione di ogni risorsa.
    pub gids:          HashMap<String, String>,
}

impl TxGroup {
    fn is_xa(&self) -> bool { self.mode == "xa" }
}

pub struct LaneTransactions {
    groups: Mutex<HashMap<String, TxGroup>>,
    /// Serve a costruire gid univoci per le transazioni XA.
    run_id: String,
}

impl LaneTransactions {
    /// Costruisce il registro dai gruppi DICHIARATI nella lane, con il
    /// numero di membri già noto (nodi con quel transactionId).
    pub fn new(
        declared: Vec<(String, String, String, u64, usize)>,
        run_id:   String,
    ) -> Arc<LaneTransactions> {
        // declared: (group_id, mode, on_error, timeout, members_total)
        let mut map = HashMap::new();
        for (id, mode, on_error, timeout, total) in declared {
            map.insert(id, TxGroup {
                mode, on_error, timeout,
                members_total: total,
                members_done:  0,
                aborted:       false,
                finalized:     false,
                conns:         HashMap::new(),
                gids:          HashMap::new(),
            });
        }
        Arc::new(LaneTransactions { groups: Mutex::new(map), run_id })
    }

    /// Ottiene (o apre) la connessione del gruppo PER LA RISORSA indicata.
    /// - Native: tutti i membri hanno la stessa risorsa → una sola conn.
    /// - XA: ogni risorsa ha la sua conn (e il suo gid).
    /// La prima chiamata per una risorsa acquisisce una connessione dal suo
    /// pool ed esegue BEGIN. Le successive riusano quella.
    pub async fn get_pg_conn(
        &self,
        group_id:    &str,
        resource_id: &str,
        pool:        &sqlx::postgres::PgPool,
    ) -> Result<SharedConn, String> {
        let mut groups = self.groups.lock().await;
        let run_id = self.run_id.clone();
        let g = groups.get_mut(group_id)
            .ok_or_else(|| format!("transazione '{}' non dichiarata nella lane", group_id))?;

        // Native: vietato coinvolgere più risorse (servirebbe XA).
        if !g.is_xa() && !g.conns.is_empty() && !g.conns.contains_key(resource_id) {
            return Err(format!(
                "transazione '{}' è native ma coinvolge più risorse: usa la stessa \
                 risorsa per tutti i membri, oppure passa a XA",
                group_id
            ));
        }

        if let Some(c) = g.conns.get(resource_id) {
            return Ok(c.clone());
        }

        let mut conn = pool.acquire().await
            .map_err(|e| format!("tx '{}': acquire fallito ({}): {}", group_id, resource_id, e))?;
        sqlx::query("BEGIN").execute(&mut *conn).await
            .map_err(|e| format!("tx '{}': BEGIN fallito ({}): {}", group_id, resource_id, e))?;

        let shared: SharedConn = Arc::new(Mutex::new(conn));
        g.conns.insert(resource_id.to_string(), shared.clone());

        if g.is_xa() {
            let gid = make_gid(&run_id, group_id, resource_id);
            eprintln!("[xa] gruppo '{}' risorsa '{}': BEGIN — gid='{}'", group_id, resource_id, gid);
            g.gids.insert(resource_id.to_string(), gid);
        } else {
            eprintln!("[tx] gruppo '{}': BEGIN (native, risorsa '{}')", group_id, resource_id);
        }
        Ok(shared)
    }

    /// Un membro ha concluso. La decisione commit/rollback è rimandata a
    /// fine lane (finalize_with_outcome): elimina la race del commit
    /// prematuro. Se il membro è fallito, il gruppo va in abort.
    pub async fn report_member_end(&self, group_id: &str, ok: bool) {
        let mut groups = self.groups.lock().await;
        if let Some(g) = groups.get_mut(group_id) {
            g.members_done += 1;
            if !ok { g.aborted = true; }
        }
    }

    /// Finalizza TUTTI i gruppi a fine lane.
    /// Regola tutto-o-niente: commit solo se NESSUN membro del gruppo è
    /// fallito. Un nodo fuori dal gruppo che fallisce NON lo influenza
    /// (per questo `lane_ok` non entra nella decisione).
    pub async fn finalize_with_outcome(&self, _lane_ok: bool) {
        let mut groups = self.groups.lock().await;
        for (id, g) in groups.iter_mut() {
            if g.finalized { continue; }
            g.finalized = true;
            let do_commit = !g.aborted;

            if g.is_xa() {
                finalize_xa(id, g, do_commit).await;
            } else {
                finalize_native(id, g, do_commit).await;
            }
        }
    }
}

// ─── Native: COMMIT/ROLLBACK sulla singola connessione ─────────────

async fn finalize_native(group_id: &str, g: &mut TxGroup, do_commit: bool) {
    let sql = if do_commit { "COMMIT" } else { "ROLLBACK" };
    for (rid, conn) in g.conns.drain() {
        let mut guard = conn.lock().await;
        match sqlx::query(sql).execute(&mut **guard).await {
            Ok(_)  => eprintln!("[tx] gruppo '{}': {} (aborted={}, risorsa '{}')",
                                group_id, sql, g.aborted, rid),
            Err(e) => eprintln!("[tx] gruppo '{}': {} FALLITO ({}): {}", group_id, sql, rid, e),
        }
    }
}

// ─── XA: two-phase commit ──────────────────────────────────────────
//
// FASE 1 (PREPARE): ogni risorsa persiste le modifiche e promette di
//   poterle committare. La transazione diventa "in doubt".
//   Il gid è loggato PRIMA del comando: è l'unica traccia per ripulire
//   se il coordinatore muore tra le due fasi.
// FASE 2 (COMMIT/ROLLBACK PREPARED): se tutte hanno preparato → commit
//   di tutte; se anche una ha fallito → rollback delle preparate.

async fn finalize_xa(group_id: &str, g: &mut TxGroup, do_commit: bool) {
    let conns: Vec<(String, SharedConn)> = g.conns.drain().collect();

    // Un membro è fallito: niente 2PC, rollback diretto di tutte.
    if !do_commit {
        for (rid, conn) in conns {
            let mut guard = conn.lock().await;
            let _ = sqlx::query("ROLLBACK").execute(&mut **guard).await;
            eprintln!("[xa] gruppo '{}' risorsa '{}': ROLLBACK (membro fallito)", group_id, rid);
        }
        return;
    }

    // ── FASE 1: PREPARE su ogni risorsa ──
    let mut prepared: Vec<(String, String, SharedConn)> = Vec::new();  // (rid, gid, conn)
    let mut not_prepared: Vec<(String, SharedConn)> = Vec::new();
    let mut phase1_ok = true;

    for (rid, conn) in conns {
        if !phase1_ok { not_prepared.push((rid, conn)); continue; }

        let gid = match g.gids.get(&rid) {
            Some(x) => x.clone(),
            None => { phase1_ok = false; not_prepared.push((rid, conn)); continue; }
        };

        // Il gid va loggato PRIMA: se crashiamo ora, è l'unica traccia.
        eprintln!("[xa] gruppo '{}': PREPARE TRANSACTION '{}' (risorsa '{}')", group_id, gid, rid);

        let res = {
            let mut guard = conn.lock().await;
            sqlx::query(&format!("PREPARE TRANSACTION '{}'", gid)).execute(&mut **guard).await
        };
        match res {
            Ok(_)  => prepared.push((rid, gid, conn)),
            Err(e) => {
                let hint = if e.to_string().contains("max_prepared_transactions") {
                    " — XA richiede 'max_prepared_transactions > 0' in postgresql.conf (poi riavvia il server)"
                } else { "" };
                eprintln!("[xa] gruppo '{}': PREPARE FALLITO (risorsa '{}'): {}{}", group_id, rid, e, hint);
                phase1_ok = false;
                not_prepared.push((rid, conn));
            }
        }
    }

    // ── FASE 2 ──
    if phase1_ok {
        for (rid, gid, conn) in prepared {
            let mut guard = conn.lock().await;
            match sqlx::query(&format!("COMMIT PREPARED '{}'", gid)).execute(&mut **guard).await {
                Ok(_)  => eprintln!("[xa] gruppo '{}': COMMIT PREPARED '{}' (risorsa '{}')", group_id, gid, rid),
                Err(e) => eprintln!("[xa] gruppo '{}': COMMIT PREPARED '{}' FALLITO: {} — \
                                     transazione IN DOUBT, risolvere a mano", group_id, gid, e),
            }
        }
    } else {
        // Fase 1 fallita: rollback delle preparate + delle non preparate.
        for (rid, gid, conn) in prepared {
            let mut guard = conn.lock().await;
            match sqlx::query(&format!("ROLLBACK PREPARED '{}'", gid)).execute(&mut **guard).await {
                Ok(_)  => eprintln!("[xa] gruppo '{}': ROLLBACK PREPARED '{}' (risorsa '{}')", group_id, gid, rid),
                Err(e) => eprintln!("[xa] gruppo '{}': ROLLBACK PREPARED '{}' FALLITO: {} — \
                                     transazione IN DOUBT, risolvere a mano", group_id, gid, e),
            }
        }
        for (rid, conn) in not_prepared {
            let mut guard = conn.lock().await;
            let _ = sqlx::query("ROLLBACK").execute(&mut **guard).await;
            eprintln!("[xa] gruppo '{}' risorsa '{}': ROLLBACK (non preparata)", group_id, rid);
        }
    }
}

/// gid univoco e valido per PostgreSQL (≤ 200 char, solo alfanumerici/_).
/// Prefisso 'fp_' per riconoscere i residui di FlowPilot in
/// `SELECT gid FROM pg_prepared_xacts`.
fn make_gid(run_id: &str, group_id: &str, resource_id: &str) -> String {
    let san = |s: &str| s.replace(|c: char| !c.is_alphanumeric() && c != '_', "_");
    let raw = format!("fp_{}_{}_{}", san(run_id), san(group_id), san(resource_id));
    raw.chars().take(200).collect()
}