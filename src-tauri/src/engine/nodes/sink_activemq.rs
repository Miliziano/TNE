// ─── src-tauri/src/engine/nodes/sink_activemq.rs ──────────────────
//
// Sink ActiveMQ (producer STOMP). Per ogni riga in ingresso serializza il
// payload e lo pubblica sulla destinazione; a fine, emette una riga di
// riepilogo {_amq_published, _amq_errors, destination, completed_at}.
//
// FONTE UNICA = `crate::stomp_publish_impl` (STOMP grezzo su TCP, lib.rs),
// cablata in P122. Replica `sinkActiveMQExecutor` di
// `src/runner/activemqExecutor.ts`. Connessione condivisa col source
// (`source_activemq::build_connection`).

use std::time::Instant;
use base64::Engine as _;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::{StompPublishRequest, stomp_publish_impl};

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_activemq {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("sink_activemq", &ctx.node_id.0);

    let destination   = spec.str_or("destination", "pipeline.output");
    let dest_type     = spec.str_or("destType", "queue");
    let serialization = spec.str_or("serialization", "json"); // json | text | bytes
    let persistent    = spec.str_or("persistent", "true") != "false";
    let priority      = spec.u64_or("priority", 4).min(9) as u8;
    let ttl           = spec.u64_or("ttl", 0);
    let corr_field    = spec.str_or("correlationIdField", "");

    // Raccoglie tutte le righe in ingresso.
    let mut rows: Vec<Row> = Vec::new();
    if let Some(mut rxc) = rx {
        while let Some(r) = rxc.recv().await { rows.push(r); }
    }
    let rows_in = rows.len() as u64;
    let start = Instant::now();

    let conn = super::source_activemq::build_connection(&spec);
    ctx.emit_log(&ctx.label, "info", 0,
        format!("ActiveMQ Producer — {}:{} | {}: {} | {} righe", conn.host, conn.port, dest_type, destination, rows_in), "panel");

    if rows.is_empty() {
        ctx.emit_log(&ctx.label, "warn", 0, "ActiveMQ Producer: nessuna riga da pubblicare".to_string(), "panel");
        let stats = NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    let mut published = 0u64;
    let mut errors    = 0u64;

    for row in &rows {
        if ctx.cancel.is_cancelled() { break; }

        let json_str = serde_json::to_string(&row.to_json_object()).unwrap_or_else(|_| "{}".to_string());
        let payload = match serialization.as_str() {
            // primo valore della riga come stringa, altrimenti il JSON intero
            "text"  => row.fields().next().map(|(_, v)| v.as_str_repr()).unwrap_or_else(|| json_str.clone()),
            "bytes" => base64::engine::general_purpose::STANDARD.encode(json_str.as_bytes()),
            _       => json_str, // json
        };

        let correlation_id = if corr_field.is_empty() {
            None
        } else {
            row.get(&corr_field).map(|v| v.as_str_repr())
        };

        match stomp_publish_impl(StompPublishRequest {
            connection: conn.clone(),
            destination: destination.clone(),
            dest_type:   dest_type.clone(),
            payload, persistent, priority, ttl, correlation_id,
        }).await {
            Ok(_) => published += 1,
            Err(e) => {
                errors += 1;
                ctx.emit_log(&ctx.label, "error", 0, format!("ActiveMQ Producer: pubblicazione fallita — {}", e), "panel");
                if errors > 5 {
                    let msg = format!("sink_activemq {}: troppi errori di pubblicazione ({})", ctx.node_id.0, errors);
                    ctx.emit_failed(msg.clone());
                    return Err(msg);
                }
            }
        }
    }

    ctx.emit_log(&ctx.label, "ok", 0,
        format!("ActiveMQ Producer: pubblicati {} messaggi ({} errori)", published, errors), "panel");

    // Riga di riepilogo (come il runner).
    let mut summary = Row::new();
    summary.set("_amq_published".to_string(), Value::Int(published as i64));
    summary.set("_amq_errors".to_string(),    Value::Int(errors as i64));
    summary.set("destination".to_string(),    Value::String(destination.clone()));
    summary.set("completed_at".to_string(),   Value::String(chrono::Utc::now().to_rfc3339()));
    let rows_out = match &tx {
        Some(t) => { let _ = t.send(summary).await; 1 }
        None => 0,
    };

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: errors,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
