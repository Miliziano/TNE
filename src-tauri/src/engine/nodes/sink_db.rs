// ─── src-tauri/src/engine/nodes/sink_db.rs ─────────────────────────
//
// Riceve righe dal canale e le scrive in un DB in batch.
// Riusa la logica SQL di pg_write/mysql_write/sqlite_write da lib.rs
// tramite le funzioni già esposte come pub — non duplichiamo il SQL.
//
// La differenza rispetto a db_write (il comando Tauri esistente):
// - Riceve righe da un RowReceiver (stream della pipeline) invece
//   che da un Vec<serde_json::Value> passato dal frontend
// - Accumula righe in un buffer locale e le scrive in batch
// - Emette NodeProgress durante la scrittura

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowReceiver, NodeContext};

#[derive(serde::Deserialize)]
struct SinkDbConfig {
    // Connessione — stessa struttura di SourceDbConfig
    dialect:          String,
    host:             Option<String>,
    port:             Option<u16>,
    database:         Option<String>,
    #[serde(rename = "schemaName")]
    schema_name:      Option<String>,
    user:             Option<String>,
    password:         Option<String>,
    ssl:              Option<String>,
    #[serde(rename = "connectTimeout")]
    connect_timeout:  Option<u64>,
    // Scrittura
    table:            String,
    mode:             String,   // "insert" | "upsert" | "update" | "delete" | "truncate_insert"
    #[serde(rename = "keyFields")]
    key_fields:       Option<Vec<String>>,
    columns:          Option<Vec<String>>,
    #[serde(rename = "excludeColumns")]
    exclude_columns:  Option<Vec<String>>,
    #[serde(rename = "batchSize")]
    batch_size:       Option<usize>,
    #[serde(rename = "onConstraintError")]
    on_constraint_error: Option<String>,
    #[serde(rename = "preSql")]
    pre_sql:          Option<String>,
    #[serde(rename = "postSql")]
    post_sql:         Option<String>,
    // Monitoraggio: id della risorsa connessione (per eventi Connection*)
    #[serde(default)]
    resource_id:      Option<String>,
}

const PROGRESS_EVERY_ROWS: u64 = 1000;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx:    NodeContext,
    mut rx: RowReceiver,
) -> Result<NodeStats, String> {

    let config: SinkDbConfig = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("sink_db config non valida: {}", e))?;

    let batch_size  = config.batch_size.unwrap_or(500).max(1);
    let start       = Instant::now();
    let mut rows_in = 0u64;
    let mut written = 0u64;
    let mut errors  = 0u64;
    let mut last_prog = Instant::now();
    let mut batch: Vec<serde_json::Value> = Vec::with_capacity(batch_size);

    // Costruisce la DbWriteRequest (il formato che pg_write/mysql_write
    // si aspettano) una volta sola, poi riusa per ogni batch.
    // Le righe vengono aggiunte/sostituite a ogni batch.
    let conn_str = build_conn_str(&config)?;

    // Monitoraggio connessione (Fase 10): sessione a livello di nodo.
    let resource_id = config.resource_id.clone().unwrap_or_default();
    ctx.emit_connection_opened(&resource_id, &format!("db_{}", config.dialect));
    let mut query_count = 0u32;

    // Pre-SQL — eseguito una volta prima di iniziare a scrivere
    if let Some(pre) = &config.pre_sql {
        if !pre.trim().is_empty() {
            exec_pre_post(&conn_str, &config.dialect, pre, "Pre-SQL").await?;
        }
    }

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Converti Row Engine → serde_json::Value per riusare pg_write/mysql_write
        // che già gestiscono tutti i dialetti, mode, key_fields, ecc.
        let json_row = row.to_json_object();
        batch.push(json_row);

        if batch.len() >= batch_size {
            let result = flush_batch(
                &conn_str, &config, &batch,
            ).await?;
            written += result.0;
            errors  += result.1;
            query_count += 1;
            batch.clear();

            let should_prog = rows_in % PROGRESS_EVERY_ROWS == 0
                || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
            if should_prog {
                let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
                ctx.emit_progress(rows_in, written, 0, rps);
                last_prog = Instant::now();
            }
        }
    }

    // Flush del batch finale (righe residue non ancora scritte)
    if !batch.is_empty() {
        let result = flush_batch(&conn_str, &config, &batch).await?;
        written += result.0;
        errors  += result.1;
    }

    // Post-SQL
    if let Some(post) = &config.post_sql {
        if !post.trim().is_empty() {
            exec_pre_post(&conn_str, &config.dialect, post, "Post-SQL").await?;
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    ctx.emit_connection_closed(&resource_id, query_count, elapsed_ms);
    let stats = NodeStats { rows_in, rows_out: written, rows_rejected: errors, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Flush un batch di righe usando le funzioni esistenti di lib.rs ──

async fn flush_batch(
    conn_str: &str,
    config:   &SinkDbConfig,
    batch:    &[serde_json::Value],
) -> Result<(u64, u64), String> {

    // Costruisce DbWriteRequest — il formato che pg_write si aspetta
    let req = crate::DbWriteRequest {
        connection:          build_db_connection_params(config),
        table:               config.table.clone(),
        schema:              config.schema_name.clone(),
        mode:                config.mode.clone(),
        rows:                batch.to_vec(),
        key_fields:          config.key_fields.clone(),
        columns:             config.columns.clone(),
        exclude_columns:     config.exclude_columns.clone(),
        column_functions:    None,
        merge_condition:     None,
        pre_sql:             None,   // già eseguito una volta sopra
        post_sql:            None,
        batch_size:          batch.len(),
        on_constraint_error: config.on_constraint_error.clone().unwrap_or_else(|| "skip".to_string()),
        dead_letter_table:   None,
        returning_column:    None,
    };

    let start = Instant::now();
    let result = match config.dialect.as_str() {
        "postgresql" => crate::pg_write(conn_str, &req, start).await?,
        "mysql"      => crate::mysql_write(conn_str, &req, start).await?,
        "sqlite"     => crate::sqlite_write(conn_str, &req, start).await?,
        d            => return Err(format!("Dialetto '{}' non supportato", d)),
    };

    Ok((result.rows_written as u64, result.rows_errors as u64))
}

// ─── Helper connessione ───────────────────────────────────────────

fn build_conn_str(config: &SinkDbConfig) -> Result<String, String> {
    let host     = config.host.as_deref().unwrap_or("localhost");
    let database = config.database.as_deref().unwrap_or("");
    let user     = config.user.as_deref().unwrap_or("");
    let password = config.password.as_deref().unwrap_or("");
    let port     = config.port.unwrap_or(match config.dialect.as_str() {
        "postgresql" => 5432, "mysql" => 3306, _ => 5432,
    });

    match config.dialect.as_str() {
        "postgresql" => {
            let ssl = match config.ssl.as_deref().unwrap_or("false") {
                "true" | "require" => "require", _ => "disable",
            };
            Ok(format!("postgresql://{}:{}@{}:{}/{}?sslmode={}",
                urlencoding::encode(user), urlencoding::encode(password),
                host, port, database, ssl))
        }
        "mysql"  => Ok(format!("mysql://{}:{}@{}:{}/{}",
            urlencoding::encode(user), urlencoding::encode(password),
            host, port, database)),
        "sqlite" => Ok(format!("sqlite:{}", database)),
        d => Err(format!("Dialetto '{}' non supportato", d)),
    }
}

fn build_db_connection_params(config: &SinkDbConfig) -> crate::DbConnectionParams {
    crate::DbConnectionParams {
        dialect:         config.dialect.clone(),
        host:            config.host.clone(),
        port:            config.port,
        database:        config.database.clone(),
        user:            config.user.clone(),
        password:        config.password.clone(),
        schema:          config.schema_name.clone(),
        service_name:    None,
        db_server_name:  None,
        charset:         None,
        ssl:             config.ssl.clone(),
        connect_timeout: config.connect_timeout,
    }
}

async fn exec_pre_post(
    conn_str: &str,
    dialect:  &str,
    sql:      &str,
    label:    &str,
) -> Result<(), String> {
    let stmts: Vec<&str> = sql.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    match dialect {
        "postgresql" => {
            use sqlx::postgres::PgPoolOptions;
            let pool = PgPoolOptions::new().max_connections(1)
                .connect(conn_str).await
                .map_err(|e| format!("{} connessione: {}", label, e))?;
            for stmt in stmts {
                sqlx::query(stmt).execute(&pool).await
                    .map_err(|e| format!("{} fallito: {}", label, e))?;
            }
            pool.close().await;
        }
        "mysql" => {
            use sqlx::mysql::MySqlPoolOptions;
            let pool = MySqlPoolOptions::new().max_connections(1)
                .connect(conn_str).await
                .map_err(|e| format!("{} connessione: {}", label, e))?;
            for stmt in stmts {
                sqlx::query(stmt).execute(&pool).await
                    .map_err(|e| format!("{} fallito: {}", label, e))?;
            }
            pool.close().await;
        }
        "sqlite" => {
            use sqlx::sqlite::SqlitePoolOptions;
            let pool = SqlitePoolOptions::new().max_connections(1)
                .connect(conn_str).await
                .map_err(|e| format!("{} connessione: {}", label, e))?;
            for stmt in stmts {
                sqlx::query(stmt).execute(&pool).await
                    .map_err(|e| format!("{} fallito: {}", label, e))?;
            }
            pool.close().await;
        }
        _ => {}
    }
    Ok(())
}
