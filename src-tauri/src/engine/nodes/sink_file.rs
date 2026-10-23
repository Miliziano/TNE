// ─── src-tauri/src/engine/nodes/sink_file.rs (v3, P361) ────────────
//
// Scrive le righe su file. Ogni opzione del pannello (SinkFilePanel) fa
// ciò che dice; ciò che il motore non sa fare non è più offerto.
//
//   path            con le variabili ${date} ${datetime} ${uuid} ${seq}
//                   ${partition}; le cartelle mancanti si creano.
//   format          righe: csv | tsv | json | jsonl | xml | excel
//                   valore di un campo: html | text (testo) ·
//                   excel_b64 | binary (base64 decodificato)
//                   (parquet/orc/avro/pdf: non scrivibili → errore chiaro)
//   mode            overwrite | append | new (nome libero _1, _2… se il file
//                   esiste) | error (errore se esiste). Append non può
//                   estendere un array JSON, un XML o un Excel → errore.
//   writeMode2      rows | raw_field (+ rawField, rawEncoding text|base64)
//   fileColumns     mapping delle colonne (tab Mapping): solo i campi inclusi,
//                   nell'ordine, col nome scelto, trasformati e convertiti
//                   (engine/field_mapping.rs). Senza: tutti, in ordine alfabetico.
//   CSV/TSV         delimiter, quoteChar, writeHeader (true|false|auto = solo
//                   se il file è nuovo o vuoto), lineEnding (lf|crlf)
//   JSON            jsonIndent (none|2|4), jsonStructure (array|lines)
//   Excel           sheetName, headerStyle (none|bold|colored)
//   encoding        utf-8 | utf-16 | iso-8859-1 | windows-1252 | ascii
//                   (i caratteri non rappresentabili → '?' con un avviso)
//   partition       none | field (partitionField) | date (partitionTimestamp,
//                   partitionGranularity year|month|day|hour) | size
//                   (partitionMaxMb): un file per partizione; la chiave va in
//                   ${partition}, o prima dell'estensione (_chiave).
//   outputMode      signal → una riga di stato PER FILE scritto
//                   replay → le righe originali, dopo la scrittura completa
//   postCommand     comando di shell dopo la chiusura, per ogni file
//                   (${file} e la variabile d'ambiente FP_FILE = il percorso);
//                   uscita ≠ 0 → errore del nodo.
//   webhookUrl      POST JSON a fine scrittura; se fallisce, un avviso.

use std::collections::HashMap;
use std::io::{BufWriter, Write};
use std::fs::File;
use std::time::Instant;
use base64::Engine as _;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::field_mapping::FieldMapping;
use crate::engine::text_encoding::{encode_chunk, bom, normalize};

const ROW_FORMATS:   &[&str] = &["csv", "tsv", "json", "jsonl", "xml", "excel"];
const FIELD_FORMATS: &[&str] = &["html", "text", "excel_b64", "binary"];
const MAX_PARTITIONS: usize = 1000;
const EXCEL_MAX_ROWS: u32   = 1_048_576;
const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;

// ─── Config ────────────────────────────────────────────────────────

#[derive(PartialEq, Clone, Copy)]
enum Header { Yes, No, Auto }

enum Partition {
    None,
    Field(String),
    Date { field: String, fmt: &'static str },
    Size(u64),
}

struct Cfg {
    path:         String,
    format:       String,
    mode:         String,
    raw:          bool,
    raw_field:    String,
    raw_b64:      bool,
    replay:       bool,
    delimiter:    char,
    quote:        char,
    header:       Header,
    ending:       &'static str,
    json_indent:  usize,
    json_lines:   bool,
    encoding:     String,
    sheet_name:   String,
    header_style: String,
    partition:    Partition,
    post_command: String,
    webhook_url:  String,
    mapping:      FieldMapping,
}

fn config_from_spec(spec: &Spec) -> Result<Cfg, String> {
    let format = spec.str_or("format", "csv").trim().to_ascii_lowercase();
    if !ROW_FORMATS.contains(&format.as_str()) && !FIELD_FORMATS.contains(&format.as_str()) {
        return Err(format!("format '{}' cannot be written: choose CSV, TSV, Excel, JSON, JSON Lines or XML (or the value of a field: HTML, text, Excel from base64, binary)", format));
    }
    let field_format = FIELD_FORMATS.contains(&format.as_str());
    let raw = field_format || spec.str_or("writeMode2", "rows") == "raw_field";
    let raw_b64 = match format.as_str() {
        "excel_b64" | "binary" => true,
        "html" | "text"        => false,
        _ => spec.str_or("rawEncoding", "text") == "base64",
    };

    let mode = spec.str_or("mode", "overwrite");
    if !matches!(mode.as_str(), "overwrite" | "append" | "new" | "error") {
        return Err(format!("unknown write mode '{}'", mode));
    }
    let json_lines = spec.str_or("jsonStructure", "array") == "lines";
    if mode == "append" && !raw {
        let what = match format.as_str() {
            "json" if !json_lines => Some("a JSON array: choose 'One line per object', JSON Lines or another write mode"),
            "xml"   => Some("an XML document: choose another write mode"),
            "excel" => Some("an Excel file: choose another write mode"),
            _ => None,
        };
        if let Some(w) = what {
            return Err(format!("'Append' cannot extend {}", w));
        }
    }

    let delimiter = match spec.str_or("delimiter", "").as_str() {
        "" => if format == "tsv" { '\t' } else { ',' },
        "\\t" => '\t',
        d => d.chars().next().unwrap_or(','),
    };
    let quote = spec.str_or("quoteChar", "\"").chars().next().unwrap_or('"');
    let header = match spec.str_or("writeHeader", "true").as_str() {
        "false" => Header::No,
        "auto"  => Header::Auto,
        _       => Header::Yes,
    };
    let ending = if spec.str_or("lineEnding", "lf") == "crlf" { "\r\n" } else { "\n" };
    let json_indent = match spec.str_or("jsonIndent", "none").as_str() { "2" => 2, "4" => 4, _ => 0 };

    let encoding = normalize(&spec.str_or("encoding", "utf-8"));
    encode_chunk("", &encoding)?;   // codifica sconosciuta → errore subito

    let partition = match spec.str_or("partition", "none").as_str() {
        "" | "none" => Partition::None,
        "field" => {
            let f = spec.str_or("partitionField", "");
            if f.trim().is_empty() { return Err("partition by field: choose the partition field".into()) }
            Partition::Field(f)
        }
        "date" => {
            let field = spec.str_or("partitionTimestamp", "created_at");
            if field.trim().is_empty() { return Err("partition by date: choose the timestamp field".into()) }
            let fmt = match spec.str_or("partitionGranularity", "day").as_str() {
                "year"  => "%Y",
                "month" => "%Y-%m",
                "hour"  => "%Y-%m-%d_%H",
                _       => "%Y-%m-%d",
            };
            Partition::Date { field, fmt }
        }
        "size" => {
            let mb: f64 = spec.str_or("partitionMaxMb", "").trim().parse().unwrap_or(0.0);
            if mb <= 0.0 { return Err("partition by size: set the maximum file size (MB)".into()) }
            if format == "excel" && !raw { return Err("partition by size is not available for Excel".into()) }
            Partition::Size((mb * 1024.0 * 1024.0) as u64)
        }
        other => return Err(format!("unknown partitioning '{}'", other)),
    };

    Ok(Cfg {
        path:         spec.str_or("path", ""),
        format, mode, raw,
        raw_field:    { let f = spec.str_or("rawField", "content"); if f.is_empty() { "content".into() } else { f } },
        raw_b64,
        replay:       spec.str_or("outputMode", "signal") == "replay",
        delimiter, quote, header, ending, json_indent, json_lines, encoding,
        sheet_name:   { let s = spec.str_or("sheetName", "Sheet1"); if s.trim().is_empty() { "Sheet1".into() } else { s } },
        header_style: spec.str_or("headerStyle", "bold"),
        partition,
        post_command: spec.str_or("postCommand", "").trim().to_string(),
        webhook_url:  spec.str_or("webhookUrl", "").trim().to_string(),
        mapping:      FieldMapping::parse(&spec.str_or("fileColumns", ""))?,
    })
}

// ─── Percorso ──────────────────────────────────────────────────────

/// Caratteri ammessi nel valore di una partizione dentro un nome di file.
fn safe_key(s: &str) -> String {
    let k: String = s.chars()
        .map(|c| if c.is_alphanumeric() || matches!(c, '-' | '_' | '.' | '=' | ' ') { c } else { '_' })
        .collect();
    let k = k.trim().replace("..", "_");
    if k.is_empty() { "_empty".into() } else { k }
}

/// Inserisce `_suffisso` prima dell'estensione del nome del file.
fn with_suffix(path: &str, suffix: &str) -> String {
    let (dir, name) = match path.rfind(['/', '\\']) { Some(i) => (&path[..=i], &path[i + 1..]), None => ("", path) };
    match name.find('.') {
        Some(0) | None => format!("{}{}_{}", dir, name, suffix),
        Some(i)        => format!("{}{}_{}{}", dir, &name[..i], suffix, &name[i..]),
    }
}

/// Le variabili del percorso. ${seq}: il primo numero (da 1) per cui il
/// file non esiste ancora.
fn expand_path(template: &str, partition: Option<&str>, now: &chrono::DateTime<chrono::Local>) -> String {
    let mut p = template
        .replace("${date}",     &now.format("%Y-%m-%d").to_string())
        .replace("${datetime}", &now.format("%Y-%m-%d_%H-%M-%S").to_string())
        .replace("${uuid}",     &uuid::Uuid::new_v4().to_string());
    if let Some(k) = partition {
        p = if p.contains("${partition}") { p.replace("${partition}", k) } else { with_suffix(&p, k) };
    }
    if p.contains("${seq}") {
        let mut n = 1u64;
        loop {
            let cand = p.replace("${seq}", &n.to_string());
            if !std::path::Path::new(&cand).exists() || n >= 999_999 { return cand }
            n += 1;
        }
    }
    p
}

// ─── Un file in scrittura ──────────────────────────────────────────

enum Out {
    Text(BufWriter<File>),
    Excel { wb: Box<rust_xlsxwriter::Workbook>, next_row: u32 },
}

struct Target {
    path:        String,
    out:         Out,
    fresh:       bool,    // file nuovo o vuoto (conta per header 'auto')
    rows:        u64,
    bytes:       u64,
    header_done: bool,
    first_json:  bool,
    replaced:    usize,   // caratteri non rappresentabili nella codifica
    started:     Instant,
}

/// Esito di un file, per la riga di stato e il webhook.
struct Written {
    path:  String,
    rows:  u64,
    bytes: u64,
    ms:    u64,
}

impl Target {
    fn open(cfg: &Cfg, path: String) -> Result<Target, String> {
        let mut path = path;
        let exists = std::path::Path::new(&path).exists();
        match cfg.mode.as_str() {
            "error" if exists => return Err(format!("file '{}' already exists (write mode 'error')", path)),
            "new" if exists => {
                path = (1..=9999).map(|n| crate::ftp_numbered_path(&path, n))
                    .find(|p| !std::path::Path::new(p).exists())
                    .ok_or_else(|| format!("no free name for '{}'", path))?;
            }
            _ => {}
        }
        if let Some(dir) = std::path::Path::new(&path).parent() {
            if !dir.as_os_str().is_empty() && !dir.exists() {
                std::fs::create_dir_all(dir).map_err(|e| format!("cannot create folder '{}': {}", dir.display(), e))?;
            }
        }
        let append = cfg.mode == "append";
        let fresh = !append || std::fs::metadata(&path).map(|m| m.len() == 0).unwrap_or(true);

        let out = if cfg.format == "excel" && !cfg.raw {
            let mut wb = rust_xlsxwriter::Workbook::new();
            wb.add_worksheet().set_name(&cfg.sheet_name)
                .map_err(|e| format!("invalid sheet name '{}': {}", cfg.sheet_name, e))?;
            // Prova subito che il file si possa creare (errori di permessi qui, non alla fine).
            File::create(&path).map_err(|e| format!("cannot create '{}': {}", path, e))?;
            Out::Excel { wb: Box::new(wb), next_row: 0 }
        } else {
            let f = if append {
                std::fs::OpenOptions::new().append(true).create(true).open(&path)
                    .map_err(|e| format!("cannot open '{}' in append: {}", path, e))?
            } else {
                File::create(&path).map_err(|e| format!("cannot create '{}': {}", path, e))?
            };
            Out::Text(BufWriter::new(f))
        };

        let mut t = Target { path, out, fresh, rows: 0, bytes: 0, header_done: false,
                             first_json: true, replaced: 0, started: Instant::now() };
        let text_out = !(cfg.raw && cfg.raw_b64) && !matches!(t.out, Out::Excel { .. });
        if text_out && fresh {
            let b = bom(&cfg.encoding);
            if !b.is_empty() { t.put_bytes(b)?; }
        }
        if !cfg.raw {
            if cfg.format == "json" && !cfg.json_lines { t.put("[", cfg)?; }
            if cfg.format == "xml" { t.put(&format!("<records>{}", cfg.ending), cfg)?; }
        }
        Ok(t)
    }

    fn put_bytes(&mut self, b: &[u8]) -> Result<(), String> {
        let Out::Text(w) = &mut self.out else { return Err("internal: bytes on an Excel file".into()) };
        w.write_all(b).map_err(|e| format!("write error on '{}': {}", self.path, e))?;
        self.bytes += b.len() as u64;
        Ok(())
    }

    fn put(&mut self, s: &str, cfg: &Cfg) -> Result<(), String> {
        let (b, rep) = encode_chunk(s, &cfg.encoding)?;
        self.replaced += rep;
        self.put_bytes(&b)
    }

    fn write_row(&mut self, row: &Row, cols: &[String], cfg: &Cfg) -> Result<(), String> {
        if cfg.raw {
            let val = row.get(&cfg.raw_field).map(|v| v.as_str_repr()).unwrap_or_default();
            if cfg.raw_b64 {
                let clean: String = val.chars().filter(|c| !c.is_whitespace()).collect();
                let bytes = base64::engine::general_purpose::STANDARD.decode(clean)
                    .map_err(|e| format!("field '{}' is not valid base64 (row {}): {}", cfg.raw_field, self.rows + 1, e))?;
                self.put_bytes(&bytes)?;
            } else {
                self.put(&val, cfg)?;
                self.put(cfg.ending, cfg)?;
            }
            self.rows += 1;
            return Ok(());
        }

        // Senza mapping JSON e XML seguono i campi di ogni riga; CSV ed Excel
        // le colonne fissate dalla prima riga.
        let own: Vec<String>;
        let keys: &[String] = if cfg.mapping.is_empty() && matches!(cfg.format.as_str(), "json" | "jsonl" | "xml") {
            let mut k: Vec<String> = row.0.keys().cloned().collect();
            k.sort();
            own = k;
            &own
        } else { cols };

        match cfg.format.as_str() {
            "json" if !cfg.json_lines => {
                let s = json_object(row, keys, cfg.json_indent);
                if !self.first_json { self.put(",", cfg)?; }
                self.put(cfg.ending, cfg)?;
                self.put(&s, cfg)?;
                self.first_json = false;
            }
            "json" | "jsonl" => {
                self.put(&json_object(row, keys, 0), cfg)?;
                self.put(cfg.ending, cfg)?;
            }
            "xml" => {
                let mut xml = String::from("  <record>");
                for k in keys {
                    let v = row.get(k).map(|v| v.as_str_repr()).unwrap_or_default();
                    let tag = sanitize_tag(k);
                    xml.push_str(&format!("<{}>{}</{}>", tag, escape_xml(&v), tag));
                }
                xml.push_str("</record>");
                self.put(&xml, cfg)?;
                self.put(cfg.ending, cfg)?;
            }
            "excel" => self.excel_row(row, keys, cfg)?,
            _ => {
                let d = cfg.delimiter.to_string();
                if !self.header_done {
                    self.header_done = true;
                    if cfg.header == Header::Yes || (cfg.header == Header::Auto && self.fresh) {
                        let h = keys.iter().map(|c| escape_csv(c, cfg.delimiter, cfg.quote)).collect::<Vec<_>>().join(&d);
                        self.put(&h, cfg)?;
                        self.put(cfg.ending, cfg)?;
                    }
                }
                let line = keys.iter()
                    .map(|c| escape_csv(&row.get(c).map(|v| v.as_str_repr()).unwrap_or_default(), cfg.delimiter, cfg.quote))
                    .collect::<Vec<_>>().join(&d);
                self.put(&line, cfg)?;
                self.put(cfg.ending, cfg)?;
            }
        }
        self.rows += 1;
        Ok(())
    }

    fn excel_row(&mut self, row: &Row, cols: &[String], cfg: &Cfg) -> Result<(), String> {
        use rust_xlsxwriter::{Color, Format};
        let header_wanted = !self.header_done && cfg.header != Header::No;
        let Out::Excel { wb, next_row } = &mut self.out else { return Err("internal: Excel row on a text file".into()) };
        let ws = wb.worksheet_from_index(0).map_err(|e| format!("xlsx: {}", e))?;
        if header_wanted {
            let fmt = match cfg.header_style.as_str() {
                "none"    => Format::new(),
                "colored" => Format::new().set_bold().set_font_color(Color::White).set_background_color(Color::RGB(0x1F4E79)),
                _         => Format::new().set_bold(),
            };
            for (c, name) in cols.iter().enumerate() {
                ws.write_string_with_format(0, c as u16, name, &fmt).map_err(|e| format!("xlsx header: {}", e))?;
            }
            *next_row = 1;
        }
        self.header_done = true;
        if *next_row >= EXCEL_MAX_ROWS {
            return Err(format!("Excel holds at most {} rows per sheet: use CSV or partition the output", EXCEL_MAX_ROWS));
        }
        let r = *next_row;
        for (c, name) in cols.iter().enumerate() {
            let cc = c as u16;
            let res = match row.get(name) {
                None | Some(Value::Null) => continue,
                Some(Value::Int(n))      => ws.write_number(r, cc, *n as f64),
                Some(Value::Float(f))    => ws.write_number(r, cc, *f),
                Some(Value::Decimal(d))  => {
                    use rust_decimal::prelude::ToPrimitive;
                    match d.to_f64() { Some(f) => ws.write_number(r, cc, f), None => ws.write_string(r, cc, d.to_string()) }
                }
                Some(Value::Bool(b))     => ws.write_boolean(r, cc, *b),
                Some(v)                  => ws.write_string(r, cc, v.as_str_repr()),
            };
            res.map_err(|e| format!("xlsx cell: {}", e))?;
        }
        *next_row += 1;
        Ok(())
    }

    fn finish(mut self, cfg: &Cfg) -> Result<Written, String> {
        if !cfg.raw {
            if cfg.format == "json" && !cfg.json_lines {
                self.put(cfg.ending, cfg)?;
                self.put("]", cfg)?;
                self.put(cfg.ending, cfg)?;
            }
            if cfg.format == "xml" { self.put(&format!("</records>{}", cfg.ending), cfg)?; }
        }
        match self.out {
            Out::Text(mut w) => w.flush().map_err(|e| format!("write error on '{}': {}", self.path, e))?,
            Out::Excel { mut wb, .. } => {
                wb.save(&self.path).map_err(|e| format!("cannot save '{}': {}", self.path, e))?;
                self.bytes = std::fs::metadata(&self.path).map(|m| m.len()).unwrap_or(0);
            }
        }
        Ok(Written { path: self.path, rows: self.rows, bytes: self.bytes, ms: self.started.elapsed().as_millis() as u64 })
    }
}

/// Oggetto JSON coi campi nell'ordine dato (serde_json ordinerebbe le chiavi).
fn json_object(row: &Row, keys: &[String], indent: usize) -> String {
    let val = |k: &str| row.get(k).map(|v| v.to_json()).unwrap_or(serde_json::Value::Null);
    if indent == 0 {
        let parts: Vec<String> = keys.iter()
            .map(|k| format!("{}:{}", serde_json::Value::String(k.clone()), val(k)))
            .collect();
        return format!("{{{}}}", parts.join(","));
    }
    let pad = " ".repeat(indent);
    let parts: Vec<String> = keys.iter().map(|k| {
        let mut buf = Vec::new();
        let ind = pad.as_bytes().to_vec();
        let mut ser = serde_json::Serializer::with_formatter(&mut buf, serde_json::ser::PrettyFormatter::with_indent(&ind));
        let _ = serde::Serialize::serialize(&val(k), &mut ser);
        let v = String::from_utf8(buf).unwrap_or_default().replace('\n', &format!("\n{}", pad));
        format!("{}{}: {}", pad, serde_json::Value::String(k.clone()), v)
    }).collect();
    if parts.is_empty() { return "{}".into() }
    format!("{{\n{}\n}}", parts.join(",\n"))
}

/// Data/ora di un valore (RFC 3339, "AAAA-MM-GG hh:mm:ss", "AAAA-MM-GG").
fn parse_when(v: &Value) -> Option<chrono::NaiveDateTime> {
    let s = v.as_str_repr();
    let s = s.trim();
    if let Ok(d) = chrono::DateTime::parse_from_rfc3339(s) { return Some(d.naive_local()) }
    for f in ["%Y-%m-%d %H:%M:%S%.f", "%Y-%m-%dT%H:%M:%S%.f", "%Y-%m-%d %H:%M", "%Y-%m-%dT%H:%M"] {
        if let Ok(d) = chrono::NaiveDateTime::parse_from_str(s, f) { return Some(d) }
    }
    chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok().and_then(|d| d.and_hms_opt(0, 0, 0))
}

// ─── Esecuzione ────────────────────────────────────────────────────

fn warn(ctx: &NodeContext, msg: String) {
    eprintln!("[sink_file {}] {}", ctx.node_id.0, msg);
    ctx.emit_log(&ctx.label, "warn", 0, msg, "panel");
}

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {
    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("sink_file {}: {}", ctx.node_id.0, e))?;
    let mut cfg = config_from_spec(&spec).map_err(|e| format!("sink_file {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("sink_file", &ctx.node_id.0);
    if cfg.path.trim().is_empty() {
        return Err(format!("sink_file {}: output file path not specified.", ctx.node_id.0));
    }
    let nerr = |e: String| format!("sink_file {}: {}", ctx.node_id.0, e);

    let now = chrono::Local::now();
    let start = Instant::now();
    let mut last_progress = Instant::now();

    // File aperti (per chiave di partizione) e, in ordine, quelli chiusi.
    let mut open: HashMap<String, Target> = HashMap::new();
    let mut order: Vec<String> = Vec::new();
    let mut done: Vec<Written> = Vec::new();
    let mut size_part = 1u64;
    let mut unknown_dates = 0u64;

    // Senza partizioni (o per dimensione) il file si apre subito: anche con
    // zero righe esiste, e un errore di percorso/modalità esce prima.
    match cfg.partition {
        Partition::None    => { open.insert(String::new(), Target::open(&cfg, expand_path(&cfg.path, None, &now)).map_err(nerr)?); order.push(String::new()); }
        Partition::Size(_) => { open.insert("1".into(), Target::open(&cfg, expand_path(&cfg.path, Some("1"), &now)).map_err(nerr)?); order.push("1".into()); }
        _ => {}
    }

    let mut cols: Vec<String> = cfg.mapping.columns();
    let mut rows_in = 0u64;
    let mut replay_buf: Vec<Row> = Vec::new();
    let replay = cfg.replay && tx.is_some();

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Chiave di partizione: dai campi in ingresso (prima del mapping).
        let key = match &cfg.partition {
            Partition::None    => String::new(),
            Partition::Field(f) => safe_key(&row.get(f).map(|v| v.as_str_repr()).unwrap_or_default()),
            Partition::Date { field, fmt } => match row.get(field).and_then(parse_when) {
                Some(d) => d.format(fmt).to_string(),
                None => { unknown_dates += 1; "_unknown".to_string() }
            },
            Partition::Size(max) => {
                let cur = size_part.to_string();
                if open.get(&cur).map(|t| t.bytes >= *max && t.rows > 0).unwrap_or(false) {
                    let t = open.remove(&cur).unwrap();
                    done.push(t.finish(&cfg).map_err(nerr)?);
                    size_part += 1;
                }
                size_part.to_string()
            }
        };
        if !open.contains_key(&key) {
            if open.len() >= MAX_PARTITIONS {
                return Err(nerr(format!("more than {} partitions open at once: choose a field with fewer distinct values", MAX_PARTITIONS)));
            }
            let path = expand_path(&cfg.path, Some(&key), &now);
            open.insert(key.clone(), Target::open(&cfg, path).map_err(nerr)?);
            order.push(key.clone());
        }

        let out_row = if cfg.raw { row.clone() } else { cfg.mapping.apply(row.clone()) };
        if cols.is_empty() && !cfg.raw {
            cols = out_row.0.keys().cloned().collect();
            cols.sort();
        }
        open.get_mut(&key).unwrap().write_row(&out_row, &cols, &cfg).map_err(nerr)?;
        if replay { replay_buf.push(row); }

        if rows_in % PROGRESS_EVERY_ROWS == 0 || last_progress.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_in, 0, rps);
            last_progress = Instant::now();
        }
    }

    // Chiusura, nell'ordine di apertura.
    let mut replaced = 0usize;
    for k in order {
        if let Some(t) = open.remove(&k) {
            replaced += t.replaced;
            done.push(t.finish(&cfg).map_err(nerr)?);
        }
    }
    done.sort_by(|a, b| a.path.cmp(&b.path));

    if replaced > 0 {
        warn(&ctx, format!("{} character(s) cannot be represented in {} and were written as '?'", replaced, cfg.encoding));
    }
    if unknown_dates > 0 {
        warn(&ctx, format!("{} row(s) without a readable date in the partition field went to the '_unknown' partition", unknown_dates));
    }
    for m in cfg.mapping.warnings() { warn(&ctx, m); }

    // Comando dopo la scrittura, per ogni file.
    if !cfg.post_command.is_empty() {
        for w in &done { run_post_command(&ctx, &cfg.post_command, &w.path).await.map_err(nerr)?; }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let rows_written: u64 = done.iter().map(|w| w.rows).sum();
    let completed_at = chrono::Local::now().to_rfc3339();

    if !cfg.webhook_url.is_empty() {
        notify_webhook(&ctx, &cfg.webhook_url, &done, rows_written, &completed_at).await;
    }

    // ── Uscita a valle — SOLO dopo la scrittura completa ──────────
    if let Some(tx) = &tx {
        if replay {
            for r in replay_buf.drain(..) {
                if tx.send(r).await.is_err() { break; }
            }
        } else if !cfg.replay {
            // Una riga di stato per file (nessun file: una riga a zero).
            let rows: Vec<(String, u64, u64, u64)> = if done.is_empty() { vec![(String::new(), 0, 0, elapsed_ms)] }
                else { done.iter().map(|w| (w.path.clone(), w.rows, w.bytes, w.ms)).collect() };
            for (path, n, bytes, ms) in rows {
                let mut sig = Row::new();
                sig.set("status".into(),        Value::String("ok".into()));
                sig.set("rows_written".into(),  Value::Int(n as i64));
                sig.set("bytes_written".into(), Value::Int(bytes as i64));
                sig.set("file_path".into(),     Value::String(path));
                sig.set("completed_at".into(),  Value::DateTime(completed_at.clone()));
                sig.set("error_message".into(), Value::String(String::new()));
                sig.set("duration_ms".into(),   Value::Int(ms as i64));
                if tx.send(sig).await.is_err() { break; }
            }
        }
    }

    let stats = NodeStats { rows_in, rows_out: rows_written, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

/// Il comando di shell dopo la scrittura di un file.
async fn run_post_command(ctx: &NodeContext, template: &str, file: &str) -> Result<(), String> {
    let cmd = template.replace("${file}", file);
    let mut c = if cfg!(windows) {
        let mut c = tokio::process::Command::new("cmd"); c.arg("/C").arg(&cmd); c
    } else {
        let mut c = tokio::process::Command::new("sh"); c.arg("-c").arg(&cmd); c
    };
    c.env("FP_FILE", file);
    let out = c.output().await.map_err(|e| format!("post-write command could not start: {}", e))?;
    if !out.status.success() {
        let err = String::from_utf8_lossy(&out.stderr);
        let tail: String = err.trim().chars().rev().take(500).collect::<Vec<_>>().into_iter().rev().collect();
        return Err(format!("post-write command failed ({}): {}", out.status, tail));
    }
    ctx.emit_log(&ctx.label, "info", 0, format!("post-write command done for {}", file), "panel");
    Ok(())
}

/// POST JSON a fine scrittura. Un errore qui non annulla i file scritti:
/// diventa un avviso.
async fn notify_webhook(ctx: &NodeContext, url: &str, done: &[Written], rows: u64, completed_at: &str) {
    let body = serde_json::json!({
        "status":       "ok",
        "node":         ctx.label,
        "run_id":       ctx.run_id,
        "rows_written": rows,
        "completed_at": completed_at,
        "files": done.iter().map(|w| serde_json::json!({
            "file_path": w.path, "rows_written": w.rows, "bytes_written": w.bytes,
        })).collect::<Vec<_>>(),
    });
    let client = match reqwest::Client::builder().timeout(std::time::Duration::from_secs(30)).build() {
        Ok(c) => c,
        Err(e) => { warn(ctx, format!("completion webhook not sent: {}", e)); return }
    };
    match client.post(url).json(&body).send().await {
        Ok(r) if r.status().is_success() => {}
        Ok(r)  => warn(ctx, format!("completion webhook answered {}", r.status())),
        Err(e) => warn(ctx, format!("completion webhook not sent: {}", e)),
    }
}

// ─── Helpers (usati anche da sink_ftp) ─────────────────────────────

pub(crate) fn write_str<W: Write>(w: &mut W, s: &str, bytes: &mut u64) -> Result<(), String> {
    *bytes += s.len() as u64;
    w.write_all(s.as_bytes()).map_err(|e| format!("Write error: {}", e))
}

pub(crate) fn row_to_json(row: &Row) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    let mut keys: Vec<&String> = row.0.keys().collect();
    keys.sort();
    for k in keys {
        if let Some(v) = row.get(k) {
            obj.insert(k.clone(), v.to_json());
        }
    }
    serde_json::Value::Object(obj)
}

pub(crate) fn escape_csv(s: &str, delimiter: char, quote: char) -> String {
    if s.contains(delimiter) || s.contains(quote) || s.contains('\n') || s.contains('\r') {
        let doubled = s.replace(quote, &format!("{}{}", quote, quote));
        format!("{}{}{}", quote, doubled, quote)
    } else {
        s.to_string()
    }
}

pub(crate) fn escape_xml(s: &str) -> String {
    s.replace('&', "&amp;")
     .replace('<', "&lt;")
     .replace('>', "&gt;")
     .replace('"', "&quot;")
     .replace('\'', "&apos;")
}

pub(crate) fn sanitize_tag(s: &str) -> String {
    let mut result = String::new();
    for c in s.chars() {
        if c.is_alphanumeric() || c == '_' || c == '-' { result.push(c); }
    }
    if result.chars().next().map_or(true, |c| c.is_ascii_digit()) {
        result.insert(0, '_');
    }
    if result == "_" { "_field".to_string() } else { result }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percorsi() {
        assert_eq!(with_suffix("/d/out.csv", "EU"), "/d/out_EU.csv");
        assert_eq!(with_suffix("/d/out.tar.gz", "1"), "/d/out_1.tar.gz");
        assert_eq!(with_suffix("out", "x"), "out_x");
        assert_eq!(safe_key("a/b:c"), "a_b_c");
        assert_eq!(safe_key(""), "_empty");
        assert_eq!(safe_key("../x"), "__x");
        let now = chrono::Local::now();
        let p = expand_path("/d/${partition}/r_${date}.csv", Some("EU"), &now);
        assert_eq!(p, format!("/d/EU/r_{}.csv", now.format("%Y-%m-%d")));
        assert!(!expand_path("/d/${uuid}.csv", None, &now).contains("${"));
    }

    #[test]
    fn json_in_ordine() {
        let mut r = Row::new();
        r.set("b".into(), Value::Int(1));
        r.set("a".into(), Value::String("x".into()));
        let k = vec!["b".to_string(), "a".to_string()];
        assert_eq!(json_object(&r, &k, 0), r#"{"b":1,"a":"x"}"#);
        assert_eq!(json_object(&r, &k, 4), "{\n    \"b\": 1,\n    \"a\": \"x\"\n}");
    }

    #[test]
    fn date() {
        assert!(parse_when(&Value::String("2026-10-23T14:05:00+02:00".into())).is_some());
        assert!(parse_when(&Value::String("2026-10-23 14:05:00".into())).is_some());
        assert_eq!(parse_when(&Value::String("2026-10-23".into())).unwrap().format("%Y-%m").to_string(), "2026-10");
        assert!(parse_when(&Value::String("ieri".into())).is_none());
    }
}
