<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Window  `window`

**Categoria:** Transform  ·  **Icona:** `W`  ·  **Colore:** `#a78bfa`

Calcola window functions (ROW_NUMBER, RANK, LAG, LEAD, CUMSUM, MOVING_AVG...).

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `window`
- **Esecuzione:** sull'intero dataset (`dataset`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `python_polars` → `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Window**.
**Ordinamento (P398).** Dentro ogni partizione le righe si ordinano per uno o più campi,
ognuno con la sua direzione (`data ASC, id DESC`): è l'ordine in cui lavorano row_number, lag,
lead, cumsum e le altre funzioni. Senza ordinamento le righe restano nell'ordine d'arrivo.
Un campo che non c'è nelle righe si segnala nel log e non conta.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
