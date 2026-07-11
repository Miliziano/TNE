// ─── JSON Parser (nodo ricco, multi-flusso, master-detail) ─────────
//
// Porting in Rust dell'executor JS (src/runner/jsonParserExecutor.ts).
// Per ogni riga in ingresso:
//   1. legge il campo sorgente e lo parsa come JSON;
//   2. per ogni FLOW (= un handle di uscita), naviga al suo JSONPath;
//   3. is_array → una riga per elemento, altrimenti una riga;
//   4. per ogni campo: risolve il JSONPath (relativo con fallback
//      assoluto), applica la trasformazione, gestisce on_missing;
//   5. merge_parent → la riga eredita i campi del padre (MASTER-DETAIL);
//   6. emette un handle per flow, più 'reject' se has_reject.
//
// Config in spec.config (node-spec §20). Multi-output: riceve l'intera
// mappa `outputs`. resolve_json_path replica il parser JS (stesso
// sottoinsieme). `filter` per-flow NON implementato (come nel JS).

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use serde_json::Value as JVal;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config (da spec.config) ───────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JsonParserConfig {
    #[serde(default)] source_field: String,
    #[serde(default)] has_reject: bool,
    #[serde(default)] flows: Vec<JsonParserFlow>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JsonParserFlow {
    #[serde(default)] id: String,
    #[serde(default)] label: String,
    #[serde(default)] json_path: String,
    /// Non implementato (non lo era nemmeno nel JS). Ignorato a runtime.
    #[serde(default)] #[allow(dead_code)] filter: Option<String>,
    #[serde(default)] is_array: bool,
    #[serde(default)] #[allow(dead_code)] streaming: bool,
    #[serde(default)] merge_parent: bool,
    #[serde(default)] parent_fields: Vec<String>,
    #[serde(default)] fields: Vec<JsonParserField>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct JsonParserField {
    #[serde(default)] name: String,
    #[serde(default)] json_path: String,
    #[serde(default)] #[allow(dead_code)] r#type: String,
    #[serde(default = "d_none")] transform: String,
    #[serde(default = "d_null")] on_missing: String,
    #[serde(default)] default_value: Option<String>,
}

fn d_none() -> String { "none".into() }
fn d_null() -> String { "null".into() }

// ─── Entry point ───────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("json_parser {}: {}", ctx.node_id.0, e))?;
    let cfg: JsonParserConfig = serde_json::from_value(spec.config().clone())
        .map_err(|e| format!("json_parser {}: config non valida: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("json_parser", &ctx.node_id.0);

    if cfg.source_field.is_empty() {
        return Err(format!("json_parser {}: campo sorgente non configurato.", ctx.node_id.0));
    }
    if cfg.flows.is_empty() {
        return Err(format!("json_parser {}: nessun flusso configurato.", ctx.node_id.0));
    }

    let mut rx = rx.ok_or_else(||
        format!("json_parser {} richiede un input collegato", ctx.node_id.0))?;

    let start = Instant::now();
    let mut rows_in:       u64 = 0;
    let mut rows_out:      u64 = 0;
    let mut rows_rejected: u64 = 0;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // 1. Parse del campo sorgente.
        let parsed: JVal = match parse_source(&row, &cfg.source_field) {
            Ok(v) => v,
            Err(reason) => {
                if cfg.has_reject {
                    let mut rej = row.clone();
                    rej.0.insert("_reject_reason".into(), Value::String(reason));
                    send_to(&mut outputs, "reject", rej).await;
                    rows_rejected += 1;
                }
                continue;
            }
        };

        // 2. Per ogni flow.
        for flow in &cfg.flows {
            let target = match resolve_json_path(&parsed, &flow.json_path) {
                Some(t) if !t.is_null() => t,
                _ => continue, // path non trovato: flusso vuoto per questa riga
            };

            // 3. is_array → itera; altrimenti singolo.
            let elements: Vec<&JVal> = if flow.is_array {
                match target {
                    JVal::Array(a) => a.iter().collect(),
                    other          => vec![other],
                }
            } else {
                match target {
                    JVal::Array(a) => a.first().into_iter().collect(),
                    other          => vec![other],
                }
            };

            for element in elements {
                match process_element(element, &parsed, flow) {
                    ProcessResult::Row(mut out) => {
                        if flow.merge_parent {
                            let parent = build_parent_data(&row, &cfg.source_field, flow);
                            // I campi del flusso hanno precedenza sui campi del padre.
                            for (k, v) in parent.0 {
                                out.0.entry(k).or_insert(v);
                            }
                        }
                        send_to(&mut outputs, &flow.id, out).await;
                        rows_out += 1;
                    }
                    ProcessResult::Skip => {}
                    ProcessResult::Reject(mut out) => {
                        if cfg.has_reject {
                            out.0.insert("_reject_reason".into(),
                                         Value::String("missing_required_field".into()));
                            out.0.insert("_source_flow".into(),
                                         Value::String(flow.label.clone()));
                            send_to(&mut outputs, "reject", out).await;
                        }
                        rows_rejected += 1;
                    }
                }
            }
        }
    }

    let stats = NodeStats {
        rows_in,
        rows_out,
        rows_rejected,
        elapsed_ms: start.elapsed().as_millis() as u64,
        error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Parse del campo sorgente ──────────────────────────────────────
// Stringa → JSON.parse; oggetto già strutturato → to_json; altro → err.

fn parse_source(row: &Row, source_field: &str) -> Result<JVal, String> {
    match row.0.get(source_field) {
        None | Some(Value::Null) => Err("source_field_missing".into()),
        Some(Value::String(s)) => {
            serde_json::from_str::<JVal>(s).map_err(|_| "invalid_json".into())
        }
        Some(Value::Object(v)) => Ok(v.clone()),
        // Un campo già strutturato (es. JSONB letto da DB) → serializza e
        // reinterpreta come albero JSON navigabile.
        Some(other) => Ok(other.to_json()),
    }
}

// ─── Invio su un handle (se collegato) ─────────────────────────────

async fn send_to(outputs: &mut HashMap<String, RowSender>, handle: &str, row: Row) {
    if let Some(tx) = outputs.get(handle) {
        let _ = tx.send(row).await;
    }
    // handle non collegato → riga scartata (nessun consumatore)
}

// ─── Elabora un elemento del flusso ────────────────────────────────

enum ProcessResult { Row(Row), Skip, Reject(Row) }

fn process_element(element: &JVal, root: &JVal, flow: &JsonParserFlow) -> ProcessResult {
    let mut out = Row(HashMap::new());
    let mut should_reject = false;

    for field in &flow.fields {
        let raw = resolve_field_value(element, root, &field.json_path, &flow.json_path);

        let is_missing = matches!(raw, None | Some(JVal::Null));
        if is_missing {
            match field.on_missing.as_str() {
                "null"    => { out.0.insert(field.name.clone(), Value::Null); }
                "default" => {
                    let v = field.default_value.clone()
                        .map(Value::String).unwrap_or(Value::Null);
                    out.0.insert(field.name.clone(), v);
                }
                "skip"    => return ProcessResult::Skip,
                "error"   => { should_reject = true; out.0.insert(field.name.clone(), Value::Null); }
                _         => { out.0.insert(field.name.clone(), Value::Null); }
            }
            continue;
        }

        let val = Value::from_json(raw.unwrap().clone());
        out.0.insert(field.name.clone(), apply_transform(val, &field.transform));
    }

    if should_reject { ProcessResult::Reject(out) } else { ProcessResult::Row(out) }
}

// ─── Costruisce i campi del padre (master-detail) ──────────────────

fn build_parent_data(input_row: &Row, source_field: &str, flow: &JsonParserFlow) -> Row {
    let mut parent = Row(HashMap::new());
    if flow.parent_fields.is_empty() {
        for (k, v) in &input_row.0 {
            if k != source_field { parent.0.insert(k.clone(), v.clone()); }
        }
    } else {
        for fname in &flow.parent_fields {
            if let Some(v) = input_row.0.get(fname) {
                parent.0.insert(fname.clone(), v.clone());
            }
        }
    }
    parent
}

// ─── Risolve il valore di un campo (relativo con fallback assoluto) ─
// Replica resolveFieldValue del JS: prova il path relativo all'elemento,
// poi il path assoluto sul documento radice.

fn resolve_field_value<'a>(
    element:   &'a JVal,
    root:      &'a JVal,
    field_path: &str,
    flow_path:  &str,
) -> Option<JVal> {
    if field_path == "$" { return Some(element.clone()); }

    let normalized_flow = flow_path.trim_end_matches("[*]").trim_end_matches('.');
    let prefix_bracket = format!("{}[*].", normalized_flow);
    let prefix_dot     = format!("{}.", normalized_flow);

    let relative_path: String = if field_path.starts_with(&prefix_bracket) {
        format!("$.{}", &field_path[prefix_bracket.len()..])
    } else if field_path.starts_with(&prefix_dot) {
        format!("$.{}", &field_path[prefix_dot.len()..])
    } else if field_path == normalized_flow
           || field_path == format!("{}[*]", normalized_flow) {
        return Some(element.clone());
    } else {
        field_path.to_string()
    };

    // Prova sull'elemento.
    if let Some(v) = resolve_json_path(element, &relative_path) {
        if !v.is_null() { return Some(v.clone()); }
    }
    // Fallback: path assoluto sul root.
    if let Some(v) = resolve_json_path(root, field_path) {
        if !v.is_null() { return Some(v.clone()); }
    }
    None
}

// ─── JSONPath (replica fedele del resolveJsonPath JS) ──────────────
// Gestisce: `$`, `$.a.b`, `a[*]` (wildcard finale), `key[idx]`.
// NON è JSONPath completo: stesso sottoinsieme (e limiti) del JS.

fn resolve_json_path<'a>(data: &'a JVal, path: &str) -> Option<&'a JVal> {
    if path.is_empty() || path == "$" { return Some(data); }

    // Rimuove il prefisso "$." o "$"
    let mut p = path.strip_prefix('$').unwrap_or(path);
    p = p.strip_prefix('.').unwrap_or(p);
    if p.is_empty() { return Some(data); }

    // Wildcard finale [*]: naviga fino al contenitore (l'iterazione la
    // fa il chiamante). Rimuove il suffisso.
    let p = p.strip_suffix("[*]").map(|s| s.trim_end_matches('.')).unwrap_or(p);

    let mut cur = data;
    for part in p.split('.').filter(|s| !s.is_empty()) {
        // key[idx]
        if let Some(open) = part.find('[') {
            if part.ends_with(']') {
                let key = &part[..open];
                let idx_str = &part[open + 1..part.len() - 1];
                if !key.is_empty() {
                    cur = cur.get(key)?;
                }
                if let Ok(idx) = idx_str.parse::<usize>() {
                    cur = cur.get(idx)?;
                } else {
                    return None;
                }
                continue;
            }
        }
        cur = cur.get(part)?;
    }
    Some(cur)
}

// ─── Trasformazioni per campo ──────────────────────────────────────
// none|trim|uppercase|lowercase|to_integer|to_decimal|to_boolean|
// to_date|to_string. Fedeli al JS.

fn apply_transform(val: Value, transform: &str) -> Value {
    if matches!(val, Value::Null) { return val; }
    let s = val.as_str_repr();
    match transform {
        "none"      => val,
        "trim"      => Value::String(s.trim().to_string()),
        "uppercase" => Value::String(s.to_uppercase()),
        "lowercase" => Value::String(s.to_lowercase()),
        "to_integer" => {
            let cleaned: String = s.chars().filter(|c| c.is_ascii_digit() || *c == '-').collect();
            cleaned.parse::<i64>().map(Value::Int).unwrap_or(Value::Null)
        }
        "to_decimal" => {
            s.replace(',', ".").parse::<f64>().map(Value::Float).unwrap_or(Value::Null)
        }
        "to_boolean" => {
            let l = s.to_lowercase();
            Value::Bool(matches!(l.as_str(), "true"|"1"|"yes"|"si"|"sì"|"on"))
        }
        "to_date" => {
            // Fedele al JS: prende la parte data ISO se parsabile.
            // Il motore non ha un parser date completo: teniamo la stringa
            // così com'è se già in forma YYYY-MM-DD, altrimenti Date(s).
            Value::Date(s)
        }
        "to_string" => Value::String(s),
        _           => val,
    }
}