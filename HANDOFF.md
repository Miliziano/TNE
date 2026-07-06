# FlowPilot — Documento di passaggio (handoff sessione)

Questo documento serve a riprendere il lavoro su FlowPilot in una nuova
chat senza perdere contesto. Leggilo per intero prima di ripartire, poi
**leggi il repo per lo stato vero** (vedi "Metodo di lavoro").

---

## 1. Cos'è FlowPilot

Tool ETL visuale (canvas a lane, stile Talend): frontend **React/TypeScript
+ Tauri**, motore di esecuzione in **Rust** (`src-tauri/src/engine/`).
Repo pubblico: **https://github.com/Miliziano/TNE** (branch `main`).
L'applicazione grafica è chiamata "studio".

Stack rilevante:
- Frontend canvas: React Flow (`@xyflow/react`), store Zustand (`src/store/flowStore.ts`).
- Costruzione del piano di esecuzione: `buildRustPlan` in `src/components/Toolbar.tsx`.
- Motore: `src-tauri/src/engine/` — `executor.rs` (routing + NodeContext),
  `mod.rs` (engine_run, lifecycle), `bus.rs` (event bus), `events.rs`
  (contratto eventi), `nodes/*.rs` (un file per tipo di nodo).
- Scrittura DB standalone (non-engine): `pg_write`/`mysql_write`/`sqlite_write`
  in `src-tauri/src/lib.rs` (riusate dai nodi sink DB).

Le fasi 0–8 del motore erano già complete a inizio collaborazione
(executor edge-based v6, TMap v3, Filter v2, serializer, badge runtime).

---

## 2. Metodo di lavoro (IMPORTANTE — rispettare queste convenzioni)

- **Leggere sempre il repo per lo stato vero** prima di rispondere/modificare,
  invece di ricostruire a memoria. L'utente preferisce così.
- **Chat corte**: non far incollare file lunghi; leggi dal repo.
- **Modifiche a mano, non patch git**: l'utente preferisce indicazioni
  puntuali ("in questo file, dopo questa riga, aggiungi…") anche se più
  soggette a errore. Per file con molte modifiche, fornire il file intero
  come deliverable è accettabile (l'utente lo copia).
- **Non si può compilare Rust nel sandbox** (manca toolchain + deps Tauri).
  L'utente compila in locale con `npm run tauri dev` (guardare la fase
  `Compiling` nel terminale). Quindi: scrivere codice corretto e idiomatico,
  dichiarare i punti a rischio compilazione, e farsi riportare l'errore cargo.
- **Ragionare ai confini di fase**: proporre design/scoping prima di
  implementazioni grosse; l'utente apprezza. Per i passi piccoli, procedere.
- **Onestà di scoping**: se un "nodo da portare" è in realtà una feature di
  motore (es. sequencer = controllo di flusso), dirlo prima di implementare.
- **Il monitor è lo strumento di collaudo**: un nodo non implementato/rotto
  si riconosce perché riceve righe e ne produce zero (`rows_in>0, rows_out=0`).

Persistenza monitoraggio su disco: file **NDJSON per run** in
`~/.flowpilot/runs/<run_id>.ndjson` (override env `FLOWPILOT_RUNS_DIR`).
Utili per debug: `grep`/`tail` di questi file. Contratto documentato in
`docs/monitoring-schema.md`.

---

## 3. Lavoro COMPLETATO in questa sessione

### Fase 9 — Monitor (COMPLETA)
Obiettivo: finestra Monitor unica che consuma la telemetria Rust,
indipendente da WebKit, con persistenza per artifact headless futuri.
- **Sampler memoria Rust** su thread OS dedicato (`engine/monitor.rs`),
  scoped al run, emette `MemorySample` (thread `fp-mem-sampler`). Sostituisce
  il campionamento JS WebKit-bound.
- **Writer NDJSON** (`engine/reporter.rs`): persistenza PRIMARIA, subscriber
  del bus via `push_event`, thread dedicato `fp-ndjson-writer`, un file per run.
  Ogni riga: `{"v":1,"ts":<ms>,"event":{"type":..,"payload":..}}`.
- **Schema-contratto** versionato in `docs/monitoring-schema.md` (core +
  estensioni, neutro rispetto al linguaggio per futuri emettitori
  Rust/Java/Python headless).
- **Plumbing rejected/rps** nello store (`NodeRunStats.rowsRejected`,
  `throughputRps`) e sui badge del canvas (`RuntimeBadges.tsx`: `⊘ N` rosso
  per rejected, `N/s` mentre gira).
- **Finestra Monitor a 6 tab** (`monitoring/MonitorPanel.tsx`), alimentata
  dal Rust via il polling in `Toolbar.tsx` che instrada gli eventi in
  `MonitoringBus`: **Run/Overview** (aggregati, colli di bottiglia, scarti),
  **Memoria** (curva RSS/PSS + processi), **Nodi** (tabella in/out/rejected/
  durata reale dal Rust), **Timeline** (gantt nodi × curva memoria),
  **Connessioni**, **Loitering**. Il timer JS di memoria è spento in UI
  (`monitor.useExternalMemory()` in `setup.ts`).
- Nota: il tracker **Loitering** ha scovato Map di modulo mai svuotate in
  `TMapModal.tsx` (handle refs) — sistemato con cleanup on-unmount.

### Fase 10 — Eventi Connection per-risorsa (COMPLETA)
- Helper `emit_connection_opened/closed/error` su `NodeContext`
  (`executor.rs`), `NodeContext` reso `#[derive(Clone)]`.
- `source_db` e `sink_db` emettono `ConnectionOpened/Closed/Error` con
  `resource_id` (aggiunto al config, che prima `buildRustPlan` scartava).
  Chiave = risorsa, non nodo (più nodi possono condividere una risorsa).
- Polling in `Toolbar.tsx` instrada i `Connection*` in `MonitoringBus`.
- Tab **Connessioni ad albero** (risorsa → nodi che la usano, con stato e
  durata per nodo). `ConnectionList` in `MonitorPanel.tsx` riscritta.

### Fase 11 (parziale) — Completamento sink_db (FUNZIONANTE)
Il `sink_db` era implementato solo lato UI/Tauri, non nel motore. Sistemato
per la modalità mapping su **PostgreSQL**:
- **DDL**: `create_if_not_exists`/`drop_and_create` dal pannello →
  `CREATE TABLE`/`DROP TABLE IF EXISTS ... CASCADE` generati da `columns_ddl`
  (nome, db_type, nullable, is_pk) — vedi `build_create_table`/`qualified_ddl_table`.
- **Applicazione mapping in scrittura** (`map_row`): il motore NON deve
  dedurre l'SQL dalle chiavi grezze della riga; costruisce la riga da scrivere
  come `riga[sourceField] → colonna dbColumn`, filtrando alle sole colonne
  mappate. Il campo `source` è stato aggiunto a `ColumnDdl`.
- **`onConstraintError`** ora passato dal pannello al motore (prima cadeva sul
  default `"skip"` che INGOIAVA gli errori → "0 scritte senza errore").
- **Quoting coerente**: la DDL NON quota tabella/colonne, per allinearsi
  all'INSERT del motore (`qualified_table` + `build_column_plan` non quotano →
  Postgres abbassa a minuscolo). Prima la DDL quotava (`"ANUOVAFILM"`) e
  l'INSERT non trovava la tabella (`anuovafilm`).

File toccati Fase 11: `src-tauri/src/engine/nodes/sink_db.rs`,
`src-tauri/src/engine/executor.rs`, `src/components/Toolbar.tsx`.
**Da committare** se non già fatto.

Limiti noti sink_db: DDL solo PostgreSQL (mysql/sqlite saltano con avviso);
`batchSize`/`keyFields`/`preSql`/`postSql`/`excludeColumns` del pannello NON
ancora passati al motore.

---

## 4. Inventario nodi (dal routing in `executor.rs` — l'autorità)

**Implementati e funzionanti (~18):** `source_file`, `source_db`,
`sink_file`, `sink_db`, `tmap`, `transform`, `filter`, `aggregate`,
`explode`, `materialize`, `pivot`/`unpivot`, `window`, `json_parser`,
`json_serializer`, `xml_parser`, `xml_serializer`, `bridge`, `log`.

**Implementati ma da correggere/allineare:**
- `sequencer` — implementa la cosa SBAGLIATA (aggiunge un ID incrementale;
  il pannello configura orchestrazione condizionale onOk/onError/always con
  timeout). Va RISCRITTO come controllo di flusso → richiede aggiungere il
  trigger condizionale all'executor (oggi data-flow puro). Feature di motore,
  da progettare.
- `log` — implementato ma **NON STAMPA** (né in-app né su finestre separate,
  che era la modalità d'uso principale dell'utente). Da investigare.
- `union` — gira come concat generico (senza dedup). Union vera da fare.
- `error_handler` — è nella lista passthrough: **non fa niente**. Da
  reintrodurre e sincronizzare (richiesta esplicita utente).

**Non implementati — passthrough/concat** (ricevono input, li concatenano
sull'uscita primaria senza logica):
- `join`, `data_quality` — hanno file `.rs` (94/107 righe) ma NON sono wired
  (l'executor li manda al passthrough). Da finire e agganciare.
- `script` — passthrough (serve runtime espressioni/JS in Rust: costoso).
- `report_generator`, `http_request`, `webhook_responder`.

**Non implementati — connettori di rete (tutti passthrough):**
sources `source_http`/`source_ftp`/`source_mqtt`/`source_kafka`/`source_activemq`;
sinks `sink_http`/`sink_ftp`/`sink_mqtt`/`sink_kafka`/`sink_activemq`;
watcher `dir_watcher`/`watchdog`.

**Non supportati — ERRORE a runtime** (non nel routing → `other => Err`):
`mail_sink`, `shell_exec`, `ssh_exec`. Fanno fallire il run se usati.

---

## 5. Problemi sistemici / trasversali riscontrati

1. **Passaggio config incompleto al motore (SISTEMICO, PRIORITÀ ALTA).**
   `buildRustPlan` sceglie a mano i campi per ogni tipo di nodo e ne lascia
   cadere molti (dimostrato: `onConstraintError`, `batchSize`, `resource_id`
   mancavano al sink). Ogni nodo ne soffre. **Direzione architetturale
   concordata**: studio deve mandare la spec COMPLETA dei tab
   "Configurazione" + "Avanzate", e il motore la esegue — non ne deriva pezzi.

2. **Il motore ricostruisce l'SQL con regole proprie ≠ Preview di studio.**
   È la radice del bug quoting del sink. Studio mostra già in Preview l'SQL
   corretto (parametrizzato, quotato). Il motore dovrebbe ESEGUIRE quella
   spec/quel template (bind valori + validazione contro le colonne reali
   della tabella), non re-inventarlo. Vale per le modalità SQL libero/
   parametrizzato del sink e in generale.

3. **Log del motore Rust non stampano** (modalità d'uso principale utente).

4. **Nodo resta "running" al primo apri-scenario**, diventa "completed" al
   secondo run. Quirk di init dello stato frontend. Minor, si auto-risolve.

5. **Triangolino di warning per-nodo (rimosso, da ripristinare).** Era un
   simbolo (warning giallo) in alto-sinistra di ogni nodo, che mostrava a
   scomparsa i warning su config del nodo e su come era collegato. Da
   ripristinare. Idea utente (valida): oltre alla validazione DAG/IR
   (frontend), aggiungere una verifica **lato motore Rust** (es. colonne/
   tabelle esistono, tipi compatibili). Da fare come layer successivo, DOPO
   che i nodi validano davvero.

6. **`onConstraintError = "skip"` (default) ingoia gli errori**: un sink che
   fallisce tutto appare come "0 scritte, nessun errore", indistinguibile dal
   successo. Quando si rifinisce il sink, un fallimento totale (0 scritte su N)
   dovrebbe emettere almeno un warning.

---

## 6. Programma concordato (ordine consigliato)

**Round 1 — inventario (FATTO, vedi §4) + implementazione nodi mancanti.**
Ma PRIMA di implementare nodi:

0. **FONDAZIONE: passaggio config completo al motore** (§5.1). Sistemica,
   tocca tutto, rende sano ogni passo successivo. PARTIRE DA QUI.
1. **Log del motore** (§5.3) — senza log si implementa alla cieca.
2. **`join`** — ETL core, file da finire, data-flow puro (no deps esterne,
   rischio minimo, valore alto). Primo nodo da implementare.
3. **`data_quality`** — stesso profilo.
4. **`error_handler`** — richiesto, trasversale.
5. **`union` vera** (dedup) — piccola.
6. **Connettori di rete** — blocco a parte (connessioni esterne, deps).
7. **`script`** — ultimo (più costoso).

**Round 2 — rifinitura:** `sequencer` (riscrittura come controllo di flusso),
triangolino warning + validazione motore, `mail_sink`/`shell_exec`/`ssh_exec`
(oggi errore), questioni canvas/logica generale.

Raccomandazione forte: iniziare dalla **fondazione config-passing**, perché è
ciò che è appena "morso" e sblocca la correttezza di tutto il resto.

---

## 7. Da dove ripartire nella prossima chat

Messaggio suggerito da dare all'inizio: "Riprendi FlowPilot da
https://github.com/Miliziano/TNE con questo HANDOFF.md. Partiamo dalla
fondazione config-passing (§6.0): analizza come `buildRustPlan` in
`src/components/Toolbar.tsx` costruisce oggi i config per ogni tipo di nodo,
e proponi la convenzione 'studio manda la spec completa dei tab
Configurazione+Avanzate, il motore la esegue'."

Prima azione consigliata: leggere `buildRustPlan` per intero (il `switch` sui
`node.data.type`) e i pannelli `Panel.tsx` di 2-3 nodi rappresentativi per
capire quali props producono e quali arrivano/non arrivano al motore.

---

## 8. Feat(engine): fondazione spec + nodi DB/log/join + tipi DB corretti
Migrato i nodi alla "busta spec" completa (docs/node-spec.md): studio
manda l'intera config dei tab Configurazione+Avanzate, il motore la
esegue. Niente più selezione a mano dei campi in buildRustPlan.

- spec.rs: accessor tipizzati lassisti + tracking chiavi non consumate
  (i drop diventano telemetria, non silenzio)
- source_db/sink_db: migrati a spec; risolti bug querySchema (schema
  sempre 'public') e hasHeader; attivati batchSize/keyFields/pre-postSql
- log: nuovo evento NodeLog (con lane_id), risolve i log che non
  arrivavano alla UI; semantica allineata al runner legacy
- join: hash join reale (era passthrough); input_left/right su canali
  separati; 7 tipi. customCondition e rightSource=materialize rimandati
- tipi DB → Value: NUMERIC/DECIMAL ora esatti via Value::Decimal (mai
  f64: reggerà Oracle NUMBER, Informix DECIMAL); array PG → array JSON;
  tsvector → null. Risolti rental_rate/replacement_cost che davano null

TODO tracciati in docs/TODO.md (Fase B decimal-aware, custom join, ecc.)
