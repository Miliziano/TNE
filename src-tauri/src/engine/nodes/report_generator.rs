// report_generator — genera un report dai dati in ingresso.
//
// Porting di src/runner/reportGeneratorExecutor.ts (v. il disegno in
// src-tauri/docs/design-nodo-report-generator.md). FETTA 1: formato Excel
// (solo dati) + template `table` in HTML (colonne tipizzate, formattazione
// per tipo/locale, riga dei totali, temi, guscio HTML). RIMANDATO alle fette
// successive: formattazione condizionale (CellRule), integrazione DQ, card
// KPI (F2); grafici SVG e template `mixed` (F3).
//
// Il nodo bufferizza TUTTE le righe (NEEDS_ROWS, come aggregate/window) ed
// emette UNA riga che descrive l'artefatto:
//   { content, content_type, filename, row_count, generated_at, template, format }
// `content` è la stringa HTML oppure il base64 dell'.xlsx. A valle un
// sink_file la scrive o un mail_sink la spedisce: il nodo NON tocca il disco.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use base64::Engine as _;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config colonna (dalla prop JSON "columns") ────────────────────
#[derive(Deserialize, Default, Clone)]
struct ColumnConfig {
    #[serde(default)] field: String,
    #[serde(default)] label: String,
    #[serde(default, rename = "type")] col_type: String,   // text|number|currency|date
    #[serde(default)] total: Option<String>,               // sum|avg|count|none
    // `rules` (formattazione condizionale) → Fetta 2.
}

// ─── Tema ──────────────────────────────────────────────────────────
struct Theme {
    accent: &'static str, header: &'static str, header_text: &'static str,
    row_even: &'static str, row_odd: &'static str, row_border: &'static str,
    text: &'static str, bg: &'static str,
}
fn theme_for(name: &str) -> Theme {
    match name {
        "green"  => Theme { accent:"#3ddc84", header:"#1a4a2a", header_text:"#ffffff", row_even:"#ffffff", row_odd:"#e8f8f0", row_border:"#c8e8d0", text:"#1a2a1e", bg:"#f4fbf7" },
        "dark"   => Theme { accent:"#4a9eff", header:"#1a2030", header_text:"#c8d4f0", row_even:"#161b27", row_odd:"#1e2535", row_border:"#2a3349", text:"#c8d4f0", bg:"#0f1117" },
        "orange" => Theme { accent:"#ffb347", header:"#4a1a00", header_text:"#ffffff", row_even:"#ffffff", row_odd:"#fff4e8", row_border:"#e8d0c0", text:"#2a1a00", bg:"#fffaf4" },
        _        => Theme { accent:"#4a9eff", header:"#1a3a6a", header_text:"#ffffff", row_even:"#ffffff", row_odd:"#e8f0fa", row_border:"#c8d4e8", text:"#1a2535", bg:"#f4f7fb" },
    }
}

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  RowSender,
) -> Result<NodeStats, String> {
    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("report_generator {}: {}", ctx.node_id.0, e))?;

    let output_fmt = spec.str_or("outputFormat", "html");
    let template   = spec.str_or("templateId",   "table");
    let title      = spec.str_or("reportTitle",  "Report");
    let subtitle   = spec.str_or("reportSubtitle", "");
    let filename   = spec.str_or("filename",     "report");
    let color      = spec.str_or("colorTheme",   "blue");
    let primary    = spec.str_or("primaryColor", "");
    let accent_ov  = spec.str_or("accentColor",  "");
    let locale     = spec.str_or("locale",       "it");
    let dq_field   = spec.str_or("dqField",      "_dq");
    let columns: Vec<ColumnConfig> =
        serde_json::from_str(&spec.str_or("columns", "[]")).unwrap_or_default();

    // ── Bufferizza tutte le righe ──────────────────────────────────
    let Some(mut rx) = rx else {
        return Err(format!("report_generator {}: nessun input collegato. Collega un flusso di dati.", ctx.node_id.0));
    };
    let start = Instant::now();
    let mut rows: Vec<Row> = Vec::new();
    while let Some(row) = rx.recv().await { rows.push(row) }
    let rows_in = rows.len() as u64;

    // ── Tema (con override custom) ─────────────────────────────────
    let theme = theme_for(&color);
    // In Rust i campi del tema sono &'static: per l'override custom teniamo
    // le stringhe a parte e le usiamo direttamente nel rendering.
    let header_col = if color == "custom" && !primary.is_empty() { primary.clone() } else { theme.header.to_string() };
    let accent_col = if color == "custom" && !accent_ov.is_empty() { accent_ov.clone() } else { theme.accent.to_string() };

    // ── Genera il contenuto ────────────────────────────────────────
    let (content, content_type, ext) = if output_fmt == "excel" {
        (build_excel(&rows, &columns, &dq_field)?,
         "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet".to_string(),
         "xlsx")
    } else {
        (build_html(&rows, &columns, &title, &subtitle, &header_col, &accent_col, &theme, &locale, &dq_field),
         "text/html".to_string(),
         "html")
    };

    let filename_ext = if filename.contains('.') { filename } else { format!("{}.{}", filename, ext) };

    // ── Emette l'unica riga-artefatto ──────────────────────────────
    let mut out: HashMap<String, Value> = HashMap::new();
    out.insert("content".into(),      Value::String(content));
    out.insert("content_type".into(), Value::String(content_type));
    out.insert("filename".into(),     Value::String(filename_ext));
    out.insert("row_count".into(),    Value::Int(rows_in as i64));
    out.insert("generated_at".into(), Value::String(chrono::Utc::now().to_rfc3339()));
    out.insert("template".into(),     Value::String(template));
    out.insert("format".into(),       Value::String(output_fmt));
    let _ = tx.send(Row(out)).await;

    Ok(NodeStats {
        rows_in,
        rows_out: 1,
        rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64,
        error: None,
    })
}

// ─── Colonne effettive ─────────────────────────────────────────────
// Se la config ha colonne con `field`, si usano; altrimenti si deducono
// dalle chiavi della prima riga (escluso il campo DQ).
fn effective_cols(rows: &[Row], columns: &[ColumnConfig], dq_field: &str) -> Vec<ColumnConfig> {
    if columns.iter().any(|c| !c.field.is_empty()) {
        return columns.to_vec();
    }
    let Some(first) = rows.first() else { return Vec::new() };
    let mut keys: Vec<&String> = first.0.keys().filter(|k| k.as_str() != dq_field).collect();
    keys.sort();   // deterministico
    keys.into_iter().map(|k| ColumnConfig {
        field: k.clone(),
        label: k.replace('_', " ").to_uppercase(),
        col_type: "text".into(),
        total: Some("none".into()),
    }).collect()
}

// ─── Formattazione per tipo/locale ─────────────────────────────────
fn format_cell(val: Option<&Value>, col_type: &str, locale: &str) -> String {
    match val {
        None | Some(Value::Null) => "—".to_string(),
        Some(v) => match col_type {
            "currency" => v.as_f64_lossy().map(|n| fmt_num(n, locale, true, true)).unwrap_or_else(|| v.as_str_repr()),
            "number"   => v.as_f64_lossy().map(|n| fmt_num(n, locale, false, false)).unwrap_or_else(|| v.as_str_repr()),
            "date"     => fmt_date(&v.as_str_repr(), locale),
            _          => v.as_str_repr(),
        },
    }
}

// Numero con separatori di locale. force2 = sempre 2 decimali (valuta);
// currency = aggiunge il simbolo.
fn fmt_num(n: f64, locale: &str, force2: bool, currency: bool) -> String {
    let (thou, dec) = if locale == "it" { (".", ",") } else { (",", ".") };
    let neg = n < 0.0;
    let abs = n.abs();
    let body = if force2 || abs.fract() != 0.0 {
        let s = format!("{:.2}", abs);
        let (i, f) = s.split_once('.').unwrap_or((s.as_str(), "00"));
        format!("{}{}{}", group_int(i, thou), dec, f)
    } else {
        group_int(&format!("{:.0}", abs), thou)
    };
    let signed = if neg { format!("-{}", body) } else { body };
    if currency {
        if locale == "it" { format!("{} €", signed) } else { format!("${}", signed) }
    } else {
        signed
    }
}

fn group_int(digits: &str, sep: &str) -> String {
    let len = digits.len();
    let mut out = String::with_capacity(len + len / 3);
    for (i, c) in digits.chars().enumerate() {
        if i > 0 && (len - i) % 3 == 0 { out.push_str(sep); }
        out.push(c);
    }
    out
}

fn fmt_date(s: &str, locale: &str) -> String {
    use chrono::{NaiveDate, NaiveDateTime, DateTime};
    let fmt = if locale == "it" { "%d/%m/%Y" } else { "%m/%d/%Y" };
    if s.len() >= 10 {
        if let Ok(d) = NaiveDate::parse_from_str(&s[..10], "%Y-%m-%d") {
            return d.format(fmt).to_string();
        }
    }
    if let Ok(dt) = NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S") {
        return dt.format(fmt).to_string();
    }
    if let Ok(dt) = DateTime::parse_from_rfc3339(s) {
        return dt.format(fmt).to_string();
    }
    s.to_string()
}

fn calc_total(rows: &[Row], field: &str, total: &str, locale: &str) -> String {
    let nums: Vec<f64> = rows.iter()
        .filter_map(|r| r.0.get(field).and_then(|v| v.as_f64_lossy()))
        .collect();
    match total {
        "sum"   if !nums.is_empty() => fmt_num(nums.iter().sum(), locale, false, false),
        "avg"   if !nums.is_empty() => fmt_num(nums.iter().sum::<f64>() / nums.len() as f64, locale, false, false),
        "count" => rows.len().to_string(),
        _       => String::new(),
    }
}

// Escape minimo per non rompere l'HTML con dati che contengono < > & ".
fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;").replace('"', "&quot;")
}

// ─── Tabella HTML ──────────────────────────────────────────────────
fn build_table(rows: &[Row], columns: &[ColumnConfig], header_col: &str, accent_col: &str, theme: &Theme, locale: &str, dq_field: &str) -> String {
    if rows.is_empty() {
        return "<p style=\"color:#999;font-style:italic\">Nessun dato disponibile.</p>".to_string();
    }
    let cols = effective_cols(rows, columns, dq_field);
    let has_totals = cols.iter().any(|c| matches!(c.total.as_deref(), Some(t) if t != "none"));

    let th_style = format!(
        "padding:10px 14px;text-align:left;background:{};color:{};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;border-bottom:2px solid {}",
        header_col, theme.header_text, accent_col);

    let header: String = cols.iter().map(|c| {
        let label = if c.label.is_empty() { c.field.replace('_', " ").to_uppercase() } else { c.label.clone() };
        format!("<th style=\"{}\">{}</th>", th_style, esc(&label))
    }).collect();

    let body: String = rows.iter().enumerate().map(|(i, row)| {
        let bg = if i % 2 == 0 { theme.row_even } else { theme.row_odd };
        let cells: String = cols.iter().map(|c| {
            let align = if matches!(c.col_type.as_str(), "number" | "currency") { "right" } else { "left" };
            let td = format!("padding:9px 14px;text-align:{};border-bottom:1px solid {};color:{};font-size:13px", align, theme.row_border, theme.text);
            format!("<td style=\"{}\">{}</td>", td, esc(&format_cell(row.0.get(&c.field), &c.col_type, locale)))
        }).collect();
        format!("<tr style=\"background:{}\">{}</tr>", bg, cells)
    }).collect();

    let totals = if has_totals {
        let cells: String = cols.iter().map(|c| {
            let t = c.total.as_deref().unwrap_or("none");
            let val = if t != "none" { calc_total(rows, &c.field, t, locale) } else { String::new() };
            let align = if matches!(c.col_type.as_str(), "number" | "currency") { "right" } else { "left" };
            format!("<td style=\"padding:10px 14px;text-align:{};font-weight:700;border-top:2px solid {};color:{}\">{}</td>", align, accent_col, theme.text, esc(&val))
        }).collect();
        format!("<tr style=\"background:{}\">{}</tr>", theme.row_even, cells)
    } else { String::new() };

    format!(
        "<table style=\"width:100%;border-collapse:collapse;border:1px solid {}\"><thead><tr>{}</tr></thead><tbody>{}{}</tbody></table>",
        theme.row_border, header, body, totals)
}

// ─── Guscio HTML ───────────────────────────────────────────────────
fn build_html(rows: &[Row], columns: &[ColumnConfig], title: &str, subtitle: &str, header_col: &str, accent_col: &str, theme: &Theme, locale: &str, dq_field: &str) -> String {
    let body = build_table(rows, columns, header_col, accent_col, theme, locale, dq_field);
    let is_dark = theme.bg == "#0f1117";
    let panel = if is_dark { "#161b27" } else { "#ffffff" };
    let sub = if subtitle.is_empty() { String::new() }
              else { format!("<div style=\"font-size:13px;color:{}90;margin-top:4px\">{}</div>", theme.header_text, esc(subtitle)) };
    let date = chrono::Utc::now().format(if locale == "it" { "%d/%m/%Y" } else { "%m/%d/%Y" });

    format!(
"<!DOCTYPE html>
<html lang=\"{lang}\"><head><meta charset=\"UTF-8\"/>
<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>
<title>{title}</title>
<style>*{{box-sizing:border-box;margin:0;padding:0}}
body{{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,sans-serif;background:{bg};color:{text};padding:24px}}
.report{{max-width:980px;margin:0 auto;background:{panel};border-radius:12px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,.12)}}
.rh{{padding:22px 28px;background:{header};display:flex;justify-content:space-between;align-items:center;gap:16px;flex-wrap:wrap}}
.rt{{font-size:22px;font-weight:700;color:{htext}}}
.rm{{text-align:right;font-size:11px;color:{htext}70;line-height:1.6}}
.rb{{padding:28px}}
@media print{{body{{background:#fff;padding:0}}.report{{box-shadow:none;border-radius:0}}}}</style></head>
<body><div class=\"report\">
<div class=\"rh\"><div><div class=\"rt\">{title}</div>{sub}</div>
<div class=\"rm\"><div>{date}</div><div>{n} righe</div></div></div>
<div class=\"rb\">{body}</div></div></body></html>",
        lang = locale, title = esc(title), bg = theme.bg, text = theme.text, panel = panel,
        header = header_col, htext = theme.header_text, sub = sub, date = date, n = rows.len(), body = body)
}

// ─── Excel (solo dati, come il runner) ─────────────────────────────
fn build_excel(rows: &[Row], columns: &[ColumnConfig], dq_field: &str) -> Result<String, String> {
    use rust_xlsxwriter::Workbook;
    let cols = effective_cols(rows, columns, dq_field);

    let mut wb = Workbook::new();
    let ws = wb.add_worksheet();

    // Intestazione
    for (c, col) in cols.iter().enumerate() {
        let label = if col.label.is_empty() { col.field.replace('_', " ").to_uppercase() } else { col.label.clone() };
        ws.write_string(0, c as u16, label).map_err(|e| format!("xlsx header: {}", e))?;
    }
    // Dati: numeri come numeri, il resto come stringa
    for (r, row) in rows.iter().enumerate() {
        let rr = (r + 1) as u32;
        for (c, col) in cols.iter().enumerate() {
            let cc = c as u16;
            match row.0.get(&col.field) {
                None | Some(Value::Null) => { ws.write_string(rr, cc, "").map_err(|e| e.to_string())?; }
                Some(v) => {
                    if matches!(col.col_type.as_str(), "number" | "currency") {
                        if let Some(n) = v.as_f64_lossy() {
                            ws.write_number(rr, cc, n).map_err(|e| e.to_string())?;
                            continue;
                        }
                    }
                    ws.write_string(rr, cc, v.as_str_repr()).map_err(|e| e.to_string())?;
                }
            }
        }
    }

    let buf = wb.save_to_buffer().map_err(|e| format!("xlsx save: {}", e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}
