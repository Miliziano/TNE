<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# XML Parser  `xml_parser`

**Categoria:** Transform  ·  **Icona:** `</>`  ·  **Colore:** `#f97316`

Estrae e trasforma dati XML in flussi strutturati.

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `parse`, `projection`
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

Legge un campo XML e produce un'uscita per ogni **flusso** (un XPath base). Con
*Repeating* esce una riga per ogni elemento trovato, altrimenti solo per il primo. I campi
si risolvono rispetto all'elemento (`qty`, `@id`, `text()`), oppure con un XPath assoluto:
se non sta sotto il flusso si prende l'antenato dell'elemento (master-detail implicito).
La navigazione è per nome di tag, non XPath completo.

**Tipi (P372).** Con *Apply field types* acceso il tipo di ogni campo si applica:
`<qty>12</qty>` su un campo *integer* esce 12; un valore non convertibile resta testo e il
log dice quanti per campo; anche il valore di *Default* prende il tipo. L'opzione è accesa
sui nodi nuovi; sui nodi salvati prima è spenta (tutto testo, come allora) e la colonna
mostra "Type (off)". Analizzando un esempio un numero con zeri davanti (`007`) resta
*string*.

**Attributi.** Il bottone `@` mette o toglie la `@` nell'ultimo passo dell'XPath: è l'XPath
che il motore legge.

**XML non leggibile.** Con *Reject* attivo la riga va sul reject (`invalid_xml` o
`source_field_missing`); senza, viene scartata e il log dice quante.

Tolta nel P372 l'opzione *Stream*: il motore non la applicava.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
