<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# JSON Parser  `json_parser`

**Categoria:** Transform  ·  **Icona:** `{ }`  ·  **Colore:** `#22d3ee`

Estrae e trasforma dati JSON in flussi strutturati.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `parse`, `projection`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** sì
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `python_polars`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

_Nessuna._

> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla configurazione a run-time): l'elenco statico qui sopra può essere parziale.

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Legge un campo JSON (testo o oggetto già strutturato) e produce un'uscita per ogni
**flusso**: ogni flusso ha un JSONPath (es. `$.righe`) e i suoi campi. Con *Array* attivo
esce una riga per elemento, altrimenti solo il primo elemento. I campi si risolvono prima
rispetto all'elemento, poi sul documento intero (così un flusso di righe può prendere
anche `$.cliente` della testata).

**Tipi (P369).** Il tipo di ogni campo si applica: `"12"` su un campo *integer* esce
come 12, un numero su un campo *string* esce come testo. Un valore non convertibile resta
com'è e il log dice quanti per campo. Le trasformazioni sono solo di testo (trim, UPPER,
lower, empty→null); le vecchie conversioni `→ integer`… sono diventate il tipo del campo
al caricamento del progetto. Gli array foglia sono di tipo *object*.

**Campo mancante.** *null*; *Default* (il valore scritto sotto, convertito al tipo del
campo); *Skip row* (nessuna riga per quell'elemento); *Reject* (l'elemento va sul reject
con `_reject_reason = missing_required_field`).

**JSON non leggibile.** Con *Reject* attivo la riga va sul reject (`invalid_json` o
`source_field_missing`); senza, viene scartata e il log dice quante.

Tolte nel P369 le opzioni *Stream* e il filtro per flusso: il motore non le applicava.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
