<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Error Handler  `error_handler`

**Categoria:** Transform  ·  **Icona:** `⚠`  ·  **Colore:** `#ff5f57`

Collettore centrale degli errori della lane — sempre attivo, non eliminabile. Riceve automaticamente ogni errore non gestito da catch/reject (e in copia quelli gestiti, se "Log centralizzato" è attivo).

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `transform`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `catch` · ruolo catch

**Porte di uscita (statiche):**

- `error_out` · «error» · ruolo data

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **Error Handler**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
