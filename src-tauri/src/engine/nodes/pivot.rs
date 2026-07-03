// src-tauri/src/engine/nodes/pivot.rs
// Pivot: trasforma valori di una colonna in colonne separate.
// Unpivot: trasforma colonne in righe.
// Config per pivot:
//   mode:         "pivot" | "unpivot"
//   key_field:    "categoria"     — colonna i cui valori diventano intestazioni
//   value_field:  "importo"       — colonna i cui valori riempiono le celle
//   group_by:     ["data", "neg"] — campi che identificano la riga di output
//   agg_func:     "sum" | "first" | "count"
//
// Config per unpivot:
//   columns:      ["gen","feb","mar"] — colonne da trasformare in righe
//   key_name:     "mese"             — nome della colonna chiave
//   value_name:   "importo"          — nome della colonna valore
//   keep:         ["data", "neg"]    — colonne da mantenere

use std::time::Instant;
use std::collections::HashMap;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let mode = ctx.config.get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("pivot")
        .to_string();

    if mode == "unpivot" {
        return run_unpivot(ctx, rx, tx).await;
    }

    // ── PIVOT ────────────────────────────────────────────────────
    let key_field   = ctx.config.get("key_field")
        .and_then(|v| v.as_str()).unwrap_or("key").to_string();
    let value_field = ctx.config.get("value_field")
        .and_then(|v| v.as_str()).unwrap_or("value").to_string();
    let group_by: Vec<String> = ctx.config.get("group_by")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let agg_func = ctx.config.get("agg_func")
        .and_then(|v| v.as_str()).unwrap_or("first").to_string();

    let start = Instant::now();
    let mut rows_in = 0u64;

    // group_key → { pivot_key → accumulated_value }
    let mut groups: HashMap<String, (Row, HashMap<String, f64>)> = HashMap::new();
    let mut pivot_keys: Vec<String> = Vec::new(); // ordine di apparizione

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let group_key: String = group_by.iter()
            .map(|f| row.get(f).map(|v| v.as_str_repr()).unwrap_or_default())
            .collect::<Vec<_>>().join("|");

        let pivot_key = row.get(&key_field)
            .map(|v| v.as_str_repr()).unwrap_or_default();
        let val = row.get(&value_field)
            .map(|v| match v {
                Value::Int(n)   => *n as f64,
                Value::Float(f) => *f,
                Value::String(s)   => s.parse().unwrap_or(0.0),
                _               => 0.0,
            }).unwrap_or(0.0);

        if !pivot_keys.contains(&pivot_key) {
            pivot_keys.push(pivot_key.clone());
        }

        let entry = groups.entry(group_key).or_insert_with(|| {
            let mut key_row = Row::new();
            for f in &group_by {
                if let Some(v) = row.get(f) {
                    key_row.set(f.clone(), v.clone());
                }
            }
            (key_row, HashMap::new())
        });

        match agg_func.as_str() {
            "sum"   => { *entry.1.entry(pivot_key).or_insert(0.0) += val; }
            "count" => { *entry.1.entry(pivot_key).or_insert(0.0) += 1.0; }
            _       => { entry.1.entry(pivot_key).or_insert(val); } // first
        }
    }

    let mut rows_out = 0u64;
    for (_, (mut key_row, vals)) in groups {
        for pk in &pivot_keys {
            let v = vals.get(pk).copied().unwrap_or(0.0);
            key_row.set(pk.clone(), Value::Float(v));
        }
        if tx.send(key_row).await.is_err() { break; }
        rows_out += 1;
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

async fn run_unpivot(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let columns: Vec<String> = ctx.config.get("columns")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let key_name = ctx.config.get("key_name")
        .and_then(|v| v.as_str()).unwrap_or("key").to_string();
    let value_name = ctx.config.get("value_name")
        .and_then(|v| v.as_str()).unwrap_or("value").to_string();
    let keep: Vec<String> = ctx.config.get("keep")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let col_set: std::collections::HashSet<&str> = columns.iter().map(|s| s.as_str()).collect();

    let start = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Costruisce la riga base con i campi da mantenere
        let mut base = Row::new();
        for f in &keep {
            if let Some(v) = row.get(f) {
                base.set(f.clone(), v.clone());
            }
        }
        // Aggiunge anche i campi non in columns e non in keep
        for (k, v) in row.fields() {
            if !col_set.contains(k.as_str()) && !keep.iter().any(|s| s == k) {
                base.set(k.to_string(), v.clone());
            }
        }

        // Emette una riga per ogni colonna
        for col in &columns {
            let mut out = base.clone();
            out.set(key_name.clone(), Value::String(col.clone()));
            out.set(value_name.clone(),
                row.get(col).cloned().unwrap_or(Value::Null));
            if tx.send(out).await.is_err() { break; }
            rows_out += 1;
        }

        if rows_in % 500 == 0 {
            ctx.emit_progress(rows_in, rows_out, 0,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
