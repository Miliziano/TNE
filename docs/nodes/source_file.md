<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# File Input  `source_file`

**Categoria:** Input  ·  **Icona:** `▤`  ·  **Colore:** `#4a9eff`

Legge record da un file locale.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `scan`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data · archi: 1 · righe: 1

**Porte di uscita (statiche):**

- `output` · ruolo data

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

### Excel e OpenDocument (dal P342)

Il formato **excel** è letto dal **motore** (crate `calamine`), sia nel run sia
nell'anteprima dello studio: un solo lettore, lo stesso risultato. Estensioni
accettate: `xlsx`, `xlsm`, `xlsb`, `xls`, `ods`. (Prima del P342 il formato era
offerto dal pannello ma il motore non lo sapeva leggere; l'anteprima usava SheetJS
nel browser, ora rimosso.)

| Chiave | Default | Significato |
|---|---|---|
| `sheetName` | vuoto | Foglio da leggere; vuoto = il **primo**. Un nome inesistente dà errore con l'elenco dei fogli presenti |
| `startRow` | `1` | Riga da cui partire (1 = prima riga del foglio) |
| `hasHeader` | `true` | La prima riga letta dà i **nomi** delle colonne; celle d'intestazione vuote → `col_<n>` |

Conversione delle celle:
- **con un tipo dichiarato nel mapping** vale la stessa regola del CSV: la cella
  viene letta come testo e convertita a quel tipo;
- **senza tipo** si tiene il tipo naturale della cella: Excel salva ogni numero come
  virgola mobile, quindi un numero intero (entro 2^53) torna **intero**; una data a
  mezzanotte diventa **data**, altrimenti **data-ora**; celle vuote o in errore → NULL.
- Le righe completamente vuote vengono saltate.

> ⚠ Il foglio viene letto **tutto in memoria** prima di emettere le righe (il
> formato xlsx è un archivio compresso, non si legge a flusso come un CSV). Per file
> molto grandi conviene esportare in CSV.

### Da dove viene il file (P357)
- **Static**: il percorso, oppure un **glob** (`/data/in/*.csv`, `*` e `?` solo nel nome
  del file): tutti i file che corrispondono, in ordine di nome, uno dopo l'altro.
  "Row limit" vale sul totale.
- **Lane variable**: il valore di una variabile di lane.
- **From flow**: il campo della riga in ingresso. L'ingresso deve portare **una** riga
  (regola delle sorgenti); per più file si usa il glob.

### CSV e TSV
Delimitatore, carattere di quote (le quote raddoppiate funzionano sempre), escape
(dentro le quote, davanti a una quote o a sé stesso), commento (righe che iniziano con
quel carattere), intestazione sì/no, righe iniziali da saltare. Un campo tra quote può
andare a capo. Il BOM UTF-8 all'inizio del file viene tolto. Encoding: UTF-8, UTF-16,
ISO-8859-1, Windows-1252, ASCII — un file non UTF-8 letto come UTF-8 dà un errore che
dice la riga.

### Il mapping
Nella scheda Mapping ogni campo ha un **nome** (quello che esce), la **colonna** del file
da cui viene, il **tipo** e una trasformazione del testo (maiuscolo/minuscolo). Con un
mapping escono solo i campi mappati; senza, tutte le colonne come testo. Un valore che
non si converte al tipo diventa NULL (meglio un null visibile che uno zero).

### Gli altri formati
- **JSON**: il valore al "JSON path" (`$`, `$.data.items`, `$.data[0].rows`) in una riga,
  oppure — con Structure = Array — una riga per elemento. Campi `content` (oggetto) e
  `raw` (il testo JSON), per il JSON Parser.
- **JSON Lines**: una riga per riga del file, stessi campi; una riga non valida dà errore
  col suo numero.
- **XML**: il documento intero in `content`, per l'XML Parser.
- **Text**: una riga per linea, `line` e `line_number`.
- **Binary / PDF (binary)**: il file in `data`, Base64 o esadecimale, con `mime_type`.

Non disponibili (tolti dal pannello nel P357): Parquet, ORC, Avro, estrazione del testo
dai PDF.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
