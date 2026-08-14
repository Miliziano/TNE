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

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Bridge In**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
