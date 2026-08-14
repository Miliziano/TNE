// src-tauri/src/bin/flowpilot_monitor.rs
//
// MONITOR centralizzato di FlowPilot (primo passo).
// Riceve in PUSH gli eventi (NDJSON, un EngineEvent per riga) dai runner della
// flotta, li aggrega per `run_id` in memoria, e offre una vista web minimale.
// E' standalone: dipende solo da tiny_http + serde_json (NIENTE Tauri, niente
// app_lib). Lo schema degli eventi e' un CONTRATTO JSON (`{type, payload}`),
// quindi qui vengono trattati genericamente (nessuna dipendenza dal tipo Rust).
// Storage IN MEMORIA (la persistenza sara' un passo successivo).
//
// Build:  cargo build --bin flowpilot_monitor --no-default-features --features monitor --release
// Uso:    flowpilot_monitor [porta]        (default 8787)
//   - i runner pushano su:  POST http://<host>:<porta>/ingest   (body NDJSON)
//   - vista web:            GET  http://<host>:<porta>/
//   - API:                  GET /api/runs   e   GET /api/runs/<run_id>

use std::collections::HashMap;
use std::io::{Cursor, Read};
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

fn ingest(body: &str, store: &Store) {
    let mut s = store.lock().unwrap();
    for line in body.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        let raw: Value = match serde_json::from_str(line) {
            Ok(v) => v,
            Err(_) => continue,
        };

        // Intestazione autodescrittiva del log: NON e' un evento. La si riconosce e
        // salta (non crea un run fasullo). I suoi metadati (runner/artifact) verranno
        // usati quando aggiungeremo la persistenza e l'apertura di log gia' eseguiti.
        if raw.get("kind").and_then(|v| v.as_str()) == Some("flowpilot-log-header") {
            continue;
        }

        // Una riga puo' essere INCAPSULATA `{ timestamp, event: {type, payload} }`
        // (nuovo formato, col timestamp d'ORIGINE) oppure un evento NUDO `{type, payload}`
        // (retrocompatibilita' con log piu' vecchi). Calcolo prima i valori POSSEDUTI
        // (niente prestito vivo su `raw`), poi o clono l'evento interno o muovo `raw`.
        let src_ts = raw.get("timestamp").and_then(|v| v.as_u64());
        let wrapped = src_ts.is_some()
            && raw.get("event").map(|e| e.is_object()).unwrap_or(false);
        let mut ev = if wrapped {
            raw.get("event").cloned().unwrap_or(Value::Null)
        } else {
            raw
        };
        // Tempo d'origine se presente; altrimenti (log nudo) ripiego sul tempo di ricezione.
        let event_ts = src_ts.unwrap_or_else(now_ms);

        // run_id: nel payload (variante RunStarted/... ) o al livello superiore.
        let run_id = ev
            .get("payload").and_then(|p| p.get("run_id")).and_then(|v| v.as_str())
            .or_else(|| ev.get("run_id").and_then(|v| v.as_str()))
            .unwrap_or("sconosciuto")
            .to_string();
        let ty = ev.get("type").and_then(|v| v.as_str()).unwrap_or("").to_string();

        // Timbro il tempo d'origine su OGNI evento memorizzato (campo `ts`): cosi' le
        // viste future potranno ordinare/aggregare per tempo reale, uniformemente sia
        // per i log nuovi (tempo d'origine) sia per quelli nudi (tempo di ricezione).
        if let Some(obj) = ev.as_object_mut() {
            obj.insert("ts".to_string(), Value::from(event_ts));
        }

        let entry = s.entry(run_id).or_default();
        if entry.status.is_empty() {
            entry.status = "running".to_string();
        }
        match ty.as_str() {
            "RunCompleted" => entry.status = "completed".to_string(),
            "RunFailed" => entry.status = "failed".to_string(),
            _ => {}
        }
        // last_seen = tempo d'ORIGINE quando disponibile (piu' onesto del tempo di
        // ricezione: il monitor poteva essere giu' e i log arrivare dopo dal fallback).
        entry.last_seen_ms = event_ts;
        entry.events.push(ev);
    }
}

fn route(req: &mut tiny_http::Request, store: &Store) -> Resp {
    let method = req.method().clone();
    let url = req.url().to_string();
    let path = url.split('?').next().unwrap_or(&url).to_string();

    match (method, path.as_str()) {
        (Method::Post, "/ingest") => {
            let mut body = String::new();
            let _ = req.as_reader().read_to_string(&mut body);
            ingest(&body, store);
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
    let addr = format!("0.0.0.0:{}", port);
    let server = match Server::http(&addr) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("impossibile avviare il monitor su {}: {}", addr, e);
            std::process::exit(1);
        }
    };
    eprintln!("FlowPilot monitor su http://{}  (ingest: POST /ingest, vista: GET /)", addr);

    let store: Store = Arc::new(Mutex::new(HashMap::new()));
    for mut req in server.incoming_requests() {
        let store = store.clone();
        std::thread::spawn(move || {
            let resp = route(&mut req, &store);
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
<header><span class="dot"></span> FlowPilot Monitor <span class="muted" id="cnt"></span></header>
<main>
  <div id="runs"></div>
  <div id="detail"><div class="muted">Seleziona un run a sinistra.</div></div>
</main>
<script>
let sel=null;
async function loadRuns(){
  try{
    const r=await fetch('/api/runs'); const d=await r.json();
    document.getElementById('cnt').textContent=d.runs.length+' run';
    const el=document.getElementById('runs');
    el.innerHTML=d.runs.map(x=>`<div class="run ${x.run_id===sel?'sel':''}" onclick="openRun('${x.run_id}')">
      <div class="rid">${x.run_id}</div>
      <div style="margin-top:4px;display:flex;justify-content:space-between;align-items:center">
        <span class="badge ${x.status}">${x.status}</span>
        <span class="muted">${x.events} eventi</span></div></div>`).join('');
  }catch(e){}
}
async function openRun(id){
  sel=id; loadRuns();
  try{
    const r=await fetch('/api/runs/'+encodeURIComponent(id)); const d=await r.json();
    const el=document.getElementById('detail');
    if(d.error){el.innerHTML='<div class="muted">'+d.error+'</div>';return}
    el.innerHTML=d.events.map(e=>`<div class="ev"><span class="ty">${e.type||'?'}</span>${JSON.stringify(e.payload||{})}</div>`).join('');
  }catch(e){}
}
loadRuns(); setInterval(()=>{loadRuns(); if(sel)openRun(sel);},2000);
</script></body></html>"#;
