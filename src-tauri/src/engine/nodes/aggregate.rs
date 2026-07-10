// ─── src-tauri/src/engine/nodes/aggregate.rs ───────────────────────
//
// GROUP BY: collassa le righe. Un gruppo, una riga.
//
// Se vuoi TENERE le righe e aggiungere un totale accanto, non è questo il
// nodo: è `window` con una funzione di partizione. La differenza è la
// stessa di SQL:
//     aggregate:  SELECT cliente, SUM(x) FROM t GROUP BY cliente
//     window:     SELECT *, SUM(x) OVER (PARTITION BY cliente) FROM t
//
// Materializza per necessità: non si sa se arriverà un'altra riga del
// gruppo "Rossi" finché il flusso non finisce.
//
// SORGENTE (dataSource), come `window` e `pivot`:
//   flow        — bufferizza le righe dell'input
//   materialize — l'input è un trigger (scartato); le righe vengono da un
//                 dataset della lane. Senza arco, si sblocca alla pubblicazione.
//
// `having` e il `filter` per aggregazione sono espressioni FPEL, compilate
// dallo studio. Il runner JS traduceva SQL in JavaScript con delle regex e
// poi faceva new Function(): niente di tutto ciò qui.
//
// FINESTRE TEMPORALI (tumbling/sliding/session) NON stanno qui: hanno un
// modello di esecuzione opposto (streaming, emettono a finestra chiusa).
// Vedi docs/legacy/TODO-window-aggregate.md.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use crate::engine::types::*;
use crate::engine::expr::{ExprNode, EvalContext, eval, is_truthy};
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config ────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct AggFunction {
    /// campo su cui opera (ignorato da `count`)
    #[serde(default)] field: String,
    /// sum, avg, count, count_distinct, min, max, first, last,
    /// median, std_dev, variance, string_agg, array_agg, json_agg
    #[serde(rename = "fn")]
    func: String,
    /// nome della colonna in uscita
    alias: String,
    /// FILTER WHERE: espressione FPEL, valutata su ogni riga del gruppo.
    /// Solo le righe che passano contribuiscono a questa aggregazione.
    #[serde(default)] filter: Option<ExprNode>,
    /// separatore per string_agg
    #[serde(default = "d_sep")] separator: String,
}

#[derive(Deserialize)]
struct AggConfig {
    #[serde(default = "d_flow")] data_source: String,
    #[serde(default)] materialize_name: String,

    #[serde(default)] group_by: Vec<String>,
    #[serde(default)] functions: Vec<AggFunction>,

    /// Espressione FPEL sui valori aggregati: `totale > 1000 and n > 5`
    #[serde(default)] having: Option<ExprNode>,

    /// Ordina i gruppi in uscita. Gratis: il nodo materializza comunque.
    #[serde(default)] order_by: String,
    #[serde(default = "d_asc")] order_dir: String,
    /// 0 = nessun limite
    #[serde(default)] limit: usize,

    /// include (default) | exclude — scarta le righe con null nei group_by
    #[serde(default = "d_include")] null_groups: String,
}

fn d_flow()    -> String { "flow".into() }
fn d_asc()     -> String { "asc".into() }
fn d_sep()     -> String { ", ".into() }
fn d_include() -> String { "include".into() }

// ─── Esecuzione ────────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  RowSender,
) -> Result<NodeStats, String> {

    let cfg: AggConfig = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("aggregate {}: config non valida: {}", ctx.node_id.0, e))?;

    if cfg.functions.is_empty() {
        return Err(format!(
            "aggregate {}: nessuna funzione di aggregazione. Apri il tab Mapping \
             e aggiungine almeno una.", ctx.node_id.0));
    }

    let start = Instant::now();

    // ── Le righe ───────────────────────────────────────────────────
    let rows: Vec<Row> = if cfg.data_source == "materialize" {
        if cfg.materialize_name.is_empty() {
            return Err(format!("aggregate {}: sorgente 'Materialize' senza nome del \
                                dataset. Selezionalo nel pannello.", ctx.node_id.0));
        }
        if let Some(mut rx) = rx { while rx.recv().await.is_some() {} }   // trigger
        let ds = ctx.lane_datasets.get(&cfg.materialize_name).await?;
        eprintln!("[aggregate] {}: legge il dataset '{}' ({} righe)",
                  ctx.node_id.0, cfg.materialize_name, ds.len());
        ds.rows().to_vec()
    } else {
        let Some(mut rx) = rx else {
            return Err(format!("aggregate {}: nessun input collegato. Collega un flusso, \
                                oppure scegli un dataset Materialize.", ctx.node_id.0));
        };
        let mut v = Vec::new();
        while let Some(row) = rx.recv().await { v.push(row) }
        v
    };

    let rows_in = rows.len() as u64;
    let variables = ctx.variables.clone();

    // ── Raggruppa ──────────────────────────────────────────────────
    // Ordine di prima apparizione: un HashMap non ne ha, e l'output deve
    // essere deterministico.
    let mut order:  Vec<String> = Vec::new();
    let mut groups: HashMap<String, Vec<Row>> = HashMap::new();

    let exclude_null = cfg.null_groups == "exclude";

    for row in rows {
        if exclude_null && cfg.group_by.iter()
            .any(|f| matches!(row.get(f), None | Some(Value::Null)))
        { continue }

        let key = if cfg.group_by.is_empty() {
            "\u{1}all".to_string()      // nessun GROUP BY: un solo gruppo
        } else {
            cfg.group_by.iter()
                .map(|f| match row.get(f) {
                    None | Some(Value::Null) => "\u{1}null".to_string(),
                    Some(v) => v.as_str_repr(),
                })
                .collect::<Vec<_>>()
                .join("\u{0}")
        };

        if !groups.contains_key(&key) { order.push(key.clone()) }
        groups.entry(key).or_default().push(row);
    }

    // ── Aggrega ────────────────────────────────────────────────────
    let mut result: Vec<Row> = Vec::with_capacity(order.len());

    for key in &order {
        let group = &groups[key];
        let first = &group[0];

        let mut out = Row::new();
        for f in &cfg.group_by {
            out.set(f.clone(), first.get(f).cloned().unwrap_or(Value::Null));
        }

        for agg in &cfg.functions {
            // FILTER WHERE: solo le righe che passano contribuiscono.
            let rows_for_agg: Vec<&Row> = match &agg.filter {
                None => group.iter().collect(),
                Some(f) => group.iter()
                    .filter(|r| is_truthy(&eval(f, &EvalContext::single(r, &variables))))
                    .collect(),
            };

            let values: Vec<&Value> = if agg.func == "count" && agg.field.is_empty() {
                // count(*) — conta le righe, non i valori
                Vec::new()
            } else {
                rows_for_agg.iter().filter_map(|r| r.get(&agg.field)).collect()
            };

            let v = if agg.func == "count" && agg.field.is_empty() {
                Value::Int(rows_for_agg.len() as i64)
            } else {
                aggregate(&values, &agg.func, &agg.separator)
            };

            out.set(agg.alias.clone(), v);
        }

        // HAVING: filtra i gruppi in base ai valori aggregati.
        if let Some(h) = &cfg.having {
            if !is_truthy(&eval(h, &EvalContext::single(&out, &variables))) { continue }
        }

        result.push(out);
    }

    // ── Ordina e limita ────────────────────────────────────────────
    if !cfg.order_by.is_empty() {
        let desc = cfg.order_dir.eq_ignore_ascii_case("desc");
        result.sort_by(|a, b| {
            let ord = compare_values(a.get(&cfg.order_by), b.get(&cfg.order_by));
            if desc { ord.reverse() } else { ord }
        });
    }
    if cfg.limit > 0 { result.truncate(cfg.limit) }

    eprintln!("[aggregate] {}: {} righe → {} gruppi", ctx.node_id.0, rows_in, result.len());

    let mut rows_out = 0u64;
    for row in result {
        if tx.send(row).await.is_err() { break }
        rows_out += 1;
    }

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Le funzioni di aggregazione ───────────────────────────────────

fn aggregate(values: &[&Value], func: &str, separator: &str) -> Value {
    let non_null: Vec<&&Value> = values.iter().filter(|v| !matches!(v, Value::Null)).collect();
    let nums: Vec<f64> = non_null.iter().filter_map(|v| v.as_f64_lossy()).collect();

    match func {
        "count"          => Value::Int(non_null.len() as i64),
        "count_distinct" => {
            let mut seen = std::collections::HashSet::new();
            for v in &non_null { seen.insert(v.as_str_repr()); }
            Value::Int(seen.len() as i64)
        }

        "first" => non_null.first().map(|v| (**v).clone()).unwrap_or(Value::Null),
        "last"  => non_null.last().map(|v| (**v).clone()).unwrap_or(Value::Null),

        "sum" => if nums.is_empty() { Value::Null } else { Value::Float(nums.iter().sum()) },
        "avg" => if nums.is_empty() { Value::Null }
                 else { Value::Float(nums.iter().sum::<f64>() / nums.len() as f64) },
        "min" => nums.iter().cloned().reduce(f64::min).map(Value::Float).unwrap_or(Value::Null),
        "max" => nums.iter().cloned().reduce(f64::max).map(Value::Float).unwrap_or(Value::Null),

        "median" => {
            if nums.is_empty() { return Value::Null }
            let mut s = nums.clone();
            s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
            let mid = s.len() / 2;
            Value::Float(if s.len() % 2 == 0 { (s[mid - 1] + s[mid]) / 2.0 } else { s[mid] })
        }

        // Deviazione standard e varianza CAMPIONARIE (divisore n-1), come
        // in SQL: STDDEV_SAMP / VAR_SAMP. Con un solo valore → null.
        "std_dev" | "variance" => {
            if nums.len() < 2 { return Value::Null }
            let avg = nums.iter().sum::<f64>() / nums.len() as f64;
            let var = nums.iter().map(|x| (x - avg).powi(2)).sum::<f64>() / (nums.len() - 1) as f64;
            Value::Float(if func == "std_dev" { var.sqrt() } else { var })
        }

        "string_agg" => Value::String(
            non_null.iter().map(|v| v.as_str_repr()).collect::<Vec<_>>().join(separator)
        ),
        "array_agg" | "json_agg" => Value::from_json(
            serde_json::Value::Array(non_null.iter().map(|v| v.to_json()).collect())
        ),

        _ => Value::Null,
    }
}

// ─── Ordinamento ───────────────────────────────────────────────────
// Numeri come numeri, il resto come testo. I null in fondo (NULLS LAST).

fn compare_values(a: Option<&Value>, b: Option<&Value>) -> std::cmp::Ordering {
    use std::cmp::Ordering;
    match (a, b) {
        (None, None) | (Some(Value::Null), Some(Value::Null)) => Ordering::Equal,
        (None, _) | (Some(Value::Null), _) => Ordering::Greater,
        (_, None) | (_, Some(Value::Null)) => Ordering::Less,
        (Some(x), Some(y)) => match (x.as_f64_lossy(), y.as_f64_lossy()) {
            (Some(nx), Some(ny)) => nx.partial_cmp(&ny).unwrap_or(Ordering::Equal),
            _ => x.as_str_repr().cmp(&y.as_str_repr()),
        },
    }
}