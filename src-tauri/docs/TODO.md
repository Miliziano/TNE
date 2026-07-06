# FlowPilot — TODO tecnici

Debiti noti e feature rimandate, tracciati per non perderli tra sessioni.
Ogni voce dice: cos'è, perché è rimandata, dove si manifesta.

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

## Value::Decimal — Fase B: nodi di calcolo decimal-aware
- **Cos'è:** il tipo `Value::Decimal` (NUMERIC/DECIMAL esatti) esiste e
  attraversa la pipeline, ma i nodi che *calcolano* non lo sfruttano
  ancora: filter, aggregate (SUM/AVG), ed espressioni lo trattano come
  Float tramite `Value::as_f64_lossy()` — che perde precisione.
- **Perché rimandato:** far compilare la Fase A senza riscrivere subito
  tutti i nodi di calcolo. `as_f64_lossy` è un ponte dichiarato tale.
- **Da fare:** aritmetica esatta su Decimal in filter/aggregate/expr;
  `expr.rs::to_int` copre già Decimal→i64, ma i confronti e le somme in
  `aggregate.rs` e `filter.rs` vanno resi decimal-aware. Rimuovere gli
  usi di `as_f64_lossy` nei nodi di calcolo man mano.
- **Contesto:** introdotto migrando i NUMERIC (rental_rate,
  replacement_cost davano Null perché letti come f64).

## Value::Decimal — preservazione dal JSON in ingresso
- **Cos'è:** oggi `Value::from_json` mappa i numeri JSON con decimali su
  `Float`, non su `Decimal` (il Decimal nasce solo dalla lettura DB).
- **Perché è ok per ora:** i decimali esatti arrivano dai DB, non dal
  JSON di configurazione. Un json_parser che legge importi da file JSON,
  però, li degraderebbe a Float.
- **Da valutare:** se/quando servirà, preservare i decimali anche in
  from_json (serde_json ha `arbitrary_precision`).

## union — semantica del merge schema (by-name con null)

- **Cos'è:** l'Union di FlowPilot non è la union SQL classica (per
  posizione, stessa struttura). È un **merge di schema per nome**: fonde
  flussi anche con colonne diverse, produce in uscita l'unione di tutti
  i campi di tutti gli ingressi (omonimi non duplicati) e riempie di
  `null` le colonne che una riga non possiede. Impila le righe: stesso
  valore di chiave in due input → DUE righe (una per input), non una
  (è ciò che la distingue dal Join).

- **Perché va normato:** il merge per nome ha due decisioni di semantica
  che oggi sono implicite e possono creare bug muti — divergerebbero tra
  motore live e codegen (Java/Python coerciscono i tipi diversamente):

  1. **Collisione di nome con tipo diverso.** Input A ha `codice` intero,
     input B ha `codice` stringa. La colonna fusa `codice` che tipo
     prende? Opzioni: coercizione a tipo comune / colonne distinte /
     errore. Da decidere e dichiarare.

  2. **Omonimia non voluta.** Due input hanno entrambi `id` ma con
     significato diverso (id-cliente vs id-ordine). Il merge by-name le
     fonde in una sola colonna, mescolando semantiche diverse senza che
     nessuno se ne accorga. Speculare al punto 1.

- **Da fare:** alla migrazione dell'union alla spec, fissare in
  node-spec.md le regole per (1) e (2) — con eventuale opzione utente
  nel pannello (es. "allinea per nome" vs "per posizione", policy sui
  conflitti di tipo). Emettere warning quando un merge fonde colonne
  con tipi incompatibili.

- **Contesto:** emerso confrontando Join e Union. Non si sovrappongono:
  Join fonde orizzontalmente (affianca colonne correlando righe per
  chiave), Union fonde verticalmente (impila righe unendo lo schema).
  Possono produrre lo stesso schema di uscita ma popolano le righe in
  modo opposto.

  
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