// ─── src-tauri/src/engine/nodes/json_serializer.rs (v2) ────────────
//
// PORTING FEDELE di src/runner/jsonSerializerExecutor.ts.
// Assembla UN documento JSON per run a partire da più flussi di
// ingresso (multi-handle), seguendo l'albero configurato nella modal.
//
// Config (da buildRustPlan):
//   output_field  — campo output (default 'content')
//   pretty        — pretty print
//   null_default  — 'null' | 'omit' | 'empty'
//   envelope      — chiave envelope opzionale
//   on_error      — 'reject' | 'stop' | 'null'
//   tree          — JsonTreeNode[] (props._treeNodes)
//   mappings      — config.jsonSerializer.mappings (per handle)
//
// SEMANTICA (identica al runner TS):
//   - Bufferizza TUTTE le righe di ogni handle (documento aggregato)
//   - Albero: object/array/foglie; array iterano su iterHandle
//     (fallback: sourceHandle, poi handle più citato nei figli),
//     groupBy raggruppa preservando l'ordine di arrivo, il rowContext
//     porta la riga corrente dentro le foglie annidate
//   - dedup: se mapping.dedup, deduplica sui campi usati nell'albero
//     per quell'handle (o sui sourceField del mapping, o su tutti)
//   - Foglie: sourceHandle+sourceField dal rowContext o prima riga
//   - transform: to_string/int/float/bool/date, upper/lower/trim
//   - nullable: null → 'null' | 'omit' (campo assente) | 'empty' ('')
//   - Output: UNA riga { output_field: json } sull'handle 'output'
//   - Errori: on_error reject → riga { _json_error } su 'reject'
//
// LIMITE DICHIARATO (Stage B.1): expr e condition sono espressioni
// JavaScript nel runner TS — qui non eseguibili. Comportamento
// allineato al fallback del riferimento: expr → null, condition →
// true, con warning esplicito nel log. La conversione a ExprNode
// (come buildTMapPlan) è il passo B.2.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use serde_json::Value as JVal;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Strutture config (mirroring dei tipi della modal) ────────────

#[derive(Debug, Deserialize)]
struct SerPlan {
    #[serde(default = "d_output_field")]
    output_field: String,
    #[serde(default)]
    pretty:       bool,
    #[serde(default)]
    envelope:     String,
    #[serde(default = "d_null")]
    null_default: String,
    #[serde(default = "d_on_error")]
    on_error:     String,
    #[serde(default)]
    tree:         Vec<TreeNode>,
    #[serde(default)]
    mappings:     HashMap<String, FlowMapping>,
}
fn d_output_field() -> String { "content".into() }
fn d_null()         -> String { "null".into() }
fn d_on_error()     -> String { "reject".into() }

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct TreeNode {
    #[serde(default)]
    key:  String,
    #[serde(rename = "type", default)]
    node_type: String,
    #[serde(default)]
    children: Vec<TreeNode>,
    #[serde(default)]
    source_handle: Option<String>,
    #[serde(default)]
    source_field:  Option<String>,
    #[serde(default)]
    sources:       Option<Vec<SourceRef>>,
    #[serde(default)]
    expr:          Option<String>,
    #[serde(default)]
    iter_handle:   Option<String>,
    #[serde(default)]
    condition:     Option<String>,
    #[serde(default)]
    group_by:      Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct SourceRef {
    #[serde(default)]
    handle: String,
    #[serde(default)]
    field:  String,
}

#[derive(Debug, Deserialize, Clone)]
struct FlowMapping {
    #[serde(default)]
    fields: Vec<FlowField>,
    #[serde(default)]
    dedup:  bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct FlowField {
    #[serde(default)]
    json_key:     String,
    #[serde(default)]
    source_field: String,
    #[serde(default)]
    transform:    String,
    #[serde(default)]
    nullable:     Option<String>,
}

// ─── Entry point ──────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    inputs:  HashMap<String, RowReceiver>,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let plan: SerPlan = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("json_serializer config non valida: {}", e))?;

    let start = Instant::now();
    let mut rows_in = 0u64;

    // ── Bufferizza tutti i flussi, handle per handle ──────────────
    // (documento aggregato: serve il dataset completo di ogni handle)
    let mut by_handle: HashMap<String, Vec<Row>> = HashMap::new();
    for (handle, mut rx) in inputs {
        let bucket = by_handle.entry(handle).or_default();
        while let Some(row) = rx.recv().await {
            rows_in += 1;
            bucket.push(row);
        }
    }

    eprintln!("[json_serializer {}] handle ricevuti: {}",
        ctx.node_id.0,
        by_handle.iter().map(|(h, r)| format!("{}({})", h, r.len()))
            .collect::<Vec<_>>().join(", "));

    // Warning una tantum per expr/condition (Stage B.2)
    if tree_uses_js(&plan.tree) {
        eprintln!("[json_serializer {}] ATTENZIONE: expr/condition JavaScript nell'albero \
                   non ancora supportati dal motore Rust — expr → null, condition → sempre vera",
                   ctx.node_id.0);
    }

    let out_tx    = outputs.remove("output");
    let reject_tx = outputs.remove("reject");

    // ── Costruzione documento ─────────────────────────────────────
    let doc: JVal = if !plan.tree.is_empty() {
        // Struttura dell'albero configurata
        let mut doc = serde_json::Map::new();
        for root in &plan.tree {
            // Caso speciale del riferimento: array radice con
            // sourceHandle → mappa piatta via mapping.fields.
            // ATTENZIONE: è un ramo legacy precedente al groupBy —
            // va applicato SOLO se l'array non ha figli, né groupBy,
            // né iterHandle. Altrimenti (albero strutturato, come
            // films raggruppato per film_id con lista annidata) la
            // costruzione passa dal ricorsivo, che onora tutto.
            let is_legacy_flat = root.node_type == "array"
                && root.source_handle.is_some()
                && root.children.is_empty()
                && root.group_by.as_deref().map_or(true, |g| g.is_empty())
                && root.iter_handle.as_deref().map_or(true, |h| h.is_empty());

            if is_legacy_flat {
                let handle  = root.source_handle.as_deref().unwrap();
                let dedup_f = collect_tree_fields(&plan.tree, handle);
                let rows    = get_rows(handle, &by_handle, &plan.mappings,
                    if dedup_f.is_empty() { None } else { Some(&dedup_f) });
                let mapping = plan.mappings.get(handle);
                let arr = if let Some(m) = mapping.filter(|m| !m.fields.is_empty()) {
                    rows.iter().map(|row| map_row_with_fields(row, &m.fields, &plan.null_default)).collect()
                } else {
                    rows.iter().map(row_to_json).collect::<Vec<_>>()
                };
                doc.insert(root.key.clone(), JVal::Array(arr));
            } else if let Some(v) = build_node_value(
                root, &by_handle, &plan.mappings, &plan.null_default, &HashMap::new(), &plan.tree,
            ) {
                doc.insert(root.key.clone(), v);
            }
        }
        JVal::Object(doc)
    } else if !plan.mappings.is_empty() {
        // Fallback: mapping senza albero
        build_from_mappings(&plan.mappings, &by_handle, &plan.null_default)
    } else {
        // Fallback finale: ogni flusso come chiave
        let mut doc = serde_json::Map::new();
        let mut handles: Vec<&String> = by_handle.keys().collect();
        handles.sort();
        for h in handles {
            let key = if h == "input" { "data".to_string() } else { h.clone() };
            let rows = by_handle.get(h).unwrap();
            doc.insert(key, JVal::Array(rows.iter().map(row_to_json).collect()));
        }
        JVal::Object(doc)
    };

    // ── Envelope + serializzazione ────────────────────────────────
    let result = if plan.envelope.is_empty() {
        doc
    } else {
        let mut wrap = serde_json::Map::new();
        wrap.insert(plan.envelope.clone(), doc);
        JVal::Object(wrap)
    };

    let json = if plan.pretty {
        serde_json::to_string_pretty(&result)
    } else {
        serde_json::to_string(&result)
    };

    let (rows_out, rows_rejected) = match json {
        Ok(json_str) => {
            eprintln!("[json_serializer {}] documento generato: {} caratteri",
                ctx.node_id.0, json_str.len());
            let mut out = Row::new();
            out.set(plan.output_field.clone(), Value::String(json_str));
            let mut sent = 0u64;
            if let Some(tx) = &out_tx {
                if tx.send(out).await.is_ok() { sent = 1; }
            }
            (sent, 0u64)
        }
        Err(e) => {
            let msg = format!("serializzazione fallita: {}", e);
            eprintln!("[json_serializer {}] {}", ctx.node_id.0, msg);
            match plan.on_error.as_str() {
                "stop" => return Err(format!("json_serializer {}: {}", ctx.node_id.0, msg)),
                "reject" => {
                    if let Some(tx) = &reject_tx {
                        let mut rej = Row::new();
                        rej.set("_json_error".into(), Value::String(msg));
                        let _ = tx.send(rej).await;
                    }
                    (0u64, 1u64)
                }
                _ => {
                    let mut out = Row::new();
                    out.set(plan.output_field.clone(), Value::Null);
                    if let Some(tx) = &out_tx { let _ = tx.send(out).await; }
                    (1u64, 0u64)
                }
            }
        }
    };

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Costruzione ricorsiva del valore di un nodo ──────────────────
// Restituisce None = "undefined" nel riferimento (campo omesso).

fn build_node_value(
    node:         &TreeNode,
    by_handle:    &HashMap<String, Vec<Row>>,
    mappings:     &HashMap<String, FlowMapping>,
    null_default: &str,
    row_context:  &HashMap<String, Row>,
    tree:         &[TreeNode],
) -> Option<JVal> {

    // ── Foglia ────────────────────────────────────────────────────
    if node.node_type != "object" && node.node_type != "array" {
        let effective_row = |handle: &str| -> Option<Row> {
            if let Some(r) = row_context.get(handle) { return Some(r.clone()); }
            by_handle.get(handle).and_then(|rows| rows.first().cloned())
        };

        // expr JS: non eseguibile → null (allineato al catch del riferimento)
        if node.expr.as_deref().map_or(false, |e| !e.trim().is_empty()) {
            return Some(JVal::Null);
        }

        if let (Some(h), Some(f)) = (&node.source_handle, &node.source_field) {
            let row = effective_row(h).unwrap_or_else(Row::new);
            // condition JS: non valutabile → true (fallback del riferimento)
            let val = row.get(f).map(|v| v.to_json()).unwrap_or(JVal::Null);
            return apply_nullable(val, null_default);
        }

        return Some(JVal::Null);
    }

    // ── Object ────────────────────────────────────────────────────
    if node.node_type == "object" {
        let mut obj = serde_json::Map::new();
        for child in &node.children {
            if let Some(v) = build_node_value(child, by_handle, mappings, null_default, row_context, tree) {
                obj.insert(child.key.clone(), v);
            }
        }
        return Some(JVal::Object(obj));
    }

    // ── Array ─────────────────────────────────────────────────────
    // Handle di iterazione: iterHandle → sourceHandle → il più
    // citato tra i sourceHandle dei figli
    let iter_h: Option<String> = node.iter_handle.clone()
        .or_else(|| node.source_handle.clone())
        .or_else(|| {
            let mut counts: HashMap<String, u32> = HashMap::new();
            fn walk(ns: &[TreeNode], counts: &mut HashMap<String, u32>) {
                for n in ns {
                    if let Some(h) = &n.source_handle {
                        *counts.entry(h.clone()).or_insert(0) += 1;
                    }
                    walk(&n.children, counts);
                }
            }
            walk(&node.children, &mut counts);
            counts.into_iter().max_by_key(|(_, c)| *c).map(|(h, _)| h)
        });

    let iter_h = match iter_h {
        Some(h) => h,
        None => {
            // Nessun handle: singolo oggetto dai figli, o array vuoto
            if !node.children.is_empty() {
                let mut obj = serde_json::Map::new();
                for child in &node.children {
                    if let Some(v) = build_node_value(child, by_handle, mappings, null_default, row_context, tree) {
                        obj.insert(child.key.clone(), v);
                    }
                }
                return Some(JVal::Array(vec![JVal::Object(obj)]));
            }
            return Some(JVal::Array(vec![]));
        }
    };

    let dedup_f = collect_tree_fields(tree, &iter_h);
    let rows = get_rows(&iter_h, by_handle, mappings,
        if dedup_f.is_empty() { None } else { Some(&dedup_f) });

    // Array senza figli: mappa piatta dal mapping, o righe raw
    if node.children.is_empty() {
        if let Some(m) = mappings.get(&iter_h).filter(|m| !m.fields.is_empty()) {
            return Some(JVal::Array(
                rows.iter().map(|r| map_row_with_fields(r, &m.fields, null_default)).collect()
            ));
        }
        return Some(JVal::Array(rows.iter().map(row_to_json).collect()));
    }

    // Con groupBy: raggruppa preservando l'ordine di arrivo
    if let Some(group_field) = node.group_by.as_deref().filter(|g| !g.is_empty()) {
        let mut order: Vec<String> = Vec::new();
        let mut groups: HashMap<String, Vec<Row>> = HashMap::new();
        for row in &rows {
            let k = row.get(group_field)
                .filter(|v| !matches!(v, Value::Null))
                .map(|v| v.as_str_repr())
                .unwrap_or_else(|| "\u{0}null\u{0}".to_string());
            if !groups.contains_key(&k) { order.push(k.clone()); }
            groups.entry(k).or_default().push(row.clone());
        }

        let mut arr = Vec::with_capacity(order.len());
        for k in order {
            let group_rows = groups.remove(&k).unwrap_or_default();
            // byHandle locale: l'handle di iterazione vede SOLO il gruppo
            let mut group_by_handle = by_handle.clone();
            group_by_handle.insert(iter_h.clone(), group_rows.clone());
            // rowContext: la prima riga del gruppo rappresenta il gruppo
            let mut ctx = row_context.clone();
            if let Some(first) = group_rows.first() {
                ctx.insert(iter_h.clone(), first.clone());
            }
            let mut obj = serde_json::Map::new();
            for child in &node.children {
                if let Some(v) = build_node_value(child, &group_by_handle, mappings, null_default, &ctx, tree) {
                    obj.insert(child.key.clone(), v);
                }
            }
            arr.push(JVal::Object(obj));
        }
        return Some(JVal::Array(arr));
    }

    // Senza groupBy: un oggetto per riga
    let mut arr = Vec::with_capacity(rows.len());
    for row in &rows {
        let mut ctx = row_context.clone();
        ctx.insert(iter_h.clone(), row.clone());
        let mut obj = serde_json::Map::new();
        for child in &node.children {
            if let Some(v) = build_node_value(child, by_handle, mappings, null_default, &ctx, tree) {
                obj.insert(child.key.clone(), v);
            }
        }
        arr.push(JVal::Object(obj));
    }
    Some(JVal::Array(arr))
}

// ─── Fallback: documento dai soli mapping (senza albero) ──────────

fn build_from_mappings(
    mappings:     &HashMap<String, FlowMapping>,
    by_handle:    &HashMap<String, Vec<Row>>,
    null_default: &str,
) -> JVal {
    // NOTA: il riferimento usa mapping.jsonKey/mode — qui semplificato:
    // ogni handle mappato diventa un array con i suoi fields.
    // (Il percorso principale è l'albero; questo fallback copre
    // configurazioni legacy senza _treeNodes.)
    let mut doc = serde_json::Map::new();
    let mut handles: Vec<&String> = mappings.keys().collect();
    handles.sort();
    for h in handles {
        let m    = mappings.get(h).unwrap();
        let rows = get_rows(h, by_handle, mappings, None);
        let key  = if h == "input" { "data".to_string() } else { h.clone() };
        let arr: Vec<JVal> = if !m.fields.is_empty() {
            rows.iter().map(|r| map_row_with_fields(r, &m.fields, null_default)).collect()
        } else {
            rows.iter().map(row_to_json).collect()
        };
        doc.insert(key, JVal::Array(arr));
    }
    JVal::Object(doc)
}

// ─── Helpers ──────────────────────────────────────────────────────

/// Righe di un handle, con dedup se il mapping lo prevede.
/// Priorità campi dedup: espliciti → sourceField del mapping → tutti.
fn get_rows(
    handle:       &str,
    by_handle:    &HashMap<String, Vec<Row>>,
    mappings:     &HashMap<String, FlowMapping>,
    dedup_fields: Option<&Vec<String>>,
) -> Vec<Row> {
    let rows = by_handle.get(handle).cloned().unwrap_or_default();
    let mapping = mappings.get(handle);
    if !mapping.map_or(false, |m| m.dedup) { return rows; }

    let fields: Vec<String> = if let Some(f) = dedup_fields.filter(|f| !f.is_empty()) {
        f.clone()
    } else if let Some(m) = mapping.filter(|m| !m.fields.is_empty()) {
        m.fields.iter()
            .map(|f| f.source_field.clone())
            .filter(|s| !s.is_empty())
            .collect()
    } else {
        let mut keys: Vec<String> = rows.first()
            .map(|r| r.0.keys().filter(|k| !k.starts_with("__")).cloned().collect())
            .unwrap_or_default();
        keys.sort();
        keys
    };

    dedup_rows(rows, &fields)
}

fn dedup_rows(rows: Vec<Row>, fields: &[String]) -> Vec<Row> {
    if fields.is_empty() { return rows; }
    let mut seen = std::collections::HashSet::new();
    rows.into_iter().filter(|row| {
        let key = fields.iter()
            .map(|f| row.get(f)
                .filter(|v| !matches!(v, Value::Null))
                .map(|v| v.as_str_repr().trim().to_string())
                .unwrap_or_default())
            .collect::<Vec<_>>()
            .join("\u{0}");
        seen.insert(key)
    }).collect()
}

/// Raccoglie i sourceField usati nell'albero per un handle
fn collect_tree_fields(nodes: &[TreeNode], handle: &str) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    fn walk(ns: &[TreeNode], handle: &str, fields: &mut Vec<String>) {
        for n in ns {
            if n.source_handle.as_deref() == Some(handle) {
                if let Some(f) = &n.source_field {
                    if !fields.contains(f) { fields.push(f.clone()); }
                }
            }
            if let Some(sources) = &n.sources {
                for s in sources {
                    if s.handle == handle && !fields.contains(&s.field) {
                        fields.push(s.field.clone());
                    }
                }
            }
            walk(&n.children, handle, fields);
        }
    }
    walk(nodes, handle, &mut fields);
    fields
}

/// Mappa una riga secondo i FlowField del mapping (con transform e nullable)
fn map_row_with_fields(row: &Row, fields: &[FlowField], null_default: &str) -> JVal {
    let mut obj = serde_json::Map::new();
    for mf in fields {
        if mf.json_key.is_empty() || mf.source_field.is_empty() { continue; }
        let raw = row.get(&mf.source_field).map(|v| v.to_json()).unwrap_or(JVal::Null);
        let transformed = if mf.transform.is_empty() { raw } else { apply_transform(raw, &mf.transform) };
        let nullable = mf.nullable.as_deref().unwrap_or(null_default);
        if let Some(v) = apply_nullable(transformed, nullable) {
            obj.insert(mf.json_key.clone(), v);
        }
    }
    JVal::Object(obj)
}

fn apply_transform(val: JVal, transform: &str) -> JVal {
    let s = jval_to_string(&val);
    match transform {
        "to_string" => JVal::String(s),
        "to_int"    => s.trim().parse::<i64>().map(|n| JVal::Number(n.into())).unwrap_or(JVal::Null),
        "to_float"  => s.trim().parse::<f64>().ok()
            .and_then(serde_json::Number::from_f64)
            .map(JVal::Number).unwrap_or(JVal::Null),
        "to_bool"   => JVal::Bool(matches!(s.to_lowercase().as_str(), "true" | "1" | "yes" | "si" | "sì")),
        "to_date"   => JVal::String(s.split('T').next().unwrap_or("").to_string()),
        "uppercase" => JVal::String(s.to_uppercase()),
        "lowercase" => JVal::String(s.to_lowercase()),
        "trim"      => JVal::String(s.trim().to_string()),
        _           => val,
    }
}

/// None = campo omesso ("undefined" nel riferimento)
fn apply_nullable(val: JVal, nullable: &str) -> Option<JVal> {
    if val.is_null() {
        return match nullable {
            "empty" => Some(JVal::String(String::new())),
            "omit"  => None,
            _       => Some(JVal::Null),
        };
    }
    Some(val)
}

fn row_to_json(row: &Row) -> JVal {
    let mut obj = serde_json::Map::new();
    let mut keys: Vec<&String> = row.0.keys().collect();
    keys.sort();
    for k in keys {
        if let Some(v) = row.get(k) { obj.insert(k.clone(), v.to_json()); }
    }
    JVal::Object(obj)
}

fn jval_to_string(v: &JVal) -> String {
    match v {
        JVal::String(s) => s.clone(),
        JVal::Null      => String::new(),
        other           => other.to_string(),
    }
}

fn tree_uses_js(nodes: &[TreeNode]) -> bool {
    nodes.iter().any(|n|
        n.expr.as_deref().map_or(false, |e| !e.trim().is_empty())
        || n.condition.as_deref().map_or(false, |c| !c.trim().is_empty())
        || tree_uses_js(&n.children))
}