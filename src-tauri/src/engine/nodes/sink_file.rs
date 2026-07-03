// ─── src-tauri/src/engine/nodes/sink_file.rs (v2) ──────────────────
//
// Scrive le righe su file onorando TUTTA la configurazione del
// pannello frontend (SinkFilePanel):
//
//   path, format:      csv | tsv | json | jsonl | xml | html | excel_b64
//                      (excel/parquet/orc/avro: non ancora supportati → errore chiaro)
//   mode:              overwrite | append | new | error
//                      (new/error: falliscono se il file esiste già)
//   write_mode:        rows       → serializza le righe nel formato scelto
//                      raw_field  → scrive il valore di un campo (HTML, Excel b64, payload serializer)
//   raw_field:         nome del campo da scrivere in modalità raw (default 'content')
//   raw_encoding:      text | base64 (base64: decodifica prima di scrivere — binari)
//   output_mode:       signal → emette a valle UNA riga di stato (SIGNAL_SCHEMA)
//                      replay → ri-emette le righe originali DOPO la scrittura completa
//   CSV/TSV:           delimiter, quote_char, write_header, line_ending (lf|crlf)
//   JSON:              json_indent (none|2|4), json_structure (array|lines)
//   encoding:          solo utf-8 onorato per ora (altri → warning)
//   partition/post_command/webhook_url: Stage B — warning se configurati
//
// La riga di stato (output_mode=signal) rispetta SIGNAL_SCHEMA del
// frontend: status, rows_written, bytes_written, file_path,
// completed_at, error_message, duration_ms.

use std::io::{BufWriter, Write};
use std::fs::File;
use std::time::Instant;
use base64::Engine as _;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

#[derive(serde::Deserialize)]
struct SinkFileConfig {
    path:           String,
    format:         Option<String>,
    mode:           Option<String>,
    write_mode:     Option<String>,
    raw_field:      Option<String>,
    raw_encoding:   Option<String>,
    output_mode:    Option<String>,
    delimiter:      Option<String>,
    quote_char:     Option<String>,
    write_header:   Option<bool>,
    line_ending:    Option<String>,
    json_indent:    Option<String>,
    json_structure: Option<String>,
    encoding:       Option<String>,
    partition:      Option<String>,
    post_command:   Option<String>,
    webhook_url:    Option<String>,
}

const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {

    let config: SinkFileConfig = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("sink_file config non valida: {}", e))?;

    let format       = config.format.as_deref().unwrap_or("csv").to_string();
    let mode         = config.mode.as_deref().unwrap_or("overwrite").to_string();
    let write_mode   = config.write_mode.as_deref().unwrap_or("rows").to_string();
    let raw_field    = config.raw_field.as_deref().unwrap_or("content").to_string();
    let raw_b64      = config.raw_encoding.as_deref() == Some("base64");
    let output_mode  = config.output_mode.as_deref().unwrap_or("signal").to_string();
    let quote_char   = config.quote_char.as_deref()
        .and_then(|s| s.chars().next()).unwrap_or('"');
    let delimiter    = config.delimiter.as_deref()
        .map(|s| if s == "\\t" { '\t' } else { s.chars().next().unwrap_or(',') })
        .unwrap_or(if format == "tsv" { '\t' } else { ',' });
    let write_header = config.write_header.unwrap_or(true);
    let ending: &str = match config.line_ending.as_deref() {
        Some("crlf") => "\r\n",
        _            => "\n",
    };
    let json_pretty  = matches!(config.json_indent.as_deref(), Some("2") | Some("4"));
    let json_lines   = config.json_structure.as_deref() == Some("lines");

    // html / excel_b64 sono SEMPRE raw_field (il pannello lo forza)
    let effective_raw = write_mode == "raw_field"
        || format == "html" || format == "excel_b64";

    // ── Avvisi per feature Stage B configurate ma non ancora attive ─
    if config.partition.as_deref().map_or(false, |p| p != "none" && !p.is_empty()) {
        eprintln!("[sink_file {}] ATTENZIONE: partizionamento configurato ma non ancora supportato — scrittura su file singolo", ctx.node_id.0);
    }
    if config.post_command.as_deref().map_or(false, |s| !s.is_empty()) {
        eprintln!("[sink_file {}] ATTENZIONE: post_command configurato ma non ancora supportato", ctx.node_id.0);
    }
    if config.webhook_url.as_deref().map_or(false, |s| !s.is_empty()) {
        eprintln!("[sink_file {}] ATTENZIONE: webhook di notifica configurato ma non ancora supportato", ctx.node_id.0);
    }
    if let Some(enc) = config.encoding.as_deref() {
        if enc != "utf-8" && !enc.is_empty() {
            eprintln!("[sink_file {}] ATTENZIONE: encoding '{}' non supportato — scrivo UTF-8", ctx.node_id.0, enc);
        }
    }

    // ── Formati non implementabili in rows mode ────────────────────
    if !effective_raw && matches!(format.as_str(), "excel" | "parquet" | "orc" | "avro") {
        return Err(format!(
            "sink_file {}: il formato '{}' non è ancora supportato dal motore Rust. \
             Usa csv/tsv/json/jsonl/xml, oppure la modalità 'valore di un campo' \
             (es. Report Generator → excel_b64).", ctx.node_id.0, format));
    }

    // ── Apertura file secondo mode ─────────────────────────────────
    let exists = std::path::Path::new(&config.path).exists();
    let append = mode == "append";
    if (mode == "new" || mode == "error") && exists {
        return Err(format!(
            "sink_file {}: il file '{}' esiste già (modalità '{}')",
            ctx.node_id.0, config.path, mode));
    }

    let file = if append {
        std::fs::OpenOptions::new()
            .append(true).create(true)
            .open(&config.path)
            .map_err(|e| format!("Impossibile aprire '{}' in append: {}", config.path, e))?
    } else {
        File::create(&config.path)
            .map_err(|e| format!("Impossibile creare '{}': {}", config.path, e))?
    };
    let mut writer = BufWriter::new(file);

    // ── Loop di scrittura ──────────────────────────────────────────
    let (mut rows_in, mut rows_written) = (0u64, 0u64);
    let mut bytes_written: u64 = 0;
    let start = Instant::now();
    let mut last_progress = Instant::now();
    let mut headers_written = false;
    let mut column_order: Vec<String> = Vec::new();
    let mut json_first = true;

    // Buffer per replay (output_mode=replay): le righe originali
    // vengono ri-emesse SOLO dopo la scrittura completa del file.
    let replay = output_mode == "replay" && tx.is_some();
    let mut replay_buf: Vec<Row> = Vec::new();

    // Apertura documento per json array / xml rows
    if !effective_raw {
        if format == "json" && !json_lines {
            write_str(&mut writer, "[", &mut bytes_written)?;
        }
        if format == "xml" {
            write_str(&mut writer, &format!("<records>{}", ending), &mut bytes_written)?;
        }
    }

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        if effective_raw {
            // ── Modalità raw: scrive il valore del campo ───────────
            let val = row.get(&raw_field).map(|v| v.as_str_repr()).unwrap_or_default();
            if raw_b64 {
                let bytes = base64::engine::general_purpose::STANDARD
                    .decode(val.trim())
                    .map_err(|e| format!("sink_file {}: base64 non valido nel campo '{}' (riga {}): {}",
                        ctx.node_id.0, raw_field, rows_in, e))?;
                bytes_written += bytes.len() as u64;
                writer.write_all(&bytes)
                    .map_err(|e| format!("Errore scrittura binaria riga {}: {}", rows_in, e))?;
            } else {
                write_str(&mut writer, &val, &mut bytes_written)?;
                write_str(&mut writer, ending, &mut bytes_written)?;
            }
        } else {
            match format.as_str() {
                "json" if !json_lines => {
                    let obj = row_to_json(&row);
                    let s = if json_pretty {
                        serde_json::to_string_pretty(&obj).unwrap_or_default()
                    } else {
                        serde_json::to_string(&obj).unwrap_or_default()
                    };
                    if !json_first { write_str(&mut writer, ",", &mut bytes_written)?; }
                    write_str(&mut writer, ending, &mut bytes_written)?;
                    write_str(&mut writer, &s, &mut bytes_written)?;
                    json_first = false;
                }
                "json" | "jsonl" => {
                    // json_structure=lines oppure formato jsonl: un oggetto per riga
                    let obj = row_to_json(&row);
                    let s   = serde_json::to_string(&obj).unwrap_or_default();
                    write_str(&mut writer, &s, &mut bytes_written)?;
                    write_str(&mut writer, ending, &mut bytes_written)?;
                }
                "xml" => {
                    let mut xml = String::from("  <record>");
                    let mut keys: Vec<&String> = row.0.keys().collect();
                    keys.sort();
                    for k in keys {
                        let v = row.get(k).map(|v| v.as_str_repr()).unwrap_or_default();
                        let tag = sanitize_tag(k);
                        xml.push_str(&format!("<{}>{}</{}>", tag, escape_xml(&v), tag));
                    }
                    xml.push_str("</record>");
                    write_str(&mut writer, &xml, &mut bytes_written)?;
                    write_str(&mut writer, ending, &mut bytes_written)?;
                }
                _ => {
                    // csv / tsv (default)
                    if column_order.is_empty() {
                        column_order = row.0.keys().cloned().collect();
                        column_order.sort();
                        if write_header && !headers_written {
                            let header_line = column_order.iter()
                                .map(|h| escape_csv(h, delimiter, quote_char))
                                .collect::<Vec<_>>().join(&delimiter.to_string());
                            write_str(&mut writer, &header_line, &mut bytes_written)?;
                            write_str(&mut writer, ending, &mut bytes_written)?;
                            headers_written = true;
                        }
                    }
                    let data_line = column_order.iter()
                        .map(|col| {
                            let val = row.get(col).map(|v| v.as_str_repr()).unwrap_or_default();
                            escape_csv(&val, delimiter, quote_char)
                        })
                        .collect::<Vec<_>>().join(&delimiter.to_string());
                    write_str(&mut writer, &data_line, &mut bytes_written)?;
                    write_str(&mut writer, ending, &mut bytes_written)?;
                }
            }
        }

        rows_written += 1;
        if replay { replay_buf.push(row); }

        let should_progress = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_progress.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if should_progress {
            writer.flush().map_err(|e| format!("Errore flush: {}", e))?;
            let elapsed_secs = start.elapsed().as_secs_f64();
            let rps = if elapsed_secs > 0.0 { rows_in as f64 / elapsed_secs } else { 0.0 };
            ctx.emit_progress(rows_in, rows_written, 0, rps);
            last_progress = Instant::now();
        }
    }

    // Chiusura documento
    if !effective_raw {
        if format == "json" && !json_lines {
            write_str(&mut writer, ending, &mut bytes_written)?;
            write_str(&mut writer, "]", &mut bytes_written)?;
            write_str(&mut writer, ending, &mut bytes_written)?;
        }
        if format == "xml" {
            write_str(&mut writer, &format!("</records>{}", ending), &mut bytes_written)?;
        }
    }

    writer.flush().map_err(|e| format!("Errore flush finale: {}", e))?;
    let elapsed_ms = start.elapsed().as_millis() as u64;

    // ── Output a valle — SOLO dopo la scrittura completa ──────────
    if let Some(tx) = &tx {
        if replay {
            // Buffer → Replay: ri-emette le righe originali
            for r in replay_buf.drain(..) {
                if tx.send(r).await.is_err() { break; }
            }
        } else if output_mode == "signal" {
            // Buffer → Signal: una riga di stato conforme a SIGNAL_SCHEMA
            let mut sig = Row::new();
            sig.set("status".into(),        Value::String("ok".into()));
            sig.set("rows_written".into(),  Value::Int(rows_written as i64));
            sig.set("bytes_written".into(), Value::Int(bytes_written as i64));
            sig.set("file_path".into(),     Value::String(config.path.clone()));
            sig.set("completed_at".into(),  Value::DateTime(chrono::Local::now().to_rfc3339()));
            sig.set("error_message".into(), Value::String(String::new()));
            sig.set("duration_ms".into(),   Value::Int(elapsed_ms as i64));
            let _ = tx.send(sig).await;
        }
    }

    let stats = NodeStats {
        rows_in,
        rows_out:      rows_written,
        rows_rejected: 0,
        elapsed_ms,
        error:         None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Helpers ──────────────────────────────────────────────────────

fn write_str<W: Write>(w: &mut W, s: &str, bytes: &mut u64) -> Result<(), String> {
    *bytes += s.len() as u64;
    w.write_all(s.as_bytes()).map_err(|e| format!("Errore scrittura: {}", e))
}

fn row_to_json(row: &Row) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    let mut keys: Vec<&String> = row.0.keys().collect();
    keys.sort();
    for k in keys {
        if let Some(v) = row.get(k) {
            obj.insert(k.clone(), v.to_json());
        }
    }
    serde_json::Value::Object(obj)
}

fn escape_csv(s: &str, delimiter: char, quote: char) -> String {
    if s.contains(delimiter) || s.contains(quote) || s.contains('\n') || s.contains('\r') {
        let doubled = s.replace(quote, &format!("{}{}", quote, quote));
        format!("{}{}{}", quote, doubled, quote)
    } else {
        s.to_string()
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
     .replace('\'', "&apos;")
}

fn sanitize_tag(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() || c == '_' || c == '-' { result.push(c); }
    }
    if result.chars().next().map_or(true, |c| c.is_ascii_digit()) {
        result.insert(0, '_');
    }
    if result == "_" { "_field".to_string() } else { result }
}