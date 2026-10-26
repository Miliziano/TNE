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

Raccoglie gli errori della lane non gestiti in modo esplicito: nessun arco da disegnare.
Le regole si valutano dall'alto; la prima che corrisponde decide l'azione, il resto esce su
`error_out`.

**Errori gestiti (P367).** Un errore preso sulla porta *catch* di un nodo segue solo quel
percorso: **non** arriva qui in copia. Le opzioni "Lane default policy" e "Centralized
log" sono state tolte: il motore non le leggeva. La policy di ogni nodo (catch, retry,
timeout) sta nella sua scheda Advanced.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
