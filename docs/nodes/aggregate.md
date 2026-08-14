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
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
