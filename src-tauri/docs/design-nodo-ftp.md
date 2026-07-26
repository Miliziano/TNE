# Disegno — nodi `source_ftp` e `sink_ftp` in Rust

> Primo nodo (coppia) della sotto-fase **nodi di rete** del porting.
> Riferimenti: `src/runner/sourceFtpExecutor.ts` (126 righe) per il source.
> **Per il sink NON esiste alcun riferimento** — non è mai stato implementato
> nemmeno nel runner JS: si disegna da zero sul modello di `sink_file` +
> la scrittura FTP già presente in Rust.
> Come per lo Script e il report_generator: non si traduce riga per riga, si
> mappa la **funzionalità** su strumenti Rust e si prendono le decisioni qui.

## 0. Il fatto che cambia tutto: la logica FTP in Rust ESISTE GIÀ

`src-tauri/src/lib.rs` contiene, come **comandi Tauri** usati dallo studio (il
pulsante "prova connessione" del pannello risorsa, la lista file, read/write),
un'implementazione FTP/SFTP completa e già funzionante:

- `FtpConnectionParams { protocol, host, port, user, password, keyPath, authType, connectTimeout }`
- `ftp_list(conn, remote_path, pattern, recursive)` → `Vec<FtpFileEntry>`
  (smista su `sftp_list` / `ftp_plain_list` secondo `protocol`)
- `ftp_read(conn, remote_path)` → `String`
- `ftp_write(conn, remote_path, content, create_dirs, atomic)` → byte scritti
- helper `glob_match(pattern, name)` per il filtro `*.csv`
- SFTP via `ssh2` (sincrono, in `spawn_blocking`), FTP/FTPS via `suppaftp` (async)

Tutti i crate necessari sono **già in `Cargo.toml`** (`suppaftp`, `ssh2`,
`futures-util`). **Nessuna nuova dipendenza.** Il porting FTP è quindi
soprattutto **cablaggio**: portare queste funzioni dentro il motore a
streaming, non riscrivere il protocollo.

⚠️ Ma quelle funzioni oggi sono **private in `lib.rs`** e chiamate solo dai
comandi Tauri. Il motore (`engine/`) non può chiamarle così com'è. → D1.

## 1. Cosa fanno i nodi

### `source_ftp` (inventario dal runner)
Sorgente. Riceve la connessione da una **risorsa di lane** (non dai props):
`node.data.config.resourceId` → `spec.resource` nel motore (stesse chiavi di
`FtpConnectionParams`). Props del nodo:

- `remotePath` (default `/`), `filePattern` (glob, opzionale)
- `outputMode`: `content` | `list_files`
  - `list_files`: NON scarica; emette una riga di **metadati per file**
    (`name, path, is_dir, size, modified_at`)
  - `content`: scarica i file che matchano e li **parsa in righe**
- `fileFormat`: `csv` | `json` | `xml` | `raw` (`raw` = una riga col contenuto intero)
- `delimiter` (csv, default `,`)
- `maxFiles` (0 = tutti), `limit` (righe per file, 0 = tutte)
- `onFileError`: `skip` (avvisa e continua) | `stop` (fallisce il nodo)
- Ogni riga in modalità `content` porta i metadati `_filename, _filepath,
  _filesize, _modified_at`.

Porte (da `nodeSemantics`): `input` (innesco/parametri, `maxEdges:1 maxRows:1`,
come le altre sorgenti — R8) → `output`. **Nessun reject.**

### `sink_ftp` (da zero, sul modello di `sink_file`)
Sink. Bufferizza le righe in ingresso, le **serializza** nel formato scelto e
scrive il risultato su un file remoto via `ftp_write`. Speculare a `sink_file`
ma con destinazione FTP invece che disco locale. Props previste (sottoinsieme
allineato a `sink_file`, + specifiche FTP):

- connessione: risorsa di lane (come il source)
- `remotePath` (percorso remoto del file da scrivere)
- `format`: `csv` | `tsv` | `json` | `jsonl` | `xml` | `html` | `excel_b64`
- `writeMode`: `rows` (serializza le righe) | `raw_field` (scrive il valore di
  un campo — es. HTML/base64 da un serializer o report_generator a monte)
- `rawField` (default `content`), `rawEncoding`: `text` | `base64`
- CSV: `delimiter`, `quoteChar`, `writeHeader`, `lineEnding`; JSON: `jsonIndent`,
  `jsonStructure`
- FTP: `createDirs` (crea le cartelle mancanti), `atomic` (scrive `.tmp` poi
  rinomina — **solo SFTP**: `ftp_plain_write` non lo fa)
- `outputMode`: `signal` → emette a valle UNA riga di stato (SIGNAL_SCHEMA come
  sink_file) | (default) niente uscita

Porte: `input` → `output` (passthrough) + `reject`. Sul `reject` v. D4.

## 2. Mappatura su Rust

| Parte | In Rust |
|---|---|
| Connessione + list/read/write FTP/SFTP | **riuso** delle funzioni già in `lib.rs` (v. D1). Zero riscrittura di protocollo. |
| Parsing del contenuto scaricato (source, modalità `content`) | v. D2 — riuso della convenzione di `source_file`. |
| Serializzazione delle righe (sink) | v. D2 — riuso del serializzatore di `sink_file`. |
| Modello del nodo | firme identiche a `source_file`/`sink_file`: `run(ctx, rx, tx)`. Il source drena l'eventuale innesco (R8) e produce su `tx`; il sink richiede `rx` e bufferizza. |
| Filtro `*.csv` | `glob_match` già in `lib.rs`. |

## 3. Le DECISIONI da prendere

### D1 — Dove vive la logica FTP condivisa (**fonte unica**)
Le funzioni FTP sono private in `lib.rs` e chiamate dai comandi Tauri. Il motore
deve chiamare **le stesse**, non una seconda copia (è la malattia che la fase
porte ha curato).
- **(A) Estrarre in un modulo condiviso** — nuovo `src-tauri/src/net/ftp.rs`
  (fuori da `engine/`, così sia i comandi Tauri sia i nodi lo importano):
  `FtpConnectionParams`, `FtpFileEntry`, `ftp_list/read/write`, `glob_match`.
  I comandi Tauri di `lib.rs` diventano wrapper sottili che chiamano il modulo;
  i nodi del motore lo importano direttamente. **Una sola implementazione.**
- (B) Lasciare tutto in `lib.rs`, il motore chiama dentro `lib.rs` — impraticabile
  pulito: `lib.rs` è la radice dell'app Tauri, non una libreria che `engine/`
  importa; creerebbe una dipendenza a rovescio.
- **➡️ Raccomandato: A.** È un rifattoring meccanico (spostamento + reindirizzo dei
  comandi), imposta il pattern per TUTTI i nodi di rete successivi (MQTT, STOMP,
  HTTP hanno la stessa situazione: logica in `lib.rs`, da condividere). ⚠️ Tocca
  `lib.rs`, che NON si compila in sandbox → i punti a rischio vanno dichiarati e
  il collaudo è la compilazione locale.

### D2 — Parsing/serializzazione: riuso vs copia
- **source (`content`)**: `source_file` ha già la convenzione del motore — CSV
  parsato in riga (con lo schema `fields`), mentre `json`/`xml` escono come **una
  riga grezza** che il parser a valle (`json_parser`/`xml_parser`) elabora, e
  `raw` = contenuto intero in un campo.
  - **(A)** `source_ftp` **riusa** quella convenzione: stesso parsing di
    `source_file`, così un CSV letto da disco e uno letto da FTP danno righe
    IDENTICHE. Richiede di estrarre la parte di parsing di `source_file` in un
    helper condiviso (oggi è inline nel suo `run`).
  - (B) `source_ftp` riproduce il parsing multi-formato del runner per conto suo
    → seconda convenzione che diverge.
  - **➡️ Raccomandato: A.** Un solo modo di trasformare "contenuto file → righe".
- **sink**: `sink_file` sa già serializzare le righe in csv/tsv/json/jsonl/xml/
  html/excel. `sink_ftp` deve produrre la **stessa stringa** e poi `ftp_write`.
  - **➡️ Raccomandato:** estrarre il serializzatore di `sink_file` (righe →
    stringa, per formato) in un helper condiviso; `sink_file` scrive su disco,
    `sink_ftp` manda via FTP. Stessa resa byte-per-byte.

### D3 — Ampiezza di v1 / fette
Il source è piccolo (126 righe di runner) e il sink è nuovo ma speculare a
`sink_file`. Propongo **due fette**, una per nodo:
- **Fetta 1 — `source_ftp`.** D1 (estrazione modulo `net/ftp`) + il nodo:
  risorsa→connessione, `list_files` e `content`, glob, `maxFiles`/`limit`,
  metadati file, `onFileError` skip/stop, parsing riusato da `source_file` (D2/A).
  Esce dallo stub (via da `NOT_IMPLEMENTED`, arm nell'executor).
- **Fetta 2 — `sink_ftp`.** Serializzatore riusato da `sink_file` (D2) + scrittura
  remota (`create_dirs`/`atomic`), `writeMode` rows|raw_field, `outputMode` signal.

### D4 — Reject ed errori
- `source_ftp` non ha reject: `onFileError` = `skip` (warn + continua) o `stop`
  (errore di nodo). Coerente col runner. Nessuna novità.
- `sink_ftp` **dichiara** un `reject`, ma scrive **un blob unico** (non riga per
  riga da remoto): non c'è una granularità naturale di "questa riga ha fallito".
  - **(A)** v1: il fallimento della scrittura è un **errore di nodo** (come
    `sink_db`/`sink_file`), il `reject` resta dichiarato ma inerte — allineato al
    debito noto "reject sui sink non ancora implementati" (HANDOFF §6, §9.3).
  - (B) instradare sul `reject` le righe quando la scrittura fallisce in blocco.
  - **➡️ Raccomandato: A** per v1, coerente con gli altri sink; il reject dei sink
    è un capitolo suo, da fare insieme (filter/parser come modello).

## 4. Cosa NON fa v1 (dichiarato)
- Niente `recursive` nella lista (il runner passa `false`; il comando lo supporta
  ma il nodo per ora no).
- Una connessione **per operazione** (come i comandi Tauri: `ftp_read` riapre ogni
  volta). Leggere N file = N connessioni. Ottimizzazione possibile (tenere una
  connessione aperta per tutto il nodo) → nota per un passo suo, non v1.
- FTP/FTPS in chiaro: `atomic` non c'è (`ftp_plain_write` non fa tmp+rename); vale
  solo per SFTP. `ftps` oggi usa lo stesso percorso di `ftp` (nessun TLS esplicito
  in `ftp_plain_connect`) — da verificare quando serve, non v1.
- `list_files` non scarica: `size`/`modified_at` in FTP puro sono spesso 0/None
  (il runner lo eredita da `nlst`). Reale su SFTP.

## 5. Rischi / da verificare in implementazione
- **D1 tocca `lib.rs`** (non compilabile in sandbox): dichiarare i punti a rischio,
  collaudo = build locale. Lo spostamento delle funzioni deve conservare le firme
  che i comandi Tauri già usano.
- Estrazione del parsing di `source_file` e del serializer di `sink_file`: sono
  **inline** nei rispettivi `run`. L'estrazione va fatta senza cambiare il
  comportamento dei due nodi già portati (diff di rendering/output invariato).
- `spec.resource` deve arrivare popolato al nodo: verificare che `buildRustPlan`
  metta la risorsa risolta nella busta spec anche per i nodi FTP (per `source_db`
  lo fa; confermare che valga per resourceId di tipo FTP).
- SFTP è sincrono in `spawn_blocking`: dentro un nodo del motore (già in un task
  Tokio) va bene, ma non bloccare il thread async — riusare esattamente il pattern
  `spawn_blocking` di `lib.rs`.
