<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Materialize  `materialize`

**Categoria:** Transform  ·  **Icona:** `◈`  ·  **Colore:** `#22d3ee`

Hashtable in-memory per esecuzione — accessibile da qualsiasi nodo tramite context.materialize().

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `aggregate`
- **Esecuzione:** sull'intero dataset (`dataset`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript` → `java_beam`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Tiene un flusso in memoria. Pubblicato nella lane, lo leggono per nome Explode, Join,
Window, Aggregate, Pivot e Data Quality, senza arco e senza consumarlo.

**Modalità.** *Passthrough*: le righe passano a valle una alla volta mentre vengono
salvate; il dataset è completo a fine ingresso. *Buffer → Signal*: salva tutto,
pubblica il dataset, poi emette una sola riga di stato (`name`, `row_count`, `status`
"done", `completed_at`, `elapsed_ms`, `truncated`) che fa da innesco ai nodi successivi.
Il vecchio "buffer replay" diventa Passthrough all'apertura del progetto (P366).

**Chiave e duplicati (P366).** Con un campo chiave il dataset è indicizzato (Data
Quality lo usa per i lookup). *On repeated key*: tutte le righe (default), solo
l'ultima per chiave, solo la prima, oppure errore. Vale per il dataset salvato; in
Passthrough le righe che passano a valle non cambiano.

**Limite di righe.** Oltre *Row limit*: errore, oppure troncamento (le righe in più
escono sul reject).

Il dataset vive per un'esecuzione della lane (in ascolto continuo: per una sessione).

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
