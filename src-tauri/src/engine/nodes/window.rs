// ─── src-tauri/src/engine/nodes/window.rs ──────────────────────────
//
// Funzioni analitiche, stile SQL `OVER (PARTITION BY … ORDER BY …)`.
//
// Ogni riga in ingresso produce UNA riga in uscita: i campi originali più
// N colonne calcolate. Arricchimento 1:1, non aggregazione.
//
// MATERIALIZZA per necessità: `rank` richiede di aver visto tutta la
// partizione, `lead` di guardare avanti, `last_value` di arrivare in fondo.
// Non c'è modo di calcolarle in streaming.
//
// TRE MODI DI PARTIRE:
//
//   1. dataSource=materialize, con arco in ingresso
//      Un buffer_signal a monte gli dice "parti": la riga è il segnale, viene
//      scartata. Poi legge il dataset dalla lane. Il get() verifica comunque
//      che sia pubblicato davvero.
//
//   2. dataSource=materialize, senza archi in ingresso
//      Il nodo è appeso nel canvas, con solo l'uscita collegata. Il get()
//      attende la pubblicazione e lo sblocca. È la sua sincronizzazione.
//
//   3. dataSource=flow
//      Riceve righe da un nodo qualunque, le bufferizza da sé, elabora,
//      emette. Nessun materialize.
//
// L'aggregazione su finestre scorrevoli (sliding/tumbling) era il vecchio
// contenuto di questo file: è un nodo diverso, `window_aggregate`.
// Vedi docs/legacy/TODO-window-aggregate.md.
//
// `streak` valuta un'espressione FPEL compilata dallo studio in ExprNode:
// niente JavaScript (l'executor JS usava `new Function(...)`).

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::expr::{ExprNode, EvalContext, eval, is_truthy};
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct WindowDef {
    /// row_number, rank, lag, moving_avg, …
    #[serde(rename = "fn")]
    func: String,
    /// campo sorgente su cui opera la funzione
    #[serde(default)]
    field: String,
    /// nome della colonna calcolata
    output_field: String,
    /// lag/lead: di quante righe spostarsi (default 1)
    #[serde(default)]
    offset: Option<i64>,
    /// ntile/topn_flag/nth_value/moving_*: dimensione o posizione (default 3)
    /// sessionize: gap massimo in secondi
    #[serde(default)]
    n: Option<i64>,
    /// streak: condizione FPEL, compilata dallo studio
    #[serde(default)]
    expr: Option<ExprNode>,
    /// lag/lead: valore quando la riga richiesta non esiste
    #[serde(default)]
    null_default: Option<serde_json::Value>,
}

#[derive(Deserialize)]
struct WindowConfig {
    #[serde(default)]
    windows: Vec<WindowDef>,
}

/// Config completa: scalari (props via Spec) + windows compilate (spec.config).
struct WindowRun {
    data_source:      String,
    materialize_name: String,
    partition_by:     Vec<String>,
    order_by:         String,
    order_dir:        String,
    windows:          Vec<WindowDef>,
}

/// Legge scalari dalle props (camelCase, verbatim) e le `windows`
/// compilate da spec.config (contengono l'IR di `streak`).
/// Default: docs/node-spec.md §11.
fn config_from_spec(spec: &Spec) -> Result<WindowRun, String> {
    let st: WindowConfig = serde_json::from_value(spec.config().clone())
        .map_err(|e| format!("config strutturata non valida (windows): {}", e))?;

    Ok(WindowRun {
        data_source:      spec.str_or("dataSource",      "flow"),
        materialize_name: spec.str_or("materializeName", ""),
        partition_by:     spec.str_list("partitionBy"),
        order_by:         spec.str_or("orderBy",  ""),
        order_dir:        spec.str_or("orderDir", "asc"),
        windows:          st.windows,
    })
}

// ─── Esecuzione ────────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    // Opzionale: nel caso 2 (materialize senza trigger) il nodo non ha archi
    // in ingresso e si sblocca da solo quando il dataset viene pubblicato.
    rx:  Option<RowReceiver>,
    tx:  RowSender,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("window {}: {}", ctx.node_id.0, e))?;
    let cfg = config_from_spec(&spec)
        .map_err(|e| format!("window {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("window", &ctx.node_id.0);

    if cfg.windows.is_empty() {
        return Err(format!(
            "window {}: nessuna funzione configurata. Apri il tab Mapping \
             e aggiungi almeno una funzione window.", ctx.node_id.0));
    }

    let start = Instant::now();

    // ── Le righe: dal flusso, o da un dataset della lane ────────────
    //
    // `window` materializza comunque: rank, lead e last_value richiedono di
    // aver visto tutta la partizione. Con `data_source = "materialize"` le
    // righe non arrivano dall'input (che è solo un trigger, e viene scartato)
    // ma da un dataset già in memoria: si evita di duplicarlo.
    let all: Vec<Row> = if cfg.data_source == "materialize" {
        // ── Triggerato: legge un dataset già in memoria ─────────────
        //
        // L'input non porta i dati: è il SEGNALE che il dataset è pronto.
        // Con `buffer_signal` il materialize pubblica PRIMA di emettere la
        // riga di stato, quindi quando il trigger arriva il dataset c'è.
        // La riga viene scartata.
        if cfg.materialize_name.is_empty() {
            return Err(format!(
                "window {}: sorgente 'Materialize' senza nome del dataset. \
                 Selezionalo nel pannello.", ctx.node_id.0));
        }

        // Se l'arco c'è (caso 1) la riga è il segnale di partenza: consumala.
        // Se non c'è (caso 2) si passa direttamente al get(), che attende.
        if let Some(mut rx) = rx {
            while rx.recv().await.is_some() {}
        }

        // `get` attende comunque, come rete di sicurezza: se il dataset non
        // è dichiarato, o il materialize è fallito, l'errore arriva subito.
        // Nessuna attesa infinita.
        let ds = ctx.lane_datasets.get(&cfg.materialize_name).await?;
        eprintln!("[window] {}: legge il dataset '{}' ({} righe)",
                  ctx.node_id.0, cfg.materialize_name, ds.len());
        ds.rows().to_vec()

    } else {
        // ── Caso 3: bufferizza da sé le righe del flusso ───────────
        let Some(mut rx) = rx else {
            return Err(format!(
                "window {}: nessun input collegato. Collega un flusso, oppure \
                 scegli un dataset Materialize come sorgente.", ctx.node_id.0));
        };
        let mut v: Vec<Row> = Vec::new();
        while let Some(row) = rx.recv().await { v.push(row) }
        v
    };

    let rows_in = all.len() as u64;

    if rows_in == 0 {
        let stats = NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0,
                                elapsed_ms: start.elapsed().as_millis() as u64, error: None };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    if cfg.data_source != "materialize" {
        eprintln!("[window] {}: materializzate {} righe dal flusso ({} partizioni per {:?})",
                  ctx.node_id.0, rows_in,
                  if cfg.partition_by.is_empty() { "1" } else { "n" },
                  cfg.partition_by);
    }

    // ── Partiziona ─────────────────────────────────────────────────
    // Le partizioni sono emesse nell'ordine di prima apparizione, per
    // determinismo (un HashMap non ha ordine).
    let mut order:  Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Row>> = HashMap::new();

    for row in all {
        let key = if cfg.partition_by.is_empty() {
            String::new()
        } else {
            cfg.partition_by.iter()
                .map(|f| row.get(f).map(|v| v.as_str_repr()).unwrap_or_default())
                .collect::<Vec<_>>()
                .join("\u{1}")   // separatore che non compare nei dati
        };
        if !groups.contains_key(&key) { order.push(key.clone()); }
        groups.entry(key).or_default().push(row);
    }

    // ── Ordina, calcola, emetti ────────────────────────────────────
    let variables = ctx.variables.clone();
    let mut rows_out = 0u64;
    let mut last_prog = Instant::now();

    for key in order {
        let mut part = groups.remove(&key).unwrap();

        if !cfg.order_by.is_empty() {
            sort_rows(&mut part, &cfg.order_by, &cfg.order_dir);
        }

        let computed = compute_windows(&part, &cfg.windows, &variables)?;

        for row in computed {
            if tx.send(row).await.is_err() {
                let stats = NodeStats { rows_in, rows_out, rows_rejected: 0,
                                        elapsed_ms: start.elapsed().as_millis() as u64, error: None };
                ctx.emit_completed(stats.clone());
                return Ok(stats);
            }
            rows_out += 1;
            emit_progress(&ctx, rows_in, rows_out, &start, &mut last_prog);
        }
    }

    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0,
                            elapsed_ms: start.elapsed().as_millis() as u64, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Ordinamento ───────────────────────────────────────────────────
//
// Confronta per tipo: numeri come numeri, il resto come testo.
// (L'executor JS confrontava sempre come stringa: "10" < "9" è vero.)
// I null vanno in fondo, come in SQL con NULLS LAST.

fn sort_rows(rows: &mut [Row], field: &str, dir: &str) {
    let desc = dir.eq_ignore_ascii_case("desc");
    rows.sort_by(|a, b| {
        let va = a.get(field);
        let vb = b.get(field);
        let ord = compare_values(va, vb);
        if desc { ord.reverse() } else { ord }
    });
}

fn compare_values(a: Option<&Value>, b: Option<&Value>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => Ordering::Equal,
        (None, _) | (Some(Value::Null), _) => Ordering::Greater,   // null in fondo
        (_, None) | (_, Some(Value::Null)) => Ordering::Less,
        (Some(x), Some(y)) => {
            match (x.as_f64_lossy(), y.as_f64_lossy()) {
                (Some(nx), Some(ny)) => nx.partial_cmp(&ny).unwrap_or(Ordering::Equal),
                _ => x.as_str_repr().cmp(&y.as_str_repr()),
            }
        }
    }
}

// ─── Le funzioni window ────────────────────────────────────────────

fn compute_windows(
    rows:      &[Row],
    windows:   &[WindowDef],
    variables: &HashMap<String, Value>,
) -> Result<Vec<Row>, String> {
    let n = rows.len();
    let mut out: Vec<Row> = rows.to_vec();

    for w in windows {
        let f     = w.field.as_str();
        let off   = w.offset.unwrap_or(1);
        let win_n = w.n.unwrap_or(3).max(1) as usize;
        let name  = w.output_field.clone();
        let dflt  = w.null_default.clone()
            .map(Value::from_json)
            .unwrap_or(Value::Null);

        match w.func.as_str() {

            // ── Ranking ────────────────────────────────────────────
            "row_number" => for (i, r) in out.iter_mut().enumerate() {
                r.set(name.clone(), Value::Int(i as i64 + 1));
            },

            // Pari merito condividono il rank; il successivo salta.
            "rank" => {
                let mut rank = 1i64;
                for i in 0..n {
                    if i > 0 && !values_eq(rows[i].get(f), rows[i - 1].get(f)) {
                        rank = i as i64 + 1;
                    }
                    out[i].set(name.clone(), Value::Int(rank));
                }
            }

            // Pari merito condividono il rank; il successivo non salta.
            "dense_rank" => {
                let mut rank = 1i64;
                for i in 0..n {
                    if i > 0 && !values_eq(rows[i].get(f), rows[i - 1].get(f)) {
                        rank += 1;
                    }
                    out[i].set(name.clone(), Value::Int(rank));
                }
            }

            "percent_rank" => for (i, r) in out.iter_mut().enumerate() {
                let v = if n <= 1 { 0.0 } else { i as f64 / (n - 1) as f64 };
                r.set(name.clone(), Value::Float(v));
            },

            "cume_dist" => for (i, r) in out.iter_mut().enumerate() {
                r.set(name.clone(), Value::Float((i + 1) as f64 / n as f64));
            },

            "ntile" => for (i, r) in out.iter_mut().enumerate() {
                let bucket = (i * win_n) / n + 1;
                r.set(name.clone(), Value::Int(bucket as i64));
            },

            "topn_flag" => for (i, r) in out.iter_mut().enumerate() {
                r.set(name.clone(), Value::Bool(i < win_n));
            },

            // ── Navigazione ────────────────────────────────────────
            "lag" => for i in 0..n {
                let src = i as i64 - off;
                let v = if src >= 0 {
                    rows[src as usize].get(f).cloned().unwrap_or_else(|| dflt.clone())
                } else { dflt.clone() };
                out[i].set(name.clone(), v);
            },

            "lead" => for i in 0..n {
                let src = i as i64 + off;
                let v = if src >= 0 && (src as usize) < n {
                    rows[src as usize].get(f).cloned().unwrap_or_else(|| dflt.clone())
                } else { dflt.clone() };
                out[i].set(name.clone(), v);
            },

            "first_value" => {
                let v = rows.iter()
                    .find_map(|r| r.get(f).filter(|x| !matches!(x, Value::Null)).cloned())
                    .unwrap_or(Value::Null);
                for r in out.iter_mut() { r.set(name.clone(), v.clone()); }
            }

            "last_value" => {
                let v = rows.iter().rev()
                    .find_map(|r| r.get(f).filter(|x| !matches!(x, Value::Null)).cloned())
                    .unwrap_or(Value::Null);
                for r in out.iter_mut() { r.set(name.clone(), v.clone()); }
            }

            "nth_value" => {
                let v = rows.get(win_n.saturating_sub(1))
                    .and_then(|r| r.get(f).cloned())
                    .unwrap_or(Value::Null);
                for r in out.iter_mut() { r.set(name.clone(), v.clone()); }
            }

            // ── Cumulative ─────────────────────────────────────────
            "cumsum" => {
                let mut acc = 0.0;
                for i in 0..n {
                    if let Some(v) = num(rows[i].get(f)) { acc += v }
                    out[i].set(name.clone(), Value::Float(acc));
                }
            }

            "cumcount" => {
                let mut cnt = 0i64;
                for i in 0..n {
                    if !matches!(rows[i].get(f), None | Some(Value::Null)) { cnt += 1 }
                    out[i].set(name.clone(), Value::Int(cnt));
                }
            }

            "cumprod" => {
                let mut prod = 1.0;
                for i in 0..n {
                    if let Some(v) = num(rows[i].get(f)) { prod *= v }
                    out[i].set(name.clone(), Value::Float(prod));
                }
            }

            // ── Finestre mobili (le ultime win_n righe, inclusa la corrente) ──
            "moving_avg" | "moving_sum" | "moving_min" | "moving_max" | "moving_stddev" => {
                for i in 0..n {
                    let from = i.saturating_sub(win_n - 1);
                    let vals: Vec<f64> = rows[from..=i].iter().filter_map(|r| num(r.get(f))).collect();
                    let v = moving(&w.func, &vals);
                    out[i].set(name.clone(), v);
                }
            }

            // ── Analitiche ─────────────────────────────────────────
            "ratio_to_report" => {
                let total: f64 = rows.iter().filter_map(|r| num(r.get(f))).sum();
                for i in 0..n {
                    let v = if total != 0.0 {
                        num(rows[i].get(f)).map(|x| Value::Float(x / total)).unwrap_or(Value::Null)
                    } else { Value::Null };
                    out[i].set(name.clone(), v);
                }
            }

            "delta" => for i in 0..n {
                let v = if i == 0 { Value::Null } else {
                    match (num(rows[i].get(f)), num(rows[i - 1].get(f))) {
                        (Some(a), Some(b)) => Value::Float(a - b),
                        _ => Value::Null,
                    }
                };
                out[i].set(name.clone(), v);
            },

            // ── ETL ────────────────────────────────────────────────
            "change_detect" => for i in 0..n {
                let changed = i > 0 && !values_eq(rows[i].get(f), rows[i - 1].get(f));
                out[i].set(name.clone(), Value::Bool(changed));
            },

            // Nuova sessione quando il gap dal record precedente supera
            // `n` secondi. Il campo deve contenere una data/ora.
            "sessionize" => {
                let gap = w.n.unwrap_or(1800);   // default 30 minuti
                let mut sid = 1i64;
                for i in 0..n {
                    if i > 0 {
                        let curr = ts(rows[i].get(f));
                        let prev = ts(rows[i - 1].get(f));
                        if let (Some(c), Some(p)) = (curr, prev) {
                            if c - p > gap { sid += 1 }
                        }
                    }
                    out[i].set(name.clone(), Value::String(format!("S{}", sid)));
                }
            }

            // Conta le righe consecutive che soddisfano la condizione.
            // L'espressione è FPEL, compilata dallo studio: niente JS.
            "streak" => {
                let Some(expr) = &w.expr else {
                    return Err(format!("window: la funzione streak richiede una condizione \
                                        (campo 'Condizione streak')"));
                };
                let mut streak = 0i64;
                for i in 0..n {
                    let ectx = EvalContext::single(&rows[i], variables);
                    streak = if is_truthy(&eval(expr, &ectx)) { streak + 1 } else { 0 };
                    out[i].set(name.clone(), Value::Int(streak));
                }
            }

            // Riempie i null interpolando linearmente tra il precedente e
            // il successivo non-null. Ai bordi ripete il valore noto.
            "interpolate" => {
                let vals: Vec<Option<f64>> = rows.iter().map(|r| num(r.get(f))).collect();
                for i in 0..n {
                    if let Some(v) = vals[i] {
                        out[i].set(name.clone(), Value::Float(v));
                        continue;
                    }
                    let prev = (0..i).rev().find(|&j| vals[j].is_some());
                    let next = (i + 1..n).find(|&j| vals[j].is_some());
                    let v = match (prev, next) {
                        (Some(p), Some(q)) => {
                            let (vp, vq) = (vals[p].unwrap(), vals[q].unwrap());
                            let ratio = (i - p) as f64 / (q - p) as f64;
                            Value::Float(vp + ratio * (vq - vp))
                        }
                        (Some(p), None) => Value::Float(vals[p].unwrap()),
                        (None, Some(q)) => Value::Float(vals[q].unwrap()),
                        (None, None)    => Value::Null,
                    };
                    out[i].set(name.clone(), v);
                }
            }

            other => return Err(format!("window: funzione sconosciuta '{}'", other)),
        }
    }

    Ok(out)
}

// ─── Helper ────────────────────────────────────────────────────────

fn num(v: Option<&Value>) -> Option<f64> {
    v.and_then(|x| x.as_f64_lossy())
}

fn values_eq(a: Option<&Value>, b: Option<&Value>) -> bool {
    match (a, b) {
        (None, None) => true,
        (Some(x), Some(y)) => x.as_str_repr() == y.as_str_repr(),
        _ => false,
    }
}

/// Interpreta un valore come istante, in secondi. Per `sessionize`.
fn ts(v: Option<&Value>) -> Option<i64> {
    let s = match v {
        Some(Value::Date(x)) | Some(Value::DateTime(x)) | Some(Value::String(x)) => x,
        Some(Value::Int(i)) => return Some(*i),   // già un epoch
        _ => return None,
    };
    crate::engine::expr_functions::parse_datetime(s)
        .map(|d| d.and_utc().timestamp())
}

fn moving(func: &str, vals: &[f64]) -> Value {
    if vals.is_empty() { return Value::Null }
    match func {
        "moving_sum" => Value::Float(vals.iter().sum()),
        "moving_avg" => Value::Float(vals.iter().sum::<f64>() / vals.len() as f64),
        "moving_min" => Value::Float(vals.iter().cloned().fold(f64::INFINITY, f64::min)),
        "moving_max" => Value::Float(vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max)),
        "moving_stddev" => {
            if vals.len() < 2 { return Value::Null }
            let avg = vals.iter().sum::<f64>() / vals.len() as f64;
            let var = vals.iter().map(|x| (x - avg).powi(2)).sum::<f64>() / (vals.len() - 1) as f64;
            Value::Float(var.sqrt())
        }
        _ => Value::Null,
    }
}

const PROGRESS_EVERY_ROWS: u64 = 1000;
const PROGRESS_EVERY_MS:   u64 = 500;

fn emit_progress(ctx: &NodeContext, rows_in: u64, rows_out: u64, start: &Instant, last: &mut Instant) {
    let due = rows_out % PROGRESS_EVERY_ROWS == 0
        || last.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
    if due {
        let rps = rows_out as f64 / start.elapsed().as_secs_f64().max(0.001);
        ctx.emit_progress(rows_in, rows_out, 0, rps);
        *last = Instant::now();
    }
}