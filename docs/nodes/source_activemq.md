<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# ActiveMQ  `source_activemq`

**Categoria:** Input  ·  **Icona:** `⊛`  ·  **Colore:** `#fb923c`

Consumer/Producer ActiveMQ — protocolli STOMP, OpenWire, AMQP.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `scan`
- **Esecuzione:** a flusso (`stream`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data · archi: 1 · righe: 1

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

**Solo STOMP (P367).** Il motore parla STOMP (porta 61613, accettato da ActiveMQ Classic e
Artemis). Un nodo salvato con OpenWire o AMQP si ferma con un errore chiaro invece di
provare comunque STOMP.

**Opzioni del consumer.** *Prefetch* vuoto = default del broker; un numero va nell'header
`activemq.prefetchSize`. *Receive timeout* 0 = attesa senza limite, *Max messages* 0 =
senza limite (prima 0 faceva finire subito la lettura). *Durable subscription* vale per i
topic: il nodo si iscrive col nome stabile `flowpilot-<id del nodo>` (anche come
`client-id`) e il broker tiene i messaggi arrivati mentre il flow è fermo.

**Connessione (P367).** Il CONNECTED del broker si aspetta al massimo 10 s; un rifiuto
(frame ERROR, per esempio un virtual host sconosciuto) dà l'errore col messaggio del
broker. I frame si leggono fino al NUL che li chiude: prima un broker che non manda un
a-capo dopo il NUL (Artemis) lasciava il nodo in attesa per sempre. Se il broker chiude
la connessione a metà lettura i messaggi già ricevuti vengono consegnati.

Per riprovare una connessione fallita si usa il Retry della scheda Advanced.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
