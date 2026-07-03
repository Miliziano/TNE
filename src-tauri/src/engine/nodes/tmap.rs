// ─── src-tauri/src/engine/nodes/tmap.rs ────────────────────────────
//
// Nodo TMap — il nodo più complesso dell'Engine.
//
// ALGORITMO:
//   Fase 1 — Pre-materializzazione lookup
//     Per ogni lookup (in ordine topologico):
//       - Legge tutte le righe dal canale rx del lookup
//       - Costruisce un HashMap<String, Vec<Row>> indicizzato per chiave di join
//       - La chiave è calcolata valutando src_key_expr su ogni riga lookup
//     NOTA: ogni lookup ha il SUO indice separato — non esiste una
//     "grande tabella" fusa. Il main NON viene mai materializzato.
//
//   Fase 2 — Elaborazione main stream (ROW BY ROW)
//     Per ogni riga del main:
//       - Calcola le variabili di transform (nell'ordine dichiarato)
//       - Per ogni lookup: calcola la chiave, cerca nel SUO HashMap,
//         applica il join type (inner/left/first)
//       - Costruisce il contesto EvalContext con tutti gli input risolti
//       - ROUTING MULTI-MATCH: ogni output valuta il proprio filtro in
//         modo INDIPENDENTE. Nessun filtro = riceve tutte le righe.
//         La stessa riga può quindi uscire su più output contemporaneamente
//         (semantica Talend). output_rejected riceve solo le righe che
//         falliscono gli inner join.
//       - Per ogni output che matcha: valuta le expression dei campi
//         e manda la riga nel canale dell'output corrispondente

use std::collections::HashMap;
use std::time::Instant;
use serde::{Deserialize, Serialize};
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
    let mut rows_rejected: u64 = 0;   // righe che falliscono gli inner join

    // Variabili di lane mutabili
    let mut lane_vars: HashMap<String, Value> = variables
        .iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect();

    while let Some(main_row) = main_rx.recv().await {
        rows_in += 1;

        // ── Trova le righe lookup per questa riga main ───────────
        let lookup_rows = find_lookup_rows(&main_row, &materialized, &variables)?;

        // ── Controlla se passa tutti gli inner join ───────────────
        let mut passes_all_inner = true;
        for lkp in &materialized {
            if matches!(lkp.plan.join_type, JoinType::Inner) {
                // Cerca per input_id O per label
                if !lookup_rows.contains_key(&lkp.plan.input_id) &&
                   !lookup_rows.contains_key(&lkp.plan.label) {
                    passes_all_inner = false;
                    break;
                }
            }
        }
        if !passes_all_inner { rows_rejected += 1; }

        // ── Costruisci il contesto per eval ───────────────────────
        // CHIAVE: aggiungiamo ogni lookup SIA con input_id SIA con label
        // perché le FieldRef nel Plan usano input_id,
        // ma le transform JS usano la label.
        let mut inputs: HashMap<String, Row> = HashMap::new();
        inputs.insert(plan.main_input_id.clone(), main_row.clone());

        for (key, row) in &lookup_rows {
            inputs.insert(key.clone(), row.clone());
        }

        // ── Calcola le transform ──────────────────────────────────
        let mut transform_values: HashMap<String, Value> = HashMap::new();
        let mut transform_row = Row::new();

        for tr in &plan.transforms {
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
                transform_values.insert(var_name.clone(), next.clone());
                transform_row.set(tr.output_name.clone(), next);
                continue;
            }

            // Eval normale
            let input_refs: HashMap<&str, &Row> = inputs.iter()
                .map(|(k, v)| (k.as_str(), v))
                .chain(std::iter::once(("__transforms__", &transform_row as &Row)))
                .collect();
            let eval_ctx = EvalContext::multi(input_refs, &lane_vars);
            let result   = eval(&tr.expr, &eval_ctx);
            transform_values.insert(tr.output_name.clone(), result.clone());
            transform_row.set(tr.output_name.clone(), result);
        }

        // Aggiunge le transform al contesto
        inputs.insert("__transforms__".to_string(), transform_row.clone());

        // ── Routing verso gli output — MULTI-MATCH ────────────────
        // Ogni output valuta il proprio filtro in modo INDIPENDENTE:
        // - filtro presente  → la riga esce se il filtro è vero
        // - nessun filtro    → la riga esce SEMPRE
        // La stessa riga può quindi uscire su più output insieme
        // (semantica Talend). Niente first-match: il vecchio flag
        // `routed` faceva vincere il primo output e affamava gli altri.
        for (i, output) in plan.outputs.iter().enumerate() {
            // output_rejected: solo le righe che falliscono inner join
            if output.output_id == "output_rejected" {
                if !passes_all_inner {
                    if let Some(tx) = output_txs.get(i) {
                        let out_row = build_output_row(output, &inputs, &transform_row, &lane_vars);
                        let _ = tx.send(out_row).await;
                        rows_out += 1;
                    }
                }
                continue;
            }

            // Gli output normali ricevono solo righe che passano gli inner join
            if !passes_all_inner { continue; }

            // Valuta il filtro di routing — indipendente per output
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
                    // Un output chiuso non deve fermare gli altri:
                    // continue, non break (l'executor mette comunque
                    // un drain sulle uscite non collegate)
                    if tx.send(out_row).await.is_err() { continue; }
                    rows_out += 1;
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
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Helpers ─────────────────────────────────────────────────────

/// Calcola la chiave di join per indicizzare una riga lookup
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

/// Trova le righe lookup per una riga main.
/// Restituisce HashMap con DUE chiavi per ogni lookup:
///   - input_id  (per FieldRef nel Plan JSON)
///   - label     (per le transform JS e debug)
fn find_lookup_rows(
    main_row:    &Row,
    materialized: &[MaterializedLookup],
    variables:   &HashMap<String, Value>,
) -> Result<HashMap<String, Row>, String> {

    let mut result: HashMap<String, Row> = HashMap::new();

    for lkp in materialized {
        if lkp.plan.join_pairs.is_empty() { continue; }

        // Costruisce la chiave src usando le righe già trovate + main
        let mut key_parts = Vec::new();
        for pair in &lkp.plan.join_pairs {
            // Il src_key_expr può referenziare:
            //   - main (DirectFieldRef senza prefisso → cerca in main_row)
            //   - un altro lookup già trovato (FieldRef con input_id o label)

            // Contesto: main + lookup già trovati
            let mut single: HashMap<&str, &Row> = HashMap::new();
            single.insert("main", main_row);
            // Aggiunge i lookup già materializzati con entrambe le chiavi
            for (k, r) in &result {
                single.insert(k.as_str(), r);
            }
            let ctx = EvalContext::multi(single, variables);
            let val = eval(&pair.src_key_expr, &ctx);
            key_parts.push(val.as_str_repr());
        }
        let src_key = key_parts.join("|");

        // Cerca nel dizionario del lookup
        match lkp.index.get(&src_key) {
            Some(rows) => {
                let row = match lkp.plan.join_type {
                    JoinType::First => rows.first(),
                    _               => rows.first(), // inner/left: prima riga (one-to-one)
                };
                if let Some(r) = row {
                    // ← INSERISCE CON ENTRAMBE LE CHIAVI
                    result.insert(lkp.plan.input_id.clone(), r.clone());
                    result.insert(lkp.plan.label.clone(),    r.clone());
                }
            }
            None => {
                // Nessun match — per left join la riga continua senza questo lookup
            }
        }
    }

    Ok(result)
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