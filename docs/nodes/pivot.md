<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Pivot / Unpivot  `pivot`

**Categoria:** Transform  ·  **Icona:** `⊞`  ·  **Colore:** `#f97316`

Trasforma la struttura della tabella — righe in colonne (Pivot) o colonne in righe (Unpivot).

## Configurazione

_Nessun campo di configurazione._

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

**Pivot dinamico (P367).** Le colonne sono i valori distinti (non null) del campo pivot,
raccolti dai dati stessi e ordinati secondo "Pivot columns order". Non serve un secondo
Materialize: il campo "Distinct values Materialize" è stato tolto perché il motore non lo
usava.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
