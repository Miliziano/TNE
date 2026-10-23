<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Union  `union`

**Categoria:** Transform  ·  **Icona:** `⊕`  ·  **Colore:** `#a78bfa`

Fonde N flussi in uno — modalità concat, interleave o zip.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `union`
- **Esecuzione:** a flusso (`stream`)
- **Più output con schema diverso:** no
- **Più ingressi:** sì · **ingressi dinamici** (handle `input_new`)
- **Runtime preferiti:** `python_polars` → `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input_main` · «flusso 1» · ruolo data · archi: 1

**Porte di uscita (statiche):**

- `output` · ruolo data

> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla configurazione a run-time): l'elenco statico qui sopra può essere parziale.

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Unisce più flussi in uno. Lo schema d'uscita si decide nella tab Mapping: per ogni
campo, da quale campo di ogni flusso viene.

**Modalità.** *Concat*: il primo flusso fino alla fine, poi il secondo, ecc. *Mix*: le
righe nell'ordine in cui arrivano. *Zip*: una riga per flusso fusa in una sola (con
flussi di lunghezza diversa: troncare, riempire di null o errore).

**Campo mancante in un flusso (P366).** Null, campo omesso, oppure errore: con
*Error* il nodo si ferma prima di leggere se un campo d'uscita non viene da tutti i
flussi collegati. *Source field* aggiunge il nome del flusso di provenienza (Concat e
Mix). L'opzione "schema incompatibile" è stata tolta: lo schema lo decide il mapping.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
