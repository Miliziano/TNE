# FlowPilot — Documento di passaggio (handoff sessione)

Questo documento serve a riprendere il lavoro su FlowPilot in una nuova
chat senza perdere contesto. Leggilo per intero prima di ripartire, poi
**leggi il repo per lo stato vero** (vedi "Metodo di lavoro").

Sostituisce l'handoff precedente (5 luglio). Aggiornato a: **Fase 12**.

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

## 3. Architettura decisa (Fase 12 — DEFINITIVA)

Documento: `src-tauri/docs/architettura-pipeline.md`. In sintesi:

- **D1 — Un solo piano di record**: quello che riceve il motore Rust
  (nodi con busta spec + archi). È il formato di esecuzione E l'input dei
  codegen futuri (Rust artifact, Java, Python, eventualmente TS). Il
  `LogicalPlan` di `src/ir/` NON è un secondo piano.
- **D2 — `src/ir/` = libreria di analisi design-time del builder**:
  `exprParser.ts` è il compilatore FPEL canonico (già condiviso);
  `dagValidation`/`ValidationIssue`/`nodeSemantics` sono il sistema di
  validazione live DA RIACCENDERE (oggi `triggerValidation` in flowStore
  è definita ma mai chiamata; `nodeSemantics` manca di pivot,
  data_quality, union); `schemaPropagation` è doppia (ir/ vs
  utils/schemaUtils) — debito noto.
- **D3 — Codegen TypeScript congelato** (`src/codegen/typescript/` +
  CodegenPanel): nessun lavoro nuovo; si deciderà il suo destino quando
  partirà il codegen vero.

**Principio di validazione (doppio strato)** —
`src-tauri/docs/design-validazione.md`: migrare l'esecuzione al motore
NON sposta la validazione. Trasformazione (tipizzare/compilare) → motore.
Verifica → resta nel builder: errori bloccanti per il sicuramente
sbagliato + warning non bloccanti per il sospetto-ma-legale. Il motore
ri-valida tutto come errori parlanti (esecuzione headless). Ridondanza
voluta. Il builder deve restare strumento di progettazione e verifica,
non solo di disegno.

---

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
4. Cancellare l'executor JS: file in `src/runner/` + import +
   registrazione in `executors.ts`.
5. Nota: `log_unconsumed` segnalerà come non consumate le props di testo
   FPEL sorgente (es. `aggFunctions`, `having`): atteso — il compilato
   vive in spec.config. Non è un drop.

---

## 5. Stato migrazione nodi (a fine sessione Fase 12 — verificare sul repo)

Due assi: **spec** (contratto) e **registro dataset** (lane_datasets).

- Migrati alla SPEC: `source_db`, `sink_db`, `join`, `log`, `explode`,
  `aggregate`.
- Sul REGISTRO dataset (ma spec da fare): `window`, `pivot`,
  `data_quality` (aggregate/explode: entrambi gli assi fatti).
- DA MIGRARE alla spec: `pivot` (PROSSIMO — v. §7), `window`,
  `data_quality`, `union`, `transform`, `filter`, `materialize`,
  `source_file`, `sink_file`, `tmap`, `json_parser`, `json_serializer`,
  `xml_parser`, `xml_serializer`.
- CANCELLATO: `sequencer` (deciso; rimosso da motore e UI in Fase 12).
- Executor JS già cancellati: dataQuality, pivot (pre-F12), explode,
  aggregate (F12). Restano in `src/runner/` gli altri.

Commit di riferimento Fase 12: `d18c7ef` (sequencer + explode),
`67b52c5` (aggregate + contratto IR + pulizia executor).

Ordine concordato dopo pivot: window → data_quality → source_file/
sink_file → filter → transform → union → tmap → parser/serializer →
materialize (ultimo: è il produttore del registro e ha il limite
"monte finito vs fallito" aperto).

---

## 6. Lavori di sistema PRIMA di certi nodi (segnalare quando si arriva lì)

- **filter/transform** → Fase B decimal-aware (`as_f64_lossy` nei nodi di
  calcolo) + bug `Add` in expr.rs (concatena in silenzio dove FPEL dice
  null — v. expr-ir-schema §3, va allineato PRIMA del codegen).
- **union** → normare in node-spec la semantica merge by-name (collisioni
  tipo, omonimie).
- **materialize** → limite "monte finito vs monte fallito" (può pubblicare
  dataset parziali in silenzio — materialize_integrazione.md §6).
- **aggregate/window/pivot** → ORDER BY multi-campo disallineato
  pannello↔motore (preesistente; scelto comportamento fedele
  all'esistente; in TODO.md, decidere una volta per tutti i nodi).
- **Fase 13 proposta** — riaccendere la validazione live: agganciare
  `triggerValidation` alle mutazioni canvas, aggiornare `nodeSemantics`
  (pivot/data_quality/union), badge error/warning sul canvas.

---

## 7. Da dove ripartire nella prossima chat

**Migrazione `pivot` alla spec.** Decisioni già prese:
- pivot NON ha FPEL → niente specConfig: tutto dalle props
  (`identityField` CSV → str_list; `pivotColumns`/`unpivotColumns`
  JSON-string → json_or).
- `nullValue`: il pannello lo salva stringa; **il motore la tipizza**
  (scelta "A", confermata) — la logica di tipizzazione (~8 righe,
  int/float/bool/string) si sposta dal builder a pivot.rs.
- Le validazioni del case pivot (pivot_field/value_field obbligatori,
  ≥1 colonna unpivot) RESTANO nel builder E si duplicano nel motore
  (doppio strato). Il builder può aggiungere warning non bloccanti
  (es. nullValue testuale in colonna probabilmente numerica) — se il
  canale warning live non è ancora attivo, annotarli come predisposti.
- Poi: sezione §10 in node-spec.md; il case builder si riduce alle sole
  validazioni; executor JS di pivot già cancellato in passato (verificare).

Dopo pivot: window (stesso pattern, ha `dataSource` come pivot).