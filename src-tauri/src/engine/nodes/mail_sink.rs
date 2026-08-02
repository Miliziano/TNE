// ─── src-tauri/src/engine/nodes/mail_sink.rs ──────────────────────
//
// Sink email. Provider SMTP portato via `crate::mail_send_impl` (lettre, già
// in lib.rs — cablaggio). I provider cloud-REST (sendgrid/mailgun/ses) sono
// DEFERITI a fase 2 (avviso onesto, non invio silenzioso), come Kafka nativo.
//
// Riferimento del flusso: `src/runner/mailSinkExecutor.ts`. Config dai prop
// (il pannello NON usa risorsa). Modi: `per_row` (una email per riga) e
// `batch` (una email con i corpi aggregati). Retry con backoff.

use std::time::{Duration, Instant};
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::{MailSendRequest, MailAttachmentRequest, SmtpConfig, mail_send_impl};

/// Sostituisce `{campo}` col valore della riga ("" se assente/null).
fn interpolate(tpl: &str, row: &Row) -> String {
    let chars: Vec<char> = tpl.chars().collect();
    let mut out = String::with_capacity(tpl.len());
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '{' {
            if let Some(rel) = chars[i + 1..].iter().position(|&c| c == '}') {
                let name: String = chars[i + 1..i + 1 + rel].iter().collect();
                if !name.is_empty() && name.chars().all(|c| c.is_alphanumeric() || c == '_') {
                    out.push_str(&row.get(&name).map(|v| v.as_str_repr()).unwrap_or_default());
                    i = i + 1 + rel + 1;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

fn build_recipients(spec: &Spec, row: &Row) -> (Vec<String>, Vec<String>, Vec<String>) {
    let split_list = |s: String| -> Vec<String> {
        s.split([',', '\n']).map(|e| e.trim().to_string()).filter(|e| !e.is_empty()).collect()
    };
    let to_mode = spec.str_or("toMode", "static");
    let mut to: Vec<String> = Vec::new();
    if to_mode == "static" || to_mode == "both" {
        to.extend(split_list(spec.str_or("toEmails", "")));
    }
    if to_mode == "field" || to_mode == "both" {
        let field = spec.str_or("toField", "email");
        if let Some(v) = row.get(&field) {
            to.extend(v.as_str_repr().split(',').map(|e| e.trim().to_string()).filter(|e| !e.is_empty()));
        }
    }
    let cc  = split_list(spec.str_or("ccEmails", ""));
    let bcc = split_list(spec.str_or("bccEmails", ""));
    (to, cc, bcc)
}

fn build_body(spec: &Spec, row: &Row) -> (Option<String>, Option<String>) {
    match spec.str_or("bodySource", "field").as_str() {
        "field" => match row.get(&spec.str_or("bodyField", "content")) {
            Some(v) => {
                let s = v.as_str_repr();
                if s.trim_start().starts_with('<') { (Some(s), None) } else { (None, Some(s)) }
            }
            None => (None, Some(String::new())),
        },
        "template" => (Some(interpolate(&spec.str_or("bodyTemplate", ""), row)), None),
        "plain"    => (None, Some(interpolate(&spec.str_or("bodyText", ""), row))),
        _          => (None, None),
    }
}

fn build_attachment(spec: &Spec, row: &Row) -> Option<MailAttachmentRequest> {
    let field = spec.str_or("attachmentField", "");
    if field.is_empty() { return None; }
    let content = row.get(&field)?.as_str_repr();
    if content.is_empty() { return None; }
    Some(MailAttachmentRequest {
        filename:     interpolate(&spec.str_or("attachmentName", "allegato.pdf"), row),
        content_b64:  content,
        content_type: spec.str_or("attachmentMime", "application/pdf"),
    })
}

fn build_smtp(spec: &Spec) -> SmtpConfig {
    SmtpConfig {
        host:     spec.str_or("smtpHost", "localhost"),
        port:     spec.u64_or("smtpPort", 587) as u16,
        username: spec.str_or("smtpUser", ""),
        password: spec.str_or("smtpPass", ""),
        security: spec.str_or("smtpSecurity", "starttls"),
    }
}

/// Invio con retry a backoff crescente.
async fn send_with_retry(req: &MailSendRequest, retry: u64) -> Result<(), String> {
    let mut attempt = 0u64;
    loop {
        match mail_send_impl(req.clone()).await {
            Ok(()) => return Ok(()),
            Err(e) => {
                if attempt < retry {
                    attempt += 1;
                    tokio::time::sleep(Duration::from_millis(500 * attempt)).await;
                } else {
                    return Err(e);
                }
            }
        }
    }
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("mail_sink {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("mail_sink", &ctx.node_id.0);

    let provider  = spec.str_or("provider", "smtp");
    let send_mode = spec.str_or("sendMode", "per_row");
    let from_email = spec.str_or("fromEmail", "");
    let from_name  = spec.str_or("fromName", "FlowPilot");
    let from = if from_name.is_empty() { from_email.clone() } else { format!("{} <{}>", from_name, from_email) };
    let retry_count = spec.u64_or("retryCount", 2).min(5);
    let on_error    = spec.str_or("onError", "continue");

    let mut rows: Vec<Row> = Vec::new();
    if let Some(mut rxc) = rx {
        while let Some(r) = rxc.recv().await { rows.push(r); }
    }
    let rows_in = rows.len() as u64;
    let start = Instant::now();

    // riga di riepilogo comune (chiamata nei vari punti d'uscita)
    let summary = |sent: u64, errors: u64| -> Row {
        let mut row = Row::new();
        row.set("_mail_sent".to_string(),   Value::Int(sent as i64));
        row.set("_mail_errors".to_string(), Value::Int(errors as i64));
        row.set("provider".to_string(),     Value::String(provider.clone()));
        row.set("completed_at".to_string(), Value::String(chrono::Utc::now().to_rfc3339()));
        row
    };

    if rows.is_empty() {
        ctx.emit_log(&ctx.label, "warn", 0, "MailSink: nessuna riga in ingresso".to_string(), "panel");
        let row = summary(0, 0);
        let rows_out = match &tx { Some(t) => { let _ = t.send(row).await; 1 } None => 0 };
        let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0, elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    // Provider cloud-REST non ancora portati (fase 1).
    if provider != "smtp" {
        ctx.emit_log(&ctx.label, "warn", 0, format!(
            "MailSink: il provider '{}' (cloud REST) non è ancora portato nel motore — usa SMTP. \
             In fase 2 verrà generato il codice per sendgrid/mailgun/ses.", provider), "panel");
        let mut row = summary(0, 0);
        row.set("_mail_skipped".to_string(), Value::Int(rows_in as i64));
        let rows_out = match &tx { Some(t) => { let _ = t.send(row).await; 1 } None => 0 };
        let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    if from_email.is_empty() {
        let msg = format!("mail_sink {}: email mittente non configurata", ctx.node_id.0);
        ctx.emit_failed(msg.clone());
        return Err(msg);
    }

    ctx.emit_log(&ctx.label, "info", 0,
        format!("MailSink [smtp] — modalità {} · {} righe", send_mode, rows_in), "panel");

    let smtp = build_smtp(&spec);
    let mut sent   = 0u64;
    let mut errors = 0u64;

    if send_mode == "batch" {
        // Prima riga per destinatari e oggetto; corpo = concatenazione di tutte.
        let first = &rows[0];
        let (to, cc, bcc) = build_recipients(&spec, first);
        if to.is_empty() {
            ctx.emit_log(&ctx.label, "warn", 0, "MailSink batch: nessun destinatario".to_string(), "panel");
            let row = summary(0, 0);
            let rows_out = match &tx { Some(t) => { let _ = t.send(row).await; 1 } None => 0 };
            let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms: start.elapsed().as_millis() as u64, error: None };
            ctx.emit_completed(stats.clone());
            return Ok(stats);
        }
        let subject = interpolate(&spec.str_or("subject", "Report"), first);
        let mut htmls: Vec<String> = Vec::new();
        let mut texts: Vec<String> = Vec::new();
        for row in &rows {
            let (h, t) = build_body(&spec, row);
            if let Some(h) = h { htmls.push(h); }
            if let Some(t) = t { texts.push(t); }
        }
        let req = MailSendRequest {
            smtp: smtp.clone(), from: from.clone(), to, cc, bcc, subject,
            html: if htmls.is_empty() { None } else { Some(htmls.join("\n<hr/>\n")) },
            text: if texts.is_empty() { None } else { Some(texts.join("\n---\n")) },
            attachments: build_attachment(&spec, first).into_iter().collect(),
        };
        match send_with_retry(&req, retry_count).await {
            Ok(()) => sent += 1,
            Err(e) => {
                errors += 1;
                let msg = format!("mail_sink {}: invio batch fallito — {}", ctx.node_id.0, e);
                ctx.emit_failed(msg.clone());
                return Err(msg);
            }
        }
    } else {
        // per_row: una email per riga.
        for row in &rows {
            if ctx.cancel.is_cancelled() { break; }
            let (to, cc, bcc) = build_recipients(&spec, row);
            if to.is_empty() {
                ctx.emit_log(&ctx.label, "warn", 0, "MailSink: riga senza destinatario — saltata".to_string(), "panel");
                continue;
            }
            let subject = interpolate(&spec.str_or("subject", "Notifica"), row);
            let (html, text) = build_body(&spec, row);
            let req = MailSendRequest {
                smtp: smtp.clone(), from: from.clone(), to: to.clone(), cc, bcc, subject, html, text,
                attachments: build_attachment(&spec, row).into_iter().collect(),
            };
            match send_with_retry(&req, retry_count).await {
                Ok(()) => sent += 1,
                Err(e) => {
                    errors += 1;
                    ctx.emit_log(&ctx.label, "error", 0,
                        format!("MailSink: errore invio a {} — {}", to.join(","), e), "panel");
                    if on_error == "stop" {
                        let msg = format!("mail_sink {}: invio fallito — {}", ctx.node_id.0, e);
                        ctx.emit_failed(msg.clone());
                        return Err(msg);
                    }
                }
            }
        }
    }

    ctx.emit_log(&ctx.label, "info", 0,
        format!("MailSink: {} email inviate, {} errori", sent, errors), "panel");

    let row = summary(sent, errors);
    let rows_out = match &tx { Some(t) => { let _ = t.send(row).await; 1 } None => 0 };

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: errors,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
