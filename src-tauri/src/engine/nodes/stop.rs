// ─── src-tauri/src/engine/nodes/stop.rs ────────────────────────────
//
// Nodo di CONTROLLO DI FLUSSO (sezione palette "Flusso", con
// l'error_handler): ferma DELIBERATAMENTE la lane dal disegno del
// flusso. Disegno chiuso in `src-tauri/docs/design-service-mode.md` §2.
//
// UN'AZIONE SOLA: ferma-lane = `LaneAbort::fire` (v. engine/abort.rs),
// lo stesso mattone dell'abort critico dell'error handler. `fire`
// aborta i task ancora vivi; a fine lane `finalize_with_outcome` fa il
// rollback delle transazioni attive (l'esito non è Ok) e `close_all`
// chiude le connessioni. Non c'è niente di nuovo da inventare nel
// motore — cambia solo il MOTIVO: qui è "stop deliberato", non "errore
// critico", così i nodi interrotti compaiono nel Monitor come
// *interrotti* (NodeInterrupted, warning) e non come falliti.
//
// DUE MODALITÀ D'INNESCO (spec.props["trigger"]):
//   - immediate   : scatta alla PRIMA riga ricevuta.
//   - after_input : drena l'ingresso fino a EOF (lasciando il monte
//                   processare/loggare tutte le righe del ramo), poi
//                   ferma. In entrambe serve ≥1 riga: un ramo a 0 righe
//                   NON innesca (coerente con "scatta quando gli arriva
//                   una riga").
//
// CANCELLABILE (vincolo utente): parte in parallelo come ogni nodo,
// quindi NON deve scattare all'avvio. Attende in `select!` fra la riga
// d'innesco e `ctx.cancel` (il token del run, service mode, P93): se il
// ramo non arriva o se un altro cancel scatta prima, esce PULITO senza
// fermare niente.
//
// ⚠️ Il nodo stop è registrato come interrompibile (ha il sender del
// collettore ⇒ è nel registro AbortHandle): il suo stesso `fire` può
// abortirlo. È benigno perché `fire` è l'ULTIMA azione, senza `.await`
// dopo — il task conclude prima che la cancellazione di sé prenda
// effetto (Tokio verifica l'abort solo a un punto di await).
//
// FETTA 2a: qui c'è il path BASE / FALLBACK (ferma-lane, cancellabile,
// due modalità). L'AMPLIFICATORE via error_handler — la riga di
// "chiusura deliberata" al collettore, i cui effetti (log/mail/http/
// sink_db) girano nella sotto-pipeline error_out — è la fetta 2b.

use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowReceiver, NodeContext};
use crate::engine::spec::Spec;

pub async fn run(
    ctx: NodeContext,
    rx:  Option<RowReceiver>,
) -> Result<NodeStats, String> {
    let start = Instant::now();

    // Modalità e messaggio arrivano da spec.props verbatim (buildRustPlan
    // mette tutte le props nella busta spec; nessun `case 'stop'` serve).
    let (trigger, message) = match Spec::from_ctx(&ctx.spec) {
        Ok(sp) => (sp.str_or("trigger", "immediate"), sp.str_or("message", "")),
        Err(_) => ("immediate".to_string(), String::new()),
    };

    let mut rows_in: u64 = 0;

    // `armed` = il ramo è stato raggiunto (≥1 riga) e va fermata la lane.
    let armed: bool = match rx {
        // Nessun ingresso: il nodo non ha su cosa innescarsi. Attende solo
        // il cancel (per non appendere il run se piazzato senza monte) ed
        // esce pulito — non ferma niente.
        None => {
            ctx.cancel.cancelled().await;
            false
        }

        Some(mut rx) => match trigger.as_str() {
            // ── after_input: drena TUTTO, poi ferma ────────────────────
            "after_input" => {
                let mut visto = false;
                loop {
                    tokio::select! {
                        maybe = rx.recv() => match maybe {
                            Some(_) => { rows_in += 1; visto = true; }
                            None    => break,   // EOF: monte esaurito
                        },
                        _ = ctx.cancel.cancelled() => {
                            // Cancellato dall'esterno mentre drenava: esci
                            // pulito, non innescare.
                            return Ok(done(&ctx, rows_in, start));
                        }
                    }
                }
                visto
            }

            // ── immediate (default): alla PRIMA riga ───────────────────
            _ => {
                tokio::select! {
                    maybe = rx.recv() => match maybe {
                        Some(_) => { rows_in += 1; true }
                        None    => false,   // ingresso chiuso a 0 righe: non innesca
                    },
                    _ = ctx.cancel.cancelled() => {
                        return Ok(done(&ctx, rows_in, start));
                    }
                }
            }
        },
    };

    if !armed {
        // Ramo non raggiunto o cancellato: uscita pulita, la lane prosegue.
        return Ok(done(&ctx, rows_in, start));
    }

    // ── INNESCO: ferma la lane ─────────────────────────────────────────
    let motivo = if message.trim().is_empty() {
        "stop deliberato".to_string()
    } else {
        format!("stop deliberato: {}", message.trim())
    };

    ctx.emit_log(
        &ctx.label, "warn", rows_in,
        format!(
            "Chiusura deliberata della lane ({} — {} righe ricevute).",
            if trigger == "after_input" { "dopo l'esaurimento dell'input" } else { "innesco immediato" },
            rows_in,
        ),
        "panel",
    );

    // `fire` è idempotente e conserva il MOTIVO: i nodi ancora vivi
    // vengono abortiti, e a fine lane il rollback + close_all seguono
    // dall'esito non-Ok. Il motivo "stop deliberato" distingue questa
    // interruzione da un errore critico (Monitor: NodeInterrupted, non
    // NodeFailed).
    let stopped = ctx.lane_abort.fire(&motivo).await;
    if !stopped.is_empty() {
        ctx.emit_log(
            &ctx.label, "warn", rows_in,
            format!("Stop deliberato: interrotti {} nodi ancora in esecuzione", stopped.len()),
            "panel",
        );
    }

    // NB nessun `.await` dopo il `fire`: se il fire ha abortito anche
    // questo task, la cancellazione non fa in tempo a scattare e il nodo
    // conclude pulito (v. nota in testa).
    Ok(done(&ctx, rows_in, start))
}

/// Esito del nodo stop. `error: None` SEMPRE: lo stop non fallisce —
/// FERMA. Che la lane non abbia committato è un fatto della lane
/// (rollback dall'esito non-Ok), non un errore di questo nodo.
fn done(ctx: &NodeContext, rows_in: u64, start: Instant) -> NodeStats {
    let stats = NodeStats {
        rows_in,
        rows_out:      0,
        rows_rejected: 0,
        elapsed_ms:    start.elapsed().as_millis() as u64,
        error:         None,
    };
    ctx.emit_completed(stats.clone());
    stats
}
