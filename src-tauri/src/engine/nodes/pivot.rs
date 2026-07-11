// ─── src-tauri/src/engine/nodes/pivot.rs ───────────────────────────
//
// PIVOT   (righe → colonne): raggruppa per identità; i valori distinti di
//         un campo diventano colonne, aggregando un campo valore.
//
//              cliente | mese | importo          cliente | gen | feb
//              --------|------|--------    →     --------|-----|-----
//              Rossi   | gen  | 100              Rossi   | 100 | 150
//              Rossi   | feb  | 150
//
// UNPIVOT (colonne → righe): l'inverso. Le colonne scelte diventano coppie
//         chiave/valore; le altre restano fisse su ogni riga generata.
//
// Materializza per necessità: il pivot deve vedere tutte le righe per
// raggruppare, e in modalità dinamica per scoprire quali colonne creare.
//
// SORGENTE (dataSource), come `window`:
//   flow        — bufferizza le righe dell'input
//   materialize — l'input è un trigger (scartato); le righe vengono da un
//                 dataset pubblicato nella lane. Senza arco in ingresso,
//                 il nodo si sblocca quando il dataset è pubblicato.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config ────────────────────────────────────────────────────────
//
// Migrato alla spec (Fase 12). Nessuna compilazione FPEL → tutto dalle
// props (node-spec §10). Scalari via accessor; le liste strutturate
// (pivot_columns, unpivot_columns) come JSON-string via json_or, il
// pattern di compositeKeys del join. `nullValue` è tipizzato QUI dal
// motore (non più dal builder): props verbatim, motore interpreta.

#[derive(Deserialize)]
struct PivotColumn {
    /// valore del campo pivot che questa colonna rappresenta
    value: String,
    /// nome della colonna in uscita (se vuoto, si usa `value`)
    #[serde(default)]
    alias: String,
}

struct PivotConfig {
    mode: String,          // pivot | unpivot
    data_source: String,   // flow | materialize
    materialize_name: String,

    // ── pivot ──
    identity_field: Vec<String>,   // campi identità: il GROUP BY
    pivot_field: String,           // i valori di questo campo diventano colonne
    value_field: String,           // il campo da aggregare nelle celle
    agg_fn: String,
    pivot_type: String,            // static | dynamic
    pivot_columns: Vec<PivotColumn>,
    pivot_sort: String,            // asc | desc | natural
    null_value: Value,             // valore delle celle senza dati (tipizzato qui)
    add_row_total: bool,

    // ── unpivot ──
    unpivot_columns: Vec<String>,
    unpivot_key_field: String,
    unpivot_value_field: String,
    unpivot_null_mode: String,  // include | exclude | zero
    unpivot_order: String,      // identity_first | key_first
}

/// Tipizza il valore-cella-vuota: props lo porta come stringa verbatim,
/// il motore deduce int/float/bool/stringa (parsing lassista, come fanno
/// gli altri nodi migrati). Vuoto → Null.
fn typed_null(raw: &str) -> Value {
    let s = raw.trim();
    if s.is_empty() { return Value::Null; }
    if let Ok(i) = s.parse::<i64>()  { return Value::Int(i); }
    if let Ok(f) = s.parse::<f64>()  { return Value::Float(f); }
    match s {
        "true"  => Value::Bool(true),
        "false" => Value::Bool(false),
        _       => Value::String(s.to_string()),
    }
}

fn config_from_spec(spec: &Spec) -> Result<PivotConfig, String> {
    // Liste strutturate: JSON-string nelle props → deserializza.
    let pivot_columns: Vec<PivotColumn> = spec.json_or("pivotColumns", Vec::new());
    let unpivot_columns: Vec<String>    = spec.json_or("unpivotColumns", Vec::new());

    Ok(PivotConfig {
        mode:             spec.str_or("pivotMode",  "pivot"),
        data_source:      spec.str_or("dataSource", "flow"),
        materialize_name: spec.str_or("materializeName", ""),

        identity_field:   spec.str_list("identityField"),
        pivot_field:      spec.str_or("pivotField", ""),
        value_field:      spec.str_or("valueField", ""),
        agg_fn:           spec.str_or("aggFn",      "sum"),
        pivot_type:       spec.str_or("pivotType",  "static"),
        pivot_columns,
        pivot_sort:       spec.str_or("pivotSort",  "asc"),
        null_value:       typed_null(&spec.str_or("nullValue", "")),
        add_row_total:    spec.bool_or("addRowTotal", false),

        unpivot_columns,
        unpivot_key_field:   spec.str_or("unpivotKeyField",   "chiave"),
        unpivot_value_field: spec.str_or("unpivotValueField", "valore"),
        unpivot_null_mode:   spec.str_or("unpivotNullMode",   "include"),
        unpivot_order:       spec.str_or("unpivotOrder",      "identity_first"),
    })
}

// ─── Esecuzione ────────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  RowSender,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("pivot {}: {}", ctx.node_id.0, e))?;
    let cfg = config_from_spec(&spec)
        .map_err(|e| format!("pivot {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("pivot", &ctx.node_id.0);

    // Validazioni (doppio strato: il builder le fa a design-time, il
    // motore le ri-valida come errori parlanti per l'esecuzione headless).
    if cfg.mode == "pivot" && (cfg.pivot_field.is_empty() || cfg.value_field.is_empty()) {
        return Err(format!("pivot {}: in modalità pivot, campo pivot e campo \
                            valore sono obbligatori.", ctx.node_id.0));
    }
    if cfg.mode == "unpivot" && cfg.unpivot_columns.is_empty() {
        return Err(format!("pivot {}: in modalità unpivot, seleziona almeno una \
                            colonna da ruotare.", ctx.node_id.0));
    }

    let start = Instant::now();

    // ── Le righe: dal flusso, o da un dataset della lane ────────────
    let rows: Vec<Row> = if cfg.data_source == "materialize" {
        if cfg.materialize_name.is_empty() {
            return Err(format!("pivot {}: sorgente 'Materialize' senza nome del \
                                dataset. Selezionalo nel pannello.", ctx.node_id.0));
        }
        if let Some(mut rx) = rx {
            while rx.recv().await.is_some() {}   // trigger, scartato
        }
        let ds = ctx.lane_datasets.get(&cfg.materialize_name).await?;
        eprintln!("[pivot] {}: legge il dataset '{}' ({} righe)",
                  ctx.node_id.0, cfg.materialize_name, ds.len());
        ds.rows().to_vec()
    } else {
        let Some(mut rx) = rx else {
            return Err(format!("pivot {}: nessun input collegato. Collega un flusso, \
                                oppure scegli un dataset Materialize.", ctx.node_id.0));
        };
        let mut v = Vec::new();
        while let Some(row) = rx.recv().await { v.push(row) }
        v
    };

    let rows_in = rows.len() as u64;

    let out = match cfg.mode.as_str() {
        "pivot"   => do_pivot(&rows, &cfg)?,
        "unpivot" => do_unpivot(&rows, &cfg),
        other     => return Err(format!("pivot {}: modalità sconosciuta '{}'",
                                        ctx.node_id.0, other)),
    };

    let mut rows_out = 0u64;
    for row in out {
        if tx.send(row).await.is_err() { break }
        rows_out += 1;
    }

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── PIVOT ─────────────────────────────────────────────────────────

fn do_pivot(rows: &[Row], cfg: &PivotConfig) -> Result<Vec<Row>, String> {
    if cfg.pivot_field.is_empty() || cfg.value_field.is_empty() {
        return Err("pivot: campo pivot e campo valore sono obbligatori".to_string());
    }

    // Raggruppa per identità, conservando l'ordine di prima apparizione.
    let mut order:  Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<&Row>> = HashMap::new();

    for row in rows {
        let key = cfg.identity_field.iter()
            .map(|f| row.get(f).map(|v| v.as_str_repr()).unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\u{0}");
        if !groups.contains_key(&key) { order.push(key.clone()) }
        groups.entry(key).or_default().push(row);
    }

    // Le colonne: dichiarate, o scoperte dai dati.
    let col_defs: Vec<(String, String)> = if cfg.pivot_type == "dynamic" {
        let mut seen:     Vec<String> = Vec::new();   // ordine di apparizione
        let mut distinct: std::collections::HashSet<String> = std::collections::HashSet::new();
        for row in rows {
            if let Some(v) = row.get(&cfg.pivot_field) {
                if matches!(v, Value::Null) { continue }
                let s = v.as_str_repr();
                if distinct.insert(s.clone()) { seen.push(s) }
            }
        }
        match cfg.pivot_sort.as_str() {
            "natural" => {}                       // ordine di apparizione
            "desc"    => { seen.sort(); seen.reverse() }
            _         => seen.sort(),             // asc, default
        }
        seen.into_iter().map(|v| (v.clone(), v)).collect()
    } else {
        cfg.pivot_columns.iter()
            .map(|c| {
                let name = if c.alias.is_empty() { c.value.clone() } else { c.alias.clone() };
                (c.value.clone(), name)
            })
            .collect()
    };

    let null_value = cfg.null_value.clone();
    let mut result = Vec::with_capacity(order.len());

    for key in order {
        let group = &groups[&key];
        let first = group[0];

        let mut out = Row::new();
        for f in &cfg.identity_field {
            out.set(f.clone(), first.get(f).cloned().unwrap_or(Value::Null));
        }

        let mut total = 0.0f64;
        let mut has_total = false;

        for (pivot_value, col_name) in &col_defs {
            let vals: Vec<&Value> = group.iter()
                .filter(|r| r.get(&cfg.pivot_field)
                             .map(|v| v.as_str_repr() == *pivot_value)
                             .unwrap_or(false))
                .filter_map(|r| r.get(&cfg.value_field))
                .collect();

            let v = if vals.is_empty() { null_value.clone() }
                    else { aggregate(&vals, &cfg.agg_fn) };

            if cfg.add_row_total {
                if let Some(n) = v.as_f64_lossy() { total += n; has_total = true }
            }
            out.set(col_name.clone(), v);
        }

        if cfg.add_row_total {
            out.set("_totale".to_string(),
                    if has_total { Value::Float(total) } else { Value::Null });
        }

        result.push(out);
    }

    Ok(result)
}

// ─── UNPIVOT ───────────────────────────────────────────────────────

fn do_unpivot(rows: &[Row], cfg: &PivotConfig) -> Vec<Row> {
    if cfg.unpivot_columns.is_empty() {
        return rows.to_vec();   // niente da ruotare
    }

    let key_first = cfg.unpivot_order == "key_first";
    let mut result = Vec::new();

    for row in rows {
        // I campi non ruotati restano su ogni riga generata.
        let fixed: Vec<(String, Value)> = row.fields()
            .filter(|(k, _)| !cfg.unpivot_columns.contains(k))
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect();

        for col in &cfg.unpivot_columns {
            let raw = row.get(col);
            let is_null = matches!(raw, None | Some(Value::Null));

            let value = if is_null {
                match cfg.unpivot_null_mode.as_str() {
                    "exclude" => continue,               // la riga non viene generata
                    "zero"    => Value::Int(0),
                    _         => Value::Null,            // include
                }
            } else {
                raw.unwrap().clone()
            };

            let mut out = Row::new();
            if key_first {
                out.set(cfg.unpivot_key_field.clone(),   Value::String(col.clone()));
                out.set(cfg.unpivot_value_field.clone(), value);
                for (k, v) in &fixed { out.set(k.clone(), v.clone()) }
            } else {
                for (k, v) in &fixed { out.set(k.clone(), v.clone()) }
                out.set(cfg.unpivot_key_field.clone(),   Value::String(col.clone()));
                out.set(cfg.unpivot_value_field.clone(), value);
            }
            result.push(out);
        }
    }

    result
}

// ─── Aggregazione ──────────────────────────────────────────────────

fn aggregate(values: &[&Value], func: &str) -> Value {
    // I non-null, e la loro proiezione numerica.
    let non_null: Vec<&&Value> = values.iter()
        .filter(|v| !matches!(v, Value::Null)).collect();
    let nums: Vec<f64> = non_null.iter().filter_map(|v| v.as_f64_lossy()).collect();

    match func {
        "count" => Value::Int(non_null.len() as i64),

        "first" => non_null.first().map(|v| (**v).clone()).unwrap_or(Value::Null),
        "last"  => non_null.last().map(|v| (**v).clone()).unwrap_or(Value::Null),

        "sum" => if nums.is_empty() { Value::Null } else { Value::Float(nums.iter().sum()) },
        "avg" => if nums.is_empty() { Value::Null }
                 else { Value::Float(nums.iter().sum::<f64>() / nums.len() as f64) },
        "min" => nums.iter().cloned().reduce(f64::min).map(Value::Float).unwrap_or(Value::Null),
        "max" => nums.iter().cloned().reduce(f64::max).map(Value::Float).unwrap_or(Value::Null),

        _ => Value::Null,
    }
}