<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# MQTT Sink  `sink_mqtt`

**Categoria:** Output  ·  **Icona:** `⊙`  ·  **Colore:** `#84cc16`

Publisher MQTT — pubblica messaggi su topic.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `sink`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

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
