<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# JSON Serializer  `json_serializer`

**Categoria:** Output  ·  **Icona:** `{ }`  ·  **Colore:** `#22d3ee`

Serializza righe del flusso in stringhe JSON con struttura configurabile.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `transform`
- **Esecuzione:** sull'intero dataset (`dataset`)
- **Più output con schema diverso:** no
- **Più ingressi:** sì · **ingressi dinamici** (handle `input_new`)
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data

> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla configurazione a run-time): l'elenco statico qui sopra può essere parziale.

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Raccoglie **tutte** le righe dei flussi in ingresso e costruisce **un** documento JSON
seguendo l'albero disegnato: oggetti, array (una voce per riga del flusso che li guida,
o per gruppo con *group by*) e foglie collegate a un campo. Esce una riga col documento
nel campo indicato (default `content`).

**Espressioni e condizioni (P373).** L'espressione di una foglia (`ƒ expr`) e la sua
condizione (`if`) sono FPEL: i campi nudi si leggono dal flusso della foglia, quelli di
un altro flusso come `flusso.campo`. Condizione falsa → il campo non compare. Trascinando
due campi sulla stessa foglia si crea `a + " " + b`. Fino al P372 erano JavaScript mai
eseguito: l'espressione dava sempre null (anche le foglie con due campi) e la condizione
era sempre vera. Il vecchio `row.campo` vale `campo`; un'espressione JavaScript vera ora
ferma il Run con l'errore, va riscritta in FPEL.

**Tipi delle foglie (P373).** Con *Field types = Applied* il tipo della foglia
(string/number/boolean) si applica: `"41"` su una foglia *number* esce 41; un valore non
convertibile resta com'è e il log lo conta. Acceso sui nodi nuovi; sui nodi salvati
prima resta "Values as they come", come allora.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
