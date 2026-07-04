// ─── src-tauri/src/engine/nodes/xml_serializer.rs (v2) ─────────────
//
// PORTING FEDELE di src/runner/xmlSerializerExecutor.ts.
//
// DUE PERCORSI (come il riferimento):
//   1. Albero (_treeNodes presente) → UN documento XML aggregato per
//      run: declaration + root (con namespace) + albero multi-flusso
//      con element/attribute/cdata/group, iterHandle, groupBy, dedup.
//      Output: UNA riga { output_field: xml }.
//   2. Nessun albero → serializzazione RIGA PER RIGA con struttura
//      legacy (xmlStructure) o auto (tutti i campi). Output: una riga
//      per input, campi originali + output_field.
//
// LIMITE DICHIARATO (B.2): expr e condition sono JavaScript nel
// riferimento — qui non eseguibili. Fallback allineato: expr sulle
// foglie → valore null (self-closing), sugli attributi/cdata → resta
// il valore del sourceField; condition → sempre vera. Warning nel log.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Strutture config ─────────────────────────────────────────────

#[derive(Debug, Deserialize)]
struct XmlPlan {
    #[serde(default = "d_output_field")]
    output_field:    String,
    #[serde(default = "d_root")]
    root_element:    String,
    #[serde(default)]
    root_ns_prefix:  String,
    #[serde(default)]
    root_namespace:  String,
    #[serde(default)]
    namespaces:      String,   // righe "prefix=uri"
    #[serde(default = "d_true")]
    xml_declaration: bool,
    #[serde(default = "d_enc")]
    encoding:        String,
    #[serde(default)]
    pretty:          bool,
    #[serde(default = "d_on_error")]
    on_error:        String,
    #[serde(default)]
    tree:            Vec<XmlTreeNode>,
    #[serde(default)]
    legacy:          Vec<XmlLegacyNode>,
    #[serde(default)]
    mappings:        HashMap<String, XmlMapping>,
}
fn d_output_field() -> String { "xml_output".into() }
fn d_root()         -> String { "record".into() }
fn d_enc()          -> String { "UTF-8".into() }
fn d_on_error()     -> String { "reject".into() }
fn d_true()         -> bool   { true }

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct XmlTreeNode {
    #[serde(default)]
    xml_name: String,
    #[serde(default)]
    ns:       String,
    #[serde(default)]
    kind:     String,   // element | attribute | cdata | group
    #[serde(default)]
    children: Vec<XmlTreeNode>,
    #[serde(default)]
    source_handle: Option<String>,
    #[serde(default)]
    source_field:  Option<String>,
    #[serde(default)]
    sources:       Option<Vec<XmlSourceRef>>,
    #[serde(default)]
    expr:          Option<String>,
    #[serde(default)]
    condition:     Option<String>,
    #[serde(default)]
    iter_handle:   Option<String>,
    #[serde(default)]
    group_by:      Option<String>,
}

#[derive(Debug, Deserialize, Clone)]
struct XmlSourceRef {
    #[serde(default)]
    handle: String,
    #[serde(default)]
    field:  String,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct XmlLegacyNode {
    #[serde(default)]
    xml_name:     String,
    #[serde(default)]
    source_field: String,
    #[serde(default)]
    kind:         String,
    #[serde(default)]
    namespace:    String,
    #[serde(default)]
    transform:    String,
    #[serde(default = "d_omit")]
    nullable:     String,   // omit | empty | xsi_nil
    #[serde(default)]
    children:     Option<Vec<XmlLegacyNode>>,
}
fn d_omit() -> String { "omit".into() }

#[derive(Debug, Deserialize, Clone)]
struct XmlMapping {
    #[serde(default)]
    fields: Vec<XmlMappingField>,
    #[serde(default)]
    dedup:  bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct XmlMappingField {
    #[serde(default)]
    source_field: String,
}

// ─── Entry point ──────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    inputs:  HashMap<String, RowReceiver>,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let plan: XmlPlan = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("xml_serializer config non valida: {}", e))?;

    let start = Instant::now();
    let mut rows_in = 0u64;

    // ── Bufferizza tutti i flussi per handle ──────────────────────
    let mut by_handle: HashMap<String, Vec<Row>> = HashMap::new();
    for (handle, mut rx) in inputs {
        let bucket = by_handle.entry(handle).or_default();
        while let Some(row) = rx.recv().await {
            rows_in += 1;
            bucket.push(row);
        }
    }

    eprintln!("[xml_serializer {}] handle ricevuti: {}",
        ctx.node_id.0,
        by_handle.iter().map(|(h, r)| format!("{}({})", h, r.len()))
            .collect::<Vec<_>>().join(", "));

    if tree_uses_js(&plan.tree) {
        eprintln!("[xml_serializer {}] ATTENZIONE: expr/condition JavaScript nell'albero \
                   non ancora supportati — expr foglia → null, condition → sempre vera",
                   ctx.node_id.0);
    }

    let out_tx    = outputs.remove("output");
    let reject_tx = outputs.remove("reject");

    let nl:  &str = if plan.pretty { "\n" } else { "" };

    // Root tag + namespace
    let root_tag = if plan.root_ns_prefix.is_empty() {
        plan.root_element.clone()
    } else {
        format!("{}:{}", plan.root_ns_prefix, plan.root_element)
    };
    let mut ns_attrs: Vec<String> = Vec::new();
    if !plan.root_namespace.is_empty() && !plan.root_ns_prefix.is_empty() {
        ns_attrs.push(format!("xmlns:{}=\"{}\"", plan.root_ns_prefix, plan.root_namespace));
    } else if !plan.root_namespace.is_empty() {
        ns_attrs.push(format!("xmlns=\"{}\"", plan.root_namespace));
    }
    for line in plan.namespaces.lines().map(|l| l.trim()).filter(|l| !l.is_empty()) {
        if let Some((prefix, uri)) = line.split_once('=') {
            let (prefix, uri) = (prefix.trim(), uri.trim());
            if !prefix.is_empty() && !uri.is_empty() {
                ns_attrs.push(format!("xmlns:{}=\"{}\"", prefix, uri));
            }
        }
    }
    let ns_str = if ns_attrs.is_empty() { String::new() } else { format!(" {}", ns_attrs.join(" ")) };

    let mut rows_out      = 0u64;
    let mut rows_rejected = 0u64;

    if !plan.tree.is_empty() {
        // ── Percorso 1: documento aggregato dall'albero ───────────
        let mut parts: Vec<String> = Vec::new();
        if plan.xml_declaration {
            parts.push(format!("<?xml version=\"1.0\" encoding=\"{}\"?>", plan.encoding));
        }
        let body = build_xml_from_tree(
            &plan.tree, &by_handle, &plan.mappings, &plan.tree, 1, plan.pretty, None);
        parts.push(format!("<{}{}>{}{}{}</{}>", root_tag, ns_str, nl, body, nl, root_tag));
        let xml = parts.join(nl);

        eprintln!("[xml_serializer {}] documento generato: {} caratteri",
            ctx.node_id.0, xml.len());

        let mut out = Row::new();
        out.set(plan.output_field.clone(), Value::String(xml));
        if let Some(tx) = &out_tx {
            if tx.send(out).await.is_ok() { rows_out = 1; }
        }
    } else {
        // ── Percorso 2: riga per riga (legacy / auto) ─────────────
        // Come il riferimento: usa l'handle 'input' se presente,
        // altrimenti tutte le righe ricevute (ordinate per handle).
        let rows: Vec<Row> = if let Some(r) = by_handle.get("input") {
            r.clone()
        } else {
            let mut handles: Vec<&String> = by_handle.keys().collect();
            handles.sort();
            handles.into_iter()
                .flat_map(|h| by_handle.get(h).unwrap().clone())
                .collect()
        };

        for row in rows {
            let xml = serialize_row(&row, &plan.legacy, &root_tag, &ns_str,
                plan.xml_declaration, &plan.encoding, plan.pretty);
            let mut out = row.clone();
            out.set(plan.output_field.clone(), Value::String(xml));
            if let Some(tx) = &out_tx {
                if tx.send(out).await.is_err() { break; }
                rows_out += 1;
            }
        }
    }

    // reject: nel porting Rust gli errori JS non esistono; il canale
    // resta cablato per gli errori futuri (B.2) e per coerenza col piano
    let _ = (&reject_tx, &mut rows_rejected, &plan.on_error);

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Costruzione dall'albero (fedele a buildXmlFromTree) ──────────

fn build_xml_from_tree(
    nodes:       &[XmlTreeNode],
    by_handle:   &HashMap<String, Vec<Row>>,
    mappings:    &HashMap<String, XmlMapping>,
    tree:        &[XmlTreeNode],
    indent:      usize,
    pretty:      bool,
    row_context: Option<&HashMap<String, Row>>,
) -> String {
    let pad: String = if pretty { "  ".repeat(indent) } else { String::new() };
    let nl:  &str   = if pretty { "\n" } else { "" };
    let mut parts: Vec<String> = Vec::new();

    for n in nodes {
        if n.kind == "attribute" { continue; }   // gestiti dal padre
        if n.xml_name.is_empty() { continue; }

        let tag = if n.ns.is_empty() { n.xml_name.clone() }
                  else { format!("{}:{}", n.ns, n.xml_name) };

        // Risolve la riga effettiva: contesto → prima riga dell'handle
        let get_row = |handle: &str,
                       ctx: Option<&HashMap<String, Row>>,
                       bh:  &HashMap<String, Vec<Row>>| -> Row {
            if let Some(c) = ctx {
                if let Some(r) = c.get(handle) { return r.clone(); }
            }
            bh.get(handle).and_then(|rows| rows.first().cloned()).unwrap_or_else(Row::new)
        };

        // Attributi (con il contesto corrente)
        let attr_nodes: Vec<&XmlTreeNode> = n.children.iter()
            .filter(|c| c.kind == "attribute").collect();
        let attrs_with = |ctx: Option<&HashMap<String, Row>>,
                          bh:  &HashMap<String, Vec<Row>>| -> String {
            attr_nodes.iter().map(|a| {
                let atag = if a.ns.is_empty() { a.xml_name.clone() }
                           else { format!("{}:{}", a.ns, a.xml_name) };
                let a_row = a.source_handle.as_deref()
                    .map(|h| get_row(h, ctx, bh))
                    .unwrap_or_else(Row::new);
                // expr JS non eseguibile: resta il valore del sourceField
                let a_val = a.source_field.as_deref()
                    .and_then(|f| a_row.get(f))
                    .filter(|v| !matches!(v, Value::Null))
                    .map(|v| v.as_str_repr());
                match a_val {
                    Some(v) => format!(" {}=\"{}\"", atag, escape_xml(&v)),
                    None    => String::new(),
                }
            }).collect::<Vec<_>>().join("")
        };
        let attr_str = attrs_with(row_context, by_handle);

        // ── CDATA ─────────────────────────────────────────────────
        if n.kind == "cdata" {
            let row = n.source_handle.as_deref()
                .map(|h| get_row(h, row_context, by_handle))
                .unwrap_or_else(Row::new);
            let val = n.source_field.as_deref()
                .and_then(|f| row.get(f))
                .filter(|v| !matches!(v, Value::Null))
                .map(|v| v.as_str_repr())
                .unwrap_or_default();
            parts.push(format!("{}<{}><![CDATA[{}]]></{}>", pad, tag, val, tag));
            continue;
        }

        // ── Elemento/group con figli strutturati ──────────────────
        let child_elms: Vec<XmlTreeNode> = n.children.iter()
            .filter(|c| c.kind != "attribute").cloned().collect();

        if n.kind == "group" || !child_elms.is_empty() {
            if let Some(iter_h) = n.iter_handle.as_deref().filter(|h| !h.is_empty()) {
                let dedup_f = collect_handle_fields(tree, iter_h);
                let rows = get_rows(iter_h, by_handle, mappings,
                    if dedup_f.is_empty() { None } else { Some(&dedup_f) });

                if let Some(group_field) = n.group_by.as_deref().filter(|g| !g.is_empty()) {
                    // groupBy: raggruppa preservando l'ordine di arrivo
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

                    let rendered: Vec<String> = order.into_iter().map(|k| {
                        let group_rows = groups.remove(&k).unwrap_or_default();
                        let mut group_bh = by_handle.clone();
                        group_bh.insert(iter_h.to_string(), group_rows.clone());
                        let mut ctx: HashMap<String, Row> =
                            row_context.cloned().unwrap_or_default();
                        if let Some(first) = group_rows.first() {
                            ctx.insert(iter_h.to_string(), first.clone());
                        }
                        // attributi calcolati con il contesto del GRUPPO
                        let group_attrs = attrs_with(Some(&ctx), &group_bh);
                        let inner = build_xml_from_tree(
                            &child_elms, &group_bh, mappings, tree,
                            indent + 1, pretty, Some(&ctx));
                        format!("{}<{}{}>{}{}{}{}</{}>",
                            pad, tag, group_attrs, nl, inner, nl, pad, tag)
                    }).collect();
                    parts.push(rendered.join(nl));
                } else {
                    // iterazione normale: byHandle resta COMPLETO
                    // (fedele al riferimento), il contesto porta la riga
                    let rendered: Vec<String> = rows.iter().map(|row| {
                        let mut ctx: HashMap<String, Row> =
                            row_context.cloned().unwrap_or_default();
                        ctx.insert(iter_h.to_string(), row.clone());
                        let inner = build_xml_from_tree(
                            &child_elms, by_handle, mappings, tree,
                            indent + 1, pretty, Some(&ctx));
                        format!("{}<{}{}>{}{}{}{}</{}>",
                            pad, tag, attr_str, nl, inner, nl, pad, tag)
                    }).collect();
                    parts.push(rendered.join(nl));
                }
            } else {
                // Wrapper senza iterazione
                let inner = build_xml_from_tree(
                    &child_elms, by_handle, mappings, tree,
                    indent + 1, pretty, row_context);
                parts.push(format!("{}<{}{}>{}{}{}{}</{}>",
                    pad, tag, attr_str, nl, inner, nl, pad, tag));
            }
            continue;
        }

        // ── Foglia con iterHandle: itera le righe raw dell'handle ──
        if let Some(iter_h) = n.iter_handle.as_deref().filter(|h| !h.is_empty()) {
            let iter_rows = by_handle.get(iter_h).cloned().unwrap_or_default();
            let iter_parts: Vec<String> = iter_rows.iter().filter_map(|irow| {
                // condition JS → sempre vera (B.2); expr → null
                let val = if n.expr.as_deref().map_or(false, |e| !e.trim().is_empty()) {
                    None
                } else {
                    n.source_field.as_deref()
                        .and_then(|f| irow.get(f))
                        .filter(|v| !matches!(v, Value::Null))
                        .map(|v| v.as_str_repr())
                };
                Some(match val {
                    None    => format!("{}<{}{}/>", pad, tag, attr_str),
                    Some(v) => format!("{}<{}{}>{}</{}>", pad, tag, attr_str, escape_xml(&v), tag),
                })
            }).collect();
            parts.push(iter_parts.join(nl));
            continue;
        }

        // ── Foglia semplice ───────────────────────────────────────
        let row = n.source_handle.as_deref()
            .map(|h| get_row(h, row_context, by_handle))
            .unwrap_or_else(Row::new);
        // expr JS → null (B.2, allineato al catch del riferimento)
        let val = if n.expr.as_deref().map_or(false, |e| !e.trim().is_empty()) {
            None
        } else {
            n.source_field.as_deref()
                .and_then(|f| row.get(f))
                .filter(|v| !matches!(v, Value::Null))
                .map(|v| v.as_str_repr())
        };
        // condition JS → sempre vera (B.2): il nodo non viene mai omesso

        match val {
            None    => parts.push(format!("{}<{}{}/>", pad, tag, attr_str)),
            Some(v) => parts.push(format!("{}<{}{}>{}</{}>",
                pad, tag, attr_str, escape_xml(&v), tag)),
        }
    }

    parts.join(nl)
}

// ─── Percorso riga-per-riga (legacy / auto) ───────────────────────

fn serialize_row(
    row:         &Row,
    legacy:      &[XmlLegacyNode],
    root_tag:    &str,
    ns_str:      &str,
    declaration: bool,
    encoding:    &str,
    pretty:      bool,
) -> String {
    let nl: &str = if pretty { "\n" } else { "" };
    let mut parts: Vec<String> = Vec::new();
    if declaration {
        parts.push(format!("<?xml version=\"1.0\" encoding=\"{}\"?>", encoding));
    }

    let body = if !legacy.is_empty() {
        build_xml_legacy(row, legacy, 1, pretty)
    } else {
        // Auto: tutti i campi (nullable=omit)
        let mut keys: Vec<&String> = row.0.keys()
            .filter(|k| !k.starts_with("__")).collect();
        keys.sort();
        let auto: Vec<XmlLegacyNode> = keys.into_iter().map(|k| XmlLegacyNode {
            xml_name: k.clone(), source_field: k.clone(), kind: "element".into(),
            namespace: String::new(), transform: String::new(),
            nullable: "omit".into(), children: None,
        }).collect();
        build_xml_legacy(row, &auto, 1, pretty)
    };

    parts.push(format!("<{}{}>{}{}{}</{}>", root_tag, ns_str, nl, body, nl, root_tag));
    parts.join(nl)
}

fn build_xml_legacy(row: &Row, nodes: &[XmlLegacyNode], indent: usize, pretty: bool) -> String {
    let pad: String = if pretty { "  ".repeat(indent) } else { String::new() };
    let nl:  &str   = if pretty { "\n" } else { "" };
    let mut parts: Vec<String> = Vec::new();

    for n in nodes {
        if n.xml_name.is_empty() || n.kind == "attribute" { continue; }
        let tag = if n.namespace.is_empty() { n.xml_name.clone() }
                  else { format!("{}:{}", n.namespace, n.xml_name) };
        let raw = if n.source_field.is_empty() { None }
                  else { row.get(&n.source_field).filter(|v| !matches!(v, Value::Null)).cloned() };
        let is_null = raw.is_none();

        if n.kind == "cdata" {
            if is_null && n.nullable == "omit" { continue; }
            let v = raw.map(|v| apply_transform(&v.as_str_repr(), &n.transform)).unwrap_or_default();
            parts.push(format!("{}<{}><![CDATA[{}]]></{}>", pad, tag, v, tag));
            continue;
        }

        let children = n.children.as_deref().unwrap_or(&[]);
        if n.kind == "group" || !children.is_empty() {
            let attrs: String = children.iter()
                .filter(|c| c.kind == "attribute")
                .filter_map(|a| {
                    let v = if a.source_field.is_empty() { None }
                            else { row.get(&a.source_field).filter(|v| !matches!(v, Value::Null)).cloned() }?;
                    let atag = if a.namespace.is_empty() { a.xml_name.clone() }
                               else { format!("{}:{}", a.namespace, a.xml_name) };
                    Some(format!(" {}=\"{}\"",
                        atag, escape_xml(&apply_transform(&v.as_str_repr(), &a.transform))))
                }).collect();
            let child_elms: Vec<XmlLegacyNode> = children.iter()
                .filter(|c| c.kind != "attribute").cloned().collect();
            let inner = build_xml_legacy(row, &child_elms, indent + 1, pretty);
            if inner.is_empty() {
                parts.push(format!("{}<{}{}/>", pad, tag, attrs));
            } else {
                parts.push(format!("{}<{}{}>{}{}{}{}</{}>",
                    pad, tag, attrs, nl, inner, nl, pad, tag));
            }
            continue;
        }

        if is_null {
            match n.nullable.as_str() {
                "omit"    => continue,
                "empty"   => { parts.push(format!("{}<{}/>", pad, tag)); continue; }
                "xsi_nil" => { parts.push(format!("{}<{} xsi:nil=\"true\"/>", pad, tag)); continue; }
                _         => continue,
            }
        }

        let v = apply_transform(&raw.unwrap().as_str_repr(), &n.transform);
        parts.push(format!("{}<{}>{}</{}>", pad, tag, escape_xml(&v), tag));
    }

    parts.join(nl)
}

// ─── Helpers ──────────────────────────────────────────────────────

fn get_rows(
    handle:       &str,
    by_handle:    &HashMap<String, Vec<Row>>,
    mappings:     &HashMap<String, XmlMapping>,
    dedup_fields: Option<&Vec<String>>,
) -> Vec<Row> {
    let rows = by_handle.get(handle).cloned().unwrap_or_default();
    let mapping = mappings.get(handle);
    if !mapping.map_or(false, |m| m.dedup) { return rows; }

    let fields: Vec<String> = if let Some(f) = dedup_fields.filter(|f| !f.is_empty()) {
        (*f).clone()
    } else if let Some(m) = mapping.filter(|m| !m.fields.is_empty()) {
        m.fields.iter().map(|f| f.source_field.clone())
            .filter(|s| !s.is_empty()).collect()
    } else {
        let mut keys: Vec<String> = rows.first()
            .map(|r| r.0.keys().filter(|k| !k.starts_with("__")).cloned().collect())
            .unwrap_or_default();
        keys.sort();
        keys
    };

    if fields.is_empty() { return rows; }
    let mut seen = std::collections::HashSet::new();
    rows.into_iter().filter(|row| {
        let key = fields.iter()
            .map(|f| row.get(f)
                .filter(|v| !matches!(v, Value::Null))
                .map(|v| v.as_str_repr().trim().to_string())
                .unwrap_or_default())
            .collect::<Vec<_>>().join("\u{0}");
        seen.insert(key)
    }).collect()
}

fn collect_handle_fields(nodes: &[XmlTreeNode], handle: &str) -> Vec<String> {
    let mut fields: Vec<String> = Vec::new();
    fn walk(ns: &[XmlTreeNode], handle: &str, fields: &mut Vec<String>) {
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

fn apply_transform(s: &str, transform: &str) -> String {
    match transform {
        "to_int"    => s.trim().parse::<f64>().map(|n| (n as i64).to_string())
                        .unwrap_or_else(|_| "NaN".into()),
        "to_float"  => s.trim().replace(',', ".").parse::<f64>()
                        .map(|n| n.to_string()).unwrap_or_else(|_| "NaN".into()),
        "to_bool"   => matches!(s.to_lowercase().as_str(),
                        "true" | "1" | "yes" | "si" | "sì").to_string(),
        "to_date"   => s.split('T').next().unwrap_or(s).to_string(),
        "uppercase" => s.to_uppercase(),
        "lowercase" => s.to_lowercase(),
        "trim"      => s.trim().to_string(),
        _           => s.to_string(),
    }
}

fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
     .replace('\'', "&apos;")
}

fn tree_uses_js(nodes: &[XmlTreeNode]) -> bool {
    nodes.iter().any(|n|
        n.expr.as_deref().map_or(false, |e| !e.trim().is_empty())
        || n.condition.as_deref().map_or(false, |c| !c.trim().is_empty())
        || tree_uses_js(&n.children))
}