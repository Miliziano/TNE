// ─── src-tauri/src/engine/pool.rs ──────────────────────────────────
//
// Registro delle connessioni DB per-lane (design L1).
//
// INVARIANTI (docs/design-connessioni-transazioni.md):
//  1. Pool per (lane, risorsa). Nessuna condivisione cross-lane: ogni
//     LaneResources appartiene a UNA esecuzione di execute_lane.
//  2. Chiusura garantita: execute_lane chiama close_all() in OGNI ramo
//     di uscita (ok/err/panic) → a fine lane nessuna connessione resta
//     aperta.
//  3. Una risorsa = un pool. Più nodi DB della stessa lane sulla stessa
//     risorsa RIUSANO lo stesso pool invece di aprire connessioni
//     separate (era il problema: 21 punti che facevano connect()).
//
// CONCETTI RUST:
//  - `Arc<LaneResources>` nel NodeContext (che è Clone): i nodi
//    condividono lo stesso registro a costo di un clone di puntatore.
//  - `tokio::sync::Mutex` (non std::Mutex): il lock è tenuto attraverso
//    un .await (la creazione del pool è async), cosa che lo std Mutex
//    non permette in un task tokio.
//  - Il pool sqlx è già internamente condivisibile e clonabile
//    (Pool<DB> è un Arc dentro): restituiamo un clone del pool, non un
//    riferimento legato al lock.

use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;
use sqlx::postgres::PgPool;
use sqlx::mysql::MySqlPool;
use sqlx::sqlite::SqlitePool;

/// Un pool tipizzato per dialetto. Clone = clone di Arc interno sqlx.
#[derive(Clone)]
pub enum DbPool {
    Pg(PgPool),
    My(MySqlPool),
    Sqlite(SqlitePool),
}

/// Parametri per creare un pool. Derivati dalla risorsa (spec.resource)
/// dal nodo chiamante, che già sa costruire la connection string.
pub struct PoolParams {
    pub dialect:         String,
    pub conn_str:        String,
    /// Numero massimo di connessioni del pool. Fuori da un gruppo
    /// transazionale può essere >1 (throughput). Dentro un gruppo, la
    /// regola "una risorsa = una connessione" impone 1 (L3).
    pub max_connections: u32,
    pub connect_timeout: u64,
}

pub struct LaneResources {
    // resource_id → pool. Mutex perché la creazione è pigra e concorrente
    // (più nodi possono chiedere lo stesso pool insieme).
    pools: Mutex<HashMap<String, DbPool>>,
}

impl LaneResources {
    pub fn new() -> Arc<LaneResources> {
        Arc::new(LaneResources { pools: Mutex::new(HashMap::new()) })
    }

    /// Restituisce il pool per la risorsa, creandolo al primo uso.
    /// I nodi successivi sulla stessa risorsa riusano lo stesso pool.
    /// `resource_id` vuoto NON è ammesso qui: il nodo deve garantire
    /// una risorsa valida prima di chiamare.
    pub async fn pool(&self, resource_id: &str, params: PoolParams) -> Result<DbPool, String> {
        {
            // Fast path: già presente.
            let guard = self.pools.lock().await;
            if let Some(p) = guard.get(resource_id) {
                return Ok(p.clone());
            }
        }
        // Slow path: crea. Ri-controlla dopo il lock (un altro task
        // potrebbe averlo creato nel frattempo).
        let pool = build_pool(&params).await?;
        let mut guard = self.pools.lock().await;
        if let Some(p) = guard.get(resource_id) {
            return Ok(p.clone());
        }
        guard.insert(resource_id.to_string(), pool.clone());
        Ok(pool)
    }

    /// Chiude TUTTI i pool della lane. Idempotente. Chiamato da
    /// execute_lane in ogni ramo di uscita: è l'invariante 2.
    pub async fn close_all(&self) {
        let pools: Vec<(String, DbPool)> = {
            let mut guard = self.pools.lock().await;
            guard.drain().collect()
        };
        for (rid, p) in pools {
            match p {
                DbPool::Pg(pool)     => pool.close().await,
                DbPool::My(pool)     => pool.close().await,
                DbPool::Sqlite(pool) => pool.close().await,
            }
            eprintln!("[pool] lane: chiusa risorsa '{}'", rid);
        }
    }
}

async fn build_pool(params: &PoolParams) -> Result<DbPool, String> {
    let max = params.max_connections.max(1);
    let to  = std::time::Duration::from_secs(params.connect_timeout.max(1));
    match params.dialect.as_str() {
        "postgresql" => {
            let pool = sqlx::postgres::PgPoolOptions::new()
                .max_connections(max)
                .acquire_timeout(to)
                .connect(&params.conn_str).await
                .map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;
            Ok(DbPool::Pg(pool))
        }
        "mysql" => {
            let pool = sqlx::mysql::MySqlPoolOptions::new()
                .max_connections(max)
                .acquire_timeout(to)
                .connect(&params.conn_str).await
                .map_err(|e| format!("MySQL connessione fallita: {}", e))?;
            Ok(DbPool::My(pool))
        }
        "sqlite" => {
            let pool = sqlx::sqlite::SqlitePoolOptions::new()
                .max_connections(max)
                .acquire_timeout(to)
                .connect(&params.conn_str).await
                .map_err(|e| format!("SQLite connessione fallita: {}", e))?;
            Ok(DbPool::Sqlite(pool))
        }
        d => Err(format!("Dialetto '{}' non supportato", d)),
    }
}
