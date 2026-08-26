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
