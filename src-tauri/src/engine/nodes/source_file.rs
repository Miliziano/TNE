// ─── src-tauri/src/engine/nodes/source_file.rs ─────────────────────
//
// Legge un file CSV riga per riga e invia ogni riga nel canale
// verso il nodo successivo.
//
// CONCETTI RUST NUOVI:
//
// 1. `BufReader` — lettore bufferizzato. Invece di leggere un byte
//    alla volta dal file (lentissimo), legge blocchi da 8KB e li
//    tiene in memoria. Ogni lines() poi itera sulle righe già in
//    buffer senza ulteriori I/O. Quasi sempre vuoi BufReader quando
//    leggi file riga per riga.
//
// 2. `std::time::Instant` — timer ad alta risoluzione per misurare
//    il throughput. Instant::now() campiona l'ora corrente,
//    .elapsed() restituisce la durata dall'ultimo campionamento.
//
// 3. `as f64` — cast esplicito tra tipi numerici. In Rust non esistono
//    coercioni implicite tra tipi numerici — devi dire esplicitamente
//    "tratta questo u64 come f64". È più verboso ma elimina una
//    classe intera di bug silenziosamente presenti in JS.

// ─── src-tauri/src/engine/nodes/source_file.rs ─────────────────────
//
// FIX: la lettura CSV è sincrona (std::io) — dentro un task Tokio
// bloccherebbe il thread del pool impedendo agli altri task (filter,
// sink) di girare. La soluzione è spawn_blocking: Tokio riserva un
// thread dedicato per operazioni bloccanti, lasciando libero il pool
// async per il resto della pipeline.
//
// Il pattern è:
//   1. spawn_blocking → legge riga dal file (bloccante, thread dedicato)
//   2. manda la riga sul canale tx (asincrono, torna nel pool Tokio)
//   3. ripeti

use std::io::{BufRead, BufReader};
use std::fs::File;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, NodeContext};

#[derive(serde::Deserialize)]
struct FieldType {
    name: String,
    #[serde(rename = "type")]
    ty:   String,
}

// Config migrata alla spec (Fase 12). Scalari verbatim dalle props;
// `fields` è la PROIEZIONE per l'esecuzione dello schema (il builder
// mappa nome logico → physicalName dell'header CSV), quindi è materiale
// elaborato e viaggia in spec.config. V. node-spec §13.
struct SourceFileConfig {
    path:       String,
    format:     String,
    delimiter:  char,
    has_header: bool,
    fields:     Vec<FieldType>,
}

fn config_from_spec(spec: &Spec) -> Result<SourceFileConfig, String> {
    // `fields`: schema-proiezione, elaborato dal builder → spec.config.
    let fields: Vec<FieldType> =
        serde_json::from_value(
            spec.config().get("fields").cloned().unwrap_or(serde_json::json!([]))
        ).map_err(|e| format!("schema campi non valido: {}", e))?;

    // delimiter: prima char di una stringa (default ',').
    let delim_str = spec.str_or("delimiter", ",");
    let delimiter = delim_str.chars().next().unwrap_or(',');

    Ok(SourceFileConfig {
        path:       spec.str_or("path", ""),
        format:     spec.str_or("format", "csv"),
        delimiter,
        // Il pannello salva `hasHeader` (camelCase). Il vecchio builder
        // leggeva `has_header` — chiave mai prodotta → sempre true (bug).
        // Leggendo la chiave vera, l'impostazione dell'utente ora conta.
        has_header: spec.bool_or("hasHeader", true),
        fields,
    })
}

const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx: NodeContext,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("source_file {}: {}", ctx.node_id.0, e))?;
    let config = config_from_spec(&spec)
        .map_err(|e| format!("source_file {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("source_file", &ctx.node_id.0);

    let delimiter  = config.delimiter as u8;
    let has_header = config.has_header;
    let path       = config.path.clone();
    let type_of: std::collections::HashMap<&str, &str> = config.fields.iter()
        .map(|f| (f.name.as_str(), f.ty.as_str()))
        .collect();

    let tx = match tx {
        Some(t) => t,
        None => return Ok(NodeStats { rows_in: 0, rows_out: 0, rows_rejected: 0, elapsed_ms: 0, error: None }),
    };

    // ── Formati "documento intero" (xml, json) ──────────────────────
    // Vanno letti come UN unico contenuto in un campo `content` (una sola
    // riga in uscita), non spezzati per righe come il CSV. È ciò che i
    // parser a valle (xml_parser, json_parser) si aspettano nel loro
    // campo sorgente. jsonl resta riga-per-riga (una riga per record).
    if config.format == "xml" || config.format == "json" {
        let start = std::time::Instant::now();
        let content = match std::fs::read_to_string(&path) {
            Ok(c) => c,
            Err(e) => {
                let msg = format!("source_file {}: impossibile leggere '{}': {}",
                                  ctx.node_id.0, path, e);
                ctx.emit_completed(NodeStats {
                    rows_in: 0, rows_out: 0, rows_rejected: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    error: Some(msg.clone()),
                });
                return Err(msg);
            }
        };

        let mut row = Row(std::collections::HashMap::new());
        row.0.insert("content".to_string(), Value::String(content));
        let _ = tx.send(row).await;

        let stats = NodeStats {
            rows_in: 0, rows_out: 1, rows_rejected: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
            error: None,
        };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

    // Leggi tutte le righe in spawn_blocking (thread dedicato per I/O sincrono)
    // poi invia le righe parsed sul canale asincrono.
    // Per file grandi, invece di caricare tutto in memoria, usiamo
    // un canale interno per fare streaming anche tra il thread bloccante
    // e il task asincrono.
    let (line_tx, mut line_rx) = tokio::sync::mpsc::channel::<Result<Vec<String>, String>>(1000);

    let path_clone = path.clone();
    tokio::task::spawn_blocking(move || {
        let file = match File::open(&path_clone) {
            Ok(f) => f,
            Err(e) => {
                let _ = line_tx.blocking_send(Err(format!("Impossibile aprire '{}': {}", path_clone, e)));
                return;
            }
        };

        let reader  = BufReader::new(file);
        let mut lines = reader.lines();
        let mut headers: Vec<String> = Vec::new();
        let mut first = true;

        for line_result in lines {
            match line_result {
                Err(e) => {
                    let _ = line_tx.blocking_send(Err(format!("Errore lettura: {}", e)));
                    return;
                }
                Ok(line) => {
                    if line.trim().is_empty() { continue; }

                    let fields = parse_csv_line(&line, delimiter);

                    if first && has_header {
                        headers = fields;
                        first = false;
                        continue;
                    }
                    if first { first = false; }

                    // Se non abbiamo header, usa col_0, col_1, ...
                    let keyed: Vec<String> = if headers.is_empty() {
                        fields.into_iter().enumerate()
                            .flat_map(|(i, v)| vec![format!("col_{}", i), v])
                            .collect()
                    } else {
                        // Intercala header e valori: [key, val, key, val, ...]
                        headers.iter().zip(fields.iter())
                            .flat_map(|(k, v)| vec![k.clone(), v.clone()])
                            .collect()
                    };

                    // blocking_send — versione sincrona di send per thread non-async
                    if line_tx.blocking_send(Ok(keyed)).is_err() {
                        return; // receiver droppato, pipeline interrotta
                    }
                }
            }
        }
        // line_tx droppato qui → line_rx riceverà None
    });

    // Task asincrono: ricevi le righe parsed e mandale sul canale della pipeline
    let mut rows_out: u64 = 0;
    let start = Instant::now();
    let mut last_progress = Instant::now();

    while let Some(result) = line_rx.recv().await {
        match result {
            Err(e) => {
                ctx.emit_failed(e.clone());
                return Err(e);
            }
            Ok(keyed) => {
                // Costruisci la Row dalla lista [key, val, key, val, ...]
                let mut row = Row::new();
                let mut i = 0;
                 while i + 1 < keyed.len() {
                    let name = &keyed[i];
                    let raw  = &keyed[i + 1];
                    let value = match type_of.get(name.as_str()) {
                        Some(t) => coerce(raw, t),
                        None    => Value::String(raw.clone()),  // tipo non dichiarato
                    };
                    row.set(name.clone(), value);
                    i += 2;
                }

                rows_out += 1;

                if tx.send(row).await.is_err() {
                    break; // nodo successivo non disponibile
                }

                let emit = rows_out % PROGRESS_EVERY_ROWS == 0
                    || last_progress.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;

                if emit {
                    let rps = rows_out as f64 / start.elapsed().as_secs_f64().max(0.001);
                    ctx.emit_progress(rows_out, rows_out, 0, rps);
                    last_progress = Instant::now();
                }
            }
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in: 0, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn parse_csv_line(line: &str, delimiter: u8) -> Vec<String> {
    let delim = delimiter as char;
    let mut fields = Vec::new();
    let mut current = String::new();
    let mut in_quotes = false;

    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' if !in_quotes => { in_quotes = true; }
            '"' if in_quotes => {
                if chars.peek() == Some(&'"') {
                    chars.next();
                    current.push('"');
                } else {
                    in_quotes = false;
                }
            }
            c if c == delim && !in_quotes => {
                fields.push(current.trim().to_string());
                current = String::new();
            }
            c => { current.push(c); }
        }
    }
    fields.push(current.trim().to_string());
    fields
}

/// Converte il testo di una cella CSV nel Value corrispondente al tipo
/// dichiarato nel mapping. Un valore non convertibile diventa Null:
/// meglio un null visibile che uno zero silenzioso.
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