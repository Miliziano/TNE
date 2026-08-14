<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Kafka  `sink_kafka`

**Categoria:** Output  ·  **Icona:** `≋`  ·  **Colore:** `#3ddc84`

Pubblica righe su un topic Kafka.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `topic` | Topic | text | `pipeline-out` | — | — |
| `key_field` | Campo chiave | text | `id` | — | — |
| `valueFormat` | Formato | select | `json` | `json`, `avro`, `protobuf`, `string` | — |
| `acks` | Acks | select | `all` | `0`, `1`, `all` | — |

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
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Kafka**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
