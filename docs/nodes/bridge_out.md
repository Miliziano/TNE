<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Bridge Out  `bridge_out`

**Categoria:** Output  ·  **Icona:** `→`  ·  **Colore:** `#a78bfa`

Porta di uscita dal flusso della lane — pubblica sul canale bridge.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `channelName` | Nome canale | text | — | — | — |
| `channelColor` | Colore | text | `#a78bfa` | — | — |
| `syncMode` | Sincronismo | text | `fire_and_forget` | — | — |
| `transferMode` | Trasferimento | text | `content` | — | — |
| `batchSize` | Batch size | number | `100` | — | — |
| `bufferSize` | Buffer size | number | `0` | — | — |
| `outputMode` | Output mode | text | `none` | — | — |

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

_Nessuna._

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Bridge Out**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
