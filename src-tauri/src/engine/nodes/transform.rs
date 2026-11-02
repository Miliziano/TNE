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
use crate::engine::expr::{ExprNode, EvalContext};
use crate::engine::compiled::Compiled;

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

    // P383: espressioni compilate una volta, non reinterpretate a ogni riga.
    let compiled: Vec<(String, Compiled)> = fields.iter()
        .map(|f| (f.name.clone(), Compiled::new(&f.expr)))
        .collect();

    let mut writer = crate::engine::row::Writer::new(
        compiled.iter().map(|(n, _)| n.clone()).collect());

    let variables = ctx.variables.clone();
    let start    = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Valuta tutte le espressioni sulla riga così com'è arrivata (tutti i
        // campi calcolati vedono la riga ORIGINALE, come prima).
        let computed: Vec<Value> = {
            let eval_ctx = EvalContext::single(&row, &variables);
            compiled.iter().map(|(_, c)| c.eval(&eval_ctx)).collect()
        };

        // P386: lo schema d'uscita si calcola una volta per forma d'ingresso
        // (`Writer`), con la stessa semantica di prima:
        //   select  → solo i campi calcolati (a parità di nome vince l'ultimo)
        //   replace → originali, sovrascritti dai calcolati
        //   add     → originali + calcolati che non c'erano già
        let out_row = match mode.as_str() {
            "select" => {
                let mut out = Row::new();
                writer.write(&mut out, computed, false);
                out
            }
            "replace" => {
                let mut out = row;
                writer.write(&mut out, computed, false);
                out
            }
            _ => {
                let mut out = row;
                writer.write(&mut out, computed, true);
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