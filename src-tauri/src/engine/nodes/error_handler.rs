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
// `critical` (P44): se la riga porta `_error_critical: 'true'`, l'EH —
// dopo aver registrato ed emesso — interrompe i nodi della lane ancora
// vivi tramite il registro degli AbortHandle (v. abort.rs). È il senso
// di "solo l'EH interrompe": i nodi segnalano, la decisione è una sola
// e sta qui.
//
// Cosa NON fa ancora: le REGOLE (il pannello mostra "0 regole"). Qui
// ogni errore raccolto viene registrato ed emesso tale e quale; filtri,
// `_error_code`/`_error_row` ed excludeFromErrorLog sono la fetta
// successiva.

use std::collections::HashMap;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::errors::field_str;
use crate::engine::executor::{RowSender, RowReceiver, NodeContext};
use crate::engine::spec::Spec;

// ─── Regole automatiche ────────────────────────────────────────────
// Lo studio le salva come JSON in `props.rules` (v. ErrorRule in
// src/types/index.ts) e la busta spec porta TUTTE le props, quindi
// arrivano qui senza bisogno di toccare buildRustPlan.
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ErrorRule {
    #[serde(default)] match_type:  String,
    #[serde(default)] match_value: String,
    #[serde(default)] action:      String,
}

/// Stesso vocabolario di `normalizeErrorRuleAction` (TS): le azioni del
/// modello vecchio non sono eseguibili dall'handler e valgono `emit`.
/// La traduzione va rifatta QUI perché un progetto salvato prima di P50
/// contiene ancora `skip`/`retry` sul disco: lo studio le mostra già
/// tradotte, il motore deve comportarsi allo stesso modo.
fn normalizza(azione: &str) -> &'static str {
    match azione.trim() {
        "log_only" => "log_only",
        "ignore"   => "ignore",
        "stop"     => "stop",
        _          => "emit",   // emit, skip, retry, vuoto, sconosciuto
    }
}

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

    // Le regole si leggono UNA VOLTA, non a ogni riga. JSON malformato o
    // assente = nessuna regola, che è anche il comportamento predefinito:
    // tutto verso error_out.
    let regole: Vec<ErrorRule> = Spec::from_ctx(&ctx.spec)
        .ok()
        .map(|sp| sp.str_or("rules", "[]"))
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default();
    if !regole.is_empty() {
        ctx.emit_log(
            &ctx.label, "info", 0,
            format!("{} regole attive", regole.len()),
            "panel",
        );
    }

    let mut rows_in:  u64 = 0;
    let mut rows_out: u64 = 0;
    // Diventa false se la sotto-pipeline a valle si chiude prima di noi.
    let mut valle_aperta = true;

    if let Some(mut rx) = collector {
        // Streaming: si sblocca a ogni errore, non a fine lane.
        while let Some(row) = rx.recv().await {
            rows_in += 1;

            let node      = field_str(&row, "_error_node_id");
            let node_type = field_str(&row, "_error_node_type");
            let msg       = field_str(&row, "_error_message");

            // I flag viaggiano sulla riga (v. errors::build_error_row):
            // l'EH non vede il piano, vede solo ciò che gli arriva.
            let critical = field_str(&row, "_error_critical") == "true";
            let excluded = field_str(&row, "_error_excluded") == "true";

            // ── REGOLE ────────────────────────────────────────────
            // In ordine, la PRIMA che corrisponde decide (come dichiara
            // il pannello). `error_code` non corrisponde mai: il motore
            // non popola `_error_code` — lo studio lo dichiara
            // indisponibile, qui semplicemente non matcha.
            let regola = regole.iter().position(|r| match r.match_type.trim() {
                "always"    => true,
                "node_type" => !r.match_value.trim().is_empty()
                               && r.match_value.trim() == node_type,
                _           => false,
            });
            let mut azione = regola
                .map(|i| normalizza(&regole[i].action))
                .unwrap_or("emit");

            // ── «Escludi dal log» (flag del NODO) ─────────────────
            // Vale come un `ignore` mirato: gli errori di quel nodo non
            // intasano l'audit trail (il caso d'uso è un nodo di puro
            // logging il cui fallimento è rumore). È una soppressione di
            // RUMORE, non di sicurezza — per questo NON batte una regola
            // «interrompi»: l'escalation è una decisione deliberata, il
            // silenziamento no. E per questo l'errore è stato comunque
            // spedito sul canale di controllo invece di essere filtrato
            // alla fonte: se lo avesse trattenuto il nodo, una spunta
            // cosmetica avrebbe potuto disattivare `critical` in silenzio.
            if excluded && azione != "stop" {
                azione = "ignore";
            }

            // ⚖️ `critical` È UN PAVIMENTO, non un'opinione: una regola
            // può alzare la gravità, mai abbassarla. Se il nodo è critico
            // la lane si ferma comunque (sotto) — e allora la riga va
            // almeno REGISTRATA: fermare una lane in silenzio sarebbe il
            // peggiore dei mondi.
            if critical && azione == "ignore" {
                azione = "log_only";
            }

            if azione != "ignore" {
                ctx.emit_log(
                    &ctx.label,
                    "error",
                    rows_in,
                    match regola {
                        Some(i) => format!("{}: {} [regola #{} → {}]", node, msg, i + 1, azione),
                        None    => format!("{}: {}", node, msg),
                    },
                    "panel",
                );
            }

            if valle_aperta && (azione == "emit" || azione == "stop") {
                if let Some(tx) = &error_out {
                    // Errore di send = sotto-pipeline già conclusa: non
                    // c'è più nessuno a valle. NON si esce dal loop —
                    // l'EH deve continuare a ricevere, sia per registrare
                    // gli errori successivi nel pannello sia per poter
                    // ancora INTERROMPERE la lane (sotto): una valle
                    // chiusa non è un buon motivo per lasciar correre un
                    // errore critico.
                    if tx.send(row).await.is_err() {
                        valle_aperta = false;
                        ctx.emit_log(
                            &ctx.label,
                            "warn",
                            rows_in,
                            "Pipeline a valle di error_out chiusa: gli errori successivi restano nel pannello".to_string(),
                            "panel",
                        );
                    } else {
                        rows_out += 1;
                    }
                }
            }

            // ── INTERRUZIONE CRITICA ──────────────────────────────
            // DOPO aver registrato ed emesso: la notifica deve uscire
            // prima che la lane venga fermata, altrimenti si perde
            // proprio l'informazione per cui esiste l'handler.
            // `fire` è idempotente: più errori critici fermano una
            // volta sola. Non c'è ricorsione: l'EH e la sua
            // sotto-pipeline non sono nel registro.
            if critical || azione == "stop" {
                // Il motivo viaggia col fire: sarà la frase che l'utente
                // legge accanto a OGNI nodo interrotto, non solo qui.
                let motivo = if critical {
                    format!("errore critico su {}", node)
                } else {
                    format!("regola «interrompi» su {}", node)
                };
                let stopped = ctx.lane_abort.fire(&motivo).await;
                if !stopped.is_empty() {
                    ctx.emit_log(
                        &ctx.label,
                        "error",
                        rows_in,
                        format!(
                            "{} su {}: interrotti {} nodi ancora in esecuzione",
                            if critical { "Errore CRITICO" } else { "Regola «interrompi»" },
                            node, stopped.len(),
                        ),   // NB il testo qui resta invariato: `motivo` è la
                             // forma breve che accompagna i nodi fermati.
                        "panel",
                    );
                }
                // I task interrotti droppano i loro sender: il
                // collettore si chiude e il loop qui sotto esce da sé.
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
