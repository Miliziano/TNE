<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Explode  `explode`

**Categoria:** Transform  ·  **Icona:** `⊕`  ·  **Colore:** `#a78bfa`

Trasforma strutture dense (Materialize, variabili lane, campi object) in un flusso di righe.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `scan`
- **Esecuzione:** sull'intero dataset (`dataset`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · «rows» · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Da uno a molti: un dataset o un campo collettivo diventa un flusso di righe.

**Sorgenti.**

- *From Materialize* — legge il dataset pubblicato da un Materialize della
  lane e lo emette riga per riga. L'ingresso, se collegato, fa solo da
  segnale di partenza.
- *From flow field* — per ogni riga in ingresso esplode un campo array o
  oggetto (anche una stringa che contiene JSON). Con *Propagate parent
  fields* ogni riga figlia porta anche i campi del padre, meno quello
  esploso; a parità di nome vince il campo dell'elemento.

**Mapping (tab Mapping, P360).** Se c'è, ogni riga esplosa esce con SOLO i
campi spuntati, col nome logico, la trasformazione del testo (trim, UPPER,
lower, empty→null) e il tipo scelto. Un valore che non si può convertire al
tipo (es. `"tre"` come integer) resta com'è e a fine esecuzione compare un
avviso per campo nel log del nodo. I campi del padre non passano dal
mapping: si aggiungono così come sono. Senza mapping escono tutti i campi
dell'elemento, senza conversioni. Lo schema d'uscita mostrato dallo studio
segue la stessa regola (`src/nodes/types/explode/schema.ts`).

Con la sorgente Materialize, la prima apertura della tab Mapping propone
tutti i campi del dataset: da quel momento escono solo i campi elencati.

**Struttura vuota o nulla** (*On empty structure*): *Skip* manda la riga
padre sull'uscita `reject`; *Emit one row* emette una riga con i campi del
mapping a null (più quelli del padre, se propagati); *Error* ferma il flusso.

**Non fa, per scelta:** navigare strutture annidate (usa un JSON Parser a
monte) né calcoli sui valori (usa Transform o TMap).
