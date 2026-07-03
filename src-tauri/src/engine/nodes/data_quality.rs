// src-tauri/src/engine/nodes/data_quality.rs
// Valida le righe contro un insieme di regole.
// Le righe valide vanno al tx principale, le righe non valide al tx_rejected.
// Config:
//   rules: [{ name: "nome", expr: ExprNode, severity: "error"|"warn" }, ...]
//   mode: "filter"  — scarta le righe non valide (vanno a tx_rejected)
//         "tag"     — aggiunge campo "_dq_errors" con lista errori, passa tutto
//         "fail"    — se una riga non valida, fallisce il nodo

use std::time::Instant;
use std::collections::HashMap;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::expr::{ExprNode, EvalContext, eval, is_truthy};

pub async fn run(
    ctx:         NodeContext,
    mut rx:      RowReceiver,
    tx:          RowSender,
    tx_rejected: Option<RowSender>,
) -> Result<NodeStats, String> {

    #[derive(serde::Deserialize)]
    struct Rule {
        name:     String,
        expr:     ExprNode,
        #[serde(default = "default_severity")]
        severity: String,
    }
    fn default_severity() -> String { "error".to_string() }

    let mode: String = ctx.config.get("mode")
        .and_then(|v| v.as_str())
        .unwrap_or("filter")
        .to_string();

    let rules: Vec<Rule> = ctx.config.get("rules")
        .and_then(|v| serde_json::from_value(v.clone()).ok())
        .unwrap_or_default();

    let variables = ctx.variables.clone();
    let start     = Instant::now();
    let mut rows_in       = 0u64;
    let mut rows_out      = 0u64;
    let mut rows_rejected = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Valuta tutte le regole
        let mut inputs: HashMap<&str, &Row> = HashMap::new();
        inputs.insert("row", &row);
        let eval_ctx = EvalContext::multi(inputs, &variables);

        let mut errors: Vec<String> = Vec::new();
        for rule in &rules {
            let result = eval(&rule.expr, &eval_ctx);
            if !is_truthy(&result) {
                errors.push(rule.name.clone());
            }
        }

        if errors.is_empty() {
            // Riga valida
            if tx.send(row).await.is_err() { break; }
            rows_out += 1;
        } else {
            match mode.as_str() {
                "fail" => {
                    return Err(format!(
                        "Data quality fallita alla riga {}: {:?}", rows_in, errors
                    ));
                }
                "tag" => {
                    // Aggiunge campo _dq_errors e passa la riga
                    let mut tagged = row.clone();
                    tagged.set("_dq_errors".to_string(),
                        Value::String(errors.join(", ")));
                    if tx.send(tagged).await.is_err() { break; }
                    rows_out += 1;
                }
                _ => {
                    // "filter" — manda a tx_rejected
                    rows_rejected += 1;
                    if let Some(ref rej) = tx_rejected {
                        let mut tagged = row.clone();
                        tagged.set("_dq_errors".to_string(),
                            Value::String(errors.join(", ")));
                        let _ = rej.send(tagged).await;
                    }
                }
            }
        }

        if rows_in % 1000 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, rows_rejected, rps);
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in, rows_out, rows_rejected, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
