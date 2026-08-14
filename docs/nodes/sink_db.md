<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# DB Sink  `sink_db`

**Categoria:** Output  ·  **Icona:** `⬡`  ·  **Colore:** `#3ddc84`

Scrive righe in una tabella di database.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `schema` | Schema | text | `public` | — | — |
| `table` | Tabella | text | — | — | — |
| `mode` | Modalità | select | `insert` | `insert`, `upsert`, `update`, `truncate_insert`, `merge` | — |
| `keyFields` | Campi chiave | text | `id` | — | — |
| `batchSize` | Batch size | number | `1000` | — | — |

## Semantica

- **Operazioni logiche:** `sink`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **DB Sink**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
