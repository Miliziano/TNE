use tauri::Manager;
use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use serde::{Deserialize, Serialize};
use sqlx::{Column, Row, TypeInfo};
use std::collections::VecDeque;
use std::time::Instant;
use std::sync::{Arc, Mutex};
use std::collections::HashMap;
use std::io::Read;
use sysinfo::{System, Pid};
use chrono::{NaiveDate, NaiveDateTime};

use engine::{
      engine_ping, engine_ping_parallel, engine_validate_plan,
      engine_poll_events, engine_test_bus,
      engine_run,   // ← nuovo
  };


mod db_transactions;
mod db_stream;
mod memory_monitor;  // aggiungere vicino agli altri mod
mod engine;

#[derive(Debug, Serialize)]
struct MemoryInfo {
    /// RSS processo Tauri principale (bytes)
    rss:         u64,
    /// RSS WebKitWebProcess — il renderer JS/React (bytes)
    rss_webkit:  u64,
    /// RAM totale sistema (bytes)
    total_ram:   u64,
    /// RAM usata sistema (bytes)
    used_ram:    u64,
    /// Timestamp Unix ms
    timestamp:   u64,
}

#[tauri::command]
async fn get_memory_info() -> Result<memory_monitor::AppMemoryInfo, String> {
    Ok(memory_monitor::get_app_memory_info())
}


// ─── Implementazione Linux ────────────────────────────────────────

#[cfg(target_os = "linux")]
fn get_webkit_rss(our_pid: u32) -> u64 {
    let our_uid = read_proc_uid(our_pid);
    if our_uid == u32::MAX { return 0 }

    let Ok(dir) = std::fs::read_dir("/proc") else { return 0 };
    let mut total = 0u64;

    for entry in dir.flatten() {
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<u32>() else { continue };
        if pid == our_pid { continue }

        // Legge status una sola volta per uid + rss
        let Ok(status) = std::fs::read_to_string(format!("/proc/{}/status", pid)) else { continue };

        // Controlla uid
        let uid: u32 = status.lines()
            .find(|l| l.starts_with("Uid:"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(u32::MAX);
        if uid != our_uid { continue }

        // Controlla nome
        let name = std::fs::read_to_string(format!("/proc/{}/comm", pid))
            .unwrap_or_default()
            .trim()
            .to_lowercase();
        if !name.contains("webkit") && name != "wpewebprocess" { continue }

        // Legge RSS dallo stesso status già letto
        let rss_kb: u64 = status.lines()
            .find(|l| l.starts_with("VmRSS:"))
            .and_then(|l| l.split_whitespace().nth(1))
            .and_then(|s| s.parse().ok())
            .unwrap_or(0);

        total += rss_kb * 1024;
    }

    total
}

#[cfg(target_os = "linux")]
fn read_proc_field(pid: u32, field: &str) -> Option<String> {
    let content = std::fs::read_to_string(format!("/proc/{}/status", pid)).ok()?;
    content.lines()
        .find(|l| l.starts_with(field))
        .and_then(|l| l.split_whitespace().nth(1))
        .map(|s| s.to_string())
}

#[cfg(target_os = "linux")]
fn read_proc_rss_kb(pid: u32) -> u64 {
    read_proc_field(pid, "VmRSS:")
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0)
}

#[cfg(target_os = "linux")]
fn read_proc_uid(pid: u32) -> u32 {
    read_proc_field(pid, "Uid:")
        .and_then(|s| s.parse::<u32>().ok())
        .unwrap_or(u32::MAX)
}

#[cfg(target_os = "linux")]
fn read_proc_name(pid: u32) -> String {
    std::fs::read_to_string(format!("/proc/{}/comm", pid))
        .unwrap_or_default()
        .trim()
        .to_lowercase()
}

// ─── Fallback per macOS, Windows e altri ─────────────────────────
// WebKit RSS non misurabile — il frontend nasconde il pannello.

#[cfg(not(target_os = "linux"))]
fn get_webkit_rss(_our_pid: u32) -> u64 {
    0
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
        read_file,
        read_file_bytes,
        write_file,
        write_file_bytes,
        list_directory,
        get_app_data_dir,
        db_query,
        db_infer_schema,
        db_list_constraints,   // ← aggiungere
        db_write,
        db_stream::db_query_stream,
        db_transactions::db_tx_begin,      // ← aggiungere
        db_transactions::db_tx_write,      // ← aggiungere
        db_transactions::db_tx_commit,     // ← aggiungere
        db_transactions::db_tx_rollback,   // ← aggiungere
        db_transactions::db_tx_xa_prepare,   // ← aggiungere
        db_transactions::db_tx_xa_finish,    // ← aggiungere
        engine::engine_ping,
        engine::engine_ping_parallel,
        engine::engine_validate_plan,
        engine::engine_poll_events,
        engine::engine_test_bus,
        engine::engine_run,
        mail_send,
        mqtt_subscribe,
        mqtt_publish,
        stomp_subscribe,
        stomp_publish,
        ftp_test, ftp_list, ftp_read, ftp_write,
        webhook_server_start,
        webhook_server_stop,
        webhook_subscribe,
        webhook_unsubscribe,
        webhook_pop,
        webhook_responder_start,
        webhook_responder_stop,
        webhook_responder_request_count,
        webhook_responder_update_headers,
        watchdog_check,
        shell_exec, 
        ssh_exec,
        ssh_test,
        get_memory_info,
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

#[derive(Debug, Deserialize)]
pub struct DbConnectionParams {
  dialect:         String,
  host:            Option<String>,
  port:            Option<u16>,
  database:        Option<String>,
  user:            Option<String>,
  password:        Option<String>,
  schema:          Option<String>,
  #[serde(rename = "serviceName")]
  service_name:    Option<String>,
  #[serde(rename = "dbServerName")]
  db_server_name:  Option<String>,
  charset:         Option<String>,
  ssl:             Option<String>,
  #[serde(rename = "connectTimeout")]
  connect_timeout: Option<u64>,
}

#[derive(Debug, Deserialize)]
struct DbQueryRequest {
  connection: DbConnectionParams,
  query:      String,
  #[serde(rename = "fetchSize")]
  fetch_size: Option<u32>,
  timeout:    Option<u64>,
}

#[derive(Debug, Serialize)]
struct DbColumnInfo {
  name:     String,
  db_type:  String,
  nullable: bool,
  position: usize,
}
#[derive(Debug, Deserialize)]
struct DbListConstraintsRequest {
  connection: DbConnectionParams,
  schema:     Option<String>,
  table:      String,
}


#[derive(Debug, Serialize, Clone)]
struct DbConstraintInfo {
  name:             String,
  constraint_type:  String,      // "primary_key" | "unique"
  columns:          Vec<String>, // ordinate secondo l'indice
}
#[tauri::command]
async fn db_list_constraints(request: DbListConstraintsRequest) -> Result<Vec<DbConstraintInfo>, String> {
  let conn_str = build_connection_string(&request.connection)?;
  match request.connection.dialect.as_str() {
    "postgresql" => pg_list_constraints(&conn_str, request.schema.as_deref().unwrap_or("public"), &request.table).await,
    "mysql"      => mysql_list_constraints(&conn_str, &request.connection.database.clone().unwrap_or_default(), &request.table).await,
    "sqlite"     => sqlite_list_constraints(&conn_str, &request.table).await,
    d            => Err(format!("Dialetto '{}' non supportato per lista vincoli", d)),
  }
}

pub(crate) fn build_connection_string(conn: &DbConnectionParams) -> Result<String, String> {
  let host     = conn.host.as_deref().unwrap_or("localhost");
  let database = conn.database.as_deref().unwrap_or("");
  let user     = conn.user.as_deref().unwrap_or("");
  let password = conn.password.as_deref().unwrap_or("");
  let port     = conn.port.unwrap_or(match conn.dialect.as_str() {
    "postgresql" => 5432,
    "mysql"      => 3306,
    "oracle"     => 1521,
    "informix"   => 9088,
    _            => 5432,
  });
  match conn.dialect.as_str() {
    "postgresql" => {
      let ssl_mode = match conn.ssl.as_deref().unwrap_or("false") {
        "true" | "require" => "require",
        "verify-ca"        => "verify-ca",
        "verify-full"      => "verify-full",
        _                  => "disable",
      };
      Ok(format!("postgresql://{}:{}@{}:{}/{}?sslmode={}",
        urlencoding::encode(user), urlencoding::encode(password),
        host, port, database, ssl_mode))
    }
    "mysql" => {
      let charset = conn.charset.as_deref().unwrap_or("utf8mb4");
      Ok(format!("mysql://{}:{}@{}:{}/{}?charset={}",
        urlencoding::encode(user), urlencoding::encode(password),
        host, port, database, charset))
    }
    "sqlite" => Ok(format!("sqlite:{}", database)),
    d => Err(format!("Dialetto '{}' non supportato.", d)),
  }
}

#[tauri::command]
async fn db_query(request: DbQueryRequest) -> Result<Vec<serde_json::Value>, String> {
  let conn_str = build_connection_string(&request.connection)?;
  match request.connection.dialect.as_str() {
    "postgresql" => pg_query(&conn_str, &request.query, request.timeout).await,
    "mysql"      => mysql_query(&conn_str, &request.query, request.timeout).await,
    "sqlite"     => sqlite_query(&conn_str, &request.query, request.timeout).await,
    d            => Err(format!("Dialetto '{}' non supportato", d)),
  }
}

#[tauri::command]
async fn db_infer_schema(request: DbQueryRequest) -> Result<Vec<DbColumnInfo>, String> {
  let conn_str = build_connection_string(&request.connection)?;
  let base     = request.query.trim().trim_end_matches(';');
  let probe = match request.connection.dialect.as_str() {
    "postgresql" | "mysql" | "sqlite" => format!("SELECT * FROM ({}) AS __probe__ LIMIT 0", base),
    "oracle"   => format!("SELECT * FROM ({}) WHERE ROWNUM = 0", base),
    "informix" => format!("SELECT FIRST 0 * FROM ({}) t", base),
    d          => return Err(format!("Dialetto '{}' non supportato", d)),
  };
  match request.connection.dialect.as_str() {
    "postgresql" => pg_infer(&conn_str, &probe).await,
    "mysql"      => mysql_infer(&conn_str, &probe).await,
    "sqlite"     => sqlite_infer(&conn_str, &probe).await,
    d            => Err(format!("Dialetto '{}' non supportato", d)),
  }
}

#[derive(Debug, Deserialize, Clone)]
pub struct DbColumnFunction {
  pub column: String,
  pub expr:   String,
}
#[derive(Debug, Deserialize)]
pub struct DbWriteRequest {
  connection:            DbConnectionParams,
  table:                 String,
  schema:                Option<String>,
  mode:                  String,
  rows:                  Vec<serde_json::Value>,
  #[serde(rename = "keyFields")]
  key_fields:            Option<Vec<String>>,
  columns:               Option<Vec<String>>,
  #[serde(rename = "excludeColumns")]
  exclude_columns:       Option<Vec<String>>,
  #[serde(rename = "columnFunctions")]
  pub(crate) column_functions: Option<Vec<DbColumnFunction>>,
  #[serde(rename = "mergeCondition")]
  merge_condition:       Option<String>,
  #[serde(rename = "preSql")]
  pre_sql:               Option<String>,
  #[serde(rename = "postSql")]
  post_sql:              Option<String>,
  #[serde(rename = "batchSize")]
  batch_size:            usize,
  #[serde(rename = "onConstraintError")]
  on_constraint_error:   String,
  #[serde(rename = "deadLetterTable")]
  dead_letter_table:     Option<String>,
  #[serde(rename = "returningColumn")]
  pub returning_column: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct DbWriteResult {
    pub rows_written:   usize,
    pub rows_skipped:   usize,
    pub rows_errors:    usize,
    pub batches:        usize,
    pub elapsed_ms:     u128,
    /// Chiavi generate dal DB dopo ogni INSERT riuscito.
    /// Ordine: corrisponde all'ordine delle righe in ingresso
    /// (le righe saltate o in errore NON producono una entry).
    /// Vuoto se returning_column è None o la modalità non è insert/upsert.
    pub generated_keys: Vec<serde_json::Value>,
}

#[tauri::command]
async fn db_write(request: DbWriteRequest) -> Result<DbWriteResult, String> {
  let conn_str = build_connection_string(&request.connection)?;
  let start    = std::time::Instant::now();
  match request.connection.dialect.as_str() {
    "postgresql" => pg_write(&conn_str, &request, start).await,
    "mysql"      => mysql_write(&conn_str, &request, start).await,
    "sqlite"     => sqlite_write(&conn_str, &request, start).await,
    d            => Err(format!("Dialetto '{}' non supportato per scrittura", d)),
  }
}

pub(crate) fn qualified_table(req: &DbWriteRequest) -> String {
  match &req.schema {
    Some(s) if !s.is_empty() => format!("{}.{}", s, req.table),
    _                         => req.table.clone(),
  }
}

async fn sqlite_list_constraints(conn_str: &str, table: &str) -> Result<Vec<DbConstraintInfo>, String> {
  use sqlx::sqlite::SqlitePoolOptions;
  use sqlx::Row as SqlxRow;

  let pool = SqlitePoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(10))
    .connect(conn_str).await
    .map_err(|e| format!("SQLite connessione fallita: {}", e))?;

  let mut result = Vec::new();

  // PRIMARY KEY — da table_info, colonne con pk > 0, ordinate per pk
  let pk_rows = sqlx::query(&format!("PRAGMA table_info('{}')", table.replace('\'', "''")))
    .fetch_all(&pool).await
    .map_err(|e| format!("SQLite table_info fallita: {}", e))?;

  let mut pk_cols: Vec<(i64, String)> = pk_rows.iter().filter_map(|row| {
    let pk: i64 = row.try_get("pk").unwrap_or(0);
    if pk > 0 {
      let name: String = row.try_get("name").unwrap_or_default();
      Some((pk, name))
    } else { None }
  }).collect();
  pk_cols.sort_by_key(|(ord, _)| *ord);

  if !pk_cols.is_empty() {
    result.push(DbConstraintInfo {
      name: format!("{}_pk", table),
      constraint_type: "primary_key".to_string(),
      columns: pk_cols.into_iter().map(|(_, name)| name).collect(),
    });
  }

  // UNIQUE — da index_list con origin='u' o 'pk', poi index_info per le colonne
  let idx_rows = sqlx::query(&format!("PRAGMA index_list('{}')", table.replace('\'', "''")))
    .fetch_all(&pool).await
    .map_err(|e| format!("SQLite index_list fallita: {}", e))?;

  for idx_row in &idx_rows {
    let is_unique: i64 = idx_row.try_get("unique").unwrap_or(0);
    let origin: String = idx_row.try_get("origin").unwrap_or_default();
    if is_unique == 0 || origin == "pk" { continue }  // pk già gestita sopra

    let idx_name: String = idx_row.try_get("name").unwrap_or_default();
    let col_rows = sqlx::query(&format!("PRAGMA index_info('{}')", idx_name.replace('\'', "''")))
      .fetch_all(&pool).await
      .map_err(|e| format!("SQLite index_info fallita: {}", e))?;

    let mut cols: Vec<(i64, String)> = col_rows.iter().map(|r| {
      let seqno: i64 = r.try_get("seqno").unwrap_or(0);
      let name: String = r.try_get("name").unwrap_or_default();
      (seqno, name)
    }).collect();
    cols.sort_by_key(|(seq, _)| *seq);

    result.push(DbConstraintInfo {
      name: idx_name,
      constraint_type: "unique".to_string(),
      columns: cols.into_iter().map(|(_, name)| name).collect(),
    });
  }

  pool.close().await;
  Ok(result)
}

async fn mysql_list_constraints(conn_str: &str, database: &str, table: &str) -> Result<Vec<DbConstraintInfo>, String> {
  use sqlx::mysql::MySqlPoolOptions;
  use sqlx::Row as SqlxRow;

  let pool = MySqlPoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(10))
    .connect(conn_str).await
    .map_err(|e| format!("MySQL connessione fallita: {}", e))?;

  let query = r#"
    SELECT
      tc.CONSTRAINT_NAME AS name,
      CASE tc.CONSTRAINT_TYPE WHEN 'PRIMARY KEY' THEN 'primary_key' ELSE 'unique' END AS constraint_type,
      kcu.COLUMN_NAME AS column_name,
      kcu.ORDINAL_POSITION AS ord
    FROM information_schema.TABLE_CONSTRAINTS tc
    JOIN information_schema.KEY_COLUMN_USAGE kcu
      ON tc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
      AND tc.TABLE_SCHEMA = kcu.TABLE_SCHEMA
      AND tc.TABLE_NAME = kcu.TABLE_NAME
    WHERE tc.CONSTRAINT_TYPE IN ('PRIMARY KEY', 'UNIQUE')
      AND tc.TABLE_SCHEMA = ?
      AND tc.TABLE_NAME = ?
    ORDER BY tc.CONSTRAINT_NAME, kcu.ORDINAL_POSITION
  "#;

  let rows = sqlx::query(query)
    .bind(database)
    .bind(table)
    .fetch_all(&pool).await
    .map_err(|e| format!("MySQL lista vincoli fallita: {}", e))?;

  // Raggruppa manualmente per nome vincolo (MySQL non ha array_agg nativo facile via sqlx qui)
  let mut grouped: std::collections::BTreeMap<(String, String), Vec<String>> = std::collections::BTreeMap::new();
  for row in &rows {
    let name: String = row.get("name");
    let ctype: String = row.get("constraint_type");
    let col: String = row.get("column_name");
    grouped.entry((name, ctype)).or_default().push(col);
  }

  let result = grouped.into_iter().map(|((name, constraint_type), columns)| {
    DbConstraintInfo { name, constraint_type, columns }
  }).collect();

  pool.close().await;
  Ok(result)
}

async fn pg_list_constraints(conn_str: &str, schema: &str, table: &str) -> Result<Vec<DbConstraintInfo>, String> {
  use sqlx::postgres::PgPoolOptions;
  use sqlx::Row as SqlxRow;

  let pool = PgPoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(10))
    .connect(conn_str).await
    .map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;

  // pg_constraint.contype: 'p' = primary key, 'u' = unique
  // conkey è un array di attnum — join con pg_attribute per i nomi colonna,
  // preservando l'ordine tramite unnest WITH ORDINALITY.
  let query = r#"
    SELECT
      con.conname AS name,
      CASE con.contype WHEN 'p' THEN 'primary_key' ELSE 'unique' END AS constraint_type,
      array_agg(att.attname ORDER BY ord.ordinality) AS columns
    FROM pg_constraint con
    JOIN pg_class cls       ON cls.oid = con.conrelid
    JOIN pg_namespace nsp   ON nsp.oid = cls.relnamespace
    JOIN unnest(con.conkey) WITH ORDINALITY AS ord(attnum, ordinality) ON true
    JOIN pg_attribute att   ON att.attrelid = cls.oid AND att.attnum = ord.attnum
    WHERE con.contype IN ('p', 'u')
      AND nsp.nspname = $1
      AND cls.relname = $2
    GROUP BY con.conname, con.contype
    ORDER BY con.contype DESC, con.conname
  "#;

  let rows = sqlx::query(query)
    .bind(schema)
    .bind(table)
    .fetch_all(&pool).await
    .map_err(|e| format!("PostgreSQL lista vincoli fallita: {}", e))?;

  let result = rows.iter().map(|row| {
    let columns: Vec<String> = row.get("columns");
    DbConstraintInfo {
      name:            row.get("name"),
      constraint_type: row.get("constraint_type"),
      columns,
    }
  }).collect();

  pool.close().await;
  Ok(result)
}

/// Risultato della costruzione colonne per INSERT/UPDATE, con supporto
/// per colonne con funzione SQL letterale (es. NOW(), MD5({v})).
///
/// - `column_sql`: frammento da usare nella lista colonne dell'INSERT
///   (es. `"data"` per colonna normale — invariato).
/// - `value_sql`: frammento da usare nella lista VALUES — o un
///   placeholder normale ($N / ?), o l'espressione della funzione con
///   eventuale placeholder incorporato (es. `NOW()`, `MD5($3)`).
/// - `bind_value`: Some(valore) se questa colonna richiede comunque un
///   bind (colonna normale, o funzione con {v}); None se la funzione
///   non referenzia alcun valore (es. NOW()) — colonna esclusa dal
///   binding.
pub(crate) struct ColumnPlan<'a> {
  pub column_sql: String,
  pub value_sql:  String,
  pub bind_value: Option<&'a serde_json::Value>,
}

/// Placeholder positivo dialect-aware: "$N" per postgres, "?" per
/// mysql/sqlite (mysql/sqlite non usano N, quindi `next_index` è
/// ignorato per loro ma viene comunque incrementato dal chiamante per
/// uniformità del codice chiamante).
pub(crate) enum PlaceholderStyle { Dollar, Question }

pub(crate) fn build_column_plan<'a>(
  fields:            &'a [(String, serde_json::Value)],
  column_functions:  &Option<Vec<DbColumnFunction>>,
  style:             PlaceholderStyle,
  start_index:       usize,
) -> Vec<ColumnPlan<'a>> {
  let fn_map: std::collections::HashMap<&str, &str> = column_functions
    .as_ref()
    .map(|v| v.iter().map(|cf| (cf.column.as_str(), cf.expr.as_str())).collect())
    .unwrap_or_default();

  let mut next_index = start_index; // solo rilevante per Dollar
  let mut plan = Vec::with_capacity(fields.len());

  for (col, val) in fields {
    match fn_map.get(col.as_str()) {
      Some(expr) if expr.contains("$VALUE") => {
        // Funzione con valore — es. MD5($VALUE) → MD5($3) o MD5(?)
        let placeholder = match style {
          PlaceholderStyle::Dollar   => { let p = format!("${}", next_index); next_index += 1; p }
          PlaceholderStyle::Question => "?".to_string(),
        };
        let value_sql = expr.replace("$VALUE", &placeholder);
        plan.push(ColumnPlan { column_sql: col.clone(), value_sql, bind_value: Some(val) });
      }
      Some(expr) => {
        // Funzione senza valore — es. NOW() — SQL letterale puro, nessun bind
        plan.push(ColumnPlan { column_sql: col.clone(), value_sql: expr.to_string(), bind_value: None });
      }
      None => {
        // Colonna normale — placeholder standard
        let placeholder = match style {
          PlaceholderStyle::Dollar   => { let p = format!("${}", next_index); next_index += 1; p }
          PlaceholderStyle::Question => "?".to_string(),
        };
        plan.push(ColumnPlan { column_sql: col.clone(), value_sql: placeholder, bind_value: Some(val) });
      }
    }
  }

  plan
}

/// Quanti placeholder posizionali ($N) sono stati consumati da un plan
/// — per Dollar style: 1 per ogni colonna con bind_value=Some. Per
/// Question style non è rilevante (sempre "?"), ma usiamo comunque
/// questo conteggio per sapere quanti VALORI sono stati bindati nel
/// SET, in modo che il WHERE possa continuare da lì in Postgres.
pub(crate) fn count_consumed_placeholders(plan: &[ColumnPlan]) -> usize {
  plan.iter().filter(|p| p.bind_value.is_some()).count()
}

pub(crate)  fn extract_row_data(
  row:     &serde_json::Value,
  include: &Option<Vec<String>>,
  exclude: &Option<Vec<String>>,
) -> Vec<(String, serde_json::Value)> {
  let obj = match row.as_object() { Some(o) => o, None => return vec![] };
  obj.iter()
    .filter(|(k, _)| {
      if let Some(inc) = include { if !inc.contains(k) { return false; } }
      if let Some(exc) = exclude { if  exc.contains(k) { return false; } }
      true
    })
    .map(|(k, v)| (k.clone(), v.clone()))
    .collect()
}

async fn exec_sql_block<'a, E>(executor: E, sql: &str) -> Result<(), String>
where E: sqlx::Executor<'a, Database = sqlx::Postgres> + Copy {
  for stmt in sql.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
    sqlx::query(stmt).execute(executor).await.map_err(|e| format!("SQL fallito: {}", e))?;
  }
  Ok(())
}


// ─── Helper: legge il valore della prima colonna di una PgRow ─────
fn pg_row_to_json_value(row: &sqlx::postgres::PgRow, idx: usize) -> serde_json::Value {
    use sqlx::Row as SqlxRow;
    // Prova i tipi numerici più comuni per le PK
    if let Ok(v) = row.try_get::<i64, _>(idx) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<i32, _>(idx) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<i16, _>(idx) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<String, _>(idx) { return serde_json::json!(v) }
    // UUID
    if let Ok(v) = row.try_get::<uuid::Uuid, _>(idx) { return serde_json::json!(v.to_string()) }
    serde_json::Value::Null
}
// ─── pg_write con RETURNING ───────────────────────────────────────
// Wrapper legacy: apre un pool usa-e-getta e delega. Usato dai comandi
// Tauri che passano una connection string (Preview, test-write). I nodi
// del motore usano invece pg_write_pool con il pool condiviso di lane.
pub async fn pg_write(
    conn_str: &str,
    req:      &DbWriteRequest,
    start:    std::time::Instant,
) -> Result<DbWriteResult, String> {
    use sqlx::postgres::PgPoolOptions;
    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(conn_str).await
        .map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;
    let result = pg_write_pool(&pool, req, start).await;
    pool.close().await;
    result
}

pub async fn pg_write_pool(
    pool:  &sqlx::postgres::PgPool,
    req:   &DbWriteRequest,
    start: std::time::Instant,
) -> Result<DbWriteResult, String> {
    use sqlx::Row as SqlxRow;

    let tbl = qualified_table(req);


    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    // Colonna PK da restituire — None se non configurata
    let ret_col = req.returning_column.as_deref();
    let use_returning = ret_col.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(pool).await
                    .map_err(|e| format!("Pre-SQL fallito: {}", e))?;
            }
        }
    }

    if req.mode == "truncate_insert" {
        sqlx::query(&format!("TRUNCATE TABLE {}", tbl)).execute(pool).await
            .map_err(|e| format!("TRUNCATE fallito: {}", e))?;
    }

    for chunk in req.rows.chunks(req.batch_size.max(1)) {
        batches += 1;
        for row in chunk {
            let fields = extract_row_data(row, &req.columns, &req.exclude_columns);
            if fields.is_empty() { skipped += 1; continue; }

            let default_keys = vec![];
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
                            format!("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO NOTHING",
                                tbl, cols, vals, conflict)
                        } else {
                            format!("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO UPDATE SET {}",
                                tbl, cols, vals, conflict, updates)
                        }
                    }
                    _ => format!("INSERT INTO {} ({}) VALUES ({})", tbl, cols, vals),
                };

                // Aggiunge RETURNING se configurato
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
                // delete
                let where_c = keys.iter().enumerate()
                    .map(|(i, k)| format!("{} = ${}", k, i + 1))
                    .collect::<Vec<_>>().join(" AND ");
                sql = format!("DELETE FROM {} WHERE {}", tbl, where_c);
                bind_list = keys.iter()
                    .filter_map(|k| fields.iter().find(|(fk, _)| fk == k).map(|(_, v)| v))
                    .collect();
            }

            if use_returning && needs_plan {
                // fetch_one per catturare la chiave generata
                let mut q = sqlx::query(&sql);
                for v in &bind_list { q = bind_pg_value(q, v); }
                match q.fetch_one(pool).await {
                    Ok(row) => {
                        written += 1;
                        // Legge il valore della colonna returning
                        let key_val = pg_row_to_json_value(&row, 0);
                        generated_keys.push(key_val);
                    }
                    Err(e) => match req.on_constraint_error.as_str() {
                        "skip" => { skipped += 1; }
                        "stop" => { return Err(format!("SinkDB errore riga: {}", e)); }
                        _ => { errors += 1; }
                    }
                }
            } else {
                // execute standard (nessun RETURNING)
                let mut q = sqlx::query(&sql);
                for v in &bind_list { q = bind_pg_value(q, v); }
                match q.execute(pool).await {
                    Ok(_) => { written += 1; }
                    Err(e) => match req.on_constraint_error.as_str() {
                        "skip" => { skipped += 1; }
                        "stop" => { return Err(format!("SinkDB errore riga: {}", e)); }
                        _ => { errors += 1; }
                    }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(pool).await
                    .map_err(|e| format!("Post-SQL fallito: {}", e))?;
            }
        }
    }

   
    Ok(DbWriteResult {
        rows_written: written,
        rows_skipped: skipped,
        rows_errors:  errors,
        batches,
        elapsed_ms:   start.elapsed().as_millis(),
        generated_keys,
    })
}

pub(crate) fn bind_pg_value<'q>(
    q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    v: &'q serde_json::Value,
    ) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {  
    match v {
        serde_json::Value::Null      => q.bind(None::<String>),
        serde_json::Value::Bool(b)   => q.bind(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() { q.bind(i) }
            else if let Some(f) = n.as_f64() { q.bind(f) }
            else { q.bind(n.to_string()) }
        }
        serde_json::Value::String(s) => {
        // Date/timestamp viaggiano come stringhe ISO: se la stringa è una
        // data/timestamp valida, bind come tipo temporale (Postgres non fa
        // il cast implicito text→date/timestamp sui parametri).
        if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f") {
            q.bind(dt)
        } else if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
            q.bind(dt)
        } else if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
            q.bind(d)
        } else {
            q.bind(s.as_str())
        }
        }
        // Array e oggetti → bind come JSON/JSONB. Senza questo, to_string()
        // li manda come text e il cast text→jsonb fallisce.
        v @ serde_json::Value::Array(_)  => q.bind(v.clone()),
        v @ serde_json::Value::Object(_) => q.bind(v.clone()),
    }
}

// ─── mysql_write con LAST_INSERT_ID ───────────────────────────────
// Wrapper legacy: apre un pool usa-e-getta e delega. Usato dai comandi
// Tauri che passano una connection string (Preview, test-write). I nodi
// del motore usano invece pg_write_pool con il pool condiviso di lane.

pub async fn mysql_write(
    conn_str: &str,
    req:      &DbWriteRequest,
    start:    std::time::Instant,
    ) -> Result<DbWriteResult, String> {
    use sqlx::mysql::MySqlPoolOptions;
    use sqlx::Row as SqlxRow;

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(conn_str).await
        .map_err(|e| format!("MySQL connessione fallita: {}", e))?;

     let result = mysql_write_pool(&pool, req, start).await;
    pool.close().await;
    result
}



pub async fn mysql_write_pool(
    pool:  &sqlx::mysql::MySqlPool,
    req:   &DbWriteRequest,
    start: std::time::Instant,
    ) -> Result<DbWriteResult, String> {
    use sqlx::Row as SqlxRow;

    let tbl = qualified_table(req);


   
    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    let default_keys = vec![];
    let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());

    let use_returning = req.returning_column.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(pool).await
                    .map_err(|e| format!("Pre-SQL fallito: {}", e))?;
            }
        }
    }
    if req.mode == "truncate_insert" {
        sqlx::query(&format!("TRUNCATE TABLE `{}`", tbl)).execute(pool).await
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
                    if let Some((_, v)) = fields.iter().find(|(fk, _)| fk == k) {
                        bind_list.push(v);
                    }
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
                    serde_json::Value::String(s) => {
                    // Date/timestamp viaggiano come stringhe ISO nel JSON. Postgres
                    // non fa il cast implicito text→date sui parametri bindati: se la
                    // stringa è una data/timestamp valida, bind come tipo temporale.
                    if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S%.f") {
                        q.bind(dt)
                    } else if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S%.f") {
                        q.bind(dt)
                    } else if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                        q.bind(d)
                    } else {
                        q.bind(s.as_str())
                    }
                }
                    other => q.bind(other.to_string()),
                };
            }

            match q.execute(pool).await {
                Ok(result) => {
                    written += 1;
                    // Recupera la chiave generata se configurato e modalità è insert/upsert
                    if use_returning && needs_plan {
                        // last_insert_id() è nel risultato dell'execute
                        let last_id = result.last_insert_id();
                        if last_id > 0 {
                            generated_keys.push(serde_json::json!(last_id));
                        } else {
                            // Fallback: SELECT LAST_INSERT_ID()
                            if let Ok(id_row) = sqlx::query("SELECT LAST_INSERT_ID() AS gid")
                                .fetch_one(pool).await
                            {
                                let gid: u64 = id_row.try_get("gid").unwrap_or(0);
                                if gid > 0 { generated_keys.push(serde_json::json!(gid)); }
                            }
                        }
                    }
                }
                Err(e) => match req.on_constraint_error.as_str() {
                    "skip" => { skipped += 1; }
                    "stop" => { pool.close().await; return Err(format!("SinkDB errore riga: {}", e)); }
                    _ => { errors += 1; }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(pool).await
                    .map_err(|e| format!("Post-SQL fallito: {}", e))?;
            }
        }
    }

   
    Ok(DbWriteResult {
        rows_written: written,
        rows_skipped: skipped,
        rows_errors:  errors,
        batches,
        elapsed_ms:   start.elapsed().as_millis(),
        generated_keys,
    })
}


// ─── sqlite_write con last_insert_rowid ───────────────────────────

pub async fn sqlite_write(
    conn_str: &str,
    req:      &DbWriteRequest,
    start:    std::time::Instant,
) -> Result<DbWriteResult, String> {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row as SqlxRow;

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect(conn_str).await
        .map_err(|e| format!("SQLite connessione fallita: {}", e))?;

      let result = sqlite_write_pool(&pool, req, start).await;
    pool.close().await;
    result
}



pub async fn sqlite_write_pool(
    pool:  &sqlx::sqlite::SqlitePool,
    req:   &DbWriteRequest,
    start: std::time::Instant,
) -> Result<DbWriteResult, String> {
    use sqlx::Row as SqlxRow;

    let tbl = qualified_table(req);


    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    let default_keys = vec![];
    let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());

    let use_returning = req.returning_column.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(pool).await
                    .map_err(|e| format!("Pre-SQL fallito: {}", e))?;
            }
        }
    }
    if req.mode == "truncate_insert" {
        sqlx::query(&format!("DELETE FROM {}", tbl)).execute(pool).await
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
                    if let Some((_, v)) = fields.iter().find(|(fk, _)| fk == k) {
                        bind_list.push(v);
                    }
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

            match q.execute(pool).await {
                Ok(result) => {
                    written += 1;
                    if use_returning && needs_plan {
                        // SQLite: last_insert_rowid() è nel SqliteQueryResult
                        let rowid = result.last_insert_rowid();
                        if rowid > 0 {
                            generated_keys.push(serde_json::json!(rowid));
                        }
                    }
                }
                Err(e) => match req.on_constraint_error.as_str() {
                    "skip" => { skipped += 1; }
                    "stop" => { pool.close().await; return Err(format!("SinkDB errore riga: {}", e)); }
                    _ => { errors += 1; }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(stmt).execute(pool).await
                    .map_err(|e| format!("Post-SQL fallito: {}", e))?;
            }
        }
    }

 
    Ok(DbWriteResult {
        rows_written: written,
        rows_skipped: skipped,
        rows_errors:  errors,
        batches,
        elapsed_ms:   start.elapsed().as_millis(),
        generated_keys,
    })
}

async fn pg_query(conn_str: &str, query: &str, timeout: Option<u64>) -> Result<Vec<serde_json::Value>, String> {
  use sqlx::postgres::PgPoolOptions;
  let pool = PgPoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(timeout.unwrap_or(30)))
    .connect(conn_str).await.map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;
  let rows = sqlx::query(query).fetch_all(&pool).await.map_err(|e| format!("PostgreSQL query fallita: {}", e))?;
  let result = rows.iter().map(|row| {
    let mut obj = serde_json::Map::new();
    for (i, col) in row.columns().iter().enumerate() { obj.insert(col.name().to_string(), pg_value_to_json(row, i)); }
    serde_json::Value::Object(obj)
  }).collect();
  pool.close().await;
  Ok(result)
}

async fn pg_infer(conn_str: &str, probe: &str) -> Result<Vec<DbColumnInfo>, String> {
  use sqlx::postgres::PgPoolOptions;
  use sqlx::Executor;
  let pool = PgPoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(10))
    .connect(conn_str).await.map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;
  let described = pool.describe(probe).await.map_err(|e| format!("PostgreSQL describe fallita: {}", e))?;
  pool.close().await;
  Ok(described.columns().iter().enumerate().map(|(i, col)| DbColumnInfo {
    name: col.name().to_string(), db_type: col.type_info().name().to_string(),
    nullable: described.nullable(i).unwrap_or(true), position: i,
  }).collect())
}

pub(crate) fn pg_value_to_json(row: &sqlx::postgres::PgRow, idx: usize) -> serde_json::Value {
  let col = &row.columns()[idx];
  let type_name = col.type_info().name().to_lowercase();
  if ["int2","int4","int8","serial","bigserial"].contains(&type_name.as_str()) {
    if let Ok(v) = row.try_get::<i64, _>(idx) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<i32, _>(idx) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<i16, _>(idx) { return serde_json::json!(v) }
  }
  if ["float4","float8","numeric","decimal","money"].contains(&type_name.as_str()) {
    if let Ok(v) = row.try_get::<f64, _>(idx) { return serde_json::json!(v) }
    if let Ok(v) = row.try_get::<rust_decimal::Decimal, _>(idx) { return serde_json::json!(v.to_string()) }
  }
  if type_name == "bool" { if let Ok(v) = row.try_get::<bool, _>(idx) { return serde_json::json!(v) } }
  if ["json","jsonb"].contains(&type_name.as_str()) { if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) { return v } }
  if type_name.starts_with("timestamp") {
    if let Ok(v) = row.try_get::<chrono::DateTime<chrono::Utc>, _>(idx) { return serde_json::json!(v.to_rfc3339()) }
    if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(idx) { return serde_json::json!(v.to_string()) }
  }
  if type_name == "date" { if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(idx) { return serde_json::json!(v.to_string()) } }
  if type_name == "uuid" { if let Ok(v) = row.try_get::<uuid::Uuid, _>(idx) { return serde_json::json!(v.to_string()) } }
  if let Ok(v) = row.try_get::<String, _>(idx) { return serde_json::json!(v) }
  if let Ok(Some(v)) = row.try_get::<Option<String>, _>(idx) { return serde_json::json!(v) }
  serde_json::Value::Null
}

async fn mysql_query(conn_str: &str, query: &str, timeout: Option<u64>) -> Result<Vec<serde_json::Value>, String> {
  use sqlx::mysql::MySqlPoolOptions;
  let pool = MySqlPoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(timeout.unwrap_or(30)))
    .connect(conn_str).await.map_err(|e| format!("MySQL connessione fallita: {}", e))?;
  let rows = sqlx::query(query).fetch_all(&pool).await.map_err(|e| format!("MySQL query fallita: {}", e))?;
  let result = rows.iter().map(|row| {
    let mut obj = serde_json::Map::new();
    for col in row.columns() {
      let val: serde_json::Value = row.try_get(col.name()).unwrap_or(serde_json::Value::Null);
      obj.insert(col.name().to_string(), val);
    }
    serde_json::Value::Object(obj)
  }).collect();
  pool.close().await;
  Ok(result)
}

async fn mysql_infer(conn_str: &str, probe: &str) -> Result<Vec<DbColumnInfo>, String> {
  use sqlx::mysql::MySqlPoolOptions;
  use sqlx::Executor;
  let pool = MySqlPoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(10))
    .connect(conn_str).await.map_err(|e| format!("MySQL connessione fallita: {}", e))?;
  let described = pool.describe(probe).await.map_err(|e| format!("MySQL describe fallita: {}", e))?;
  pool.close().await;
  Ok(described.columns().iter().enumerate().map(|(i, col)| DbColumnInfo {
    name: col.name().to_string(), db_type: col.type_info().name().to_string(),
    nullable: described.nullable(i).unwrap_or(true), position: i,
  }).collect())
}

async fn sqlite_query(conn_str: &str, query: &str, timeout: Option<u64>) -> Result<Vec<serde_json::Value>, String> {
  use sqlx::sqlite::SqlitePoolOptions;
  let pool = SqlitePoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(timeout.unwrap_or(30)))
    .connect(conn_str).await.map_err(|e| format!("SQLite connessione fallita: {}", e))?;
  let rows = sqlx::query(query).fetch_all(&pool).await.map_err(|e| format!("SQLite query fallita: {}", e))?;
  let result = rows.iter().map(|row| {
    let mut obj = serde_json::Map::new();
    for col in row.columns() {
      let val = {
        if let Ok(v) = row.try_get::<i64,    _>(col.name()) { serde_json::json!(v) }
        else if let Ok(v) = row.try_get::<f64,    _>(col.name()) { serde_json::json!(v) }
        else if let Ok(v) = row.try_get::<bool,   _>(col.name()) { serde_json::json!(v) }
        else if let Ok(v) = row.try_get::<String, _>(col.name()) { serde_json::json!(v) }
        else { serde_json::Value::Null }
      };
      obj.insert(col.name().to_string(), val);
    }
    serde_json::Value::Object(obj)
  }).collect();
  pool.close().await;
  Ok(result)
}

async fn sqlite_infer(conn_str: &str, probe: &str) -> Result<Vec<DbColumnInfo>, String> {
  use sqlx::sqlite::SqlitePoolOptions;
  use sqlx::Executor;
  let pool = SqlitePoolOptions::new().max_connections(1)
    .acquire_timeout(std::time::Duration::from_secs(10))
    .connect(conn_str).await.map_err(|e| format!("SQLite connessione fallita: {}", e))?;
  let described = pool.describe(probe).await.map_err(|e| format!("SQLite describe fallita: {}", e))?;
  pool.close().await;
  Ok(described.columns().iter().enumerate().map(|(i, col)| DbColumnInfo {
    name: col.name().to_string(), db_type: col.type_info().name().to_string(),
    nullable: described.nullable(i).unwrap_or(true), position: i,
  }).collect())
}

#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
  std::fs::read_to_string(&path).map_err(|e| format!("Errore lettura {}: {}", path, e))
}

#[tauri::command]
async fn read_file_bytes(path: String) -> Result<String, String> {
  let bytes = std::fs::read(&path).map_err(|e| format!("Errore lettura {}: {}", path, e))?;
  Ok(BASE64.encode(&bytes))
}

#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
  if let Some(parent) = std::path::Path::new(&path).parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("Errore creazione directory: {}", e))?;
  }
  std::fs::write(&path, content.into_bytes()).map_err(|e| format!("Errore scrittura {}: {}", path, e))
}

#[tauri::command]
async fn write_file_bytes(path: String, content_base64: String) -> Result<(), String> {
  if let Some(parent) = std::path::Path::new(&path).parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("Errore creazione directory: {}", e))?;
  }
  let bytes = BASE64.decode(&content_base64).map_err(|e| format!("Errore decodifica base64: {}", e))?;
  std::fs::write(&path, bytes).map_err(|e| format!("Errore scrittura {}: {}", path, e))
}

#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
  let entries = std::fs::read_dir(&path).map_err(|e| format!("Errore lettura directory {}: {}", path, e))?;
  let mut result = Vec::new();
  for entry in entries {
    let entry    = entry.map_err(|e| e.to_string())?;
    let metadata = entry.metadata().map_err(|e| e.to_string())?;
    result.push(FileEntry {
      name:   entry.file_name().to_string_lossy().to_string(),
      path:   entry.path().to_string_lossy().to_string(),
      is_dir: metadata.is_dir(),
      size:   if metadata.is_file() { metadata.len() } else { 0 },
    });
  }
  result.sort_by(|a, b| match (a.is_dir, b.is_dir) {
    (true, false) => std::cmp::Ordering::Less,
    (false, true) => std::cmp::Ordering::Greater,
    _             => a.name.cmp(&b.name),
  });
  Ok(result)
}

#[tauri::command]
async fn get_app_data_dir(app: tauri::AppHandle) -> Result<String, String> {
  app.path().app_data_dir()
    .map(|p| p.to_string_lossy().to_string())
    .map_err(|e| e.to_string())
}

#[derive(serde::Serialize, serde::Deserialize)]
struct FileEntry {
  name:   String,
  path:   String,
  is_dir: bool,
  size:   u64,
}

// ═══════════════════════════════════════════════════════════════════
// FTP / SFTP
// ═══════════════════════════════════════════════════════════════════

#[derive(Debug, Deserialize, Clone)]
struct FtpConnectionParams {
  protocol:        String,
  host:            String,
  port:            u16,
  user:            String,
  password:        Option<String>,
  #[serde(rename = "keyPath")]
  key_path:        Option<String>,
  #[serde(rename = "authType")]
  auth_type:       Option<String>,
  #[serde(rename = "connectTimeout")]
  connect_timeout: Option<u64>,
}

#[derive(Debug, Serialize)]
struct FtpTestResult {
  ok:         bool,
  message:    String,
  elapsed_ms: u128,
}

#[derive(Debug, Serialize)]
struct FtpFileEntry {
  name:        String,
  path:        String,
  is_dir:      bool,
  size:        u64,
  modified_at: Option<String>,
}

#[tauri::command]
async fn ftp_test(connection: FtpConnectionParams) -> Result<FtpTestResult, String> {
  let start = std::time::Instant::now();
  match connection.protocol.as_str() {
    "sftp"        => sftp_test(&connection, start).await,
    "ftp" | "ftps" => ftp_plain_test(&connection, start).await,
    p             => Err(format!("Protocollo '{}' non supportato. Usa: ftp, ftps, sftp", p)),
  }
}

#[tauri::command]
async fn ftp_list(
  connection:  FtpConnectionParams,
  remote_path: String,
  pattern:     Option<String>,
  recursive:   Option<bool>,
) -> Result<Vec<FtpFileEntry>, String> {
  match connection.protocol.as_str() {
    "sftp"        => sftp_list(&connection, &remote_path, pattern.as_deref(), recursive.unwrap_or(false)).await,
    "ftp" | "ftps" => ftp_plain_list(&connection, &remote_path, pattern.as_deref()).await,
    p             => Err(format!("Protocollo '{}' non supportato", p)),
  }
}

#[tauri::command]
async fn ftp_read(connection: FtpConnectionParams, remote_path: String) -> Result<String, String> {
  match connection.protocol.as_str() {
    "sftp"        => sftp_read(&connection, &remote_path).await,
    "ftp" | "ftps" => ftp_plain_read(&connection, &remote_path).await,
    p             => Err(format!("Protocollo '{}' non supportato", p)),
  }
}

#[tauri::command]
async fn ftp_write(
  connection:  FtpConnectionParams,
  remote_path: String,
  content:     String,
  create_dirs: Option<bool>,
  atomic:      Option<bool>,
) -> Result<u64, String> {
  match connection.protocol.as_str() {
    "sftp"        => sftp_write(&connection, &remote_path, &content, create_dirs.unwrap_or(true), atomic.unwrap_or(true)).await,
    "ftp" | "ftps" => ftp_plain_write(&connection, &remote_path, &content).await,
    p             => Err(format!("Protocollo '{}' non supportato", p)),
  }
}

fn sftp_connect_sync(conn: &FtpConnectionParams) -> Result<ssh2::Session, String> {
  let timeout = std::time::Duration::from_secs(conn.connect_timeout.unwrap_or(30));
  let addr    = format!("{}:{}", conn.host, conn.port);
  use std::net::ToSocketAddrs;
  let socket_addr = addr.to_socket_addrs()
    .map_err(|e| format!("Risoluzione DNS fallita per '{}': {}", addr, e))?
    .next()
    .ok_or_else(|| format!("Nessun indirizzo trovato per '{}'", addr))?;
  let tcp = std::net::TcpStream::connect_timeout(&socket_addr, timeout)
    .map_err(|e| format!("Connessione TCP fallita a {}: {}", addr, e))?;
  tcp.set_read_timeout(Some(timeout)).ok();
  tcp.set_write_timeout(Some(timeout)).ok();
  let mut session = ssh2::Session::new().map_err(|e| format!("Errore sessione SSH: {}", e))?;
  session.set_tcp_stream(tcp);
  session.handshake().map_err(|e| format!("SSH handshake fallito: {}", e))?;
  let auth_type = conn.auth_type.as_deref().unwrap_or("password");
  if auth_type == "key" {
    let key_path  = conn.key_path.as_deref().ok_or("keyPath non specificato")?;
    let passphrase = conn.password.as_deref();
    session.userauth_pubkey_file(&conn.user, None, std::path::Path::new(key_path), passphrase)
      .map_err(|e| format!("Auth SSH con chiave fallita: {}", e))?;
  } else {
    let password = conn.password.as_deref().unwrap_or("");
    session.userauth_password(&conn.user, password)
      .map_err(|e| format!("Auth SSH con password fallita: {}", e))?;
  }
  if !session.authenticated() { return Err("Autenticazione SSH fallita".to_string()); }
  Ok(session)
}

async fn sftp_test(conn: &FtpConnectionParams, start: std::time::Instant) -> Result<FtpTestResult, String> {
  let c       = conn.clone();
  let timeout = std::time::Duration::from_secs(c.connect_timeout.unwrap_or(10));
  let result = tokio::time::timeout(
    timeout,
    tokio::task::spawn_blocking(move || {
      match sftp_connect_sync(&c) {
        Ok(_) => Ok(FtpTestResult { ok: true, message: format!("SFTP connesso a {}:{} come {}", c.host, c.port, c.user), elapsed_ms: start.elapsed().as_millis() }),
        Err(e) => Ok(FtpTestResult { ok: false, message: e, elapsed_ms: start.elapsed().as_millis() }),
      }
    })
  ).await;
  match result {
    Ok(Ok(r)) => r,
    Ok(Err(e)) => Ok(FtpTestResult { ok: false, message: format!("Errore interno: {}", e), elapsed_ms: start.elapsed().as_millis() }),
    Err(_) => Ok(FtpTestResult { ok: false, message: format!("Timeout: nessuna risposta da {}:{} entro {}s", conn.host, conn.port, conn.connect_timeout.unwrap_or(10)), elapsed_ms: start.elapsed().as_millis() }),
  }
}

async fn sftp_list(conn: &FtpConnectionParams, remote_path: &str, pattern: Option<&str>, _recursive: bool) -> Result<Vec<FtpFileEntry>, String> {
  let c = conn.clone(); let path = remote_path.to_string(); let pat = pattern.map(|s| s.to_string());
  tokio::task::spawn_blocking(move || {
    let session = sftp_connect_sync(&c)?;
    let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
    let entries = sftp.readdir(std::path::Path::new(&path)).map_err(|e| format!("SFTP readdir '{}': {}", path, e))?;
    Ok(entries.into_iter().filter_map(|(p, stat)| {
      let name = p.file_name()?.to_string_lossy().to_string();
      if let Some(ref pat) = pat { if !glob_match(pat, &name) { return None; } }
      let modified_at = stat.mtime.and_then(|t| chrono::DateTime::<chrono::Utc>::from_timestamp(t as i64, 0).map(|dt| dt.to_rfc3339()));
      Some(FtpFileEntry { path: format!("{}/{}", path.trim_end_matches('/'), name), name, is_dir: stat.is_dir(), size: stat.size.unwrap_or(0), modified_at })
    }).collect())
  }).await.map_err(|e| e.to_string())?
}

async fn sftp_read(conn: &FtpConnectionParams, remote_path: &str) -> Result<String, String> {
  use std::io::Read;
  let c = conn.clone(); let path = remote_path.to_string();
  tokio::task::spawn_blocking(move || {
    let session = sftp_connect_sync(&c)?;
    let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
    let mut file = sftp.open(std::path::Path::new(&path)).map_err(|e| format!("SFTP open '{}': {}", path, e))?;
    let mut content = String::new();
    file.read_to_string(&mut content).map_err(|e| format!("SFTP read: {}", e))?;
    Ok(content)
  }).await.map_err(|e| e.to_string())?
}

async fn sftp_write(conn: &FtpConnectionParams, remote_path: &str, content: &str, create_dirs: bool, atomic: bool) -> Result<u64, String> {
  use std::io::Write;
  let c = conn.clone(); let path = remote_path.to_string();
  let data = content.as_bytes().to_vec(); let data_len = data.len() as u64;
  tokio::task::spawn_blocking(move || {
    let session = sftp_connect_sync(&c)?;
    let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
    if create_dirs { if let Some(parent) = std::path::Path::new(&path).parent() { let _ = sftp_mkdir_p(&sftp, parent); } }
    let write_path = if atomic { format!("{}.tmp", path) } else { path.clone() };
    let mut file = sftp.create(std::path::Path::new(&write_path)).map_err(|e| format!("SFTP create '{}': {}", write_path, e))?;
    file.write_all(&data).map_err(|e| format!("SFTP write: {}", e))?;
    drop(file);
    if atomic { sftp.rename(std::path::Path::new(&write_path), std::path::Path::new(&path), Some(ssh2::RenameFlags::OVERWRITE)).map_err(|e| format!("SFTP rename: {}", e))?; }
    Ok(data_len)
  }).await.map_err(|e| e.to_string())?
}

fn sftp_mkdir_p(sftp: &ssh2::Sftp, path: &std::path::Path) -> Result<(), String> {
  if sftp.stat(path).is_ok() { return Ok(()); }
  if let Some(parent) = path.parent() { if parent != path { let _ = sftp_mkdir_p(sftp, parent); } }
  sftp.mkdir(path, 0o755).map_err(|e| format!("SFTP mkdir: {}", e))
}

async fn ftp_plain_connect(conn: &FtpConnectionParams) -> Result<suppaftp::AsyncFtpStream, String> {
  let addr     = format!("{}:{}", conn.host, conn.port);
  let user     = conn.user.clone();
  let password = conn.password.clone().unwrap_or_default();
  let mut ftp  = suppaftp::AsyncFtpStream::connect(&addr).await.map_err(|e| format!("FTP connessione a {}: {}", addr, e))?;
  ftp.login(&user, &password).await.map_err(|e| format!("FTP login: {}", e))?;
  Ok(ftp)
}

async fn ftp_plain_test(conn: &FtpConnectionParams, start: std::time::Instant) -> Result<FtpTestResult, String> {
  let addr    = format!("{}:{}", conn.host, conn.port);
  let user    = conn.user.clone();
  let timeout = std::time::Duration::from_secs(conn.connect_timeout.unwrap_or(10));
  let result  = tokio::time::timeout(timeout, ftp_plain_connect(conn)).await;
  match result {
    Ok(Ok(mut ftp)) => { let _ = ftp.quit().await; Ok(FtpTestResult { ok: true, message: format!("FTP connesso a {} come {}", addr, user), elapsed_ms: start.elapsed().as_millis() }) }
    Ok(Err(e)) => Ok(FtpTestResult { ok: false, message: e, elapsed_ms: start.elapsed().as_millis() }),
    Err(_) => Ok(FtpTestResult { ok: false, message: format!("Timeout: nessuna risposta da {} entro {}s", addr, conn.connect_timeout.unwrap_or(10)), elapsed_ms: start.elapsed().as_millis() }),
  }
}

async fn ftp_plain_list(conn: &FtpConnectionParams, remote_path: &str, pattern: Option<&str>) -> Result<Vec<FtpFileEntry>, String> {
  let path = remote_path.to_string(); let pat = pattern.map(|s| s.to_string());
  let mut ftp = ftp_plain_connect(conn).await?;
  let list = ftp.nlst(Some(&path)).await.map_err(|e| format!("FTP list '{}': {}", path, e))?;
  let _ = ftp.quit().await;
  Ok(list.into_iter().filter_map(|entry| {
    let name = std::path::Path::new(&entry).file_name()?.to_string_lossy().to_string();
    if let Some(ref pat) = pat { if !glob_match(pat, &name) { return None; } }
    Some(FtpFileEntry { name, path: entry, is_dir: false, size: 0, modified_at: None })
  }).collect())
}

async fn ftp_plain_read(conn: &FtpConnectionParams, remote_path: &str) -> Result<String, String> {
  use futures_util::io::AsyncReadExt;
  let path = remote_path.to_string(); let mut ftp = ftp_plain_connect(conn).await?;
  let mut stream = ftp.retr_as_stream(&path).await.map_err(|e| format!("FTP retr '{}': {}", path, e))?;
  let mut content = Vec::new();
  stream.read_to_end(&mut content).await.map_err(|e| format!("FTP read: {}", e))?;
  ftp.finalize_retr_stream(stream).await.map_err(|e| format!("FTP finalize: {}", e))?;
  let _ = ftp.quit().await;
  String::from_utf8(content).map_err(|e| format!("FTP UTF-8: {}", e))
}

async fn ftp_plain_write(conn: &FtpConnectionParams, remote_path: &str, content: &str) -> Result<u64, String> {
  use futures_util::io::Cursor;
  let path = remote_path.to_string(); let data = content.as_bytes().to_vec(); let len = data.len() as u64;
  let mut ftp = ftp_plain_connect(conn).await?; let mut cursor = Cursor::new(data);
  ftp.put_file(&path, &mut cursor).await.map_err(|e| format!("FTP put '{}': {}", path, e))?;
  let _ = ftp.quit().await; Ok(len)
}

fn glob_match(pattern: &str, name: &str) -> bool {
  let pat: Vec<char> = pattern.chars().collect(); let txt: Vec<char> = name.chars().collect();
  let (mut pi, mut ti) = (0, 0); let (mut star_pi, mut star_ti) = (usize::MAX, 0);
  while ti < txt.len() {
    if pi < pat.len() && (pat[pi] == '?' || pat[pi] == txt[ti]) { pi += 1; ti += 1; }
    else if pi < pat.len() && pat[pi] == '*' { star_pi = pi; star_ti = ti; pi += 1; }
    else if star_pi != usize::MAX { pi = star_pi + 1; star_ti += 1; ti = star_ti; }
    else { return false; }
  }
  while pi < pat.len() && pat[pi] == '*' { pi += 1; }
  pi == pat.len()
}

//--------Mail ------
use lettre::{
    AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor,
    message::{header::ContentType, Attachment, MultiPart, SinglePart},
    transport::smtp::authentication::Credentials,
    transport::smtp::client::{Tls, TlsParameters},
};

#[derive(Debug, Deserialize)]
struct SmtpConfig {
    host:     String, port: u16, username: String, password: String, security: String,
}

#[derive(Debug, Deserialize)]
struct MailAttachmentRequest {
    filename:     String, content_b64: String, content_type: String,
}

#[derive(Debug, Deserialize)]
struct MailSendRequest {
    smtp:        SmtpConfig, from: String, to: Vec<String>, cc: Vec<String>, bcc: Vec<String>,
    subject:     String, html: Option<String>, text: Option<String>,
    attachments: Vec<MailAttachmentRequest>,
}

#[tauri::command]
async fn mail_send(request: MailSendRequest) -> Result<(), String> {
    let from_mailbox = request.from.parse::<lettre::message::Mailbox>().map_err(|e| format!("Indirizzo mittente non valido: {}", e))?;
    let mut builder = Message::builder().from(from_mailbox);
    for addr in &request.to { let mb = addr.parse::<lettre::message::Mailbox>().map_err(|e| format!("TO non valido '{}': {}", addr, e))?; builder = builder.to(mb); }
    for addr in &request.cc { let mb = addr.parse::<lettre::message::Mailbox>().map_err(|e| format!("CC non valido '{}': {}", addr, e))?; builder = builder.cc(mb); }
    for addr in &request.bcc { let mb = addr.parse::<lettre::message::Mailbox>().map_err(|e| format!("BCC non valido '{}': {}", addr, e))?; builder = builder.bcc(mb); }
    builder = builder.subject(&request.subject);
    let body = build_mail_body(&request)?;
    let email = builder.multipart(body).map_err(|e| format!("Errore costruzione email: {}", e))?;
    let creds = Credentials::new(request.smtp.username.clone(), request.smtp.password.clone());
    let transport: AsyncSmtpTransport<Tokio1Executor> = match request.smtp.security.as_str() {
        "ssl" => {
            let tls = TlsParameters::new(request.smtp.host.clone()).map_err(|e| format!("TLS error: {}", e))?;
            AsyncSmtpTransport::<Tokio1Executor>::relay(&request.smtp.host).map_err(|e| format!("SMTP relay error: {}", e))?.port(request.smtp.port).tls(Tls::Wrapper(tls)).credentials(creds).build()
        }
        "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&request.smtp.host).port(request.smtp.port).credentials(creds).build(),
        _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&request.smtp.host).map_err(|e| format!("STARTTLS error: {}", e))?.port(request.smtp.port).credentials(creds).build(),
    };
    transport.send(email).await.map_err(|e| format!("Invio SMTP fallito: {}", e))?;
    Ok(())
}

fn build_mail_body(request: &MailSendRequest) -> Result<MultiPart, String> {
    let text_part = match (&request.html, &request.text) {
        (Some(html), Some(text)) => MultiPart::alternative().singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(text.clone())).singlepart(SinglePart::builder().header(ContentType::TEXT_HTML).body(html.clone())),
        (Some(html), None) => MultiPart::alternative().singlepart(SinglePart::builder().header(ContentType::TEXT_HTML).body(html.clone())),
        (None, Some(text)) => MultiPart::alternative().singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(text.clone())),
        (None, None) => MultiPart::alternative().singlepart(SinglePart::builder().header(ContentType::TEXT_PLAIN).body(String::new())),
    };
    if request.attachments.is_empty() { return Ok(text_part); }
    let mut mixed = MultiPart::mixed().multipart(text_part);
    for att in &request.attachments {
        let data = base64::engine::general_purpose::STANDARD.decode(&att.content_b64).map_err(|e| format!("Allegato '{}' base64 non valido: {}", att.filename, e))?;
        let content_type = att.content_type.parse::<lettre::message::header::ContentType>().unwrap_or_else(|_| "application/octet-stream".parse().unwrap());
        mixed = mixed.singlepart(Attachment::new(att.filename.clone()).body(data, content_type));
    }
    Ok(mixed)
}

//-----mqtt-----
#[derive(Debug, Deserialize, Clone)]
struct MqttConnectionParams {
    host: String, port: u16, client_id: String, username: Option<String>, password: Option<String>,
    keep_alive: u64, clean_session: bool, use_tls: bool,
}
#[derive(Debug, Deserialize)]
struct MqttSubscribeRequest { connection: MqttConnectionParams, topic: String, qos: u8, timeout_ms: u64, max_messages: usize }
#[derive(Debug, Serialize)]
struct MqttMessage { topic: String, payload: String, qos: u8, retain: bool, received_at: String }
#[derive(Debug, Deserialize)]
struct MqttPublishRequest { connection: MqttConnectionParams, topic: String, payload: String, qos: u8, retain: bool }

fn mqtt_qos(qos: u8) -> rumqttc::QoS {
    match qos { 0 => rumqttc::QoS::AtMostOnce, 2 => rumqttc::QoS::ExactlyOnce, _ => rumqttc::QoS::AtLeastOnce }
}

fn build_mqtt_options(conn: &MqttConnectionParams) -> rumqttc::MqttOptions {
    let mut opts = rumqttc::MqttOptions::new(&conn.client_id, &conn.host, conn.port);
    opts.set_keep_alive(std::time::Duration::from_secs(conn.keep_alive));
    opts.set_clean_session(conn.clean_session);
    if let (Some(user), Some(pass)) = (&conn.username, &conn.password) { opts.set_credentials(user, pass); }
    opts
}

#[tauri::command]
async fn mqtt_subscribe(request: MqttSubscribeRequest) -> Result<Vec<MqttMessage>, String> {
    use rumqttc::{AsyncClient, Event, Incoming};
    let opts = build_mqtt_options(&request.connection);
    let (client, mut eventloop) = AsyncClient::new(opts, 64);
    client.subscribe(&request.topic, mqtt_qos(request.qos)).await.map_err(|e| format!("MQTT subscribe fallito: {}", e))?;
    let mut messages: Vec<MqttMessage> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(request.timeout_ms);
    loop {
        if messages.len() >= request.max_messages { break; }
        match tokio::time::timeout_at(deadline, eventloop.poll()).await {
            Ok(Ok(Event::Incoming(Incoming::Publish(publish)))) => {
                messages.push(MqttMessage { topic: publish.topic.clone(), payload: String::from_utf8_lossy(&publish.payload).to_string(), qos: publish.qos as u8, retain: publish.retain, received_at: chrono::Utc::now().to_rfc3339() });
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => { return Err(format!("MQTT errore connessione: {}", e)); }
            Err(_) => { break; }
        }
    }
    client.disconnect().await.ok();
    Ok(messages)
}

#[tauri::command]
async fn mqtt_publish(request: MqttPublishRequest) -> Result<(), String> {
    use rumqttc::{AsyncClient, Event, Incoming};
    let opts = build_mqtt_options(&request.connection);
    let (client, mut eventloop) = AsyncClient::new(opts, 16);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(10);
    loop {
        match tokio::time::timeout_at(deadline, eventloop.poll()).await {
            Ok(Ok(Event::Incoming(Incoming::ConnAck(_)))) => break,
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("MQTT connessione fallita: {}", e)),
            Err(_)     => return Err("MQTT: timeout connessione (10s)".to_string()),
        }
    }
    client.publish(&request.topic, mqtt_qos(request.qos), request.retain, request.payload.as_bytes()).await.map_err(|e| format!("MQTT publish fallito: {}", e))?;
    if request.qos > 0 {
        let deadline2 = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match tokio::time::timeout_at(deadline2, eventloop.poll()).await {
                Ok(Ok(Event::Incoming(Incoming::PubAck(_)))) => break,
                Ok(Ok(Event::Incoming(Incoming::PubComp(_)))) => break,
                Ok(Ok(_)) => {}
                Ok(Err(e)) => return Err(format!("MQTT ack fallito: {}", e)),
                Err(_) => break,
            }
        }
    }
    client.disconnect().await.ok();
    Ok(())
}

#[derive(Debug, Deserialize, Clone)]
struct StompConnectionParams { host: String, port: u16, username: String, password: String, vhost: String, use_tls: bool }
#[derive(Debug, Deserialize)]
struct StompSubscribeRequest { connection: StompConnectionParams, destination: String, dest_type: String, ack_mode: String, selector: Option<String>, timeout_ms: u64, max_messages: usize }
#[derive(Debug, Serialize)]
struct StompMessage { destination: String, payload: String, headers: std::collections::HashMap<String, String>, message_id: String, received_at: String }
#[derive(Debug, Deserialize)]
struct StompPublishRequest { connection: StompConnectionParams, destination: String, dest_type: String, payload: String, persistent: bool, priority: u8, ttl: u64, correlation_id: Option<String> }

#[tauri::command]
async fn stomp_subscribe(request: StompSubscribeRequest) -> Result<Vec<StompMessage>, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpStream;
    let addr = format!("{}:{}", request.connection.host, request.connection.port);
    let stream = tokio::time::timeout(std::time::Duration::from_secs(10), TcpStream::connect(&addr)).await
        .map_err(|_| format!("STOMP: timeout connessione a {}", addr))?
        .map_err(|e| format!("STOMP: connessione fallita a {}: {}", addr, e))?;
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let connect_frame = format!("CONNECT\naccept-version:1.0,1.1,1.2\nhost:{}\nlogin:{}\npasscode:{}\n\n\0", request.connection.vhost, request.connection.username, request.connection.password);
    writer.write_all(connect_frame.as_bytes()).await.map_err(|e| format!("STOMP CONNECT fallito: {}", e))?;
    let connected = read_stomp_frame(&mut reader).await?;
    if !connected.starts_with("CONNECTED") { return Err(format!("STOMP: handshake fallito — risposta: {}", &connected[..connected.len().min(100)])); }
    let dest = format_stomp_destination(&request.destination, &request.dest_type);
    let ack = if request.ack_mode == "client" { "client" } else { "auto" };
    let mut sub_frame = format!("SUBSCRIBE\nid:sub-0\ndestination:{}\nack:{}\n", dest, ack);
    if let Some(sel) = &request.selector { sub_frame.push_str(&format!("selector:{}\n", sel)); }
    sub_frame.push_str("\n\0");
    writer.write_all(sub_frame.as_bytes()).await.map_err(|e| format!("STOMP SUBSCRIBE fallito: {}", e))?;
    let mut messages: Vec<StompMessage> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(request.timeout_ms);
    loop {
        if messages.len() >= request.max_messages { break; }
        match tokio::time::timeout_at(deadline, read_stomp_frame(&mut reader)).await {
            Ok(Ok(frame)) => {
                if frame.starts_with("MESSAGE") {
                    if let Some(msg) = parse_stomp_message(&frame, &dest) {
                        if ack == "client" { if let Some(msg_id) = msg.headers.get("message-id") { let ack_frame = format!("ACK\nid:{}\n\n\0", msg_id); writer.write_all(ack_frame.as_bytes()).await.ok(); } }
                        messages.push(msg);
                    }
                }
            }
            Ok(Err(e)) => return Err(format!("STOMP: errore lettura: {}", e)),
            Err(_) => break,
        }
    }
    let disconnect = format!("DISCONNECT\nreceipt:rec-1\n\n\0");
    writer.write_all(disconnect.as_bytes()).await.ok();
    Ok(messages)
}

#[tauri::command]
async fn stomp_publish(request: StompPublishRequest) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpStream;
    let addr = format!("{}:{}", request.connection.host, request.connection.port);
    let stream = tokio::time::timeout(std::time::Duration::from_secs(10), TcpStream::connect(&addr)).await
        .map_err(|_| format!("STOMP: timeout connessione a {}", addr))?
        .map_err(|e| format!("STOMP: connessione fallita: {}", e))?;
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let connect_frame = format!("CONNECT\naccept-version:1.0,1.1,1.2\nhost:{}\nlogin:{}\npasscode:{}\n\n\0", request.connection.vhost, request.connection.username, request.connection.password);
    writer.write_all(connect_frame.as_bytes()).await.map_err(|e| format!("STOMP CONNECT fallito: {}", e))?;
    let connected = read_stomp_frame(&mut reader).await?;
    if !connected.starts_with("CONNECTED") { return Err(format!("STOMP: handshake fallito")); }
    let dest = format_stomp_destination(&request.destination, &request.dest_type);
    let receipt_id = format!("send-{}", chrono::Utc::now().timestamp_millis());
    let mut send_frame = format!("SEND\ndestination:{}\ncontent-length:{}\ndelivery-mode:{}\npriority:{}\nreceipt:{}\n", dest, request.payload.len(), if request.persistent { "persistent" } else { "non-persistent" }, request.priority, receipt_id);
    if request.ttl > 0 { send_frame.push_str(&format!("expires:{}\n", chrono::Utc::now().timestamp_millis() + request.ttl as i64)); }
    if let Some(cid) = &request.correlation_id { send_frame.push_str(&format!("correlation-id:{}\n", cid)); }
    send_frame.push('\n');
    send_frame.push_str(&request.payload);
    send_frame.push('\0');
    writer.write_all(send_frame.as_bytes()).await.map_err(|e| format!("STOMP SEND fallito: {}", e))?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, read_stomp_frame(&mut reader)).await {
            Ok(Ok(frame)) if frame.starts_with("RECEIPT") => break,
            Ok(Ok(frame)) if frame.starts_with("ERROR") => { return Err(format!("STOMP ERROR: {}", &frame[..frame.len().min(200)])); }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("STOMP: errore attesa receipt: {}", e)),
            Err(_) => break,
        }
    }
    writer.write_all(b"DISCONNECT\n\n\0").await.ok();
    Ok(())
}

fn format_stomp_destination(name: &str, dest_type: &str) -> String {
    if name.starts_with('/') { return name.to_string(); }
    match dest_type { "topic" => format!("/topic/{}", name), _ => format!("/queue/{}", name) }
}

async fn read_stomp_frame<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<String, String> {
    let mut frame = String::new(); let mut line = String::new();
    loop {
        line.clear();
        let n = tokio::io::AsyncBufReadExt::read_line(reader, &mut line).await.map_err(|e| format!("STOMP read error: {}", e))?;
        if n == 0 { break; }
        frame.push_str(&line);
        if line.contains('\0') { break; }
    }
    Ok(frame)
}

fn parse_stomp_message(frame: &str, destination: &str) -> Option<StompMessage> {
    let mut headers = std::collections::HashMap::new(); let mut payload = String::new(); let mut in_body = false;
    for line in frame.lines() {
        if line.is_empty() { in_body = true; continue; }
        if in_body { payload.push_str(line.trim_end_matches('\0')); continue; }
        if line == "MESSAGE" { continue; }
        if let Some((k, v)) = line.split_once(':') { headers.insert(k.trim().to_lowercase(), v.trim().to_string()); }
    }
    let message_id = headers.get("message-id").cloned().unwrap_or_else(|| format!("msg-{}", chrono::Utc::now().timestamp_millis()));
    let dest = headers.get("destination").cloned().unwrap_or_else(|| destination.to_string());
    Some(StompMessage { destination: dest, payload, headers, message_id, received_at: chrono::Utc::now().to_rfc3339() })
}

// ═══════════════════════════════════════════════════════════════════
// WEBHOOK — server HTTP condiviso, Responder (flow + monitor), Watchdog
// ═══════════════════════════════════════════════════════════════════

use hmac::{Hmac, Mac};
use sha2::Sha256;
use sha1::Sha1;

#[derive(Debug, Clone, Serialize)]
struct WebhookEvent {
    event_id:        String,
    event_type:      String,
    source_ip:       String,
    path:            String,
    headers:         std::collections::HashMap<String, String>,
    payload:         serde_json::Value,
    received_at:     String,
    signature_valid: Option<bool>,
}

struct WebhookSubscriber {
    node_id:       String,
    secret:        String,
    sig_header:    String,
    sig_algo:      String,
    dedup_ttl_sec: u64,
    max_buffer:    usize,
    overflow:      String,
    queue:         VecDeque<WebhookEvent>,
    seen:          std::collections::HashMap<String, Instant>,
}

impl WebhookSubscriber {
    fn new(node_id: String, secret: String, sig_header: String, sig_algo: String, dedup_ttl_sec: u64, max_buffer: usize, overflow: String) -> Self {
        Self { node_id, secret, sig_header, sig_algo, dedup_ttl_sec, max_buffer, overflow, queue: VecDeque::new(), seen: std::collections::HashMap::new() }
    }
    fn is_duplicate(&mut self, event_id: &str) -> bool {
        if self.dedup_ttl_sec == 0 { return false; }
        let ttl = std::time::Duration::from_secs(self.dedup_ttl_sec);
        self.seen.retain(|_, ts: &mut Instant| ts.elapsed() < ttl);
        self.seen.contains_key(event_id)
    }
    fn push(&mut self, event: WebhookEvent) {
        if self.is_duplicate(&event.event_id) { return; }
        if self.queue.len() >= self.max_buffer {
            match self.overflow.as_str() { "drop_oldest" => { self.queue.pop_front(); } _ => return }
        }
        if self.dedup_ttl_sec > 0 { self.seen.insert(event.event_id.clone(), Instant::now()); }
        self.queue.push_back(event);
    }
    fn pop(&mut self) -> Option<WebhookEvent> { self.queue.pop_front() }
    fn queued(&self) -> usize { self.queue.len() }
}

struct WebhookServerState {
    subscribers: std::collections::HashMap<String, WebhookSubscriber>,
}
impl WebhookServerState {
    fn new() -> Self { Self { subscribers: std::collections::HashMap::new() } }
    fn deliver(&mut self, path: &str, event: WebhookEvent) {
        if let Some(sub) = self.subscribers.get_mut(path) { sub.push(event); }
    }
}

type SharedWebhookState = Arc<Mutex<WebhookServerState>>;

struct WebhookServerEntry {
    state:       SharedWebhookState,
    shutdown_tx: tokio::sync::oneshot::Sender<()>,
}

static WEBHOOK_SERVERS: std::sync::OnceLock<Arc<Mutex<std::collections::HashMap<String, WebhookServerEntry>>>> = std::sync::OnceLock::new();
fn webhook_servers() -> &'static Arc<Mutex<std::collections::HashMap<String, WebhookServerEntry>>> {
    WEBHOOK_SERVERS.get_or_init(|| Arc::new(Mutex::new(std::collections::HashMap::new())))
}

// Responder registry — tupla a 3: (shutdown_tx, request_count, headers_dinamici)
type ResponderHeaders = Arc<Mutex<std::collections::HashMap<String, String>>>;
type ResponderEntry   = (tokio::sync::oneshot::Sender<()>, Arc<std::sync::atomic::AtomicU64>, ResponderHeaders);

static WEBHOOK_RESPONDERS: std::sync::OnceLock<Arc<Mutex<std::collections::HashMap<String, ResponderEntry>>>> = std::sync::OnceLock::new();
fn webhook_responders() -> &'static Arc<Mutex<std::collections::HashMap<String, ResponderEntry>>> {
    WEBHOOK_RESPONDERS.get_or_init(|| Arc::new(Mutex::new(std::collections::HashMap::new())))
}

fn webhook_verify_hmac(body: &[u8], secret: &str, sig_val: &str, algo: &str) -> bool {
    if secret.is_empty() { return true; }
    let hex_part = if sig_val.contains('=') { sig_val.splitn(2, '=').nth(1).unwrap_or(sig_val) } else { sig_val };
    let Ok(expected) = hex::decode(hex_part) else { return false };
    match algo {
        "sha256" => { let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes()).unwrap(); mac.update(body); mac.verify_slice(&expected).is_ok() }
        "sha1"   => { let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes()).unwrap();   mac.update(body); mac.verify_slice(&expected).is_ok() }
        _ => false,
    }
}

fn webhook_event_id(headers: &std::collections::HashMap<String, String>, body: &[u8]) -> String {
    for h in &["x-webhook-delivery","x-delivery-id","x-github-delivery","x-shopify-webhook-id"] {
        if let Some(v) = headers.get(*h) { return v.clone(); }
    }
    if let Some(v) = headers.get("x-stripe-signature") {
        if let Some(ts) = v.split(',').find(|p| p.starts_with("t=")) { return ts.to_string(); }
    }
    use sha2::Digest;
    hex::encode(&sha2::Sha256::digest(body)[..8])
}

#[derive(Debug, Deserialize)]
struct WebhookServerStartRequest { resource_id: String, port: u16, ip_whitelist: Vec<String> }

#[tauri::command]
async fn webhook_server_start(request: WebhookServerStartRequest) -> Result<(), String> {
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper::{Request, Response, StatusCode};
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;

    { let reg = webhook_servers().lock().unwrap(); if reg.contains_key(&request.resource_id) { return Ok(()); } }

    let addr: std::net::SocketAddr = format!("0.0.0.0:{}", request.port).parse().map_err(|e| format!("Porta non valida: {}", e))?;
    let state    = Arc::new(Mutex::new(WebhookServerState::new()));
    let state_cl = Arc::clone(&state);
    let (tx, rx) = tokio::sync::oneshot::channel::<()>();
    let whitelist = request.ip_whitelist.clone();
    { let mut reg = webhook_servers().lock().unwrap(); reg.insert(request.resource_id.clone(), WebhookServerEntry { state: Arc::clone(&state), shutdown_tx: tx }); }

    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await { Ok(l) => l, Err(e) => { eprintln!("Webhook: bind fallito su {}: {}", addr, e); return; } };
        eprintln!("Webhook server avviato su {}", addr);
        let mut rx = rx;
        loop {
            tokio::select! {
                accept = listener.accept() => {
                    let Ok((stream, peer_addr)) = accept else { continue };
                    let peer_ip = peer_addr.ip().to_string();
                    if !whitelist.is_empty() {
                        let ok = whitelist.iter().any(|e| e == &peer_ip || e == "0.0.0.0" || e.is_empty());
                        if !ok { eprintln!("Webhook: IP {} non autorizzato", peer_ip); continue; }
                    }
                    let state = Arc::clone(&state_cl);
                    tokio::spawn(async move {
                        let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                            let state = Arc::clone(&state); let ip = peer_ip.clone();
                            async move {
                                let req_path = req.uri().path().to_string();
                                let mut hdrs: std::collections::HashMap<String, String> = std::collections::HashMap::new();
                                for (k, v) in req.headers() { if let Ok(val) = v.to_str() { hdrs.insert(k.as_str().to_lowercase(), val.to_string()); } }
                                let body_bytes = req.collect().await.map(|b| b.to_bytes()).unwrap_or_default();
                                let response = Response::builder().status(StatusCode::OK).header("Content-Type", "application/json").header("X-Webhook-Received", "true").body(Full::new(Bytes::from(r#"{"status":"received"}"#))).unwrap();
                                let event_opt = {
                                    let sl = state.lock().unwrap();
                                    sl.subscribers.get(&req_path).map(|sub| {
                                        let sig_val = hdrs.get(&sub.sig_header).map(|s| s.as_str()).unwrap_or("");
                                        let sig_valid = if sub.secret.is_empty() { None } else { Some(webhook_verify_hmac(&body_bytes, &sub.secret, sig_val, &sub.sig_algo)) };
                                        let event_id = webhook_event_id(&hdrs, &body_bytes);
                                        let event_type = hdrs.get("x-webhook-event").or(hdrs.get("x-github-event")).or(hdrs.get("x-shopify-topic")).cloned().unwrap_or_default();
                                        let payload: serde_json::Value = serde_json::from_slice(&body_bytes).unwrap_or(serde_json::Value::String(String::from_utf8_lossy(&body_bytes).to_string()));
                                        WebhookEvent { event_id, event_type, source_ip: ip.clone(), path: req_path.clone(), headers: hdrs, payload, received_at: chrono::Utc::now().to_rfc3339(), signature_valid: sig_valid }
                                    })
                                };
                                if let Some(event) = event_opt { state.lock().unwrap().deliver(&event.path.clone(), event); }
                                Ok::<_, hyper::Error>(response)
                            }
                        });
                        let io = hyper_util::rt::TokioIo::new(stream);
                        let _ = http1::Builder::new().serve_connection(io, svc).await;
                    });
                }
                _ = &mut rx => { eprintln!("Webhook server: shutdown"); break; }
            }
        }
    });
    Ok(())
}

#[tauri::command]
async fn webhook_server_stop(resource_id: String) -> Result<(), String> {
    if let Some(entry) = webhook_servers().lock().unwrap().remove(&resource_id) { let _ = entry.shutdown_tx.send(()); }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct WebhookSubscribeRequest { resource_id: String, node_id: String, path: String, secret: String, sig_header: String, sig_algo: String, dedup_ttl_sec: u64, max_buffer: usize, overflow: String }

#[tauri::command]
async fn webhook_subscribe(request: WebhookSubscribeRequest) -> Result<(), String> {
    let reg   = webhook_servers().lock().unwrap();
    let entry = reg.get(&request.resource_id).ok_or_else(|| format!("Server webhook '{}' non avviato", request.resource_id))?;
    let mut state = entry.state.lock().unwrap();
    let sub = WebhookSubscriber::new(request.node_id.clone(), request.secret, request.sig_header.to_lowercase(), request.sig_algo, request.dedup_ttl_sec, request.max_buffer.max(1), request.overflow);
    state.subscribers.insert(request.path.clone(), sub);
    eprintln!("Webhook: {} registrato su {}", request.node_id, request.path);
    Ok(())
}

#[tauri::command]
async fn webhook_unsubscribe(resource_id: String, node_id: String) -> Result<(), String> {
    let reg = webhook_servers().lock().unwrap();
    if let Some(entry) = reg.get(&resource_id) { entry.state.lock().unwrap().subscribers.retain(|_, s| s.node_id != node_id); }
    Ok(())
}

#[derive(Debug, Serialize)]
struct WebhookPopResult { event: Option<WebhookEvent>, queued: usize }

#[tauri::command]
async fn webhook_pop(resource_id: String, node_id: String) -> Result<WebhookPopResult, String> {
    let reg = webhook_servers().lock().unwrap();
    let Some(entry) = reg.get(&resource_id) else { return Ok(WebhookPopResult { event: None, queued: 0 }); };
    let mut state = entry.state.lock().unwrap();
    let sub_opt = state.subscribers.values_mut().find(|s| s.node_id == node_id);
    match sub_opt {
        None => Ok(WebhookPopResult { event: None, queued: 0 }),
        Some(sub) => { let event = sub.pop(); let queued = sub.queued(); Ok(WebhookPopResult { event, queued }) }
    }
}

// ─── Responder — con headers dinamici aggiornabili a runtime ─────

#[derive(Debug, Deserialize)]
struct WebhookResponderStartRequest {
    node_id: String, port: u16, path: String,
    methods: Vec<String>,
    headers: std::collections::HashMap<String, String>,
}

#[tauri::command]
async fn webhook_responder_start(request: WebhookResponderStartRequest) -> Result<(), String> {
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper::{Request, Response, StatusCode};
    use http_body_util::Full;
    use hyper::body::Bytes;

    let addr: std::net::SocketAddr = format!("0.0.0.0:{}", request.port).parse().map_err(|e| format!("Porta non valida: {}", e))?;

    let (tx, rx)  = tokio::sync::oneshot::channel::<()>();
    let req_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let req_count_cl = Arc::clone(&req_count);

    // Headers dinamici — inizializzati con i valori di avvio, aggiornabili via webhook_responder_update_headers
    let headers_state: ResponderHeaders = Arc::new(Mutex::new(request.headers.clone()));
    let headers_cl = Arc::clone(&headers_state);

    webhook_responders().lock().unwrap().insert(request.node_id.clone(), (tx, req_count, headers_state));

    let path    = request.path.clone();
    let methods = request.methods.iter().map(|m| m.to_uppercase()).collect::<Vec<_>>();

    tokio::spawn(async move {
        let listener = match tokio::net::TcpListener::bind(addr).await { Ok(l) => l, Err(e) => { eprintln!("Responder: bind fallito: {}", e); return; } };
        let mut rx = rx;
        loop {
            tokio::select! {
                accept = listener.accept() => {
                    let Ok((stream, _)) = accept else { continue };
                    let path    = path.clone();
                    let methods = methods.clone();
                    let hdrs    = Arc::clone(&headers_cl);
                    let cnt     = Arc::clone(&req_count_cl);
                    tokio::spawn(async move {
                        let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                            let path = path.clone(); let methods = methods.clone();
                            let hdrs = Arc::clone(&hdrs); let cnt = Arc::clone(&cnt);
                            async move {
                                let method = req.method().as_str().to_uppercase();
                                if req.uri().path() != path || !methods.contains(&method) {
                                    return Ok::<_, hyper::Error>(Response::builder().status(StatusCode::NOT_FOUND).body(Full::new(Bytes::new())).unwrap());
                                }
                                cnt.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
                                let status = if method == "HEAD" { StatusCode::NO_CONTENT } else { StatusCode::OK };
                                // Legge gli header al momento della richiesta — sempre aggiornati
                                let current_headers = hdrs.lock().unwrap().clone();
                                let mut builder = Response::builder().status(status);
                                for (k, v) in &current_headers { builder = builder.header(k.as_str(), v.as_str()); }
                                Ok::<_, hyper::Error>(builder.body(Full::new(Bytes::new())).unwrap())
                            }
                        });
                        let io = hyper_util::rt::TokioIo::new(stream);
                        let _ = http1::Builder::new().serve_connection(io, svc).await;
                    });
                }
                _ = &mut rx => break,
            }
        }
    });
    Ok(())
}

/// Aggiorna gli header esposti dal Responder senza riavviarlo.
/// Chiamato dall'executor TypeScript sia in modalità flow (per ogni riga)
/// che in modalità monitor (ad ogni ciclo di polling delle variabili di lane).
#[tauri::command]
async fn webhook_responder_update_headers(
    node_id: String,
    headers: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let reg = webhook_responders().lock().unwrap();
    if let Some((_, _, headers_state)) = reg.get(&node_id) {
        *headers_state.lock().unwrap() = headers;
    }
    Ok(())
}

#[tauri::command]
async fn webhook_responder_request_count(node_id: String) -> Result<u64, String> {
    Ok(webhook_responders().lock().unwrap().get(&node_id)
        .map(|(_, cnt, _)| cnt.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(0))
}

#[tauri::command]
async fn webhook_responder_stop(node_id: String) -> Result<(), String> {
    if let Some((tx, _, _)) = webhook_responders().lock().unwrap().remove(&node_id) { let _ = tx.send(()); }
    Ok(())
}

// ─── Watchdog ─────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct WatchdogCheckRequest {
    url: String, method: String, header_name: String, header_value: String,
    match_mode: String, auth_type: String, auth_value: String, timeout_sec: u64,
}

#[derive(Debug, Serialize)]
struct WatchdogCheckResult { matched: bool, header_found: Option<String>, status_code: u16, elapsed_ms: u64 }

#[tauri::command]
async fn watchdog_check(request: WatchdogCheckRequest) -> Result<WatchdogCheckResult, String> {
    let start  = Instant::now();
    let client = reqwest::Client::builder().timeout(std::time::Duration::from_secs(request.timeout_sec)).build().map_err(|e| format!("Watchdog client: {}", e))?;
    let method = match request.method.to_uppercase().as_str() { "GET" => reqwest::Method::GET, _ => reqwest::Method::HEAD };
    let mut rb = client.request(method, &request.url);
    match request.auth_type.as_str() {
        "bearer"  => { rb = rb.bearer_auth(&request.auth_value); }
        "basic"   => { let p: Vec<&str> = request.auth_value.splitn(2,':').collect(); if p.len()==2 { rb = rb.basic_auth(p[0], Some(p[1])); } }
        "api_key" => { let p: Vec<&str> = request.auth_value.splitn(2,':').collect(); if p.len()==2 { rb = rb.header(p[0].trim(), p[1].trim()); } }
        _ => {}
    }
    let resp        = rb.send().await.map_err(|e| format!("Watchdog: {}", e))?;
    let status_code = resp.status().as_u16();
    let elapsed_ms  = start.elapsed().as_millis() as u64;
    let header_found = resp.headers().iter().find(|(k,_)| k.as_str().eq_ignore_ascii_case(&request.header_name)).and_then(|(_,v)| v.to_str().ok()).map(|s| s.to_string());
    let matched = match request.match_mode.as_str() {
        "present"  => header_found.is_some(),
        "contains" => header_found.as_deref().map(|v| v.to_lowercase().contains(&request.header_value.to_lowercase())).unwrap_or(false),
        _          => header_found.as_deref().map(|v| v.eq_ignore_ascii_case(&request.header_value)).unwrap_or(false),
    };
    Ok(WatchdogCheckResult { matched, header_found, status_code, elapsed_ms })
}

// ─── Shell exec ─────────────────────────────────────────────────────

#[derive(serde::Deserialize)]
struct ShellExecRequest {
    pub command:     String,
    pub cwd:         Option<String>,
    pub timeout_sec: Option<u64>,
    pub env:         Option<HashMap<String, String>>,
}

#[derive(serde::Serialize)]
struct ShellResult {
    pub exit_code:   i32,
    pub stdout:      String,
    pub stderr:      String,
    pub duration_ms: u64,
}


#[tauri::command]
async fn shell_exec(request: ShellExecRequest) -> Result<ShellResult, String> {
    let start = Instant::now();

    let mut cmd = tokio::process::Command::new("/bin/sh");
    cmd.arg("-c").arg(&request.command);

    if let Some(cwd) = &request.cwd {
        cmd.current_dir(cwd);
    }

    if let Some(env) = &request.env {
        for (k, v) in env {
            cmd.env(k, v);
        }
    }

    cmd.stdout(std::process::Stdio::piped());
    cmd.stderr(std::process::Stdio::piped());

    let output = if let Some(timeout_secs) = request.timeout_sec {
        tokio::time::timeout(
            std::time::Duration::from_secs(timeout_secs),
            cmd.output(),
        )
        .await
        .map_err(|_| format!("Shell: timeout dopo {}s", timeout_secs))?
        .map_err(|e| format!("Shell: errore avvio — {}", e))?
    } else {
        cmd.output()
            .await
            .map_err(|e| format!("Shell: errore avvio — {}", e))?
    };

    let duration_ms = start.elapsed().as_millis() as u64;

    Ok(ShellResult {
        exit_code:   output.status.code().unwrap_or(-1),
        stdout:      String::from_utf8_lossy(&output.stdout).to_string(),
        stderr:      String::from_utf8_lossy(&output.stderr).to_string(),
        duration_ms,
    })
}

// ─── SSH exec ─────────────────────────────────────────────────────

#[derive(serde::Deserialize, Clone)]
struct SshConnection {
    pub host:                String,
    pub port:                u16,
    pub user:                String,
    pub auth_type:           String,   // "password" | "key" | "key_passphrase"
    pub password:            Option<String>,
    pub key_path:            Option<String>,
    pub key_passphrase:      Option<String>,
    pub known_hosts_check:   bool,
    pub connect_timeout_sec: u64,
}

#[derive(serde::Deserialize)]
struct SshExecRequest {
    pub connection:  SshConnection,
    pub command:     String,
    pub timeout_sec: Option<u64>,
}

#[derive(serde::Serialize)]
struct SshTestResult {
    pub ok:         bool,
    pub message:    String,
    pub elapsed_ms: u64,
}

fn build_ssh_session(conn: &SshConnection) -> Result<ssh2::Session, String> {
    use std::net::TcpStream;
    use std::time::Duration;

    let addr = format!("{}:{}", conn.host, conn.port);
    let tcp  = TcpStream::connect_timeout(
        &addr.parse().map_err(|e| format!("SSH: indirizzo non valido — {}", e))?,
        Duration::from_secs(conn.connect_timeout_sec),
    ).map_err(|e| format!("SSH: connessione TCP fallita — {}", e))?;

    let mut sess = ssh2::Session::new()
        .map_err(|e| format!("SSH: errore sessione — {}", e))?;
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("SSH: handshake fallito — {}", e))?;

    // Autenticazione
    match conn.auth_type.as_str() {
        "password" => {
            let pwd = conn.password.as_deref().unwrap_or("");
            sess.userauth_password(&conn.user, pwd)
                .map_err(|e| format!("SSH: autenticazione password fallita — {}", e))?;
        }
        "key" | "key_passphrase" => {
            let key_path = conn.key_path.as_deref()
                .ok_or("SSH: key_path non configurato")?;
            let passphrase = if conn.auth_type == "key_passphrase" {
                conn.key_passphrase.as_deref()
            } else {
                None
            };
            sess.userauth_pubkey_file(
                &conn.user,
                None,
                std::path::Path::new(key_path),
                passphrase,
            ).map_err(|e| format!("SSH: autenticazione chiave fallita — {}", e))?;
        }
        _ => return Err(format!("SSH: auth_type '{}' non supportato", conn.auth_type)),
    }

    if !sess.authenticated() {
        return Err("SSH: autenticazione fallita".to_string());
    }

    Ok(sess)
}

#[tauri::command]
async fn ssh_exec(request: SshExecRequest) -> Result<ShellResult, String> {
    let conn    = request.connection.clone();
    let command = request.command.clone();
    let timeout = request.timeout_sec;

    // ssh2 non è async — esegui in thread separato
    let result = tokio::task::spawn_blocking(move || -> Result<ShellResult, String> {
        let start = Instant::now();
        let sess  = build_ssh_session(&conn)?;

        let mut channel = sess.channel_session()
            .map_err(|e| format!("SSH: errore apertura canale — {}", e))?;

        channel.exec(&command)
            .map_err(|e| format!("SSH: errore esecuzione — {}", e))?;

        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();

        channel.read_to_string(&mut stdout_buf)
            .map_err(|e| format!("SSH: errore lettura stdout — {}", e))?;

        channel.stderr().read_to_string(&mut stderr_buf)
            .map_err(|e| format!("SSH: errore lettura stderr — {}", e))?;

        channel.wait_close()
            .map_err(|e| format!("SSH: errore chiusura canale — {}", e))?;

        let exit_code   = channel.exit_status().unwrap_or(-1);
        let duration_ms = start.elapsed().as_millis() as u64;

        Ok(ShellResult { exit_code, stdout: stdout_buf, stderr: stderr_buf, duration_ms })
    })
    .await
    .map_err(|e| format!("SSH: errore thread — {}", e))??;

    Ok(result)
}

#[tauri::command]
async fn ssh_test(connection: SshConnection) -> Result<SshTestResult, String> {
    let start = Instant::now();
    let conn  = connection.clone();

    let result = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let sess = build_ssh_session(&conn)?;
        // Esegui comando di probe minimale
        let mut ch = sess.channel_session()
            .map_err(|e| format!("SSH: {}", e))?;
        ch.exec("echo ok")
            .map_err(|e| format!("SSH: {}", e))?;
        ch.wait_close().ok();
        Ok(())
    })
    .await
    .map_err(|e| format!("thread: {}", e))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;

    match result {
        Ok(_) => Ok(SshTestResult {
            ok:         true,
            message:    format!("Connessione a {}:{} riuscita ({}ms)", connection.host, connection.port, elapsed_ms),
            elapsed_ms,
        }),
        Err(e) => Ok(SshTestResult {
            ok:         false,
            message:    e,
            elapsed_ms,
        }),
    }
}