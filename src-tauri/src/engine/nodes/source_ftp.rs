// ─── src-tauri/src/engine/nodes/source_ftp.rs (v2, P362) ───────────
//
// Sorgente FTP/FTPS/SFTP. Ogni opzione del pannello fa ciò che dice.
//
// FONTE UNICA:
//   - il protocollo (lista, lettura, spostamento, cancellazione) vive in
//     `lib.rs` (ftp_list_impl, ftp_read_bytes_impl, ftp_move_impl,
//     ftp_delete_impl), condiviso col pannello risorsa dello studio;
//   - la LETTURA di un file scaricato è quella del File Input
//     (`source_file::FileReader`): stessi formati, mapping, codifiche. Un
//     CSV letto via FTP dà le stesse righe di uno letto da disco.
//
// Opzioni (props del pannello):
//   remotePath, filePattern (glob sul nome), recursive
//   outputMode   content (scarica e legge) | list_files (solo metadati)
//   fetchMode    list (i file presenti) | watch (attende, interrogando ogni
//                pollInterval s, che almeno un file corrisponda; poi li legge
//                e finisce — il tetto è "Max run time" della scheda Advanced)
//   fileFormat   raw (tutto il file in `content`) | text | csv | tsv | excel
//                | json | jsonl | xml | binary  (+ encoding, delimiter, hasHeader)
//   compression  none | gzip | zip (ogni voce dell'archivio è un file)
//   fileOrder    name_asc | name_desc | date_asc | date_desc | size_asc
//   maxFiles     0 = tutti
//   afterFetch   leave | move (archivePath) | delete — solo per i file letti
//                senza errori; se l'azione fallisce, il nodo fallisce (un
//                file rimasto al suo posto verrebbe riletto la volta dopo)
//   onFileError  skip | stop | move_error (errorPath)
//   connectTimeout (s) sul nodo; altrimenti quello della risorsa
//
// Ogni riga letta porta anche _filename, _filepath, _filesize, _modified_at.
// L'eventuale arco in ingresso è un innesco (R8): si drena e si scarta.

use std::time::{Duration, Instant};
use std::io::Read;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::text_encoding::decode_text;
use crate::{FtpConnectionParams, FtpFileEntry, ftp_list_impl, ftp_read_bytes_impl, ftp_move_impl, ftp_delete_impl};
use super::source_file::FileReader;

const PROGRESS_EVERY_MS: u64 = 500;
const FORMATS: &[&str] = &["raw", "text", "csv", "tsv", "excel", "json", "jsonl", "xml", "binary"];

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

/// Aggiunge i metadati del file a una riga (modalità `content`).
fn add_meta(row: &mut Row, name: &str, file: &FtpFileEntry) {
    row.set("_filename".to_string(),    Value::String(name.to_string()));
    row.set("_filepath".to_string(),    Value::String(file.path.clone()));
    row.set("_filesize".to_string(),    Value::Int(file.size as i64));
    row.set("_modified_at".to_string(), file.modified_at.clone().map(Value::String).unwrap_or(Value::Null));
}

/// Il file scaricato, decompresso: una o più parti (nome, byte).
fn decompress(compression: &str, name: &str, bytes: Vec<u8>) -> Result<Vec<(String, Vec<u8>)>, String> {
    match compression {
        "gzip" => {
            let mut out = Vec::new();
            flate2::read::MultiGzDecoder::new(&bytes[..]).read_to_end(&mut out)
                .map_err(|e| format!("not a valid gzip file: {}", e))?;
            let inner = name.strip_suffix(".gz").or_else(|| name.strip_suffix(".gzip")).unwrap_or(name);
            Ok(vec![(inner.to_string(), out)])
        }
        "zip" => {
            let mut z = zip::ZipArchive::new(std::io::Cursor::new(bytes))
                .map_err(|e| format!("not a valid zip file: {}", e))?;
            let mut parts = Vec::new();
            for i in 0..z.len() {
                let mut f = z.by_index(i).map_err(|e| format!("zip entry {}: {}", i, e))?;
                if f.is_dir() { continue }
                let full = f.name().map_err(|e| format!("zip entry {}: {}", i, e))?.to_string();
                let entry = full.rsplit('/').next().unwrap_or("").to_string();
                let mut data = Vec::new();
                f.read_to_end(&mut data).map_err(|e| format!("zip entry '{}': {}", entry, e))?;
                parts.push((entry, data));
            }
            Ok(parts)
        }
        _ => Ok(vec![(name.to_string(), bytes)]),
    }
}

/// Ordina i file come chiesto nel pannello.
fn sort_files(files: &mut [FtpFileEntry], order: &str) {
    match order {
        "name_desc" => files.sort_by(|a, b| b.path.cmp(&a.path)),
        // RFC 3339 in UTC: l'ordine delle stringhe è quello del tempo; senza data in fondo.
        "date_asc"  => files.sort_by(|a, b| (a.modified_at.is_none(), &a.modified_at).cmp(&(b.modified_at.is_none(), &b.modified_at))),
        "date_desc" => files.sort_by(|a, b| (a.modified_at.is_none(), std::cmp::Reverse(&a.modified_at)).cmp(&(b.modified_at.is_none(), std::cmp::Reverse(&b.modified_at)))),
        "size_asc"  => files.sort_by(|a, b| a.size.cmp(&b.size).then(a.path.cmp(&b.path))),
        _           => files.sort_by(|a, b| a.path.cmp(&b.path)),
    }
}

/// `dir` + nome del file.
fn join(dir: &str, name: &str) -> String {
    format!("{}/{}", dir.trim_end_matches('/'), name)
}

struct Cfg {
    remote_path: String,
    pattern:     Option<String>,
    recursive:   bool,
    list_only:   bool,
    watch:       bool,
    poll:        Duration,
    format:      String,
    encoding:    String,
    compression: String,
    order:       String,
    max_files:   usize,
    after:       String,
    archive:     String,
    on_err:      String,
    error_dir:   String,
}

fn config_from_spec(spec: &Spec) -> Result<Cfg, String> {
    let format = spec.str_or("fileFormat", "csv").to_ascii_lowercase();
    if !FORMATS.contains(&format.as_str()) {
        return Err(format!("format '{}' is not available — choose raw, text, CSV, TSV, Excel, JSON, JSON Lines, XML or binary", format));
    }
    let compression = spec.str_or("compression", "none");
    if !matches!(compression.as_str(), "" | "none" | "gzip" | "zip") {
        return Err(format!("compression '{}' is not supported (use none, gzip or zip)", compression));
    }
    let after = spec.str_or("afterFetch", "leave");
    let archive = spec.str_or("archivePath", "").trim().to_string();
    if after == "move" && archive.is_empty() {
        return Err("'Move' after processing needs the archive directory".into());
    }
    let on_err = spec.str_or("onFileError", "skip");
    let error_dir = spec.str_or("errorPath", "").trim().to_string();
    if on_err == "move_error" && error_dir.is_empty() {
        return Err("'Move to error directory' needs the error directory".into());
    }
    let pattern = spec.str_or("filePattern", "");
    Ok(Cfg {
        remote_path: { let p = spec.str_or("remotePath", "/"); if p.trim().is_empty() { "/".into() } else { p } },
        pattern:     if pattern.trim().is_empty() { None } else { Some(pattern.trim().to_string()) },
        recursive:   spec.bool_or("recursive", false),
        list_only:   spec.str_or("outputMode", "content") == "list_files",
        watch:       spec.str_or("fetchMode", "list") == "watch",
        poll:        Duration::from_secs(spec.u64_or("pollInterval", 30).max(5)),
        encoding:    spec.str_or("encoding", "utf-8"),
        compression: if compression.is_empty() { "none".into() } else { compression },
        order:       spec.str_or("fileOrder", "name_asc"),
        max_files:   spec.u64_or("maxFiles", 0) as usize,
        after, archive, on_err, error_dir, format,
    })
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
    let fail = |m: String| -> Result<NodeStats, String> {
        let msg = format!("source_ftp {}: {}", ctx.node_id.0, m);
        ctx.emit_failed(msg.clone());
        Err(msg)
    };

    if !spec.has_resource() {
        return fail("no FTP resource configured (select a connection in the node panel)".into());
    }
    let cfg = match config_from_spec(&spec) { Ok(c) => c, Err(e) => return fail(e) };
    // I formati letti dal File Input: raw resta qui (tutto il file in `content`).
    let reader = if cfg.format == "raw" || cfg.list_only { None } else {
        match FileReader::from_spec(&spec, &cfg.format) { Ok(r) => Some(r), Err(e) => return fail(e) }
    };
    let mut conn = build_conn(&spec);
    let node_timeout = spec.u64_or("connectTimeout", 0);
    if node_timeout > 0 { conn.connect_timeout = Some(node_timeout); }
    spec.log_unconsumed("source_ftp", &ctx.node_id.0);

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let start = Instant::now();
    ctx.emit_log(&ctx.label, "info", 0,
        format!("FTP: connecting to {}:{} ({})", conn.host, conn.port, conn.protocol), "panel");

    // ── Lista file (watch: si interroga finché qualcosa corrisponde) ──
    let mut announced = false;
    let mut files: Vec<FtpFileEntry> = loop {
        let entries = match ftp_list_impl(conn.clone(), cfg.remote_path.clone(), cfg.pattern.clone(), Some(cfg.recursive)).await {
            Ok(e) => e,
            Err(e) => return fail(format!("listing of '{}' failed: {}", cfg.remote_path, e)),
        };
        let found: Vec<FtpFileEntry> = if cfg.list_only { entries }
            else { entries.into_iter().filter(|e| !e.is_dir).collect() };
        if !cfg.watch || cfg.list_only || !found.is_empty() { break found }
        if !announced {
            announced = true;
            ctx.emit_log(&ctx.label, "info", 0,
                format!("FTP: waiting for files in '{}' (checking every {} s)", cfg.remote_path, cfg.poll.as_secs()), "panel");
        }
        tokio::select! {
            _ = tokio::time::sleep(cfg.poll) => {}
            _ = ctx.cancel.cancelled() => {
                let stats = NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: start.elapsed().as_millis() as u64, error: None };
                ctx.emit_completed(stats.clone());
                return Ok(stats);
            }
        }
    };
    if files.is_empty() {
        ctx.emit_log(&ctx.label, "warn", 0, format!("FTP: no file in '{}'", cfg.remote_path), "panel");
    }
    sort_files(&mut files, &cfg.order);
    if cfg.max_files > 0 { files.truncate(cfg.max_files); }

    // ── Modalità LISTA FILE — metadati, niente download ───────────
    if cfg.list_only {
        let mut rows_out = 0u64;
        for e in &files {
            let mut row = Row::new();
            row.set("name".to_string(),        Value::String(e.name.clone()));
            row.set("path".to_string(),        Value::String(e.path.clone()));
            row.set("is_dir".to_string(),      Value::Bool(e.is_dir));
            row.set("size".to_string(),        Value::Int(e.size as i64));
            row.set("modified_at".to_string(), e.modified_at.clone().map(Value::String).unwrap_or(Value::Null));
            if tx.send(row).await.is_err() { break; }
            rows_out += 1;
        }
        let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
            elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    // ── Modalità CONTENT — scarica, decomprime, legge ─────────────
    let reader = std::sync::Arc::new(reader);
    let mut budget: u64 = match reader.as_ref() { Some(r) if r.limit() > 0 => r.limit(), _ => u64::MAX };
    let mut rows_out  = 0u64;
    let mut last_prog = Instant::now();
    let mut downstream_closed = false;

    for file in &files {
        if budget == 0 || downstream_closed { break }
        let outcome = read_file(&ctx, &conn, &cfg, reader.clone(), file, &tx, &mut budget, &mut rows_out, &mut last_prog, start).await;
        match outcome {
            Ok(closed) => {
                downstream_closed = closed;
                let done = match cfg.after.as_str() {
                    "move"   => ftp_move_impl(&conn, &file.path, &join(&cfg.archive, &file.name)).await,
                    "delete" => ftp_delete_impl(&conn, &file.path).await,
                    _        => Ok(()),
                };
                if let Err(e) = done {
                    return fail(format!("{} read, but the after-processing action failed: {}", file.path, e));
                }
            }
            Err(e) => {
                let detail = format!("FTP: error on {} — {}", file.path, e);
                match cfg.on_err.as_str() {
                    "stop" => return fail(detail),
                    "move_error" => {
                        if let Err(me) = ftp_move_impl(&conn, &file.path, &join(&cfg.error_dir, &file.name)).await {
                            return fail(format!("{}; moving it to the error directory failed too: {}", detail, me));
                        }
                        ctx.emit_log(&ctx.label, "warn", 0, format!("{} (moved to {})", detail, cfg.error_dir), "panel");
                    }
                    _ => ctx.emit_log(&ctx.label, "warn", 0, detail, "panel"),
                }
            }
        }
    }

    let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

/// Un file: scarica, decomprime, legge e invia le righe.
/// Ok(true) = il nodo a valle ha chiuso (ci si ferma).
#[allow(clippy::too_many_arguments)]
async fn read_file(
    ctx:       &NodeContext,
    conn:      &FtpConnectionParams,
    cfg:       &Cfg,
    reader:    std::sync::Arc<Option<FileReader>>,
    file:      &FtpFileEntry,
    tx:        &RowSender,
    budget:    &mut u64,
    rows_out:  &mut u64,
    last_prog: &mut Instant,
    start:     Instant,
) -> Result<bool, String> {
    let bytes = ftp_read_bytes_impl(conn, &file.path).await?;
    let parts = decompress(&cfg.compression, &file.name, bytes)?;

    for (name, data) in parts {
        if *budget == 0 { return Ok(false) }

        // raw: il file intero, come testo, in una riga.
        if reader.is_none() {
            let mut row = Row::new();
            row.set("content".to_string(), Value::String(decode_text(&data, &cfg.encoding)?));
            add_meta(&mut row, &name, file);
            if tx.send(row).await.is_err() { return Ok(true) }
            *rows_out += 1;
            *budget -= 1;
            continue;
        }

        // Gli altri formati: il lettore del File Input, su una copia locale
        // temporanea (stesso nome, così il tipo MIME del binario è giusto).
        let tmp_dir = std::env::temp_dir().join(format!("fp-ftp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&tmp_dir).map_err(|e| format!("temporary folder: {}", e))?;
        let tmp = tmp_dir.join(if name.is_empty() { "file".to_string() } else { name.clone() });
        let tmp_s = tmp.to_string_lossy().to_string();
        if let Err(e) = std::fs::write(&tmp, &data) {
            let _ = std::fs::remove_dir_all(&tmp_dir);
            return Err(format!("temporary copy: {}", e));
        }
        drop(data);

        let (row_tx, mut row_rx) = tokio::sync::mpsc::channel::<Row>(1000);
        let rd = reader.clone();
        let mut b = *budget;
        let job = tokio::task::spawn_blocking(move || -> Result<u64, String> {
            let mut emit = |r: Row| row_tx.blocking_send(r).is_ok();
            let res = rd.as_ref().as_ref().expect("reader").read(&tmp_s, &mut b, &mut emit);
            res.map(|_| b)
        });
        let mut closed = false;
        while let Some(mut row) = row_rx.recv().await {
            add_meta(&mut row, &name, file);
            if tx.send(row).await.is_err() { closed = true; break }
            *rows_out += 1;
            if last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS {
                let rps = *rows_out as f64 / start.elapsed().as_secs_f64().max(0.001);
                ctx.emit_progress(*rows_out, *rows_out, 0, rps);
                *last_prog = Instant::now();
            }
        }
        drop(row_rx);
        let res = job.await.map_err(|e| e.to_string());
        let _ = std::fs::remove_dir_all(&tmp_dir);
        if closed { return Ok(true) }
        *budget = res??;
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn f(path: &str, size: u64, date: Option<&str>) -> FtpFileEntry {
        FtpFileEntry { name: path.rsplit('/').next().unwrap().into(), path: path.into(), is_dir: false, size, modified_at: date.map(|d| d.into()) }
    }

    #[test]
    fn ordine_dei_file() {
        let base = vec![
            f("/d/b.csv", 30, Some("2026-01-02T00:00:00+00:00")),
            f("/d/a.csv", 10, None),
            f("/d/c.csv", 20, Some("2026-01-01T00:00:00+00:00")),
        ];
        let names = |o: &str| { let mut v = base.clone(); sort_files(&mut v, o); v.into_iter().map(|e| e.name).collect::<Vec<_>>() };
        assert_eq!(names("name_asc"),  vec!["a.csv", "b.csv", "c.csv"]);
        assert_eq!(names("name_desc"), vec!["c.csv", "b.csv", "a.csv"]);
        assert_eq!(names("date_asc"),  vec!["c.csv", "b.csv", "a.csv"]);
        assert_eq!(names("date_desc"), vec!["b.csv", "c.csv", "a.csv"]);
        assert_eq!(names("size_asc"),  vec!["a.csv", "c.csv", "b.csv"]);
    }

    #[test]
    fn decompressione() {
        use std::io::Write;
        let mut gz = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        gz.write_all(b"a,b\n1,2\n").unwrap();
        let parts = decompress("gzip", "x.csv.gz", gz.finish().unwrap()).unwrap();
        assert_eq!(parts, vec![("x.csv".to_string(), b"a,b\n1,2\n".to_vec())]);

        let mut buf = std::io::Cursor::new(Vec::new());
        {
            let mut z = zip::ZipWriter::new(&mut buf);
            let o = zip::write::SimpleFileOptions::default();
            z.start_file("dir/uno.csv", o).unwrap(); z.write_all(b"x\n1\n").unwrap();
            z.start_file("due.csv", o).unwrap(); z.write_all(b"x\n2\n").unwrap();
            z.finish().unwrap();
        }
        let parts = decompress("zip", "a.zip", buf.into_inner()).unwrap();
        assert_eq!(parts.iter().map(|p| p.0.as_str()).collect::<Vec<_>>(), vec!["uno.csv", "due.csv"]);
        assert!(decompress("gzip", "x", b"non gzip".to_vec()).is_err());
    }
}
