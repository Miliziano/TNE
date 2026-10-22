// ─── src-tauri/src/engine/nodes/filter.rs (v3) ─────────────────────
//
// ROUTING FIRST-MATCH: ogni riga esce sul PRIMO handle (cond.id) la
// cui condizione passa, nell'ordine di priorità configurato; se
// nessuna condizione passa → handle 'reject'.
//
// MODALITÀ CONDIZIONE:
//   visual   — clausole con operatori nativi (==, !=, >, >=, <, <=,
//              contains, starts, ends, is_null, not_null, in, not_in,
//              regex) concatenate con AND/OR (il connettore sta sulla
//              clausola PRECEDENTE).
//   template — i 16 template predefiniti, implementati nativamente
//              (numerici, stringa, null, date via chrono).
//   code     — un'espressione FPEL, compilata dallo studio in IR
//              (`expr`) e valutata con expr::eval: vera se il valore è
//              "truthy" (is_truthy). P354: prima era sempre FALSA (era
//              JS/TS/Python, non eseguibile).
//
// caseSensitive (P354, prima ignorato): governa i confronti stringa di
// visual (==, !=, contains, starts, ends, in, not_in, regex) e dei
// template stringa (contains, starts, ends, regex). Non tocca la
// modalità code: lì valgono le regole di FPEL (lower()/upper() per
// confronti senza maiuscole). Regex: crate `regex` vero (prima era un
// "contiene" travestito), compilata una volta all'avvio — un pattern
// non valido fa fallire il nodo con il motivo, non riga per riga.
//
// nullBehavior (solo visual): exclude (default, campo null → clausola
// falsa), include (prosegue la valutazione con stringa vuota), error
// (condizione in errore → warning e falsa).
//
// execMode (P354, prima ignorato):
//   parallel     — (default) tutti i rami in streaming insieme.
//   ordered_wait — il ramo #1 va in streaming; i rami #2..#N sono
//                  trattenuti in memoria e il ramo #N parte solo quando
//                  la sotto-pipeline del ramo #N-1 ha FINITO (es. master
//                  prima dei dettagli, per le FK). Se quella
//                  sotto-pipeline fallisce, i rami successivi NON
//                  vengono emessi e il nodo fallisce. 'reject' resta in
//                  streaming. I nodi a valle CONDIVISI con un ramo
//                  successivo (o con reject) non si possono aspettare —
//                  sarebbe un deadlock — e sono esclusi dall'attesa
//                  (warning nel log).
//   'sequential' (valore legacy dello studio) = parallel: in streaming
//                  "partire in ordine senza aspettare" non ha differenze
//                  osservabili.
//
// Config (da buildRustPlan):
//   { conditions: [...], null_behavior, case_sensitive, exec_mode }
//   ogni condizione code porta `expr` (ExprNode) accanto a `code`.

use std::collections::{HashMap, HashSet};
use std::time::Instant;
use serde::Deserialize;
use chrono::{Datelike, Local, NaiveDate, NaiveDateTime};
use regex::{Regex, RegexBuilder};
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::expr::{ExprNode, EvalContext, eval, is_truthy};

const PROGRESS_EVERY: u64 = 500;

// ─── Strutture config ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct FilterPlan {
    #[serde(default)]
    conditions:     Vec<FilterCondition>,
    #[serde(default = "d_exclude")]
    null_behavior:  String,
    #[serde(default = "d_true")]
    case_sensitive: bool,
    #[serde(default = "d_parallel")]
    exec_mode:      String,
}
fn d_exclude()  -> String { "exclude".into() }
fn d_parallel() -> String { "parallel".into() }
fn d_true()     -> bool   { true }

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
    /// IR compilato dallo studio dalla sorgente FPEL `code` (modalità
    /// code): il motore valuta solo questo.
    #[serde(default)]
    expr: Option<ExprNode>,
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

/// Regole di valutazione comuni a tutte le condizioni.
struct EvalOpts<'a> {
    null_behavior:  &'a str,
    case_sensitive: bool,
    variables:      &'a HashMap<String, Value>,
}

/// Regex compilate all'avvio, per (indice condizione, indice clausola);
/// la clausola usize::MAX è il parametro `pattern` del template.
type RegexCache = HashMap<(usize, usize), Regex>;
const TEMPLATE_SLOT: usize = usize::MAX;

/// I template che il motore sa valutare (allineati a FILTER_TEMPLATES
/// in src/nodes/types/filter/filterTypes.ts).
const KNOWN_TEMPLATES: &[&str] = &[
    "num_greater", "num_less", "num_between", "num_is_zero", "num_is_negative",
    "str_contains", "str_starts", "str_ends", "str_regex", "str_is_empty",
    "is_null", "is_not_null",
    "date_is_today", "date_is_past", "date_is_future", "date_is_weekend", "date_range",
];

// ─── Entry point ──────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let spec = crate::engine::spec::Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("filter {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("filter", &ctx.node_id.0);

    // Le `conditions` sono materiale elaborato dal builder → spec.config.
    // Quelle in modalità code portano l'IR FPEL già compilato (`expr`).
    let plan: FilterPlan = serde_json::from_value(spec.config().clone())
        .map_err(|e| format!("filter {}: invalid config: {}", ctx.node_id.0, e))?;

    let regexes = prepare(&plan).map_err(|e| format!("filter {}: {}", ctx.node_id.0, e))?;

    let opts = EvalOpts {
        null_behavior:  &plan.null_behavior,
        case_sensitive: plan.case_sensitive,
        variables:      &ctx.variables,
    };

    let start = Instant::now();
    let mut rows_in       = 0u64;
    let mut rows_out      = 0u64;
    let mut rows_rejected = 0u64;
    let mut per_cond: HashMap<String, u64> = HashMap::new();

    let ordered = plan.exec_mode == "ordered_wait" && plan.conditions.len() > 1;
    if plan.exec_mode == "sequential" {
        eprintln!("[filter {}] exec mode 'sequential' = parallel (streaming)", ctx.node_id.0);
    }

    // Insiemi di attesa del modo ordinato, calcolati PRIMA di leggere le
    // righe: un ramo che non si può ordinare lo si dice subito.
    let wait_sets: Vec<HashSet<String>> = if ordered {
        ordered_wait_sets(&ctx, &plan.conditions)
    } else {
        Vec::new()
    };
    // Buffer dei rami #2..#N (indice = posizione della condizione).
    let mut held: Vec<Vec<Row>> = vec![Vec::new(); plan.conditions.len()];

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Nessuna condizione: tutto a reject (come dice il pannello).
        let mut placed: Option<usize> = None;
        for (ci, cond) in plan.conditions.iter().enumerate() {
            let passes = match evaluate_condition(&row, ci, cond, &opts, &regexes) {
                Ok(v)  => v,
                Err(e) => {
                    // log e la condizione non passa: la riga scivola alle
                    // condizioni successive / reject
                    eprintln!("[filter {}] '{}': {}", ctx.node_id.0, cond.label, e);
                    false
                }
            };
            if passes { placed = Some(ci); break; }
        }

        match placed {
            Some(ci) => {
                let cond = &plan.conditions[ci];
                // Anche se l'uscita non è collegata la riga è "piazzata":
                // il first-match consuma la riga alla prima condizione vera
                *per_cond.entry(cond.id.clone()).or_insert(0) += 1;
                if ordered && ci > 0 {
                    if outputs.contains_key(&cond.id) { held[ci].push(row); }
                } else if let Some(tx) = outputs.get(&cond.id) {
                    if tx.send(row).await.is_ok() { rows_out += 1; }
                }
            }
            None => {
                rows_rejected += 1;
                if let Some(tx) = outputs.get("reject") {
                    let _ = tx.send(row).await;
                }
            }
        }

        if rows_in % PROGRESS_EVERY == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, rows_rejected, rps);
        }
    }

    // ── Modo ordinato: rilascio dei rami trattenuti, uno alla volta ──
    if ordered {
        // Chiude il ramo #1: la sua sotto-pipeline vede la fine dello
        // stream e può concludere.
        drop(outputs.remove(&plan.conditions[0].id));
        for ci in 1..plan.conditions.len() {
            let prev = &plan.conditions[ci - 1];
            let wait = &wait_sets[ci - 1];
            if !wait.is_empty() {
                eprintln!("[filter {}] ordered: waiting for branch '{}' ({} downstream node(s))",
                          ctx.node_id.0, prev.label, wait.len());
                let failed = tokio::select! {
                    f = ctx.lane_done.wait_all(wait) => f,
                    _ = ctx.cancel.cancelled() => {
                        eprintln!("[filter {}] ordered: run cancelled, later branches not emitted",
                                  ctx.node_id.0);
                        break;
                    }
                };
                if !failed.is_empty() {
                    return Err(format!(
                        "filter {}: the downstream of branch '{}' did not complete successfully \
                         ({}); branch '{}' and the following ones were not emitted",
                        ctx.node_id.0, prev.label, failed.join(", "),
                        plan.conditions[ci].label));
                }
            }
            let cond = &plan.conditions[ci];
            let rows = std::mem::take(&mut held[ci]);
            if let Some(tx) = outputs.get(&cond.id) {
                eprintln!("[filter {}] ordered: releasing branch '{}' ({} rows)",
                          ctx.node_id.0, cond.label, rows.len());
                for row in rows {
                    if tx.send(row).await.is_ok() { rows_out += 1; }
                }
            }
            drop(outputs.remove(&cond.id));
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

// ─── Preparazione ─────────────────────────────────────────────────

/// Controlli d'avvio e regex compilate. Un errore qui ferma il nodo
/// prima della prima riga: meglio del "falso silenzioso" riga per riga.
fn prepare(plan: &FilterPlan) -> Result<RegexCache, String> {
    let mut cache = RegexCache::new();
    for (ci, cond) in plan.conditions.iter().enumerate() {
        match cond.mode.as_str() {
            "code" => {
                if cond.expr.is_none() {
                    return Err(format!(
                        "condition '{}' is in code mode but carries no compiled FPEL \
                         expression — run the pipeline again from the studio", cond.label));
                }
            }
            "visual" => {
                for (k, cl) in cond.clauses.iter().enumerate() {
                    if cl.operator == "regex" {
                        cache.insert((ci, k), build_regex(&cl.value, plan.case_sensitive)
                            .map_err(|e| format!("condition '{}': {}", cond.label, e))?);
                    }
                }
            }
            "template" if !KNOWN_TEMPLATES.contains(&cond.template_id.as_str()) => {
                return Err(if cond.template_id.is_empty() {
                    format!("condition '{}': no template selected", cond.label)
                } else {
                    format!("condition '{}': unknown template '{}'", cond.label, cond.template_id)
                });
            }
            "template" if cond.template_id == "str_regex" => {
                let pat = cond.template_params.get("pattern").cloned().unwrap_or_default();
                cache.insert((ci, TEMPLATE_SLOT), build_regex(&pat, plan.case_sensitive)
                    .map_err(|e| format!("condition '{}': {}", cond.label, e))?);
            }
            "template" => {}
            other => return Err(format!("condition '{}': unknown mode '{}'", cond.label, other)),
        }
    }
    Ok(cache)
}

fn build_regex(pattern: &str, case_sensitive: bool) -> Result<Regex, String> {
    RegexBuilder::new(pattern)
        .case_insensitive(!case_sensitive)
        .build()
        .map_err(|e| format!("invalid regex '{}': {}", pattern, e))
}

/// Per ogni ramo k: i nodi a valle di k da aspettare prima di emettere
/// il ramo k+1. Esclusi quelli raggiungibili anche dai rami successivi
/// o da reject: i loro ingressi restano aperti finché il filtro non ha
/// finito, quindi aspettarli sarebbe un deadlock.
fn ordered_wait_sets(ctx: &NodeContext, conds: &[FilterCondition]) -> Vec<HashSet<String>> {
    let me = &ctx.node_id.0;
    let reach: Vec<HashSet<String>> = conds.iter()
        .map(|c| ctx.lane_done.downstream_of(me, &c.id))
        .collect();
    let reject = ctx.lane_done.downstream_of(me, "reject");

    (0..conds.len()).map(|k| {
        let mut later: HashSet<String> = reject.clone();
        for r in &reach[k + 1..] { later.extend(r.iter().cloned()); }
        let shared: Vec<&String> = reach[k].iter().filter(|n| later.contains(*n)).collect();
        if !shared.is_empty() && k + 1 < conds.len() {
            let mut names: Vec<String> = shared.iter().map(|s| s.to_string()).collect();
            names.sort();
            eprintln!("[filter {}] ordered: branch '{}' shares downstream node(s) {} with a later \
                       branch or reject — those cannot be awaited",
                      me, conds[k].label, names.join(", "));
        }
        reach[k].iter().filter(|n| !later.contains(*n)).cloned().collect()
    }).collect()
}

// ─── Valutazione condizioni ───────────────────────────────────────

fn evaluate_condition(
    row: &Row, ci: usize, cond: &FilterCondition, o: &EvalOpts, rx: &RegexCache,
) -> Result<bool, String> {
    match cond.mode.as_str() {
        "visual" => {
            if cond.clauses.is_empty() { return Ok(true); }
            let mut result = eval_visual_clause(row, &cond.clauses[0], o, rx.get(&(ci, 0)))?;
            for i in 1..cond.clauses.len() {
                let curr = eval_visual_clause(row, &cond.clauses[i], o, rx.get(&(ci, i)))?;
                // il connettore logic è sulla clausola PRECEDENTE
                result = if cond.clauses[i - 1].logic == "OR" {
                    result || curr
                } else {
                    result && curr
                };
            }
            Ok(result)
        }
        "template" => eval_template(row, &cond.template_id, &cond.template_params,
                                    o.case_sensitive, rx.get(&(ci, TEMPLATE_SLOT))),
        "code" => match &cond.expr {
            Some(e) => Ok(is_truthy(&eval(e, &EvalContext::single(row, o.variables)))),
            None    => Ok(false),   // impossibile: prepare() lo rifiuta
        },
        _ => Ok(false),
    }
}

fn fold_case(s: &str, case_sensitive: bool) -> String {
    if case_sensitive { s.to_string() } else { s.to_lowercase() }
}

fn eval_visual_clause(
    row: &Row, clause: &VisualClause, o: &EvalOpts, re: Option<&Regex>,
) -> Result<bool, String> {
    let raw = row.get(&clause.field).filter(|v| !matches!(v, Value::Null));

    if raw.is_none() {
        match clause.operator.as_str() {
            "is_null"  => return Ok(true),
            "not_null" => return Ok(false),
            _ => match o.null_behavior {
                "exclude" => return Ok(false),
                "error"   => return Err(format!("Field '{}' is null", clause.field)),
                _         => {} // include: prosegue con stringa vuota
            },
        }
    }

    let cs    = o.case_sensitive;
    let plain = raw.map(|v| v.as_str_repr()).unwrap_or_default();
    let str_v = fold_case(&plain, cs);
    let val   = fold_case(&clause.value, cs);
    let num   = raw.and_then(num_of);
    let num_v = clause.value.trim().parse::<f64>().ok();
    let in_list = || clause.value.split(',').any(|s| fold_case(s.trim(), cs) == str_v);

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
        "in"       => in_list(),
        "not_in"   => !in_list(),
        "regex"    => re.map_or(false, |r| r.is_match(&plain)),
        _          => true,
    })
}

fn cmp(a: Option<f64>, b: Option<f64>, f: impl Fn(f64, f64) -> bool) -> bool {
    match (a, b) {
        (Some(a), Some(b)) => f(a, b),
        _ => false,   // non numerico: il confronto non passa
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

// ─── Template nativi ──────────────────────────────────────────────

fn eval_template(
    row: &Row, template_id: &str, p: &HashMap<String, String>,
    cs: bool, re: Option<&Regex>,
) -> Result<bool, String> {
    let field = |key: &str| -> Option<&Value> {
        p.get(key).and_then(|f| row.get(f)).filter(|v| !matches!(v, Value::Null))
    };
    let fnum  = |key: &str| field(key).and_then(num_of);
    let fstr  = |key: &str| field(key).map(|v| v.as_str_repr()).unwrap_or_default();
    let pnum  = |key: &str| p.get(key).and_then(|s| s.trim().parse::<f64>().ok());
    let pstr  = |key: &str| p.get(key).cloned().unwrap_or_default();
    let f_cs  = |key: &str| fold_case(&fstr(key), cs);
    let p_cs  = |key: &str| fold_case(&pstr(key), cs);

    Ok(match template_id {
        "num_greater"     => matches!((fnum("field"), pnum("threshold")), (Some(a), Some(b)) if a > b),
        "num_less"        => matches!((fnum("field"), pnum("threshold")), (Some(a), Some(b)) if a < b),
        "num_between"     => matches!((fnum("field"), pnum("min"), pnum("max")),
                                (Some(a), Some(lo), Some(hi)) if a >= lo && a <= hi),
        "num_is_zero"     => fnum("field") == Some(0.0),
        "num_is_negative" => matches!(fnum("field"), Some(a) if a < 0.0),

        "str_contains"    => f_cs("field").contains(&p_cs("text")),
        "str_starts"      => f_cs("field").starts_with(&p_cs("prefix")),
        "str_ends"        => f_cs("field").ends_with(&p_cs("suffix")),
        "str_regex"       => re.map_or(false, |r| r.is_match(&fstr("field"))),
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

        "" => return Err("no template selected".to_string()),
        other => return Err(format!("unknown template '{}'", other)),
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

#[cfg(test)]
mod tests {
    use super::*;

    fn row(pairs: &[(&str, Value)]) -> Row {
        let mut r = Row::new();
        for (k, v) in pairs { r.set(k.to_string(), v.clone()); }
        r
    }
    fn plan(json: serde_json::Value) -> FilterPlan { serde_json::from_value(json).unwrap() }
    fn passes(p: &FilterPlan, r: &Row, ci: usize) -> bool {
        let rx = prepare(p).unwrap();
        let vars = HashMap::new();
        let o = EvalOpts { null_behavior: &p.null_behavior, case_sensitive: p.case_sensitive, variables: &vars };
        evaluate_condition(r, ci, &p.conditions[ci], &o, &rx).unwrap()
    }

    #[test]
    fn case_sensitive_governa_visual_e_template() {
        let r = row(&[("name", Value::String("Mario Rossi".into()))]);
        for (cs, atteso) in [(true, false), (false, true)] {
            let p = plan(serde_json::json!({
                "case_sensitive": cs,
                "conditions": [
                    { "id": "a", "mode": "visual", "clauses": [{ "field": "name", "operator": "==", "value": "mario rossi" }] },
                    { "id": "b", "mode": "visual", "clauses": [{ "field": "name", "operator": "regex", "value": "^mario" }] },
                    { "id": "c", "mode": "template", "templateId": "str_starts", "templateParams": { "field": "name", "prefix": "MARIO" } },
                    { "id": "d", "mode": "visual", "clauses": [{ "field": "name", "operator": "in", "value": "x, MARIO ROSSI" }] },
                ]
            }));
            for ci in 0..4 { assert_eq!(passes(&p, &r, ci), atteso, "cs={} cond={}", cs, ci); }
        }
    }

    #[test]
    fn regex_vera_e_pattern_invalido_rifiutato() {
        let r = row(&[("phone", Value::String("+39123".into()))]);
        let p = plan(serde_json::json!({ "conditions": [
            { "id": "a", "mode": "visual", "clauses": [{ "field": "phone", "operator": "regex", "value": "^\\+39\\d+$" }] }
        ]}));
        assert!(passes(&p, &r, 0));
        let bad = plan(serde_json::json!({ "conditions": [
            { "id": "a", "label": "x", "mode": "visual", "clauses": [{ "field": "phone", "operator": "regex", "value": "(" }] }
        ]}));
        assert!(prepare(&bad).unwrap_err().contains("invalid regex"));
    }

    #[test]
    fn code_valuta_l_ir_fpel() {
        // IR prodotto da compileFpel('amount > 100 && lower(country) == "it"')
        let ir: serde_json::Value = serde_json::from_str(r#"{"kind":"BinaryOp","op":"AND","left":{"kind":"BinaryOp","op":"GT","left":{"kind":"DirectFieldRef","field":"amount"},"right":{"kind":"Literal","value":100}},"right":{"kind":"BinaryOp","op":"EQ","left":{"kind":"FunctionCall","name":"lower","args":[{"kind":"DirectFieldRef","field":"country"}]},"right":{"kind":"Literal","value":"it"}}}"#).unwrap();
        let p = plan(serde_json::json!({ "conditions": [{ "id": "a", "mode": "code",
            "code": "amount > 100 && lower(country) == \"it\"", "expr": ir }] }));
        let si = row(&[("amount", Value::Int(150)), ("country", Value::String("IT".into()))]);
        let no = row(&[("amount", Value::Int(50)),  ("country", Value::String("IT".into()))]);
        assert!(passes(&p, &si, 0));
        assert!(!passes(&p, &no, 0));
        // senza IR: rifiutata all'avvio, non "falsa" in silenzio
        let senza = plan(serde_json::json!({ "conditions": [{ "id": "a", "label": "x", "mode": "code", "code": "true" }] }));
        assert!(prepare(&senza).unwrap_err().contains("no compiled FPEL"));
    }
}
