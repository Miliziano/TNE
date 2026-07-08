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
use crate::engine::executor::{RowReceiver,RowSender, NodeContext};
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
    #[serde(rename = "isKey", default)]
    is_key:       bool,
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
     // Master-detail (pass-through chiave generata)
    passthrough_md:       bool,
    md_output_field:      String,   // nome sotto cui iniettare la chiave nella riga
    md_source_column:     String,   // colonna DB del RETURNING (es. "id")
    transaction_id:       String,
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

    let sink_cols: Vec<SinkColumn> = spec.json_or("sinkColumns", Vec::new());

    // Le chiavi per update/upsert/delete vengono dal mapping (colonne
    // marcate 'chiave'), UNICA fonte di verità. Fallback alla prop
    // keyFields (legacy) se il mapping non ne ha.
    let key_fields = {
        let from_mapping: Vec<String> = sink_cols.iter()
            .filter(|c| c.is_key && c.enabled)
            .map(|c| c.db_column.clone())
            .collect();
        if !from_mapping.is_empty() {
            Some(from_mapping)
        } else {
            let v = spec.str_list("keyFields");
            if v.is_empty() { None } else { Some(v) }
        }
    };
    // update/upsert/delete richiedono chiavi esplicite: mai inventare
    // 'id' (colpirebbe righe sbagliate o darebbe errori oscuri).
    let mode = spec.str_or("mode", "insert");
    if matches!(mode.as_str(), "update" | "upsert" | "delete") && key_fields.is_none() {
        return Err(format!(
            "modalità '{}' richiede almeno un campo chiave: nel mapping del sink \
             marca una o più colonne come 'chiave' (badge blu), non come PK",
            mode
        ));
    }
    let exclude_columns = {
        let v = spec.str_list("excludeColumns");
        if v.is_empty() { None } else { Some(v) }
    };

    // Mapping colonne dal MappingPanel — filtrate alle sole enabled,
    // con sourceField preservato (prima veniva scartato dal builder TS).
   
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
    
    // Master-detail: legge passthroughMasterDetail + generatedKeyConfig.
    #[derive(serde::Deserialize, Default)]
    struct GenKeyCfg {
        #[serde(rename = "outputFieldName", default)]
        output_field_name: String,
        #[serde(rename = "sourceDbColumn", default)]
        source_db_column:  String,
    }
    let passthrough_md = spec.bool_or("passthroughMasterDetail", false);
    let gk: GenKeyCfg = spec.json_or("generatedKeyConfig", GenKeyCfg::default());
    let md_output_field  = if gk.output_field_name.is_empty() { "__generated_id".to_string() } else { gk.output_field_name };
    let md_source_column = if gk.source_db_column.is_empty()  { "id".to_string() } else { gk.source_db_column };

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
        transaction_id:       spec.str_or("transactionId", ""),
        dialect,
        port,
        user,
        table,
        schema_name,
        key_fields,
        exclude_columns,
        columns_ddl,
        // Master-detail (pass-through chiave generata)
        passthrough_md,
        md_output_field,
        md_source_column,
    })
}

const PROGRESS_EVERY_ROWS: u64 = 1000;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx:    NodeContext,
    rx:     RowReceiver,
    tx:     Option<RowSender>,
    ) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;
    let config = config_from_spec(&spec)
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;

    spec.log_unconsumed("sink_db", &ctx.node_id.0);

    // Master-detail richiede insert/upsert (serve una chiave generata).
    if config.passthrough_md && !matches!(config.mode.as_str(), "insert" | "upsert" | "truncate_insert") {
        return Err(format!(
            "sink_db {}: master-detail richiede modalità insert/upsert (non '{}')",
            ctx.node_id.0, config.mode
        ));
    }
    if config.passthrough_md && tx.is_none() {
        ctx.emit_log(&ctx.label, "warn", 0,
            "[sink_db] master-detail attivo ma nessun nodo a valle: le righe \
             arricchite non vanno da nessuna parte".to_string(), "panel");
    }
    if config.passthrough_md {
        ctx.emit_log(&ctx.label, "info", 0,
            "[sink_db] master-detail: scrittura riga-per-riga (performance ridotta)".to_string(), "panel");
    }

    let resource_id = config.resource_id.clone();
    let conn_str = build_conn_str(&config)?;
    let pool = ctx.lane_resources.pool(
        &resource_id,
        crate::engine::pool::PoolParams {
            dialect:         config.dialect.clone(),
            conn_str,
            max_connections: 5,
            connect_timeout: config.connect_timeout,
        },
    ).await
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;

    ctx.emit_connection_opened(&resource_id, &format!("db_{}", config.dialect));

    let start = Instant::now();

    // Biforcazione: master-detail (riga-per-riga, inoltra) vs batch (default).
    let start = Instant::now();

    // Transazione: se il nodo appartiene a un gruppo, scrive sulla
    // connessione condivisa (BEGIN aperto dal registro); altrimenti
    // percorso normale (autocommit sul pool).
    let tx_group = config.transaction_id.clone();

    let outcome = if !tx_group.is_empty() {
        // Percorso transazionale (native, PostgreSQL). Master-detail in
        // transazione: TODO — per ora il ramo transazionale usa write_all_tx.
        if config.dialect != "postgresql" {
            return Err(format!("sink_db {}: transazioni supportate solo su PostgreSQL (per ora)", ctx.node_id.0));
        }
        write_all_tx(&ctx, &pool, &config, rx, &tx_group, &start).await
    } else if config.passthrough_md {
        write_master_detail(&ctx, &pool, &config, rx, tx, &start).await
    } else {
        write_all(&ctx, &pool, &config, rx, &start).await
    };

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

// Scrittura DENTRO una transazione di gruppo (L3 native, PostgreSQL).
// Ottiene la connessione condivisa dal registro (BEGIN già aperto),
// scrive le righe su di essa, poi segnala done/failure e tenta la
// finalizzazione (commit/rollback se è l'ultimo membro).

async fn write_all_tx(
    ctx:      &NodeContext,
    pool:     &crate::engine::pool::DbPool,
    config:   &SinkDbConfig,
    mut rx:   RowReceiver,
    group_id: &str,
    start:    &Instant,
    ) -> Result<(u64, u64, u32), String> {
    use crate::engine::pool::DbPool;

    // Estrae il PgPool concreto dalla risorsa condivisa.
    let pg_pool = match pool {
        DbPool::Pg(p) => p,
        _ => return Err("transazioni solo su PostgreSQL (per ora)".to_string()),
    };

    // Connessione condivisa del gruppo (apre BEGIN alla prima chiamata).
    let conn = ctx.lane_txns.get_pg_conn(group_id, pg_pool).await?;

    let batch_size  = config.batch_size;
    let mut rows_in = 0u64;
    let mut written = 0u64;
    let mut last_prog = Instant::now();
    let mut query_count = 0u32;
    let mut batch: Vec<serde_json::Value> = Vec::with_capacity(batch_size);

    // NB: DDL / pre-SQL / post-SQL non gestiti nel ramo transazionale
    // per ora (andrebbero coordinati a livello di gruppo, non per-nodo).
    // Se servono, il nodo deve NON essere in transazione o si estende qui.

    // Corpo di scrittura, isolato per intercettare l'errore e segnalare
    // il fallimento al gruppo (che deciderà il rollback).
    let write_result: Result<(), String> = async {
        while let Some(row) = rx.recv().await {
            rows_in += 1;
            let json_row = if config.columns_ddl.is_empty() {
                row.to_json_object()
            } else {
                map_row(&row, &config.columns_ddl)
            };
            batch.push(json_row);

            if batch.len() >= batch_size {
                let w = flush_batch_tx(&conn, config, &batch).await?;
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
            let w = flush_batch_tx(&conn, config, &batch).await?;
            written += w;
            query_count += 1;
        }
        Ok(())
    }.await;

    // Segnala solo l'esito: la finalizzazione (commit/rollback) avviene
    // a fine lane, quando l'esito complessivo è noto. Il sink NON committa.
    ctx.lane_txns.report_member_end(group_id, write_result.is_ok()).await;

    write_result?;
    Ok((rows_in, written, query_count))
}

// Scrive un batch sulla connessione condivisa della transazione.
async fn flush_batch_tx(
    conn:   &std::sync::Arc<tokio::sync::Mutex<sqlx::pool::PoolConnection<sqlx::Postgres>>>,
    config: &SinkDbConfig,
    batch:  &[serde_json::Value],
) -> Result<u64, String> {
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
        pre_sql:             None,
        post_sql:            None,
        batch_size:          batch.len(),
        on_constraint_error: config.on_constraint_error.clone(),
        dead_letter_table:   config.dead_letter_table.clone(),
        returning_column:    None,
    };
    let start = Instant::now();
    let mut guard = conn.lock().await;
    let result = crate::pg_write_conn(&mut *guard, &req, start).await?;
    Ok(result.rows_written as u64)
}

// Master-detail: scrive UNA riga alla volta con RETURNING, inietta la
// chiave generata nella riga sotto md_output_field, e la inoltra su tx.
// Batch=1 obbligatorio: serve la corrispondenza 1:1 riga↔chiave.
async fn write_master_detail(
    ctx:    &NodeContext,
    pool:   &crate::engine::pool::DbPool,
    config: &SinkDbConfig,
    mut rx: RowReceiver,
    tx:     Option<RowSender>,
    start:  &Instant,
) -> Result<(u64, u64, u32), String> {

    let mut rows_in = 0u64;
    let mut written = 0u64;
    let mut last_prog = Instant::now();

    // DDL + pre-SQL come nel percorso batch.
    if config.drop_and_create || config.create_if_not_exists {
        if config.dialect == "postgresql" {
            if config.drop_and_create {
                let drop = format!("DROP TABLE IF EXISTS {} CASCADE", qualified_ddl_table(config));
                exec_pre_post(pool, &drop, "DROP TABLE").await?;
            }
            if let Some(ddl) = build_create_table(config) {
                exec_pre_post(pool, &ddl, "CREATE TABLE").await?;
            }
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

        // Scrive questa singola riga con RETURNING della colonna chiave.
        let key = flush_one_returning(pool, config, &json_row, &config.md_source_column).await?;
        // eprintln!("[md] chiave catturata: {:?}", key);
        written += 1;

        // Inietta la chiave nella riga originale e inoltra.
        if let Some(ref tx) = tx {
            //eprintln!("[md-inject] campo='{}' = {:?}", config.md_output_field, key);
            let mut enriched = row.clone();
            enriched.set(config.md_output_field.clone(), key.unwrap_or(Value::Null));
           
            if tx.send(enriched).await.is_err() { break; }
        }

        let should_prog = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if should_prog {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, written, 0, rps);
            last_prog = Instant::now();
        }
    }

    if !config.post_sql.trim().is_empty() {
        exec_pre_post(pool, &config.post_sql, "Post-SQL").await?;
    }

    Ok((rows_in, written, written as u32))
}

// Scrive una riga con RETURNING e restituisce la chiave generata.
async fn flush_one_returning(
    pool:    &crate::engine::pool::DbPool,
    config:  &SinkDbConfig,
    row:     &serde_json::Value,
    ret_col: &str,
) -> Result<Option<Value>, String> {
    let req = crate::DbWriteRequest {
        connection:          build_db_connection_params(config),
        table:               config.table.clone(),
        schema:              config.schema_name.clone(),
        mode:                config.mode.clone(),
        rows:                vec![row.clone()],
        key_fields:          config.key_fields.clone(),
        columns:             None,
        exclude_columns:     config.exclude_columns.clone(),
        column_functions:    None,
        merge_condition:     config.merge_condition.clone(),
        pre_sql:             None,
        post_sql:            None,
        batch_size:          1,
        on_constraint_error: config.on_constraint_error.clone(),
        dead_letter_table:   config.dead_letter_table.clone(),
        returning_column:    Some(ret_col.to_string()),
    };

    let start = Instant::now();
    use crate::engine::pool::DbPool;
    let result = match pool {
        DbPool::Pg(p)     => crate::pg_write_pool(p, &req, start).await?,
        DbPool::My(p)     => crate::mysql_write_pool(p, &req, start).await?,
        DbPool::Sqlite(p) => crate::sqlite_write_pool(p, &req, start).await?,
    };
    // generated_keys[0] è la chiave di questa riga (batch=1).
    let key = result.generated_keys.into_iter().next()
        .map(Value::from_json);
    Ok(key)
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
        //eprintln!("[md-write] col='{}' src='{}' val={:?}", c.name, src, val);
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