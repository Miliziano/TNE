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
// La cartella arriva dai props (pathSource=static), da una variabile di lane
// (lane_var, `laneVarName`) o dal primo record in ingresso (pathSource=flow,
// campo `pathField`; non nel continuo). Porte: input(innesco/path, R8) →
// output; `reject` dichiarato ma INERTE in v1.
//
// P363 — opzioni del pannello ora applicate:
//   stabilityMs  (watch) un file si emette quando dimensione e data non
//                cambiano per quel tempo: non si legge un file mentre lo si
//                sta ancora copiando. Tetto 5 minuti, poi si emette con un avviso.
//   dedupMode    none | path | path_mtime | hash (sha-256 del contenuto) —
//   dedupStore   memory (dentro il run: nel continuo, fra le sessioni) |
//   dedupFile    file (JSON, relativo alla cartella osservata se non assoluto;
//                persiste fra i run). Un file conta come "già emesso" solo
//                quando i nodi a valle hanno finito SENZA errori: se la
//                sessione fallisce, al giro dopo lo si riprende.
//   sortBy       name | created | modified | size
//   maxAgeMin    anche in watch.

use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime};
use tokio_util::sync::CancellationToken;
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

/// Filtri e opzioni comuni a scan e watch.
pub(crate) struct WatchOpts {
    pub allowed:      HashSet<String>,
    pub pattern:      String,
    pub min_size:     u64,
    pub max_age_min:  u64,
    pub limit:        usize,
    pub stability_ms: u64,
}

/// Info di un file esistente (None se non c'è o non è un file regolare).
fn file_info(path: &str) -> Option<FileInfo> {
    let meta = std::fs::metadata(path).ok()?;
    if !meta.is_file() { return None }
    let filename = Path::new(path).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let mtime = meta.modified().unwrap_or(SystemTime::UNIX_EPOCH);
    let ext = filename.rsplit_once('.').map(|(_, e)| e.to_string()).unwrap_or_default();
    let directory = Path::new(path).parent().map(|pp| pp.to_string_lossy().to_string()).unwrap_or_default();
    Some(FileInfo {
        path: path.to_string(), filename, extension: ext, directory,
        size: meta.len(),
        created_at:  meta.created().ok().map(systime_rfc3339),
        modified_at: Some(systime_rfc3339(mtime)),
        mtime,
    })
}

fn too_old(f: &FileInfo, max_age_min: u64) -> bool {
    max_age_min > 0 && SystemTime::now().duration_since(f.mtime).map(|a| a.as_secs() / 60 > max_age_min).unwrap_or(false)
}

/// Stabilità (P363): aspetta che dimensione e data dei file non cambino per
/// `ms`. Un file sparito nel frattempo si scarta. Tetto 5 minuti: i file
/// ancora in movimento si emettono comunque (secondo valore = quanti).
async fn wait_stable(files: Vec<FileInfo>, ms: u64, cancel: &CancellationToken) -> (Vec<FileInfo>, usize) {
    if ms == 0 || files.is_empty() { return (files, 0) }
    let cap = Instant::now() + Duration::from_secs(300);
    let mut pending = files;
    let mut stable: Vec<FileInfo> = Vec::new();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return (Vec::new(), 0),
            _ = tokio::time::sleep(Duration::from_millis(ms)) => {}
        }
        let mut still = Vec::new();
        for f in pending {
            match file_info(&f.path) {
                Some(now) if now.size == f.size && now.mtime == f.mtime => stable.push(now),
                Some(now) => still.push(now),
                None => {}   // sparito: niente da emettere
            }
        }
        pending = still;
        if pending.is_empty() { return (stable, 0) }
        if Instant::now() >= cap {
            let n = pending.len();
            stable.extend(pending);
            return (stable, n);
        }
    }
}

/// Trasforma una sequenza di eventi `notify` GREZZI in righe e le emette su
/// `tx`: mappa (map_watch_event) → dedup per path first-wins → filtro
/// pattern+eventi → riga PIENA se il file esiste, MAGRA (size/date NULL) se è
/// sparito (delete/rename-from), senza saltarla. I file esistenti passano da
/// stabilità e deduplicazione (P363). Ritorna (righe emesse, file ancora
/// instabili). CONDIVISA da watch one-shot e continuo.
pub(crate) async fn emit_watch(
    events: &[notify::Event],
    o:      &WatchOpts,
    dedup:  &mut Dedup,
    cancel: &CancellationToken,
    tx:     &RowSender,
) -> (u64, usize) {
    let mut mapped: Vec<(String, String, Option<String>)> = Vec::new();
    for ev in events { map_watch_event(ev, &mut mapped); }

    // Prima si separano i file presenti (righe piene) dalle righe magre.
    enum Item { Full(String, String, Option<String>), Lean(String, String, Option<String>) }
    let mut seen: HashSet<String> = HashSet::new();
    let mut items: Vec<Item> = Vec::new();
    let mut present: Vec<FileInfo> = Vec::new();
    for (path, event, old_path) in mapped {
        if !seen.insert(path.clone()) { continue; }   // first-wins per path
        let filename = Path::new(&path).file_name()
            .map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
        if !glob_match(&o.pattern, &filename) { continue; }
        if dedup.is_state_file(&path) { continue; }
        match file_info(&path) {
            Some(fi) => {
                if !o.allowed.contains(event.as_str()) { continue; }
                if o.min_size > 0 && fi.size < o.min_size { continue; }
                if too_old(&fi, o.max_age_min) { continue; }
                items.push(Item::Full(path, event, old_path));
                present.push(fi);
            }
            None => {
                // File assente: rename ambiguo → delete; altrimenti tieni l'evento.
                let ev2 = if event == "rename" { "delete".to_string() } else { event };
                if !o.allowed.contains(ev2.as_str()) { continue; }
                items.push(Item::Lean(path, ev2, old_path));
            }
        }
    }

    let (stable, unstable) = wait_stable(present, o.stability_ms, cancel).await;
    let by_path: HashMap<String, FileInfo> = stable.into_iter().map(|f| (f.path.clone(), f)).collect();

    let mut rows_out = 0u64;
    for it in items {
        let row = match it {
            Item::Full(path, event, old_path) => {
                // sparito durante l'attesa di stabilità: niente riga
                let Some(fi) = by_path.get(&path) else { continue };
                if !dedup.admit(fi) { continue; }
                to_row(fi, Some(&event), old_path.as_deref())
            }
            Item::Lean(path, event, old_path) => to_row_magra(&path, &event, old_path.as_deref()),
        };
        rows_out += 1;
        if tx.send(row).await.is_err() { break; }
        if o.limit > 0 && rows_out as usize >= o.limit { break; }
    }
    (rows_out, unstable)
}

// ─── Deduplicazione (P363) ──────────────────────────────────────────

/// Chiavi già emesse, per run (nel continuo valgono fra le sessioni).
fn memory_seen() -> &'static Mutex<HashMap<String, HashSet<String>>> {
    static SEEN: OnceLock<Mutex<HashMap<String, HashSet<String>>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Fine del run continuo: si dimenticano le chiavi in memoria del nodo.
pub(crate) fn forget_seen(key: &str) {
    memory_seen().lock().unwrap().remove(key);
}

pub(crate) struct Dedup {
    mode:     String,              // none | path | path_mtime | hash
    file:     Option<PathBuf>,     // dedupStore = file
    reg_key:  String,              // dedupStore = memory
    seen:     HashSet<String>,
    new_keys: Vec<String>,
}

impl Dedup {
    fn load(spec: &Spec, directory: &str, reg_key: String) -> Result<Dedup, String> {
        // `dedupMode` (P363), non il vecchio `dedup`: il pannello salvava
        // `dedup: 'path'` su ogni nodo e non era mai applicato — leggerlo
        // ora cambierebbe i flussi continui esistenti (gli `update` di un
        // file già visto sparirebbero). Assente = nessuna deduplicazione.
        let mode = spec.str_or("dedupMode", "none");
        let mode = if mode.is_empty() { "none".to_string() } else { mode };
        if !matches!(mode.as_str(), "none" | "path" | "path_mtime" | "hash") {
            return Err(format!("unknown deduplication '{}'", mode));
        }
        let to_file = mode != "none" && spec.str_or("dedupStore", "memory") == "file";
        let file = if to_file {
            let f = spec.str_or("dedupFile", ".flowpilot_dw_state.json");
            let f = if f.trim().is_empty() { ".flowpilot_dw_state.json".to_string() } else { f.trim().to_string() };
            let p = PathBuf::from(&f);
            Some(if p.is_absolute() { p } else { Path::new(directory).join(p) })
        } else { None };
        let seen: HashSet<String> = match &file {
            Some(f) if f.exists() => {
                let text = std::fs::read_to_string(f).map_err(|e| format!("cannot read the state file '{}': {}", f.display(), e))?;
                serde_json::from_str::<Vec<String>>(&text)
                    .map_err(|e| format!("the state file '{}' is not valid: {}", f.display(), e))?
                    .into_iter().collect()
            }
            Some(_) => HashSet::new(),
            None => memory_seen().lock().unwrap().get(&reg_key).cloned().unwrap_or_default(),
        };
        Ok(Dedup { mode, file, reg_key, seen, new_keys: Vec::new() })
    }

    /// Il file di stato non è mai un file da emettere.
    fn is_state_file(&self, path: &str) -> bool {
        self.file.as_ref().map(|f| Path::new(path) == f.as_path()).unwrap_or(false)
    }

    fn key(&self, f: &FileInfo) -> Option<String> {
        match self.mode.as_str() {
            "path" => Some(format!("p:{}", f.path)),
            "path_mtime" => {
                let secs = f.mtime.duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
                Some(format!("m:{}|{}|{}", f.path, secs, f.size))
            }
            "hash" => {
                use sha2::{Digest, Sha256};
                let bytes = std::fs::read(&f.path).ok()?;
                Some(format!("h:{}", hex::encode(Sha256::digest(&bytes))))
            }
            _ => None,
        }
    }

    /// true = il file va emesso (e la sua chiave si ricorda).
    fn admit(&mut self, f: &FileInfo) -> bool {
        let Some(k) = self.key(f) else { return true };
        if self.seen.contains(&k) { return false }
        self.seen.insert(k.clone());
        self.new_keys.push(k);
        true
    }

    /// Registra le chiavi nuove (memoria del run o file di stato).
    fn commit(&self) -> Result<(), String> {
        if self.new_keys.is_empty() { return Ok(()) }
        match &self.file {
            Some(f) => {
                let mut all: Vec<&String> = self.seen.iter().collect();
                all.sort();
                let text = serde_json::to_string_pretty(&all).map_err(|e| e.to_string())?;
                let tmp = f.with_extension("tmp");
                std::fs::write(&tmp, text).map_err(|e| format!("cannot write the state file '{}': {}", tmp.display(), e))?;
                std::fs::rename(&tmp, f).map_err(|e| format!("cannot write the state file '{}': {}", f.display(), e))
            }
            None => {
                let mut reg = memory_seen().lock().unwrap();
                reg.entry(self.reg_key.clone()).or_default().extend(self.new_keys.iter().cloned());
                Ok(())
            }
        }
    }
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
    let fail = |m: String| -> Result<NodeStats, String> {
        let msg = format!("dir_watcher {}: {}", ctx.node_id.0, m);
        ctx.emit_failed(msg.clone());
        Err(msg)
    };

    let mode = spec.str_or("mode", "scan");
    let directory = match resolve_directory(&spec, &ctx.variables, first_input.as_ref()) {
        Ok(d) => d,
        Err(e) => return fail(e),
    };

    let opts = WatchOpts {
        allowed:      parse_events_filter(&spec.str_or("events", "all")),
        pattern:      spec.str_or("pattern", "*"),
        min_size:     spec.u64_or("minSize", 0),
        max_age_min:  spec.u64_or("maxAgeMin", 0),
        limit:        spec.u64_or("limit", 0) as usize,
        stability_ms: if mode == "watch" { spec.u64_or("stabilityMs", 0) } else { 0 },
    };
    let recursive = spec.bool_or("recursive", false);
    let sort_by   = spec.str_or("sortBy", "name");
    let sort_dir  = spec.str_or("sortDir", "asc");
    let continuo  = mode == "watch" && spec.str_or("submode", "oneshot") == "continuo";
    let reg_key   = crate::engine::watch_subs::watch_key(&ctx.run_id.0, &ctx.node_id.0);
    let mut dedup = match Dedup::load(&spec, &directory, reg_key.clone()) { Ok(d) => d, Err(e) => return fail(e) };
    spec.log_unconsumed("dir_watcher", &ctx.node_id.0);

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let start = Instant::now();
    if !continuo {
        ctx.emit_log(&ctx.label, "info", 0,
            format!("DirWatcher ({}): {} — pattern {}", mode, directory, opts.pattern), "panel");
    }

    let (rows_out, unstable) = if mode != "watch" {
        // ── SCAN ──────────────────────────────────────────────────
        let mut files = Vec::new();
        scan_dir(&directory, &opts.pattern, recursive, opts.max_age_min, opts.min_size, &mut files);
        files.retain(|f| !dedup.is_state_file(&f.path));
        sort_files(&mut files, &sort_by, &sort_dir);
        let mut rows_out = 0u64;
        for f in &files {
            if !dedup.admit(f) { continue }
            rows_out += 1;
            if tx.send(to_row(f, None, None)).await.is_err() { break; }
            if opts.limit > 0 && rows_out as usize >= opts.limit { break; }
        }
        (rows_out, 0)
    } else if continuo {
        // ── WATCH CONTINUO (fetta 3) — ADATTATORE ─────────────────
        // In continuo il nodo NON ascolta il SO: il loop di sessione dell'engine
        // (engine/mod.rs) ha già depositato il gruppo di eventi GREZZI di QUESTA
        // sessione nello slot run-scoped (watch_subs). Qui li preleva ed emette con
        // lo STESSO emettitore dell'one-shot (`emit_watch`). Ritorna → la lane
        // committa e chiude; il loop la ri-esegue al gruppo successivo.
        let events = crate::engine::watch_subs::take_group(&reg_key);
        emit_watch(&events, &opts, &mut dedup, &ctx.cancel, &tx).await
    } else {
        // ── WATCH ONE-SHOT — attesa dell'evento REALE del SO (crate `notify`) ─
        // FASE 1: sottoscrive la cartella, BLOCCA sull'evento (attesa efficiente,
        // niente polling né loop occupato), al primo evento (o piccolo batch entro
        // un debounce) emette i file coinvolti e RITORNA → la lane processa fino
        // all'uscita. `watchTimeoutSec` è un TETTO di sicurezza (se non arriva
        // nulla ritorna a vuoto, così il run finito non resta appeso).
        use notify::{RecursiveMode, Watcher};

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
            format!("DirWatcher watch: listening on {} (OS events, cap {}s)", directory, timeout_sec), "panel");

        // Drena i `notify::Event` GREZZI (attesa bloccante fuori dal runtime async):
        // primo evento entro il tetto, poi il burst ravvicinato entro il debounce.
        let wait_timeout = Duration::from_secs(timeout_sec);
        let node_id_err = ctx.node_id.0.clone();
        let join = tokio::task::spawn_blocking(move || {
            let mut out: Vec<notify::Event> = Vec::new();
            match ev_rx.recv_timeout(wait_timeout) {
                Ok(Ok(ev)) => out.push(ev),
                _ => return out,
            }
            while let Ok(Ok(ev)) = ev_rx.recv_timeout(debounce) {
                out.push(ev);
            }
            out
        });
        // P112 — CANCELLABILE: `select!` fra il thread e `ctx.cancel`; il thread
        // abbandonato si sblocca appena si droppa `watcher`.
        let events: Vec<notify::Event> = tokio::select! {
            _   = ctx.cancel.cancelled() => Vec::new(),
            res = join => res.map_err(|e| format!("dir_watcher {}: attesa evento: {}", node_id_err, e))?,
        };
        drop(watcher); // smette di ascoltare (e sblocca il thread se cancellati)
        emit_watch(&events, &opts, &mut dedup, &ctx.cancel, &tx).await
    };

    if unstable > 0 {
        ctx.emit_log(&ctx.label, "warn", 0,
            format!("{} file(s) were still changing after 5 minutes and were emitted anyway", unstable), "panel");
    }

    // Deduplicazione: i file emessi contano come "già visti" solo se i nodi
    // a valle finiscono senza errori (altrimenti al giro dopo si riprendono).
    drop(tx);
    if !dedup.new_keys.is_empty() {
        let downstream = ctx.lane_done.downstream_all(&ctx.node_id.0);
        let failed = ctx.lane_done.wait_all(&downstream).await;
        if failed.is_empty() {
            if let Err(e) = dedup.commit() { return fail(e) }
        } else {
            ctx.emit_log(&ctx.label, "warn", 0,
                format!("{} file(s) not marked as processed: downstream node(s) failed ({})", dedup.new_keys.len(), failed.join(", ")), "panel");
        }
    }
    // Fuori dal continuo la memoria del run non serve oltre questo nodo.
    if !continuo { forget_seen(&reg_key); }

    let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

/// La cartella da osservare, secondo pathSource (static | lane_var | flow).
/// Usata anche dal loop del continuo (engine/mod.rs), senza la riga in ingresso.
pub(crate) fn resolve_directory(spec: &Spec, variables: &HashMap<String, Value>, input: Option<&Row>) -> Result<String, String> {
    let dir = match spec.str_or("pathSource", "static").as_str() {
        "lane_var" => {
            let var = spec.str_or("laneVarName", "");
            if var.is_empty() { return Err("the directory comes from a lane variable, but no variable is selected".into()) }
            match variables.get(&var) {
                Some(Value::Null) | None => return Err(format!("lane variable '{}' is not set", var)),
                Some(v) => v.as_str_repr(),
            }
        }
        "flow" => {
            let field = spec.str_or("pathField", "path");
            let Some(row) = input else {
                return Err(format!("the directory comes from the incoming flow, but no row arrived (field '{}')", field));
            };
            row.get(&field).map(|v| v.as_str_repr()).unwrap_or_default()
        }
        _ => spec.str_or("directory", ""),
    };
    let dir = dir.trim().trim_end_matches('/').to_string();
    if dir.is_empty() { return Err("directory not configured".into()) }
    Ok(dir)
}

fn sort_files(files: &mut [FileInfo], sort_by: &str, sort_dir: &str) {
    files.sort_by(|a, b| {
        let o = match sort_by {
            "size"     => a.size.cmp(&b.size),
            "modified" => a.mtime.cmp(&b.mtime),
            // RFC 3339 in UTC: l'ordine delle stringhe è quello del tempo.
            "created"  => a.created_at.cmp(&b.created_at),
            _          => a.filename.to_lowercase().cmp(&b.filename.to_lowercase()),
        };
        if sort_dir == "desc" { o.reverse() } else { o }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec(props: serde_json::Value) -> Spec {
        Spec::from_ctx(&serde_json::json!({"props": props, "config": {}})).unwrap()
    }

    fn tmpdir(nome: &str) -> String {
        let d = std::env::temp_dir().join(format!("fp-dw-{}-{}", nome, std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d.to_string_lossy().to_string()
    }

    #[test]
    fn cartella_da_variabile() {
        let mut vars = HashMap::new();
        vars.insert("cartella".to_string(), Value::String("/dati/in/".into()));
        let sp = spec(serde_json::json!({"pathSource": "lane_var", "laneVarName": "cartella"}));
        assert_eq!(resolve_directory(&sp, &vars, None).unwrap(), "/dati/in");
        let sp = spec(serde_json::json!({"pathSource": "lane_var", "laneVarName": "manca"}));
        assert!(resolve_directory(&sp, &vars, None).is_err());
        let sp = spec(serde_json::json!({"pathSource": "flow", "pathField": "p"}));
        assert!(resolve_directory(&sp, &vars, None).is_err());
    }

    #[test]
    fn deduplicazione_su_file() {
        let dir = tmpdir("dedup");
        let f = format!("{}/a.csv", dir);
        std::fs::write(&f, "x").unwrap();
        let fi = file_info(&f).unwrap();
        let sp = spec(serde_json::json!({"dedupMode": "path_mtime", "dedupStore": "file"}));
        let mut d = Dedup::load(&sp, &dir, "k1".into()).unwrap();
        assert!(d.is_state_file(&format!("{}/.flowpilot_dw_state.json", dir)));
        assert!(d.admit(&fi));
        assert!(!d.admit(&fi));          // stesso giro: già visto
        d.commit().unwrap();
        let mut d2 = Dedup::load(&sp, &dir, "k1".into()).unwrap();
        assert!(!d2.admit(&fi));         // giro dopo: ricordato nel file
        std::thread::sleep(Duration::from_millis(20));
        std::fs::write(&f, "xy").unwrap();
        assert!(d2.admit(&file_info(&f).unwrap()));   // cambiato: di nuovo
        // vecchia chiave `dedup` ignorata: nessuna deduplicazione
        let mut d3 = Dedup::load(&spec(serde_json::json!({"dedup": "path"})), &dir, "k2".into()).unwrap();
        assert!(d3.admit(&fi) && d3.admit(&fi));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[tokio::test]
    async fn stabilita() {
        let dir = tmpdir("stab");
        let f = format!("{}/b.csv", dir);
        std::fs::write(&f, "1").unwrap();
        let fi = file_info(&f).unwrap();
        let f2 = f.clone();
        let w = std::thread::spawn(move || {
            for i in 0..4 {
                std::thread::sleep(Duration::from_millis(120));
                std::fs::write(&f2, "1".repeat(i + 2)).unwrap();
            }
        });
        let t = Instant::now();
        let (out, unstable) = wait_stable(vec![fi], 300, &CancellationToken::new()).await;
        w.join().unwrap();
        assert_eq!(unstable, 0);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].size, 5);                       // la dimensione finale
        assert!(t.elapsed() >= Duration::from_millis(480));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
