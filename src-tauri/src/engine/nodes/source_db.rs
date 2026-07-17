// ─── src-tauri/src/engine/nodes/source_db.rs ───────────────────────
//
// Legge righe da un DB (PostgreSQL, MySQL, SQLite) in streaming
// e le invia nel canale della pipeline.
//
// MIGRATO ALLA SPEC (fondazione §6.0 — contratto docs/node-spec.md §3):
// - la connessione arriva da spec.resource (risorsa di lane risolta
//   dallo studio); la query è costruita QUI dall'esecutore.
//
// MIGRATO AL POOL CONDIVISO (design L1):
// - il nodo NON apre più un pool proprio: chiede
//   ctx.lane_resources.pool(resource_id, ...). Nodi diversi della
//   stessa lane sulla stessa risorsa RIUSANO la stessa connessione.
// - NESSUN pool.close() qui: il pool è di proprietà della lane, che lo
//   chiude in close_all() a fine esecuzione (invariante 2). Chiudere il
//   pool qui lo toglierebbe da sotto i piedi agli altri nodi.
//
// CONVERSIONE TIPI (docs/node-spec.md §3): numeric/decimal → Decimal
// esatto; array PG (text[], int[]...) → array JSON; tsvector → null.

use std::time::Instant;
use futures::StreamExt;
use sqlx::Column;
use sqlx::TypeInfo;
use sqlx::postgres::PgPool;
use sqlx::mysql::MySqlPool;
use sqlx::sqlite::SqlitePool;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, NodeContext, RowReceiver};
use crate::engine::spec::Spec;
use crate::engine::pool::{DbPool, PoolParams};

struct SourceDbConfig {
    dialect:         String,
    host:            String,
    port:            u16,
    database:        String,
    user:            String,
    password:        String,
    ssl:             String,
    connect_timeout: u64,
    query:           String,
    resource_id:     String,
}

fn default_port(dialect: &str) -> u16 {
    match dialect { "mysql" => 3306, _ => 5432 }
}

fn config_from_spec(spec: &Spec) -> Result<SourceDbConfig, String> {
    if !spec.has_resource() {
        return Err("nessuna risorsa DB collegata (selezionare una \
                    connessione nel pannello del nodo)".to_string());
    }

    let dialect = spec.res_str_or("dialect", "postgresql");
    let port    = spec.res_u16_or("port", default_port(&dialect));
    let user = {
        let u = spec.res_str_or("user", "");
        if u.is_empty() { spec.res_str_or("username", "") } else { u }
    };

    // Query: custom verbatim se presente, altrimenti costruita.
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
        if !order_by.is_empty() { q.push_str(&format!(" ORDER BY {}", order_by)); }
        let limit = spec.u64_or("limit", 0);
        if limit > 0 { q.push_str(&format!(" LIMIT {}", limit)); }
        let offset = spec.u64_or("offset", 0);
        if offset > 0 { q.push_str(&format!(" OFFSET {}", offset)); }
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

fn connection_string(c: &SourceDbConfig) -> Result<String, String> {
    match c.dialect.as_str() {
        "postgresql" => {
            let ssl_mode = match c.ssl.as_str() {
                "true" | "require" => "require",
                _                  => "disable",
            };
            Ok(format!(
                "postgresql://{}:{}@{}:{}/{}?sslmode={}",
                urlencoding::encode(&c.user), urlencoding::encode(&c.password),
                c.host, c.port, c.database, ssl_mode
            ))
        }
        "mysql" => Ok(format!(
            "mysql://{}:{}@{}:{}/{}",
            urlencoding::encode(&c.user), urlencoding::encode(&c.password),
            c.host, c.port, c.database
        )),
        "sqlite" => Ok(format!("sqlite:{}", c.database)),
        d => Err(format!("Dialetto '{}' non supportato", d)),
    }
}

const PROGRESS_EVERY_ROWS: u64 = 1000;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx: NodeContext,
    // R8 — "barriera + parametri". Opzionale: se il nodo non ha archi in
    // ingresso non c'è niente da aspettare. Se ce l'ha, si drena fino alla
    // chiusura del canale — che È l'attesa (R7) — e si tiene la riga di
    // parametri. Prima questo receiver non veniva MAI preso: il canale si
    // chiudeva, le send a monte fallivano e `let _ =` le ingoiava, quindi
    // le righe sparivano in silenzio. V. nodes/source_input.rs.
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    // Aspetta chi sta a monte, se c'è. Da qui in poi il nodo a monte ha
    // finito: è la garanzia di ordine che l'arco porta anche quando non
    // porta dati.
    let _params = super::source_input::await_params(
        &ctx.node_id.0, "source_db", rx,
    ).await?;
    // ⚠️ `_params` non è ancora usato: il BINDING dei parametri nella query
    // aspetta una decisione aperta — con quale sintassi la query cita un
    // campo in arrivo (contratto-porte.md §10). Va fatto con `.bind()`
    // tipizzato di sqlx, MAI per interpolazione di stringa: aprirebbe la
    // SQL injection sul valore calcolato a monte e violerebbe "Decimal mai
    // via f64". Fino ad allora il comportamento è quello di window.rs caso
    // 1: l'ingresso è un INNESCO, la riga si scarta.

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_db {}: {}", ctx.node_id.0, e))?;
    let config = config_from_spec(&spec)
        .map_err(|e| format!("source_db {}: {}", ctx.node_id.0, e))?;

    let tx = match tx {
        Some(t) => t,
        None    => return Ok(NodeStats::default()),
    };

    let conn_str = connection_string(&config)?;
    let query    = config.query.clone();
    let dialect  = config.dialect.clone();

    let start         = Instant::now();
    let mut rows_out  = 0u64;
    let mut last_prog = Instant::now();

    eprintln!("[source_db] node={} query={}", ctx.node_id.0, query);
    spec.log_unconsumed("source_db", &ctx.node_id.0);

    // Pool condiviso della lane (L1). Il source usa 1 connessione
    // (lettura in streaming da un unico cursore).
    let pool = ctx.lane_resources.pool(
        &config.resource_id,
        PoolParams {
            dialect:         dialect.clone(),
            conn_str,
            max_connections: 5,
            connect_timeout: config.connect_timeout,
        },
    ).await
        .map_err(|e| format!("source_db {}: {}", ctx.node_id.0, e))?;

    let resource_id = config.resource_id.clone();
    ctx.emit_connection_opened(&resource_id, &format!("db_{}", dialect));

    let result = match &pool {
        DbPool::Pg(p)     => run_pg(ctx.clone(), tx, p, &query, &mut rows_out, &start, &mut last_prog).await,
        DbPool::My(p)     => run_mysql(ctx.clone(), tx, p, &query, &mut rows_out, &start, &mut last_prog).await,
        DbPool::Sqlite(p) => run_sqlite(ctx.clone(), tx, p, &query, &mut rows_out, &start, &mut last_prog).await,
    };

    // NB: nessun pool.close() — il pool è della lane (close_all()).
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

// ─── Conversione colonna PostgreSQL → Value ───────────────────────

fn pg_col_to_value(row: &sqlx::postgres::PgRow, idx: usize) -> Value {
    use sqlx::Row as SqlxRow;
    let col       = &row.columns()[idx];
    let type_name = col.type_info().name().to_lowercase();

    if ["int2","int4","int8","serial","bigserial"].contains(&type_name.as_str()) {
        if let Ok(v) = row.try_get::<i64, _>(idx) { return Value::Int(v) }
        if let Ok(v) = row.try_get::<i32, _>(idx) { return Value::Int(v as i64) }
        if let Ok(v) = row.try_get::<i16, _>(idx) { return Value::Int(v as i64) }
    }
    if ["float4","float8"].contains(&type_name.as_str()) {
        if let Ok(v) = row.try_get::<f64, _>(idx) { return Value::Float(v) }
    }
    // NUMERIC/DECIMAL: esatto via Decimal (mai f64). Regge Oracle NUMBER,
    // Informix DECIMAL in futuro.
    if ["numeric","decimal"].contains(&type_name.as_str()) {
        if let Ok(v) = row.try_get::<rust_decimal::Decimal, _>(idx) { return Value::Decimal(v) }
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
    // Array PostgreSQL: sqlx nomina il tipo "…[]" (non "_…").
    if type_name.ends_with("[]") {
        let inner = type_name.trim_end_matches("[]");
        match inner {
            "text" | "varchar" | "character varying" | "bpchar" | "char" | "name" => {
                if let Ok(v) = row.try_get::<Vec<Option<String>>, _>(idx) {
                    return Value::from_json(serde_json::json!(v));
                }
            }
            "int2" | "smallint" | "int4" | "integer" | "int8" | "bigint" => {
                if let Ok(v) = row.try_get::<Vec<i64>, _>(idx) { return Value::from_json(serde_json::json!(v)); }
                if let Ok(v) = row.try_get::<Vec<i32>, _>(idx) { return Value::from_json(serde_json::json!(v)); }
            }
            "float4" | "real" | "float8" | "double precision" => {
                if let Ok(v) = row.try_get::<Vec<f64>, _>(idx) { return Value::from_json(serde_json::json!(v)); }
            }
            "bool" | "boolean" => {
                if let Ok(v) = row.try_get::<Vec<bool>, _>(idx) { return Value::from_json(serde_json::json!(v)); }
            }
            _ => {}
        }
    }
    // tsvector: rappresentazione binaria interna, non testo utile → Null.
    if type_name == "tsvector" {
        if let Ok(v) = row.try_get::<String, _>(idx) { return Value::String(v) }
        return Value::Null;
    }
    // Testo e tipi stringa
    if let Ok(v) = row.try_get::<String, _>(idx) { return Value::String(v) }
    // Fallback per tipi personalizzati (enum, domini): bytes come UTF-8,
    // ma scartati se contengono NUL (binario mal interpretato).
    if let Ok(raw) = row.try_get_raw(idx) {
        use sqlx::ValueRef;
        if !raw.is_null() {
            if let Ok(bytes) = raw.as_bytes() {
                if let Ok(s) = std::str::from_utf8(bytes) {
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
    pool:      &PgPool,
    query:     &str,
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::Row as SqlxRow;

    let mut stream = sqlx::query(query).fetch(pool);

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
    pool:      &MySqlPool,
    query:     &str,
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::Row as SqlxRow;

    let mut stream = sqlx::query(query).fetch(pool);

    while let Some(row_result) = stream.next().await {
        let row = row_result
            .map_err(|e| format!("MySQL errore riga {}: {}", *rows_out + 1, e))?;

        let mut engine_row = Row::new();
        for col in row.columns() {
            let val: serde_json::Value = row.try_get(col.name())
                .unwrap_or(serde_json::Value::Null);
            engine_row.set(col.name().to_string(), Value::from_json(val));
        }

        *rows_out += 1;
        if tx.send(engine_row).await.is_err() { break; }
        maybe_emit_progress(&ctx, *rows_out, start, last_prog);
    }

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
    pool:      &SqlitePool,
    query:     &str,
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::Row as SqlxRow;

    let mut stream = sqlx::query(query).fetch(pool);

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