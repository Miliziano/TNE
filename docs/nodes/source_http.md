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

**OAuth2, rinnovo del token (P367).** Al primo 401 il nodo rinnova il token e ripete la
richiesta una volta:

- *Client credentials* con "Auto-refresh" attivo: scarta il token in cache e ne chiede uno
  nuovo al token endpoint;
- *Authorization code* con "Refresh token" e token URL compilati: chiede un nuovo access
  token con `grant_type=refresh_token`; il nuovo token resta in memoria per le richieste
  successive dello stesso processo.

Se anche la seconda risposta è 401, o il rinnovo non è possibile, vale la gestione normale
degli errori HTTP del nodo.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
