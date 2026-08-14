<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Union  `union`

**Categoria:** Transform  ·  **Icona:** `⊕`  ·  **Colore:** `#a78bfa`

Fonde N flussi in uno — modalità concat, interleave o zip.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `union`
- **Esecuzione:** a flusso (`stream`)
- **Più output con schema diverso:** no
- **Più ingressi:** sì · **ingressi dinamici** (handle `input_new`)
- **Runtime preferiti:** `python_polars` → `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input_main` · «flusso 1» · ruolo data · archi: 1

**Porte di uscita (statiche):**

- `output` · ruolo data

> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla configurazione a run-time): l'elenco statico qui sopra può essere parziale.

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Union**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
