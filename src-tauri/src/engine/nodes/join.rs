// src-tauri/src/engine/nodes/join.rs
// Join tra due stream (tipo SQL).
// Il join materializza lo stream secondario (right) in memoria
// e fa lo streaming dello stream principale (left).
// Config:
//   join_type:  "inner" | "left" | "right" | "full"
//   left_key:   "id"        — campo chiave left
//   right_key:  "left_id"   — campo chiave right
//   prefix_right: "r_"      — prefisso campi right (evita collisioni)

use std::time::Instant;
use std::collections::HashMap;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx:       NodeContext,
    mut left:  RowReceiver,
    mut right: RowReceiver,
    tx:        RowSender,
) -> Result<NodeStats, String> {

    let join_type     = ctx.config.get("join_type")
        .and_then(|v| v.as_str()).unwrap_or("inner").to_string();
    let left_key      = ctx.config.get("left_key")
        .and_then(|v| v.as_str()).unwrap_or("id").to_string();
    let right_key     = ctx.config.get("right_key")
        .and_then(|v| v.as_str()).unwrap_or("id").to_string();
    let prefix_right  = ctx.config.get("prefix_right")
        .and_then(|v| v.as_str()).unwrap_or("").to_string();

    let start = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    // Materializza il right stream
    let mut right_index: HashMap<String, Vec<Row>> = HashMap::new();
    while let Some(row) = right.recv().await {
        let key = row.get(&right_key)
            .map(|v| v.as_str_repr()).unwrap_or_default();
        right_index.entry(key).or_default().push(row);
    }

    // Stream del left
    while let Some(left_row) = left.recv().await {
        rows_in += 1;
        let key = left_row.get(&left_key)
            .map(|v| v.as_str_repr()).unwrap_or_default();

        match right_index.get(&key) {
            Some(right_rows) => {
                for right_row in right_rows {
                    let out = merge_rows(&left_row, right_row, &prefix_right);
                    if tx.send(out).await.is_err() { break; }
                    rows_out += 1;
                }
            }
            None => {
                // Nessun match
                match join_type.as_str() {
                    "left" | "full" => {
                        // Emette la riga left con campi right null
                        if tx.send(left_row).await.is_err() { break; }
                        rows_out += 1;
                    }
                    _ => {} // inner: scarta
                }
            }
        }

        if rows_in % 1000 == 0 {
            ctx.emit_progress(rows_in, rows_out, rows_in - rows_out,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in, rows_out,
        rows_rejected: rows_in.saturating_sub(rows_out),
        elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn merge_rows(left: &Row, right: &Row, prefix: &str) -> Row {
    let mut out = left.clone();
    for (k, v) in right.fields() {
        let key = if prefix.is_empty() { k.to_string() } else { format!("{}{}", prefix, k) };
        out.set(key, v.clone());
    }
    out
}
