// ─── src-tauri/src/engine/nodes/dir_watcher.rs ───────────────────
//
// Nodo dir_watcher. Due modalità:
//   • scan  — lista la cartella UNA volta e emette una riga per file (finito).
//   • watch — FASE 1: si sottoscrive agli eventi del SO (crate `notify`) e
//             BLOCCA in attesa; al primo evento (o batch entro un debounce)
//             emette i file coinvolti e RITORNA → la lane processa e finisce.
//             Event-driven vero, single-shot ⇒ finito ⇒ gira nel motore
//             attuale. `watchTimeoutSec` è un tetto di sicurezza. Eventi:
//             new/update/rename/delete (prop `events` = filtro; metadata/
//             permessi esclusi). delete e rename-from → riga "magra" (il file
//             non c'è più: size/date NULL). FASE 2 (ri-ascolto continuo + lane
//             a sessioni) = `design-nodo-dir-watcher.md`, capitolo a parte.
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

fn to_row(f: &FileInfo, event: Option<&str>, old_path: Option<&str>) -> Row {
    let mut r = Row::new();
    r.set("path".into(),        Value::String(f.path.clone()));
    r.set("filename".into(),    Value::String(f.filename.clone()));
    r.set("extension".into(),   Value::String(f.extension.clone()));
    r.set("directory".into(),   Value::String(f.directory.clone()));
    r.set("size".into(),        Value::Int(f.size as i64));
    r.set("created_at".into(),  f.created_at.clone().map(Value::String).unwrap_or(Value::Null));
    r.set("modified_at".into(), f.modified_at.clone().map(Value::String).unwrap_or(Value::Null));
    // In watch (event=Some) la riga porta SEMPRE `event` e `old_path` (coerenza
    // di schema con le righe magre); `old_path` è Null se non è un rename atomico.
    // In scan (event=None) nessuno dei due, come da schema scan.
    if let Some(e) = event {
        r.set("event".into(),    Value::String(e.to_string()));
        r.set("old_path".into(), old_path.map(|s| Value::String(s.to_string())).unwrap_or(Value::Null));
    }
    r
}

/// Riga MAGRA per `delete` / `rename`-from: il file NON esiste più → path e
/// derivati dal path, size/date a NULL. Stessi campi di una riga watch piena
/// (schema coerente) ma valori nulli dove manca il file — NON si salta la riga.
fn to_row_magra(path: &str, event: &str, old_path: Option<&str>) -> Row {
    let filename = Path::new(path).file_name()
        .map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = filename.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
    let dir_of = Path::new(path).parent()
        .map(|pp| pp.to_string_lossy().to_string()).unwrap_or_default();
    let mut r = Row::new();
    r.set("path".into(),        Value::String(path.to_string()));
    r.set("filename".into(),    Value::String(filename));
    r.set("extension".into(),   Value::String(ext));
    r.set("directory".into(),   Value::String(dir_of));
    r.set("size".into(),        Value::Null);
    r.set("created_at".into(),  Value::Null);
    r.set("modified_at".into(), Value::Null);
    r.set("event".into(),       Value::String(event.to_string()));
    r.set("old_path".into(),    old_path.map(|s| Value::String(s.to_string())).unwrap_or(Value::Null));
    r
}

/// Traduce la prop `events` in un set di eventi ammessi (vocabolario
/// new/update/rename/delete). Retro-compat coi vecchi token: create→new,
/// modify→update. "all" o vuoto = tutti e quattro.
fn parse_events_filter(raw: &str) -> HashSet<String> {
    let all = || ["new", "update", "rename", "delete"].iter().map(|s| s.to_string()).collect::<HashSet<String>>();
    let raw = raw.trim();
    if raw.is_empty() || raw.eq_ignore_ascii_case("all") { return all(); }
    let mut set = HashSet::new();
    for tok in raw.split(',') {
        let norm = match tok.trim().to_ascii_lowercase().as_str() {
            "create"           => "new",      // retro-compat vecchio vocabolario
            "modify"           => "update",   // retro-compat
            "new"              => "new",
            "update"           => "update",
            "rename"           => "rename",
            "delete"           => "delete",
            _                  => continue,
        };
        set.insert(norm.to_string());
    }
    if set.is_empty() { all() } else { set }
}

/// Mappa UN evento `notify` grezzo sulle righe da emettere: triple
/// (path, event, old_path). Vocabolario new/update/rename/delete; metadata/
/// permessi esclusi; rename atomico (Both, due path) → una riga `rename` con
/// old_path, from→delete, to→new, ambiguo→"rename" (risolto in emissione per
/// esistenza file). CONDIVISA da watch one-shot e continuo (fetta 3).
pub(crate) fn map_watch_event(ev: &notify::Event, out: &mut Vec<(String, String, Option<String>)>) {
    use notify::EventKind;
    use notify::event::{ModifyKind, RenameMode};
    let paths: Vec<String> = ev.paths.iter().map(|p| p.to_string_lossy().to_string()).collect();
    match &ev.kind {
        EventKind::Create(_) => { for p in paths { out.push((p, "new".into(), None)); } }
        EventKind::Remove(_) => { for p in paths { out.push((p, "delete".into(), None)); } }
        EventKind::Modify(ModifyKind::Data(_)) | EventKind::Modify(ModifyKind::Any) => {
            for p in paths { out.push((p, "update".into(), None)); }
        }
        EventKind::Modify(ModifyKind::Metadata(_)) => { /* rumore ETL: escluso */ }
        EventKind::Modify(ModifyKind::Name(mode)) => match mode {
            RenameMode::Both if paths.len() >= 2 => {
                out.push((paths[1].clone(), "rename".into(), Some(paths[0].clone())));
            }
            RenameMode::From => { for p in paths { out.push((p, "delete".into(), None)); } }
            RenameMode::To   => { for p in paths { out.push((p, "new".into(), None)); } }
            _ => { for p in paths { out.push((p, "rename".into(), None)); } }
        },
        _ => {}
    }
}

/// Trasforma una sequenza di eventi `notify` GREZZI in righe e le emette su
/// `tx`: mappa (map_watch_event) → dedup per path first-wins → filtro
/// pattern+eventi → riga PIENA se il file esiste, MAGRA (size/date NULL) se è
/// sparito (delete/rename-from), senza saltarla. Ritorna il numero di righe
/// emesse. CONDIVISA da watch one-shot (drena il suo canale → Vec → qui) e
/// continuo (slot run-scoped → Vec → qui, fetta 3).
pub(crate) async fn emit_watch(
    events:   &[notify::Event],
    allowed:  &HashSet<String>,
    pattern:  &str,
    min_size: u64,
    limit:    usize,
    tx:       &RowSender,
) -> u64 {
    let mut mapped: Vec<(String, String, Option<String>)> = Vec::new();
    for ev in events { map_watch_event(ev, &mut mapped); }

    let mut seen: HashSet<String> = HashSet::new();
    let mut rows_out = 0u64;
    for (path, event, old_path) in mapped {
        if !seen.insert(path.clone()) { continue; }   // first-wins per path
        let filename = Path::new(&path).file_name()
            .map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !glob_match(pattern, &filename) { continue; }

        match std::fs::metadata(&path) {
            Ok(meta) if meta.is_file() => {
                if !allowed.contains(event.as_str()) { continue; }
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
                if tx.send(to_row(&fi, Some(&event), old_path.as_deref())).await.is_err() { break; }
            }
            _ => {
                // File assente: rename ambiguo → delete; altrimenti tieni l'evento.
                let ev2 = if event == "rename" { "delete" } else { event.as_str() };
                if !allowed.contains(ev2) { continue; }
                rows_out += 1;
                if tx.send(to_row_magra(&path, ev2, old_path.as_deref())).await.is_err() { break; }
            }
        }
        if limit > 0 && rows_out as usize >= limit { break; }
    }
    rows_out
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
            if tx.send(to_row(f, None, None)).await.is_err() { break; }
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
    use notify::{RecursiveMode, Watcher};

    let timeout_sec = match spec.u64_or("watchTimeoutSec", 300) { 0 => 86_400, n => n };
    let debounce = Duration::from_millis(spec.u64_or("debounceMs", 300).max(50));

    // Filtro eventi (prop `events`, prima INERTE nel motore → ora onorata).
    // Vocabolario new/update/rename/delete; retro-compat create/modify.
    let allowed = parse_events_filter(&spec.str_or("events", "all"));

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

    // Drena i `notify::Event` GREZZI (attesa bloccante fuori dal runtime async):
    // primo evento entro il tetto, poi il burst ravvicinato entro il debounce.
    // La trasformazione in righe è delegata a `emit_watch` (condivisa col continuo).
    let wait_timeout = Duration::from_secs(timeout_sec);
    let events: Vec<notify::Event> = tokio::task::spawn_blocking(move || {
        let mut out: Vec<notify::Event> = Vec::new();
        match ev_rx.recv_timeout(wait_timeout) {
            Ok(Ok(ev)) => out.push(ev),
            _ => return out,
        }
        while let Ok(Ok(ev)) = ev_rx.recv_timeout(debounce) {
            out.push(ev);
        }
        out
    }).await.map_err(|e| format!("dir_watcher {}: attesa evento: {}", ctx.node_id.0, e))?;

    drop(watcher); // smette di ascoltare

    let rows_out = emit_watch(&events, &allowed, &pattern, min_size, limit, &tx).await;

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
