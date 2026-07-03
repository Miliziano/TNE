/**
 * src-tauri/src/db_stream.rs
 *
 * Streaming query DB: legge le righe dal DB con sqlx::fetch() (non fetch_all)
 * ed emette ogni riga come evento Tauri invece di accumularle in memoria.
 *
 * Evento emesso per ogni riga:
 *   nome:    "db_stream_row_{stream_id}"
 *   payload: serde_json::Value (oggetto con i campi della riga)
 *
 * Evento emesso al termine (ok o errore):
 *   nome:    "db_stream_done_{stream_id}"
 *   payload: DbStreamDone { rows_read, error? }
 *
 * Il chiamante JS:
 *   1. Genera un stream_id univoco
 *   2. Registra i listener PRIMA di chiamare invoke('db_query_stream', ...)
 *   3. invoke ritorna immediatamente (fire-and-forget asincrono)
 *   4. Raccoglie le righe via listener finché non arriva db_stream_done
 *   5. Rimuove i listener
 *
 * Perché stream_id e non node_id?
 * Un nodo può essere eseguito più volte (retry, sequencer) — lo stream_id
 * garantisce che listener di run diversi non si sovrappongano.
 */

use futures::StreamExt;
use serde::{Deserialize, Serialize};
use sqlx::Column;
use sqlx::Row as SqlxRow;
use sqlx::TypeInfo;
use tauri::Emitter;

use crate::DbConnectionParams;
use crate::build_connection_string;
use crate::pg_value_to_json;

// ─── Tipi ─────────────────────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct DbStreamRequest {
    pub connection: DbConnectionParams,
    pub query:      String,
    pub stream_id:  String,
    pub timeout:    Option<u64>,
}

#[derive(Debug, Serialize, Clone)]
pub struct DbStreamDone {
    pub rows_read: u64,
    pub error:     Option<String>,
}

// ─── Comando Tauri ─────────────────────────────────────────────────
//
// Tauri comandi async spawna su un thread Tokio — non blocca il frontend.
// Usiamo tauri::async_runtime::spawn per non tenere il comando "in attesa":
// il comando ritorna subito Ok(()), lo streaming avviene in background.

#[tauri::command]
pub async fn db_query_stream(
    app:     tauri::AppHandle,
    request: DbStreamRequest,
) -> Result<(), String> {
    // Lancia lo streaming in background — il comando ritorna subito
    tauri::async_runtime::spawn(async move {
        let result = stream_query(app.clone(), &request).await;
        if let Err(e) = result {
            let done = DbStreamDone { rows_read: 0, error: Some(e) };
            let _ = app.emit(&format!("db_stream_done_{}", request.stream_id), done);
        }
    });
    Ok(())
}

// ─── Streaming interno ─────────────────────────────────────────────

async fn stream_query(
    app:     tauri::AppHandle,
    request: &DbStreamRequest,
) -> Result<(), String> {
    let conn_str = build_connection_string(&request.connection)?;
    let timeout  = request.timeout.unwrap_or(60);

    match request.connection.dialect.as_str() {
        "postgresql" => stream_pg(app, &conn_str, &request.query, &request.stream_id, timeout).await,
        "mysql"      => stream_mysql(app, &conn_str, &request.query, &request.stream_id, timeout).await,
        "sqlite"     => stream_sqlite(app, &conn_str, &request.query, &request.stream_id, timeout).await,
        d            => Err(format!("Dialetto '{}' non supportato per streaming", d)),
    }
}

// ─── PostgreSQL streaming ──────────────────────────────────────────

async fn stream_pg(
    app:       tauri::AppHandle,
    conn_str:  &str,
    query:     &str,
    stream_id: &str,
    timeout:   u64,
) -> Result<(), String> {
    use sqlx::postgres::PgPoolOptions;

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(timeout))
        .connect(conn_str).await
        .map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;

    let mut stream = sqlx::query(query).fetch(&pool);
    let mut rows_read: u64 = 0;

    while let Some(row_result) = stream.next().await {
        match row_result {
            Ok(row) => {
                let mut obj = serde_json::Map::new();
                for (i, col) in row.columns().iter().enumerate() {
                    obj.insert(col.name().to_string(), pg_value_to_json(&row, i));
                }
                let payload = serde_json::Value::Object(obj);

                // Emetti la riga — se il frontend ha già chiuso il listener
                // (abort) ignoriamo l'errore di emit silenziosamente
                let _ = app.emit(&format!("db_stream_row_{}", stream_id), payload);
                rows_read += 1;
            }
            Err(e) => {
                pool.close().await;
                let done = DbStreamDone {
                    rows_read,
                    error: Some(format!("PostgreSQL errore riga {}: {}", rows_read + 1, e)),
                };
                let _ = app.emit(&format!("db_stream_done_{}", stream_id), done);
                return Ok(());
            }
        }
    }

    pool.close().await;
    let done = DbStreamDone { rows_read, error: None };
    let _ = app.emit(&format!("db_stream_done_{}", stream_id), done);
    Ok(())
}

// ─── MySQL streaming ───────────────────────────────────────────────

async fn stream_mysql(
    app:       tauri::AppHandle,
    conn_str:  &str,
    query:     &str,
    stream_id: &str,
    timeout:   u64,
) -> Result<(), String> {
    use sqlx::mysql::MySqlPoolOptions;

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(timeout))
        .connect(conn_str).await
        .map_err(|e| format!("MySQL connessione fallita: {}", e))?;

    let mut stream = sqlx::query(query).fetch(&pool);
    let mut rows_read: u64 = 0;

    while let Some(row_result) = stream.next().await {
        match row_result {
            Ok(row) => {
                let mut obj = serde_json::Map::new();
                for col in row.columns() {
                    let val: serde_json::Value = row
                        .try_get(col.name())
                        .unwrap_or(serde_json::Value::Null);
                    obj.insert(col.name().to_string(), val);
                }
                let payload = serde_json::Value::Object(obj);
                let _ = app.emit(&format!("db_stream_row_{}", stream_id), payload);
                rows_read += 1;
            }
            Err(e) => {
                pool.close().await;
                let done = DbStreamDone {
                    rows_read,
                    error: Some(format!("MySQL errore riga {}: {}", rows_read + 1, e)),
                };
                let _ = app.emit(&format!("db_stream_done_{}", stream_id), done);
                return Ok(());
            }
        }
    }

    pool.close().await;
    let done = DbStreamDone { rows_read, error: None };
    let _ = app.emit(&format!("db_stream_done_{}", stream_id), done);
    Ok(())
}

// ─── SQLite streaming ──────────────────────────────────────────────

async fn stream_sqlite(
    app:       tauri::AppHandle,
    conn_str:  &str,
    query:     &str,
    stream_id: &str,
    timeout:   u64,
) -> Result<(), String> {
    use sqlx::sqlite::SqlitePoolOptions;

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(timeout))
        .connect(conn_str).await
        .map_err(|e| format!("SQLite connessione fallita: {}", e))?;

    let mut stream = sqlx::query(query).fetch(&pool);
    let mut rows_read: u64 = 0;

    while let Some(row_result) = stream.next().await {
        match row_result {
            Ok(row) => {
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
                let payload = serde_json::Value::Object(obj);
                let _ = app.emit(&format!("db_stream_row_{}", stream_id), payload);
                rows_read += 1;
            }
            Err(e) => {
                pool.close().await;
                let done = DbStreamDone {
                    rows_read,
                    error: Some(format!("SQLite errore riga {}: {}", rows_read + 1, e)),
                };
                let _ = app.emit(&format!("db_stream_done_{}", stream_id), done);
                return Ok(());
            }
        }
    }

    pool.close().await;
    let done = DbStreamDone { rows_read, error: None };
    let _ = app.emit(&format!("db_stream_done_{}", stream_id), done);
    Ok(())
}
