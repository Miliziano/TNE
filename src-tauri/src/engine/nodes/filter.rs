// ─── src-tauri/src/engine/nodes/filter.rs ──────────────────────────
//
// Riceve righe, applica una condizione, passa avanti solo quelle
// che la soddisfano. Versione minimale con condizioni semplici —
// l'interprete completo arriva in Fase 6.
//
// Condizioni supportate in questa fase:
//   { "op": "eq",  "field": "citta",   "value": "Milano" }
//   { "op": "ne",  "field": "citta",   "value": "Roma"   }
//   { "op": "gt",  "field": "importo", "value": "100"    }
//   { "op": "lt",  "field": "importo", "value": "500"    }
//   { "op": "gte", "field": "eta",     "value": "18"     }
//   { "op": "lte", "field": "eta",     "value": "65"     }
//   { "op": "contains", "field": "nome", "value": "Mario" }
//   { "op": "not_null", "field": "email" }
//   { "op": "and", "conditions": [...] }
//   { "op": "or",  "conditions": [...] }

// ─── src-tauri/src/engine/nodes/filter.rs (versione Fase 6) ────────
//
// Aggiornato per usare l'interprete ExprNode invece delle condizioni
// hard-coded della Fase 3. Ora supporta qualsiasi espressione booleana
// costruibile nell'editor FlowPilot.
//
// La config del nodo può avere:
//   { "expr": <ExprNode JSON> }          ← nuovo, interprete completo
//   { "condition": <FilterCondition> }   ← vecchio, mantenuto per compatibilità

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::expr::{ExprNode, EvalContext, eval, is_truthy};

// Config del nodo filter — supporta sia il vecchio formato (Fase 3)
// che il nuovo formato con ExprNode (Fase 6)
#[derive(serde::Deserialize)]
struct FilterConfig {
    // Nuovo: espressione generica
    expr: Option<ExprNode>,
    // Vecchio: condizione semplice (mantenuta per retrocompatibilità)
    condition: Option<serde_json::Value>,
}

const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx:    NodeContext,
    mut rx: RowReceiver,
    tx:     RowSender,
) -> Result<NodeStats, String> {

//eprintln!("[filter] config raw JSON: {}", ctx.config);

let config: FilterConfig = match serde_json::from_value(ctx.config.clone()) {
    Ok(c)  => c,
    Err(e) => {
        eprintln!("[filter] ERRORE deserializzazione: {}", e);
        return Err(format!("filter config non valida: {}", e));
    }
};
//eprintln!("[filter] config caricata, expr presente: {}", config.expr.is_some());


    let (mut rows_in, mut rows_out, mut rows_rejected) = (0u64, 0u64, 0u64);
    let start         = Instant::now();
    let mut last_prog = Instant::now();

    let empty_vars = std::collections::HashMap::new();

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let pass = if let Some(expr) = &config.expr {
            // Nuovo path: interprete ExprNode completo
            let eval_ctx = EvalContext::single(&row, &empty_vars);
            is_truthy(&eval(&expr, &eval_ctx))
        } else if let Some(cond_json) = &config.condition {
            // Vecchio path: condizione semplice (deserializza e valuta)
            eval_simple_condition(cond_json, &row)
        } else {
            // Nessuna condizione = passa tutto
            true
        };

        if pass {
            rows_out += 1;
            if tx.send(row).await.is_err() { break; }
        } else {
            rows_rejected += 1;
        }

        let emit = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if emit {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, rows_rejected, rps);
            last_prog = Instant::now();
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Valutatore condizioni semplici (vecchio formato) ─────────────
// Mantenuto per retrocompatibilità con il formato { op, field, value }

fn eval_simple_condition(cond: &serde_json::Value, row: &Row) -> bool {
    let op    = cond.get("op").and_then(|v| v.as_str()).unwrap_or("");
    let field = cond.get("field").and_then(|v| v.as_str()).unwrap_or("");
    let value = cond.get("value").and_then(|v| v.as_str()).unwrap_or("");

    match op {
        "eq"       => row.get(field).map(|v| v.as_str_repr() == value).unwrap_or(false),
        "ne"       => row.get(field).map(|v| v.as_str_repr() != value).unwrap_or(true),
        "not_null" => row.get(field).map(|v| !matches!(v, Value::Null)).unwrap_or(false),
        "is_null"  => row.get(field).map(|v| matches!(v, Value::Null)).unwrap_or(true),
        "contains" => row.get(field).map(|v| v.as_str_repr().contains(value)).unwrap_or(false),
        "gt" | "lt" | "gte" | "lte" => {
            let row_val = row.get(field).map(|v| v.as_str_repr()).unwrap_or_default();
            match (row_val.parse::<f64>(), value.parse::<f64>()) {
                (Ok(a), Ok(b)) => match op {
                    "gt" => a > b, "lt" => a < b, "gte" => a >= b, _ => a <= b,
                },
                _ => match op {
                    "gt" => row_val > value.to_string(), "lt" => row_val < value.to_string(),
                    "gte" => row_val >= value.to_string(), _ => row_val <= value.to_string(),
                }
            }
        }
        "and" => {
            cond.get("conditions")
                .and_then(|c| c.as_array())
                .map(|arr| arr.iter().all(|c| eval_simple_condition(c, row)))
                .unwrap_or(true)
        }
        "or" => {
            cond.get("conditions")
                .and_then(|c| c.as_array())
                .map(|arr| arr.iter().any(|c| eval_simple_condition(c, row)))
                .unwrap_or(false)
        }
        _ => true,
    }
}