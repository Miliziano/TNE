# Design — Registro dei dataset materializzati

## Cosa fa `materialize`

Accumula le righe di un flusso in memoria. Due usi, indipendenti:

1. **Buffer / barriera** — utile prima di un nodo che richiede accesso
   casuale (sort, join). Non pubblica nulla.
2. **Dataset condiviso** — l'utente lo **pubblica nella lane** (pulsante
   nel tab Configurazione) dandogli un nome. Altri nodi lo leggono per
   nome, senza arco e senza consumarlo.

La pubblicazione è una **scelta esplicita dell'utente**, non automatica.

## Chi lo consuma

| Nodo        | Prop            | Uso                                  |
|-------------|-----------------|--------------------------------------|
| `window`    | `dataSource`    | funzioni analitiche sul dataset       |
| `aggregate` | `dataSource`    | aggrega il dataset                    |
| `pivot`     | `dataSource`    | pivota il dataset                     |
| `explode`   | `explodeSource` | riporta il dataset a flusso di righe  |
| `join`      | `rightSource`   | lookup contro il dataset              |

Questi nodi **non hanno bisogno di un arco** verso il materialize:
pescano il dataset dalla lane per nome.

## Come lo studio lo dichiara

`publishToLane()` crea una variabile di lane:

    { name: matName, type: 'materialize', value: nodeId, scope: 'lane' }

`removeFromLane()` la elimina. La variabile **è** la dichiarazione:
il suo `value` dice quale nodo pubblica quel nome.

⚠ **Il builder oggi appiattisce le variabili in `{name: value}`**, perdendo
il tipo. Il motore riceve `{"clienti": "node_7"}` e non distingue una
stringa da un dataset. Va aggiunta al plan una sezione dedicata:

    "lanes": [{
      …,
      "variables":  { "prefisso": "ACME" },       // solo scalari
      "datasets":   [ { "name": "clienti", "node_id": "node_7" } ]
    }]

Il motore usa `datasets` per precalcolare gli slot del registro.

---

## Modalità di `materialize`

### `passthrough` — non blocca il flusso

Le righe **attraversano** il nodo una alla volta, verso valle. Nel
frattempo vengono anche salvate nel dataset.

    source → materialize("clienti") → sink        le righe scorrono subito
                     ↓
              dataset "clienti"                    completo a input esaurito

Chi sta a valle **non attende**. Ma il **dataset** è completo solo quando
l'input si chiude: un consumer che lo legge attende fino a quel momento.

### `buffer_signal` — blocca il flusso

Accumula tutto, pubblica il dataset, **poi** emette una sola riga di stato
(`{rows, name, elapsed_ms}`). Chi sta a valle attende.

L'ordine conta: il dataset è pubblicato **prima** del segnale. Chi riceve
la riga sa che può leggere.

---

## Modello nel motore

### Il dataset

    pub struct Dataset {
        rows:      Vec<Row>,
        /// Indice per accesso O(1), se il materialize ha un keyField.
        /// Una chiave può avere più righe: non è una PK.
        index:     Option<HashMap<String, Vec<usize>>>,
        key_field: Option<String>,
    }

Immutabile una volta pubblicato. I consumer ricevono `Arc<Dataset>`:
nessuna copia, lettura concorrente sicura.

### Il registro

    pub struct LaneDatasets {
        slots: Mutex<HashMap<String, Slot>>,
    }

    enum Slot {
        Pending(Arc<Notify>),       // il materialize sta accumulando
        Ready(Arc<Dataset>),        // pubblicato
        Failed(String),             // il materialize è fallito
    }

Vive nel contesto di lane, accanto a `LaneResources` e `LaneTransactions`.
`Arc<LaneDatasets>` nel `NodeContext`.

### La barriera

`execute_lane` crea uno slot `Pending` per **ogni dataset dichiarato**
(dalla sezione `datasets` del plan). Un consumer che chiede un dataset:

    let ds = ctx.lane_datasets.get("clienti").await?;   // attende se Pending

Il materialize, a input esaurito:

    ctx.lane_datasets.publish("clienti", dataset).await;   // → Ready, notifica

Se fallisce:

    ctx.lane_datasets.fail("clienti", msg).await;          // → Failed

### Deadlock — tre difese

1. **Nome non dichiarato** → errore immediato, non attesa.
2. **Ciclo** (`window → materialize("A")` e `window` legge `"A"`) →
   `execute_lane` costruisce il grafo delle dipendenze dataset e **rifiuta
   i cicli prima di partire**, con un messaggio chiaro.
3. **Rete di sicurezza** — a fine lane, `finalize()` risveglia chi attende
   ancora con `Failed("il dataset non è mai stato pubblicato")`.

Un consumer non può restare appeso: o riceve il dataset, o un errore.

---

## Modalità di lettura (decise dal consumer)

Il pannello lo dice: *"come i dati vengono letti è responsabilità del nodo
consumer"*.

- **`dataset`** — prende `Arc<Dataset>` e lo scorre. Default.
- **`iterator`** — riga per riga. **In Rust è la stessa cosa**:
  `dataset.rows.iter()`, zero copie. La distinzione aveva senso in JS
  (lista completa vs streaming). Qui le trattiamo uguali.
- **`lookup`** — `dataset.get(key)` → `&[Row]`. Richiede `keyField` sul
  materialize. È come lo usa `join`.

---

## Limiti dichiarati

**Memoria.** Un dataset vive per tutta la lane. `max_rows` e `on_overflow`
(già nel materialize) restano l'unica difesa. Il log lo dice:
`[materialize] 'clienti': 50000 righe pubblicate`.

**Ambito.** Registro **per-lane**, come pool e transazioni. Un dataset non
attraversa le lane. Coerente: la lane è l'unità di isolamento, e domani un
processo separato.

**Codegen.** Il registro è struttura di esecuzione, non di dati. Le
dipendenze sono statiche (chi pubblica cosa, chi legge cosa), quindi il
generatore può risolverle a compile-time: una variabile locale, o una
`Map` condivisa.

---

## Passi

1. **`datasets.rs`** — `Dataset`, `Slot`, `LaneDatasets` con `publish`,
   `get` (attesa), `fail`, `finalize`.
2. **Plan** — sezione `datasets` per lane (dalle variabili di tipo
   `materialize`), e `variables` con i soli scalari.
3. **`execute_lane`** — precalcola gli slot, rifiuta i cicli, `finalize`
   a fine lane.
4. **`materialize.rs`** — pubblica; modalità `passthrough` (streaming) e
   `buffer_signal` (barriera).
5. **Consumer**, uno per volta: `window`, `aggregate`, `pivot`, `explode`,
   `join`. Chi non è pronto continua a funzionare in modalità `flow`.
