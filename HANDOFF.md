# FlowPilot — Documento di passaggio (handoff sessione)

Questo documento serve a riprendere il lavoro su FlowPilot in una nuova
chat senza perdere contesto. Leggilo per intero prima di ripartire, poi
**leggi il repo per lo stato vero** (vedi "Metodo di lavoro").

Sostituisce l'handoff precedente. Aggiornato a: **1 agosto** — ultima consegna
di riferimento: **P127**. La **FASE PORTING è CONCLUSA**: `NOT_IMPLEMENTED` è
vuota, restano solo 3 "manuali" (mail_sink, shell_exec, ssh_exec). Per tutto ciò
che è cambiato da P106 leggi l'**appendice finale "stato al P127"**; l'intestazione
storica qui sotto (27 lug, P93b) resta per contesto.

--- (storico) ---
Aggiornato a: **27 luglio** — ultima consegna di riferimento: **P93b**. Da P47 a oggi: chiuso il porting del nodo
**Script** (P58-73) e del **report_generator** (P74-78); aggiunta la
**persistenza** salva/apri (P79); portata l'intera famiglia dei **nodi di
rete** (FTP, MQTT, HTTP client con tutti gli auth incl. digest reale,
dir_watcher); avviata la **SERVICE MODE** (token di cancellazione per-run,
P93). Restano pochi stub (§6) e un punto aperto sul **nodo stop** (§9).

> Le sezioni 1-5 (cos'è, metodo, architettura, contratto spec, contratto
> porte) e 6.1 (error handling) sono la stesura precedente e sono ancora
> valide. Aggiornate il 27 lug: intestazione, §6, §8, §9; aggiunte §6.2 (fase
> porting) e §6.3 (service mode).

---

## 1. Cos'è FlowPilot

Tool ETL visuale (canvas a lane, stile Talend): frontend **React/TypeScript
+ Tauri**, motore di esecuzione in **Rust** (`src-tauri/src/engine/`).
Repo pubblico: **https://github.com/Miliziano/TNE** (branch `main`).
L'applicazione grafica è chiamata "studio".

**Visione.** Lo studio serve a *progettare e verificare*; il motore Rust
è l'*unico esecutore*. Gli artifact progettati saranno distribuiti ed
eseguiti **compilati, senza il motore grafico** — perciò tutto ciò che
esegue vive nel motore, e gli eventi del motore alimentano monitor e log.
Obiettivo finale: **un solo punto di generazione, N target** — dallo
stesso piano si genereranno artifact Rust, Java, Python (ed eventualmente
TypeScript). V. `src-tauri/docs/architettura-pipeline.md`.

**I progetti sono fatti di lane.** Dentro una lane vivono nodi e flussi.
Le lane sono **entità completamente isolate** tra loro: comunicano SOLO
tramite i nodi bridge (`bridge_in`/`bridge_out`). La lane è l'unità di
isolamento — e domani un processo/artifact separato. Registro dataset,
pool connessioni, transazioni, variabili: tutto è per-lane. Mai
introdurre stato globale che scavalchi il confine di lane.

Stack rilevante:
- Canvas: React Flow (`@xyflow/react`), store Zustand (`src/store/flowStore.ts`).
- Piano di esecuzione: `buildRustPlan` in `src/components/Toolbar.tsx` —
  produce nodi con **busta spec** + archi, consumato dal motore.
  🔴 **ATTENZIONE: i builder di piano sono DUE e non portano le stesse
  cose.** `canvasToIR` (`src/ir/lowering.ts`, usato da `pipeline.ts`)
  serve **validazione e codegen TS**; il piano che arriva al MOTORE nasce
  solo da `buildRustPlan`. Ogni ragionamento su "cosa riceve il motore"
  parte da lì — leggere l'IR ha già portato fuori strada due volte (v. §8).
- Parser FPEL (unico, condiviso): `src/ir/exprParser.ts`.
- Motore: `src-tauri/src/engine/` — `executor.rs` (routing + NodeContext),
  `spec.rs` (contratto spec, accessor, telemetria chiavi non consumate),
  `expr.rs`/`expr_functions.rs` (valutazione IR FPEL), `datasets.rs`
  (registro dataset per-lane), `pool.rs`/`txregistry.rs` (risorse e
  transazioni per-lane), `bus.rs`/`events.rs`/`monitor.rs` (telemetria),
  `nodes/*.rs` (un file per tipo di nodo).
- Runner JS legacy: `src/runner/` — **è la vecchia versione (backend JS)**,
  tenuta SOLO come riferimento per riscrivere i nodi in Rust. Man mano che
  un nodo va su Rust, il suo executor JS **si cancella** (import +
  registrazione in `executors.ts` + file). A fine porting la cartella
  sparisce.

Persistenza monitoraggio: NDJSON per run in
`~/.flowpilot/runs/<run_id>.ndjson` (env `FLOWPILOT_RUNS_DIR`).
Contratto: `src-tauri/docs/monitoring-schema.md`.

---

## 2. Metodo di lavoro (IMPORTANTE — rispettare queste convenzioni)

- **Leggere sempre il repo per lo stato vero** prima di rispondere o
  modificare. Non ricostruire a memoria. Se l'utente ha pushato,
  ri-clonare/riallineare e verificare.
- **Chat corte**: non far incollare file lunghi; leggere dal repo.
- **Consegna del lavoro (dal 20 lug): un file `.patch` per consegna.**
  Claude clona il repo, modifica nella propria copia e consegna il
  risultato di `git diff` come `.patch`; l'utente fa `git apply`, compila,
  committa e pusha lui. Claude NON pusha (niente credenziali, e il
  cancello di qualità è la compilazione locale dell'utente). La patch è
  tagliata sull'**ultimo commit pushato**: se l'albero locale ha lavoro
  non committato sugli stessi file, `git apply` fallisce — è già successo
  (v. §8). Consegnare sempre `git apply --check` come primo passo.
- **Rust nel sandbox (aggiornato al P336):** `cargo` c'è e, installando le librerie
  webkit (`libwebkit2gtk-4.1-dev` & co. via apt), si compila anche lo STUDIO (feature
  `desktop`), oltre a runner e monitor; si lanciano i test. La toolchain del repo è
  fissata (`src-tauri/rust-toolchain.toml`) ma il sandbox non scarica toolchain da
  static.rust-lang.org: lì si usa `RUSTUP_TOOLCHAIN=stable cargo … --ignore-rust-version`.
  L'utente ricompila comunque prima di committare (`npm run tauri dev`, runner, monitor):
  resta il cancello finale, e collaudi con servizi veri (DB, FTP, MQTT, LDAP) sono suoi.
- **Ragionare ai confini di fase**: design/scoping prima di
  implementazioni grosse. Le decisioni di design/prodotto si SOTTOPONGONO
  all'utente (opzioni A/B con raccomandazione), non si prendono a mano.
  Le decisioni puramente tecniche si prendono leggendo il codice e si
  motivano.
- **Onestà di scoping**: se un lavoro nasconde una feature di sistema,
  dirlo prima. Se emerge un bug preesistente, segnalarlo e proporre
  A (fedele all'esistente + TODO) / B / C — non allargare lo scope in
  silenzio.
- **Il monitor è lo strumento di collaudo**: nodo rotto = `rows_in>0,
  rows_out=0`. La telemetria `log_unconsumed` segnala le props non lette
  dal motore (drop reali vs testo-sorgente il cui compilato vive in
  spec.config — v. §4).
- Dopo il push dell'utente, **verificare l'allineamento** (ri-clonare e
  controllare che le modifiche attese siano arrivate) prima di proseguire.

---

- **Verificare interrogando i moduli veri, non con regex**: `npx tsx` con
  uno script che importa e stampa (path ASSOLUTI negli import). Gli audit
  a espressioni regolari hanno già mentito due volte.
- **Test sintetici invece di chiedere conferme**: costruire nodi/archi
  finti e passarli a `runValidation`/`getNodePorts` prova una tesi in un
  minuto, senza far riaprire scenari all'utente.
- **Chiedere `git status --short` prima di dare la colpa alla propria
  consegna**: se il typecheck passa da noi e non da lui, il problema è
  nel suo albero.
---

## 3. Architettura decisa (DEFINITIVA)

Documento: `src-tauri/docs/architettura-pipeline.md`. In sintesi:

- **D1 — Un solo piano di record**: quello che riceve il motore Rust
  (nodi con busta spec + archi). È il formato di esecuzione E l'input dei
  codegen futuri (Rust artifact, Java, Python, eventualmente TS). Il
  `LogicalPlan` di `src/ir/` NON è un secondo piano.
- **D2 — `src/ir/` = libreria di analisi design-time del builder**:
  `exprParser.ts` è il compilatore FPEL canonico; `dagValidation` +
  `ValidationIssue` + `nodeSemantics` sono il sistema di validazione live
  — **acceso in Fase 13** (badge sui nodi + pannello Validazione, click
  su un problema centra il canvas sul nodo).
  `nodeSemantics` è oggi anche il **contratto delle porte** (v. §5).
  `schemaPropagation` è doppia (`ir/` vs `utils/schemaUtils`) — debito noto.
- **D3 — Codegen TypeScript congelato** (`src/codegen/typescript/` +
  CodegenPanel): nessun lavoro nuovo. NB non dipende da `src/runner/`
  (verificato: `grep -rn runner src/codegen` è vuoto).

**Principio di validazione (doppio strato)** —
`src-tauri/docs/design-validazione.md`: migrare l'esecuzione al motore
NON sposta la validazione. Trasformazione (tipizzare/compilare) → motore.
Verifica → resta nel builder: errori bloccanti per il sicuramente
sbagliato + warning non bloccanti per il sospetto-ma-legale. Il motore
ri-valida tutto come errori parlanti (esecuzione headless). Ridondanza
voluta.

**Principio di copertura** (deciso 15 lug): *tutti* i nodi in palette
devono essere implementati in Rust. Se qualcosa va rifatto — come lo
script — **va programmato**, non lasciato implicito. Un buco non si
tollera in silenzio.

**Principio della fonte unica** (la lezione della fase in corso): quando
due componenti descrivono la stessa cosa, divergono — e nessuno se ne
accorge finché qualcosa non si rompe in silenzio. Finché una
dichiarazione non è *l'unica* fonte, ognuno se la riscrive addosso.
## 4. Il contratto spec e il pattern di migrazione

Contratti (in `src-tauri/docs/`):
- `node-spec.md` — la busta spec: props verbatim camelCase dai pannelli,
  default normati nel documento, telemetria chiavi non consumate, sezioni
  per nodo (§3 source_db, §4 sink_db, §6 log, §7 join, §8 explode,
  §9 aggregate). SQL custom eseguito verbatim. Decimal mai via f64.
- `expr-ir-schema.md` — forma JSON dell'IR FPEL (ExprNode): tag `kind`
  PascalCase, operatori MAIUSCOLI, `Cast.target_type` in snake_case
  (unica eccezione), Literal untagged. È il contratto che leggeranno i
  codegen. ⚠ la prima versione consegnata diceva `targetType`: ERRATA,
  corretta in `target_type`.
- `monitoring-schema.md` — eventi NDJSON.
- Design: `design-linguaggio-espressioni.md` (FPEL),
  `design-materialize-registry.md` (registro dataset),
  `design-union.md`, `design-validazione.md`, `architettura-pipeline.md`.
- TODO: `TODO.md`, `TODO-arco-dataset.md`.

**Regola dove vive un dato** (decisa con aggregate, "Opzione 1"):
- dato grezzo del pannello → **props** (verbatim; CSV → `str_list`,
  JSON-string → `json_or`);
- struttura COMPILATA (IR FPEL) → **`spec.config`** sotto chiave dedicata.
Meccanismo builder: variabile `specConfig = {...node.data.config}` a cui
i nodi che compilano aggiungono l'IR; la busta usa `specConfig`
(`config: specConfig` — riga comune a tutti i nodi, sicura perché
superset di node.data.config).

**Checklist migrazione di un nodo** (pattern rodato su explode/aggregate):
1. Sezione §N in `node-spec.md` (tabella props + default + semantica).
2. `<nodo>.rs`: `Spec::from_ctx(&ctx.spec)` + `config_from_spec(&spec)`
   (accessor: `str_or`, `bool_or`, `usize_or`, `str_list`, `json_or`;
   strutture compilate: `serde_json::from_value(spec.config().clone())`)
   + `spec.log_unconsumed("<nodo>", &ctx.node_id.0)`. Logica invariata.
3. Builder: il `case` non rinomina più in snake_case; o sparisce (nodo
   senza compilazione: explode) o scrive l'IR in `specConfig` (nodo FPEL:
   aggregate). Le VALIDAZIONI del case restano nel builder (design-
   validazione) e si duplicano come errori parlanti nel motore.
4. ⚠️ NON cancellare l'executor JS in `src/runner/`: decisione utente del
   15 lug — resta come implementazione di RIFERIMENTO finché il porting
   non è finito (v. §7). Il passo 4 del pattern originale è SOSPESO.
5. Nota: `log_unconsumed` segnalerà come non consumate le props di testo
   FPEL sorgente (es. `aggFunctions`, `having`): atteso — il compilato
   vive in spec.config. Non è un drop.

---

## 5. Il contratto delle porte (`src/ir/nodeSemantics.ts`) — FONTE UNICA

Nato dalla **Fase porte** (luglio, in corso). Prima le porte di un nodo
erano descritte in **quattro posti** che divergevano: `FlowNode.tsx`
cablava `{ id:'output', show:true }` su ogni nodo, `HANDLE_MAP` in
`schemaRegistry` diceva la sua, `nodeSemantics.staticOutputPorts`
un'altra, e i lowerer (`laneBoundaryLowerer`, `scriptLowerer`) si
ricopiavano le porte a mano. Su 43 tipi, **16 divergevano**.

Oggi `NodeSemantics` dichiara tutto:

- `staticInputPorts: PortSpec[]` / `staticOutputPorts: PortSpec[]`
  (entrambi **obbligatori**: chi aggiunge un nodo non può dimenticarli,
  il typecheck glielo dice).
- `producesMultipleOutputs: boolean` — disambigua il *vuoto*:
  `[] + true` = porte **dinamiche** (tmap, filter, json_parser,
  xml_parser: le calcola il resolver dalla config); `[] + false` =
  **nessuna uscita** (bridge_out, lane_end, webhook_responder).
  Combacia esattamente con i due regimi del motore.
- `PortSpec = { id, label, isReject, role?, when? }`
  - **`id` = nome del filo** (deve combaciare con l'handle disegnato e
    con ciò che il motore cerca: `take_primary_output` prova `"output"`
    per primo). **`label` = cosa esce** (es. id `output`, label
    `passthrough`). Non confonderli: id sbagliato = archi scollegati.
  - `role: 'data' | 'signal' | 'reject' | 'catch'` — cosa PORTA la porta.
    Da qui discende la regola di schema.
  - `when: { prop, equals?, notEquals?, fallback? }` — la porta esiste
    solo se la config lo dice. **Due porte con lo stesso `id` e `when`
    mutuamente esclusive sono legittime e volute**: è il modo di dire
    "questa porta cambia natura secondo la configurazione".

**Chi lo consuma** — tutti derivano, nessuno riscrive:
- `getNodePorts(node)` in `src/utils/schemaRegistry.ts` = **il resolver**:
  statiche dal contratto con `when` applicato + dinamiche (switch per i
  4 tipi) + **`catch` universale** (onError='propagate'). Ritorna
  `PortSpec[]` completi. `getNodeHandles` è una vista per id.
- `FlowNode.tsx` disegna gli handle di uscita da lì.
- `lowering.ts` → `buildOutputPorts` usa i lowerer specifici per i 4
  dinamici, altrimenti il contratto.
- `dagValidation` → `EDGE_FROM_UNDECLARED_PORT` (**error**): un arco che
  parte da una porta non dichiarata.

⚠️ **Gli INGRESSI non sono ancora derivati**: `FlowNode` disegna
`<Handle id="input">` **sempre, cablato** (~riga 170) — è il gemello del
vecchio `show:true`. Il contratto ora è corretto (le sorgenti hanno
`['input']`: un source_file può ricevere il path da monte, un source_db
la query), ma nessuno lo legge ancora per gli input. NB i nodi a ingressi
multipli (join `input_left`/`input_right`, union `input_1/2`, tmap
`input_main`, error_handler `catch`) vanno verificati: se usano
`FlowNode`, oggi hanno un solo handle disegnato → c'è un'altra
divergenza sotto.

**`outputMode` — il vocabolario unico di cosa esce verso valle.**
Valori: `none | passthrough | signal`. Implementato nel motore **solo da
`sink_file`** (`sink_file.rs`, SIGNAL_SCHEMA). Dichiarato oggi da
`sink_file` e dallo **script** (P18: sezione "Uscita verso valle" nel
pannello — Dati / Innesco / Niente; per lo script è pura dichiarazione
design-time, il motore non deve cambiare). Per gli altri sink e per
`bridge_out` il motore NON emette la riga di segnale: dichiararlo senza
implementarlo sarebbe una bugia silenziosa → va con la fase porting.

> 📝 **NOTA UTENTE (16 lug)**: la sezione "**Uscita verso valle**" del
> pannello script **va ridiscussa e quantomeno spostata di posizione**,
> più avanti, **durante il restyling**. Non è una decisione chiusa: la
> collocazione attuale (sotto "Modalità", sopra "Linguaggio") è
> provvisoria.

---

## 6. Lo stato reale del motore (audit di copertura — agg. 27 lug)

**Non fidarsi delle mappe: interrogare il motore.** La lista autorevole è
`NOT_IMPLEMENTED` in `executor.rs` (i nodi ancora stub), tenuta allineata a
mano con `MOTORE_NON_IMPLEMENTA` in `dagValidation.ts`: chi porta un nodo lo
toglie da ENTRAMBE — riverificare che coincidano a ogni consegna.

**`NOT_IMPLEMENTED` ora VUOTA** (agg. 1 ago, dopo P127): la fase porting è
**chiusa**. Restano senza arm nel motore solo **3 nodi mai portati** — i
"manuali": `mail_sink, shell_exec, ssh_exec`. Ora che la lista è vuota il ramo
passthrough `is_stub` è morto: un tipo senza arm cade in
`other => Err("Tipo nodo non supportato")` (non più inoltro silenzioso).
NB: `mail_sink` ha GIÀ l'infra SMTP in lib.rs (crate `lettre`) → porting =
cablaggio; `shell_exec`/`ssh_exec` sono i due sostanziali (sensibili →
sicurezza reale). `data_quality` ha il suo arm (implementato). Il dettaglio del
lavoro P108→P127 è nell'**appendice finale "stato al P127"**.

**Portati da luglio (P58→P93):** Script (FPEL), report_generator, FTP
source/sink, MQTT source/sink, HTTP client (source_http + http_request +
sink_http con 7 auth incl. digest reale, retry, paginazione), dir_watcher.
V. §6.2.

**Già implementati prima:** source_file, source_db, sink_file, sink_db,
bridge_out/in, tmap, log, join, transform, aggregate, explode, materialize,
json/xml serializer+parser, filter, pivot, data_quality, window, union,
**error_handler** (+ `bridge.rs` a livello `engine/`).

**I due regimi di porte** (invariato): `filter`, `json_parser`, `xml_parser`,
`tmap` ricevono l'intera mappa `outputs` e gestiscono i reject; gli altri
usano `take_primary_output` (una porta) → i `reject` dichiarati per
explode/join/materialize/sink_* restano DA IMPLEMENTARE. Modello: filter e i
parser. Decisione utente: i reject servono, vanno implementati.

## 6.1 Error handling nel motore (fase motore, 20-22 lug) — FINITO E COLLAUDATO

Il modello completo sta in `DISEGNO-error-handling.md`. Qui il minimo per
non rifare le stesse scoperte.

**DUE CANALI.** *Dati*: righe `_error_*` sulla porta `catch`, dentro il
nodo, livello riga (pattern del reject). *Controllo*: eccezione di nodo →
error_handler, livello nodo. Sono separati: non è la transazione a
emettere il catch, ed il rollback è un binario a parte dalla notifica.

**L'EH è un NODO NORMALE con un COLLETTORE A CANALE**, non un'entità di
fine lane (il primo tentativo, a registro, è stato buttato). L'executor
crea un `mpsc` per lane; il receiver arriva all'EH sotto l'handle
**`catch`** — porta LOGICA (`connectable:false`, R9), che nessun arco del
canvas può occupare, così `run_node` non cambia firma. Ogni spawn è un
wrapper attorno a `run_node`: se il nodo torna `Err` **e** delega
all'handler, la riga `_error_*` parte sul canale **appena l'errore
capita**. L'EH drena in streaming ed emette su `error_out`: la
sotto-pipeline dell'utente lavora mentre la lane gira ancora.

**Terminazione, senza casi speciali**: il canale si chiude quando l'ultimo
produttore droppa il sender. 🔑 Compresa **la copia dell'executor**, che
va droppata subito dopo il loop di spawn — senza quel `drop` l'EH resta in
ascolto per sempre (stesso principio del `drop(target_tx)` nel wiring).

**Deadlock circolare evitato**: l'EH e i nodi della sua **sotto-pipeline**
(BFS a valle di `error_out`, per `source_node`) non ricevono il sender del
collettore. Conseguenza accettata: un errore *dentro* la sotto-pipeline
dell'EH non può tornare all'EH — resta fatale e visibile solo su
`NodeFailed`.

**`critical` INTERROMPE** (decisione utente: abort immediato dei task
ancora vivi, non "lascia finire bloccando i sink"). Il flag viaggia sulla
riga come `_error_critical` — l'EH non vede il piano, vede solo ciò che
gli arriva — ed è dichiarato in `ERROR_HANDLER_SCHEMA` (non in
`CATCH_SCHEMA`: la criticità appartiene al canale di controllo), quindi
l'utente può filtrarci sopra. L'EH chiama `LaneAbort::fire()`
(`engine/abort.rs`) **dopo** aver registrato ed emesso quella riga: la
notifica esce prima che la lane venga fermata. Il registro è **per-lane**
(verificato su un grafo a due lane: la lane sana prosegue). I task
abortiti tornano `JoinError::is_cancelled()` → arm dedicato: **non sono
panic e non scrivono `lane_result`**, la causa resta il nodo critico.

**Ordine finale**: `fire()` → nodi interrotti → collettore chiuso → l'EH
conclude → la sotto-pipeline dell'EH conclude → `finalize_with_outcome`
(rollback) → `close_all`. Quindi la notifica è già scritta quando parte il
rollback — ma ⚠️ se il sink d'errore sta nello **stesso gruppo
transazionale** della pipeline principale, il rollback se la porta via.

**CROSS-LANE: il bridge porta anche il controllo.** Oltre alle righe, ogni
bridge ha un `oneshot` con cui il BridgeOut dichiara "consegna conclusa",
mandato *prima* di lasciar cadere il canale dati. Se quel segnale non
arriva, il BridgeIn sa che la lane sorgente è morta a metà e **fallisce
come nodo normale** — quindi l'errore va all'error handler della lane di
valle, che decide con le sue regole; marcare «critico» il BridgeIn ferma
anche quella lane. Il disegno è vincolato da un fatto di Tokio: **un task
abortito non esegue altro codice**, quindi la lane morente non può
avvisare nessuno e l'unico segnale affidabile è l'ASSENZA della conferma.

⚠️ **Limite da conoscere, verificato sul campo.** Se un nodo della lane
sorgente fallisce **senza** essere critico, la lane non viene interrotta:
il BridgeOut conclude regolarmente — magari con 0 righe — e manda la
conferma. La lane di valle riceve "consegna completa, 0 righe" e prosegue
verde: se ha dei sink, **scrivono vuoto**. Non è aggirabile a quel
livello (quando il BridgeOut finisce, la sua lane non sa ancora di essere
fallita: l'esito si compone a fine lane; e far attendere il BridgeIn
serializzerebbe la lane di valle senza impedire le scritture, perché i
sink scrivono man mano). **Regola operativa: se il fallimento della lane
sorgente deve contare per quella di valle, il nodo va marcato «critico».**
È scritto anche nel pannello del nodo Bridge, dove serve.

**Cosa resta**: `_error_code` e `_error_row` (richiedono un errore di nodo
STRUTTURATO al posto di `Result<_, String>`: 25+ punti, è un passo suo) e
il riconoscimento dei fallimenti DERIVATI — oggi `RunFailed` elenca tutte
le lane fallite senza poter dire quale sia la causa e quale la
conseguenza.

---

## 6.2 FASE PORTING degli stub (P58→P93) — quasi finita

Ordine deciso dall'utente: error_handler (fatto in fase motore) → Script →
report_generator → nodi di rete → (restano watchdog/activemq/kafka).

- **Script (P58-73):** rifatto su **FPEL** — mini-linguaggio di istruzioni
  compilato a IR, NON un motore JS (che avrebbe reso il nodo opaco al codegen
  per sempre). Così lo schema d'uscita è calcolabile e il nodo è traducibile.
  Grammatica Monaco propria, tipi di ritorno, variabili di lane scrivibili.
  Disegno: `src-tauri/docs/design-nodo-script.md`.
- **report_generator (P74-78):** HTML/SVG costruiti a mano + Excel via
  `rust_xlsxwriter` (solo dati); formattazione condizionale, DQ, KPI, grafici.
  Disegno: `src-tauri/docs/design-nodo-report-generator.md`.
- **Persistenza (P79):** salva / salva-con-nome / apri (file `.ffplan`) — era
  il grande buco di uno studio ETL. Toolbar + flowStore.
- **Nodi di rete.** 🔑 La logica di connessione (FTP/SFTP, MQTT, ActiveMQ via
  STOMP, SMTP) ESISTE GIÀ in `lib.rs` come comandi Tauri: per questi il porting
  è **cablaggio** — il nodo del motore chiama una `*_impl` pub estratta dal
  comando. Fatti: FTP source/sink (P80-82), MQTT source/sink (P83-84),
  dir_watcher (P90-91, watch a eventi reali via `notify`). Il **client HTTP**
  invece NON esisteva in Rust (il runner usava `fetch` TS): portato da ZERO in
  reqwest — source_http (nucleo condiviso) + http_request + sink_http, con 7
  auth (incl. **digest reale** RFC, crate `md-5` — quello del runner era finto,
  mandava Basic), retry, paginazione (P85-89). Disegno FTP:
  `src-tauri/docs/design-nodo-ftp.md`.

## 6.3 SERVICE MODE (in corso) — nodi che vivono oltre la lane

Nato dall'osservazione che `dir_watcher` in watch e i **webhook**
(receiver/responder, oggi server long-running in `lib.rs`) devono restare
attivi finché non li fermi — cosa che il motore, strettamente FINITO (attende
che OGNI task-nodo ritorni), non permette ancora. Disegno completo:
`src-tauri/docs/design-service-mode.md`.

- **Watch fase 1 (P91, FATTO):** `dir_watcher` watch aspetta l'evento REALE del
  SO (crate `notify`), single-shot → resta finito → gira già nel motore.
- **Plumbing (P93, FATTO):** `tokio_util::CancellationToken` per-run, registro
  globale `run_id→token` in `engine_run`, campo `cancel` nel `NodeContext`,
  comando `stop_run(run_id)`. Puro plumbing: nessun nodo lo usa ancora.
- **Da fare:** nodo `stop` funzionale (§9), watch fase 2, i due webhook come
  nodi-servizio (`select!` fra evento e `cancel`).

## 7. `src/runner/` — CODICE MORTO, ma NON cancellare

19 file, 6045 righe di executor TypeScript. **Nessuno lo importa**
(verificato con grep, barrel incluso); il codegen TS non lo nomina; il
suo `transactionCoordinator.ts` è già stato cancellato e lascia un import
penzolante in `src/io/types.ts:20`.

🛑 **Decisione utente (15 lug): NON si cancella finché il porting non è
finito** — serve come **implementazione di riferimento** dei nodi ancora
da portare. ⚠️ Rischio noto: il commit `1cc8e83` lo aggiornò *per
riflesso* durante un lavoro sui parser → si stava mantenendo codice morto.
Se resta, andrebbe **marcato** (intestazione "CODICE MORTO — riferimento
per il porting, non aggiornare").

Piano archiviato per quando si cancellerà: `git rm -r src/runner`;
spostare `export type Row = Record<string, unknown>` in
`src/io/readers.ts` e cancellare `src/io/types.ts` intero (tutti i suoi
export sono consumati solo dal runner); **tenere** `src/io/readers.ts`
(vivo: `source_file/MappingPanel.tsx` usa `readFileContent`).

---

## 8. Debiti noti e trappole (non ripetere questi errori)

- 🔴 **Non marcare `pub` un `#[tauri::command]` nello stesso modulo** (E0255):
  la macro ri-esporta i suoi helper (`__cmd__*`) → nomi duplicati. Estrarre una
  `*_impl` pub e lasciare il comando non-pub a delegare. Vale per ogni nodo di
  rete che richiama un comando Tauri (ftp/mqtt/stomp).
- 🔴 **Il "digest" del client HTTP nel runner era FINTO** (mandava Basic).
  Implementato quello vero (RFC 2617, crate `md-5`). Direttiva utente:
  sicurezza/autenticazione vanno implementate DAVVERO, mai finte.
- **Confezionamento patch:** committare in locale la consegna PRECEDENTE come
  base prima della successiva, o `git diff` impacchetta entrambe. Un commit per
  patch.
- **Move in `for` + `async move`:** un valore non-Copy (es. `CancellationToken`)
  usato in `tokio::spawn(async move …)` dentro un ciclo va clonato
  PER-ITERAZIONE prima dello spawn (come `run_id`), altrimenti E0382.
- **Verifiche di Claude (dal P333):** Rust compilato e testato nel sandbox (vedi §2),
  più il typecheck TS.
- **La baseline typecheck è 111** (era 134; scesa con le pulizie fino al P311 —
  `npx tsc --noEmit -p tsconfig.app.json 2>&1 | grep -c "error TS"`). Sono errori
  preesistenti. **Ogni consegna deve chiudere a 111**: se sale, è colpa tua. Meglio ancora: confrontare l'ELENCO prima/
  dopo (`git stash` + diff dei due output), non solo il numero.
- 🔴 **`npx tsc --noEmit` NUDO dà un falso verde**: il `tsconfig.json` di
  radice è solution-style (`files: []` + references), quindi controlla
  ZERO file e stampa 0 errori. Serve sempre `-p tsconfig.app.json`.
- 🔴 **Se una funzionalità "non fa niente", prima di tutto verificare che
  il DATO arrivi al motore** — due volte su due il colpevole era il piano,
  non il codice che lo consuma:
  1. l'`error_handler` non entrava proprio nel piano (`SKIP_TYPES` in
     `buildRustPlan`), e sparivano con lui **tutti i suoi archi**, perché
     `laneEdges` è filtrato sui nodi sopravvissuti;
  2. **nessuna impostazione `advanced` arrivava al motore**: lo studio
     scrive in `node.data.config.advanced`, che `buildRustPlan` mette in
     **`spec.config`**, mentre il campo `config` del NodePlan è la
     selezione LEGACY da `node.data.props` (nella stringa "advanced" non
     compare **mai** in Toolbar.tsx). Il Rust leggeva `config["advanced"]`
     → sempre `None`: `critical` mai attivo, **il retry di P36 mai attivo
     a runtime**, `onError` sempre "handler" (catch/retry_catch ignorati).
     Si legge con `errors::advanced(&config, &spec)`.
- **Il pannello NON antepone il `node_label` alle righe `NodeLog`**: se il
  nodo deve essere visibile, va scritto **dentro il testo** del messaggio.
- **Un nodo troncato si dichiarava riuscito**: il pattern
  `if tx.send(..).await.is_err() { break }` (25 punti, 13 file) fa uscire
  il loop e tornare `Ok` con le righe emesse fino a lì. Oggi l'executor
  aggiunge una riga `warn` per i nodi che scrivevano verso un nodo
  abortito; resta il debito più largo dei **`let _ = tx.send()` ingoiati**.
- **Prima di applicare una patch, `git status`**: un `git apply` fallito
  era lavoro locale non committato sugli stessi file, non una patch rotta.
- **Verificare interrogando i moduli veri con `npx tsx`, non con regex**:
  gli audit a espressioni regolari hanno mentito due volte (staticOutputPorts
  sono oggetti, non stringhe; e un regex ha "perso" una voce esistente).
  `tsx` richiede **path assoluti** negli import.
- **Le voci di `nodeSemantics.ts` non hanno formattazione uniforme**:
  alcune usano `staticOutputPorts: [`, altre la forma allineata
  `staticOutputPorts:       [],`, e `dir_watcher` è indentato con **6
  spazi** invece di 4. Un solo regex non basta.
- **Non rilanciare uno script di inserimento su un file già modificato**:
  la seconda passata duplica.
- **`SIGNAL_SCHEMA` è duplicato**: `sink_file.rs` (Rust) e
  `sink_file/Panel.tsx:80` (JSON). Fonte unica da fare.
- **Gli eventi `Connection*` del motore non hanno un `conn_id`**
  (`events.rs`): l'accoppiamento apertura/chiusura si fa sul `node_id`
  con una **coda FIFO** in `Toolbar.tsx` — è un'ipotesi, e se un nodo
  tiene due connessioni aperte insieme le *durate* possono scambiarsi.
  Fix vero: aggiungere `conn_id` agli eventi.
- **`case 'aggregate'` in schemaPropagation smista per `_uiRef.type`**:
  materialize/pivot/aggregate hanno tutti `operations: ['aggregate']` ma
  tre regole di schema diverse. Lo smistamento per *operazione* era
  troppo grosso — è stata la causa di una cascata di falsi warning.
- **Il marcatore `__pivot_dynamic__`** significa "colonne note solo a
  runtime": va propagato **com'è**. Non appiattirlo a `[]` — è una
  risposta, non un vuoto.
- **Chiedere `git status --short` prima di dare la colpa alla propria
  consegna**: un errore runtime attribuito a un import nuovo era in
  realtà un file modificato in locale dall'utente.

---

## 9. Da dove ripartire

**Fasi chiuse:** Fase 13 (validazione live), Fase porte, Fase motore (error
handling end-to-end, §6.1). **FASE PORTING quasi finita** (§6.2): Script,
report_generator, persistenza e tutti i nodi di rete tranne activemq/kafka.

**PUNTO APERTO — nodo `stop` (service mode, fetta 2).** ⚠️ Verificato: **NON
esiste un nodo `stop`** in palette/motore. `stop` è solo un'**azione di regola
dell'error handler** ("emit + interrompi la lane"), ed è GIÀ implementata
(`error_handler.rs` fa `fire` dell'abort via `abort.rs`). L'utente vuole un
NODO piazzabile nel flusso per chiudere il processo consapevolmente
(eccezione→EH, oppure close→cancel del token di P93). → Va CREATO un nodo nuovo
— anche lato STUDIO (voce palette + pannello + `nodeSemantics`), non solo il
motore — che riusa l'abort esistente + il token. **In attesa di conferma
dell'utente.** Vincolo suo: il nodo stop dev'essere CANCELLABILE (parte in
parallelo come ogni nodo, `select!` fra innesco e `cancel`), non deve scattare
all'avvio, sennò chiude tutto al momento sbagliato.

**Prossimi passi (service mode + porting):**
1. Nodo `stop` (fetta 2, dopo conferma) → poi **watch fase 2** → i due webhook
   (`webhook_receiver`, `webhook_responder`) come nodi-servizio.
2. Nodi finiti rimasti: **watchdog** (c'è `watchdog_check` reqwest in lib.rs),
   **ActiveMQ/STOMP** (logica in lib.rs = cablaggio), **Kafka** (ultimo: crate
   nuovo, non compile-testabile in sandbox).
3. Debiti motore ancora aperti: collaudare il **retry** (P36, avvolge solo
   l'apertura connessione); le due criticità del modello error handling (§9
   prec.); i **reject** dichiarati (explode/join/materialize/sink_*, modello
   filter/parser); i `let _ = tx.send()` ingoiati; `SIGNAL_SCHEMA` da fonte
   unica; `conn_id` negli eventi Connection*.
4. **MANUALI**: il cancello di fine porting (li scrive Claude; già slittati una
   volta — se slitta ancora, farlo notare).

**Metodo:** una fase alla volta; Rust compilato dall'utente a ogni patch;
baseline TS 134; un commit per patch. *"Siamo sempre in fase di sviluppo:
finché non abbiamo finito tutto non si va in produzione."*

---

## AGGIORNAMENTO — stato al P106 (service mode: stop + dir_watcher continuo)

Sezione additiva sopra il corpo storico (fermo a ~P93b). Il dettaglio patch-per-patch è nei commit
`git log P94..P106` e nei design in `src-tauri/docs/`. Cancello TS invariato: `npx tsc --noEmit -p
tsconfig.app.json`, baseline **134**, diff elenco vuoto. Rust non compilabile in sandbox → gate = utente.

### Nodo STOP — CHIUSO (P94 design, P95 ferma-lane, P96 amplificatore-EH) → `design-service-mode.md` §2
Nodo di palette (sezione "Flusso"). Unica azione: ferma la lane via `LaneAbort::fire` (rollback txn + chiusura
conn; reason "stop deliberato" → nodi `NodeInterrupted`, non falliti). Innesco `immediate`/`after_input` (≥1
riga). Passa dall'Error Handler per gli EFFETTI: riga collettore `_error_source="stop"` (non critica) →
sotto-pipeline `error_out`; ordine effetti-poi-rollback garantito (EH+sotto-pipeline esclusi dall'abort).
Fallback senza EH: ferma pulito senza effetti. Cancellabile (`select!` vs `ctx.cancel`, token P93). Run ONESTO:
stop deliberato fa rollback ma `execute_lane` ritorna `Ok(stats)` → RunCompleted, non RunFailed. Campo nuovo
`err_collector: Option<RowSender>` in `NodeContext`. Collaudo utente da confermare.

### dir_watcher CONTINUO — COMPLETO (P97 design, P98-P106 impl) → `design-nodo-dir-watcher.md`
Terza modalità del dir_watcher (oltre scan e watch one-shot): **watch continuo a SESSIONI**. Nasce da due
vincoli utente che insieme forzano il modello: (1) commit per gruppo ⇒ la lane va **ri-eseguita** per ogni
gruppo di eventi; (2) non perdere input ⇒ la sottoscrizione + coda vivono **sopra la lane** (run-scoped), non
nel nodo (che verrebbe ricreato a ogni sessione).

- **Eventi + schema (P98-100)**: vocabolario `new/update/rename/delete` (metadata escluse; rename atomico Both
  → riga `rename` con `old_path`, altrimenti from→delete/to→new). `delete` e `rename`-from → riga "magra"
  (path+event, size/date NULL, non saltata). Prop `events` ora onorata (era inerte). Schema d'uscita: la valle
  lo legge da `props.outputSchema` → scritto e propagato dal nuovo `src/nodes/types/dir_watcher/schema.ts`
  (hook `useDirWatcherSchemaSync`, agganciato a ENTRAMBI i pannelli). NB: due sistemi di schema — vedi lezione
  in memoria/`schema.ts`.
- **Sottoscrizione run-scoped (P101)**: nuovo `src-tauri/src/engine/watch_subs.rs` — registro globale (stesso
  schema di `run_cancels()`) che tiene vivo il `RecommendedWatcher`; callback `notify` → canale `tokio::mpsc`
  unbounded; `start_watch` ritorna il receiver al chiamante; `stop_run_watches` nel teardown di fine run.
- **Loop di sessione (P102-104, il cuore)**: fatto chiave — `execute_lane(lane_plan: LanePlan)` crea le
  transazioni e a fine committa/chiude, quindi **una chiamata = una sessione**; `LanePlan` è `Clone`. Nel
  per-lane spawn di `engine/mod.rs`, `continuous_watcher()` riconosce la lane (`mode='watch'` +
  `submode='continuo'`) e, invece di eseguirla una volta, la mette in loop: attende evento (o cancel), raccoglie
  il burst entro 300ms, deposita gli eventi grezzi in uno slot run-scoped, ri-esegue `execute_lane(clone)`.
  L'emettitore watch è stato estratto in `map_watch_event`/`emit_watch` (condiviso one-shot/continuo); il nodo
  in continuo è un adattatore che legge lo slot ed emette.
- **UI (P105)**: selettore sotto-modo "Ascolto" (Una volta / Continuo) nei due pannelli → prop `submode`.
- **Monitor sessioni (P106, leggera)**: evento `LaneSessionStarted` per sessione → log "Sessione N — M eventi".
  Le statistiche per-nodo si sovrascrivono ancora a ogni sessione (indice per-nodo pieno rimandato).

Limiti v1: single-lane, directory statica nel continuo (niente interpolazione variabili), debounce 300ms fisso,
bridge ignorati nel ramo continuo, coda in-memory (crash del processo = eventi persi). Collaudo utente in attesa.

### Prossimo (piano com'era allo stato P106)
webhook_receiver / webhook_responder (nodi-servizio) → watchdog → ActiveMQ/STOMP → Kafka (ultimo) → MANUALI.
→ **Tutto questo è stato completato (P108-P127): vedi l'appendice sotto.**

---

## AGGIORNAMENTO — stato al P127 (1 agosto)

**La FASE PORTING è conclusa.** `NOT_IMPLEMENTED` (executor.rs) e
`MOTORE_NON_IMPLEMENTA` (dagValidation.ts) sono **vuote**. Su 40 tipi-nodo reali
tutti hanno un arm nel motore **tranne 3** — i "manuali" mai portati:
`mail_sink`, `shell_exec`, `ssh_exec`. (`mail_sink` ha già l'infra SMTP `lettre`
in lib.rs → porting = solo cablaggio; `shell_exec`/`ssh_exec` sono i due
sostanziali.) `lane_start`/`lane_end` sono ancoraggi (lowered a `lane_boundary`,
non eseguiti), non contano.

Metodo invariato: **1 consegna = 1 `.patch`**; cancello TS
`npx tsc --noEmit -p tsconfig.app.json` (baseline **134**, diff elenco vuoto); il
Rust NON è compilabile in sandbox → l'utente è il cancello, i punti a rischio
sono dichiarati per patch. Pattern di cablaggio invariato: `*_impl` pub in
lib.rs, il comando `#[tauri::command]` diventa un wrapper sottile (gotcha E0255).

### Correzioni Stop / Monitor (P108-P112) — P108/109/110 COLLAUDATI OK
- **P108**: il pulsante Stop era cosmetico (non chiamava `stop_run` né
  `monitor.runEnd`) → in service/continuo il motore non veniva mai cancellato e
  il monitor restava "running". Ora ferma davvero.
- **P109**: colonna **Lane** (chip colorato) nel Monitor — l'utente scambiava
  l'error_handler di lane diverse. (`P109-DIAG` era una sonda usa-e-getta, da
  non committare.)
- **P110**: il dir_watcher continuo ora si mostra "in ascolto" (NodeStarted del
  watcher a ogni giro del loop, prima del `select!`) → il flusso è visibile dal
  via anche fra le sessioni istantanee.
- **P111**: lo Stop chiude i timing dei nodi rimasti aperti (stato "■ interrotto"
  grigio) → in one-shot il Monitor non resta più "running".
- **P112**: il watch **one-shot** ora è cancellabile (`select!` su `ctx.cancel`
  attorno al `spawn_blocking`) → lo Stop lo ferma davvero (prima girava fino al
  timeout, e un file in arrivo faceva eseguire la lane DOPO lo stop).

### SERVICE MODE — CHIUSO (webhook + watchdog, P113-P120) → `design-service-mode.md`
Infra webhook già in lib.rs (server hyper, subscribe/pop, responder, **HMAC
reale**). Riferimento del flusso: `src/runner/webhookExecutor.ts`.
- **P113** cablaggio (`webhook_*_impl` + struct pub).
- **P114** `webhook_receiver` (server_start → subscribe → loop `select!{cancel |
  poll webhook_pop}` → riga per evento → unsubscribe). **P116** fix: porta/
  resourceId/ipWhitelist vengono dalla RISORSA (default 9110), non dai prop —
  📌 lezione: leggere `resolve*Config` del runner per le chiavi vere, non solo
  l'executor.
- **P115** `watchdog` (nodo-servizio HTTP): 3 modi `gate`/`stream`/`edge`, via
  `watchdog_check_impl` (reqwest), attesa `select!` su cancel.
- **P117** schema studio del receiver (8 campi fissi propagati a valle).
- **P118** `webhook_responder` → **SERVICE MODE CHIUSO**: modi `flow` (header
  per-riga dal template `$campo`) e `monitor` (header dalle variabili di lane).
  **P119** fix: log punta a `localhost` (non 0.0.0.0) e il GET restituisce il
  JSON degli header (prima corpo vuoto → "niente nel browser"). **P120**: toggle
  "Body sul GET" + selettore dei campi in ingresso nel pannello (chip cliccabili,
  via `useIncomingSchema`).

### ActiveMQ / STOMP — CHIUSO (P122-P125) → `src/runner/activemqExecutor.ts`
Infra STOMP grezza su TCP già in lib.rs (nessun crate). **P122** cablaggio
(`stomp_{subscribe,publish}_impl` + struct pub). **P123** `source_activemq`
(consumer batch, cancellabile). **P124** `sink_activemq` (producer json/text/
bytes, conteggio errori). **P125** schema studio del source (5 campi).
Connessione dalla risorsa (porta 61613) via `build_connection` condiviso.

### Kafka — CHIUSO (P126-P127) → `src/runner/kafkaExecutor.ts`
🔑 Niente crate nuovo: il Kafka **nativo** (librdkafka) è deferito al code-gen
di fase 2 (come già faceva il runner); il path **REST Proxy Confluent** è solo
HTTP → portato reale con `reqwest`. **P126** `source_kafka` (crea consumer →
subscribe → GET /records → righe → DELETE). **P127** `sink_kafka` (POST /topics
a batch da 100; aggiunta feature `v4` a `uuid`). Senza REST Proxy → avviso
onesto, non passthrough silenzioso.

### Studio: fix campi doppi TMap (P121)
`propagateToTMap` (e i gemelli json/xml_parser) non collassavano i doppioni:
riconnettere/re-importare lo stesso file accumulava campi doppi nell'input del
TMap, e la cancellazione li moltiplicava. **P121** deduplica per nome il
risultato del merge (idempotente). ⚠️ DEBITO: fatto SOLO in `propagateToTMap`;
i 2 siti gemelli in `flowStore.ts` (onConnect ~650, updateNodeConfig ~719, path
json/xml_parser) hanno la stessa falla latente — indurirli quando si usano.

### Da dove ripartire (i "manuali")
`mail_sink` (cablare l'infra SMTP `lettre` già in lib.rs), poi `shell_exec` e
`ssh_exec` — replicando i rispettivi executor del runner, con attenzione alla
sicurezza reale. L'utente ha anticipato che chiederà anche un nodo **LDAP**
(sarebbe un nodo NUOVO, non in palette). Debiti motore ancora aperti: reject
dichiarati inerti (explode/join/materialize/sink_*), retry da collaudare,
`let _ = tx.send()` ingoiati, `conn_id` negli eventi Connection*.


## AGGIORNAMENTO — stato al P146 (7 agosto)

**TL;DR:** Dopo il P127 sono state chiuse tre grosse aree — la famiglia di nodi **LDAP** (risorsa + source + autenticatore), il nodo **GitHub** in lettura (sorgente unica configurabile), e un **audit** completo studio↔Rust con rimozione del codice morto. È poi iniziato il lavoro **pre-distribuzione** (ambienti, sicurezza segreti, versionamento): il **versionamento è implementato**; ambienti e segreti sono **decisi a livello di design ma non ancora implementati**. Il porting è FINITO (ogni nodo di palette ha il suo arm Rust); `src/runner/` è stato CANCELLATO.

### Correzioni a sezioni precedenti di questo documento
- **§7 (`src/runner/` — codice morto, NON cancellare)**: SUPERATA. Il runner è stato **cancellato in P142** (porting finito). L'unico riferimento esterno era un import orfano di `TransactionGroupState` in `src/io/types.ts` (da un file già inesistente) → sostituito con un tipo locale. `tsc -b` è sceso da 134 a **113 errori** (−21, zero nuovi; i 113 restanti sono quasi tutti TS6133 "unused" pre-esistenti).
- **§6.2 (FASE PORTING quasi finita)**: FINITA. Audit confermato: ogni nodo reale ha un arm; `transform` è coperto dall'arm combinato `"transform"|"transform_fields"`; `lane_start`/`lane_end` sono boundary non eseguiti; `NOT_IMPLEMENTED` (Rust) e `MOTORE_NON_IMPLEMENTA` (TS) sono entrambe VUOTE.

### LDAP — COMPLETO (P131–P137) → nota memoria `flowpilot-ldap`
Famiglia di 3 nodi + risorsa condivisa. Crate `ldap3` (native-tls). Ethos "mai finto": LDAPS default + verifica cert, rifiuto password vuota (bind anonimo mascherato), escape RFC 4515 anti-injection, TLS.
- **Risorsa `kind:'ldap'` + `ldap_test`** (P131-132): `LdapConnection`, helper condiviso `ldap_connect_and_bind` (connetti + bind di servizio), comando `ldap_test`. "Testa connessione" via il ramo `ldap` di `testResource` (flowStore).
- **`ldap_source`** (P133 studio, P135 motore): sorgente, search PAGINATA (`streaming_search_with` + adapter `EntriesOnly`+`PagedResults`), una riga per voce (dn + attributi; multi-valore array/join/first).
- **`ldap_auth`** (P136 studio, P137 motore): transform con porte output/reject, **search-then-bind** (bind servizio → cerca l'utente per attributo di login → secondo bind con la password utente), `requireGroup` via `memberOf`; password mai loggata né lasciata nella riga.
- **Fix azioni-risorsa per-kind** (P134): fonte unica `src/nodes/resourceActions.ts` (`actionsForKind`), usata sia dal template sia da `ActionButtons`. GOTCHA durevole: `resource.actions` è inciso alla CREAZIONE della risorsa → aggiungere un'azione al template NON la mostra sulle risorse già create; derivarla dal kind lo risolve.

### GitHub (lettura) — COMPLETO (P138–P141) → nota memoria `flowpilot-github`
UN nodo `github_source` configurabile (non tre): stessa operazione (GET REST paginata), cambia solo entità/endpoint/colonne — come `source_http`/`source_db`. NIENTE crate nuovo: solo `reqwest` (già nel progetto).
- **Risorsa `kind:'github'` + `github_test`** (P138): solo TOKEN (GitHub non ha password), header `User-Agent` OBBLIGATORIO, `Bearer`. Helper `github_client()`/`github_base()`.
- **`github_source`** (P139 studio, P140 motore, P141 per-riga): selettore **Entità** (repos / issue+PR / commits) con campi condizionali; **due modalità** — *da config* (owner/repo fissi) e *per-riga* (owner/repo dai campi della riga in ingresso → fan-out da una lista, ogni riga taggata con `_repo`). Paginazione via header `Link` rel="next", tetto `maxItems`. Le issue includono i PR (`is_pull_request` = presenza campo `pull_request`, filtrabile).
- Pattern sbloccato: `source_file(lista owner,repo) → github_source per-riga → aggregate/tmap` (raggruppa per `_repo`), schedulato da ESTERNO (FlowPilot non ha nodi timer/cron; trigger disponibili: dir_watcher, webhook_receiver, watchdog).

### Pre-distribuzione (P143–P146 + design) → nota memoria `flowpilot-distribuzione`
Tre cose prima di pubblicare. **Perno architetturale**: separare il PIANO (struttura, versionato, condiviso, SENZA segreti) dall'AMBIENTE (valori + segreti, per test/dev/prod, scelti a run-time). Sblocca tutto: versioni/distribuisci senza segreti, esegui ovunque cambiando profilo.
- **Ambienti** — DECISO, non implementato: profilo attivo a livello di **POOL**; le variabili restano a livello pool (fonte unica), le lane le leggono per scope (vista read-only, no copie). Gancio esistente: `Variable{scope:'pool'|'lane'}` (già nei tipi) + risoluzione `${VAR}`.
- **Segreti** — DECISO (principio), non implementato: l'artifact contiene solo RIFERIMENTI (`${DB_PASSWORD}`), mai valori; risoluzione a run-time ALLA DESTINAZIONE da **keychain del SO** (desktop, hardware-backed via Secure Enclave/TPM) o env-var / secret-manager esterno (server), dietro un'astrazione "provider di segreti". Anti-pattern VIETATO: cifrare il piano con una chiave incorporata nell'app (la chiave non deve mai viaggiare). Variabile `type:'secret'` = solo il nome nel file, mai il valore.
- **Versionamento** — IMPLEMENTATO (P143–P146): cronologia IN-FILE nel `.ffplan`. Involucro `{ formatVersion:2, version:{id,savedAt,label}, plan:{pool,nodes,edges}, history:[snapshot COMPLETI, più recente in cima, tetto 20] }`, compatibile col vecchio formato flat. UI in `src/components/VersionHistoryModal.tsx` (bottone "Cronologia" in Toolbar): **ripristina**, **commenta** la versione corrente, salva **nuovo checkpoint** con nome, **elimina** versioni. Logica save/load/relabel/delete in `Toolbar.tsx`. Manca solo il **confronto side-by-side** (rimandato; lo schema è già pronto perché gli snapshot sono completi). NB: l'UI è stata solo typecheckata, non collaudata visivamente.
- Involucro proposto COMPLETO (quando si faranno ambienti/segreti): `{ formatVersion, version, plan:{pool,nodes,edges}, environments:{active, profiles:{test,dev,prod → {VAR:valore} solo non-segreti}}, history }`.

### Metodo (invariato — vedi §2)
Ogni consegna è un `.patch` verificato con `git apply --check` su clone fresco del remoto; l'utente applica/compila/pusha (il remoto avanza a ogni turno → clonare sempre fresco e controllare lo stato reale). Il TS si verifica con `tsc --noEmit` (0 = pulito); il **Rust NON è compilabile in sandbox** (nessuna toolchain), quindi il collaudo Rust è il cancello dell'utente. Numerazione patch sequenziale (ora a P146).

### Da dove ripartire
Le due cose pre-distribuzione ancora da implementare: **AMBIENTI** (risoluzione `${VAR}` con scope di pool + profili — è il cuore) oppure **SEGRETI** (il provider col keychain/env). Rifiniture rimandate dall'utente: il **confronto side-by-side** delle versioni e un **editor dedicato delle variabili** di pool. Debiti minori invariati (§8): porte reject inerti su alcuni nodi, dedup campi TMap (P121), e i ~113 errori TS6133 pre-esistenti (ripulibili in un passaggio dedicato).


## AGGIORNAMENTO — stato al P158 (7 agosto)

**TL;DR:** I **tre pilastri pre-distribuzione** — versionamento, ambienti, segreti — sono ora **IMPLEMENTATI** (P143–P158). La sezione "stato al P146" li dava come "design deciso ma non implementato" per ambienti/segreti: **superata**. Il nucleo per pubblicare c'è tutto; restano solo rifiniture rimandate. Tutta la UI è verificata col typecheck ma **non collaudata visivamente** (aspetto da confermare); il Rust dei segreti (P155/P157) **compila** (confermato).

### Perno architetturale (tutti e tre i pilastri)
Separare il **PIANO** (struttura: lane/nodi/wiring + riferimenti `${...}`, versionato, condiviso, SENZA segreti) dall'**AMBIENTE** (valori + segreti, per test/dev/prod, scelti a run-time). Da qui: si versiona/distribuisce senza segreti, si esegue ovunque cambiando profilo. Involucro `.ffplan` finale: `{ formatVersion:2, version:{id,savedAt,label}, plan:{pool,nodes,edges}, environments:{active, profiles, profileRefs}, history:[…] }`. Compatibile all'indietro col vecchio formato flat.

### Versionamento — IMPLEMENTATO (P143–P146)
Cronologia **dentro il `.ffplan`** (ramo `history` di snapshot COMPLETI, più recente in cima, tetto 20). Persistenza in `src/components/Toolbar.tsx` (`scriviProgetto`/`handleOpen`, non flowStore). UI in `src/components/VersionHistoryModal.tsx` (bottone "Cronologia" in Toolbar): **ripristina**, **commenta** la versione corrente (senza creare una nuova versione), salva **nuovo checkpoint** con nome, **elimina** versioni. Manca solo il confronto **side-by-side** (rimandato; lo schema è pronto perché gli snapshot sono completi).

### Ambienti — IMPLEMENTATO (P148–P152)
- **Variabili di POOL = fonte unica**, risolte per SCOPE da ogni lane (P148: `buildRustPlan` mette `pool.variables` come base dello scope; la lane può ombreggiare). Prima le pool-var erano inerti a run-time.
- **Profili** test/dev/prod (P149 motore, P150 UI): `environments.profiles` = value-set che al Run rimpiazzano i valori di default delle pool-var; `environments.active` = profilo in uso.
- **Editor "Ambienti"** (`src/components/EnvironmentsModal.tsx`, bottone "Ambienti" in Toolbar): crea/rinomina/elimina variabili di pool (P151), gestisce profili e i loro valori, seleziona l'attivo.
- **Import/export su FILE** (P152): il **progetto è il padrone** (valori inline nel `.ffplan`); il file esterno è comodità (esporta/importa un profilo, formato `{ "profile":"prod", "values":{…} }`). Il progetto ricorda il percorso (`profileRefs`); all'apertura valgono i valori del progetto, l'utente **ricarica a mano** dal file (nessun auto-reload). L'import crea le variabili di pool mancanti referenziate.
- Le variabili non appaiono più in alto vicino a "Pool" nel Canvas (P156): con decine ingombravano; si gestiscono nel modale.

### Segreti — IMPLEMENTATO (P153–P158)
- **Risoluzione `${VAR}` nei config delle RISORSE** (P153, studio, in `buildRustPlan`): host/porta/… diventano **sensibili all'ambiente** (`${API_HOST}` cambia per profilo — prima NON funzionava). I riferimenti IGNOTI (i `${SEGRETO}`) vengono **lasciati intatti** → risolti nel motore, mai in chiaro nello studio.
- **Dichiarazione** (P154): `'secret'` aggiunto a `VariableType`; nell'editor Ambienti il bottone **"+ segreto"** crea una variabile di cui il file conserva **solo il nome** (valore mai salvato). Esclusi dai valori-per-profilo.
- **Provider in Rust** (`src-tauri/src/secrets.rs`): P155 = variabili d'ambiente; P157 = fallback **keychain** del SO (crate `keyring` in Cargo.toml — ⚠️ verificare versione/feature per-piattaforma; l'env-var resta fallback). `spec.rs res_str_or` risolve i `${SEGRETO}` **nel backend** (il segreto non torna mai al lato JS).
- **Provisioning** (P157 comandi + P158 UI): comandi Tauri `secret_set`/`secret_has`/`secret_delete`; sezione "Segreti" nel modale Ambienti per inserire i valori **sulla macchina** (keychain), vederne lo stato (✓/mancante) e rimuoverli.
- Risultato: il piano **elenca i segreti necessari** (nomi) SENZA contenerne i valori → distribuibile e a prova di leak.

### Metodo (invariato — vedi §2)
Ogni consegna è un `.patch` verificato con `git apply --check` su clone fresco del remoto; TS con `tsc --noEmit`; il Rust è il cancello dell'utente. La UI si verifica solo col typecheck (aspetto visivo a carico dell'utente). Numerazione ora a P158.

### Da dove ripartire
Rifiniture rimandate: **confronto side-by-side** delle versioni; **editor variabili/"contesti classici"** più ampio. Estensioni future eventuali: cifratura dei profili che portano segreti, backend provider aggiuntivi (Vault/KMS/secret-manager esterni). Debiti minori invariati (§8): porte reject inerti su alcuni nodi, dedup campi TMap (P121), ~113 errori TS6133 pre-esistenti. Nota: il pre-distribuzione ha il suo dettaglio nella nota di memoria `flowpilot-distribuzione`.


## AGGIORNAMENTO — stato al P170 (8 agosto)

**TL;DR:** Dopo i tre pilastri pre-distribuzione (stato al P158), due cose grosse. **(1)** Una pulizia di consistenza: rimosso un campo di config morto (`parallel`, P160). **(2)** L'intero **tema RILASCIO / eseguibile** (P161–P170): dallo studio **generi un artifact**, un **runner headless** lo esegue anche su un server nudo (senza Tauri), che **pusha i log a un monitor centralizzato**; più la **CI cross-platform** e un **manuale operativo**. Il dettaglio patch-per-patch di questo tema è nella nota di memoria **`flowpilot-rilascio`** — leggerla per lavorare qui. Come sempre: il Rust è il cancello di compilazione dell'utente (non compilabile in sandbox), il TS si verifica con `tsc --noEmit`, e ogni consegna è un `.patch` validato con `git apply --check`.

### Pulizia consistenza (P160)
Rimosso il campo `advanced.parallel`: era **dead-config** — reso in DUE tab (TabGeneral "Esegui in parallelo" + TabAdvanced "Esecuzione parallela", stesso campo) e **mai letto** né da `buildRustPlan` né dal motore. Il motore è **sempre-parallelo per costruzione** (ogni nodo/lane = task Tokio; il sequenziamento nasce dalle dipendenze di dati), quindi il toggle era fuorviante. Rimosso dai 2 tab + dal tipo `NodeAdvanced`. NON toccati: l'`execMode` del nodo **filter** (per i suoi rami — vivo) e i campi **retry** (vivi).

### Tema RILASCIO — l'eseguibile degli artifact (P161–P169)
Modello scelto = **BUNDLE**: un **runner GENERICO condiviso** (un binario per piattaforma, con dentro TUTTI i driver), compilato una volta; l'**artifact è il PIANO** (KB), **portabile** — lo stesso runner esegue qualsiasi piano. Un **ambiente congelato per artifact**. Fatto chiave: la costruzione del piano vive nello STUDIO (`buildRustPlan` in TS); il motore Rust ESEGUE un piano già pronto (`engine_run(planJson)`). Quindi il runner NON riscrive nulla: lo studio **esporta** il piano compilato, il runner lo esegue.

- **Export + scheda di compilazione** (P161, P167): bottone **"Compila"** nella Toolbar → modale `CompileModal` (scegli profilo da congelare / endpoint monitor / piattaforma) → genera un **`.ffart`**: `{ formatVersion, kind, exportedAt, profile, platform, monitor, requiredSecrets, plan }`. Riusa `buildRustPlan` (profilo attivo congelato; `${SEGRETO}`/`${MONITOR_URL}` lasciati intatti). Mostra il **manifesto** (segreti richiesti, ecc.).
- **Runner headless** (P162, P163): nuovo binario **`src-tauri/src/bin/flowpilot_runner.rs`** — riusa `engine_run`, drena il **bus eventi** (`global_bus().drain_since`) e stampa **NDJSON** su stdout. `default-run = "app"` nel Cargo.toml perché ora ci sono due binari.
- **Scollegamento da Tauri** (P164, P165): `tauri` + i 4 tauri-plugin resi **opzionali** dietro la feature **`desktop`** (default ON). Gatati con `#[cfg(feature="desktop")]` `run()`, i ~38 comandi dell'app e i `mod db_*` in lib.rs; `cfg_attr` sui 7 comandi del motore (restano chiamabili). `build.rs` gatato (`CARGO_FEATURE_DESKTOP`). → il runner si compila **`--no-default-features`** = **SENZA Tauri/webview** (per i server); lo studio resta identico.
- **Push al monitor** (P166, P168): il runner, per ogni batch, oltre a stampare NDJSON fa **POST** al monitor (best-effort, timeout, **mai bloccante**, fallback su `flowpilot-monitor-fallback.ndjson`). Legge l'endpoint **dal manifesto** (`monitor`; `${MONITOR_URL}` risolto dalle env della macchina) con fallback su env `MONITOR_URL`.
- **CI cross-platform** (P169): `.github/workflows/runner.yml` compila il runner per **Linux+Windows** (`--no-default-features --profile release-lean`), size-optimized. Deps di sistema Linux (solo per runner/monitor, niente webview): `pkg-config libssl-dev libdbus-1-dev`. Trigger: manuale o tag `vX.Y.Z` (allega i binari alla Release). Profilo `[profile.release-lean]` in Cargo.toml (opt-level="z", lto, strip, ecc.), separato dal release dello studio.

### Il MONITOR (P170)
Nuovo binario **`src-tauri/src/bin/flowpilot_monitor.rs`** — servizio **standalone** (dipende solo da `tiny_http`+`serde_json`, NO Tauri/app_lib), dietro la feature **`monitor`** (`required-features`, così non appesantisce studio/runner). Riceve i push (`POST /ingest`, NDJSON), aggrega per `run_id`, offre `GET /api/runs`, `GET /api/runs/<id>` e una **vista web** minimale (`GET /`). Store **IN MEMORIA** (persistenza = prossimo passo). Decisione: la *vista* potrà riusare l'UI dello studio, ma il *ricevitore* è un servizio always-on separato (il desktop non riceve push da una flotta).

### Comandi chiave (dal manuale operativo)
Da **`src-tauri/`** per i `cargo`, dalla radice per gli `npm`:
- Studio: `npm run tauri dev` (sviluppo), `npm run tauri build` (app).
- Runner: `cargo build --bin flowpilot_runner --no-default-features --profile release-lean` → `target/release-lean/`.
- Monitor: `cargo build --bin flowpilot_monitor --no-default-features --features monitor --release` → `target/release/`, poi `flowpilot_monitor [porta=8787]`.
- Artifact: NON da CLI — dallo studio, bottone "Compila".

### Manuale operativo
Scritto un **manuale operativo** (documento a parte, consegnato all'utente, NON nel repo): copre compilazione/esecuzione di studio/runner/monitor/artifact con parametri, più i capitoli **segreti** (dichiarazione, `${}` nelle risorse, risoluzione env-poi-keychain nel backend, provisioning) e **profili di esecuzione** (variabili di pool, profili, congelamento, import/export su file, involucro `.ffplan`).

### Da dove ripartire
- **TEMA 2 (manuali) — resta la metà per-nodo:** un **generatore di schede-nodo** dal registry + `nodeSemantics` + Panel (scheletro auto-generato per i ~40 nodi, poi arricchito) e **progetti di esempio** curati (che sono anche test del runner). Il lato *operativo* del tema 2 è già coperto dal manuale.
- **Monitor:** persistenza (ora volatile), riuso dell'UI dello studio come vista, auth/retention.
- **Rimandato/da valutare:** far **assemblare il bundle alla scheda** (copiare accanto al `.ffart` un runner pre-compilato per la piattaforma — NON compilare Rust dallo studio); "sapori" di runner (snello/completo); scelta congela-un-profilo confermata.


## AGGIORNAMENTO — stato al P207 (24 agosto)

**TL;DR:** Tre filoni. **(1)** Il **TEMA 2** è partito davvero: un **generatore di schede-nodo** (47 schede in `docs/nodes/`) e una **suite di esempi** `examples/` con un **verificatore** — che è la prima prova ripetibile del progetto. **(2)** Il **monitor** è cresciuto da prototipo a strumento usabile: timestamp d'origine, persistenza, apertura di log salvati, provenienza dei run, livelli di log, riepilogo/filtri/ricerca, token sull'ingest. **(3)** Una serie di **correzioni nate dai test**, alcune serie. Il dettaglio patch-per-patch sta nelle note di memoria **`flowpilot-rilascio`** (monitor/rilascio) e **`flowpilot-esempi`** (esempi, verificatore, correzioni recenti). Metodo invariato: un `.patch` per consegna validato con `git apply --check` su clone fresco, TS con `tsc --noEmit`, il Rust è il cancello di compilazione dell'utente.

### Tema 2 — riferimento per-nodo (P172)
`NODE_DEFS` + `PALETTE_SECTIONS` estratti da `registry.ts` in **`src/nodes/nodeDefs.ts`** (dati puri, senza React; `registry.ts` li ri-esporta → importatori invariati). Nuovo **`scripts/gen-node-docs.ts`** (`npm run docs:nodes`, gira con `tsx`): legge registry + `nodeSemantics` e produce **`docs/nodes/<tipo>.md`** (47 schede: campi, semantica, porte) + indice. Ogni scheda ha un **blocco AUTO** rigenerabile e una sezione **`## Approfondimento`** scritta a mano **preservata** a ogni rigenerazione. I nodi reali sono **47**, non ~40.

### Esempi e verificatore (P193, P197, P200, P204, P207)
`examples/` con **7 esempi L0** (nessuna dipendenza esterna): 01 file→file · 02 filtro e reject · 03 script FPEL (fan-out con `emit`) · 04 fallimento governato (**deve fallire**, uscita 1) · 05 due ingressi · 06 aggregazione · 07 ambienti e segreti. Ogni esempio porta **dati**, **`atteso.json`** e **`NOTE.md`**; i `piano.ffplan` li disegna l'utente nello studio (un `.ffplan` non è scrivibile a mano in modo affidabile).

**`examples/verifica.mjs`** (node puro, zero dipendenze) confronta il log NDJSON di un run con le attese: codice d'uscita, esito, **statistiche per nodo indicate per ETICHETTA** (non per id, che cambia se ridisegni), eventi richiesti, file prodotti, `errore_contiene` (fallire *per il motivo giusto*), l'**artifact** (profilo congelato, segreti dichiarati, e che il **valore** di un segreto non compaia nel `.ffart`) e le **invarianti** — la prima: `nessun_dato_di_riga`. Modalità **`--taratura`**: stampa i valori osservati nella forma di `atteso.json`.

Procedura: disegna il piano → "Compila" nella cartella dell'esempio → `runner artifact.ffart > run.ndjson` → `node ../verifica.mjs . run.ndjson --exit 0`. **01 e 02 e 04 già collaudati verdi.**

### Monitor — da prototipo a strumento (P173–P199)
Deciso con l'utente: monitoraggio dello **studio** (debugger) e **monitor centralizzato** (log di campo) sono **due mondi**; in comune solo il **formato degli eventi**.

- **Contratto del log** (P173): ogni evento viaggia **incapsulato** `{timestamp, event}` col **tempo d'origine** (prima si perdeva e valeva l'ora di ricezione); il log si apre con un'**intestazione autodescrittiva** (runner, artifact).
- **Persistenza** (P174, P179): un file NDJSON **per run** in **`~/.flowpilot/monitor-data/`** (env `MONITOR_DATA_DIR`), append a ogni ingest, **ricarica all'avvio**. ⚠️ Il default sta **fuori dai progetti** apposta: scrivendo dentro un progetto aperto con `tauri dev`, il file-watcher di Tauri **riavviava lo studio a ogni evento**.
- **Salva / Apri log** (P175, P178): download NDJSON di un run + apertura di un file **lato client** (vista temporanea, non importa nulla nell'archivio).
- **Provenienza** (P176–P183): nome del piano, **identità dello studio** (UUID + etichetta modificabile in `~/.flowpilot/studio.json`), versione studio/piano, **hash del piano** etichettato *integrità* (mai "autentico"), host **dichiarato** dal runner e **IP osservato** dal monitor — dichiarato e osservato tenuti distinti.
- **Livelli di log** (P186–P188, P196): scelta in "Compila" fra *essenziale / normale / diagnostico*. Filtra ciò che **esce dalla macchina**; il log integrale resta sempre in `~/.flowpilot/runs/`. **Essenziale e normale non trasmettono il contenuto delle righe** (protezione dati): su un run reale si passa da 65 eventi con 42 righe di dato a 17 eventi con zero.
- **Viste** (P184, P189, P191, P192, P199): cartella dati dichiarata a schermo; **riepilogo del run** (esito, durata, righe, nodi con interrotti/falliti, lane) **ricostruito dagli eventi** quando il riepilogo finale è vuoto — cioè proprio quando il run fallisce; **dettaglio per nodo** (`nome in → out`) al posto di una somma che contava più volte le stesse righe; colori per gravità; filtri (solo errori, nascondi memoria, per nodo); **ricerca testuale con sintesi** dei risultati; campioni di memoria in forma compatta.
- **Sicurezza e tenuta** (P190, P191): **`MONITOR_TOKEN`** → `/ingest` esige `Authorization: Bearer` (vuoto = aperto, come prima). Il token **non entra nell'artifact**: il runner lo prende dall'ambiente. **Dedup** degli eventi (il re-invio del fallback non duplica più), tetto eventi per run e **retention** dei run — **solo in memoria: i file non si cancellano mai**. ⚠️ Limite dichiarato: protetta la **scrittura**, la lettura resta aperta.
- **Identità dei run** (P198): il `run_id` era inciso nell'**artifact** → ogni esecuzione dello stesso `.ffart` finiva nello stesso run. Ora il runner ne genera uno **per esecuzione** (`<artifact>-<istante>`) e porta l'`artifact_id` nella provenienza; `FLOWPILOT_RUN_ID` per imporlo.

### Correzioni nate dai test
- 🐞 **P185 — il primo evento del processo veniva sempre perso.** Il bus numerava da 0 e i lettori partono da cursore 0 (`seq > cursore`): l'evento 0 non veniva **mai** consegnato. Nel runner era `RunStarted` — e con lui **tutta la provenienza**, che viaggia lì dentro. Corretto facendo partire la numerazione da 1.
- 🐞 **P196 — dati di riga che uscivano lo stesso.** Il filtro dei livelli bloccava `target == "window"`, ma i valori sono **tre**: `both_window` passava. **Trovato dal verificatore** (invariante `nessun_dato_di_riga`), non da un'ispezione a occhio.
- 🐞 **P194 + P195 — tipi dedotti dal CSV.** L'inferenza guardava il *valore* invece del *testo*: `"1200.00"` diventava `integer`, e il motore su un intero non convertibile scrive **NULL senza errore** (dati cancellati in silenzio). Ora per le stringhe decide la forma scritta; colonne miste → tipo prudente; il tipo salvato che non regge i dati viene **autocorretto** e segnalato, e resta un **errore bloccante** se lo si rimette a mano.
- **P201** — schema propagato anche sul **reject del filter** (lì escono le stesse righe dell'ingresso): spariva l'avviso "non riceve campi" su un nodo che a run-time funziona. Per TMap/parser l'esclusione resta giusta.
- **P202** — i **nodi disabilitati** ora si escludono davvero (`config.enabled` era scritto e mai letto): bypass monte→valle con un ingresso, rimozione per sorgenti/sink, e **avviso** quando ha più ingressi (ricucire sarebbe arbitrario). Il sottotitolo dello Script dice **FPEL** (non più "typescript"); nuovo **errore** se uno Script è dichiarato *generatore* ma ha un arco in ingresso.
- **P203** — il motore **onora `sourceMode`**: prima la natura del nodo (generatore o trasformatore) la decideva la presenza del canale, quindi dichiarazione e comportamento potevano divergere in silenzio.
- **P205 + P206b** — il **nome del progetto** ora si vede: accanto al *Main Pool* (con separatore) e nel titolo della finestra.

### Documenti esterni (NON nel repo)
Consegnati all'utente: **Manuale operativo** (studio/runner/monitor/artifact, segreti, profili, generazione schede), **Manuale del linguaggio FPEL** (grammatica, 84 funzioni, template, editor), **Manuale del Monitor** (avvio, env, ingestione, persistenza, sicurezza, viste, API, diagnosi rapida), **Disegno della suite di esempi**, **Studio FPEL — funzioni proprie e librerie**. Valutare se portarli sotto `docs/` nel repo: fuori si scollegano dal codice.

### Lezioni operative (costate tempo più volte)
- **Binario vecchio**: eventi "nudi" senza l'intestazione `flowpilot-log-header` ⇒ runner anteriore a P173. Test: `strings <binario> | grep -c flowpilot-log-header`. Attenzione al profilo: `--profile release-lean` scrive in `target/release-lean/`, non in `target/release/`.
- **La vista del monitor è compilata dentro il binario**: applicare una patch e ricaricare la pagina non basta — va ricompilato **e riavviato** il monitor.
- **Base delle patch**: verificare se la precedente è nel **remoto** o solo nell'albero locale dell'utente, altrimenti il `.patch` non applica.
- Il monitor tiene i run **in memoria**: cancellare i file non svuota la lista (fermare → cancellare → riavviare).

### Da dove ripartire
- **Esempi**: disegnare i `piano.ffplan` mancanti (03, 05, 06, 07) e tarare le attese al primo run. Poi valutare uno **smoke test in CI** (serve un modo di esportare un artifact da riga di comando).
- **Tema 2**: arricchire a mano le sezioni *Approfondimento* delle 47 schede.
- **FPEL**: le funzioni definite dall'utente e le librerie `.ffpel` (vedi lo studio dedicato). Fatto chiave: si compilano **nello studio** ed è possibile **espanderle a compile-time** → nessuna modifica al motore.
- **Monitor**: protezione in **lettura**; eventuale firma degli artifact (fase C).
- **Debiti**: molti nodi portati in Rust (webhook, watchdog, ActiveMQ, Kafka, mail, ssh) **non sono mai stati collaudati a runtime**; la **CI non è mai stata eseguita** (mettere un tag `v0.1.0` e vedere se sforna i binari); `sink_file` non crea le cartelle mancanti (rimandato di proposito); allineare anche i run **dello studio** al `run_id` per esecuzione.

---

## Aggiornamento P208 → P259 (dopo il P207)

Quattro temi grandi, tutti verificati (tsc baseline **110**, suite FPEL 49/57/44, esbuild), patch nel remoto. Il motore Rust non è compilabile nell'ambiente di sviluppo delle patch: i pezzi Rust sono scritti con revisione statica e **compilati dall'utente** (come per la FASE MOTORE storica).

### Anteprima sul dato vero
- Comando motore **`engine_preview_node`** (`engine/mod.rs`): fa girare un nodo PURO (transform, source_file) in **isolamento** — registri per-lane vuoti, `var()` mock, nessuna lane — restituendo le righe in uscita dal **motore vero**, mai simulate. Tetto righe per le sorgenti (abort dopo N).
- Pannelli **Preview**: transform (mock rows salvate sul nodo → `engine_preview_node`), source DB (campione reale via `db_query`), source file (lettura reale via `engine_preview_node`).
- 🐞 **P240 — divergenza dei lettori**: `db_query` leggeva gli enum Postgres (`mpaa_rating`) come NULL, il nodo `source_db` no (aveva il fallback `try_get_raw`). Reso `pg_col_to_value` `pub(crate)` e usato da `pg_query` → **un solo lettore Postgres**; la preview è fedele al run.

### Selettore unico ovunque
- Un solo **`FunctionPicker`** (ricerca, categorie, costrutti) in: casella espressione e script del TMap, funzione di campo e ultimo passo, tendina trasformazione ed espressione custom del nodo Transform. **Inline del TMap ridisegnato a casella unica** (regola "avvolgi la selezione, o l'intera espressione").

### Schema-file
- Formato unico `src/schema/schemaFile.ts`; **export** schema da source DB / TMap / sink DB; **import-da-file** nel TMap (prima placeholder). Dialoghi **nativi** Tauri (`saveFileDialog`/`openFileDialog` + `writeFile`/`readFile`): il download `<a>` del browser è inerte nella webview.

### Funzioni utente FPEL (il pezzo grosso)
- Sintassi `function nome(par) { return espressione }` (alias italiani `funzione`/`ritorna`). Corpo = una sola espressione, solo i suoi parametri, niente ricorsione né ombreggiamento delle predefinite.
- **Espanse a compile-time** (chiamata → albero del corpo con argomenti sostituiti); `_origin` per la diagnostica, **tolto prima del motore** → **zero modifiche al Rust**.
- Valgono in **transform, TMap e script**: `compileFpel` nei convertitori (`templateCompiler`, `tmapExprConverter`) col threading dal build; per lo script un **registro attivo** in `userFunctions.ts`, tenuto fresco da una **subscription dello store**, così valgono anche in propagazione schema e validazione.
- Modale **Functions** (menu) con l'editor dello script (Monaco `flowpilot`) + `ƒ apply…`; compaiono nel selettore e nell'**autocompletamento** Monaco. Persistono in `pool.userFunctions` (progetto + localStorage). **Librerie `.ffpel`** import/export (copia nel progetto).

### Preparazione beta
- Menu **Esempio → Help** (modale contenitore per manuali/wizard/agente). **Codegen rimosso** dalla UI (file `CodegenPanel.tsx` lasciato, solo scollegato).
- **Contrasto**: il grigio-testo `#4a5a7a` (977 usi, sotto la soglia AA) portato a `#8593b5` (passa AA).
- **Passata inglese** in corso, a blocchi, con dizionario **`src/i18n/it-en.json`** (seed per l'i18n futuro): fatti Toolbar, modali principali (Functions, Environments, Compile, Version history), nomi/sezioni dei nodi. Resta la **coda lunga**: 99 descrizioni dei nodi, messaggi rari, `desc` delle funzioni FPEL. Nota: inglese **hardcoded**; l'i18n vero (chiavi `t()`) è una rifinitura successiva — il dizionario ne è la base.

---

## AGGIORNAMENTO — passata di traduzione in inglese (stato al P311, 15 settembre)

La "passata inglese" annotata sopra (stato P259, "in corso, a blocchi") è
proseguita fino a diventare la **fase corrente** del progetto. Il dettaglio
completo — metodo, convenzioni, stato file-per-file, cosa NON tradurre e le
lezioni operative — vive in un handoff **DEDICATO** che qui **non ricopio**:

> → **`HANDOFF-traduzione-EN.md`** (nel repo, accanto a questo file). È la
> fonte di verità per la traduzione; questo paragrafo è solo il puntatore.

Sintesi minima (non duplicare — per tutto il resto leggi il doc dedicato):
- **Frontend** tradotto: nodi/panel, i 7 modali, catalogo FPEL/functions,
  script, log, Property/Monitor, canvas/dock/menu. Dizionario-seed
  **`src/i18n/it-en.json`** mantenuto in modo additivo (~2357 voci; base per
  l'i18n `t()` futuro — l'inglese oggi è **hardcoded**).
- **Motore Rust** tradotto: `lib.rs`, orchestrazione, tutti i nodi, layer DB,
  `datasets.rs`, binario monitor. ⚠ **`P303`** (orchestration) fu applicata e
  **REVERTATA** (virgolette nude in una stringa Rust); le stringhe sono poi
  rientrate via **`P305`**. Da qui la regola "check virgolette bilanciate"
  prima di consegnare una patch motore (dettaglio nel doc dedicato).
- Ultime consegne della fase: **P310** (residui motore — watchdog, webhook,
  sink_db/kafka/ftp, error_handler, ecc.) e **P311** (catalogo trasformazioni
  `src/transforms/catalog.ts` + `presets.ts` — i nomi "parlanti" e le
  descrizioni delle funzioni della palette — e i messaggi del parser script
  `src/ir/scriptParser.ts`, incluso "unrecognized instruction. Expected: …" e
  il prefisso "line N:").
- La **"coda lunga"** annotata al P259 (99 descrizioni nodi, `desc` funzioni
  FPEL) è in gran parte **chiusa** da P310/P311.
- **Residuo attuale** (da trattare come gruppi nuovi quando emergono testando
  con `npm run tauri dev`): mezzi-tradotti e stringhe generate a runtime, più
  alcune aree UI ancora IT viste nello sweep — titoli dei dialog save/open
  (`schema/schemaFile.ts`, `components/EnvironmentsModal.tsx`,
  `components/Toolbar.tsx`, `components/UserFunctionsModal.tsx`, `App.tsx`) e
  descrizioni in alcuni Panel di nodi (aggregate/window/pivot/ssh_exec/
  data_quality), oltre agli errori FPEL a livello di espressione
  (`ExprParseError.pretty()`, file diverso da scriptParser).

Il **metodo e le convenzioni** della passata NON sono qui: sono in
`HANDOFF-traduzione-EN.md`.

---

## AGGIORNAMENTO — sicurezza per il rilascio pubblico (16 settembre)

Iniziato il ragionamento su **affidabilità e sicurezza** in vista del rilascio al
pubblico. Rivisto il codice reale delle tre parti (studio Tauri, monitor web, runtime
Rust) e censite le debolezze principali: nello studio `csp: null` + capability
`shell`/`fs` larghissime + 50 comandi → una XSS nella webview diventa RCE; monitor con
viste di lettura aperte, bind `0.0.0.0`, HTTP in chiaro, ingest aperto se manca il
token; **la runtime esegue qualunque `.ffart` le si passi** — `planHash` presente ma
NON verificato (provenienza "fase A", dichiarata e non verificata); segreti non
redatti nei log/eventi. Priorità P0/P1/P2 discusse in chat.

Prima area portata a design: **la catena di fiducia dell'artifact** (autenticare e
validare un `.ffart` prima di eseguirlo). Decisione presa: **solo FIRMA** in v1
(autenticità + integrità + attribuzione), Ed25519, verifica **all'ammissione** (non a
ogni esecuzione) → compatibile con lo scheduler near-real-time futuro; cifratura
rimandata ma agganciabile senza rifare. È la "Fase B" dei campi di provenienza già
presenti nell'`.ffart`.

> Design completo, punti aperti e prossimi passi:
> → **`HANDOFF-firma-artifact.md`** (nel repo, accanto a questo file).

Ancora da portare a design (citati ma non ancora dettagliati): hardening studio
(CSP + capability minime), messa in sicurezza del monitor (TLS/auth/bind locale),
redaction segreti, sandbox/policy nodi pericolosi della runtime. L'**affidabilità**
(ripresa/checkpoint, tetti di memoria, timeout uniformi, versionamento, passthrough
dei nodi non implementati → errore duro) è stata esplicitamente messa da parte.

---

## AGGIORNAMENTO — firma + hardening + redaction (stato al P332, 18 settembre)

La **catena di fiducia degli artifact è implementata**, lo **studio è irrobustito** e i
**segreti sono redatti** nei log/eventi verso il monitor. Design + modello di minaccia
completi in **`HANDOFF-firma-artifact.md`** (blocco "STATO DI IMPLEMENTAZIONE" in cima).
Sintesi:

**Firma (P314–P327).** Forma canonica del piano + `planHash` (TS⟷Rust, vettore condiviso);
firma **Ed25519** del manifesto; export produce il `.ffart` **firmato**; **verifica lato
runner** fail-closed + **trust store** (`~/.flowpilot/trust-store.json`) + modalità
`FLOWPILOT_SIGNATURE_MODE = off|warn|enforce`. Chiave privata **cifrata a riposo**
(argon2id + XChaCha20-Poly1305) in `~/.flowpilot/signing-key.json`, sbloccata **in memoria
per la sessione** e **azzerata** (zeroize) al lock/chiusura; voce UI dedicata **Signing**.
Due scelte chiave: **solo autenticità** (cifratura artifact rimandata) e **Modo A** — il
**manifesto è l'unica fonte di verità** e assorbe tutti i campi operativi (monitor,
logLevel, planName, studio, requiredSecrets…), così sono firmati e il runner li legge da
lì. Firma **libera multi-sviluppatore** (trust store = allowlist a più voci).

**Hardening studio (P328–P331).** Chiude il vettore XSS→RCE che avrebbe scavalcato firma e
vault: **capability Tauri minime** (rimosse `shell:*` e `fs:*`, inutilizzate dal frontend),
**CSP `default-src 'self'`** (blocca gli script iniettati; `script-src 'self'`, `devCsp`
per l'HMR), **icone/font bundlati in locale** (via i CDN → CSP pura, studio offline), e
**guardrail ESLint anti-XSS** (vieta `dangerouslySetInnerHTML`/`innerHTML`/`eval`/…). La
sanificazione non serviva: lo studio è già sicuro per costruzione (React scappa il testo,
`.ffplan` via `JSON.parse`, zero bypass) → il guardrail impedisce la regressione.

**Redaction segreti (P332).** `secrets.rs` tiene un **registro** dei valori di segreto
risolti (via `resolve_secret`/`set_secret`) e `redact()` li maschera con `***` **al confine
di emissione**: `emit_log` (`NodeLog.message`) ed `emit_failed` (`NodeFailed.error`) in
`executor.rs`. Così un comando ssh/shell o una connection-string con password non trapela
nel monitor. Soglia ≥ 4 char (niente over-masking); maschera il valore **letterale** (limite
noto: non le forme trasformate, es. URL-encoded). Le righe non sono campionate al monitor →
non serve redigerle lì (i sink a valle sono l'output voluto dall'autore del piano).

### Deliverable prodotti in questa sessione (oltre alle patch)
- **`HANDOFF-firma-artifact.md`** — design firma + modello di minaccia (aggiornato a Modo A /
  vault / zeroize).
- **`MANUALE-build-esecuzione.md`** — manuale build+esecuzione Linux/Windows, con la sezione
  dedicata ai segreti.
- **`flowpilot-security-brochure.html`** — brochure tecnica di sicurezza per acquirenti
  (HTML autoportante; anche pubblicata come artifact). ⚠️ **Da aggiornare** col nuovo stato
  (redaction segreti; sezione "garantito oggi" allineata) — vedi PROMEMORIA.
- Patch di sessione, da applicare **in ordine**: **P310–P313** (traduzioni),
  **P314–P327** (firma), **P328–P331** (hardening studio), **P332** (redaction segreti).
  Nota: ogni Pxxx è diffata sopra la precedente committata (concatenazione).

### Prossimi passi / lavori vivi
- **Sicurezza del monitor** (P0 di sicurezza rimasto): oggi HTTP in chiaro, viste di lettura
  aperte, ingest aperto se manca il token → TLS (o reverse proxy), auth **anche in lettura**,
  bind locale di default, limiti su dimensione/rate dell'ingest.
- **Sandbox / least-privilege della runtime** + policy per disabilitare i nodi pericolosi
  (shell/ssh) su una data runtime — è la difesa complementare a "la firma prova *chi*, non
  *cosa*".
- **Supply-chain**: firma dei binari (studio/runner), `cargo audit` / `npm audit` in CI.
- **Rifiniture firma**: `engineVersionRange` reale (oggi `"*"`, un gancio), audit firmato
  nel monitor (chi ha eseguito cosa).
- **Affidabilità** (messa da parte, ma reale per un acquirente serio): join tenuto
  INTERAMENTE in RAM (OOM su dataset grandi), ripresa/checkpoint dopo crash, timeout
  uniformi su tutti i nodi, versionamento artifact↔motore.
- **Distribuzione come prodotto**: code-signing + notarizzazione (Windows SmartScreen /
  macOS Gatekeeper), Tauri updater firmato, LICENSE/EULA + attribuzioni dipendenze (crate +
  font/icone Tabler/IBM Plex/JetBrains), doc end-user + progetti d'esempio.
- **Chiusure leggere**: compile-time passphrase (prompt inline in CompileModal alla prima
  compilazione di sessione); traduzione EN dei **pannelli dei singoli nodi**
  (`src/nodes/types/*/Panel.tsx`) e di qualche modale import/export (le aree segnalate —
  proprietà, transactions, bridge, lane/variabili, SigningModal — sono chiuse in P323–P325).

### ⭐ PROMEMORIA ATTIVI (richiesti esplicitamente dall'utente)
1. **Aggiornare la brochure** di sicurezza (`flowpilot-security-brochure.html`) col lavoro
   nuovo: redaction dei segreti, e sezione "garantito oggi" allineata allo stato P332.
2. **Supporto ODBC** per database — casi d'uso **Oracle** e **Informix**. È la realizzazione
   del topic parcheggiato **"Oracle e Informix — pensata (DA RIPRENDERE)"** qui sotto: via
   decisa = **ODBC per entrambi** (crate `odbc-api`); prerequisito d'ambiente sul runner =
   librerie client del fornitore (Oracle Instant Client / IBM Informix CSDK) + driver
   manager (unixODBC su Linux/mac). Lavoro a più patch: nuovo nodo/config nello studio +
   implementazione source/sink ODBC nel motore.

### Decisioni SCARTATE (non riproporre)
- **Data di scadenza dello studio** — valutata e **scartata** dall'utente. (Su desktop
  sarebbe stata comunque un cancello "morbido", non enforcement, e avrebbe stonato col
  valore air-gap.)

---

## AGGIORNAMENTO — runner enforce-only + monitor chiuso per default (stato al P335, 17 ottobre)

Tre patch: **P333 → P334 → P335** (nella storia: P334 in `Aggiornamento`, P333+P335
nel commit `P333,P334,P335`).
Rust compilato e testato anche nell'ambiente delle patch (cargo ora disponibile:
`cargo check/test --no-default-features [--features monitor]`); collaudi end-to-end
con runner e monitor veri.

**P333 — runner enforce-only + `trust` CLI.** Tolte le modalità `off`/`warn`
(`FLOWPILOT_SIGNATURE_MODE` ignorata con avviso) e i ripieghi sul piano nudo.
`TrustStore::open` rigoroso: assente/illeggibile/JSON non valido/**scrivibile da
chiunque** → rifiuto (uscita 3); voci con keyId ≠ fingerprint → ignorate.
`flowpilot_runner trust list|show|add|revoke [--store P]`: `add` esige `--owner`,
verifica chiave e fingerprint, scrive atomico 600/700; una revocata non si riattiva
da CLI. Tolti dal repo i file di runtime rimasti (dati monitor, `pipeline.ffplan` con
password, CSV, tre `flowpilot-monitor-fallback.ndjson` negli esempi, uno con dati di
riga) + `.gitignore`. Dettaglio: `HANDOFF-firma-artifact.md` (delta 5, punto 6b).

**P334 — vista del monitor.** 🐞 **La vista era ROTTA dal P309**: un apostrofo
("the run's") dentro una stringa JS a virgolette singole → SyntaxError, nessuno
script girava (lista run vuota). Corretto. 🐞 **XSS memorizzata**: `run_id` grezzo in
un `onclick`, `esc()` che non sfuggiva le virgolette, numeri delle statistiche non
controllati → chi scriveva un evento eseguiva codice nel browser di chi guardava.
Ora `esc()` completo, `num()` per i numeri, id in `data-id`. Intestazioni di
sicurezza su ogni risposta (CSP senza risorse esterne e `connect-src 'self'`,
`frame-ancestors 'none'`, nosniff, no-referrer, no-store). Id del run decodificato
dall'URL. Collaudo: harness jsdom con eventi ostili (base: 4 problemi; P334: 0).
> Lezione: **dopo ogni modifica alla vista del monitor, `node --check` sullo script
> estratto da `INDEX_HTML`** — la regola "virgolette bilanciate" vale anche per il JS
> dentro le stringhe Rust.

**P335 — monitor chiuso per default.** Bind **127.0.0.1** (`MONITOR_BIND`); **due token
obbligatori e distinti** — `MONITOR_TOKEN` (ingest) e `MONITOR_READ_TOKEN` (lettura:
Basic nel browser, utente qualsiasi; Bearer per le API) — min 16 caratteri, o il
monitor **non parte**. `MONITOR_INSECURE_LOCAL=1` = token facoltativi solo su loopback,
con controllo dell'Host (anti DNS-rebinding). Ingest: rifiuta `Origin` (CSRF da
browser), solo Content-Type NDJSON/JSON, corpo max (`MONITOR_MAX_BODY_BYTES`, 8 MiB),
volume per IP/minuto (`MONITOR_RATE_BYTES_PER_MIN`, 64 MiB), `_observed_ip` dal payload
scartato (era falsificabile). Letture: blocco per IP dopo `MONITOR_AUTH_FAIL_MAX`
password errate (solo letture: un runner con token vecchio non blocca l'host). Pool
di `MONITOR_WORKERS` thread con coda → 503 (prima un thread per richiesta senza tetto).
Manuali aggiornati (Monitor §6 riscritto, build-esecuzione, operativo). ⚠ I `.docx` dei
manuali in `docs/` non sono rigenerati.

**Resta del P0 monitor:** TLS (oggi: reverse proxy), identità per persona/audit di
chi legge, riverifica della firma lato monitor.

---

## AGGIORNAMENTO — aggiornamento tecnologico (stato al P343, 18 ottobre)

Toolchain e dipendenze portate all'ultima versione, con i bug emersi lungo la strada.
Patch **P336 → P342** (nella storia: un unico commit `da P336 a P342`) + **P343**.
Verificato nel sandbox: studio (`desktop`), runner e monitor compilano, test di libreria
e monitor verdi, typecheck invariato (111), `npm audit` 0.

**Toolchain (P336).** Rust **fissato a 1.99.1** in `src-tauri/rust-toolchain.toml` e in CI
(`rust-version = "1.99"`). Per aggiornarlo: cambiarlo in entrambi i posti, ricompilare tutto.

**🐞 Bug trovati aggiornando (corretti):**
- **FTPS in chiaro** (P337): il protocollo "ftps" si collegava in FTP normale, password
  compresa. Ora TLS esplicito (AUTH TLS) **prima** del login, con PROT P.
- **MQTT senza TLS** (P337): `use_tls` letto e poi ignorato.
- **XML** (P337): dal quick-xml 0.38 le entità (`&amp;`, `&#65;`…) non venivano decodificate.
- **SQL injection in `sink_db`** (P338): senza mapping, i nomi di colonna presi dalle
  intestazioni finivano nell'SQL con backtick senza escape. Ora ogni nome di
  tabella/colonna/chiave passa da `sqlsafe.rs` (`check_*`).
- **Lettore MySQL** (P339): anteprima e streaming davano tutto NULL tranne le colonne JSON;
  ora usano lo stesso lettore del nodo `source_db`.
- **Excel** (P342): il formato offerto dal pannello non aveva un lettore nel motore. Ora
  `calamine` nel motore (run + anteprima); **SheetJS (`xlsx` su npm) eliminato**
  (abbandonato e vulnerabile). Scheda: `docs/nodes/source_file.md`.

**Crate principali.** sqlx 0.9 (P338, chiude RUSTSEC-2024-0363), suppaftp 12 su tokio
(chiude RUSTSEC-2026-0271, CRLF injection), rumqttc 0.25 con native-tls, quick-xml 0.42,
rust_xlsxwriter 0.100, reqwest 0.13, notify 8, ldap3 0.12, sysinfo 0.39.
**Crittografia (P340):** ed25519-dalek 3, argon2 0.6, chacha20poly1305 0.11, sha2/hmac
nuovi, `getrandom` diretto. **Parametri argon2 FISSATI** a quelli di argon2 0.5 (19 MiB,
2 passate, 1 corsia): mai dipendere dal default della libreria, o le chiavi cifrate a
riposo non si riaprono. `signing/compat.rs` = **vettori di compatibilità** (chiave
cifrata, firma e manifesto prodotti con le versioni vecchie): se falliscono dopo un
aggiornamento si corregge il codice, **non** i vettori.

**P343.**
- **keyring 2 → 4** (feature `v1`: stessa API; unico cambio `delete_password` →
  `delete_credential`). Store: Keychain (macOS), Credential Manager (Windows), Secret
  Service via zbus 5 (Linux). Provato nel sandbox contro **gnome-keyring reale**
  (scrivi/leggi/sostituisci in connection string/cancella) e **senza D-Bus** (server
  headless): degrada in ~1 ms a "non trovato" e vincono le variabili d'ambiente.
- **TypeScript 7** (compilatore nativo, ~7× più veloce: 3 s contro 20 s) **affiancato
  a TS 6**, come raccomanda Microsoft: TS 7 non ha ancora l'API JavaScript che usa
  `typescript-eslint` (e quindi il guardrail anti-XSS). In `package.json`:
  `"typescript": "npm:@typescript/typescript6@^6.0.2"` (lo importa ESLint; comando
  `tsc6`) e `"@typescript/native": "npm:typescript@^7.0.2"` (comando **`tsc`**).
  Stesso elenco di 111 errori con l'uno e con l'altro. Quando `typescript-eslint`
  supporterà TS 7 (API nuova attesa in 7.1) si toglie l'alias.
- `@types/node` 26.

**Residui di `cargo audit` (non risolvibili da noi, valutati):**
- `rsa` (RUSTSEC-2023-0071) via sqlx-mysql: nessuna correzione esiste; riguarda la
  decifratura, il client MySQL cifra soltanto.
- `zip` 8 (RUSTSEC-2026-0367/0368/0369) via calamine: tutti in `extract()` (estrazione
  su disco), che calamine non usa. Si chiude quando calamine passa a zip 9.
- "unmaintained": `zvariant`/`zbus_names` (zbus 5, store Linux di keyring — zbus 6 è
  uscito il 16 ottobre, lo store non lo usa ancora), `glib` 0.18 e `proc-macro-error`
  (GTK3 di Tauri su Linux).

**✅ Risolto nel P352** (vedi sezione in fondo). Testo originale: `npm run build` (e quindi `tauri build`, che lo usa
come `beforeBuildCommand`) esegue `tsc -b` e **fallisce** per i 111 errori di typecheck
— era così anche prima di questi aggiornamenti. `tauri dev` non ne risente. Sono quasi
tutti variabili/import inutilizzati (TS6133/TS6196) più due errori veri
(`src/ir/canonicalPlan.ts` Uint8Array→BufferSource, `src/store/flowStore.ts` campo
`parallel` non in `NodeAdvanced`). Serve prima di distribuire lo studio.

**Schede dei nodi:** `npm run docs:nodes` oggi riscriverebbe le descrizioni di tutte le
48 schede in **inglese** (residuo della passata EN: il registry è tradotto, le schede
no). Decidere se rigenerarle (schede in inglese) prima di lanciarlo.

---

## AGGIORNAMENTO — ODBC fetta 1: lettura da Oracle / Informix / ODBC generico (stato al P344, 18 ottobre)

Decisioni prese con l'utente: **ODBC anche per Oracle** (il driver nativo `oracledb` si
rivaluta quando esce dalla beta); gestore ODBC collegato **dinamicamente** (unixODBC è
LGPL: niente `vendored-unix-odbc`, che lo incorporerebbe staticamente) → **unixODBC è un
prerequisito di runner e studio su Linux/macOS**, anche dove non si usano questi DB.
Nessuna istanza Oracle/Informix di prova per ora: **collaudo nel sandbox contro
PostgreSQL attraverso il suo driver ODBC (psqlODBC)**; la parte specifica dei due DB
(SQL, tipi, driver) resta da collaudare su istanze vere.

**Motore — `src-tauri/src/odbc.rs`.** `odbc-api` 29 (bloccante → tutto in
`spawn_blocking`). `OdbcPool`: pool per (lane, risorsa) come i pool sqlx, prima
connessione aperta alla creazione (così il retry "prima operazione" la ritenta),
`is_dead` prima del riuso, connessioni guaste scartate. `DbPool::Odbc` in `pool.rs`.
Connection string da: connection string completa → DSN → driver + campi del dialetto
(Oracle EZConnect `DBQ=host:porta/servizio`; Informix `Host/Service/Server/Database/
Protocol=onsoctcp`, driver di default `IBM INFORMIX ODBC DRIVER`); valori con `;{}=`
tra graffe. Lettura a lotti in buffer di **testo** (UTF-8; UTF-16 su Windows) convertito
dal tipo dichiarato: NUMERIC/DECIMAL → **Decimal esatto**, scala 0 e precisione ≤ 18 →
Int, oltre le 28 cifre di Decimal → **Stringa esatta**; date/timestamp normalizzati come
il lettore Postgres; binari (esadecimale) come il lettore Postgres. Testo di dimensione
non dichiarata: tetto 64 Ki caratteri, oltre → errore esplicito di troncamento.
`source_db`: `run_odbc` (blocking_send sul canale, si ferma su annullamento o valle
chiusa), parametri R8 legati tipizzati (`?`), paginazione per dialetto (Oracle `OFFSET …
ROWS FETCH NEXT …`, Informix `SELECT SKIP … FIRST …`, ODBC generico → errore parlante).
Studio: `db_query` (con `maxRows`, il tetto lo applica il backend), `db_infer_schema`
(PREPARA senza eseguire e legge le colonne), test di connessione. `sink_db` su ODBC →
errore esplicito "arriva con la prossima fetta".

**Studio.** Dialetto **`odbc`** nuovo; nella risorsa: *Service name* (Oracle), *Server
DBSERVERNAME* (Informix), sezione **ODBC** (Driver ODBC, DSN, Connection string, Parametri
aggiuntivi). Campo **`odbcDriver`** (non `driver`: nelle risorse vecchie `driver` è un
alias del dialetto). **`dbConnectionParams()`** in `resourceDefaults.ts` = UNICA fonte dei
parametri di connessione per i comandi DB (prima 5 copie divergenti in flowStore,
anteprima, mapping source e sink).

**Collaudo (sandbox, psqlODBC).** Stessa tabella letta nativa e via ODBC: identiche cella
per cella tranne un `numeric(38,10)` a 30 cifre, **esatto via ODBC e arrotondato a f64
dal lettore Postgres nativo** (🐞 preesistente in `pg_col_to_value`: oltre la portata di
Decimal ricade su f64 — da correggere). 200.000 righe in ~5 s (debug). Errori parlanti per
driver mancante e limit su ODBC generico. Anteprima con tetto, schema, parametri legati.

**Prossime fette.** (2) scrittura: `sink_db` insert/upsert (`MERGE` per Oracle e Informix),
DDL per dialetto, pre/post SQL, `db_list_constraints` via cataloghi ODBC. (3) gruppi
transazionali nativi su ODBC (autocommit off), documentazione d'installazione per
piattaforma, eventuale CLOB/LOB in streaming.

## AGGIORNAMENTO — ODBC fetta 2: scrittura + correzione MERGE (stato al P345, 20 ottobre)

**🐞 Grave, corretto: MERGE cancellava le righe.** In `pg_write_pool`/`pg_write_conn` (e
nei rami MySQL/SQLite) il ramo finale `else` era il DELETE: la modalità **MERGE** dello
studio, mai gestita dal motore, finiva lì → **cancellava le righe corrispondenti** e il run
risultava riuscito (verificato: riga id=1 sparita). Ora `check_write_mode(mode, dialect)`
in `lib.rs` (chiamato in config_from_spec di `sink_db` e nei 4 percorsi di scrittura)
accetta solo insert/truncate_insert/upsert/update/delete/merge, rifiuta MERGE su
MySQL/SQLite ("use UPSERT") e qualunque modalità sconosciuta; il ramo DELETE non è più un
`else` cieco.

**MERGE per dialetto.**
- *PostgreSQL nativo (15+)*: `MERGE INTO t AS target USING (SELECT * FROM
  jsonb_populate_record(NULL::t, $1)) AS source ON (…)` — la riga arriva come **un solo
  parametro jsonb** e prende i tipi dalla tabella (con `SELECT $1 AS col` Postgres tipizza
  text e fallisce su date/numeric/NULL). `mergeCondition` personalizzata ammessa; funzioni
  di colonna con `$VALUE` → `source.col`. Senza condizione servono colonne chiave.
- *Oracle (via ODBC)*: `MERGE INTO t target USING (SELECT ? AS c, … FROM DUAL) source ON
  (…) WHEN MATCHED THEN UPDATE … WHEN NOT MATCHED THEN INSERT …` (`merge_parts` condiviso).
  Condizione personalizzata ammessa.
- *Informix e ODBC generico*: MERGE = UPSERT sulle chiavi; condizione personalizzata
  rifiutata con errore parlante.

**🐞 Grave, corretto: TRUNCATE+INSERT teneva solo l'ultimo lotto.** La modalità arrivava a
ogni lotto e ogni lotto rifaceva TRUNCATE: 2500 righe con lotti da 1000 → 500 in tabella,
run riuscito e "2500 scritte" (tutti i dialetti; nel master-detail restava una riga sola;
in transazione invece **non svuotava affatto**). Ora `sink_db` svuota **una volta** dopo
DDL e pre-SQL (`truncate_once`: lotto vuoto con la modalità truncate_insert, così la
sintassi per dialetto resta quella di lib.rs/odbc.rs e la tabella si svuota anche con zero
righe in ingresso), poi i lotti viaggiano come INSERT (`row_mode`); in transazione
`TRUNCATE` dentro `tx_ddl_and_presql` (annullato dal ROLLBACK del gruppo). Collaudato:
nativo, ODBC, transazione, zero righe.

**🐞 Corretto: NULL in colonne date/timestamp (Postgres nativo).** Il NULL veniva legato
come TEXT → "column is of type date but expression is of type text". Ora `PgUntypedNull`
(OID 0, Postgres deduce il tipo dal contesto).

**🐞 Corretto: NUMERIC oltre le 28 cifre (lettore Postgres nativo).** `pg_col_to_value`
ricadeva su f64 (cifre perse); ora, quando non entra in `Decimal`, passa come **testo
esatto** (anche `NaN`/`Infinity`) decodificando il formato binario di NUMERIC
(`numeric_bin_to_text`, testata con vettori di `numeric_send`). Stesso per l'anteprima
(`pg_value_to_json`, prima dava NULL).

**Scrittura ODBC — `odbc.rs`.** `write()` / `WriteJob`: insert, update, delete, upsert
(UPDATE sulle chiavi, INSERT se nessuna riga; se non ci sono colonne da aggiornare →
SELECT di esistenza), merge (sopra), truncate_insert. Istruzioni preparate in cache per
lotto; parametri tipizzati (`json_param`: NULL, bit, i64, f64, timestamp/date ISO →
tipi ODBC, il resto testo). `exec_sql` per pre/post SQL, `table_exists` + DROP/CREATE per
la DDL (`run_ddl` in `sink_db`), `primary_key` dai cataloghi ODBC (`SQLPrimaryKeys`, nome
tal quale/maiuscolo/minuscolo) → `db_list_constraints` ("Load constraints" dello studio).
Oracle: `session_init` imposta `NLS_NUMERIC_CHARACTERS='.,'` e i formati data (non fatale).
`db_write` (studio) passa da ODBC.

**Non ancora su ODBC (errore esplicito, mai silenzio):** gruppi transazionali e
master-detail transazionale ("PostgreSQL only (for now)"), chiavi generate per il
pass-through master-detail. Fetta 3.

**Studio.** Pannello `sink_db`: note per dialetto sulle modalità (UPSERT/MERGE via ODBC,
PG 15+), MERGE nascosto su MySQL/SQLite (resta visibile solo se già selezionato, così si
vede l'errore), avviso sotto la condizione MERGE dove non è ammessa.

**Collaudo (sandbox, PG 16 + psqlODBC).** Stessa sequenza su tre bersagli — nativo,
ODBC generico, "oracle" via ODBC verso Postgres: DDL drop+create con pre/post SQL, insert,
upsert, update, merge sulle chiavi, delete, duplicato con skip, duplicato con stop
(errore atteso), merge con condizione. Nativo e ODBC generico: tutto ok, tabelle finali
identiche. "Oracle":
tutto ok tranne il MERGE, che **Postgres** rifiuta (`integer = text`: psqlODBC incolla i
parametri come letterali tra apici e Postgres non li converte dentro la SELECT): la
sintassi generata è verificata dal log, l'esecuzione va **collaudata su Oracle vero**.
NUMERIC a 34 cifre letto nativo e scritto via ODBC: esatto.

**🐞 Aperti (preesistenti, segnalati, non corretti):**
- ~~Decimali in scrittura passano da f64~~ → **corretto nel P346** (sezione sotto).
- `onConstraintError` = `log`/`update` e la tabella dead-letter non sono implementati
  (righe contate come errori).
- pre/post SQL spezzati su `;`: un blocco PL/SQL (`BEGIN … END;`) si rompe.

## AGGIORNAMENTO — decimali esatti in scrittura + DDL MySQL/SQLite (stato al P346, 20 ottobre)

**🐞 Corretto: i Decimal in scrittura passavano da f64 (tutti i database).** Le righe del
`sink_db` diventavano JSON con `Value::to_json`, che serializza `Decimal` come numero
(feature `serde-float` di rust_decimal), e i binding legavano f64. Misurato prima della
correzione: `222222222222222222.2222222222` in `numeric(38,10)` → `222222222222222200.0000000000`
su Postgres e su MySQL; oltre ~15 cifre significative i decimali sparivano, in silenzio.

**Come.** `Value::to_write_json` / `Row::to_write_json_object` (in `engine/types.rs`)
trasformano il `Decimal` nel marcatore `{"$fp_decimal": "12.50"}` (testo esatto, scala
compresa); `to_json` resta com'era (numero JSON per frontend ed eventi). Il `sink_db` usa
le varianti di scrittura in tutti i percorsi (lotti, transazione, master-detail, mapping
colonne). `crate::json_decimal(v)` riconosce il marcatore (oggetto con **una sola** chiave
`$fp_decimal` e valore stringa) e i binding lo legano:
- Postgres: `rust_decimal::Decimal` → NUMERIC binario esatto (cast implicito di
  assegnazione verso int/float/varchar della colonna);
- MySQL: `Decimal` → DECIMAL;
- SQLite: testo (SQLite non ha decimali esatti: la colonna NUMERIC applica la sua
  affinità e può arrotondare — limite di SQLite, non nostro);
- ODBC: testo con tipo SQL `DECIMAL(p,s)` calcolati dal valore (`decimal_precision_scale`);
- MERGE Postgres: nel jsonb il marcatore diventa stringa, `jsonb_populate_record` la
  converte col tipo della colonna.

**🐞 Corretto: DDL saltata su MySQL e SQLite.** "Crea tabella" / "Drop e ricrea" su questi
due dialetti facevano solo un `eprintln` e poi il nodo falliva con "no such table". Ora
`DROP TABLE IF EXISTS` (con `CASCADE` solo su Postgres) e `CREATE TABLE [IF NOT EXISTS]`.

**Collaudo.** Stessa sequenza (insert con drop+create, update, merge o upsert, insert) su
Postgres nativo, ODBC generico, "oracle" via ODBC, SQLite e **MySQL (MariaDB 10.11 nel
sandbox)**: Postgres nativo, ODBC e MySQL esatti cifra per cifra (tabelle identiche);
"oracle" via Postgres: come al P345, il MERGE resta da collaudare su Oracle vero. Ripetuti
i collaudi del P345 (scrittura su tre bersagli, TRUNCATE+INSERT): invariati.

**Resta (noto):** un NUMERIC oltre le 28 cifre letto da Postgres diventa `Value::String`
(P345) e quindi si lega come testo: in una colonna numeric col driver Postgres nativo
fallisce ("expression is of type text"); via ODBC va.

## AGGIORNAMENTO — ODBC fetta 3: transazioni e master-detail (stato al P347, 20 ottobre)

**Transazioni native su ODBC.** `txregistry.rs`: `TxGroup.odbc_conns` + `get_odbc_conn`
(XA rifiutato con messaggio; native con più risorse rifiutato anche se mischia Postgres e
ODBC); `finalize_with_outcome` chiude prima le connessioni ODBC con `odbc::tx_end`.
`odbc.rs`: `TxConn` (= `Arc<tokio::Mutex<PooledConn>>`), `tx_begin` (autocommit off),
`tx_end` (COMMIT/ROLLBACK + autocommit on; se non riesce la connessione non torna nel
pool — `PooledConn.in_tx`: mai rimettere nel pool una connessione con transazione
aperta), `tx_exec`, `tx_write`; `OdbcPool::sibling()` = pool separato di una connessione.
`sink_db`: `write_all_tx_odbc`, `write_master_detail_tx_odbc` (stesso modello Postgres:
lotti, lock, inoltro del detail fuori dal lock). Scelte:
- **DDL fuori dalla transazione** (`odbc_ddl_outside_tx`, su `sibling()`, PRIMA di unirsi
  al gruppo): Oracle fa COMMIT implicito della DDL e confermerebbe le righe degli altri
  membri; su `sibling` per non attendere una connessione del pool tenuta dal gruppo.
  Conseguenza documentata: il ROLLBACK non toglie la tabella creata.
- **truncate_insert in transazione = `DELETE FROM`** (TRUNCATE è DDL su Oracle).
- **Niente savepoint per lotto**: Oracle/Informix annullano la sola istruzione fallita e
  un membro fallito fa comunque annullare il gruppo.

**Chiavi generate (master-detail) su ODBC.** `WriteJob.returning` (insert, truncate_insert,
upsert, come `use_returning` di Postgres); `DbWriteResult.generated_keys` riempito.
Se la riga porta già il valore della colonna chiave → quello (tutti i dialetti).
Altrimenti: **Oracle** blocco `BEGIN INSERT … RETURNING col INTO ?; END;` con parametro
di **uscita** (testo, `InputsAndOut`: `ParameterCollectionRef` scritto a mano perché le
tuple di odbc-api hanno arità fissa); **Informix** `DBINFO('sqlca.sqlerrd1')`, se 0
`DBINFO('bigserial')`; **generico** → errore parlante. Upsert che aggiorna → `SELECT col
FROM t WHERE <chiavi>`.

**🐞 Corretto: membro Postgres senza connessione di gruppo non segnalato.** Se
`get_pg_conn` falliva (gruppo native con due risorse, BEGIN fallito) o il dialetto non era
supportato, il membro usciva con errore **senza** `report_member_end(false)` → il gruppo
non andava in abort e **gli altri membri committavano**. Verificato prima/dopo (gruppo
native con due risorse Postgres: prima 3 righe confermate nella tabella dell'altro membro,
ora nessuna).

**Collaudo (sandbox, PG 16 + psqlODBC, `examples/p347_tx.rs` usa-e-getta):** commit di
due membri ODBC con drop+create; rollback tutto-o-niente (membro con duplicato e stop);
truncate_insert annullato (righe vecchie intatte) e confermato; master-detail ODBC fuori e
dentro transazione (chiave nella riga), con rollback quando fallisce il detail; chiave
generata su ODBC generico → errore; XA su ODBC → errore; Postgres nativo in transazione
invariato. Parametro di uscita collaudato con psqlODBC (`{call f(?, ?, ?)}`). Percorso
Informix collaudato **emulando** `DBINFO` e `systables` in Postgres. **Non collaudato:**
il blocco PL/SQL di Oracle.

**Collaudi pronti per DB veri** (`odbc.rs`, `tests_live`, `#[ignore]`):
`FP_ORACLE_TEST` / `FP_INFORMIX_TEST` / `FP_ODBC_TEST` con la connection string →
`cargo test --lib tests_live -- --ignored`: tabella `FP_COLLAUDO_K`, chiavi generate,
MERGE, rollback. Da lanciare appena c'è un'istanza.

**Manuale.** §8.5b aggiornato (transazioni, master-detail); nuovo **§8.5c installazione**
di unixODBC, Oracle Instant Client ODBC (`odbc_update_ini.sh`, `odbc_install.exe`, macOS
DMG) e Informix CSDK (`INFORMIXDIR`, `iclit09b.so`, `odbcinst.ini`, nome del driver su
Windows), verifica con `isql -k`, variabili nei servizi systemd.

**~~Aperto~~ → chiuso nel P348:** l'opzione "rollback of this node only" è stata tolta
(sezione sotto).

---

## Oracle e Informix — pensata (DA RIPRENDERE)

> **Stato al P345:** la via ODBC è decisa; **lettura (P344) e scrittura (P345) implementate** (sezioni sopra).
> Il testo qui sotto resta come storia della decisione.

> **Verifica del 17 ottobre (prima di partire con ODBC).**
> - **Oracle: novità vera.** Oracle ha pubblicato un driver **Rust puro ufficiale**,
>   crate **`oracledb`** (github.com/oracle/rust-oracledb, annunciato a settembre 2026):
>   **nessun Instant Client** richiesto. Oggi è **beta** (26.0.0-beta.4, 23 set 2026),
>   API sincrona, MSRV **1.89** (il nostro `rust-version` è 1.99 dal P336). Esiste anche
>   `oracle-rs` (community, async/Tokio, 0.1.x, giovane). Il crate `oracle` (ODPI-C)
>   resta a 0.6.3 (gen 2025) e richiede il client.
> - **Informix: nulla di nuovo in Rust.** `informix_rust` 0.0.4 (2024) avvolge il CSDK ed
>   è immaturo; esiste un driver SQLI puro solo in **Python**. → **ODBC resta l'unica via**.
> - `odbc-api` è vivo: 29.2.0 (4 ott 2026).
> - Effetto sulla decisione 1 qui sotto: l'ibrido non si giustifica più con prestazioni
>   ma con **zero librerie client per Oracle** (air-gap). Il prezzo è adottare una beta.

Richiesto come "fondamentale". **Non è un'aggiunta piccola: è una decisione architetturale del motore.**

**Stato.** Lo studio è quasi pronto: selettore dialetto con `oracle`/`informix`, cataloghi di tipi (Oracle `VARCHAR2/CLOB/NUMBER`, Informix `LVARCHAR/DATETIME YEAR TO SECOND`), query e porte di default. **Il buco è nel motore**: `pool.rs` ha `DbPool = Pg | My | Sqlite` (sqlx) ed esegue solo quei tre (`source_db`/`db_query` → `run_pg`/`run_mysql`/`run_sqlite`); oracle/informix hanno la sonda ma **nessuna esecuzione**.

**Vincolo duro.** `sqlx` non fa Oracle né Informix. Asimmetria che decide tutto:
- **Oracle** ha un crate Rust nativo (`oracle`, su ODPI-C + Instant Client).
- **Informix** **non ha un driver Rust nativo utilizzabile** → unica via reale: **ODBC**.

**Scelta consigliata: ODBC per ENTRAMBI** (crate `odbc-api`). Un solo percorso: Oracle dal suo driver ODBC, Informix dal driver ODBC dell'IBM Informix CSDK. È **l'unico modo di avere Informix** e prende Oracle in omaggio (+ futuri SQL Server/DB2). Alternativa **ibrida**: `oracle` nativo (miglior fedeltà/prestazioni) + ODBC per Informix — solo se su Oracle servono precisione numerica o prestazioni critiche. Nativo per entrambi = impossibile.

**Caveat, anch'esso "fondamentale".** ODBC (e il crate Oracle) richiedono le **librerie client del fornitore sulla macchina che esegue il motore**: Oracle Instant Client; IBM Informix CSDK (con driver ODBC); più un driver manager (unixODBC su Linux/mac, integrato su Windows). **Non impacchettabili** nell'`.ffart` (licenze + binari per piattaforma) → **prerequisito d'ambiente del runner**, da documentare nella beta.

**Forma del lavoro (se ODBC).**
- *Motore*: dipendenza `odbc-api`; variante **`DbPool::Odbc`**; connessione via stringa/DSN ODBC; **`run_odbc`** generica (query + cella→`Value` dai tipi ODBC); agganciata al dispatch di `source_db`/`sink_db`/`db_query`/`db_infer_schema`.
- *Studio*: quasi pronto; aggiungere i campi di connessione ODBC (DSN o driver+parametri) alla risorsa per oracle/informix.
- *Tipi*: SQL ODBC → `Value` (Oracle `NUMBER`, Informix `DATETIME`, ecc. via i tipi generici ODBC).
- *Verificabilità*: **Rust non compilabile nell'ambiente patch** e serve l'header di sviluppo ODBC + i driver del fornitore per build/test → **compile-and-test lato utente**, contro istanze reali.

**Da decidere quando si riprende:**
1. **ODBC unico** vs **ibrido** (Oracle nativo + Informix ODBC).
2. Disponibilità di **istanze di prova** Oracle e/o Informix — **indispensabili** per buildare e testare.
3. Prima fetta proposta: `DbPool::Odbc` + `run_odbc` in **lettura** (`source_db`) contro il DB per cui esiste un'istanza; poi scrittura (`sink_db`); poi l'altro DB.

## AGGIORNAMENTO — via le opzioni che il motore non applica (stato al P348, 20 ottobre)

Decisione con l'utente: **togliere dallo studio ciò che non è chiaro o non si comporta
in modo uniforme**, invece di lasciare opzioni che il motore ignora.

**Transazioni di lane.** Restano solo nome e **mode** (`native` | `xa`). Tolti
`onError` (`rollback_all`/`rollback_self`) e `timeout`: il registro (`txregistry.rs`) fa
**sempre** tutto-o-niente e non ha mai avuto un timeout. Il tipo `LaneTransaction` non li ha
più; l'export del piano non li manda; il motore li accetta ancora nei piani vecchi
(`TransactionPlan`, serde default) e li ignora. La scheda Transazioni lo dice in chiaro.

**Sink DB.** Tolti dal pannello: *Commit every N batches*, *Parallel connections*,
*Transaction timeout* (mai letti dal motore), *On constraint error* = *Log* e *Update* e la
*Dead letter table* (non implementati: le righe in errore finivano contate e il run
risultava riuscito). Restano **Stop** e **Skip**; un valore vecchio diverso → avviso nel
pannello e **errore esplicito al run** (`prepare` in `sink_db.rs`).

**Sink Kafka.** Tolto l'editor "Transaction" (`TransactionGroupEditor.tsx`, cancellato):
scriveva la prop `transactionGroup`, un modello vecchio che il motore non legge (nessuna
transazione Kafka è implementata). Il sottotitolo del nodo non mostra più il badge.

**Validazione (CHECK 8, `dagValidation.ts`) riscritta sul modello vero.** Prima leggeva
`transactionGroup` → non scattava mai per i sink_db. Ora: membri = sink_db con
`props.transactionId`, gruppi = `pool.lanes[].transactions`. Errori, uguali a quelli del
motore: transazione non dichiarata nella lane, nodo senza risorsa, dialetto senza
transazioni (MySQL/SQLite), XA con risorse non PostgreSQL, native con risorse diverse.
Tolto l'avviso "un solo partecipante = nessun effetto" (falso: un membro solo ha comunque
tutte le sue scritture atomiche).

**🐞 Corretto: errore prima di entrare nel gruppo non segnalato.** Un sink_db membro che
falliva in configurazione, controlli o apertura del pool usciva senza
`report_member_end(false)` → gli altri membri committavano. Ora `run` separa `prepare` e,
su errore, segnala il fallimento al gruppo del nodo. Collaudato (Postgres e ODBC): membro
con `onConstraintError=log` → run fallito, **nessuna riga** confermata dall'altro membro;
piano con `timeout`/`on_error` vecchi letto senza errori.

`src-tauri/docs/node-spec.md` aggiornato (props tolte, DDL su tutti i dialetti).

**Restano nello studio ma NON nel motore (da decidere):** tab *Query* del sink_db —
`customQueryMode`/`customSql` (SQL personalizzato) e `storedProcMode` (stored procedure);
`ddlPrimaryKey`; *Identity map* (`identityMapPersist`, `identityMapVarName`,
`identityMapTxGroup`). Sono funzioni vere, non manopole: implementarle o toglierle.

## AGGIORNAMENTO — il mapping del sink_db eseguito davvero (stato al P349, 20 ottobre)

Analisi con l'utente (P348 → "il motore dovrebbe eseguirle"). Provato dal vivo prima
della correzione: **DELETE con chiave `id >` 3 cancellava id = 3** (la riga da tenere) e
lasciava 4 e 5; **SQL personalizzato ignorato** (riga inserita nella tabella del tab
Configurazione, run riuscito); **funzione DB per colonna ignorata** (colonna NULL).

**P349 (questa patch) — mapping.** `lib.rs`: `DbKeyCondition` + `DbWriteRequest.key_conditions`
(serde `keyConditions`, assente = `=`/AND), `where_plan` (WHERE condiviso da Postgres
pool/conn, MySQL, SQLite e ODBC: operatori, AND/OR con precedenze SQL come l'anteprima
dello studio, funzioni di colonna anche in WHERE, chiave mancante nella riga → errore),
`check_key_conditions` (UPSERT/MERGE solo `=`/AND). `sink_db`: legge `dbFunction`,
`keyOperator`, `keyLogic` del mapping e `generatedKeyConfig.dbFunction` ("Sequence");
`{v}` → `$VALUE`, una sola occorrenza; `with_md_key` mette la colonna chiave nell'INSERT
quando la genera una sequenza. Upsert con chiave restituita: la chiave non si riscrive
mai (Postgres `DO UPDATE` la esclude; senza altre colonne `DO UPDATE SET k = EXCLUDED.k`,
perché con `DO NOTHING` il RETURNING non restituisce la riga esistente; MySQL e ODBC
idem). ODBC: `WriteJob.key_conditions`, la chiave calcolata da una funzione si legge
dal DB (Oracle/Informix), su ODBC generico errore che nomina la funzione.
Studio: al posto di `ddlPrimaryKey` il pannello mostra la PK ricavata dai badge PK del
mapping (unica fonte, già usata dal motore). `node-spec.md` aggiornato.

**Collaudo:** DELETE `>`, DELETE `LIKE … OR =`, UPDATE con `UPPER({v})` e chiave
`IS NULL`, UPDATE con funzione letterale e chiave `!=`, UPSERT con `>` → errore — tutto
giusto su **Postgres, ODBC (psqlODBC), MySQL (MariaDB) e SQLite**. Master-detail con
`nextval('seq')` (Postgres): chiavi 100/101/102 nei detail; upsert ripetuto → id
invariati. Regressioni P345/P346 invariate. Test unitario `where_tests`.

**Prossime (decise con l'utente):**
- **P350 — SQL personalizzato e stored procedure** (tab Query): `{campo}` → parametro
  legato (mai testo incollato), errore su campo inesistente o dentro apici; transazioni,
  Stop/Skip, conteggi; stored procedure nella sintassi del dialetto (Postgres/MySQL
  `CALL`, Oracle blocco PL/SQL, Informix `EXECUTE PROCEDURE`; SQLite no); master-detail
  con SQL personalizzato → errore esplicito; correggere il testo falso "pre e post nella
  stessa transazione" e i template (virgolette per dialetto, `{campo}` dentro apici).
  Decisioni (lasciate a Claude dall'utente): **"SQL bulk" tolto** (doppione del
  post-SQL; un progetto che lo usa riceve un errore che indica il post-SQL); **stored
  procedure "una volta" = una chiamata per lotto** (Batch size righe in un array JSON),
  non tutte le righe in una chiamata.
- **P351 — identity map**: mappa "valori Hash → chiave" nel run; tra un run e l'altro
  **ricerca del master nel database** sulle colonne Hash (decisione utente), niente
  variabile di lane né "reset su rollback"; avviso nello studio sul vincolo UNIQUE.

## AGGIORNAMENTO — SQL personalizzato e stored procedure (stato al P350, 20 ottobre)

Regola ribadita dall'utente: **tutte le scritte dello studio in inglese** (chat in italiano).

**Motore.** `lib.rs`: `CustomSql` + `parse_custom_sql` (segnaposto `{campo}` fuori da
apici, virgolette e commenti → `$n` su Postgres, un numero per campo distinto; `?` per
occorrenza altrove; `{campo}` dentro una stringa SQL → errore; `;` finale tolto tranne
`BEGIN/DECLARE`); `DbWriteRequest.custom_sql` (`#[serde(skip)]`, lo costruisce il
motore). I quattro scrittori sqlx e `odbc::WriteJob` hanno il ramo "un'istruzione per
riga con i campi della riga" prima di quelli di modalità (stesso Stop/Skip, stesse
transazioni). Stored procedure **per lotto** (decisione: una chiamata ogni Batch size
righe, non tutte insieme): `sink_db::request_rows` fa del lotto UNA riga con il campo
`rows` = marcatore `{"$fp_json": testo}`; `json_text_exact` scrive il JSON con i Decimal
esatti; Postgres lega `jsonb` (`sqlx::types::Json<RawValue>`, feature serde_json
`raw_value`), gli altri testo; `batch_written` conta tutte le righe del lotto.
`sink_db`: `customQueryMode`/`customSql`/`storedProcMode` letti; `bulk_sql` → errore
(decisione: era il post-SQL con un altro nome); tabella facoltativa con SQL
personalizzato; `write_json_row` (con SQL personalizzato i campi della riga, non il
mapping); master-detail + SQL personalizzato → errore; stored procedure su SQLite →
errore.

**Studio.** Scheda Query: tolto "SQL bulk" (avviso rosso se un progetto lo ha ancora);
stored procedure "For each row" / "Once per batch (rows as JSON)" con esempi per
dialetto (PostgreSQL `CALL` con cast — sceglie la procedura dai tipi, gli interi del
flusso sono bigint —, MySQL `CALL`, Oracle `BEGIN … END;`, Informix `EXECUTE PROCEDURE`,
ODBC `{call …}`); template senza virgolette e per dialetto (via il MERGE e l'audit con
`{campo}` dentro una stringa); corretto il testo falso "pre e post nella stessa
transazione". Validazione (CHECK 9 `checkSinkDbCustomSql`, `customSqlPlaceholders`):
bulk tolto, testo vuoto, segnaposto fra apici, SQLite + procedura, master-detail, per
lotto senza solo `{rows}`.

**Collaudo (Postgres, ODBC/psqlODBC, MySQL/MariaDB, SQLite):** INSERT personalizzato con
campo ripetuto e decimali → righe giuste nella tabella giusta (prima finivano nella
tabella del tab Configurazione); errori fra apici / campo mancante / bulk; procedura per
riga (Postgres con `::int`, ODBC, MySQL); **procedura per lotto con 2500 righe in lotti
da 1000 e decimali a 28 cifre esatti** (Postgres jsonb, ODBC, MySQL `JSON_TABLE`);
per lotto con altri campi → errore; SQLite + procedura → errore; **transazione**: SQL
personalizzato annullato dal rollback del gruppo (Postgres e ODBC). Test unitari
`custom_sql_tests`. Non collaudati su istanze vere: Oracle (PL/SQL, CLOB per il lotto) e
Informix.

**Prossima: P351 — identity map** (decisione utente: ricerca del master nel database).

## AGGIORNAMENTO — identity map del master-detail (stato al P351, 22 ottobre)

**Prima:** il motore non leggeva le colonne Hash: con una sorgente "piatta" (una riga per
riga d'ordine) inseriva il master a ogni riga → duplicati o violazione di chiave. Le opzioni
di persistenza ("variabile di lane", "reset su rollback") non avevano un archivio dietro (le
variabili di lane il motore le legge soltanto) e il pannello creava/cancellava da solo una
variabile di lane `object`.

**Ora (decisione utente: verità nel database).** `sink_db`: `SinkColumn.is_hash_key`,
`SinkDbConfig.hash_cols`, `IdentityMap` (valori Hash → chiave, per run). Nei tre percorsi
master-detail (fuori transazione, transazione Postgres, transazione ODBC): master già visto
nel run → chiave riusata senza scrivere; in **INSERT** un master nuovo per il run si cerca
prima nella tabella (`idmap_lookup_sql`: `SELECT chiave … WHERE` colonne Hash, `IS NULL`
sui nulli, stesse funzioni di colonna — via `where_plan`) sulla stessa connessione della
transazione se c'è (`idmap_lookup_pg` generico sull'executor, `odbc::lookup_key` /
`tx_lookup_key`, MySQL e SQLite sul pool) e si inserisce solo se manca; in **UPSERT** il
master si scrive una volta per run (l'upsert aggiorna o inserisce; un valore Hash NULL non
fa mai conflitto nel vincolo UNIQUE → master nuovo a ogni run: lo studio lo dice, in
INSERT invece si riusa). `rows_out` del master = master scritti davvero.

**Studio.** Tolte la sezione di persistenza e la gestione automatica della variabile di
lane (`identityMap*` non più scritte; le variabili create prima restano e si possono
cancellare a mano). Al loro posto il riquadro "Identity map" spiega cosa succede, con
l'avviso sul vincolo UNIQUE. **Corretto:** la riga di configurazione della chiave generata
(campo d'uscita, colonna PK, sequenza) compariva solo con almeno una colonna Hash; ora
compare con il pass-through attivo (prima, senza Hash, non si poteva cambiare). Badge Hash
con spiegazione al passaggio del mouse.

**Collaudo** (sorgente di 6 righe, 3 clienti di cui uno NULL, ordine mescolato; due run):
Postgres insert, Postgres insert in transazione, Postgres upsert, ODBC insert e ODBC insert
in transazione (chiave nella riga), MySQL e SQLite insert → run 1: 3 master, 6 detail sui
master giusti; run 2: **0 master scritti**, detail sui master del run 1. Upsert con cliente
NULL: nuovo master al run 2 (comportamento del vincolo UNIQUE, documentato). Regressioni
P345/P349/P350 invariate.

## AGGIORNAMENTO — studio senza errori TypeScript (stato al P352, 22 ottobre)

`npx tsc --noEmit -p tsconfig.app.json`: **da 111 errori a 0** (anche `tsconfig.node.json` a 0)
→ **`npm run build` (tsc -b + vite build) passa**, quindi anche il `beforeBuildCommand` di
`tauri build`. **Nuova regola di metodo: ogni patch chiude con tsc a 0** (non più "baseline").

- 2 errori veri: `canonicalPlanBytes` ora restituisce `Uint8Array<ArrayBuffer>` (le lib DOM
  recenti chiedono un `BufferSource` con `ArrayBuffer`, per `crypto.subtle.digest`);
  `NodeAdvanced` non ha `parallel` → tolto dai default del nodo (non lo leggeva nessuno).
- 109 dichiarazioni mai usate (`noUnusedLocals`/`noUnusedParameters`): import tolti; parametri
  non usati con `_`; nomi destrutturati dalle props tolti dal pattern; codice morto rimosso
  (`TabConnection`/`Row`/`Field` in NodeEditorModal, `collectXHandles`, `upsertFieldConfig`,
  `inputColor`, `mb`, costanti e `useMemo` mai letti, `abortFlag` scritto e mai letto nel
  Toolbar). Nessun cambiamento di comportamento.
- Effetto collaterale buono: in `BridgeModal` (SchemaTab) c'erano hook (`useFlowStore`,
  `useMemo`) **dopo** `if (!node) return null` — violazione delle regole degli hook; erano
  proprio quelli inutilizzati, ora tolti.
- ESLint: da 1080 a 983 problemi (non era l'obiettivo; restano da fare).
- Test IR (tsx): invariati. **🐞 Preesistente, segnalato:** `src/ir/userFunctions.test.ts`
  ha 4 FAIL (ridefinire `upper`, ricorsione indiretta, variabile non parametro nel corpo,
  definizione malformata non vengono rifiutate) — la validazione delle funzioni utente FPEL
  non copre questi casi.

## AGGIORNAMENTO — Start/End facoltativi + traduzione pannello risorse (stato al P353, 22 ottobre)

**Start/End delle lane (decisione utente).** Non si creano più da soli (né nel progetto
nuovo, né con "Clear canvas", né aggiungendo una lane): suggerivano un ordine di
esecuzione che non c'è (tutti i nodi di una lane partono insieme; li ordinano solo gli
archi di dati) e il motore li salta già (Toolbar `SKIP_TYPES`, lowering `lane_boundary`).
Restano nella palette, sezione **Flow**, come segnaposto grafici facoltativi
(`addNode` li crea come `startNode`/`endNode`) e si possono cancellare: il blocco in
`LaneCanvas.onNodesChange` ora protegge solo l'Error Handler; `normalizeLoadedNodes`
(flowStore) rende cancellabili quelli dei progetti salvati prima (`deletable:false`),
all'apertura e al ripristino di una versione. Descrizioni nella palette aggiornate.

**Traduzione (regola: tutto lo studio in inglese).** Pannello delle risorse completo
(DB/ODBC, LDAP, GitHub, HTTP, Kafka, MQTT, FTP, Webhook: sezioni, campi, stato, pulsanti,
conferma di cancellazione), azioni "Add to canvas" (le canoniche ora hanno la precedenza
sulle etichette salvate nella risorsa, così i progetti vecchi mostrano quelle attuali),
modelli di risorsa, Filter (operatori, clausole, modalità, uscite, nodo sul canvas),
scheda Transactions, finestre di dialogo file (`lib/tauri.ts`).

**Restano in italiano:** ~560 occorrenze candidate in ~97 file (stima per eccesso dello
scanner: contiene anche codice generato e messaggi d'errore). I più grandi: `ssh_exec`
Panel, `data_quality` (tipi delle regole), `pivot`, `EnvironmentsModal`, messaggi di
`exprParser`/`connectionResolver`/`aggFunctions`, `CompileModal`, `join`, `json_serializer`.

**🐞 Trovati nel Filter, non corretti (stessa famiglia del P348: lo studio promette, il
motore non fa):** "Case sensitive" ignorato (confronti sempre case-insensitive);
"Branch execution mode" (parallel/sequential/ordered with wait) ignorato; modalità
"code" (TypeScript/JS/Python) non eseguibile nel motore → la condizione è falsa con un
warning. Da decidere: implementare o togliere.

## AGGIORNAMENTO — Filter: code FPEL, case sensitive, rami ordinati (stato al P354, 22 ottobre)

Chiude i tre 🐞 del Filter segnalati al P353 (decisione utente: implementare tutti e tre).

**Modalità code = solo FPEL.** Tolta la scelta TypeScript/Python/Java. Il pannello ha un
editor FPEL (grammatica `flowpilot`) con validazione dal vivo (`compileFpel`, funzioni utente
incluse) e riconosce le condizioni scritte nella vecchia modalità JS (`=>`, `->`, `def`,
`lambda`) chiedendo di riscriverle. Il builder (`Toolbar`, `case 'filter'`) compila ogni
condizione code in IR (`expr`); un errore blocca il Run. Il motore valuta
`is_truthy(eval(expr))`; condizione code senza `expr` → il nodo fallisce all'avvio (prima:
sempre falsa con un warning). Visual e template mostrano il loro **FPEL equivalente**
(`conditionToFpel` in `filterTypes.ts`, che sostituisce il JS di `toCode`), usato come
punto di partenza passando a code. **Collaudo di equivalenza** (throwaway): 368 condizioni
(tutti gli operatori × campi presenti/assenti/con spazi, combinazioni AND/OR, 17 template ×
2, case sensitive sì/no, null exclude/include) × 4 righe → 0 differenze fra valutazione
nativa e FPEL generato. `FilterModal.tsx` era codice morto (mai importato): rimosso.

**Case sensitive applicato** a visual (==, !=, contains, starts, ends, in, not in, regex) e
ai template di testo; default sì (era il default mostrato). ⚠ Cambio di comportamento: i
Filter salvati con "Yes" (il default) prima confrontavano senza maiuscole.

**Regex vere.** Operatore `regex` e template `str_regex`: crate `regex`, compilata all'avvio
(pattern non valido → il nodo fallisce col motivo); prima era un "contiene"
case-insensitive. Anche la funzione FPEL `regex_match` era un `contains` travestito (TODO
"Fase 6b"): ora regex vera, con cache per thread condivisa con `replace_regex`. Effetto: il
template Script "validazione email" ora funziona davvero.

**Branch execution mode.** `ordered_wait` implementato: ramo #1 in streaming, rami #2..#N
trattenuti in memoria e rilasciati quando tutti i nodi a valle del ramo precedente hanno
finito; se uno fallisce i rami successivi non partono e il filtro fallisce. Infrastruttura
nuova: `engine/completion.rs` (`LaneCompletion`: archi della lane + un `watch` per nodo;
`DoneGuard` nel wrapper di spawn dell'executor marca la fine anche su errore/panic/abort),
nel `NodeContext` come `lane_done`. I nodi raggiunti anche da un ramo successivo o da reject
sono esclusi dall'attesa (deadlock) → warning nel log e a design-time (`FILTER_ORDER_SHARED`).
`sequential` tolto dal pannello: in streaming non ha differenze osservabili da parallel (il
motore lo tratta come parallel). Collaudo su Postgres (tabelle con FK, dettagli prima dei
master nello stream, 3000+3000 righe): parallel → violazione FK; ordered_wait → tutto
scritto; master che fallisce → dettagli non emessi, filtro fallito col motivo; rami
convergenti sullo stesso nodo → warning, nessun deadlock.

**FPEL, semantica dei confronti (trovata col collaudo di equivalenza).**
- `<` `<=` `>` `>=` con un null erano veri quando il null stava "a sinistra" (null = il più
  piccolo): `importo < 100` passava per ogni importo mancante. Ora falsi (SQL). L'ordinamento
  di `min`/`max` resta invariato.
- Decimal (P346) contro Int/Float e testo numerico contro numero si confrontavano come
  stringhe (`"10" > 9` falso, `Decimal(100.50) == 100.5` falso). Ora numerico (Decimal esatto
  quando possibile). Testo non numerico contro numero → falso.
- `is_before`/`is_after`/`diff_days` & co. non leggevano le date RFC 3339 con fuso, cioè il
  valore di `now()`: `is_before(x, now())` era null. Ora lette.

**Validazione a design-time** (`checkFilterConditions` in `dagValidation`): condizione code
vuota o non compilabile (`FILTER_CODE_INVALID`), template non scelto (`FILTER_NO_TEMPLATE`),
rami ordinati con nodi a valle condivisi (`FILTER_ORDER_SHARED`).

**Altro.** Messaggi d'errore del parser FPEL (`exprParser.ts`) tradotti in inglese (ora si
vedono anche nel pannello Filter). Sottotitolo del nodo Filter: leggeva `props.rules`
(inesistente, diceva sempre "no rules"), ora conta le condizioni. Etichette residue in
italiano del pannello Filter tradotte. Doc: node-spec §16, manuale FPEL (§3.4 confronti,
`regex_match`), `docs/nodes/filter.md` (approfondimento).

**Non toccato:** il generatore di codice TypeScript (`codegen/.../generators.ts`, filter) usa
ancora la stringa della condizione e un solo ramo — era già fuori allineamento col motore.

## AGGIORNAMENTO — Audit studio↔motore e scheda Advanced applicata (stato al P355, 23 ottobre)

**Audit (22 ottobre, su richiesta utente).** Confronto statico chiavi dei pannelli ↔ chiavi
lette dal motore (+ builder), poi verifica a mano dei casi. Nessun nodo è più uno stub, ma
molte opzioni non sono applicate. Ordine deciso con l'utente ("dobbiamo mettere a posto
tutto", principio P348: implementare o togliere):
1. ✅ scheda Advanced (questo P355);
2. sink_ftp (chiavi pannello ≠ motore: `fileFormat`/`format`, `writeMode` con due
   significati, `fileName` ignorato, `atomicWrite`/`atomic`; compressione, encoding,
   permessi ignorati);
3. source_file (jsonl/parquet/orc/avro/pdf/text letti come CSV; json/xml una riga grezza;
   percorso da variabile/flusso ignorato; encoding/quote/escape/comment/skip/limit/glob
   ignorati; rinomina e trasformazioni del mapping perse);
4. Kafka (senza REST Proxy non pubblica né legge, e il pannello non ha il campo; il sink
   scarta le righe con un avviso) — **serve decisione utente**: campo REST Proxy o togliere;
5. bridge (transfer/batch/buffer/output passthrough-signal/sync wait-for-ack/gate/timeout
   tutti ignorati); 6. explode (mapping ignorato); 7. sink_file (mapping colonne,
   partizionamento, post-command, webhook, encoding ≠ UTF-8: avvisi solo su stderr; formati
   excel/parquet/orc/avro offerti ma falliscono al Run); 8. source_ftp (after-fetch,
   fetch mode, ordine, ricorsivo, header, compressione, encoding); 9. dir_watcher (percorso da
   variabile, dedup hash/mtime/file, stabilityMs); 10. join (sorgente destra "Query inline"
   = stream in silenzio; algorithm/broadcast); 11. materialize (onDuplicate, clearOn), union
   (schemaMismatch).
   🟡 Minori: source_db fetchSize/queryTimeout; ActiveMQ durable/prefetch/retry/OpenWire; MQTT
   version/connectTimeout; mail priority; script timeout/memory/sandbox; ssh cwd/env; HTTP
   OAuth2 auto-refresh; xml_serializer validateOutput + encoding; webhook varPollMs e
   drop_newest; error_handler defaultOnError/logAll; aggregate execMode streaming; pivot
   distinctValuesMat; "Materialize access mode" (solo codegen). 🧹 Studio: la scheda Mapping
   di Data Quality legge `dqRules` che nessuno scrive; `json_serializer/Panel.tsx` morto.

**P355 — scheda Advanced (vale per tutti i nodi).** Nuovo `run_with_policy` attorno a
`run_node` nel wrapper di spawn; politica in `errors::exec_policy` (`ExecPolicy`).
- **Catch sul nodo** (prima la porta non emetteva mai): se il nodo fallisce, la riga
  `_error_*` di `build_error_row` esce sulla `catch` e l'errore è gestito — la lane prosegue
  (NodeFailed + log "handled on the catch port"). Catch scollegata → error handler (prima:
  l'errore non andava all'EH). Membro di transazione → rollback del gruppo comunque
  (`caught_in_tx`). Livello nodo, non riga (decisione in DISEGNO-error-handling §13).
  Schema unico `CATCH_PORT_SCHEMA` (types/index.ts) per lowering, canvas (prima: dati del
  nodo + un `_catch` oggetto), `getHandleSchema('catch')` e scheda.
- **Retry** (prima solo source_db/sink_db): il nodo si rilancia da capo dopo l'attesa se è
  fallito senza aver emesso righe (uscite contate da canali-proxy per tentativo) e non ha
  ingressi di dati. DB invariati (`RETRY_IN_NODE`). Lo studio offre il retry solo dove si
  applica; validazione `RETRY_NOT_APPLICABLE`; il motore lo dice nel log se lo trova altrove.
- **Max run time**: `maxRunSec` (scritto dal builder dal campo della scheda) → timeout del
  nodo, errore "timed out after N s". NON si legge `timeoutSec`: era '30' di default in ogni
  nodo senza effetto, e i piani esportati prima non devono cambiare. Allo studio il '30'
  dei progetti salvati diventa '0' all'apertura (`normalizeAdvanced`), tranne dir_watcher
  (lì è la durata dell'osservazione, e il limite generico non si applica). Nota: un timeout
  ferma il nodo ma una query DB già partita finisce lato server (la lane chiude dopo).
- **Tolti** (P348): "Batch size" generico (mai applicato; sink_db ha il suo) e la sezione
  "Status — fields emitted to the next node / lane variables" (descriveva campi che il motore
  non produce).
- Collaudo (harness throwaway, PG): catch collegata → RunCompleted + riga d'errore; catch
  scollegata → RunFailed; retry con file che compare dopo 1,5 s → 2 tentativi falliti poi
  ok; retry esaurito → "(after 2 retries)"; retry su nodo con ingresso → avviso, non
  applicato; maxRunSec 1 su pg_sleep(5) → "timed out after 1 s"; catch in un membro di
  transazione → lane ok, 0 righe (rollback; controllo: senza errore 2 righe).

## AGGIORNAMENTO — SFTP Output allineato al pannello (stato al P356, 23 ottobre)

Punto 2 dell'audit. Il nodo `sink_ftp` era scollegato dal suo pannello: formato letto da
`format` (il pannello scrive `fileFormat` → sempre CSV), `writeMode` con due significati
(motore: righe/campo; pannello: overwrite/append/new/error → ignorato), `fileName` ignorato
(con la cartella in remotePath si scriveva un file chiamato come la cartella),
`atomicWrite` letto come `atomic`, compressione/encoding/permessi/timeout ignorati,
passthrough mai emesso, segnale con campi diversi da quelli mostrati.

- **lib.rs**: nuovi `ftp_resolve_target` (percorso definitivo: esiste? dimensione? nome
  libero `_N` per "new"; errore per "error") e `ftp_write_bytes` (byte, non testo;
  append — SFTP open APPEND + seek, FTP `APPE`; atomic anche in FTP con `.tmp` + rename;
  cartelle anche in FTP; chmod — SFTP setstat, FTP `SITE CHMOD`, con avviso se il server
  rifiuta). `ftp_write_impl` (comando Tauri) invariato.
- **engine/text_encoding.rs** (nuovo, senza crate): UTF-8, UTF-16LE+BOM, ISO-8859-1,
  Windows-1252, ASCII; caratteri non rappresentabili → `?` contati nel log. Pronto per
  sink_file (punto 7).
- **sink_ftp.rs** riscritto sulle chiavi del pannello, con compatibilità per i progetti
  vecchi (`format`, `writeMode` = rows/raw_field, `atomic`, percorso intero in remotePath).
  Formati csv/tsv/json/jsonl/xml/**excel** (rust_xlsxwriter, numeri come numeri);
  contenuto da campo (testo o **base64**, prima rifiutato); gzip/zip (crate `flate2` e
  `zip` 9 — già nel lockfile via rust_xlsxwriter, solo 2 righe nuove in Cargo.lock);
  append solo dove ha senso (CSV/TSV/JSONL/campo, senza ZIP: altrimenti errore chiaro).
  Retry della scheda Advanced su connessione e upload (non l'upload in append) →
  `RETRY_IN_NODE` += sink_ftp (executor, TabAdvanced, dagValidation).
- **Pannello**: tolti Parquet, larghezza fissa, BZIP2, `{batch_id}` (il motore non li
  fa); aggiunta la scelta "righe / valore di un campo"; avviso se append è incompatibile;
  testi in inglese; nota finale corretta (non "una connessione per batch"). Schema del
  segnale in `sink_ftp/schema.ts`, usato da pannello e `schemaInference` (passthrough →
  schema in ingresso). Sottotitolo: mostra il formato (il protocollo è nella risorsa).
- **Collaudo** (throwaway) su SFTP reale (openssh, :2222) e FTP reale (pyftpdlib, :2121),
  12 casi × 2: nome con `{run_id}` + cartelle create; append ×2 → intestazione una volta e
  4 righe; new ×2 → `n.csv` e `n_1.csv`; error su esistente → fallisce; excel+gzip →
  `.xlsx.gz` valido; JSONL Windows-1252 → `è`=E8, `€`=80; csv zip → archivio con `z.csv`;
  chmod 600 applicato + passthrough a valle; progetto "vecchio" → JSON corretto; append su
  JSON array → errore chiaro; retry su porta chiusa → 2 tentativi poi "(after 2 retries)".
  Nessun `.tmp` rimasto.
- ⚠ Visto e non toccato: lo studio descrive l'uscita dei sink su file con campi `status.*`
  e `row.*` (schemaInference/connectionResolver), il motore emette campi piatti — da
  sistemare con sink_file (punto 7).

## AGGIORNAMENTO — File Input allineato al pannello (stato al P357, 23 ottobre)

Punto 3 dell'audit. `source_file.rs` riscritto (lettori per formato in un thread
bloccante, righe in streaming su canale), excel e test P342 conservati.
- **Formati**: jsonl, text, binary, pdf_binary prima letti come CSV → ora lettori veri;
  json una riga col testo grezzo → valore al `jsonPath` (`$`, `$.a.b`, `$.a[0].b`), una
  riga (default, compatibile) o una per elemento (`jsonStructure = array`), campi
  `content` (object) + `raw` come dichiarava FIXED_SCHEMA. ⚠ `content` è ora un oggetto,
  non un testo (il JSON Parser accetta entrambi). Parquet/ORC/Avro/estrazione testo PDF:
  tolti (nessun lettore; il motore dà un errore chiaro sui progetti vecchi, il pannello lo
  segnala).
- **CSV**: parser nuovo — quote configurabile, escape (solo dentro le quote, davanti a quote
  o a sé stesso: `C:\dir` resta com'è), commenti, campi su più righe, BOM UTF-8 tolto
  (prima finiva nel nome della prima colonna), campi non quotati senza spazi ai bordi.
  `parse_csv_line` resta (source_ftp) appoggiato al nuovo parser.
- **Encoding**: `text_encoding::decode_text` / `decode_byte` (UTF-8 con errore che dice la
  riga, UTF-16 con BOM, ISO-8859-1, Windows-1252, ASCII). UTF-8 e a un byte in streaming,
  UTF-16 in memoria.
- **Percorso**: variabile di lane e campo della riga in ingresso (cardinalità 1, come
  deciso il 16 lug) — prima ignorati; **glob** sul nome del file, in ordine, `limit` sul
  totale; `skipRows`, `limit` applicati.
- **Mapping**: il builder (`sourceFileSpecFields`, `source_file/spec.ts`, usato anche
  dall'anteprima) manda `{name, physical, type, transform}`; il motore emette solo i campi
  mappati, col nome logico, trasformati e convertiti. Prima mandava `{name: physicalName}`
  → la rinomina del mapping si perdeva e lo schema dello studio non corrispondeva ai dati.
  Trasformazioni nel pannello ridotte a maiuscolo/minuscolo (trim, vuoto→null e le
  conversioni le facevano già la conversione di tipo / la colonna Type; i valori vecchi
  restano applicati e mostrati "(legacy)").
- **Studio**: `SOURCE_FORMAT_GROUPS`/`SOURCE_FORMATS`/`SOURCE_TEXT_FORMATS`/
  `SOURCE_TABULAR_FORMATS` in fileSchema.ts (FORMAT_GROUPS resta a sink_file, punto 7);
  pannello con le sole opzioni reali per formato, glob accanto al percorso statico,
  avviso sui formati tolti; anteprima e "carica schema" del mapping per CSV/TSV via motore
  con tutte le props del nodo; pannello laterale e sottotitolo aggiornati; testi in inglese.
- **Collaudo**: 6 test unitari nuovi (CSV completo, mapping, Windows-1252, json/jsonl/
  text/binary, glob) + harness throwaway sul motore: statico+mapping, variabile di lane,
  flusso (source_db → path), glob con limite su due file, json col path, parquet → errore.

## AGGIORNAMENTO — Kafka sospeso (stato al P358, 23 ottobre)

Punto 4 dell'audit, **decisione utente**: Kafka fuori dalla palette finché non sarà
pubblicata e validata una versione pilota/beta della suite; poi si ripristina (servirà il
protocollo nativo: oggi il motore parla solo con un REST Proxy di Confluent, e il pannello
non ha nemmeno il campo per configurarlo).
- Palette (`PALETTE_SECTIONS`) e striscia risorse (modello "Kafka") senza Kafka. Tipi,
  pannelli e codice restano: i progetti esistenti si aprono.
- Validazione: `NODE_SUSPENDED` (errore, blocca il Run) su source_kafka / sink_kafka
  (`NODI_SOSPESI` in dagValidation).
- Motore: senza REST Proxy il sink **fallisce** (prima: avviso, riga `_kafka_skipped`, run
  riuscito = dati scartati in silenzio) e la sorgente pure (prima: run riuscito a zero
  righe). Vale anche per i piani esportati eseguiti dal runner, che non passano dalla
  validazione dello studio.
- Per ripristinarlo: togliere le due voci da `NODI_SOSPESI`, rimetterle in
  `PALETTE_SECTIONS` e nella striscia risorse (LaneCanvas), e dare al nodo un trasporto vero.

Verifica chiesta dall'utente — **File Input JSON → JSON Parser dopo il P357**: provato sul
motore (harness throwaway) in tre forme, tutte corrette: documento intero (default) +
parser con flusso `$.ordini` array; una riga per ordine (path `$.ordini`, Array) + parser
`$`; JSON Lines + parser `$`. Il JSON Parser accetta `content` sia testo sia oggetto
(`parse_source`).

🟡 **Aggiunte all'audit** (nodi configurati da editor, sfuggiti al confronto delle props):
nel JSON Parser il `type` dei campi non converte (`#[allow(dead_code)]`: 7 resta intero
anche se dichiarato decimal), `filter` e `streaming` del flusso sono ignorati. Da
controllare allo stesso modo TMap, XML Parser, JSON/XML Serializer, Data Quality.

## AGGIORNAMENTO — Bridge: le opzioni fanno ciò che dicono (stato al P359, 23 ottobre)

Punto 5 dell'audit: tutte le opzioni del bridge erano ignorate (il piano porta solo gli
id). Implementate quelle che hanno senso in un canale in memoria, tolte le altre.
- **BridgeOut — uscita nella lane** (`outputMode`): passthrough (le stesse righe anche a
  valle nella lane) e signal (`channel`, `rows_sent`, `status`, `sent_at`). Prima l'arm
  dell'executor non prendeva l'uscita: un arco disegnato riceveva zero righe. Porte
  condizionali in nodeSemantics (`when outputMode`), schema del segnale
  `BRIDGE_SIGNAL_SCHEMA` (bridgeSchema.ts) in schemaPropagation.
- **BridgeOut — wait for ack** (`syncMode`): nuovo `oneshot` di conferma BridgeIn →
  BridgeOut in `BridgeOutEnds/BridgeInEnds`; il BridgeOut chiude il canale, aspetta la
  conferma, status `delivered`; se la lane di valle muore prima → errore.
- **BridgeIn — delivery** (`delivery` = stream | all): "all at once" tiene le righe finché
  il flusso è completo e confermato (`done`), poi le passa; se la lane sorgente si
  interrompe non passa niente. **Wait timeout** (`waitTimeoutSec`, 0 = nessuno) sulla prima
  riga. Il builder li mette nella config del nodo (`all_at_once`, `timeout_sec`). Un
  BridgeIn senza nodi a valle ora scarica il canale e conferma (prima usciva subito).
- **Tolti** (P348): transfer mode content/stream e batch size (il canale è in memoria, riga
  per riga), gate del BridgeOut, wait-for-ack del BridgeIn, buffer size e "buffer pieno"
  (la contropressione c'è già: la lane sorgente aspetta).
- ⚠ **Lezione (vale per tutti i prossimi punti)**: `addNode` salva nelle props di ogni nodo
  nuovo TUTTI i default dei `fields` di `nodeDefs.ts`. Quindi "valore assente" non vuol dire
  "non scelto": il bridge_out aveva `transferMode: 'content'` e il bridge_in
  `timeoutSec: '30'` salvati ovunque, mai applicati. Per non cambiare il comportamento dei
  progetti esistenti si usano chiavi nuove (`delivery`, `waitTimeoutSec`) e le vecchie non
  si leggono (eccetto `syncMode = gate`, che si otteneva solo scegliendolo). Prima di
  applicare un'opzione finora ignorata, guardare il suo default in nodeDefs.
- Collaudo: harness throwaway su due lane (stream; passthrough; signal + wait for ack →
  `delivered` e BridgeOut chiuso dopo il BridgeIn; signal senza ack → `sent`; all at once;
  timeout 1 s su sorgente lenta → errore; timeout 5 s rispettato) + 2 test unitari
  (all at once con mittente morto → nessuna riga a valle; stream interrotto → errore).

## AGGIORNAMENTO — Explode: il mapping si applica (stato al P360, 23 ottobre)

Punto 6 dell'audit: la tab Mapping dell'Explode (`explodeMapping`: sourceField, outputName,
type, transform, include) era ignorata dal motore, e lo schema d'uscita dello studio non
corrispondeva ai dati.
- **Motore** (`explode.rs`): con un mapping, ogni riga esplosa esce con SOLO i campi
  inclusi, col nome logico, trasformazione del testo (trim/uppercase/lowercase/
  nullify_empty) e tipo; le vecchie to_* valgono come tipo. Un valore non convertibile
  resta com'è (niente null silenzioso) e a fine esecuzione c'è un avviso `warn` per campo.
  Il mapping vale per l'elemento esploso; i campi del padre (includeParent) si aggiungono
  com'erano. Riga `null_row`: i campi del mapping a null. Senza mapping: come prima.
  Mapping non JSON → errore parlante.
- **Modulo comune** `engine/field_mapping.rs`: `transform_text`, `effective_type`,
  `try_coerce`/`coerce`, `matches_type` — tolti da source_file.rs, che ora li importa. Il
  tipo `number` ora dà un numero (prima, in source_file, una stringa).
- **Studio**: lo schema d'uscita ha UNA regola, `explode/schema.ts`
  (`explodeOutputSchema`), calcolata e propagata dal MappingPanel (sempre montato
  nell'editor). Prima c'erano tre scrittori in conflitto: l'effetto del Panel (che a ogni
  apertura rimetteva lo schema completo del materialize, cancellando il mapping), il
  saveMapping e l'editor manuale dello schema per flow_field — quest'ultimo è stato tolto:
  per flow_field i campi si dichiarano nella tab Mapping. Uno schema manuale vecchio resta
  finché il mapping non viene toccato (prop `explodeMapping` assente). Trasformazioni
  offerte: none/trim/UPPER/lower/empty→null; le to_* salvate compaiono come "(legacy)".
  Hook spostati prima dei return in Panel e MappingPanel. Sottotitolo flow_field col nome
  del campo; descrizione nodeDefs senza "lane variables".
- Compatibilità: nodeDefs explode non ha `fields` (niente default salvati). Un mapping già
  salvato ora si applica: con la sorgente materialize è stato seminato all'apertura della
  tab con tutti i campi del dataset, quindi l'effetto è tenere solo i campi dichiarati
  (lo schema che lo studio già mostrava) e convertire ai tipi dichiarati, lasciando
  com'è ciò che non si converte.
- Collaudo: 3 test unitari (mapping, field_mapping) + harness throwaway (CSV con campo JSON
  → flow_field + includeParent + mapping + null_row; senza mapping invariato; materialize
  signal → explode con rinomina/tipo/uppercase; mapping rotto → errore). Prossimo punto
  dell'audit: sink_file.

## AGGIORNAMENTO — File Output: ogni opzione fa ciò che dice (stato al P361, 23 ottobre)

Punto 7 dell'audit. `sink_file.rs` riscritto (v3) attorno a un `Target` per file aperto.
- **Formati**: righe csv/tsv/json/jsonl/xml + **excel** (rust_xlsxwriter: `sheetName`,
  `headerStyle` none/bold/colored, numeri come numeri, max 1.048.576 righe); valore di un
  campo html/text (testo) ed excel_b64/binary (base64 decodificato, forzato dal formato:
  prima excel_b64 senza `rawEncoding=base64` scriveva il testo base64). parquet/orc/avro/
  pdf_* → errore chiaro (prima text/binary/pdf venivano scritti come CSV in silenzio).
  Studio: `sink_file/schema.ts` (`SINK_FILE_FORMAT_GROUPS`, formati, estensioni, segnale);
  tolti `FORMAT_GROUPS`/`STRUCTURED_FORMATS` (etichette italiane, gruppo Report doppio) da
  fileSchema; formato vecchio non scrivibile mostrato come "(not supported for writing)".
- **Percorso**: `${date}` `${datetime}` `${uuid}` `${seq}` `${partition}` (prima scritti
  letteralmente); cartelle mancanti create.
- **Modalità**: `new` = nome libero `_1`, `_2`… (prima = `error`); append su array JSON,
  XML o Excel → errore (prima file corrotto). `writeHeader=auto` = solo se nuovo/vuoto.
- **Colonne** (`fileColumns`, tab Mapping): applicate dal motore via
  `FieldMapping` — spostato da explode.rs in `engine/field_mapping.rs` (P360), ora
  condiviso. Ordine delle colonne = ordine del mapping (anche in JSON: `json_object` non
  ordina). Prima le colonne stavano in `outputSchema` (e i nomi rinominati in
  `incomingSchema` del nodo stesso), erano modificabili solo in replay e il motore le
  ignorava. `normalizeSinkFile` (flowStore, al caricamento) sposta il vecchio mapping in
  `fileColumns`, rimette `outputSchema` (segnale o vuoto) e toglie `passthrough`/
  `processingMode`. La tab non semina più da sola: con zero colonne si scrive tutto
  (alfabetico) e un pulsante le carica dai campi in ingresso.
- **Codifica**: `text_encoding::encode_chunk` (senza BOM) + `bom()`; il BOM UTF-16 solo in
  testa a un file nuovo/vuoto; caratteri non rappresentabili → `?` + avviso.
- **Partizioni**: field / date (year|month|day|hour; data illeggibile → `_unknown` +
  avviso) / size (`partitionMaxMb`, nuovo campo; non per Excel). Max 1000 aperte.
- **Uscita**: signal = una riga di stato PER FILE (status "ok"); replay invariato.
  Studio: schemaInference e schemaPropagation (`case 'sink'`, anche sink_ftp) danno lo
  schema del segnale o l'ingresso; `useIncomingSchema` tratta sink_file in replay e
  sink_ftp in passthrough come passthrough; FlowNode "buffered output" = replay.
- **postCommand** (sh -c / cmd /C, per file, `${file}` e `FP_FILE`; uscita ≠ 0 → errore) e
  **webhookUrl** (POST JSON, timeout 30 s; errore → avviso) implementati.
- **connectionResolver**: tolti i campi fantasma `status.*` (status.ok, status.rows_written…)
  che venivano aggiunti all'ingresso del TMap per OGNI sorgente collegata: il motore non li
  produce mai. Gli ingressi TMap già salvati li conservano (la sezione Status del TMap li
  mostra ancora): 🟡 da ripulire, insieme a TMapModal/StatusFieldsSection, con l'audit TMap.
- Collaudo: 3 test unitari (percorsi, JSON ordinato, date) + harness throwaway su file
  reali (CSV con colonne + crlf + windows-1252 + append/auto ×2; JSON indent 4; append su
  array → errore; Excel foglio "Dati" colorato riletto dal File Input; partizioni campo in
  cartella / mese / dimensione; new ×2; ${seq} ×2; binario da base64; testo UTF-16 con BOM;
  comando ok e in errore; webhook su server locale e irraggiungibile; segnale per file
  verso un secondo sink; parquet e pdf_text → errore). Prossimo punto: source_ftp.
