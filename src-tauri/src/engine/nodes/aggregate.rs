// src-tauri/src/engine/nodes/aggregate.rs
// GROUP BY con funzioni di aggregazione.
// Config:
//   group_by: ["campo1", "campo2"]
//   aggregations: [{ name: "totale", field: "importo", func: "sum" }, ...]
//   funzioni: sum, count, avg, min, max, first, last, count_distinct

use std::time::Instant;
use std::collections::HashMap;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    #[derive(serde::Deserialize)]
    struct Aggregation {
        name:  String,
        field: String,
        func:  String,
    }

    let group_by: Vec<String> = ctx.config.get("group_by")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let aggregations: Vec<Aggregation> = ctx.config.get("aggregations")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let start = Instant::now();
    let mut rows_in = 0u64;

    // Stato di aggregazione per gruppo
    // key = valori dei campi group_by concatenati
    struct GroupState {
        key_row:       Row,                         // valori dei campi group_by
        sums:          HashMap<String, f64>,
        counts:        HashMap<String, u64>,
        count_distinct: HashMap<String, std::collections::HashSet<String>>,
        mins:          HashMap<String, Value>,
        maxs:          HashMap<String, Value>,
        firsts:        HashMap<String, Value>,
        lasts:         HashMap<String, Value>,
    }

    let mut groups: HashMap<String, GroupState> = HashMap::new();

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Costruisce la chiave del gruppo
        let key_parts: Vec<String> = group_by.iter()
            .map(|f| row.get(f).map(|v| v.as_str_repr()).unwrap_or_default())
            .collect();
        let key = key_parts.join("|");

        let state = groups.entry(key).or_insert_with(|| {
            let mut key_row = Row::new();
            for f in &group_by {
                if let Some(v) = row.get(f) {
                    key_row.set(f.clone(), v.clone());
                }
            }
            GroupState {
                key_row,
                sums:           HashMap::new(),
                counts:         HashMap::new(),
                count_distinct: HashMap::new(),
                mins:           HashMap::new(),
                maxs:           HashMap::new(),
                firsts:         HashMap::new(),
                lasts:          HashMap::new(),
            }
        });

        for agg in &aggregations {
            let val = row.get(&agg.field).cloned().unwrap_or(Value::Null);
            match agg.func.as_str() {
                "sum" => {
                    let n = to_f64(&val);
                    *state.sums.entry(agg.name.clone()).or_insert(0.0) += n;
                }
                "count" => {
                    *state.counts.entry(agg.name.clone()).or_insert(0) += 1;
                }
                "count_distinct" => {
                    state.count_distinct
                        .entry(agg.name.clone())
                        .or_default()
                        .insert(val.as_str_repr());
                }
                "avg" => {
                    *state.sums.entry(format!("{}_sum", agg.name)).or_insert(0.0) += to_f64(&val);
                    *state.counts.entry(format!("{}_cnt", agg.name)).or_insert(0) += 1;
                }
                "min" => {
                    let entry = state.mins.entry(agg.name.clone()).or_insert(val.clone());
                    if compare_values(&val, entry) == std::cmp::Ordering::Less {
                        *entry = val;
                    }
                }
                "max" => {
                    let entry = state.maxs.entry(agg.name.clone()).or_insert(val.clone());
                    if compare_values(&val, entry) == std::cmp::Ordering::Greater {
                        *entry = val;
                    }
                }
                "first" => {
                    state.firsts.entry(agg.name.clone()).or_insert(val);
                }
                "last" => {
                    state.lasts.insert(agg.name.clone(), val);
                }
                _ => {}
            }
        }

        if rows_in % 1000 == 0 {
            ctx.emit_progress(rows_in, 0, 0,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    // Emette le righe aggregate
    let mut rows_out = 0u64;
    for (_, state) in groups {
        let mut out = state.key_row.clone();
        for agg in &aggregations {
            let val = match agg.func.as_str() {
                "sum"  => Value::Float(*state.sums.get(&agg.name).unwrap_or(&0.0)),
                "count" => Value::Int(*state.counts.get(&agg.name).unwrap_or(&0) as i64),
                "count_distinct" => Value::Int(
                    state.count_distinct.get(&agg.name).map(|s| s.len()).unwrap_or(0) as i64
                ),
                "avg" => {
                    let sum = state.sums.get(&format!("{}_sum", agg.name)).copied().unwrap_or(0.0);
                    let cnt = state.counts.get(&format!("{}_cnt", agg.name)).copied().unwrap_or(0);
                    if cnt > 0 { Value::Float(sum / cnt as f64) } else { Value::Null }
                }
                "min"   => state.mins.get(&agg.name).cloned().unwrap_or(Value::Null),
                "max"   => state.maxs.get(&agg.name).cloned().unwrap_or(Value::Null),
                "first" => state.firsts.get(&agg.name).cloned().unwrap_or(Value::Null),
                "last"  => state.lasts.get(&agg.name).cloned().unwrap_or(Value::Null),
                _ => Value::Null,
            };
            out.set(agg.name.clone(), val);
        }
        if tx.send(out).await.is_err() { break; }
        rows_out += 1;
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in, rows_out,
        rows_rejected: 0, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn to_f64(v: &Value) -> f64 {
    match v {
        Value::Int(n)   => *n as f64,
        Value::Float(f) => *f,
        Value::String(s)   => s.parse().unwrap_or(0.0),
        _               => 0.0,
    }
}

fn compare_values(a: &Value, b: &Value) -> std::cmp::Ordering {
    match (a, b) {
        (Value::Int(a),   Value::Int(b))   => a.cmp(b),
        (Value::Float(a), Value::Float(b)) => a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal),
        (Value::String(a),   Value::String(b))   => a.cmp(b),
        (Value::Null,     Value::Null)     => std::cmp::Ordering::Equal,
        (Value::Null,     _)               => std::cmp::Ordering::Less,
        (_,               Value::Null)     => std::cmp::Ordering::Greater,
        _                                  => std::cmp::Ordering::Equal,
    }
}
