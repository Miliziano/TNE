# Architettura di esecuzione — runtime, agente, coordinatore

> Riferimento fisso per tutte le patch che toccano esecuzione, distribuzione e
> schedulazione. Decisioni prese con l'utente il 29 ottobre 2026.
> Da leggere insieme a `HANDOFF.md` (generale) e `HANDOFF-firma-artifact.md` (firma).

---

## 0. In una riga

Tre componenti — **runtime**, **agente**, **coordinatore** — con gli stessi formati in
tutti i casi. Il cliente sceglie quanta struttura vuole: solo la runtime, un agente
locale autonomo, oppure tutto governato da un coordinatore centrale. Si passa da un
modo all'altro **senza reinstallare e senza rifare** pipeline, artifact e configurazioni.

Differenza voluta rispetto a Talend TMC + Remote Engine: lì il controllo centrale è
obbligatorio; qui è **facoltativo**. Un cliente può avere installazioni focalizzate sui
propri sistemi senza gestire un software di controllo.

---

## 1. I componenti

| Componente | Binario | Stato | Cosa fa |
|---|---|---|---|
| **Runtime** | `flowpilot_runner` | esiste | Ammette (verifica firma) ed esegue **un** artifact. Un processo per run. |
| **Agente** | `flowpilot_agent` | da fare | Tiene in locale artifact, configurazioni e schedulazioni; fa scattare i run lanciando la runtime; tiene lo storico; inoltra gli eventi. |
| **Coordinatore** | `flowpilot_coordinator` | da fare | Catalogo artifact e versioni, configurazioni per ambiente, schedulazioni, gruppi di agenti, comandi remoti, vista unica dei run. Assorbe il ruolo del monitor (raccolta eventi). |

Lo **studio** resta dov'è: progetta, compila e firma gli artifact. Non esegue in
produzione e non parla con gli agenti.

---

## 2. I modi d'uso

**A — Solo runtime (oggi).** Si installa `flowpilot_runner`, si autorizza la chiave dello
sviluppatore (`flowpilot_runner trust add`), si lancia un artifact a mano o da un
pianificatore del sistema (cron, systemd timer, Utilità di pianificazione). Eventi al
monitor se configurato.

**B — Agente locale autonomo.** Si installa anche `flowpilot_agent`. La sua
configurazione è una cartella locale (artifact, configurazioni, schedulazioni) gestita da
CLI o da file. Nessun coordinatore, nessuna connessione uscente obbligatoria.

**C — Gestito.** Lo stesso agente, collegato a un coordinatore (`flowpilot_agent attach`).
Il coordinatore distribuisce artifact, configurazioni e schedulazioni; l'agente li
esegue.

**Misto (B + C).** Un agente collegato tiene anche elementi propri. Ogni elemento ha
un'**origine** (`local` | `coordinator`): il coordinatore gestisce solo i suoi, mai
quelli locali.

**Passaggi fra modi**
- A → B: si installa l'agente accanto alla runtime esistente; usa lo stesso binario
  `flowpilot_runner` e lo stesso trust store.
- B → C: `attach`. Gli elementi locali restano locali; si aggiungono quelli del coordinatore.
- C → B: `detach`. Gli elementi ricevuti dal coordinatore restano come ultima versione
  nota e diventano locali; l'agente continua a girare.

---

## 3. Decisioni

**D1 — Il modo è configurazione.** Stessi binari, stessi formati, stesse regole di
sicurezza in A, B e C. Nessuna funzione esiste solo in un modo se può esistere in tutti.

**D2 — Stato desiderato.** Agente e coordinatore si scambiano uno *stato desiderato*
dichiarativo (§4.6): quali deployment devono esistere. L'agente lo riconcilia con quello
che ha. In B lo stato viene dalla cartella locale, in C anche dal coordinatore.

**D3 — L'agente chiede, il coordinatore non spinge.** Connessioni solo uscenti
dall'agente (nessuna porta aperta nei siti dei clienti). Se il coordinatore non risponde,
l'agente continua con l'ultimo stato ricevuto. In air-gap lo stato si porta su file
(stesso formato, stessa firma).

**D4 — La schedulazione si valuta sull'agente.** Il coordinatore scrive e distribuisce le
schedulazioni; gli scatti avvengono in locale. I comandi remoti ("esegui ora", "ferma")
sono richieste che l'agente raccoglie alla connessione successiva.

**D5 — La fiducia nel codice resta locale.** Firma dell'artifact verificata dalla runtime
col trust store della macchina; policy della macchina applicata all'ammissione. Il
coordinatore può **restringere** (non distribuire, disabilitare) ma mai **allargare**:
non può far eseguire codice non firmato né aggirare la policy locale. Lo stato desiderato
del coordinatore è firmato con la chiave del coordinatore, registrata nell'agente
all'`attach` con lo stesso meccanismo del trust store.

**D6 — Un processo runtime per run.** Il motore ha stato globale pensato per un run alla
volta (bus eventi, reporter, registri dei watcher). L'agente lancia un processo per run:
il motore resta com'è, un crash non coinvolge altri run, l'isolamento può venire dal
sistema operativo (utente dedicato, container) senza riscritture.

**D7 — Configurazione separata dall'artifact.** Oggi il profilo scelto alla compilazione
è congelato nel piano. Si aggiunge: l'artifact **dichiara** le variabili configurabili
(nome, tipo, default = valore congelato); al run i valori possono arrivare da una
configurazione esterna, che sostituisce **solo** variabili dichiarate. Valore assente =
default congelato, cioè il comportamento di oggi. I segreti restano dove sono (env →
keychain della macchina), mai nella configurazione distribuita.

**D8 — Compatibilità.** Nei formati si aggiunge, non si rinomina né si cambia significato.
Un campo assente vuol dire il comportamento precedente. Quando un artifact richiede una
capacità nuova del motore, lo dichiara in `engineVersionRange`, che diventa un vincolo
reale (oggi lo studio scrive sempre `"*"`).

---

## 4. Contratti

Ogni contratto ha una **versione** e dei **vettori di prova** nel repo (come
`vectors/canonical_plan_v1.json`): un test che fallisce dopo una modifica vuol dire che
si è rotto un contratto, e si corregge il codice, non il vettore.

### 4.1 Artifact (`.ffart`) — esiste

`{ formatVersion: 2, manifest, sig, plan }`. Il manifesto è firmato e unica fonte dei
campi operativi: `planName`, `planVersion`, `planHash`, `studio`, `studioVersion`,
`profile`, `platform`, `logLevel`, `monitor`, `requiredSecrets`, `engineVersionRange`,
`createdAt`. Previsti (D7, D8): `variables` (dichiarazione delle variabili
configurabili), `engineVersionRange` reale.

### 4.2 Interfaccia della runtime — esiste, da estendere

- `flowpilot_runner <artifact.ffart>` esegue; `flowpilot_runner trust …` gestisce il trust store.
- Codici d'uscita: **0** completato · **1** run fallito · **2** uso errato / file illeggibile
  · **3** rifiutato all'ammissione (firma, trust store, compatibilità).
- Ambiente: `FLOWPILOT_RUN_ID` (id del run, assegnato da chi lancia), `MONITOR_URL`,
  `MONITOR_TOKEN`, `FLOWPILOT_RUNS_DIR`.
- Da aggiungere, tutte facoltative: `--config <file>` (valori di configurazione, D7),
  `--profile <file>` (profilo della runtime, §4.5), `--admit-only` (verifica e policy
  senza eseguire: serve all'agente per ammettere una volta), uscita degli eventi su file
  o stdout (l'agente li inoltra).

### 4.3 Eventi — esiste, da estendere

NDJSON con `run_id`, tipi `RunStarted/Completed/Failed`, `Node*`, `Lane*`, `Bridge*`,
`Connection*`, `MemorySample`, più l'intestazione del run (provenienza). Da aggiungere,
facoltativi: `agent_id`, `runtime_id`, `deployment_id`, `trigger`
(`manual` | `schedule` | `event` | `remote`). Chi non li conosce li ignora.

### 4.4 Configurazione — formato già esistente

Si riusa il formato dell'export dei profili (P152): `{ "profile": "prod", "values":
{ "VAR": valore } }`. La runtime rifiuta valori per variabili non dichiarate o di tipo
incompatibile (errore all'ammissione, uscita 3).

### 4.5 Profilo della runtime — da fare

Un file per macchina: percorso del trust store, **policy** (tipi di nodo vietati, per
esempio `shell_exec`/`ssh_exec`), limiti (memoria, durata), monitor/inoltro eventi. Le
variabili d'ambiente di oggi continuano a valere e hanno la precedenza. In C il
coordinatore può distribuire un profilo, ma la policy locale vince sempre (D5).

### 4.6 Stato desiderato dell'agente — da fare

Elenco di **deployment**: `{ id, origin, artifact (planHash), config (riferimento),
schedule (cron | manuale | evento), target (runtime o gruppo), enabled }`. Gli artifact
sono indirizzati per `planHash`: lo stesso artifact non si scarica due volte e una
versione non cambia sotto i piedi.

---

## 5. Fasi

Ogni fase è utile da sola e non richiede le successive.

1. **Contratti e ammissione.** Vettori per §4.1–4.3; `engineVersionRange` reale; una sola
   funzione di ammissione (firma + compatibilità + **policy dei nodi pericolosi**);
   `--admit-only`; profilo della runtime. Utile subito in modo A.
2. **Configurazione separata (D7).** Lo studio dichiara le variabili configurabili e le
   lascia come riferimento nel piano; il motore le risolve; `--config`. Lo stesso artifact
   gira in test e in produzione cambiando solo il file.
3. **Agente autonomo (modo B).** Cartella di stato, schedulazioni cron e manuali, lancio
   della runtime, storico locale, inoltro eventi al monitor. Sostituisce il cron esterno.
4. **Coordinatore (modo C).** Registrazione degli agenti, catalogo, configurazioni per
   ambiente, schedulazione remota, comandi remoti, vista unica. Il monitor confluisce qui.
5. **Più runtime per agente.** Code, concorrenza, retry, dipendenze fra pipeline.

---

## 6. Punti aperti

- Interfaccia dell'agente in modo B: solo CLI + file, o anche una piccola UI web locale.
- Coordinatore: evoluzione del binario `flowpilot_monitor` o servizio nuovo che lo
  incorpora.
- Utenti e ruoli sul coordinatore (chi distribuisce, chi esegue, chi legge).
- Storico dei run in modo B: formato e conservazione (oggi i file del monitor non si
  cancellano mai).
- Agenti che pilotano runtime su altre macchine (fase 5) o solo sulla propria.
