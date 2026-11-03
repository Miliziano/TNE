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
use crate::engine::expr::{ExprNode, EvalContext, is_truthy};
use crate::engine::compiled::Compiled;
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
    /// var("x") = expr : scrive una variabile di lane. A differenza di
    /// Assign (che tocca la riga), aggiorna la mappa `variables`, che vive
    /// FUORI dal loop delle righe → il valore sopravvive alla riga corrente
    /// e la successiva lo rilegge con var("x"). Scope: locale al nodo.
    SetVar { name: String, expr: ExprNode },
    If {
        cond: ExprNode,
        #[serde(default)] then: Vec<ScriptStmt>,
        // `else` è parola chiave in Rust: il campo si chiama altrimenti
        // e serde lo rimappa sul nome che usa lo studio.
        #[serde(default, rename = "else")] altrimenti: Vec<ScriptStmt>,
    },
    Skip,
    Reject { #[serde(default)] reason: Option<ExprNode> },
    /// P392: `expect <condizione> else reject|warn|error [messaggio]` — una
    /// regola sui dati: se la condizione non è vera la riga si scarta (reject),
    /// prosegue (warn) o fa fallire il nodo (error); in ogni caso la violazione
    /// si CONTA per regola e il conteggio va al monitor (NodeRuleStats).
    Expect {
        cond:    ExprNode,
        action:  String,
        #[serde(default)] message: Option<ExprNode>,
        /// nome della regola nei conteggi (il messaggio scritto, o la condizione)
        label:   String,
    },
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

/// P388: il corpo con le espressioni COMPILATE una volta all'avvio del nodo
/// (engine/compiled.rs), invece di reinterpretare l'albero a ogni riga. Stesse
/// istruzioni di `ScriptStmt`, stessa semantica.
enum Istr {
    Let    { name: String,  c: Compiled },
    Assign { field: String, c: Compiled },
    SetVar { name: String,  c: Compiled },
    If     { cond: Compiled, then: Vec<Istr>, altrimenti: Vec<Istr> },
    Skip,
    Reject { reason: Option<Compiled> },
    /// `regola` = indice nel registro delle regole del nodo (conteggi)
    Expect { cond: Compiled, action: Azione, message: Option<Compiled>, regola: usize },
    Log    { c: Compiled },
    Error  { c: Compiled },
    Emit,
    Repeat { count: Compiled, var_name: Option<String>, body: Vec<Istr> },
    For    { var_name: String, list: Compiled, body: Vec<Istr> },
}

/// P392: cosa fa una regola `expect` violata.
#[derive(Clone, Copy, PartialEq)]
enum Azione { Scarta, Avvisa, Fallisci }

/// Le regole `expect` di un nodo, nell'ordine in cui compaiono, con i conteggi.
#[derive(Default)]
struct Regole {
    voci: Vec<(String, Azione, u64)>,
}

impl Regole {
    fn esito(&self) -> Vec<crate::engine::events::RuleStat> {
        self.voci.iter().map(|(r, a, n)| crate::engine::events::RuleStat {
            rule: r.clone(),
            action: match a { Azione::Scarta => "reject", Azione::Avvisa => "warn", Azione::Fallisci => "error" }.to_string(),
            violations: *n,
        }).collect()
    }
}

fn compila(stmts: &[ScriptStmt], regole: &mut Regole) -> Result<Vec<Istr>, String> {
    stmts.iter().map(|s| Ok(match s {
        ScriptStmt::Let { name, expr }    => Istr::Let { name: name.clone(), c: Compiled::new(expr) },
        ScriptStmt::Assign { field, expr } => Istr::Assign { field: field.clone(), c: Compiled::new(expr) },
        ScriptStmt::SetVar { name, expr } => Istr::SetVar { name: name.clone(), c: Compiled::new(expr) },
        ScriptStmt::If { cond, then, altrimenti } => Istr::If {
            cond: Compiled::new(cond), then: compila(then, regole)?, altrimenti: compila(altrimenti, regole)?,
        },
        ScriptStmt::Expect { cond, action, message, label } => {
            let azione = match action.as_str() {
                "reject" => Azione::Scarta,
                "warn"   => Azione::Avvisa,
                "error"  => Azione::Fallisci,
                altro => return Err(format!("expect: unknown action \"{}\" (reject, warn or error)", altro)),
            };
            regole.voci.push((label.clone(), azione, 0));
            Istr::Expect {
                cond: Compiled::new(cond), action: azione,
                message: message.as_ref().map(Compiled::new), regola: regole.voci.len() - 1,
            }
        }
        ScriptStmt::Skip => Istr::Skip,
        ScriptStmt::Reject { reason } => Istr::Reject { reason: reason.as_ref().map(Compiled::new) },
        ScriptStmt::Log { expr }   => Istr::Log { c: Compiled::new(expr) },
        ScriptStmt::Error { expr } => Istr::Error { c: Compiled::new(expr) },
        ScriptStmt::Emit => Istr::Emit,
        ScriptStmt::Repeat { count, var_name, body } => Istr::Repeat {
            count: Compiled::new(count), var_name: var_name.clone(), body: compila(body, regole)?,
        },
        ScriptStmt::For { var_name, list, body } => Istr::For {
            var_name: var_name.clone(), list: Compiled::new(list), body: compila(body, regole)?,
        },
    })).collect()
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
            .map_err(|e| format!("script {}: invalid body: {}", ctx.node_id.0, e))?,
        // Nessun corpo = passthrough, che è anche il `fallback`
        // dichiarato nel contratto porte. Non è un errore: è uno script
        // ancora da scrivere.
        None => Vec::new(),
    };
    let mut regole = Regole::default();
    let body: Vec<Istr> = compila(&body, &mut regole)
        .map_err(|e| format!("script {}: {}", ctx.node_id.0, e))?;

    // La porta reject va presa PRIMA dell'uscita principale (modello di
    // filter e dei parser, P31/P32): `take_primary_output` lascia cadere
    // le altre porte.
    let reject_tx = outputs.remove("reject");
    let tx = take_primary_output(&mut outputs).unwrap_or_else(make_drain);

    // `mut`: da P71 lo Script può SCRIVERE le variabili di lane (SetVar).
    // Vive fuori dal loop, quindi le scritture persistono fra le righe.
    let mut variables = ctx.variables.clone();
    let start = Instant::now();
    let mut rows_in       = 0u64;
    let mut rows_out      = 0u64;
    let mut rows_rejected = 0u64;

    // ── Chi comanda: la DICHIARAZIONE, non la presenza del canale ──
    // Prima le due nature si distinguevano dal solo `rx`: "genera" nello studio
    // toglie la porta, quindi si dava per scontato che senza porta non ci fosse
    // canale. Ma un arco disegnato PRIMA di cambiare modalità resta nel piano:
    // il nodo continuava a lavorare riga-per-riga mentre lo studio dichiarava
    // "generatore" — dichiarazione e comportamento divergenti, in silenzio.
    // Ora `sourceMode` decide: da generatore l'eventuale ingresso viene ignorato
    // (e detto nel log, che è un'incongruenza del piano, non un dettaglio).
    let genera = spec.str_or("sourceMode", "flusso") == "genera";
    let rx = if genera {
        if rx.is_some() {
            ctx.emit_log(
                &ctx.label,
                "warn",
                0,
                "Declared as GENERATOR but has an incoming connection: incoming rows are ignored. Disconnect the edge, or set the node back to 'flow' mode."
                    .to_string(),
                "panel",
            );
        }
        None
    } else {
        rx
    };

    // P392: i conteggi delle regole `expect` escono anche se il nodo fallisce
    // (un `expect … else error` fa fallire proprio per una regola).
    let esito: Result<(), String> = async {
        match rx {
            // ── Caso normale: una passata per ogni riga in ingresso ──
            Some(mut rx) => {
                while let Some(row) = rx.recv().await {
                    rows_in += 1;
                    let prosegui = passata(&body, row, &mut variables, &ctx, rows_in,
                                           &tx, &reject_tx,
                                           &mut rows_out, &mut rows_rejected, true, &mut regole).await?;
                    if !prosegui { break; }
                }
            }

            // ── Generatore: una passata sola, senza riga d'ingresso ──
            // La riga di lavoro parte VUOTA e NON esce da sola a fine corpo:
            // senza `emit` un generatore non produce niente, ed è giusto —
            // far uscire una riga vuota sarebbe inventare un dato.
            None => {
                passata(&body, Row::new(), &mut variables, &ctx, 0,
                        &tx, &reject_tx,
                        &mut rows_out, &mut rows_rejected, false, &mut regole).await?;
            }
        }
        Ok(())
    }.await;
    if !regole.voci.is_empty() { ctx.emit_rule_stats(regole.esito()); }
    esito?;

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
    body:             &[Istr],
    riga_iniziale:    Row,
    variables:        &mut HashMap<String, Value>,
    ctx:              &NodeContext,
    row_num:          u64,
    tx:               &RowSender,
    reject_tx:        &Option<RowSender>,
    rows_out:         &mut u64,
    rows_rejected:    &mut u64,
    uscita_implicita: bool,
    regole:           &mut Regole,
) -> Result<bool, String> {
    let mut riga   = riga_iniziale;
    // I locali vivono in una riga sintetica, azzerata a ogni passata: un
    // `let` non deve sopravvivere alla riga che l'ha calcolato.
    let mut locali = Row::new();
    let mut emesse: Vec<Row> = Vec::new();

    let esito = esegui(body, &mut riga, &mut locali, variables, ctx, row_num, &mut emesse, regole);

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
                scartata.insert("_reject_reason".to_string(), Value::String(motivo));
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
#[allow(clippy::too_many_arguments)]
fn esegui(
    stmts:     &[Istr],
    riga:      &mut Row,
    locali:    &mut Row,
    variables: &mut HashMap<String, Value>,
    ctx:       &NodeContext,
    row_num:   u64,
    // Le righe di `emit` si RACCOLGONO qui invece di essere spedite
    // subito. Spedire vorrebbe dire `await`, e una funzione async che
    // ricorre su se stessa (i blocchi annidati) in Rust non compila senza
    // impacchettare il future: raccogliere tiene la funzione sincrona e
    // la ricorsione banale. Il tetto MAX_GIRI limita quanto può crescere.
    emesse:    &mut Vec<Row>,
    // P392: registro delle regole `expect` del nodo, coi conteggi
    regole:    &mut Regole,
) -> Flow {
    for stmt in stmts {
        match stmt {
            Istr::Let { name, c } => {
                let v = valuta(c, riga, locali, variables);
                locali.insert(name.clone(), v);
            }

            Istr::Assign { field, c } => {
                let v = valuta(c, riga, locali, variables);
                riga.insert(field.clone(), v);
            }

            Istr::SetVar { name, c } => {
                // `valuta` ri-presta `variables` in sola lettura (var("x")
                // legge il valore corrente), poi si scrive: sequenziale, ok
                // per il borrow checker.
                let v = valuta(c, riga, locali, variables);
                variables.insert(name.clone(), v);
            }

            Istr::If { cond, then, altrimenti } => {
                let v = valuta(cond, riga, locali, variables);
                // `is_truthy` è quella di expr.rs: un `if` nello script
                // deve voler dire ESATTAMENTE quello che vuol dire una
                // condizione in un filter. Duplicare la regola qui
                // significherebbe farle divergere alla prima modifica.
                let rami = if is_truthy(&v) { then } else { altrimenti };
                match esegui(rami, riga, locali, variables, ctx, row_num, emesse, regole) {
                    // Un blocco che non decide niente lascia proseguire
                    // il blocco esterno; gli altri esiti risalgono.
                    Flow::Continua => {}
                    altro          => return altro,
                }
            }

            Istr::Emit => emesse.push(riga.clone()),

            Istr::Repeat { count, var_name, body } => {
                let quante = match valuta(count, riga, locali, variables).as_f64_lossy() {
                    Some(n) if n >= 0.0 => n as u64,
                    _ => return Flow::Fallisci(
                        "repeat: the number of iterations is not a non-negative number".to_string()),
                };
                if quante > MAX_GIRI {
                    return Flow::Fallisci(format!(
                        "repeat: {} iterations requested, the maximum is {}", quante, MAX_GIRI));
                }
                for i in 0..quante {
                    if let Some(nome) = var_name {
                        // Contatore da 1: chi scrive `repeat 3 as i` si
                        // aspetta 1,2,3 e non 0,1,2.
                        locali.insert(nome.clone(), Value::Int(i as i64 + 1));
                    }
                    match esegui(body, riga, locali, variables, ctx, row_num, emesse, regole) {
                        Flow::Continua => {}
                        altro          => return altro,
                    }
                }
            }

            Istr::For { var_name, list, body } => {
                let v = valuta(list, riga, locali, variables);
                // Gli array non sono un tipo di FPEL: vivono dentro
                // `Object`, che porta un serde_json::Value. Un valore che
                // non è un array non viene "adattato" a lista di uno solo:
                // sarebbe una comodità che nasconde un errore.
                let elementi: Vec<serde_json::Value> = match &v {
                    Value::Object(serde_json::Value::Array(a)) => a.clone(),
                    _ => return Flow::Fallisci(
                        "for: the expression is not an array".to_string()),
                };
                if elementi.len() as u64 > MAX_GIRI {
                    return Flow::Fallisci(format!(
                        "for: {} elements, the maximum is {}", elementi.len(), MAX_GIRI));
                }
                for el in elementi {
                    locali.insert(var_name.clone(), Value::from_json(el));
                    match esegui(body, riga, locali, variables, ctx, row_num, emesse, regole) {
                        Flow::Continua => {}
                        altro          => return altro,
                    }
                }
            }

            Istr::Skip => return Flow::Salta,

            Istr::Expect { cond, action, message, regola } => {
                if !is_truthy(&valuta(cond, riga, locali, variables)) {
                    regole.voci[*regola].2 += 1;
                    // Il messaggio si calcola solo quando serve: per `warn` dopo
                    // la prima violazione si conta e basta.
                    if matches!(action, Azione::Avvisa) && regole.voci[*regola].2 > 1 { continue }
                    let testo = match message {
                        Some(m) => valuta(m, riga, locali, variables).as_str_repr(),
                        None    => format!("expectation not met: {}", regole.voci[*regola].0),
                    };
                    let voce = &regole.voci[*regola];
                    match action {
                        Azione::Scarta   => return Flow::Scarta(testo),
                        Azione::Fallisci => return Flow::Fallisci(testo),
                        // La riga prosegue; il log dice solo la PRIMA violazione di
                        // ogni regola (le altre sono nel conteggio, non una riga di
                        // log per riga di dati).
                        Azione::Avvisa => ctx.emit_log(&ctx.label, "warn", row_num,
                            format!("rule \"{}\" not met (first time at row {}): {} — every violation is counted in the run summary",
                                    voce.0, row_num, testo), "panel"),
                    }
                }
            }

            Istr::Reject { reason } => {
                let motivo = match reason {
                    Some(e) => valuta(e, riga, locali, variables).as_str_repr(),
                    None    => "scartata dallo script".to_string(),
                };
                return Flow::Scarta(motivo);
            }

            Istr::Log { c } => {
                let v = valuta(c, riga, locali, variables);
                ctx.emit_log(&ctx.label, "info", row_num, v.as_str_repr(), "panel");
            }

            Istr::Error { c } => {
                let v = valuta(c, riga, locali, variables);
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
    c:         &Compiled,
    riga:      &Row,
    locali:    &Row,
    variables: &HashMap<String, Value>,
) -> Value {
    // P388: contesto senza HashMap (niente allocazioni) ed espressione compilata.
    c.eval(&EvalContext::from_pairs([("row", riga), (LOCAL_INPUT, locali)], variables, None))
}
