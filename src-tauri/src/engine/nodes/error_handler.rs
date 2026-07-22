// ─── src-tauri/src/engine/nodes/error_handler.rs ───────────────────
//
// Error handler — PASSO 2 del modello a canale (P43): il COLLETTORE.
//
// L'EH è un nodo NORMALE, spawato in parallelo agli altri. Non attende
// la fine della lane: si mette in ascolto sul canale collettore (un mpsc
// per lane creato dall'executor) e lavora in STREAMING — ogni nodo che
// fallisce in modalità handler gli manda la sua riga `_error_*` appena
// l'errore capita, l'EH la registra nel pannello e la rilancia su
// `error_out`, dove la sotto-pipeline grafica dell'utente la consuma
// mentre il resto della lane sta ancora girando.
//
// Terminazione, senza trattamenti speciali: il canale si chiude quando
// l'ultimo produttore droppa il suo sender (i task dei nodi al termine,
// più la copia dell'executor droppata subito dopo lo spawn). A quel
// punto `recv()` restituisce None, l'EH esce dal loop, droppa il suo
// error_out e la sotto-pipeline vede il fine-stream e conclude.
//
// Niente deadlock circolare (criticità A): l'EH e i nodi della sua
// sotto-pipeline NON ricevono il sender del collettore — l'esclusione la
// fa l'executor con una BFS a valle dell'EH. Conseguenza accettata
// (criticità B): un fallimento DENTRO la sotto-pipeline dell'EH non può
// tornare all'EH; resta fatale per la lane e visibile su NodeFailed.
//
// Cosa NON fa ancora: le REGOLE (il pannello mostra "0 regole"). Qui
// ogni errore raccolto viene registrato ed emesso tale e quale; filtri,
// `_error_code`/`_error_row` e `critical` sono la fetta successiva.

use std::collections::HashMap;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::errors::field_str;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx:         NodeContext,
    mut inputs:  HashMap<String, RowReceiver>,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {
    let start = Instant::now();

    // Il receiver del collettore arriva sotto l'handle `catch`: la porta
    // d'ingresso LOGICA dell'EH (connectable:false, R9), che nessun edge
    // del canvas può occupare. Se manca (piano senza collettore), l'EH
    // conclude subito a 0 righe invece di restare appeso.
    let collector = inputs.remove("catch");
    drop(inputs);

    // Si tiene SOLO error_out: le altre porte vanno chiuse subito, o un
    // eventuale ramo collegato resterebbe in attesa a vuoto.
    let error_out = outputs.remove("error_out");
    drop(outputs);

    let mut rows_in:  u64 = 0;
    let mut rows_out: u64 = 0;

    if let Some(mut rx) = collector {
        // Streaming: si sblocca a ogni errore, non a fine lane.
        while let Some(row) = rx.recv().await {
            rows_in += 1;

            let node = field_str(&row, "_error_node_id");
            let msg  = field_str(&row, "_error_message");
            ctx.emit_log(
                &ctx.label,
                "error",
                rows_in,
                format!("{}: {}", node, msg),
                "panel",
            );

            if let Some(tx) = &error_out {
                // Errore di send = sotto-pipeline già conclusa: non c'è
                // più nessuno a valle, inutile continuare a spingere.
                // L'errore resta comunque nel pannello (sopra) e su
                // NodeFailed.
                if tx.send(row).await.is_err() {
                    ctx.emit_log(
                        &ctx.label,
                        "warn",
                        rows_in,
                        "Pipeline a valle di error_out chiusa: righe successive solo nel pannello".to_string(),
                        "panel",
                    );
                    break;
                }
                rows_out += 1;
            }
        }
    }

    // Chiusura di error_out → la sotto-pipeline vede il fine-stream.
    drop(error_out);

    let stats = NodeStats {
        rows_in,
        rows_out,
        rows_rejected: 0,
        elapsed_ms:    start.elapsed().as_millis() as u64,
        error:         None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
