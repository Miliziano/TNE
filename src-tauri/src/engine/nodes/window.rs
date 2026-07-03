// src-tauri/src/engine/nodes/window.rs
// Calcola aggregazioni su finestre di righe.
// Config:
//   type:         "sliding" | "tumbling" | "session"
//   size:         100        — dimensione finestra (righe per sliding/tumbling)
//   step:         1          — passo (sliding: ogni N righe emette)
//   partition_by: ["campo"]  — partiziona per campo (opzionale)
//   aggregations: [{ name: "avg_importo", field: "importo", func: "avg" }, ...]

use std::time::Instant;
use std::collections::{HashMap, VecDeque};
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// Definizione UNICA di WinAgg, a livello di modulo: la vedono sia
// run() (per deserializzare la config) sia compute_window_row().
// Attenzione a non ridefinirla dentro run(): due struct identiche
// dichiarate in punti diversi sono tipi DISTINTI per il compilatore.
#[derive(serde::Deserialize)]
struct WinAgg {
    name:  String,
    field: String,
    func:  String,
}

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let win_type = ctx.config.get("type")
        .and_then(|v| v.as_str()).unwrap_or("tumbling").to_string();
    let size = ctx.config.get("size")
        .and_then(|v| v.as_u64()).unwrap_or(100) as usize;
    let step = ctx.config.get("step")
        .and_then(|v| v.as_u64()).unwrap_or(1) as usize;
    let partition_by: Vec<String> = ctx.config.get("partition_by")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();
    let aggregations: Vec<WinAgg> = ctx.config.get("aggregations")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    // Finestre per partizione
    let mut windows: HashMap<String, VecDeque<Row>> = HashMap::new();
    let mut step_counter: HashMap<String, usize> = HashMap::new();

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let part_key = if partition_by.is_empty() {
            "__all__".to_string()
        } else {
            partition_by.iter()
                .map(|f| row.get(f).map(|v| v.as_str_repr()).unwrap_or_default())
                .collect::<Vec<_>>().join("|")
        };

        let window = windows.entry(part_key.clone()).or_default();
        window.push_back(row.clone());

        // Tumbling: emette ogni `size` righe e resetta
        if win_type == "tumbling" {
            if window.len() >= size {
                let out = compute_window_row(&row, window, &aggregations);
                if tx.send(out).await.is_err() { break; }
                rows_out += 1;
                window.clear();
            }
        } else {
            // Sliding: mantieni le ultime `size` righe, emetti ogni `step`
            if window.len() > size { window.pop_front(); }
            let cnt = step_counter.entry(part_key).or_insert(0);
            *cnt += 1;
            if *cnt >= step && window.len() == size {
                let out = compute_window_row(&row, window, &aggregations);
                if tx.send(out).await.is_err() { break; }
                rows_out += 1;
                *cnt = 0;
            }
        }

        if rows_in % 1000 == 0 {
            ctx.emit_progress(rows_in, rows_out, 0,
                rows_in as f64 / start.elapsed().as_secs_f64().max(0.001));
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn compute_window_row(
    last_row: &Row,
    window:   &VecDeque<Row>,
    aggs:     &[WinAgg],
) -> Row {
    let mut out = last_row.clone();
    for agg in aggs {
        let vals: Vec<f64> = window.iter()
            .filter_map(|r| r.get(&agg.field))
            .map(|v| match v {
                Value::Int(n)    => *n as f64,
                Value::Float(f)  => *f,
                Value::String(s) => s.parse().unwrap_or(0.0),
                _                => 0.0,
            }).collect();

        let result = match agg.func.as_str() {
            "sum"   => vals.iter().sum(),
            "avg"   => if vals.is_empty() { 0.0 } else { vals.iter().sum::<f64>() / vals.len() as f64 },
            "min"   => vals.iter().cloned().fold(f64::INFINITY, f64::min),
            "max"   => vals.iter().cloned().fold(f64::NEG_INFINITY, f64::max),
            "count" => vals.len() as f64,
            _       => 0.0,
        };
        out.set(agg.name.clone(), Value::Float(result));
    }
    out
}