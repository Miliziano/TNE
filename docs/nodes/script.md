<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Script  `script`

**Categoria:** Transform  ·  **Icona:** `λ`  ·  **Colore:** `#a78bfa`

Trasforma, filtra o scarta ogni riga con istruzioni ed espressioni.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `sourceMode` | Sorgente delle righe | select | `flusso` | `flusso`, `genera` | — |
| `code` | Istruzioni | code | `// I campi si usano per nome; "let" per i valori intermedi. // Istruzioni: let, assegnazione, if/else, skip, reject, log, error. ` | — | — |

## Semantica

- **Operazioni logiche:** `transform`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data · _condizionata_

**Porte di uscita (statiche):**

- `output` · ruolo data · _condizionata_
- `output` · «innesco» · ruolo signal · _condizionata_
- `reject` · ruolo reject · _condizionata_

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Script**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
