// ─── src-tauri/src/engine/nodes/dir_watcher.rs ───────────────────
//
// Nodo dir_watcher. Due modalità:
//   • scan  — lista la cartella UNA volta e emette una riga per file (finito).
//   • watch — osserva per una finestra `watchTimeoutSec` (poll periodico),
//             emette i file nuovi/modificati che compaiono nella finestra.
//             Bounded come il subscribe MQTT → si incastra nel modello a run
//             finito. ⚠️ v1: è POLLING (non eventi fs reali: niente crate
//             `notify`); rileva create/modify, non i delete.
//
// I metadati file (mtime/size) vengono da std::fs — nessuna dipendenza nuova.
// La cartella arriva dai props (pathSource=static) o dal primo record in
// ingresso (pathSource=flow, campo `pathField`). Porte: input(innesco/path,
// R8) → output; `reject` dichiarato ma INERTE in v1.

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant, SystemTime};
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// glob case-insensitive: * = sequenza, ? = un carattere.
fn glob_match(pattern: &str, name: &str) -> bool {
    fn m(p: &[u8], n: &[u8]) -> bool {
        match p.first() {
            None      => n.is_empty(),
            Some(b'*') => m(&p[1..], n) || (!n.is_empty() && m(p, &n[1..])),
            Some(b'?') => !n.is_empty() && m(&p[1..], &n[1..]),
            Some(&c)   => !n.is_empty()
                          && n[0].to_ascii_lowercase() == c.to_ascii_lowercase()
                          && m(&p[1..], &n[1..]),
        }
    }
    m(pattern.as_bytes(), name.as_bytes())
}

fn systime_rfc3339(t: SystemTime) -> String {
    chrono::DateTime::<chrono::Utc>::from(t).to_rfc3339()
}

struct FileInfo {
    path:        String,
    filename:    String,
    extension:   String,
    directory:   String,
    size:        u64,
    created_at:  Option<String>,
    modified_at: Option<String>,
    mtime:       SystemTime,
}

fn to_row(f: &FileInfo, event: Option<&str>) -> Row {
    let mut r = Row::new();
    r.set("path".into(),        Value::String(f.path.clone()));
    r.set("filename".into(),    Value::String(f.filename.clone()));
    r.set("extension".into(),   Value::String(f.extension.clone()));
    r.set("directory".into(),   Value::String(f.directory.clone()));
    r.set("size".into(),        Value::Int(f.size as i64));
    r.set("created_at".into(),  f.created_at.clone().map(Value::String).unwrap_or(Value::Null));
    r.set("modified_at".into(), f.modified_at.clone().map(Value::String).unwrap_or(Value::Null));
    if let Some(e) = event { r.set("event".into(), Value::String(e.to_string())); }
    r
}

// Scansione (ricorsiva opzionale) con i filtri pattern/maxAge/minSize.
fn scan_dir(dir: &str, pattern: &str, recursive: bool, max_age_min: u64, min_size: u64, out: &mut Vec<FileInfo>) {
    let entries = match std::fs::read_dir(dir) { Ok(e) => e, Err(_) => return };
    for entry in entries.flatten() {
        let path = entry.path();
        let meta = match entry.metadata() { Ok(m) => m, Err(_) => continue };
        if meta.is_dir() {
            if recursive { scan_dir(&path.to_string_lossy(), pattern, recursive, max_age_min, min_size, out); }
            continue;
        }
        let filename = entry.file_name().to_string_lossy().to_string();
        if !glob_match(pattern, &filename) { continue; }
        if min_size > 0 && meta.len() < min_size { continue; }

        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        if max_age_min > 0 {
            if let Ok(age) = SystemTime::now().duration_since(mtime) {
                if age.as_secs() / 60 > max_age_min { continue; }
            }
        }
        let full = path.to_string_lossy().to_string();
        let ext  = filename.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
        let directory = Path::new(&full).parent().map(|p| p.to_string_lossy().to_string()).unwrap_or_default();
        out.push(FileInfo {
            path: full, filename, extension: ext, directory,
            size: meta.len(),
            created_at:  meta.created().ok().map(systime_rfc3339),
            modified_at: Some(systime_rfc3339(mtime)),
            mtime,
        });
    }
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    // Il primo record in ingresso serve per pathSource=flow; il resto si scarta.
    let mut first_input: Option<Row> = None;
    if let Some(mut rx) = rx {
        if let Some(r) = rx.recv().await { first_input = Some(r); }
        while rx.recv().await.is_some() {}
    }

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("dir_watcher {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("dir_watcher", &ctx.node_id.0);

    let mode        = spec.str_or("mode", "scan");
    let path_source = spec.str_or("pathSource", "static");
    let directory = if path_source == "flow" {
        let field = spec.str_or("pathField", "path");
        first_input.as_ref().and_then(|r| r.get(&field)).map(|v| v.as_str_repr()).unwrap_or_default()
    } else {
        spec.str_or("directory", "")
    };
    let directory = directory.trim_end_matches('/').to_string();

    if directory.is_empty() {
        let msg = format!("dir_watcher {}: directory non configurata", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }

    let pattern     = spec.str_or("pattern", "*");
    let recursive   = spec.bool_or("recursive", false);
    let min_size    = spec.u64_or("minSize", 0);
    let max_age_min = spec.u64_or("maxAgeMin", 0);
    let sort_by     = spec.str_or("sortBy", "name");
    let sort_dir    = spec.str_or("sortDir", "asc");
    let limit       = spec.u64_or("limit", 0) as usize;

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let start = Instant::now();
    ctx.emit_log(&ctx.label, "info", 0,
        format!("DirWatcher ({}): {} — pattern {}", mode, directory, pattern), "panel");

    // ── SCAN ──────────────────────────────────────────────────────
    if mode != "watch" {
        let mut files = Vec::new();
        scan_dir(&directory, &pattern, recursive, max_age_min, min_size, &mut files);
        sort_files(&mut files, &sort_by, &sort_dir);
        if limit > 0 { files.truncate(limit); }

        let mut rows_out = 0u64;
        for f in &files {
            rows_out += 1;
            if tx.send(to_row(f, None)).await.is_err() { break; }
        }
        let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
            elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    // ── WATCH (polling bounded dal timeout) ──────────────────────
    let timeout_sec = match spec.u64_or("watchTimeoutSec", 300) {
        0 => 86_400, // 0 = "infinito" → 24h come massimo pratico (come il runner)
        n => n,
    };
    let deadline = Instant::now() + Duration::from_secs(timeout_sec);
    let poll = Duration::from_millis(spec.u64_or("debounceMs", 300).max(200));

    // baseline: registra lo stato attuale senza emettere (watch = eventi futuri).
    let mut seen: HashSet<(String, String)> = HashSet::new();
    {
        let mut base = Vec::new();
        scan_dir(&directory, &pattern, recursive, max_age_min, min_size, &mut base);
        for f in &base { seen.insert((f.path.clone(), systime_rfc3339(f.mtime))); }
    }

    let mut rows_out = 0u64;
    while Instant::now() < deadline {
        tokio::time::sleep(poll).await;
        let mut cur = Vec::new();
        scan_dir(&directory, &pattern, recursive, max_age_min, min_size, &mut cur);
        for f in &cur {
            let key = (f.path.clone(), systime_rfc3339(f.mtime));
            if seen.contains(&key) { continue; }
            // nuovo path = create; path già visto con mtime diverso = modify
            let is_new = !seen.iter().any(|(p, _)| p == &f.path);
            let event = if is_new { "create" } else { "modify" };
            seen.insert(key);
            rows_out += 1;
            if tx.send(to_row(f, Some(event))).await.is_err() {
                let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64, error: None };
                ctx.emit_completed(stats.clone());
                return Ok(stats);
            }
        }
    }

    let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn sort_files(files: &mut [FileInfo], sort_by: &str, sort_dir: &str) {
    files.sort_by(|a, b| {
        let o = match sort_by {
            "size"     => a.size.cmp(&b.size),
            "modified" => a.mtime.cmp(&b.mtime),
            _          => a.filename.to_lowercase().cmp(&b.filename.to_lowercase()),
        };
        if sort_dir == "desc" { o.reverse() } else { o }
    });
}
