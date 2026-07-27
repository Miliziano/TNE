// ─── src-tauri/src/engine/nodes/source_ftp.rs ─────────────────────
//
// Sorgente FTP/SFTP. FETTA 1 del porting dei nodi di rete.
//
// FONTE UNICA: la logica di protocollo (connessione, list, read) NON è
// riscritta qui. Vive già in `lib.rs` come comandi Tauri (il pulsante
// "prova connessione", la lista file del pannello risorsa) ed è esposta
// `pub`: `crate::ftp_list`, `crate::ftp_read`, `crate::FtpConnectionParams`,
// `crate::FtpFileEntry`. Questo nodo la CABLA nel motore a streaming.
// Il tokenizer CSV è quello di source_file (`parse_csv_line`), così un
// CSV letto da FTP dà righe identiche a uno letto da disco.
//
// Modello: come source_file, firma run(ctx, rx, tx). L'eventuale arco in
// ingresso è un INNESCO (R8): si drena e si scarta (await_params). La
// connessione arriva da una RISORSA di lane (spec.resource), non dai props.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::{FtpConnectionParams, FtpFileEntry, ftp_list_impl, ftp_read_impl};

const PROGRESS_EVERY_MS: u64 = 500;

/// Costruisce i parametri di connessione dalla risorsa di lane risolta.
/// Stesse chiavi di `buildFtpConnection` (studio) e di source_db per il DB.
pub(crate) fn build_conn(spec: &Spec) -> FtpConnectionParams {
    let protocol     = spec.res_str_or("protocol", "sftp");
    let default_port = if protocol == "ftp" || protocol == "ftps" { 21 } else { 22 };
    let user = {
        let u = spec.res_str_or("user", "");
        if u.is_empty() { spec.res_str_or("username", "") } else { u }
    };
    let pw  = spec.res_str_or("password", "");
    let key = spec.res_str_or("keyPath", "");
    FtpConnectionParams {
        port:            spec.res_u16_or("port", default_port),
        host:            spec.res_str_or("host", "localhost"),
        protocol,
        user,
        password:        if pw.is_empty()  { None } else { Some(pw)  },
        key_path:        if key.is_empty() { None } else { Some(key) },
        auth_type:       Some(spec.res_str_or("authType", "password")),
        connect_timeout: Some(spec.res_u64_or("connectTimeout", 30)),
    }
}

/// Aggiunge i metadati file a una riga (modalità `content`).
fn add_meta(row: &mut Row, file: &FtpFileEntry) {
    row.set("_filename".to_string(),    Value::String(file.name.clone()));
    row.set("_filepath".to_string(),    Value::String(file.path.clone()));
    row.set("_filesize".to_string(),    Value::Int(file.size as i64));
    row.set("_modified_at".to_string(), file.modified_at.clone().map(Value::String).unwrap_or(Value::Null));
}

/// CSV/TSV → righe con chiavi dall'header. Riusa il tokenizer di source_file
/// (fonte unica). I valori restano stringhe: il source FTP non ha (ancora) uno
/// schema `fields` tipizzato come source_file → nessuna coercizione qui.
fn parse_delimited(content: &str, delimiter: u8, limit: usize) -> Vec<Row> {
    let mut out: Vec<Row> = Vec::new();
    let mut headers: Vec<String> = Vec::new();
    let mut first = true;

    for line in content.lines() {
        if line.trim().is_empty() { continue; }
        let fields = super::source_file::parse_csv_line(line, delimiter);

        if first {
            headers = fields;
            first = false;
            continue;
        }

        let mut row = Row::new();
        if headers.is_empty() {
            for (i, v) in fields.into_iter().enumerate() {
                row.set(format!("col_{}", i), Value::String(v));
            }
        } else {
            for (k, v) in headers.iter().zip(fields.iter()) {
                row.set(k.clone(), Value::String(v.clone()));
            }
        }
        out.push(row);
        if limit > 0 && out.len() >= limit { break; }
    }
    out
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    // R8: se c'è un arco in ingresso è un innesco — si drena e si scarta,
    // esattamente come source_file / source_db.
    let _params = super::source_input::await_params(&ctx.node_id.0, "source_ftp", rx).await?;

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_ftp {}: {}", ctx.node_id.0, e))?;

    if !spec.has_resource() {
        let msg = format!(
            "source_ftp {}: nessuna risorsa FTP configurata \
             (selezionare una connessione nel pannello del nodo)", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }
    spec.log_unconsumed("source_ftp", &ctx.node_id.0);

    let conn        = build_conn(&spec);
    let remote_path = spec.str_or("remotePath", "/");
    let pattern_s   = spec.str_or("filePattern", "");
    let pattern     = if pattern_s.is_empty() { None } else { Some(pattern_s) };
    let output_mode = spec.str_or("outputMode", "content");
    let file_format = spec.str_or("fileFormat", "csv");
    let delim_str   = spec.str_or("delimiter", ",");
    let delimiter   = delim_str.chars().next().unwrap_or(',') as u8;
    let max_files   = spec.u64_or("maxFiles", 0) as usize;
    let limit       = spec.u64_or("limit", 0) as usize;
    let on_file_err = spec.str_or("onFileError", "skip");

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let start = Instant::now();
    ctx.emit_log(&ctx.label, "info", 0,
        format!("FTP: connessione a {}:{} ({})", conn.host, conn.port, conn.protocol), "panel");

    // ── Lista file (con filtro glob lato lib.rs) ──────────────────
    let entries = match ftp_list_impl(conn.clone(), remote_path.clone(), pattern.clone(), Some(false)).await {
        Ok(e) => e,
        Err(e) => {
            let msg = format!("source_ftp {}: lista di '{}' fallita: {}", ctx.node_id.0, remote_path, e);
            ctx.emit_failed(msg.clone());
            return Err(msg);
        }
    };

    if entries.is_empty() {
        ctx.emit_log(&ctx.label, "warn", 0,
            format!("FTP: nessun file in '{}'", remote_path), "panel");
    }

    // ── Modalità LISTA FILE — metadati, niente download ───────────
    if output_mode == "list_files" {
        let mut rows_out = 0u64;
        for e in &entries {
            let mut row = Row::new();
            row.set("name".to_string(),        Value::String(e.name.clone()));
            row.set("path".to_string(),        Value::String(e.path.clone()));
            row.set("is_dir".to_string(),      Value::Bool(e.is_dir));
            row.set("size".to_string(),        Value::Int(e.size as i64));
            row.set("modified_at".to_string(), e.modified_at.clone().map(Value::String).unwrap_or(Value::Null));
            rows_out += 1;
            if tx.send(row).await.is_err() { break; }
        }
        let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
            elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    // ── Modalità CONTENT — scarica e parsa ────────────────────────
    let files: Vec<&FtpFileEntry> = entries.iter().filter(|e| !e.is_dir).collect();
    let to_read: Vec<&FtpFileEntry> = if max_files > 0 {
        files.into_iter().take(max_files).collect()
    } else {
        files
    };

    let mut rows_out  = 0u64;
    let mut last_prog = Instant::now();

    for file in to_read {
        let content = match ftp_read_impl(conn.clone(), file.path.clone()).await {
            Ok(c) => c,
            Err(e) => {
                let detail = format!("FTP: errore su {} — {}", file.name, e);
                if on_file_err == "stop" {
                    let msg = format!("source_ftp {}: {}", ctx.node_id.0, detail);
                    ctx.emit_failed(msg.clone());
                    return Err(msg);
                }
                ctx.emit_log(&ctx.label, "warn", 0, detail, "panel");
                continue;
            }
        };

        // 'raw' | 'json' | 'xml' → UNA riga col contenuto intero nel campo
        // `content` (i parser a valle json_parser/xml_parser lo leggono lì);
        // stessa convenzione di source_file. Il resto = delimitato.
        let file_rows: Vec<Row> = if file_format == "raw" || file_format == "json" || file_format == "xml" {
            let mut row = Row::new();
            row.set("content".to_string(), Value::String(content));
            vec![row]
        } else {
            parse_delimited(&content, delimiter, limit)
        };

        for mut row in file_rows {
            add_meta(&mut row, file);
            rows_out += 1;
            if tx.send(row).await.is_err() {
                // nodo a valle non più disponibile → ci fermiamo pulito
                let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64, error: None };
                ctx.emit_completed(stats.clone());
                return Ok(stats);
            }
            if last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS {
                let rps = rows_out as f64 / start.elapsed().as_secs_f64().max(0.001);
                ctx.emit_progress(rows_out, rows_out, 0, rps);
                last_prog = Instant::now();
            }
        }
    }

    let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
