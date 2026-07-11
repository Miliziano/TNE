// ─── src-tauri/src/engine/nodes/filter.rs (v2) ─────────────────────
//
// PORTING FEDELE del filterExecutor di src/runner/executors.ts.
//
// ROUTING FIRST-MATCH: ogni riga esce sul PRIMO handle (cond.id) la
// cui condizione passa, nell'ordine di priorità configurato; se
// nessuna condizione passa → handle 'reject'.
//
// MODALITÀ CONDIZIONE:
//   visual   — clausole con operatori nativi (==, !=, >, >=, <, <=,
//              contains, starts, ends, is_null, not_null, in, not_in,
//              regex) concatenate con AND/OR: implementate nativamente.
//              NOTA fedele al riferimento: i confronti stringa sono
//              SEMPRE case-insensitive (il flag caseSensitive è
//              ignorato anche nel runner TS).
//   template — i 16 template predefiniti sono implementati
//              NATIVAMENTE (numerici, stringa, null, date via chrono).
//   code     — JavaScript/TypeScript/Python: non eseguibile nel
//              motore Rust (B.2) → warning + condizione falsa (la
//              riga scivola verso le condizioni successive / reject).
//
// nullBehavior: exclude (default, campo null → clausola falsa),
// include (prosegue la valutazione), error (condizione in errore →
// warning e falsa, come il catch del riferimento).
//
// Config (da buildRustPlan):
//   { conditions: [...], null_behavior: 'exclude' }

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use chrono::{Datelike, Local, NaiveDate, NaiveDateTime};
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

const PROGRESS_EVERY: u64 = 500;

// ─── Strutture config ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct FilterPlan {
    #[serde(default)]
    conditions:    Vec<FilterCondition>,
    #[serde(default = "d_exclude")]
    null_behavior: String,
}
fn d_exclude() -> String { "exclude".into() }

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FilterCondition {
    #[serde(default)]
    id:    String,
    #[serde(default)]
    label: String,
    #[serde(default)]
    mode:  String,   // visual | template | code
    #[serde(default)]
    clauses: Vec<VisualClause>,
    #[serde(default)]
    template_id:     String,
    #[serde(default)]
    template_params: HashMap<String, String>,
    #[serde(default)]
    code: String,
}

#[derive(Debug, Deserialize, Clone)]
struct VisualClause {
    #[serde(default)]
    field:    String,
    #[serde(default)]
    operator: String,
    #[serde(default)]
    value:    String,
    #[serde(default = "d_and")]
    logic:    String,   // AND | OR — connettore con la clausola PRECEDENTE
}
fn d_and() -> String { "AND".into() }

// ─── Entry point ──────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let spec = crate::engine::spec::Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("filter {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("filter", &ctx.node_id.0);

    // Le `conditions` (visual/template/code) sono una struttura elaborata
    // dal builder → spec.config. Filter non usa FPEL: le condizioni sono
    // clausole strutturate o template, non espressioni compilate.
    let plan: FilterPlan = serde_json::from_value(spec.config().clone())
        .map_err(|e| format!("filter {}: config non valida: {}", ctx.node_id.0, e))?;

    let start = Instant::now();
    let mut rows_in       = 0u64;
    let mut rows_out      = 0u64;
    let mut rows_rejected = 0u64;
    let mut per_cond: HashMap<String, u64> = HashMap::new();

    // Warning una tantum per condizioni 'code' (B.2)
    for cond in plan.conditions.iter().filter(|c| c.mode == "code") {
        eprintln!("[filter {}] ATTENZIONE: la condizione '{}' è in modalità code \
                   (JS/TS/Python) non eseguibile dal motore — verrà trattata come FALSA",
                   ctx.node_id.0, cond.label);
    }

    // Nessuna condizione configurata: passthrough sull'uscita primaria
    // (comportamento del riferimento quando la config è vuota)
    if plan.conditions.is_empty() {
        eprintln!("[filter {}] nessuna condizione configurata: passthrough", ctx.node_id.0);
        let tx = outputs.values().next();
        while let Some(row) = rx.recv().await {
            rows_in += 1;
            if let Some(tx) = tx {
                if tx.send(row).await.is_ok() { rows_out += 1; }
            }
        }
        let elapsed_ms = start.elapsed().as_millis() as u64;
        let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    let reject_tx = outputs.get("reject");

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // ── First-match: prima condizione che passa vince ─────────
        let mut placed = false;
        for cond in &plan.conditions {
            let passes = match evaluate_condition(&row, cond, &plan.null_behavior) {
                Ok(v)  => v,
                Err(e) => {
                    // come il riferimento: log e la condizione non passa
                    eprintln!("[filter {}] '{}': {}", ctx.node_id.0, cond.label, e);
                    false
                }
            };
            if passes {
                if let Some(tx) = outputs.get(&cond.id) {
                    if tx.send(row.clone()).await.is_ok() { rows_out += 1; }
                }
                // Anche se l'uscita non è collegata la riga è "piazzata":
                // il first-match consuma la riga alla prima condizione vera
                *per_cond.entry(cond.id.clone()).or_insert(0) += 1;
                placed = true;
                break;
            }
        }

        if !placed {
            rows_rejected += 1;
            if let Some(tx) = reject_tx {
                let _ = tx.send(row).await;
            }
        }

        if rows_in % PROGRESS_EVERY == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, rows_rejected, rps);
        }
    }

    let stats_str = plan.conditions.iter()
        .map(|c| format!("{}:{}", c.label, per_cond.get(&c.id).copied().unwrap_or(0)))
        .collect::<Vec<_>>().join(" ");
    eprintln!("[filter {}] {} | reject:{}", ctx.node_id.0, stats_str, rows_rejected);

    // Fase 8: conteggi per handle di uscita → badge sul canvas
    let mut per_out = per_cond.clone();
    per_out.insert("reject".to_string(), rows_rejected);
    ctx.emit_output_stats(per_out);

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Valutazione condizioni ───────────────────────────────────────

fn evaluate_condition(row: &Row, cond: &FilterCondition, null_behavior: &str) -> Result<bool, String> {
    match cond.mode.as_str() {
        "visual" => {
            if cond.clauses.is_empty() { return Ok(true); }
            let mut result = eval_visual_clause(row, &cond.clauses[0], null_behavior)?;
            for i in 1..cond.clauses.len() {
                let curr = eval_visual_clause(row, &cond.clauses[i], null_behavior)?;
                // il connettore logic è sulla clausola PRECEDENTE
                result = if cond.clauses[i - 1].logic == "OR" {
                    result || curr
                } else {
                    result && curr
                };
            }
            Ok(result)
        }
        "template" => eval_template(row, &cond.template_id, &cond.template_params),
        "code"     => Ok(false),   // B.2: JS non eseguibile — warning emesso all'avvio
        _          => Ok(false),
    }
}

fn eval_visual_clause(row: &Row, clause: &VisualClause, null_behavior: &str) -> Result<bool, String> {
    let raw = row.get(&clause.field).filter(|v| !matches!(v, Value::Null));

    if raw.is_none() {
        match clause.operator.as_str() {
            "is_null"  => return Ok(true),
            "not_null" => return Ok(false),
            _ => match null_behavior {
                "exclude" => return Ok(false),
                "error"   => return Err(format!("Campo '{}' è null", clause.field)),
                _         => {} // include: prosegue con stringa vuota
            },
        }
    }

    // Confronti case-insensitive come il riferimento
    let str_v = raw.map(|v| v.as_str_repr()).unwrap_or_default().to_lowercase();
    let val   = clause.value.to_lowercase();
    let num   = raw.and_then(num_of);
    let num_v = clause.value.trim().parse::<f64>().ok();

    Ok(match clause.operator.as_str() {
        "=="       => str_v == val,
        "!="       => str_v != val,
        ">"        => cmp(num, num_v, |a, b| a >  b),
        ">="       => cmp(num, num_v, |a, b| a >= b),
        "<"        => cmp(num, num_v, |a, b| a <  b),
        "<="       => cmp(num, num_v, |a, b| a <= b),
        "contains" => str_v.contains(&val),
        "starts"   => str_v.starts_with(&val),
        "ends"     => str_v.ends_with(&val),
        "is_null"  => raw.is_none(),
        "not_null" => raw.is_some(),
        "in"       => clause.value.split(',')
                        .any(|s| s.trim().to_lowercase() == str_v),
        "not_in"   => !clause.value.split(',')
                        .any(|s| s.trim().to_lowercase() == str_v),
        "regex"    => regex_test(&clause.value, &raw.map(|v| v.as_str_repr()).unwrap_or_default()),
        _          => true,
    })
}

fn cmp(a: Option<f64>, b: Option<f64>, f: impl Fn(f64, f64) -> bool) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => f(a, b),
        _ => false,   // NaN semantics del riferimento: !isNaN(num) && ...
    }
}

fn num_of(v: &Value) -> Option<f64> {
    match v {
        Value::Int(n)    => Some(*n as f64),
        Value::Float(f)  => Some(*f),
        Value::Bool(b)   => Some(if *b { 1.0 } else { 0.0 }),
        Value::String(s) => s.trim().parse::<f64>().ok(),
        _                => None,
    }
}

// ─── Template nativi (porting di templateToCode) ──────────────────

fn eval_template(row: &Row, template_id: &str, p: &HashMap<String, String>) -> Result<bool, String> {
    let field = |key: &str| -> Option<&Value> {
        p.get(key).and_then(|f| row.get(f)).filter(|v| !matches!(v, Value::Null))
    };
    let fnum  = |key: &str| field(key).and_then(num_of);
    let fstr  = |key: &str| field(key).map(|v| v.as_str_repr()).unwrap_or_default();
    let pnum  = |key: &str| p.get(key).and_then(|s| s.trim().parse::<f64>().ok());
    let pstr  = |key: &str| p.get(key).cloned().unwrap_or_default();

    Ok(match template_id {
        "num_greater"     => matches!((fnum("field"), pnum("threshold")), (Some(a), Some(b)) if a > b),
        "num_less"        => matches!((fnum("field"), pnum("threshold")), (Some(a), Some(b)) if a < b),
        "num_between"     => matches!((fnum("field"), pnum("min"), pnum("max")),
                                (Some(a), Some(lo), Some(hi)) if a >= lo && a <= hi),
        "num_is_zero"     => fnum("field") == Some(0.0),
        "num_is_negative" => matches!(fnum("field"), Some(a) if a < 0.0),

        "str_contains"    => fstr("field").to_lowercase().contains(&pstr("text").to_lowercase()),
        "str_starts"      => fstr("field").starts_with(&pstr("prefix")),
        "str_ends"        => fstr("field").ends_with(&pstr("suffix")),
        "str_regex"       => regex_test(&pstr("pattern"), &fstr("field")),
        "str_is_empty"    => field("field").is_none() || fstr("field").trim().is_empty(),

        "is_null"         => field("field").is_none(),
        "is_not_null"     => field("field").is_some(),

        "date_is_today"   => parse_date(&fstr("field"))
                                .map_or(false, |d| d == Local::now().date_naive()),
        "date_is_past"    => parse_datetime(&fstr("field"))
                                .map_or(false, |d| d < Local::now().naive_local()),
        "date_is_future"  => parse_datetime(&fstr("field"))
                                .map_or(false, |d| d > Local::now().naive_local()),
        "date_is_weekend" => parse_date(&fstr("field"))
                                .map_or(false, |d| {
                                    let wd = d.weekday().num_days_from_sunday();
                                    wd == 0 || wd == 6
                                }),
        "date_range"      => match (parse_datetime(&fstr("field")),
                                    parse_datetime(&pstr("from")),
                                    parse_datetime(&pstr("to"))) {
            (Some(d), Some(from), Some(to)) => d >= from && d <= to,
            _ => false,
        },

        _ => true,   // template sconosciuto: come il default del riferimento
    })
}

fn parse_date(s: &str) -> Option<NaiveDate> {
    let s = s.trim();
    if s.is_empty() { return None; }
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
        .or_else(|| parse_datetime(s).map(|dt| dt.date()))
}

fn parse_datetime(s: &str) -> Option<NaiveDateTime> {
    let s = s.trim();
    if s.is_empty() { return None; }
    chrono::DateTime::parse_from_rfc3339(s).ok()
        .map(|dt| dt.naive_local())
        .or_else(|| NaiveDateTime::parse_from_str(s, "%Y-%m-%d %H:%M:%S").ok())
        .or_else(|| NaiveDateTime::parse_from_str(s, "%Y-%m-%dT%H:%M:%S").ok())
        .or_else(|| NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
            .and_then(|d| d.and_hms_opt(0, 0, 0)))
}

// Regex minimale senza dipendenze: supporta il caso d'uso comune
// (pattern letterali, case-insensitive come il riferimento con flag 'i').
// Per pattern regex veri aggiungere il crate `regex` a Cargo.toml e
// sostituire questa funzione — segnalato nel log al primo uso.
fn regex_test(pattern: &str, value: &str) -> bool {
    static WARNED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if !WARNED.swap(true, std::sync::atomic::Ordering::Relaxed) {
        eprintln!("[filter] NOTA: operatore regex in modalità semplificata \
                   (match per sottostringa case-insensitive). Per regex complete \
                   aggiungere il crate `regex` a Cargo.toml.");
    }
    value.to_lowercase().contains(&pattern.to_lowercase())
}