<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# File Output  `sink_file`

**Categoria:** Output  ·  **Icona:** `▤`  ·  **Colore:** `#3ddc84`

Scrive righe su file.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `path` | Percorso | text | `/data/output.csv` | — | — |
| `format` | Formato | select | `csv` | `csv`, `json`, `jsonl`, `parquet`, `tsv`, `xml`, `excel` | — |
| `mode` | Modalità | select | `overwrite` | `overwrite`, `append`, `new`, `error` | — |
| `partition` | Partizione | select | `none` | `none`, `field`, `date`, `size` | — |
| `processingMode` | Elaborazione | select | `streaming` | `streaming`, `batch` | — |
| `passthrough` | Pass-through | text | `false` | — | — |

## Semantica

- **Operazioni logiche:** `sink`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `python_polars`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **File Output**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
