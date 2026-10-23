<!-- gen-node-docs: BLOCCO AUTO — rigenerato da `npm run docs:nodes`. Non modificare a mano. -->

# Dir Watcher  `dir_watcher`

**Categoria:** Input  ·  **Icona:** `📁`  ·  **Colore:** `#22d3ee`

Osserva una directory per nuovi file (watch) o ne enumera il contenuto (scan).

## Configurazione

_Nessun campo di configurazione._

## Semantica

- **Operazioni logiche:** `scan`
- **Esecuzione:** a flusso (`stream`)
- **Più output con schema diverso:** no
- **Più ingressi:** no
- **Runtime preferiti:** `typescript`
- **Pushdown alla sorgente:** nessuno

**Porte di ingresso (statiche):**

- `input` · ruolo data · archi: 1 · righe: 1

**Porte di uscita (statiche):**

- `output` · ruolo data
- `reject` · ruolo reject

<!-- gen-node-docs: FINE BLOCCO AUTO — sotto questa riga scrivi liberamente: viene preservato. -->

## Approfondimento

Emette una riga per file: *Scan* elenca i file presenti; *Watch* ascolta gli eventi
del sistema operativo (nuovo, modificato, rinominato, cancellato) su una cartella
**locale** (sulle cartelle di rete montate gli eventi spesso non arrivano).

**Cartella.** Percorso fisso, variabile di lane o campo della riga in ingresso. In
ascolto continuo il campo della riga non si può usare: non c'è una riga prima della
prima sessione.

**Watch: una volta o continuo.** *Once*: aspetta il primo gruppo di eventi (entro il
timeout), lo emette e finisce. *Continuous*: resta in ascolto fino a Stop; a ogni
gruppo di eventi (eventi più vicini del *Debounce* formano un gruppo) la lane riparte
da capo, con il suo commit, e il log mostra "Sessione N".

**Stabilità (P363).** In Watch un file si emette quando dimensione e data restano
uguali per *File stability* ms: non si legge un file che sta ancora arrivando. Dopo 5
minuti di cambiamenti continui lo si emette comunque, con un avviso.

**Deduplicazione (P363).** *By path* (lo stesso percorso non riesce), *Path +
modified date* (riesce se il file è cambiato), *By content* (SHA-256: riconosce anche
copie rinominate). La memoria vale per il run (nel continuo, fra le sessioni) oppure
su file JSON, che persiste fra i run: così uno Scan lanciato ogni giorno elabora solo
i file nuovi. Un file conta come elaborato solo se i nodi a valle hanno finito senza
errori; se la valle fallisce, al giro dopo viene ripreso. Il file di stato (di default
`.flowpilot_dw_state.json` nella cartella osservata) non viene mai emesso.

**Filtri.** Pattern glob sul nome, sottocartelle, dimensione minima, età massima
(dalla data di modifica). In Scan: ordine per nome, creazione, modifica o dimensione,
e limite di file.

Questa sezione è scritta a mano e sopravvive alle rigenerazioni.
