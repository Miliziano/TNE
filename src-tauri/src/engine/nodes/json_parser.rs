// src-tauri/src/engine/nodes/json_parser.rs
// Parsa un campo JSON stringa ed espande i campi nella riga.
// Config:
//   input_field:  "payload"  — campo contenente il JSON
//   prefix:       ""         — prefisso per i campi estratti
//   flatten:      true       — appiattisce oggetti annidati (a.b.c → a_b_c)
//   keep_original: false     — mantiene il campo originale

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let input_field = ctx.config.get("input_field")
        .and_then(|v| v.as_str())
        .unwrap_or("payload")
        .to_string();
    let prefix = ctx.config.get("prefix")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let flatten = ctx.config.get("flatten")
        .and_then(|v| v.as_bool())
        .unwrap_or(true);
    let keep_original = ctx.config.get("keep_original")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let start    = Instant::now();
    let mut rows_in      = 0u64;
    let mut rows_out     = 0u64;
    let mut rows_rejected = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let json_str = match row.get(&input_field) {
            Some(Value::String(s)) => s.clone(),
            _ => {
                // Campo non stringa o assente — passa la riga invariata
                if tx.send(row).await.is_err() { break; }
                rows_out += 1;
                continue;
            }
        };

        match serde_json::from_str::<serde_json::Value>(&json_str) {
            Ok(json) => {
                let mut out = if keep_original { row.clone() } else {
                    let mut r = row.clone();
                    r.remove(&input_field);
                    r
                };

                // Espande i campi JSON nella riga
                let mut fields: Vec<(String, Value)> = Vec::new();
                flatten_json(&json, &prefix, flatten, &mut fields);
                for (k, v) in fields {
                    out.set(k, v);
                }

                if tx.send(out).await.is_err() { break; }
                rows_out += 1;
            }
            Err(_) => {
                // JSON non valido — marca come errore e passa
                let mut out = row.clone();
                out.set("_parse_error".to_string(),
                    Value::String(format!("JSON non valido: {}...", &json_str[..50.min(json_str.len())])));
                if tx.send(out).await.is_err() { break; }
                rows_rejected += 1;
            }
        }

        if rows_in % 1000 == 0 {
            ctx.emit_progress(rows_in, rows_out, rows_rejected,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn flatten_json(
    val:    &serde_json::Value,
    prefix: &str,
    flatten: bool,
    out:    &mut Vec<(String, Value)>,
) {
    match val {
        serde_json::Value::Object(map) => {
            for (k, v) in map {
                let key = if prefix.is_empty() { k.clone() } else { format!("{}_{}", prefix, k) };
                if flatten && v.is_object() {
                    flatten_json(v, &key, flatten, out);
                } else {
                    out.push((key, json_to_value(v)));
                }
            }
        }
        _ => {
            out.push((prefix.to_string(), json_to_value(val)));
        }
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
