# FlowPilot — Manuale di compilazione ed esecuzione (Linux e Windows)

> Guida operativa completa: prerequisiti, build dello **studio**, del **runner** e del
> **monitor**, il flusso end-to-end dallo studio all'esecuzione firmata, e la
> configurazione dei **segreti**. Comandi affiancati per Linux e Windows.
>
> Questo manuale assume applicata la catena di firma degli artifact (P314–P319):
> gli `.ffart` escono **firmati** (`formatVersion: 2`) e il runner li **verifica**.
> Riferimento di design: `HANDOFF-firma-artifact.md`.

---

## 1. Architettura in due minuti

Quattro pezzi, tre macchine possibili (spesso separate):

- **Studio** (app desktop Tauri) — dove disegni la pipeline, dichiari i segreti,
  e **compili** l'artifact. Possiede la **chiave privata di firma**.
- **Artifact** (`.ffart`) — un file JSON firmato che contiene il *piano* + il
  *manifesto* (planHash, firma, keyId). **Non contiene segreti**: solo i loro nomi.
- **Runner** (`flowpilot_runner`) — binario headless che **verifica** ed **esegue**
  l'artifact su un server. Possiede il **trust store** (chiavi pubbliche autorizzate).
- **Monitor** (`flowpilot_monitor`) — servizio web opzionale che raccoglie i log delle
  esecuzioni (NDJSON) e li mostra.

File di configurazione per-utente (creati al bisogno):

| Percorso (Linux/macOS) | Percorso (Windows) | Cosa contiene |
|---|---|---|
| `~/.flowpilot/studio.json` | `%USERPROFILE%\.flowpilot\studio.json` | identità (etichetta) dello studio |
| `~/.flowpilot/signing-key.json` | `%USERPROFILE%\.flowpilot\signing-key.json` | **chiave privata** di firma (0600) — solo studio |
| `~/.flowpilot/trust-store.json` | `%USERPROFILE%\.flowpilot\trust-store.json` | chiavi **pubbliche** autorizzate — solo runner |
| `~/.flowpilot/runs/` | `%USERPROFILE%\.flowpilot\runs\` | log completi delle esecuzioni (reporter locale) |
| `~/.flowpilot/monitor-data/` | `%USERPROFILE%\.flowpilot\monitor-data\` | dati del monitor (default) |

---

## 2. Prerequisiti

### Comuni (tutte le macchine che compilano)
- **Rust** ≥ 1.81 (`rustup`), con `cargo` nel PATH.
- **Node.js** ≥ 18 e **npm** (solo per lo studio).
- **Git**.

### Linux (Debian/Ubuntu) — pacchetti di sistema

Per **studio** (webview Tauri v2):
```bash
sudo apt update
sudo apt install -y build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev librsvg2-dev libssl-dev \
  libayatana-appindicator3-dev libxdo-dev
```
> Su distro non-Debian usa gli equivalenti; vedi i prerequisiti ufficiali di Tauri v2.

Per **runner** e **monitor** (headless, niente webview) basta molto meno:
```bash
sudo apt install -y pkg-config libssl-dev libdbus-1-dev
```
- `libssl-dev` → il runner usa HTTPS per spingere al monitor (`reqwest`).
- `libdbus-1-dev` → supporto keychain (`keyring`, Secret Service) per i segreti.

### Windows — strumenti
- **Visual Studio Build Tools** con il workload *"Sviluppo di applicazioni desktop con C++"* (MSVC + Windows SDK).
- **WebView2 Runtime** (di norma già presente su Windows 10/11; altrimenti installalo — serve **solo allo studio**, non al runner/monitor).
- **Rust** e **Node** come sopra (installer ufficiali).

---

## 3. Ottenere il codice

```bash
git clone https://github.com/Miliziano/TNE.git
cd TNE
npm install          # dipendenze frontend dello studio
```
> `npm install` serve per lo studio. Runner e monitor si costruiscono con `cargo` da `src-tauri/` e non richiedono `npm`.

---

## 4. Compilare ed eseguire lo STUDIO

Lo studio ha la feature `desktop` (default → tira dentro Tauri + i plugin).

**Sviluppo** (hot-reload):
```bash
npm run tauri dev
```

**Bundle di produzione** (installer/eseguibile):
```bash
npm run tauri build
```
Gli artefatti finiscono in `src-tauri/target/release/bundle/`:
- Linux: AppImage e/o `.deb` (secondo configurazione).
- Windows: installer `.msi`/`.exe` in `...\bundle\msi\` o `...\nsis\`.

> Al **primo export** lo studio genera la chiave di firma in `~/.flowpilot/signing-key.json`
> (Windows: `%USERPROFILE%\.flowpilot\`). Da lì in poi ogni artifact esce firmato.

---

## 5. Compilare il RUNNER (headless)

Dalla cartella `src-tauri/`, **senza** la feature desktop (niente Tauri/webview):

**Linux**
```bash
cd src-tauri
cargo build --bin flowpilot_runner --no-default-features --release
# → target/release/flowpilot_runner
```
Variante ottimizzata per dimensione (come in CI):
```bash
cargo build --bin flowpilot_runner --no-default-features --profile release-lean
# → target/release-lean/flowpilot_runner
```

**Windows** (PowerShell)
```powershell
cd src-tauri
cargo build --bin flowpilot_runner --no-default-features --release
# → target\release\flowpilot_runner.exe
```

Uso di base:
```bash
./target/release/flowpilot_runner  esempio.ffart
```
```powershell
.\target\release\flowpilot_runner.exe  esempio.ffart
```
Il runner stampa **NDJSON** su stdout (un evento per riga) e, se configurato, spinge gli stessi eventi al monitor.

---

## 6. Compilare ed eseguire il MONITOR (opzionale)

```bash
cd src-tauri
cargo build --bin flowpilot_monitor --no-default-features --features monitor --release
# → target/release/flowpilot_monitor
```

Avvio (porta opzionale, default **8787**):
```bash
# Linux
MONITOR_TOKEN=un-segreto-lungo ./target/release/flowpilot_monitor 8787
```
```powershell
# Windows
$env:MONITOR_TOKEN="un-segreto-lungo"; .\target\release\flowpilot_monitor.exe 8787
```
Poi apri `http://localhost:8787`. Endpoint: `POST /ingest` (NDJSON), `GET /api/runs`, `GET /api/runs/<id>`.

Variabili d'ambiente del monitor:

| Variabile | Default | Effetto |
|---|---|---|
| `MONITOR_TOKEN` | (nessuno) | se impostata, `/ingest` la **esige**; se assente, il monitor accetta push da chiunque raggiunga la porta |
| `MONITOR_DATA_DIR` | `~/.flowpilot/monitor-data` | dove persiste i dati |
| `MONITOR_MAX_RUNS` | 200 | tetto run conservate |
| `MONITOR_MAX_EVENTS` | 50000 | tetto eventi conservati |

> Il monitor parla **HTTP in chiaro** (nessun TLS integrato). In produzione mettilo dietro
> un reverse proxy con TLS e imposta sempre `MONITOR_TOKEN`.

---

## 7. Flusso completo end-to-end (esempio)

Scenario: una pipeline legge da Postgres e scrive un file; gira su un server Linux e
spinge i log a un monitor. La firma è in `enforce`.

### 7.1 Nello studio (macchina dello sviluppatore)
1. Disegna la pipeline. Sulla risorsa Postgres, nei campi di connessione, usa i
   **riferimenti a segreto** dove serve — es. password: `${DB_PASSWORD}` (vedi §8).
2. Dichiara i segreti nel pannello ambienti (`EnvironmentsModal` → **+ secret**): qui
   metti solo il **nome** (`DB_PASSWORD`); il valore non viene mai salvato nel file.
3. Apri la scheda di **compilazione**: scegli il profilo da congelare, l'URL del
   **monitor** (letterale o `${MONITOR_URL}`), la piattaforma, il livello di log.
4. Nel blocco **Identità di firma**, premi **"Copia voce trust store"** — è la riga da
   autorizzare sul server (vedi 7.2).
5. **Genera** → salva `esempio.ffart`. L'artifact esce **firmato** (`formatVersion: 2`).

### 7.2 Enrollment della chiave sul server (una tantum)
Sul server crea/edita `~/.flowpilot/trust-store.json` e incolla la voce copiata
nell'array `keys`:
```json
{
  "keys": [
    {
      "keyId": "ed25519:9f3c…",
      "publicKey": "0KfE…base64…",
      "owner": "mark-laptop",
      "status": "active"
    }
  ]
}
```
> Trasferisci la voce **out-of-band** (non serve nessun collegamento studio↔server).
> Per **revocare**: metti `"status": "revoked"` o togli la riga.

### 7.3 Sul server: segreti, monitor, esecuzione
Imposta i segreti come **variabili d'ambiente** (headless → via più affidabile):
```bash
# Linux
export DB_PASSWORD='S3cr3t!'
export MONITOR_URL='https://monitor.interno:8787/ingest'
export MONITOR_TOKEN='un-segreto-lungo'          # per farsi accettare dal monitor
export FLOWPILOT_SIGNATURE_MODE=enforce
./target/release/flowpilot_runner esempio.ffart
```
```powershell
# Windows (PowerShell)
$env:DB_PASSWORD='S3cr3t!'
$env:MONITOR_URL='https://monitor.interno:8787/ingest'
$env:MONITOR_TOKEN='un-segreto-lungo'
$env:FLOWPILOT_SIGNATURE_MODE='enforce'
.\target\release\flowpilot_runner.exe esempio.ffart
```

Cosa vedrai (stderr):
```
firma OK: artifact firmato da mark-laptop (ed25519:9f3c…)
```
e gli eventi NDJSON su stdout (più il monitor, se raggiungibile). Se la firma non
tornasse, in `enforce` il runner stampa `FIRMA RIFIUTATA (enforce): …` ed esce con
codice **3**, senza eseguire nulla.

---

## 8. SEGRETI — configurazione ed esempi

### 8.1 Il modello
- **Dichiarazione** (studio): un segreto è una *variabile di pool* di tipo `secret`.
  Nel file di progetto e nell'artifact **si salva solo il NOME**, mai il valore.
- **Riferimento** (config risorsa): scrivi `${NOME}` dove vuoi il valore — password,
  token, host, interi pezzi di stringa di connessione.
- **Risoluzione** (a runtime, sulla macchina che esegue): `${NOME}` viene sostituito
  con il valore risolto in quest'ordine:
  1. **variabile d'ambiente** `NOME`;
  2. **keychain del SO** (service `flowpilot`): Keychain macOS / Credential Manager
     Windows / Secret Service Linux.
  - Se il segreto **non** si risolve, `${NOME}` resta **intatto** (nessun valore
    fittizio): lo vedrai tale e quale nei log — segnale chiaro che manca.

> L'artifact è quindi **trasportabile senza rischi**: i valori vivono solo sulla
> macchina di destinazione.

### 8.2 Dichiarare un segreto nello studio
Nel pannello ambienti (`EnvironmentsModal`):
1. **+ secret** → dai il nome, es. `DB_PASSWORD` (solo il nome).
2. Nella sezione *Secrets — valori su questa macchina (keychain)* puoi impostare il
   valore **sul computer dello studio** (finisce nel keychain, per test/anteprima).
   Questo NON viaggia con l'artifact.
3. Nei campi della risorsa, referenzia `${DB_PASSWORD}`.

### 8.3 Provisioning sulla macchina di esecuzione

**Opzione A — variabili d'ambiente (consigliata sui server headless)**
```bash
# Linux
export DB_PASSWORD='S3cr3t!'
export API_TOKEN='abc123'
```
```powershell
# Windows (sessione corrente)
$env:DB_PASSWORD='S3cr3t!'
$env:API_TOKEN='abc123'
# persistente per l'utente:
setx DB_PASSWORD "S3cr3t!"
```
> Con `systemd`, usa `Environment=` o `EnvironmentFile=` nella unit; evita di lasciare
> i segreti nella history della shell.

**Opzione B — keychain del SO**
- Windows: **Credential Manager** (lo studio installato sulla macchina può scriverli;
  service `flowpilot`). Funziona anche headless.
- macOS: **Keychain**.
- Linux: **Secret Service** (GNOME Keyring/KWallet) — spesso **assente o bloccato** su
  un server senza sessione desktop: in quel caso usa le **env** (Opzione A).

### 8.4 Esempi di riferimento nei config
- Password DB: campo *password* = `${DB_PASSWORD}`.
- Stringa di connessione con più pezzi:
  `postgres://app:${DB_PASSWORD}@db.interno:5432/warehouse`.
- Header di autenticazione HTTP: `Authorization: Bearer ${API_TOKEN}`.
- Endpoint del monitor come segreto/variabile d'ambiente: nella scheda di
  compilazione metti `${MONITOR_URL}` e a runtime esporta `MONITOR_URL=…`.

### 8.5 Verifica e diagnosi
- Nello studio, il pannello ambienti mostra per ogni segreto se è **presente** sulla
  macchina corrente (env o keychain).
- A runtime, se nei log compare un `${NOME}` **non** sostituito → quel segreto non è
  impostato sulla macchina che esegue. Impostalo (env o keychain) e riesegui.
- `requiredSecrets` nell'anteprima del manifesto elenca i **nomi** che l'artifact si
  aspetta di trovare a destinazione.

### 8.6 Regole di sicurezza
- Non committare mai valori di segreti; il repo e l'artifact contengono **solo nomi**.
- Il token del monitor (`MONITOR_TOKEN`) vive **nell'ambiente della macchina che
  esegue**, mai nell'artifact.
- La chiave **privata** di firma non lascia la macchina dello studio; sul server c'è
  solo la **pubblica** nel trust store.

---

## 9. Verifica della firma — riepilogo operativo

Modalità del runner via `FLOWPILOT_SIGNATURE_MODE`:

| Valore | Comportamento |
|---|---|
| `off` | nessuna verifica (solo sviluppo locale isolato) |
| `warn` (default) | verifica e **avvisa** su fallimento, ma **esegue** (utile per migrare gli `.ffart` non firmati) |
| `enforce` | **rifiuta ed esce** (codice 3) su artifact non firmato / chiave non autorizzata / firma non valida / piano manomesso. **Consigliato in produzione** |

Cosa controlla (fail-closed): busta firmata presente (`formatVersion ≥ 2`) → motore
compatibile → `keyId` presente e **attivo** nel trust store → firma valida (con la
chiave del trust store) → `planHash` ricalcolato dal piano == quello firmato.

> In `enforce` con trust store **vuoto**, nessun artifact passa: è corretto. Autorizza
> prima almeno una chiave (§7.2).

---

## 10. Variabili d'ambiente — tabella riassuntiva

**Runner** (`flowpilot_runner`)

| Variabile | Effetto |
|---|---|
| `FLOWPILOT_SIGNATURE_MODE` | `off` \| `warn` (default) \| `enforce` |
| `MONITOR_URL` | override dell'endpoint monitor (`.../ingest`); altrimenti usa quello nel manifesto |
| `MONITOR_TOKEN` | token per farsi accettare da `/ingest` del monitor |
| `FLOWPILOT_RUN_ID` | impone l'id d'esecuzione (utile in CI o per rieseguire) |
| *(segreti)* | qualunque `${NOME}` referenziato nei config risorsa |

**Monitor**: vedi §6.

---

## 11. Cheat sheet

**Build**
```bash
# Studio (dev / bundle)
npm run tauri dev
npm run tauri build

# Runner (da src-tauri/)
cargo build --bin flowpilot_runner  --no-default-features --release
cargo build --bin flowpilot_runner  --no-default-features --profile release-lean

# Monitor (da src-tauri/)
cargo build --bin flowpilot_monitor --no-default-features --features monitor --release
```

**Esecuzione (Linux)**
```bash
MONITOR_TOKEN=… ./target/release/flowpilot_monitor 8787 &
export DB_PASSWORD=… MONITOR_URL=https://host:8787/ingest MONITOR_TOKEN=…
FLOWPILOT_SIGNATURE_MODE=enforce ./target/release/flowpilot_runner esempio.ffart
```

**Esecuzione (Windows/PowerShell)**
```powershell
$env:MONITOR_TOKEN="…"; Start-Process .\target\release\flowpilot_monitor.exe 8787
$env:DB_PASSWORD="…"; $env:MONITOR_URL="https://host:8787/ingest"; $env:MONITOR_TOKEN="…"
$env:FLOWPILOT_SIGNATURE_MODE="enforce"; .\target\release\flowpilot_runner.exe esempio.ffart
```

---

## 12. Troubleshooting

- **`cannot find module or crate 'tauri'` compilando il runner** → hai compilato senza
  `--no-default-features`, oppure un comando dello studio non è dietro
  `#[cfg(feature = "desktop")]`. Il runner va **sempre** `--no-default-features`.
- **`FIRMA RIFIUTATA (enforce): chiave non autorizzata`** → il `keyId` dell'artifact
  non è nel `trust-store.json` del server (o è `revoked`). Fai l'enrollment (§7.2).
- **`FIRMA RIFIUTATA (enforce): planHash non combacia`** → l'artifact è stato modificato
  dopo la firma; riesporta dallo studio.
- **`${NOME}` compare nei log** → segreto non impostato sulla macchina che esegue; vedi §8.3.
- **Il monitor risponde `401`/rifiuta l'ingest** → `MONITOR_TOKEN` sul runner non
  combacia con quello del monitor.
- **Linux: errore di link su `-lssl`/`-ldbus`** → mancano `libssl-dev`/`libdbus-1-dev`
  (build) o le relative librerie a runtime.
- **Il keychain non trattiene i segreti su un server Linux** → nessun Secret Service
  attivo/sbloccato: usa le variabili d'ambiente (§8.3, Opzione A).
