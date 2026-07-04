# FlowPilot — Contratto dello stream di monitoraggio (NDJSON)

Questo documento definisce il formato con cui FlowPilot registra su disco
gli eventi di un run. È un **contratto**: chiunque produca questi file
(oggi il motore Rust; domani artifact headless in Rust, Java o Python) e
chiunque li legga (la finestra Monitor, strumenti offline, replay) deve
rispettarlo.

Il file è scritto dal writer `src-tauri/src/engine/reporter.rs`.

---

## 1. Principi

**Un file per run.** Ogni esecuzione produce un file indipendente,
`<run_id>.ndjson`, nella cartella dei run (default `~/.flowpilot/runs/`,
override con la variabile d'ambiente `FLOWPILOT_RUNS_DIR`). Non si
mescolano run diversi nello stesso file.

**NDJSON.** Newline-Delimited JSON: una riga = un oggetto JSON = un
evento. Nessuna virgola tra righe, nessun array che racchiude il tutto.
Questo rende il file scrivibile in append in streaming e leggibile riga
per riga (`tail -f`, lettura parziale) senza dover caricare o chiudere
una struttura complessiva.

**Indipendente dalla GUI.** Il file è la persistenza *primaria*: è
completo e fedele anche quando il buffer in memoria del bus wrappa o
quando la UI (WebKit) legge in ritardo. Un artifact headless che non ha
alcuna GUI produce esattamente lo stesso formato.

**Core + estensioni.** Non tutti gli eventi hanno senso per tutti i
runtime. Il contratto distingue:

- **Core** — eventi e campi che *qualsiasi* emettitore che esegua un
  dataflow sa e deve produrre (ciclo di vita run/nodo, conteggi righe,
  throughput). Sono il minimo indispensabile perché un file sia
  "monitorabile".
- **Estensioni** — eventi e campi legati a una piattaforma o a una
  funzionalità specifica (memoria dettagliata di WebKit, animazione
  edge del canvas, bridge tra lane, telemetria connettori). Un
  emettitore che non ha quel concetto li **omette**; un consumatore che
  li riceve ma non li capisce li **ignora**. Nessuno dei due deve
  rompersi.

---

## 2. Formato di una riga

Ogni riga è un *record*: un involucro che marca versione e istante, e
racchiude l'evento vero e proprio.

```json
{"v":1,"ts":1783195185087,"event":{"type":"RunStarted","payload":{ ... }}}
```

| Campo   | Tipo    | Descrizione                                                        |
|---------|---------|--------------------------------------------------------------------|
| `v`     | intero  | Versione dello schema del record. Attuale: `1`.                    |
| `ts`    | intero  | Istante di emissione, Unix epoch in **millisecondi**.              |
| `event` | oggetto | L'evento, nella forma `{"type": <nome>, "payload": {...}}`.        |

`event` usa il pattern *tag esterno*: `type` è il nome della variante,
`payload` ne contiene i campi. Un consumatore fa dispatch su
`event.type`.

Il campo `v` sta su **ogni** riga (non in un header) di proposito: così
ogni riga è auto-descrittiva anche leggendo il file dal mezzo, e un
domani un consumatore può gestire righe `v:1` e `v:2` nello stesso
stream durante una migrazione.

---

## 3. Versionamento

`v` cambia solo per modifiche **incompatibili** dello schema: rimozione
o rinomina di un campo core, cambio di tipo, cambio di semantica.

Sono considerate **retro-compatibili** e **non** alzano `v`:

- aggiunta di un nuovo tipo di evento (i consumatori ignorano ciò che
  non conoscono);
- aggiunta di un campo **opzionale** a un payload esistente;
- aggiunta di una nuova estensione.

Regola per i consumatori: leggere `v`; se è maggiore della versione
massima supportata, degradare (leggere i campi noti, ignorare il resto)
invece di rifiutare il file.

---

## 4. Eventi core

Ogni emettitore deve produrre questi. I payload sono descritti come
`campo: tipo`.

### Ciclo di vita del run

**`RunStarted`** — prima riga del file.
```
run_id:     stringa
lane_count: intero      # numero di lane nel piano
started_at: intero (ms)
```

**`RunCompleted`** — ultima riga di un run riuscito.
```
run_id:     stringa
stats:      RunStats     # vedi §6
elapsed_ms: intero
```

**`RunFailed`** — ultima riga di un run fallito.
```
run_id:     stringa
error:      stringa
elapsed_ms: intero
```

Invariante: un file ben formato inizia con esattamente un `RunStarted` e
termina con esattamente un `RunCompleted` **oppure** un `RunFailed`.

### Ciclo di vita del nodo

**`NodeStarted`**
```
run_id:  stringa
lane_id: stringa
node_id: stringa
label:   stringa
```

**`NodeProgress`** — emesso ogni N righe o ogni T ms (il primo che
scatta), non una volta per riga.
```
run_id:         stringa
lane_id:        stringa
node_id:        stringa
rows_in:        intero
rows_out:       intero
rows_rejected:  intero
throughput_rps: numero      # righe/secondo correnti
```

**`NodeCompleted`**
```
run_id:  stringa
lane_id: stringa
node_id: stringa
stats:   NodeStats          # vedi §6
```

**`NodeFailed`**
```
run_id:  stringa
lane_id: stringa
node_id: stringa
error:   stringa
```

### Conteggi per uscita

**`NodeOutputStats`** — per nodi multi-uscita (filter, tmap, …).
Emesso a fine nodo, prima di `NodeCompleted`.
```
run_id:  stringa
lane_id: stringa
node_id: stringa
counts:  oggetto            # handle_id (stringa) → righe emesse (intero)
```

Core "raccomandato": un runtime puramente lineare (nodi a una sola
uscita) può ometterlo; un runtime con nodi multi-uscita deve produrlo,
perché è l'unico modo di attribuire le righe alle singole uscite.

---

## 5. Estensioni (opzionali)

### Memoria

**`MemorySample`** — campione di memoria a cadenza fissa durante il run.
Forma core + estensione:
```
run_id:    stringa | null      # null se emesso fuori da un run
rss:       intero              # CORE: RSS totale dell'app in bytes
timestamp: intero (ms)
detail:    AppMemoryInfo | assente   # ESTENSIONE: vedi §6
```
Il campo `rss` è il numero neutro che qualsiasi runtime sa produrre. Il
campo `detail` (albero processi, PSS, private/shared, RAM) è specifico
di Tauri/WebKit: gli emettitori che non l'hanno lo **omettono**
(assente, non `null`). Un consumatore disegna la curva da `rss` e mostra
il dettaglio solo se `detail` è presente.

### Flusso e campionamento sul canvas

**`EdgeFlow`** — righe transitate su un edge dall'ultimo evento, per
animare il canvas.
```
run_id:  stringa
edge_id: stringa
delta:   intero
```

**`RowSample`** — ultime righe transitate su un edge, per ispezione
interattiva (pull su richiesta).
```
run_id:  stringa
node_id: stringa
edge_id: stringa
rows:    array di oggetti
```

Entrambi sono orientati alla GUI: un emettitore headless può ometterli.

### Bridge tra lane

**`BridgeStarted`**
```
run_id:    stringa
bridge_id: stringa
from_lane: stringa
to_lane:   stringa
```

**`BridgeCompleted`**
```
run_id:        stringa
bridge_id:     stringa
rows_transfer: intero
```

Solo per runtime che hanno il concetto di bridge (sincronismo tra lane).

### Connettori

**`ConnectionOpened`**
```
run_id:      stringa
node_id:     stringa
resource_id: stringa
conn_type:   stringa       # "db_postgresql", "ftp", "smtp", …
```

**`ConnectionClosed`**
```
run_id:      stringa
node_id:     stringa
resource_id: stringa
query_count: intero
elapsed_ms:  intero
```

**`ConnectionError`**
```
run_id:      stringa
node_id:     stringa
resource_id: stringa
error:       stringa
```

Raccomandati quando il runtime usa connettori esterni; opzionali
altrimenti.

---

## 6. Strutture annidate

**`NodeStats`** (dentro `NodeCompleted` e dentro `RunStats.node_stats`)
```
rows_in:       intero
rows_out:      intero
rows_rejected: intero
elapsed_ms:    intero
error:         stringa | null
```

**`RunStats`** (dentro `RunCompleted`)
```
run_id:       stringa
node_stats:   oggetto        # node_id (stringa) → NodeStats
total_ms:     intero
lanes_ok:     intero
lanes_failed: intero
```

**`AppMemoryInfo`** (estensione `detail` di `MemorySample`)
```
processes:     array di ProcessMemoryInfo
total_rss:     intero        # somma RSS di tutti i processi (bytes)
total_pss:     intero        # somma PSS; 0 se non disponibile
main_rss:      intero        # RSS del solo processo principale
webkit_rss:    intero        # RSS dei processi WebKit sommati
total_private: intero        # memoria privata sommata (metrica leak)
total_shared:  intero        # memoria condivisa sommata
total_ram:     intero        # RAM di sistema totale
used_ram:      intero        # RAM di sistema usata
timestamp:     intero (ms)
pss_available: booleano      # true solo dove il PSS è leggibile (Linux)
```

**`ProcessMemoryInfo`**
```
pid:     intero
name:    stringa
role:    stringa             # "Main" | "WebKitWeb" | "WebKitNetwork" | "WebKitGpu" | "Other"
rss:     intero
pss:     intero              # 0 se non disponibile
private: intero
shared:  intero
```

---

## 7. Regole per i consumatori

- **Tolleranza ai campi assenti.** Un campo opzionale può essere
  assente *o* presente con valore `null`. Trattare i due casi allo
  stesso modo.
- **Tolleranza agli eventi ignoti.** Se `event.type` non è riconosciuto,
  saltare la riga senza errori.
- **Ordine.** Le righe sono in ordine di emissione (`ts` non
  decrescente). Non assumere però granularità inferiore al millisecondo:
  più eventi possono condividere lo stesso `ts`.
- **Un run per file.** Tutte le righe di un file condividono lo stesso
  `run_id`; non serve deduplicare o filtrare per run come invece
  accadeva leggendo il bus in memoria (che è condiviso tra run).

---

## 8. Requisiti minimi per un nuovo emettitore

Un runtime headless (Rust/Java/Python) che voglia essere "monitorabile"
deve, al minimo:

1. scrivere un file NDJSON per run, righe nel formato `{"v":1,"ts":…,"event":…}`;
2. emettere `RunStarted` come prima riga e `RunCompleted`/`RunFailed` come ultima;
3. per ogni nodo, emettere `NodeStarted`, almeno un `NodeProgress` e `NodeCompleted`;
4. popolare i conteggi core (`rows_in`, `rows_out`, `rows_rejected`) e `throughput_rps`.

Tutto il resto (memoria, edge flow, row sample, bridge, connessioni) è
opzionale e va aggiunto solo se il runtime ha quel concetto. Un file che
rispetta i quattro punti sopra è già leggibile e utile in ogni
consumatore di FlowPilot.
