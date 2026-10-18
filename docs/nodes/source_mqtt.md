<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# MQTT  `source_mqtt`

**Categoria:** Input  ·  **Icona:** `⊙`  ·  **Colore:** `#84cc16`

Subscriber MQTT — riceve messaggi da broker MQTT/MQTTS.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `scan`
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

**TLS (P337).** Con **TLS** attivo nella risorsa il nodo si collega su TLS vero
(native-tls) e verifica il certificato del broker con i certificati di sistema; di
solito la porta è **8883**. Se il broker non parla TLS su quella porta, o il certificato
non è fidato, la connessione **fallisce** (non ripiega in chiaro). Fino al P336 l'opzione
veniva ignorata e la connessione era sempre in chiaro.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
