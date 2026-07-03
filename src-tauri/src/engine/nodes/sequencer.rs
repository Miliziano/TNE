// src-tauri/src/engine/nodes/sequencer.rs
// Aggiunge un campo ID incrementale a ogni riga.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let field_name = ctx.config.get("field_name")
        .and_then(|v| v.as_str())
        .unwrap_or("id")
        .to_string();
    let start_value = ctx.config.get("start")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let step = ctx.config.get("step")
        .and_then(|v| v.as_i64())
        .unwrap_or(1);
    let position = ctx.config.get("position")
        .and_then(|v| v.as_str())
        .unwrap_or("first") // "first" | "last"
        .to_string();

    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;
    let mut counter  = start_value;

    while let Some(mut row) = rx.recv().await {
        rows_in += 1;

        if position == "first" {
            // Inserisce il campo ID come primo campo
            let mut new_row = Row::new();
            new_row.set(field_name.clone(), Value::Int(counter));
            for (k, v) in row.fields() {
                new_row.set(k.to_string(), v.clone());
            }
            row = new_row;
        } else {
            row.set(field_name.clone(), Value::Int(counter));
        }

        counter += step;

        if tx.send(row).await.is_err() { break; }
        rows_out += 1;

        if rows_in % 1000 == 0 {
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
