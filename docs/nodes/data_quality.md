<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Data Quality  `data_quality`

**Categoria:** Transform  ·  **Icona:** `✓`  ·  **Colore:** `#3ddc84`

Valida ogni riga contro regole configurabili — output valid e reject.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `transform`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `python_polars`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Valuta le regole su ogni riga, ripara dove una regola lo prevede e aggiunge un campo
(default `_dq`). **Non filtra**: escono tutte le righe; per separarle si mette un Filter a
valle su `_dq.valid`, `_dq.level` o `_dq.score`.

**Il campo `_dq`.** `score` (0–1), `valid` (score ≥ soglia "valid"), `level` (`error` se
una regola *error* non è stata riparata o lo score è sotto la soglia "warning", `warn` se è
sotto la soglia "valid", altrimenti `ok`), `repaired`, `dimensions` (solo quelle con almeno
una regola), `issues` (rule, field, dimension, severity, message, repaired e, se riparata,
action, original, new_value). Con le opzioni: `score_original` (score prima delle
riparazioni) e `original_row` (la riga com'era arrivata). Da P368 lo studio mostra `_dq`
nello schema a valle.

**Score.** Per dimensione: regole passate / regole della dimensione (una regola riparata
conta come passata). Lo score è la media pesata delle sole dimensioni con regole. Anche una
regola *warn* abbassa lo score; *error* in più porta `level` a `error` se non riparata.

**Null.** Un valore null (o un campo assente) fa fallire `not_null` e `not_empty`; i
confronti (*Compare fields*, *FPEL expression*) dipendono dai valori; gli altri check lo
lasciano passare.

**Lookup in Materialize (P368).** "Key field" è il campo di questa riga con la chiave;
il dataset si cerca per la sua chiave (keyField del Materialize) o, senza chiave, nella
colonna con lo stesso nome. "Value column" è la colonna copiata nel campo. Fino al P367 i
due valori non arrivavano al motore e il lookup non riparava mai. Il lookup da file non è
supportato: si carica il file con File Source → Materialize.

**Espressioni.** Il check *FPEL expression* e la riparazione *FPEL expression* usano FPEL
coi nomi dei campi (`age >= 18`), non JavaScript.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
