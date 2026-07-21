// ─── src-tauri/src/engine/nodes/error_handler.rs ───────────────────
//
// Error handler — PASSO 1 del modello a canale (P42).
//
// L'EH è un NODO NORMALE: entra nel piano, viene spawato in parallelo
// come tutti gli altri. Questo file è la versione minima che serve al
// passo 1 — dimostrare che l'impianto regge: l'EH è tra gli spawn, il
// suo edge error_out esiste nel wiring, la sotto-pipeline a valle
// riceve un canale vero (e la sua fine), niente deadlock.
//
// Cosa NON fa ancora (passo 2): il COLLETTORE. Lì l'EH riceverà il
// receiver di un canale mpsc il cui sender sta nel ctx di ogni nodo
// (esclusi l'EH stesso e la sua sotto-pipeline — criticità A, deadlock
// circolare); i nodi in errore gli manderanno la riga `_error_*` in
// streaming, lui la elaborerà e la emetterà su error_out. Il canale si
// chiude quando l'ultimo nodo droppa il suo sender → l'EH conclude
// naturale.
//
// Al passo 1, senza collettore, il comportamento onesto è: dichiararsi
// vivo, chiudere error_out subito (drop dei sender → fine-stream a
// valle) e completare con 0 righe. Gli errori dei nodi intanto restano
// visibili nel pannello via la rete di sicurezza a fine lane
// (executor.rs, drain di LaneErrors), che il passo 2 smonterà.

use std::collections::HashMap;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};

pub async fn run(
    ctx:     NodeContext,
    inputs:  HashMap<String, RowReceiver>,
    outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {
    let start = Instant::now();

    // La porta `catch` è LOGICA (connectable:false, R9): nessun edge la
    // raggiunge, quindi la mappa è normalmente vuota. La si droppa comunque
    // subito: se un piano malformato le desse un receiver, il canale si
    // chiuderebbe e il mittente vedrebbe l'errore invece di bloccarsi.
    drop(inputs);

    ctx.emit_log(
        &ctx.label,
        "info",
        0,
        "Error handler attivo (nodo nel piano) — collettore errori non ancora cablato: arriva al passo 2".to_string(),
        "panel",
    );

    // Drop dei sender = chiusura di error_out: la sotto-pipeline vede la
    // fine dello stream e conclude con 0 righe. È il contrario esatto del
    // vecchio modello a fine lane, dove error_out restava aperto fino
    // all'iniezione e obbligava ad attese separate.
    drop(outputs);

    let stats = NodeStats {
        rows_in:       0,
        rows_out:      0,
        rows_rejected: 0,
        elapsed_ms:    start.elapsed().as_millis() as u64,
        error:         None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}
