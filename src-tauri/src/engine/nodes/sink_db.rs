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
/// P349: letti anche dbFunction, keyOperator e keyLogic (prima ignorati:
/// il motore usava sempre `=`/AND e nessuna funzione).
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
    /// P351: colonna dell'identita' del master (identity map del master-detail).
    #[serde(rename = "isHashKey", default)]
    is_hash_key:  bool,
    #[serde(default = "default_true")]
    enabled:      bool,
    #[serde(rename = "sourceField", default)]
    source_field: String,
    #[serde(rename = "dbFunction", default)]
    db_function:  String,
    #[serde(rename = "keyOperator", default)]
    key_operator: Option<String>,
    #[serde(rename = "keyLogic", default)]
    key_logic:    Option<String>,
}

/// P349: funzione SQL di una colonna come la scrive lo studio. Il valore
/// della riga e' `{v}` (`$VALUE` resta accettato); senza segnaposto la
/// funzione e' SQL letterale (es. `NOW()`) e il valore della riga non si usa.
fn column_function(column: &str, expr: &str) -> Option<crate::DbColumnFunction> {
    let e = expr.trim();
    if e.is_empty() { return None }
    Some(crate::DbColumnFunction { column: column.to_string(), expr: e.replace("{v}", "$VALUE") })
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
    /// P382: una riga in buffer aspetta al più questi ms che il lotto si riempia
    /// (0 = solo `batch_size`). Default 1000.
    flush_ms:             u64,
    on_constraint_error:  String,
    pre_sql:              String,
    post_sql:             String,
    merge_condition:      Option<String>,
    dead_letter_table:    Option<String>,
    /// P349: funzioni SQL per colonna (mapping `dbFunction`, sequenza della chiave generata).
    column_functions:     Option<Vec<crate::DbColumnFunction>>,
    /// P349: operatori e AND/OR delle chiavi (mapping `keyOperator`/`keyLogic`).
    key_conditions:       Option<Vec<crate::DbKeyCondition>>,
    /// P349: la chiave del master-detail la genera una funzione (sequenza).
    md_key_function:      bool,
    /// P350: SQL personalizzato o stored procedure (scheda Query).
    custom_sql:           Option<crate::CustomSql>,
    /// P350: stored procedure "una chiamata per lotto" (righe in `{rows}`, JSON).
    proc_per_batch:       bool,
    /// P351: colonne Hash del mapping = identita' del master (identity map).
    hash_cols:            Vec<String>,
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
    /// P345: parametri di connessione per i dialetti ODBC.
    odbc:                 crate::odbc::OdbcTarget,
}

fn default_port(dialect: &str) -> u16 {
    match dialect {
        "mysql"    => 3306,
        "oracle"   => 1521,
        "informix" => 9088,
        _          => 5432,
    }
}

fn opt_nonempty(s: String) -> Option<String> {
    if s.trim().is_empty() { None } else { Some(s) }
}

fn config_from_spec(spec: &Spec) -> Result<SinkDbConfig, String> {
    if !spec.has_resource() {
        return Err("no DB resource connected (select a connection in the node panel)".to_string());
    }

    let dialect = spec.res_str_or("dialect", "postgresql");
    let port    = spec.res_u16_or("port", default_port(&dialect));
    let user = {
        let u = spec.res_str_or("user", "");
        if u.is_empty() { spec.res_str_or("username", "") } else { u }
    };

    // P350: scheda Query. "SQL bulk" (una volta, senza parametri) era un doppione
    // del post-SQL: tolto. Stored procedure "una volta" = una chiamata per LOTTO.
    let query_mode = spec.str_or("customQueryMode", "none");
    let (custom_sql, proc_per_batch) = match query_mode.as_str() {
        "none" | "" => (None, false),
        "bulk_sql" => return Err("'SQL bulk' is no longer available: put the statement in the post-write SQL (it runs once, after the rows)".to_string()),
        "custom_sql" | "stored_proc" => {
            let per_batch = query_mode == "stored_proc"
                && matches!(spec.str_or("storedProcMode", "per_row").as_str(), "once" | "per_batch");
            if query_mode == "stored_proc" && dialect == "sqlite" {
                return Err("SQLite has no stored procedures: use parametrized SQL".to_string());
            }
            let cs = crate::parse_custom_sql(&spec.str_or("customSql", ""))?;
            if per_batch && (cs.fields().is_empty() || cs.fields().iter().any(|f| f != "rows")) {
                return Err("stored procedure once per batch: the call takes the rows of the batch as JSON in {rows} (e.g. CALL load_orders({rows})); no other {field} is allowed".to_string());
            }
            (Some(cs), per_batch)
        }
        other => return Err(format!("unknown query mode '{}'", other)),
    };
    let table = if custom_sql.is_some() {
        spec.str_or("table", "")
    } else {
        spec.str_req("table").map_err(|e| e.to_string())?
    };

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
            "mode '{}' requires at least one key field: in the sink mapping mark one or more columns as 'key' (blue badge), not as PK",
            mode
        ));
    }
    // MERGE (P345): serve una condizione oppure almeno una chiave, altrimenti
    // non c'e' modo di sapere quale riga aggiornare.
    if mode == "merge" && key_fields.is_none() && spec.str_or("mergeCondition", "").trim().is_empty() {
        return Err("mode 'merge' requires a MERGE ON condition or at least one key column in the mapping".to_string());
    }
    // Modalita' sconosciuta: errore SUBITO (prima finiva nel ramo DELETE).
    crate::check_write_mode(&mode, &spec.res_str_or("dialect", "postgresql"))?;
    let exclude_columns = {
        let v = spec.str_list("excludeColumns");
        if v.is_empty() { None } else { Some(v) }
    };

    // P349: operatori/AND-OR delle chiavi e funzioni di colonna dal mapping.
    let key_conditions: Option<Vec<crate::DbKeyCondition>> = {
        let v: Vec<crate::DbKeyCondition> = sink_cols.iter()
            .filter(|c| c.is_key && c.enabled)
            .map(|c| crate::DbKeyCondition {
                column: c.db_column.clone(),
                op:     c.key_operator.clone().filter(|o| !o.trim().is_empty()).unwrap_or_else(|| "=".to_string()),
                logic:  c.key_logic.clone().filter(|l| !l.trim().is_empty()).unwrap_or_else(|| "AND".to_string()),
            })
            .collect();
        if v.is_empty() { None } else { Some(v) }
    };
    crate::check_key_conditions(&mode, &key_conditions)?;
    let hash_cols: Vec<String> = sink_cols.iter()
        .filter(|c| c.enabled && c.is_hash_key)
        .map(|c| c.db_column.clone())
        .collect();
    let mut column_functions: Vec<crate::DbColumnFunction> = sink_cols.iter()
        .filter(|c| c.enabled)
        .filter_map(|c| column_function(&c.db_column, &c.db_function))
        .collect();
    // Un solo {v} per funzione: con i segnaposto `?` (MySQL, SQLite, ODBC)
    // ogni occorrenza vorrebbe un suo valore legato.
    if let Some(f) = column_functions.iter().find(|f| f.expr.matches("$VALUE").count() > 1) {
        return Err(format!("the DB function of column '{}' uses the row value more than once: use {{v}} only once", f.column));
    }

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
        #[serde(rename = "dbFunction", default)]
        db_function:       String,
    }
    let passthrough_md = spec.bool_or("passthroughMasterDetail", false);
    let gk: GenKeyCfg = spec.json_or("generatedKeyConfig", GenKeyCfg::default());
    let md_output_field  = if gk.output_field_name.is_empty() { "__generated_id".to_string() } else { gk.output_field_name };
    let md_source_column = if gk.source_db_column.is_empty()  { "id".to_string() } else { gk.source_db_column };
    // P349: "Sequence (opt.)" della chiave generata (es. nextval('seq'),
    // seq.NEXTVAL): diventa la funzione della colonna chiave, e la chiave
    // torna indietro con RETURNING (Postgres) / RETURNING INTO (Oracle).
    let md_key_function = passthrough_md && !gk.db_function.trim().is_empty();
    if md_key_function {
        column_functions.retain(|f| f.column != md_source_column);
        column_functions.extend(column_function(&md_source_column, &gk.db_function));
    }

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
        flush_ms:             spec.u64_or("flushIntervalMs", 1000),
        on_constraint_error:  spec.str_or("onConstraintError", "stop"),
        pre_sql:              spec.str_or("preSql", ""),
        post_sql:             spec.str_or("postSql", ""),
        merge_condition:      opt_nonempty(spec.str_or("mergeCondition", "")),
        dead_letter_table:    opt_nonempty(spec.str_or("deadLetterTable", "")),
        column_functions:     if column_functions.is_empty() { None } else { Some(column_functions) },
        key_conditions,
        md_key_function,
        custom_sql,
        proc_per_batch,
        hash_cols,
        create_if_not_exists: spec.bool_or("createIfNotExists", false),
        drop_and_create:      spec.bool_or("dropAndCreate", false),
        resource_id:          spec.resource_id(),
        transaction_id:       spec.str_or("transactionId", ""),
        odbc:                 crate::odbc::target_from_spec(spec, &dialect, port, &user),
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

/// Configurazione + controlli + pool (P348: separati da `run` perche' un errore
/// qui deve essere segnalato al gruppo transazionale del nodo).
async fn prepare(
    ctx: &NodeContext,
    tx:  &Option<RowSender>,
) -> Result<(SinkDbConfig, crate::engine::pool::DbPool), String> {
    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;
    let config = config_from_spec(&spec)
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;

    spec.log_unconsumed("sink_db", &ctx.node_id.0);

    // P348: solo stop e skip esistono davvero. "log" e "update" (e la dead
    // letter table) c'erano nello studio ma non nel motore: le righe in errore
    // finivano contate e il run risultava riuscito.
    if !matches!(config.on_constraint_error.as_str(), "stop" | "skip") {
        return Err(format!(
            "sink_db {}: on constraint error '{}' is not available: choose stop or skip",
            ctx.node_id.0, config.on_constraint_error
        ));
    }
    // Master-detail richiede insert/upsert (serve una chiave generata).
    if config.passthrough_md && config.custom_sql.is_some() {
        return Err(format!(
            "sink_db {}: master-detail pass-through needs the generated key of an INSERT: it is not available with custom SQL",
            ctx.node_id.0
        ));
    }
    if config.passthrough_md && !matches!(config.mode.as_str(), "insert" | "upsert" | "truncate_insert") {
        return Err(format!(
            "sink_db {}: master-detail requires insert/upsert mode (not '{}')",
            ctx.node_id.0, config.mode
        ));
    }
    if config.passthrough_md && tx.is_none() {
        ctx.emit_log(&ctx.label, "warn", 0,
            "[sink_db] master-detail active but no downstream node: the enriched rows go nowhere".to_string(), "panel");
    }
    if config.passthrough_md {
        ctx.emit_log(&ctx.label, "info", 0,
            "[sink_db] master-detail: row-by-row write (reduced performance)".to_string(), "panel");
    }

    let resource_id = config.resource_id.clone();
    let conn_str = build_conn_str(&config)?;
    let params = crate::engine::pool::PoolParams {
        dialect:         config.dialect.clone(),
        conn_str,
        max_connections: 5,
        connect_timeout: config.connect_timeout,
    };
    // Retry "prima operazione": se la modalità onError lo prevede, ritenta
    // l'apertura della connessione (risorsa non disponibile all'avvio).
    let pool = match ctx.retry_policy() {
        Some((n, d)) => ctx.lane_resources
            .pool_with_retry(&resource_id, params, n, d,
                             |m| ctx.emit_log(&ctx.label, "warn", 0, m, "panel")).await,
        None         => ctx.lane_resources.pool(&resource_id, params).await,
    }
        .map_err(|e| format!("sink_db {}: {}", ctx.node_id.0, e))?;

    Ok((config, pool))
}

pub async fn run(
    ctx:    NodeContext,
    rx:     RowReceiver,
    tx:     Option<RowSender>,
    ) -> Result<NodeStats, String> {

    // P348: un membro di transazione che fallisce PRIMA di arrivare al gruppo
    // (spec, configurazione, connessione) va comunque segnalato al gruppo:
    // altrimenti gli altri membri committano come se fosse andato tutto bene.
    let tx_of_node = ctx.spec.get("props")
        .and_then(|p| p.get("transactionId"))
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let prepared = prepare(&ctx, &tx).await;
    let (config, pool) = match prepared {
        Ok(x) => x,
        Err(e) => {
            if !tx_of_node.is_empty() {
                ctx.lane_txns.report_member_end(&tx_of_node, false).await;
            }
            return Err(e);
        }
    };
    let resource_id = config.resource_id.clone();

    ctx.emit_connection_opened(&resource_id, &format!("db_{}", config.dialect));

    // Biforcazione: master-detail (riga-per-riga, inoltra) vs batch (default).
    let start = Instant::now();

    // Transazione: se il nodo appartiene a un gruppo, scrive sulla
    // connessione condivisa (BEGIN aperto dal registro); altrimenti
    // percorso normale (autocommit sul pool).
    let tx_group = config.transaction_id.clone();

   let outcome = if !tx_group.is_empty() {
        if let crate::engine::pool::DbPool::Odbc(p) = &pool {
            // P347: gruppi transazionali nativi su Oracle / Informix / ODBC generico.
            if config.passthrough_md {
                write_master_detail_tx_odbc(&ctx, p, &config, rx, tx, &tx_group, &start).await
            } else {
                write_all_tx_odbc(&ctx, p, &config, rx, &tx_group, &start).await
            }
        } else if config.dialect != "postgresql" {
            // P347: il membro fallito va segnalato al gruppo, altrimenti gli
            // altri membri committerebbero (prima usciva senza dirlo).
            ctx.lane_txns.report_member_end(&tx_group, false).await;
            return Err(format!("sink_db {}: transactions are supported on PostgreSQL and ODBC databases (Oracle, Informix), not on {} (for now)", ctx.node_id.0, config.dialect));
        } else if config.passthrough_md {
            // Master-detail DENTRO transazione: riga-per-riga con RETURNING,
            // chunked, lock rilasciato prima di inoltrare (no deadlock col detail).
            write_master_detail_tx(&ctx, &pool, &config, rx, tx, &tx_group, &start).await
        } else {
            write_all_tx(&ctx, &pool, &config, rx, &tx_group, &start).await
        }
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

// ─── P382: lotti con scadenza (near real time) ──────────────────────
// Prima un lotto si scriveva solo quando arrivava a `batch_size` righe o quando
// il flusso finiva. In una lane di servizio (webhook, MQTT, coda…) con poco
// traffico le righe restavano in memoria anche per ore. Ora la prima riga del
// lotto fissa una scadenza (`flushIntervalMs`, default 1000): a scadenza si scrive
// quello che c'è. Nei run a lotti non cambia nulla: il flusso arriva tutto di fila.
enum Recv { Row(Row), Flush, Closed }

async fn recv_or_flush(rx: &mut RowReceiver, deadline: Option<tokio::time::Instant>) -> Recv {
    match deadline {
        Some(d) => match tokio::time::timeout_at(d, rx.recv()).await {
            Ok(Some(r)) => Recv::Row(r),
            Ok(None)    => Recv::Closed,
            Err(_)      => Recv::Flush,
        },
        None => match rx.recv().await {
            Some(r) => Recv::Row(r),
            None    => Recv::Closed,
        },
    }
}

impl SinkDbConfig {
    fn flush_deadline(&self) -> Option<tokio::time::Instant> {
        (self.flush_ms > 0).then(|| tokio::time::Instant::now() + std::time::Duration::from_millis(self.flush_ms))
    }
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

    run_ddl(pool, config).await?;

    if !config.pre_sql.trim().is_empty() {
        exec_pre_post(pool, &config.pre_sql, "Pre-SQL").await?;
    }
    truncate_once(pool, config).await?;

    let mut deadline: Option<tokio::time::Instant> = None;
    loop {
        match recv_or_flush(&mut rx, deadline).await {
            Recv::Row(row) => {
                rows_in += 1;
                batch.push(write_json_row(config, &row));
                if deadline.is_none() { deadline = config.flush_deadline(); }
                if batch.len() < batch_size { continue; }
            }
            Recv::Flush  => {}
            Recv::Closed => break,
        }
        deadline = None;
        {
            let (w, _e) = flush_batch(pool, config, &batch, &row_mode(config)).await?;
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
        let (w, _e) = flush_batch(pool, config, &batch, &row_mode(config)).await?;
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

// ═══ SOSTITUISCE write_all_tx E AGGIUNGE write_master_detail_tx ═══
// in src-tauri/src/engine/nodes/sink_db.rs
//
// MODELLO (deciso con l'utente):
// - Streaming a CHUNK, mai "tutto in memoria": si bufferizzano al più
//   `batch_size` righe, poi si scrive.
// - Per ogni chunk: lock → SAVEPOINT → scrivi → RELEASE/ROLLBACK TO → unlock.
//   Lo stack savepoint è SEMPRE pulito quando il lock viene rilasciato:
//   i membri non intrecciano mai i loro savepoint (era il bug
//   "il punto di salvataggio non esiste").
// - Il lock è rilasciato PRIMA di inoltrare le righe a valle: un master e
//   il suo detail possono stare nello stesso gruppo senza deadlock.
// - Regola tutto-o-niente: se un membro fallisce, il gruppo fa ROLLBACK
//   totale a fine lane. Il savepoint per-chunk serve a non avvelenare la
//   connessione, così ogni membro riporta il SUO vero esito.

// ── Scrittura transazionale a batch (nessun master-detail) ────────
async fn write_all_tx(
    ctx:      &NodeContext,
    pool:     &crate::engine::pool::DbPool,
    config:   &SinkDbConfig,
    mut rx:   RowReceiver,
    group_id: &str,
    start:    &Instant,
) -> Result<(u64, u64, u32), String> {
    use crate::engine::pool::DbPool;

    let pg_pool = match pool {
        DbPool::Pg(p) => p,
        _ => { ctx.lane_txns.report_member_end(group_id, false).await; return Err("transactions: unsupported database for this path".to_string()) }
    };
    // P347: se la connessione del gruppo non si ottiene (gruppo native con due
    // risorse, BEGIN fallito…) il membro e' fallito: va detto al gruppo,
    // altrimenti gli altri membri committerebbero.
    let conn = match ctx.lane_txns.get_pg_conn(group_id, &config.resource_id, pg_pool).await {
        Ok(c) => c,
        Err(e) => { ctx.lane_txns.report_member_end(group_id, false).await; return Err(e); }
    };

    let batch_size = config.batch_size.max(1);
    let sp_name    = savepoint_name(&ctx.node_id.0);

    // DDL + pre-SQL. Se falliscono, il membro è fallito: segnalalo al gruppo
    // (altrimenti il gruppo non lo saprebbe e potrebbe committare).
    if let Err(e) = tx_ddl_and_presql(&conn, config).await {
        ctx.lane_txns.report_member_end(group_id, false).await;
        return Err(e);
    }

    let mut rows_in = 0u64;
    let mut written = 0u64;
    let mut query_count = 0u32;
    let mut last_prog = Instant::now();
    let mut buf: Vec<serde_json::Value> = Vec::with_capacity(batch_size);

    let mut write_result: Result<(), String> = Ok(());

    'outer: loop {
        // 1. Bufferizza fino a batch_size righe (SENZA lock).
        buf.clear();
        let mut deadline: Option<tokio::time::Instant> = None;
        while buf.len() < batch_size {
            match recv_or_flush(&mut rx, deadline).await {
                Recv::Row(row) => {
                    rows_in += 1;
                    buf.push(write_json_row(config, &row));
                    if deadline.is_none() { deadline = config.flush_deadline(); }
                }
                Recv::Flush | Recv::Closed => break, // scadenza o canale chiuso
            }
        }
        if buf.is_empty() { break 'outer; }

        // 2. Scrive il chunk sotto lock, dentro un savepoint che apre e
        //    chiude nello stesso lock: stack sempre pulito all'uscita.
        let chunk_res: Result<u64, String> = {
            let mut guard = conn.lock().await;
            match sqlx::query(crate::sqlsafe::composto(format!("SAVEPOINT {}", sp_name))).execute(&mut **guard).await {
                Ok(_) => {}
                Err(e) => { write_result = Err(format!("SAVEPOINT failed: {}", e)); break 'outer; }
            }
            let req = build_tx_req(config, &buf);
            let r = crate::pg_write_conn(&mut **guard, &req, Instant::now()).await
                .map(|res| batch_written(config, buf.len(), res.rows_written));

            let sp_sql = if r.is_ok() {
                format!("RELEASE SAVEPOINT {}", sp_name)
            } else {
                format!("ROLLBACK TO SAVEPOINT {}", sp_name)
            };
            if let Err(e) = sqlx::query(crate::sqlsafe::composto(sp_sql.as_str())).execute(&mut **guard).await {
                eprintln!("[tx] {} fallito: {}", sp_sql, e);
            }
            r
        }; // lock rilasciato

        match chunk_res {
            Ok(w) => { written += w; query_count += 1; }
            Err(e) => {
                eprintln!("[tx] membro {} fallito (chunk annullato, connessione pulita)", ctx.node_id.0);
                write_result = Err(e);
                break 'outer;
            }
        }

        let should_prog = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if should_prog {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, written, 0, rps);
            last_prog = Instant::now();
        }
    }
// Post-SQL dentro la transazione (solo se le scritture sono riuscite).
    if write_result.is_ok() {
        if let Err(e) = tx_postsql(&conn, config).await {
            write_result = Err(e);
        }
    }
    ctx.lane_txns.report_member_end(group_id, write_result.is_ok()).await;
    write_result?;
    Ok((rows_in, written, query_count))
}

// ── Master-detail DENTRO una transazione ──────────────────────────
// Scrive riga-per-riga con RETURNING (serve la corrispondenza 1:1
// riga↔chiave), bufferizzando a chunk: il lock è preso per il chunk,
// rilasciato prima di inoltrare al detail (che può essere membro dello
// stesso gruppo → senza rilascio ci sarebbe deadlock).
async fn write_master_detail_tx(
    ctx:      &NodeContext,
    pool:     &crate::engine::pool::DbPool,
    config:   &SinkDbConfig,
    mut rx:   RowReceiver,
    tx:       Option<RowSender>,
    group_id: &str,
    start:    &Instant,
) -> Result<(u64, u64, u32), String> {
    use crate::engine::pool::DbPool;

    let pg_pool = match pool {
        DbPool::Pg(p) => p,
        _ => { ctx.lane_txns.report_member_end(group_id, false).await; return Err("transactions: unsupported database for this path".to_string()) }
    };
    // P347: se la connessione del gruppo non si ottiene (gruppo native con due
    // risorse, BEGIN fallito…) il membro e' fallito: va detto al gruppo,
    // altrimenti gli altri membri committerebbero.
    let conn = match ctx.lane_txns.get_pg_conn(group_id, &config.resource_id, pg_pool).await {
        Ok(c) => c,
        Err(e) => { ctx.lane_txns.report_member_end(group_id, false).await; return Err(e); }
    };

    let batch_size = config.batch_size.max(1);
    let sp_name    = savepoint_name(&ctx.node_id.0);
    // DDL + pre-SQL. Se falliscono, il membro è fallito: segnalalo al gruppo
    // (altrimenti il gruppo non lo saprebbe e potrebbe committare).
    if let Err(e) = tx_ddl_and_presql(&conn, config).await {
        ctx.lane_txns.report_member_end(group_id, false).await;
        return Err(e);
    }

    let mut rows_in = 0u64;
    let mut written = 0u64;
    let mut query_count = 0u32;
    let mut last_prog = Instant::now();

    // Buffer: righe ORIGINALI (per l'inoltro) + JSON mappato (per la scrittura).
    let mut buf: Vec<(Row, serde_json::Value)> = Vec::with_capacity(batch_size);
    let mut write_result: Result<(), String> = Ok(());

    let mut idmap = IdentityMap::new(config);   // P351
    'outer: loop {
        buf.clear();
        let mut deadline: Option<tokio::time::Instant> = None;
        while buf.len() < batch_size {
            match recv_or_flush(&mut rx, deadline).await {
                Recv::Row(row) => {
                    rows_in += 1;
                    let json_row = write_json_row(config, &row);
                    buf.push((row, json_row));
                    if deadline.is_none() { deadline = config.flush_deadline(); }
                }
                Recv::Flush | Recv::Closed => break, // scadenza o canale chiuso
            }
        }
        if buf.is_empty() { break 'outer; }

        // Scrive il chunk riga-per-riga con RETURNING, sotto lock.
        // Le righe arricchite vengono accumulate e inoltrate DOPO il rilascio.
        let mut enriched_batch: Vec<Row> = Vec::with_capacity(buf.len());
        let chunk_res: Result<(), String> = {
            let mut guard = conn.lock().await;
            if let Err(e) = sqlx::query(crate::sqlsafe::composto(format!("SAVEPOINT {}", sp_name))).execute(&mut **guard).await {
                write_result = Err(format!("SAVEPOINT failed: {}", e));
                break 'outer;
            }

            let mut res: Result<(), String> = Ok(());
            for (orig_row, json_row) in &buf {
                // P351: identity map (vedi IdentityMap): run, poi database
                let hk = idmap.as_ref().map(|im| im.hash_of(json_row));
                if let (Some(im), Some(h)) = (idmap.as_ref(), hk.as_ref()) {
                    let mut found = im.map.get(h).cloned();
                    if found.is_none() && idmap_lookup_needed(config) {
                        let looked = match idmap_lookup_sql(config, json_row) {
                            Ok((sql, binds)) => idmap_lookup_pg(&mut **guard, &sql, &binds).await,
                            Err(e) => Err(e),
                        };
                        match looked { Ok(k) => found = k, Err(e) => { res = Err(e); break; } }
                    }
                    if let Some(k) = found {
                        if let Some(im) = idmap.as_mut() { im.map.entry(h.clone()).or_insert_with(|| k.clone()); }
                        let mut enriched = orig_row.clone();
                        enriched.set(config.md_output_field.clone(), k);
                        enriched_batch.push(enriched);
                        continue;
                    }
                }
                let md_row  = with_md_key(config, json_row);
            let mut req = build_tx_req(config, std::slice::from_ref(&md_row));
                req.batch_size       = 1;
                req.returning_column = Some(config.md_source_column.clone());

                match crate::pg_write_conn(&mut **guard, &req, Instant::now()).await {
                    Ok(r) => {
                        written += r.rows_written as u64;
                        query_count += 1;
                        let key = r.generated_keys.into_iter().next().map(Value::from_json);
                        if let (Some(im), Some(h), Some(k)) = (idmap.as_mut(), hk, key.as_ref()) {
                            im.map.entry(h).or_insert_with(|| k.clone());
                        }
                        let mut enriched = orig_row.clone();
                        enriched.set(config.md_output_field.clone(), key.unwrap_or(Value::Null));
                        enriched_batch.push(enriched);
                    }
                    Err(e) => { res = Err(e); break; }
                }
            }

            let sp_sql = if res.is_ok() {
                format!("RELEASE SAVEPOINT {}", sp_name)
            } else {
                format!("ROLLBACK TO SAVEPOINT {}", sp_name)
            };
            if let Err(e) = sqlx::query(crate::sqlsafe::composto(sp_sql.as_str())).execute(&mut **guard).await {
                eprintln!("[tx] {} fallito: {}", sp_sql, e);
            }
            res
        }; // lock RILASCIATO: ora il detail può scrivere

        if let Err(e) = chunk_res {
            eprintln!("[tx] master-detail {} fallito (chunk annullato)", ctx.node_id.0);
            write_result = Err(e);
            break 'outer;
        }

        // Inoltra le righe arricchite al nodo a valle (fuori dal lock).
        if let Some(ref tx) = tx {
            for enriched in enriched_batch {
                if tx.send(enriched).await.is_err() { break 'outer; }
            }
        }

        let should_prog = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if should_prog {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, written, 0, rps);
            last_prog = Instant::now();
        }
    }
    if write_result.is_ok() {
        if let Err(e) = tx_postsql(&conn, config).await {
            write_result = Err(e);
        }
    }
    ctx.lane_txns.report_member_end(group_id, write_result.is_ok()).await;
    write_result?;
    Ok((rows_in, written, query_count))
}

// ═══ P347: gruppi transazionali su ODBC (Oracle, Informix, generico) ═══
//
// Stesso modello del percorso Postgres (lotti, lock della connessione
// condivisa, inoltro del master-detail fuori dal lock, esito al registro) con
// tre differenze:
// - DDL FUORI dalla transazione, su una connessione a parte e prima di unirsi
//   al gruppo: Oracle fa COMMIT implicito sulla DDL, che dentro il gruppo
//   confermerebbe anche le righe degli altri membri. Una tabella creata qui
//   NON sparisce con il ROLLBACK del gruppo.
// - truncate_insert svuota con DELETE dentro la transazione (TRUNCATE e' DDL
//   su Oracle → commit implicito; DELETE si annulla col gruppo).
// - niente savepoint: vedi odbc.rs, "Transazioni".

async fn odbc_ddl_outside_tx(p: &crate::odbc::OdbcPool, config: &SinkDbConfig) -> Result<(), String> {
    if !(config.drop_and_create || config.create_if_not_exists) {
        return Ok(());
    }
    let side = p.sibling().await?;
    let r = run_ddl(&crate::engine::pool::DbPool::Odbc(side.clone()), config).await;
    side.close().await;
    r
}

async fn odbc_tx_presql(conn: &crate::odbc::TxConn, config: &SinkDbConfig) -> Result<(), String> {
    if !config.pre_sql.trim().is_empty() {
        crate::odbc::tx_exec(conn, config.pre_sql.clone(), "Pre-SQL".to_string()).await?;
    }
    if config.mode == "truncate_insert" {
        crate::odbc::tx_exec(conn, format!("DELETE FROM {}", qualified_ddl_table(config)), "DELETE (truncate_insert)".to_string()).await?;
    }
    Ok(())
}

async fn odbc_tx_postsql(conn: &crate::odbc::TxConn, config: &SinkDbConfig) -> Result<(), String> {
    if config.post_sql.trim().is_empty() { return Ok(()); }
    crate::odbc::tx_exec(conn, config.post_sql.clone(), "Post-SQL".to_string()).await
}

/// Apertura comune ai due percorsi: DDL fuori, connessione del gruppo, pre-SQL.
/// Su errore il membro e' segnalato fallito al gruppo.
async fn odbc_tx_open(
    ctx:      &NodeContext,
    p:        &crate::odbc::OdbcPool,
    config:   &SinkDbConfig,
    group_id: &str,
) -> Result<crate::odbc::TxConn, String> {
    let opened = async {
        odbc_ddl_outside_tx(p, config).await?;
        let conn = ctx.lane_txns.get_odbc_conn(group_id, &config.resource_id, p).await?;
        odbc_tx_presql(&conn, config).await?;
        Ok::<_, String>(conn)
    }.await;
    if opened.is_err() {
        ctx.lane_txns.report_member_end(group_id, false).await;
    }
    opened
}

async fn write_all_tx_odbc(
    ctx:      &NodeContext,
    p:        &crate::odbc::OdbcPool,
    config:   &SinkDbConfig,
    mut rx:   RowReceiver,
    group_id: &str,
    start:    &Instant,
) -> Result<(u64, u64, u32), String> {
    let conn = odbc_tx_open(ctx, p, config, group_id).await?;
    let batch_size = config.batch_size.max(1);
    let (mut rows_in, mut written, mut query_count) = (0u64, 0u64, 0u32);
    let mut last_prog = Instant::now();
    let mut buf: Vec<serde_json::Value> = Vec::with_capacity(batch_size);
    let mut write_result: Result<(), String> = Ok(());

    loop {
        buf.clear();
        let mut deadline: Option<tokio::time::Instant> = None;
        while buf.len() < batch_size {
            match recv_or_flush(&mut rx, deadline).await {
                Recv::Row(row) => {
                    rows_in += 1;
                    buf.push(write_json_row(config, &row));
                    if deadline.is_none() { deadline = config.flush_deadline(); }
                }
                Recv::Flush | Recv::Closed => break, // scadenza o canale chiuso
            }
        }
        if buf.is_empty() { break; }
        match crate::odbc::tx_write(&conn, &build_tx_req(config, &buf), Instant::now()).await {
            Ok(r) => { written += batch_written(config, buf.len(), r.rows_written); query_count += 1; }
            Err(e) => {
                eprintln!("[tx] membro {} fallito (ODBC)", ctx.node_id.0);
                write_result = Err(e);
                break;
            }
        }
        let should_prog = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if should_prog {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, written, 0, rps);
            last_prog = Instant::now();
        }
    }
    if write_result.is_ok() {
        if let Err(e) = odbc_tx_postsql(&conn, config).await { write_result = Err(e); }
    }
    ctx.lane_txns.report_member_end(group_id, write_result.is_ok()).await;
    write_result?;
    Ok((rows_in, written, query_count))
}

async fn write_master_detail_tx_odbc(
    ctx:      &NodeContext,
    p:        &crate::odbc::OdbcPool,
    config:   &SinkDbConfig,
    mut rx:   RowReceiver,
    tx:       Option<RowSender>,
    group_id: &str,
    start:    &Instant,
) -> Result<(u64, u64, u32), String> {
    let conn = odbc_tx_open(ctx, p, config, group_id).await?;
    let batch_size = config.batch_size.max(1);
    let (mut rows_in, mut written, mut query_count) = (0u64, 0u64, 0u32);
    let mut last_prog = Instant::now();
    let mut buf: Vec<(Row, serde_json::Value)> = Vec::with_capacity(batch_size);
    let mut write_result: Result<(), String> = Ok(());

    let mut idmap = IdentityMap::new(config);   // P351
    'outer: loop {
        buf.clear();
        let mut deadline: Option<tokio::time::Instant> = None;
        while buf.len() < batch_size {
            match recv_or_flush(&mut rx, deadline).await {
                Recv::Row(row) => {
                    rows_in += 1;
                    let json_row = write_json_row(config, &row);
                    buf.push((row, json_row));
                    if deadline.is_none() { deadline = config.flush_deadline(); }
                }
                Recv::Flush | Recv::Closed => break, // scadenza o canale chiuso
            }
        }
        if buf.is_empty() { break; }

        // Riga per riga (serve la corrispondenza 1:1 riga↔chiave); le righe
        // arricchite si inoltrano dopo il lotto: il detail, se e' membro dello
        // stesso gruppo, scrive sulla stessa connessione e vede i master.
        let mut enriched_batch: Vec<Row> = Vec::with_capacity(buf.len());
        for (orig_row, json_row) in &buf {
            // P351: identity map (vedi IdentityMap): run, poi database (stessa connessione)
            let hk = idmap.as_ref().map(|im| im.hash_of(json_row));
            if let (Some(im), Some(h)) = (idmap.as_ref(), hk.as_ref()) {
                let mut found = im.map.get(h).cloned();
                if found.is_none() && idmap_lookup_needed(config) {
                    let looked = match idmap_lookup_sql(config, json_row) {
                        Ok((sql, binds)) => crate::odbc::tx_lookup_key(&conn, sql, binds).await.map(|o| o.map(Value::from_json)),
                        Err(e) => Err(e),
                    };
                    match looked { Ok(k) => found = k, Err(e) => { write_result = Err(e); break 'outer; } }
                }
                if let Some(k) = found {
                    if let Some(im) = idmap.as_mut() { im.map.entry(h.clone()).or_insert_with(|| k.clone()); }
                    let mut enriched = orig_row.clone();
                    enriched.set(config.md_output_field.clone(), k);
                    enriched_batch.push(enriched);
                    continue;
                }
            }
            let md_row  = with_md_key(config, json_row);
            let mut req = build_tx_req(config, std::slice::from_ref(&md_row));
            req.batch_size       = 1;
            req.returning_column = Some(config.md_source_column.clone());
            match crate::odbc::tx_write(&conn, &req, Instant::now()).await {
                Ok(r) => {
                    written += r.rows_written as u64;
                    query_count += 1;
                    let key = r.generated_keys.into_iter().next().map(Value::from_json);
                    if let (Some(im), Some(h), Some(k)) = (idmap.as_mut(), hk, key.as_ref()) {
                        im.map.entry(h).or_insert_with(|| k.clone());
                    }
                    let mut enriched = orig_row.clone();
                    enriched.set(config.md_output_field.clone(), key.unwrap_or(Value::Null));
                    enriched_batch.push(enriched);
                }
                Err(e) => {
                    eprintln!("[tx] master-detail {} fallito (ODBC)", ctx.node_id.0);
                    write_result = Err(e);
                    break 'outer;
                }
            }
        }
        if let Some(ref tx) = tx {
            for enriched in enriched_batch {
                if tx.send(enriched).await.is_err() { break 'outer; }
            }
        }
        let should_prog = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if should_prog {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, written, 0, rps);
            last_prog = Instant::now();
        }
    }
    if write_result.is_ok() {
        if let Err(e) = odbc_tx_postsql(&conn, config).await { write_result = Err(e); }
    }
    ctx.lane_txns.report_member_end(group_id, write_result.is_ok()).await;
    write_result?;
    Ok((rows_in, written, query_count))
}

// Nome savepoint valido come identificatore SQL.
fn savepoint_name(node_id: &str) -> String {
    format!("sp_{}", node_id.replace(|c: char| !c.is_alphanumeric() && c != '_', "_"))
}

// DDL + pre-SQL di un membro, eseguiti sulla SUA connessione transazionale.
// In PostgreSQL la DDL è transazionale: se il gruppo fa rollback, la tabella
// creata sparisce (coerente con la regola tutto-o-niente).
// NB: Oracle/MySQL fanno commit implicito sulla DDL → servirà una variante
// che la esegue fuori transazione (vedi TODO).
async fn tx_ddl_and_presql(
    conn:   &std::sync::Arc<tokio::sync::Mutex<sqlx::pool::PoolConnection<sqlx::Postgres>>>,
    config: &SinkDbConfig,
    ) -> Result<(), String> {
    let needs_ddl = config.drop_and_create || config.create_if_not_exists;
    let truncate = config.mode == "truncate_insert";
    if !needs_ddl && config.pre_sql.trim().is_empty() && !truncate {
        return Ok(());
    }
    let mut guard = conn.lock().await;

    if config.drop_and_create {
        let drop = format!("DROP TABLE IF EXISTS {} CASCADE", qualified_ddl_table(config));
        eprintln!("[tx][ddl] {}", drop);
        sqlx::query(crate::sqlsafe::autore(drop.as_str())).execute(&mut **guard).await
            .map_err(|e| format!("DROP TABLE failed: {}", e))?;
    }
    if needs_ddl {
        if let Some(ddl) = build_create_table(config, true) {
            eprintln!("[tx][ddl] CREATE TABLE {}", qualified_ddl_table(config));
            sqlx::query(crate::sqlsafe::autore(ddl.as_str())).execute(&mut **guard).await
                .map_err(|e| format!("CREATE TABLE failed: {}", e))?;
        }
    }
    if !config.pre_sql.trim().is_empty() {
        for stmt in config.pre_sql.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
            sqlx::query(crate::sqlsafe::autore(stmt)).execute(&mut **guard).await
                .map_err(|e| format!("Pre-SQL failed: {}", e))?;
        }
    }
    // P345: prima truncate_insert in transazione NON svuotava la tabella.
    // TRUNCATE in Postgres è transazionale: un ROLLBACK del gruppo la annulla.
    if truncate {
        let t = format!("TRUNCATE TABLE {}", qualified_ddl_table(config));
        sqlx::query(crate::sqlsafe::autore(t.as_str())).execute(&mut **guard).await
            .map_err(|e| format!("TRUNCATE failed: {}", e))?;
    }
    Ok(())
}

// Post-SQL di un membro, dentro la transazione, a fine scritture.
async fn tx_postsql(
    conn:   &std::sync::Arc<tokio::sync::Mutex<sqlx::pool::PoolConnection<sqlx::Postgres>>>,
    config: &SinkDbConfig,
) -> Result<(), String> {
    if config.post_sql.trim().is_empty() { return Ok(()); }
    let mut guard = conn.lock().await;
    for stmt in config.post_sql.split(';').map(|s| s.trim()).filter(|s| !s.is_empty()) {
        sqlx::query(crate::sqlsafe::autore(stmt)).execute(&mut **guard).await
            .map_err(|e| format!("Post-SQL failed: {}", e))?;
    }
    Ok(())
}

// Costruisce la DbWriteRequest per un batch transazionale.
fn build_tx_req(config: &SinkDbConfig, batch: &[serde_json::Value]) -> crate::DbWriteRequest {
    crate::DbWriteRequest {
        connection:          build_db_connection_params(config),
        table:               config.table.clone(),
        schema:              config.schema_name.clone(),
        mode:                row_mode(config),
        rows:                request_rows(config, batch),
        key_fields:          config.key_fields.clone(),
        columns:             None,
        exclude_columns:     config.exclude_columns.clone(),
        column_functions:    config.column_functions.clone(),
        key_conditions:      config.key_conditions.clone(),
        merge_condition:     config.merge_condition.clone(),
        pre_sql:             None,
        post_sql:            None,
        batch_size:          batch.len(),
        on_constraint_error: config.on_constraint_error.clone(),
        dead_letter_table:   config.dead_letter_table.clone(),
        returning_column:    None,
        custom_sql:          config.custom_sql.clone(),
    }
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
        mode:                row_mode(config),
        rows:                request_rows(config, batch),
        key_fields:          config.key_fields.clone(),
        columns:             None,
        exclude_columns:     config.exclude_columns.clone(),
        column_functions:    config.column_functions.clone(),
        key_conditions:      config.key_conditions.clone(),
        merge_condition:     config.merge_condition.clone(),
        pre_sql:             None,
        post_sql:            None,
        batch_size:          batch.len(),
        on_constraint_error: config.on_constraint_error.clone(),
        dead_letter_table:   config.dead_letter_table.clone(),
        returning_column:    None,
        custom_sql:          config.custom_sql.clone(),
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
    run_ddl(pool, config).await?;
    if !config.pre_sql.trim().is_empty() {
        exec_pre_post(pool, &config.pre_sql, "Pre-SQL").await?;
    }
    truncate_once(pool, config).await?;

    let mut idmap = IdentityMap::new(config);
    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let json_row = write_json_row(config, &row);

        // P351: master gia' visto nel run, o gia' presente nel database → si
        // riusa la sua chiave senza riscriverlo.
        let hk = idmap.as_ref().map(|im| im.hash_of(&json_row));
        let mut key: Option<Value> = None;
        let mut known = false;
        if let (Some(im), Some(h)) = (idmap.as_ref(), hk.as_ref()) {
            if let Some(k) = im.map.get(h) { key = Some(k.clone()); known = true; }
            else if idmap_lookup_needed(config) {
                let (sql, binds) = idmap_lookup_sql(config, &json_row)?;
                if let Some(k) = idmap_lookup(pool, &sql, &binds).await? { key = Some(k); known = true; }
            }
        }
        if !known {
            // Scrive questa singola riga con RETURNING della colonna chiave.
            key = flush_one_returning(pool, config, &json_row, &config.md_source_column).await?;
            written += 1;
        }
        if let (Some(im), Some(h), Some(k)) = (idmap.as_mut(), hk, key.as_ref()) {
            im.map.entry(h).or_insert_with(|| k.clone());
        }

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

/// P350: riga da scrivere. Con l'SQL personalizzato `{campo}` legge i campi
/// della riga in ingresso (la scheda Mapping non si usa); altrimenti il mapping.
fn write_json_row(config: &SinkDbConfig, row: &Row) -> serde_json::Value {
    if config.custom_sql.is_some() || config.columns_ddl.is_empty() {
        row.to_write_json_object()
    } else {
        map_row(row, &config.columns_ddl)
    }
}

/// P350: righe della richiesta. Stored procedure "per lotto": UNA riga col solo
/// campo `rows` = il lotto in JSON (Decimal esatti), legato come JSON.
fn request_rows(config: &SinkDbConfig, batch: &[serde_json::Value]) -> Vec<serde_json::Value> {
    if !config.proc_per_batch || batch.is_empty() {
        return batch.to_vec();
    }
    let mut text = String::new();
    crate::json_text_exact(&serde_json::Value::Array(batch.to_vec()), &mut text);
    let mut marker = serde_json::Map::new();
    marker.insert(crate::JSON_MARKER.to_string(), serde_json::Value::String(text));
    let mut row = serde_json::Map::new();
    row.insert("rows".to_string(), serde_json::Value::Object(marker));
    vec![serde_json::Value::Object(row)]
}

/// Righe in ingresso scritte da un lotto: per la stored procedure per lotto la
/// chiamata riuscita vale tutte le righe del lotto.
fn batch_written(config: &SinkDbConfig, batch_len: usize, rows_written: usize) -> u64 {
    if config.proc_per_batch { if rows_written > 0 { batch_len as u64 } else { 0 } } else { rows_written as u64 }
}

// ─── Identity map del master-detail (P351) ────────────────────────
//
// Sorgente "piatta" (una riga per riga d'ordine, dati del cliente ripetuti):
// le colonne Hash del mapping identificano il master. Il primo master con
// quei valori si scrive, gli altri riusano la sua chiave e ogni detail esce
// con la chiave giusta. Tra un run e l'altro (decisione utente) la verita' e'
// il DATABASE: in modalita' INSERT un master nuovo per il run si cerca prima
// nella tabella sulle colonne Hash e si inserisce solo se non c'e' (niente
// stato salvato, niente "reset su rollback": in transazione la stessa
// connessione vede i master appena scritti, e il rollback non lascia nulla).
// In UPSERT il master si scrive una volta per run (l'upsert gia' aggiorna o
// inserisce). Serve un vincolo UNIQUE sulle colonne Hash, altrimenti due run
// in parallelo possono inserire lo stesso master.

struct IdentityMap {
    cols: Vec<String>,
    map:  std::collections::HashMap<String, Value>,
}

impl IdentityMap {
    fn new(config: &SinkDbConfig) -> Option<IdentityMap> {
        if !config.passthrough_md || config.hash_cols.is_empty() { return None }
        Some(IdentityMap { cols: config.hash_cols.clone(), map: std::collections::HashMap::new() })
    }
    fn hash_of(&self, json_row: &serde_json::Value) -> String {
        let vals: Vec<&serde_json::Value> = self.cols.iter()
            .map(|c| json_row.get(c.as_str()).unwrap_or(&serde_json::Value::Null))
            .collect();
        serde_json::to_string(&vals).unwrap_or_default()
    }
}

/// Il master va cercato nel database prima di scriverlo? (solo INSERT)
fn idmap_lookup_needed(config: &SinkDbConfig) -> bool {
    config.mode == "insert"
}

/// SELECT della chiave del master sulle colonne Hash (`IS NULL` per i valori
/// nulli), con le stesse funzioni di colonna della scrittura.
fn idmap_lookup_sql(config: &SinkDbConfig, json_row: &serde_json::Value) -> Result<(String, Vec<serde_json::Value>), String> {
    let fields: Vec<(String, serde_json::Value)> = config.hash_cols.iter()
        .map(|c| (c.clone(), json_row.get(c.as_str()).cloned().unwrap_or(serde_json::Value::Null)))
        .collect();
    let conds = Some(fields.iter().map(|(c, v)| crate::DbKeyCondition {
        column: c.clone(),
        op:     if v.is_null() { "IS NULL".to_string() } else { "=".to_string() },
        logic:  "AND".to_string(),
    }).collect::<Vec<_>>());
    let style = if config.dialect == "postgresql" { crate::PlaceholderStyle::Dollar } else { crate::PlaceholderStyle::Question };
    let mysql = config.dialect == "mysql";
    let quote = move |k: &str| if mysql { format!("`{}`", k) } else { k.to_string() };
    let (w, binds) = crate::where_plan(&config.hash_cols, &conds, &fields, &config.column_functions, style, 1, &quote)?;
    let binds: Vec<serde_json::Value> = binds.into_iter().cloned().collect();
    Ok((format!("SELECT {} FROM {} WHERE {}", quote(&config.md_source_column), qualified_ddl_table(config), w), binds))
}

async fn idmap_lookup_pg<'e, E>(ex: E, sql: &str, binds: &[serde_json::Value]) -> Result<Option<Value>, String>
where E: sqlx::Executor<'e, Database = sqlx::Postgres> {
    let mut q = sqlx::query(crate::sqlsafe::composto(sql.to_string()));
    for v in binds { q = crate::bind_pg_value(q, v); }
    let row = q.fetch_optional(ex).await.map_err(|e| format!("identity map lookup failed: {}", e))?;
    Ok(row.map(|r| Value::from_json(crate::pg_row_to_json_value(&r, 0))))
}

/// Ricerca del master fuori transazione, sul pool della risorsa.
async fn idmap_lookup(pool: &crate::engine::pool::DbPool, sql: &str, binds: &[serde_json::Value]) -> Result<Option<Value>, String> {
    use crate::engine::pool::DbPool;
    use sqlx::Row as _;
    // valori semplici delle colonne Hash: testo, numeri, booleani, decimali, NULL
    fn plain(v: &serde_json::Value) -> Option<String> {
        match v {
            serde_json::Value::Null => None,
            serde_json::Value::String(s) => Some(s.clone()),
            other => Some(crate::json_decimal(other).map(String::from).unwrap_or_else(|| other.to_string())),
        }
    }
    match pool {
        DbPool::Pg(p) => idmap_lookup_pg(p, sql, binds).await,
        DbPool::My(p) => {
            let mut q = sqlx::query(crate::sqlsafe::composto(sql.to_string()));
            for v in binds { q = q.bind(plain(v)); }
            let row = q.fetch_optional(p).await.map_err(|e| format!("identity map lookup failed: {}", e))?;
            Ok(row.map(|r| r.try_get::<i64, _>(0).map(Value::Int)
                .or_else(|_| r.try_get::<u64, _>(0).map(|u| Value::Int(u as i64)))
                .or_else(|_| r.try_get::<String, _>(0).map(Value::String))
                .unwrap_or(Value::Null)))
        }
        DbPool::Sqlite(p) => {
            let mut q = sqlx::query(crate::sqlsafe::composto(sql.to_string()));
            for v in binds {
                q = match v {
                    serde_json::Value::Number(n) if n.is_i64() => q.bind(n.as_i64()),
                    other => q.bind(plain(other)),
                };
            }
            let row = q.fetch_optional(p).await.map_err(|e| format!("identity map lookup failed: {}", e))?;
            Ok(row.map(|r| r.try_get::<i64, _>(0).map(Value::Int)
                .or_else(|_| r.try_get::<String, _>(0).map(Value::String))
                .unwrap_or(Value::Null)))
        }
        DbPool::Odbc(p) => crate::odbc::lookup_key(p, sql.to_string(), binds.to_vec()).await
            .map(|o| o.map(Value::from_json)),
    }
}

/// P349: con la chiave generata da una sequenza la colonna chiave deve
/// comparire nell'INSERT anche se il mapping non la porta: vale la funzione.
fn with_md_key(config: &SinkDbConfig, row: &serde_json::Value) -> serde_json::Value {
    let mut r = row.clone();
    if config.md_key_function {
        if let Some(o) = r.as_object_mut() {
            o.entry(config.md_source_column.clone()).or_insert(serde_json::Value::Null);
        }
    }
    r
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
        mode:                row_mode(config),
        rows:                vec![with_md_key(config, row)],
        key_fields:          config.key_fields.clone(),
        columns:             None,
        exclude_columns:     config.exclude_columns.clone(),
        column_functions:    config.column_functions.clone(),
        key_conditions:      config.key_conditions.clone(),
        merge_condition:     config.merge_condition.clone(),
        pre_sql:             None,
        post_sql:            None,
        batch_size:          1,
        on_constraint_error: config.on_constraint_error.clone(),
        dead_letter_table:   config.dead_letter_table.clone(),
        returning_column:    Some(ret_col.to_string()),
        custom_sql:          None,
    };

    let start = Instant::now();
    use crate::engine::pool::DbPool;
    let result = match pool {
        DbPool::Pg(p)     => crate::pg_write_pool(p, &req, start).await?,
        DbPool::My(p)     => crate::mysql_write_pool(p, &req, start).await?,
        DbPool::Sqlite(p) => crate::sqlite_write_pool(p, &req, start).await?,
        DbPool::Odbc(p)   => crate::odbc::write(p, &req, start).await?,
    };
    // generated_keys[0] è la chiave di questa riga (batch=1).
    let key = result.generated_keys.into_iter().next()
        .map(Value::from_json);
    Ok(key)
}
// ─── truncate_insert: svuota UNA volta, poi solo INSERT ──────────
//
// P345 🐞: la modalità arrivava tale e quale a ogni lotto, e ogni lotto
// rifaceva TRUNCATE → restava solo l'ultimo lotto (2500 righe con lotti
// da 1000 → 500 in tabella, run "riuscito"); nel master-detail una riga
// sola. Ora il TRUNCATE (DELETE su SQLite) si fa qui, una volta, con un
// lotto vuoto — così la sintassi per dialetto resta quella di lib.rs/odbc.rs
// e la tabella si svuota anche senza righe in ingresso — e i lotti
// viaggiano come INSERT.
fn row_mode(config: &SinkDbConfig) -> String {
    if config.mode == "truncate_insert" { "insert".to_string() } else { config.mode.clone() }
}

async fn truncate_once(pool: &crate::engine::pool::DbPool, config: &SinkDbConfig) -> Result<(), String> {
    if config.mode != "truncate_insert" { return Ok(()) }
    flush_batch(pool, config, &[], "truncate_insert").await.map(|_| ())
}

// ─── Flush un batch di righe usando le funzioni esistenti di lib.rs ──

async fn flush_batch(
    pool:   &crate::engine::pool::DbPool,
    config:   &SinkDbConfig,
    batch:    &[serde_json::Value],
    mode:     &str,
) -> Result<(u64, u64), String> {

    // Costruisce DbWriteRequest — il formato che pg_write si aspetta
    let req = crate::DbWriteRequest {
        connection:          build_db_connection_params(config),
        table:               config.table.clone(),
        schema:              config.schema_name.clone(),
        mode:                mode.to_string(),
        rows:                request_rows(config, batch),
        key_fields:          config.key_fields.clone(),
        columns:             None,
        exclude_columns:     config.exclude_columns.clone(),
        column_functions:    config.column_functions.clone(),
        key_conditions:      config.key_conditions.clone(),
        merge_condition:     config.merge_condition.clone(),
        pre_sql:             None,   // già eseguito una volta sopra
        post_sql:            None,
        batch_size:          batch.len(),
        on_constraint_error: config.on_constraint_error.clone(),
        dead_letter_table:   config.dead_letter_table.clone(),
        returning_column:    None,
        custom_sql:          config.custom_sql.clone(),
    };

    let start = Instant::now();
      use crate::engine::pool::DbPool;
    let result = match pool {
        DbPool::Pg(p)     => crate::pg_write_pool(p, &req, start).await?,
        DbPool::My(p)     => crate::mysql_write_pool(p, &req, start).await?,
        DbPool::Sqlite(p) => crate::sqlite_write_pool(p, &req, start).await?,
        DbPool::Odbc(p)   => crate::odbc::write(p, &req, start).await?,
    };

    Ok((batch_written(config, batch.len(), result.rows_written), result.rows_errors as u64))
}

// ─── Scrittura: applica il mapping sorgente → colonna ─────────────

/// Costruisce l'oggetto JSON da scrivere prendendo, per ogni colonna
/// mappata, il valore di `source` (sourceField) dalla riga e mettendolo
/// sotto `name` (dbColumn). Filtra alle sole colonne mappate e rinomina.
fn map_row(row: &Row, cols: &[ColumnDdl]) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    for c in cols {
        let src = if c.source.is_empty() { c.name.as_str() } else { c.source.as_str() };
        let val = row.get(src).map(|v| v.to_write_json()).unwrap_or(serde_json::Value::Null);
        //if c.name == "id" {
        //    eprintln!("[diag] col='id' src='{}' val={:?}", src, val);
        //}
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
fn build_create_table(config: &SinkDbConfig, allow_if_not_exists: bool) -> Option<String> {
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

    let if_not_exists = if allow_if_not_exists && config.create_if_not_exists && !config.drop_and_create {
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
        d if crate::odbc::is_odbc_dialect(d) => crate::odbc::connection_string(&config.odbc),
        d => Err(format!("Dialect '{}' not supported", d)),
    }
}

/// DDL dal mapping (creazione / ricreazione della tabella), prima di scrivere.
/// PostgreSQL: `DROP … IF EXISTS … CASCADE` e `CREATE TABLE IF NOT EXISTS`.
/// ODBC (P345): niente IF [NOT] EXISTS portabile → si verifica l'esistenza con
/// una SELECT che non legge righe, poi DROP / CREATE semplici. I tipi delle
/// colonne sono quelli del mapping (nella lingua del database di destinazione).
async fn run_ddl(pool: &crate::engine::pool::DbPool, config: &SinkDbConfig) -> Result<(), String> {
    if !(config.drop_and_create || config.create_if_not_exists) {
        return Ok(());
    }
    // P346: MySQL e SQLite prima saltavano la DDL (solo un eprintln) e il
    // nodo falliva poi con "no such table". Entrambi hanno IF [NOT] EXISTS.
    if matches!(config.dialect.as_str(), "postgresql" | "mysql" | "sqlite") {
        if config.drop_and_create {
            let cascade = if config.dialect == "postgresql" { " CASCADE" } else { "" };
            let drop = format!("DROP TABLE IF EXISTS {}{}", qualified_ddl_table(config), cascade);
            exec_pre_post(pool, &drop, "DROP TABLE").await?;
        }
        if let Some(ddl) = build_create_table(config, true) {
            exec_pre_post(pool, &ddl, "CREATE TABLE").await?;
        }
    } else if let crate::engine::pool::DbPool::Odbc(p) = pool {
        let tbl = qualified_ddl_table(config);
        let exists = crate::odbc::table_exists(p, tbl.clone()).await?;
        if config.drop_and_create && exists {
            exec_pre_post(pool, &format!("DROP TABLE {}", tbl), "DROP TABLE").await?;
        }
        if config.drop_and_create || !exists {
            if let Some(ddl) = build_create_table(config, false) {
                exec_pre_post(pool, &ddl, "CREATE TABLE").await?;
            }
        }
    } else {
        eprintln!("[sink_db] DDL saltata: dialetto '{}' non ancora supportato", config.dialect);
    }
    Ok(())
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
        driver:            None,
        dsn:               None,
        connection_string: None,
        odbc_params:       None,
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
            DbPool::Pg(p)     => sqlx::query(crate::sqlsafe::autore(stmt.to_string())).execute(p).await.map(|_| ()).map_err(|e| e.to_string()),
            DbPool::My(p)     => sqlx::query(crate::sqlsafe::autore(stmt.to_string())).execute(p).await.map(|_| ()).map_err(|e| e.to_string()),
            DbPool::Sqlite(p) => sqlx::query(crate::sqlsafe::autore(stmt.to_string())).execute(p).await.map(|_| ()).map_err(|e| e.to_string()),
            DbPool::Odbc(p)   => crate::odbc::exec_sql(p, stmt.to_string(), String::new()).await,
        };
        res.map_err(|e| format!("{} failed: {}", label, e))?;
    }
    Ok(())
}
#[cfg(test)]
mod flush_tests {
    use super::*;
    use tokio::sync::mpsc;

    /// P382: una riga sola in attesa non resta nel buffer oltre la scadenza.
    #[tokio::test]
    async fn la_scadenza_scrive_il_lotto_parziale() {
        let (tx, mut rx) = mpsc::channel::<Row>(8);
        tx.send(Row::new()).await.unwrap();
        // prima riga: arriva subito
        assert!(matches!(recv_or_flush(&mut rx, None).await, Recv::Row(_)));
        // nessun'altra riga: alla scadenza si scrive quello che c'è
        let t = tokio::time::Instant::now();
        let d = Some(t + std::time::Duration::from_millis(30));
        assert!(matches!(recv_or_flush(&mut rx, d).await, Recv::Flush));
        assert!(t.elapsed() >= std::time::Duration::from_millis(30));
        // canale chiuso: Closed, anche con scadenza
        drop(tx);
        assert!(matches!(recv_or_flush(&mut rx, d).await, Recv::Closed));
    }
}
