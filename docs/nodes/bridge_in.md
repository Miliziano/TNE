<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Bridge In  `bridge_in`

**Categoria:** Input  ·  **Icona:** `←`  ·  **Colore:** `#a78bfa`

Porta di ingresso da un'altra lane — riceve dal canale bridge.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `channelName` | Nome canale | text | — | — | — |
| `channelColor` | Colore | text | `#a78bfa` | — | — |
| `syncMode` | Sincronismo | text | `fire_and_forget` | — | — |
| `timeoutSec` | Timeout (sec) | number | `30` | — | — |

## Semantica

- **Operazioni logiche:** `scan`
- **Esecuzione:** a flusso (`stream`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

_Nessuna._

**Porte di uscita (statiche):**

- `output` · ruolo data

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

**Cosa fa (P358).** Riceve le righe che il Bridge Out con lo stesso nome pubblica, e le
passa ai nodi successivi di questa lane.
- *Delivery*: **As it arrives** (default: le righe passano appena arrivano; se la lane
  sorgente si interrompe a metà, quelle già passate restano e il nodo fallisce) o **All at
  once** (le righe si tengono in memoria finché il flusso è completo e confermato, poi
  passano tutte; se la lane sorgente si interrompe, non passa niente — niente dati a metà).
- *Wait timeout*: attesa massima della prima riga (o della fine di un flusso vuoto);
  `0` = nessun limite. Scaduto, il nodo fallisce.
- Chiavi `delivery` e `waitTimeoutSec`: le vecchie `syncMode`/`timeoutSec` avevano default
  salvati in ogni nodo (30 s) mai applicati, e non vengono lette (salvo `syncMode = gate`,
  che vale "All at once").
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
