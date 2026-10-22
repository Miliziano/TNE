<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Filter  `filter`

**Categoria:** Transform  ·  **Icona:** `⊻`  ·  **Colore:** `#ffb347`

Smista le righe su N uscite in base a condizioni — first-match.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `branch`
- **Esecuzione:** riga-per-riga (`row`)
- **Più output con schema diverso:** sì
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `python_polars`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

_Nessuna._

> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla configurazione a run-time): l'elenco statico qui sopra può essere parziale.

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

**Routing first-match.** Le condizioni si valutano in ordine di priorità
(`#1`, `#2`, …): ogni riga esce sul primo ramo la cui condizione è vera; se
nessuna lo è, su `reject`. Senza condizioni tutto va a `reject`.

**Tre modi di scrivere una condizione.**
- *Visual* — clausole campo/operatore/valore unite da AND/OR, valutate da
  sinistra a destra (`a OR b AND c` = `(a OR b) AND c`).
- *Template* — 17 casi pronti (date, numeri, testo, null).
- *Code* — un'espressione **FPEL** booleana, es.
  `importo > 100 && lower(paese) == "it"`. Validata dal vivo nel pannello e
  compilata al Run (un errore blocca il Run). Le altre due modalità mostrano
  il loro **FPEL equivalente**, che diventa il punto di partenza quando si
  passa a *Code*.

**Opzioni globali.**
- *Null behavior* (solo visual): `exclude` (clausola falsa), `include`
  (il null vale stringa vuota), `error` (condizione in errore → falsa, con
  avviso).
- *Case sensitive*: vale per i confronti di testo di visual e template
  (anche la regex). Non per *Code*: lì si usa `lower()`/`upper()`.
- *Branch execution mode*: `All in parallel` (default) oppure `Ordered with
  wait` — il ramo #1 scorre subito, gli altri sono trattenuti in memoria e
  il ramo #N parte solo quando tutto ciò che sta a valle del ramo #N-1 ha
  finito. Caso tipico: righe master prima delle righe di dettaglio, per le
  chiavi esterne. Se quella parte fallisce i rami successivi non partono.

**Trabocchetti.**
- In *Ordered with wait* un nodo raggiunto da due rami (o anche da
  `reject`) non si può aspettare: l'ordine non è garantito per quel nodo
  (avviso in validazione). Dai a ogni ramo i suoi nodi.
- Con i sink in un gruppo transazionale, "finito" vuol dire scritto, non
  committato: master e dettagli nella **stessa** transazione funzionano
  (stessa connessione); master in transazione e dettagli fuori no.
- Le condizioni *Code* scritte prima del P354 in JavaScript/Python non
  sono mai state eseguite: il pannello le segnala, vanno riscritte in FPEL.
