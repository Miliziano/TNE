
// ─── src-tauri/src/engine/nodes/explode.rs ─────────────────────────
//
// Da uno a molti: trasforma qualcosa di collettivo in un flusso di righe.
//
// DUE SORGENTI (explodeSource):
//
//   materialize — legge un dataset pubblicato nella lane e lo emette riga
//                 per riga. È l'accoppiamento naturale col `materialize`:
//                 il buffer torna streaming.
//                 L'input è un trigger (scartato); senza arco, il nodo si
//                 sblocca quando il dataset viene pubblicato.
//
//   flow_field  — per ogni riga in ingresso, esplode un campo collettivo
//                 (array o oggetto) in più righe.
//
// COSA NON FA, per scelta:
//   - navigare strutture annidate (JSONPath) → è mestiere di `json_parser`
//   - trasformare i valori (trim, uppercase…)  → è mestiere di `transform`
//   - leggere variabili di lane                 → caricale in un materialize
//
// Un nodo, una responsabilità.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::spec::Spec;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

// ─── Config ────────────────────────────────────────────────────────
//
// Migrato alla spec (Fase 12): le chiavi sono quelle del pannello,
// verbatim in camelCase (v. docs/node-spec.md §8). Niente più rinomina
// snake_case nel builder.

struct ExplodeConfig {
    source:           String,   // materialize | flow_field
    materialize_name: String,
    field:            String,   // flow_field: campo collettivo da esplodere
    structure_type:   String,   // array | object_values | object_entries
    include_parent:   bool,     // i campi del padre si ripetono su ogni riga
    on_empty:         String,   // skip | null_row | error
    on_primitive:     String,   // wrap | skip | error
    limit:            usize,    // max righe per riga padre (0 = nessun limite)
}

/// Legge la config dalle props del pannello (camelCase, verbatim).
/// I default sono quelli dichiarati in docs/node-spec.md §8.
fn config_from_spec(spec: &Spec) -> ExplodeConfig {
    ExplodeConfig {
        source:           spec.str_or("explodeSource",  "materialize"),
        materialize_name: spec.str_or("materializeName", ""),
        field:            spec.str_or("flowField",       ""),
        structure_type:   spec.str_or("structureType",   "array"),
        include_parent:   spec.bool_or("includeParent",  false),
        on_empty:         spec.str_or("onEmpty",         "skip"),
        on_primitive:     spec.str_or("onPrimitive",     "wrap"),
        limit:            spec.usize_or("limit",         0),
    }
}

// ─── Esecuzione ────────────────────────────────────────────────────

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
    tx:  RowSender,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("explode {}: {}", ctx.node_id.0, e))?;
    let cfg = config_from_spec(&spec);
    spec.log_unconsumed("explode", &ctx.node_id.0);

    let start = Instant::now();

    // Sorgenti rimosse dal contratto (§8): rifiuto parlante invece che
    // silenzioso. `lane_var` non è mai stata implementata nel motore;
    // `json_path` come structureType è mestiere di json_parser.
    if cfg.source == "lane_var" {
        return Err(format!("explode {}: la sorgente 'variabile di lane' non è \
                            supportata. Carica i dati in un Materialize e leggilo da lì.",
                           ctx.node_id.0));
    }
    if cfg.structure_type == "json_path" {
        return Err(format!("explode {}: il tipo 'json_path' non è supportato. Per \
                            navigare una struttura annidata usa un JSON Parser a monte, \
                            poi esplodi il campo array che ne risulta.", ctx.node_id.0));
    }

    match cfg.source.as_str() {
        "materialize" => from_materialize(ctx, rx, tx, cfg, start).await,
        "flow_field"  => from_flow_field(ctx, rx, tx, cfg, start).await,
        other => Err(format!("explode {}: sorgente sconosciuta '{}'", ctx.node_id.0, other)),
    }
}

// ─── Dataset → flusso ──────────────────────────────────────────────

async fn from_materialize(
    ctx:   NodeContext,
    rx:    Option<RowReceiver>,
    tx:    RowSender,
    cfg:   ExplodeConfig,
    start: Instant,
) -> Result<NodeStats, String> {

    if cfg.materialize_name.is_empty() {
        return Err(format!("explode {}: sorgente 'Materialize' senza nome del dataset. \
                            Selezionalo nel pannello.", ctx.node_id.0));
    }

    // L'input, se collegato, è il segnale di partenza: consumalo.
    if let Some(mut rx) = rx {
        while rx.recv().await.is_some() {}
    }

    let ds = ctx.lane_datasets.get(&cfg.materialize_name).await?;
    eprintln!("[explode] {}: dataset '{}' → {} righe",
              ctx.node_id.0, cfg.materialize_name, ds.len());

    if ds.is_empty() {
        match cfg.on_empty.as_str() {
            "error" => return Err(format!("explode {}: il dataset '{}' è vuoto",
                                          ctx.node_id.0, cfg.materialize_name)),
            "null_row" => { let _ = tx.send(Row::new()).await; }
            _ => {}   // skip
        }
    }

    let mut rows_out = 0u64;
    for row in ds.rows() {
        if tx.send(row.clone()).await.is_err() { break }
        rows_out += 1;
        if cfg.limit > 0 && rows_out as usize >= cfg.limit { break }
    }

    let stats = NodeStats {
        rows_in: 0, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── Campo collettivo → righe ──────────────────────────────────────

async fn from_flow_field(
    ctx:   NodeContext,
    rx:    Option<RowReceiver>,
    tx:    RowSender,
    cfg:   ExplodeConfig,
    start: Instant,
) -> Result<NodeStats, String> {

    let Some(mut rx) = rx else {
        return Err(format!("explode {}: nessun input collegato.", ctx.node_id.0));
    };
    if cfg.field.is_empty() {
        return Err(format!("explode {}: nessun campo da esplodere. Selezionalo nel pannello.",
                           ctx.node_id.0));
    }

    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;
    let mut last_prog = Instant::now();

    while let Some(parent) = rx.recv().await {
        rows_in += 1;

        let value = parent.get(&cfg.field);
        let is_null = matches!(value, None | Some(Value::Null));

        if is_null {
            match cfg.on_empty.as_str() {
                "error" => return Err(format!("explode {}: il campo '{}' è null",
                                              ctx.node_id.0, cfg.field)),
                "null_row" => {
                    let row = if cfg.include_parent { parent.clone() } else { Row::new() };
                    if tx.send(row).await.is_err() { break }
                    rows_out += 1;
                }
                _ => {}   // skip
            }
            continue;
        }

        let exploded = explode_value(value.unwrap(), &cfg.structure_type, &cfg.on_primitive)?;

        if exploded.is_empty() {
            match cfg.on_empty.as_str() {
                "error" => return Err(format!("explode {}: il campo '{}' produce una \
                                               struttura vuota", ctx.node_id.0, cfg.field)),
                "null_row" => {
                    let row = if cfg.include_parent { parent.clone() } else { Row::new() };
                    if tx.send(row).await.is_err() { break }
                    rows_out += 1;
                }
                _ => {}
            }
            continue;
        }

        let take = if cfg.limit > 0 { cfg.limit.min(exploded.len()) } else { exploded.len() };

        for child in exploded.into_iter().take(take) {
            let mut out = if cfg.include_parent {
                // I campi del padre, meno quello esploso: sarebbe ridondante
                // e in conflitto con i campi generati.
                let mut r = Row::new();
                for (k, v) in parent.fields() {
                    if k != &cfg.field { r.set(k.clone(), v.clone()) }
                }
                r
            } else {
                Row::new()
            };
            for (k, v) in child.fields() { out.set(k.clone(), v.clone()) }

            if tx.send(out).await.is_err() { break }
            rows_out += 1;
        }

        if rows_in % 1000 == 0 || last_prog.elapsed().as_millis() >= 500 {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
            last_prog = Instant::now();
        }
    }

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected: 0,
        elapsed_ms: start.elapsed().as_millis() as u64, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

// ─── L'esplosione ──────────────────────────────────────────────────

/// Un valore collettivo diventa N righe.
///
///   array          → una riga per elemento. Se l'elemento è un oggetto,
///                    i suoi campi; se primitivo, `{value: x}`.
///   object_values  → una riga per valore dell'oggetto
///   object_entries → una riga `{key, value}` per coppia
fn explode_value(v: &Value, structure: &str, on_primitive: &str) -> Result<Vec<Row>, String> {
    // Una stringa che contiene JSON viene parsata: un CSV letto come testo
    // può avere un campo `["a","b"]`.
    let json = match v {
        Value::Object(j) => j.clone(),
        Value::String(s) => match serde_json::from_str::<serde_json::Value>(s) {
            Ok(j) => j,
            Err(_) => return primitive(v, on_primitive),
        },
        other => return primitive(other, on_primitive),
    };

    match structure {
        "array" => match json.as_array() {
            Some(items) => Ok(items.iter().map(json_to_row).collect()),
            None => primitive(v, on_primitive),
        },

        "object_values" => match json.as_object() {
            Some(map) => Ok(map.values().map(json_to_row).collect()),
            None => primitive(v, on_primitive),
        },

        "object_entries" => match json.as_object() {
            Some(map) => Ok(map.iter().map(|(k, val)| {
                let mut r = Row::new();
                r.set("key".to_string(),   Value::String(k.clone()));
                r.set("value".to_string(), Value::from_json(val.clone()));
                r
            }).collect()),
            None => primitive(v, on_primitive),
        },

        other => Err(format!("explode: tipo di struttura sconosciuto '{}'", other)),
    }
}

/// Un elemento di array/oggetto: se è a sua volta un oggetto, i suoi campi
/// diventano la riga; altrimenti finisce in un campo `value`.
fn json_to_row(v: &serde_json::Value) -> Row {
    match v.as_object() {
        Some(map) => {
            let mut r = Row::new();
            for (k, val) in map { r.set(k.clone(), Value::from_json(val.clone())) }
            r
        }
        None => {
            let mut r = Row::new();
            r.set("value".to_string(), Value::from_json(v.clone()));
            r
        }
    }
}

/// Il campo non è una collezione.
fn primitive(v: &Value, mode: &str) -> Result<Vec<Row>, String> {
    match mode {
        "error" => Err(format!("explode: il campo non è una collezione (valore: {})",
                               v.as_str_repr())),
        "skip"  => Ok(Vec::new()),
        _ => {   // wrap: una riga sola, col valore
            let mut r = Row::new();
            r.set("value".to_string(), v.clone());
            Ok(vec![r])
        }
    }
}
