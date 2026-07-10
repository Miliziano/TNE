// ─── src-tauri/src/engine/nodes/union.rs ───────────────────────────
//
// Unisce N flussi in uno. Vedi docs/design-union.md.
//
// PRINCIPIO: lo schema di uscita è deciso a DESIGN-TIME dal pannello, che
// produce una mappatura esplicita (campo di uscita → campo sorgente, per
// ogni handle). Il motore la applica meccanicamente: nessuna inferenza sui
// tipi, nessun campionamento dei valori. Deterministico e traducibile dal
// codegen.
//
// Modalità (tutte streaming, nessuna materializzazione):
//   concat — input_main fino alla fine, poi il secondo, ecc.
//   mix    — da qualunque input abbia righe pronte (ordine non garantito)
//   zip    — una riga per input, fusa in una sola riga di uscita
//
// `outputOrder` NON è supportato: ordinare richiede di materializzare
// tutte le righe, ed è mestiere di un nodo `sort`.

use std::collections::HashMap;
use std::time::Instant;
use serde::Deserialize;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config (prodotta dal pannello) ────────────────────────────────

#[derive(Deserialize)]
struct UnionField {
    name: String,
    /// handle → nome del campo IN QUEL FLUSSO.
    /// Un handle assente da questa mappa non alimenta il campo → null.
    #[serde(default)]
    from: HashMap<String, String>,
}

#[derive(Deserialize)]
struct UnionConfig {
    #[serde(default = "default_mode")]
    mode: String,
    #[serde(default)]
    fields: Vec<UnionField>,
    /// "null" (default) — il campo esiste ma è nullo
    /// "omit"          — il campo è assente dalla riga
    #[serde(default = "default_missing")]
    missing_field: String,
    #[serde(default)]
    add_source_field: bool,
    #[serde(default = "default_source_name")]
    source_field_name: String,
    /// zip: "truncate" (default) | "pad_null" | "error"
    #[serde(default = "default_zip_mismatch")]
    zip_mismatch: String,
    /// handle → etichetta leggibile ("flusso 1", "flusso 2"…),
    /// usata per `_union_source`.
    #[serde(default)]
    handle_labels: HashMap<String, String>,
}

fn default_mode()         -> String { "concat".to_string() }
fn default_missing()      -> String { "null".to_string() }
fn default_source_name()  -> String { "_union_source".to_string() }
fn default_zip_mismatch() -> String { "truncate".to_string() }

// ─── Proiezione di una riga sullo schema di uscita ─────────────────

/// Applica la mappatura: per ogni campo di uscita prende il valore dal
/// campo sorgente dichiarato per QUESTO handle, o null.
fn project(row: &Row, handle: &str, cfg: &UnionConfig) -> Row {
    let mut out = Row::new();
    let omit = cfg.missing_field == "omit";

    for f in &cfg.fields {
        match f.from.get(handle) {
            Some(src) => {
                let v = row.get(src).cloned().unwrap_or(Value::Null);
                out.set(f.name.clone(), v);
            }
            None => {
                // Questo flusso non ha questo campo.
                if !omit { out.set(f.name.clone(), Value::Null); }
            }
        }
    }

    if cfg.add_source_field {
        let label = cfg.handle_labels.get(handle).cloned()
            .unwrap_or_else(|| handle.to_string());
        out.set(cfg.source_field_name.clone(), Value::String(label));
    }
    out
}

/// Se il pannello non ha prodotto la mappatura (config vuota), passa le
/// righe invariate. Evita che un flusso smetta di funzionare per una
/// config mancante, ma è un ripiego: lo schema non è unificato.
fn passthrough(row: Row, handle: &str, cfg: &UnionConfig) -> Row {
    if !cfg.add_source_field { return row }
    let mut out = row;
    let label = cfg.handle_labels.get(handle).cloned()
        .unwrap_or_else(|| handle.to_string());
    out.set(cfg.source_field_name.clone(), Value::String(label));
    out
}

// ─── Esecuzione ────────────────────────────────────────────────────

pub async fn run(
    ctx:    NodeContext,
    inputs: Vec<(String, RowReceiver)>,   // (handle, receiver), in ordine
    tx:     RowSender,
) -> Result<NodeStats, String> {

    let cfg: UnionConfig = serde_json::from_value(ctx.config.clone())
        .map_err(|e| format!("union {}: config non valida: {}", ctx.node_id.0, e))?;

    if inputs.is_empty() {
        return Err(format!("union {}: nessun flusso collegato", ctx.node_id.0));
    }
    if cfg.fields.is_empty() {
        eprintln!("[union][WARN] {}: nessuna mappatura campi — le righe passano \
                   invariate, lo schema NON è unificato. Apri il tab Mapping.",
                  ctx.node_id.0);
    }

    let start = Instant::now();
    let has_mapping = !cfg.fields.is_empty();

    let (rows_in, rows_out) = match cfg.mode.as_str() {
        "concat" => run_concat(&ctx, inputs, &tx, &cfg, has_mapping).await?,
        "mix"    => run_mix(&ctx, inputs, &tx, &cfg, has_mapping).await?,
        "zip"    => run_zip(&ctx, inputs, &tx, &cfg).await?,
        other    => return Err(format!("union {}: modalità sconosciuta '{}'", ctx.node_id.0, other)),
    };

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats { rows_in, rows_out, rows_rejected: 0, elapsed_ms, error: None };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── concat: un flusso dopo l'altro ────────────────────────────────

async fn run_concat(
    ctx: &NodeContext,
    inputs: Vec<(String, RowReceiver)>,
    tx: &RowSender,
    cfg: &UnionConfig,
    has_mapping: bool,
) -> Result<(u64, u64), String> {
    let (mut rows_in, mut rows_out) = (0u64, 0u64);
    let mut last_prog = Instant::now();
    let start = Instant::now();

    for (handle, mut rx) in inputs {
        while let Some(row) = rx.recv().await {
            rows_in += 1;
            let out = if has_mapping { project(&row, &handle, cfg) }
                      else           { passthrough(row, &handle, cfg) };
            if tx.send(out).await.is_err() { return Ok((rows_in, rows_out)) }
            rows_out += 1;
            emit_progress(ctx, rows_in, rows_out, &start, &mut last_prog);
        }
    }
    Ok((rows_in, rows_out))
}

// ─── mix: da chiunque abbia righe pronte ───────────────────────────
//
// Round-robin non bloccante: prova ogni input con try_recv; se nessuno ha
// righe pronte, attende sul primo ancora vivo. Evita di dipendere da
// tokio-stream per un select_all su N receiver.

async fn run_mix(
    ctx: &NodeContext,
    inputs: Vec<(String, RowReceiver)>,
    tx: &RowSender,
    cfg: &UnionConfig,
    has_mapping: bool,
) -> Result<(u64, u64), String> {
    use tokio::sync::mpsc::error::TryRecvError;

    let (mut rows_in, mut rows_out) = (0u64, 0u64);
    let mut last_prog = Instant::now();
    let start = Instant::now();

    let mut live: Vec<(String, RowReceiver)> = inputs;

    while !live.is_empty() {
        let mut progressed = false;

        // Giro non bloccante: prendi una riga da ogni input che ne ha.
        let mut i = 0;
        while i < live.len() {
            match live[i].1.try_recv() {
                Ok(row) => {
                    rows_in += 1;
                    let handle = live[i].0.clone();
                    let out = if has_mapping { project(&row, &handle, cfg) }
                              else           { passthrough(row, &handle, cfg) };
                    if tx.send(out).await.is_err() { return Ok((rows_in, rows_out)) }
                    rows_out += 1;
                    progressed = true;
                    emit_progress(ctx, rows_in, rows_out, &start, &mut last_prog);
                    i += 1;
                }
                Err(TryRecvError::Empty) => { i += 1; }
                Err(TryRecvError::Disconnected) => { live.remove(i); }
            }
        }

        // Nessuno aveva righe pronte: attendi sul primo, senza busy-wait.
        if !progressed && !live.is_empty() {
            match live[0].1.recv().await {
                Some(row) => {
                    rows_in += 1;
                    let handle = live[0].0.clone();
                    let out = if has_mapping { project(&row, &handle, cfg) }
                              else           { passthrough(row, &handle, cfg) };
                    if tx.send(out).await.is_err() { return Ok((rows_in, rows_out)) }
                    rows_out += 1;
                    emit_progress(ctx, rows_in, rows_out, &start, &mut last_prog);
                }
                None => { live.remove(0); }
            }
        }
    }
    Ok((rows_in, rows_out))
}

// ─── zip: una riga per input, fuse in una ──────────────────────────

async fn run_zip(
    ctx: &NodeContext,
    inputs: Vec<(String, RowReceiver)>,
    tx: &RowSender,
    cfg: &UnionConfig,
) -> Result<(u64, u64), String> {
    let (mut rows_in, mut rows_out) = (0u64, 0u64);
    let mut last_prog = Instant::now();
    let start = Instant::now();

    if cfg.fields.is_empty() {
        return Err(format!("union {}: la modalità zip richiede la mappatura \
                            dei campi (tab Mapping)", ctx.node_id.0));
    }

    let mut live: Vec<(String, RowReceiver, bool)> = inputs.into_iter()
        .map(|(h, rx)| (h, rx, true))   // true = ancora attivo
        .collect();

    loop {
        // Una riga da ciascun input ancora attivo.
        let mut batch: Vec<(String, Option<Row>)> = Vec::with_capacity(live.len());
        for (handle, rx, alive) in live.iter_mut() {
            if !*alive { batch.push((handle.clone(), None)); continue }
            match rx.recv().await {
                Some(row) => { rows_in += 1; batch.push((handle.clone(), Some(row))); }
                None      => { *alive = false; batch.push((handle.clone(), None)); }
            }
        }

        let got  = batch.iter().filter(|(_, r)| r.is_some()).count();
        let want = live.len();

        if got == 0 { break }                       // tutti finiti

        if got < want {
            match cfg.zip_mismatch.as_str() {
                "truncate" => break,                // ferma al più corto
                "error"    => return Err(format!(
                    "union {}: zip — i flussi hanno lunghezza diversa \
                     (zip_mismatch=error)", ctx.node_id.0)),
                _ => { /* pad_null: prosegui, i mancanti danno null */ }
            }
        }

        // Fonde i campi presenti; i mancanti restano null.
        let mut out = Row::new();
        for f in &cfg.fields { out.set(f.name.clone(), Value::Null); }

        for (handle, maybe_row) in &batch {
            let Some(row) = maybe_row else { continue };
            for f in &cfg.fields {
                if let Some(src) = f.from.get(handle) {
                    if let Some(v) = row.get(src) {
                        out.set(f.name.clone(), v.clone());
                    }
                }
            }
        }

        if tx.send(out).await.is_err() { break }
        rows_out += 1;
        emit_progress(ctx, rows_in, rows_out, &start, &mut last_prog);
    }

    Ok((rows_in, rows_out))
}

// ─── Progress ──────────────────────────────────────────────────────

const PROGRESS_EVERY_ROWS: u64 = 1000;
const PROGRESS_EVERY_MS:   u64 = 500;

fn emit_progress(
    ctx: &NodeContext, rows_in: u64, rows_out: u64,
    start: &Instant, last: &mut Instant,
) {
    let due = rows_in % PROGRESS_EVERY_ROWS == 0
        || last.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
    if due {
        let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
        ctx.emit_progress(rows_in, rows_out, 0, rps);
        *last = Instant::now();
    }
}