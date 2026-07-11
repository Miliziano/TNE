// src-tauri/src/engine/nodes/transform.rs
// Trasforma campi usando ExprNode — versione semplificata del TMap
// per trasformazioni su un singolo input.
// Config:
//   fields: [{ name: "output_field", expr: ExprNode }, ...]
//   mode: "add"     — aggiunge i campi calcolati (mantiene gli originali)
//         "replace" — sostituisce i campi esistenti con quelli calcolati
//         "select"  — solo i campi calcolati (scarta tutti gli originali)

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::expr::{ExprNode, EvalContext, eval};
use std::collections::HashMap;

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: RowSender,
) -> Result<NodeStats, String> {

    let spec = crate::engine::spec::Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("transform {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("transform", &ctx.node_id.0);

    #[derive(serde::Deserialize)]
    struct FieldExpr { name: String, expr: ExprNode }

    // mode e fields sono materiale elaborato/compilato dal builder
    // (fields contiene l'IR delle espressioni FPEL) → spec.config.
    let mode: String = spec.config().get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("add")
        .to_string();

    let fields: Vec<FieldExpr> = spec.config().get("fields")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let variables = ctx.variables.clone();
    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Costruisci il contesto con la riga corrente
        let mut inputs: HashMap<&str, &Row> = HashMap::new();
        inputs.insert("row", &row);
        let eval_ctx = EvalContext::multi(inputs, &variables);

        // Valuta tutte le espressioni
        let computed: Vec<(&str, Value)> = fields.iter()
            .map(|f| (f.name.as_str(), eval(&f.expr, &eval_ctx)))
            .collect();

        let out_row = match mode.as_str() {
            "select" => {
                // Solo i campi calcolati
                let mut out = Row::new();
                for (name, val) in computed {
                    out.set(name.to_string(), val);
                }
                out
            }
            "replace" => {
                // Tutti i campi originali, poi sovrascrive con i calcolati
                let mut out = row.clone();
                for (name, val) in computed {
                    out.set(name.to_string(), val);
                }
                out
            }
            _ => {
                // "add" — originali + nuovi campi calcolati
                let mut out = row.clone();
                for (name, val) in computed {
                    if !out.has(name) {
                        out.set(name.to_string(), val);
                    }
                }
                out
            }
        };

        if tx.send(out_row).await.is_err() { break; }
        rows_out += 1;

        if rows_in % 1000 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in, rows_out,
        rows_rejected: 0, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}