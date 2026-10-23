<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Join  `join`

**Categoria:** Transform  ·  **Icona:** `⋈`  ·  **Colore:** `#ffb347`

Unisce due flussi su un campo chiave.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `join_type` | Tipo join | select | `inner` | `inner`, `left`, `right`, `full` | — |
| `key` | Campo chiave | text | `user_id` | — | — |

## Semantica

- **Operazioni logiche:** `join`
- **Esecuzione:** con stato (`stateful`)
- **Più output con schema diverso:** no
- **Più ingressi:** sì
- **Runtime preferiti:** `python_polars` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input_left` · ruolo data · archi: 1
- `input_right` · ruolo data · archi: 1

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · «non-matched» · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Unisce il flusso sinistro (in streaming) a un lato destro tenuto in memoria come
tabella per chiave (hash join).

**Lato destro.** Il flusso collegato all'ingresso destro, oppure il dataset di un
Materialize della lane (P365): in quel caso un arco sull'ingresso destro fa solo da
innesco. La "query inline" non è supportata: si mette un DB Source sull'ingresso destro.

**Tipi.** INNER, LEFT, RIGHT, FULL, CROSS (prodotto cartesiano), ANTI (righe sinistre
senza corrispondenza), SEMI (righe sinistre con corrispondenza, solo i loro campi) e
CUSTOM. Con INNER, SEMI e CUSTOM le righe sinistre senza corrispondenza escono sul
*reject*.

**CUSTOM (P365).** Una condizione FPEL qualsiasi su `left.campo` e `right.campo`, per
esempio `left.price >= right.min_price && left.price <= right.max_price` (join per fasce).
Ogni campo deve dire il suo lato, altrimenti il Run si ferma. Si confronta ogni riga
sinistra con ogni riga destra (n × m): adatto a lati destri piccoli. Attenzione ai tipi:
due stringhe si confrontano come testo ("15" <= "9" è vero), quindi i campi numerici vanno
tipizzati a monte (mapping della sorgente).

**Opzioni.** Chiavi composite, maiuscole/minuscole, prefisso per i campi destri con lo
stesso nome di uno sinistro, corrispondenze multiple (tutte, la prima, l'ultima, errore),
chiavi null (escluse, null = null, errore).

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
