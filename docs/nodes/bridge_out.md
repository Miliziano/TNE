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

**Cosa fa (P358).** Prende il flusso della lane e lo pubblica sul canale; il Bridge In
con lo stesso nome, in un'altra lane, lo riceve. Se l'altra lane è più lenta, questa
aspetta (contropressione): nessun buffer da configurare.
- *Output to current lane*: nessuna uscita (default), **Passthrough** (le stesse righe
  anche ai nodi successivi di questa lane) o **Signal** (una riga `channel`, `rows_sent`,
  `status`, `sent_at` a consegna fatta).
- *Sync*: **Fire & Forget** (il nodo finisce quando ha consegnato tutto al canale) o
  **Wait for ack** (finisce solo quando l'altra lane ha ricevuto tutto: lo status diventa
  `delivered`; se l'altra lane si ferma prima, il nodo fallisce).
- Un fallimento in questa lane arriva all'altra solo se il nodo che fallisce è
  "critical": altrimenti la consegna si chiude normalmente.

Tolti nel P358 (il motore non li faceva): modalità di trasferimento content/stream e
dimensione dei batch (il canale è in memoria, riga per riga), gate, dimensione e
comportamento del buffer.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
