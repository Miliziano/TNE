# FlowPilot — Documento di passaggio (handoff sessione)

Questo documento serve a riprendere il lavoro su FlowPilot in una nuova
chat senza perdere contesto. Leggilo per intero prima di ripartire, poi
**leggi il repo per lo stato vero** (vedi "Metodo di lavoro").

Sostituisce l'handoff precedente. Aggiornato a: **16 luglio** — Fase 13
chiusa (mancano i manuali), **Fase porte in corso** (v. §5 e §9).
Ultimo commit di riferimento: `fa7026e`.

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
- **Consegna del lavoro**: Claude modifica nella propria copia sandbox e
  poi CONSEGNA all'utente — file interi (present_files) per i file
  grossi/molto toccati + un documento di modifiche puntuali con numeri
  di riga E testo "TROVA→SOSTITUISCI" (i numeri riferiti al repo pushato;
  il testo è l'àncora se i numeri slittano). L'utente applica, compila,
  committa e pusha lui. Claude NON pusha (niente credenziali, e il
  cancello di qualità è la compilazione locale dell'utente).
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

## 6. Lo stato reale del motore (audit di copertura, 15 lug)

**Non fidarsi delle mappe: interrogare il motore.** `executor.rs` ha 22
arm che implementano davvero + un catch-all a riga ~705 (`other =>
Err("Tipo nodo non supportato")`) che fa la cosa giusta.

**Ma c'è uno STUB PASSTHROUGH SILENZIOSO** (executor.rs ~662-704) per
**16 type-string**: `script, watchdog, source_http, source_ftp,
source_mqtt, source_activemq, source_kafka, sink_kafka, sink_ftp,
sink_mqtt, sink_activemq, sink_http, http_request, webhook_responder,
report_generator, error_handler`. Il commento nel codice lo ammette
("in attesa delle implementazioni vere"). Inoltra le righe tal quali ed
emette `NodeStats` regolari con `error: None`: **non fallisce, non
avvisa, finge di funzionare**. Le sorgenti di rete non hanno input →
`rows_in=0, rows_out=0`, run "riuscito". I sink di rete buttano i dati in
silenzio. Lo script non fa niente (e in `Cargo.toml` non c'è **nessun
motore JS**: lo script non è portabile, va **riprogettato**).
NB `data_quality` compare nella lista dello stub ma è irraggiungibile
(ha il suo arm a riga 602): `data_quality` **è** implementato.

Implementati davvero: source_file, source_db, sink_file, sink_db,
bridge_out, bridge_in, tmap, log, join, transform, aggregate, explode,
materialize, json_serializer, json_parser, filter, xml_serializer,
xml_parser, pivot, data_quality, window, union (+ `bridge.rs` a livello
`engine/`, fuori da `nodes/`).

**I due regimi di porte del motore**: `filter`, `json_parser`,
`xml_parser`, `tmap` ricevono l'**intera mappa `outputs`** e gestiscono
le porte per nome, **reject compreso e funzionante**. Tutti gli altri
usano `take_primary_output` (una porta sola) → i `reject` dichiarati per
explode/join/materialize/sink_* **non sono implementati**.

**Decisione utente**: i reject dichiarati **servono** e vanno
implementati (non rimossi). Modello da copiare: filter e i parser.

---

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

- **La baseline typecheck è 135** (`npx tsc --noEmit -p tsconfig.app.json
  2>&1 | grep -c "error TS"`). Sono errori preesistenti (TS6133/6196
  inutilizzati + un TS2307 penzolante). **Ogni consegna deve chiudere a
  135**: se sale, è colpa tua.
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

**Fase 13 (validazione live + pannello Problems): CHIUSA.**
P4 PropertyPanel contestuale, P5 Monitor staccabile+ridimensionabile,
P6 stato del Monitor ritenuto dal bus, P7/P8 Step 4 bridge (validazione
cardinalità/cicli + derivazione schema BridgeOut→BridgeIn: l'OUT è
dominante, il tab del BridgeIn è in sola lettura). Restano da scrivere i
**MANUALI** (richiesta esplicita: alla fine della fase li scrive Claude).

**Fase porte: IN CORSO.** Fatto: P9→P13 (contratto esteso con role/when,
archi orfani, schema aggregate/pivot/materialize/bridge_in, innesco vs
dati), P14/P15 (metà ingressi + `HANDLE_MAP` cancellata), P16 (coda
connessioni), P17 (FlowNode legge le porte — handle fantasma morti),
P18 (le sorgenti hanno ingressi + lo script dichiara cosa emette).

**Prossimi passi, in ordine:**
1. **Gli ingressi sul canvas**: far leggere a `FlowNode` anche gli
   `<Handle>` di ingresso dal contratto. Prima verificare i nodi a
   ingressi multipli (join/union/tmap/error_handler).
2. **Il motore** (apre di fatto la fase porting): i `reject` dichiarati
   per explode/join/materialize/sink_db/sink_file (modello: filter e i
   parser, che ricevono l'intera mappa `outputs`); il segnale del
   `bridge_out` (`take_primary_output` + emissione riga di stato a fine
   corsa; modello: `sink_file.rs`); `SIGNAL_SCHEMA` da fonte unica;
   `conn_id` negli eventi Connection*.
3. **Fase porting dei 16 stub**, ordine deciso dall'utente:
   **error_handler → script → report_generator**. Riferimenti TS in
   `src/runner/`: `errorHandlerExecutor.ts` (35 righe) +
   `errorHandling.ts` (98) + il concetto `ExecutionContext.errorRows`
   ("popolato da executeNode/executeStreamingNode, consumato da
   processErrorHandler() alla fine di runLane" → **è orchestrazione, non
   un executor**: tocca il motore, non solo `nodes/`); poi
   `scriptExecutor.ts` (179) + `buildLaneProxy`; poi
   `reportGeneratorExecutor.ts` (688, il più grosso).
4. **Restyling**: v. la nota sull'"Uscita verso valle" in §5.

**Sequenza decisa dall'utente**: si chiude una fase alla volta. *"Siamo
sempre in fase di sviluppo: finché non abbiamo finito tutto non si va in
produzione."*