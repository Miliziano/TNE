// ─── src-tauri/src/engine/nodes/sink_ftp.rs ───────────────────────
//
// Sink FTP/FTPS/SFTP. Raccoglie tutte le righe, le serializza e carica il
// file in un solo trasferimento a fine ingresso.
//
// P356 — allineato al pannello (prima molte chiavi non combaciavano: il
// formato era letto da `format` mentre il pannello scrive `fileFormat`, e
// si scriveva sempre CSV; `writeMode` voleva dire "righe o campo" nel
// motore e "sovrascrivi/accoda/nuovo/errore" nel pannello; il nome file
// era ignorato; `atomicWrite` letto come `atomic`; compressione,
// encoding, permessi, timeout e passthrough non applicati).
//
// Chiavi (props del pannello):
//   remotePath  cartella remota          fileName   nome, con {date} {datetime}
//                                                    {timestamp} {run_id}
//                (fileName vuoto = remotePath è il percorso completo, come
//                 nei progetti precedenti)
//   writeMode   overwrite | append | new | error
//   writeMode2  rows | raw_field (cosa scrivere, come sink_file)
//   rawField, rawEncoding (text | base64) per raw_field
//   fileFormat  csv | tsv | json | jsonl | xml | excel   (legacy: `format`)
//   encoding    utf-8 | utf-16 | iso-8859-1 | windows-1252 (formati di testo)
//   delimiter, quoteChar, writeHeader (csv/tsv), lineEnding (lf | crlf)
//   compression none | gzip | zip
//   atomicWrite (legacy: `atomic`), createDirs, filePermissions (ottale),
//   connectTimeout (s, sovrascrive quello della risorsa)
//   outputMode  signal | passthrough
//
// Retry (scheda Advanced, ctx.retry_policy()): connessione iniziale e
// upload — i dati sono già in memoria, quindi ritentare è sicuro; tranne
// l'upload in append, dove un trasferimento interrotto a metà verrebbe
// ripetuto in coda.

use std::io::Write as _;
use std::time::Instant;
use base64::Engine as _;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowReceiver, RowSender, NodeContext};
use crate::{ftp_resolve_target, ftp_write_bytes, FtpPutOpts, FtpWriteMode};
use super::source_ftp::build_conn;
use super::sink_file::{write_str, row_to_json, escape_csv, escape_xml, sanitize_tag};

const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;
const FORMATS: &[&str] = &["csv", "tsv", "json", "jsonl", "xml", "excel"];

struct SerOpts {
    format:        String,
    delimiter:     char,
    quote:         char,
    ending:        String,
    write_header:  bool,
    json_pretty:   bool,
    json_lines:    bool,
    raw_field:     String,
    raw_b64:       bool,
}

/// Ordine delle colonne: dalla prima riga, alfabetico (come sink_file).
fn columns(rows: &[Row]) -> Vec<String> {
    let mut c: Vec<String> = rows.first().map(|r| r.0.keys().cloned().collect()).unwrap_or_default();
    c.sort();
    c
}

/// Formati di testo → stringa (poi codificata). Riusa i primitivi di
/// sink_file, così un CSV/JSON/XML via FTP è identico a uno su disco.
fn serialize_text(rows: &[Row], o: &SerOpts) -> Result<String, String> {
    let mut buf: Vec<u8> = Vec::new();
    let mut bytes: u64 = 0;
    let end = o.ending.as_str();
    match o.format.as_str() {
        "json" if !o.json_lines => {
            write_str(&mut buf, "[", &mut bytes)?;
            for (i, row) in rows.iter().enumerate() {
                let obj = row_to_json(row);
                let s = if o.json_pretty { serde_json::to_string_pretty(&obj) } else { serde_json::to_string(&obj) }
                    .unwrap_or_default();
                if i > 0 { write_str(&mut buf, ",", &mut bytes)?; }
                write_str(&mut buf, end, &mut bytes)?;
                write_str(&mut buf, &s, &mut bytes)?;
            }
            write_str(&mut buf, end, &mut bytes)?;
            write_str(&mut buf, "]", &mut bytes)?;
            write_str(&mut buf, end, &mut bytes)?;
        }
        "json" | "jsonl" => {
            for row in rows {
                write_str(&mut buf, &serde_json::to_string(&row_to_json(row)).unwrap_or_default(), &mut bytes)?;
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
            // csv / tsv
            let cols = columns(rows);
            let d = o.delimiter.to_string();
            if o.write_header && !cols.is_empty() {
                let header = cols.iter().map(|h| escape_csv(h, o.delimiter, o.quote)).collect::<Vec<_>>().join(&d);
                write_str(&mut buf, &header, &mut bytes)?;
                write_str(&mut buf, end, &mut bytes)?;
            }
            for row in rows {
                let line = cols.iter()
                    .map(|c| escape_csv(&row.get(c).map(|v| v.as_str_repr()).unwrap_or_default(), o.delimiter, o.quote))
                    .collect::<Vec<_>>().join(&d);
                write_str(&mut buf, &line, &mut bytes)?;
                write_str(&mut buf, end, &mut bytes)?;
            }
        }
    }
    String::from_utf8(buf).map_err(|e| format!("non-UTF-8 content: {}", e))
}

/// Excel (.xlsx): intestazione + valori; i numeri restano numeri.
fn serialize_excel(rows: &[Row], write_header: bool) -> Result<Vec<u8>, String> {
    use rust_xlsxwriter::Workbook;
    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();
    let cols = columns(rows);
    let mut r0: u32 = 0;
    if write_header {
        for (c, name) in cols.iter().enumerate() {
            ws.write_string(0, c as u16, name).map_err(|e| format!("xlsx header: {}", e))?;
        }
        r0 = 1;
    }
    for (i, row) in rows.iter().enumerate() {
        let r = r0 + i as u32;
        for (c, name) in cols.iter().enumerate() {
            let cc = c as u16;
            let res = match row.get(name) {
                None | Some(Value::Null) => continue,
                Some(Value::Int(n))      => ws.write_number(r, cc, *n as f64),
                Some(Value::Float(f))    => ws.write_number(r, cc, *f),
                Some(Value::Decimal(d))  => {
                    use rust_decimal::prelude::ToPrimitive;
                    match d.to_f64() { Some(f) => ws.write_number(r, cc, f), None => ws.write_string(r, cc, d.to_string()) }
                }
                Some(Value::Bool(b))     => ws.write_boolean(r, cc, *b),
                Some(v)                  => ws.write_string(r, cc, v.as_str_repr()),
            };
            res.map_err(|e| format!("xlsx cell: {}", e))?;
        }
    }
    wb.save_to_buffer().map_err(|e| format!("xlsx save: {}", e))
}

/// Modalità "campo": il valore di un campo per riga (es. Report Generator
/// → HTML o Excel in base64).
fn serialize_raw(rows: &[Row], o: &SerOpts) -> Result<Vec<u8>, String> {
    let mut out: Vec<u8> = Vec::new();
    for row in rows {
        let val = row.get(&o.raw_field).map(|v| v.as_str_repr()).unwrap_or_default();
        if o.raw_b64 {
            let clean: String = val.chars().filter(|c| !c.is_whitespace()).collect();
            let bytes = base64::engine::general_purpose::STANDARD.decode(clean)
                .map_err(|e| format!("field '{}' is not valid base64: {}", o.raw_field, e))?;
            out.extend_from_slice(&bytes);
        } else {
            out.extend_from_slice(val.as_bytes());
            out.extend_from_slice(o.ending.as_bytes());
        }
    }
    Ok(out)
}

/// {date} {datetime} {timestamp} {run_id} nel nome del file.
fn expand_name(name: &str, run_id: &str) -> String {
    let now = chrono::Local::now();
    name.replace("{date}", &now.format("%Y-%m-%d").to_string())
        .replace("{datetime}", &now.format("%Y%m%d_%H%M%S").to_string())
        .replace("{timestamp}", &now.timestamp().to_string())
        .replace("{run_id}", run_id)
}

fn gzip(data: &[u8]) -> Result<Vec<u8>, String> {
    let mut enc = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    enc.write_all(data).map_err(|e| format!("gzip: {}", e))?;
    enc.finish().map_err(|e| format!("gzip: {}", e))
}

fn zip_one(entry: &str, data: &[u8]) -> Result<Vec<u8>, String> {
    let mut w = zip::ZipWriter::new(std::io::Cursor::new(Vec::new()));
    let opts = zip::write::SimpleFileOptions::default().compression_method(zip::CompressionMethod::Deflated);
    w.start_file(entry, opts).map_err(|e| format!("zip: {}", e))?;
    w.write_all(data).map_err(|e| format!("zip: {}", e))?;
    Ok(w.finish().map_err(|e| format!("zip: {}", e))?.into_inner())
}

/// Ritenta un'operazione remota fino a `retries` volte, con attesa.
/// Gli errori "di contenuto" (file già esistente in modalità Error) non si
/// ritentano.
async fn retry_op<T, F, Fut>(ctx: &NodeContext, retries: u32, delay: u64, what: &str, mut op: F) -> Result<T, String>
where F: FnMut() -> Fut, Fut: std::future::Future<Output = Result<T, String>> {
    let mut attempt = 0u32;
    loop {
        match op().await {
            Ok(v) => return Ok(v),
            Err(e) if attempt < retries && !e.contains("already exists") && !e.contains("no free file name") => {
                attempt += 1;
                ctx.emit_log(&ctx.label, "warn", 0,
                    format!("{} failed: {} — retry {}/{} in {} s", what, e, attempt, retries, delay), "panel");
                tokio::select! {
                    _ = tokio::time::sleep(std::time::Duration::from_secs(delay)) => {}
                    _ = ctx.cancel.cancelled() => return Err(e),
                }
            }
            Err(e) => return Err(if attempt > 0 { format!("{} (after {} retries)", e, attempt) } else { e }),
        }
    }
}

fn fail(ctx: &NodeContext, msg: String) -> Result<NodeStats, String> {
    let msg = format!("sink_ftp {}: {}", ctx.node_id.0, msg);
    ctx.emit_failed(msg.clone());
    Err(msg)
}

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_ftp {}: {}", ctx.node_id.0, e))?;

    if !spec.has_resource() {
        return fail(&ctx, "no FTP resource configured (select a connection in the node panel)".into());
    }

    let mut conn = build_conn(&spec);
    let t = spec.u64_or("connectTimeout", 0);
    if t > 0 { conn.connect_timeout = Some(t); }

    // ── Percorso ────────────────────────────────────────────────────
    let dir       = spec.str_or("remotePath", "");
    let file_name = spec.str_or("fileName", "");
    let mut path = if file_name.trim().is_empty() {
        dir.trim().to_string()
    } else {
        format!("{}/{}", dir.trim().trim_end_matches('/'), expand_name(file_name.trim(), &ctx.run_id.0))
    };
    if path.trim().is_empty() || path.ends_with('/') {
        return fail(&ctx, "no file name: set the remote directory and the file name".into());
    }

    // ── Opzioni ─────────────────────────────────────────────────────
    // `writeMode` dei progetti vecchi poteva valere rows/raw_field (il
    // significato che il motore gli dava): lo si riconosce e si sovrascrive.
    let wm = spec.str_or("writeMode", "overwrite");
    let (mode, legacy_content) = match wm.as_str() {
        "append" => (FtpWriteMode::Append, None),
        "new"    => (FtpWriteMode::New, None),
        "error"  => (FtpWriteMode::Error, None),
        "rows" | "raw_field" => (FtpWriteMode::Overwrite, Some(wm.clone())),
        _        => (FtpWriteMode::Overwrite, None),
    };
    let content_mode = { let c = spec.str_or("writeMode2", ""); if c.is_empty() { legacy_content.unwrap_or_else(|| "rows".into()) } else { c } };
    let format = { let f = spec.str_or("fileFormat", ""); if f.is_empty() { spec.str_or("format", "csv") } else { f } };
    let raw = content_mode == "raw_field";
    if !raw && !FORMATS.contains(&format.as_str()) {
        return fail(&ctx, format!("file format '{}' is not available — choose csv, tsv, json, jsonl, xml or excel", format));
    }
    let compression = spec.str_or("compression", "none");
    if !matches!(compression.as_str(), "none" | "" | "gzip" | "zip") {
        return fail(&ctx, format!("compression '{}' is not available — choose none, gzip or zip", compression));
    }
    let json_lines = format == "jsonl" || spec.str_or("jsonStructure", "") == "lines";
    if mode == FtpWriteMode::Append {
        let ok = raw || matches!(format.as_str(), "csv" | "tsv" | "jsonl") || (format == "json" && json_lines);
        if !ok || compression == "zip" {
            return fail(&ctx, format!("append works with CSV, TSV and JSON Lines, without ZIP (here: {}{})",
                format, if compression == "zip" { " + zip" } else { "" }));
        }
    }
    let encoding = spec.str_or("encoding", "utf-8");
    let atomic   = { let a = spec.str_or("atomicWrite", ""); if a.is_empty() { spec.bool_or("atomic", true) } else { a == "true" } };
    let create_dirs = spec.bool_or("createDirs", true);
    let perms = spec.str_or("filePermissions", "").trim().to_string();
    let chmod = if perms.is_empty() { None } else {
        match u32::from_str_radix(&perms, 8) {
            Ok(m) if m <= 0o7777 => Some(m),
            _ => return fail(&ctx, format!("file permissions '{}' are not a valid octal mode (e.g. 644)", perms)),
        }
    };
    let output_mode = spec.str_or("outputMode", "signal");
    let delim_raw = spec.str_or("delimiter", "");
    let delimiter = if delim_raw == "\\t" { '\t' }
                    else if !delim_raw.is_empty() { delim_raw.chars().next().unwrap_or(',') }
                    else if format == "tsv" { '\t' } else { ',' };
    let ending = if spec.str_or("lineEnding", "lf") == "crlf" { "\r\n" } else { "\n" }.to_string();
    let mut opts = SerOpts {
        format: format.clone(), delimiter,
        quote:        spec.str_or("quoteChar", "\"").chars().next().unwrap_or('"'),
        ending,
        write_header: spec.bool_or("writeHeader", true),
        json_pretty:  matches!(spec.str_or("jsonIndent", "").as_str(), "2" | "4"),
        json_lines,
        raw_field:    spec.str_or("rawField", "content"),
        raw_b64:      spec.str_or("rawEncoding", "text") == "base64",
    };
    // Estensione della compressione nel nome, se manca.
    let ext = match compression.as_str() { "gzip" => ".gz", "zip" => ".zip", _ => "" };
    let inner_name = path.rsplit('/').next().unwrap_or(&path).to_string();
    if !ext.is_empty() && !path.ends_with(ext) { path.push_str(ext); }
    spec.log_unconsumed("sink_ftp", &ctx.node_id.0);

    // ── Raccoglie le righe ──────────────────────────────────────────
    let start = Instant::now();
    let mut rows: Vec<Row> = Vec::new();
    let mut rows_in = 0u64;
    let mut last_progress = Instant::now();
    while let Some(row) = rx.recv().await {
        rows_in += 1;
        rows.push(row);
        if rows_in % PROGRESS_EVERY_ROWS == 0 || last_progress.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS {
            let secs = start.elapsed().as_secs_f64();
            ctx.emit_progress(rows_in, 0, 0, if secs > 0.0 { rows_in as f64 / secs } else { 0.0 });
            last_progress = Instant::now();
        }
    }

    // Retry della scheda Advanced: vale per la connessione iniziale e per
    // l'upload (i dati sono già in memoria).
    let (retries, delay) = ctx.retry_policy().unwrap_or((0, 0));

    // ── Percorso definitivo (nuovo nome / errore se esiste / append) ─
    // Un "esiste già" in modalità Error non si ritenta: non è un guasto.
    let target = match retry_op(&ctx, retries, delay, "Connection", || ftp_resolve_target(&conn, &path, mode)).await {
        Ok(t)  => t,
        Err(e) => return fail(&ctx, e),
    };
    // In append l'intestazione va solo in un file nuovo o vuoto.
    if mode == FtpWriteMode::Append && target.existing_size.unwrap_or(0) > 0 {
        opts.write_header = false;
    }

    // ── Serializza → codifica → comprime ────────────────────────────
    let data: Vec<u8> = {
        let res = if raw {
            serialize_raw(&rows, &opts)
        } else if format == "excel" {
            serialize_excel(&rows, opts.write_header)
        } else {
            serialize_text(&rows, &opts).and_then(|text| {
                let (bytes, replaced) = crate::engine::text_encoding::encode_text(&text, &encoding)?;
                if replaced > 0 {
                    ctx.emit_log(&ctx.label, "warn", 0, format!(
                        "{} character(s) cannot be written in {} and were replaced with '?'", replaced, encoding), "panel");
                }
                Ok(bytes)
            })
        };
        match res.and_then(|d| match compression.as_str() {
            "gzip" => gzip(&d),
            "zip"  => zip_one(&inner_name, &d),
            _      => Ok(d),
        }) {
            Ok(d)  => d,
            Err(e) => return fail(&ctx, e),
        }
    };

    ctx.emit_log(&ctx.label, "info", 0,
        format!("FTP: writing {} ({} bytes) to {}:{}", target.path, data.len(), conn.host, conn.port), "panel");

    // ── Upload, con il retry della scheda Advanced ──────────────────
    let put = FtpPutOpts { create_dirs, atomic, append: mode == FtpWriteMode::Append, chmod };
    let upload_retries = if put.append && retries > 0 {
        ctx.emit_log(&ctx.label, "warn", 0,
            "The upload is not retried in append mode: a transfer interrupted halfway would be appended twice".into(), "panel");
        0
    } else { retries };
    let (bytes_written, warnings) = match retry_op(&ctx, upload_retries, delay, "Upload",
        || ftp_write_bytes(&conn, &target.path, data.clone(), put)).await {
        Ok(r)  => r,
        Err(e) => return fail(&ctx, format!("writing '{}' failed: {}", target.path, e)),
    };
    for w in warnings { ctx.emit_log(&ctx.label, "warn", 0, w, "panel"); }

    let elapsed_ms = start.elapsed().as_millis() as u64;

    // ── Uscita a valle (dopo la scrittura completa) ─────────────────
    let mut rows_out = 0u64;
    if let Some(tx) = &tx {
        if output_mode == "passthrough" {
            for row in rows {
                if tx.send(row).await.is_err() { break }
                rows_out += 1;
            }
        } else {
            let mut sig = Row::new();
            sig.set("status".into(),        Value::String("ok".into()));
            sig.set("rows_written".into(),  Value::Int(rows_in as i64));
            sig.set("bytes_written".into(), Value::Int(bytes_written as i64));
            sig.set("file_path".into(),     Value::String(target.path.clone()));
            sig.set("file_name".into(),     Value::String(target.path.rsplit('/').next().unwrap_or("").to_string()));
            sig.set("completed_at".into(),  Value::DateTime(chrono::Local::now().to_rfc3339()));
            sig.set("error_message".into(), Value::String(String::new()));
            sig.set("duration_ms".into(),   Value::Int(elapsed_ms as i64));
            if tx.send(sig).await.is_ok() { rows_out = 1; }
        }
    }

    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nome_file_e_suffisso() {
        let n = expand_name("out_{run_id}.csv", "R1");
        assert_eq!(n, "out_R1.csv");
        assert!(!expand_name("{date}", "x").contains('{'));
        assert_eq!(crate::ftp_numbered_path("/d/report.csv.gz", 2), "/d/report_2.csv.gz");
        assert_eq!(crate::ftp_numbered_path("noext", 1), "noext_1");
    }

    #[test]
    fn excel_gzip_zip() {
        let mut r = Row::new();
        r.set("a".into(), Value::Int(1));
        r.set("b".into(), Value::String("x".into()));
        let x = serialize_excel(&[r], true).unwrap();
        assert_eq!(&x[..2], b"PK");
        let g = gzip(b"ciao").unwrap();
        assert_eq!(&g[..2], &[0x1f, 0x8b]);
        let z = zip_one("f.csv", b"ciao").unwrap();
        assert_eq!(&z[..2], b"PK");
    }
}
