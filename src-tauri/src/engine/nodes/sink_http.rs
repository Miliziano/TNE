// ─── src-tauri/src/engine/nodes/sink_http.rs ─────────────────────
//
// Sink HTTP: per OGNI riga esegue una chiamata (tipicamente POST del corpo
// costruito dalla riga) e conta esiti. Riusa `execute_single_request` di
// source_http (fonte unica) — quindi eredita auth (incluso digest), retry e
// costruzione del corpo. La risposta viene ignorata (è un sink): conta solo
// successo/errore ed emette una riga di riepilogo.
//
// ⚠️ v1: il metodo lo legge dai props (`method`); perché il corpo venga
// inviato dev'essere POST/PUT/PATCH (lo imposta il pannello). Con GET non
// c'è corpo.

use std::time::{Duration, Instant};
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowReceiver, RowSender, NodeContext};
use super::source_http::execute_single_request;

const MAX_ERRORS: u64 = 5;

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_http {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("sink_http", &ctx.node_id.0);

    if spec.str_or("url", "").trim().is_empty() {
        let msg = format!("sink_http {}: URL non configurato", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }
    let timeout = spec.u64_or("timeout", 30);
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| format!("sink_http {}: client: {}", ctx.node_id.0, e))?;

    let start = Instant::now();
    let (mut rows_in, mut sent, mut errors) = (0u64, 0u64, 0u64);

    while let Some(row) = rx.recv().await {
        rows_in += 1;
        match execute_single_request(&spec, &client, &row, &ctx, &[], None).await {
            Ok(_) => { sent += 1; }
            Err(e) => {
                errors += 1;
                ctx.emit_log(&ctx.label, "error", 0,
                    format!("HTTP: invio riga {} fallito — {}", rows_in, e), "panel");
                if errors > MAX_ERRORS {
                    let msg = format!("sink_http {}: troppi errori di invio ({})", ctx.node_id.0, errors);
                    ctx.emit_failed(msg.clone());
                    return Err(msg);
                }
            }
        }
    }

    ctx.emit_log(&ctx.label, "info", 0,
        format!("HTTP: {} inviate, {} errori", sent, errors), "panel");

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // Riga di riepilogo a valle (come sink_mqtt).
    if let Some(tx) = &tx {
        let mut summary = Row::new();
        summary.set("_http_sent".into(),   Value::Int(sent as i64));
        summary.set("_http_errors".into(), Value::Int(errors as i64));
        summary.set("url".into(),          Value::String(spec.str_or("url", "")));
        summary.set("completed_at".into(), Value::DateTime(chrono::Local::now().to_rfc3339()));
        let _ = tx.send(summary).await;
    }

    let stats = NodeStats {
        rows_in, rows_out: sent, rows_rejected: errors, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
