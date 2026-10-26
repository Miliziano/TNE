<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Webhook Receiver  `webhook_receiver`

**Categoria:** Input  ·  **Icona:** `⤵`  ·  **Colore:** `#3ddc84`

Riceve webhook — server condiviso con HMAC, buffer e dedup.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `scan`, `parse`
- **Esecuzione:** a flusso (`stream`)
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

**Coda piena (P367).** Con "Buffer overflow policy" = *Refuse* il server risponde **503**
`{"status":"queue_full"}` con `Retry-After: 5`, così il mittente sa di dover riprovare
(prima l'evento veniva scartato rispondendo comunque 200). *Drop the incoming one* scarta
l'evento nuovo, *Drop the oldest* fa posto togliendo il più vecchio.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
