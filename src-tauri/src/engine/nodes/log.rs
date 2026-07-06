// ─── src-tauri/src/engine/nodes/log.rs ─────────────────────────────
//
// Nodo Log: stampa righe verso il LogPanel in-app e/o la finestra
// viewer, poi passa la riga invariata al nodo successivo.
//
// MIGRATO ALLA SPEC (contratto docs/node-spec.md §log). Replica 1:1
// la semantica del runner JS legacy (executors.ts → logExecutor):
//   - template "{campo}" risolto coi valori di riga (o JSON riga se
//     nessun template);
//   - prefix; troncamento a maxChars; numero riga opzionale;
//   - sampling: all | first_n | every_n | random;
//   - routing UI via logTarget: panel | window | both_window.
//
// DIFFERENZE ARCHITETTURALI rispetto al legacy:
//   - il contatore righe NON è una Map globale per node.id (stato
//     condiviso cross-lane, da evitare nel modello a lane sandbox):
//     qui è una variabile locale al task del nodo → per-lane per
//     costruzione;
//   - l'output va nel bus eventi (EngineEvent::NodeLog) con lane_id,
//     non in eprintln!: così raggiunge la UI ed entra anche nel
//     reporter NDJSON del run (log persistito per artifact headless).
//
// CONCETTI RUST:
//   - `regex::Regex` (già in Cargo.toml) per la sostituzione del
//     template; compilata una volta fuori dal loop.
//   - LCG inline per il sampling random: evita la dipendenza `rand`
//     per un uso non crittografico.

use std::time::Instant;
use regex::Regex;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::spec::Spec;

struct LogConfig {
    enabled:      bool,
    level:        String,
    template:     String,
    prefix:       String,
    sample_mode:  String,   // "all" | "first_n" | "every_n" | "random"
    sample_n:     u64,
    sample_pct:   u64,
    show_row_num: bool,
    max_chars:    usize,
    target:       String,   // "panel" | "window" | "both_window"
    node_label:   String,
}

fn config_from_spec(spec: &Spec, ctx: &NodeContext) -> LogConfig {
    // Il label di default replica il legacy: displayName del nodo,
    // altrimenti il label statico, altrimenti "Log".
    let cfg_name = spec.config().get("displayName")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let node_label = cfg_name.clone()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| {
            if ctx.label.is_empty() { "Log".to_string() } else { ctx.label.clone() }
        });
    let prefix = spec.str_or("logPrefix", &format!("[{}]", node_label));

    LogConfig {
        enabled:      spec.bool_or("logEnabled", true),
        level:        spec.str_or("logLevel", "info"),
        template:     spec.str_or("logTemplate", ""),
        sample_mode:  spec.str_or("sampleMode", "all"),
        sample_n:     spec.u64_or("sampleN", 10).max(1),
        sample_pct:   spec.u64_or("samplePct", 10),
        show_row_num: spec.bool_or("showRowNum", true),
        max_chars:    spec.usize_or("maxChars", 200),
        target:       spec.str_or("logTarget", "panel"),
        prefix,
        node_label,
    }
}

const PROGRESS_EVERY_ROWS: u64 = 1000;
const PROGRESS_EVERY_MS:   u64 = 500;

pub async fn run(
    ctx: NodeContext,
    mut rx: RowReceiver,
    tx: Option<RowSender>,
) -> Result<NodeStats, String> {

    let spec = Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("log {}: {}", ctx.node_id.0, e))?;
    let cfg = config_from_spec(&spec, &ctx);
    spec.log_unconsumed("log", &ctx.node_id.0);

    // {campo} → valore. Compilata una volta sola.
    let tpl_re = Regex::new(r"\{(\w+)\}").unwrap();

    let start        = Instant::now();
    let mut rows_in  = 0u64;   // conteggio locale al task = per-lane
    let mut rows_out = 0u64;
    let mut last_prog = Instant::now();
    let mut rng: u64 = 0x9E3779B97F4A7C15 ^ (start.elapsed().as_nanos() as u64);

    while let Some(row) = rx.recv().await {
        let idx = rows_in;   // indice 0-based della riga corrente
        rows_in += 1;

        if cfg.enabled {
            let should_log = match cfg.sample_mode.as_str() {
                "first_n" => idx < cfg.sample_n,
                "every_n" => idx % cfg.sample_n == 0,
                "random"  => {
                    // LCG (Numerical Recipes) → [0,100)
                    rng = rng.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                    let r = (rng >> 33) % 100;
                    r < cfg.sample_pct
                }
                _ => true,   // "all"
            };

            if should_log {
                let mut msg = if cfg.template.is_empty() {
                    row.to_json_object_sorted().to_string()
                } else {
                    tpl_re.replace_all(&cfg.template, |caps: &regex::Captures| {
                        let key = &caps[1];
                        row.get(key).map(|v| v.as_str_repr()).unwrap_or_default()
                    }).into_owned()
                };
                if cfg.max_chars > 0 && msg.chars().count() > cfg.max_chars {
                    msg = msg.chars().take(cfg.max_chars).collect::<String>() + "…";
                }
                let row_num = if cfg.show_row_num { idx + 1 } else { 0 };
                let full = format!("{} {}", cfg.prefix, msg);
                ctx.emit_log(&cfg.node_label, &cfg.level, row_num, full, &cfg.target);
            }
        }

        // Passthrough invariato
        if let Some(ref tx) = tx {
            if tx.send(row).await.is_err() { break; }
            rows_out += 1;
        }

        let should_prog = rows_in % PROGRESS_EVERY_ROWS == 0
            || last_prog.elapsed().as_millis() as u64 >= PROGRESS_EVERY_MS;
        if should_prog {
            let rps = rows_in as f64 / start.elapsed().as_secs_f64().max(0.001);
            ctx.emit_progress(rows_in, rows_out, 0, rps);
            last_prog = Instant::now();
        }
    }

    let elapsed_ms = start.elapsed().as_millis() as u64;
    let stats = NodeStats {
        rows_in, rows_out,
        rows_rejected: 0, elapsed_ms, error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}