// src-tauri/src/engine/nodes/log.rs
// Stampa ogni riga nel monitor (emit_progress con payload)
// e la passa al nodo successivo invariata.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {

    // Config opzionale
    let label    = ctx.config.get("label")
        .and_then(|v| v.as_str())
        .unwrap_or("[log]")
        .to_string();
    let max_rows = ctx.config.get("max_rows")
        .and_then(|v| v.as_u64())
        .unwrap_or(100); // stampa al massimo N righe nel monitor

    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Stampa la riga nel monitor (solo le prime max_rows)
        if rows_in <= max_rows {
            let preview: Vec<String> = row.fields()
                .take(6)
                .map(|(k, v)| format!("{}={}", k, v.as_str_repr()))
                .collect();
            ctx.emit_progress(rows_in, rows_out, 0,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));

            eprintln!("{} row#{}: {}", label, rows_in, preview.join(", "));
        }

        // Passa la riga al nodo successivo
        if let Some(ref tx) = tx {
            if tx.send(row).await.is_err() { break; }
            rows_out += 1;
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
