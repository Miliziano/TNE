<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# HTTP Source  `source_http`

**Categoria:** Input  ·  **Icona:** `⇄`  ·  **Colore:** `#4a9eff`

Recupera dati da un endpoint HTTP.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `url` | URL | text | `https://jsonplaceholder.typicode.com/users` | — | — |
| `method` | Metodo | select | `GET` | `GET`, `POST`, `PUT`, `PATCH`, `DELETE` | — |
| `responseType` | Tipo risposta | select | `json` | `json`, `text`, `xml`, `binary`, `pdf`, `csv` | — |
| `authType` | Auth | select | `none` | `none`, `basic`, `bearer`, `api_key`, `digest`, `oauth2_cc`, `oauth2_ac` | — |
| `customFields` | Campi JSON | text | `[]` | — | — |

## Semantica

- **Operazioni logiche:** `scan`, `parse`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data · archi: 1 · righe: 1

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **HTTP Source**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
