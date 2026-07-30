# FlowPilot — Documento di passaggio (handoff sessione)

Questo documento serve a riprendere il lavoro su FlowPilot in una nuova
chat senza perdere contesto. Leggilo per intero prima di ripartire, poi
**leggi il repo per lo stato vero** (vedi "Metodo di lavoro").

Sostituisce l'handoff precedente. Aggiornato a: **27 luglio** — ultima
consegna di riferimento: **P93b**. Da P47 a oggi: chiuso il porting del nodo
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
- **Non si può compilare Rust nel sandbox**: l'utente compila con
  `npm run tauri dev` (fase `Compiling`) PRIMA di committare. Dichiarare
  sempre i punti a rischio compilazione e farsi riportare l'errore cargo.
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

**Stub rimasti (6)**, tutti nella fase porting ancora da fare:
`watchdog, source_activemq, sink_activemq, source_kafka, sink_kafka,
webhook_responder`. Lo stub inoltra le righe tal quali senza fallire né
avvisare (i sink buttano i dati in silenzio) — MA da P73 lo studio ci mette un
**warning giallo** (`NODE_NOT_IMPLEMENTED`), così non è più un inganno
silenzioso. `data_quality` NON è stub (ha il suo arm): è implementato.

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
- **Rust non si compila in sandbox:** ogni patch Rust lo compila l'UTENTE — è
  quello il cancello. Il typecheck TS (baseline 134) è l'unica verifica
  automatica di Claude.
- **La baseline typecheck è 134** (`npx tsc --noEmit -p tsconfig.app.json
  2>&1 | grep -c "error TS"`). Sono errori preesistenti (TS6133/6196
  inutilizzati + un TS2307 penzolante). **Ogni consegna deve chiudere a
  134**: se sale, è colpa tua. Meglio ancora: confrontare l'ELENCO prima/
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

### Prossimo
webhook_receiver / webhook_responder (nodi-servizio) → watchdog → ActiveMQ/STOMP → Kafka (ultimo) → MANUALI.
