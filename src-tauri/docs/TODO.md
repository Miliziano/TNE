# FlowPilot — TODO tecnici

Debiti noti e feature rimandate, tracciati per non perderli tra sessioni.
Ogni voce dice: cos'è, perché è rimandata, dove si manifesta.

## aggregate/window/pivot — semantica di ORDER BY (multi-campo)

Disallineamento pannello↔motore, **preesistente** alla migrazione di
aggregate (Fase 12), emerso migrandolo.

- Il pannello aggregate espone `orderBy` come **testo libero** con le
  direzioni inline, stile SQL: `"count DESC, region ASC"`. Non c'è un
  `orderDir` separato.
- Il motore (`aggregate.rs`, ~riga 225) tratta `order_by` come **un
  singolo nome di campo** e legge `orderDir` (chiave che il pannello non
  produce mai → sempre `"asc"`). Con un `orderBy` multi-campo, cerca un
  campo chiamato letteralmente `"count DESC, region ASC"`, non lo trova,
  e l'ordinamento non fa nulla di sensato.

Conseguenza: l'ordinamento in uscita funziona solo nel caso banale di un
singolo campo senza direzione. Multi-campo e `DESC` inline sono ignorati
in silenzio.

Rimandato perché la migrazione Fase 12 deve restare **fedele al
comportamento pre-esistente** (scelta "A"), e perché la sintassi di
ORDER BY va decisa **una volta per tutti i nodi che ordinano** — aggregate,
window e pivot hanno lo stesso campo `orderBy`. Progettarla in mezzo alla
migrazione di un singolo nodo mescola due lavori.

Quando si affronta, due strade (da valutare allora):
- **motore**: parser `campo [ASC|DESC], …` in aggregate/window/pivot,
  `orderDir` deprecato;
- **pannello**: selettore direzione esplicito + campo singolo (toglie il
  multi-campo all'utente).

Priorità: media. Non produce dati errati (le righe restano corrette),
solo un ordine di uscita non rispettato senza segnalazione.

Nota: la telemetria `log_unconsumed` di aggregate segnala come non
consumate le props `aggFunctions` e `having` (testo FPEL sorgente): è
atteso e corretto — il loro compilato (IR) vive in `spec.config`, non
nelle props. Non è un drop.

## pivot — `distinctValuesMat` offerta ma ignorata dal motore

Disallineamento pannello↔motore, **preesistente** alla migrazione di
pivot (Fase 12), emerso migrandolo.

Il pannello pivot, in modalità `dynamic`, espone una prop
`distinctValuesMat` per fornire l'elenco dei valori-colonna da un
**materialize esterno**. Ma il motore (`pivot.rs`, modalità dynamic)
ricava i valori distinti **dalle righe stesse in ingresso**, e non legge
`distinctValuesMat`. La prop è quindi offerta all'utente ma ignorata:
l'utente può selezionare un materialize di valori distinti che non avrà
alcun effetto.

Rimandato: fuori scope dalla migrazione (che resta fedele all'esistente).
Da decidere quando si affronta: o il motore impara a leggere i valori
distinti da un dataset esterno (utile per colonne stabili tra run), o la
prop si rimuove dal pannello (come fatto per `lane_var` di explode).

Priorità: bassa. Non rompe (il dynamic funziona coi valori dalle righe),
ma è una promessa UI non mantenuta — il tipo di cosa che la validazione
live (Fase 13) dovrà segnalare.

## join — customCondition
- **Cos'è:** condizione di match arbitraria nel nodo Join, oltre
  all'uguaglianza di chiave (es. `left.importo > right.soglia`).
- **Perché rimandata:** il runner JS legacy la eseguiva come codice
  JavaScript arbitrario (`new Function`). Il motore Rust non può
  eseguire codice utente: serve un interprete di espressioni.
- **Stato attuale:** se l'utente la valorizza, `join.rs` emette un
  warning e la ignora (nessun risultato silenziosamente errato).
- **Possibile approccio:** riusare/estendere `engine/expr.rs` se il
  formato delle espressioni è compatibile.
- **Contratto:** docs/node-spec.md §7, marcata 🕐.

## join — rightSource=materialize
- **Cos'è:** prendere il lato destro da un nodo Materialize invece che
  dallo stream input_right.
- **Perché rimandata:** il nodo `materialize` non è ancora migrato alla
  spec. Warning + fallback a stream nel frattempo.

## studio — campi connessione duplicati nelle props dei nodi DB
- **Cos'è:** i pannelli source_db/sink_db copiano host/port/database/
  user/password/dialect nelle props del nodo, oltre che nella risorsa.
- **Perché è un problema:** password in chiaro duplicata nel file di
  scenario, possibile divergenza dalla risorsa. Emerso dal log
  [spec][sink_db] delle props non consumate.
- **Fix:** i pannelli non devono copiare i campi connessione nelle
  props; fa fede spec.resource. Non urgente.

## log — LogPanel in-app senza buffering
- **Cos'è:** il LogPanel in-app (target=panel) fa un re-render per riga
  via store.addLog; la finestra viewer invece bufferizza (200 righe /
  80ms). Su sampleMode=all ad alto volume il pannello in-app soffre.
- **Fix possibile:** dare al LogPanel lo stesso batching dello
  useLogViewerStore, se servirà l'alto volume anche in-app.

## trasversale — viste per-lane
- Monitor memoria, log e contatori dovrebbero offrire viste separate
  per lane (le lane sono sandbox asincrone, potenzialmente processi/
  artifact distinti coordinati via bridge). Gli eventi già portano
  lane_id: è lavoro di presentazione, non di trasporto. Da pianificare.

## Value::Decimal — Fase B: nodi di calcolo decimal-aware — ✅ IN GRAN PARTE RISOLTA

Stato aggiornato (Fase 12, verificato nel codice): il grosso è **fatto**.
Questa voce era rimasta indietro rispetto al codice e induceva a credere
che ci fosse un blocco davanti a filter/transform. Non c'è.

- **Aritmetica delle espressioni (expr.rs):** `numeric_op` — che alimenta
  Add/Sub/Mul/Div/Mod — è **decimal-aware**: Decimal×Decimal, Decimal×Int
  restano Decimal esatti, senza passare per f64. Solo Decimal×Float
  degrada a Float (corretto: il Float è già inesatto). Filter e transform,
  che valutano espressioni via expr.rs, ereditano questo. → risolto.
- **Bug `Add`:** il TODO storico diceva che `Add` concatena in silenzio
  dove FPEL vuole `null`. Il codice attuale (`eval_binary`) è **corretto**:
  concatena solo se un operando è stringa, altrimenti aritmetica, e su
  null/tipi-non-numerici → `Null` (semantica SQL, come expr-ir-schema §3).
  → risolto.
- **`as_f64_lossy` residui:** restano SOLO in operazioni intrinsecamente
  a virgola mobile — `median`/`std_dev`/`variance` (aggregate), moving
  average (window), somma totali-riga (pivot), `is_numeric`/confronti
  (data_quality). Qui f64 è **corretto per natura** (una deviazione
  standard non ha forma Decimal esatta), non un degrado da sanare.
- **Resta da valutare (minore):** se un domani si volessero SUM/AVG di
  aggregate in Decimal esatto (oggi passano da f64 in riga ~254), sarebbe
  un miglioramento di precisione per importi monetari aggregati. Non
  blocca nulla; priorità bassa.

## Value::Decimal — preservazione dal JSON in ingresso
- **Cos'è:** oggi `Value::from_json` mappa i numeri JSON con decimali su
  `Float`, non su `Decimal` (il Decimal nasce solo dalla lettura DB).
- **Perché è ok per ora:** i decimali esatti arrivano dai DB, non dal
  JSON di configurazione. Un json_parser che legge importi da file JSON,
  però, li degraderebbe a Float.
- **Da valutare:** se/quando servirà, preservare i decimali anche in
  from_json (serde_json ha `arbitrary_precision`).

## union — semantica del merge schema (by-name con null) — ✅ RISOLTA

Stato aggiornato (Fase 12): le due decisioni sotto erano **già decise e
implementate** nel MappingPanel (`src/nodes/types/union/MappingPanel.tsx`).
Il TODO era rimasto indietro rispetto al codice.

Il modello reale: allineamento su **nome + tipo**. Campi con stesso nome
E stesso tipo si fondono; nome uguale ma tipo diverso → suffisso
automatico (`codice_2`), niente fusione; l'utente separa/fonde
rinominando. Il motore applica la mappatura risolta, non inferisce.
Normato in `node-spec.md §17`.

Come questo risolve le due ambiguità:
  1. **Collisione di nome con tipo diverso** → non si fondono in
     automatico (la fusione richiede tipo uguale); l'utente decide.
     Se forza la fusione, il motore impila verbatim senza coercere
     (tipi misti nella colonna; coercizione = transform a valle).
  2. **Omonimia non voluta** → l'utente rinomina uno dei due nel pannello
     per tenerli separati. Nessun merge cieco.

Resta (minore, per validazione live Fase 13): emettere un **warning**
quando l'utente forza la fusione di colonne con tipi incompatibili.

  
## Nota per node-spec.md §3 — tipi non scalari (tsvector, tipi custom)
- **Aggiungere alla tabella di conversione tipi / note del source_db:

  1. **tsvector e altri tipi non direttamente decodificabili. Alcuni tipi
    PostgreSQL non hanno un decoder testuale nativo in sqlx e con SELECT *
    il source li rende Null (era: byte binari corrotti). Esempi: tsvector
    (indice full-text). Questo è VOLUTO: sono indici/strutture interne, non
    dati di contenuto (il testo originale è nelle colonne sorgente, es.
    description).

  2. **Soluzione universale — query custom con cast. Chi ha bisogno del
    contenuto lo ottiene scrivendo una query custom nel pannello con un cast
    esplicito a text:

    SELECT film_id, title, ..., fulltext::text AS fulltext
    FROM film

    Il meccanismo funziona end-to-end senza modifiche al motore:

    "Rileva schema dalla query" usa pool.describe() → Postgres riporta
    il tipo castato come text → il mapping si allinea automaticamente.
    Al run, il source legge la colonna come text (già castata da PG) →
    contenuto disponibile (es. 'academi':1 'battl':15 ...).
    Il sink la scrive come stringa, coerente.

  3. **Principio: i tipi esotici si risolvono in SQL (linguaggio universale per
    questi casi), non con decoder binari fragili nel motore. Vale per
    qualunque tipo che l'utente sappia castare a un tipo scalare.

## Da aggiungere a docs/TODO.md

  ### Semantica `Add` nel motore espressioni (bug latente, dati sbagliati silenziosi)
  `eval_binary` in src-tauri/src/engine/expr.rs:
  ```rust
  BinaryOperator::Add => numeric_op(...).unwrap_or_else(|| {
      Value::String(format!("{}{}", l_str(&l), l_str(&r)))   // fallback: concatena
  }),
  ```
  Se la somma numerica fallisce, il motore **concatena come stringhe**, in
  silenzio. Conseguenze:
  - `"" + Null`  → `Value::String("")`
  - `null + 5`   → stringa `"5"` (invece di Null o 5)
  Un valore stringa così prodotto finisce su una colonna numerica → errore
  DB criptico (`la colonna "id" è di tipo bigint ma l'espressione è di tipo
  text`), oppure — peggio — passa silenziosamente dove la colonna è testo.

  Stessa famiglia dei "default silenziosi" già eliminati altrove
  (keyFields='id' inventato, badge di stato residuo).

  **Da normare:**
  - `null` in un'operazione aritmetica dovrebbe propagare `Null` (semantica SQL).
  - La concatenazione dovrebbe avere un operatore dedicato (`||` o `concat()`),
    non essere il fallback di `+`.
  - `Sub/Mul/Div/Mod` già ritornano `Null` sul fallimento: `Add` è l'eccezione
    incoerente.

  Priorità: media-alta. Produce dati errati senza errore quando la
  destinazione è testuale.

  ### DDL / pre-SQL / post-SQL nel ramo transazionale (in corso)
  `write_all_tx` e `write_master_detail_tx` NON eseguono DDL né pre/post-SQL:
  un sink con "crea tabella se non esiste" dentro una transazione fallisce
  con "la relazione non esiste".
  Nota dialetti: in PostgreSQL la DDL è transazionale (rollback annulla il
  CREATE) → si può eseguire dentro il gruppo. In Oracle/MySQL la DDL fa
  **commit implicito** e spezzerebbe la transazione → servirà una variante
  che la esegue fuori, su connessione autocommit.