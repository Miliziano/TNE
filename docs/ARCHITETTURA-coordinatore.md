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

Ogni contratto ha una **versione** e dei **vettori di prova** nel repo (elenco in
`vectors/README.md`): un test che fallisce dopo una modifica vuol dire che si è rotto un
contratto, e si corregge il codice, non il vettore. Dal P379: artifact firmato
(`artifact_v2.ffart`), eventi (`engine_events_v1.ndjson`), interfaccia del runner
(`src-tauri/tests/runner_contract.rs`); la CI li esegue prima di costruire il binario.

### 4.1 Artifact (`.ffart`) — esiste

`{ formatVersion: 2, manifest, sig, plan }`. Il manifesto è firmato e unica fonte dei
campi operativi: `planName`, `planVersion`, `planHash`, `studio`, `studioVersion`,
`profile`, `platform`, `logLevel`, `monitor`, `requiredSecrets`, `engineVersionRange`,
`createdAt`, e dal P380 `variables` (dichiarazione delle variabili configurabili, §4.4).

`engineVersionRange` (dal P378 il runner lo applica davvero): `*` oppure confronti
`>=` `>` `<=` `<` `=` su versioni `MAGGIORE.MINORE.PATCH`, separati da spazi o virgole,
tutti veri (`>=0.2.0 <0.3.0`). Sintassi non riconosciuta = incompatibile. Lo studio
scrive ancora `*`; scriverà la versione minima quando un artifact userà una capacità
nuova del motore (per esempio le variabili configurabili).

### 4.2 Interfaccia della runtime — esiste, da estendere

- `flowpilot_runner <artifact.ffart>` esegue; `flowpilot_runner trust …` gestisce il trust store.
- Codici d'uscita: **0** completato · **1** run fallito · **2** uso errato / file illeggibile
  · **3** rifiutato all'ammissione (firma, trust store, compatibilità).
- Ambiente: `FLOWPILOT_RUN_ID` (id del run, assegnato da chi lancia), `MONITOR_URL`,
  `MONITOR_TOKEN`, `FLOWPILOT_RUNS_DIR`.
- **Fatto nel P378:** `--profile <file>` (profilo della runtime, §4.5) e
  `--admit-only` (verifica e policy senza eseguire; stampa su stdout
  `{"admitted":true,"keyId","owner","planHash","planName","nodeTypes"}` oppure
  `{"admitted":false,"reason"}`; uscita 0 o 3). Le opzioni stanno in qualunque
  ordine rispetto al file; un'opzione sconosciuta è un errore d'uso (uscita 2).
- **Fatto nel P380:** `--config <file>` (o `FLOWPILOT_CONFIG`): valori delle variabili
  configurabili (§4.4). Il riepilogo di `--admit-only` e l'intestazione del log hanno
  `configuration: { source, profile, hash, overridden }`.
- Da aggiungere, facoltativa: uscita degli eventi su file o stdout separata dal log
  (l'agente li inoltra).

### 4.3 Eventi — esiste, da estendere

NDJSON con `run_id`, tipi `RunStarted/Completed/Failed`, `Node*`, `Lane*`, `Bridge*`,
`Connection*`, `MemorySample`, più l'intestazione del run (provenienza). Da aggiungere,
facoltativi: `agent_id`, `runtime_id`, `deployment_id`, `trigger`
(`manual` | `schedule` | `event` | `remote`). Chi non li conosce li ignora.

### 4.4 Configurazione — fatta (P380 runtime, P381 studio)

**Dichiarazione** nel manifesto firmato:
`"variables": { "NOME": { "type": "string|number|boolean|json", "default": "testo",
"allowed": [..], "min": n, "max": n, "pattern": "regex" } }` — i vincoli sono facoltativi;
`min`/`max` solo per `number`, `pattern` solo per `string` (ancorato: vale il valore intero).
Un vincolo sconosciuto o un default fuori dai vincoli rendono l'artifact non ammissibile.

**File di configurazione** (formato dell'export dei profili, P152):
`{ "profile": "prod", "values": { "NOME": "valore" } }` (testi; numeri e booleani JSON
accettati). Codice: `src-tauri/src/runtime/config.rs`.

**Regole di sicurezza** (concordate il 29 ottobre):
1. Solo variabili dichiarate nell'artifact firmato; per default nessuna è configurabile.
2. Tipo e vincoli stanno nel manifesto firmato; un valore fuori vincolo → rifiuto (3).
3. I valori sono dati: vanno nelle variabili di lane (`var()`, percorsi "da variabile")
   e al posto di `${NOME}` nei campi delle risorse; mai nel testo di espressioni o query.
   Sempre rifiutati: caratteri di controllo e riferimenti `${…}` dentro un valore (che
   verrebbero poi risolti come segreti).
4. Il file è controllato come il trust store (permessi, JSON rigoroso).
5. Impronta dei valori (`sha256` del JSON ordinato) e nomi cambiati nel log; mai i valori.
6. Facoltativo: configurazione firmata pretesa dal profilo (non ancora fatto).

**Rappresentazione:** come fa lo studio, i valori stanno nel piano come testo: un valore
da file si comporta come lo stesso valore congelato alla compilazione.

**Compatibilità:** un artifact con `variables` dichiara `engineVersionRange: ">=0.2.0"`
(il runner è passato a 0.2.0 nel P380). I runner precedenti lo rifiutano invece di
eseguirlo con i `${NOME}` non risolti: quelli prima del P378 accettano solo `*`.

### 4.5 Profilo della runtime — formato 1 fatto (P378)

`{ "formatVersion": 1, "description", "policy": { "deniedNodeTypes", "allowedNodeTypes" } }`
in `~/.flowpilot/runtime.json`, oppure `--profile`, oppure `FLOWPILOT_RUNTIME_PROFILE`.
Codice: `src-tauri/src/runtime/profile.rs`. Regole: file di default assente = nessuna
restrizione; percorso indicato e assente = errore; chiave sconosciuta, `formatVersion`
diversa, tipo di nodo inesistente o permessi pericolosi = rifiuto. I tipi validi sono
`engine::executor::NODE_TYPES`, tenuto allineato al `match` di `run_node` da un test.

Dal P380 anche `"secrets": { "onlyDeclared": true }`: i `${NOME}` delle risorse si
risolvono solo per i segreti elencati in `requiredSecrets` del manifesto firmato, non per
qualunque variabile d'ambiente della macchina. Facoltativo per non cambiare gli artifact
esistenti; consigliato in produzione. (Un runner più vecchio rifiuta un profilo con questa
chiave, come deve.)

Prossime versioni del formato (si alza `formatVersion`, così un runner vecchio rifiuta
un profilo che non sa applicare invece di ignorarne le restrizioni): limiti (memoria,
durata), percorso del trust store, inoltro eventi. In C il coordinatore può distribuire
un profilo, ma la policy locale vince sempre (D5).

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
   *P378: ammissione unica (`runtime::admission::admit`), policy, profilo,
   `--admit-only`, `engineVersionRange` reale nel runner. P379: vettori dei contratti
   (`vectors/README.md`) e test dell'interfaccia del runner, eseguiti anche in CI.
   **Fase 1 chiusa.** Lo studio scriverà un range vero quando servirà (fase 2).*
2. **Configurazione separata (D7).** Lo studio dichiara le variabili configurabili e le
   lascia come riferimento nel piano; il motore le risolve; `--config`. Lo stesso artifact
   gira in test e in produzione cambiando solo il file.
   *P380: lato runtime fatto (dichiarazione, `--config`, vincoli, impronta, segreti solo
   dichiarati). P381: lato studio (variabili configurabili e vincoli in Environments,
   `manifest.variables`, `${NOME}` lasciati nelle risorse dell'artifact, validazione col
   codice del runner alla firma). **Fase 2 chiusa.** Resta facoltativa la configurazione
   firmata (regola 6).*
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
