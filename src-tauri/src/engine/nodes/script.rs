// ─── src-tauri/src/engine/nodes/script.rs ──────────────────────────
//
// Nodo Script — FETTA 1. Disegno: `src-tauri/docs/design-nodo-script.md`.
//
// Lo Script non esegue codice: esegue un IR di ISTRUZIONI compilato
// dallo studio (`src/ir/scriptParser.ts`), le cui espressioni sono FPEL
// già in forma di `ExprNode`. Il motore non conosce la sintassi, come
// non conosce quella delle espressioni: qui si valuta e basta.
//
// La versione TypeScript compilava JavaScript arbitrario con
// `new Function()` (v. `src/runner/scriptExecutor.ts`, conservato come
// riferimento). Non è stato portato ma RIPROGETTATO, perché un corpo
// opaco sarebbe eseguibile solo da questo motore e mai traducibile dal
// codegen — mentre tutto il resto del grafo compila a IR.

use std::collections::HashMap;
use std::time::Instant;
use crate::engine::types::*;
use crate::engine::expr::{ExprNode, EvalContext, eval, is_truthy};
use crate::engine::executor::{RowSender, RowReceiver, NodeContext, take_primary_output, make_drain};

/// Nome dell'input sintetico sotto cui vivono i locali dichiarati con
/// `let`. Deve combaciare con `LOCAL_INPUT` in `src/ir/scriptParser.ts`:
/// è lo studio a riscrivere i riferimenti ai locali come
/// `FieldRef { input: "__local", … }`, così l'IR delle espressioni non
/// guadagna varianti e `expr.rs` resta intatto.
const LOCAL_INPUT: &str = "__local";

#[derive(serde::Deserialize)]
#[serde(tag = "kind")]
enum ScriptStmt {
    Let    { name: String,  expr: ExprNode },
    Assign { field: String, expr: ExprNode },
    If {
        cond: ExprNode,
        #[serde(default)] then: Vec<ScriptStmt>,
        // `else` è parola chiave in Rust: il campo si chiama altrimenti
        // e serde lo rimappa sul nome che usa lo studio.
        #[serde(default, rename = "else")] altrimenti: Vec<ScriptStmt>,
    },
    Skip,
    Reject { #[serde(default)] reason: Option<ExprNode> },
    Log    { expr: ExprNode },
    Error  { expr: ExprNode },
}

/// Esito dell'esecuzione di un blocco. `Salta`, `Scarta` e `Fallisci`
/// risalgono attraverso gli `if` annidati fino al ciclo sulle righe:
/// sono l'equivalente di un `return` anticipato, senza che il
/// linguaggio debba avere un `return`.
enum Flow {
    Continua,
    Salta,
    Scarta(String),
    Fallisci(String),
}

pub async fn run(
    ctx:        NodeContext,
    mut rx:     RowReceiver,
    mut outputs: HashMap<String, RowSender>,
) -> Result<NodeStats, String> {

    let spec = crate::engine::spec::Spec::from_ctx(&ctx.spec)
        .map_err(|e| format!("script {}: {}", ctx.node_id.0, e))?;
    spec.log_unconsumed("script", &ctx.node_id.0);

    // `body` è materiale COMPILATO dal builder → spec.config, come i
    // `fields` del transform.
    let body: Vec<ScriptStmt> = match spec.config().get("body") {
        Some(v) => serde_json::from_value(v.clone())
            .map_err(|e| format!("script {}: corpo non valido: {}", ctx.node_id.0, e))?,
        // Nessun corpo = passthrough, che è anche il `fallback`
        // dichiarato nel contratto porte. Non è un errore: è uno script
        // ancora da scrivere.
        None => Vec::new(),
    };

    // La porta reject va presa PRIMA dell'uscita principale (modello di
    // filter e dei parser, P31/P32): `take_primary_output` lascia cadere
    // le altre porte.
    let reject_tx = outputs.remove("reject");
    let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);

    let variables = ctx.variables.clone();
    let start = Instant::now();
    let mut rows_in       = 0u64;
    let mut rows_out      = 0u64;
    let mut rows_rejected = 0u64;

    while let Some(row) = rx.recv().await {
        rows_in += 1;

        // Si parte da una COPIA della riga in ingresso: chi non assegna
        // niente ottiene un passthrough.
        let mut riga   = row;
        // I locali vivono in una riga sintetica, azzerata a ogni giro:
        // un `let` non deve sopravvivere alla riga che l'ha calcolato.
        let mut locali = Row(HashMap::new());

        match esegui(&body, &mut riga, &mut locali, &variables, &ctx, rows_in) {
            Flow::Continua => {
                if tx.send(riga).await.is_err() { break; }
                rows_out += 1;
            }
            Flow::Salta => { /* la riga non esce da nessuna porta */ }
            Flow::Scarta(motivo) => {
                rows_rejected += 1;
                if let Some(rtx) = &reject_tx {
                    let mut scartata = riga;
                    scartata.0.insert("_reject_reason".to_string(), Value::String(motivo));
                    if rtx.send(scartata).await.is_err() { break; }
                }
                // Senza porta reject collegata la riga si perde: è la
                // stessa scelta degli altri nodi con reject condizionale.
            }
            Flow::Fallisci(messaggio) => {
                // Errore di NODO: prende il canale di controllo e arriva
                // all'error handler della lane come qualunque altro
                // fallimento.
                return Err(format!("script {}: {}", ctx.node_id.0, messaggio));
            }
        }
    }

    let stats = NodeStats {
        rows_in,
        rows_out,
        rows_rejected,
        elapsed_ms: start.elapsed().as_millis() as u64,
        error: None,
    };
    ctx.emit_completed(stats.clone());
    Ok(stats)
}

/// Esegue un blocco di istruzioni sulla riga corrente.
///
/// Non è ricorsivo sui dati, solo sui blocchi annidati: il linguaggio
/// non ha cicli né chiamate, quindi la profondità è quella che l'utente
/// ha scritto e non può crescere a runtime.
fn esegui(
    stmts:     &[ScriptStmt],
    riga:      &mut Row,
    locali:    &mut Row,
    variables: &HashMap<String, Value>,
    ctx:       &NodeContext,
    row_num:   u64,
) -> Flow {
    for stmt in stmts {
        match stmt {
            ScriptStmt::Let { name, expr } => {
                let v = valuta(expr, riga, locali, variables);
                locali.0.insert(name.clone(), v);
            }

            ScriptStmt::Assign { field, expr } => {
                let v = valuta(expr, riga, locali, variables);
                riga.0.insert(field.clone(), v);
            }

            ScriptStmt::If { cond, then, altrimenti } => {
                let v = valuta(cond, riga, locali, variables);
                // `is_truthy` è quella di expr.rs: un `if` nello script
                // deve voler dire ESATTAMENTE quello che vuol dire una
                // condizione in un filter. Duplicare la regola qui
                // significherebbe farle divergere alla prima modifica.
                let rami = if is_truthy(&v) { then } else { altrimenti };
                match esegui(rami, riga, locali, variables, ctx, row_num) {
                    // Un blocco che non decide niente lascia proseguire
                    // il blocco esterno; gli altri esiti risalgono.
                    Flow::Continua => {}
                    altro          => return altro,
                }
            }

            ScriptStmt::Skip => return Flow::Salta,

            ScriptStmt::Reject { reason } => {
                let motivo = match reason {
                    Some(e) => valuta(e, riga, locali, variables).as_str_repr(),
                    None    => "scartata dallo script".to_string(),
                };
                return Flow::Scarta(motivo);
            }

            ScriptStmt::Log { expr } => {
                let v = valuta(expr, riga, locali, variables);
                ctx.emit_log(&ctx.label, "info", row_num, v.as_str_repr(), "panel");
            }

            ScriptStmt::Error { expr } => {
                let v = valuta(expr, riga, locali, variables);
                return Flow::Fallisci(v.as_str_repr());
            }
        }
    }
    Flow::Continua
}

/// Valuta un'espressione FPEL nell'ambiente dello Script: la riga sotto
/// `"row"` (come fanno filter e transform) e i locali sotto
/// `LOCAL_INPUT`. Il contesto si ricostruisce a ogni valutazione perché
/// `riga` e `locali` sono prestati in scrittura dal chiamante: qui
/// servono in lettura, e il prestito si chiude prima della modifica.
fn valuta(
    expr:      &ExprNode,
    riga:      &Row,
    locali:    &Row,
    variables: &HashMap<String, Value>,
) -> Value {
    let mut inputs: HashMap<&str, &Row> = HashMap::new();
    inputs.insert("row", riga);
    inputs.insert(LOCAL_INPUT, locali);
    eval(expr, &EvalContext::multi(inputs, variables))
}
