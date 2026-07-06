// ─── src-tauri/src/engine/nodes/source_db.rs ───────────────────────
//
// Legge righe da un DB (PostgreSQL, MySQL, SQLite) in streaming
// e le invia nel canale della pipeline.
//
// MIGRATO ALLA SPEC (fondazione §6.0 — contratto docs/node-spec.md §3):
// - la connessione arriva da spec.resource (risorsa di lane risolta
//   dallo studio), non più da campi selezionati a mano nel plan;
// - la query è costruita QUI dall'esecutore a partire dalle props
//   verbatim del pannello (query custom → verbatim; altrimenti
//   SELECT * FROM [querySchema.]table [ORDER BY][LIMIT][OFFSET]).
//   Chiude il bug 'schema' vs 'querySchema' (lo schema era sempre
//   'public') e attiva orderBy/offset che prima cadevano a terra;
// - fetchSize e queryTimeout restano dichiarati nel contratto ma non
//   ancora implementati (🕐): compariranno nel log delle props non
//   consumate — è il comportamento voluto.
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
use crate::engine::spec::Spec;

// Config interna del nodo, costruita dalla Spec (niente più serde
// diretto sul blob config: parse lassista con default del contratto).
struct SourceDbConfig {
    // Connessione (da spec.resource)
    dialect:         String,
    host:            String,
    port:            u16,
    database:        String,
    user:            String,
    password:        String,
    ssl:             String,
    connect_timeout: u64,
    // Query costruita (da spec.props)
    query:           String,
    // Monitoraggio (eventi Connection*)
    resource_id:     String,
}

fn default_port(dialect: &str) -> u16 {
    match dialect {
        "mysql" => 3306,
        _       => 5432,
    }
}

fn config_from_spec(spec: &Spec) -> Result<SourceDbConfig, String> {
    if !spec.has_resource() {
        return Err("nessuna risorsa DB collegata (selezionare una \
                    connessione nel pannello del nodo)".to_string());
    }

    let dialect = spec.res_str_or("dialect", "postgresql");
    let port    = spec.res_u16_or("port", default_port(&dialect));
    // Le risorse storiche usano 'user' oppure 'username'
    let user = {
        let u = spec.res_str_or("user", "");
        if u.is_empty() { spec.res_str_or("username", "") } else { u }
    };

    // ── Query (contratto §3): custom verbatim se presente,
    //    altrimenti costruita dall'esecutore ──────────────────────
    let custom = spec.str_or("query", "");
    let query = if !custom.is_empty() {
        custom
    } else {
        let table = spec.str_req("table")
            .map_err(|_| "specificare una tabella o una query SQL".to_string())?;
        let schema = spec.str_or("querySchema", "public");
        let qualified = if !schema.is_empty() && schema != "public" {
            format!("{}.{}", schema, table)
        } else {
            table
        };
        let mut q = format!("SELECT * FROM {}", qualified);
        let order_by = spec.str_or("orderBy", "");
        if !order_by.is_empty() {
            q.push_str(&format!(" ORDER BY {}", order_by));
        }
        let limit = spec.u64_or("limit", 0);
        if limit > 0 {
            q.push_str(&format!(" LIMIT {}", limit));
        }
        let offset = spec.u64_or("offset", 0);
        if offset > 0 {
            q.push_str(&format!(" OFFSET {}", offset));
        }
        q
    };

    Ok(SourceDbConfig {
        host:            spec.res_str_or("host", "localhost"),
        database:        spec.res_str_or("database", ""),
        password:        spec.res_str_or("password", ""),
        ssl:             spec.res_str_or("ssl", "false"),
        connect_timeout: spec.res_u64_or("connectTimeout", 30),
        resource_id:     spec.resource_id(),
        dialect,
        port,
        user,
        query,
    })
}

impl SourceDbConfig {
    fn connection_string(&self) -> Result<String, String> {
        match self.dialect.as_str() {
            "postgresql" => {
                let ssl_mode = match self.ssl.as_str() {
                    "true" | "require" => "require",
                    _                  => "disable",
                };
                Ok(format!(
                    "postgresql://{}:{}@{}:{}/{}?sslmode={}",
                    urlencoding::encode(&self.user),
                    urlencoding::encode(&self.password),
                    self.host, self.port, self.database, ssl_mode
                ))
            }
            "mysql" => Ok(format!(
                "mysql://{}:{}@{}:{}/{}",
                urlencoding::encode(&self.user),
                urlencoding::encode(&self.password),
                self.host, self.port, self.database
            )),
            "sqlite" => Ok(format!("sqlite:{}", self.database)),
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

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_db {}: {}", ctx.node_id.0, e))?;
    let config = config_from_spec(&spec)
        .map_err(|e| format!("source_db {}: {}", ctx.node_id.0, e))?;

    let tx = match tx {
        Some(t) => t,
        None    => return Ok(NodeStats::default()),
    };

    let conn_str = config.connection_string()?;
    let timeout  = config.connect_timeout;
    let dialect  = config.dialect.clone();
    let query    = config.query.clone();

    let start         = Instant::now();
    let mut rows_out  = 0u64;
    let mut last_prog = Instant::now();

    eprintln!("[source_db] node={} query={}", ctx.node_id.0, query);
    // Telemetria dei drop: props configurate nei pannelli ma non
    // ancora implementate qui (es. fetchSize, queryTimeout).
    spec.log_unconsumed("source_db", &ctx.node_id.0);

    let resource_id = config.resource_id.clone();
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
        // float4/float8 sono binari nativi → Float
        if type_name == "float4" || type_name == "float8" {
            if let Ok(v) = row.try_get::<f64, _>(idx) { return Value::Float(v) }
        }
        // NUMERIC/DECIMAL: esatto, mai via f64 (regge Oracle NUMBER,
        // Informix DECIMAL in futuro). Con feature rust_decimal sqlx
        // li mappa su Decimal — era la causa dei Null su rental_rate.
        if let Ok(v) = row.try_get::<rust_decimal::Decimal, _>(idx) {
            return Value::Decimal(v)
        }
        // Fallback: alcuni driver danno comunque f64
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


    // tsvector / altri tipi testuali interni: prova come stringa,
    // ma NON cadere sui byte grezzi (che sarebbero binari corrotti).
    if type_name == "tsvector" {
        if let Ok(v) = row.try_get::<String, _>(idx) { return Value::String(v) }
        return Value::Null;
    }
    // Array PostgreSQL. sqlx nomina il tipo array con le parentesi
    // quadre ("text[]", "integer[]", …), non con l'underscore del
    // catalogo pg. Confronto su type_name già in lowercase.
    if type_name.ends_with("[]") {
        let inner = type_name.trim_end_matches("[]");
        if ["text","varchar","character varying","bpchar","char","name"].contains(&inner) {
            match row.try_get::<Vec<Option<String>>, _>(idx) {
                Ok(v)  => return Value::from_json(serde_json::json!(v)),
                Err(e) => eprintln!("[pg_array] col idx={} type='{}' fallita Vec<Option<String>>: {}", idx, type_name, e),
            }
        }
        match inner {
            "text" | "varchar" | "character varying" | "bpchar" | "char" | "name" => {
                if let Ok(v) = row.try_get::<Vec<String>, _>(idx) {
                    return Value::from_json(serde_json::json!(v));
                }
                if let Ok(v) = row.try_get::<Vec<Option<String>>, _>(idx) {
                    return Value::from_json(serde_json::json!(v));
                }
            }
            "int2" | "smallint" | "int4" | "integer" | "int8" | "bigint" => {
                if let Ok(v) = row.try_get::<Vec<i64>, _>(idx) {
                    return Value::from_json(serde_json::json!(v));
                }
                if let Ok(v) = row.try_get::<Vec<i32>, _>(idx) {
                    return Value::from_json(serde_json::json!(v));
                }
                if let Ok(v) = row.try_get::<Vec<i16>, _>(idx) {
                    return Value::from_json(serde_json::json!(v));
                }
            }
            "float4" | "real" | "float8" | "double precision" => {
                if let Ok(v) = row.try_get::<Vec<f64>, _>(idx) {
                    return Value::from_json(serde_json::json!(v));
                }
            }
            "bool" | "boolean" => {
                if let Ok(v) = row.try_get::<Vec<bool>, _>(idx) {
                    return Value::from_json(serde_json::json!(v));
                }
            }
            _ => {}
        }
    }
    // Fallback per tipi personalizzati (enum PostgreSQL, domini, ecc.)
    // sqlx non riesce a decodificare tipi enum personalizzati nei tipi Rust nativi.
    // Usiamo try_get_raw per accedere ai bytes grezzi e decodificarli come UTF-8.
    if let Ok(raw) = row.try_get_raw(idx) {
        use sqlx::ValueRef;
        if !raw.is_null() {
            if let Ok(bytes) = raw.as_bytes() {
                if let Ok(s) = std::str::from_utf8(bytes) {
                    // Se contiene NUL, è quasi certamente un tipo binario
                    // (array/tsvector/ecc.) mal interpretato: non è testo.
                    if !s.contains('\u{0}') {
                        return Value::String(s.to_string());
                    }
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