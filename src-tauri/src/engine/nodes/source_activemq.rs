// ─── src-tauri/src/engine/nodes/source_activemq.rs ────────────────
//
// Sorgente ActiveMQ (consumer STOMP). Batch bounded: si connette, raccoglie
// fino a `maxMessages` entro `receiveTimeout`, chiude, ed emette una riga per
// messaggio. NON è un nodo-servizio (nessun loop infinito).
//
// FONTE UNICA = `crate::stomp_subscribe_impl` (STOMP grezzo su TCP in lib.rs),
// cablata in P122. Replica `sourceActiveMQExecutor` di
// `src/runner/activemqExecutor.ts`.
//
// Connessione: dalla RISORSA se collegata (host/port/user/pass/vhost/tls),
// altrimenti dai prop — come `buildConnection` del runner (lezione P116:
// leggere la config vera dal runner, non indovinare le chiavi).

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::{StompConnectionParams, StompSubscribeRequest, stomp_subscribe_impl};

/// Connessione dalla risorsa (se presente) o dai prop. Porta STOMP 61613.
/// Condivisa col sink (`sink_activemq`) — fonte unica della connessione.
pub(crate) fn build_connection(spec: &Spec) -> StompConnectionParams {
    if spec.has_resource() {
        let username = {
            let u = spec.res_str_or("username", "");
            if u.is_empty() { spec.res_str_or("user", "admin") } else { u }
        };
        StompConnectionParams {
            host:     spec.res_str_or("host", "localhost"),
            port:     spec.res_u16_or("port", 61613),
            username,
            password: spec.res_str_or("password", ""),
            vhost:    spec.res_str_or("vhost", "/"),
            use_tls:  spec.res_str_or("tls", "false") == "true",
        }
    } else {
        let protocol = spec.str_or("protocol", "stomp");
        let default_port = if protocol == "amqp" { 5672 } else if protocol == "stomp" { 61613 } else { 61616 };
        StompConnectionParams {
            host:     spec.str_or("host", "localhost"),
            port:     spec.u64_or("port", default_port) as u16,
            username: spec.str_or("username", "admin"),
            password: spec.str_or("password", ""),
            vhost:    spec.str_or("vhost", "/"),
            use_tls:  spec.str_or("tls", "false") == "true",
        }
    }
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    // R8: eventuale arco in ingresso = innesco.
    let _params = super::source_input::await_params(&ctx.node_id.0, "source_activemq", rx).await?;

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_activemq {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("source_activemq", &ctx.node_id.0);

    let destination    = spec.str_or("destination", "pipeline.input");
    let dest_type      = spec.str_or("destType", "queue");
    let ack_mode       = spec.str_or("ackMode", "auto");
    let selector       = { let s = spec.str_or("selector", ""); if s.trim().is_empty() { None } else { Some(s) } };
    let timeout_ms     = spec.u64_or("receiveTimeout", 5000);
    let max_messages   = spec.u64_or("maxMessages", 1000) as usize;
    let payload_format = spec.str_or("payloadFormat", "json");

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let conn  = build_connection(&spec);
    let start = Instant::now();

    ctx.emit_log(&ctx.label, "info", 0,
        format!("ActiveMQ Consumer — {}:{} | {}: {}", conn.host, conn.port, dest_type, destination), "panel");

    // Attesa CANCELLABILE: allo stop non restiamo appesi sul subscribe.
    let req = StompSubscribeRequest {
        connection: conn, destination, dest_type, ack_mode, selector, timeout_ms, max_messages,
    };
    let messages = tokio::select! {
        _ = ctx.cancel.cancelled() => Vec::new(),
        res = stomp_subscribe_impl(req) => match res {
            Ok(m)  => m,
            Err(e) => {
                let msg = format!("ActiveMQ Consumer: {}", e);
                ctx.emit_failed(msg.clone());
                return Err(msg);
            }
        },
    };

    ctx.emit_log(&ctx.label, "info", 0,
        format!("ActiveMQ Consumer: ricevuti {} messaggi", messages.len()), "panel");

    let mut rows_out = 0u64;
    for msg in &messages {
        // payload: JSON parsato se richiesto, altrimenti stringa grezza.
        let payload_val = if payload_format == "json" {
            match serde_json::from_str::<serde_json::Value>(&msg.payload) {
                Ok(v)  => Value::Object(v),
                Err(_) => Value::String(msg.payload.clone()),
            }
        } else {
            Value::String(msg.payload.clone())
        };

        let mut row = Row::new();
        row.set("destination".to_string(), Value::String(msg.destination.clone()));
        row.set("payload".to_string(),     payload_val);
        row.set("headers".to_string(),     Value::Object(serde_json::to_value(&msg.headers).unwrap_or(serde_json::Value::Null)));
        row.set("message_id".to_string(),  Value::String(msg.message_id.clone()));
        row.set("received_at".to_string(), Value::String(msg.received_at.clone()));

        if tx.send(row).await.is_err() { break; }
        rows_out += 1;
    }

    let stats = NodeStats {
        rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
