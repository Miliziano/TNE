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
use serde::Deserialize;
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
    /// R8 — la query compilata dallo studio, se cita parametri.
    query_compiled:  Option<CompiledQuery>,
}

/// Query con i `${campo}` già risolti in placeholder.
///
/// La compila lo **studio** (`src/ir/queryParams.ts`) e scende nella busta
/// `spec.config`. Qui non si legge MAI la sintassi `${...}`: è lo stesso
/// patto di FPEL — `exprParser.ts` parsa, `expr.rs` valuta un albero già
/// pronto. Un secondo parser in Rust sarebbe una copia, e le copie
/// divergono in silenzio. V. contratto-porte.md R8 e §10.
///
/// `sql` porta placeholder NEUTRI (`?`): il dialetto lo sappiamo QUI,
/// perché qui abbiamo il pool in mano. Lo studio non può saperlo per
/// certo — la risorsa può cambiare sotto.
#[derive(Deserialize, Clone, Debug)]
struct CompiledQuery {
    /// SQL con `?` al posto di ogni `${campo}`.
    sql:   String,
    /// I nomi dei campi da legare, **nell'ordine dei placeholder**.
    /// Lo stesso campo citato due volte compare due volte: i placeholder
    /// sono posizionali e ognuno vuole il suo valore.
    binds: Vec<String>,
}

/// Parte compilata, letta da `spec.config` (non dalle props).
#[derive(Deserialize, Default)]
struct SourceDbConfigStruct {
    #[serde(default, rename = "queryCompiled")]
    query_compiled: Option<CompiledQuery>,
}

fn default_port(dialect: &str) -> u16 {
    match dialect { "mysql" => 3306, _ => 5432 }
}

fn config_from_spec(spec: &Spec) -> Result<SourceDbConfig, String> {
    // Strutture compilate dalla busta config (calco: aggregate.rs:88).
    let st: SourceDbConfigStruct = serde_json::from_value(spec.config().clone())
        .map_err(|e| format!("config strutturata non valida (queryCompiled): {}", e))?;

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
        query_compiled:  st.query_compiled,
    })
}

// ─── R8, seconda metà — i parametri della query ────────────────────

/// Rinumera i placeholder neutri `?` per il dialetto.
///
/// Postgres vuole `$1, $2, …` posizionali; MySQL e SQLite vogliono `?`.
/// Lo studio emette sempre `?` perché non può sapere per certo con quale
/// risorsa girerà il nodo; qui il pool ce l'abbiamo in mano.
///
/// NB si rinumerano solo i `?` che lo studio ha messo — sono tanti quanti
/// i bind. Un `?` scritto a mano dall'utente dentro la sua query (dentro
/// un letterale, per dire) sarebbe indistinguibile: per questo la conta
/// viene verificata dal chiamante contro `binds.len()`.
fn renumber_placeholders(sql: &str, dialect: &str) -> String {
    if !dialect.starts_with("postgres") {
        return sql.to_string();
    }
    let mut out = String::with_capacity(sql.len() + 8);
    let mut n = 0usize;
    for ch in sql.chars() {
        if ch == '?' {
            n += 1;
            out.push('$');
            out.push_str(&n.to_string());
        } else {
            out.push(ch);
        }
    }
    out
}

/// Prende dalla riga di parametri i valori citati dalla query, in ordine.
///
/// La riga arriva dall'ingresso (R8: barriera + parametri, una riga sola —
/// v. `nodes/source_input.rs`). Un campo citato e non presente è un errore
/// parlante: lo studio lo controlla già in design (QUERY_PARAM_UNKNOWN),
/// ma il piano può essere eseguito senza passare di lì, e a runtime un
/// parametro mancante non deve diventare NULL in silenzio — diventerebbe
/// una query che gira e non trova niente, cioè un risultato sbagliato che
/// sembra giusto.
fn resolve_binds(
    node_id: &str,
    compiled: &CompiledQuery,
    params: Option<&Row>,
) -> Result<Vec<Value>, String> {
    if compiled.binds.is_empty() {
        return Ok(Vec::new());
    }
    let Some(row) = params else {
        return Err(format!(
            "source_db {}: la query usa i parametri [{}] ma al nodo non è arrivata \
             nessuna riga in ingresso. Collega a monte il nodo che li calcola.",
            node_id, compiled.binds.join(", ")
        ));
    };
    let mut out = Vec::with_capacity(compiled.binds.len());
    for name in &compiled.binds {
        match row.0.get(name) {
            Some(v) => out.push(v.clone()),
            None => {
                let mut avail: Vec<&str> = row.0.keys().map(|k| k.as_str()).collect();
                avail.sort_unstable();
                return Err(format!(
                    "source_db {}: la query usa il parametro `${{{}}}` ma la riga in \
                     ingresso non ha quel campo. Campi arrivati: {}",
                    node_id, name,
                    if avail.is_empty() { "(nessuno)".to_string() } else { avail.join(", ") }
                ));
            }
        }
    }
    Ok(out)
}

/// Lega i valori a una query sqlx, **tipizzati**.
///
/// Macro e non funzione perché sqlx tipizza `Query` per dialetto
/// (`Query<'_, Postgres, _>` ≠ `Query<'_, MySql, _>`): una funzione
/// generica costerebbe più cerimonia di quanta ne risparmi. La macro
/// tiene comunque il match in UN posto solo — tre copie a mano di questa
/// tabella sarebbero esattamente il modo in cui questo progetto si è
/// ammalato finora.
///
/// ⚠️ IL DECIMAL — il punto che decide tutto.
/// `engine/types.rs` dice del suo `Decimal`: *"Esatto: non passa mai per
/// f64"*. Legarlo per f64 qui vanificherebbe l'intera catena, in silenzio
/// e sui soldi. Ma **il dialetto cambia la strada**:
///   · Postgres e MySQL → si lega NATIVAMENTE (`sqlx` ha la feature
///     `rust_decimal` abilitata, Cargo.toml).
///   · SQLite → sqlx NON implementa `Encode<Sqlite>` per `Decimal`, perché
///     SQLite non ha un tipo NUMERIC. Si lega come **testo**: esatto anche
///     quello, e comunque mai per f64.
/// Per questo il terzo parametro è *come si lega un Decimal qui*: la
/// differenza sta in un posto solo, al punto di chiamata.
///
/// Date e DateTime a livello di trasporto sono stringhe ISO 8601 (v.
/// engine/types.rs): si legano come stringhe e il driver le converte.
/// `Object` (JSON) si lega come il suo testo JSON, non come Debug.
macro_rules! bind_values {
    ($q:expr, $vals:expr, $bind_decimal:expr) => {{
        let mut q = $q;
        for v in $vals {
            q = match v {
                Value::Null        => q.bind(None::<String>),
                Value::Bool(b)     => q.bind(*b),
                Value::Int(i)      => q.bind(*i),
                Value::Float(f)    => q.bind(*f),
                Value::Decimal(d)  => q.bind($bind_decimal(d)),
                Value::String(s)   => q.bind(s.clone()),
                Value::Date(s)     => q.bind(s.clone()),
                Value::DateTime(s) => q.bind(s.clone()),
                Value::Object(j)   => q.bind(j.to_string()),
            };
        }
        q
    }};
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
    // Aspetta chi sta a monte, se c'è, e prendi la riga di parametri.
    // R8: barriera + parametri, una riga sola. V. nodes/source_input.rs.
    let params = super::source_input::await_params(
        &ctx.node_id.0, "source_db", rx,
    ).await?;

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_db {}: {}", ctx.node_id.0, e))?;
    let config = config_from_spec(&spec)
        .map_err(|e| format!("source_db {}: {}", ctx.node_id.0, e))?;

    let tx = match tx {
        Some(t) => t,
        None    => return Ok(NodeStats::default()),
    };

    let conn_str = connection_string(&config)?;
    let dialect  = config.dialect.clone();

    // R8 — se la query cita parametri, lo studio l'ha già compilata:
    // placeholder neutri + i campi da legare in ordine. Qui si rinumera
    // per il dialetto (che sappiamo per certo: il pool è nostro) e si
    // prendono i valori dalla riga arrivata in ingresso.
    // Senza parametri: la query verbatim, come è sempre stato.
    let (query, binds): (String, Vec<Value>) = match &config.query_compiled {
        Some(c) => {
            let vals = resolve_binds(&ctx.node_id.0, c, params.as_ref())?;
            // Cintura: i `?` rinumerati devono essere tanti quanti i bind.
            // Se non tornano, la query ha `?` che lo studio non ha messo e
            // legare alla cieca darebbe un errore del driver senza spiegazione.
            let holes = c.sql.matches('?').count();
            if holes != c.binds.len() {
                return Err(format!(
                    "source_db {}: la query ha {} punti interrogativi ma {} parametri \
                     dichiarati. Un `?` scritto a mano in una query con parametri non è \
                     distinguibile da un segnaposto: toglilo, o usa `${{campo}}`.",
                    ctx.node_id.0, holes, c.binds.len()
                ));
            }
            (renumber_placeholders(&c.sql, &dialect), vals)
        }
        None => (config.query.clone(), Vec::new()),
    };

    let start         = Instant::now();
    let mut rows_out  = 0u64;
    let mut last_prog = Instant::now();

    eprintln!("[source_db] node={} query={}", ctx.node_id.0, query);
    spec.log_unconsumed("source_db", &ctx.node_id.0);

    // Pool condiviso della lane (L1). Il source usa 1 connessione
    // (lettura in streaming da un unico cursore).
    let params = PoolParams {
        dialect:         dialect.clone(),
        conn_str,
        max_connections: 5,
        connect_timeout: config.connect_timeout,
    };
    // Retry "prima operazione": ritenta l'apertura se la modalità lo prevede.
    let pool = match ctx.retry_policy() {
        Some((n, d)) => ctx.lane_resources.pool_with_retry(&config.resource_id, params, n, d).await,
        None         => ctx.lane_resources.pool(&config.resource_id, params).await,
    }
        .map_err(|e| format!("source_db {}: {}", ctx.node_id.0, e))?;

    let resource_id = config.resource_id.clone();
    ctx.emit_connection_opened(&resource_id, &format!("db_{}", dialect));

    let result = match &pool {
        DbPool::Pg(p)     => run_pg(ctx.clone(), tx, p, &query, &binds, &mut rows_out, &start, &mut last_prog).await,
        DbPool::My(p)     => run_mysql(ctx.clone(), tx, p, &query, &binds, &mut rows_out, &start, &mut last_prog).await,
        DbPool::Sqlite(p) => run_sqlite(ctx.clone(), tx, p, &query, &binds, &mut rows_out, &start, &mut last_prog).await,
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
    // R8 — i valori da legare, nell'ordine dei placeholder. Vuoto = query senza parametri.
    binds:     &[Value],
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::Row as SqlxRow;

    let mut stream = bind_values!(sqlx::query(query), binds, |d: &rust_decimal::Decimal| *d).fetch(pool);

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
    // R8 — i valori da legare, nell'ordine dei placeholder. Vuoto = query senza parametri.
    binds:     &[Value],
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::Row as SqlxRow;

    let mut stream = bind_values!(sqlx::query(query), binds, |d: &rust_decimal::Decimal| *d).fetch(pool);

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
    // R8 — i valori da legare, nell'ordine dei placeholder. Vuoto = query senza parametri.
    binds:     &[Value],
    rows_out:  &mut u64,
    start:     &Instant,
    last_prog: &mut Instant,
) -> Result<(), String> {
    use sqlx::Row as SqlxRow;

    let mut stream = bind_values!(sqlx::query(query), binds, |d: &rust_decimal::Decimal| d.to_string()).fetch(pool);

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