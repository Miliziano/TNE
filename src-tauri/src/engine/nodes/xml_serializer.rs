// src-tauri/src/engine/nodes/xml_serializer.rs
// Serializza ogni riga in XML e la mette in un campo stringa.
// Config:
//   output_field: "payload"   — campo dove mettere l'XML
//   root_element: "record"    — tag root
//   include: ["f1","f2"]      — campi da includere (default: tutti)
//   exclude: ["f1"]           — campi da escludere

use std::time::Instant;
use std::collections::HashSet;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let output_field = ctx.config.get("output_field")
        .and_then(|v| v.as_str())
        .unwrap_or("payload")
        .to_string();
    let root = ctx.config.get("root_element")
        .and_then(|v| v.as_str())
        .unwrap_or("record")
        .to_string();
    let include: Option<HashSet<String>> = ctx.config.get("include")
        .and_then(|v| serde_json::from_value(v.clone()).ok());
    let exclude: HashSet<String> = ctx.config.get("exclude")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let mut xml = format!("<{}>", root);
        for (k, v) in row.fields() {
            if exclude.contains(k) { continue; }
            if let Some(ref inc) = include {
                if !inc.contains(k) { continue; }
            }
            let val_str = xml_escape(&v.as_str_repr());
            // Sanitizza il nome del tag (rimuove caratteri non validi)
            let tag = sanitize_xml_tag(k);
            xml.push_str(&format!("<{}>{}</{}>", tag, val_str, tag));
        }
        xml.push_str(&format!("</{}>", root));

        let mut out = row.clone();
        out.set(output_field.clone(), Value::String(xml));

        if tx.send(out).await.is_err() { break; }
        rows_out += 1;

        if rows_in % 1000 == 0 {
            ctx.emit_progress(rows_in, rows_out, 0,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn xml_escape(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
     .replace('\'', "&apos;")
}

fn sanitize_xml_tag(s: &str) -> String {
    let mut result = String::new();
    for (i, c) in s.chars().enumerate() {
        if c.is_alphanumeric() || c == '_' || c == '-' {
            result.push(c);
        } else if i == 0 {
            result.push('_');
        }
    }
    if result.is_empty() { "_field".to_string() } else { result }
}
