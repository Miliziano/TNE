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

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **TMap**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
