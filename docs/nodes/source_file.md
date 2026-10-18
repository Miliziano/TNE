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

Altre note d'uso, esempi e trabocchetti: _da compilare_.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
