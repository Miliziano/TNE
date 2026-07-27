// ─── src-tauri/src/engine/nodes/http_request.rs ──────────────────
//
// Nodo http_request: per OGNI riga in ingresso esegue una chiamata HTTP e
// emette la risposta a valle. È il "cugino a metà flusso" di source_http:
// riusa lo stesso nucleo (`execute_with_pagination` → auth/retry/digest/
// paginazione/risposta) di source_http (fonte unica). Differenza: richiede
// l'input (una chiamata per riga; nessuna chiamata "a vuoto").

use std::time::{Duration, Instant};
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowReceiver, RowSender, NodeContext};
use super::source_http::execute_with_pagination;

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("http_request {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("http_request", &ctx.node_id.0);

    if spec.str_or("url", "").trim().is_empty() {
        let msg = format!("http_request {}: URL non configurato", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }
    let passthrough = spec.bool_or("passthroughInput", true);
    let timeout = spec.u64_or("timeout", 30);

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(timeout))
        .build()
        .map_err(|e| format!("http_request {}: client: {}", ctx.node_id.0, e))?;

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let start = Instant::now();
    let mut rows_in = 0u64;
    let mut rows_out = 0u64;
    let mut errors = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;
        match execute_with_pagination(&spec, &client, &row, &ctx).await {
            Ok(resp_rows) => {
                for mut rr in resp_rows {
                    if passthrough && !row.0.is_empty() {
                        for (k, v) in row.0.iter() {
                            rr.0.entry(k.clone()).or_insert_with(|| v.clone());
                        }
                    }
                    rows_out += 1;
                    if tx.send(rr).await.is_err() { break; }
                }
            }
            Err(e) => {
                // Resilienza per-riga: una riga d'errore, si continua.
                errors += 1;
                ctx.emit_log(&ctx.label, "error", 0, format!("HTTP errore su una riga: {}", e), "panel");
                let mut er = Row::new();
                er.set("status_code".into(),  Value::Int(0));
                er.set("content_type".into(), Value::String(String::new()));
                er.set("latency_ms".into(),   Value::Int(0));
                er.set("headers".into(),      Value::Object(serde_json::Value::Object(serde_json::Map::new())));
                er.set("_error".into(),       Value::String(e));
                if passthrough {
                    for (k, v) in row.0.iter() { er.0.entry(k.clone()).or_insert_with(|| v.clone()); }
                }
                rows_out += 1;
                if tx.send(er).await.is_err() { break; }
            }
        }
    }

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: errors,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
