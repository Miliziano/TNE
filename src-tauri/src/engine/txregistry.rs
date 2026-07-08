// ─── src-tauri/src/engine/txregistry.rs ────────────────────────────
//
// Registro delle transazioni per-lane (design-transazioni-v2, L3 native).
// Approccio B: connessione condivisa. Ogni gruppo native possiede UNA
// connessione (PoolConnection) con BEGIN aperto; i sink membri prendono
// il lock, scrivono su quella connessione (qualsiasi modalità), l'ultimo
// membro (o la fine lane) fa COMMIT/ROLLBACK.
//
// Verificato dal prototipo: Arc<Mutex<PoolConnection>> + execute(&mut **guard)
// regge i tipi sqlx.
//
// Scope attuale: PostgreSQL. MySQL/SQLite native: TODO (stessa struttura).
// XA (multi-risorsa): TODO (Passo 2).

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use sqlx::pool::PoolConnection;
use sqlx::Postgres;

/// Stato di un gruppo transazionale native.
pub struct TxGroup {
    pub mode:          String,   // "native" | "xa"
    pub on_error:      String,   // "rollback_all" | "rollback_self"
    pub timeout:       u64,
    pub members_total: usize,
    pub members_done:  usize,
    pub aborted:       bool,
    /// Connessione condivisa con BEGIN aperto (native, PostgreSQL).
    /// None finché il primo membro non la apre.
    pub pg_conn:       Option<Arc<Mutex<PoolConnection<Postgres>>>>,
    /// true dopo COMMIT/ROLLBACK: evita doppia finalizzazione.
    pub finalized:     bool,
}

pub struct LaneTransactions {
    groups: Mutex<HashMap<String, TxGroup>>,
}

impl LaneTransactions {
    /// Costruisce il registro dai gruppi DICHIARATI nella lane, con il
    /// numero di membri già noto (nodi con quel transactionId).
    pub fn new(declared: Vec<(String, String, String, u64, usize)>) -> Arc<LaneTransactions> {
        // declared: (group_id, mode, on_error, timeout, members_total)
        let mut map = HashMap::new();
        for (id, mode, on_error, timeout, total) in declared {
            map.insert(id, TxGroup {
                mode, on_error, timeout,
                members_total: total,
                members_done:  0,
                aborted:       false,
                pg_conn:       None,
                finalized:     false,
            });
        }
        Arc::new(LaneTransactions { groups: Mutex::new(map) })
    }

    pub fn is_empty(&self) -> bool {
        // usato per short-circuit quando nessun gruppo è dichiarato
        false // la mappa è piccola; il check reale avviene in get_conn
    }

    /// Ottiene (o apre) la connessione condivisa del gruppo native su
    /// PostgreSQL. La prima chiamata acquisisce una connessione dal pool
    /// della risorsa ed esegue BEGIN. Le successive riusano quella.
    pub async fn get_pg_conn(
        &self,
        group_id: &str,
        pool: &sqlx::postgres::PgPool,
    ) -> Result<Arc<Mutex<PoolConnection<Postgres>>>, String> {
        let mut groups = self.groups.lock().await;
        let g = groups.get_mut(group_id)
            .ok_or_else(|| format!("transazione '{}' non dichiarata nella lane", group_id))?;

        if let Some(ref c) = g.pg_conn {
            return Ok(c.clone());
        }
        // Prima apertura: acquire + BEGIN
        let mut conn = pool.acquire().await
            .map_err(|e| format!("tx '{}': acquire fallito: {}", group_id, e))?;
        sqlx::query("BEGIN").execute(&mut *conn).await
            .map_err(|e| format!("tx '{}': BEGIN fallito: {}", group_id, e))?;
        let shared = Arc::new(Mutex::new(conn));
        g.pg_conn = Some(shared.clone());
        eprintln!("[tx] gruppo '{}': BEGIN (native)", group_id);
        Ok(shared)
    }

   /// Un membro ha finito. NON finalizza più qui: la decisione
    /// commit/rollback è rimandata a fine lane (finalize_with_outcome),
    /// quando si conosce l'esito COMPLETO della lane (source inclusi).
    /// Elimina la race del commit prematuro.
    pub async fn report_member_end(&self, group_id: &str, ok: bool) {
        let mut groups = self.groups.lock().await;
        if let Some(g) = groups.get_mut(group_id) {
            g.members_done += 1;
            if !ok { g.aborted = true; }
        }
    }

  
    /// Finalizza TUTTI i gruppi a fine lane, guidata dall'esito globale.
    /// - lane_ok && gruppo non aborted → COMMIT
    /// - altrimenti → ROLLBACK
    /// Chiamata da execute_lane DOPO aver atteso tutti i nodi, quindi
    /// conosce l'esito reale (source e non-membri inclusi).
    pub async fn finalize_with_outcome(&self, lane_ok: bool) {
        let mut groups = self.groups.lock().await;
        for (id, g) in groups.iter_mut() {
            if g.finalized { continue; }
            g.finalized = true;
            let do_commit = lane_ok && !g.aborted;
            if let Some(conn) = g.pg_conn.take() {
                let mut guard = conn.lock().await;
                let sql = if do_commit { "COMMIT" } else { "ROLLBACK" };
                match sqlx::query(sql).execute(&mut **guard).await {
                    Ok(_)  => eprintln!("[tx] gruppo '{}': {} (lane_ok={}, aborted={})", id, sql, lane_ok, g.aborted),
                    Err(e) => eprintln!("[tx] gruppo '{}': {} FALLITO: {}", id, sql, e),
                }
            }
        }
    }
}
