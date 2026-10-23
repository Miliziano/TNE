// ─── src-tauri/src/engine/nodes/source_file.rs ─────────────────────
//
// Legge un file e manda le righe a valle.
//
// P357 — allineato al pannello. Prima: jsonl/parquet/orc/avro/pdf/text
// letti come CSV; json e xml una riga col testo grezzo (jsonPath e
// struttura ignorati); percorso da variabile di lane o dal flusso
// ignorato; encoding, quote, escape, commento, righe da saltare, limite e
// glob ignorati; rinomina e trasformazioni del mapping perse; BOM UTF-8
// finito nel nome della prima colonna; campi tra virgolette su più righe
// spezzati.
//
// FORMATI
//   csv / tsv  righe tabellari: delimiter, quoteChar, escapeChar (dentro le
//              virgolette, prima di virgolette o di sé stesso),
//              commentChar, hasHeader, skipRows (righe fisiche iniziali,
//              prima dell'intestazione), limit (righe di dati, 0 = tutte).
//              Un campo tra virgolette può andare a capo.
//   excel      xlsx/xlsm/xlsb/xls/ods via calamine: sheetName, startRow,
//              hasHeader, limit.
//   json       il documento, con jsonPath ($, $.a.b, $.a[0].b) e
//              jsonStructure: object (default) → una riga col valore,
//              array → una riga per elemento. Campi: content (object),
//              raw (testo JSON).
//   jsonl      una riga per riga non vuota: content (object), raw.
//   xml        una riga: content (il testo, per l'XML Parser).
//   text       una riga per linea: line, line_number.
//   binary     una riga: data (base64 | hex, binaryEncoding), size, mime_type.
//   pdf_binary come binary, mime_type application/pdf.
//   Formati di testo: encoding utf-8 | utf-16 | iso-8859-1 | windows-1252 | ascii.
//
// PERCORSO (pathSource)
//   static   `path`, oppure `glob` (es. /data/*.csv): tutti i file che
//            corrispondono, in ordine di nome, letti uno dopo l'altro.
//   lane_var la variabile di lane `laneVarName`.
//   flow     il campo `pathField` della riga in ingresso (una sola: v.
//            source_input.rs, cardinalità 1).
//
// MAPPING (csv/tsv/excel) — config.fields dal builder:
//   [{ name (logico), physical (colonna nel file), type, transform }]
//   Se c'è, escono SOLO i campi mappati, col nome logico, trasformati
//   (trim | uppercase | lowercase | nullify_empty; legacy: to_int,
//   to_float, to_date, to_bool, to_string) e convertiti al tipo. Senza
//   mapping, tutte le colonne come testo.

use std::io::{BufRead, BufReader, Read};
use std::fs::File;
use std::time::Instant;
use base64::Engine as _;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, NodeContext, RowReceiver};
use crate::engine::text_encoding::{decode_text, decode_byte, is_single_byte, normalize};

#[derive(serde::Deserialize, Clone, Debug)]
struct FieldType {
    name: String,
    /// Colonna nel file; dal P357 il builder la manda a parte (prima `name`
    /// ERA la colonna fisica e il nome logico si perdeva).
    #[serde(default)]
    physical: String,
    #[serde(rename = "type")]
    ty:   String,
    #[serde(default)]
    transform: String,
}

impl FieldType {
    fn column(&self) -> &str { if self.physical.is_empty() { &self.name } else { &self.physical } }
}

const TABULAR: &[&str] = &["csv", "tsv", "excel", "xlsx", "xlsm", "xlsb", "xls", "ods"];
const FORMATS: &[&str] = &["csv", "tsv", "excel", "xlsx", "xlsm", "xlsb", "xls", "ods",
                           "json", "jsonl", "ndjson", "xml", "text", "txt", "binary", "pdf_binary"];

struct SourceFileConfig {
    format:     String,
    delimiter:  char,
    quote:      char,
    escape:     Option<char>,
    comment:    Option<char>,
    has_header: bool,
    skip_rows:  u64,
    limit:      u64,
    encoding:   String,
    fields:     Vec<FieldType>,
    sheet_name: String,
    start_row:  u64,
    json_path:  String,
    json_object: bool,
    binary_hex: bool,
}

fn one_char(s: &str) -> Option<char> {
    match s { "\\t" => Some('\t'), "" => None, _ => s.chars().next() }
}

fn config_from_spec(spec: &Spec) -> Result<SourceFileConfig, String> {
    let fields: Vec<FieldType> =
        serde_json::from_value(
            spec.config().get("fields").cloned().unwrap_or(serde_json::json!([]))
        ).map_err(|e| format!("invalid fields schema: {}", e))?;
    let format = spec.str_or("format", "csv").to_ascii_lowercase();
    let default_delim = if format == "tsv" { "\t" } else { "," };
    Ok(SourceFileConfig {
        delimiter:  one_char(&spec.str_or("delimiter", default_delim)).unwrap_or(','),
        quote:      one_char(&spec.str_or("quoteChar", "\"")).unwrap_or('"'),
        escape:     one_char(&spec.str_or("escapeChar", "\\")),
        comment:    one_char(spec.str_or("commentChar", "").trim()),
        // Il pannello salva `hasHeader` (camelCase).
        has_header: spec.bool_or("hasHeader", true),
        skip_rows:  spec.u64_or("skipRows", 0),
        limit:      spec.u64_or("limit", 0),
        encoding:   spec.str_or("encoding", "utf-8"),
        fields,
        sheet_name: spec.str_or("sheetName", ""),
        start_row:  spec.u64_or("startRow", 1).max(1),
        json_path:  spec.str_or("jsonPath", "$"),
        // Default "object" = tutto il valore in una riga: è ciò che il nodo
        // ha sempre fatto (i progetti esistenti col JSON Parser a valle
        // non cambiano). "array" = una riga per elemento.
        json_object: spec.str_or("jsonStructure", "object") != "array",
        binary_hex: spec.str_or("binaryEncoding", "base64") == "hex",
        format,
    })
}

const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;

// ─── Percorsi ──────────────────────────────────────────────────────

/// I file da leggere, secondo pathSource. `params` è la riga arrivata
/// sull'ingresso (pathSource = flow).
fn resolve_paths(spec: &Spec, ctx: &NodeContext, params: Option<&Row>) -> Result<Vec<String>, String> {
    match spec.str_or("pathSource", "static").as_str() {
        "lane_var" => {
            let var = spec.str_or("laneVarName", "");
            if var.is_empty() { return Err("path source is a lane variable, but no variable is selected".into()) }
            match ctx.variables.get(&var) {
                Some(Value::Null) | None => Err(format!("lane variable '{}' is not set", var)),
                Some(v) => Ok(vec![v.as_str_repr()]),
            }
        }
        "flow" => {
            let field = spec.str_or("pathField", "path");
            let Some(row) = params else {
                return Err(format!("path source is the incoming flow, but no row arrived (field '{}')", field));
            };
            match row.get(&field) {
                Some(Value::Null) | None => Err(format!("the incoming row has no '{}' field with the file path", field)),
                Some(v) => Ok(vec![v.as_str_repr()]),
            }
        }
        _ => {
            let glob = spec.str_or("glob", "");
            if glob.trim().is_empty() {
                let p = spec.str_or("path", "");
                if p.trim().is_empty() { return Err("no file path configured".into()) }
                return Ok(vec![p]);
            }
            expand_glob(glob.trim())
        }
    }
}

/// `/dir/*.csv` → i file della cartella il cui NOME corrisponde (`*`, `?`),
/// in ordine alfabetico. Il pattern vale solo sull'ultimo segmento.
fn expand_glob(pattern: &str) -> Result<Vec<String>, String> {
    let (dir, name_pat) = match pattern.rfind('/') {
        Some(i) => (if i == 0 { "/" } else { &pattern[..i] }, &pattern[i + 1..]),
        None    => (".", pattern),
    };
    if dir.contains('*') || dir.contains('?') {
        return Err(format!("glob '{}': wildcards are allowed only in the file name, not in the directory", pattern));
    }
    let entries = std::fs::read_dir(dir).map_err(|e| format!("glob '{}': cannot read '{}': {}", pattern, dir, e))?;
    let mut out: Vec<String> = entries.filter_map(|e| e.ok())
        .filter(|e| e.file_type().map(|t| t.is_file()).unwrap_or(false))
        .filter_map(|e| e.file_name().to_str().map(|s| s.to_string()))
        .filter(|n| wildcard(name_pat, n))
        .map(|n| if dir == "/" { format!("/{}", n) } else { format!("{}/{}", dir, n) })
        .collect();
    out.sort();
    Ok(out)
}

fn wildcard(pattern: &str, name: &str) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = (pattern.chars().collect(), name.chars().collect());
    let (mut pi, mut ti, mut star, mut mark) = (0usize, 0usize, usize::MAX, 0usize);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) { pi += 1; ti += 1; }
        else if pi < p.len() && p[pi] == '*' { star = pi; mark = ti; pi += 1; }
        else if star != usize::MAX { pi = star + 1; mark += 1; ti = mark; }
        else { return false }
    }
    while pi < p.len() && p[pi] == '*' { pi += 1 }
    pi == p.len()
}

// ─── Lettura per righe, con la codifica ────────────────────────────

/// Righe di testo di un file, decodificate. UTF-8 e codifiche a un byte in
/// streaming; UTF-16 (raro, file piccoli) decodificato tutto in memoria.
enum LineSource {
    Stream { r: BufReader<File>, enc: String, n: u64 },
    Mem    { lines: std::vec::IntoIter<String> },
}

impl LineSource {
    fn open(path: &str, encoding: &str) -> Result<LineSource, String> {
        let enc = normalize(encoding);
        let mut f = File::open(path).map_err(|e| format!("Cannot open '{}': {}", path, e))?;
        if matches!(enc.as_str(), "" | "utf-8" | "utf8") || is_single_byte(&enc) {
            return Ok(LineSource::Stream { r: BufReader::new(f), enc, n: 0 });
        }
        let mut bytes = Vec::new();
        f.read_to_end(&mut bytes).map_err(|e| format!("Read error on '{}': {}", path, e))?;
        let text = decode_text(&bytes, &enc)?;
        let lines: Vec<String> = text.lines().map(|l| l.to_string()).collect();
        Ok(LineSource::Mem { lines: lines.into_iter() })
    }

    fn next_line(&mut self) -> Option<Result<String, String>> {
        match self {
            LineSource::Mem { lines } => lines.next().map(Ok),
            LineSource::Stream { r, enc, n } => {
                let mut buf: Vec<u8> = Vec::new();
                match r.read_until(b'\n', &mut buf) {
                    Ok(0)  => None,
                    Err(e) => Some(Err(format!("Read error: {}", e))),
                    Ok(_)  => {
                        *n += 1;
                        while matches!(buf.last(), Some(b'\n') | Some(b'\r')) { buf.pop(); }
                        if *n == 1 && buf.starts_with(&[0xEF, 0xBB, 0xBF]) { buf.drain(..3); }
                        if is_single_byte(enc) {
                            Some(Ok(buf.iter().map(|b| decode_byte(*b, enc)).collect()))
                        } else {
                            Some(String::from_utf8(buf).map_err(|_| format!(
                                "line {} is not valid UTF-8: choose the right encoding in the panel", n)))
                        }
                    }
                }
            }
        }
    }
}

// ─── CSV ───────────────────────────────────────────────────────────

/// Campi di un record. `false` = record incompleto (virgolette aperte a
/// fine riga): il chiamante aggiunge la riga successiva e riprova.
fn parse_fields(text: &str, d: char, q: char, esc: Option<char>) -> (Vec<String>, bool) {
    let mut out = Vec::new();
    let mut cur = String::new();
    let (mut in_q, mut quoted) = (false, false);
    let chars: Vec<char> = text.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if in_q {
            if Some(c) == esc && esc != Some(q) && i + 1 < chars.len() && (chars[i + 1] == q || Some(chars[i + 1]) == esc) {
                cur.push(chars[i + 1]); i += 2; continue;
            }
            if c == q {
                if i + 1 < chars.len() && chars[i + 1] == q { cur.push(q); i += 2; continue; }
                in_q = false; i += 1; continue;
            }
            cur.push(c);
        } else if c == q && cur.trim().is_empty() {
            in_q = true; quoted = true; cur.clear();
        } else if c == d {
            out.push(if quoted { std::mem::take(&mut cur) } else { cur.trim().to_string() });
            cur.clear(); quoted = false;
        } else {
            cur.push(c);
        }
        i += 1;
    }
    if in_q { return (Vec::new(), false) }
    out.push(if quoted { cur } else { cur.trim().to_string() });
    (out, true)
}

/// Compatibilità (source_ftp): una riga, virgolette doppie, niente escape.
pub(crate) fn parse_csv_line(line: &str, delimiter: u8) -> Vec<String> {
    let (f, complete) = parse_fields(line, delimiter as char, '"', None);
    if complete { f } else { parse_fields(&format!("{}\"", line), delimiter as char, '"', None).0 }
}

/// Prossimo record CSV (anche su più righe fisiche). Salta righe vuote e
/// commenti.
fn next_record(src: &mut LineSource, c: &SourceFileConfig) -> Option<Result<Vec<String>, String>> {
    loop {
        let line = match src.next_line()? { Ok(l) => l, Err(e) => return Some(Err(e)) };
        if line.trim().is_empty() { continue }
        if let Some(cc) = c.comment { if line.trim_start().starts_with(cc) { continue } }
        let mut text = line;
        loop {
            let (fields, complete) = parse_fields(&text, c.delimiter, c.quote, c.escape);
            if complete { return Some(Ok(fields)) }
            match src.next_line() {
                Some(Ok(more)) => { text.push('\n'); text.push_str(&more); }
                Some(Err(e))   => return Some(Err(e)),
                None => return Some(Err("unterminated quoted field at the end of the file".into())),
            }
        }
    }
}

// ─── Mapping ───────────────────────────────────────────────────────

fn transform_text(s: &str, t: &str) -> Option<String> {
    match t {
        "trim"          => Some(s.trim().to_string()),
        "uppercase"     => Some(s.to_uppercase()),
        "lowercase"     => Some(s.to_lowercase()),
        "nullify_empty" => if s.trim().is_empty() { None } else { Some(s.to_string()) },
        _               => Some(s.to_string()),
    }
}

/// Le trasformazioni-conversione (legacy) valgono come tipo.
fn effective_type<'a>(f: &'a FieldType) -> &'a str {
    match f.transform.as_str() {
        "to_int" | "to_integer"  => "integer",
        "to_float" | "to_decimal" => "decimal",
        "to_date"   => "date",
        "to_bool" | "to_boolean" => "boolean",
        "to_string" => "string",
        _ => f.ty.as_str(),
    }
}

/// Riga del file (colonna → valore) → riga d'uscita secondo il mapping.
fn project(raw: &Row, fields: &[FieldType]) -> Row {
    if fields.is_empty() { return raw.clone() }
    let mut out = Row::new();
    for f in fields {
        let v = match raw.get(f.column()) {
            None | Some(Value::Null) => Value::Null,
            Some(v) => {
                let ty = effective_type(f);
                let is_text = matches!(v, Value::String(_));
                match transform_text(&v.as_str_repr(), &f.transform) {
                    None => Value::Null,
                    // Un valore già tipizzato (Excel) resta tale se non c'è
                    // niente da cambiare; il testo si converte al tipo.
                    Some(s) if is_text || !f.transform.is_empty() || !ty.is_empty() => coerce(&s, ty),
                    Some(_) => v.clone(),
                }
            }
        };
        out.set(f.name.clone(), v);
    }
    out
}

// ─── Lettori ───────────────────────────────────────────────────────

/// Invia una riga; false = il nodo a valle ha chiuso.
type Emit<'a> = &'a mut dyn FnMut(Row) -> bool;

fn read_csv(path: &str, c: &SourceFileConfig, budget: &mut u64, emit: Emit) -> Result<(), String> {
    let mut src = LineSource::open(path, &c.encoding)?;
    for _ in 0..c.skip_rows { if src.next_line().is_none() { return Ok(()) } }
    let mut headers: Vec<String> = Vec::new();
    let mut first = true;
    while *budget > 0 {
        let fields = match next_record(&mut src, c) { None => break, Some(r) => r? };
        if first && c.has_header {
            headers = fields.iter().enumerate()
                .map(|(i, h)| if h.is_empty() { format!("col_{}", i) } else { h.clone() }).collect();
            first = false;
            continue;
        }
        first = false;
        let mut row = Row::new();
        for (i, v) in fields.into_iter().enumerate() {
            let k = headers.get(i).cloned().unwrap_or_else(|| format!("col_{}", i));
            row.set(k, Value::String(v));
        }
        if !emit(project(&row, &c.fields)) { return Ok(()) }
        *budget -= 1;
    }
    Ok(())
}

fn read_text_lines(path: &str, c: &SourceFileConfig, budget: &mut u64, emit: Emit) -> Result<(), String> {
    let mut src = LineSource::open(path, &c.encoding)?;
    let mut n: i64 = 0;
    while *budget > 0 {
        let line = match src.next_line() { None => break, Some(l) => l? };
        n += 1;
        if (n as u64) <= c.skip_rows { continue }
        let mut row = Row::new();
        row.set("line".into(), Value::String(line));
        row.set("line_number".into(), Value::Int(n));
        if !emit(row) { return Ok(()) }
        *budget -= 1;
    }
    Ok(())
}

fn json_row(v: serde_json::Value) -> Row {
    let mut row = Row::new();
    row.set("raw".into(), Value::String(v.to_string()));
    row.set("content".into(), Value::Object(v));
    row
}

fn read_jsonl(path: &str, c: &SourceFileConfig, budget: &mut u64, emit: Emit) -> Result<(), String> {
    let mut src = LineSource::open(path, &c.encoding)?;
    let mut n = 0u64;
    while *budget > 0 {
        let line = match src.next_line() { None => break, Some(l) => l? };
        n += 1;
        if n <= c.skip_rows || line.trim().is_empty() { continue }
        let v: serde_json::Value = serde_json::from_str(&line)
            .map_err(|e| format!("line {} is not valid JSON: {}", n, e))?;
        if !emit(json_row(v)) { return Ok(()) }
        *budget -= 1;
    }
    Ok(())
}

/// `$`, `$.a.b`, `$.a[0].b`, `a.b` — navigazione semplice.
fn json_at<'a>(root: &'a serde_json::Value, path: &str) -> Result<&'a serde_json::Value, String> {
    let p = path.trim();
    let p = p.strip_prefix('$').unwrap_or(p);
    let mut cur = root;
    for seg in p.split('.').filter(|s| !s.is_empty()) {
        let (key, idx) = match seg.find('[') {
            Some(i) => (&seg[..i], Some(&seg[i..])),
            None    => (seg, None),
        };
        if !key.is_empty() {
            cur = cur.get(key).ok_or_else(|| format!("JSON path '{}': no '{}' key", path, key))?;
        }
        if let Some(ix) = idx {
            for part in ix.split('[').filter(|s| !s.is_empty()) {
                let n: usize = part.trim_end_matches(']').trim().parse()
                    .map_err(|_| format!("JSON path '{}': bad index '[{}'", path, part))?;
                cur = cur.get(n).ok_or_else(|| format!("JSON path '{}': index {} out of range", path, n))?;
            }
        }
    }
    Ok(cur)
}

fn read_json(path: &str, c: &SourceFileConfig, budget: &mut u64, emit: Emit) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read '{}': {}", path, e))?;
    let text = decode_text(&bytes, &c.encoding)?;
    let doc: serde_json::Value = serde_json::from_str(&text)
        .map_err(|e| format!("'{}' is not valid JSON: {}", path, e))?;
    let at = json_at(&doc, &c.json_path)?;
    match at {
        serde_json::Value::Array(items) if !c.json_object => {
            for it in items.iter() {
                if *budget == 0 || !emit(json_row(it.clone())) { break }
                *budget -= 1;
            }
        }
        other => { if *budget > 0 && emit(json_row(other.clone())) { *budget -= 1 } }
    }
    Ok(())
}

fn read_xml(path: &str, c: &SourceFileConfig, budget: &mut u64, emit: Emit) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read '{}': {}", path, e))?;
    let mut row = Row::new();
    row.set("content".into(), Value::String(decode_text(&bytes, &c.encoding)?));
    if *budget > 0 && emit(row) { *budget -= 1 }
    Ok(())
}

fn mime_of(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("").to_ascii_lowercase().as_str() {
        "pdf" => "application/pdf", "png" => "image/png", "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif", "zip" => "application/zip", "gz" => "application/gzip",
        "xlsx" => "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "json" => "application/json", "xml" => "application/xml", "csv" => "text/csv",
        "txt" => "text/plain", "html" | "htm" => "text/html",
        _ => "application/octet-stream",
    }
}

fn read_binary(path: &str, c: &SourceFileConfig, pdf: bool, budget: &mut u64, emit: Emit) -> Result<(), String> {
    let bytes = std::fs::read(path).map_err(|e| format!("cannot read '{}': {}", path, e))?;
    let data = if c.binary_hex {
        bytes.iter().map(|b| format!("{:02x}", b)).collect::<String>()
    } else {
        base64::engine::general_purpose::STANDARD.encode(&bytes)
    };
    let mut row = Row::new();
    row.set("data".into(), Value::String(data));
    row.set("mime_type".into(), Value::String(if pdf { "application/pdf".into() } else { mime_of(path).into() }));
    if !pdf { row.set("size".into(), Value::Int(bytes.len() as i64)); }
    if *budget > 0 && emit(row) { *budget -= 1 }
    Ok(())
}

/// Legge UN file nel formato configurato (thread bloccante).
fn read_one(path: &str, c: &SourceFileConfig, budget: &mut u64, emit: Emit) -> Result<(), String> {
    match c.format.as_str() {
        "csv" | "tsv" => read_csv(path, c, budget, emit),
        "excel" | "xlsx" | "xlsm" | "xlsb" | "xls" | "ods" => {
            // Celle col tipo naturale; la conversione al tipo dichiarato la
            // fa il mapping (project), come per il CSV.
            let none = std::collections::HashMap::new();
            for row in read_excel(path, &c.sheet_name, c.start_row, c.has_header, &none)? {
                if *budget == 0 || !emit(project(&row, &c.fields)) { break }
                *budget -= 1;
            }
            Ok(())
        }
        "json"  => read_json(path, c, budget, emit),
        "jsonl" | "ndjson" => read_jsonl(path, c, budget, emit),
        "xml"   => read_xml(path, c, budget, emit),
        "text" | "txt" => read_text_lines(path, c, budget, emit),
        "binary" => read_binary(path, c, false, budget, emit),
        "pdf_binary" => read_binary(path, c, true, budget, emit),
        other => Err(format!("format '{}' is not available", other)),
    }
}

pub async fn run(
    ctx: NodeContext,
    // R8 — "barriera + parametri": se il nodo ha un arco in ingresso si
    // aspetta che il nodo a monte finisca e se ne tiene la riga (al più
    // una). Con pathSource = flow il percorso viene da lì.
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {
    let params = super::source_input::await_params(&ctx.node_id.0, "source_file", rx).await?;

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_file {}: {}", ctx.node_id.0, e))?;
    let config = config_from_spec(&spec)
        .map_err(|e| format!("source_file {}: {}", ctx.node_id.0, e))?;
    let fail = |m: String| -> Result<NodeStats, String> {
        let msg = format!("source_file {}: {}", ctx.node_id.0, m);
        ctx.emit_failed(msg.clone());
        Err(msg)
    };
    if !FORMATS.contains(&config.format.as_str()) {
        return fail(format!("format '{}' is not available — choose CSV, TSV, Excel, JSON, JSON Lines, XML, text, binary or PDF (binary)", config.format));
    }
    let paths = match resolve_paths(&spec, &ctx, params.as_ref()) { Ok(p) => p, Err(e) => return fail(e) };
    spec.log_unconsumed("source_file", &ctx.node_id.0);
    if paths.is_empty() {
        ctx.emit_log(&ctx.label, "warn", 0, "no file matches the glob pattern".into(), "panel");
    }

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    // Lettura in un thread bloccante (std::io), righe verso il task async
    // su un canale: lo streaming resta anche per file grandi.
    let (row_tx, mut row_rx) = tokio::sync::mpsc::channel::<Result<Row, String>>(1000);
    // I formati a schema fisso non si mappano: i campi sono quelli del formato.
    let mut c = config;
    if !TABULAR.contains(&c.format.as_str()) { c.fields.clear(); }
    let multi = paths.len() > 1;
    let reader = tokio::task::spawn_blocking(move || {
        let mut budget = if c.limit == 0 { u64::MAX } else { c.limit };
        for p in &paths {
            let mut emit = |r: Row| row_tx.blocking_send(Ok(r)).is_ok();
            if let Err(e) = read_one(p, &c, &mut budget, &mut emit) {
                let msg = if multi { format!("{}: {}", p, e) } else { e };
                let _ = row_tx.blocking_send(Err(msg));
                return;
            }
            if budget == 0 { break }
        }
    });

    let mut rows_out: u64 = 0;
    let start = Instant::now();
    let mut last_progress = Instant::now();
    while let Some(result) = row_rx.recv().await {
        match result {
            Err(e) => { drop(row_rx); let _ = reader.await; return fail(e) }
            Ok(row) => {
                if tx.send(row).await.is_err() { break }
                rows_out += 1;
                if rows_out % PROGRESS_EVERY_ROWS == 0
                    || last_progress.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS {
                    let rps = rows_out as f64 / start.elapsed().as_secs_f64().max(0.001);
                    ctx.emit_progress(rows_out, rows_out, 0, rps);
                    last_progress = Instant::now();
                }
            }
        }
    }
    drop(row_rx);
    let _ = reader.await;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

/// Converte il testo di una cella CSV nel Value corrispondente al tipo
/// dichiarato nel mapping. Un valore non convertibile diventa Null:
/// meglio un null visibile che uno zero silenzioso.
// ─── Excel / OpenDocument (P342) ──────────────────────────────────

/// Testo di una cella, nella forma che avrebbe in un CSV esportato.
fn excel_text(cell: &calamine::Data) -> String {
    use calamine::Data;
    match cell {
        Data::Empty | Data::Error(_) => String::new(),
        Data::String(s) | Data::DateTimeIso(s) | Data::DurationIso(s) => s.clone(),
        Data::Int(i) => i.to_string(),
        Data::Float(f) => format!("{}", f),
        Data::Bool(b) => b.to_string(),
        Data::DateTime(d) => match d.as_datetime() {
            Some(dt) if dt.time() == chrono::NaiveTime::MIN => dt.date().to_string(),
            Some(dt) => dt.to_string(),
            None => d.as_f64().to_string(),
        },
    }
}

/// Valore di una cella. Con un tipo dichiarato nel mapping vale la stessa regola
/// del CSV (`coerce` sul testo); senza, il tipo naturale della cella. Excel salva
/// ogni numero come virgola mobile: un numero intero entro 2^53 torna intero.
fn excel_value(cell: &calamine::Data, declared: Option<&str>) -> Value {
    use calamine::Data;
    if let Some(ty) = declared {
        return coerce(&excel_text(cell), ty);
    }
    match cell {
        Data::Empty | Data::Error(_) => Value::Null,
        Data::Int(i) => Value::Int(*i),
        Data::Float(f) if f.fract() == 0.0 && f.abs() < 9_007_199_254_740_992.0 => Value::Int(*f as i64),
        Data::Float(f) => Value::Float(*f),
        Data::Bool(b) => Value::Bool(*b),
        Data::DateTime(d) => match d.as_datetime() {
            Some(dt) if dt.time() == chrono::NaiveTime::MIN => Value::Date(dt.date().to_string()),
            Some(dt) => Value::DateTime(dt.to_string()),
            None => Value::Float(d.as_f64()),
        },
        Data::DateTimeIso(s) => Value::DateTime(s.clone()),
        Data::String(s) | Data::DurationIso(s) => Value::String(s.clone()),
    }
}

/// Legge un foglio (il primo se `sheet` e' vuoto) a partire da `start_row`
/// (1 = prima riga); con intestazione, la prima riga letta da' i nomi.
fn read_excel(
    path: &str,
    sheet: &str,
    start_row: u64,
    has_header: bool,
    types: &std::collections::HashMap<String, String>,
) -> Result<Vec<Row>, String> {
    use calamine::Reader;
    let mut wb = calamine::open_workbook_auto(path)
        .map_err(|e| format!("cannot open Excel file '{}': {}", path, e))?;
    let names = wb.sheet_names();
    let range = if sheet.trim().is_empty() {
        wb.worksheet_range_at(0)
            .ok_or_else(|| format!("'{}' contains no sheets", path))?
            .map_err(|e| format!("cannot read the first sheet: {}", e))?
    } else {
        if !names.iter().any(|n| n == sheet) {
            return Err(format!("sheet '{}' not found. Available: {}", sheet, names.join(", ")));
        }
        wb.worksheet_range(sheet).map_err(|e| format!("cannot read sheet '{}': {}", sheet, e))?
    };

    let mut it = range.rows().skip((start_row - 1) as usize);
    let header: Vec<String> = if has_header {
        match it.next() {
            Some(r) => r.iter().enumerate().map(|(i, c)| {
                let t = excel_text(c).trim().to_string();
                if t.is_empty() { format!("col_{}", i) } else { t }
            }).collect(),
            None => return Ok(Vec::new()),
        }
    } else {
        Vec::new()
    };

    let mut out = Vec::new();
    for r in it {
        if r.iter().all(|c| matches!(c, calamine::Data::Empty)) { continue; } // riga vuota
        let mut row = Row::new();
        for (i, c) in r.iter().enumerate() {
            let name = header.get(i).cloned().unwrap_or_else(|| format!("col_{}", i));
            let v = excel_value(c, types.get(&name).map(|s| s.as_str()));
            row.set(name, v);
        }
        out.push(row);
    }
    Ok(out)
}

fn coerce(raw: &str, ty: &str) -> Value {
    let t = raw.trim();
    if t.is_empty() { return Value::Null }

    match ty {
        "integer" => t.parse::<i64>().map(Value::Int).unwrap_or(Value::Null),
        "float"   => t.parse::<f64>().map(Value::Float).unwrap_or(Value::Null),
        "decimal" => t.parse::<rust_decimal::Decimal>().map(Value::Decimal).unwrap_or(Value::Null),
        "boolean" => match t.to_lowercase().as_str() {
            "true"  | "1" | "si" | "sì" | "yes" | "y" | "t" => Value::Bool(true),
            "false" | "0" | "no" | "n"  | "f"               => Value::Bool(false),
            _ => Value::Null,
        },
        "date" | "datetime" => Value::String(t.to_string()),  // il motore parsa on-demand
        "object" => serde_json::from_str::<serde_json::Value>(t)
            .map(Value::Object).unwrap_or(Value::String(t.to_string())),
        _ => Value::String(t.to_string()),   // string, any, sconosciuto
    }
}
#[cfg(test)]
mod tests_excel {
    use super::*;

    // Andata e ritorno (P342): scrive un .xlsx con rust_xlsxwriter (il writer del
    // report_generator) e lo rilegge col lettore del motore.
    fn crea_xlsx(path: &std::path::Path) {
        use rust_xlsxwriter::{ExcelDateTime, Format, Workbook};
        let mut wb = Workbook::new();
        let ws = wb.add_worksheet();
        ws.set_name("Clienti").unwrap();
        for (c, h) in ["id", "nome", "importo", "attivo", "data", ""].iter().enumerate() {
            ws.write_string(0, c as u16, *h).unwrap();
        }
        let df = Format::new().set_num_format("yyyy-mm-dd");
        ws.write_number(1, 0, 1.0).unwrap();
        ws.write_string(1, 1, "Alfa & Beta").unwrap();
        ws.write_number(1, 2, 1200.5).unwrap();
        ws.write_boolean(1, 3, true).unwrap();
        ws.write_datetime_with_format(1, 4, &ExcelDateTime::from_ymd(2026, 1, 2).unwrap(), &df).unwrap();
        ws.write_string(1, 5, "senza intestazione").unwrap();
        // riga 3 vuota: deve essere saltata
        ws.write_number(3, 0, 2.0).unwrap();
        ws.write_string(3, 1, "Gamma").unwrap();
        let ws2 = wb.add_worksheet();
        ws2.set_name("Altro").unwrap();
        ws2.write_string(0, 0, "x").unwrap();
        ws2.write_string(1, 0, "dal secondo foglio").unwrap();
        wb.save(path).unwrap();
    }

    #[test]
    fn excel_andata_e_ritorno() {
        let dir = std::env::temp_dir().join(format!("fp-xlsx-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("t.xlsx");
        crea_xlsx(&p);
        let ps = p.to_str().unwrap();
        let none = std::collections::HashMap::new();

        let rows = read_excel(ps, "", 1, true, &none).unwrap();
        assert_eq!(rows.len(), 2, "la riga vuota va saltata");
        let r = &rows[0];
        assert_eq!(r.get("id"), Some(&Value::Int(1)));
        assert_eq!(r.get("nome"), Some(&Value::String("Alfa & Beta".into())));
        assert_eq!(r.get("importo"), Some(&Value::Float(1200.5)));
        assert_eq!(r.get("attivo"), Some(&Value::Bool(true)));
        assert_eq!(r.get("data"), Some(&Value::Date("2026-01-02".into())));
        assert_eq!(r.get("col_5"), Some(&Value::String("senza intestazione".into())));
        assert_eq!(rows[1].get("importo"), Some(&Value::Null));

        // tipi dichiarati nel mapping: stessa regola del CSV
        let mut tipi = std::collections::HashMap::new();
        tipi.insert("importo".to_string(), "decimal".to_string());
        tipi.insert("id".to_string(), "string".to_string());
        let rows = read_excel(ps, "Clienti", 1, true, &tipi).unwrap();
        assert_eq!(rows[0].get("importo"), Some(&Value::Decimal("1200.5".parse().unwrap())));
        assert_eq!(rows[0].get("id"), Some(&Value::String("1".into())));

        // foglio per nome, senza intestazione, da una riga successiva
        let rows = read_excel(ps, "Altro", 2, false, &none).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].get("col_0"), Some(&Value::String("dal secondo foglio".into())));

        // errori parlanti
        assert!(read_excel(ps, "Manca", 1, true, &none).unwrap_err().contains("Available: Clienti, Altro"));
        assert!(read_excel("/non/esiste.xlsx", "", 1, true, &none).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod tests_p357 {
    use super::*;

    fn cfg(format: &str) -> SourceFileConfig {
        SourceFileConfig {
            format: format.into(), delimiter: ',', quote: '"', escape: Some('\\'), comment: None,
            has_header: true, skip_rows: 0, limit: 0, encoding: "utf-8".into(), fields: vec![],
            sheet_name: String::new(), start_row: 1, json_path: "$".into(), json_object: false, binary_hex: false,
        }
    }
    fn read(path: &str, c: &SourceFileConfig) -> Result<Vec<Row>, String> {
        let mut out = Vec::new();
        let mut budget = if c.limit == 0 { u64::MAX } else { c.limit };
        let mut emit = |r: Row| { out.push(r); true };
        read_one(path, c, &mut budget, &mut emit)?;
        Ok(out)
    }
    fn tmp(name: &str, bytes: &[u8]) -> String {
        let dir = std::env::temp_dir().join(format!("fp-p357-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join(name);
        std::fs::write(&p, bytes).unwrap();
        p.to_str().unwrap().to_string()
    }
    fn s(r: &Row, k: &str) -> Value { r.get(k).cloned().unwrap_or(Value::Null) }

    #[test]
    fn csv_completo() {
        // BOM, riga da saltare, commento, campo su due righe, virgolette
        // raddoppiate ed escape, delimitatore ';'
        let p = tmp("a.csv", "\u{feff}titolo del file\nid;nome;nota\n# commento\n1;\"Anna\";\"riga 1\nriga 2\"\n2;\"Bo \"\"B\"\"\";\"x \\\" y\"\n3;Carlo;\n".as_bytes());
        let mut c = cfg("csv");
        c.delimiter = ';'; c.comment = Some('#'); c.skip_rows = 1;
        let rows = read(&p, &c).unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(s(&rows[0], "id"), Value::String("1".into()));
        assert_eq!(s(&rows[0], "nota"), Value::String("riga 1\nriga 2".into()));
        assert_eq!(s(&rows[1], "nome"), Value::String("Bo \"B\"".into()));
        assert_eq!(s(&rows[1], "nota"), Value::String("x \" y".into()));
        // limite
        c.limit = 2;
        assert_eq!(read(&p, &c).unwrap().len(), 2);
    }

    #[test]
    fn mapping_rinomina_trasforma_converte() {
        let p = tmp("m.csv", b"ID,Nome,Importo,Extra\n7,anna,12.50,x\n");
        let mut c = cfg("csv");
        c.fields = vec![
            FieldType { name: "codice".into(), physical: "ID".into(), ty: "integer".into(), transform: String::new() },
            FieldType { name: "nome".into(), physical: "Nome".into(), ty: "string".into(), transform: "uppercase".into() },
            FieldType { name: "importo".into(), physical: "Importo".into(), ty: "decimal".into(), transform: String::new() },
        ];
        let r = &read(&p, &c).unwrap()[0];
        assert_eq!(s(r, "codice"), Value::Int(7));
        assert_eq!(s(r, "nome"), Value::String("ANNA".into()));
        assert_eq!(s(r, "importo"), Value::Decimal("12.50".parse().unwrap()));
        assert!(r.get("Extra").is_none() && r.get("ID").is_none(), "escono solo i campi mappati");
    }

    #[test]
    fn codifica_windows_1252() {
        let p = tmp("w.csv", &[b'n', b'\n', 0xE8, 0x80, b'\n']);
        let mut c = cfg("csv");
        c.encoding = "windows-1252".into();
        assert_eq!(s(&read(&p, &c).unwrap()[0], "n"), Value::String("è€".into()));
        c.encoding = "utf-8".into();
        assert!(read(&p, &c).unwrap_err().contains("not valid UTF-8"));
    }

    #[test]
    fn json_jsonl_text_binary() {
        let p = tmp("d.json", br#"{"data":{"items":[{"a":1},{"a":2}]}}"#);
        let mut c = cfg("json");
        c.json_path = "$.data.items".into();
        let rows = read(&p, &c).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(s(&rows[1], "content"), Value::Object(serde_json::json!({"a":2})));
        assert_eq!(s(&rows[1], "raw"), Value::String("{\"a\":2}".into()));
        c.json_object = true;
        assert_eq!(read(&p, &c).unwrap().len(), 1);
        c.json_path = "$.data.items[1].a".into(); c.json_object = false;
        assert_eq!(s(&read(&p, &c).unwrap()[0], "content"), Value::Object(serde_json::json!(2)));
        c.json_path = "$.manca".into();
        assert!(read(&p, &c).is_err());

        let p = tmp("d.jsonl", b"{\"a\":1}\n\n{\"a\":2}\n");
        assert_eq!(read(&p, &cfg("jsonl")).unwrap().len(), 2);
        let p = tmp("bad.jsonl", b"{\"a\":1}\n{oops\n");
        assert!(read(&p, &cfg("jsonl")).unwrap_err().contains("line 2"));

        let p = tmp("t.txt", b"uno\ndue\ntre\n");
        let mut c = cfg("text"); c.skip_rows = 1;
        let rows = read(&p, &c).unwrap();
        assert_eq!(rows.len(), 2);
        assert_eq!(s(&rows[0], "line_number"), Value::Int(2));

        let p = tmp("b.pdf", b"%PDF");
        let mut c = cfg("binary"); c.binary_hex = true;
        let r = &read(&p, &c).unwrap()[0];
        assert_eq!(s(r, "data"), Value::String("25504446".into()));
        assert_eq!(s(r, "size"), Value::Int(4));
        assert_eq!(s(r, "mime_type"), Value::String("application/pdf".into()));
    }

    #[test]
    fn glob_e_wildcard() {
        let a = tmp("g1.csv", b"x\n1\n");
        tmp("g2.csv", b"x\n2\n");
        tmp("g3.txt", b"x\n3\n");
        let dir = a.rsplit_once('/').unwrap().0.to_string();
        let files = expand_glob(&format!("{}/g?.csv", dir)).unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0].ends_with("g1.csv") && files[1].ends_with("g2.csv"));
        assert!(expand_glob("/tmp/*/x.csv").is_err());
    }
}
