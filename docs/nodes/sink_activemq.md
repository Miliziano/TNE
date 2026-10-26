<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# ActiveMQ Sink  `sink_activemq`

**Categoria:** Output  ·  **Icona:** `⊛`  ·  **Colore:** `#fb923c`

Producer ActiveMQ — pubblica messaggi su queue o topic.

## Configurazione

_Nessun campo di configurazione._

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

- `output` · ruolo data

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

**Solo STOMP (P367).** Come il consumer: OpenWire e AMQP danno errore. Ogni riga è un
SEND con `receipt`; un frame ERROR del broker diventa l'errore di quella riga. La
connessione, l'attesa del CONNECTED (massimo 10 s) e la lettura dei frame sono quelle del
consumer (vedi ActiveMQ).

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
