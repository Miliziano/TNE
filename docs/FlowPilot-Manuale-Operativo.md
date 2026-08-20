# FlowPilot — Manuale operativo

Guida "sistemistica" a FlowPilot: come si eseguono e si compilano i suoi
componenti, con quali parametri, e come si governano gli ambienti di
**profilatura**, **compilazione** ed **esecuzione**. Include i capitoli su
**segreti**, su **profili di esecuzione** (a livello di artifact e su file) e
sulla generazione del **riferimento dei nodi**.

> I comandi Rust (`cargo …`) vanno sempre dati dalla cartella **`src-tauri/`**
> (è lì il `Cargo.toml`). I comandi npm dalla **radice del repo**.

---

## 1. I pezzi in gioco

FlowPilot è composto da quattro elementi, con una separazione di fondo che
conviene tenere a mente: **il PIANO** (la struttura del flusso) è distinto
dall'**AMBIENTE** (i valori e i segreti, che cambiano tra test/dev/prod).

| Componente | Cos'è | Tecnologia |
|---|---|---|
| **Studio** | L'app desktop dove disegni i flussi, gestisci profili e segreti, e generi gli artifact | Tauri (React + motore Rust) |
| **Artifact** (`.ffart`) | Il piano compilato di un progetto, con un ambiente congelato. È solo dati (KB) | JSON |
| **Runner** | Il binario headless che esegue un artifact su una macchina qualsiasi (anche server nudi) | Rust |
| **Monitor** | Il servizio always-on che riceve i log dei runner della flotta e li mostra | Rust |

Principio chiave del rilascio: **il runner è UNO**, generico, con dentro tutti i
driver, compilato una volta per piattaforma. L'**artifact è il piano**,
portabile: lo stesso runner esegue qualsiasi artifact. Cento flussi = un runner
+ cento piani da pochi KB.

---

## 2. Prerequisiti

- **Rust** ≥ 1.77.2 (con `cargo`). Installazione: <https://rustup.rs>.
- **Node.js** ≥ 18 e **npm** (per lo studio).
- **Librerie di sistema** — dipendono da *cosa* compili:

  - **Per lo STUDIO** (app Tauri completa) su Linux servono le dipendenze
    grafiche di Tauri (webkit2gtk, gtk, ecc.). Vedi la guida Tauri per la tua
    distribuzione: <https://tauri.app/start/prerequisites/>.
  - **Per il RUNNER e il MONITOR** (build headless, *senza* Tauri) su Linux
    basta molto meno — niente webview:
    ```bash
    sudo apt-get install -y pkg-config libssl-dev libdbus-1-dev
    ```
    (`libssl-dev` per il TLS dei connettori, `libdbus-1-dev` per il keychain.)
    Su **Windows** e **macOS**: nulla di extra (TLS e keychain sono nativi).

La prima volta, dalla radice del repo:
```bash
npm install
```
Tira giù anche `tsx`, il piccolo runner TypeScript usato dal generatore delle
schede-nodo (§11).

---

## 3. Lo studio

Lo studio è l'app desktop. Da usare per: disegnare i flussi, gestire variabili di
pool, profili e segreti, e **generare gli artifact**.

**Eseguirlo in sviluppo** (dalla radice del repo):
```bash
npm run tauri dev
```
Avvia il frontend (Vite) e il motore (Tauri) insieme. È la modalità normale di
lavoro. Con la feature `desktop` attiva di default, si porta dietro tutto lo
stack grafico — è giusto così: questo è lo *studio*, non il runner.

**Compilarlo come app distribuibile:**
```bash
npm run tauri build
```
Produce l'installer/eseguibile dello studio per la tua piattaforma (in
`src-tauri/target/release/bundle/…`).

> Nota: `cargo run` da `src-tauri/` esegue il binario `app` (grazie a
> `default-run = "app"`), ma per lo studio completo con frontend usa
> `npm run tauri dev`.

---

## 4. Compilare il RUNNER (headless)

Il runner è il motore **senza** Tauri né interfaccia: esegue un artifact e basta.
Il "senza Tauri" si ottiene con `--no-default-features` (spegne la feature
`desktop`). Da **`src-tauri/`**:

**Build ottimizzato per la distribuzione** (leggero, senza simboli):
```bash
cargo build --bin flowpilot_runner --no-default-features --profile release-lean
```
→ binario in `src-tauri/target/release-lean/flowpilot_runner`
(`flowpilot_runner.exe` su Windows).

**Build "grasso" solo per sviluppo** (linka anche Tauri — NON distribuirlo):
```bash
cargo run --bin flowpilot_runner -- <artifact.ffart>
```

**Parametri di build che contano:**

| Parametro | Effetto |
|---|---|
| `--bin flowpilot_runner` | Compila il binario del runner (non lo studio) |
| `--no-default-features` | Spegne `desktop` → **niente Tauri/webview**. Indispensabile per i server |
| `--profile release-lean` | Profilo ottimizzato per dimensione (`opt-level="z"`, `lto`, `strip`, ecc.) |

**Cosa contiene il runner:** tutti i driver/connettori (DB, REST, LDAP, FTP,
SSH, mail…) e il keychain, ma **niente interfaccia grafica**. È "il motore
completo senza il guscio". Quindi non è minuscolo, ma è unico e riusabile.

**Compilarlo automaticamente per Windows e Linux** — la CI (`.github/workflows/
runner.yml`): dalla tab **Actions** di GitHub premi *Run workflow*, oppure pusha
un tag `vX.Y.Z`. Sforna i due binari già pronti (e su tag li allega alla
Release).

---

## 5. Compilare ed eseguire il MONITOR

Il monitor è un servizio standalone che riceve i log dei runner. È dietro la
feature `monitor` (così non appesantisce studio e runner). Da **`src-tauri/`**:

**Build:**
```bash
cargo build --bin flowpilot_monitor --no-default-features --features monitor --release
```
→ binario in `src-tauri/target/release/flowpilot_monitor`.

**Esecuzione:**
```bash
./target/release/flowpilot_monitor 8787
```
(8787 è la porta di default; puoi passarne un'altra come argomento.)

**Cosa espone:**

| Endpoint | Uso |
|---|---|
| `POST /ingest` | I runner pushano qui i log (body NDJSON) — non lo usi a mano |
| `GET /` | La **vista web**: lista dei run a sinistra, eventi a destra, auto-refresh |
| `GET /api/runs` | Elenco run (id, stato, numero eventi) |
| `GET /api/runs/<run_id>` | Gli eventi di un run |

Apri `http://<host>:8787/` nel browser per vederlo.

> Limiti del monitor attuale: lo storico è **in memoria** (riavvii il monitor →
> perdi i run passati); niente autenticazione né retention. Sono i prossimi
> affinamenti.

---

## 6. Compilare gli ARTIFACT (dallo studio)

L'artifact **non si compila da riga di comando**: si genera dallo studio, con la
scheda **"Compila"** (bottone nella toolbar). Non è codice Rust — è il *piano*
del progetto, in JSON. Nella scheda scegli:

- **Profilo da congelare** — un ambiente per artifact (i suoi valori vengono
  bakati nel piano);
- **Monitor** — l'endpoint dove il runner pusherà i log (vedi §8);
- **Piattaforma** di destinazione (informativa, finisce nel manifesto).

Premi **Genera** e salvi il file `.ffart`. Il manifesto in anteprima ti mostra
il profilo congelato, la piattaforma, il monitor e **quali segreti servono**.

**Struttura del `.ffart`:**
```json
{
  "formatVersion": 1,
  "kind": "flowpilot-artifact",
  "exportedAt": "…",
  "profile": "prod",
  "platform": "linux",
  "monitor": "http://mon:8787/ingest",
  "requiredSecrets": ["DB_PASSWORD", "GITHUB_TOKEN"],
  "plan": { …lo stesso piano che esegue il motore… }
}
```
Nessun valore di segreto è dentro: l'artifact è distribuibile e a prova di leak.

---

## 7. Eseguire un artifact col runner

Sulla macchina di destinazione, col runner compilato:
```bash
./flowpilot_runner /percorso/artifact.ffart
```

- Stampa una riga **NDJSON per evento** su stdout (`RunStarted`, `NodeStarted`,
  `NodeProgress`, `RunCompleted`/`RunFailed`).
- Se l'artifact ha un **monitor** nel manifesto, il runner **pusha là in
  automatico** (vedi §8) — non serve altro.
- Codici d'uscita: **0** = completato, **1** = fallito, **2** = errore
  d'uso/lettura del file.

**Fornire i segreti al runner:** i loro valori non sono nell'artifact, vanno dati
sulla macchina (§9). Il modo più rapido per un test è la variabile d'ambiente:
```bash
DB_PASSWORD='...' GITHUB_TOKEN='...' ./flowpilot_runner artifact.ffart
```

---

## 8. Monitor: come il runner sa dove pushare

L'endpoint del monitor si imposta **nella scheda di compilazione**, e può essere
di due tipi. La regola del runner è: **manifesto prima, variabile d'ambiente come
ripiego.**

**a) URL letterale** (es. `http://mon:8787/ingest`)
→ inciso nel manifesto. Il runner lo usa da solo:
```bash
./flowpilot_runner artifact.ffart          # nessun MONITOR_URL necessario
```
Comodo quando il monitor è fisso.

**b) Riferimento `${MONITOR_URL}`**
→ nel manifesto c'è il *riferimento*, non l'indirizzo. Il runner lo risolve dalla
variabile d'ambiente **sulla macchina di destinazione**:
```bash
MONITOR_URL='http://mon-di-questa-macchina:8787/ingest' ./flowpilot_runner artifact.ffart
```
Ideale per una **flotta**: lo *stesso* artifact gira ovunque, e ogni macchina
punta al proprio monitor impostando `MONITOR_URL` una volta nel suo ambiente,
senza ricompilare nulla.

**c) Nessun monitor nella scheda**
→ il runner ripiega su `MONITOR_URL` se è impostata, altrimenti non pusha (solo
stdout).

**Affidabilità:** il push è **best-effort e mai bloccante** — se il monitor è
irraggiungibile il run non si ferma né fallisce. In caso di fallimento gli eventi
vengono appesi a `flowpilot-monitor-fallback.ndjson` (nella cartella da cui hai
lanciato il runner), così non si perdono.

---

## 9. Segreti

I segreti (password, token, chiavi) **non stanno mai nel piano né nell'artifact**:
il piano ne elenca solo i **nomi**; i **valori** vivono sulla macchina che esegue.

### Come si dichiara un segreto
Nello studio, editor **"Ambienti"** → sezione *Variabili condivise (pool)* →
bottone **"+ segreto"**. Crea una variabile di tipo *segreto*: nel file resta
**solo il nome**, mai il valore (badge 🔒). I segreti non compaiono nella griglia
dei valori-per-profilo (i loro valori non li dà un profilo, li dà la macchina).

### Come si usa un segreto in un job / una lane
Referenzia il segreto con `${NOME}` nella configurazione di una **risorsa** (es.
il campo password di una connessione DB, il token di GitHub, ecc.). Esempio:
`password = ${DB_PASSWORD}`, `host = ${API_HOST}`.

Distinzione importante:
- I `${VAR}` **non-segreti** (host, porta, path…) vengono risolti **nello
  studio** al momento della compilazione, col profilo congelato → finiscono
  come valori nell'artifact. Sono variabili di ambiente, non sensibili.
- I `${SEGRETO}` vengono **lasciati intatti** nell'artifact e risolti **nel
  motore, a run-time**, sulla macchina di destinazione — non passano mai per lo
  studio né per l'artifact.

### Come si forniscono i valori sulla macchina
Il motore risolve un segreto con questo ordine: **1) variabile d'ambiente** con
quel nome; **2) keychain del sistema operativo**.

- **Variabile d'ambiente** (comodo per server/CI, stile 12-factor):
  ```bash
  DB_PASSWORD='...' ./flowpilot_runner artifact.ffart
  ```
- **Keychain del SO** (per il desktop, valore protetto):
  - dallo studio: editor **"Ambienti"** → sezione *Segreti — valori su questa
    macchina* → inserisci il valore e **Salva** (va nel keychain; l'input si
    azzera subito). Vedi anche lo stato ✓ presente / mancante;
  - il valore resta nel keychain di *quella* macchina e non nel progetto.

Su una macchina di destinazione (dove non gira lo studio) userai in genere le
**variabili d'ambiente**; sul desktop di sviluppo il **keychain**.

### In sintesi
Il piano dice *di quali* segreti ha bisogno (nomi in `requiredSecrets`); tu
fornisci i *valori* dove il flusso gira. Cambia macchina/ambiente → cambi solo i
valori, non l'artifact.

---

## 10. Profili di esecuzione (ambienti)

Un **profilo** è un insieme di valori (test/dev/prod) per le **variabili di
pool** condivise del progetto. Il profilo **attivo** determina i valori usati
all'esecuzione; congelando un profilo nell'artifact, quell'artifact esegue in
quell'ambiente.

### Variabili di pool (la fonte unica)
Le variabili condivise si gestiscono nell'editor **"Ambienti"** → *Variabili
condivise (pool)*: le crei, rinomini, dai un valore di default, elimini. Sono
referenziabili con `${nome}` **in ogni lane** (fonte unica, risolta per scope).

### Profili
Sempre in "Ambienti", sezione *Profili*:
- **crea/elimina** profili (es. `test`, `dev`, `prod`);
- per ogni profilo, imposti il **valore di ogni variabile** (vuoto = usa il
  default della variabile);
- scegli il **profilo attivo** — quello usato al Run e quello che verrà
  congelato quando generi l'artifact.

### Congelamento nell'artifact
Nella scheda **"Compila"** scegli il *profilo da congelare*: i suoi valori
vengono applicati al piano al momento della generazione. **Un ambiente per
artifact**: generi un `.ffart` per prod, uno per test, ecc.

### Configurazione su file (import/export dei profili)
I profili possono anche essere **preparati fuori** dallo studio e caricati:

- **Esporta** un profilo → un file JSON, formato:
  ```json
  { "profile": "prod", "values": { "API_HOST": "api.prod.com", "PORT": "5432" } }
  ```
- **Importa** un profilo da file → entra nel progetto; se referenzia variabili
  di pool non ancora presenti, **le crea**.
- Il progetto ricorda il **percorso** del file (`profileRefs`). All'apertura del
  progetto valgono sempre i valori *salvati nel progetto* (nessuna sorpresa); se
  il file esterno è cambiato, con **"ricarica"** reimporti quando vuoi tu.

Regola di fondo: **il progetto è il padrone** (i valori stanno nel `.ffplan`); il
file esterno è comodità — per condividere, versionare a parte, o preparare gli
ambienti fuori.

### Dove stanno i dati nel file di progetto (`.ffplan`)
```
{
  "formatVersion": 2,
  "version": { … },                       // versione corrente
  "plan": { "pool": …, "nodes": …, "edges": … },
  "environments": {
    "active": "prod",                      // profilo attivo
    "profiles": { "test": { … }, "prod": { … } },   // valori per profilo (no segreti)
    "profileRefs": { "prod": "…/prod.env.json" }     // origine su file (opz.)
  },
  "history": [ … ]                         // cronologia versioni
}
```

---

## 11. Generare il riferimento dei nodi (schede-nodo)

Oltre a questo manuale operativo, FlowPilot ha un **riferimento per-nodo**: una
scheda per ciascun tipo di nodo (oggi **47**), generata automaticamente dal
codice. Le schede vivono in **`docs/nodes/`** nel repo — un file `<tipo>.md` per
nodo (es. `source_db.md`, `join.md`) più un indice **`docs/nodes/README.md`**
raggruppato per categoria di palette.

### Com'è fatta una scheda
Ogni scheda ha due parti nette:

- un **blocco AUTO** in cima, tra due marcatori `<!-- gen-node-docs … -->`:
  categoria, descrizione, la **tabella dei campi** di configurazione e la
  **semantica** del nodo (operazioni logiche, tipo di esecuzione, porte di
  ingresso/uscita, runtime preferiti, pushdown…). È generato dal registry dei
  nodi (`NODE_DEFS`) e dalla semantica (`NODE_SEMANTICS`) — **non si modifica a
  mano**: al prossimo `docs:nodes` verrebbe riscritto;
- una sezione **`## Approfondimento`** in fondo: prosa scritta a mano — note
  d'uso, esempi, trabocchetti, buone pratiche. È **tua** e viene **preservata**
  intatta a ogni rigenerazione.

### (Ri)generare le schede
Da **radice del repo**:
```bash
npm run docs:nodes
```
Rilegge il registro dei nodi e riscrive il blocco AUTO di ogni scheda + l'indice.
La sezione «Approfondimento» di ciascuna scheda **non viene toccata**: puoi
rigenerare quante volte vuoi senza perdere quello che hai scritto.

**Quando rilanciarlo:** quando cambi il registro dei nodi — aggiungi un nodo,
cambi un campo, una descrizione o la semantica. La parte automatica si riallinea
al codice; la parte scritta a mano resta.

> Prerequisito: aver fatto `npm install` (§2), che tira giù `tsx` (il generatore
> gira con quello). Le schede committate nel repo sono già pronte da **leggere** —
> il comando serve per **riallinearle** dopo una modifica al codice, non per
> vederle la prima volta.

**Sotto il cofano** (per chi vuole saperne di più): il generatore è
`scripts/gen-node-docs.ts`; legge i metadati dei nodi da `src/nodes/nodeDefs.ts`
(dati puri, senza React) e la semantica da `src/ir/nodeSemantics.ts`.

---

## 12. Riferimento rapido dei comandi

Tutti i `cargo …` da **`src-tauri/`**; gli `npm …` dalla **radice**.

```bash
# --- STUDIO ---
npm install                       # una volta (tira giù anche tsx per le schede)
npm run tauri dev                 # sviluppo (frontend + motore)
npm run tauri build               # app distribuibile

# --- RUNNER (headless, per la distribuzione) ---
cargo build --bin flowpilot_runner --no-default-features --profile release-lean
#   -> target/release-lean/flowpilot_runner
./target/release-lean/flowpilot_runner artifact.ffart          # esegui
MONITOR_URL='http://mon:8787/ingest' \
  ./target/release-lean/flowpilot_runner artifact.ffart        # con ${MONITOR_URL}
DB_PASSWORD='...' ./flowpilot_runner artifact.ffart            # segreto da env

# --- MONITOR ---
cargo build --bin flowpilot_monitor --no-default-features --features monitor --release
#   -> target/release/flowpilot_monitor
./target/release/flowpilot_monitor 8787                        # avvia (porta 8787)
#   vista:  http://localhost:8787/

# --- ARTIFACT ---
#   Non da CLI: dallo studio, bottone "Compila" -> scegli profilo/monitor/piattaforma -> Genera

# --- RIFERIMENTO NODI (schede-nodo) ---
npm run docs:nodes                # (ri)genera docs/nodes/*.md + README dal registro
#   schede: docs/nodes/<tipo>.md ;  indice: docs/nodes/README.md
#   la sezione "Approfondimento" di ogni scheda è scritta a mano ed è preservata

# --- CI (Windows + Linux) ---
#   GitHub -> Actions -> "Build runner" -> Run workflow;  oppure push di un tag vX.Y.Z
```

### Dipendenze di sistema (Linux) — solo per runner/monitor
```bash
sudo apt-get install -y pkg-config libssl-dev libdbus-1-dev
```

---

*Manuale operativo — copre profilatura, compilazione, esecuzione e la generazione
del riferimento nodi. Le singole schede-nodo vivono in `docs/nodes/` (generate e
arricchite come al §11); i progetti di esempio curati sono la parte del tema 2
ancora da fare.*
