// ─── src-tauri/src/engine/nodes/webhook_responder.rs ──────────────
//
// Nodo-servizio: espone un piccolo server HTTP che risponde a HEAD/GET su
// un path con header sintetici, aggiornati a runtime. Ultima fetta del
// service mode (gemello del receiver/watchdog).
//
// FONTE UNICA dell'infra = gli `*_impl` responder di lib.rs (server hyper +
// registro globale), estratti in P118. Replica il responder di
// `src/runner/webhookExecutor.ts`:
//   webhook_responder_start_impl → update_headers (per riga o per variabili)
//     → webhook_responder_stop_impl (all'uscita).
//
// Due modalità (`mode`):
//   • flow    — per OGNI riga in ingresso costruisce gli header dai suoi
//               campi, aggiorna il server e passa la riga a valle;
//   • monitor — nessun input: costruisce gli header dalle VARIABILI DI LANE
//               (`ctx.variables`) e tiene su il server.
//
// Nodo-servizio ⇒ CANCELLABILE: dopo l'input (flow) o subito (monitor) tiene
// vivo il server in un loop `select!` su `ctx.cancel`; allo stop esce, ferma
// il server e la valle vede fine-stream.

use std::time::Instant;
use std::collections::HashMap;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::{
    WebhookResponderStartRequest, webhook_responder_start_impl,
    webhook_responder_update_headers_impl, webhook_responder_stop_impl,
};

/// Sostituisce `$nome` (a-zA-Z0-9_) col valore da `values` ("" se assente).
/// Equivalente a `resolveHeaderTemplate` del runner, senza regex.
fn substitute_vars(tpl: &str, values: &HashMap<String, String>) -> String {
    let chars: Vec<char> = tpl.chars().collect();
    let mut out = String::with_capacity(tpl.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '$' {
            let mut j = i + 1;
            while j < chars.len() && (chars[j].is_ascii_alphanumeric() || chars[j] == '_') { j += 1; }
            if j > i + 1 {
                let name: String = chars[i + 1..j].iter().collect();
                out.push_str(values.get(&name).map(|s| s.as_str()).unwrap_or(""));
                i = j;
                continue;
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// Interpreta il template JSON `{"Header":"$var"}` e produce gli header risolti.
fn resolve_header_template(tpl_raw: &str, values: &HashMap<String, String>) -> HashMap<String, String> {
    let parsed: serde_json::Value = match serde_json::from_str(tpl_raw) {
        Ok(v) => v,
        Err(_) => return HashMap::new(),
    };
    let obj = match parsed.as_object() {
        Some(o) => o,
        None => return HashMap::new(),
    };
    let mut out = HashMap::new();
    for (key, tpl) in obj {
        let tpl_str = tpl.as_str().map(|s| s.to_string()).unwrap_or_else(|| tpl.to_string());
        out.insert(key.clone(), substitute_vars(&tpl_str, values));
    }
    out
}

/// Tiene vivo il server fino a cancel o scadenza del timeout.
async fn keep_alive(ctx: &NodeContext, start: &Instant, deadline_ms: Option<u128>) {
    loop {
        if let Some(d) = deadline_ms {
            if start.elapsed().as_millis() >= d { break; }
        }
        tokio::select! {
            _ = ctx.cancel.cancelled() => break,
            _ = tokio::time::sleep(std::time::Duration::from_millis(500)) => {}
        }
    }
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("webhook_responder {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("webhook_responder", &ctx.node_id.0);

    let mode    = spec.str_or("mode", "flow");
    let port    = spec.u64_or("port", 9111) as u16;
    let path    = { let p = spec.str_or("path", "/status"); if p.starts_with('/') { p } else { format!("/{}", p) } };
    let methods: Vec<String> = spec.str_or("methods", "HEAD,GET")
        .split(',').map(|m| m.trim().to_uppercase()).filter(|m| !m.is_empty()).collect();
    let run_sec = spec.u64_or("listenSec", 0);
    let tpl_raw = spec.str_or("headerTemplate", "{\"X-Data-Ready\":\"true\",\"X-Status\":\"ok\"}");
    // GET restituisce il JSON degli header? Toggle nel pannello, default ON.
    let expose_body = spec.str_or("exposeBody", "true") != "false";

    let start = Instant::now();
    let deadline_ms: Option<u128> = if run_sec > 0 { Some((run_sec * 1000) as u128) } else { None };

    ctx.emit_log(&ctx.label, "info", 0,
        format!("Webhook Responder [{}] — porta {}{}", mode, port, path), "panel");

    // Avvia il server con header vuoti — aggiornati subito dopo.
    if let Err(e) = webhook_responder_start_impl(WebhookResponderStartRequest {
        node_id: ctx.node_id.0.clone(), port, path: path.clone(), methods, headers: HashMap::new(),
        expose_body,
    }).await {
        let msg = format!("webhook_responder {}: avvio — {}", ctx.node_id.0, e);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }
    ctx.emit_log(&ctx.label, "info", 0,
        format!("Webhook Responder: attivo su porta {}{} — prova: http://localhost:{}{}", port, path, port, path), "panel");

    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    if mode == "monitor" {
        // Header dalle variabili di lane. In v1 le variabili nel motore sono
        // uno SNAPSHOT (ctx.variables), quindi le impostiamo una volta; il
        // "polling per cambi" del runner qui non avrebbe effetto.
        let values: HashMap<String, String> = ctx.variables.iter()
            .map(|(k, v)| (k.clone(), v.as_str_repr()))
            .collect();
        let headers = resolve_header_template(&tpl_raw, &values);
        let _ = webhook_responder_update_headers_impl(ctx.node_id.0.clone(), headers).await;
        ctx.emit_log(&ctx.label, "info", 0,
            "Webhook Responder [monitor]: header impostati dalle variabili di lane".to_string(), "panel");
        keep_alive(&ctx, &start, deadline_ms).await;
    } else {
        // flow: per ogni riga aggiorna gli header dai suoi campi e la passa a valle.
        if let Some(mut rxc) = rx {
            loop {
                if let Some(d) = deadline_ms {
                    if start.elapsed().as_millis() >= d { break; }
                }
                let row = tokio::select! {
                    _ = ctx.cancel.cancelled() => break,
                    r = rxc.recv() => match r { Some(r) => r, None => break },
                };
                rows_in += 1;
                let values: HashMap<String, String> = row.fields()
                    .map(|(k, v)| (k.clone(), v.as_str_repr()))
                    .collect();
                let headers = resolve_header_template(&tpl_raw, &values);
                let _ = webhook_responder_update_headers_impl(ctx.node_id.0.clone(), headers).await;
                // Pass-through: la riga scorre invariata (se c'è una valle).
                if let Some(t) = &tx {
                    if t.send(row).await.is_err() { break; }
                }
                rows_out += 1;
            }
        }
        // Tiene su il server finché non scade il timeout o arriva il cancel.
        keep_alive(&ctx, &start, deadline_ms).await;
    }

    let _ = webhook_responder_stop_impl(ctx.node_id.0.clone()).await;
    ctx.emit_log(&ctx.label, "ok", 0,
        format!("Webhook Responder [{}]: terminato — {} righe", mode, rows_out), "panel");

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
