// ─── src-tauri/src/engine/nodes/sink_ftp.rs ───────────────────────
//
// Sink FTP/SFTP. FETTA 2 del porting dei nodi di rete.
//
// FONTE UNICA: la scrittura di protocollo è `crate::ftp_write_impl`
// (la stessa dei comandi Tauri). La connessione la costruisce
// `super::source_ftp::build_conn` (una sola lettura della risorsa). I
// PRIMITIVI di formattazione (escape_csv/xml, row_to_json, sanitize_tag,
// write_str) sono quelli di `sink_file` (resi pub(crate)).
//
// ⚠️ DIVERGENZA GIUSTIFICATA da sink_file: sink_file fa STREAMING su disco
// riga per riga; sink_ftp deve BUFFERIZZARE tutte le righe e serializzare in
// memoria, perché `ftp_write` scrive il contenuto INTERO in un colpo (API
// one-shot). Quindi il loop di serializzazione è suo, ma usa gli stessi
// primitivi. L'unificazione piena (un RowSerializer condiviso) è un passo
// successivo, da fare col collaudo runtime dei due nodi insieme.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowReceiver, RowSender, NodeContext};
use crate::ftp_write_impl;
use super::source_ftp::build_conn;
use super::sink_file::{write_str, row_to_json, escape_csv, escape_xml, sanitize_tag};

const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;

struct SerOpts {
    format:        String,
    delimiter:     char,
    quote:         char,
    ending:        String,
    write_header:  bool,
    json_pretty:   bool,
    json_lines:    bool,
    effective_raw: bool,
    raw_field:     String,
    raw_b64:       bool,
}

/// Righe bufferizzate → contenuto serializzato (byte). Riusa i primitivi di
/// sink_file, così un CSV/JSON/XML scritto via FTP è byte-identico a uno
/// scritto su disco.
fn serialize_rows(rows: &[Row], o: &SerOpts) -> Result<Vec<u8>, String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut bytes: u64 = 0;              // contatore richiesto da write_str (non usato qui)
    let end = o.ending.as_str();

    if o.effective_raw {
        // Modalità raw: scrive il valore di un campo per riga.
        if o.raw_b64 {
            return Err("sink_ftp: la modalità raw base64 (binari, es. excel_b64) non è \
                        ancora supportata su FTP in v1 — `ftp_write` accetta testo. \
                        Usa un formato testuale (html/csv/json) o un sink_file locale.".to_string());
        }
        for row in rows {
            let val = row.get(&o.raw_field).map(|v| v.as_str_repr()).unwrap_or_default();
            write_str(&mut buf, &val, &mut bytes)?;
            write_str(&mut buf, end, &mut bytes)?;
        }
        return Ok(buf);
    }

    match o.format.as_str() {
        "json" if !o.json_lines => {
            write_str(&mut buf, "[", &mut bytes)?;
            let mut first = true;
            for row in rows {
                let obj = row_to_json(row);
                let s = if o.json_pretty {
                    serde_json::to_string_pretty(&obj).unwrap_or_default()
                } else {
                    serde_json::to_string(&obj).unwrap_or_default()
                };
                if !first { write_str(&mut buf, ",", &mut bytes)?; }
                write_str(&mut buf, end, &mut bytes)?;
                write_str(&mut buf, &s, &mut bytes)?;
                first = false;
            }
            write_str(&mut buf, end, &mut bytes)?;
            write_str(&mut buf, "]", &mut bytes)?;
            write_str(&mut buf, end, &mut bytes)?;
        }
        "json" | "jsonl" => {
            for row in rows {
                let s = serde_json::to_string(&row_to_json(row)).unwrap_or_default();
                write_str(&mut buf, &s, &mut bytes)?;
                write_str(&mut buf, end, &mut bytes)?;
            }
        }
        "xml" => {
            write_str(&mut buf, &format!("<records>{}", end), &mut bytes)?;
            for row in rows {
                let mut xml = String::from("  <record>");
                let mut keys: Vec<&String> = row.0.keys().collect();
                keys.sort();
                for k in keys {
                    let v = row.get(k).map(|v| v.as_str_repr()).unwrap_or_default();
                    let tag = sanitize_tag(k);
                    xml.push_str(&format!("<{}>{}</{}>", tag, escape_xml(&v), tag));
                }
                xml.push_str("</record>");
                write_str(&mut buf, &xml, &mut bytes)?;
                write_str(&mut buf, end, &mut bytes)?;
            }
            write_str(&mut buf, &format!("</records>{}", end), &mut bytes)?;
        }
        _ => {
            // csv / tsv (default). Ordine colonne dalla 1ª riga (come sink_file).
            let mut column_order: Vec<String> = Vec::new();
            let mut header_done = false;
            for row in rows {
                if column_order.is_empty() {
                    column_order = row.0.keys().cloned().collect();
                    column_order.sort();
                    if o.write_header && !header_done {
                        let header = column_order.iter()
                            .map(|h| escape_csv(h, o.delimiter, o.quote))
                            .collect::<Vec<_>>().join(&o.delimiter.to_string());
                        write_str(&mut buf, &header, &mut bytes)?;
                        write_str(&mut buf, end, &mut bytes)?;
                        header_done = true;
                    }
                }
                let line = column_order.iter()
                    .map(|c| {
                        let v = row.get(c).map(|v| v.as_str_repr()).unwrap_or_default();
                        escape_csv(&v, o.delimiter, o.quote)
                    })
                    .collect::<Vec<_>>().join(&o.delimiter.to_string());
                write_str(&mut buf, &line, &mut bytes)?;
                write_str(&mut buf, end, &mut bytes)?;
            }
        }
    }
    Ok(buf)
}

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_ftp {}: {}", ctx.node_id.0, e))?;

    if !spec.has_resource() {
        let msg = format!(
            "sink_ftp {}: nessuna risorsa FTP configurata \
             (selezionare una connessione nel pannello del nodo)", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }
    spec.log_unconsumed("sink_ftp", &ctx.node_id.0);

    let conn        = build_conn(&spec);
    let remote_path = spec.str_or("remotePath", "");
    if remote_path.trim().is_empty() {
        let msg = format!("sink_ftp {}: percorso remoto (remotePath) non specificato", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }

    let format      = spec.str_or("format", "csv");
    let write_mode  = spec.str_or("writeMode", "rows");
    let raw_field   = spec.str_or("rawField", "content");
    let raw_b64     = spec.str_or("rawEncoding", "text") == "base64";
    let output_mode = spec.str_or("outputMode", "signal");
    let quote       = spec.str_or("quoteChar", "\"").chars().next().unwrap_or('"');
    let delim_raw   = spec.str_or("delimiter", "");
    let delimiter   = if delim_raw == "\\t" { '\t' }
                      else if !delim_raw.is_empty() { delim_raw.chars().next().unwrap_or(',') }
                      else if format == "tsv" { '\t' } else { ',' };
    let write_header = spec.bool_or("writeHeader", true);
    let ending = match spec.str_or("lineEnding", "lf").as_str() {
        "crlf" => "\r\n".to_string(),
        _      => "\n".to_string(),
    };
    let json_pretty = matches!(spec.str_or("jsonIndent", "").as_str(), "2" | "4");
    let json_lines  = spec.str_or("jsonStructure", "") == "lines";
    let create_dirs = spec.bool_or("createDirs", true);
    let atomic      = spec.bool_or("atomic", true);
    // html / excel_b64 sono sempre raw (come sink_file).
    let effective_raw = write_mode == "raw_field" || format == "html" || format == "excel_b64";

    // ── Bufferizza tutte le righe (ftp_write è one-shot) ──────────
    let start = Instant::now();
    let mut rows: Vec<Row> = Vec::new();
    let mut rows_in = 0u64;
    let mut last_progress = Instant::now();

    while let Some(row) = rx.recv().await {
        rows_in += 1;
        rows.push(row);
        let should = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_progress.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if should {
            let secs = start.elapsed().as_secs_f64();
            let rps  = if secs > 0.0 { rows_in as f64 / secs } else { 0.0 };
            ctx.emit_progress(rows_in, 0, 0, rps);
            last_progress = Instant::now();
        }
    }

    // ── Serializza ────────────────────────────────────────────────
    let opts = SerOpts {
        format, delimiter, quote, ending, write_header,
        json_pretty, json_lines, effective_raw, raw_field, raw_b64,
    };
    let bytes = match serialize_rows(&rows, &opts) {
        Ok(b) => b,
        Err(e) => { ctx.emit_failed(e.clone()); return Err(e); }
    };
    let content = String::from_utf8(bytes)
        .map_err(|e| {
            let msg = format!("sink_ftp {}: contenuto non UTF-8: {}", ctx.node_id.0, e);
            ctx.emit_failed(msg.clone());
            msg
        })?;
    let bytes_written = content.len() as u64;

    ctx.emit_log(&ctx.label, "info", 0,
        format!("FTP: scrivo {} ({} byte) su {}:{}", remote_path, bytes_written, conn.host, conn.port),
        "panel");

    // ── Scrittura remota (fonte unica: ftp_write_impl) ────────────
    if let Err(e) = ftp_write_impl(conn.clone(), remote_path.clone(),
                                   content, Some(create_dirs), Some(atomic)).await {
        let msg = format!("sink_ftp {}: scrittura di '{}' fallita: {}", ctx.node_id.0, remote_path, e);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // ── Uscita a valle: SIGNAL_SCHEMA (dopo la scrittura completa) ─
    if let Some(tx) = &tx {
        if output_mode == "signal" {
            let mut sig = Row::new();
            sig.set("status".into(),        Value::String("ok".into()));
            sig.set("rows_written".into(),  Value::Int(rows_in as i64));
            sig.set("bytes_written".into(), Value::Int(bytes_written as i64));
            sig.set("file_path".into(),     Value::String(remote_path.clone()));
            sig.set("completed_at".into(),  Value::DateTime(chrono::Local::now().to_rfc3339()));
            sig.set("error_message".into(), Value::String(String::new()));
            sig.set("duration_ms".into(),   Value::Int(elapsed_ms as i64));
            let _ = tx.send(sig).await;
        }
    }

    let stats = NodeStats {
        rows_in,
        rows_out:      rows_in,
        rows_rejected: 0,
        elapsed_ms,
        error:         None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
