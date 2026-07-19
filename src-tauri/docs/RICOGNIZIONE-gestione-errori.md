# Ricognizione — la gestione degli errori in FlowPilot

Stato del repo: `origin/main` @ `6a6cef8` (dopo P33). Documento di lavoro, non un
disegno: qui c'è **cosa esiste e cosa fa oggi**. Le scelte le prendiamo dopo,
insieme, su questa base.

---

## In una riga

Esistono **cinque** meccanismi di gestione errori, con **due strade parallele e
sovrapposte** per instradare le righe in errore (la sovrapposizione che avevi
intuito). Il **motore Rust ne implementa uno solo** (quello locale dei
serializer). Tutto il resto è dichiarato nel modello TypeScript e/o vivo nel
runner JS legacy, ma **il motore lo ignora**.

---

## I cinque meccanismi

| # | Meccanismo | Dove si configura | Valori | UI | Runner JS legacy | Motore Rust |
|---|-----------|-------------------|--------|----|-----------------|-------------|
| 1 | **Policy per-nodo** | tab Avanzate di ogni nodo | `stop` / `skip` / `retry` / `propagate` (+ retryCount, retryDelaySec) | ✅ `TabAdvanced.tsx` | ✅ implementata | ❌ **ignorata** |
| 2 | **Porta `catch` per-nodo** | conseguenza di `onError=propagate` | porta `catch` con schema `_error_*` | ✅ spunta sul nodo | ✅ | ❌ **non popolata** |
| 3 | **Error Handler centralizzato** | nodo `error_handler` | regole `ErrorRule` (match → `retry`/`skip`/`ignore`) | ✅ `error_handler/Panel.tsx` | ✅ collettore di lane | ❌ **stub** (P30) |
| 4 | **Transazioni** | tab Transazioni della lane | `rollback_all` / `rollback_self` (+ mode, timeout) | ✅ `TransactionsTab.tsx` | — | ⚠️ **parziale** (`txregistry.rs` esiste) |
| 5 | **`on_error` del serializer** | pannello json/xml_serializer | `reject` / `stop` / `null` | ✅ | — | ✅ **implementato** (`json_serializer.rs:249`) |

L'unico onorato dal motore end-to-end è il **#5**, che però è locale al
serializer (errori di serializzazione), non una politica generale del nodo.

---

## Lo schema comune `_error_*`

Tutti i meccanismi di *instradamento* (2 e 3) parlano la stessa lingua: la riga in
errore esce arricchita di questi campi.

- `_error_message` — messaggio dell'eccezione
- `_error_code` — tipo / codice errore
- `_error_node_id` — id del nodo che ha fallito
- `_error_node_type` — tipo del nodo
- `_error_at` — timestamp
- `_error_row` — la riga originale che ha causato l'errore
- (legacy anche `_error_lane_id`, `_error_source`)

Definito in tre punti che **concordano ma sono copie**: `types/index.ts`
(`CATCH_SCHEMA`), `lowering.ts:260`, `TabAdvanced.tsx` (il riquadro informativo),
e nel legacy `errorHandling.ts:37`.

---

## Le due strade parallele (il cuore della sovrapposizione)

Entrambe raccolgono le righe in errore, con lo stesso schema `_error_*`.

### Strada A — decentralizzata: la `catch` per-nodo
- Metti `onError = propagate` su un nodo qualsiasi → gli **spunta una porta
  `catch`** (universale, condizionale).
- Le righe in errore escono da lì e **le colleghi dove vuoi** a valle.
- Vive interamente nel modello TS: `schemaRegistry.ts:197` (la disegna sul
  canvas) e `lowering.ts:260` (la mette nel piano).

### Strada B — centralizzata: l'`error_handler`
- Un nodo `error_handler` con porta `catch` dichiarata **`connectable: false`**
  (`nodeSemantics.ts:979`): è un **collettore implicito** di tutta la lane, non si
  cabla a mano.
- Ha **regole** (`ErrorRule`: `always`/`node_type`/`error_code` → `retry`/`skip`/
  `ignore`) che decidono l'azione per categoria d'errore.
- Nel legacy: `routeToErrorHandler()` accumulava le righe, `processErrorHandler()`
  le emetteva su `error_out` ed eseguiva la sotto-pipeline collegata.

### Perché si sovrappongono
1. **Instradamento doppio**: la stessa riga in errore può uscire dalla `catch`
   per-nodo (A) *oppure* essere raccolta dal collettore `error_handler` (B). Due
   modi per la stessa cosa.
2. **Azioni doppie**: il per-nodo ha `stop`/`skip`/`retry` (meccanismo 1); l'error
   handler ha regole con `retry`/`skip`/`ignore` (meccanismo 3). Le stesse azioni,
   una volta per-nodo e una volta centralizzate.

Nel disegno originale (legacy) le due strade erano **complementari**: la policy
per-nodo *decideva* (stop/skip/retry/propagate) e solo `propagate` alimentava la
strada verso la `catch`. Ma oggi, con `retry`/`skip` presenti **sia** per-nodo
**sia** nelle regole dell'error handler, e con due modi di raccogliere le righe,
la linea di demarcazione non è più netta.

---

## Cosa fa il motore Rust *oggi* quando un nodo fallisce

- Un nodo che ritorna `Err(e)` → l'executor (`:394`) emette `NodeFailed` (nodo
  **rosso**) e segna la **lane come fallita** (`lane_result = Err`). Non aborta i
  task già avviati: li lascia finire, ma l'esito della lane è "fallita".
- **Nessuna** lettura di `advanced.onError`: `stop`/`skip`/`retry`/`propagate`
  non hanno effetto. Il comportamento reale è **sempre "stop"**, senza skip,
  senza retry, senza propagate.
- **Nessun** routing verso la `catch`: nessun nodo costruisce la riga `_error_*`
  né la manda alla porta catch. La porta esiste nel piano (`lowering.ts:260`) ma
  **resta vuota**.
- `error_handler` è nella lista `NOT_IMPLEMENTED` (P30) → da stub, oggi si
  segnala come errore "non implementato".

Conseguenza pratica: **tutta la configurazione di gestione errori che l'utente
imposta (per-nodo o via error_handler) non ha alcun effetto a runtime.** È il
caso più grande di "il canvas promette, il motore non mantiene" rimasto aperto.

---

## Divergenze e debiti trovati (da tenere sott'occhio nel disegno)

1. 🔴 **La `catch` per-nodo è cablata in DUE posti**: `schemaRegistry.ts:197`
   (canvas) e `lowering.ts:260` (piano), ciascuno col suo `if (onError ===
   'propagate')`. È esattamente la "doppia opinione" che `portApplies`
   (`nodeSemantics.ts:1037`) doveva eliminare dichiarando le porte condizionali
   con `when` in un unico posto — ma la catch universale **non** è dichiarata come
   `PortSpec` con `when`: è hardcoded due volte. Se una cambia e l'altra no,
   canvas e piano divergono.

2. 🟠 **Schema `_error_*` copiato in ~4 punti** (types, lowering, TabAdvanced,
   legacy). Un'unica fonte manca.

3. 🟠 **Azioni ridondanti** tra policy per-nodo (`stop`/`skip`/`retry`) e regole
   error_handler (`retry`/`skip`/`ignore`): vocabolari simili ma non identici
   (`stop` vs `ignore`), da riconciliare.

4. 🟡 **Transazioni** (`rollback_all`/`rollback_self`) sono un terzo asse di
   politica d'errore, con un registro nel motore (`txregistry.rs`) — va capito
   quanto del rollback è davvero onorato e come si incastra con 1–3.

---

## Le domande da sciogliere (per il disegno, NON decise qui)

1. **Una strada o due?** La `catch` per-nodo (A) e l'`error_handler` collettore
   (B) restano entrambe, o se ne sceglie una come modello unico? Se restano
   entrambe, qual è la divisione di ruoli netta (es. A = instrado io a mano; B =
   collettore automatico + regole)?

2. **Dove stanno le azioni?** `stop`/`skip`/`retry` come *decisione locale* del
   nodo, oppure centralizzate nelle regole dell'error_handler, o entrambe con una
   precedenza dichiarata?

3. **La config nel tab Avanzate**: la tua domanda diretta. Resta lì (decisione
   per-nodo vicino al nodo) o si sposta/riduce perché la governa l'error_handler?
   → Dipende dalla risposta a 1 e 2.

4. **Il motore**: quando lo si implementa, quale semantica di `retry` (a livello
   di riga? di nodo? con quale stato?), e `skip` significa "salta la riga" o
   "salta il nodo"? Il legacy ha risposte — vanno riviste, non ereditate a scatola
   chiusa.

5. **Collegamento con la scelta B sui sink** (18 lug): "errore di scrittura resta
   fatale" è *un caso* di questo quadro. Quando il modello generale c'è, il sink
   reject (opzione C, toggle `onWriteError`) va riletto lì dentro, non a parte.

---

## Indice dei file (per riprendere al volo)

- **Policy per-nodo (UI)**: `src/components/tabs/TabAdvanced.tsx` (`onError`,
  retry, riquadro propagate)
- **Tipo**: `src/types/index.ts` (`NodeAdvanced.onError`, `ErrorRule`,
  `CATCH_SCHEMA`, transazioni `onError`)
- **Catch per-nodo (canvas)**: `src/utils/schemaRegistry.ts:197`
- **Catch per-nodo (piano)**: `src/ir/lowering.ts:260`
- **Porte condizionali, fonte unica**: `src/ir/nodeSemantics.ts` (`portApplies`
  ~:1037; `error_handler` :961 con `catch` connectable:false)
- **Error handler UI/regole**: `src/nodes/types/error_handler/Panel.tsx`
- **Legacy**: `src/runner/errorHandling.ts` (routing + enrichment + retry),
  `src/runner/errorHandlerExecutor.ts` (no-op + processErrorHandler in
  `runner/index.ts`)
- **Transazioni**: `src/components/TransactionsTab.tsx`, motore
  `src-tauri/src/engine/txregistry.rs`
- **Serializer on_error (implementato)**: `src-tauri/src/engine/nodes/json_serializer.rs:249`
- **Motore, gestione fallimento**: `src-tauri/src/engine/executor.rs:394`
  (`NodeFailed` + lane fallita), `emit_failed` :88
