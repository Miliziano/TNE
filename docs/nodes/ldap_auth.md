<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# LDAP Auth  `ldap_auth`

**Categoria:** Transform  ·  **Icona:** `⊞`  ·  **Colore:** `#ffb347`

Autentica le credenziali di ogni riga contro LDAP (search-then-bind).

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `transform`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** sì
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · «authenticated» · ruolo data
- `reject` · ruolo reject

> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla configurazione a run-time): l'elenco statico qui sopra può essere parziale.

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

_Da compilare._ Note d'uso, esempi, trabocchetti e buone pratiche per **LDAP Auth**.
Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
