// ─── src-tauri/src/engine/nodes/materialize.rs ─────────────────────
//
// Accumula un flusso in memoria. Due usi indipendenti:
//
//   1. BUFFER / BARRIERA — checkpoint prima di nodi che richiedono
//      accesso casuale (sort, join). Non pubblica nulla.
//
//   2. DATASET CONDIVISO — se l'utente lo pubblica nella lane (pulsante
//      nel tab Configurazione), il dataset è leggibile per nome da altri
//      nodi (window, aggregate, pivot, explode, join), SENZA arco e SENZA
//      consumarlo. Un dataset caricato da un source_db si legge una volta
//      sola, anche se tre nodi lo usano.
//
// MODALITÀ (matMode):
//
//   passthrough    — le righe ATTRAVERSANO il nodo verso valle, una alla
//                    volta, mentre vengono salvate nel dataset. Chi sta a
//                    valle non attende. Il dataset è completo a input
//                    esaurito: chi lo legge attende fino a quel momento.
//
//   buffer_signal  — accumula tutto, pubblica il dataset, POI emette una
//                    sola riga di stato. Chi sta a valle attende.
//                    L'ordine conta: il dataset è pubblicato PRIMA del
//                    segnale, così chi riceve la riga sa di poter leggere.
//
// Vedi docs/design-materialize-registry.md.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::datasets::Dataset;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx:    NodeContext,
    mut rx: RowReceiver,
    tx:     RowSender,
) -> Result<NodeStats, String> {

    // Migrato alla spec (Fase 12). Caso "tutto props": scalari verbatim,
    // niente FPEL né strutture compilate. Il motore legge le chiavi del
    // pannello (camelCase) via Spec — il case builder che le rinominava
    // in snake_case è stato rimosso. V. node-spec §23.
    let spec = crate::engine::spec::Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("materialize {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("materialize", &ctx.node_id.0);

    let mode      = { let m = spec.str_or("matMode", "passthrough");
                      if m.is_empty() { "passthrough".to_string() } else { m } };
    let name      = spec.str_or("matName", "");
    let key_field = { let k = spec.str_or("keyField", "");
                      if k.is_empty() { None } else { Some(k) } };
    let publishes = !name.is_empty();

    let max_rows = { let n = spec.usize_or("maxRows", 0);
                     if n > 0 { n as u64 } else { u64::MAX } };
    let on_overflow = { let o = spec.str_or("onOverflow", "error");
                        if o.is_empty() { "error".to_string() } else { o } };

    let start = Instant::now();
    let mut buffer: Vec<Row> = Vec::new();
    let mut rows_in   = 0u64;
    let mut rows_out  = 0u64;
    let mut truncated = false;

    // Se il nodo pubblica e fallisce, chi attende il dataset deve saperlo:
    // altrimenti resta appeso. Ogni ramo d'errore chiama `fail`.
    macro_rules! bail {
        ($msg:expr) => {{
            let msg: String = $msg;
            if publishes { ctx.lane_datasets.fail(&name, msg.clone()).await; }
            return Err(msg);
        }};
    }

    let streaming = mode == "passthrough";

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        if rows_in > max_rows {
            if on_overflow == "error" {
                bail!(format!("materialize {}: superato il limite di {} righe",
                              ctx.node_id.0, max_rows));
            }
            truncated = true;
            continue;   // truncate: la riga è scartata, non entra nel dataset
        }

        if streaming {
            // Le righe scorrono subito verso valle; una copia va nel dataset.
            if tx.send(row.clone()).await.is_ok() { rows_out += 1; }
            buffer.push(row);
        } else {
            buffer.push(row);
        }

        if rows_in % 10_000 == 0 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
        }
    }

    eprintln!("[materialize] {}: {} righe in memoria{}{}",
        ctx.node_id.0, buffer.len(),
        if truncated { " (troncato)" } else { "" },
        if publishes { format!(" — pubblicato come '{}'", name) } else { String::new() });

    // ── Pubblicazione ──────────────────────────────────────────────
    // Prima del segnale: chi riceve la riga di stato sa di poter leggere.
    if publishes {
        let ds = Dataset::new(name.clone(), buffer.clone(), key_field.clone());
        ctx.lane_datasets.publish(&name, ds).await;
    }

    // ── Uscita ─────────────────────────────────────────────────────
    match mode.as_str() {
        "passthrough" => {
            // Le righe sono già state inoltrate durante l'accumulo.
        }

        "buffer_signal" => {
            // Una sola riga di stato: il nodo a valle sa che il dataset
            // è pronto e può leggerlo dal registro.
            let mut signal = Row::new();
            signal.set("rows".to_string(),       Value::Int(buffer.len() as i64));
            signal.set("name".to_string(),       Value::String(name.clone()));
            signal.set("elapsed_ms".to_string(), Value::Int(start.elapsed().as_millis() as i64));
            signal.set("truncated".to_string(),  Value::Bool(truncated));
            if tx.send(signal).await.is_ok() { rows_out = 1; }
        }

        // Compatibilità: il vecchio `buffer_replay` rilasciava le righe
        // dopo averle accumulate. È `buffer_signal` senza segnale.
        "buffer" | "buffer_replay" => {
            for row in &buffer {
                if tx.send(row.clone()).await.is_err() { break }
                rows_out += 1;
            }
        }

        other => bail!(format!("materialize {}: modalità sconosciuta '{}'",
                               ctx.node_id.0, other)),
    }

    let stats = NodeStats {
        rows_in, rows_out,
        rows_rejected: if truncated { rows_in.saturating_sub(buffer.len() as u64) } else { 0 },
        elapsed_ms: start.elapsed().as_millis() as u64,
        error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}