// src-tauri/src/engine/nodes/explode.rs
// Espande un campo array/JSON in righe separate.
// Config:
//   field:     "nome_campo"   — campo da esplodere
//   output:    "nome_output"  — nome del campo nella riga output (default = field)
//   separator: ","            — separatore se il campo è una stringa
//   format:    "json" | "csv" — formato del campo (default: auto-detect)

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let field = ctx.config.get("field")
        .and_then(|v| v.as_str())
        .unwrap_or("items")
        .to_string();
    let output = ctx.config.get("output")
        .and_then(|v| v.as_str())
        .unwrap_or(&field)
        .to_string();
    let separator = ctx.config.get("separator")
        .and_then(|v| v.as_str())
        .unwrap_or(",")
        .to_string();
    let format = ctx.config.get("format")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();

    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let val = row.get(&field).cloned().unwrap_or(Value::Null);
        let items = explode_value(&val, &separator, &format);

        if items.is_empty() {
            // Nessun item — emette la riga con campo null
            let mut out = row.clone();
            out.set(output.clone(), Value::Null);
            if tx.send(out).await.is_err() { break; }
            rows_out += 1;
        } else {
            for item in items {
                let mut out = row.clone();
                out.set(output.clone(), item);
                if tx.send(out).await.is_err() { break; }
                rows_out += 1;
            }
        }

        if rows_in % 500 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in, rows_out,
        rows_rejected: 0, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn explode_value(val: &Value, separator: &str, format: &str) -> Vec<Value> {
    match val {
        Value::Null => vec![],
        Value::String(s) => {
            // Auto-detect: prova JSON array, poi split per separatore
            if format == "json" || (format == "auto" && s.trim().starts_with('[')) {
                if let Ok(arr) = serde_json::from_str::<serde_json::Value>(s) {
                    if let Some(items) = arr.as_array() {
                        return items.iter().map(json_to_value).collect();
                    }
                }
            }
            // Split per separatore
            s.split(separator)
                .map(|p| Value::String(p.trim().to_string()))
                .filter(|v| !matches!(v, Value::String(s) if s.is_empty()))
                .collect()
        }
        other => vec![other.clone()],
    }
}

fn json_to_value(j: &serde_json::Value) -> Value {
    match j {
        serde_json::Value::Null        => Value::Null,
        serde_json::Value::Bool(b)     => Value::Bool(*b),
        serde_json::Value::Number(n)   => {
            if let Some(i) = n.as_i64() { Value::Int(i) }
            else { Value::Float(n.as_f64().unwrap_or(0.0)) }
        }
        serde_json::Value::String(s)   => Value::String(s.clone()),
        other                          => Value::String(other.to_string()),
    }
}
