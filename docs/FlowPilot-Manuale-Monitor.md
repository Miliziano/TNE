# FlowPilot — Manuale del Monitor

Guida al **monitor centralizzato**: cos'è, come si compila e si avvia, come i
runner gli mandano i log, come si legge la sua interfaccia, come si conservano e
si riaprono i log, e quali sono i suoi limiti dichiarati.

> Il monitor è un **servizio a sé**: non è lo studio, e non è il pannello di
> monitoraggio che vedi dentro lo studio. Sono due mondi distinti, per scelta —
> vedi §1.

---

## 1. A cosa serve (e cosa NON è)

FlowPilot ha **due** strumenti di osservazione, con scopi diversi:

| | Monitoraggio nello **studio** | **Monitor** centralizzato |
|---|---|---|
| Scopo | **Debugger**: capire un flusso che stai costruendo | **Scatola nera di campo**: capire cos'è successo in produzione |
| Quando | Mentre disegni ed esegui nello studio | Sempre acceso, riceve dai runner della flotta |
| Dettaglio | Massimo (memoria, righe, timeline fine) | Filtrato (vedi §7) — niente dati, niente rumore |
| Dove vive | Nell'app desktop | Su un server, raggiungibile via HTTP |

L'unica cosa che condividono è il **formato degli eventi** (NDJSON): non l'interfaccia,
non lo storage.

Il monitor è **standalone**: dipende solo da `tiny_http` e `serde_json`, niente
Tauri, niente webview. Gira su un server nudo.

---

## 2. Compilare e avviare

Dalla cartella **`src-tauri/`**:

```bash
cargo build --bin flowpilot_monitor --no-default-features --features monitor --release
```
→ binario in `src-tauri/target/release/flowpilot_monitor`.

Avvio:
```bash
./flowpilot_monitor            # porta 8787 (default)
./flowpilot_monitor 9000       # porta a scelta
```

All'avvio il monitor **dichiara come è configurato** — leggi quelle righe, dicono
tutto:
- l'indirizzo e la porta,
- **la cartella dati** e **quanti run ha ricaricato** da disco,
- se l'ingest è **protetto da token** (🔒) o **aperto a chiunque** (⚠).

> ⚠️ **L'interfaccia web è compilata dentro il binario.** Se applichi una patch
> che tocca la vista, non basta ricaricare la pagina: va **ricompilato e
> riavviato** il monitor, e conviene un ricaricamento forzato del browser
> (Ctrl+Shift+R) per aggirare la cache.

### Variabili d'ambiente

| Variabile | Default | Effetto |
|---|---|---|
| `MONITOR_DATA_DIR` | `~/.flowpilot/monitor-data` | Cartella dei log persistiti (un file per run) |
| `MONITOR_TOKEN` | *(vuoto)* | Se impostata, `/ingest` la esige (§6). Vuoto = ingest aperto |
| `MONITOR_MAX_RUNS` | `200` | Quanti run tenere **in memoria**; oltre, escono i più vecchi (i **file restano**) |
| `MONITOR_MAX_EVENTS` | `50000` | Tetto eventi **in memoria** per run; oltre, si tengono i più recenti (il file resta completo) |

> La cartella dati di default sta **fuori** da qualunque progetto, di proposito:
> se il monitor scrive dentro l'albero di un progetto aperto con `tauri dev`, il
> file-watcher di Tauri scambia quelle scritture per modifiche al codice e
> **riavvia lo studio a ogni evento ricevuto**.

---

## 3. Come i runner gli mandano i log

L'indirizzo del monitor si sceglie nello studio, nella scheda **"Compila"**, e
finisce nel manifesto dell'artifact. Può essere:

- un **URL letterale** (`http://mon:8787/ingest`) → il runner lo usa così com'è;
- un **riferimento** `${MONITOR_URL}` → il runner lo risolve dalla variabile
  d'ambiente **sulla macchina di destinazione**. Ideale per una flotta: stesso
  artifact ovunque, ogni macchina punta al proprio monitor.

Se nella scheda non metti nulla, il runner ripiega su `MONITOR_URL` dall'ambiente;
se non c'è neanche quella, non pusha (resta solo lo stdout).

**Il push è best-effort e non blocca mai il run.** Se il monitor è irraggiungibile,
gli eventi vengono appesi a `flowpilot-monitor-fallback.ndjson` nella cartella da
cui hai lanciato il runner, così non si perdono: potrai reinviarli o aprirli a
mano più tardi (i duplicati vengono riconosciuti, §5).

**Token:** se il monitor lo richiede, il runner lo prende da `MONITOR_TOKEN`
**dell'ambiente della macchina che esegue** — mai dall'artifact (§6).

```bash
MONITOR_TOKEN='…' MONITOR_URL='http://mon:8787/ingest' ./flowpilot_runner piano.ffart
```

---

## 4. L'interfaccia web

Apri `http://<host>:<porta>/`. Si aggiorna da sola ogni 2 secondi.

**In alto** trovi il numero di run, il pulsante **📂 Apri log…** (§8) e, sotto,
la **cartella dati** da cui il monitor legge e scrive.

**A sinistra**, la lista dei run (più recenti in cima): nome del piano, codice del
run, stato, numero di eventi, e — quando disponibili — lo **studio** che ha
compilato l'artifact e l'**IP osservato**.

**A destra**, il dettaglio del run selezionato:

- **Banner**: nome del piano, codice, stato, conteggio eventi, **💾 Salva log** (§8),
  e la riga di **provenienza** (§9).
- **Riepilogo**: esito, durata, righe, nodi, lane ok/ko. Se il run è fallito, il
  messaggio d'errore è mostrato in evidenza invece che sepolto nel JSON.
  - *Nota sui numeri:* «righe (max per nodo)» è la scala reale del flusso; la voce
    «somma righe nodi» somma tutti i nodi e quindi **conta più volte le stesse
    righe** che attraversano la pipeline — è indicata come somma proprio per non
    trarre in inganno.
- **Filtri**: ricerca testuale (§10), «⚠ solo errori», «💾 nascondi memoria»
  (attivo di default) e un menu per isolare un singolo nodo. I filtri
  **sopravvivono** all'aggiornamento automatico.
- **Eventi**: orario al millisecondo, tipo, contenuto. Gli errori hanno bordo e
  sfondo rossi, gli avvisi ambra, i completamenti verdi. I campioni di memoria,
  quando li mostri, sono resi in forma compatta (`RSS 18.6 MB · PSS 15.5 MB`).

---

## 5. Dove finiscono i log (tre posti diversi)

| Dove | Cosa | Chi lo scrive |
|---|---|---|
| `~/.flowpilot/runs/<run_id>.ndjson` | **Log integrale** del run, **sempre completo** | Il motore, sulla macchina che esegue |
| `~/.flowpilot/monitor-data/<run_id>.ndjson` | Log **ricevuto** dal monitor (filtrato secondo §7) | Il monitor, in append a ogni evento |
| `flowpilot-monitor-fallback.ndjson` | Solo se il push fallisce | Il runner, nella sua cartella di lavoro |

Due conseguenze pratiche:

- **Il log completo non si perde mai**, anche se al monitor mandi il minimo
  indispensabile: resta sulla macchina che ha eseguito.
- **La persistenza del monitor è append-on-ingest**: è lo stesso meccanismo che
  gli dà il salvataggio automatico e la ricarica all'avvio. Riavviando, il
  monitor rilegge i file e ritrova i run.

**Duplicati:** se il runner reinvia il file di fallback, gli eventi già visti
vengono riconosciuti e scartati — né in memoria né sul file.

**Retention:** `MONITOR_MAX_RUNS` e `MONITOR_MAX_EVENTS` sfoltiscono **solo la
memoria**. I file **non vengono mai cancellati** dal monitor: sfoltire la memoria
non è cancellare la storia. La pulizia del disco resta una tua decisione.

> **Attenzione all'equivoco più comune:** cancellare i file **non svuota** la lista
> dei run, perché lo store è in memoria e il disco si rilegge solo all'avvio.
> Ordine giusto: **ferma il monitor → cancella i file → riavvia**.

---

## 6. Sicurezza dell'ingest (token)

Di default `/ingest` **accetta da chiunque raggiunga la porta**: comodo in locale,
da non usare su una rete condivisa. Per proteggerlo:

```bash
MONITOR_TOKEN='un-segreto-lungo-e-casuale' ./flowpilot_monitor 8787
```

Da quel momento ogni push deve portare l'intestazione
`Authorization: Bearer <segreto>` (è accettata anche `X-Flowpilot-Token`);
senza, la risposta è **401**. I runner lo prendono da `MONITOR_TOKEN`
sull'ambiente della loro macchina.

**Perché il token non sta nell'artifact:** l'artifact è un file che si
distribuisce, e un segreto dentro un file distribuibile è un segreto bruciato.
Stesso principio dei segreti del piano: il piano dice *di cosa* ha bisogno, la
macchina fornisce *il valore*.

### Limiti dichiarati (onestà, non omissione)

- Il token protegge la **scrittura**. **Vista e API di lettura restano aperte** a
  chi raggiunge la porta: se il monitor sta su una rete non fidata, mettilo dietro
  un reverse proxy con autenticazione, o su una rete privata.
- L'**hash del piano** mostrato come *integrità* dice che è stato eseguito
  esattamente il piano esportato; **non dice chi** l'ha prodotto — chi modifica un
  piano può ricalcolare l'hash. Per l'autenticità servirebbe una firma
  asimmetrica (non ancora implementata).
- Nessun log prova **da solo** che un run sia avvenuto come raccontato: è il
  runner a narrarlo. L'unico dato non dichiarato dal runner è l'**IP osservato**,
  che il monitor legge dalla connessione.

---

## 7. Quanto dettaglio arriva al monitor

Si sceglie nella scheda **"Compila"** ("Dettaglio del log inviato") e viaggia
nell'artifact. Filtra ciò che **esce dalla macchina** (stdout del runner + push);
il log integrale resta comunque in `~/.flowpilot/runs/`.

| Livello | Cosa arriva | Quando usarlo |
|---|---|---|
| **Essenziale** | Ciclo di vita run/nodi, errori, statistiche finali | Produzione, flussi molto verbosi |
| **Normale** *(default)* | + avanzamento e messaggi dei nodi | Predefinito sensato per il campo |
| **Diagnostico** | Tutto: **contenuto delle righe** e campioni di memoria | Solo mentre cacci un problema |

**Essenziale e Normale non trasmettono mai il contenuto delle righe.** Non è solo
una questione di rumore: i dump di riga contengono i **dati veri** (anagrafiche,
email, importi), e copiarli su un server di monitoraggio è un problema di
protezione dati. Il ciclo di vita e gli errori, invece, passano a **tutti** i
livelli: il log può essere sintetico, mai incompleto sulle cose che contano.

Quando un log è filtrato, il monitor **lo dichiara** nel banner del run, così non
sembra che manchino eventi.

---

## 8. Salvare e riaprire un log

- **💾 Salva log** (nel dettaglio del run) scarica l'NDJSON di quel run sul tuo
  computer.
- **📂 Apri log…** (in alto) apre un file `.ndjson` **dal tuo computer** e lo
  mostra come un run: banner, riepilogo, filtri e ricerca funzionano allo stesso
  modo. Il file **non viene importato**: è una vista temporanea, non tocca
  l'archivio del monitor né crea run doppi. Si chiude con **✕ chiudi**.

Puoi aprire qualunque log del formato: quelli scaricati dal monitor, quelli di
`~/.flowpilot/runs/` presi da una macchina, o un file di fallback. Se il file ha
l'intestazione scritta dal runner, ne vengono mostrati i metadati.

---

## 9. Provenienza di un run

Nel banner, le informazioni sono separate per **grado di fiducia** — una
distinzione voluta, non estetica:

- **Dichiarate** (arrivano dall'artifact e dal runner, sono riportate così come
  sono): studio che ha compilato ed etichetta, versione dello studio, versione del
  piano, host dichiarato, hash del piano (*integrità*), livello di log.
- **Osservato** (lo rileva il monitor dalla connessione, non è dichiarato da
  nessuno): **IP osservato**.

L'identità dello studio si imposta nella scheda "Compila" ("Compilato da"), vale
per tutti i progetti di quel computer, ed è conservata in `~/.flowpilot/studio.json`.
Identifica **l'installazione**, non la persona: è un'etichetta di provenienza,
non un'autenticazione.

> Nome del piano e provenienza vengono **incisi al momento dell'export**: un
> artifact generato prima non li ha. Ri-esportalo.

---

## 10. Ricerca

Il campo di ricerca filtra gli eventi per **sottostringa** (senza distinzione tra
maiuscole e minuscole) su tutto il testo dell'evento — tipo e contenuto insieme.
Il termine trovato viene evidenziato nelle righe.

Sopra l'elenco compare una **sintesi** dei risultati: quanti eventi su quanti
contengono il termine, quanti sono in errore, l'intervallo di tempo coperto con la
durata, e i conteggi per **tipo di evento** e **per nodo**. Serve a capire *cosa*
ha trovato la ricerca senza scorrere l'elenco.

Se non trova nulla te lo dice, ricordandoti che potrebbero esserci **altri filtri
attivi** (per esempio "solo errori" o un nodo selezionato).

---

## 11. Interfaccia HTTP

| Metodo | Percorso | Uso |
|---|---|---|
| POST | `/ingest` | I runner pushano qui (body NDJSON). Richiede il token se configurato |
| GET | `/` | La vista web |
| GET | `/api/runs` | Elenco run + la cartella dati |
| GET | `/api/runs/<run_id>` | Eventi e provenienza di un run |
| GET | `/api/runs/<run_id>/download` | Scarica il log del run in NDJSON |

**Formato del log.** Un file NDJSON (un JSON per riga) fatto così:

```
{"kind":"flowpilot-log-header","logFormat":1,"runner":{…},"artifact":{…}}
{"timestamp":1787212216770,"event":{"type":"RunStarted","payload":{…}}}
{"timestamp":1787212216771,"event":{"type":"NodeStarted","payload":{…}}}
```

La prima riga è l'**intestazione autodescrittiva** (metadati di runner e artifact),
che rende il file interpretabile anche a distanza di mesi. Ogni riga successiva
porta il **timestamp d'origine** — l'ora in cui l'evento è accaduto sulla macchina
che eseguiva, non quella in cui il monitor l'ha ricevuto.

---

## 12. Diagnosi rapida

| Sintomo | Causa quasi certa |
|---|---|
| Vedo run che avevo cancellato | Store in memoria: **ferma → cancella → riavvia** (§5) |
| Ho applicato una patch alla vista ma non cambia nulla | La vista è nel binario: **ricompila e riavvia**, poi Ctrl+Shift+R |
| Manca il nome del piano o la provenienza | Artifact esportato **prima**: ri-esportalo dalla scheda "Compila" |
| Il log non ha l'intestazione e gli eventi sono "nudi" | Stai eseguendo un **runner vecchio**: verifica con `strings <binario> \| grep -c flowpilot-log-header` (0 = vecchio) e ricontrolla in quale cartella scrive il tuo `cargo build` |
| Il push risponde 401 | Token mancante o diverso: allinea `MONITOR_TOKEN` su monitor e runner |
| Non arriva nulla al monitor | Controlla l'URL nel manifesto (o `MONITOR_URL`), e cerca `flowpilot-monitor-fallback.ndjson` accanto al runner |
| Lo studio si riavvia da solo quando arrivano eventi | Il monitor scrive dentro un progetto aperto con `tauri dev`: sposta `MONITOR_DATA_DIR` fuori (§2) |
| Vedo pochi eventi | Livello di log filtrato (§7) — il banner lo dichiara — oppure filtri attivi nella vista |

---

*Manuale del Monitor — copre avvio, configurazione, ingestione, persistenza,
sicurezza, livelli di log, viste, ricerca e API. Il manuale operativo generale
copre studio, runner e artifact; il riferimento dei nodi vive in `docs/nodes/`.*
