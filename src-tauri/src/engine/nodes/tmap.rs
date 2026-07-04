// ─── src-tauri/src/engine/nodes/tmap.rs (v3) ───────────────────────
//
// Nodo TMap — il nodo più complesso dell'Engine.
//
// ALGORITMO:
//   Fase 1 — Pre-materializzazione lookup
//     Per ogni lookup (in ordine): legge tutte le righe dal canale,
//     costruisce HashMap<chiave, Vec<Row>> valutando src/dst key expr.
//     Ogni lookup ha il SUO indice separato. Il main NON viene mai
//     materializzato.
//
//   Fase 2 — Elaborazione main stream (ROW BY ROW)
//     Per ogni riga del main, ESPANSIONE COMBINATORIA dei lookup
//     (semantica Talend "all matches"):
//       - parte da una combinazione vuota
//       - per ogni lookup, per ogni combinazione corrente:
//           · calcola la chiave (può referenziare main E lookup già
//             risolti nella combinazione — join a catena)
//           · JoinType::First  → aggiunge SOLO la prima corrispondenza
//           · Inner/Left       → una combinazione per OGNI corrispondenza
//             (uno-a-molti: la riga main si moltiplica)
//           · nessuna corrispondenza: Inner → la combinazione muore;
//             Left/First → continua senza quel lookup (campi null)
//       - se NESSUNA combinazione sopravvive → riga rejected
//       - per ogni combinazione sopravvissuta: transforms, routing
//         MULTI-MATCH verso gli output (filtro indipendente per
//         output; nessun filtro = tutte le righe)
//
//   Es. dvdrental: film(main) ⋈ film_actor(inner, per film_id) ⋈
//   actor(inner, per actor_id) → un film con 4 attori produce 4
//   righe in uscita; il JSON Serializer a valle le riaggrega con
//   groupBy. Per il vecchio comportamento uno-a-uno usare
//   join type 'first' sul lookup.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::expr::{ExprNode, EvalContext, eval, is_truthy};

// ─── Strutture del Plan ───────────────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct TMapPlan {
    pub main_input_id:  String,
    pub lookups:        Vec<TMapLookupPlan>,
    pub outputs:        Vec<TMapOutputPlan>,
    pub transforms:     Vec<TMapTransformPlan>,
    pub lane_variables: Vec<String>,
}

#[derive(Debug, Deserialize)]
pub struct TMapLookupPlan {
    pub input_id:   String,
    pub label:      String,
    pub join_type:  JoinType,
    pub join_pairs: Vec<TMapJoinPairPlan>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum JoinType {
    Inner,
    Left,
    First,
}

#[derive(Debug, Deserialize)]
pub struct TMapJoinPairPlan {
    pub src_key_expr: ExprNode,
    pub dst_field:    String,
    pub dst_key_expr: Option<ExprNode>,
}

#[derive(Debug, Deserialize)]
pub struct TMapOutputPlan {
    pub output_id:   String,
    pub label:       String,
    pub filter_expr: Option<ExprNode>,
    pub fields:      Vec<TMapOutputFieldPlan>,
}

#[derive(Debug, Deserialize)]
pub struct TMapOutputFieldPlan {
    pub name:    String,
    #[serde(rename = "type")]
    pub r#type:  String,
    pub expr:    ExprNode,
}

#[derive(Debug, Deserialize)]
pub struct TMapTransformPlan {
    pub id:          String,
    pub output_name: String,
    pub output_type: String,
    pub expr:        ExprNode,
}

// ─── Lookup materializzato ────────────────────────────────────────

struct MaterializedLookup {
    plan:  TMapLookupPlan,
    index: HashMap<String, Vec<Row>>,
}

// ─── Entry point ──────────────────────────────────────────────────

pub async fn run(
    ctx:          NodeContext,
    mut main_rx:  RowReceiver,
    lookup_rxs:   Vec<RowReceiver>,
    output_txs:   Vec<RowSender>,
) -> Result<NodeStats, String> {

    let plan: TMapPlan = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("tmap config non valida: {}", e))?;

    let start     = Instant::now();
    let variables = ctx.variables.clone();

    // ── Fase 1: Pre-materializzazione lookup ──────────────────────
    let mut materialized: Vec<MaterializedLookup> = Vec::new();

    for (lookup_plan, mut rx) in plan.lookups.into_iter().zip(lookup_rxs.into_iter()) {
        let mut index: HashMap<String, Vec<Row>> = HashMap::new();
        let mut count = 0u64;

        while let Some(lkp_row) = rx.recv().await {
            count += 1;
            let key = compute_lookup_key(&lkp_row, &lookup_plan.join_pairs, &variables)?;
            index.entry(key).or_default().push(lkp_row);
        }

        eprintln!("[tmap] lookup '{}' materializzato: {} righe, {} chiavi",
            lookup_plan.label, count, index.len());

        materialized.push(MaterializedLookup { plan: lookup_plan, index });
    }

    // ── Fase 2: Elaborazione main stream ─────────────────────────
    let mut rows_in:       u64 = 0;
    let mut rows_out:      u64 = 0;   // totale righe emesse (somma su tutti gli output)
    let mut rows_rejected: u64 = 0;   // righe main senza combinazioni valide
    // Fase 8: conteggi per handle di uscita (output_id → righe)
    let mut per_out: HashMap<String, u64> = HashMap::new();

    // Variabili di lane mutabili
    let mut lane_vars: HashMap<String, Value> = variables
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    while let Some(main_row) = main_rx.recv().await {
        rows_in += 1;

        // ── Espansione combinatoria dei lookup ────────────────────
        // Ogni combinazione mappa input_id E label → riga lookup.
        // Un lookup uno-a-molti (Inner/Left) moltiplica le
        // combinazioni; First ne prende una sola.
        let mut combos: Vec<HashMap<String, Row>> = vec![HashMap::new()];

        for lkp in &materialized {
            if lkp.plan.join_pairs.is_empty() { continue; }

            let mut next: Vec<HashMap<String, Row>> = Vec::new();

            for combo in &combos {
                let src_key = compute_src_key(lkp, &main_row, combo, &variables);

                match lkp.index.get(&src_key).filter(|r| !r.is_empty()) {
                    Some(rows) => {
                        match lkp.plan.join_type {
                            JoinType::First => {
                                // Solo la prima corrispondenza (uno-a-uno esplicito)
                                let mut c = combo.clone();
                                let r = rows.first().unwrap().clone();
                                c.insert(lkp.plan.input_id.clone(), r.clone());
                                c.insert(lkp.plan.label.clone(),    r);
                                next.push(c);
                            }
                            JoinType::Inner | JoinType::Left => {
                                // TUTTE le corrispondenze: una combinazione per riga
                                for r in rows {
                                    let mut c = combo.clone();
                                    c.insert(lkp.plan.input_id.clone(), r.clone());
                                    c.insert(lkp.plan.label.clone(),    r.clone());
                                    next.push(c);
                                }
                            }
                        }
                    }
                    None => {
                        match lkp.plan.join_type {
                            // Inner senza match: la combinazione muore
                            JoinType::Inner => {}
                            // Left/First senza match: continua senza il lookup
                            JoinType::Left | JoinType::First => next.push(combo.clone()),
                        }
                    }
                }
            }

            combos = next;
            if combos.is_empty() { break; }
        }

        // ── Nessuna combinazione: riga rejected ───────────────────
        if combos.is_empty() {
            rows_rejected += 1;
            // Costruisce la riga rejected con il solo contesto main
            // (+ transforms valutabili su main)
            if let Some((i, output)) = plan.outputs.iter().enumerate()
                .find(|(_, o)| o.output_id == "output_rejected")
            {
                let mut inputs: HashMap<String, Row> = HashMap::new();
                inputs.insert(plan.main_input_id.clone(), main_row.clone());
                let transform_row = compute_transforms(
                    &plan.transforms, &inputs, &mut lane_vars);
                inputs.insert("__transforms__".to_string(), transform_row.clone());
                if let Some(tx) = output_txs.get(i) {
                    let out_row = build_output_row(output, &inputs, &transform_row, &lane_vars);
                    let _ = tx.send(out_row).await;
                    rows_out += 1;
                    *per_out.entry("output_rejected".to_string()).or_insert(0) += 1;
                }
            }
            continue;
        }

        // ── Per ogni combinazione: transforms + routing multi-match ─
        for combo in combos {
            let mut inputs: HashMap<String, Row> = HashMap::new();
            inputs.insert(plan.main_input_id.clone(), main_row.clone());
            for (key, row) in combo {
                inputs.insert(key, row);
            }

            let transform_row = compute_transforms(
                &plan.transforms, &inputs, &mut lane_vars);
            inputs.insert("__transforms__".to_string(), transform_row.clone());

            // Routing MULTI-MATCH: ogni output valuta il proprio
            // filtro in modo indipendente; nessun filtro = tutte le
            // righe. output_rejected qui viene saltato (riceve solo
            // le righe senza combinazioni, gestite sopra).
            for (i, output) in plan.outputs.iter().enumerate() {
                if output.output_id == "output_rejected" { continue; }

                let passes = if let Some(filter) = &output.filter_expr {
                    let input_refs: HashMap<&str, &Row> = inputs.iter()
                        .map(|(k, v)| (k.as_str(), v))
                        .collect();
                    let eval_ctx = EvalContext::multi(input_refs, &lane_vars);
                    is_truthy(&eval(filter, &eval_ctx))
                } else {
                    true
                };

                if passes {
                    if let Some(tx) = output_txs.get(i) {
                        let out_row = build_output_row(output, &inputs, &transform_row, &lane_vars);
                        if tx.send(out_row).await.is_err() { continue; }
                        rows_out += 1;
                        *per_out.entry(output.output_id.clone()).or_insert(0) += 1;
                    }
                }
            }
        }

        if rows_in % 500 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, rows_rejected, rps);
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in, rows_out,
        rows_rejected,
        elapsed_ms, error: None,
    };
    ctx.emit_output_stats(per_out.clone());
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Helpers ─────────────────────────────────────────────────────

/// Calcola le transform nell'ordine dichiarato, aggiornando i
/// contatori di lane. Restituisce la riga __transforms__.
fn compute_transforms(
    transforms: &[TMapTransformPlan],
    inputs:     &HashMap<String, Row>,
    lane_vars:  &mut HashMap<String, Value>,
) -> Row {
    let mut transform_row = Row::new();

    for tr in transforms {
        // Caso speciale: "lane.variabile" → incremento contatore
        let is_lane_var = matches!(&tr.expr,
            ExprNode::DirectFieldRef { field }
            if field.starts_with("lane.")
        );

        if is_lane_var {
            let var_name = tr.output_name.clone();
            let current  = lane_vars.get(&var_name)
                .cloned()
                .unwrap_or(Value::Int(0));
            let next = match &current {
                Value::Int(n) => Value::Int(n + 1),
                _             => Value::Int(1),
            };
            lane_vars.insert(var_name.clone(), next.clone());
            transform_row.set(tr.output_name.clone(), next);
            continue;
        }

        // Eval normale
        let input_refs: HashMap<&str, &Row> = inputs.iter()
            .map(|(k, v)| (k.as_str(), v))
            .chain(std::iter::once(("__transforms__", &transform_row as &Row)))
            .collect();
        let eval_ctx = EvalContext::multi(input_refs, lane_vars);
        let result   = eval(&tr.expr, &eval_ctx);
        transform_row.set(tr.output_name.clone(), result);
    }

    transform_row
}

/// Calcola la chiave di join per indicizzare una riga lookup (fase 1)
fn compute_lookup_key(
    lkp_row:    &Row,
    join_pairs: &[TMapJoinPairPlan],
    variables:  &HashMap<String, Value>,
) -> Result<String, String> {
    if join_pairs.is_empty() { return Ok(String::new()); }

    let mut key_parts = Vec::new();

    for pair in join_pairs {
        let default_expr = ExprNode::DirectFieldRef {
            field: pair.dst_field.clone(),
        };
        let key_expr = pair.dst_key_expr.as_ref().unwrap_or(&default_expr);

        // Contesto minimale: solo la riga lookup corrente
        let mut single: HashMap<&str, &Row> = HashMap::new();
        single.insert("__current__", lkp_row);
        let ctx = EvalContext::multi(single, variables);
        let val = eval(key_expr, &ctx);
        key_parts.push(val.as_str_repr());
    }

    Ok(key_parts.join("|"))
}

/// Calcola la chiave src per un lookup data la combinazione corrente.
/// Il src_key_expr può referenziare il main O un lookup già risolto
/// nella combinazione (join a catena: actor per actor_id di film_actor).
fn compute_src_key(
    lkp:       &MaterializedLookup,
    main_row:  &Row,
    combo:     &HashMap<String, Row>,
    variables: &HashMap<String, Value>,
) -> String {
    let mut key_parts = Vec::new();

    for pair in &lkp.plan.join_pairs {
        let mut refs: HashMap<&str, &Row> = HashMap::new();
        refs.insert("main", main_row);
        for (k, r) in combo {
            refs.insert(k.as_str(), r);
        }
        let ctx = EvalContext::multi(refs, variables);
        let val = eval(&pair.src_key_expr, &ctx);
        key_parts.push(val.as_str_repr());
    }

    key_parts.join("|")
}

/// Costruisce la riga di output valutando tutte le espressioni
fn build_output_row(
    output:        &TMapOutputPlan,
    inputs:        &HashMap<String, Row>,
    transform_row: &Row,
    variables:     &HashMap<String, Value>,
) -> Row {
    let mut out_row = Row::new();

    // Costruisci i riferimenti per EvalContext
    let mut input_refs: HashMap<&str, &Row> = inputs.iter()
        .map(|(k, v)| (k.as_str(), v))
        .collect();
    input_refs.insert("__transforms__", transform_row);

    let eval_ctx = EvalContext::multi(input_refs, variables);

    for field in &output.fields {
        let val = eval(&field.expr, &eval_ctx);
        out_row.set(field.name.clone(), val);
    }

    out_row
}