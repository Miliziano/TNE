<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# TMap  `tmap`

**Categoria:** Transform  ·  **Icona:** `⇌`  ·  **Colore:** `#a78bfa`

Trasformatore visuale multi-input/output con mapping, join lookup e routing condizionale.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `shortLabel` | Etichetta | text | — | — | — |

## Semantica

- **Operazioni logiche:** `projection`, `filter`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** sì
- **Più ingressi:** sì · **ingressi dinamici** (handle `input_new`)
- **Runtime preferiti:** `typescript` → `python_polars`
- **Pushdown alla sorgente:** `filter`, `projection`

**Porte di ingresso (statiche):**

- `input_main` · ruolo data

**Porte di uscita (statiche):**

_Nessuna._

> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla configurazione a run-time): l'elenco statico qui sopra può essere parziale.

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Un ingresso **main** letto riga per riga e N **lookup** tenuti in memoria per chiave.
Per ogni riga del main si cercano i lookup nell'ordine delle dipendenze (un lookup può
legarsi a un altro già risolto: join a catena). *inner*: senza corrispondenza la riga va
sull'uscita **rejected**; *left*: continua coi campi del lookup a null; *first*: solo la
prima corrispondenza (con inner/left una riga del main ne produce una per corrispondenza).

**Chiavi di join (P371).** Ogni lato è un campo con una funzione (trim, maiuscole,
anno, substring(start, length), regex extract, espressione FPEL). Lato sorgente i campi
si leggono dall'ingresso indicato (anche il main: un campo omonimo in un altro ingresso
non interferisce), lato lookup dalla riga del lookup. Con più campi la combinazione
automatica li unisce con "-"; una combinazione scritta a mano è FPEL con `$0`, `$1`… al
posto dei campi. *regex extract* prende il primo gruppo catturato (o tutta la
corrispondenza). Fino al P370: l'espressione libera non scritta come `row.campo` diventava
una costante (tutte le chiavi uguali), *regex extract* dava vero/falso, la combinazione
automatica salvata in JavaScript fermava il Run; ora si riallineano all'apertura del
progetto.

**Espressioni.** I campi degli ingressi si scrivono per esteso (`Ordini.id`,
`"Anagrafica clienti".nome`); nudi solo le trasformazioni e i contatori `lane.x`.
Rinominando un ingresso le espressioni (trasformazioni, campi e filtri delle uscite)
prendono la nuova etichetta.

**Tipi in uscita (P371).** Il tipo di un campo d'uscita (dedotto dall'espressione o
scelto a mano) si applica: `"12"` su un campo *integer* esce 12; un valore non
convertibile resta com'è e il log lo conta. Il tipo *string* non converte (è anche il
ripiego quando il tipo non si deduce).

**Filtri delle uscite.** Ogni uscita valuta il suo filtro in modo indipendente (una riga
può andare su più uscite); vuoto = tutte le righe. Il filtro legge ingressi e
trasformazioni, non i campi calcolati dell'uscita stessa.

I vecchi campi `status.*` degli ingressi (mai prodotti dal motore) sono tolti
all'apertura del progetto.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
