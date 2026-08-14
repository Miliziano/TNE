<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Stop  `stop`

**Categoria:** Transform  ·  **Icona:** `⏹`  ·  **Colore:** `#ff5f57`

Controllo di flusso: ferma deliberatamente la lane (rollback + chiusura connessioni) quando il flusso raggiunge questo nodo. Non è un fallimento. Multi-istanza — tipicamente a valle di un reject o di un handle di un filter.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `trigger` | Innesco | select | `immediate` | `immediate`, `after_input` | — |
| `message` | Messaggio | text | — | — | — |

## Semantica

- **Operazioni logiche:** `transform`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

_Nessuna._

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Stop**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
