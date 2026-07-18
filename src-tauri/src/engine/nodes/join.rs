// ─── src-tauri/src/engine/nodes/join.rs ────────────────────────────
//
// Join di due flussi su chiave (hash join). Primo nodo BLOCCANTE del
// motore: per sapere se una riga sinistra ha match deve aver già visto
// tutte le righe destre. Strategia:
//   1. drena INTERAMENTE input_right in un Vec (materializza il lato dx);
//   2. costruisce la hashtable  chiave → Vec<Row>  sul lato destro;
//   3. itera input_left in streaming, emettendo i match;
//   4. per right/full, a fine sinistro emette le righe destre rimaste
//      senza corrispondenza.
// I due lati arrivano su CANALI SEPARATI (input_left / input_right):
// niente ricostruzione della provenienza (il vecchio runner JS univa
// tutto in un array e indovinava con __sourceHandle — qui non serve).
//
// Semantica replicata da src/runner/joinExecutor.ts (legacy):
//   tipi: inner | left | right | full | cross | anti | semi
//   + chiavi composite, caseSensitive, rightPrefix anti-collisione,
//     duplicates (all|first|last|error), nullKeys (exclude|error).
//
// NON ANCORA SUPPORTATO (v. docs/node-spec.md §join, docs/TODO.md):
//   - customCondition: il legacy eseguiva JS arbitrario (new Function);
//     in Rust serve un interprete → rimandata. Se valorizzata, il nodo
//     EMETTE UN WARNING e la ignora (niente drop muto).
//   - rightSource=materialize: dipende dal nodo materialize non ancora
//     migrato → per ora il lato destro è sempre lo stream input_right.
//
// MEMORIA (modello a lane): il buffer del lato destro (ed eventualmente
// del sinistro per right/full) è un picco di RAM DELLA LANE che contiene
// il join. Sarà il primo cliente del monitor memoria per-lane.

use std::collections::HashMap;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext, make_drain, take_primary_output};
use crate::engine::spec::Spec;

struct CompositeKey {
    left:  String,
    right: String,
}

struct JoinConfig {
    join_type:      String,
    left_key:       String,
    right_key:      String,
    composite_keys: Vec<CompositeKey>,
    case_sensitive: bool,
    right_prefix:   String,
    duplicates:     String,   // all | first | last | error
    null_keys:      String,   // exclude | error
    right_source:   String,   // stream | materialize (🕐)
    custom_cond:    String,   // 🕐 ignorata con warning
}

#[derive(serde::Deserialize)]
struct CompositeKeyRaw {
    #[serde(default)]
    left:  String,
    #[serde(default)]
    right: String,
}

fn config_from_spec(spec: &Spec) -> JoinConfig {
    let raw: Vec<CompositeKeyRaw> = spec.json_or("compositeKeys", Vec::new());
    let composite_keys = raw.into_iter()
        .filter(|c| !c.left.is_empty() || !c.right.is_empty())
        .map(|c| CompositeKey { left: c.left, right: c.right })
        .collect();

    JoinConfig {
        join_type:      spec.str_or("join_type", "inner"),
        left_key:       spec.str_or("leftKey", ""),
        right_key:      spec.str_or("rightKey", ""),
        case_sensitive: spec.bool_or("caseSensitive", true),
        right_prefix:   spec.str_or("rightPrefix", "r_"),
        duplicates:     spec.str_or("duplicates", "all"),
        null_keys:      spec.str_or("nullKeys", "exclude"),
        right_source:   spec.str_or("rightSource", "stream"),
        custom_cond:    spec.str_or("customCondition", ""),
        composite_keys,
    }
}

const NULL_KEY: &str = "\u{0}__null__";

// ─── Costruzione chiave (primaria + composite) ────────────────────

fn normalize(v: Option<&Value>, case_sensitive: bool) -> String {
    match v {
        None => NULL_KEY.to_string(),
        Some(Value::Null) => NULL_KEY.to_string(),
        Some(val) => {
            let s = val.as_str_repr();
            if case_sensitive { s } else { s.to_lowercase() }
        }
    }
}

fn build_key(row: &Row, primary: &str, comps: &[CompositeKey], side_left: bool, cs: bool) -> String {
    let mut parts: Vec<String> = Vec::with_capacity(1 + comps.len());
    if !primary.is_empty() {
        parts.push(normalize(row.get(primary), cs));
    }
    for ck in comps {
        let field = if side_left { &ck.left } else { &ck.right };
        if !field.is_empty() {
            parts.push(normalize(row.get(field), cs));
        }
    }
    parts.join("\u{0}")
}

fn is_null_key(key: &str) -> bool {
    // La chiave è "null" se ogni sua componente è la sentinella.
    !key.is_empty() && key.split('\u{0}').all(|p| p == "__null__" || p.is_empty())
        || key == NULL_KEY
}

// ─── Merge di due righe con prefisso anti-collisione ──────────────
// Il prefisso è deciso a livello di SCHEMA, non di singola riga:
// un campo destra riceve `prefix` se il suo nome esiste tra i nomi
// del lato sinistro (left_names), a prescindere dalla riga corrente.
// Così le righe fuse e le righe right-only hanno lo stesso schema.

fn apply_right_prefix(right: &Row, left_names: &std::collections::HashSet<String>, prefix: &str) -> Vec<(String, Value)> {
    right.fields().map(|(k, v)| {
        let key = if left_names.contains(k) { format!("{}{}", prefix, k) } else { k.clone() };
        (key, v.clone())
    }).collect()
}

fn merge(left: &Row, right: &Row, left_names: &std::collections::HashSet<String>, prefix: &str) -> Row {
    let mut out = left.clone();
    for (k, v) in apply_right_prefix(right, left_names, prefix) {
        out.set(k, v);
    }
    out
}

/// Riga destra senza corrispondenza (right/full): stesso schema delle
/// righe fuse — i campi destra collidenti con lo schema sinistro sono
/// prefissati, gli altri restano col nome nudo. I campi sinistri sono
/// assenti (nessuna riga sinistra da affiancare).
fn right_only(right: &Row, left_names: &std::collections::HashSet<String>, prefix: &str) -> Row {
    let mut out = Row::new();
    for (k, v) in apply_right_prefix(right, left_names, prefix) {
        out.set(k, v);
    }
    out
}

pub async fn run(
    ctx:        NodeContext,
    mut inputs: HashMap<String, RowReceiver>,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("join {}: {}", ctx.node_id.0, e))?;
    let cfg = config_from_spec(&spec);
    spec.log_unconsumed("join", &ctx.node_id.0);

    // Feature rimandate: avvisa invece di fallire in silenzio.
    if !cfg.custom_cond.trim().is_empty() {
        ctx.emit_log(&ctx.label, "warn", 0,
            "[join] condizione custom ignorata: non ancora supportata dal motore \
             (v. docs/TODO.md)".to_string(), "panel");
    }
    if cfg.right_source == "materialize" {
        ctx.emit_log(&ctx.label, "warn", 0,
            "[join] rightSource=materialize non ancora supportato: uso lo stream \
             input_right".to_string(), "panel");
    }

    // Uscite: 'output' primaria (fallback drain, il join non deve bloccarsi) e
    // 'reject' opzionale — le righe SINISTRE senza corrispondenza per inner/semi,
    // che altrimenti verrebbero scartate. Toglilo prima del primario. Modello P31.
    let reject_tx = outputs.remove("reject");
    let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);

    let mut left_rx  = inputs.remove("input_left");
    let mut right_rx = inputs.remove("input_right");

    // Fallback difensivo: se gli handle non hanno i nomi canonici
    // (es. un solo input collegato), assegna per ordine.
    if left_rx.is_none() || right_rx.is_none() {
        let mut keys: Vec<String> = inputs.keys().cloned().collect();
        keys.sort();
        for k in keys {
            if let Some(rx) = inputs.remove(&k) {
                if left_rx.is_none() { left_rx = Some(rx); }
                else if right_rx.is_none() { right_rx = Some(rx); }
            }
        }
    }

    let start = Instant::now();
    let mut rows_in  = 0u64;
    let mut rows_out = 0u64;
    let mut rows_rejected = 0u64;
    let cross = cfg.join_type == "cross";

    // ── 1. Materializza il lato destro (drain completo) ───────────
    let mut right_rows: Vec<Row> = Vec::new();
    if let Some(mut rx) = right_rx {
        while let Some(r) = rx.recv().await {
            rows_in += 1;
            right_rows.push(r);
        }
    }

    // ── 2. Hashtable  chiave → indici in right_rows  ──────────────
    // (indici, non cloni: right_rows è la sola copia del lato destro)
    let mut table: HashMap<String, Vec<usize>> = HashMap::new();
    if !cross {
        for (i, rr) in right_rows.iter().enumerate() {
            let k = build_key(rr, &cfg.right_key, &cfg.composite_keys, false, cfg.case_sensitive);
            if is_null_key(&k) && cfg.null_keys == "exclude" { continue; }
            table.entry(k).or_default().push(i);
        }
    }
    let mut matched_right: Vec<bool> = vec![false; right_rows.len()];

    // ── 3. Streaming del lato sinistro ────────────────────────────
    let jt = cfg.join_type.as_str();
    let mut left_names: std::collections::HashSet<String> = std::collections::HashSet::new();
    if let Some(mut rx) = left_rx {
        while let Some(lr) = rx.recv().await {
            rows_in += 1;
            for (k, _) in lr.fields() { left_names.insert(k.clone()); }

            if cross {
                for rr in &right_rows {
                    if tx.send(merge(&lr, rr, &left_names, &cfg.right_prefix)).await.is_err() { break; }
                    rows_out += 1;
                }
                continue;
            }

            let lk = build_key(&lr, &cfg.left_key, &cfg.composite_keys, true, cfg.case_sensitive);

            if is_null_key(&lk) {
                if cfg.null_keys == "error" {
                    return Err(format!("join {}: chiave null nel flusso sinistro (campo '{}')",
                        ctx.node_id.0, cfg.left_key));
                }
                // exclude: nessun match possibile
                if jt == "left" || jt == "full" {
                    if tx.send(lr.clone()).await.is_err() { break; }
                    rows_out += 1;
                } else if jt == "inner" || jt == "semi" {
                    // non-matched: la riga sinistra non produce output → reject
                    if let Some(rej) = &reject_tx { let _ = rej.send(lr.clone()).await; }
                    rows_rejected += 1;
                }
                continue;
            }

            let match_idx: Vec<usize> = table.get(&lk).cloned().unwrap_or_default();

            if match_idx.is_empty() {
                match jt {
                    "inner" | "semi" => {
                        // non-matched: la riga sinistra non produce output → reject
                        if let Some(rej) = &reject_tx { let _ = rej.send(lr.clone()).await; }
                        rows_rejected += 1;
                    }
                    "anti" => { if tx.send(lr.clone()).await.is_err() { break; } rows_out += 1; }
                    "left" | "full" => { if tx.send(lr.clone()).await.is_err() { break; } rows_out += 1; }
                    _ => {}
                }
                continue;
            }

            // Ha match
            match jt {
                "anti" => continue,                       // escludi righe con match
                "semi" => {                               // solo campi sinistri, una volta
                    if tx.send(lr.clone()).await.is_err() { break; }
                    rows_out += 1;
                    for &i in &match_idx { matched_right[i] = true; }
                    continue;
                }
                _ => {}
            }

            // Selezione duplicati
            let selected: Vec<usize> = match cfg.duplicates.as_str() {
                "first" => vec![match_idx[0]],
                "last"  => vec![*match_idx.last().unwrap()],
                "error" if match_idx.len() > 1 => {
                    return Err(format!("join {}: corrispondenze multiple per chiave '{}' (duplicates=error)",
                        ctx.node_id.0, lk));
                }
                _ => match_idx,
            };

            for i in selected {
                if tx.send(merge(&lr, &right_rows[i], &left_names, &cfg.right_prefix)).await.is_err() { break; }
                rows_out += 1;
                matched_right[i] = true;
            }
        }
    }

    // ── 4. right / full: righe destre senza corrispondenza ────────
    if jt == "right" || jt == "full" {
        for (i, rr) in right_rows.iter().enumerate() {
            if !matched_right[i] {
                if tx.send(right_only(rr, &left_names, &cfg.right_prefix)).await.is_err() { break; }
                rows_out += 1;
            }
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    ctx.emit_log(&ctx.label, "info", 0,
        format!("[join] {}: {} righe in ingresso, {} in uscita, {} scartate",
            jt.to_uppercase(), rows_in, rows_out, rows_rejected), "panel");

    // Conteggi per handle di uscita → badge sul canvas (come filter).
    let mut per_out: HashMap<String, u64> = HashMap::new();
    per_out.insert("output".to_string(), rows_out);
    per_out.insert("reject".to_string(), rows_rejected);
    ctx.emit_output_stats(per_out);

    let stats = NodeStats {
        rows_in, rows_out, rows_rejected, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}