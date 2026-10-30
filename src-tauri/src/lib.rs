// P382: allocatore globale per TUTTI i binari (studio, runner, monitor). Il motore
// alloca molte piccole strutture per riga; con l'allocatore di sistema malloc/free
// pesavano il 40% del tempo. Misure in docs/STUDIO-motore-prestazioni.md.
#[global_allocator]
static GLOBAL_ALLOCATOR: mimalloc::MiMalloc = mimalloc::MiMalloc;

#[cfg(feature = "desktop")]
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
    engine_preview_node,
  };


#[cfg(feature = "desktop")]
mod db_transactions;
#[cfg(feature = "desktop")]
mod db_stream;
mod memory_monitor;  // aggiungere vicino agli altri mod
pub mod engine;   // esposto: usato anche dal binario runner headless (src/bin/flowpilot_runner.rs)
pub(crate) mod odbc; // P344: Oracle / Informix / ODBC generico (lettura)
mod sqlsafe;      // P338: SQL dinamico sotto sqlx 0.9 (identificatori validati, AssertSqlSafe motivato)
mod secrets;      // provider segreti: risolve i ${SEGRETO} nei config risorsa (env-var; env-var + keychain)
pub mod signing;  // catena di fiducia degli artifact (firma): forma canonica + planHash (HANDOFF-firma-artifact.md)
pub mod runtime;  // P378: profilo della runtime + ammissione unica (docs/ARCHITETTURA-coordinatore.md)

#[cfg(feature = "desktop")]
#[tauri::command]
fn secret_set(name: String, value: String) -> Result<(), String> { crate::secrets::set_secret(&name, &value) }
#[cfg(feature = "desktop")]
#[tauri::command]
fn secret_has(name: String) -> bool { crate::secrets::has_secret(&name) }
#[cfg(feature = "desktop")]
#[tauri::command]
fn secret_delete(name: String) -> Result<(), String> { crate::secrets::delete_secret(&name) }

// ─── Identita' dello STUDIO (provenienza degli artifact) ──────────
// Un artifact compilato qui porta con se' CHI l'ha compilato, cosi' che un monitor
// centralizzato possa distinguere artifact prodotti da studi/sviluppatori diversi.
// - `id`    = UUID generato UNA volta e conservato in ~/.flowpilot/studio.json
// - `label` = etichetta LEGGIBILE modificabile dall'utente (es. "marco-portatile");
//             al primo avvio si propone hostname/utente del sistema operativo.
// ⚠️ ONESTA': identifica l'INSTALLAZIONE, non la persona (chi reinstalla cambia id,
// chi copia il file si spaccia per un altro). Non e' autenticazione: per quella
// servirebbe una firma (chiave privata) o un canale autenticato.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StudioIdentity {
    id:    String,
    label: String,
}

fn studio_identity_path() -> std::path::PathBuf {
    let home = std::env::var("HOME")
        .or_else(|_| std::env::var("USERPROFILE"))
        .unwrap_or_else(|_| ".".to_string());
    std::path::PathBuf::from(home).join(".flowpilot").join("studio.json")
}

/// Etichetta proposta al primo avvio: hostname del sistema, altrimenti l'utente.
fn default_studio_label() -> String {
    if let Ok(h) = std::env::var("HOSTNAME") {
        if !h.trim().is_empty() { return h.trim().to_string() }
    }
    if let Ok(h) = std::env::var("COMPUTERNAME") {
        if !h.trim().is_empty() { return h.trim().to_string() }
    }
    if let Ok(h) = std::fs::read_to_string("/etc/hostname") {
        if !h.trim().is_empty() { return h.trim().to_string() }
    }
    std::env::var("USER").or_else(|_| std::env::var("USERNAME")).unwrap_or_else(|_| "studio".to_string())
}

fn load_or_create_studio_identity() -> StudioIdentity {
    let path = studio_identity_path();
    if let Ok(txt) = std::fs::read_to_string(&path) {
        if let Ok(idn) = serde_json::from_str::<StudioIdentity>(&txt) {
            if !idn.id.is_empty() { return idn }
        }
    }
    let idn = StudioIdentity {
        id:    uuid::Uuid::new_v4().to_string(),
        label: default_studio_label(),
    };
    if let Some(dir) = path.parent() { let _ = std::fs::create_dir_all(dir); }
    let _ = std::fs::write(&path, serde_json::to_string_pretty(&idn).unwrap_or_default());
    idn
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn studio_identity() -> Result<StudioIdentity, String> {
    Ok(load_or_create_studio_identity())
}

/// Sigilla un artifact: costruisce il manifesto (planHash ricalcolato dal piano,
/// keyId, alg, engineVersionRange, createdAt), lo firma con la chiave dello
/// sviluppatore (~/.flowpilot/signing-key.json) e restituisce { manifest, sig,
/// publicKey }. Vedi HANDOFF-firma-artifact.md §5.
#[cfg(feature = "desktop")]
#[tauri::command]
fn artifact_seal(
    plan: serde_json::Value,
    meta: serde_json::Value,
) -> Result<serde_json::Value, String> {
    // P381: le variabili configurabili si controllano con lo STESSO codice del
    // runner prima di firmare: un pattern che il runner non compila o un default
    // fuori dai vincoli darebbero un artifact firmato ma mai ammissibile.
    crate::runtime::config::declared_variables(&meta)
        .map_err(|e| format!("variabili configurabili: {e}"))?;
    crate::signing::seal::seal(&plan, &meta)
}

/// Identità di firma dello sviluppatore: keyId + chiave pubblica, letti dal file
/// cifrato SENZA passphrase. Vuoti se la chiave non esiste ancora (l'utente la
/// crea dalla voce Firma). Vedi §7. Per lo stato completo usa `vault_status`.
#[cfg(feature = "desktop")]
#[tauri::command]
fn artifact_signing_identity() -> Result<serde_json::Value, String> {
    let path = crate::signing::keys::default_key_path();
    match crate::signing::vault::load_identity(&path) {
        Some(id) => Ok(serde_json::json!({ "keyId": id.key_id, "publicKey": id.public_b64 })),
        None => Ok(serde_json::json!({ "keyId": "", "publicKey": "" })),
    }
}

// ── VAULT della chiave di firma (cifrata a riposo) — comandi per la UI (§7) ──

/// Stato del vault: se esiste una chiave, se è sbloccata in memoria, e la sua
/// identità pubblica (keyId/publicKey), senza richiedere la passphrase.
#[cfg(feature = "desktop")]
#[tauri::command]
fn vault_status() -> Result<serde_json::Value, String> {
    let path = crate::signing::keys::default_key_path();
    let id = crate::signing::vault::load_identity(&path);
    Ok(serde_json::json!({
        "exists":   crate::signing::vault::key_exists(&path),
        "unlocked": crate::signing::vault::is_unlocked(),
        "keyId":    id.as_ref().map(|i| i.key_id.clone()),
        "publicKey":id.as_ref().map(|i| i.public_b64.clone()),
    }))
}

/// Sblocca la chiave con la passphrase (la tiene in memoria per la sessione).
#[cfg(feature = "desktop")]
#[tauri::command]
fn vault_unlock(passphrase: String) -> Result<serde_json::Value, String> {
    let path = crate::signing::keys::default_key_path();
    let id = crate::signing::vault::unlock(&path, &passphrase)?;
    Ok(serde_json::json!({ "keyId": id.key_id, "publicKey": id.public_b64 }))
}

/// Ri-blocca la chiave (la dimentica dalla memoria).
#[cfg(feature = "desktop")]
#[tauri::command]
fn vault_lock() {
    crate::signing::vault::lock();
}

/// Genera una NUOVA chiave dal sistema, la salva cifrata con la passphrase e la
/// sblocca. Sovrascrive l'eventuale chiave esistente (cambia identità).
#[cfg(feature = "desktop")]
#[tauri::command]
fn vault_generate(passphrase: String) -> Result<serde_json::Value, String> {
    let path = crate::signing::keys::default_key_path();
    let seed = crate::signing::vault::generate_seed();
    let id = crate::signing::vault::save_encrypted(&path, &seed, &passphrase)?;
    crate::signing::vault::unlock(&path, &passphrase)?;
    Ok(serde_json::json!({ "keyId": id.key_id, "publicKey": id.public_b64 }))
}

/// Importa una chiave fornita dall'utente (seed Ed25519 in base64, 32 byte), la
/// salva cifrata con la passphrase e la sblocca. Sovrascrive l'esistente.
#[cfg(feature = "desktop")]
#[tauri::command]
fn vault_import(seed: String, passphrase: String) -> Result<serde_json::Value, String> {
    let path = crate::signing::keys::default_key_path();
    let s = crate::signing::vault::seed_from_b64(&seed)?;
    let id = crate::signing::vault::save_encrypted(&path, &s, &passphrase)?;
    crate::signing::vault::unlock(&path, &passphrase)?;
    Ok(serde_json::json!({ "keyId": id.key_id, "publicKey": id.public_b64 }))
}

#[cfg(feature = "desktop")]
#[tauri::command]
fn studio_identity_set_label(label: String) -> Result<StudioIdentity, String> {
    let mut idn = load_or_create_studio_identity();
    let label = label.trim().to_string();
    idn.label = if label.is_empty() { default_studio_label() } else { label };
    let path = studio_identity_path();
    if let Some(dir) = path.parent() { std::fs::create_dir_all(dir).map_err(|e| e.to_string())?; }
    std::fs::write(&path, serde_json::to_string_pretty(&idn).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    Ok(idn)
}

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

#[cfg(feature = "desktop")]
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
#[cfg(feature = "desktop")]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_dialog::init())
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
        secret_set,
        secret_has,
        secret_delete,
        studio_identity,
        artifact_seal,
        artifact_signing_identity,
        vault_status,
        vault_unlock,
        vault_lock,
        vault_generate,
        vault_import,
        studio_identity_set_label,
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
        engine::engine_preview_node,
        engine::stop_run,
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
        ldap_test,
        github_test,
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
  // P344 — ODBC (oracle / informix / odbc): driver per nome o percorso, DSN,
  // connection string completa, parametri aggiuntivi.
  #[serde(rename = "odbcDriver")]
  driver:          Option<String>,
  dsn:             Option<String>,
  #[serde(rename = "connectionString")]
  connection_string: Option<String>,
  #[serde(rename = "odbcParams")]
  odbc_params:     Option<String>,
}

impl DbConnectionParams {
  /// Parametri ODBC dalla richiesta dello studio (P344).
  #[cfg_attr(not(feature = "desktop"), allow(dead_code))]
  pub(crate) fn odbc_target(&self) -> crate::odbc::OdbcTarget {
    let s = |o: &Option<String>| o.clone().unwrap_or_default().trim().to_string();
    crate::odbc::OdbcTarget {
      dialect:           self.dialect.clone(),
      host:              s(&self.host),
      port:              self.port,
      database:          s(&self.database),
      user:              s(&self.user),
      password:          self.password.clone().unwrap_or_default(),
      service_name:      s(&self.service_name),
      db_server_name:    s(&self.db_server_name),
      driver:            s(&self.driver),
      dsn:               s(&self.dsn),
      connection_string: s(&self.connection_string),
      extra:             s(&self.odbc_params),
    }
  }
}

#[derive(Debug, Deserialize)]
struct DbQueryRequest {
  connection: DbConnectionParams,
  query:      String,
  #[serde(rename = "fetchSize")]
  fetch_size: Option<u32>,
  timeout:    Option<u64>,
  /// P344: massimo di righe da restituire (anteprima). Serve ai dialetti ODBC,
  /// dove non si puo' avvolgere la query con un LIMIT portabile.
  #[serde(rename = "maxRows")]
  max_rows:   Option<usize>,
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
#[cfg(feature = "desktop")]
#[tauri::command]
async fn db_list_constraints(request: DbListConstraintsRequest) -> Result<Vec<DbConstraintInfo>, String> {
  let conn_str = build_connection_string(&request.connection)?;
  match request.connection.dialect.as_str() {
    "postgresql" => pg_list_constraints(&conn_str, request.schema.as_deref().unwrap_or("public"), &request.table).await,
    "mysql"      => mysql_list_constraints(&conn_str, &request.connection.database.clone().unwrap_or_default(), &request.table).await,
    "sqlite"     => sqlite_list_constraints(&conn_str, &request.table).await,
    // P345: chiave primaria dal catalogo ODBC (i vincoli UNIQUE non sono esposti
    // in modo portabile dai cataloghi ODBC).
    d if crate::odbc::is_odbc_dialect(d) => {
      let pk = crate::odbc::primary_key(conn_str, d.to_string(), request.schema.clone(), request.table.clone()).await?;
      Ok(pk.into_iter().map(|(name, columns)| DbConstraintInfo { name, constraint_type: "primary_key".into(), columns }).collect())
    }
    d            => Err(format!("Dialect '{}' not supported for constraint list", d)),
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
    d if crate::odbc::is_odbc_dialect(d) => crate::odbc::connection_string(&conn.odbc_target()),
    d => Err(format!("Dialect '{}' not supported.", d)),
  }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn db_query(request: DbQueryRequest) -> Result<Vec<serde_json::Value>, String> {
  let conn_str = build_connection_string(&request.connection)?;
  match request.connection.dialect.as_str() {
    "postgresql" => pg_query(&conn_str, &request.query, request.timeout).await,
    "mysql"      => mysql_query(&conn_str, &request.query, request.timeout).await,
    "sqlite"     => sqlite_query(&conn_str, &request.query, request.timeout).await,
    d if crate::odbc::is_odbc_dialect(d) =>
      crate::odbc::query_json(conn_str, d.to_string(), request.query.clone(), request.max_rows, request.timeout).await,
    d            => Err(format!("Dialect '{}' not supported", d)),
  }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn db_infer_schema(request: DbQueryRequest) -> Result<Vec<DbColumnInfo>, String> {
  let conn_str = build_connection_string(&request.connection)?;
  let base     = request.query.trim().trim_end_matches(';');
  // P344 — ODBC: si PREPARA la query e se ne leggono le colonne senza
  // eseguirla (niente LIMIT/ROWNUM/FIRST da indovinare per dialetto).
  if crate::odbc::is_odbc_dialect(&request.connection.dialect) {
    let cols = crate::odbc::describe_json(conn_str, request.connection.dialect.clone(), base.to_string()).await?;
    return Ok(cols.into_iter().enumerate().map(|(i, (name, db_type, nullable))| DbColumnInfo {
      name, db_type, nullable, position: i,
    }).collect());
  }
  let probe = match request.connection.dialect.as_str() {
    "postgresql" | "mysql" | "sqlite" => format!("SELECT * FROM ({}) AS __probe__ LIMIT 0", base),
    "oracle"   => format!("SELECT * FROM ({}) WHERE ROWNUM = 0", base),
    "informix" => format!("SELECT FIRST 0 * FROM ({}) t", base),
    d          => return Err(format!("Dialect '{}' not supported", d)),
  };
  match request.connection.dialect.as_str() {
    "postgresql" => pg_infer(&conn_str, &probe).await,
    "mysql"      => mysql_infer(&conn_str, &probe).await,
    "sqlite"     => sqlite_infer(&conn_str, &probe).await,
    d            => Err(format!("Dialect '{}' not supported", d)),
  }
}

#[derive(Debug, Deserialize, Clone)]
pub struct DbColumnFunction {
  pub column: String,
  pub expr:   String,
}

/// P349: condizione su una colonna chiave per UPDATE e DELETE, come nel
/// mapping dello studio: operatore (`=`, `!=`, `>`, `<`, `>=`, `<=`, `LIKE`,
/// `IS NULL`, `IS NOT NULL`) e legame con la condizione precedente
/// (`AND`/`OR`, precedenze normali dell'SQL — come l'anteprima dello studio).
/// Prima il motore usava sempre `=` e `AND`: un DELETE con `>` cancellava
/// righe diverse da quelle configurate.
#[derive(Debug, Deserialize, Clone)]
pub struct DbKeyCondition {
  pub column: String,
  #[serde(default = "key_op_default")]
  pub op:     String,
  #[serde(default = "key_logic_default")]
  pub logic:  String,
}
fn key_op_default() -> String { "=".to_string() }
fn key_logic_default() -> String { "AND".to_string() }

/// Operatore SQL ammesso e se lega un valore.
fn key_sql_op(op: &str) -> Result<(&'static str, bool), String> {
  Ok(match op.trim().to_uppercase().as_str() {
    "=" => ("=", true),
    "!=" | "<>" => ("<>", true),
    ">" => (">", true),
    "<" => ("<", true),
    ">=" => (">=", true),
    "<=" => ("<=", true),
    "LIKE" => ("LIKE", true),
    "IS NULL" => ("IS NULL", false),
    "IS NOT NULL" => ("IS NOT NULL", false),
    other => return Err(format!("key operator '{}' is not supported", other)),
  })
}

/// Upsert e merge usano le chiavi come identita' della riga: solo `=` e `AND`.
pub(crate) fn check_key_conditions(mode: &str, conds: &Option<Vec<DbKeyCondition>>) -> Result<(), String> {
  for c in conds.iter().flatten() {
    key_sql_op(&c.op)?;
    let logic = c.logic.trim().to_uppercase();
    if logic != "AND" && logic != "OR" {
      return Err(format!("key logic '{}' is not supported (AND or OR)", c.logic));
    }
    if matches!(mode, "upsert" | "merge") && (key_sql_op(&c.op)?.0 != "=" || logic == "OR") {
      return Err(format!(
        "{} matches rows on the key columns with '=' and AND: operator '{}' / '{}' on '{}' is only for UPDATE and DELETE",
        mode.to_uppercase(), c.op, c.logic, c.column));
    }
  }
  Ok(())
}

/// WHERE di UPDATE/DELETE sulle colonne chiave (P349). Rispetta operatori,
/// AND/OR e le funzioni di colonna (`UPPER($VALUE)`, `NOW()`), come
/// l'anteprima dello studio. Restituisce l'SQL e i valori da legare, in ordine.
pub(crate) fn where_plan<'a>(
  keys: &[String],
  conds: &Option<Vec<DbKeyCondition>>,
  fields: &'a [(String, serde_json::Value)],
  column_functions: &Option<Vec<DbColumnFunction>>,
  style: PlaceholderStyle,
  start_index: usize,
  quote: &dyn Fn(&str) -> String,
) -> Result<(String, Vec<&'a serde_json::Value>), String> {
  let fn_map: std::collections::HashMap<&str, &str> = column_functions.as_ref()
    .map(|v| v.iter().map(|cf| (cf.column.as_str(), cf.expr.as_str())).collect())
    .unwrap_or_default();
  let mut next = start_index;
  let mut sql = String::new();
  let mut binds = Vec::new();
  for (i, k) in keys.iter().enumerate() {
    let cond = conds.as_ref().and_then(|v| v.iter().find(|c| &c.column == k));
    let (op, needs_value) = key_sql_op(cond.map(|c| c.op.as_str()).unwrap_or("="))?;
    if i > 0 {
      let logic = cond.map(|c| c.logic.trim().to_uppercase()).unwrap_or_else(|| "AND".to_string());
      sql.push_str(if logic == "OR" { " OR " } else { " AND " });
    }
    if !needs_value {
      sql.push_str(&format!("{} {}", quote(k), op));
      continue;
    }
    let mut placeholder = || match style {
      PlaceholderStyle::Dollar => { let p = format!("${}", next); next += 1; p }
      PlaceholderStyle::Question => "?".to_string(),
    };
    let value_sql = match fn_map.get(k.as_str()) {
      Some(expr) if expr.contains("$VALUE") => {
        let v = fields.iter().find(|(f, _)| f == k).map(|(_, v)| v)
          .ok_or_else(|| format!("key field '{}' is missing in the row", k))?;
        binds.push(v);
        expr.replace("$VALUE", &placeholder())
      }
      Some(expr) => expr.to_string(),
      None => {
        let v = fields.iter().find(|(f, _)| f == k).map(|(_, v)| v)
          .ok_or_else(|| format!("key field '{}' is missing in the row", k))?;
        binds.push(v);
        placeholder()
      }
    };
    sql.push_str(&format!("{} {} {}", quote(k), op, value_sql));
  }
  if sql.is_empty() {
    return Err("UPDATE/DELETE need at least one key column (WHERE)".to_string());
  }
  Ok((sql, binds))
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
  /// P349: operatori e AND/OR delle chiavi (UPDATE/DELETE). Assente = `=` e AND.
  #[serde(rename = "keyConditions", default)]
  pub(crate) key_conditions: Option<Vec<DbKeyCondition>>,
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
  /// P350: SQL personalizzato / stored procedure del sink_db (scheda Query).
  /// Lo costruisce il motore, non arriva dal frontend.
  #[serde(skip)]
  pub(crate) custom_sql: Option<CustomSql>,
}

// ─── SQL personalizzato (P350) ────────────────────────────────────
//
// Il testo dell'autore con segnaposto `{campo}`: ogni segnaposto diventa un
// PARAMETRO legato col valore del campo della riga (mai testo incollato
// nell'SQL: niente iniezioni, decimali esatti, date tipizzate). I segnaposto
// dentro apici, virgolette o commenti non sono segnaposto; uno `{campo}` dentro
// una stringa SQL e' un errore (il valore non si potrebbe legare li').

#[derive(Debug, Clone)]
pub(crate) struct CustomSql {
  /// Postgres: `$1…$n`, un numero per ogni campo distinto (ripetuto = stesso numero).
  dollar:         String,
  dollar_names:   Vec<String>,
  /// MySQL, SQLite, ODBC: un `?` per ogni occorrenza.
  question:       String,
  question_names: Vec<String>,
}

impl CustomSql {
  pub(crate) fn text(&self, style: PlaceholderStyle) -> &str {
    match style { PlaceholderStyle::Dollar => &self.dollar, PlaceholderStyle::Question => &self.question }
  }
  /// Nomi dei campi usati (distinti, in ordine di apparizione).
  pub(crate) fn fields(&self) -> &[String] { &self.dollar_names }
  /// Valori da legare, presi dai campi della riga in ingresso.
  pub(crate) fn binds<'a>(&self, row: &'a serde_json::Value, style: PlaceholderStyle) -> Result<Vec<&'a serde_json::Value>, String> {
    let names = match style { PlaceholderStyle::Dollar => &self.dollar_names, PlaceholderStyle::Question => &self.question_names };
    names.iter().map(|n| row.get(n.as_str())
      .ok_or_else(|| format!("custom SQL: the field '{}' is not in the incoming row", n))).collect()
  }
}

/// Analizza il testo dell'autore. Toglie il `;` finale (tranne nei blocchi
/// `BEGIN … END;` / `DECLARE …`, dove fa parte della sintassi PL/SQL).
pub(crate) fn parse_custom_sql(src: &str) -> Result<CustomSql, String> {
  let mut text = src.trim().to_string();
  if text.is_empty() {
    return Err("custom SQL is empty: write the statement in the Query tab".to_string());
  }
  let head = text.to_uppercase();
  if !(head.starts_with("BEGIN") || head.starts_with("DECLARE")) {
    while text.ends_with(';') { text.pop(); text = text.trim_end().to_string(); }
  }
  let is_ident = |s: &str| {
    let mut ch = s.chars();
    matches!(ch.next(), Some(c) if c.is_ascii_alphabetic() || c == '_') && ch.all(|c| c.is_ascii_alphanumeric() || c == '_')
  };
  let chars: Vec<char> = text.chars().collect();
  let (mut dollar, mut question) = (String::new(), String::new());
  let (mut dollar_names, mut question_names): (Vec<String>, Vec<String>) = (Vec::new(), Vec::new());
  let mut i = 0;
  while i < chars.len() {
    let c = chars[i];
    // stringhe, identificatori tra virgolette, commenti: copiati tali e quali
    let (close, until_newline) = match c {
      '\'' => (Some("'"), false),
      '"'  => (Some("\""), false),
      '-' if chars.get(i + 1) == Some(&'-') => (None, true),
      '/' if chars.get(i + 1) == Some(&'*') => (Some("*/"), false),
      _ => (None, false),
    };
    if close.is_some() || until_newline {
      let start = i;
      i += if c == '/' { 2 } else { 1 };
      loop {
        if i >= chars.len() { break }
        if until_newline && chars[i] == '\n' { break }
        if let Some(cl) = close {
          let cl: Vec<char> = cl.chars().collect();
          if chars[i..].starts_with(&cl) {
            // '' dentro una stringa = apice
            if cl == ['\''] && chars.get(i + 1) == Some(&'\'') { i += 2; continue }
            i += cl.len();
            break;
          }
        }
        i += 1;
      }
      let chunk: String = chars[start..i.min(chars.len())].iter().collect();
      if c == '\'' {
        if let Some(pos) = chunk.find('{') {
          if let Some(end) = chunk[pos..].find('}') {
            let name = &chunk[pos + 1..pos + end];
            if is_ident(name) {
              return Err(format!("custom SQL: {{{}}} is inside quotes: write {{{}}} without quotes (the value is passed as a parameter)", name, name));
            }
          }
        }
      }
      dollar.push_str(&chunk);
      question.push_str(&chunk);
      continue;
    }
    if c == '{' {
      if let Some(end) = chars[i + 1..].iter().position(|&x| x == '}') {
        let name: String = chars[i + 1..i + 1 + end].iter().collect();
        if is_ident(&name) {
          let n = match dollar_names.iter().position(|x| x == &name) {
            Some(p) => p + 1,
            None => { dollar_names.push(name.clone()); dollar_names.len() }
          };
          dollar.push_str(&format!("${}", n));
          question.push('?');
          question_names.push(name);
          i += end + 2;
          continue;
        }
      }
    }
    dollar.push(c);
    question.push(c);
    i += 1;
  }
  Ok(CustomSql { dollar, dollar_names, question, question_names })
}

/// P350: valore JSON gia' serializzato (il lotto per la stored procedure),
/// legato come JSON e non come testo qualunque.
pub(crate) const JSON_MARKER: &str = "$fp_json";

pub(crate) fn json_raw(v: &serde_json::Value) -> Option<&str> {
  let o = v.as_object()?;
  if o.len() != 1 { return None }
  o.get(JSON_MARKER)?.as_str()
}

/// JSON di righe di scrittura con i Decimal ESATTI (numero JSON col testo del
/// decimale, non passato da f64).
pub(crate) fn json_text_exact(v: &serde_json::Value, out: &mut String) {
  if let Some(d) = json_decimal(v) {
    out.push_str(d);
    return;
  }
  match v {
    serde_json::Value::Array(a) => {
      out.push('[');
      for (i, x) in a.iter().enumerate() { if i > 0 { out.push(',') } json_text_exact(x, out) }
      out.push(']');
    }
    serde_json::Value::Object(o) => {
      out.push('{');
      for (i, (k, x)) in o.iter().enumerate() {
        if i > 0 { out.push(',') }
        out.push_str(&serde_json::to_string(k).unwrap_or_default());
        out.push(':');
        json_text_exact(x, out);
      }
      out.push('}');
    }
    other => out.push_str(&other.to_string()),
  }
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

#[cfg(feature = "desktop")]
#[tauri::command]
async fn db_write(request: DbWriteRequest) -> Result<DbWriteResult, String> {
  let conn_str = build_connection_string(&request.connection)?;
  let start    = std::time::Instant::now();
  match request.connection.dialect.as_str() {
    "postgresql" => pg_write(&conn_str, &request, start).await,
    "mysql"      => mysql_write(&conn_str, &request, start).await,
    "sqlite"     => sqlite_write(&conn_str, &request, start).await,
    d if crate::odbc::is_odbc_dialect(d) => {
      let pool = crate::odbc::OdbcPool::connect(conn_str, 1, request.connection.connect_timeout.unwrap_or(30), d).await?;
      let res = crate::odbc::write(&pool, &request, start).await;
      pool.close().await;
      res
    }
    d            => Err(format!("Dialect '{}' not supported for writing", d)),
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
    .map_err(|e| format!("SQLite connection failed: {}", e))?;

  let mut result = Vec::new();

  // PRIMARY KEY — da table_info, colonne con pk > 0, ordinate per pk
  let pk_rows = sqlx::query(crate::sqlsafe::composto(format!("PRAGMA table_info({})", crate::sqlsafe::literal(table))))
    .fetch_all(&pool).await
    .map_err(|e| format!("SQLite table_info failed: {}", e))?;

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
  let idx_rows = sqlx::query(crate::sqlsafe::composto(format!("PRAGMA index_list({})", crate::sqlsafe::literal(table))))
    .fetch_all(&pool).await
    .map_err(|e| format!("SQLite index_list failed: {}", e))?;

  for idx_row in &idx_rows {
    let is_unique: i64 = idx_row.try_get("unique").unwrap_or(0);
    let origin: String = idx_row.try_get("origin").unwrap_or_default();
    if is_unique == 0 || origin == "pk" { continue }  // pk già gestita sopra

    let idx_name: String = idx_row.try_get("name").unwrap_or_default();
    let col_rows = sqlx::query(crate::sqlsafe::composto(format!("PRAGMA index_info({})", crate::sqlsafe::literal(&idx_name))))
      .fetch_all(&pool).await
      .map_err(|e| format!("SQLite index_info failed: {}", e))?;

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
    .map_err(|e| format!("MySQL connection failed: {}", e))?;

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
    .map_err(|e| format!("MySQL constraint list failed: {}", e))?;

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
    .map_err(|e| format!("PostgreSQL connection failed: {}", e))?;

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
    .map_err(|e| format!("PostgreSQL constraint list failed: {}", e))?;

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

/// Modalita' di scrittura note (P345). Prima ogni modalita' non riconosciuta
/// finiva nel ramo DELETE: 🐞 con `merge` (offerta dal pannello) il motore
/// CANCELLAVA le righe corrispondenti alle chiavi e riportava successo.
pub(crate) fn check_write_mode(mode: &str, dialect: &str) -> Result<(), String> {
  match mode {
    "insert" | "truncate_insert" | "upsert" | "update" | "delete" => Ok(()),
    "merge" if matches!(dialect, "mysql" | "sqlite") => Err(format!(
      "MERGE is not available on {}: use UPSERT (insert or update on the key)",
      if dialect == "mysql" { "MySQL" } else { "SQLite" })),
    "merge" => Ok(()),
    m => Err(format!("unknown write mode '{}' (expected insert, upsert, update, delete, truncate_insert, merge)", m)),
  }
}

/// Pezzi di un MERGE (P345), con gli alias del pannello: `target` (la tabella)
/// e `source` (la riga). Condizione: quella scritta dall'utente oppure
/// l'uguaglianza delle colonne chiave. Ritorna (lista SELECT della sorgente,
/// condizione ON, SET per WHEN MATCHED — vuoto se non ci sono colonne da
/// aggiornare —, colonne e valori dell'INSERT, valori da legare in ordine).
pub(crate) struct MergeParts<'a> {
  pub source_select: String,
  pub on:            String,
  pub update_set:    String,
  pub insert_cols:   String,
  pub insert_vals:   String,
  pub binds:         Vec<&'a serde_json::Value>,
}

pub(crate) fn merge_parts<'a>(
  fields:           &'a [(String, serde_json::Value)],
  keys:             &[String],
  column_functions: &Option<Vec<DbColumnFunction>>,
  merge_condition:  &Option<String>,
  style:            PlaceholderStyle,
) -> Result<MergeParts<'a>, String> {
  let plan = build_column_plan(fields, column_functions, style, 1);
  let on = match merge_condition.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
    Some(c) => c.to_string(),
    None if !keys.is_empty() => keys.iter()
      .map(|k| format!("target.{} = source.{}", k, k)).collect::<Vec<_>>().join(" AND "),
    None => return Err("MERGE needs a condition or at least one key column".to_string()),
  };
  Ok(MergeParts {
    source_select: plan.iter().map(|p| format!("{} AS {}", p.value_sql, p.column_sql)).collect::<Vec<_>>().join(", "),
    on,
    update_set: plan.iter().filter(|p| !keys.contains(&p.column_sql))
      .map(|p| format!("{} = source.{}", p.column_sql, p.column_sql)).collect::<Vec<_>>().join(", "),
    insert_cols: plan.iter().map(|p| p.column_sql.clone()).collect::<Vec<_>>().join(", "),
    insert_vals: plan.iter().map(|p| format!("source.{}", p.column_sql)).collect::<Vec<_>>().join(", "),
    binds: plan.iter().filter_map(|p| p.bind_value).collect(),
  })
}

/// MERGE in sintassi PostgreSQL (15+). La riga sorgente nasce con i TIPI DELLA
/// TABELLA: `jsonb_populate_record(NULL::tabella, $1)` con un solo parametro
/// JSON. Con `SELECT $1 AS col` Postgres non sa il tipo del parametro e lo
/// tratta come testo: date, numeri e NULL fallirebbero ("column is of type
/// timestamp but expression is of type text"). Le funzioni di colonna valgono
/// come negli altri modi (`$VALUE` → il valore della sorgente).
fn pg_merge_sql(
  tbl: &str,
  fields: &[(String, serde_json::Value)],
  keys: &[String],
  column_functions: &Option<Vec<DbColumnFunction>>,
  merge_condition: &Option<String>,
) -> Result<(String, serde_json::Value), String> {
  let on = match merge_condition.as_deref().map(str::trim).filter(|c| !c.is_empty()) {
    Some(c) => c.to_string(),
    None if !keys.is_empty() => keys.iter()
      .map(|k| format!("target.{} = source.{}", k, k)).collect::<Vec<_>>().join(" AND "),
    None => return Err("MERGE needs a condition or at least one key column".to_string()),
  };
  let fn_map: std::collections::HashMap<&str, &str> = column_functions.as_ref()
    .map(|v| v.iter().map(|cf| (cf.column.as_str(), cf.expr.as_str())).collect())
    .unwrap_or_default();
  let expr = |c: &str| match fn_map.get(c) {
    Some(e) if e.contains("$VALUE") => e.replace("$VALUE", &format!("source.{}", c)),
    Some(e) => e.to_string(),
    None => format!("source.{}", c),
  };
  let cols: Vec<&str> = fields.iter().map(|(c, _)| c.as_str()).collect();
  let set = cols.iter().filter(|c| !keys.iter().any(|k| k == *c))
    .map(|c| format!("{} = {}", c, expr(c))).collect::<Vec<_>>().join(", ");
  let matched = if set.is_empty() { String::new() } else { format!(" WHEN MATCHED THEN UPDATE SET {}", set) };
  // P346: un Decimal marcato entra nel jsonb come stringa: jsonb_populate_record
  // la converte col tipo della colonna (numeric esatto), senza passare da f64.
  let row: serde_json::Map<String, serde_json::Value> = fields.iter()
    .map(|(k, v)| (k.clone(), json_decimal(v).map(|d| serde_json::Value::String(d.to_string())).unwrap_or_else(|| v.clone())))
    .collect();
  Ok((format!(
    "MERGE INTO {t} AS target USING (SELECT * FROM jsonb_populate_record(NULL::{t}, $1)) AS source ON ({on}){matched} WHEN NOT MATCHED THEN INSERT ({cols}) VALUES ({vals})",
    t = tbl, on = on, matched = matched, cols = cols.join(", "),
    vals = cols.iter().map(|c| expr(c)).collect::<Vec<_>>().join(", ")),
    serde_json::Value::Object(row)))
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
    sqlx::query(crate::sqlsafe::autore(stmt)).execute(executor).await.map_err(|e| format!("SQL failed: {}", e))?;
  }
  Ok(())
}


// ─── Helper: legge il valore della prima colonna di una PgRow ─────
pub(crate) fn pg_row_to_json_value(row: &sqlx::postgres::PgRow, idx: usize) -> serde_json::Value {
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
        .map_err(|e| format!("PostgreSQL connection failed: {}", e))?;
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
    if req.custom_sql.is_none() {
        crate::sqlsafe::check_names(&tbl, req.key_fields.as_deref().unwrap_or(&[]), req.columns.as_deref(), req.returning_column.as_deref(), &req.connection.dialect)?;
    }
    check_write_mode(&req.mode, &req.connection.dialect)?;
    check_key_conditions(&req.mode, &req.key_conditions)?;


    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    // Colonna PK da restituire — None se non configurata
    let ret_col = req.returning_column.as_deref();
    let use_returning = ret_col.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(crate::sqlsafe::autore(stmt)).execute(pool).await
                    .map_err(|e| format!("Pre-SQL failed: {}", e))?;
            }
        }
    }

    if req.mode == "truncate_insert" {
        sqlx::query(crate::sqlsafe::composto(format!("TRUNCATE TABLE {}", tbl))).execute(pool).await
            .map_err(|e| format!("TRUNCATE failed: {}", e))?;
    }

    for chunk in req.rows.chunks(req.batch_size.max(1)) {
        batches += 1;
        for row in chunk {
            let fields = extract_row_data(row, &req.columns, &req.exclude_columns);
            // P350: con l'SQL personalizzato i nomi dei campi non diventano identificatori SQL
            if req.custom_sql.is_none() { crate::sqlsafe::check_fields(&fields, &req.connection.dialect)?; }
            if fields.is_empty() { skipped += 1; continue; }

            let default_keys = vec![];
            let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());
            let needs_plan = req.custom_sql.is_none() && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

            let set_fields: Vec<(String, serde_json::Value)> = fields.iter()
                .filter(|(k, _)| !keys.contains(k))
                .cloned()
                .collect();

            let merge_row: serde_json::Value; // riga sorgente del MERGE (P345), vive fino all'esecuzione
            let sql: String;
            let mut bind_list: Vec<&serde_json::Value>;

            if let Some(cs) = &req.custom_sql {
                // P350: SQL personalizzato / stored procedure: un'istruzione per riga
                sql = cs.text(PlaceholderStyle::Dollar).to_string();
                bind_list = cs.binds(row, PlaceholderStyle::Dollar)?;
            } else if needs_plan {
                let plan = build_column_plan(&fields, &req.column_functions, PlaceholderStyle::Dollar, 1);
                let cols = plan.iter().map(|p| p.column_sql.as_str()).collect::<Vec<_>>().join(", ");
                let vals = plan.iter().map(|p| p.value_sql.as_str()).collect::<Vec<_>>().join(", ");
                bind_list = plan.iter().filter_map(|p| p.bind_value).collect();

                let base_sql = match req.mode.as_str() {
                    "upsert" => {
                        let updates = plan.iter()
                            .filter(|p| !keys.contains(&p.column_sql))
                            // P349: la chiave restituita (master-detail) non si riscrive
                            // sull'upsert: con una sequenza cambierebbe a ogni run
                            .filter(|p| Some(p.column_sql.as_str()) != ret_col)
                            .map(|p| format!("{} = EXCLUDED.{}", p.column_sql, p.column_sql))
                            .collect::<Vec<_>>().join(", ");
                        let conflict = keys.join(", ");
                        if updates.is_empty() && use_returning && !keys.is_empty() {
                            // P349: con DO NOTHING il RETURNING non restituisce la riga
                            // esistente; un aggiornamento neutro sulla chiave si'.
                            format!("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO UPDATE SET {} = EXCLUDED.{}",
                                tbl, cols, vals, conflict, keys[0], keys[0])
                        } else if updates.is_empty() {
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
                let (where_c, where_binds) = where_plan(keys, &req.key_conditions, &fields, &req.column_functions,
                    PlaceholderStyle::Dollar, where_start, &|k: &str| k.to_string())?;
                sql = format!("UPDATE {} SET {} WHERE {}", tbl, sets, where_c);
                bind_list = set_plan.iter().filter_map(|p| p.bind_value).collect();
                bind_list.extend(where_binds);
            } else if req.mode == "merge" {
                let (q, row) = pg_merge_sql(&tbl, &fields, keys, &req.column_functions, &req.merge_condition)?;
                merge_row = row;
                sql = q;
                bind_list = vec![&merge_row];
            } else {
                // delete (check_write_mode garantisce che non ci siano altre modalita')
                let (where_c, where_binds) = where_plan(keys, &req.key_conditions, &fields, &req.column_functions,
                    PlaceholderStyle::Dollar, 1, &|k: &str| k.to_string())?;
                sql = format!("DELETE FROM {} WHERE {}", tbl, where_c);
                bind_list = where_binds;
            }

            if use_returning && needs_plan {
                // fetch_one per catturare la chiave generata
                let mut q = sqlx::query(crate::sqlsafe::composto(sql.as_str()));
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
                        "stop" => { return Err(format!("SinkDB row error: {}", e)); }
                        _ => { errors += 1; }
                    }
                }
            } else {
                // execute standard (nessun RETURNING)
                let mut q = sqlx::query(crate::sqlsafe::composto(sql.as_str()));
                for v in &bind_list { q = bind_pg_value(q, v); }
                match q.execute(pool).await {
                    Ok(_) => { written += 1; }
                    Err(e) => match req.on_constraint_error.as_str() {
                        "skip" => { skipped += 1; }
                        "stop" => { return Err(format!("SinkDB row error: {}", e)); }
                        _ => { errors += 1; }
                    }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(crate::sqlsafe::autore(stmt)).execute(pool).await
                    .map_err(|e| format!("Post-SQL failed: {}", e))?;
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

// Variante transazionale: scrive su una connessione condivisa (dentro
// un BEGIN già aperto dal registro), invece che sul pool in autocommit.
// È pg_write_pool con `pool` → `&mut PgConnection`. NON gestisce
// pre/post-SQL né BEGIN/COMMIT: quelli sono responsabilità del gruppo.
pub async fn pg_write_conn(
    conn:  &mut sqlx::postgres::PgConnection,
    req:   &DbWriteRequest,
    start: std::time::Instant,
) -> Result<DbWriteResult, String> {
    use sqlx::Row as SqlxRow;

    let tbl = qualified_table(req);
    if req.custom_sql.is_none() {
        crate::sqlsafe::check_names(&tbl, req.key_fields.as_deref().unwrap_or(&[]), req.columns.as_deref(), req.returning_column.as_deref(), &req.connection.dialect)?;
    }
    check_write_mode(&req.mode, &req.connection.dialect)?;
    check_key_conditions(&req.mode, &req.key_conditions)?;
    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    let ret_col = req.returning_column.as_deref();
    let use_returning = ret_col.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    // NB: pre_sql / truncate / post_sql NON qui — la transazione è
    // gestita dal gruppo. (Se servono in transazione, andranno inseriti
    // nel coordinamento di gruppo, non per-nodo.)

    for chunk in req.rows.chunks(req.batch_size.max(1)) {
        batches += 1;
        for row in chunk {
            let fields = extract_row_data(row, &req.columns, &req.exclude_columns);
            // P350: con l'SQL personalizzato i nomi dei campi non diventano identificatori SQL
            if req.custom_sql.is_none() { crate::sqlsafe::check_fields(&fields, &req.connection.dialect)?; }
            if fields.is_empty() { skipped += 1; continue; }

            let default_keys = vec![];
            let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());
            let needs_plan = req.custom_sql.is_none() && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

            let set_fields: Vec<(String, serde_json::Value)> = fields.iter()
                .filter(|(k, _)| !keys.contains(k)).cloned().collect();

            let merge_row: serde_json::Value; // riga sorgente del MERGE (P345), vive fino all'esecuzione
            let sql: String;
            let mut bind_list: Vec<&serde_json::Value>;

            if let Some(cs) = &req.custom_sql {
                // P350: SQL personalizzato / stored procedure: un'istruzione per riga
                sql = cs.text(PlaceholderStyle::Dollar).to_string();
                bind_list = cs.binds(row, PlaceholderStyle::Dollar)?;
            } else if needs_plan {
                let plan = build_column_plan(&fields, &req.column_functions, PlaceholderStyle::Dollar, 1);
                let cols = plan.iter().map(|p| p.column_sql.as_str()).collect::<Vec<_>>().join(", ");
                let vals = plan.iter().map(|p| p.value_sql.as_str()).collect::<Vec<_>>().join(", ");
                bind_list = plan.iter().filter_map(|p| p.bind_value).collect();

                let base_sql = match req.mode.as_str() {
                    "upsert" => {
                        let updates = plan.iter()
                            .filter(|p| !keys.contains(&p.column_sql))
                            // P349: la chiave restituita (master-detail) non si riscrive
                            // sull'upsert: con una sequenza cambierebbe a ogni run
                            .filter(|p| Some(p.column_sql.as_str()) != ret_col)
                            .map(|p| format!("{} = EXCLUDED.{}", p.column_sql, p.column_sql))
                            .collect::<Vec<_>>().join(", ");
                        let conflict = keys.join(", ");
                        if updates.is_empty() && use_returning && !keys.is_empty() {
                            // P349: vedi pg_write_pool (RETURNING anche sulla riga esistente)
                            format!("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO UPDATE SET {} = EXCLUDED.{}", tbl, cols, vals, conflict, keys[0], keys[0])
                        } else if updates.is_empty() {
                            format!("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO NOTHING", tbl, cols, vals, conflict)
                        } else {
                            format!("INSERT INTO {} ({}) VALUES ({}) ON CONFLICT ({}) DO UPDATE SET {}", tbl, cols, vals, conflict, updates)
                        }
                    }
                    _ => format!("INSERT INTO {} ({}) VALUES ({})", tbl, cols, vals),
                };
                sql = if use_returning { format!("{} RETURNING \"{}\"", base_sql, ret_col.unwrap()) } else { base_sql };
            } else if req.mode == "update" {
                let set_plan = build_column_plan(&set_fields, &req.column_functions, PlaceholderStyle::Dollar, 1);
                let sets = set_plan.iter().map(|p| format!("{} = {}", p.column_sql, p.value_sql)).collect::<Vec<_>>().join(", ");
                let where_start = count_consumed_placeholders(&set_plan) + 1;
                let (where_c, where_binds) = where_plan(keys, &req.key_conditions, &fields, &req.column_functions,
                    PlaceholderStyle::Dollar, where_start, &|k: &str| k.to_string())?;
                sql = format!("UPDATE {} SET {} WHERE {}", tbl, sets, where_c);
                bind_list = set_plan.iter().filter_map(|p| p.bind_value).collect();
                bind_list.extend(where_binds);
            } else if req.mode == "merge" {
                let (q, row) = pg_merge_sql(&tbl, &fields, keys, &req.column_functions, &req.merge_condition)?;
                merge_row = row;
                sql = q;
                bind_list = vec![&merge_row];
            } else {
                // delete (check_write_mode garantisce che non ci siano altre modalita')
                let (where_c, where_binds) = where_plan(keys, &req.key_conditions, &fields, &req.column_functions,
                    PlaceholderStyle::Dollar, 1, &|k: &str| k.to_string())?;
                sql = format!("DELETE FROM {} WHERE {}", tbl, where_c);
                bind_list = where_binds;
            }

            if use_returning && needs_plan {
                let mut q = sqlx::query(crate::sqlsafe::composto(sql.as_str()));
                for v in &bind_list { q = bind_pg_value(q, v); }
                match q.fetch_one(&mut *conn).await {
                    Ok(row) => { written += 1; generated_keys.push(pg_row_to_json_value(&row, 0)); }
                    Err(e) => match req.on_constraint_error.as_str() {
                        "skip" => { skipped += 1; }
                        "stop" => { return Err(format!("SinkDB row error: {}", e)); }
                        _ => { errors += 1; }
                    }
                }
            } else {
                let mut q = sqlx::query(crate::sqlsafe::composto(sql.as_str()));
                for v in &bind_list { q = bind_pg_value(q, v); }
                match q.execute(&mut *conn).await {
                    Ok(_) => { written += 1; }
                    Err(e) => match req.on_constraint_error.as_str() {
                        "skip" => { skipped += 1; }
                        "stop" => { return Err(format!("SinkDB row error: {}", e)); }
                        _ => { errors += 1; }
                    }
                }
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
/// NULL SENZA TIPO per PostgreSQL (P345). 🐞 Prima un NULL si legava come
/// `None::<String>`, cioe' un NULL di tipo TEXT: Postgres lo rifiuta in qualunque
/// colonna non testuale ("column is of type date but expression is of type
/// text") — ogni riga con un valore mancante in una colonna data, timestamp,
/// numerica o booleana faceva fallire la scrittura. Con il tipo non specificato
/// (OID 0) e' il server a dedurlo dalla colonna, come per un NULL letterale.
struct PgUntypedNull;
impl sqlx::Type<sqlx::Postgres> for PgUntypedNull {
    fn type_info() -> sqlx::postgres::PgTypeInfo {
        sqlx::postgres::PgTypeInfo::with_oid(sqlx::postgres::types::Oid(0))
    }
}
impl<'q> sqlx::Encode<'q, sqlx::Postgres> for PgUntypedNull {
    fn encode_by_ref(&self, _buf: &mut sqlx::postgres::PgArgumentBuffer) -> Result<sqlx::encode::IsNull, sqlx::error::BoxDynError> {
        Ok(sqlx::encode::IsNull::Yes)
    }
}

/// P346: il testo esatto di un Decimal marcato da `Value::to_write_json`
/// (`{"$fp_decimal": "12.50"}`), se `v` è quel marcatore.
pub(crate) fn json_decimal(v: &serde_json::Value) -> Option<&str> {
    let o = v.as_object()?;
    if o.len() != 1 { return None }
    o.get(crate::engine::types::DECIMAL_MARKER)?.as_str()
}

pub(crate) fn bind_pg_value<'q>(
    q: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>,
    v: &'q serde_json::Value,
    ) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {  
    // P346: Decimal esatto come NUMERIC (prima f64)
    if let Some(d) = json_decimal(v) {
        return match d.parse::<rust_decimal::Decimal>() { Ok(x) => q.bind(x), Err(_) => q.bind(d) };
    }
    // P350: lotto JSON della stored procedure → jsonb, testo esatto
    if let Some(t) = json_raw(v) {
        return match serde_json::value::RawValue::from_string(t.to_string()) {
            Ok(raw) => q.bind(sqlx::types::Json(raw)),
            Err(_)  => q.bind(t),
        };
    }
    match v {
        serde_json::Value::Null      => q.bind(PgUntypedNull),
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
        .map_err(|e| format!("MySQL connection failed: {}", e))?;

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
    if req.custom_sql.is_none() {
        crate::sqlsafe::check_names(&tbl, req.key_fields.as_deref().unwrap_or(&[]), req.columns.as_deref(), req.returning_column.as_deref(), &req.connection.dialect)?;
    }
    check_write_mode(&req.mode, &req.connection.dialect)?;
    check_key_conditions(&req.mode, &req.key_conditions)?;


   
    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    let default_keys = vec![];
    let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());

    let use_returning = req.returning_column.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(crate::sqlsafe::autore(stmt)).execute(pool).await
                    .map_err(|e| format!("Pre-SQL failed: {}", e))?;
            }
        }
    }
    if req.mode == "truncate_insert" {
        sqlx::query(crate::sqlsafe::composto(format!("TRUNCATE TABLE `{}`", tbl))).execute(pool).await
            .map_err(|e| format!("TRUNCATE failed: {}", e))?;
    }

    for chunk in req.rows.chunks(req.batch_size.max(1)) {
        batches += 1;
        for row in chunk {
            let fields = extract_row_data(row, &req.columns, &req.exclude_columns);
            // P350: con l'SQL personalizzato i nomi dei campi non diventano identificatori SQL
            if req.custom_sql.is_none() { crate::sqlsafe::check_fields(&fields, &req.connection.dialect)?; }
            if fields.is_empty() { skipped += 1; continue; }

            let needs_plan = req.custom_sql.is_none() && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");
            let sql: String;
            let mut bind_list: Vec<&serde_json::Value>;

            let set_fields: Vec<(String, serde_json::Value)> = fields.iter()
                .filter(|(k, _)| !keys.contains(k))
                .cloned()
                .collect();

            if let Some(cs) = &req.custom_sql {
                // P350: SQL personalizzato / stored procedure: un'istruzione per riga
                sql = cs.text(PlaceholderStyle::Question).to_string();
                bind_list = cs.binds(row, PlaceholderStyle::Question)?;
            } else if needs_plan {
                let plan = build_column_plan(&fields, &req.column_functions, PlaceholderStyle::Question, 1);
                let cols = plan.iter().map(|p| format!("`{}`", p.column_sql)).collect::<Vec<_>>().join(", ");
                let vals = plan.iter().map(|p| p.value_sql.as_str()).collect::<Vec<_>>().join(", ");
                bind_list = plan.iter().filter_map(|p| p.bind_value).collect();

                sql = match req.mode.as_str() {
                    "upsert" => {
                        let updates = plan.iter()
                            .filter(|p| Some(p.column_sql.as_str()) != req.returning_column.as_deref())
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
                let (where_c, where_binds) = where_plan(keys, &req.key_conditions, &fields, &req.column_functions,
                    PlaceholderStyle::Question, 1, &|k: &str| format!("`{}`", k))?;
                sql = format!("UPDATE `{}` SET {} WHERE {}", tbl, sets, where_c);
                bind_list = set_plan.iter().filter_map(|p| p.bind_value).collect();
                bind_list.extend(where_binds);
            } else {
                let (where_c, where_binds) = where_plan(keys, &req.key_conditions, &fields, &req.column_functions,
                    PlaceholderStyle::Question, 1, &|k: &str| format!("`{}`", k))?;
                sql = format!("DELETE FROM `{}` WHERE {}", tbl, where_c);
                bind_list = where_binds;
            }

            let mut q = sqlx::query(crate::sqlsafe::composto(sql.as_str()));
            for v in &bind_list {
                // P350: lotto JSON della stored procedure, come testo
                if let Some(t) = json_raw(v) { q = q.bind(t); continue; }
                // P346: Decimal esatto (DECIMAL di MySQL), non f64
                if let Some(d) = json_decimal(v) {
                    q = match d.parse::<rust_decimal::Decimal>() { Ok(x) => q.bind(x), Err(_) => q.bind(d) };
                    continue;
                }
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
                    "stop" => { pool.close().await; return Err(format!("SinkDB row error: {}", e)); }
                    _ => { errors += 1; }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(crate::sqlsafe::autore(stmt)).execute(pool).await
                    .map_err(|e| format!("Post-SQL failed: {}", e))?;
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
        .map_err(|e| format!("SQLite connection failed: {}", e))?;

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
    if req.custom_sql.is_none() {
        crate::sqlsafe::check_names(&tbl, req.key_fields.as_deref().unwrap_or(&[]), req.columns.as_deref(), req.returning_column.as_deref(), &req.connection.dialect)?;
    }
    check_write_mode(&req.mode, &req.connection.dialect)?;
    check_key_conditions(&req.mode, &req.key_conditions)?;


    let (mut written, mut skipped, mut errors, mut batches) = (0usize, 0usize, 0usize, 0usize);
    let mut generated_keys: Vec<serde_json::Value> = Vec::new();

    let default_keys = vec![];
    let keys = req.key_fields.as_deref().unwrap_or(default_keys.as_slice());

    let use_returning = req.returning_column.is_some()
        && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");

    if let Some(pre) = &req.pre_sql {
        if !pre.trim().is_empty() {
            for stmt in pre.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(crate::sqlsafe::autore(stmt)).execute(pool).await
                    .map_err(|e| format!("Pre-SQL failed: {}", e))?;
            }
        }
    }
    if req.mode == "truncate_insert" {
        sqlx::query(crate::sqlsafe::composto(format!("DELETE FROM {}", tbl))).execute(pool).await
            .map_err(|e| format!("DELETE failed: {}", e))?;
    }

    for chunk in req.rows.chunks(req.batch_size.max(1)) {
        batches += 1;
        for row in chunk {
            let fields = extract_row_data(row, &req.columns, &req.exclude_columns);
            // P350: con l'SQL personalizzato i nomi dei campi non diventano identificatori SQL
            if req.custom_sql.is_none() { crate::sqlsafe::check_fields(&fields, &req.connection.dialect)?; }
            if fields.is_empty() { skipped += 1; continue; }

            let needs_plan = req.custom_sql.is_none() && matches!(req.mode.as_str(), "insert" | "truncate_insert" | "upsert");
            let sql: String;
            let mut bind_list: Vec<&serde_json::Value>;

            let set_fields: Vec<(String, serde_json::Value)> = fields.iter()
                .filter(|(k, _)| !keys.contains(k))
                .cloned()
                .collect();

            if let Some(cs) = &req.custom_sql {
                // P350: SQL personalizzato / stored procedure: un'istruzione per riga
                sql = cs.text(PlaceholderStyle::Question).to_string();
                bind_list = cs.binds(row, PlaceholderStyle::Question)?;
            } else if needs_plan {
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
                let (where_c, where_binds) = where_plan(keys, &req.key_conditions, &fields, &req.column_functions,
                    PlaceholderStyle::Question, 1, &|k: &str| k.to_string())?;
                sql = format!("UPDATE {} SET {} WHERE {}", tbl, sets, where_c);
                bind_list = set_plan.iter().filter_map(|p| p.bind_value).collect();
                bind_list.extend(where_binds);
            } else {
                let (where_c, where_binds) = where_plan(keys, &req.key_conditions, &fields, &req.column_functions,
                    PlaceholderStyle::Question, 1, &|k: &str| k.to_string())?;
                sql = format!("DELETE FROM {} WHERE {}", tbl, where_c);
                bind_list = where_binds;
            }

            let mut q = sqlx::query(crate::sqlsafe::composto(sql.as_str()));
            for v in &bind_list {
                // P346: SQLite non ha un tipo decimale esatto: il Decimal va
                // come testo (la colonna applica la sua affinità).
                if let Some(d) = json_decimal(v) { q = q.bind(d); continue; }
                if let Some(t) = json_raw(v) { q = q.bind(t); continue; }
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
                    "stop" => { pool.close().await; return Err(format!("SinkDB row error: {}", e)); }
                    _ => { errors += 1; }
                }
            }
        }
    }

    if let Some(post) = &req.post_sql {
        if !post.trim().is_empty() {
            for stmt in post.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
                sqlx::query(crate::sqlsafe::autore(stmt)).execute(pool).await
                    .map_err(|e| format!("Post-SQL failed: {}", e))?;
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
    .connect(conn_str).await.map_err(|e| format!("PostgreSQL connection failed: {}", e))?;
  let rows = sqlx::query(crate::sqlsafe::autore(query)).fetch_all(&pool).await.map_err(|e| format!("PostgreSQL query failed: {}", e))?;
  let result = rows.iter().map(|row| {
    let mut obj = serde_json::Map::new();
    // Un solo lettore: la preview (db_query) decodifica le celle con LO STESSO
    // convertitore del nodo source_db del run vero (pg_col_to_value) — incluso
    // il fallback try_get_raw per gli enum/domini Postgres (es. mpaa_rating).
    // Così l'anteprima è uno specchio fedele di ciò che leggerà l'esecuzione.
    for (i, col) in row.columns().iter().enumerate() {
      let v = crate::engine::nodes::source_db::pg_col_to_value(row, i);
      obj.insert(col.name().to_string(), serde_json::to_value(v).unwrap_or(serde_json::Value::Null));
    }
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
    .connect(conn_str).await.map_err(|e| format!("PostgreSQL connection failed: {}", e))?;
  let described = pool.describe(sqlx::SqlSafeStr::into_sql_str(crate::sqlsafe::autore(probe))).await.map_err(|e| format!("PostgreSQL describe failed: {}", e))?;
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
    // P345: NUMERIC oltre le 28 cifre (o NaN/Infinity) → testo esatto, non NULL
    if let Some(t) = crate::engine::nodes::source_db::pg_numeric_text(row, idx) { return serde_json::json!(t) }
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
    .connect(conn_str).await.map_err(|e| format!("MySQL connection failed: {}", e))?;
  let rows = sqlx::query(crate::sqlsafe::autore(query)).fetch_all(&pool).await.map_err(|e| format!("MySQL query failed: {}", e))?;
  // P339: stesso lettore del nodo source_db (prima: tutto NULL tranne JSON).
  let result = rows.iter().map(|row| {
    let mut obj = serde_json::Map::new();
    for (i, col) in row.columns().iter().enumerate() {
      obj.insert(col.name().to_string(), crate::engine::nodes::source_db::my_col_to_value(row, i).to_json());
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
    .connect(conn_str).await.map_err(|e| format!("MySQL connection failed: {}", e))?;
  let described = pool.describe(sqlx::SqlSafeStr::into_sql_str(crate::sqlsafe::autore(probe))).await.map_err(|e| format!("MySQL describe failed: {}", e))?;
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
    .connect(conn_str).await.map_err(|e| format!("SQLite connection failed: {}", e))?;
  let rows = sqlx::query(crate::sqlsafe::autore(query)).fetch_all(&pool).await.map_err(|e| format!("SQLite query failed: {}", e))?;
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
    .connect(conn_str).await.map_err(|e| format!("SQLite connection failed: {}", e))?;
  let described = pool.describe(sqlx::SqlSafeStr::into_sql_str(crate::sqlsafe::autore(probe))).await.map_err(|e| format!("SQLite describe failed: {}", e))?;
  pool.close().await;
  Ok(described.columns().iter().enumerate().map(|(i, col)| DbColumnInfo {
    name: col.name().to_string(), db_type: col.type_info().name().to_string(),
    nullable: described.nullable(i).unwrap_or(true), position: i,
  }).collect())
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn read_file(path: String) -> Result<String, String> {
  std::fs::read_to_string(&path).map_err(|e| format!("Read error {}: {}", path, e))
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn read_file_bytes(path: String) -> Result<String, String> {
  let bytes = std::fs::read(&path).map_err(|e| format!("Read error {}: {}", path, e))?;
  Ok(BASE64.encode(&bytes))
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn write_file(path: String, content: String) -> Result<(), String> {
  if let Some(parent) = std::path::Path::new(&path).parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("Directory creation error: {}", e))?;
  }
  std::fs::write(&path, content.into_bytes()).map_err(|e| format!("Write error {}: {}", path, e))
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn write_file_bytes(path: String, content_base64: String) -> Result<(), String> {
  if let Some(parent) = std::path::Path::new(&path).parent() {
    std::fs::create_dir_all(parent).map_err(|e| format!("Directory creation error: {}", e))?;
  }
  let bytes = BASE64.decode(&content_base64).map_err(|e| format!("Base64 decode error: {}", e))?;
  std::fs::write(&path, bytes).map_err(|e| format!("Write error {}: {}", path, e))
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn list_directory(path: String) -> Result<Vec<FileEntry>, String> {
  let entries = std::fs::read_dir(&path).map_err(|e| format!("Directory read error {}: {}", path, e))?;
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

#[cfg(feature = "desktop")]
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
pub struct FtpConnectionParams {
  pub protocol:        String,
  pub host:            String,
  pub port:            u16,
  pub user:            String,
  pub password:        Option<String>,
  #[serde(rename = "keyPath")]
  pub key_path:        Option<String>,
  #[serde(rename = "authType")]
  pub auth_type:       Option<String>,
  #[serde(rename = "connectTimeout")]
  pub connect_timeout: Option<u64>,
}

#[derive(Debug, Serialize)]
struct FtpTestResult {
  ok:         bool,
  message:    String,
  elapsed_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
pub struct FtpFileEntry {
  pub name:        String,
  pub path:        String,
  pub is_dir:      bool,
  pub size:        u64,
  pub modified_at: Option<String>,
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn ftp_test(connection: FtpConnectionParams) -> Result<FtpTestResult, String> {
  let start = std::time::Instant::now();
  match connection.protocol.as_str() {
    "sftp"        => sftp_test(&connection, start).await,
    "ftp" | "ftps" => ftp_plain_test(&connection, start).await,
    p             => Err(format!("Protocol '{}' not supported. Use: ftp, ftps, sftp", p)),
  }
}

// Impl condivisa (FONTE UNICA): la chiamano SIA il comando Tauri qui sotto
// SIA i nodi del motore (crate::ftp_list_impl). NON marcare `pub` il
// #[tauri::command]: nello stesso modulo la macro ri-esporta i suoi helper
// (__cmd__*, __tauri_command_name_*) e collidono con la definizione (E0255).
pub async fn ftp_list_impl(
  connection:  FtpConnectionParams,
  remote_path: String,
  pattern:     Option<String>,
  recursive:   Option<bool>,
) -> Result<Vec<FtpFileEntry>, String> {
  match connection.protocol.as_str() {
    "sftp"        => sftp_list(&connection, &remote_path, pattern.as_deref(), recursive.unwrap_or(false)).await,
    "ftp" | "ftps" => ftp_plain_list(&connection, &remote_path, pattern.as_deref(), recursive.unwrap_or(false)).await,
    p             => Err(format!("Protocol '{}' not supported", p)),
  }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn ftp_list(
  connection:  FtpConnectionParams,
  remote_path: String,
  pattern:     Option<String>,
  recursive:   Option<bool>,
) -> Result<Vec<FtpFileEntry>, String> {
  ftp_list_impl(connection, remote_path, pattern, recursive).await
}

pub async fn ftp_read_impl(connection: FtpConnectionParams, remote_path: String) -> Result<String, String> {
  let bytes = ftp_read_bytes_impl(&connection, &remote_path).await?;
  String::from_utf8(bytes).map_err(|e| format!("'{}' is not UTF-8 text: {}", remote_path, e))
}

/// Il file remoto così com'è, byte per byte (P362: source_ftp legge binari,
/// archivi e codifiche diverse da UTF-8).
pub async fn ftp_read_bytes_impl(connection: &FtpConnectionParams, remote_path: &str) -> Result<Vec<u8>, String> {
  match connection.protocol.as_str() {
    "sftp"        => sftp_read(connection, remote_path).await,
    "ftp" | "ftps" => ftp_plain_read(connection, remote_path).await,
    p             => Err(format!("Protocol '{}' not supported", p)),
  }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn ftp_read(connection: FtpConnectionParams, remote_path: String) -> Result<String, String> {
  ftp_read_impl(connection, remote_path).await
}

pub async fn ftp_write_impl(
  connection:  FtpConnectionParams,
  remote_path: String,
  content:     String,
  create_dirs: Option<bool>,
  atomic:      Option<bool>,
) -> Result<u64, String> {
  match connection.protocol.as_str() {
    "sftp"        => sftp_write(&connection, &remote_path, &content, create_dirs.unwrap_or(true), atomic.unwrap_or(true)).await,
    "ftp" | "ftps" => ftp_plain_write(&connection, &remote_path, &content).await,
    p             => Err(format!("Protocol '{}' not supported", p)),
  }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn ftp_write(
  connection:  FtpConnectionParams,
  remote_path: String,
  content:     String,
  create_dirs: Option<bool>,
  atomic:      Option<bool>,
) -> Result<u64, String> {
  ftp_write_impl(connection, remote_path, content, create_dirs, atomic).await
}

fn sftp_connect_sync(conn: &FtpConnectionParams) -> Result<ssh2::Session, String> {
  let timeout = std::time::Duration::from_secs(conn.connect_timeout.unwrap_or(30));
  let addr    = format!("{}:{}", conn.host, conn.port);
  use std::net::ToSocketAddrs;
  let socket_addr = addr.to_socket_addrs()
    .map_err(|e| format!("DNS resolution failed for '{}': {}", addr, e))?
    .next()
    .ok_or_else(|| format!("No address found for '{}'", addr))?;
  let tcp = std::net::TcpStream::connect_timeout(&socket_addr, timeout)
    .map_err(|e| format!("TCP connection failed to {}: {}", addr, e))?;
  tcp.set_read_timeout(Some(timeout)).ok();
  tcp.set_write_timeout(Some(timeout)).ok();
  let mut session = ssh2::Session::new().map_err(|e| format!("SSH session error: {}", e))?;
  session.set_tcp_stream(tcp);
  session.handshake().map_err(|e| format!("SSH handshake failed: {}", e))?;
  let auth_type = conn.auth_type.as_deref().unwrap_or("password");
  if auth_type == "key" {
    let key_path  = conn.key_path.as_deref().ok_or("keyPath not specified")?;
    let passphrase = conn.password.as_deref();
    session.userauth_pubkey_file(&conn.user, None, std::path::Path::new(key_path), passphrase)
      .map_err(|e| format!("SSH key auth failed: {}", e))?;
  } else {
    let password = conn.password.as_deref().unwrap_or("");
    session.userauth_password(&conn.user, password)
      .map_err(|e| format!("SSH password auth failed: {}", e))?;
  }
  if !session.authenticated() { return Err("SSH authentication failed".to_string()); }
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
    Ok(Err(e)) => Ok(FtpTestResult { ok: false, message: format!("Internal error: {}", e), elapsed_ms: start.elapsed().as_millis() }),
    Err(_) => Ok(FtpTestResult { ok: false, message: format!("Timeout: no response from {}:{} within {}s", conn.host, conn.port, conn.connect_timeout.unwrap_or(10)), elapsed_ms: start.elapsed().as_millis() }),
  }
}

/// Cartelle annidate oltre le quali la ricerca ricorsiva si ferma.
const FTP_MAX_DEPTH: usize = 32;

async fn sftp_list(conn: &FtpConnectionParams, remote_path: &str, pattern: Option<&str>, recursive: bool) -> Result<Vec<FtpFileEntry>, String> {
  let c = conn.clone(); let path = remote_path.to_string(); let pat = pattern.map(|s| s.to_string());
  tokio::task::spawn_blocking(move || {
    let session = sftp_connect_sync(&c)?;
    let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
    let mut out = Vec::new();
    // P362: con `recursive` si scende nelle sottocartelle; il filtro vale
    // sui nomi, le cartelle si attraversano comunque.
    let mut stack = vec![(path.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
      let entries = match sftp.readdir(std::path::Path::new(&dir)) {
        Ok(e) => e,
        Err(e) if depth == 0 => return Err(format!("SFTP readdir '{}': {}", dir, e)),
        Err(_) => continue,
      };
      for (p, stat) in entries {
        let Some(name) = p.file_name().map(|n| n.to_string_lossy().to_string()) else { continue };
        if name == "." || name == ".." { continue }
        let full = format!("{}/{}", dir.trim_end_matches('/'), name);
        if stat.is_dir() && recursive && depth < FTP_MAX_DEPTH { stack.push((full.clone(), depth + 1)); }
        if let Some(ref pat) = pat { if !glob_match(pat, &name) { continue } }
        let modified_at = stat.mtime.and_then(|t| chrono::DateTime::<chrono::Utc>::from_timestamp(t as i64, 0).map(|dt| dt.to_rfc3339()));
        out.push(FtpFileEntry { path: full, name, is_dir: stat.is_dir(), size: stat.size.unwrap_or(0), modified_at });
      }
    }
    Ok(out)
  }).await.map_err(|e| e.to_string())?
}

async fn sftp_read(conn: &FtpConnectionParams, remote_path: &str) -> Result<Vec<u8>, String> {
  use std::io::Read;
  let c = conn.clone(); let path = remote_path.to_string();
  tokio::task::spawn_blocking(move || {
    let session = sftp_connect_sync(&c)?;
    let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
    let mut file = sftp.open(std::path::Path::new(&path)).map_err(|e| format!("SFTP open '{}': {}", path, e))?;
    let mut content = Vec::new();
    file.read_to_end(&mut content).map_err(|e| format!("SFTP read: {}", e))?;
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

// suppaftp 12 (P337): backend tokio (prima async-std). Chiude RUSTSEC-2026-0271
// (CRLF injection nel canale di controllo).
//
// 🐞 Corretto (P337): il protocollo "ftps" si collegava in FTP IN CHIARO (stessa
// funzione di "ftp"): password e file viaggiavano leggibili mentre la UI diceva
// FTPS. Ora "ftps" = FTPS ESPLICITO (AUTH TLS) fatto PRIMA del login, con PROT P
// sul canale dati e verifica del certificato del server (native-tls). L'FTPS
// implicito (porta 990) non e' supportato: se il server lo esige, la connessione
// fallisce invece di ripiegare in chiaro.
enum FtpConn {
  Plain(suppaftp::tokio::AsyncFtpStream),
  Tls(suppaftp::tokio::AsyncNativeTlsFtpStream),
}

/// Esegue lo stesso corpo su entrambe le varianti (in chiaro / TLS).
macro_rules! with_ftp {
  ($conn:expr, $ftp:ident => $body:expr) => {
    match $conn {
      FtpConn::Plain(mut $ftp) => $body,
      FtpConn::Tls(mut $ftp) => $body,
    }
  };
}

async fn ftp_plain_connect(conn: &FtpConnectionParams) -> Result<FtpConn, String> {
  let addr     = format!("{}:{}", conn.host, conn.port);
  let user     = conn.user.clone();
  let password = conn.password.clone().unwrap_or_default();
  // suppaftp 12 parte in ASCII e in upload converte LF→CRLF: i file dei nodi FTP
  // devono viaggiare byte per byte com'erano (CSV/JSON/XML), quindi BINARIO.
  let binary = suppaftp::types::FileType::Binary;
  if conn.protocol == "ftps" {
    // Lo stream nasce gia' "tipizzato TLS" (connessione TCP in chiaro), poi AUTH TLS.
    let ftp = suppaftp::tokio::AsyncNativeTlsFtpStream::connect(&addr).await.map_err(|e| format!("FTP connection to {}: {}", addr, e))?;
    let tls = suppaftp::tokio::AsyncNativeTlsConnector::from(suppaftp::async_native_tls::TlsConnector::new());
    let mut ftp = ftp.into_secure(tls, &conn.host).await.map_err(|e| format!("FTPS (AUTH TLS) with {}: {}", addr, e))?;
    ftp.login(&user, &password).await.map_err(|e| format!("FTPS login: {}", e))?;
    ftp.transfer_type(binary).await.map_err(|e| format!("FTPS TYPE I: {}", e))?;
    Ok(FtpConn::Tls(ftp))
  } else {
    let mut ftp = suppaftp::tokio::AsyncFtpStream::connect(&addr).await.map_err(|e| format!("FTP connection to {}: {}", addr, e))?;
    ftp.login(&user, &password).await.map_err(|e| format!("FTP login: {}", e))?;
    ftp.transfer_type(binary).await.map_err(|e| format!("FTP TYPE I: {}", e))?;
    Ok(FtpConn::Plain(ftp))
  }
}

async fn ftp_plain_test(conn: &FtpConnectionParams, start: std::time::Instant) -> Result<FtpTestResult, String> {
  let addr    = format!("{}:{}", conn.host, conn.port);
  let user    = conn.user.clone();
  let label   = if conn.protocol == "ftps" { "FTPS (TLS)" } else { "FTP" };
  let timeout = std::time::Duration::from_secs(conn.connect_timeout.unwrap_or(10));
  let result  = tokio::time::timeout(timeout, ftp_plain_connect(conn)).await;
  match result {
    Ok(Ok(c)) => { with_ftp!(c, ftp => { let _ = ftp.quit().await; }); Ok(FtpTestResult { ok: true, message: format!("{} connesso a {} come {}", label, addr, user), elapsed_ms: start.elapsed().as_millis() }) }
    Ok(Err(e)) => Ok(FtpTestResult { ok: false, message: e, elapsed_ms: start.elapsed().as_millis() }),
    Err(_) => Ok(FtpTestResult { ok: false, message: format!("Timeout: no response from {} within {}s", addr, conn.connect_timeout.unwrap_or(10)), elapsed_ms: start.elapsed().as_millis() }),
  }
}

/// Una riga di MLSD o di LIST (formato Unix o DOS) → nome, cartella?, dimensione, data.
/// P362: prima si usava NLST, che dà solo i nomi: cartelle viste come file,
/// dimensione 0, nessuna data (e ordinamento per data/dimensione impossibile).
fn ftp_parse_entry(line: &str) -> Option<(String, bool, u64, Option<String>)> {
  use suppaftp::list::ListParser;
  let f = ListParser::parse_mlsd(line).or_else(|_| ListParser::parse_posix(line)).or_else(|_| ListParser::parse_dos(line)).ok()?;
  let modified = chrono::DateTime::<chrono::Utc>::from(f.modified()).to_rfc3339();
  Some((f.name().to_string(), f.is_directory(), f.size() as u64, Some(modified)))
}

async fn ftp_plain_list(conn: &FtpConnectionParams, remote_path: &str, pattern: Option<&str>, recursive: bool) -> Result<Vec<FtpFileEntry>, String> {
  let path = remote_path.to_string(); let pat = pattern.map(|s| s.to_string());
  let c = ftp_plain_connect(conn).await?;
  let out = with_ftp!(c, ftp => {
    let mut out: Vec<FtpFileEntry> = Vec::new();
    let mut stack = vec![(path.clone(), 0usize)];
    while let Some((dir, depth)) = stack.pop() {
      // MLSD (standard, date in UTC) se il server lo conosce, altrimenti LIST.
      let lines = match ftp.mlsd(Some(&dir)).await {
        Ok(l) => l,
        Err(_) => match ftp.list(Some(&dir)).await {
          Ok(l) => l,
          Err(e) if depth == 0 => return Err(format!("FTP list '{}': {}", dir, e)),
          Err(_) => continue,
        },
      };
      for line in lines {
        let Some((name, is_dir, size, modified_at)) = ftp_parse_entry(&line) else { continue };
        let name = name.rsplit('/').next().unwrap_or(&name).to_string();
        if name == "." || name == ".." || name.is_empty() { continue }
        let full = format!("{}/{}", dir.trim_end_matches('/'), name);
        if is_dir && recursive && depth < FTP_MAX_DEPTH { stack.push((full.clone(), depth + 1)); }
        if let Some(ref pat) = pat { if !glob_match(pat, &name) { continue } }
        out.push(FtpFileEntry { name, path: full, is_dir, size, modified_at });
      }
    }
    let _ = ftp.quit().await;
    out
  });
  Ok(out)
}

async fn ftp_plain_read(conn: &FtpConnectionParams, remote_path: &str) -> Result<Vec<u8>, String> {
  use tokio::io::AsyncReadExt;
  let path = remote_path.to_string();
  let c = ftp_plain_connect(conn).await?;
  let content = with_ftp!(c, ftp => {
    let mut stream = ftp.retr_as_stream(&path).await.map_err(|e| format!("FTP retr '{}': {}", path, e))?;
    let mut content = Vec::new();
    stream.read_to_end(&mut content).await.map_err(|e| format!("FTP read: {}", e))?;
    stream.finish().await.map_err(|e| format!("FTP finalize: {}", e))?;
    let _ = ftp.quit().await;
    content
  });
  Ok(content)
}

async fn ftp_plain_write(conn: &FtpConnectionParams, remote_path: &str, content: &str) -> Result<u64, String> {
  use std::io::Cursor;
  let path = remote_path.to_string(); let data = content.as_bytes().to_vec(); let len = data.len() as u64;
  let c = ftp_plain_connect(conn).await?; let mut cursor = Cursor::new(data);
  with_ftp!(c, ftp => {
    ftp.put_file(&path, &mut cursor).await.map_err(|e| format!("FTP put '{}': {}", path, e))?;
    let _ = ftp.quit().await;
  });
  Ok(len)
}

// ─── Spostare e cancellare file remoti (P362, source_ftp) ─────────

/// Sposta (rinomina) un file remoto; crea la cartella di destinazione se
/// manca. Se il file di destinazione esiste viene sostituito.
pub async fn ftp_move_impl(connection: &FtpConnectionParams, from: &str, to: &str) -> Result<(), String> {
  let parent = to.rfind('/').map(|i| to[..i].to_string()).filter(|d| !d.is_empty());
  match connection.protocol.as_str() {
    "sftp" => {
      let c = connection.clone(); let (from, to) = (from.to_string(), to.to_string());
      tokio::task::spawn_blocking(move || {
        let session = sftp_connect_sync(&c)?;
        let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
        if let Some(d) = parent { let _ = sftp_mkdir_p(&sftp, std::path::Path::new(&d)); }
        let (fp, tp) = (std::path::Path::new(&from), std::path::Path::new(&to));
        if sftp.rename(fp, tp, Some(ssh2::RenameFlags::OVERWRITE)).is_err() {
          // Server SFTP v3 senza sovrascrittura: si toglie la destinazione e si riprova.
          let _ = sftp.unlink(tp);
          sftp.rename(fp, tp, None).map_err(|e| format!("SFTP rename '{}' → '{}': {}", from, to, e))?;
        }
        Ok(())
      }).await.map_err(|e| e.to_string())?
    }
    "ftp" | "ftps" => {
      let c = ftp_plain_connect(connection).await?;
      with_ftp!(c, ftp => {
        if let Some(d) = parent {
          let mut acc = String::new();
          for part in d.split('/').filter(|x| !x.is_empty()) {
            acc.push('/'); acc.push_str(part);
            let _ = ftp.mkdir(&acc).await;
          }
        }
        ftp.rename(from, to).await.map_err(|e| format!("FTP rename '{}' → '{}': {}", from, to, e))?;
        let _ = ftp.quit().await;
      });
      Ok(())
    }
    p => Err(format!("Protocol '{}' not supported", p)),
  }
}

/// Cancella un file remoto.
pub async fn ftp_delete_impl(connection: &FtpConnectionParams, path: &str) -> Result<(), String> {
  match connection.protocol.as_str() {
    "sftp" => {
      let c = connection.clone(); let path = path.to_string();
      tokio::task::spawn_blocking(move || {
        let session = sftp_connect_sync(&c)?;
        let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
        sftp.unlink(std::path::Path::new(&path)).map_err(|e| format!("SFTP delete '{}': {}", path, e))
      }).await.map_err(|e| e.to_string())?
    }
    "ftp" | "ftps" => {
      let c = ftp_plain_connect(connection).await?;
      with_ftp!(c, ftp => {
        ftp.rm(path).await.map_err(|e| format!("FTP delete '{}': {}", path, e))?;
        let _ = ftp.quit().await;
      });
      Ok(())
    }
    p => Err(format!("Protocol '{}' not supported", p)),
  }
}

// ─── Scrittura del sink FTP/SFTP (P356) ────────────────────────────
//
// ftp_write_impl (comando Tauri) scrive un testo e basta. Il nodo sink_ftp
// promette di più: byte (gzip, zip, Excel, encoding non UTF-8), append,
// "nuovo file" con suffisso, errore se esiste, permessi, cartelle anche in
// FTP. Due passi, ognuno con la sua connessione: prima si risolve il
// percorso (esiste? quanto è grande? quale nome libero?) — serve PRIMA di
// serializzare, perché in append l'intestazione CSV va scritta solo se il
// file è nuovo — poi si scrivono i byte.

/// Modalità di scrittura del file remoto.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum FtpWriteMode { Overwrite, Append, New, Error }

/// Esito della risoluzione: percorso definitivo e dimensione se il file c'è già.
#[derive(Debug, Clone)]
pub struct FtpTarget { pub path: String, pub existing_size: Option<u64> }

#[derive(Debug, Clone, Copy)]
pub struct FtpPutOpts { pub create_dirs: bool, pub atomic: bool, pub append: bool, pub chmod: Option<u32> }

/// `dir/nome.csv.gz` → `dir/nome_N.csv.gz` (il suffisso va prima della
/// prima estensione).
pub fn ftp_numbered_path(path: &str, n: u32) -> String {
  let (dir, name) = match path.rfind('/') { Some(i) => (&path[..=i], &path[i + 1..]), None => ("", path) };
  match name.find('.') {
    Some(0) | None => format!("{}{}_{}", dir, name, n),
    Some(i)        => format!("{}{}_{}{}", dir, &name[..i], n, &name[i..]),
  }
}

/// Risolve il percorso secondo la modalità: `new` cerca un nome libero
/// (_1, _2…), `error` fallisce se il file esiste.
pub async fn ftp_resolve_target(conn: &FtpConnectionParams, path: &str, mode: FtpWriteMode) -> Result<FtpTarget, String> {
  // Dimensione del file se esiste, per un insieme di candidati (una connessione sola).
  let candidates: Vec<String> = match mode {
    FtpWriteMode::New => std::iter::once(path.to_string()).chain((1..=999).map(|n| ftp_numbered_path(path, n))).collect(),
    _ => vec![path.to_string()],
  };
  // Dimensioni dei candidati esistenti (None = non esiste).
  let known: std::collections::HashMap<String, Option<u64>> = if conn.protocol == "sftp" {
    let c = conn.clone(); let cands = candidates.clone();
    tokio::task::spawn_blocking(move || -> Result<std::collections::HashMap<String, Option<u64>>, String> {
      let session = sftp_connect_sync(&c)?;
      let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
      let mut m = std::collections::HashMap::new();
      for cand in cands {
        let sz = sftp.stat(std::path::Path::new(&cand)).ok().map(|st| st.size.unwrap_or(0));
        let stop = mode == FtpWriteMode::New && sz.is_none();
        m.insert(cand, sz);
        if stop { break }
      }
      Ok(m)
    }).await.map_err(|e| e.to_string())??
  } else if conn.protocol == "ftp" || conn.protocol == "ftps" {
    // FTP: SIZE per ogni candidato (in `new` ci si ferma al primo libero).
    let mut m = std::collections::HashMap::new();
    let c = ftp_plain_connect(conn).await?;
    with_ftp!(c, ftp => {
      for cand in &candidates {
        let sz = ftp.size(cand).await.ok().map(|n| n as u64);
        m.insert(cand.clone(), sz);
        if mode == FtpWriteMode::New && sz.is_none() { break }
      }
      let _ = ftp.quit().await;
    });
    m
  } else {
    return Err(format!("Protocol '{}' not supported", conn.protocol));
  };
  let size_of = |p: &str| known.get(p).copied().flatten();
  match mode {
    FtpWriteMode::New => {
      for c in &candidates {
        if known.contains_key(c) && size_of(c).is_none() { return Ok(FtpTarget { path: c.clone(), existing_size: None }) }
      }
      Err(format!("no free file name for '{}' (tried up to _999)", path))
    }
    FtpWriteMode::Error => match size_of(path) {
      Some(_) => Err(format!("the remote file '{}' already exists (write mode: Error)", path)),
      None    => Ok(FtpTarget { path: path.to_string(), existing_size: None }),
    },
    _ => Ok(FtpTarget { path: path.to_string(), existing_size: size_of(path) }),
  }
}

/// Scrive i byte nel percorso già risolto. Restituisce i byte scritti e gli
/// avvisi (es. permessi non applicati dal server).
pub async fn ftp_write_bytes(conn: &FtpConnectionParams, path: &str, data: Vec<u8>, o: FtpPutOpts) -> Result<(u64, Vec<String>), String> {
  let len = data.len() as u64;
  let mut warnings: Vec<String> = Vec::new();
  let atomic = o.atomic && !o.append;   // in append si scrive in coda al file vero
  match conn.protocol.as_str() {
    "sftp" => {
      let c = conn.clone(); let path = path.to_string();
      tokio::task::spawn_blocking(move || {
        use std::io::{Seek, SeekFrom, Write};
        let session = sftp_connect_sync(&c)?;
        let sftp    = session.sftp().map_err(|e| format!("SFTP init: {}", e))?;
        let p = std::path::Path::new(&path);
        if o.create_dirs { if let Some(parent) = p.parent() { let _ = sftp_mkdir_p(&sftp, parent); } }
        if o.append {
          let end = sftp.stat(p).ok().and_then(|st| st.size).unwrap_or(0);
          let mut f = sftp.open_mode(p, ssh2::OpenFlags::WRITE | ssh2::OpenFlags::CREATE | ssh2::OpenFlags::APPEND, 0o644, ssh2::OpenType::File)
            .map_err(|e| format!("SFTP open '{}' for append: {}", path, e))?;
          f.seek(SeekFrom::Start(end)).map_err(|e| format!("SFTP seek: {}", e))?;
          f.write_all(&data).map_err(|e| format!("SFTP write: {}", e))?;
        } else {
          let write_path = if atomic { format!("{}.tmp", path) } else { path.clone() };
          let wp = std::path::Path::new(&write_path);
          let mut f = sftp.create(wp).map_err(|e| format!("SFTP create '{}': {}", write_path, e))?;
          if let Err(e) = f.write_all(&data) {
            drop(f);
            if atomic { let _ = sftp.unlink(wp); }
            return Err(format!("SFTP write: {}", e));
          }
          drop(f);
          if atomic {
            sftp.rename(wp, p, Some(ssh2::RenameFlags::OVERWRITE | ssh2::RenameFlags::ATOMIC | ssh2::RenameFlags::NATIVE))
              .or_else(|_| { let _ = sftp.unlink(p); sftp.rename(wp, p, None) })
              .map_err(|e| { let _ = sftp.unlink(wp); format!("SFTP rename '{}' → '{}': {}", write_path, path, e) })?;
          }
        }
        if let Some(mode) = o.chmod {
          let st = ssh2::FileStat { size: None, uid: None, gid: None, perm: Some(mode), atime: None, mtime: None };
          if let Err(e) = sftp.setstat(p, st) { warnings.push(format!("permissions {:o} not applied: {}", mode, e)); }
        }
        Ok((len, warnings))
      }).await.map_err(|e| e.to_string())?
    }
    "ftp" | "ftps" => {
      let c = ftp_plain_connect(conn).await?;
      let path = path.to_string();
      with_ftp!(c, ftp => {
        if o.create_dirs {
          if let Some(i) = path.rfind('/') {
            let parent = &path[..i];
            let mut acc = String::new();
            for part in parent.split('/') {
              if part.is_empty() { if acc.is_empty() { acc.push('/'); } continue }
              if !acc.is_empty() && !acc.ends_with('/') { acc.push('/'); }
              acc.push_str(part);
              let _ = ftp.mkdir(&acc).await;   // già esistente → errore ignorato
            }
          }
        }
        let mut cursor = std::io::Cursor::new(data);
        if o.append {
          ftp.append_file(&path, &mut cursor).await.map_err(|e| format!("FTP append '{}': {}", path, e))?;
        } else if atomic {
          let tmp = format!("{}.tmp", path);
          if let Err(e) = ftp.put_file(&tmp, &mut cursor).await {
            let _ = ftp.rm(&tmp).await;
            return Err(format!("FTP put '{}': {}", tmp, e));
          }
          // Non tutti i server rinominano sopra un file esistente.
          if ftp.rename(&tmp, &path).await.is_err() {
            let _ = ftp.rm(&path).await;
            ftp.rename(&tmp, &path).await.map_err(|e| format!("FTP rename '{}' → '{}': {}", tmp, path, e))?;
          }
        } else {
          ftp.put_file(&path, &mut cursor).await.map_err(|e| format!("FTP put '{}': {}", path, e))?;
        }
        if let Some(mode) = o.chmod {
          if let Err(e) = ftp.site(format!("CHMOD {:o} {}", mode, path)).await {
            warnings.push(format!("permissions {:o} not applied (SITE CHMOD): {}", mode, e));
          }
        }
        let _ = ftp.quit().await;
      });
      Ok((len, warnings))
    }
    p => Err(format!("Protocol '{}' not supported", p)),
  }
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

#[derive(Debug, Clone, Deserialize)]
pub struct SmtpConfig {
    pub host:     String, pub port: u16, pub username: String, pub password: String, pub security: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MailAttachmentRequest {
    pub filename:     String, pub content_b64: String, pub content_type: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct MailSendRequest {
    pub smtp:        SmtpConfig, pub from: String, pub to: Vec<String>, pub cc: Vec<String>, pub bcc: Vec<String>,
    pub subject:     String, pub html: Option<String>, pub text: Option<String>,
    pub attachments: Vec<MailAttachmentRequest>,
    /// P367: low | normal | high → intestazioni X-Priority e Importance.
    #[serde(default)]
    pub priority: Option<String>,
}

/// Intestazioni di priorità (P367): X-Priority (1 alta, 3 normale, 5 bassa) e
/// Importance, che leggono Outlook, Thunderbird e Gmail.
#[derive(Clone)]
struct XPriority(String);
impl lettre::message::header::Header for XPriority {
    fn name() -> lettre::message::header::HeaderName { lettre::message::header::HeaderName::new_from_ascii_str("X-Priority") }
    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> { Ok(XPriority(s.to_string())) }
    fn display(&self) -> lettre::message::header::HeaderValue { lettre::message::header::HeaderValue::new(Self::name(), self.0.clone()) }
}
#[derive(Clone)]
struct Importance(String);
impl lettre::message::header::Header for Importance {
    fn name() -> lettre::message::header::HeaderName { lettre::message::header::HeaderName::new_from_ascii_str("Importance") }
    fn parse(s: &str) -> Result<Self, Box<dyn std::error::Error + Send + Sync>> { Ok(Importance(s.to_string())) }
    fn display(&self) -> lettre::message::header::HeaderValue { lettre::message::header::HeaderValue::new(Self::name(), self.0.clone()) }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn mail_send(request: MailSendRequest) -> Result<(), String> {
    mail_send_impl(request).await
}

/// FONTE UNICA dell'invio email (comando Tauri + nodo `mail_sink`). SMTP via lettre.
pub async fn mail_send_impl(request: MailSendRequest) -> Result<(), String> {
    let from_mailbox = request.from.parse::<lettre::message::Mailbox>().map_err(|e| format!("Invalid sender address: {}", e))?;
    let mut builder = Message::builder().from(from_mailbox);
    for addr in &request.to { let mb = addr.parse::<lettre::message::Mailbox>().map_err(|e| format!("Invalid TO '{}': {}", addr, e))?; builder = builder.to(mb); }
    for addr in &request.cc { let mb = addr.parse::<lettre::message::Mailbox>().map_err(|e| format!("Invalid CC '{}': {}", addr, e))?; builder = builder.cc(mb); }
    for addr in &request.bcc { let mb = addr.parse::<lettre::message::Mailbox>().map_err(|e| format!("Invalid BCC '{}': {}", addr, e))?; builder = builder.bcc(mb); }
    builder = builder.subject(&request.subject);
    match request.priority.as_deref() {
        Some("high") => { builder = builder.header(XPriority("1 (Highest)".into())).header(Importance("High".into())); }
        Some("low")  => { builder = builder.header(XPriority("5 (Lowest)".into())).header(Importance("Low".into())); }
        _ => {}
    }
    let body = build_mail_body(&request)?;
    let email = builder.multipart(body).map_err(|e| format!("Email build error: {}", e))?;
    let mut transport = match request.smtp.security.as_str() {
        "ssl" => {
            let tls = TlsParameters::new(request.smtp.host.clone()).map_err(|e| format!("TLS error: {}", e))?;
            AsyncSmtpTransport::<Tokio1Executor>::relay(&request.smtp.host).map_err(|e| format!("SMTP relay error: {}", e))?.port(request.smtp.port).tls(Tls::Wrapper(tls))
        }
        "none" => AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&request.smtp.host).port(request.smtp.port),
        _ => AsyncSmtpTransport::<Tokio1Executor>::starttls_relay(&request.smtp.host).map_err(|e| format!("STARTTLS error: {}", e))?.port(request.smtp.port),
    };
    // P367: senza utente niente AUTH — un relay interno senza
    // autenticazione rifiutava ogni invio ("No compatible authentication
    // mechanism").
    if !request.smtp.username.is_empty() {
        transport = transport.credentials(Credentials::new(request.smtp.username.clone(), request.smtp.password.clone()));
    }
    let transport: AsyncSmtpTransport<Tokio1Executor> = transport.build();
    transport.send(email).await.map_err(|e| format!("SMTP send failed: {}", e))?;
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
        let data = base64::engine::general_purpose::STANDARD.decode(&att.content_b64).map_err(|e| format!("Attachment '{}' invalid base64: {}", att.filename, e))?;
        let content_type = att.content_type.parse::<lettre::message::header::ContentType>().unwrap_or_else(|_| "application/octet-stream".parse().unwrap());
        mixed = mixed.singlepart(Attachment::new(att.filename.clone()).body(data, content_type));
    }
    Ok(mixed)
}

//-----mqtt-----
#[derive(Debug, Deserialize, Clone)]
pub struct MqttConnectionParams {
    pub host: String, pub port: u16, pub client_id: String, pub username: Option<String>, pub password: Option<String>,
    pub keep_alive: u64, pub clean_session: bool, pub use_tls: bool,
    /// P367: attesa massima della risposta del broker (CONNACK), in secondi.
    #[serde(default = "mqtt_default_connect_timeout")]
    pub connect_timeout: u64,
}
fn mqtt_default_connect_timeout() -> u64 { 10 }
#[derive(Debug, Deserialize)]
pub struct MqttSubscribeRequest { pub connection: MqttConnectionParams, pub topic: String, pub qos: u8, pub timeout_ms: u64, pub max_messages: usize }
#[derive(Debug, Serialize)]
pub struct MqttMessage { pub topic: String, pub payload: String, pub qos: u8, pub retain: bool, pub received_at: String }
#[derive(Debug, Deserialize)]
pub struct MqttPublishRequest { pub connection: MqttConnectionParams, pub topic: String, pub payload: String, pub qos: u8, pub retain: bool }

fn mqtt_qos(qos: u8) -> rumqttc::QoS {
    match qos { 0 => rumqttc::QoS::AtMostOnce, 2 => rumqttc::QoS::ExactlyOnce, _ => rumqttc::QoS::AtLeastOnce }
}

fn build_mqtt_options(conn: &MqttConnectionParams) -> rumqttc::MqttOptions {
    let mut opts = rumqttc::MqttOptions::new(&conn.client_id, &conn.host, conn.port);
    opts.set_keep_alive(std::time::Duration::from_secs(conn.keep_alive));
    opts.set_clean_session(conn.clean_session);
    if let (Some(user), Some(pass)) = (&conn.username, &conn.password) { opts.set_credentials(user, pass); }
    // 🐞 Corretto (P337): `use_tls` era letto dalla config e poi IGNORATO — il nodo si
    // collegava in chiaro (credenziali comprese). Ora TLS vero (native-tls, verifica
    // del certificato del broker con i certificati di sistema).
    if conn.use_tls {
        opts.set_transport(rumqttc::Transport::tls_with_config(rumqttc::TlsConfiguration::Native));
    }
    opts
}

/// Attende la CONNACK del broker entro `secs` (P367: il timeout di connessione
/// del pannello; prima 10 s fissi in pubblicazione e nessuno in sottoscrizione).
async fn mqtt_wait_connack(eventloop: &mut rumqttc::EventLoop, secs: u64) -> Result<(), String> {
    use rumqttc::{Event, Incoming};
    let secs = secs.max(1);
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(secs);
    loop {
        match tokio::time::timeout_at(deadline, eventloop.poll()).await {
            Ok(Ok(Event::Incoming(Incoming::ConnAck(_)))) => return Ok(()),
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("MQTT connection failed: {}", e)),
            Err(_)     => return Err(format!("MQTT: no answer from the broker within {} s", secs)),
        }
    }
}

pub async fn mqtt_subscribe_impl(request: MqttSubscribeRequest) -> Result<Vec<MqttMessage>, String> {
    use rumqttc::{AsyncClient, Event, Incoming};
    let opts = build_mqtt_options(&request.connection);
    let (client, mut eventloop) = AsyncClient::new(opts, 64);
    client.subscribe(&request.topic, mqtt_qos(request.qos)).await.map_err(|e| format!("MQTT subscribe failed: {}", e))?;
    // P367: prima la risposta del broker, entro il timeout di connessione.
    // Prima un broker irraggiungibile faceva finire l'attesa dei messaggi con
    // zero righe e nessun errore.
    mqtt_wait_connack(&mut eventloop, request.connection.connect_timeout).await?;
    let mut messages: Vec<MqttMessage> = Vec::new();
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_millis(request.timeout_ms);
    loop {
        if messages.len() >= request.max_messages { break; }
        match tokio::time::timeout_at(deadline, eventloop.poll()).await {
            Ok(Ok(Event::Incoming(Incoming::Publish(publish)))) => {
                messages.push(MqttMessage { topic: publish.topic.clone(), payload: String::from_utf8_lossy(&publish.payload).to_string(), qos: publish.qos as u8, retain: publish.retain, received_at: chrono::Utc::now().to_rfc3339() });
            }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => { return Err(format!("MQTT connection error: {}", e)); }
            Err(_) => { break; }
        }
    }
    client.disconnect().await.ok();
    Ok(messages)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn mqtt_subscribe(request: MqttSubscribeRequest) -> Result<Vec<MqttMessage>, String> {
    mqtt_subscribe_impl(request).await
}

pub async fn mqtt_publish_impl(request: MqttPublishRequest) -> Result<(), String> {
    use rumqttc::{AsyncClient, Event, Incoming};
    let opts = build_mqtt_options(&request.connection);
    let (client, mut eventloop) = AsyncClient::new(opts, 16);
    mqtt_wait_connack(&mut eventloop, request.connection.connect_timeout).await?;
    client.publish(&request.topic, mqtt_qos(request.qos), request.retain, request.payload.as_bytes()).await.map_err(|e| format!("MQTT publish failed: {}", e))?;
    if request.qos > 0 {
        let deadline2 = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            match tokio::time::timeout_at(deadline2, eventloop.poll()).await {
                Ok(Ok(Event::Incoming(Incoming::PubAck(_)))) => break,
                Ok(Ok(Event::Incoming(Incoming::PubComp(_)))) => break,
                Ok(Ok(_)) => {}
                Ok(Err(e)) => return Err(format!("MQTT ack failed: {}", e)),
                Err(_) => break,
            }
        }
    }
    client.disconnect().await.ok();
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn mqtt_publish(request: MqttPublishRequest) -> Result<(), String> {
    mqtt_publish_impl(request).await
}

#[derive(Debug, Deserialize, Clone)]
pub struct StompConnectionParams { pub host: String, pub port: u16, pub username: String, pub password: String, pub vhost: String, pub use_tls: bool }
#[derive(Debug, Deserialize)]
pub struct StompSubscribeRequest {
    pub connection: StompConnectionParams, pub destination: String, pub dest_type: String, pub ack_mode: String, pub selector: Option<String>, pub timeout_ms: u64, pub max_messages: usize,
    /// P367: messaggi che il broker può mandare prima degli ack (activemq.prefetchSize).
    #[serde(default)] pub prefetch: Option<u32>,
    /// P367: sottoscrizione durevole (solo topic): nome stabile, usato anche come client-id.
    #[serde(default)] pub durable_name: Option<String>,
}
#[derive(Debug, Serialize)]
pub struct StompMessage { pub destination: String, pub payload: String, pub headers: std::collections::HashMap<String, String>, pub message_id: String, pub received_at: String }
#[derive(Debug, Deserialize)]
pub struct StompPublishRequest { pub connection: StompConnectionParams, pub destination: String, pub dest_type: String, pub payload: String, pub persistent: bool, pub priority: u8, pub ttl: u64, pub correlation_id: Option<String> }

#[cfg(feature = "desktop")]
#[tauri::command]
async fn stomp_subscribe(request: StompSubscribeRequest) -> Result<Vec<StompMessage>, String> {
    stomp_subscribe_impl(request).await
}

/// FONTE UNICA del consumer STOMP (comando Tauri + nodo `source_activemq`).
pub async fn stomp_subscribe_impl(request: StompSubscribeRequest) -> Result<Vec<StompMessage>, String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpStream;
    let addr = format!("{}:{}", request.connection.host, request.connection.port);
    let stream = tokio::time::timeout(std::time::Duration::from_secs(10), TcpStream::connect(&addr)).await
        .map_err(|_| format!("STOMP: connection timeout to {}", addr))?
        .map_err(|e| format!("STOMP: connection failed to {}: {}", addr, e))?;
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let durable = request.durable_name.as_deref().filter(|n| !n.is_empty() && request.dest_type == "topic");
    let client_id = durable.map(|n| format!("client-id:{}\n", n)).unwrap_or_default();
    let connect_frame = format!("CONNECT\naccept-version:1.0,1.1,1.2\nhost:{}\nlogin:{}\npasscode:{}\n{}\n\0", request.connection.vhost, request.connection.username, request.connection.password, client_id);
    writer.write_all(connect_frame.as_bytes()).await.map_err(|e| format!("STOMP CONNECT failed: {}", e))?;
    stomp_handshake(&mut reader).await?;
    let dest = format_stomp_destination(&request.destination, &request.dest_type);
    let ack = if request.ack_mode == "client" { "client" } else { "auto" };
    let mut sub_frame = format!("SUBSCRIBE\nid:sub-0\ndestination:{}\nack:{}\n", dest, ack);
    if let Some(sel) = &request.selector { sub_frame.push_str(&format!("selector:{}\n", sel)); }
    if let Some(n) = request.prefetch.filter(|n| *n > 0) { sub_frame.push_str(&format!("activemq.prefetchSize:{}\n", n)); }
    if let Some(name) = durable { sub_frame.push_str(&format!("activemq.subscriptionName:{}\n", name)); }
    sub_frame.push_str("\n\0");
    writer.write_all(sub_frame.as_bytes()).await.map_err(|e| format!("STOMP SUBSCRIBE failed: {}", e))?;
    let mut messages: Vec<StompMessage> = Vec::new();
    // P367: 0 = senza limite, come dice il pannello (prima 0 messaggi o 0 ms
    // facevano finire subito l'attesa). Il chiamante resta cancellabile.
    let deadline = (request.timeout_ms > 0).then(|| tokio::time::Instant::now() + std::time::Duration::from_millis(request.timeout_ms));
    loop {
        if request.max_messages > 0 && messages.len() >= request.max_messages { break; }
        let next = match deadline {
            Some(d) => tokio::time::timeout_at(d, read_stomp_frame(&mut reader)).await,
            None    => Ok(read_stomp_frame(&mut reader).await),
        };
        match next {
            Ok(Ok(frame)) => {
                if frame.starts_with("ERROR") {
                    return Err(format!("STOMP ERROR: {}", stomp_error_text(&frame)));
                }
                if frame.starts_with("MESSAGE") {
                    if let Some(msg) = parse_stomp_message(&frame, &dest) {
                        if ack == "client" { if let Some(msg_id) = msg.headers.get("message-id") { let ack_frame = format!("ACK\nid:{}\n\n\0", msg_id); writer.write_all(ack_frame.as_bytes()).await.ok(); } }
                        messages.push(msg);
                    }
                }
            }
            // Con messaggi già ricevuti (e in ack auto già confermati) si
            // consegnano quelli invece di perderli.
            Ok(Err(e)) if !messages.is_empty() => { eprintln!("[stomp] {} — {} messages kept", e, messages.len()); break; }
            Ok(Err(e)) => return Err(format!("STOMP: read error: {}", e)),
            Err(_) => break,
        }
    }
    let disconnect = format!("DISCONNECT\nreceipt:rec-1\n\n\0");
    writer.write_all(disconnect.as_bytes()).await.ok();
    Ok(messages)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn stomp_publish(request: StompPublishRequest) -> Result<(), String> {
    stomp_publish_impl(request).await
}

/// FONTE UNICA del producer STOMP (comando Tauri + nodo `sink_activemq`).
pub async fn stomp_publish_impl(request: StompPublishRequest) -> Result<(), String> {
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::TcpStream;
    let addr = format!("{}:{}", request.connection.host, request.connection.port);
    let stream = tokio::time::timeout(std::time::Duration::from_secs(10), TcpStream::connect(&addr)).await
        .map_err(|_| format!("STOMP: connection timeout to {}", addr))?
        .map_err(|e| format!("STOMP: connection failed: {}", e))?;
    let (reader, mut writer) = stream.into_split();
    let mut reader = BufReader::new(reader);
    let connect_frame = format!("CONNECT\naccept-version:1.0,1.1,1.2\nhost:{}\nlogin:{}\npasscode:{}\n\n\0", request.connection.vhost, request.connection.username, request.connection.password);
    writer.write_all(connect_frame.as_bytes()).await.map_err(|e| format!("STOMP CONNECT failed: {}", e))?;
    stomp_handshake(&mut reader).await?;
    let dest = format_stomp_destination(&request.destination, &request.dest_type);
    let receipt_id = format!("send-{}", chrono::Utc::now().timestamp_millis());
    let mut send_frame = format!("SEND\ndestination:{}\ncontent-length:{}\ndelivery-mode:{}\npriority:{}\nreceipt:{}\n", dest, request.payload.len(), if request.persistent { "persistent" } else { "non-persistent" }, request.priority, receipt_id);
    if request.ttl > 0 { send_frame.push_str(&format!("expires:{}\n", chrono::Utc::now().timestamp_millis() + request.ttl as i64)); }
    if let Some(cid) = &request.correlation_id { send_frame.push_str(&format!("correlation-id:{}\n", cid)); }
    send_frame.push('\n');
    send_frame.push_str(&request.payload);
    send_frame.push('\0');
    writer.write_all(send_frame.as_bytes()).await.map_err(|e| format!("STOMP SEND failed: {}", e))?;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(5);
    loop {
        match tokio::time::timeout_at(deadline, read_stomp_frame(&mut reader)).await {
            Ok(Ok(frame)) if frame.starts_with("RECEIPT") => break,
            Ok(Ok(frame)) if frame.starts_with("ERROR") => { return Err(format!("STOMP ERROR: {}", stomp_error_text(&frame))); }
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("STOMP: receipt wait error: {}", e)),
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

/// P367: attesa del CONNECTED con un limite (10 s) e il messaggio del
/// broker se rifiuta (frame ERROR) — prima l'attesa era senza limite.
async fn stomp_handshake<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<String, String> {
    let frame = tokio::time::timeout(std::time::Duration::from_secs(10), read_stomp_frame(reader)).await
        .map_err(|_| "STOMP: no answer to CONNECT within 10 s".to_string())?
        .map_err(|e| format!("STOMP: handshake failed — {}", e))?;
    if frame.starts_with("CONNECTED") { return Ok(frame); }
    Err(format!("STOMP: handshake refused — {}", stomp_error_text(&frame)))
}

/// Testo leggibile di un frame ERROR: header `message` più il corpo.
fn stomp_error_text(frame: &str) -> String {
    let (head, body) = frame.split_once("\n\n").unwrap_or((frame, ""));
    let msg = head.lines().find_map(|l| l.strip_prefix("message:")).unwrap_or("").trim();
    let body = body.trim_matches(|c: char| c == '\0' || c.is_whitespace());
    let txt = match (msg.is_empty(), body.is_empty()) {
        (false, false) if msg == body => msg.to_string(),
        (false, false) => format!("{} — {}", msg, body),
        (false, true)  => msg.to_string(),
        (true, false)  => body.to_string(),
        (true, true)   => head.lines().next().unwrap_or("").to_string(),
    };
    txt.chars().take(300).collect()
}

/// Un frame STOMP: tutto fino al NUL che lo chiude (senza il NUL).
/// P367: prima si leggeva a righe e un frame chiuso da NUL senza a-capo
/// dopo (Artemis, coilmq…) restava in attesa per sempre; la connessione
/// chiusa dal broker tornava come frame vuoto (il consumer girava a vuoto).
/// Gli a-capo prima di un frame (fine del precedente, heart-beat) si saltano.
async fn read_stomp_frame<R: tokio::io::AsyncBufRead + Unpin>(reader: &mut R) -> Result<String, String> {
    let mut buf: Vec<u8> = Vec::new();
    loop {
        buf.clear();
        let n = tokio::io::AsyncBufReadExt::read_until(reader, 0, &mut buf).await.map_err(|e| format!("STOMP read error: {}", e))?;
        if n == 0 || buf.last() != Some(&0) { return Err("connection closed by the broker".into()); }
        buf.pop();
        let start = buf.iter().position(|b| *b != b'\n' && *b != b'\r').unwrap_or(buf.len());
        if start < buf.len() { return Ok(String::from_utf8_lossy(&buf[start..]).into_owned()); }
    }
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

use hmac::{Hmac, KeyInit, Mac};
use sha2::Sha256;
use sha1::Sha1;

#[derive(Debug, Clone, Serialize)]
pub struct WebhookEvent {
    pub event_id:        String,
    pub event_type:      String,
    pub source_ip:       String,
    pub path:            String,
    pub headers:         std::collections::HashMap<String, String>,
    pub payload:         serde_json::Value,
    pub received_at:     String,
    pub signature_valid: Option<bool>,
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
    /// false = coda piena con overflow "error" (P367: chi chiama risponde 503,
    /// così il mittente sa di dover riprovare; prima era come drop_newest).
    fn push(&mut self, event: WebhookEvent) -> bool {
        if self.is_duplicate(&event.event_id) { return true; }
        if self.queue.len() >= self.max_buffer {
            match self.overflow.as_str() {
                "drop_oldest" => { self.queue.pop_front(); }
                "error"       => return false,
                _             => return true,   // drop_newest: scartato
            }
        }
        if self.dedup_ttl_sec > 0 { self.seen.insert(event.event_id.clone(), Instant::now()); }
        self.queue.push_back(event);
        true
    }
    fn pop(&mut self) -> Option<WebhookEvent> { self.queue.pop_front() }
    fn queued(&self) -> usize { self.queue.len() }
}

#[cfg(test)]
mod tests_stomp_frame {
    use super::*;
    #[tokio::test]
    async fn frame_chiusi_da_nul() {
        // NUL senza a-capo dopo, heart-beat fra i frame, poi chiusura.
        let data: &[u8] = b"CONNECTED\nversion:1.2\n\n\0\n\nMESSAGE\ndestination:/queue/a\n\nciao\0";
        let mut r = tokio::io::BufReader::new(data);
        assert!(read_stomp_frame(&mut r).await.unwrap().starts_with("CONNECTED"));
        let m = read_stomp_frame(&mut r).await.unwrap();
        assert_eq!(parse_stomp_message(&m, "x").unwrap().payload, "ciao");
        assert!(read_stomp_frame(&mut r).await.is_err());
        assert_eq!(stomp_error_text("ERROR\nmessage:no\n\nno\0"), "no");
    }
}

#[cfg(test)]
mod tests_webhook_overflow {
    use super::*;
    fn ev(id: &str) -> WebhookEvent {
        WebhookEvent { event_id: id.into(), event_type: String::new(), source_ip: String::new(), path: "/h".into(),
            headers: Default::default(), payload: serde_json::Value::Null, received_at: String::new(), signature_valid: None }
    }
    fn sub(overflow: &str) -> WebhookSubscriber {
        WebhookSubscriber::new("n".into(), String::new(), String::new(), String::new(), 0, 2, overflow.into())
    }
    #[test]
    fn coda_piena() {
        // error: il terzo evento è rifiutato (il server risponde 503)
        let mut s = sub("error");
        assert!(s.push(ev("a")) && s.push(ev("b")));
        assert!(!s.push(ev("c")));
        assert_eq!(s.queued(), 2);
        // drop_newest: accettato ma scartato
        let mut s = sub("drop_newest");
        s.push(ev("a")); s.push(ev("b"));
        assert!(s.push(ev("c")));
        assert_eq!(s.pop().unwrap().event_id, "a");
        // drop_oldest: entra, esce il più vecchio
        let mut s = sub("drop_oldest");
        s.push(ev("a")); s.push(ev("b"));
        assert!(s.push(ev("c")));
        assert_eq!(s.pop().unwrap().event_id, "b");
    }
}

struct WebhookServerState {
    subscribers: std::collections::HashMap<String, WebhookSubscriber>,
}
impl WebhookServerState {
    fn new() -> Self { Self { subscribers: std::collections::HashMap::new() } }
    /// false = l'evento non è entrato (coda piena, overflow "error").
    fn deliver(&mut self, path: &str, event: WebhookEvent) -> bool {
        match self.subscribers.get_mut(path) { Some(sub) => sub.push(event), None => true }
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
pub struct WebhookServerStartRequest { pub resource_id: String, pub port: u16, pub ip_whitelist: Vec<String> }

#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_server_start(request: WebhookServerStartRequest) -> Result<(), String> {
    webhook_server_start_impl(request).await
}

/// FONTE UNICA del server webhook (chiamata dal comando Tauri e dal
/// nodo-servizio `webhook_receiver` nel motore). V. pattern rete (`*_impl`).
pub async fn webhook_server_start_impl(request: WebhookServerStartRequest) -> Result<(), String> {
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper::{Request, Response, StatusCode};
    use http_body_util::{BodyExt, Full};
    use hyper::body::Bytes;

    { let reg = webhook_servers().lock().unwrap(); if reg.contains_key(&request.resource_id) { return Ok(()); } }

    let addr: std::net::SocketAddr = format!("0.0.0.0:{}", request.port).parse().map_err(|e| format!("Invalid port: {}", e))?;
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
                                if let Some(event) = event_opt {
                                    if !state.lock().unwrap().deliver(&event.path.clone(), event) {
                                        let full = Response::builder().status(StatusCode::SERVICE_UNAVAILABLE).header("Content-Type", "application/json").header("Retry-After", "5").body(Full::new(Bytes::from(r#"{"status":"queue_full"}"#))).unwrap();
                                        return Ok::<_, hyper::Error>(full);
                                    }
                                }
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

#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_server_stop(resource_id: String) -> Result<(), String> {
    if let Some(entry) = webhook_servers().lock().unwrap().remove(&resource_id) { let _ = entry.shutdown_tx.send(()); }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct WebhookSubscribeRequest { pub resource_id: String, pub node_id: String, pub path: String, pub secret: String, pub sig_header: String, pub sig_algo: String, pub dedup_ttl_sec: u64, pub max_buffer: usize, pub overflow: String }

#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_subscribe(request: WebhookSubscribeRequest) -> Result<(), String> {
    webhook_subscribe_impl(request).await
}

pub async fn webhook_subscribe_impl(request: WebhookSubscribeRequest) -> Result<(), String> {
    let reg   = webhook_servers().lock().unwrap();
    let entry = reg.get(&request.resource_id).ok_or_else(|| format!("Webhook server '{}' not started", request.resource_id))?;
    let mut state = entry.state.lock().unwrap();
    let sub = WebhookSubscriber::new(request.node_id.clone(), request.secret, request.sig_header.to_lowercase(), request.sig_algo, request.dedup_ttl_sec, request.max_buffer.max(1), request.overflow);
    state.subscribers.insert(request.path.clone(), sub);
    eprintln!("Webhook: {} registrato su {}", request.node_id, request.path);
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_unsubscribe(resource_id: String, node_id: String) -> Result<(), String> {
    webhook_unsubscribe_impl(resource_id, node_id).await
}

pub async fn webhook_unsubscribe_impl(resource_id: String, node_id: String) -> Result<(), String> {
    let reg = webhook_servers().lock().unwrap();
    if let Some(entry) = reg.get(&resource_id) { entry.state.lock().unwrap().subscribers.retain(|_, s| s.node_id != node_id); }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct WebhookPopResult { pub event: Option<WebhookEvent>, pub queued: usize }

#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_pop(resource_id: String, node_id: String) -> Result<WebhookPopResult, String> {
    webhook_pop_impl(resource_id, node_id).await
}

pub async fn webhook_pop_impl(resource_id: String, node_id: String) -> Result<WebhookPopResult, String> {
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
pub struct WebhookResponderStartRequest {
    pub node_id: String, pub port: u16, pub path: String,
    pub methods: Vec<String>,
    pub headers: std::collections::HashMap<String, String>,
    #[serde(default)] pub expose_body: bool,
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_responder_start(request: WebhookResponderStartRequest) -> Result<(), String> {
    webhook_responder_start_impl(request).await
}

/// FONTE UNICA del server responder (comando Tauri + nodo `webhook_responder`).
pub async fn webhook_responder_start_impl(request: WebhookResponderStartRequest) -> Result<(), String> {
    use hyper::server::conn::http1;
    use hyper::service::service_fn;
    use hyper::{Request, Response, StatusCode};
    use http_body_util::Full;
    use hyper::body::Bytes;

    let addr: std::net::SocketAddr = format!("0.0.0.0:{}", request.port).parse().map_err(|e| format!("Invalid port: {}", e))?;

    let (tx, rx)  = tokio::sync::oneshot::channel::<()>();
    let req_count = Arc::new(std::sync::atomic::AtomicU64::new(0));
    let req_count_cl = Arc::clone(&req_count);

    // Headers dinamici — inizializzati con i valori di avvio, aggiornabili via webhook_responder_update_headers
    let headers_state: ResponderHeaders = Arc::new(Mutex::new(request.headers.clone()));
    let headers_cl = Arc::clone(&headers_state);

    webhook_responders().lock().unwrap().insert(request.node_id.clone(), (tx, req_count, headers_state));

    let path    = request.path.clone();
    let methods = request.methods.iter().map(|m| m.to_uppercase()).collect::<Vec<_>>();
    let expose_body = request.expose_body;

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
                    let expose_body = expose_body;
                    tokio::spawn(async move {
                        let svc = service_fn(move |req: Request<hyper::body::Incoming>| {
                            let path = path.clone(); let methods = methods.clone();
                            let hdrs = Arc::clone(&hdrs); let cnt = Arc::clone(&cnt);
                            let expose_body = expose_body;
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
                                // HEAD → mai corpo (204). GET → JSON degli header SOLO se
                                // `expose_body` è attivo (toggle nel pannello); altrimenti
                                // resta header-only, endpoint macchina-a-macchina puro.
                                let body = if method == "HEAD" || !expose_body {
                                    Full::new(Bytes::new())
                                } else {
                                    builder = builder.header("content-type", "application/json");
                                    let json = serde_json::to_string(&current_headers).unwrap_or_else(|_| "{}".to_string());
                                    Full::new(Bytes::from(json))
                                };
                                Ok::<_, hyper::Error>(builder.body(body).unwrap())
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
#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_responder_update_headers(
    node_id: String,
    headers: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    webhook_responder_update_headers_impl(node_id, headers).await
}

pub async fn webhook_responder_update_headers_impl(
    node_id: String,
    headers: std::collections::HashMap<String, String>,
) -> Result<(), String> {
    let reg = webhook_responders().lock().unwrap();
    if let Some((_, _, headers_state)) = reg.get(&node_id) {
        *headers_state.lock().unwrap() = headers;
    }
    Ok(())
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_responder_request_count(node_id: String) -> Result<u64, String> {
    Ok(webhook_responders().lock().unwrap().get(&node_id)
        .map(|(_, cnt, _)| cnt.load(std::sync::atomic::Ordering::Relaxed)).unwrap_or(0))
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn webhook_responder_stop(node_id: String) -> Result<(), String> {
    webhook_responder_stop_impl(node_id).await
}

pub async fn webhook_responder_stop_impl(node_id: String) -> Result<(), String> {
    if let Some((tx, _, _)) = webhook_responders().lock().unwrap().remove(&node_id) { let _ = tx.send(()); }
    Ok(())
}

// ─── Watchdog ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct WatchdogCheckRequest {
    pub url: String, pub method: String, pub header_name: String, pub header_value: String,
    pub match_mode: String, pub auth_type: String, pub auth_value: String, pub timeout_sec: u64,
}

#[derive(Debug, Serialize)]
pub struct WatchdogCheckResult { pub matched: bool, pub header_found: Option<String>, pub status_code: u16, pub elapsed_ms: u64 }

#[cfg(feature = "desktop")]
#[tauri::command]
async fn watchdog_check(request: WatchdogCheckRequest) -> Result<WatchdogCheckResult, String> {
    watchdog_check_impl(request).await
}

/// FONTE UNICA del check watchdog (comando Tauri + nodo-servizio `watchdog`
/// nel motore). Pattern rete (`*_impl`).
pub async fn watchdog_check_impl(request: WatchdogCheckRequest) -> Result<WatchdogCheckResult, String> {
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
pub struct ShellExecRequest {
    pub command:     String,
    pub cwd:         Option<String>,
    pub timeout_sec: Option<u64>,
    pub env:         Option<HashMap<String, String>>,
}

#[derive(serde::Serialize)]
pub struct ShellResult {
    pub exit_code:   i32,
    pub stdout:      String,
    pub stderr:      String,
    pub duration_ms: u64,
}


#[cfg(feature = "desktop")]
#[tauri::command]
async fn shell_exec(request: ShellExecRequest) -> Result<ShellResult, String> {
    shell_exec_impl(request).await
}

/// Esecuzione shell reale (`/bin/sh -c`), richiamabile SIA dal comando Tauri
/// SIA dai nodi del motore (porting del nodo shell_exec). Estratta come
/// `*_impl` per la fonte unica — stesso pattern di rete/webhook/stomp; il
/// comando resta un wrapper sottile (gotcha E0255: mai `pub` su un
/// `#[tauri::command]` nello stesso modulo, la macro ri-esporterebbe helper
/// con nomi duplicati).
pub async fn shell_exec_impl(request: ShellExecRequest) -> Result<ShellResult, String> {
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
        .map_err(|_| format!("Shell: timeout after {}s", timeout_secs))?
        .map_err(|e| format!("Shell: start error — {}", e))?
    } else {
        cmd.output()
            .await
            .map_err(|e| format!("Shell: start error — {}", e))?
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
pub struct SshConnection {
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
pub struct SshExecRequest {
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
        &addr.parse().map_err(|e| format!("SSH: invalid address — {}", e))?,
        Duration::from_secs(conn.connect_timeout_sec),
    ).map_err(|e| format!("SSH: TCP connection failed — {}", e))?;

    let mut sess = ssh2::Session::new()
        .map_err(|e| format!("SSH: session error — {}", e))?;
    sess.set_tcp_stream(tcp);
    sess.handshake()
        .map_err(|e| format!("SSH: handshake failed — {}", e))?;

    // Autenticazione
    match conn.auth_type.as_str() {
        "password" => {
            let pwd = conn.password.as_deref().unwrap_or("");
            sess.userauth_password(&conn.user, pwd)
                .map_err(|e| format!("SSH: password authentication failed — {}", e))?;
        }
        "key" | "key_passphrase" => {
            let key_path = conn.key_path.as_deref()
                .ok_or("SSH: key_path not configured")?;
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
            ).map_err(|e| format!("SSH: key authentication failed — {}", e))?;
        }
        _ => return Err(format!("SSH: auth_type '{}' not supported", conn.auth_type)),
    }

    if !sess.authenticated() {
        return Err("SSH: authentication failed".to_string());
    }

    Ok(sess)
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn ssh_exec(request: SshExecRequest) -> Result<ShellResult, String> {
    ssh_exec_impl(request).await
}

/// Esecuzione SSH reale (ssh2, in `spawn_blocking`), richiamabile SIA dal
/// comando Tauri SIA dai nodi del motore (porting del nodo ssh_exec). Estratta
/// come `*_impl` per la fonte unica — gemella di `shell_exec_impl`; il comando
/// resta un wrapper sottile (gotcha E0255).
pub async fn ssh_exec_impl(request: SshExecRequest) -> Result<ShellResult, String> {
    let conn    = request.connection.clone();
    let command = request.command.clone();
    let timeout = request.timeout_sec;

    // ssh2 non è async — esegui in thread separato
    let result = tokio::task::spawn_blocking(move || -> Result<ShellResult, String> {
        let start = Instant::now();
        let sess  = build_ssh_session(&conn)?;

        let mut channel = sess.channel_session()
            .map_err(|e| format!("SSH: channel open error — {}", e))?;

        channel.exec(&command)
            .map_err(|e| format!("SSH: execution error — {}", e))?;

        let mut stdout_buf = String::new();
        let mut stderr_buf = String::new();

        channel.read_to_string(&mut stdout_buf)
            .map_err(|e| format!("SSH: stdout read error — {}", e))?;

        channel.stderr().read_to_string(&mut stderr_buf)
            .map_err(|e| format!("SSH: stderr read error — {}", e))?;

        channel.wait_close()
            .map_err(|e| format!("SSH: channel close error — {}", e))?;

        let exit_code   = channel.exit_status().unwrap_or(-1);
        let duration_ms = start.elapsed().as_millis() as u64;

        Ok(ShellResult { exit_code, stdout: stdout_buf, stderr: stderr_buf, duration_ms })
    })
    .await
    .map_err(|e| format!("SSH: thread error — {}", e))??;

    Ok(result)
}

#[cfg(feature = "desktop")]
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
            message:    format!("Connection to {}:{} succeeded ({}ms)", connection.host, connection.port, elapsed_ms),
            elapsed_ms,
        }),
        Err(e) => Ok(SshTestResult {
            ok:         false,
            message:    e,
            elapsed_ms,
        }),
    }
}

// ─── LDAP ─────────────────────────────────────────────────────────
// Infrastruttura di connessione condivisa (FETTA 1). Il comando `ldap_test`
// è il round-trip per il pulsante "Test connessione" della risorsa LDAP; le
// funzioni `pub` qui sotto saranno riusate dai nodi ldap_source / ldap_auth
// (stesso schema di ssh: un `*_impl`/helper pub, il comando è un wrapper).
// Crate: ldap3 (async, native-tls). Sicurezza: LDAPS di default, verifica
// certificato attiva salvo opt-out esplicito, StartTLS come alternativa; un
// bindDN con password vuota è RIFIUTATO (molti server lo trattano come bind
// anonimo che "riesce" → falso positivo di autenticazione).

#[derive(serde::Deserialize, Clone)]
pub struct LdapConnection {
    pub host:                String,
    pub port:                u16,
    pub tls_mode:            String,   // "ldaps" | "starttls" | "plain"
    pub verify_cert:         bool,
    pub bind_dn:             String,   // account di servizio ("" = bind anonimo)
    pub password:            String,
    pub base_dn:             String,
    pub connect_timeout_sec: u64,
}

#[derive(serde::Serialize)]
pub struct LdapTestResult {
    pub ok:         bool,
    pub message:    String,
    pub elapsed_ms: u64,
}

fn ldap_url(conn: &LdapConnection) -> String {
    let scheme = if conn.tls_mode == "ldaps" { "ldaps" } else { "ldap" };
    format!("{}://{}:{}", scheme, conn.host, conn.port)
}

/// Apre la connessione, esegue il bind di SERVIZIO (se un bindDN è impostato) e
/// restituisce l'handle pronto per le operazioni. Il driver di connessione è
/// già spawnato con `drive!`. Condivisa da ldap_test e (in seguito) dai nodi.
pub async fn ldap_connect_and_bind(conn: &LdapConnection) -> Result<ldap3::Ldap, String> {
    let mut settings = ldap3::LdapConnSettings::new()
        .set_conn_timeout(std::time::Duration::from_secs(conn.connect_timeout_sec.max(1)))
        .set_no_tls_verify(!conn.verify_cert);
    if conn.tls_mode == "starttls" {
        settings = settings.set_starttls(true);
    }

    let url = ldap_url(conn);
    let (driver, mut ldap) = ldap3::LdapConnAsync::with_settings(settings, &url)
        .await
        .map_err(|e| format!("LDAP: connection to {} failed — {}", url, e))?;
    ldap3::drive!(driver);

    // Un bindDN con password vuota NON è consentito: sarebbe un bind anonimo
    // travestito da account di servizio, che molti server accettano.
    if !conn.bind_dn.is_empty() {
        if conn.password.is_empty() {
            return Err("LDAP: service account password empty (masked anonymous bind not allowed)".to_string());
        }
        ldap.simple_bind(&conn.bind_dn, &conn.password)
            .await
            .map_err(|e| format!("LDAP: bind failed — {}", e))?
            .success()
            .map_err(|e| format!("LDAP: bind refused by the server — {}", e))?;
    }

    Ok(ldap)
}

pub async fn ldap_test_impl(connection: LdapConnection) -> Result<LdapTestResult, String> {
    let start = Instant::now();
    let outcome = ldap_connect_and_bind(&connection).await;
    let elapsed_ms = start.elapsed().as_millis() as u64;
    match outcome {
        Ok(mut ldap) => {
            let _ = ldap.unbind().await;
            let how = if connection.bind_dn.is_empty() { "connection (anonymous)" }
                      else { "connection + service bind" };
            Ok(LdapTestResult {
                ok:      true,
                message: format!("{} to {}:{} succeeded ({}ms)", how, connection.host, connection.port, elapsed_ms),
                elapsed_ms,
            })
        }
        Err(e) => Ok(LdapTestResult { ok: false, message: e, elapsed_ms }),
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn ldap_test(connection: LdapConnection) -> Result<LdapTestResult, String> {
    ldap_test_impl(connection).await
}

// ─── GitHub (lettura) ─────────────────────────────────────────────
// Infrastruttura di connessione condivisa per i nodi GitHub in LETTURA
// (github_repos / github_issues / github_commits). Solo HTTPS+JSON via reqwest
// (già nel progetto) — nessun crate nuovo. Il comando `github_test` è il
// round-trip per il pulsante "Testa connessione" della risorsa: GET /rate_limit
// con il token. GitHub ESIGE un header User-Agent, altrimenti rifiuta.

#[derive(serde::Deserialize, Clone)]
pub struct GithubConnection {
    pub token:    String,   // PAT (idealmente fine-grained, sola lettura)
    pub base_url: String,   // "" → https://api.github.com (per Enterprise: .../api/v3)
}

#[derive(serde::Serialize)]
pub struct GithubTestResult {
    pub ok:      bool,
    pub message: String,
}

/// Base URL normalizzata (default api.github.com, senza slash finale).
pub fn github_base(conn: &GithubConnection) -> String {
    if conn.base_url.trim().is_empty() {
        "https://api.github.com".to_string()
    } else {
        conn.base_url.trim().trim_end_matches('/').to_string()
    }
}

/// Client reqwest con gli header standard GitHub (User-Agent obbligatorio,
/// Accept + versione API) e il Bearer token se presente. Condiviso dai nodi.
pub fn github_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .user_agent("FlowPilot")
        .build()
        .map_err(|e| format!("client GitHub: {}", e))
}

pub async fn github_test_impl(connection: GithubConnection) -> Result<GithubTestResult, String> {
    let client = github_client()?;
    let mut req = client
        .get(format!("{}/rate_limit", github_base(&connection)))
        .header("Accept", "application/vnd.github+json")
        .header("X-GitHub-Api-Version", "2022-11-28");
    if !connection.token.trim().is_empty() {
        req = req.bearer_auth(connection.token.trim());
    }

    let resp = req.send().await.map_err(|e| format!("GitHub request failed: {}", e))?;
    let status = resp.status();

    if status.is_success() {
        let remaining = resp.json::<serde_json::Value>().await.ok()
            .and_then(|v| v.get("rate").and_then(|r| r.get("remaining")).and_then(|x| x.as_i64()));
        let message = match remaining {
            Some(n) => format!("Connected to GitHub — {} requests/hour remaining", n),
            None    => "Connected to GitHub".to_string(),
        };
        Ok(GithubTestResult { ok: true, message })
    } else if status.as_u16() == 401 {
        Ok(GithubTestResult { ok: false, message: "Invalid or missing token (401)".to_string() })
    } else {
        Ok(GithubTestResult { ok: false, message: format!("GitHub ha risposto HTTP {}", status.as_u16()) })
    }
}

#[cfg(feature = "desktop")]
#[tauri::command]
async fn github_test(connection: GithubConnection) -> Result<GithubTestResult, String> {
    github_test_impl(connection).await
}
#[cfg(test)]
mod where_tests {
  use super::*;
  fn cond(c: &str, op: &str, logic: &str) -> DbKeyCondition {
    DbKeyCondition { column: c.into(), op: op.into(), logic: logic.into() }
  }

  #[test]
  fn where_con_operatori_logica_e_funzioni() {
    let fields = vec![
      ("id".to_string(), serde_json::json!(3)),
      ("nome".to_string(), serde_json::json!("w%")),
      ("agg".to_string(), serde_json::Value::Null),
    ];
    let keys = vec!["id".to_string(), "nome".to_string(), "agg".to_string()];
    let conds = Some(vec![cond("id", ">", "AND"), cond("nome", "LIKE", "OR"), cond("agg", "IS NULL", "AND")]);
    let (sql, binds) = where_plan(&keys, &conds, &fields, &None, PlaceholderStyle::Dollar, 4, &|k: &str| k.to_string()).unwrap();
    assert_eq!(sql, "id > $4 OR nome LIKE $5 AND agg IS NULL");
    assert_eq!(binds.len(), 2);
    // funzioni: con {v} → $VALUE legato; senza → letterale; '!=' → '<>'
    let f = Some(vec![
      DbColumnFunction { column: "nome".into(), expr: "UPPER($VALUE)".into() },
      DbColumnFunction { column: "id".into(), expr: "0".into() },
    ]);
    let conds = Some(vec![cond("id", "!=", "AND"), cond("nome", "=", "AND")]);
    let (sql, binds) = where_plan(&keys[..2], &conds, &fields, &f, PlaceholderStyle::Question, 1, &|k: &str| format!("`{}`", k)).unwrap();
    assert_eq!(sql, "`id` <> 0 AND `nome` = UPPER(?)");
    assert_eq!(binds, vec![&serde_json::json!("w%")]);
    // senza condizioni: = e AND come prima
    let (sql, _) = where_plan(&keys[..2], &None, &fields, &None, PlaceholderStyle::Dollar, 1, &|k: &str| k.to_string()).unwrap();
    assert_eq!(sql, "id = $1 AND nome = $2");
    // chiave assente dalla riga, operatore sconosciuto, upsert con '>'
    assert!(where_plan(&["zz".to_string()], &None, &fields, &None, PlaceholderStyle::Dollar, 1, &|k: &str| k.to_string()).is_err());
    assert!(check_key_conditions("delete", &Some(vec![cond("id", "BETWEEN", "AND")])).is_err());
    assert!(check_key_conditions("upsert", &Some(vec![cond("id", ">", "AND")])).is_err());
    assert!(check_key_conditions("merge", &Some(vec![cond("id", "=", "OR")])).is_err());
    assert!(check_key_conditions("update", &Some(vec![cond("id", ">=", "OR")])).is_ok());
  }
}

#[cfg(test)]
mod custom_sql_tests {
  use super::*;

  #[test]
  fn segnaposto_legati_e_testo_intatto() {
    let cs = parse_custom_sql("INSERT INTO t (a, b, c) VALUES ({id}, {nome}, {id}) -- {non_un_campo}\n;").unwrap();
    assert_eq!(cs.text(PlaceholderStyle::Dollar), "INSERT INTO t (a, b, c) VALUES ($1, $2, $1) -- {non_un_campo}");
    assert_eq!(cs.text(PlaceholderStyle::Question), "INSERT INTO t (a, b, c) VALUES (?, ?, ?) -- {non_un_campo}");
    assert_eq!(cs.fields(), &["id".to_string(), "nome".to_string()]);
    let row = serde_json::json!({"id": 7, "nome": "x"});
    assert_eq!(cs.binds(&row, PlaceholderStyle::Question).unwrap().len(), 3);
    assert_eq!(cs.binds(&row, PlaceholderStyle::Dollar).unwrap().len(), 2);
    assert!(cs.binds(&serde_json::json!({"id": 1}), PlaceholderStyle::Dollar).is_err());
    // JSON letterale e identificatori tra virgolette non sono segnaposto
    let cs = parse_custom_sql(r#"UPDATE "t{x}" SET meta = '{"a": 1}' WHERE id = {id}"#).unwrap();
    assert_eq!(cs.text(PlaceholderStyle::Dollar), r#"UPDATE "t{x}" SET meta = '{"a": 1}' WHERE id = $1"#);
    // apice raddoppiato dentro la stringa
    let cs = parse_custom_sql("SELECT 'it''s {ok' , {a}").unwrap();
    assert_eq!(cs.text(PlaceholderStyle::Question), "SELECT 'it''s {ok' , ?");
    // PL/SQL: il ; finale resta
    let cs = parse_custom_sql("BEGIN p({a}); END;").unwrap();
    assert_eq!(cs.text(PlaceholderStyle::Question), "BEGIN p(?); END;");
    // errori: vuoto, segnaposto fra apici
    assert!(parse_custom_sql("  ").is_err());
    assert!(parse_custom_sql("INSERT INTO t VALUES ('{nome}')").is_err());
  }

  #[test]
  fn json_esatto_dei_lotti() {
    let d = serde_json::json!({"$fp_decimal": "12.50"});
    let rows = serde_json::json!([{"id": 1, "imp": d, "n": "a\"b"}]);
    let mut out = String::new();
    json_text_exact(&rows, &mut out);
    assert_eq!(out, r#"[{"id":1,"imp":12.50,"n":"a\"b"}]"#);
  }
}
