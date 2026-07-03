/**
 * src-tauri/src/db_transactions.rs
 *
 * Transazioni native — registro connessioni persistenti.
 * Vedi db_transactions_integration.md per l'integrazione in lib.rs.
 */

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::Mutex;

use crate::{
  DbConnectionParams, DbWriteRequest, DbWriteResult,
  build_connection_string, qualified_table, extract_row_data, bind_pg_value,
  build_column_plan, PlaceholderStyle, count_consumed_placeholders,
};

// ─── Registro connessioni transazionali ───────────────────────────
//
// Una transazione di gruppo (transactionGroup, mode: 'native') mantiene
// UNA connessione DB aperta (stessa risorsa per tutti i membri — vincolo
// già validato da TX_NATIVE_RESOURCE_MISMATCH in dagValidation.ts) tra
// db_tx_begin e db_tx_commit/db_tx_rollback.
//
// Pattern: come WEBHOOK_SERVERS/WEBHOOK_RESPONDERS in lib.rs — registro
// globale dietro OnceLock<Mutex<HashMap<...>>>. La PoolConnection<DB> è
// 'static (il Pool sottostante resta vivo via Arc anche se la variabile
// locale `pool` esce di scope), quindi può essere spostata nel registro.
//
// Locking: il Mutex std non viene MAI tenuto attraverso un .await — le
// operazioni async fanno remove() dal registro (ownership), eseguono,
// poi re-insert().

enum TxConnection {
  Pg(sqlx::pool::PoolConnection<sqlx::Postgres>),
  MySql(sqlx::pool::PoolConnection<sqlx::MySql>),
  Sqlite(sqlx::pool::PoolConnection<sqlx::Sqlite>),
}

static TX_REGISTRY: std::sync::OnceLock<Mutex<HashMap<String, TxConnection>>> = std::sync::OnceLock::new();
fn tx_registry() -> &'static Mutex<HashMap<String, TxConnection>> {
  TX_REGISTRY.get_or_init(|| Mutex::new(HashMap::new()))
}

// ─── db_tx_begin ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DbTxBeginRequest {
  #[serde(rename = "txId")]
  tx_id:      String,
  connection: DbConnectionParams,
}

/// Apre una connessione e avvia una transazione, registrandola sotto txId.
/// Idempotente: se txId esiste già (un altro membro del gruppo l'ha già
/// avviata), non fa nulla — i membri successivi condividono la stessa
/// connessione/transazione.
#[tauri::command]
pub async fn db_tx_begin(request: DbTxBeginRequest) -> Result<(), String> {
  {
    let reg = tx_registry().lock().unwrap();
    if reg.contains_key(&request.tx_id) { return Ok(()); }
  }

  let conn_str = build_connection_string(&request.connection)?;

  match request.connection.dialect.as_str() {
    "postgresql" => {
      use sqlx::postgres::PgPoolOptions;
      let pool = PgPoolOptions::new().max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&conn_str).await
        .map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;
      let mut conn = pool.acquire().await.map_err(|e| format!("PostgreSQL acquire fallito: {}", e))?;
      sqlx::query("BEGIN").execute(&mut *conn).await
        .map_err(|e| format!("BEGIN fallito: {}", e))?;
      tx_registry().lock().unwrap().insert(request.tx_id, TxConnection::Pg(conn));
    }
    "mysql" => {
      use sqlx::mysql::MySqlPoolOptions;
      let pool = MySqlPoolOptions::new().max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&conn_str).await
        .map_err(|e| format!("MySQL connessione fallita: {}", e))?;
      let mut conn = pool.acquire().await.map_err(|e| format!("MySQL acquire fallito: {}", e))?;
      sqlx::query("START TRANSACTION").execute(&mut *conn).await
        .map_err(|e| format!("START TRANSACTION fallito: {}", e))?;
      tx_registry().lock().unwrap().insert(request.tx_id, TxConnection::MySql(conn));
    }
    "sqlite" => {
      use sqlx::sqlite::SqlitePoolOptions;
      let pool = SqlitePoolOptions::new().max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&conn_str).await
        .map_err(|e| format!("SQLite connessione fallita: {}", e))?;
      let mut conn = pool.acquire().await.map_err(|e| format!("SQLite acquire fallito: {}", e))?;
      // BEGIN IMMEDIATE — acquisisce il lock di scrittura subito,
      // evita "database is locked" a metà transazione su scritture successive.
      sqlx::query("BEGIN IMMEDIATE").execute(&mut *conn).await
        .map_err(|e| format!("BEGIN IMMEDIATE fallito: {}", e))?;
      tx_registry().lock().unwrap().insert(request.tx_id, TxConnection::Sqlite(conn));
    }
    d => return Err(format!("Dialetto '{}' non supporta transazioni native", d)),
  }

  Ok(())
}

// ─── db_tx_write ───────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DbTxWriteRequest {
  #[serde(rename = "txId")]
  tx_id: String,
  #[serde(flatten)]
  write: DbWriteRequest,
}

/// Esegue una scrittura sulla connessione/transazione già aperta per txId.
/// Stessa logica SQL di db_write (insert/upsert/update/delete/...), ma
/// SENZA apertura pool, BEGIN o COMMIT/close — opera sulla connessione
/// esistente e la lascia aperta per il prossimo membro o per db_tx_commit.
#[tauri::command]
pub async fn db_tx_write(request: DbTxWriteRequest) -> Result<DbWriteResult, String> {
  let mut entry = {
    let mut reg = tx_registry().lock().unwrap();
    reg.remove(&request.tx_id)
      .ok_or_else(|| format!("Transazione '{}' non trovata o già chiusa", request.tx_id))?
  };

  let start  = std::time::Instant::now();
  let result = match &mut entry {
    TxConnection::Pg(conn)     => pg_tx_write(conn, &request.write, start).await,
    TxConnection::MySql(conn)  => mysql_tx_write(conn, &request.write, start).await,
    TxConnection::Sqlite(conn) => sqlite_tx_write(conn, &request.write, start).await,
  };

  // Rimette la connessione nel registro indipendentemente dall'esito —
  // il coordinatore TS deciderà se chiamare db_tx_commit o db_tx_rollback.
  tx_registry().lock().unwrap().insert(request.tx_id, entry);

  result
}

// ─── db_tx_commit / db_tx_rollback ─────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DbTxFinishRequest {
  #[serde(rename = "txId")]
  tx_id: String,
}

#[tauri::command]
pub async fn db_tx_commit(request: DbTxFinishRequest) -> Result<(), String> {
  finish_tx(request.tx_id, "COMMIT").await
}

#[tauri::command]
pub async fn db_tx_rollback(request: DbTxFinishRequest) -> Result<(), String> {
  finish_tx(request.tx_id, "ROLLBACK").await
}

/// Idempotente: se txId non esiste (già chiusa, o mai iniziata perché
/// un membro precedente ha fallito durante db_tx_begin), non è un errore.
async fn finish_tx(tx_id: String, sql: &str) -> Result<(), String> {
  let entry = { tx_registry().lock().unwrap().remove(&tx_id) };
  let Some(entry) = entry else { return Ok(()) };

  match entry {
    TxConnection::Pg(mut conn) => {
      sqlx::query(sql).execute(&mut *conn).await
        .map_err(|e| format!("{} fallito (postgresql, tx '{}'): {}", sql, tx_id, e))?;
    }
    TxConnection::MySql(mut conn) => {
      sqlx::query(sql).execute(&mut *conn).await
        .map_err(|e| format!("{} fallito (mysql, tx '{}'): {}", sql, tx_id, e))?;
    }
    TxConnection::Sqlite(mut conn) => {
      sqlx::query(sql).execute(&mut *conn).await
        .map_err(|e| format!("{} fallito (sqlite, tx '{}'): {}", sql, tx_id, e))?;
    }
  }
  // `conn` esce di scope qui — torna al pool (che si chiude da solo,
  // non avendo più referenze) o viene chiuso.
  Ok(())
}

// ─── pg_tx_write / mysql_tx_write / sqlite_tx_write ────────────────
// Stessa logica di costruzione SQL di pg_write/mysql_write/sqlite_write
// (in lib.rs), ma operano su &mut PoolConnection (la transazione
// condivisa) invece che su &Pool, e NON gestiscono pre/post
// BEGIN/COMMIT/close — quelli sono a carico di
// db_tx_begin/db_tx_commit/db_tx_rollback.
//
// Aggiornate per supportare column_functions (es. NOW(), MD5({v})) —
// stesso schema di build_column_plan usato in lib.rs: per i modi
// insert/truncate_insert/upsert costruiamo il piano colonne via
// build_column_plan; il modo update lo usa SOLO per il SET (colonne
// non-chiave), mentre il WHERE resta posizionale puro sulle
// key_fields, continuando la numerazione da dove si è fermato il SET
// (vedi count_consumed_placeholders). delete resta sulla vecchia
// logica posizionale, dato che le funzioni non si applicano alle
// condizioni WHERE.

pub(crate) async fn pg_tx_write(
    conn:  &mut sqlx::pool::PoolConnection<sqlx::Postgres>,
    req:   &DbWriteRequest,
    start: std::time::Instant,
) -> Result<DbWriteResult, String> {
    use sqlx::Row as SqlxRow;

    let tbl = crate::qualified_table(req);
    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    let ret_col = req.returning_column.as_deref();
    let use_returning = ret_col.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(&mut **conn).await
                    .map_err(|e| format!("Pre-SQL fallito: {}", e))?;
            }
        }
    }
    if req.mode == "truncate_insert" {
        sqlx::query(&format!("TRUNCATE TABLE {}", tbl)).execute(&mut **conn).await
            .map_err(|e| format!("TRUNCATE fallito: {}", e))?;
    }

    for chunk in req.rows.chunks(req.batch_size.max(1)) {
        batches += 1;
        for row in chunk {
            let fields = extract_row_data(row, &req.columns, &req.exclude_columns);
            if fields.is_empty() { skipped += 1; continue; }

            let default_keys = vec!["id".to_string()];
            let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());
            let needs_plan = matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

            let set_fields: Vec<(String, serde_json::Value)> = fields.iter()
                .filter(|(k, _)| !keys.contains(k))
                .cloned()
                .collect();

            let sql: String;
            let mut bind_list: Vec<&serde_json::Value>;

            if needs_plan {
                let plan = build_column_plan(&fields, &req.column_functions, PlaceholderStyle::Dollar, 1);
                let cols = plan.iter().map(|p| p.column_sql.as_str()).collect::<Vec<_>>().join(", ");
                let vals = plan.iter().map(|p| p.value_sql.as_str()).collect::<Vec<_>>().join(", ");
                bind_list = plan.iter().filter_map(|p| p.bind_value).collect();

                let base_sql = match req.mode.as_str() {
                    "upsert" => {
                        let updates = plan.iter()
                            .filter(|p| !keys.contains(&p.column_sql))
                            .map(|p| format!("{} = EXCLUDED.{}", p.column_sql, p.column_sql))
                            .collect::<Vec<_>>().join(", ");
                        let conflict = keys.join(", ");
                        if updates.is_empty() {
                            format!("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO NOTHING", tbl, cols, vals, conflict)
                        } else {
                            format!("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO UPDATE SET {}", tbl, cols, vals, conflict, updates)
                        }
                    }
                    _ => format!("INSERT INTO {} ({}) VALUES ({})", tbl, cols, vals),
                };

                sql = if use_returning {
                    format!("{} RETURNING \"{}\"", base_sql, ret_col.unwrap())
                } else {
                    base_sql
                };
            } else if req.mode == "update" {
                let set_plan = build_column_plan(&set_fields, &req.column_functions, PlaceholderStyle::Dollar, 1);
                let sets = set_plan.iter()
                    .map(|p| format!("{} = {}", p.column_sql, p.value_sql))
                    .collect::<Vec<_>>().join(", ");
                let where_start = count_consumed_placeholders(&set_plan) + 1;
                let where_c = keys.iter().enumerate()
                    .map(|(i, k)| format!("{} = ${}", k, where_start + i))
                    .collect::<Vec<_>>().join(" AND ");
                sql = format!("UPDATE {} SET {} WHERE {}", tbl, sets, where_c);
                bind_list = set_plan.iter().filter_map(|p| p.bind_value).collect();
                for k in keys {
                    if let Some((_, v)) = fields.iter().find(|(fk, _)| fk == k) {
                        bind_list.push(v);
                    }
                }
            } else {
                let where_c = keys.iter().enumerate()
                    .map(|(i, k)| format!("{} = ${}", k, i + 1))
                    .collect::<Vec<_>>().join(" AND ");
                sql = format!("DELETE FROM {} WHERE {}", tbl, where_c);
                bind_list = keys.iter()
                    .filter_map(|k| fields.iter().find(|(fk, _)| fk == k).map(|(_, v)| v))
                    .collect();
            }

            if use_returning && needs_plan {
                let mut q = sqlx::query(&sql);
                for v in &bind_list { q = bind_pg_value(q, v); }
                match q.fetch_one(&mut **conn).await {
                    Ok(row) => {
                        written += 1;
                        let key_val = pg_tx_row_to_json(&row);
                        generated_keys.push(key_val);
                    }
                    Err(e) => match req.on_constraint_error.as_str() {
                        "skip" => { skipped += 1; }
                        "stop" => return Err(format!("SinkDB errore riga (transazione): {}", e)),
                        _ => { errors += 1; }
                    }
                }
            } else {
                let mut q = sqlx::query(&sql);
                for v in &bind_list { q = bind_pg_value(q, v); }
                match q.execute(&mut **conn).await {
                    Ok(_) => { written += 1; }
                    Err(e) => match req.on_constraint_error.as_str() {
                        "skip" => { skipped += 1; }
                        "stop" => return Err(format!("SinkDB errore riga (transazione): {}", e)),
                        _ => { errors += 1; }
                    }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(&mut **conn).await
                    .map_err(|e| format!("Post-SQL fallito: {}", e))?;
            }
        }
    }

    Ok(DbWriteResult {
        rows_written: written,
        rows_skipped: skipped,
        rows_errors: errors,
        batches,
        elapsed_ms: start.elapsed().as_millis(),
        generated_keys,
    })
}

fn pg_tx_row_to_json(row: &sqlx::postgres::PgRow) -> serde_json::Value {
    use sqlx::Row as SqlxRow;
    if let Ok(v) = row.try_get::<i64, _>(0) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<i32, _>(0) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<i16, _>(0) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<String, _>(0) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<uuid::Uuid, _>(0) { return serde_json::json!(v.to_string()) }
    serde_json::Value::Null
}


pub(crate) async fn mysql_tx_write(
    conn:  &mut sqlx::pool::PoolConnection<sqlx::MySql>,
    req:   &DbWriteRequest,
    start: std::time::Instant,
  ) -> Result<DbWriteResult, String> {
    use sqlx::Row as SqlxRow;

    let tbl = req.table.clone();
    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    let default_keys = vec!["id".to_string()];
    let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());
    let use_returning = req.returning_column.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(&mut **conn).await
                    .map_err(|e| format!("Pre-SQL fallito: {}", e))?;
            }
        }
    }
    if req.mode == "truncate_insert" {
        sqlx::query(&format!("TRUNCATE TABLE `{}`", tbl)).execute(&mut **conn).await
            .map_err(|e| format!("TRUNCATE fallito: {}", e))?;
    }

    for chunk in req.rows.chunks(req.batch_size.max(1)) {
        batches += 1;
        for row in chunk {
            let fields = extract_row_data(row, &req.columns, &req.exclude_columns);
            if fields.is_empty() { skipped += 1; continue; }

            let needs_plan = matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");
            let sql: String;
            let mut bind_list: Vec<&serde_json::Value>;

            let set_fields: Vec<(String, serde_json::Value)> = fields.iter()
                .filter(|(k, _)| !keys.contains(k))
                .cloned()
                .collect();

            if needs_plan {
                let plan = build_column_plan(&fields, &req.column_functions, PlaceholderStyle::Question, 1);
                let cols = plan.iter().map(|p| format!("`{}`", p.column_sql)).collect::<Vec<_>>().join(", ");
                let vals = plan.iter().map(|p| p.value_sql.as_str()).collect::<Vec<_>>().join(", ");
                bind_list = plan.iter().filter_map(|p| p.bind_value).collect();
                sql = match req.mode.as_str() {
                    "upsert" => {
                        let updates = plan.iter()
                            .map(|p| format!("`{}` = VALUES(`{}`)", p.column_sql, p.column_sql))
                            .collect::<Vec<_>>().join(", ");
                        format!("INSERT INTO `{}` ({}) VALUES ({}) ON DUPLICATE KEY UPDATE {}", tbl, cols, vals, updates)
                    }
                    _ => format!("INSERT INTO `{}` ({}) VALUES ({})", tbl, cols, vals),
                };
            } else if req.mode == "update" {
                let set_plan = build_column_plan(&set_fields, &req.column_functions, PlaceholderStyle::Question, 1);
                let sets = set_plan.iter()
                    .map(|p| format!("`{}` = {}", p.column_sql, p.value_sql))
                    .collect::<Vec<_>>().join(", ");
                let where_c = keys.iter().map(|k| format!("`{}` = ?", k)).collect::<Vec<_>>().join(" AND ");
                sql = format!("UPDATE `{}` SET {} WHERE {}", tbl, sets, where_c);
                bind_list = set_plan.iter().filter_map(|p| p.bind_value).collect();
                for k in keys {
                    if let Some((_, v)) = fields.iter().find(|(fk, _)| fk == k) { bind_list.push(v); }
                }
            } else {
                let where_c = keys.iter().map(|k| format!("`{}` = ?", k)).collect::<Vec<_>>().join(" AND ");
                sql = format!("DELETE FROM `{}` WHERE {}", tbl, where_c);
                bind_list = keys.iter()
                    .filter_map(|k| fields.iter().find(|(fk, _)| fk == k).map(|(_, v)| v))
                    .collect();
            }

            let mut q = sqlx::query(&sql);
            for v in &bind_list {
                q = match v {
                    serde_json::Value::Null      => q.bind(None::<String>),
                    serde_json::Value::Bool(b)   => q.bind(*b),
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() { q.bind(i) }
                        else if let Some(f) = n.as_f64() { q.bind(f) }
                        else { q.bind(n.to_string()) }
                    }
                    serde_json::Value::String(s) => q.bind(s.as_str()),
                    other => q.bind(other.to_string()),
                };
            }

            match q.execute(&mut **conn).await {
                Ok(result) => {
                    written += 1;
                    if use_returning && needs_plan {
                        let last_id = result.last_insert_id();
                        if last_id > 0 {
                            generated_keys.push(serde_json::json!(last_id));
                        }
                    }
                }
                Err(e) => match req.on_constraint_error.as_str() {
                    "skip" => { skipped += 1; }
                    "stop" => return Err(format!("SinkDB errore riga (transazione): {}", e)),
                    _ => { errors += 1; }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(&mut **conn).await
                    .map_err(|e| format!("Post-SQL fallito: {}", e))?;
            }
        }
    }

    Ok(DbWriteResult {
        rows_written: written,
        rows_skipped: skipped,
        rows_errors: errors,
        batches,
        elapsed_ms: start.elapsed().as_millis(),
        generated_keys,
    })
}


// ─── sqlite_tx_write con last_insert_rowid ───────────────────────

pub(crate) async fn sqlite_tx_write(
    conn:  &mut sqlx::pool::PoolConnection<sqlx::Sqlite>,
    req:   &DbWriteRequest,
    start: std::time::Instant,
) -> Result<DbWriteResult, String> {
    let tbl = req.table.clone();
    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    let default_keys = vec!["id".to_string()];
    let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());
    let use_returning = req.returning_column.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(&mut **conn).await
                    .map_err(|e| format!("Pre-SQL fallito: {}", e))?;
            }
        }
    }
    if req.mode == "truncate_insert" {
        sqlx::query(&format!("DELETE FROM {}", tbl)).execute(&mut **conn).await
            .map_err(|e| format!("DELETE fallito: {}", e))?;
    }

    for chunk in req.rows.chunks(req.batch_size.max(1)) {
        batches += 1;
        for row in chunk {
            let fields = extract_row_data(row, &req.columns, &req.exclude_columns);
            if fields.is_empty() { skipped += 1; continue; }

            let needs_plan = matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");
            let sql: String;
            let mut bind_list: Vec<&serde_json::Value>;

            let set_fields: Vec<(String, serde_json::Value)> = fields.iter()
                .filter(|(k, _)| !keys.contains(k))
                .cloned()
                .collect();

            if needs_plan {
                let plan = build_column_plan(&fields, &req.column_functions, PlaceholderStyle::Question, 1);
                let cols = plan.iter().map(|p| p.column_sql.as_str()).collect::<Vec<_>>().join(", ");
                let vals = plan.iter().map(|p| p.value_sql.as_str()).collect::<Vec<_>>().join(", ");
                bind_list = plan.iter().filter_map(|p| p.bind_value).collect();
                sql = match req.mode.as_str() {
                    "upsert" => format!("INSERT OR REPLACE INTO {} ({}) VALUES ({})", tbl, cols, vals),
                    _ => format!("INSERT INTO {} ({}) VALUES ({})", tbl, cols, vals),
                };
            } else if req.mode == "update" {
                let set_plan = build_column_plan(&set_fields, &req.column_functions, PlaceholderStyle::Question, 1);
                let sets = set_plan.iter()
                    .map(|p| format!("{} = {}", p.column_sql, p.value_sql))
                    .collect::<Vec<_>>().join(", ");
                let where_c = keys.iter().map(|k| format!("{} = ?", k)).collect::<Vec<_>>().join(" AND ");
                sql = format!("UPDATE {} SET {} WHERE {}", tbl, sets, where_c);
                bind_list = set_plan.iter().filter_map(|p| p.bind_value).collect();
                for k in keys {
                    if let Some((_, v)) = fields.iter().find(|(fk, _)| fk == k) { bind_list.push(v); }
                }
            } else {
                let where_c = keys.iter().map(|k| format!("{} = ?", k)).collect::<Vec<_>>().join(" AND ");
                sql = format!("DELETE FROM {} WHERE {}", tbl, where_c);
                bind_list = keys.iter()
                    .filter_map(|k| fields.iter().find(|(fk, _)| fk == k).map(|(_, v)| v))
                    .collect();
            }

            let mut q = sqlx::query(&sql);
            for v in &bind_list {
                q = match v {
                    serde_json::Value::Null      => q.bind(None::<String>),
                    serde_json::Value::Bool(b)   => q.bind(*b),
                    serde_json::Value::Number(n) => {
                        if let Some(i) = n.as_i64() { q.bind(i) }
                        else if let Some(f) = n.as_f64() { q.bind(f) }
                        else { q.bind(n.to_string()) }
                    }
                    serde_json::Value::String(s) => q.bind(s.as_str()),
                    other => q.bind(other.to_string()),
                };
            }

            match q.execute(&mut **conn).await {
                Ok(result) => {
                    written += 1;
                    if use_returning && needs_plan {
                        let rowid = result.last_insert_rowid();
                        if rowid > 0 {
                            generated_keys.push(serde_json::json!(rowid));
                        }
                    }
                }
                Err(e) => match req.on_constraint_error.as_str() {
                    "skip" => { skipped += 1; }
                    "stop" => return Err(format!("SinkDB errore riga (transazione): {}", e)),
                    _ => { errors += 1; }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(&mut **conn).await
                    .map_err(|e| format!("Post-SQL fallito: {}", e))?;
            }
        }
    }

    Ok(DbWriteResult {
        rows_written: written,
        rows_skipped: skipped,
        rows_errors: errors,
        batches,
        elapsed_ms: start.elapsed().as_millis(),
        generated_keys,
    })
}

// ═══════════════════════════════════════════════════════════════════
// TRANSAZIONI XA (two-phase commit) — Fase 2
// ═══════════════════════════════════════════════════════════════════
//
// A differenza della modalità 'native' (connessione condivisa tenuta
// aperta in TX_REGISTRY), in modalità XA ogni partecipante prepara la
// PROPRIA transazione sulla PROPRIA risorsa in modo indipendente:
//
//   db_tx_xa_prepare: BEGIN/XA START → scritture → PREPARE TRANSACTION
//                      / XA PREPARE → connessione chiusa.
//                      La transazione preparata persiste nel DB,
//                      indipendente dalla connessione.
//
//   db_tx_xa_finish:  nuova connessione → COMMIT PREPARED / XA COMMIT
//                      (o ROLLBACK PREPARED / XA ROLLBACK) → connessione
//                      chiusa.
//
// Nessun registro di stato necessario qui — il coordinatore TS tiene
// la lista dei partecipanti preparati (nodeId, connection, xid) e
// chiama db_tx_xa_finish per ciascuno nella fase 2.
//
// Dialetti supportati: postgresql, mysql (entrambi via sintassi SQL
// standard, nessuna API driver speciale). sqlite non supporta 2PC.

// ─── db_tx_xa_prepare ──────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DbTxXaPrepareRequest {
  #[serde(rename = "txId")]
  tx_id: String,
  #[serde(flatten)]
  write: DbWriteRequest,
}

#[tauri::command]
pub async fn db_tx_xa_prepare(request: DbTxXaPrepareRequest) -> Result<DbWriteResult, String> {
  let conn_str = build_connection_string(&request.write.connection)?;
  let start    = std::time::Instant::now();
  let xid      = request.tx_id.replace('\'', "''");

  match request.write.connection.dialect.as_str() {
    "postgresql" => pg_xa_prepare(&conn_str, &xid, &request.write, start).await,
    "mysql"      => mysql_xa_prepare(&conn_str, &xid, &request.write, start).await,
    d => Err(format!("Dialetto '{}' non supporta XA two-phase commit", d)),
  }
}

async fn pg_xa_prepare(conn_str: &str, xid: &str, req: &DbWriteRequest, start: std::time::Instant) -> Result<DbWriteResult, String> {
  use sqlx::postgres::PgPoolOptions;
  let pool = PgPoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(30))
    .connect(conn_str).await
    .map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;
  let mut conn = pool.acquire().await.map_err(|e| format!("PostgreSQL acquire fallito: {}", e))?;

  sqlx::query("BEGIN").execute(&mut *conn).await
    .map_err(|e| format!("BEGIN fallito: {}", e))?;

  match pg_tx_write(&mut conn, req, start).await {
    Ok(result) => {
      sqlx::query(&format!("PREPARE TRANSACTION '{}'", xid)).execute(&mut *conn).await
        .map_err(|e| format!("PREPARE TRANSACTION fallita: {}", e))?;
      // conn chiusa qui (drop) — la transazione preparata persiste nel DB
      Ok(result)
    }
    Err(e) => {
      // best-effort: la sessione è in stato di errore, ROLLBACK pulisce
      // prima di chiudere la connessione (nessuna transazione preparata
      // viene lasciata pendente).
      let _ = sqlx::query("ROLLBACK").execute(&mut *conn).await;
      Err(e)
    }
  }
}

async fn mysql_xa_prepare(conn_str: &str, xid: &str, req: &DbWriteRequest, start: std::time::Instant) -> Result<DbWriteResult, String> {
  use sqlx::mysql::MySqlPoolOptions;
  let pool = MySqlPoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(30))
    .connect(conn_str).await
    .map_err(|e| format!("MySQL connessione fallita: {}", e))?;
  let mut conn = pool.acquire().await.map_err(|e| format!("MySQL acquire fallito: {}", e))?;

  sqlx::query(&format!("XA START '{}'", xid)).execute(&mut *conn).await
    .map_err(|e| format!("XA START fallita: {}", e))?;

  match mysql_tx_write(&mut conn, req, start).await {
    Ok(result) => {
      sqlx::query(&format!("XA END '{}'", xid)).execute(&mut *conn).await
        .map_err(|e| format!("XA END fallita: {}", e))?;
      sqlx::query(&format!("XA PREPARE '{}'", xid)).execute(&mut *conn).await
        .map_err(|e| format!("XA PREPARE fallita: {}", e))?;
      Ok(result)
    }
    Err(e) => {
      // best-effort: chiude il branch XA prima di restituire l'errore,
      // altrimenti resta una transazione XA "ACTIVE" pendente sul server.
      let _ = sqlx::query(&format!("XA END '{}'", xid)).execute(&mut *conn).await;
      let _ = sqlx::query(&format!("XA ROLLBACK '{}'", xid)).execute(&mut *conn).await;
      Err(e)
    }
  }
}

// ─── db_tx_xa_finish ────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DbTxXaFinishRequest {
  #[serde(rename = "txId")]
  tx_id:      String,
  connection: DbConnectionParams,
  action:     String,   // "commit" | "rollback"
}

/// Esegue COMMIT PREPARED / XA COMMIT (o ROLLBACK PREPARED / XA ROLLBACK)
/// su una NUOVA connessione — non serve la connessione che ha fatto il
/// prepare, basta che punti alla stessa risorsa/DB.
#[tauri::command]
pub async fn db_tx_xa_finish(request: DbTxXaFinishRequest) -> Result<(), String> {
  let conn_str = build_connection_string(&request.connection)?;
  let xid      = request.tx_id.replace('\'', "''");

  let sql = match request.connection.dialect.as_str() {
    "postgresql" => match request.action.as_str() {
      "commit"   => format!("COMMIT PREPARED '{}'", xid),
      "rollback" => format!("ROLLBACK PREPARED '{}'", xid),
      a => return Err(format!("Azione XA '{}' non valida", a)),
    },
    "mysql" => match request.action.as_str() {
      "commit"   => format!("XA COMMIT '{}'", xid),
      "rollback" => format!("XA ROLLBACK '{}'", xid),
      a => return Err(format!("Azione XA '{}' non valida", a)),
    },
    d => return Err(format!("Dialetto '{}' non supporta XA", d)),
  };

  match request.connection.dialect.as_str() {
    "postgresql" => {
      use sqlx::postgres::PgPoolOptions;
      let pool = PgPoolOptions::new().max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&conn_str).await
        .map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;
      sqlx::query(&sql).execute(&pool).await
        .map_err(|e| format!("{} fallita: {}", sql, e))?;
      pool.close().await;
    }
    "mysql" => {
      use sqlx::mysql::MySqlPoolOptions;
      let pool = MySqlPoolOptions::new().max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(&conn_str).await
        .map_err(|e| format!("MySQL connessione fallita: {}", e))?;
      sqlx::query(&sql).execute(&pool).await
        .map_err(|e| format!("{} fallita: {}", sql, e))?;
      pool.close().await;
    }
    _ => unreachable!(),
  }

  Ok(())
}