# FlowPilot — Architettura della pipeline: decisioni definitive

Documento di riferimento. Chiude un'ambiguità storica del progetto:
la coesistenza di **due strade** dal canvas all'esecuzione. Fissa i
ruoli una volta per tutte. Decisioni prese e confermate in Fase 12.

## La storia (perché esistono due strade)

- **Giugno** — visione "compilatore dati multi-runtime", quando il
  runtime era il runner JS: nasce la pipeline `src/ir/`
  (lowering → schemaPropagation → dagValidation → optimizer →
  **codegen TypeScript**), con `LogicalPlan` come IR.
- **Svolta Rust** — il runtime diventa il motore Rust nativo in Tauri:
  nasce `buildRustPlan` (in `Toolbar.tsx`) che produce il piano per il
  motore, poi arricchito con la **busta spec** (node-spec.md) e i
  contratti (monitoring-schema.md, expr-ir-schema.md).
- Le due strade sono rimaste entrambe nel codice senza che fosse mai
  scritto quale fosse il futuro. Questo documento lo scrive.

## Stato di fatto rilevato (Fase 12)

- `buildRustPlan` è il **percorso di produzione**: ogni run passa di qui.
- Il parser FPEL è **uno solo**: `src/ir/exprParser.ts`, usato da
  `buildRustPlan`, produce l'ExprNode nella forma che il motore Rust
  deserializza (contratto `expr-ir-schema.md`). Nessuna duplicazione.
- La **validazione live** di `src/ir/` (dagValidation, 22 check;
  ValidationIssue con severità error/warning/info; badge sul canvas via
  applyIssuesToCanvas) è **costruita ma spenta**: `triggerValidation`
  in flowStore è definita e mai chiamata. `nodeSemantics` è stale
  (mancano pivot, data_quality, union).
- Il **codegen TypeScript** (`src/codegen/typescript/`, CodegenPanel
  montato in App) genera codice per la visione pre-Rust.

## Le tre decisioni

### D1 — Il piano di riferimento è UNO

**Il piano che riceve il motore Rust** — nodi con busta `spec`
(props verbatim + config strutturata/compilata + risorsa) e archi — è
l'unico "piano di record". È contemporaneamente:

- il formato di **esecuzione** (motore live, oggi);
- il formato di **input dei codegen futuri** (artifact Rust compilati,
  Java, Python, e volendo di nuovo TypeScript).

**Un solo punto di generazione, N target.** I generatori leggono lo
stesso piano-spec e lo stesso IR espressioni (`expr-ir-schema.md`) e
traducono: lo studio compila una volta, ogni target traduce un albero
già strutturato. Il `LogicalPlan` di `src/ir/` NON è un secondo piano
candidato.

### D2 — `src/ir/` è la libreria di analisi design-time del builder

Non una pipeline alternativa: una **cassetta degli attrezzi** al
servizio dello studio. Tre componenti, tre destini:

1. **`exprParser.ts` — resta il compilatore FPEL canonico.** È già
   condiviso; è "lo studio compila" fatto codice. Ogni nodo FPEL passa
   di qui.
2. **`dagValidation` + `ValidationIssue` + `nodeSemantics` — si
   riaccendono.** Sono il sistema di validazione live previsto da
   `design-validazione.md` (doppio strato: builder avvisa a design-time,
   motore ri-valida a runtime). Lavori: agganciare `triggerValidation`
   alle mutazioni del canvas; aggiornare `nodeSemantics` con i nodi
   mancanti; migrare progressivamente le validazioni per-nodo di
   `buildRustPlan` in check richiamabili anche dalla validazione live,
   così scattano **mentre si disegna**, non solo al lancio.
3. **`schemaPropagation`** — esiste doppia (`src/ir/` e
   `utils/schemaUtils`, i pannelli usano la seconda). Debito noto,
   consolidamento futuro; nessun lavoro nuovo su due binari.

### D3 — Il codegen TypeScript è congelato

`src/codegen/typescript/` e il CodegenPanel restano nel codice ma
**nessun lavoro nuovo li tocca**; il pannello è da considerarsi
legacy/sperimentale. Quando partirà il lavoro di codegen vero, i
generatori leggeranno piano-spec + expr-IR (D1); a quel punto si
deciderà se demolire il codegen TS o riciclarne l'ossatura come primo
traduttore del nuovo formato.

## Conseguenze pratiche per le migrazioni in corso

- Migrare un nodo = portarlo al contratto spec (props verbatim; IR
  compilato in `spec.config` per i nodi FPEL, meccanismo `specConfig`
  nel builder) + errori parlanti nel motore + validazioni che RESTANO
  nel builder (v. `design-validazione.md`).
- Ogni migrazione lascia le proprie condizioni di validità esplicite,
  pronte per essere pescate dalla validazione live quando si riaccende.
- Nessun nodo nuovo va aggiunto al `LogicalPlan`/codegen TS.

## Sequenza

1. **Fase 12 (in corso)** — completare le migrazioni alla spec
   (prossimo: pivot).
2. **Fase 13 (proposta)** — riaccendere la validazione live:
   trigger agganciato, nodeSemantics aggiornato, badge error/warning
   sul canvas. Il "builder che consiglia" diventa visibile.
3. **Codegen (futuro)** — generatori per target (artifact Rust
   standalone, Java, Python, eventualmente TS) dallo stesso
   piano-spec + expr-IR.
