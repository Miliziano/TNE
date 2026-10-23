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
//
// P366 — opzioni del pannello applicate:
//   keyField + onDuplicate  (il dataset, non le righe che passano a valle)
//       all       — tutte le righe; una chiave → più righe (default: era
//                   l'unico comportamento, i progetti esistenti non cambiano)
//       overwrite — per chiave resta l'ULTIMA riga (al posto della prima)
//       keep      — per chiave resta la PRIMA riga
//       error     — una chiave ripetuta ferma il nodo
//   maxRows + onOverflow (error | truncate → reject)
//   riga di stato (buffer_signal): name, row_count, status "done",
//   completed_at, elapsed_ms, truncated — lo schema dichiarato dallo studio
//   (prima: rows/name/elapsed_ms/truncated, nomi che lo studio non mostrava).
//   Il dataset vive quanto l'esecuzione della lane (nel continuo: una
//   sessione); "clearOn" del pannello non c'è più.

use std::time::Instant;
use std::collections::HashMap;
use crate::engine::types::*;
use crate::engine::datasets::Dataset;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext, make_drain, take_primary_output};

pub async fn run(
    ctx:    NodeContext,
    mut rx: RowReceiver,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    // Uscite: 'output' primaria (fallback drain se non collegata) e 'reject'
    // opzionale — le righe TRONCATE per superamento di maxRows (onOverflow≠
    // 'error') ci finiscono invece di sparire in silenzio. Togli reject prima
    // del primario così take_primary_output non lo pesca. Modello di filter.
    let reject_tx = outputs.remove("reject");
    let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);

    // Migrato alla spec (Fase 12). Caso "tutto props": scalari verbatim,
    // niente FPEL né strutture compilate. Il motore legge le chiavi del
    // pannello (camelCase) via Spec — il case builder che le rinominava
    // in snake_case è stato rimosso. V. node-spec §23.
    let spec = crate::engine::spec::Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("materialize {}: {}", ctx.node_id.0, e))?;

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
    let on_duplicate = { let d = spec.str_or("onDuplicate", "all");
                         if d.is_empty() { "all".to_string() } else { d } };
    if !matches!(on_duplicate.as_str(), "all" | "array" | "overwrite" | "keep" | "error") {
        return Err(format!("materialize {}: unknown duplicate policy '{}'", ctx.node_id.0, on_duplicate));
    }
    spec.log_unconsumed("materialize", &ctx.node_id.0);

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
                bail!(format!("materialize {}: exceeded the limit of {} rows",
                              ctx.node_id.0, max_rows));
            }
            truncated = true;
            // truncate: la riga non entra nel dataset → al reject, se collegato
            if let Some(rej) = &reject_tx { let _ = rej.send(row).await; }
            continue;
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

    // ── Chiavi ripetute (P366) ─────────────────────────────────────
    if let Some(kf) = &key_field {
        if on_duplicate != "all" && on_duplicate != "array" {
            match dedup_by_key(buffer, kf, &on_duplicate) {
                Ok(b) => buffer = b,
                Err(k) => bail!(format!("materialize {}: duplicate key '{}' in field '{}' (on duplicate = error)",
                                        ctx.node_id.0, k, kf)),
            }
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
            signal.set("name".to_string(),         Value::String(name.clone()));
            signal.set("row_count".to_string(),    Value::Int(buffer.len() as i64));
            signal.set("status".to_string(),       Value::String("done".into()));
            signal.set("completed_at".to_string(), Value::DateTime(chrono::Local::now().to_rfc3339()));
            signal.set("elapsed_ms".to_string(),   Value::Int(start.elapsed().as_millis() as i64));
            signal.set("truncated".to_string(),    Value::Bool(truncated));
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

        other => bail!(format!("materialize {}: unknown mode '{}'",
                               ctx.node_id.0, other)),
    }

    let rows_rejected = if truncated { rows_in.saturating_sub(max_rows) } else { 0 };

    // Conteggi per handle di uscita → badge sul canvas (come filter).
    let mut per_out: HashMap<String, u64> = HashMap::new();
    per_out.insert("output".to_string(), rows_out);
    per_out.insert("reject".to_string(), rows_rejected);
    ctx.emit_output_stats(per_out);

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected,
        elapsed_ms: start.elapsed().as_millis() as u64,
        error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

/// Una riga per chiave: `overwrite` tiene l'ultima (al posto della prima),
/// `keep` la prima; `error` → Err(chiave ripetuta).
fn dedup_by_key(rows: Vec<Row>, key_field: &str, policy: &str) -> Result<Vec<Row>, String> {
    let mut pos: HashMap<String, usize> = HashMap::new();
    let mut out: Vec<Row> = Vec::with_capacity(rows.len());
    for row in rows {
        let k = row.get(key_field).map(|v| v.as_str_repr()).unwrap_or_default();
        match pos.get(&k) {
            None => { pos.insert(k, out.len()); out.push(row); }
            Some(&i) => match policy {
                "overwrite" => out[i] = row,
                "error"     => return Err(k),
                _           => {}   // keep
            },
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn r(id: i64, v: &str) -> Row {
        let mut row = Row::new();
        row.set("id".into(), Value::Int(id));
        row.set("v".into(), Value::String(v.into()));
        row
    }

    #[test]
    fn chiavi_ripetute() {
        let rows = || vec![r(1, "a"), r(2, "b"), r(1, "c")];
        let v = |rs: Vec<Row>| rs.iter().map(|x| x.get("v").unwrap().as_str_repr()).collect::<Vec<_>>();
        assert_eq!(v(dedup_by_key(rows(), "id", "overwrite").unwrap()), vec!["c", "b"]);
        assert_eq!(v(dedup_by_key(rows(), "id", "keep").unwrap()), vec!["a", "b"]);
        assert_eq!(dedup_by_key(rows(), "id", "error").unwrap_err(), "1");
    }
}
