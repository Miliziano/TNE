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
    /// Manda a valle una COPIA della riga com'è ora. Non interrompe: le
    /// istruzioni successive continuano sulla stessa riga di lavoro.
    Emit,
    Repeat {
        count: ExprNode,
        // `rename` esplicito invece di `rename_all_fields`: è lo stesso
        // costrutto già usato qui sopra per `else`, quindi noto e sicuro.
        #[serde(default, rename = "varName")] var_name: Option<String>,
        #[serde(default)] body: Vec<ScriptStmt>,
    },
    For {
        #[serde(rename = "varName")] var_name: String,
        list: ExprNode,
        #[serde(default)] body: Vec<ScriptStmt>,
    },
}

/// Tetto ai giri di ciclo per riga in ingresso. Serve a trasformare un
/// `repeat` con un conteggio sbagliato in un errore leggibile invece che
/// in un processo che mangia memoria finché non muore. Il numero è alto
/// abbastanza da non intralciare un uso legittimo.
const MAX_GIRI: u64 = 1_000_000;

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
    // OPZIONALE, come per `window` ("caso 2: nessun arco"): senza ingresso
    // lo Script è un GENERATORE — il corpo gira una volta sola e le righe
    // escono solo dalle `emit`. Con l'ingresso è il caso normale: una
    // passata per riga. Che sia voluto lo dichiara `sourceMode` nello
    // studio, che in modalità "genera" toglie proprio la porta.
    rx:         Option<RowReceiver>,
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

    match rx {
        // ── Caso normale: una passata per ogni riga in ingresso ──
        Some(mut rx) => {
            while let Some(row) = rx.recv().await {
                rows_in += 1;
                let prosegui = passata(&body, row, &variables, &ctx, rows_in,
                                       &tx, &reject_tx,
                                       &mut rows_out, &mut rows_rejected, true).await?;
                if !prosegui { break; }
            }
        }

        // ── Generatore: una passata sola, senza riga d'ingresso ──
        // La riga di lavoro parte VUOTA e NON esce da sola a fine corpo:
        // senza `emit` un generatore non produce niente, ed è giusto —
        // far uscire una riga vuota sarebbe inventare un dato.
        None => {
            passata(&body, Row(HashMap::new()), &variables, &ctx, 0,
                    &tx, &reject_tx,
                    &mut rows_out, &mut rows_rejected, false).await?;
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

/// Una passata del corpo su una riga di lavoro: esegue, poi manda a valle
/// ciò che è stato prodotto. Restituisce `false` se un canale a valle si è
/// chiuso, così il chiamante smette di ciclare.
///
/// `uscita_implicita` distingue le due nature del nodo: con una riga in
/// ingresso, quella riga esce anche se lo script non ha detto `emit`
/// (passthrough); da generatore, no.
#[allow(clippy::too_many_arguments)]
async fn passata(
    body:             &[ScriptStmt],
    riga_iniziale:    Row,
    variables:        &HashMap<String, Value>,
    ctx:              &NodeContext,
    row_num:          u64,
    tx:               &RowSender,
    reject_tx:        &Option<RowSender>,
    rows_out:         &mut u64,
    rows_rejected:    &mut u64,
    uscita_implicita: bool,
) -> Result<bool, String> {
    let mut riga   = riga_iniziale;
    // I locali vivono in una riga sintetica, azzerata a ogni passata: un
    // `let` non deve sopravvivere alla riga che l'ha calcolato.
    let mut locali = Row(HashMap::new());
    let mut emesse: Vec<Row> = Vec::new();

    let esito = esegui(body, &mut riga, &mut locali, variables, ctx, row_num, &mut emesse);

    // Le righe di `emit` escono in ogni caso: sono state prodotte PRIMA
    // che il corpo decidesse come finire. Così `repeat 3 { emit }` seguito
    // da `skip` significa "solo le tre, non l'originale" — che è il modo
    // naturale di scrivere un fan-out puro.
    for r in emesse {
        if tx.send(r).await.is_err() { return Ok(false); }
        *rows_out += 1;
    }

    match esito {
        Flow::Continua => {
            if uscita_implicita {
                if tx.send(riga).await.is_err() { return Ok(false); }
                *rows_out += 1;
            }
        }
        Flow::Salta => { /* la riga di lavoro non esce da nessuna porta */ }
        Flow::Scarta(motivo) => {
            *rows_rejected += 1;
            if let Some(rtx) = reject_tx {
                let mut scartata = riga;
                scartata.0.insert("_reject_reason".to_string(), Value::String(motivo));
                if rtx.send(scartata).await.is_err() { return Ok(false); }
            }
            // Senza porta reject collegata la riga si perde: stessa scelta
            // degli altri nodi con reject condizionale.
        }
        Flow::Fallisci(messaggio) => {
            // Errore di NODO: prende il canale di controllo e arriva
            // all'error handler della lane come ogni altro fallimento.
            return Err(format!("script {}: {}", ctx.node_id.0, messaggio));
        }
    }
    Ok(true)
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
    // Le righe di `emit` si RACCOLGONO qui invece di essere spedite
    // subito. Spedire vorrebbe dire `await`, e una funzione async che
    // ricorre su se stessa (i blocchi annidati) in Rust non compila senza
    // impacchettare il future: raccogliere tiene la funzione sincrona e
    // la ricorsione banale. Il tetto MAX_GIRI limita quanto può crescere.
    emesse:    &mut Vec<Row>,
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
                match esegui(rami, riga, locali, variables, ctx, row_num, emesse) {
                    // Un blocco che non decide niente lascia proseguire
                    // il blocco esterno; gli altri esiti risalgono.
                    Flow::Continua => {}
                    altro          => return altro,
                }
            }

            ScriptStmt::Emit => emesse.push(riga.clone()),

            ScriptStmt::Repeat { count, var_name, body } => {
                let quante = match valuta(count, riga, locali, variables).as_f64_lossy() {
                    Some(n) if n >= 0.0 => n as u64,
                    _ => return Flow::Fallisci(
                        "repeat: il numero di giri non è un numero non negativo".to_string()),
                };
                if quante > MAX_GIRI {
                    return Flow::Fallisci(format!(
                        "repeat: {} giri richiesti, il massimo è {}", quante, MAX_GIRI));
                }
                for i in 0..quante {
                    if let Some(nome) = var_name {
                        // Contatore da 1: chi scrive `repeat 3 as i` si
                        // aspetta 1,2,3 e non 0,1,2.
                        locali.0.insert(nome.clone(), Value::Int(i as i64 + 1));
                    }
                    match esegui(body, riga, locali, variables, ctx, row_num, emesse) {
                        Flow::Continua => {}
                        altro          => return altro,
                    }
                }
            }

            ScriptStmt::For { var_name, list, body } => {
                let v = valuta(list, riga, locali, variables);
                // Gli array non sono un tipo di FPEL: vivono dentro
                // `Object`, che porta un serde_json::Value. Un valore che
                // non è un array non viene "adattato" a lista di uno solo:
                // sarebbe una comodità che nasconde un errore.
                let elementi: Vec<serde_json::Value> = match &v {
                    Value::Object(serde_json::Value::Array(a)) => a.clone(),
                    _ => return Flow::Fallisci(
                        "for: l'espressione non è un array".to_string()),
                };
                if elementi.len() as u64 > MAX_GIRI {
                    return Flow::Fallisci(format!(
                        "for: {} elementi, il massimo è {}", elementi.len(), MAX_GIRI));
                }
                for el in elementi {
                    locali.0.insert(var_name.clone(), Value::from_json(el));
                    match esegui(body, riga, locali, variables, ctx, row_num, emesse) {
                        Flow::Continua => {}
                        altro          => return altro,
                    }
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
