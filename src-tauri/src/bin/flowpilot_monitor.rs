// src-tauri/src/bin/flowpilot_monitor.rs
//
// MONITOR centralizzato di FlowPilot (primo passo).
// Riceve in PUSH gli eventi (NDJSON, un EngineEvent per riga) dai runner della
// flotta, li aggrega per `run_id` in memoria, e offre una vista web minimale.
// E' standalone: dipende solo da tiny_http + serde_json (NIENTE Tauri, niente
// app_lib). Lo schema degli eventi e' un CONTRATTO JSON (`{type, payload}`),
// quindi qui vengono trattati genericamente (nessuna dipendenza dal tipo Rust).
// Storage: in memoria + PERSISTENZA su file (un NDJSON per run, append all'ingest;
// ricarica all'avvio -> un riavvio non perde lo storico).
//
// Build:  cargo build --bin flowpilot_monitor --no-default-features --features monitor --release
// Uso:    flowpilot_monitor [porta]        (default 8787)
//   Env:  MONITOR_DATA_DIR=<cartella>      (default: flowpilot-monitor-data)
//   - i runner pushano su:  POST http://<host>:<porta>/ingest   (body NDJSON)
//   - vista web:            GET  http://<host>:<porta>/
//   - API:                  GET /api/runs   e   GET /api/runs/<run_id>

use std::collections::HashMap;
use std::io::{Cursor, Read, Write};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tiny_http::{Header, Method, Response, Server};

#[derive(Default)]
struct RunState {
    events: Vec<Value>,
    status: String, // "running" | "completed" | "failed"
    last_seen_ms: u64,
}

type Store = Arc<Mutex<HashMap<String, RunState>>>;
type Resp = Response<Cursor<Vec<u8>>>;

fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn json_resp(v: &Value) -> Resp {
    Response::from_string(v.to_string())
        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"application/json"[..]).unwrap())
}

fn html_resp(html: &str) -> Resp {
    Response::from_string(html.to_string())
        .with_header(Header::from_bytes(&b"Content-Type"[..], &b"text/html; charset=utf-8"[..]).unwrap())
}

/// run_id -> nome file sicuro (solo alfanumerici, `-`, `_`; il resto -> `_`).
fn safe_name(run_id: &str) -> String {
    let s: String = run_id
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    if s.is_empty() { "sconosciuto".to_string() } else { s }
}

/// Percorso del file NDJSON di un run: <data_dir>/<run_id>.ndjson
fn run_file_path(dir: &str, run_id: &str) -> std::path::PathBuf {
    std::path::Path::new(dir).join(format!("{}.ndjson", safe_name(run_id)))
}

/// Applica un evento gia' elaborato allo store in memoria (stato + last_seen + append).
/// Condiviso da ingest (push dai runner) e load_persisted (ricarica da disco).
fn apply_to_store(s: &mut HashMap<String, RunState>, run_id: String, ty: &str, event_ts: u64, ev: Value) {
    let entry = s.entry(run_id).or_default();
    if entry.status.is_empty() {
        entry.status = "running".to_string();
    }
    match ty {
        "RunCompleted" => entry.status = "completed".to_string(),
        "RunFailed" => entry.status = "failed".to_string(),
        _ => {}
    }
    entry.last_seen_ms = event_ts;
    entry.events.push(ev);
}

/// Elabora una riga NDJSON grezza -> (run_id, tipo, timestamp, evento-con-`ts`).
/// None se e' un'intestazione autodescrittiva o non e' JSON valido.
/// Tollerante: riga INCAPSULATA `{timestamp, event}` (col tempo d'origine), riga
/// NUDA `{type, payload}` (retrocompat), o riga gia' persistita da noi (ha gia' `ts`).
fn process_line(line: &str) -> Option<(String, String, u64, Value)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let raw: Value = serde_json::from_str(line).ok()?;

    // Intestazione autodescrittiva del log: NON e' un evento (non crea un run fasullo).
    if raw.get("kind").and_then(|v| v.as_str()) == Some("flowpilot-log-header") {
        return None;
    }

    // Calcolo prima i valori POSSEDUTI (niente prestito vivo su `raw`), poi o clono
    // l'evento interno (riga incapsulata) o muovo `raw` (riga nuda / gia' persistita).
    let src_ts = raw.get("timestamp").and_then(|v| v.as_u64());
    let wrapped = src_ts.is_some() && raw.get("event").map(|e| e.is_object()).unwrap_or(false);
    let mut ev = if wrapped {
        raw.get("event").cloned().unwrap_or(Value::Null)
    } else {
        raw
    };

    // Preferenza del tempo: `ts` gia' presente (nostro file persistito) > timestamp
    // d'ORIGINE dell'incapsulamento > tempo di ricezione (ripiego per i log nudi).
    let event_ts = ev
        .get("ts").and_then(|v| v.as_u64())
        .or(src_ts)
        .unwrap_or_else(now_ms);

    let run_id = ev
        .get("payload").and_then(|p| p.get("run_id")).and_then(|v| v.as_str())
        .or_else(|| ev.get("run_id").and_then(|v| v.as_str()))
        .unwrap_or("sconosciuto")
        .to_string();
    let ty = ev.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // Timbro il tempo su OGNI evento memorizzato (campo `ts`): viste future ordinano/
    // aggregano per tempo reale, uniformemente. Idempotente sui file gia' persistiti.
    if let Some(obj) = ev.as_object_mut() {
        obj.insert("ts".to_string(), Value::from(event_ts));
    }

    Some((run_id, ty, event_ts, ev))
}

/// Ricarica all'avvio i run gia' salvati su disco (chiude la volatilita': un riavvio
/// del monitor non perde piu' lo storico). Legge ogni <data_dir>/*.ndjson.
fn load_persisted(store: &Store, data_dir: &str) {
    let entries = match std::fs::read_dir(data_dir) {
        Ok(e) => e,
        Err(_) => return, // cartella assente o illeggibile -> niente da ricaricare
    };
    let mut s = store.lock().unwrap();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|x| x.to_str()) != Some("ndjson") {
            continue;
        }
        if let Ok(content) = std::fs::read_to_string(&path) {
            for line in content.lines() {
                if let Some((run_id, ty, event_ts, ev)) = process_line(line) {
                    apply_to_store(&mut s, run_id, &ty, event_ts, ev);
                }
            }
        }
    }
}

fn ingest(body: &str, store: &Store, data_dir: &str) {
    // Fase 1 (sotto lock): applica in memoria e accumula per run le righe da persistere.
    let mut to_persist: HashMap<String, String> = HashMap::new();
    {
        let mut s = store.lock().unwrap();
        for line in body.lines() {
            if let Some((run_id, ty, event_ts, ev)) = process_line(line) {
                let persisted = ev.to_string(); // l'evento gia' con `ts`
                apply_to_store(&mut s, run_id.clone(), &ty, event_ts, ev);
                let buf = to_persist.entry(run_id).or_default();
                buf.push_str(&persisted);
                buf.push('\n');
            }
        }
    } // rilascio il lock PRIMA dell'I/O su file (non blocca le altre richieste)

    // Fase 2 (fuori dal lock): append best-effort, un file per run. Una scrittura
    // fallita NON rompe l'ingest: i dati restano comunque in memoria.
    for (run_id, lines) in &to_persist {
        let path = run_file_path(data_dir, run_id);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let _ = f.write_all(lines.as_bytes());
        }
    }
}

fn route(req: &mut tiny_http::Request, store: &Store, data_dir: &str) -> Resp {
    let method = req.method().clone();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or(&url).to_string();

    match (method, path.as_str()) {
        (Method::Post, "/ingest") => {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            ingest(&body, store, data_dir);
            json_resp(&serde_json::json!({ "ok": true }))
        }
        (Method::Get, "/api/runs") => {
            let s = store.lock().unwrap();
            let mut runs: Vec<Value> = s
                .iter()
                .map(|(id, r)| {
                    serde_json::json!({
                        "run_id": id,
                        "status": r.status,
                        "events": r.events.len(),
                        "last_seen_ms": r.last_seen_ms,
                    })
                })
                .collect();
            // piu' recenti in cima
            runs.sort_by(|a, b| b["last_seen_ms"].as_u64().cmp(&a["last_seen_ms"].as_u64()));
            json_resp(&serde_json::json!({ "runs": runs }))
        }
        (Method::Get, p) if p.starts_with("/api/runs/") => {
            let id = &p["/api/runs/".len()..];
            let s = store.lock().unwrap();
            match s.get(id) {
                Some(r) => json_resp(&serde_json::json!({
                    "run_id": id, "status": r.status, "events": r.events
                })),
                None => json_resp(&serde_json::json!({ "error": "run non trovato" })),
            }
        }
        (Method::Get, _) => html_resp(INDEX_HTML),
        _ => Response::from_string("not found").with_status_code(404),
    }
}

fn main() {
    let port: u16 = std::env::args().nth(1).and_then(|s| s.parse().ok()).unwrap_or(8787);
    let data_dir = std::env::var("MONITOR_DATA_DIR")
        .unwrap_or_else(|_| "flowpilot-monitor-data".to_string());
    let addr = format!("0.0.0.0:{}", port);
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("impossibile avviare il monitor su {}: {}", addr, e);
            std::process::exit(1);
        }
    };

    let store: Store = Arc::new(Mutex::new(HashMap::new()));

    // Persistenza: crea la cartella dati e RICARICA i run gia' salvati -> un riavvio
    // del monitor non perde piu' lo storico (chiude la volatilita' di M1).
    if let Err(e) = std::fs::create_dir_all(&data_dir) {
        eprintln!("attenzione: cartella dati '{}' non creabile: {} (persistenza disattivata)", data_dir, e);
    }
    load_persisted(&store, &data_dir);
    let loaded = store.lock().map(|s| s.len()).unwrap_or(0);
    eprintln!(
        "FlowPilot monitor su http://{}  (ingest: POST /ingest, vista: GET /; dati in '{}', run caricati: {})",
        addr, data_dir, loaded
    );

    let data_dir = Arc::new(data_dir);
    for mut req in server.incoming_requests() {
        let store = store.clone();
        let data_dir = data_dir.clone();
        std::thread::spawn(move || {
            let resp = route(&mut req, &store, &data_dir);
            let _ = req.respond(resp);
        });
    }
}

const INDEX_HTML: &str = r#"<!doctype html>
<html lang="it"><head><meta charset="utf-8"><title>FlowPilot Monitor</title>
<style>
  body{margin:0;background:#141a26;color:#c8d4f0;font:13px/1.5 system-ui,sans-serif}
  header{padding:12px 18px;border-bottom:1px solid #2a3349;font-weight:600;display:flex;gap:10px;align-items:center}
  .dot{width:8px;height:8px;border-radius:50%;background:#3ddc84}
  main{display:flex;height:calc(100vh - 46px)}
  #runs{width:320px;border-right:1px solid #2a3349;overflow:auto}
  .run{padding:10px 14px;border-bottom:1px solid #1e2535;cursor:pointer}
  .run:hover{background:#1a2233}
  .run.sel{background:#1e2a44}
  .rid{font-family:'JetBrains Mono',monospace;font-size:11px;color:#8aa4d0;word-break:break-all}
  .badge{font-size:10px;padding:1px 7px;border-radius:10px;text-transform:uppercase;letter-spacing:.05em}
  .running{background:#33406a;color:#aac0ff}.completed{background:#164a2c;color:#7ef0a8}.failed{background:#4a2020;color:#ffb0b0}
  #detail{flex:1;overflow:auto;padding:10px 16px}
  .ev{border-bottom:1px solid #1e2535;padding:6px 0;font-family:'JetBrains Mono',monospace;font-size:11px;white-space:pre-wrap;word-break:break-word}
  .ty{color:#c8a060;margin-right:8px}
  .muted{color:#5a6a8a}
</style></head><body>
<header><span class="dot"></span> FlowPilot Monitor <span class="muted" id="cnt"></span>
  <label class="openbtn" style="margin-left:auto;cursor:pointer;font-weight:400;font-size:12px;color:#8aa4d0">&#128194; Apri log&#8230;<input type="file" accept=".ndjson,.json,.log,.txt" style="display:none" onchange="onFile(this)"></label>
</header>
<main>
  <div id="runs"></div>
  <div id="detail"><div class="muted">Seleziona un run a sinistra, oppure apri un file di log.</div></div>
</main>
<script>
let sel=null;        // id del run del server selezionato
let opened=null;     // { name, header, run_id, status, events } aperto DA FILE (transiente)
let active='none';   // 'run' | 'file' | 'none' — cosa mostra il pannello dettaglio

function esc(s){ return String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }
function fmtTs(ts){ if(typeof ts!=='number') return ''; try{ return new Date(ts).toLocaleTimeString('it-IT'); }catch(e){ return ''; } }
function renderEvents(events){
  return events.map(e=>{
    const t=fmtTs(e&&e.ts), ty=(e&&e.type)||'?', pl=(e&&e.payload)||{};
    return '<div class="ev">'+(t?('<span class="muted">'+t+'</span> '):'')+'<span class="ty">'+esc(ty)+'</span>'+esc(JSON.stringify(pl))+'</div>';
  }).join('');
}
async function loadRuns(){
  try{
    const r=await fetch('/api/runs'); const d=await r.json();
    document.getElementById('cnt').textContent=d.runs.length+' run';
    let html='';
    if(opened){
      html+='<div class="run '+(active==='file'?'sel':'')+'" onclick="showOpened()" style="border-left:3px solid #c8a060">'
        +'<div class="rid">&#128194; '+esc(opened.name)+'</div>'
        +'<div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center">'
        +'<span class="badge '+opened.status+'">'+opened.status+'</span>'
        +'<span class="muted">'+opened.events.length+' eventi &middot; da file</span></div></div>';
    }
    html+=d.runs.map(x=>'<div class="run '+((active==='run'&&x.run_id===sel)?'sel':'')+'" onclick="openRun(\''+x.run_id+'\')">'
      +'<div class="rid">'+esc(x.run_id)+'</div>'
      +'<div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center">'
      +'<span class="badge '+x.status+'">'+x.status+'</span>'
      +'<span class="muted">'+x.events+' eventi</span></div></div>').join('');
    document.getElementById('runs').innerHTML=html;
  }catch(e){}
}
async function openRun(id){
  sel=id; active='run'; loadRuns();
  try{
    const r=await fetch('/api/runs/'+encodeURIComponent(id)); const d=await r.json();
    if(active!=='run'||sel!==id) return; // vista cambiata nel frattempo
    const el=document.getElementById('detail');
    if(d.error){el.innerHTML='<div class="muted">'+esc(d.error)+'</div>';return;}
    el.innerHTML=renderEvents(d.events);
  }catch(e){}
}
function showOpened(){
  if(!opened) return;
  active='file'; loadRuns();
  const h=opened.header, a=(h&&h.artifact)||{}, rn=(h&&h.runner)||{}, m=[];
  if(a.profile) m.push('profilo '+esc(a.profile));
  if(a.platform) m.push('piattaforma '+esc(a.platform));
  if(rn.os) m.push('runner '+esc(rn.os)+(rn.version?(' v'+esc(rn.version)):''));
  if(a.exportedAt) m.push('artifact '+esc(a.exportedAt));
  const metaLine = h ? (m.length?('<div class="muted" style="margin-top:4px">'+m.join(' &middot; ')+'</div>'):'')
                     : '<div class="muted" style="margin-top:4px">nessuna intestazione nel file</div>';
  const banner='<div style="border-bottom:1px solid #2a3349;padding-bottom:8px;margin-bottom:8px">'
    +'<div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">'
    +'<b>&#128194; '+esc(opened.name)+'</b> <span class="rid">'+esc(opened.run_id)+'</span> '
    +'<span class="badge '+opened.status+'">'+opened.status+'</span> '
    +'<span class="muted">'+opened.events.length+' eventi</span>'
    +'<button onclick="closeOpened()" style="margin-left:auto">&#10005; chiudi</button></div>'+metaLine+'</div>';
  document.getElementById('detail').innerHTML=banner+renderEvents(opened.events);
}
function closeOpened(){
  opened=null; active='none';
  document.getElementById('detail').innerHTML='<div class="muted">Seleziona un run a sinistra, oppure apri un file di log.</div>';
  loadRuns();
}
function parseLog(text){
  let header=null; const events=[];
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim(); if(!line) continue;
    let o; try{ o=JSON.parse(line); }catch(e){ continue; }
    if(o && o.kind==='flowpilot-log-header'){ header=o; continue; }
    const src_ts=(typeof o.timestamp==='number')?o.timestamp:null;
    const wrapped = src_ts!==null && o.event && typeof o.event==='object' && !Array.isArray(o.event);
    const ev = wrapped ? o.event : o;
    const ts = (ev && typeof ev.ts==='number') ? ev.ts : (src_ts!==null?src_ts:null);
    if(ev && typeof ev==='object' && ts!==null) ev.ts=ts;
    events.push(ev);
  }
  let run_id='(sconosciuto)';
  for(const e of events){ const rid=(e&&e.payload&&e.payload.run_id)||(e&&e.run_id); if(rid){run_id=rid;break;} }
  let status='running';
  if(events.some(e=>e&&e.type==='RunFailed')) status='failed';
  else if(events.some(e=>e&&e.type==='RunCompleted')) status='completed';
  return {header:header, run_id:run_id, status:status, events:events};
}
function onFile(input){
  const f=input.files&&input.files[0]; if(!f) return;
  const reader=new FileReader();
  reader.onload=()=>{ opened=Object.assign({name:f.name}, parseLog(String(reader.result||''))); showOpened(); };
  reader.readAsText(f);
  input.value=''; // consente di riaprire lo stesso file
}
loadRuns();
setInterval(()=>{ loadRuns(); if(active==='run'&&sel) openRun(sel); },2000);
</script></body></html>"#;
