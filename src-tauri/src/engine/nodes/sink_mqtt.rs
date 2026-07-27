// ─── src-tauri/src/engine/nodes/sink_mqtt.rs ──────────────────────
//
// Sink MQTT (publisher). Coppia MQTT del porting nodi di rete.
//
// FONTE UNICA: `crate::mqtt_publish_impl` (rumqttc, la stessa del comando
// Tauri). La connessione la costruisce `super::source_mqtt::build_conn` (una
// sola lettura della risorsa). Per ogni riga in ingresso pubblica un
// messaggio; il topic è statico o preso da un campo (`topicField`).

use std::time::Instant;
use base64::Engine;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowReceiver, RowSender, NodeContext};
use crate::{MqttPublishRequest, mqtt_publish_impl};
use super::source_mqtt::build_conn;
use super::sink_file::row_to_json;

const MAX_ERRORS: u64 = 5;

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_mqtt {}: {}", ctx.node_id.0, e))?;
    if !spec.has_resource() {
        let msg = format!("sink_mqtt {}: nessuna risorsa MQTT configurata \
                           (selezionare un broker nel pannello del nodo)", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }
    spec.log_unconsumed("sink_mqtt", &ctx.node_id.0);

    let conn          = build_conn(&spec);
    let topic_static  = spec.str_or("topic", "pipeline/output");
    let topic_field   = spec.str_or("topicField", "");
    let qos           = spec.u64_or("qos", 1) as u8;
    let retain        = spec.bool_or("retain", false);
    let serialization = spec.str_or("serialization", "json");

    let start = Instant::now();
    let (mut rows_in, mut published, mut errors) = (0u64, 0u64, 0u64);

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // topic: dal campo `topicField` se presente e valorizzato, altrimenti statico.
        let topic = if !topic_field.is_empty() {
            match row.get(&topic_field) {
                Some(v) => v.as_str_repr(),
                None    => topic_static.clone(),
            }
        } else {
            topic_static.clone()
        };

        // payload secondo `serialization`.
        let json = serde_json::to_string(&row_to_json(&row)).unwrap_or_default();
        let payload = match serialization.as_str() {
            "text" => {
                // valore del primo campo (ordine chiavi), fallback al JSON.
                let mut keys: Vec<&String> = row.0.keys().collect();
                keys.sort();
                keys.first()
                    .and_then(|k| row.get(*k))
                    .map(|v| v.as_str_repr())
                    .unwrap_or(json.clone())
            }
            "bytes" => base64::engine::general_purpose::STANDARD.encode(json.as_bytes()),
            _       => json, // json (default)
        };

        let request = MqttPublishRequest {
            connection: conn.clone(),
            topic:      topic.clone(),
            payload,
            qos,
            retain,
        };

        match mqtt_publish_impl(request).await {
            Ok(())  => { published += 1; }
            Err(e)  => {
                errors += 1;
                ctx.emit_log(&ctx.label, "error", 0,
                    format!("MQTT: pubblicazione su '{}' fallita — {}", topic, e), "panel");
                if errors > MAX_ERRORS {
                    let msg = format!("sink_mqtt {}: troppi errori di pubblicazione ({})",
                                      ctx.node_id.0, errors);
                    ctx.emit_failed(msg.clone());
                    return Err(msg);
                }
            }
        }
    }

    ctx.emit_log(&ctx.label, "info", 0,
        format!("MQTT: {} messaggi pubblicati, {} errori", published, errors), "panel");

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // Riga di riepilogo a valle (come il runner).
    if let Some(tx) = &tx {
        let mut summary = Row::new();
        summary.set("_mqtt_published".into(), Value::Int(published as i64));
        summary.set("_mqtt_errors".into(),    Value::Int(errors as i64));
        summary.set("topic".into(),           Value::String(topic_static.clone()));
        summary.set("completed_at".into(),     Value::DateTime(chrono::Local::now().to_rfc3339()));
        let _ = tx.send(summary).await;
    }

    let stats = NodeStats {
        rows_in,
        rows_out:      published,
        rows_rejected: errors,
        elapsed_ms,
        error:         None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
