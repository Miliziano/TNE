// ─── XML Parser (nodo ricco, multi-flusso) ─────────────────────────
//
// Porting in Rust dell'executor JS (src/runner/xmlParserExecutor.ts).
// Il JS navigava un DOM (DOMParser del browser). In Rust costruiamo un
// mini-DOM in memoria con quick-xml (stream parser) e lo navighiamo
// replicando la logica JS: navigazione per NOME di tag (non XPath
// completo), attributi @attr, text(), ignore_namespaces (localName vs
// tagName), e la risoluzione campo con fallback per-antenato
// (isAncestorOf) usata dai path assoluti (master-detail impliciti).
//
// Config in spec.config (node-spec §21). Multi-output: un handle per
// flow + reject. `filter` per-flow: non presente in questo nodo.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config (da spec.config) ───────────────────────────────────────

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct XmlParserConfig {
    #[serde(default)] source_field: String,
    #[serde(default)] has_reject: bool,
    #[serde(default)] flows: Vec<XmlParserFlow>,
    #[serde(default = "d_true")] ignore_namespaces: bool,
    #[serde(default = "d_true")] trim_text: bool,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct XmlParserFlow {
    #[serde(default)] id: String,
    #[serde(default)] label: String,
    #[serde(default)] xpath: String,
    #[serde(default)] is_repeating: bool,
    #[serde(default)] #[allow(dead_code)] streaming: bool,
    #[serde(default)] fields: Vec<XmlParserField>,
}

#[derive(Debug, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
struct XmlParserField {
    #[serde(default)] name: String,
    #[serde(default)] xpath: String,
    #[serde(default)] #[allow(dead_code)] r#type: String,
    #[serde(default)] #[allow(dead_code)] is_attribute: bool,
    #[serde(default = "d_none")] transform: String,
    #[serde(default = "d_null")] on_missing: String,
    #[serde(default)] default_value: Option<String>,
}

fn d_true() -> bool { true }
fn d_none() -> String { "none".into() }
fn d_null() -> String { "null".into() }

// ─── Mini-DOM ──────────────────────────────────────────────────────
// Albero in memoria da quick-xml. `parent` è l'indice del nodo padre
// nell'arena (per isAncestorOf). I nodi vivono in un Vec (arena) e si
// referenziano per indice.

#[derive(Debug, Default)]
struct XmlNode {
    tag_name:   String,         // nome con prefisso ns (es. "dc:title")
    local_name: String,         // nome senza prefisso (es. "title")
    attrs:      HashMap<String, String>,
    children:   Vec<usize>,
    parent:     Option<usize>,
    text:       String,
}

struct XmlDom {
    nodes: Vec<XmlNode>,
    root:  Option<usize>,
}

impl XmlDom {
    fn name<'a>(&'a self, idx: usize, ignore_ns: bool) -> &'a str {
        if ignore_ns { &self.nodes[idx].local_name } else { &self.nodes[idx].tag_name }
    }

    /// textContent approssimato: testo diretto + figli, trimmato.
    fn text_content(&self, idx: usize) -> String {
        let mut out = String::new();
        self.collect_text(idx, &mut out);
        out.trim().to_string()
    }

    fn collect_text(&self, idx: usize, out: &mut String) {
        out.push_str(&self.nodes[idx].text);
        for &c in &self.nodes[idx].children {
            self.collect_text(c, out);
        }
    }

    fn is_ancestor_of(&self, candidate: usize, mut el: usize) -> bool {
        while let Some(p) = self.nodes[el].parent {
            if p == candidate { return true; }
            el = p;
        }
        false
    }
}

// ─── Parsing XML → mini-DOM ────────────────────────────────────────

fn parse_xml(xml: &str, trim_text: bool) -> Result<XmlDom, String> {
    let mut reader = Reader::from_str(xml);
    reader.config_mut().trim_text(trim_text);

    let mut nodes: Vec<XmlNode> = Vec::new();
    let mut stack: Vec<usize> = Vec::new();
    let mut root: Option<usize> = None;

    let split_name = |raw: &[u8]| -> (String, String) {
        let full = String::from_utf8_lossy(raw).to_string();
        let local = full.rsplit(':').next().unwrap_or(&full).to_string();
        (full, local)
    };

    // Estrae attributi da un tag start/empty.
    macro_rules! read_attrs {
        ($e:expr) => {{
            let mut attrs = HashMap::new();
            for a in $e.attributes().flatten() {
                let key_full = String::from_utf8_lossy(a.key.as_ref()).to_string();
                let key = key_full.rsplit(':').next().unwrap_or(&key_full).to_string();
                let val = a.decode_and_unescape_value(reader.decoder())
                    .map(|c| c.into_owned()).unwrap_or_default();
                attrs.insert(key, val);
            }
            attrs
        }};
    }

    loop {
        match reader.read_event() {
            Ok(Event::Start(e)) => {
                let (tag_name, local_name) = split_name(e.name().as_ref());
                let attrs = read_attrs!(e);
                let idx = nodes.len();
                let parent = stack.last().copied();
                nodes.push(XmlNode { tag_name, local_name, attrs,
                    children: Vec::new(), parent, text: String::new() });
                if let Some(p) = parent { nodes[p].children.push(idx); }
                if root.is_none() { root = Some(idx); }
                stack.push(idx);
            }
            Ok(Event::Empty(e)) => {
                let (tag_name, local_name) = split_name(e.name().as_ref());
                let attrs = read_attrs!(e);
                let idx = nodes.len();
                let parent = stack.last().copied();
                nodes.push(XmlNode { tag_name, local_name, attrs,
                    children: Vec::new(), parent, text: String::new() });
                if let Some(p) = parent { nodes[p].children.push(idx); }
                if root.is_none() { root = Some(idx); }
            }
            Ok(Event::Text(e)) => {
                if let Some(&cur) = stack.last() {
                    let t = e.decode().map(|c| c.into_owned()).unwrap_or_default();
                    nodes[cur].text.push_str(&t);
                }
            }
            Ok(Event::CData(e)) => {
                if let Some(&cur) = stack.last() {
                    let t = String::from_utf8_lossy(e.as_ref()).to_string();
                    nodes[cur].text.push_str(&t);
                }
            }
            Ok(Event::End(_)) => { stack.pop(); }
            Ok(Event::Eof) => break,
            Err(e) => return Err(format!("XML non valido: {}", e)),
            _ => {}
        }
    }

    if root.is_none() { return Err("XML vuoto o senza root".into()); }
    Ok(XmlDom { nodes, root })
}

// ─── Navigazione per nome (replica navigatePath / navigatePathAll) ─

fn navigate_path_all(dom: &XmlDom, path: &str, ignore_ns: bool) -> Vec<usize> {
    let parts: Vec<&str> = path.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() { return dom.root.into_iter().collect(); }

    let mut current: Vec<usize> = dom.root.into_iter().collect();
    for (i, part) in parts.iter().enumerate() {
        if i == 0 && current.len() == 1 && dom.name(current[0], ignore_ns) == *part {
            continue;
        }
        let mut next = Vec::new();
        for &el in &current {
            for &c in &dom.nodes[el].children {
                if dom.name(c, ignore_ns) == *part { next.push(c); }
            }
        }
        current = next;
        if current.is_empty() { return Vec::new(); }
    }
    current
}

// ─── Trova gli elementi target di un flusso (findFlowElements) ─────

fn find_flow_elements(dom: &XmlDom, flow: &XmlParserFlow, ignore_ns: bool) -> Vec<usize> {
    let xpath = flow.xpath.replace("[*]", "");
    let parts: Vec<&str> = xpath.split('/').filter(|s| !s.is_empty()).collect();
    if parts.is_empty() { return dom.root.into_iter().collect(); }

    let last_name = parts[parts.len() - 1];
    let parent_parts = &parts[..parts.len() - 1];

    let mut parents: Vec<usize> = dom.root.into_iter().collect();
    for part in parent_parts {
        if parents.len() == 1 && dom.name(parents[0], ignore_ns) == *part { continue; }
        let mut next = Vec::new();
        for &el in &parents {
            for &c in &dom.nodes[el].children {
                if dom.name(c, ignore_ns) == *part { next.push(c); }
            }
        }
        parents = next;
        if parents.is_empty() { return Vec::new(); }
    }

    let mut result = Vec::new();
    for &parent in &parents {
        if dom.name(parent, ignore_ns) == last_name {
            result.push(parent);
        } else {
            for &c in &dom.nodes[parent].children {
                if dom.name(c, ignore_ns) == last_name { result.push(c); }
            }
        }
    }
    result
}

// ─── Risolve il valore di un campo su un elemento ──────────────────

fn resolve_field_on_element(
    dom: &XmlDom,
    element: usize,
    field: &XmlParserField,
    flow_xpath: &str,
    ignore_ns: bool,
) -> Option<String> {
    let clean_flow = flow_xpath.replace("[*]", "");
    let clean_flow = clean_flow.trim_end_matches('/');
    let clean_field = field.xpath.replace("[*]", "");

    // Caso 1: path relativo (non inizia con '/').
    if !clean_field.starts_with('/') {
        if let Some(attr) = clean_field.strip_prefix('@') {
            return dom.nodes[element].attrs.get(attr).cloned();
        }
        if clean_field == "text()" {
            return Some(dom.text_content(element));
        }
        return navigate_relative(dom, element, &clean_field, ignore_ns);
    }

    // Caso 2: path assoluto sotto il flusso corrente.
    if let Some(rel) = clean_field.strip_prefix(&format!("{}/", clean_flow)) {
        if let Some(attr) = rel.strip_prefix('@') {
            return dom.nodes[element].attrs.get(attr).cloned();
        }
        if rel == "text()" { return Some(dom.text_content(element)); }
        return navigate_relative(dom, element, rel, ignore_ns);
    } else if clean_field == clean_flow {
        return Some(dom.text_content(element));
    } else {
        // Path assoluto non sotto il flusso: naviga dal documento e prendi
        // il candidato ANTENATO dell'elemento corrente.
        let (elem_path, attr_name) = match clean_field.rfind("/@") {
            Some(idx) => (clean_field[..idx].to_string(),
                          Some(clean_field[idx + 2..].to_string())),
            None      => (clean_field.clone(), None),
        };
        let candidates = navigate_path_all(dom, &elem_path, ignore_ns);
        for &cand in &candidates {
            if dom.is_ancestor_of(cand, element) {
                return match &attr_name {
                    Some(a) => dom.nodes[cand].attrs.get(a).cloned(),
                    None    => Some(dom.text_content(cand)),
                };
            }
        }
        if candidates.len() == 1 {
            return match &attr_name {
                Some(a) => dom.nodes[candidates[0]].attrs.get(a).cloned(),
                None    => Some(dom.text_content(candidates[0])),
            };
        }
        None
    }
}

// Naviga un path relativo dall'elemento; gestisce @attr finale e text().
fn navigate_relative(dom: &XmlDom, element: usize, path: &str, ignore_ns: bool) -> Option<String> {
    if let Some(at) = path.rfind("/@") {
        let elem_path = &path[..at];
        let attr = &path[at + 2..];
        let target = navigate_relative_elem(dom, element, elem_path, ignore_ns)?;
        return dom.nodes[target].attrs.get(attr).cloned();
    }
    if path == "text()" || path.ends_with("/text()") {
        let clean = path.strip_suffix("/text()").unwrap_or("");
        let target = if clean.is_empty() { element }
                     else { navigate_relative_elem(dom, element, clean, ignore_ns)? };
        return Some(dom.text_content(target));
    }
    let target = navigate_relative_elem(dom, element, path, ignore_ns)?;
    Some(dom.text_content(target))
}

fn navigate_relative_elem(dom: &XmlDom, start: usize, path: &str, ignore_ns: bool) -> Option<usize> {
    let mut current = start;
    for part in path.split('/').filter(|s| !s.is_empty()) {
        let found = dom.nodes[current].children.iter()
            .copied().find(|&c| dom.name(c, ignore_ns) == part)?;
        current = found;
    }
    Some(current)
}

// ─── Elabora un elemento del flusso ────────────────────────────────

enum ProcessResult { Row(Row), Skip, Reject(Row) }

fn process_element(
    dom: &XmlDom,
    element: usize,
    flow: &XmlParserFlow,
    ignore_ns: bool,
    trim_text: bool,
) -> ProcessResult {
    let mut out = Row(HashMap::new());
    let mut should_reject = false;

    for field in &flow.fields {
        let mut raw = resolve_field_on_element(dom, element, field, &flow.xpath, ignore_ns);
        if trim_text {
            if let Some(s) = raw { raw = Some(s.trim().to_string()); }
        }

        let missing = raw.is_none() || matches!(&raw, Some(s) if s.is_empty());
        if missing {
            match field.on_missing.as_str() {
                "null"    => { out.0.insert(field.name.clone(), Value::Null); }
                "default" => {
                    let v = field.default_value.clone().map(Value::String).unwrap_or(Value::Null);
                    out.0.insert(field.name.clone(), v);
                }
                "skip"    => return ProcessResult::Skip,
                "error"   => { should_reject = true; out.0.insert(field.name.clone(), Value::Null); }
                _         => { out.0.insert(field.name.clone(), Value::Null); }
            }
            continue;
        }

        let val = Value::String(raw.unwrap());
        out.0.insert(field.name.clone(), apply_transform(val, &field.transform));
    }

    if should_reject { ProcessResult::Reject(out) } else { ProcessResult::Row(out) }
}

// ─── Entry point ───────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("xml_parser {}: {}", ctx.node_id.0, e))?;
    let cfg: XmlParserConfig = serde_json::from_value(spec.config().clone())
        .map_err(|e| format!("xml_parser {}: config non valida: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("xml_parser", &ctx.node_id.0);

    if cfg.source_field.is_empty() {
        return Err(format!("xml_parser {}: campo sorgente non configurato.", ctx.node_id.0));
    }
    if cfg.flows.is_empty() {
        return Err(format!("xml_parser {}: nessun flusso configurato.", ctx.node_id.0));
    }

    let mut rx = rx.ok_or_else(||
        format!("xml_parser {} richiede un input collegato", ctx.node_id.0))?;

    let start = Instant::now();
    let mut rows_in:       u64 = 0;
    let mut rows_out:      u64 = 0;
    let mut rows_rejected: u64 = 0;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        let xml_string = match row.0.get(&cfg.source_field) {
            None | Some(Value::Null) => {
                if cfg.has_reject {
                    let mut rej = row.clone();
                    rej.0.insert("_reject_reason".into(), Value::String("source_field_missing".into()));
                    send_to(&mut outputs, "reject", rej).await;
                    rows_rejected += 1;
                }
                continue;
            }
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.as_str_repr(),
        };

        let dom = match parse_xml(&xml_string, cfg.trim_text) {
            Ok(d) => d,
            Err(_) => {
                if cfg.has_reject {
                    let mut rej = row.clone();
                    rej.0.insert("_reject_reason".into(), Value::String("invalid_xml".into()));
                    send_to(&mut outputs, "reject", rej).await;
                    rows_rejected += 1;
                }
                continue;
            }
        };

        for flow in &cfg.flows {
            let elements = find_flow_elements(&dom, flow, cfg.ignore_namespaces);
            if elements.is_empty() { continue; }

            let targets: Vec<usize> = if flow.is_repeating {
                elements
            } else {
                vec![elements[0]]
            };

            for element in targets {
                match process_element(&dom, element, flow, cfg.ignore_namespaces, cfg.trim_text) {
                    ProcessResult::Row(out) => {
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

async fn send_to(outputs: &mut HashMap<String, RowSender>, handle: &str, row: Row) {
    if let Some(tx) = outputs.get(handle) {
        let _ = tx.send(row).await;
    }
}

// ─── Trasformazioni per campo (fedeli al JS) ───────────────────────

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
        "to_date"   => Value::Date(s),
        "to_string" => Value::String(s),
        _           => val,
    }
}