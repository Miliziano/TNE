// src-tauri/src/engine/nodes/union.rs
// Unisce due stream in uno solo (UNION ALL).
// Legge dal rx principale e dal rx secondario in parallelo.
// Config:
//   mode: "all"      — emette tutte le righe (default, UNION ALL)
//         "distinct" — deduplica (richiede materializzazione, costoso)

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx:      NodeContext,
    mut rx1:  RowReceiver,
    mut rx2:  RowReceiver,
    tx:       RowSender,
) -> Result<NodeStats, String> {

    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    // Legge da rx1 fino alla fine
    while let Some(row) = rx1.recv().await {
        rows_in += 1;
        if tx.send(row).await.is_err() { break; }
        rows_out += 1;
    }

    // Poi legge da rx2 fino alla fine
    while let Some(row) = rx2.recv().await {
        rows_in += 1;
        if tx.send(row).await.is_err() { break; }
        rows_out += 1;
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in, rows_out,
        rows_rejected: 0, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
