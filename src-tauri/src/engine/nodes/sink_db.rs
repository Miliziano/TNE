// ─── src-tauri/src/engine/nodes/sink_db.rs ─────────────────────────
//
// Riceve righe dal canale e le scrive in un DB in batch.
// Riusa la logica SQL di pg_write/mysql_write/sqlite_write da lib.rs
// tramite le funzioni già esposte come pub — non duplichiamo il SQL.
//
// MIGRATO ALLA SPEC (fondazione §6.0 — contratto docs/node-spec.md §4):
// - connessione da spec.resource (risorsa risolta), non più da campi
//   selezionati a mano nel plan;
// - props lette verbatim con le chiavi dei pannelli. Diventano ATTIVI
//   i campi che prima cadevano a terra: batchSize (default 1000 come
//   il pannello — prima il fallback era 500), keyFields, preSql,
//   postSql, querySchema, mergeCondition, deadLetterTable,
//   excludeColumns;
// - sinkColumns letto direttamente dalla prop JSON del MappingPanel,
//   INCLUSO sourceField: chiude il drop per cui map_row ripiegava
//   sempre sul nome colonna (il mapping riga[sourceField] → dbColumn
//   funzionava solo con nomi coincidenti);
// - warning esplicito su fallimento totale (N ricevute, 0 scritte):
//   §5.6 handoff — non deve essere indistinguibile dal successo.
//
// Restano 🕐 (dichiarati nel contratto, visibili nel log unconsumed):
// commitInterval, parallelConnections, txTimeout, customSql/
// customQueryMode, storedProcMode, ddlPrimaryKey,
// passthroughMasterDetail, generatedKeyConfig, identityMap*.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowReceiver, NodeContext};
use crate::engine::spec::Spec;

fn default_true() -> bool { true }

/// Elemento della prop `sinkColumns` (JSON del MappingPanel).
/// I campi UI non elencati (dbFunction, isKey, keyOperator, …)
/// vengono ignorati da serde.
#[derive(serde::Deserialize)]
struct SinkColumn {
    #[serde(rename = "dbColumn")]
    db_column:    String,
    #[serde(rename = "dbType", default)]
    db_type:      String,
    #[serde(default = "default_true")]
    nullable:     bool,
    #[serde(rename = "isPk", default)]
    is_pk:        bool,
    #[serde(default = "default_true")]
    enabled:      bool,
    #[serde(rename = "sourceField", default)]
    source_field: String,
}

/// Definizione di una colonna per DDL e scrittura (interna al nodo).
struct ColumnDdl {
    name:     String,
    db_type:  String,   // tipo nativo dal mapping (es. "int8", "text")
    nullable: bool,
    is_pk:    bool,
    source:   String,   // campo sorgente nella riga (per la scrittura)
}

// Config interna, costruita dalla Spec (default del contratto §4).
struct SinkDbConfig {
    // Connessione (da spec.resource)
    dialect:              String,
    host:                 String,
    port:                 u16,
    database:             String,
    schema_name:          Option<String>,
    user:                 String,
    password:             String,
    ssl:                  String,
    connect_timeout:      u64,
    // Scrittura (da spec.props)
    table:                String,
    mode:                 String,   // "insert" | "upsert" | "update" | "delete" | "truncate_insert" | "merge"
    key_fields:           Option<Vec<String>>,
    exclude_columns:      Option<Vec<String>>,
    batch_size:           usize,
    on_constraint_error:  String,
    pre_sql:              String,
    post_sql:             String,
    merge_condition:      Option<String>,
    dead_letter_table:    Option<String>,
    // Monitoraggio: id della risorsa connessione (per eventi Connection*)
    resource_id:          String,
    // DDL (Fase 11): creazione/ricreazione tabella dal mapping
    create_if_not_exists: bool,
    drop_and_create:      bool,
    columns_ddl:          Vec<ColumnDdl>,
}

fn default_port(dialect: &str) -> u16 {
    match dialect {
        "mysql" => 3306,
        _       => 5432,
    }
}

fn opt_nonempty(s: String) -> Option<String> {
    if s.trim().is_empty() { None } else { Some(s) }
}

fn config_from_spec(spec: &Spec) -> Result<SinkDbConfig, String> {
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

    let table = spec.str_req("table")
        .map_err(|e| e.to_string())?;

    // 'public' equivale a nessun prefisso: mantiene l'SQL identico
    // al comportamento pre-migrazione (e alla Preview).
    let schema = spec.str_or("querySchema", "");
    let schema_name = if schema.is_empty() || schema == "public" {
        None
    } else {
        Some(schema)
    };

    let key_fields = {
        let v = spec.str_list("keyFields");
        if v.is_empty() { None } else { Some(v) }
    };
    let exclude_columns = {
        let v = spec.str_list("excludeColumns");
        if v.is_empty() { None } else { Some(v) }
    };

    // Mapping colonne dal MappingPanel — filtrate alle sole enabled,
    // con sourceField preservato (prima veniva scartato dal builder TS).
    let sink_cols: Vec<SinkColumn> = spec.json_or("sinkColumns", Vec::new());
    let columns_ddl: Vec<ColumnDdl> = sink_cols.into_iter()
        .filter(|c| c.enabled)
        .map(|c| ColumnDdl {
            name:     c.db_column,
            db_type:  c.db_type,
            nullable: c.nullable,
            is_pk:    c.is_pk,
            source:   c.source_field,
        })
        .collect();

    Ok(SinkDbConfig {
        host:                 spec.res_str_or("host", "localhost"),
        database:             spec.res_str_or("database", ""),
        password:             spec.res_str_or("password", ""),
        ssl:                  spec.res_str_or("ssl", "false"),
        connect_timeout:      spec.res_u64_or("connectTimeout", 30),
        mode:                 spec.str_or("mode", "insert"),
        // Default 1000 come il pannello (contratto §4) — prima il
        // fallback del motore era 500, disallineato dalla UI.
        batch_size:           spec.usize_or("batchSize", 1000).max(1),
        on_constraint_error:  spec.str_or("onConstraintError", "stop"),
        pre_sql:              spec.str_or("preSql", ""),
        post_sql:             spec.str_or("postSql", ""),
        merge_condition:      opt_nonempty(spec.str_or("mergeCondition", "")),
        dead_letter_table:    opt_nonempty(spec.str_or("deadLetterTable", "")),
        create_if_not_exists: spec.bool_or("createIfNotExists", false),
        drop_and_create:      spec.bool_or("dropAndCreate", false),
        resource_id:          spec.resource_id(),
        dialect,
        port,
        user,
        table,
        schema_name,
        key_fields,
        exclude_columns,
        columns_ddl,
    })
}

const PROGRESS_EVERY_ROWS: u64 = 1000;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx:    NodeContext,
    rx:     RowReceiver,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;
    let config = config_from_spec(&spec)
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;

    spec.log_unconsumed("sink_db", &ctx.node_id.0);

    let resource_id = config.resource_id.clone();

    // Pool condiviso della lane (L1): stessa risorsa → stessa connessione
    // delle altre source/sink della lane. Creato qui, chiuso dalla lane.
    let conn_str = build_conn_str(&config)?;
    let pool = ctx.lane_resources.pool(
        &resource_id,
        crate::engine::pool::PoolParams {
            dialect:         config.dialect.clone(),
            conn_str,
            max_connections: 1,   // L1: una connessione per risorsa
            connect_timeout: config.connect_timeout,
        },
    ).await
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;

    ctx.emit_connection_opened(&resource_id, &format!("db_{}", config.dialect));

    let start = Instant::now();

    // Corpo che può fallire, isolato: qualunque sia l'esito,
    // emettiamo SEMPRE connection_closed dopo (evento garantito anche
    // su errore — era il bug del monitor "aperta" dopo il fallimento).
    let outcome = write_all(&ctx, &pool, &config, rx, &start).await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    match &outcome {
        Ok((_, _, query_count)) => ctx.emit_connection_closed(&resource_id, *query_count, elapsed_ms),
        Err(_)                  => ctx.emit_connection_closed(&resource_id, 0, elapsed_ms),
    }

    let (rows_in, written, _qc) = outcome?;

    let stats = NodeStats {
        rows_in, rows_out: written, rows_rejected: 0, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// Corpo di scrittura: DDL + pre-SQL + batch + post-SQL sul pool condiviso.
// Ritorna (rows_in, written, query_count). Il ? qui NON salta la chiusura
// dell'evento: la gestisce run() dopo aver ricevuto l'outcome.
async fn write_all(
    ctx:    &NodeContext,
    pool:   &crate::engine::pool::DbPool,
    config: &SinkDbConfig,
    mut rx: RowReceiver,
    start:  &Instant,
) -> Result<(u64, u64, u32), String> {

    let batch_size  = config.batch_size;
    let mut rows_in = 0u64;
    let mut written = 0u64;
    let mut last_prog = Instant::now();
    let mut query_count = 0u32;
    let mut batch: Vec<serde_json::Value> = Vec::with_capacity(batch_size);

    // DDL
    if config.drop_and_create || config.create_if_not_exists {
        if config.dialect == "postgresql" {
            if config.drop_and_create {
                let drop = format!("DROP TABLE IF EXISTS {} CASCADE", qualified_ddl_table(config));
                exec_pre_post(pool, &drop, "DROP TABLE").await?;
            }
            if let Some(ddl) = build_create_table(config) {
                exec_pre_post(pool, &ddl, "CREATE TABLE").await?;
            }
        } else {
            eprintln!("[sink_db] DDL saltata: dialetto '{}' non ancora supportato", config.dialect);
        }
    }

    if !config.pre_sql.trim().is_empty() {
        exec_pre_post(pool, &config.pre_sql, "Pre-SQL").await?;
    }

    while let Some(row) = rx.recv().await {
        rows_in += 1;
        let json_row = if config.columns_ddl.is_empty() {
            row.to_json_object()
        } else {
            map_row(&row, &config.columns_ddl)
        };
        batch.push(json_row);

        if batch.len() >= batch_size {
            let (w, _e) = flush_batch(pool, config, &batch).await?;
            written += w;
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

    if !batch.is_empty() {
        let (w, _e) = flush_batch(pool, config, &batch).await?;
        written += w;
        query_count += 1;
    }

    if !config.post_sql.trim().is_empty() {
        exec_pre_post(pool, &config.post_sql, "Post-SQL").await?;
    }

    if rows_in > 0 && written == 0 {
        eprintln!(
            "[sink_db][WARN] {}: {} righe ricevute, 0 scritte (onConstraintError={}) — possibile fallimento totale",
            ctx.node_id.0, rows_in, config.on_constraint_error
        );
    }

    Ok((rows_in, written, query_count))
}

// ─── Flush un batch di righe usando le funzioni esistenti di lib.rs ──

async fn flush_batch(
    pool:   &crate::engine::pool::DbPool,
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
        columns:             None,
        exclude_columns:     config.exclude_columns.clone(),
        column_functions:    None,
        merge_condition:     config.merge_condition.clone(),
        pre_sql:             None,   // già eseguito una volta sopra
        post_sql:            None,
        batch_size:          batch.len(),
        on_constraint_error: config.on_constraint_error.clone(),
        dead_letter_table:   config.dead_letter_table.clone(),
        returning_column:    None,
    };

    let start = Instant::now();
      use crate::engine::pool::DbPool;
    let result = match pool {
        DbPool::Pg(p)     => crate::pg_write_pool(p, &req, start).await?,
        DbPool::My(p)     => crate::mysql_write_pool(p, &req, start).await?,
        DbPool::Sqlite(p) => crate::sqlite_write_pool(p, &req, start).await?,
    };

    Ok((result.rows_written as u64, result.rows_errors as u64))
}

// ─── Scrittura: applica il mapping sorgente → colonna ─────────────

/// Costruisce l'oggetto JSON da scrivere prendendo, per ogni colonna
/// mappata, il valore di `source` (sourceField) dalla riga e mettendolo
/// sotto `name` (dbColumn). Filtra alle sole colonne mappate e rinomina.
fn map_row(row: &Row, cols: &[ColumnDdl]) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    for c in cols {
        let src = if c.source.is_empty() { c.name.as_str() } else { c.source.as_str() };
        let val = row.get(src).map(|v| v.to_json()).unwrap_or(serde_json::Value::Null);
        obj.insert(c.name.clone(), val);
    }
    serde_json::Value::Object(obj)
}

// ─── DDL: generazione CREATE TABLE dal mapping (Fase 11) ──────────
/// Nome tabella qualificato per la DDL — stessa politica di quoting
/// dell'INSERT (nessun quoting), v. node-spec.md §4.
fn qualified_ddl_table(config: &SinkDbConfig) -> String {
    match &config.schema_name {
        Some(s) if !s.is_empty() => format!("{}.{}", s, config.table),
        _                        => config.table.clone(),
    }
}

/// Genera il CREATE TABLE da columns_ddl. Ritorna None se non ci sono
/// colonne (in quel caso non si crea niente). Usa `IF NOT EXISTS` solo
/// in modalità create-if-not-exists pura (dopo un DROP la tabella è
/// sicuramente assente, quindi non serve).
fn build_create_table(config: &SinkDbConfig) -> Option<String> {
    if config.columns_ddl.is_empty() {
        return None;
    }
    let cols: Vec<String> = config.columns_ddl.iter().map(|c| {
        let null = if c.nullable { "" } else { " NOT NULL" };
        format!("  {} {}{}", c.name, c.db_type, null)
    }).collect();

     let pk: Vec<String> = config.columns_ddl.iter()
        .filter(|c| c.is_pk)
        .map(|c| c.name.clone())
        .collect();

    let mut body = cols.join(",\n");
    if !pk.is_empty() {
        body.push_str(&format!(",\n  PRIMARY KEY ({})", pk.join(", ")));
    }

    let if_not_exists = if config.create_if_not_exists && !config.drop_and_create {
        "IF NOT EXISTS "
    } else {
        ""
    };

    Some(format!(
        "CREATE TABLE {}{} (\n{}\n)",
        if_not_exists, qualified_ddl_table(config), body
    ))
}

// ─── Helper connessione ───────────────────────────────────────────

fn build_conn_str(config: &SinkDbConfig) -> Result<String, String> {
    match config.dialect.as_str() {
        "postgresql" => {
            let ssl = match config.ssl.as_str() {
                "true" | "require" => "require", _ => "disable",
            };
            Ok(format!("postgresql://{}:{}@{}:{}/{}?sslmode={}",
                urlencoding::encode(&config.user), urlencoding::encode(&config.password),
                config.host, config.port, config.database, ssl))
        }
        "mysql"  => Ok(format!("mysql://{}:{}@{}:{}/{}",
            urlencoding::encode(&config.user), urlencoding::encode(&config.password),
            config.host, config.port, config.database)),
        "sqlite" => Ok(format!("sqlite:{}", config.database)),
        d => Err(format!("Dialetto '{}' non supportato", d)),
    }
}

fn build_db_connection_params(config: &SinkDbConfig) -> crate::DbConnectionParams {
    crate::DbConnectionParams {
        dialect:         config.dialect.clone(),
        host:            Some(config.host.clone()),
        port:            Some(config.port),
        database:        Some(config.database.clone()),
        user:            Some(config.user.clone()),
        password:        Some(config.password.clone()),
        schema:          config.schema_name.clone(),
        service_name:    None,
        db_server_name:  None,
        charset:         None,
        ssl:             Some(config.ssl.clone()),
        connect_timeout: Some(config.connect_timeout),
    }
}

async fn exec_pre_post(
    pool:  &crate::engine::pool::DbPool,
    sql:   &str,
    label: &str,
) -> Result<(), String> {
    use crate::engine::pool::DbPool;
    let stmts: Vec<&str> = sql.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()).collect();
    for stmt in stmts {
        let res = match pool {
            DbPool::Pg(p)     => sqlx::query(stmt).execute(p).await.map(|_| ()),
            DbPool::My(p)     => sqlx::query(stmt).execute(p).await.map(|_| ()),
            DbPool::Sqlite(p) => sqlx::query(stmt).execute(p).await.map(|_| ()),
        };
        res.map_err(|e| format!("{} fallito: {}", label, e))?;
    }
    Ok(())
}