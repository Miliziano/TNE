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

Scrive le righe su un file locale (o su una cartella di rete montata). Dal P361
ogni opzione del pannello è applicata dal motore.

**Formati.** Righe: CSV, TSV, Excel (.xlsx), JSON (array o un oggetto per riga),
JSON Lines, XML (`<records><record>…`). Valore di un campo, una riga alla volta:
HTML e testo (scritti come testo), Excel da base64 e binario (base64 decodificato:
PDF, immagini…). Parquet, ORC, Avro e PDF non si scrivono: il nodo si ferma con
un errore che lo dice.

**Percorso.** Variabili `${date}` (2026-01-15), `${datetime}` (2026-01-15_14-30-00),
`${uuid}`, `${seq}` (il primo numero per cui il file non esiste ancora) e
`${partition}`. Le cartelle mancanti si creano.

**Modalità di scrittura.** *Overwrite* sovrascrive; *Append* aggiunge in fondo
(non può estendere un array JSON, un XML o un Excel: errore); *New file* usa un
nome libero (`out_1.csv`, `out_2.csv`…) se il file esiste; *Error* si ferma se
esiste. Con *Write header = Auto* l'intestazione si scrive solo se il file è
nuovo o vuoto: utile con Append.

**Colonne (tab Mapping).** Se scelte, si scrivono solo i campi spuntati,
nell'ordine della lista, col nome, il tipo e la trasformazione indicati (le
stesse regole del File Input e dell'Explode, `engine/field_mapping.rs`). Un
valore che non si converte resta com'è, con un avviso per campo. Senza colonne
si scrivono tutti i campi, in ordine alfabetico. Le colonne non cambiano ciò
che il nodo emette a valle.

**Codifica.** UTF-8, UTF-16 (little endian, con BOM), ISO-8859-1,
Windows-1252, ASCII. I caratteri non rappresentabili diventano `?` e il log
dice quanti sono.

**Partizioni.** Un file per partizione: per valore di un campo, per data
(anno, mese, giorno, ora, da un campo data/ora; le righe senza una data
leggibile vanno nella partizione `_unknown`) o per dimensione massima in MB
(file numerati 1, 2, 3…; non per Excel). La chiave sostituisce `${partition}`
nel percorso, che può stare anche in una cartella (`/out/${partition}/dati.csv`);
senza, va prima dell'estensione (`dati_EU.csv`). Al massimo 1000 partizioni
aperte insieme.

**Uscita.** *Signal*: una riga di stato per file scritto (`status` "ok",
`rows_written`, `bytes_written`, `file_path`, `completed_at`, `error_message`,
`duration_ms`). *Replay*: le righe in ingresso, invariate, dopo la scrittura
completa (restano in memoria fino ad allora).

**Dopo la scrittura.** Il comando di shell gira per ogni file chiuso, con
`${file}` e la variabile d'ambiente `FP_FILE` = il percorso; un'uscita diversa
da 0 ferma il nodo. Il webhook riceve un POST JSON con i file e le righe; se
non risponde, il nodo registra solo un avviso: i file sono già scritti.
