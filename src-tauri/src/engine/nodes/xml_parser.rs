// src-tauri/src/engine/nodes/xml_parser.rs
// Parsa un campo XML stringa ed espande i campi nella riga.
// Implementazione minimale senza dipendenze esterne —
// usa un parser manuale che gestisce il caso comune <tag>valore</tag>.
// Config:
//   input_field:   "payload"  — campo contenente l'XML
//   prefix:        ""         — prefisso per i campi estratti
//   keep_original: false      — mantiene il campo originale

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let input_field = ctx.config.get("input_field")
        .and_then(|v| v.as_str())
        .unwrap_or("payload")
        .to_string();
    let prefix = ctx.config.get("prefix")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    let keep_original = ctx.config.get("keep_original")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);

    let start         = Instant::now();
    let mut rows_in   = 0u64;
    let mut rows_out  = 0u64;
    let mut rows_rejected = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let xml_str = match row.get(&input_field) {
            Some(Value::String(s)) => s.clone(),
            _ => {
                if tx.send(row).await.is_err() { break; }
                rows_out += 1;
                continue;
            }
        };

        let mut out = if keep_original { row.clone() } else {
            let mut r = row.clone();
            r.remove(&input_field);
            r
        };

        // Parser minimale: trova tutti i pattern <tag>valore</tag>
        let fields = parse_xml_flat(&xml_str);
        if fields.is_empty() {
            out.set("_parse_error".to_string(),
                Value::String("XML non parsabile o vuoto".to_string()));
            rows_rejected += 1;
        } else {
            for (k, v) in fields {
                let key = if prefix.is_empty() { k } else { format!("{}_{}", prefix, k) };
                out.set(key, Value::String(v));
            }
        }

        if tx.send(out).await.is_err() { break; }
        rows_out += 1;

        if rows_in % 1000 == 0 {
            ctx.emit_progress(rows_in, rows_out, rows_rejected,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

/// Parser XML minimale — trova tutti i <tag>valore</tag> flat
fn parse_xml_flat(xml: &str) -> Vec<(String, String)> {
    let mut results = Vec::new();
    let re_str = r"<(\w[\w\-]*)>(.*?)</\1>";
    // Implementazione senza regex: ricerca manuale
    let mut pos = 0;
    let bytes = xml.as_bytes();
    while pos < xml.len() {
        // Cerca '<'
        if let Some(start) = xml[pos..].find('<') {
            let tag_start = pos + start + 1;
            // Cerca '>'
            if let Some(end) = xml[tag_start..].find('>') {
                let tag = &xml[tag_start..tag_start + end];
                // Salta tag di chiusura e tag vuoti
                if tag.starts_with('/') || tag.ends_with('/') {
                    pos = tag_start + end + 1;
                    continue;
                }
                // Cerca il tag di chiusura
                let close_tag = format!("</{}>", tag);
                let content_start = tag_start + end + 1;
                if let Some(close_pos) = xml[content_start..].find(&close_tag) {
                    let value = &xml[content_start..content_start + close_pos];
                    // Solo valori senza tag annidati
                    if !value.contains('<') {
                        results.push((
                            tag.to_string(),
                            xml_unescape(value.trim()),
                        ));
                    }
                    pos = content_start + close_pos + close_tag.len();
                } else {
                    pos = tag_start + end + 1;
                }
            } else {
                break;
            }
        } else {
            break;
        }
    }
    let _ = re_str; // suppress unused warning
    results
}

fn xml_unescape(s: &str) -> String {
    s.replace("&amp;",  "&")
     .replace("&lt;",   "<")
     .replace("&gt;",   ">")
     .replace("&quot;", "\"")
     .replace("&apos;", "'")
}
