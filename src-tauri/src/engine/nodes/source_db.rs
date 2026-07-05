// ─── src-tauri/src/engine/nodes/source_db.rs ───────────────────────
//
// Legge righe da un DB (PostgreSQL, MySQL, SQLite) in streaming
// e le invia nel canale della pipeline.
//
// Riusa la logica di connessione e conversione tipi già presente
// in db_stream.rs e lib.rs — non duplichiamo la logica SQL,
// duplichiamo solo il punto di arrivo delle righe (canale invece
// di app.emit).
//
// CONCETTI RUST NUOVI:
//
// 1. `use futures::StreamExt` — importa il trait che aggiunge
//    `.next().await` agli stream sqlx. Senza questo import,
//    lo stream non avrebbe il metodo next() disponibile.
//    I trait in Rust sono "opt-in": devi importarli esplicitamente
//    per usare i loro metodi — il compilatore ti dice esattamente
//    quale trait importare se dimentichi.
//
// 2. `while let Some(result) = stream.next().await` — lo stesso
//    pattern di source_file ma su uno stream asincrono DB invece
//    che su un canale. Quando il DB non ha più righe, next() 
//    restituisce None e il loop termina naturalmente.

use std::time::Instant;
use futures::StreamExt;
use sqlx::Column;
use sqlx::TypeInfo;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, NodeContext};

// Config del nodo source_db — deserializzata da node.config
// Rispecchia DbConnectionParams già in lib.rs ma semplificata
// per l'Engine (i campi non usati vengono ignorati da serde).
#[derive(serde::Deserialize)]
struct SourceDbConfig {
    // Connessione
    dialect:          String,
    host:             Option<String>,
    port:             Option<u16>,
    database:         Option<String>,
    user:             Option<String>,
    password:         Option<String>,
    schema:           Option<String>,
    ssl:              Option<String>,
    #[serde(rename = "connectTimeout")]
    connect_timeout:  Option<u64>,
    // Query
    query:            String,
    timeout:          Option<u64>,
    // Monitoraggio: id della risorsa connessione (per eventi Connection*)
    #[serde(default)]
    resource_id:      Option<String>,
}

impl SourceDbConfig {
    fn connection_string(&self) -> Result<String, String> {
        let host     = self.host.as_deref().unwrap_or("localhost");
        let database = self.database.as_deref().unwrap_or("");
        let user     = self.user.as_deref().unwrap_or("");
        let password = self.password.as_deref().unwrap_or("");
        let port     = self.port.unwrap_or(match self.dialect.as_str() {
            "postgresql" => 5432,
            "mysql"      => 3306,
            _            => 5432,
        });

        match self.dialect.as_str() {
            "postgresql" => {
                let ssl_mode = match self.ssl.as_deref().unwrap_or("false") {
                    "true" | "require" => "require",
                    _                  => "disable",
                };
                Ok(format!(
                    "postgresql://{}:{}@{}:{}/{}?sslmode={}",
                    urlencoding::encode(user),
                    urlencoding::encode(password),
                    host, port, database, ssl_mode
                ))
            }
            "mysql" => Ok(format!(
                "mysql://{}:{}@{}:{}/{}",
                urlencoding::encode(user),
                urlencoding::encode(password),
                host, port, database
            )),
            "sqlite" => Ok(format!("sqlite:{}", database)),
            d => Err(format!("Dialetto '{}' non supportato", d)),
        }
    }
}

const PROGRESS_EVERY_ROWS: u64 = 1000;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx: NodeContext,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let config: SourceDbConfig = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("source_db config non valida: {}", e))?;

    let tx = match tx {
        Some(t) => t,
        None    => return Ok(NodeStats::default()),
    };

    let conn_str = config.connection_string()?;
    let timeout  = config.connect_timeout.unwrap_or(30);
    let dialect  = config.dialect.clone();
    let query    = config.query.clone();

    let start         = Instant::now();
    let mut rows_out  = 0u64;
    let mut last_prog = Instant::now();


    eprintln!("[source_db] node={} query={}", ctx.node_id.0,
    ctx.config.get("query").and_then(|v| v.as_str()).unwrap_or("NESSUNA"));
    
    let resource_id = config.resource_id.clone().unwrap_or_default();
    let conn_type   = format!("db_{}", dialect);
    ctx.emit_connection_opened(&resource_id, &conn_type);

    let result = match dialect.as_str() {
        "postgresql" => {
            run_pg(ctx.clone(), tx, &conn_str, &query, timeout,
                   &mut rows_out, &start, &mut last_prog).await
        }
        "mysql" => {
            run_mysql(ctx.clone(), tx, &conn_str, &query, timeout,
                      &mut rows_out, &start, &mut last_prog).await
        }
        "sqlite" => {
            run_sqlite(ctx.clone(), tx, &conn_str, &query, timeout,
                       &mut rows_out, &start, &mut last_prog).await
        }
        d => Err(format!("Dialetto '{}' non supportato", d)),
    };

    match &result {
        Ok(())  => ctx.emit_connection_closed(&resource_id, 1, start.elapsed().as_millis() as u64),
        Err(e)  => ctx.emit_connection_error(&resource_id, e.clone()),
    }
    result?;

    Ok(NodeStats {
        rows_in:       0,
        rows_out,
        rows_rejected: 0,
        elapsed_ms:    start.elapsed().as_millis() as u64,
        error:         None,
    })
}

// ─── Helper: converte una riga sqlx in Row Engine ─────────────────
// Riuso della logica pg_value_to_json da lib.rs, ma produce
// Value Engine invece di serde_json::Value — così il resto della
// pipeline lavora con tipi nativi, non con JSON intermedio.

fn pg_col_to_value(row: &sqlx::postgres::PgRow, idx: usize) -> Value {
    use sqlx::Row as SqlxRow;
    let col      = &row.columns()[idx];
    let type_name = col.type_info().name().to_lowercase();

    if ["int2","int4","int8","serial","bigserial"].contains(&type_name.as_str()) {
        if let Ok(v) = row.try_get::<i64, _>(idx) { return Value::Int(v) }
        if let Ok(v) = row.try_get::<i32, _>(idx) { return Value::Int(v as i64) }
        if let Ok(v) = row.try_get::<i16, _>(idx) { return Value::Int(v as i64) }
    }
    if ["float4","float8","numeric","decimal"].contains(&type_name.as_str()) {
        if let Ok(v) = row.try_get::<f64, _>(idx) { return Value::Float(v) }
    }
    if type_name == "bool" {
        if let Ok(v) = row.try_get::<bool, _>(idx) { return Value::Bool(v) }
    }
    if ["json","jsonb"].contains(&type_name.as_str()) {
        if let Ok(v) = row.try_get::<serde_json::Value, _>(idx) { return Value::Object(v) }
    }
    if type_name.starts_with("timestamp") {
        if let Ok(v) = row.try_get::<chrono::NaiveDateTime, _>(idx) {
            return Value::DateTime(v.to_string())
        }
    }
    if type_name == "date" {
        if let Ok(v) = row.try_get::<chrono::NaiveDate, _>(idx) {
            return Value::Date(v.to_string())
        }
    }
    if let Ok(v) = row.try_get::<String, _>(idx) { return Value::String(v) }
    // Fallback per tipi personalizzati (enum PostgreSQL, domini, ecc.)
    // sqlx non riesce a decodificare tipi enum personalizzati nei tipi Rust nativi.
    // Usiamo try_get_raw per accedere ai bytes grezzi e decodificarli come UTF-8.
    if let Ok(raw) = row.try_get_raw(idx) {
        use sqlx::ValueRef;
        if !raw.is_null() {
            // I valori enum PostgreSQL sono trasportati come stringhe UTF-8 nel protocollo wire
            if let Ok(bytes) = raw.as_bytes() {
                if let Ok(s) = std::str::from_utf8(bytes) {
                    return Value::String(s.to_string());
                }
            }
        }
    }
    Value::Null
}

// ─── PostgreSQL ───────────────────────────────────────────────────

async fn run_pg(
    ctx:       NodeContext,
    tx:        RowSender,
    conn_str:  &str,
    query:     &str,
    timeout:   u64,
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::postgres::PgPoolOptions;
    use sqlx::Row as SqlxRow;
    use sqlx::Column;

    let pool = PgPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(timeout))
        .connect(conn_str).await
        .map_err(|e| format!("PostgreSQL connessione fallita: {}", e))?;

    let mut stream = sqlx::query(query).fetch(&pool);

    while let Some(row_result) = stream.next().await {
        let row = row_result
            .map_err(|e| format!("PostgreSQL errore riga {}: {}", *rows_out + 1, e))?;

        let mut engine_row = Row::new();
        for (i, col) in row.columns().iter().enumerate() {
            engine_row.set(col.name().to_string(), pg_col_to_value(&row, i));
        }

        *rows_out += 1;

        if tx.send(engine_row).await.is_err() { break; }

        maybe_emit_progress(&ctx, *rows_out, start, last_prog);
    }

    pool.close().await;
    let stats = NodeStats {
        rows_in: 0, rows_out: *rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats);
    Ok(())
}

// ─── MySQL ────────────────────────────────────────────────────────

async fn run_mysql(
    ctx:       NodeContext,
    tx:        RowSender,
    conn_str:  &str,
    query:     &str,
    timeout:   u64,
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::mysql::MySqlPoolOptions;
    use sqlx::Row as SqlxRow;

    let pool = MySqlPoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(timeout))
        .connect(conn_str).await
        .map_err(|e| format!("MySQL connessione fallita: {}", e))?;

    let mut stream = sqlx::query(query).fetch(&pool);

    while let Some(row_result) = stream.next().await {
        let row = row_result
            .map_err(|e| format!("MySQL errore riga {}: {}", *rows_out + 1, e))?;

        let mut engine_row = Row::new();
        for col in row.columns() {
            // MySQL: serde_json è il modo più sicuro per tipi misti
            let val: serde_json::Value = row.try_get(col.name())
                .unwrap_or(serde_json::Value::Null);
            engine_row.set(col.name().to_string(), Value::from_json(val));
        }

        *rows_out += 1;
        if tx.send(engine_row).await.is_err() { break; }
        maybe_emit_progress(&ctx, *rows_out, start, last_prog);
    }

    pool.close().await;
    let stats = NodeStats {
        rows_in: 0, rows_out: *rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats);
    Ok(())
}

// ─── SQLite ───────────────────────────────────────────────────────

async fn run_sqlite(
    ctx:       NodeContext,
    tx:        RowSender,
    conn_str:  &str,
    query:     &str,
    timeout:   u64,
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::sqlite::SqlitePoolOptions;
    use sqlx::Row as SqlxRow;

    let pool = SqlitePoolOptions::new()
        .max_connections(1)
        .acquire_timeout(std::time::Duration::from_secs(timeout))
        .connect(conn_str).await
        .map_err(|e| format!("SQLite connessione fallita: {}", e))?;

    let mut stream = sqlx::query(query).fetch(&pool);

    while let Some(row_result) = stream.next().await {
        let row = row_result
            .map_err(|e| format!("SQLite errore riga {}: {}", *rows_out + 1, e))?;

        let mut engine_row = Row::new();
        for col in row.columns() {
            let val = if let Ok(v) = row.try_get::<i64,    _>(col.name()) { Value::Int(v) }
                else if let Ok(v) = row.try_get::<f64,    _>(col.name()) { Value::Float(v) }
                else if let Ok(v) = row.try_get::<bool,   _>(col.name()) { Value::Bool(v) }
                else if let Ok(v) = row.try_get::<String, _>(col.name()) { Value::String(v) }
                else { Value::Null };
            engine_row.set(col.name().to_string(), val);
        }

        *rows_out += 1;
        if tx.send(engine_row).await.is_err() { break; }
        maybe_emit_progress(&ctx, *rows_out, start, last_prog);
    }

    pool.close().await;
    let stats = NodeStats {
        rows_in: 0, rows_out: *rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats);
    Ok(())
}

// ─── Helper progress ──────────────────────────────────────────────

fn maybe_emit_progress(
    ctx:       &NodeContext,
    rows_out:  u64,
    start:     &Instant,
    last_prog: &mut Instant,
) {
    let should = rows_out % PROGRESS_EVERY_ROWS == 0
        || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
    if should {
        let rps = rows_out as f64 / start.elapsed().as_secs_f64().max(0.001);
        ctx.emit_progress(rows_out, rows_out, 0, rps);
        *last_prog = Instant::now();
    }
}