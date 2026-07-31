// ─── src-tauri/src/engine/nodes/webhook_receiver.rs ───────────────
//
// Nodo-servizio: riceve webhook HTTP ed emette una riga per evento.
// FASE PORTING service mode, fetta 4b (gemella di dir_watcher continuo).
//
// FONTE UNICA dell'infra = gli `*_impl` di lib.rs (server hyper + registro
// globale + verifica HMAC reale), estratti in P113. Questo nodo replica il
// flusso di `src/runner/webhookExecutor.ts` (receiver):
//   webhook_server_start_impl → webhook_subscribe_impl
//     → loop { select!{ cancel | poll } → webhook_pop_impl → emit }
//   → webhook_unsubscribe_impl (all'uscita).
//
// Nodo-servizio ⇒ CANCELLABILE: l'attesa fra un poll e l'altro è un
// `select!` su `ctx.cancel`; allo stop il loop esce, la tx viene droppata,
// la valle vede fine-stream e il run finisce (come da design service mode).

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::{
    WebhookServerStartRequest, WebhookSubscribeRequest,
    webhook_server_start_impl, webhook_subscribe_impl,
    webhook_unsubscribe_impl, webhook_pop_impl,
};

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    // R8: eventuale arco in ingresso = innesco, drenato e scartato.
    let _params = super::source_input::await_params(&ctx.node_id.0, "webhook_receiver", rx).await?;

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("webhook_receiver {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("webhook_receiver", &ctx.node_id.0);

    // Config — allineata a resolveReceiverConfig del runner.
    // ⚠️ Con una RISORSA collegata, resourceId + porta + ipWhitelist vengono
    // dalla RISORSA (non dai prop): è il caso normale del pannello. Default
    // porta = 9110. (La prima versione leggeva "port" dai prop e ricadeva
    // sempre su 8088 ignorando la risorsa.)
    let (resource_id, port, ip_whitelist): (String, u16, Vec<String>) = if spec.has_resource() {
        let rid = { let r = spec.resource_id(); if r.is_empty() { ctx.node_id.0.clone() } else { r } };
        let wl  = spec.res_str_or("ipWhitelist", "")
            .split('\n').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
        (rid, spec.res_u16_or("port", 9110), wl)
    } else {
        (ctx.node_id.0.clone(), spec.u64_or("port", 9110) as u16, Vec::new())
    };
    let path = {
        let p = spec.str_or("path", "/webhook");
        if p.starts_with('/') { p } else { format!("/{}", p) }
    };
    // secret/sigHeader/sigAlgo: prop → altrimenti dalla risorsa → altrimenti default.
    let secret     = spec.str_or("hmacSecret", &spec.res_str_or("hmacSecret", ""));
    let sig_header = spec.str_or("sigHeader",  &spec.res_str_or("sigHeader",  "X-Hub-Signature-256"));
    let sig_algo   = spec.str_or("sigAlgo",    &spec.res_str_or("sigAlgo",    "sha256"));
    let dedup_ttl  = spec.u64_or("dedupTtlSec", 3600);
    let max_buffer = spec.u64_or("maxBuffer", 1000) as usize;
    let overflow   = spec.str_or("overflow", "drop_oldest");
    let poll_ms     = spec.u64_or("pollIntervalMs", 200).max(20);
    let listen_sec  = spec.u64_or("listenSec", 0);         // 0 = senza limite
    let debounce_ms = spec.u64_or("debounceMs", 0) as i64; // 0 = disattivo

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let start = Instant::now();
    ctx.emit_log(&ctx.label, "info", 0,
        format!("Webhook Receiver — server {} | path {} | porta {}", resource_id, path, port), "panel");

    // 1) avvia (o riusa) il server sulla porta.
    if let Err(e) = webhook_server_start_impl(WebhookServerStartRequest {
        resource_id: resource_id.clone(), port, ip_whitelist,
    }).await {
        let msg = format!("webhook_receiver {}: avvio server — {}", ctx.node_id.0, e);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }

    // 2) registra la sottoscrizione (path + secret HMAC + policy buffer).
    if let Err(e) = webhook_subscribe_impl(WebhookSubscribeRequest {
        resource_id: resource_id.clone(),
        node_id:     ctx.node_id.0.clone(),
        path:        path.clone(),
        secret, sig_header, sig_algo,
        dedup_ttl_sec: dedup_ttl,
        max_buffer, overflow,
    }).await {
        let msg = format!("webhook_receiver {}: subscribe — {}", ctx.node_id.0, e);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }

    ctx.emit_log(&ctx.label, "info", 0,
        format!("Webhook Receiver: in ascolto su http://0.0.0.0:{}{}", port, path), "panel");

    let deadline_ms: Option<u64> = if listen_sec > 0 { Some(listen_sec * 1000) } else { None };
    let mut rows_out      = 0u64;
    let mut last_event_ms = 0i64;

    loop {
        if let Some(d) = deadline_ms {
            if start.elapsed().as_millis() as u64 >= d { break; }
        }

        // Attesa cancellabile: allo stop usciamo subito, senza aspettare il poll.
        tokio::select! {
            _ = ctx.cancel.cancelled() => break,
            _ = tokio::time::sleep(std::time::Duration::from_millis(poll_ms)) => {}
        }

        let result = match webhook_pop_impl(resource_id.clone(), ctx.node_id.0.clone()).await {
            Ok(r)  => r,
            Err(_) => continue,
        };
        let evt = match result.event { Some(e) => e, None => continue };

        // Debounce opzionale (scarta eventi troppo ravvicinati).
        if debounce_ms > 0 {
            let now = chrono::Utc::now().timestamp_millis();
            if now - last_event_ms < debounce_ms { continue; }
            last_event_ms = now;
        }

        // Riga d'uscita: i campi fissi dell'evento + flatten del payload JSON.
        let mut row = Row::new();
        row.set("event_id".to_string(),        Value::String(evt.event_id.clone()));
        row.set("event_type".to_string(),      Value::String(evt.event_type.clone()));
        row.set("source_ip".to_string(),       Value::String(evt.source_ip.clone()));
        row.set("webhook_path".to_string(),    Value::String(evt.path.clone()));
        row.set("payload".to_string(),         Value::Object(evt.payload.clone()));
        row.set("headers".to_string(),         Value::Object(serde_json::to_value(&evt.headers).unwrap_or(serde_json::Value::Null)));
        row.set("received_at".to_string(),     Value::String(evt.received_at.clone()));
        row.set("signature_valid".to_string(), match evt.signature_valid {
            Some(b) => Value::Bool(b),
            None    => Value::Null,
        });
        // Se il payload è un oggetto, i suoi campi salgono a livello riga
        // (come il runner). Il payload vince su eventuali collisioni.
        if let serde_json::Value::Object(map) = &evt.payload {
            for (k, v) in map { row.set(k.clone(), Value::Object(v.clone())); }
        }

        ctx.emit_log(&ctx.label, "info", 0,
            format!("Webhook Receiver [{}]: evento {} | buffer {}", path, evt.event_id, result.queued), "panel");

        if tx.send(row).await.is_err() { break; }
        rows_out += 1;
    }

    // Cleanup: togli la sottoscrizione. Il server resta su (condiviso), come
    // nel runner — la sua vita è legata alla risorsa, non al singolo nodo.
    let _ = webhook_unsubscribe_impl(resource_id.clone(), ctx.node_id.0.clone()).await;

    ctx.emit_log(&ctx.label, "ok", 0,
        format!("Webhook Receiver: terminato — {} eventi", rows_out), "panel");

    let stats = NodeStats {
        rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
