// src-tauri/src/bin/flowpilot_runner.rs
//
// Runner HEADLESS di FlowPilot.
// Esegue un artifact `.ffart` (o un piano JSON) riusando lo STESSO motore dello
// studio (`engine_run` di app_lib). Drena il bus eventi e per ogni batch:
//   - stampa NDJSON su stdout (una riga = un EngineEvent);
//   - se e' impostata la variabile d'ambiente MONITOR_URL, fa PUSH del batch al
//     monitor centralizzato (POST NDJSON). Il push e' BEST-EFFORT: timeout breve,
//     mai bloccante per il run; se fallisce, i log NON si perdono -> vengono
//     appesi a un file di fallback locale (flowpilot-monitor-fallback.ndjson),
//     cosi' il monitor puo' recuperarli dopo.
// I segreti e i `${...}` nel piano si risolvono a run-time NEL motore (env/keychain).
//
// (!) Con `app_lib` a default (feature desktop) questo linka Tauri; il build
//     headless e': cargo build --bin flowpilot_runner --no-default-features --release
//
// Uso:    flowpilot_runner <artifact.ffart | piano.json>
// Env:    MONITOR_URL=https://host:porta/ingest   (opzionale)
// Uscita: 0 = run completato, 1 = run fallito, 2 = errore d'uso/lettura.

use std::io::Write;
use std::time::Duration;

use app_lib::engine::bus::global_bus;
use app_lib::engine::engine_run;
use app_lib::engine::events::EngineEvent;

const FALLBACK_FILE: &str = "flowpilot-monitor-fallback.ndjson";

/// Risolve i riferimenti `${NAME}` nell'endpoint del monitor usando le variabili
/// d'ambiente della macchina di destinazione. Se un riferimento non e' risolto,
/// o il risultato e' vuoto, ritorna None (nessun monitor).
fn resolve_monitor(raw: &str) -> Option<String> {
    let mut out = String::new();
    let mut rest = raw;
    while let Some(start) = rest.find("${") {
        out.push_str(&rest[..start]);
        let after = &rest[start + 2..];
        match after.find('}') {
            Some(end) => {
                let name = after[..end].trim();
                match std::env::var(name) {
                    Ok(v) if !v.is_empty() => out.push_str(&v),
                    _ => return None, // riferimento non risolto -> niente monitor
                }
                rest = &after[end + 1..];
            }
            None => {
                out.push_str("${");
                rest = after;
            }
        }
    }
    out.push_str(rest);
    let out = out.trim().to_string();
    if out.is_empty() { None } else { Some(out) }
}

/// Invia un blocco NDJSON al monitor (best-effort, mai bloccante). Se il push
/// fallisce (o il monitor e' irraggiungibile) i log NON si perdono: vengono
/// appesi al file di fallback locale. Nessun monitor configurato -> no-op.
async fn push_ndjson(client: Option<&reqwest::Client>, url: Option<&str>, token: Option<&str>, payload: &str) {
    if payload.is_empty() {
        return;
    }
    if let (Some(client), Some(url)) = (client, url) {
        let mut rq = client
            .post(url)
            .header("content-type", "application/x-ndjson");
        // Token di ingest: NON viaggia mai nell'artifact (sarebbe un segreto in un
        // file distribuibile). Viene dall'AMBIENTE della macchina che esegue,
        // esattamente come i segreti del piano.
        if let Some(t) = token {
            if !t.is_empty() { rq = rq.header("authorization", format!("Bearer {}", t)); }
        }
        let ok = rq
            .body(payload.to_string())
            .send()
            .await
            .map(|r| r.status().is_success())
            .unwrap_or(false);
        if !ok {
            if let Ok(mut f) = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(FALLBACK_FILE)
            {
                let _ = f.write_all(payload.as_bytes());
            }
        }
    }
}

/// Decide se un evento va EMESSO (stdout + push al monitor) al livello scelto.
///
/// Filtra solo cio' che ESCE dalla macchina: il log integrale resta comunque su
/// disco in ~/.flowpilot/runs (lo scrive il reporter, che riceve ogni push_event
/// a monte di questo filtro). Cosi' la diagnosi locale non perde nulla e il
/// monitor centrale non si riempie di rumore — ne' di DATI.
///
/// - `essenziale`  ciclo di vita + errori + statistiche. Niente contenuto delle
///                 righe, niente memoria, niente avanzamento.
/// - `normale`     + avanzamento e messaggi dei nodi, MA senza il contenuto delle
///                 righe (i NodeLog con `target: "window"` sono dump di dati) e
///                 senza campioni di memoria.
/// - `diagnostico` tutto, come prima.
fn evento_da_emettere(ev: &serde_json::Value, livello: &str) -> bool {
    if livello == "diagnostico" {
        return true;
    }
    let tipo = ev.get("type").and_then(|v| v.as_str()).unwrap_or("");
    let payload = ev.get("payload");
    let campo = |k: &str| payload.and_then(|p| p.get(k)).and_then(|v| v.as_str()).unwrap_or("");

    match tipo {
        // Campioni di memoria: strumento da debugger, mai nel log di campo.
        "MemorySample" => false,
        // Avanzamento: utile a vedere il flusso vivo, superfluo nell'essenziale.
        "NodeProgress" => livello != "essenziale",
        "NodeLog" => {
            let level  = campo("level");
            let target = campo("target");
            // Contenuto di riga destinato alla FINESTRA dello studio: non deve
            // uscire dalla macchina (sono i dati veri).
            // ⚠️ `target` ha TRE valori: "panel" | "window" | "both_window".
            // Bloccarne solo uno lasciava passare `both_window`, che trasporta
            // esattamente lo stesso contenuto (trovato dal verificatore
            // dell'esempio 04, invariante `nessun_dato_di_riga`).
            if target.contains("window") {
                return false;
            }
            match livello {
                "essenziale" => level == "error" || level == "warn",
                _            => true, // normale: anche info/ok, ma mai i dump di riga
            }
        }
        // Tutto il resto (RunStarted/Completed/Failed, Node*, stats, Lane*,
        // Connection*, Edge*) e' ciclo di vita o esito: passa sempre.
        _ => true,
    }
}

fn main() {
    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("uso: flowpilot_runner <artifact.ffart | piano.json>");
            std::process::exit(2);
        }
    };

    let raw = match std::fs::read_to_string(&path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("errore lettura {}: {}", path, e);
            std::process::exit(2);
        }
    };

    let root: serde_json::Value = match serde_json::from_str(&raw) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("JSON non valido: {}", e);
            std::process::exit(2);
        }
    };
    // Monitor dal MANIFESTO dell'artifact (prima di consumare root per il piano).
    let manifest_monitor = root.get("monitor").and_then(|v| v.as_str()).map(|s| s.to_string());
    // Nome del piano dal manifesto (lo studio lo ricava dal file .ffplan). Serve per
    // arricchire l'intestazione E l'evento RunStarted, cosi' il monitor mostra il nome.
    let plan_name = root.get("planName").and_then(|v| v.as_str()).map(|s| s.to_string());
    // Id dell'ARTIFACT = il run_id inciso dallo studio all'export. Serve prima
    // dell'intestazione, quindi si legge qui (dal piano, o dalla radice se il
    // file è un piano nudo senza manifesto).
    let artifact_id = root
        .get("plan").and_then(|p| p.get("run_id")).and_then(|v| v.as_str())
        .or_else(|| root.get("run_id").and_then(|v| v.as_str()))
        .unwrap_or("piano")
        .to_string();
    // Livello di dettaglio di cio' che il runner EMETTE (stdout + monitor).
    // Default prudente: "normale" (niente dati di riga, niente memoria) anche per
    // gli artifact vecchi che non portano il campo.
    let log_level = root.get("logLevel").and_then(|v| v.as_str()).unwrap_or("normale").to_string();
    // PROVENIENZA (fase A): chi ha compilato, con quale versione, quale piano.
    // Il runner li RIPORTA e basta: sono dati DICHIARATI dall'artifact, non verificati.
    let studio_id    = root.get("studio").and_then(|s| s.get("id")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let studio_label = root.get("studio").and_then(|s| s.get("label")).and_then(|v| v.as_str()).map(|s| s.to_string());
    let plan_hash    = root.get("planHash").and_then(|v| v.as_str()).map(|s| s.to_string());
    let plan_version = root.get("planVersion").and_then(|v| v.get("label")).and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string())
        .or_else(|| root.get("planVersion").and_then(|v| v.get("id")).and_then(|v| v.as_str()).map(|s| s.to_string()));
    // Host DICHIARATO da questa macchina (hostname del sistema). E' auto-dichiarato:
    // il dato affidabile sull'origine e' l'IP che il monitor OSSERVA sulla connessione.
    let runner_host = std::env::var("HOSTNAME").ok()
        .or_else(|| std::env::var("COMPUTERNAME").ok())
        .or_else(|| std::fs::read_to_string("/etc/hostname").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty());

    // Intestazione autodescrittiva del log (self-contained): versione del formato,
    // metadati del runner e dell'artifact. Emessa UNA volta, in testa al log, cosi'
    // un file NDJSON salvato e' interpretabile a freddo (usata dalla persistenza e
    // dall'apertura di log gia' eseguiti). Costruita PRIMA di consumare `root`.
    let header_line = serde_json::json!({
        "kind":       "flowpilot-log-header",
        "logFormat":  1,
        "emittedAt":  EngineEvent::timestamp_ms(),
        "runner": {
            "os":      std::env::consts::OS,
            "arch":    std::env::consts::ARCH,
            "version": env!("CARGO_PKG_VERSION"),
            "host":    runner_host,
        },
        "artifact": {
            "formatVersion":   root.get("formatVersion"),
            "planName":        root.get("planName"),
            "planVersion":     root.get("planVersion"),
            "studio":          root.get("studio"),
            "studioVersion":   root.get("studioVersion"),
            "planHash":        root.get("planHash"),
            "logLevel":        log_level.clone(),
            "artifactId":      artifact_id.clone(),
            "profile":         root.get("profile"),
            "platform":        root.get("platform"),
            "exportedAt":      root.get("exportedAt"),
            "requiredSecrets": root.get("requiredSecrets"),
        },
    })
    .to_string();

    let mut plan = root.get("plan").cloned().unwrap_or(root);

    // ─── UN run_id PER ESECUZIONE ────────────────────────────────
    // Nel piano il `run_id` viene inciso dallo STUDIO al momento dell'export
    // (`export-<timestamp>`): identifica l'ARTIFACT, non l'esecuzione. Eseguendo
    // due volte lo stesso .ffart, tutti gli eventi finivano sotto lo stesso id →
    // nel monitor le esecuzioni si accavallavano in un unico run (e in produzione
    // un piano notturno avrebbe accumulato per sempre), col dedup che scartava gli
    // eventi identici e accodava i diversi: un run "misto".
    // Qui il runner lo sostituisce con un id proprio dell'ESECUZIONE, tenendo il
    // riferimento all'artifact come prefisso (resta leggibile la provenienza).
    // `FLOWPILOT_RUN_ID` permette di imporne uno (utile in CI o per rieseguire
    // un id noto).
    let run_id = match std::env::var("FLOWPILOT_RUN_ID") {
        Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
        _ => format!("{}-{}", artifact_id, EngineEvent::timestamp_ms()),
    };
    if let Some(obj) = plan.as_object_mut() {
        obj.insert("run_id".to_string(), serde_json::Value::from(run_id.clone()));
    }
    eprintln!("run: {} (artifact: {})", run_id, artifact_id);

    let plan_json = plan.to_string();

    // Endpoint del monitor (opzionale):
    //   1) dal MANIFESTO dell'artifact (`monitor`), risolvendo i ${NAME} dalle
    //      variabili d'ambiente sulla macchina di destinazione;
    //   2) altrimenti dalla variabile d'ambiente MONITOR_URL (override/retrocompat).
    let monitor_url = manifest_monitor
        .as_deref()
        .and_then(resolve_monitor)
        .or_else(|| std::env::var("MONITOR_URL").ok().filter(|s| !s.trim().is_empty()));

    let rt = match tokio::runtime::Runtime::new() {
        Ok(r) => r,
        Err(e) => {
            eprintln!("errore runtime tokio: {}", e);
            std::process::exit(2);
        }
    };

    let code: i32 = rt.block_on(async move {
        // Client HTTP per il push (timeout breve: il monitor non deve mai bloccare il run).
        // Token di ingest dall'AMBIENTE della macchina che esegue (mai dall'artifact:
        // sarebbe un segreto dentro un file distribuibile).
        let monitor_token = std::env::var("MONITOR_TOKEN").ok().filter(|t| !t.trim().is_empty());
        let http = match &monitor_url {
            Some(url) => {
                eprintln!(
                    "monitor: push verso {} (fallback locale: {}){}",
                    url, FALLBACK_FILE,
                    if monitor_token.is_some() { " [con token]" } else { "" }
                );
                reqwest::Client::builder()
                    .timeout(Duration::from_secs(5))
                    .build()
                    .ok()
            }
            None => None,
        };

        // Intestazione in testa al log: stdout + push (best-effort), una volta.
        println!("{}", header_line);
        push_ndjson(http.as_ref(), monitor_url.as_deref(), monitor_token.as_deref(), &format!("{}\n", header_line)).await;

        if let Err(e) = engine_run(plan_json).await {
            eprintln!("avvio run fallito: {}", e);
            return 1;
        }

        let bus = global_bus();
        let mut cursor: u64 = 0;
        loop {
            // Sezione critica breve: prendo il batch e rilascio subito il lock.
            let batch = {
                let guard = match bus.lock() {
                    Ok(g) => g,
                    Err(e) => {
                        eprintln!("bus lock error: {}", e);
                        return 1;
                    }
                };
                let (events, new_cursor) = guard.drain_since(cursor);
                cursor = new_cursor;
                events
            };

            // Costruisco l'NDJSON del batch, stampo su stdout, rilevo la fine.
            let mut ndjson = String::new();
            let mut exit_code: Option<i32> = None;
            for te in &batch {
                // Riga INCAPSULATA: il timestamp d'ORIGINE (preso dal bus al momento
                // dell'evento) viaggia con l'evento -> il monitor sa QUANDO e' successo
                // davvero, non quando l'ha ricevuto (importante se era giu' e i log
                // arrivano dopo dal fallback). L'evento resta {type, payload} dentro `event`.
                let mut ev_val = serde_json::to_value(&te.event).unwrap_or(serde_json::Value::Null);
                // Arricchisco RunStarted con NOME e PROVENIENZA del piano (una volta per
                // run, cosi' il monitor li associa al run_id in modo esatto e a costo nullo).
                if ev_val.get("type").and_then(|v| v.as_str()) == Some("RunStarted") {
                    if let Some(payload) = ev_val.get_mut("payload").and_then(|p| p.as_object_mut()) {
                        let mut set = |k: &str, v: &Option<String>| {
                            if let Some(s) = v {
                                payload.insert(k.to_string(), serde_json::Value::from(s.clone()));
                            }
                        };
                        set("plan_name", &plan_name);
                        set("studio_id", &studio_id);
                        set("studio_label", &studio_label);
                        set("plan_hash", &plan_hash);
                        set("plan_version", &plan_version);
                        set("runner_host", &runner_host);
                        // Il monitor deve poter DIRE che il log e' filtrato, altrimenti
                        // sembra che manchino eventi.
                        payload.insert("log_level".to_string(), serde_json::Value::from(log_level.clone()));
                        // Riferimento all'ARTIFACT: il run_id ora è per esecuzione,
                        // questo dice DA QUALE artifact proviene (permette di
                        // raggruppare le esecuzioni dello stesso piano).
                        payload.insert("artifact_id".to_string(), serde_json::Value::from(artifact_id.clone()));
                    }
                }
                // FILTRO per livello: decide cosa esce (stdout + monitor). Gli eventi
                // scartati restano comunque nel log locale scritto dal reporter.
                if evento_da_emettere(&ev_val, &log_level) {
                    let line = serde_json::json!({
                        "timestamp": te.timestamp,
                        "event":     ev_val,
                    })
                    .to_string();
                    println!("{}", line);
                    ndjson.push_str(&line);
                    ndjson.push('\n');
                }

                match &te.event {
                    EngineEvent::RunCompleted { .. } => exit_code = Some(0),
                    EngineEvent::RunFailed { .. } => exit_code = Some(1),
                    _ => {}
                }
            }

            // Push al monitor (best-effort): include anche il batch finale.
            push_ndjson(http.as_ref(), monitor_url.as_deref(), monitor_token.as_deref(), &ndjson).await;

            if let Some(c) = exit_code {
                return c;
            }

            tokio::time::sleep(Duration::from_millis(100)).await;
        }
    });

    std::process::exit(code);
}
