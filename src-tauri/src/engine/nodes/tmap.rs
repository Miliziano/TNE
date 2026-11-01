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
//   P371: le chiavi di join leggono i campi per esteso — lato sorgente
//   l'input da cui vengono (main incluso, registrato anche col suo id),
//   lato lookup la riga del lookup (registrata anche col suo id e label).
//   Prima un campo omonimo fra main e lookup poteva dare la chiave
//   sbagliata. I campi d'uscita prendono il TIPO dichiarato (field_mapping::
//   convert_value), tranne `string`; un valore non convertibile resta com'è
//   e si conta.
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
use crate::engine::compiled::Compiled;

/// P383: valuta la versione compilata se c'è (sempre, dopo `compile_plan`),
/// altrimenti l'albero con l'interprete. Stesso risultato.
fn ev(c: &Option<Compiled>, e: &ExprNode, ctx: &EvalContext) -> Value {
    match c {
        Some(c) => c.eval(ctx),
        None => eval(e, ctx),
    }
}

/// P383: compila una volta tutte le espressioni del piano.
fn compile_plan(plan: &mut TMapPlan) {
    for tr in plan.transforms.iter_mut() { tr.c = Some(Compiled::new(&tr.expr)); }
    for out in plan.outputs.iter_mut() {
        out.filter_c = out.filter_expr.as_ref().map(Compiled::new);
        for f in out.fields.iter_mut() { f.c = Some(Compiled::new(&f.expr)); }
    }
    for lkp in plan.lookups.iter_mut() {
        for p in lkp.join_pairs.iter_mut() {
            p.src_c = Some(Compiled::new(&p.src_key_expr));
            p.dst_c = p.dst_key_expr.as_ref().map(Compiled::new);
        }
    }
}

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
    /// P383: espressioni compilate all'avvio del nodo (non nel piano).
    #[serde(skip)] src_c: Option<Compiled>,
    #[serde(skip)] dst_c: Option<Compiled>,
}

#[derive(Debug, Deserialize)]
pub struct TMapOutputPlan {
    pub output_id:   String,
    pub label:       String,
    pub filter_expr: Option<ExprNode>,
    pub fields:      Vec<TMapOutputFieldPlan>,
    #[serde(skip)] filter_c: Option<Compiled>,
}

#[derive(Debug, Deserialize)]
pub struct TMapOutputFieldPlan {
    pub name:    String,
    #[serde(rename = "type")]
    pub r#type:  String,
    pub expr:    ExprNode,
    #[serde(skip)] c: Option<Compiled>,
}

#[derive(Debug, Deserialize)]
pub struct TMapTransformPlan {
    pub id:          String,
    pub output_name: String,
    pub output_type: String,
    pub expr:        ExprNode,
    #[serde(skip)] c: Option<Compiled>,
}

// ─── Lookup materializzato ────────────────────────────────────────

/// P383: una combinazione main × lookup = coppie (nome dell'ingresso, riga),
/// in prestito. A parità di nome vale l'ultima (come l'insert in una HashMap).
type Combo<'a> = smallvec::SmallVec<[(&'a str, &'a Row); 4]>;

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

    // Migrato alla spec (Fase 12). Il TMapPlan è un blob interamente
    // compilato dal builder (ExprNode per lookup/join/output/transform)
    // → spec.config. V. node-spec §22.
    let spec = crate::engine::spec::Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("tmap {}: {}", ctx.node_id.0, e))?;
    let mut plan: TMapPlan = serde_json::from_value(spec.config().clone())
        .map_err(|e| format!("tmap {}: invalid config: {}", ctx.node_id.0, e))?;
    compile_plan(&mut plan);
    spec.log_unconsumed("tmap", &ctx.node_id.0);

    let start     = Instant::now();
    let variables = ctx.variables.clone();

    // ── Fase 1: Pre-materializzazione lookup ──────────────────────
    let mut materialized: Vec<MaterializedLookup> = Vec::new();

    for (lookup_plan, mut rx) in plan.lookups.into_iter().zip(lookup_rxs.into_iter()) {
        let mut index: HashMap<String, Vec<Row>> = HashMap::new();
        let mut count = 0u64;

        while let Some(lkp_row) = rx.recv().await {
            count += 1;
            let key = compute_lookup_key(&lkp_row, &lookup_plan, &variables)?;
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
    // P371: "output.campo" → (valori non convertibili al tipo, tipo)
    let mut failed: HashMap<String, (u64, String)> = HashMap::new();

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
        // P383: le combinazioni tengono RIFERIMENTI alle righe (main e lookup
        // materializzati), non copie: prima ogni riga di lookup si clonava due
        // volte (sotto id e label) per ogni riga main che la usava.
        let mut combos: Vec<Combo> = vec![Combo::new()];

        for lkp in &materialized {
            if lkp.plan.join_pairs.is_empty() { continue; }

            let mut next: Vec<Combo> = Vec::new();

            for combo in &combos {
                let src_key = compute_src_key(lkp, &main_row, plan.main_input_id.as_str(), combo, &variables);

                match lkp.index.get(&src_key).filter(|r| !r.is_empty()) {
                    Some(rows) => {
                        match lkp.plan.join_type {
                            JoinType::First => {
                                // Solo la prima corrispondenza (uno-a-uno esplicito)
                                let mut c = combo.clone();
                                let r = rows.first().unwrap();
                                c.push((lkp.plan.input_id.as_str(), r));
                                c.push((lkp.plan.label.as_str(),    r));
                                next.push(c);
                            }
                            JoinType::Inner | JoinType::Left => {
                                // TUTTE le corrispondenze: una combinazione per riga
                                for r in rows {
                                    let mut c = combo.clone();
                                    c.push((lkp.plan.input_id.as_str(), r));
                                    c.push((lkp.plan.label.as_str(),    r));
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
                let inputs: Combo = std::iter::once((plan.main_input_id.as_str(), &main_row)).collect();
                let transform_row = compute_transforms(
                    &plan.transforms, &inputs, &mut lane_vars, plan.main_input_id.as_str());
                let full: Combo = inputs.iter().copied()
                    .chain(std::iter::once(("__transforms__", &transform_row))).collect();
                if let Some(tx) = output_txs.get(i) {
                    let out_row = build_output_row(output, &full, &transform_row, &lane_vars, &mut failed);
                    let _ = tx.send(out_row).await;
                    rows_out += 1;
                    *per_out.entry("output_rejected".to_string()).or_insert(0) += 1;
                }
            }
            continue;
        }

        // ── Per ogni combinazione: transforms + routing multi-match ─
        for combo in combos {
            let mut inputs: Combo = Combo::new();
            inputs.push((plan.main_input_id.as_str(), &main_row));
            inputs.extend(combo.iter().copied());

            let transform_row = compute_transforms(
                &plan.transforms, &inputs, &mut lane_vars, plan.main_input_id.as_str());
            let inputs: Combo = inputs.iter().copied()
                .chain(std::iter::once(("__transforms__", &transform_row))).collect();

            // Routing MULTI-MATCH: ogni output valuta il proprio
            // filtro in modo indipendente; nessun filtro = tutte le
            // righe. output_rejected qui viene saltato (riceve solo
            // le righe senza combinazioni, gestite sopra).
            for (i, output) in plan.outputs.iter().enumerate() {
                if output.output_id == "output_rejected" { continue; }

                let passes = if let Some(filter) = &output.filter_expr {
                    // Il main dichiarato ⇒ un campo scritto senza sorgente si
                    // risolve prima lì, non a caso (v. expr.rs).
                    let eval_ctx = EvalContext::from_pairs(
                        inputs.iter().copied(),
                        &lane_vars, Some(plan.main_input_id.as_str()));
                    match &output.filter_c {
                        Some(c) => c.is_true(&eval_ctx),
                        None => is_truthy(&eval(filter, &eval_ctx)),
                    }
                } else {
                    true
                };

                if passes {
                    if let Some(tx) = output_txs.get(i) {
                        let out_row = build_output_row(output, &inputs, &transform_row, &lane_vars, &mut failed);
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

    let mut keys: Vec<&String> = failed.keys().collect();
    keys.sort();
    for k in keys {
        let (n, ty) = &failed[k];
        ctx.emit_log(&ctx.label, "warn", 0, format!(
            "field '{}': {} value(s) could not be converted to {} and were kept as they are", k, n, ty), "panel");
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
    transforms:    &[TMapTransformPlan],
    inputs:        &[(&str, &Row)],
    lane_vars:     &mut HashMap<String, Value>,
    main_input_id: &str,
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

        // Eval normale (P383: contesto senza HashMap, chiuso prima di scrivere)
        let result = {
            let eval_ctx = EvalContext::from_pairs(
                inputs.iter().copied()
                    .chain(std::iter::once(("__transforms__", &transform_row as &Row))),
                lane_vars, Some(main_input_id));
            ev(&tr.c, &tr.expr, &eval_ctx)
        };
        transform_row.set(tr.output_name.clone(), result);
    }

    transform_row
}

/// Calcola la chiave di join per indicizzare una riga lookup (fase 1)
fn compute_lookup_key(
    lkp_row:    &Row,
    lookup:     &TMapLookupPlan,
    variables:  &HashMap<String, Value>,
) -> Result<String, String> {
    if lookup.join_pairs.is_empty() { return Ok(String::new()); }

    let mut key_parts = Vec::new();

    for pair in &lookup.join_pairs {
        let default_expr = ExprNode::DirectFieldRef {
            field: pair.dst_field.clone(),
        };
        let key_expr = pair.dst_key_expr.as_ref().unwrap_or(&default_expr);

        // Contesto minimale: solo la riga lookup corrente — anche col suo id
        // e la sua label, per le espressioni che la citano per esteso.
        let ctx = EvalContext::from_pairs(
            [("__current__", lkp_row), (lookup.input_id.as_str(), lkp_row), (lookup.label.as_str(), lkp_row)],
            variables, None);
        let val = if pair.dst_key_expr.is_some() { ev(&pair.dst_c, key_expr, &ctx) } else { eval(key_expr, &ctx) };
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
    main_id:   &str,
    combo:     &[(&str, &Row)],
    variables: &HashMap<String, Value>,
) -> String {
    let mut key_parts = Vec::new();

    for pair in &lkp.plan.join_pairs {
        let ctx = EvalContext::from_pairs(
            [("main", main_row), (main_id, main_row)].into_iter()
                .chain(combo.iter().copied()),
            variables, Some(main_id));
        let val = ev(&pair.src_c, &pair.src_key_expr, &ctx);
        key_parts.push(val.as_str_repr());
    }

    key_parts.join("|")
}

/// Costruisce la riga di output valutando tutte le espressioni
fn build_output_row(
    output:        &TMapOutputPlan,
    inputs:        &[(&str, &Row)],
    transform_row: &Row,
    variables:     &HashMap<String, Value>,
    failed:        &mut HashMap<String, (u64, String)>,
) -> Row {
    let mut out_row = Row::new();

    // Riferimenti per EvalContext (P383: senza HashMap). `__transforms__` per
    // ultimo: a parità di nome vince, come con l'insert di prima.
    let eval_ctx = EvalContext::from_pairs(
        inputs.iter().copied()
            .chain(std::iter::once(("__transforms__", transform_row))),
        variables, None);

    for field in &output.fields {
        let val = ev(&field.c, &field.expr, &eval_ctx);
        // P371: il tipo dichiarato (o dedotto dallo studio) si applica. Non
        // `string`: è anche il ripiego quando lo studio non deduce il tipo, e
        // trasformare in testo un numero romperebbe le scritture a valle.
        let val = if field.r#type == "string" { Ok(val) } else {
            crate::engine::field_mapping::convert_value(&val, &field.r#type, "none")
        };
        let val = match val {
            Ok(v) => v,
            Err((kept, target)) => {
                failed.entry(format!("{}.{}", output.label, field.name)).or_insert((0, target)).0 += 1;
                kept
            }
        };
        out_row.set(field.name.clone(), val);
    }

    out_row
}