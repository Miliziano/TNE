<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Aggregate  `aggregate`

**Categoria:** Transform  ·  **Icona:** `Σ`  ·  **Colore:** `#ffb347`

Raggruppa le righe e calcola funzioni aggregate.

## Configurazione

| Chiave | Etichetta | Tipo | Default | Opzioni | Inerte quando |
|---|---|---|---|---|---|
| `group_by` | Raggruppa per | text | `region` | — | — |
| `functions` | Funzioni | code | `{"count": "*", "sum": "amount"}` | — | — |

## Semantica

- **Operazioni logiche:** `aggregate`
- **Esecuzione:** sull'intero dataset (`dataset`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `python_polars` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Aggregate**.
**Ordinamento (P398).** "Order by" ordina il RISULTATO: si usano i campi di raggruppamento
e i nomi delle funzioni (l'alias, o `<funzione>_<campo>`: `sum_importo`, `count_all` per
count(*)). Più campi, ognuno con la sua direzione: `conteggio DESC, regione ASC` (a parità del
primo decide il secondo). Un campo che non c'è nel risultato si segnala nel log e non conta.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
