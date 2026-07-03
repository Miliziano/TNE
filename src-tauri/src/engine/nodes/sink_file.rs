// ─── src-tauri/src/engine/nodes/sink_file.rs ───────────────────────
//
// Riceve righe dal canale e le scrive in un file CSV.
// Flush periodico per non tenere tutto in memoria.

use std::io::{BufWriter, Write};
use std::fs::File;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowReceiver, NodeContext};

#[derive(serde::Deserialize)]
struct SinkFileConfig {
    path:          String,
    delimiter:     Option<char>,
    write_header:  Option<bool>,
    // "overwrite" | "append" — default: overwrite
    mode:          Option<String>,
}

const PROGRESS_EVERY_ROWS: u64 = 500;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
) -> Result<NodeStats, String> {

    let config: SinkFileConfig = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("sink_file config non valida: {}", e))?;

    let delimiter    = config.delimiter.unwrap_or(',');
    let write_header = config.write_header.unwrap_or(true);
    let append       = config.mode.as_deref() == Some("append");

    // Apri/crea il file in scrittura
    let file = if append {
        std::fs::OpenOptions::new()
            .append(true)
            .create(true)
            .open(&config.path)
            .map_err(|e| format!("Impossibile aprire '{}' in append: {}", config.path, e))?
    } else {
        File::create(&config.path)
            .map_err(|e| format!("Impossibile creare '{}': {}", config.path, e))?
    };

    // BufWriter accumula le scritture in memoria e le fa in blocchi —
    // molto più efficiente che scrivere un carattere alla volta sul disco
    let mut writer = BufWriter::new(file);

    let (mut rows_in, mut rows_written) = (0u64, 0u64);
    let start = Instant::now();
    let mut last_progress = Instant::now();
    let mut headers_written = false;
    let mut column_order: Vec<String> = Vec::new();

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Alla prima riga: determina l'ordine delle colonne
        // (le HashMap non hanno ordine garantito — usiamo la prima
        // riga come riferimento per l'header)
        if column_order.is_empty() {
            column_order = row.0.keys().cloned().collect();
            column_order.sort();  // ordine alfabetico per consistenza

            if write_header && !headers_written {
                let header_line = column_order
                    .iter()
                    .map(|h| escape_csv(h, delimiter))
                    .collect::<Vec<_>>()
                    .join(&delimiter.to_string());
                writeln!(writer, "{}", header_line)
                    .map_err(|e| format!("Errore scrittura header: {}", e))?;
                headers_written = true;
            }
        }

        // Scrivi la riga nel CSV
        let data_line = column_order
            .iter()
            .map(|col| {
                let val = row.get(col)
                    .map(|v| v.as_str_repr())
                    .unwrap_or_default();
                escape_csv(&val, delimiter)
            })
            .collect::<Vec<_>>()
            .join(&delimiter.to_string());

        writeln!(writer, "{}", data_line)
            .map_err(|e| format!("Errore scrittura riga {}: {}", rows_in, e))?;

        rows_written += 1;

        // Flush periodico — garantisce che i dati arrivino sul disco
        // anche durante l'esecuzione (utile se l'utente monitora il file)
        let should_progress = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_progress.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;

        if should_progress {
            writer.flush()
                .map_err(|e| format!("Errore flush: {}", e))?;
            let elapsed_secs = start.elapsed().as_secs_f64();
            let rps = if elapsed_secs > 0.0 { rows_in as f64 / elapsed_secs } else { 0.0 };
            ctx.emit_progress(rows_in, rows_written, 0, rps);
            last_progress = Instant::now();
        }
    }

    // Flush finale — assicura che le ultime righe vengano scritte
    writer.flush()
        .map_err(|e| format!("Errore flush finale: {}", e))?;

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in,
        rows_out:      rows_written,
        rows_rejected: 0,
        elapsed_ms,
        error:         None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

fn escape_csv(s: &str, delimiter: char) -> String {
    if s.contains(delimiter) || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('"', "\"\""))
    } else {
        s.to_string()
    }
}
