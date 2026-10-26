<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# XML Serializer  `xml_serializer`

**Categoria:** Output  ·  **Icona:** `</>`  ·  **Colore:** `#f97316`

Serializza righe del flusso in stringhe XML con struttura e namespace configurabili.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `transform`
- **Esecuzione:** sull'intero dataset (`dataset`)
- **Più output con schema diverso:** no
- **Più ingressi:** sì · **ingressi dinamici** (handle `input_new`)
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data

**Porte di uscita (statiche):**

- `output` · ruolo data

> Alcune porte di questo nodo sono **dinamiche** (calcolate dalla configurazione a run-time): l'elenco statico qui sopra può essere parziale.

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

**Controllo dell'output (P367).** "Check the output" verifica che ogni XML prodotto sia
**ben formato** (tag chiusi nell'ordine giusto, attributi validi, un solo elemento
radice). Non è una validazione su XSD. Un documento sbagliato segue "On error": *stop*
ferma il nodo, *reject* manda la riga sul reject, *empty* scrive il campo vuoto, *skip*
scarta la riga.

**Espressioni e condizioni (P374).** Su foglie, attributi e CDATA l'espressione (`ƒ expr`)
e la condizione (`if`) sono FPEL: campi nudi dal flusso del nodo, `flusso.campo` per un
altro flusso; condizione falsa → il nodo (o l'attributo) non compare. Due campi trascinati
sullo stesso nodo creano `a + " " + b`. Fino al P373 erano JavaScript mai eseguito
(foglie vuote, attributi col solo campo, condizione sempre vera).

**Correzioni (P374).** In un elemento ripetuto (iterazione senza *group by*) gli
attributi prendono il valore della riga corrente: prima avevano tutti quello della prima
riga. Un CDATA che contiene `]]>` viene spezzato in due sezioni (prima rompeva l'XML). Le
vecchie conversioni `to_int`/`to_float` con un valore non numerico lasciano il valore
com'è invece di scrivere `NaN`.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
