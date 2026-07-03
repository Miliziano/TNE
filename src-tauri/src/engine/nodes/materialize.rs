// src-tauri/src/engine/nodes/materialize.rs
// Carica tutto lo stream in memoria, poi lo rilascia.
// Utile come checkpoint prima di nodi che richiedono
// accesso random (sort, aggregate, join).
// Config:
//   max_rows: 1000000  — limite righe (default: illimitato)
//   on_overflow: "error" | "truncate" — comportamento se max_rows superato

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let max_rows = ctx.config.get("max_rows")
        .and_then(|v| v.as_u64())
        .unwrap_or(u64::MAX);
    let on_overflow = ctx.config.get("on_overflow")
        .and_then(|v| v.as_str())
        .unwrap_or("error")
        .to_string();

    let start = Instant::now();
    let mut buffer: Vec<Row> = Vec::new();
    let mut rows_in = 0u64;
    let mut truncated = false;

    while let Some(row) = rx.recv().await {
        rows_in += 1;
        if rows_in > max_rows {
            if on_overflow == "error" {
                return Err(format!(
                    "Materialize: superato il limite di {} righe", max_rows
                ));
            }
            truncated = true;
            continue; // truncate
        }
        buffer.push(row);
        if rows_in % 10000 == 0 {
            ctx.emit_progress(rows_in, 0, 0,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    eprintln!("[materialize] {} righe in memoria{}",
        buffer.len(), if truncated { " (troncato)" } else { "" });

    // Rilascia le righe al nodo successivo
    let mut rows_out = 0u64;
    for row in buffer {
        if tx.send(row).await.is_err() { break; }
        rows_out += 1;
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
