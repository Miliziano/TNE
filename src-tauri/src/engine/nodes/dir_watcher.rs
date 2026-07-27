// ─── src-tauri/src/engine/nodes/dir_watcher.rs ───────────────────
//
// Nodo dir_watcher. Due modalità:
//   • scan  — lista la cartella UNA volta e emette una riga per file (finito).
//   • watch — FASE 1: si sottoscrive agli eventi del SO (crate `notify`) e
//             BLOCCA in attesa; al primo evento (o batch entro un debounce)
//             emette i file coinvolti e RITORNA → la lane processa e finisce.
//             Event-driven vero, single-shot ⇒ finito ⇒ gira nel motore
//             attuale. `watchTimeoutSec` è un tetto di sicurezza. Rileva
//             create/modify (non delete). FASE 2 (ri-ascolto + lane che non
//             chiude) = service mode, capitolo a parte.
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

    // ── WATCH — attesa dell'evento REALE del SO (crate `notify`) ─
    // FASE 1: sottoscrive la cartella, BLOCCA sull'evento (attesa efficiente,
    // niente polling né loop occupato), al primo evento (o piccolo batch entro
    // un debounce) emette i file coinvolti e RITORNA → la lane processa fino
    // all'uscita. Event-driven vero, single-shot ⇒ finito ⇒ gira nel motore
    // attuale. `watchTimeoutSec` è un TETTO di sicurezza (se non arriva nulla
    // ritorna a vuoto, così il run finito non resta appeso). FASE 2 (ri-ascolto
    // + lane che non chiude) = service mode, capitolo a parte.
    use notify::{EventKind, RecursiveMode, Watcher};

    let timeout_sec = match spec.u64_or("watchTimeoutSec", 300) { 0 => 86_400, n => n };
    let debounce = Duration::from_millis(spec.u64_or("debounceMs", 300).max(50));

    let (ev_tx, ev_rx) = std::sync::mpsc::channel::<notify::Result<notify::Event>>();
    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let _ = ev_tx.send(res);
    }).map_err(|e| format!("dir_watcher {}: watcher: {}", ctx.node_id.0, e))?;
    watcher.watch(
        Path::new(&directory),
        if recursive { RecursiveMode::Recursive } else { RecursiveMode::NonRecursive },
    ).map_err(|e| format!("dir_watcher {}: watch '{}': {}", ctx.node_id.0, directory, e))?;

    ctx.emit_log(&ctx.label, "info", 0,
        format!("DirWatcher watch: in ascolto su {} (eventi SO, tetto {}s)", directory, timeout_sec), "panel");

    // Attesa BLOCCANTE dell'evento fuori dal runtime async (std mpsc).
    let wait_timeout = Duration::from_secs(timeout_sec);
    let affected: Vec<(String, String)> = tokio::task::spawn_blocking(move || {
        let label = |k: &EventKind| -> Option<&'static str> {
            match k {
                EventKind::Create(_) => Some("create"),
                EventKind::Modify(_) => Some("modify"),
                _ => None,
            }
        };
        let mut out: Vec<(String, String)> = Vec::new();
        // primo evento (blocca fino al tetto)
        match ev_rx.recv_timeout(wait_timeout) {
            Ok(Ok(ev)) => if let Some(l) = label(&ev.kind) {
                for pth in ev.paths { out.push((pth.to_string_lossy().to_string(), l.to_string())); }
            },
            _ => return out,
        }
        // drena eventi ravvicinati entro il debounce
        while let Ok(Ok(ev)) = ev_rx.recv_timeout(debounce) {
            if let Some(l) = label(&ev.kind) {
                for pth in ev.paths { out.push((pth.to_string_lossy().to_string(), l.to_string())); }
            }
        }
        out
    }).await.map_err(|e| format!("dir_watcher {}: attesa evento: {}", ctx.node_id.0, e))?;

    drop(watcher); // smette di ascoltare

    // Emette i file coinvolti che matchano (dedup per path).
    let mut seen: HashSet<String> = HashSet::new();
    let mut rows_out = 0u64;
    for (path, event) in affected {
        if !seen.insert(path.clone()) { continue; }
        let meta = match std::fs::metadata(&path) { Ok(m) => m, Err(_) => continue };
        if !meta.is_file() { continue; }
        let filename = Path::new(&path).file_name()
            .map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !glob_match(&pattern, &filename) { continue; }
        if min_size > 0 && meta.len() < min_size { continue; }
        let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
        let ext = filename.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
        let dir_of = Path::new(&path).parent()
            .map(|pp| pp.to_string_lossy().to_string()).unwrap_or_default();
        let fi = FileInfo {
            path: path.clone(), filename, extension: ext, directory: dir_of,
            size: meta.len(),
            created_at:  meta.created().ok().map(systime_rfc3339),
            modified_at: Some(systime_rfc3339(mtime)),
            mtime,
        };
        rows_out += 1;
        if tx.send(to_row(&fi, Some(&event))).await.is_err() { break; }
        if limit > 0 && rows_out as usize >= limit { break; }
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
