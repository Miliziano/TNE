<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# DB Source  `source_db`

**Categoria:** Input  ·  **Icona:** `⬡`  ·  **Colore:** `#4a9eff`

Legge righe da una tabella di database.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `schema` | Schema | text | `public` | — | `query` valorizzato |
| `table` | Tabella | text | — | — | `query` valorizzato |
| `limit` | Limite righe | number | `0` | — | `query` valorizzato |
| `orderBy` | Ordina per | text | — | — | `query` valorizzato |
| `query` | Query SQL | code | `SELECT * FROM ` | — | — |

## Semantica

- **Operazioni logiche:** `scan`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `python_polars` → `java_beam`
- **Pushdown alla sorgente:** `filter`, `projection`, `sort`, `limit`

**Porte di ingresso (statiche):**

- `input` · ruolo data · archi: 1 · righe: 1

**Porte di uscita (statiche):**

- `output` · ruolo data

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

**Query timeout (P367).** "Query timeout" è il tempo massimo per la **prima riga**: se il
database non risponde entro quei secondi il nodo fallisce con "query timeout". Dopo la
prima riga le righe scorrono senza limite (lo stream può durare quanto serve). 0 = nessun
limite. Il nodo si ferma subito, ma il database può continuare la query finché non
finisce: per un limite lato server si imposta `statement_timeout` (PostgreSQL) o
`max_statement_time` (MariaDB) sull'utente. Il campo "Fetch size" è stato tolto: il motore
legge già in streaming.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
