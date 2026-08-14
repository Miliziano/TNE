<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Join  `join`

**Categoria:** Transform  ·  **Icona:** `⋈`  ·  **Colore:** `#ffb347`

Unisce due flussi su un campo chiave.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `join_type` | Tipo join | select | `inner` | `inner`, `left`, `right`, `full` | — |
| `key` | Campo chiave | text | `user_id` | — | — |

## Semantica

- **Operazioni logiche:** `join`
- **Esecuzione:** con stato (`stateful`)
- **Più output con schema diverso:** no
- **Più ingressi:** sì
- **Runtime preferiti:** `python_polars` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input_left` · ruolo data · archi: 1
- `input_right` · ruolo data · archi: 1

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · «non-matched» · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Join**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
