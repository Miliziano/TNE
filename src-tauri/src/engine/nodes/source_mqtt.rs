// ─── src-tauri/src/engine/nodes/source_mqtt.rs ────────────────────
//
// Sorgente MQTT (subscriber). Coppia MQTT del porting nodi di rete.
//
// FONTE UNICA: `crate::mqtt_subscribe_impl` (la stessa dei comandi Tauri,
// rumqttc). NON è uno stream infinito: il subscribe RACCOGLIE messaggi fino
// a `timeout_ms` o `max_messages`, poi restituisce il lotto → il nodo lo
// emette come righe. Strutturalmente come source_ftp (chiama l'impl → Vec →
// emette). Connessione da una RISORSA di lane; l'arco in ingresso è un
// innesco (R8), drenato con await_params.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::{MqttConnectionParams, MqttSubscribeRequest, mqtt_subscribe_impl};

/// Parametri di connessione dalla risorsa di lane (chiavi di buildConnection
/// del runner: host/port/clientId/username|user/password/keepAlive/
/// cleanSession/scheme).
pub(crate) fn build_conn(spec: &Spec) -> MqttConnectionParams {
    let username = {
        let u = spec.res_str_or("username", "");
        if u.is_empty() { spec.res_str_or("user", "") } else { u }
    };
    let pw     = spec.res_str_or("password", "");
    let client = {
        let c = spec.res_str_or("clientId", "");
        if c.is_empty() { format!("flowpilot_{}", chrono::Utc::now().timestamp_millis()) } else { c }
    };
    let scheme = spec.res_str_or("scheme", "mqtt");
    MqttConnectionParams {
        host:          spec.res_str_or("host", "localhost"),
        port:          spec.res_u16_or("port", 1883),
        client_id:     client,
        username:      if username.is_empty() { None } else { Some(username) },
        password:      if pw.is_empty()       { None } else { Some(pw) },
        keep_alive:    spec.res_u64_or("keepAlive", 60),
        clean_session: spec.res_str_or("cleanSession", "true") != "false",
        use_tls:       scheme == "mqtts" || scheme == "wss",
    }
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    // R8: eventuale arco in ingresso = innesco, drenato e scartato.
    let _params = super::source_input::await_params(&ctx.node_id.0, "source_mqtt", rx).await?;

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_mqtt {}: {}", ctx.node_id.0, e))?;
    if !spec.has_resource() {
        let msg = format!("source_mqtt {}: nessuna risorsa MQTT configurata \
                           (selezionare un broker nel pannello del nodo)", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }
    spec.log_unconsumed("source_mqtt", &ctx.node_id.0);

    let connection     = build_conn(&spec);
    let topic          = spec.str_or("topic", "sensor/+/data");
    let qos            = spec.u64_or("qos", 1) as u8;
    let timeout_ms     = spec.u64_or("subscribeTimeout", 5000);
    let max_messages   = spec.u64_or("maxQueue", 1000) as usize;
    let payload_format = spec.str_or("payloadFormat", "json");

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let start = Instant::now();
    ctx.emit_log(&ctx.label, "info", 0,
        format!("MQTT: {}:{} | topic {} | timeout {}ms",
                connection.host, connection.port, topic, timeout_ms), "panel");

    let request = MqttSubscribeRequest { connection, topic, qos, timeout_ms, max_messages };

    let messages = match mqtt_subscribe_impl(request).await {
        Ok(m) => m,
        Err(e) => {
            let msg = format!("source_mqtt {}: {}", ctx.node_id.0, e);
            ctx.emit_failed(msg.clone());
            return Err(msg);
        }
    };
    ctx.emit_log(&ctx.label, "info", 0,
        format!("MQTT: ricevuti {} messaggi", messages.len()), "panel");

    let mut rows_out = 0u64;
    for msg in messages {
        let mut row = Row::new();
        row.set("topic".to_string(), Value::String(msg.topic));
        // payloadFormat=json → prova a interpretare il payload come JSON,
        // altrimenti resta stringa (come il runner).
        let payload = if payload_format == "json" {
            match serde_json::from_str::<serde_json::Value>(&msg.payload) {
                Ok(v)  => Value::Object(v),
                Err(_) => Value::String(msg.payload),
            }
        } else {
            Value::String(msg.payload)
        };
        row.set("payload".to_string(),     payload);
        row.set("qos".to_string(),         Value::Int(msg.qos as i64));
        row.set("retain".to_string(),      Value::Bool(msg.retain));
        row.set("received_at".to_string(), Value::String(msg.received_at));
        rows_out += 1;
        if tx.send(row).await.is_err() { break; }
    }

    let stats = NodeStats {
        rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
