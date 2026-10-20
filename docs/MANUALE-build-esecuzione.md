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
- **Rust** via `rustup`, con `cargo` nel PATH. La versione è **fissata** dal repo
  (`src-tauri/rust-toolchain.toml`, oggi **1.99.1**): al primo `cargo` dentro
  `src-tauri/` rustup la scarica da solo. Non serve sceglierla a mano.
- **Node.js** ≥ 18 e **npm** (solo per lo studio).
- **Git**.

### Linux (Debian/Ubuntu) — pacchetti di sistema

Per **studio** (webview Tauri v2):
```bash
sudo apt update
sudo apt install -y build-essential curl wget file pkg-config \
  libwebkit2gtk-4.1-dev librsvg2-dev libssl-dev \
  libayatana-appindicator3-dev libxdo-dev unixodbc-dev
```
> Su distro non-Debian usa gli equivalenti; vedi i prerequisiti ufficiali di Tauri v2.

Per **runner** e **monitor** (headless, niente webview) basta molto meno:
```bash
sudo apt install -y pkg-config libssl-dev libdbus-1-dev unixodbc-dev
```
- `libssl-dev` → il runner usa HTTPS per spingere al monitor (`reqwest`).
- `libdbus-1-dev` → supporto keychain (`keyring`, Secret Service) per i segreti.
- `unixodbc-dev` → ODBC per Oracle, Informix e sorgenti ODBC generiche (P344). Il
  gestore ODBC è collegato **dinamicamente**: dove si **esegue** studio o runner serve
  il pacchetto di runtime (`sudo apt install unixodbc`; su macOS `brew install unixodbc`),
  anche se non si usano Oracle/Informix — senza, il binario non parte. Su Windows il
  gestore ODBC fa parte del sistema.

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

Avvio (porta opzionale, default **8787**; ascolta solo su **127.0.0.1** salvo
`MONITOR_BIND`). Servono **due token diversi**, o non parte:
```bash
# Linux
MONITOR_TOKEN=$(openssl rand -hex 32) MONITOR_READ_TOKEN=$(openssl rand -hex 32) \
  ./target/release/flowpilot_monitor 8787
```
```powershell
# Windows
$env:MONITOR_TOKEN="<token-ingest>"; $env:MONITOR_READ_TOKEN="<token-lettura>"; .\target\release\flowpilot_monitor.exe 8787
```
Poi apri `http://localhost:8787` (il browser chiede la password: utente qualsiasi,
password = `MONITOR_READ_TOKEN`). Endpoint: `POST /ingest` (NDJSON, token di ingest),
`GET /api/runs`, `GET /api/runs/<id>` (token di lettura).

Variabili d'ambiente del monitor:

| Variabile | Default | Effetto |
|---|---|---|
| `MONITOR_BIND` | `127.0.0.1` | indirizzo d'ascolto (`0.0.0.0` per la rete: meglio un reverse proxy TLS) |
| `MONITOR_TOKEN` | **obbligatoria** | token di **ingest** (runner), min 16 caratteri |
| `MONITOR_READ_TOKEN` | **obbligatoria** | token di **lettura** (vista/API), diverso dal precedente |
| `MONITOR_INSECURE_LOCAL` | spenta | `1` = token facoltativi, solo su loopback (prove locali) |
| `MONITOR_MAX_BODY_BYTES` / `MONITOR_RATE_BYTES_PER_MIN` | 8 MiB / 64 MiB | dimensione massima di un push / volume per IP al minuto |
| `MONITOR_AUTH_FAIL_MAX` / `MONITOR_WORKERS` | 20 / 16 | password di lettura errate per IP al minuto / richieste in parallelo |
| `MONITOR_DATA_DIR` | `~/.flowpilot/monitor-data` | dove persiste i dati |
| `MONITOR_MAX_RUNS` | 200 | tetto run conservate |
| `MONITOR_MAX_EVENTS` | 50000 | tetto eventi conservati |

> Il monitor parla **HTTP in chiaro** (nessun TLS integrato). In produzione lascialo su
> 127.0.0.1 dietro un reverse proxy con TLS. Dettagli: `FlowPilot-Manuale-Monitor.md` §6.

---

## 7. Flusso completo end-to-end (esempio)

Scenario: una pipeline legge da Postgres e scrive un file; gira su un server Linux e
spinge i log a un monitor. La firma è **sempre verificata** dal runner (§9).

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
Salva la voce copiata in un file (es. `voce.json`), portala sul server **out-of-band**
(non serve nessun collegamento studio↔server) e autorizzala **come l'utente che
eseguirà il runner** (il trust store è `~/.flowpilot/trust-store.json` di quell'utente):
```bash
./flowpilot_runner trust add voce.json --owner mark-laptop
#   chiave autorizzata
#     keyId (fingerprint): ed25519:9f3c…
```
- `--owner` è **obbligatorio** (finisce nell'audit: "firmato da …"). La voce esportata
  dalla voce *Signing* ha `owner` vuoto: lo decidi tu qui.
- **Confronta il fingerprint** stampato con quello mostrato nello studio dello
  sviluppatore, su un canale fidato (di persona, telefono): è l'unico passo che lega
  la chiave a una persona.
- Il runner controlla che il `keyId` sia davvero il fingerprint della chiave pubblica,
  crea il file con permessi `600` (cartella `700`) e lo scrive in modo atomico.

Altri comandi:
```bash
./flowpilot_runner trust list                 # chiavi presenti e stato
./flowpilot_runner trust show ed25519:9f3c…   # una voce per intero
./flowpilot_runner trust revoke ed25519:9f3c… # revoca (la riga resta, per l'audit)
./flowpilot_runner trust add --public-key <B64> --owner NOME   # senza file
# --store <percorso> su ogni comando trust: gestisce un file diverso dal default
```
> Una chiave **revocata** non si riattiva con `trust add` (la revoca di solito vuol
> dire compromissione): se è davvero voluto, va modificato il file a mano.
>
> Il trust store resta un JSON leggibile (`{"keys":[{keyId, publicKey, owner, status}]}`),
> ma il runner è **rigoroso**: file assente, JSON non valido o **scrivibile da chiunque**
> → rifiuta di eseguire; voci incoerenti (keyId ≠ fingerprint) → ignorate con avviso.

### 7.3 Sul server: segreti, monitor, esecuzione
Imposta i segreti come **variabili d'ambiente** (headless → via più affidabile):
```bash
# Linux
export DB_PASSWORD='S3cr3t!'
export MONITOR_URL='https://monitor.interno:8787/ingest'
export MONITOR_TOKEN='un-segreto-lungo'          # per farsi accettare dal monitor
./target/release/flowpilot_runner esempio.ffart
```
```powershell
# Windows (PowerShell)
$env:DB_PASSWORD='S3cr3t!'
$env:MONITOR_URL='https://monitor.interno:8787/ingest'
$env:MONITOR_TOKEN='un-segreto-lungo'
.\target\release\flowpilot_runner.exe esempio.ffart
```

Cosa vedrai (stderr):
```
firma OK: artifact firmato da mark-laptop (ed25519:9f3c…)
```
e gli eventi NDJSON su stdout (più il monitor, se raggiungibile). Se la firma non
tornasse, il runner stampa `FIRMA RIFIUTATA: …` ed esce con codice **3**, senza
eseguire nulla.

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

### 8.5b Oracle, Informix e ODBC generico (dal P344)

Il motore li raggiunge via **ODBC**. Sulla macchina che esegue (runner, o studio per
anteprima e schema) servono:

| Database | Driver del fornitore | Nome tipico del driver |
|---|---|---|
| Oracle | Oracle Instant Client **Basic** + pacchetto **ODBC** (`odbc_update_ini.sh` lo registra) | `Oracle 23 ODBC driver` (dipende dalla versione) |
| Informix | IBM Informix **Client SDK** (CSDK), che include il driver ODBC | `IBM INFORMIX ODBC DRIVER` (predefinito se il campo è vuoto) |
| Altri | il driver ODBC del prodotto (SQL Server, DB2, …) | come registrato |

Nella risorsa DB dello studio:
- **Oracle**: host, porta (1521), *Service name* (vuoto = campo Database), utente,
  password e **Driver ODBC** (obbligatorio, oppure un DSN). La connessione usa
  EZConnect (`host:porta/servizio`), senza `tnsnames.ora`.
- **Informix**: host, porta (9088), *Server (DBSERVERNAME)*, database, utente, password.
  Driver facoltativo (default `IBM INFORMIX ODBC DRIVER`). Per l'UTF-8 aggiungi nei
  *Parametri aggiuntivi* `CLIENT_LOCALE=en_US.utf8;` (e `DB_LOCALE` se il DB lo richiede).
- **ODBC generico**: un **DSN** configurato sulla macchina oppure una **connection
  string** completa.
- Il driver si indica per **nome** (come in `odbcinst.ini`: `odbcinst -q -d` li elenca)
  oppure con il **percorso** della libreria (es. `/opt/oracle/instantclient_23_5/libsqora.so.23.1`).
- `${SEGRETO}` funziona in tutti i campi, come per gli altri database.

Stato (P347): **lettura** — nodo `source_db`, anteprima, "Rileva schema", test di
connessione — e **scrittura** — nodo `sink_db` con insert, truncate+insert, upsert,
update, delete, merge; creazione/ricreazione della tabella; SQL pre/post; "Load
constraints" legge la chiave primaria dal catalogo del database.

Come si comportano UPSERT e MERGE:

| Database | UPSERT | MERGE |
|---|---|---|
| PostgreSQL | `INSERT … ON CONFLICT` | `MERGE` nativo (PostgreSQL 15+), condizione libera ammessa |
| Oracle | UPDATE sulle chiavi, INSERT se nessuna riga | `MERGE` nativo, condizione libera ammessa |
| Informix, ODBC generico | come Oracle | uguale a UPSERT sulle chiavi (condizione libera rifiutata) |
| MySQL, SQLite | nativo | **non disponibile**: usa UPSERT |

**Transazioni (dal P347).** Un gruppo transazionale **native** funziona anche su
Oracle, Informix e ODBC generico: i membri scrivono sulla stessa connessione con
autocommit spento e a fine lane il gruppo fa COMMIT, oppure ROLLBACK se anche un solo
membro è fallito. Differenze rispetto a PostgreSQL:
- **XA non disponibile** su ODBC: il nodo si ferma con un messaggio; usa un gruppo
  native con una sola risorsa;
- la **creazione/ricreazione della tabella** avviene *prima e fuori* dalla transazione
  (Oracle conferma da solo ogni DDL, e dentro il gruppo confermerebbe anche le righe
  degli altri membri): un ROLLBACK non elimina la tabella creata;
- **TRUNCATE+INSERT** in transazione svuota con `DELETE` (annullabile), non con `TRUNCATE`.

**Master-detail (pass-through, dal P347).** La chiave del master passa al detail:
- se la riga porta già il valore della colonna chiave (per esempio da una sequenza),
  si usa quello — su qualunque database;
- se lo genera il database: **Oracle** con `RETURNING … INTO` (colonna IDENTITY o
  trigger con sequenza), **Informix** con il valore SERIAL/BIGSERIAL appena assegnato;
  su **ODBC generico** non esiste un modo portabile e il nodo si ferma spiegandolo.

Collaudo su un database vero (dalla macchina con il driver installato, nella cartella
`src-tauri`): `FP_ORACLE_TEST="<connection string>" cargo test --lib tests_live -- --ignored`
(o `FP_INFORMIX_TEST`). Crea e cancella la tabella `FP_COLLAUDO_K` e verifica chiavi
generate, MERGE e rollback.

Limiti noti: una cella di testo di dimensione non dichiarata (CLOB, TEXT, LVARCHAR
lunghi) può essere al massimo di 64 Ki caratteri, oltre il nodo si ferma con un errore
di troncamento (mai un valore tagliato in silenzio). In modalità *tabella* su **ODBC
generico** limit/offset non hanno una sintassi portabile: scrivili nella query.

### 8.5c Installare ODBC e i driver (Oracle, Informix)

Tre pezzi, tutti sulla macchina che esegue e **mai nell'artifact**: il gestore ODBC, la
libreria client del fornitore e il suo driver ODBC. Architettura a **64 bit** in tutti e
tre.

**1. Gestore ODBC.**
- Linux: `sudo apt install unixodbc` (Debian/Ubuntu) oppure `sudo dnf install unixODBC`
  (RHEL/Fedora). Oracle consiglia unixODBC 2.3.11 con Instant Client 23ai.
- macOS: `brew install unixodbc`.
- Windows: già presente (Amministrazione origine dati ODBC, `odbcad32.exe` a 64 bit).

**2a. Oracle — Instant Client + ODBC.**
- Linux: scarica *Basic* (o *Basic Light*) e *ODBC* della stessa versione da Oracle
  (Instant Client Downloads), scompattali nella **stessa** cartella, per esempio
  `/opt/oracle/instantclient_23_26`, poi:
  ```bash
  cd /opt/oracle/instantclient_23_26
  sudo ./odbc_update_ini.sh / /opt/oracle/instantclient_23_26
  echo /opt/oracle/instantclient_23_26 | sudo tee /etc/ld.so.conf.d/oracle-ic.conf && sudo ldconfig
  odbcinst -q -d          # deve comparire il driver Oracle (nome tipo "Oracle 23ai ODBC driver")
  ```
  Il primo argomento di `odbc_update_ini.sh` è la cartella di unixODBC (`/` se installato
  dai pacchetti, con `odbcinst.ini` in `/etc`). In alternativa al nome registrato, nel
  campo *Driver ODBC* della risorsa puoi mettere il percorso della libreria
  `…/libsqora.so.23.1`.
- Windows: scompatta *Basic* e *ODBC* nella stessa cartella, esegui `odbc_install.exe`
  da lì (registra il driver) e aggiungi la cartella al `PATH`.
- macOS: Oracle pubblica il pacchetto *ODBC* per Apple Silicon (DMG accanto a *Basic*);
  installali con `install_ic.sh` come da pagina di download e registra la libreria in
  `odbcinst.ini` di Homebrew (`odbcinst -j` mostra dove sta).

**2b. Informix — Client SDK (CSDK).**
- Installa l'Informix **Client SDK** (HCL/IBM, 64 bit): contiene il driver ODBC.
- Linux/macOS: imposta l'ambiente del processo che esegue (servizio del runner o
  shell dello studio):
  ```bash
  export INFORMIXDIR=/opt/informix
  export LD_LIBRARY_PATH=$INFORMIXDIR/lib:$INFORMIXDIR/lib/cli:$INFORMIXDIR/lib/esql:$LD_LIBRARY_PATH
  ```
  e registra il driver in `/etc/odbcinst.ini`:
  ```ini
  [IBM INFORMIX ODBC DRIVER]
  Description = Informix ODBC (CSDK)
  Driver      = /opt/informix/lib/cli/iclit09b.so
  ```
  Il nome tra parentesi quadre è quello che FlowPilot usa se il campo *Driver ODBC* è
  vuoto. Errori tipici: `libifgls.so` non trovata → manca `lib/esql` nel percorso
  librerie; `sqlhosts` non trovato o server sconosciuto → la risorsa deve avere *Server
  (DBSERVERNAME)* uguale al nome del server Informix (se il driver lo pretende comunque,
  aggiungi la voce in `$INFORMIXDIR/etc/sqlhosts`).
- Windows: il CSDK registra il driver da solo (`iclit09b.dll`). Controlla in
  `odbcad32.exe` (scheda *Driver*) il nome esatto: se compare con un suffisso, ad
  esempio "(64-bit)", scrivilo così nel campo *Driver ODBC*.
- Caratteri accentati: nei *Parametri aggiuntivi* della risorsa
  `CLIENT_LOCALE=en_US.utf8;` (e `DB_LOCALE` uguale a quello del database).

**3. Verifica.** Dallo studio, *Test connessione* sulla risorsa. Dal terminale, con
unixODBC: `isql -v -k "Driver={Oracle 23ai ODBC driver};DBQ=host:1521/servizio;UID=…;PWD=…"`.
Per i servizi systemd del runner le variabili d'ambiente (`INFORMIXDIR`,
`LD_LIBRARY_PATH`, `TNS_ADMIN`, `NLS_LANG`) vanno nel file del servizio
(`Environment=`), non nel profilo dell'utente.

### 8.6 Regole di sicurezza
- Non committare mai valori di segreti; il repo e l'artifact contengono **solo nomi**.
- Il token del monitor (`MONITOR_TOKEN`) vive **nell'ambiente della macchina che
  esegue**, mai nell'artifact.
- La chiave **privata** di firma non lascia la macchina dello studio; sul server c'è
  solo la **pubblica** nel trust store.

---

## 9. Verifica della firma — riepilogo operativo

La verifica è **sempre attiva** e non si può spegnere (dal P333 non esistono più le
modalità `off`/`warn`: erano un rischio di configurazione — un default dimenticato o
l'`off` dello sviluppo copiato in produzione = verifica saltata in silenzio). Se
`FLOWPILOT_SIGNATURE_MODE` è ancora impostata, il runner la **ignora** e lo dice.

Cosa controlla (fail-closed, uscita **3** e nulla eseguito al primo fallimento):
trust store presente, leggibile, valido e **non scrivibile da chiunque** → busta
firmata presente (`formatVersion ≥ 2`) → motore compatibile → `keyId` presente e
**attivo** nel trust store → firma valida (con la chiave del trust store) →
`planHash` ricalcolato dal piano == quello firmato.

> Con trust store **assente o vuoto** nessun artifact passa: è corretto. Autorizza
> prima almeno una chiave (§7.2). Vale anche in sviluppo: per provare il runner sulla
> tua macchina, autorizza la tua stessa chiave una volta
> (`trust add <voce copiata da Signing> --owner <te>`).

---

## 10. Variabili d'ambiente — tabella riassuntiva

**Runner** (`flowpilot_runner`)

| Variabile | Effetto |
|---|---|
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
MONITOR_TOKEN=… MONITOR_READ_TOKEN=… ./target/release/flowpilot_monitor 8787 &
export DB_PASSWORD=… MONITOR_URL=https://host:8787/ingest MONITOR_TOKEN=…
./target/release/flowpilot_runner trust add voce.json --owner mark-laptop   # una tantum
./target/release/flowpilot_runner esempio.ffart
```

**Esecuzione (Windows/PowerShell)**
```powershell
$env:MONITOR_TOKEN="…"; $env:MONITOR_READ_TOKEN="…"; Start-Process .\target\release\flowpilot_monitor.exe 8787
$env:DB_PASSWORD="…"; $env:MONITOR_URL="https://host:8787/ingest"; $env:MONITOR_TOKEN="…"
.\target\release\flowpilot_runner.exe trust add voce.json --owner mark-laptop   # una tantum
.\target\release\flowpilot_runner.exe esempio.ffart
```

---

## 12. Troubleshooting

- **Il runner o lo studio non partono: `libodbc.so.2: cannot open shared object file`**
  → manca il gestore ODBC: `sudo apt install unixodbc` (macOS: `brew install unixodbc`).
- **`Can't open lib '…'`** (ODBC) → il driver del fornitore non è installato, oppure
  `odbcinst.ini` indica la libreria senza percorso assoluto: indica il percorso completo
  nel campo *Driver ODBC*, o correggi `odbcinst.ini`.
- **`Data source name not found`** → nome del driver o del DSN sbagliato: `odbcinst -q -d`
  elenca i driver registrati, `odbcinst -q -s` i DSN.

- **`cannot find module or crate 'tauri'` compilando il runner** → hai compilato senza
  `--no-default-features`, oppure un comando dello studio non è dietro
  `#[cfg(feature = "desktop")]`. Il runner va **sempre** `--no-default-features`.
- **`FIRMA RIFIUTATA: trust store assente`** → su questa macchina (per questo utente)
  non è autorizzata nessuna chiave: `flowpilot_runner trust add …` (§7.2).
- **`FIRMA RIFIUTATA: trust store scrivibile da CHIUNQUE`** → `chmod 600` sul file (e la
  cartella non deve essere scrivibile da altri).
- **`FIRMA RIFIUTATA: chiave non autorizzata`** → il `keyId` dell'artifact
  non è nel `trust-store.json` del server (o è `revoked`). Fai l'enrollment (§7.2).
- **`FIRMA RIFIUTATA: planHash non combacia`** → l'artifact è stato modificato
  dopo la firma; riesporta dallo studio.
- **`${NOME}` compare nei log** → segreto non impostato sulla macchina che esegue; vedi §8.3.
- **Il monitor risponde `401`/rifiuta l'ingest** → `MONITOR_TOKEN` sul runner non
  combacia con quello del monitor (il token di **lettura** non vale per l'ingest).
- **Il monitor non parte: "token obbligatori mancanti"** → imposta `MONITOR_TOKEN` e
  `MONITOR_READ_TOKEN`; solo per prove locali `MONITOR_INSECURE_LOCAL=1`.
- **Linux: errore di link su `-lssl`/`-ldbus`** → mancano `libssl-dev`/`libdbus-1-dev`
  (build) o le relative librerie a runtime.
- **Il keychain non trattiene i segreti su un server Linux** → nessun Secret Service
  attivo/sbloccato: usa le variabili d'ambiente (§8.3, Opzione A).
