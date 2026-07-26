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
    #[serde(default)] rules: Vec<CellRule>,                 // formattazione condizionale (F2)
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
    let kpi_fields: Vec<String> = spec.str_or("kpiFields", "")
        .split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();

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
        (build_html(&rows, &columns, &template, &title, &subtitle, &header_col, &accent_col, &theme, &locale, &dq_field, &kpi_fields),
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
        rules: Vec::new(),
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

// ─── Formattazione condizionale (CellRule) ─────────────────────────
#[derive(Deserialize, Default, Clone)]
struct CellRule {
    #[serde(default)] condition: String,   // lt|gt|lte|gte|eq|neq|contains|is_null|not_null|custom
    #[serde(default)] value: String,
    #[serde(default)] target: String,      // cell|row
    #[serde(default)] style: String,       // danger|warning|success|info|custom
    #[serde(default, rename = "bgColor")]   bg_color: Option<String>,
    #[serde(default, rename = "textColor")] text_color: Option<String>,
    #[serde(default)] icon: String,
    // `condition="custom"` (espressione arbitraria) → RIMANDATO: va valutato
    // con FPEL (lo studio compila l'espressione in IR, il motore la valuta
    // con expr.rs), per non introdurre un secondo valutatore. Per ora non scatta.
}

// preset (bg, text, border) per chiaro/scuro.
fn preset(style: &str, dark: bool) -> (&'static str, &'static str, &'static str) {
    match (style, dark) {
        ("danger",  false) => ("#fff0f0", "#c0392b", "#e74c3c"),
        ("warning", false) => ("#fffbf0", "#d35400", "#f39c12"),
        ("success", false) => ("#f0fff4", "#1e8449", "#27ae60"),
        ("info",    false) => ("#f0f8ff", "#1a5276", "#2980b9"),
        ("danger",  true)  => ("#2a0a0a", "#ff6b6b", "#ff5f57"),
        ("warning", true)  => ("#2a1a00", "#ffb347", "#f39c12"),
        ("success", true)  => ("#0a2a15", "#3ddc84", "#27ae60"),
        ("info",    true)  => ("#0a1a2a", "#4a9eff", "#2980b9"),
        _ => ("", "", ""),
    }
}
fn icon_char(name: &str) -> &'static str {
    match name { "arrow_up"=>"↑", "arrow_down"=>"↓", "warning"=>"⚠", "check"=>"✓", "dot"=>"●", "star"=>"★", _=>"" }
}

fn eval_rule(row: &Row, field: &str, rule: &CellRule) -> bool {
    let raw = row.0.get(field);
    let empty = matches!(raw, None | Some(Value::Null)) || matches!(raw, Some(v) if v.as_str_repr().is_empty());
    let s = raw.map(|v| v.as_str_repr().to_lowercase()).unwrap_or_default();
    let rv = rule.value.to_lowercase();
    let num = raw.and_then(|v| v.as_f64_lossy());
    let rvn = rule.value.parse::<f64>().ok();
    match rule.condition.as_str() {
        "lt"       => matches!((num, rvn), (Some(a), Some(b)) if a <  b),
        "gt"       => matches!((num, rvn), (Some(a), Some(b)) if a >  b),
        "lte"      => matches!((num, rvn), (Some(a), Some(b)) if a <= b),
        "gte"      => matches!((num, rvn), (Some(a), Some(b)) if a >= b),
        "eq"       => s == rv,
        "neq"      => s != rv,
        "contains" => s.contains(&rv),
        "is_null"  => empty,
        "not_null" => !empty,
        _          => false,   // "custom" → FPEL, rimandato
    }
}

#[derive(Default)]
struct CellStyle { bg: String, text: String, border: String, icon: String, row_bg: String, row_text: String }

// Prima regola che corrisponde vince (come il runner).
fn cell_style(row: &Row, field: &str, rules: &[CellRule], dark: bool) -> CellStyle {
    let mut r = CellStyle::default();
    for rule in rules {
        if !eval_rule(row, field, rule) { continue }
        let (bg, text) = if rule.style == "custom" {
            (rule.bg_color.clone().unwrap_or_default(), rule.text_color.clone().unwrap_or_default())
        } else {
            let (b, t, _) = preset(&rule.style, dark);
            (b.to_string(), t.to_string())
        };
        let (_, _, brd) = preset(&rule.style, dark);
        if rule.target == "row" {
            r.row_bg = bg; r.row_text = text;
        } else {
            r.bg = bg; r.text = text; r.border = brd.to_string();
        }
        if !rule.icon.is_empty() { r.icon = icon_char(&rule.icon).to_string(); }
        break;
    }
    r
}

// ─── Integrazione DQ (campo _dq scritto da data_quality) ───────────
#[derive(Deserialize, Default)]
struct DQIssue {
    #[serde(default)] field: String,
    #[serde(default)] severity: String,
    #[serde(default)] message: String,
    #[serde(default)] repaired: bool,
    #[serde(default)] action: Option<String>,
    #[serde(default)] original: Option<serde_json::Value>,
}
#[derive(Deserialize, Default)]
struct DQResult {
    #[serde(default)] score: f64,
    #[serde(default)] valid: bool,
    #[serde(default)] level: String,
    #[serde(default)] repaired: bool,
    #[serde(default)] issues: Vec<DQIssue>,
}
fn dq_of(row: &Row, dq_field: &str) -> Option<DQResult> {
    match row.0.get(dq_field) {
        Some(v) if !matches!(v, Value::Null) => serde_json::from_value::<DQResult>(v.to_json()).ok(),
        _ => None,
    }
}

// (css cella, badge) per il campo, dalle issue DQ.
fn dq_cell(dq: &Option<DQResult>, field: &str, dark: bool) -> (String, String) {
    let Some(dq) = dq else { return (String::new(), String::new()) };
    let Some(issue) = dq.issues.iter().find(|i| i.field == field) else { return (String::new(), String::new()) };
    let badge = |brd: &str, title: &str, sym: &str| format!(
        "<span title=\"{}\" style=\"display:inline-block;margin-left:5px;font-size:10px;padding:1px 4px;border-radius:3px;background:{};color:#fff;cursor:help\">{}</span>",
        esc(title), brd, sym);
    if issue.repaired {
        let (bg, text, brd) = preset("warning", dark);
        let orig = issue.original.as_ref().map(|o| format!(" (era: {})", o)).unwrap_or_default();
        let title = format!("Riparato: {}{} → {}", issue.message, orig, issue.action.clone().unwrap_or_else(|| "repair".into()));
        (format!("background:{};color:{};border:1px solid {};", bg, text, brd), badge(brd, &title, "✦"))
    } else if issue.severity == "error" {
        let (bg, text, brd) = preset("danger", dark);
        (format!("background:{};color:{};border:1px solid {};", bg, text, brd), badge(brd, &issue.message, "!"))
    } else if issue.severity == "warn" {
        let (bg, text, brd) = preset("warning", dark);
        (format!("background:{};color:{};", bg, text), badge(brd, &issue.message, "⚠"))
    } else {
        (String::new(), String::new())
    }
}

// ─── Card KPI (template "summary") ─────────────────────────────────
fn build_summary(rows: &[Row], kpi_fields: &[String], header_col: &str, accent_col: &str, locale: &str, dq_field: &str) -> String {
    if rows.is_empty() { return String::new() }
    let fields: Vec<String> = if !kpi_fields.is_empty() {
        kpi_fields.to_vec()
    } else {
        let mut ks: Vec<String> = rows[0].0.keys().filter(|k| k.as_str() != dq_field).cloned().collect();
        ks.sort(); ks.truncate(4); ks
    };
    let cards: String = fields.iter().map(|field| {
        let present: Vec<&Value> = rows.iter().filter_map(|r| r.0.get(field)).filter(|v| !matches!(v, Value::Null)).collect();
        let nums: Vec<f64> = present.iter().filter_map(|v| v.as_f64_lossy()).collect();
        let is_num = !nums.is_empty() && nums.len() == present.len();
        let (display, sub) = if is_num {
            let sum: f64 = nums.iter().sum();
            (fmt_num(sum, locale, false, false),
             format!("Media: {} · N: {}", fmt_num(sum / nums.len() as f64, locale, false, false), nums.len()))
        } else {
            let uniq: std::collections::HashSet<String> = present.iter().map(|v| v.as_str_repr()).collect();
            (uniq.len().to_string(), format!("Valori unici: {}", uniq.len()))
        };
        format!(
            "<div style=\"flex:1;min-width:150px;padding:18px 20px;background:{h};border-radius:8px;border-left:4px solid {a};box-shadow:0 2px 8px rgba(0,0,0,.1)\"><div style=\"font-size:10px;color:rgba(255,255,255,.6);text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;font-weight:600\">{f}</div><div style=\"font-size:26px;font-weight:700;color:{a};margin-bottom:4px\">{d}</div><div style=\"font-size:11px;color:rgba(255,255,255,.5)\">{s}</div></div>",
            h = header_col, a = accent_col, f = esc(&field.replace('_', " ")), d = esc(&display), s = esc(&sub))
    }).collect();
    format!("<div style=\"display:flex;flex-wrap:wrap;gap:14px;margin-bottom:24px\">{}</div>", cards)
}

// ─── Tabella HTML ──────────────────────────────────────────────────
fn build_table(rows: &[Row], columns: &[ColumnConfig], header_col: &str, accent_col: &str, theme: &Theme, locale: &str, dq_field: &str) -> String {
    if rows.is_empty() {
        return "<p style=\"color:#999;font-style:italic\">Nessun dato disponibile.</p>".to_string();
    }
    let cols = effective_cols(rows, columns, dq_field);
    let has_totals = cols.iter().any(|c| matches!(c.total.as_deref(), Some(t) if t != "none"));
    let dark = theme.bg == "#0f1117";
    let has_dq = rows.iter().any(|r| dq_of(r, dq_field).is_some());

    let th_style = format!(
        "padding:10px 14px;text-align:left;background:{};color:{};font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;border-bottom:2px solid {}",
        header_col, theme.header_text, accent_col);

    let mut header: String = cols.iter().map(|c| {
        let label = if c.label.is_empty() { c.field.replace('_', " ").to_uppercase() } else { c.label.clone() };
        format!("<th style=\"{}\">{}</th>", th_style, esc(&label))
    }).collect();
    if has_dq { header.push_str(&format!("<th style=\"{};width:60px;text-align:center\">DTS</th>", th_style)); }

    let body: String = rows.iter().enumerate().map(|(i, row)| {
        let dq = dq_of(row, dq_field);
        // Stile riga: zebra di default, sovrascritto da una regola target="row"
        // o dallo stato DQ della riga.
        let mut row_bg = String::new();
        let mut row_text = String::new();
        for c in &cols {
            let cs = cell_style(row, &c.field, &c.rules, dark);
            if !cs.row_bg.is_empty()   { row_bg = cs.row_bg; }
            if !cs.row_text.is_empty() { row_text = cs.row_text; }
        }
        let mut border_top = String::new();
        if let Some(d) = &dq {
            if !d.valid {
                let (bg, text, brd) = preset("danger", dark);
                if row_bg.is_empty() { row_bg = bg.to_string(); row_text = text.to_string(); }
                border_top = format!("border-top:2px solid {};", brd);
            } else if d.level == "warn" || d.repaired {
                let (bg, _, brd) = preset("warning", dark);
                if row_bg.is_empty() { row_bg = bg.to_string(); }
                border_top = format!("border-top:1px solid {};", brd);
            }
        }
        if row_bg.is_empty()   { row_bg = (if i % 2 == 0 { theme.row_even } else { theme.row_odd }).to_string(); }
        if row_text.is_empty() { row_text = theme.text.to_string(); }

        let cells: String = cols.iter().map(|c| {
            let align = if matches!(c.col_type.as_str(), "number" | "currency") { "right" } else { "left" };
            let cs = cell_style(row, &c.field, &c.rules, dark);
            let (dq_css, dq_badge) = dq_cell(&dq, &c.field, dark);
            let mut extra = String::new();
            if !cs.bg.is_empty()     { extra.push_str(&format!("background:{};", cs.bg)); }
            if !cs.text.is_empty()   { extra.push_str(&format!("color:{};", cs.text)); }
            if !cs.border.is_empty() { extra.push_str(&format!("border-left:3px solid {};", cs.border)); }
            if cs.bg.is_empty() { extra.push_str(&dq_css); }   // il DQ non sovrascrive una regola
            let ic = if cs.icon.is_empty() { String::new() } else { format!("{} ", cs.icon) };
            let td = format!("padding:9px 14px;text-align:{};border-bottom:1px solid {};font-size:13px;{}", align, theme.row_border, extra);
            format!("<td style=\"{}\">{}{}{}</td>", td, ic, esc(&format_cell(row.0.get(&c.field), &c.col_type, locale)), dq_badge)
        }).collect();

        let dts = if has_dq {
            match &dq {
                Some(d) => {
                    let pct = (d.score * 100.0).round() as i64;
                    let color = if d.score >= 0.8 { "#27ae60" } else if d.score >= 0.6 { "#f39c12" } else { "#e74c3c" };
                    let mark = if d.repaired { " ✦" } else { "" };
                    format!("<td style=\"padding:9px 14px;text-align:center;border-bottom:1px solid {}\"><span style=\"font-size:11px;font-weight:700;color:{}\">{}%{}</span></td>", theme.row_border, color, pct, mark)
                }
                None => format!("<td style=\"padding:9px 14px;text-align:center;border-bottom:1px solid {};color:#999\">—</td>", theme.row_border),
            }
        } else { String::new() };

        format!("<tr style=\"background:{};color:{};{}\">{}{}</tr>", row_bg, row_text, border_top, cells, dts)
    }).collect();

    let totals = if has_totals {
        let mut cells: String = cols.iter().map(|c| {
            let t = c.total.as_deref().unwrap_or("none");
            let val = if t != "none" { calc_total(rows, &c.field, t, locale) } else { String::new() };
            let align = if matches!(c.col_type.as_str(), "number" | "currency") { "right" } else { "left" };
            format!("<td style=\"padding:10px 14px;text-align:{};font-weight:700;border-top:2px solid {};color:{}\">{}</td>", align, accent_col, theme.text, esc(&val))
        }).collect();
        if has_dq { cells.push_str(&format!("<td style=\"border-top:2px solid {}\"></td>", accent_col)); }
        format!("<tr style=\"background:{}\">{}</tr>", theme.row_even, cells)
    } else { String::new() };

    format!(
        "<table style=\"width:100%;border-collapse:collapse;border:1px solid {}\"><thead><tr>{}</tr></thead><tbody>{}{}</tbody></table>",
        theme.row_border, header, body, totals)
}

// ─── Guscio HTML ───────────────────────────────────────────────────
fn build_html(rows: &[Row], columns: &[ColumnConfig], template: &str, title: &str, subtitle: &str, header_col: &str, accent_col: &str, theme: &Theme, locale: &str, dq_field: &str, kpi_fields: &[String]) -> String {
    let is_dark = theme.bg == "#0f1117";
    let body = match template {
        "summary" => build_summary(rows, kpi_fields, header_col, accent_col, locale, dq_field),
        // bar_chart / line_chart / pie_chart / mixed → Fetta 3; per ora tabella.
        _ => build_table(rows, columns, header_col, accent_col, theme, locale, dq_field),
    };
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
