// ─── src-tauri/src/engine/nodes/data_quality.rs ────────────────────
//
// Valuta N regole di qualità su ogni riga, tenta di riparare i valori non
// conformi, e calcola un punteggio di fiducia (Data Trust Score).
//
// Il nodo NON filtra: arricchisce ogni riga con un campo `_dq` e la passa.
// Per scartare le righe non valide si mette un `filter` a valle, su
// `_dq.valid` o `_dq.score`.
//
// LO SCORE
//   Ogni regola appartiene a una dimensione: completeness, conformity,
//   consistency, accuracy.
//     score_dimensione = regole_passate / regole_della_dimensione
//     score = Σ(peso_d × score_d) / Σ(peso_d)
//   Le dimensioni SENZA regole sono escluse dal calcolo, e i pesi
//   rinormalizzati: non si misura ciò per cui non si è definita una regola.
//   (Il runner JS le contava come 1.0, alzando lo score. Qui no.)
//
// ESPRESSIONI
//   `custom` e il repair `expression` sono FPEL, compilati dallo studio in
//   ExprNode. Niente JavaScript: il motore non lo esegue, e il codegen deve
//   poterli tradurre.
//
// LOOKUP
//   Solo `lookup_from_materialize` (dataset in memoria). Per un file, si
//   carica con `source_file → materialize("tabella")`: nessun I/O qui.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use crate::engine::types::*;
use crate::engine::expr::{ExprNode, EvalContext, eval, is_truthy};
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config ────────────────────────────────────────────────────────

#[derive(Deserialize, Clone)]
struct Rule {
    id:        String,
    field:     String,
    #[serde(default)] label: String,
    dimension: String,          // completeness | conformity | consistency | accuracy
    #[serde(default = "d_error")] severity: String,   // error | warn
    #[serde(default = "d_true")]  enabled:  bool,

    check_type: String,
    #[serde(default)] pattern:       String,
    #[serde(default)] min:           String,
    #[serde(default)] max:           String,
    #[serde(default)] list:          String,   // CSV
    #[serde(default)] mat_name:      String,   // referential, lookup_from_materialize
    #[serde(default)] ref_field:     String,   // referential: campo del dataset
    #[serde(default)] compare_field: String,
    #[serde(default)] compare_op:    String,
    /// `custom`: espressione FPEL compilata. Vera = la riga passa.
    #[serde(default)] expression:    Option<ExprNode>,

    #[serde(default = "d_none")] repair: String,
    #[serde(default)] repair_default:   String,
    #[serde(default)] repair_field:     String,
    #[serde(default)] repair_fields:    String,   // CSV
    #[serde(default = "d_space")] repair_separator: String,
    /// `expression`: espressione FPEL che produce il valore riparato.
    #[serde(default)] repair_expression: Option<ExprNode>,
}

#[derive(Deserialize)]
struct Weights {
    #[serde(default = "d_030")] completeness: f64,
    #[serde(default = "d_030")] conformity:   f64,
    #[serde(default = "d_020")] consistency:  f64,
    #[serde(default = "d_020")] accuracy:     f64,
}

#[derive(Deserialize)]
struct Thresholds {
    #[serde(default = "d_080")] valid:   f64,
    #[serde(default = "d_060")] warning: f64,
}

#[derive(Deserialize)]
struct DqConfig {
    #[serde(default)] rules: Vec<Rule>,
    #[serde(default = "d_weights")]    weights:    Weights,
    #[serde(default = "d_thresholds")] thresholds: Thresholds,
    #[serde(default = "d_dq")]         output_field: String,
    #[serde(default)] show_original:       bool,
    #[serde(default)] score_before_repair: bool,
}

fn d_error() -> String { "error".into() }
fn d_none()  -> String { "none".into() }
fn d_space() -> String { " ".into() }
fn d_dq()    -> String { "_dq".into() }
fn d_true()  -> bool { true }
fn d_030() -> f64 { 0.30 }
fn d_020() -> f64 { 0.20 }
fn d_080() -> f64 { 0.80 }
fn d_060() -> f64 { 0.60 }
fn d_weights()    -> Weights    { Weights { completeness: 0.30, conformity: 0.30, consistency: 0.20, accuracy: 0.20 } }
fn d_thresholds() -> Thresholds { Thresholds { valid: 0.80, warning: 0.60 } }

const DIMENSIONS: [&str; 4] = ["completeness", "conformity", "consistency", "accuracy"];

// ─── Esito di una regola su una riga ───────────────────────────────

struct Issue {
    rule:      String,
    field:     String,
    dimension: String,
    severity:  String,
    message:   String,
    repaired:  bool,
    action:    String,
    original:  Option<Value>,
    new_value: Option<Value>,
}

// ─── Esecuzione ────────────────────────────────────────────────────

pub async fn run(
    ctx:    NodeContext,
    mut rx: RowReceiver,
    tx:     RowSender,
) -> Result<NodeStats, String> {

    let cfg: DqConfig = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("data_quality {}: config non valida: {}", ctx.node_id.0, e))?;

    let rules: Vec<&Rule> = cfg.rules.iter().filter(|r| r.enabled).collect();

    if rules.is_empty() {
        eprintln!("[data_quality][WARN] {}: nessuna regola attiva — ogni riga passa \
                   con score 1.0", ctx.node_id.0);
    }

    // Dataset di riferimento (referential, lookup_from_materialize).
    // Caricati una volta sola, non per riga.
    let mut datasets: HashMap<String, std::sync::Arc<crate::engine::datasets::Dataset>> = HashMap::new();
    for r in &rules {
        // Serve sia ai check `referential` sia ai repair `lookup_from_materialize`.
        if r.mat_name.is_empty() || datasets.contains_key(&r.mat_name) { continue }
        let ds = ctx.lane_datasets.get(&r.mat_name).await?;
        eprintln!("[data_quality] {}: dataset di riferimento '{}' ({} righe)",
                  ctx.node_id.0, r.mat_name, ds.len());
        datasets.insert(r.mat_name.clone(), ds);
    }

    // Pesi delle sole dimensioni che hanno almeno una regola.
    let active_dims: Vec<&str> = DIMENSIONS.iter().copied()
        .filter(|d| rules.iter().any(|r| r.dimension == *d))
        .collect();

    let start = Instant::now();
    let variables = ctx.variables.clone();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;
    let mut prev_row: Option<Row> = None;   // copy_from_previous

    while let Some(mut row) = rx.recv().await {
        rows_in += 1;

        let original = if cfg.show_original || cfg.score_before_repair {
            Some(row.clone())
        } else { None };

        let mut issues: Vec<Issue> = Vec::new();

        for r in &rules {
            let value = row.get(&r.field).cloned().unwrap_or(Value::Null);
            let ectx  = EvalContext::single(&row, &variables);

            if check(r, &value, &row, &ectx, &datasets) { continue }

            // La regola è fallita: tenta la riparazione.
            let repaired = repair(r, &row, prev_row.as_ref(), &ectx, &datasets);

            match repaired {
                Some(new_val) => {
                    issues.push(Issue {
                        rule:      r.id.clone(),
                        field:     r.field.clone(),
                        dimension: r.dimension.clone(),
                        severity:  r.severity.clone(),
                        message:   message(r),
                        repaired:  true,
                        action:    r.repair.clone(),
                        original:  Some(value),
                        new_value: Some(new_val.clone()),
                    });
                    row.set(r.field.clone(), new_val);
                }
                None => {
                    issues.push(Issue {
                        rule:      r.id.clone(),
                        field:     r.field.clone(),
                        dimension: r.dimension.clone(),
                        severity:  r.severity.clone(),
                        message:   message(r),
                        repaired:  false,
                        action:    "none".to_string(),
                        original:  Some(value),
                        new_value: None,
                    });
                }
            }
        }

        // ── Score ──────────────────────────────────────────────────
        // Post-repair: una regola con repair riuscito conta come passata.
        let (score, dims) = calc_score(&issues, &rules, &cfg.weights, &active_dims, true);

        let score_original = if cfg.score_before_repair {
            let (s, _) = calc_score(&issues, &rules, &cfg.weights, &active_dims, false);
            Some(s)
        } else { None };

        let has_error = issues.iter().any(|i| !i.repaired && i.severity == "error");
        let level = if has_error || score < cfg.thresholds.warning { "error" }
                    else if score < cfg.thresholds.valid           { "warn" }
                    else                                           { "ok" };

        let dq = build_dq_field(score, score_original, &cfg, level, &issues, &dims,
                                original.as_ref(), cfg.show_original);
        row.set(cfg.output_field.clone(), dq);

        prev_row = Some(row.clone());

        if tx.send(row).await.is_err() { break }
        rows_out += 1;

        if rows_in % 1000 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
        }
    }

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── I check ───────────────────────────────────────────────────────

/// `true` = la riga passa la regola.
fn check(
    r:        &Rule,
    value:    &Value,
    row:      &Row,
    ectx:     &EvalContext,
    datasets: &HashMap<String, std::sync::Arc<crate::engine::datasets::Dataset>>,
) -> bool {
    let is_null = matches!(value, Value::Null);
    let s = value.as_str_repr();

    match r.check_type.as_str() {
        // ── Completeness ──
        "not_null"  => !is_null,
        "not_empty" => !is_null && !s.trim().is_empty(),

        // ── Conformity ──
        "pattern" => {
            if is_null { return true }   // il null lo copre not_null
            regex::Regex::new(&r.pattern).map(|re| re.is_match(&s)).unwrap_or(false)
        }
        "is_numeric" => is_null || value.as_f64_lossy().is_some(),
        "is_date"    => is_null || crate::engine::expr_functions::parse_datetime(&s).is_some(),
        "is_email"   => is_null || is_email(&s),
        "is_url"     => is_null || (s.starts_with("http://") || s.starts_with("https://")),
        "min_length" => is_null || r.min.parse::<usize>().map(|n| s.chars().count() >= n).unwrap_or(true),
        "max_length" => is_null || r.max.parse::<usize>().map(|n| s.chars().count() <= n).unwrap_or(true),

        // ── Consistency ──
        "range" => {
            if is_null { return true }
            let Some(n) = value.as_f64_lossy() else { return false };
            let lo_ok = r.min.trim().parse::<f64>().map(|lo| n >= lo).unwrap_or(true);
            let hi_ok = r.max.trim().parse::<f64>().map(|hi| n <= hi).unwrap_or(true);
            lo_ok && hi_ok
        }
        "in_list"     => is_null || csv_list(&r.list).contains(&s),
        "not_in_list" => is_null || !csv_list(&r.list).contains(&s),
        "compare_fields" => {
            let Some(other) = row.get(&r.compare_field) else { return true };
            compare(value, other, &r.compare_op)
        }

        // ── Accuracy ──
        "referential" => {
            if is_null { return true }
            let Some(ds) = datasets.get(&r.mat_name) else { return false };
            // Se il dataset è indicizzato sul campo giusto, O(1).
            if ds.key_field() == Some(r.ref_field.as_str()) {
                !ds.get(&s).is_empty()
            } else {
                ds.rows().iter().any(|x| {
                    x.get(&r.ref_field).map(|v| v.as_str_repr() == s).unwrap_or(false)
                })
            }
        }
        "custom" => match &r.expression {
            Some(e) => is_truthy(&eval(e, ectx)),
            None    => true,   // nessuna espressione: la regola non vincola
        },

        _ => true,   // check sconosciuto: non blocca
    }
}

fn is_email(s: &str) -> bool {
    let Some((user, domain)) = s.split_once('@') else { return false };
    !user.is_empty() && domain.contains('.') && !domain.starts_with('.') && !domain.ends_with('.')
}

fn csv_list(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

fn compare(a: &Value, b: &Value, op: &str) -> bool {
    // Numerico se entrambi lo sono, altrimenti testuale.
    match (a.as_f64_lossy(), b.as_f64_lossy()) {
        (Some(x), Some(y)) => match op {
            ">" => x > y, "<" => x < y, ">=" => x >= y,
            "<=" => x <= y, "==" => x == y, "!=" => x != y,
            _ => true,
        },
        _ => {
            let (x, y) = (a.as_str_repr(), b.as_str_repr());
            match op {
                ">" => x > y, "<" => x < y, ">=" => x >= y,
                "<=" => x <= y, "==" => x == y, "!=" => x != y,
                _ => true,
            }
        }
    }
}

// ─── Le riparazioni ────────────────────────────────────────────────

/// `Some(valore)` se la riparazione è riuscita, `None` altrimenti.
fn repair(
    r:        &Rule,
    row:      &Row,
    prev:     Option<&Row>,
    ectx:     &EvalContext,
    datasets: &HashMap<String, std::sync::Arc<crate::engine::datasets::Dataset>>,
) -> Option<Value> {
    match r.repair.as_str() {
        "none" => None,

        "set_default" => Some(coerce_literal(&r.repair_default)),
        "set_null"    => Some(Value::Null),
        "set_empty_string" => Some(Value::String(String::new())),

        "copy_from_field" => row.get(&r.repair_field).cloned(),

        "concat_fields" => {
            let parts: Vec<String> = csv_list(&r.repair_fields).iter()
                .filter_map(|f| row.get(f))
                .filter(|v| !matches!(v, Value::Null))
                .map(|v| v.as_str_repr())
                .collect();
            if parts.is_empty() { None } else { Some(Value::String(parts.join(&r.repair_separator))) }
        }

        "copy_from_previous" => prev.and_then(|p| p.get(&r.field).cloned()),

        "expression" => r.repair_expression.as_ref().map(|e| eval(e, ectx)),

        // Cerca nel dataset `mat_name` la riga la cui chiave (`repair_field`,
        // o il keyField del dataset) vale quanto il campo `repair_field` di
        // questa riga; ne prende il campo `ref_field`.
        "lookup_from_materialize" => {
            let ds  = datasets.get(&r.mat_name)?;
            let key = row.get(&r.repair_field)?.as_str_repr();

            if ds.key_field() == Some(r.ref_field.as_str()) || ds.key_field().is_some() {
                ds.get_one(&key)?.get(&r.ref_field).cloned()
            } else {
                // Dataset non indicizzato: scansione lineare.
                ds.rows().iter()
                    .find(|x| x.get(&r.repair_field).map(|v| v.as_str_repr() == key).unwrap_or(false))
                    .and_then(|x| x.get(&r.ref_field).cloned())
            }
        }

        // Il lookup da file non è supportato: si carica il CSV con
        // `source_file → materialize("tabella")` e si usa lookup_from_materialize.
        "lookup_from_file" => None,

        _ => None,
    }
}

/// Un valore letterale del pannello (stringa) diventa il Value giusto:
/// "0" → Int(0), non String("0"), che romperebbe le operazioni a valle.
fn coerce_literal(s: &str) -> Value {
    let t = s.trim();
    if t.is_empty() { return Value::String(String::new()) }
    if let Ok(i) = t.parse::<i64>() { return Value::Int(i) }
    if let Ok(f) = t.parse::<f64>() { return Value::Float(f) }
    match t {
        "true"  => Value::Bool(true),
        "false" => Value::Bool(false),
        "null"  => Value::Null,
        _ => Value::String(t.to_string()),
    }
}

fn message(r: &Rule) -> String {
    if !r.label.is_empty() { return r.label.clone() }
    format!("{}: check '{}' fallito", r.field, r.check_type)
}

// ─── Lo score ──────────────────────────────────────────────────────

/// `post_repair`: se true, una regola riparata conta come passata.
fn calc_score(
    issues:      &[Issue],
    rules:       &[&Rule],
    w:           &Weights,
    active_dims: &[&str],
    post_repair: bool,
) -> (f64, HashMap<String, f64>) {
    let mut dims: HashMap<String, f64> = HashMap::new();

    for d in DIMENSIONS {
        let total = rules.iter().filter(|r| r.dimension == d).count();
        if total == 0 { continue }

        let failed = issues.iter()
            .filter(|i| i.dimension == d && (!post_repair || !i.repaired))
            .count();

        dims.insert(d.to_string(), (total - failed) as f64 / total as f64);
    }

    // Solo i pesi delle dimensioni con regole: non si misura ciò per cui
    // non si è definita alcuna regola.
    let weight_of = |d: &str| match d {
        "completeness" => w.completeness,
        "conformity"   => w.conformity,
        "consistency"  => w.consistency,
        _              => w.accuracy,
    };

    let total_w: f64 = active_dims.iter().map(|d| weight_of(d)).sum();
    let score = if total_w > 0.0 {
        active_dims.iter()
            .map(|d| dims.get(*d).copied().unwrap_or(1.0) * weight_of(d))
            .sum::<f64>() / total_w
    } else {
        1.0   // nessuna regola: la riga passa
    };

    ((score * 1000.0).round() / 1000.0, dims)
}

// ─── Il campo `_dq` ────────────────────────────────────────────────

fn build_dq_field(
    score:          f64,
    score_original: Option<f64>,
    cfg:            &DqConfig,
    level:          &str,
    issues:         &[Issue],
    dims:           &HashMap<String, f64>,
    original:       Option<&Row>,
    show_original:  bool,
) -> Value {
    let mut dq = serde_json::Map::new();

    dq.insert("score".into(), serde_json::json!(score));
    if let Some(so) = score_original {
        dq.insert("score_original".into(), serde_json::json!(so));
    }
    dq.insert("valid".into(),    serde_json::json!(score >= cfg.thresholds.valid));
    dq.insert("level".into(),    serde_json::json!(level));
    dq.insert("repaired".into(), serde_json::json!(issues.iter().any(|i| i.repaired)));

    let mut dim_map = serde_json::Map::new();
    for d in DIMENSIONS {
        if let Some(v) = dims.get(d) { dim_map.insert(d.into(), serde_json::json!(v)); }
    }
    dq.insert("dimensions".into(), serde_json::Value::Object(dim_map));

    let issues_json: Vec<serde_json::Value> = issues.iter().map(|i| {
        let mut m = serde_json::Map::new();
        m.insert("rule".into(),      serde_json::json!(i.rule));
        m.insert("field".into(),     serde_json::json!(i.field));
        m.insert("dimension".into(), serde_json::json!(i.dimension));
        m.insert("severity".into(),  serde_json::json!(i.severity));
        m.insert("message".into(),   serde_json::json!(i.message));
        m.insert("repaired".into(),  serde_json::json!(i.repaired));
        if i.repaired {
            m.insert("action".into(), serde_json::json!(i.action));
            if let Some(o) = &i.original  { m.insert("original".into(),  o.to_json()); }
            if let Some(n) = &i.new_value { m.insert("new_value".into(), n.to_json()); }
        }
        serde_json::Value::Object(m)
    }).collect();
    dq.insert("issues".into(), serde_json::Value::Array(issues_json));

    if show_original {
        if let Some(orig) = original {
            dq.insert("original_row".into(), orig.to_json_object());
        }
    }

    Value::Object(serde_json::Value::Object(dq))
}