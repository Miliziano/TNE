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
use crate::engine::executor::{RowSender, NodeContext, RowReceiver};

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
    /// Excel/ODS (P342): foglio ("" = il primo) e riga da cui partire (1 = prima).
    sheet_name: String,
    start_row:  u64,
}

fn config_from_spec(spec: &Spec) -> Result<SourceFileConfig, String> {
    // `fields`: schema-proiezione, elaborato dal builder → spec.config.
    let fields: Vec<FieldType> =
        serde_json::from_value(
            spec.config().get("fields").cloned().unwrap_or(serde_json::json!([]))
        ).map_err(|e| format!("invalid fields schema: {}", e))?;

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
        sheet_name: spec.str_or("sheetName", ""),
        start_row:  spec.u64_or("startRow", 1).max(1),
    })
}

const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx: NodeContext,
    // R8 — "barriera + parametri". Opzionale: se il nodo non ha archi in
    // ingresso non c'è niente da aspettare. Se ce l'ha, si drena fino alla
    // chiusura del canale — che È l'attesa (R7) — e si tiene la riga di
    // parametri. Prima questo receiver non veniva MAI preso: il canale si
    // chiudeva, le send a monte fallivano e `let _ =` le ingoiava, quindi
    // le righe sparivano in silenzio. V. nodes/source_input.rs.
    rx:  Option<RowReceiver>,
    tx:  Option<RowSender>,
) -> Result<NodeStats, String> {

    // Aspetta chi sta a monte, se c'è. Da qui in poi il nodo a monte ha
    // finito: è la garanzia di ordine che l'arco porta anche quando non
    // porta dati.
    let _params = super::source_input::await_params(
        &ctx.node_id.0, "source_file", rx,
    ).await?;
    // ⚠️ `_params` non è ancora usato: il BINDING dei parametri nella query
    // aspetta una decisione aperta — con quale sintassi la query cita un
    // campo in arrivo (contratto-porte.md §10). Va fatto con `.bind()`
    // tipizzato di sqlx, MAI per interpolazione di stringa: aprirebbe la
    // SQL injection sul valore calcolato a monte e violerebbe "Decimal mai
    // via f64". Fino ad allora il comportamento è quello di window.rs caso
    // 1: l'ingresso è un INNESCO, la riga si scarta.

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

    // ── Excel / OpenDocument (P342) ─────────────────────────────────
    // 🐞 Prima il formato "excel" (offerto dal pannello) non aveva un lettore nel
    // motore: il file binario veniva letto come CSV e usciva spazzatura. Ora lo
    // legge calamine (xlsx, xlsm, xlsb, xls, ods), la stessa via che usa
    // l'anteprima dello studio.
    if matches!(config.format.as_str(), "excel" | "xlsx" | "xlsm" | "xlsb" | "xls" | "ods") {
        let start = std::time::Instant::now();
        let rows = {
            let (path, sheet, start_row, has_header) =
                (path.clone(), config.sheet_name.clone(), config.start_row, has_header);
            let types: std::collections::HashMap<String, String> = config.fields.iter()
                .map(|f| (f.name.clone(), f.ty.clone())).collect();
            tokio::task::spawn_blocking(move || read_excel(&path, &sheet, start_row, has_header, &types))
                .await
                .map_err(|e| format!("source_file {}: Excel reader crashed: {}", ctx.node_id.0, e))?
        };
        let rows = match rows {
            Ok(r) => r,
            Err(e) => {
                let msg = format!("source_file {}: {}", ctx.node_id.0, e);
                ctx.emit_completed(NodeStats {
                    rows_in: 0, rows_out: 0, rows_rejected: 0,
                    elapsed_ms: start.elapsed().as_millis() as u64,
                    error: Some(msg.clone()),
                });
                return Err(msg);
            }
        };
        let mut rows_out = 0u64;
        for row in rows {
            if tx.send(row).await.is_err() { break; }
            rows_out += 1;
        }
        let stats = NodeStats {
            rows_in: 0, rows_out, rows_rejected: 0,
            elapsed_ms: start.elapsed().as_millis() as u64,
            error: None,
        };
        ctx.emit_completed(stats.clone());
        return Ok(stats);
    }

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
                let msg = format!("source_file {}: cannot read '{}': {}",
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
                let _ = line_tx.blocking_send(Err(format!("Cannot open '{}': {}", path_clone, e)));
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
                    let _ = line_tx.blocking_send(Err(format!("Read error: {}", e)));
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

pub(crate) fn parse_csv_line(line: &str, delimiter: u8) -> Vec<String> {
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
