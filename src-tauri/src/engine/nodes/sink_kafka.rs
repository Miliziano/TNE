// ─── src-tauri/src/engine/nodes/sink_kafka.rs ─────────────────────
//
// Sink Kafka. Come `src/runner/kafkaExecutor.ts`:
//   • REST Proxy (Confluent): se `restProxyUrl` è configurato → publish REALE
//     via HTTP (reqwest), a batch da 100, NESSUN crate nativo.
//   • Nativo (librdkafka): DEFERITO (fase 2 code-gen) → avviso onesto + riga
//     di riepilogo che dichiara lo skip (NON pubblica di nascosto).
//
// Chiave del record: dal campo `key_field` (keyType=field) o UUID (keyType=uuid).

use std::time::{Duration, Instant};
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_kafka {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("sink_kafka", &ctx.node_id.0);

    let topic        = spec.str_or("topic", "pipeline-output");
    let value_format = spec.str_or("valueFormat", "json");
    let rest_proxy   = spec.str_or("restProxyUrl", "").trim().to_string();
    let key_field    = spec.str_or("key_field", "id");
    let key_type     = spec.str_or("keyType", "field");

    // Raccoglie l'input.
    let mut rows: Vec<Row> = Vec::new();
    if let Some(mut rxc) = rx {
        while let Some(r) = rxc.recv().await { rows.push(r); }
    }
    let rows_in = rows.len() as u64;
    let start = Instant::now();

    if rows.is_empty() {
        ctx.emit_log(&ctx.label, "warn", 0, "Kafka Sink: nessuna riga in ingresso".to_string(), "panel");
        let stats = NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    // ── Nativo non disponibile (fase 1) ──────────────────────────
    if rest_proxy.is_empty() {
        ctx.emit_log(&ctx.label, "warn", 0, format!(
            "Kafka Sink [{}]: il protocollo nativo Kafka non è disponibile in fase 1 (richiede librdkafka). \
             Configura una REST Proxy URL nel pannello per pubblicare. In fase 2 verrà generato codice nativo.",
            topic
        ), "panel");
        let mut row = Row::new();
        row.set("_kafka_skipped".to_string(), Value::Int(rows_in as i64));
        row.set("topic".to_string(),          Value::String(topic.clone()));
        row.set("reason".to_string(),         Value::String("native_protocol_unavailable_phase1".to_string()));
        row.set("completed_at".to_string(),   Value::String(chrono::Utc::now().to_rfc3339()));
        let rows_out = match &tx { Some(t) => { let _ = t.send(row).await; 1 } None => 0 };
        let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    // ── REST Proxy (Confluent) ───────────────────────────────────
    ctx.emit_log(&ctx.label, "info", 0,
        format!("Kafka Sink REST — {} | topic: {} | {} record", rest_proxy, topic, rows_in), "panel");

    let content_type = if value_format == "json" {
        "application/vnd.kafka.json.v2+json"
    } else {
        "application/vnd.kafka.binary.v2+json"
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|e| format!("sink_kafka {}: client HTTP — {}", ctx.node_id.0, e))?;

    // Prepara i record: { key, value } (value = riga come JSON).
    let records: Vec<serde_json::Value> = rows.iter().map(|row| {
        let key: serde_json::Value = if key_type == "uuid" {
            serde_json::Value::String(uuid::Uuid::new_v4().to_string())
        } else if key_type == "field" && !key_field.is_empty() {
            match row.get(&key_field) {
                Some(v) => serde_json::Value::String(v.as_str_repr()),
                None    => serde_json::Value::Null,
            }
        } else {
            serde_json::Value::Null
        };
        serde_json::json!({ "key": key, "value": row.to_json_object() })
    }).collect();

    // Invia a batch da 100.
    let url = format!("{}/topics/{}", rest_proxy.trim_end_matches('/'), topic);
    let mut published = 0u64;
    for batch in records.chunks(100) {
        if ctx.cancel.is_cancelled() { break; }
        let res = client.post(&url)
            .header("Content-Type", content_type)
            .header("Accept", "application/vnd.kafka.v2+json")
            .json(&serde_json::json!({ "records": batch }))
            .send().await
            .map_err(|e| { let m = format!("Kafka REST Sink: invio batch — {}", e); ctx.emit_failed(m.clone()); m })?;
        if !res.status().is_success() {
            let body = res.text().await.unwrap_or_default();
            let msg = format!("Kafka REST Sink: errore invio batch — {}", body);
            ctx.emit_failed(msg.clone());
            return Err(msg);
        }
        let result: serde_json::Value = res.json().await.unwrap_or(serde_json::Value::Null);
        let n = result.get("offsets").and_then(|o| o.as_array()).map(|a| a.len()).unwrap_or(batch.len());
        published += n as u64;
    }

    ctx.emit_log(&ctx.label, "info", 0, format!("Kafka Sink REST: {} record pubblicati", published), "panel");

    let mut row = Row::new();
    row.set("_kafka_published".to_string(), Value::Int(published as i64));
    row.set("topic".to_string(),            Value::String(topic.clone()));
    row.set("completed_at".to_string(),     Value::String(chrono::Utc::now().to_rfc3339()));
    let rows_out = match &tx { Some(t) => { let _ = t.send(row).await; 1 } None => 0 };

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
