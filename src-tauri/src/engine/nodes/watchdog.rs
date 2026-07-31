// ─── src-tauri/src/engine/nodes/watchdog.rs ───────────────────────
//
// Nodo-servizio: sonda un endpoint HTTP a intervalli finché una condizione
// su un header è soddisfatta. Tre modalità (come il runner):
//   • gate   — attende il match, poi lascia PASSARE l'input a valle (+ meta);
//   • stream — emette una riga meta a OGNI check positivo;
//   • edge   — emette solo al CAMBIO di stato (rising/falling).
//
// FONTE UNICA del check = `crate::watchdog_check_impl` (reqwest, la stessa
// del comando Tauri), cablata in P115. Riferimento del flusso:
// `src/runner/webhookExecutor.ts` (watchdogExecutor).
//
// Nodo-servizio ⇒ CANCELLABILE: ogni attesa d'intervallo è un `select!` su
// `ctx.cancel`; allo stop il loop esce, la tx droppa, il run finisce.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::{WatchdogCheckRequest, WatchdogCheckResult, watchdog_check_impl};

/// Un check, con log di warning in caso di errore (non fatale: si riprova).
async fn check(req: &WatchdogCheckRequest, ctx: &NodeContext) -> Option<WatchdogCheckResult> {
    match watchdog_check_impl(req.clone()).await {
        Ok(r)  => Some(r),
        Err(e) => {
            ctx.emit_log(&ctx.label, "warn", 0,
                format!("Watchdog: check fallito — {}", e), "panel");
            None
        }
    }
}

/// Campi meta comuni ai tre modi (come `buildMeta` del runner).
fn build_meta(res: &WatchdogCheckResult, attempt: u64, url: &str, header: &str) -> Vec<(String, Value)> {
    vec![
        ("watchdog_matched".to_string(),     Value::Bool(res.matched)),
        ("watchdog_attempts".to_string(),    Value::Int(attempt as i64)),
        ("watchdog_url".to_string(),         Value::String(url.to_string())),
        ("watchdog_header".to_string(),      Value::String(header.to_string())),
        ("watchdog_value_found".to_string(), match &res.header_found {
            Some(v) => Value::String(v.clone()),
            None    => Value::Null,
        }),
        ("watchdog_elapsed_ms".to_string(),  Value::Int(res.elapsed_ms as i64)),
        ("matched_at".to_string(),           Value::String(chrono::Utc::now().to_rfc3339())),
    ]
}

fn row_with(meta: &[(String, Value)]) -> Row {
    let mut row = Row::new();
    for (k, v) in meta { row.set(k.clone(), v.clone()); }
    row
}

/// gate: emette input+meta (se c'è input) oppure la sola meta. Ritorna righe emesse.
async fn emit_gate(tx: &RowSender, input_rows: &[Row], meta: &[(String, Value)]) -> u64 {
    if input_rows.is_empty() {
        let _ = tx.send(row_with(meta)).await;
        return 1;
    }
    let mut n = 0u64;
    for row in input_rows {
        let mut merged = row.clone();
        for (k, v) in meta { merged.set(k.clone(), v.clone()); }
        if tx.send(merged).await.is_err() { break; }
        n += 1;
    }
    n
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("watchdog {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("watchdog", &ctx.node_id.0);

    let watch_mode     = spec.str_or("watchMode", "gate");
    let url            = spec.str_or("url", "");
    let method         = spec.str_or("method", "HEAD");
    let header_name    = spec.str_or("headerName", "X-Data-Ready");
    let header_value   = spec.str_or("headerValue", "true");
    let match_mode     = spec.str_or("matchMode", "exact");
    let interval_sec   = spec.u64_or("intervalSec", 30).max(1);
    let timeout_sec    = spec.u64_or("timeoutSec", 10);
    let auth_type      = spec.str_or("authType", "none");
    let auth_value     = spec.str_or("authValue", "");
    let global_ttl_min = spec.u64_or("globalTtlMin", 0);
    let max_attempts   = spec.u64_or("maxAttempts", 0);        // gate
    let on_timeout     = spec.str_or("onTimeout", "error");    // gate: error|proceed
    let edge_trigger   = spec.str_or("edgeTrigger", "both");   // edge: both|rising|falling

    if url.is_empty() {
        let msg = format!("watchdog {}: URL non configurato", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    let start = Instant::now();

    // Input: in gate è il flusso da lasciar passare dopo il match; negli altri
    // modi il watchdog è una SORGENTE di segnale, quindi l'eventuale input
    // viene drenato e ignorato (per non bloccare l'upstream).
    let mut input_rows: Vec<Row> = Vec::new();
    if let Some(mut rxc) = rx {
        while let Some(row) = rxc.recv().await { input_rows.push(row); }
    }
    let rows_in = input_rows.len() as u64;

    let global_deadline_ms: Option<u128> =
        if global_ttl_min > 0 { Some((global_ttl_min * 60 * 1000) as u128) } else { None };

    let req = WatchdogCheckRequest {
        url: url.clone(), method, header_name: header_name.clone(), header_value,
        match_mode, auth_type, auth_value, timeout_sec,
    };
    let interval = std::time::Duration::from_secs(interval_sec);

    ctx.emit_log(&ctx.label, "info", 0,
        format!("Watchdog [{}] — {} {} | {} | ogni {}s", watch_mode, req.method, url, header_name, interval_sec), "panel");

    let mut rows_out = 0u64;

    match watch_mode.as_str() {
        // ── GATE ──────────────────────────────────────────────────
        "gate" => {
            let mut attempt = 0u64;
            let mut matched = false;
            loop {
                if ctx.cancel.is_cancelled() {
                    ctx.emit_log(&ctx.label, "warn", 0, "Watchdog [gate]: interrotto".to_string(), "panel");
                    break;
                }
                if let Some(d) = global_deadline_ms {
                    if start.elapsed().as_millis() >= d {
                        let msg = format!("Watchdog [gate]: timeout globale ({} min) dopo {} tentativi", global_ttl_min, attempt);
                        if on_timeout == "error" { ctx.emit_failed(msg.clone()); return Err(msg); }
                        ctx.emit_log(&ctx.label, "warn", 0, msg, "panel");
                        break;
                    }
                }
                if max_attempts > 0 && attempt >= max_attempts {
                    let msg = format!("Watchdog [gate]: limite tentativi ({})", max_attempts);
                    if on_timeout == "error" { ctx.emit_failed(msg.clone()); return Err(msg); }
                    ctx.emit_log(&ctx.label, "warn", 0, msg, "panel");
                    break;
                }

                attempt += 1;
                if let Some(res) = check(&req, &ctx).await {
                    ctx.emit_log(&ctx.label, "info", 0,
                        format!("Watchdog [gate]: tentativo {} — HTTP {} | {}: {} | {}ms",
                            attempt, res.status_code, header_name,
                            res.header_found.clone().unwrap_or_else(|| "(assente)".to_string()), res.elapsed_ms), "panel");
                    if res.matched {
                        ctx.emit_log(&ctx.label, "ok", 0,
                            format!("Watchdog [gate]: condizione soddisfatta dopo {} tentativo/i", attempt), "panel");
                        let meta = build_meta(&res, attempt, &url, &header_name);
                        rows_out = emit_gate(&tx, &input_rows, &meta).await;
                        matched = true;
                        break;
                    }
                }

                tokio::select! {
                    _ = ctx.cancel.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {}
                }
            }
            if !matched && on_timeout == "proceed" {
                // Passa comunque, marcando matched=false.
                let meta = vec![
                    ("watchdog_matched".to_string(),  Value::Bool(false)),
                    ("watchdog_attempts".to_string(), Value::Int(attempt as i64)),
                ];
                rows_out = emit_gate(&tx, &input_rows, &meta).await;
            }
        }

        // ── STREAM ────────────────────────────────────────────────
        "stream" => {
            let mut attempt = 0u64;
            loop {
                if ctx.cancel.is_cancelled() { break; }
                if let Some(d) = global_deadline_ms {
                    if start.elapsed().as_millis() >= d { break; }
                }
                attempt += 1;
                if let Some(res) = check(&req, &ctx).await {
                    if res.matched {
                        let meta = build_meta(&res, attempt, &url, &header_name);
                        if tx.send(row_with(&meta)).await.is_err() { break; }
                        rows_out += 1;
                        ctx.emit_log(&ctx.label, "info", 0,
                            format!("Watchdog [stream]: emessa riga #{} | {}: {}",
                                rows_out, header_name, res.header_found.clone().unwrap_or_default()), "panel");
                    }
                }
                tokio::select! {
                    _ = ctx.cancel.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {}
                }
            }
            ctx.emit_log(&ctx.label, "ok", 0,
                format!("Watchdog [stream]: terminato — {} rilevazioni positive in {} check", rows_out, attempt), "panel");
        }

        // ── EDGE ──────────────────────────────────────────────────
        "edge" => {
            let mut attempt = 0u64;
            let mut prev: Option<bool> = None;
            loop {
                if ctx.cancel.is_cancelled() { break; }
                if let Some(d) = global_deadline_ms {
                    if start.elapsed().as_millis() >= d { break; }
                }
                attempt += 1;
                if let Some(res) = check(&req, &ctx).await {
                    let curr = res.matched;
                    match prev {
                        Some(p) if curr != p => {
                            let edge = if curr { "rising" } else { "falling" };
                            let should = edge_trigger == "both" || edge_trigger == edge;
                            ctx.emit_log(&ctx.label, "info", 0,
                                format!("Watchdog [edge]: transizione {} — {}: {} → {}", edge, header_name, p, curr), "panel");
                            if should {
                                let mut meta = build_meta(&res, attempt, &url, &header_name);
                                meta.push(("watchdog_edge".to_string(), Value::String(edge.to_string())));
                                meta.push(("watchdog_prev".to_string(), Value::Bool(p)));
                                if tx.send(row_with(&meta)).await.is_err() { break; }
                                rows_out += 1;
                            }
                        }
                        None => {
                            ctx.emit_log(&ctx.label, "info", 0,
                                format!("Watchdog [edge]: stato iniziale — matched {}", curr), "panel");
                        }
                        _ => {}
                    }
                    prev = Some(curr);
                }
                tokio::select! {
                    _ = ctx.cancel.cancelled() => break,
                    _ = tokio::time::sleep(interval) => {}
                }
            }
            ctx.emit_log(&ctx.label, "ok", 0,
                format!("Watchdog [edge]: terminato — {} transizioni in {} check", rows_out, attempt), "panel");
        }

        other => {
            let msg = format!("watchdog {}: modalità '{}' sconosciuta", ctx.node_id.0, other);
            ctx.emit_failed(msg.clone());
            return Err(msg);
        }
    }

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
