// src-tauri/src/engine/nodes/json_serializer.rs
// Serializza ogni riga in JSON e la mette in un campo stringa.
// Config:
//   output_field: "payload"  — campo dove mettere il JSON
//   pretty:       false      — JSON indentato
//   include:      ["f1","f2"] — campi da includere (default: tutti)
//   exclude:      ["f1"]     — campi da escludere

use std::time::Instant;
use std::collections::HashSet;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let output_field = ctx.config.get("output_field")
        .and_then(|v| v.as_str())
        .unwrap_or("payload")
        .to_string();
    let pretty = ctx.config.get("pretty")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let include: Option<HashSet<String>> = ctx.config.get("include")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let exclude: HashSet<String> = ctx.config.get("exclude")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Costruisce il JSON object
        let mut obj = serde_json::Map::new();
        for (k, v) in row.fields() {
            if exclude.contains(k) { continue; }
            if let Some(ref inc) = include {
                if !inc.contains(k) { continue; }
            }
            obj.insert(k.to_string(), v.to_json());
        }

        let json_str = if pretty {
            serde_json::to_string_pretty(&obj).unwrap_or_default()
        } else {
            serde_json::to_string(&obj).unwrap_or_default()
        };

        let mut out = row.clone();
        out.set(output_field.clone(), Value::String(json_str));

        if tx.send(out).await.is_err() { break; }
        rows_out += 1;

        if rows_in % 1000 == 0 {
            ctx.emit_progress(rows_in, rows_out, 0,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}


