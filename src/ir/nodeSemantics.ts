/**
 * src/ir/nodeSemantics.ts
 * ───────────────────────
 * Mapping dal tipo UI di un nodo alle sue proprietà semantiche
 * nel Logical IR.
 *
 * Questo è il punto dove il compilatore impara cosa fa ogni nodo
 * UI in termini semantici — senza dipendere da React o dal canvas.
 *
 * Il Lowerer (src/ir/lowering.ts) usa questo registro per costruire
 * i LogicalNode corrispondenti a ogni CanvasNode.
 *
 * Per aggiungere un nuovo tipo di nodo:
 *   1. Aggiungere una entry in NODE_SEMANTICS
 *   2. Implementare il relativo NodeLowerer in lowering.ts
 *   3. Nessuna altra modifica necessaria al compilatore
 */

import type { LogicalOperation, ExecutionSemantics, PortSpec } from './types'

// ─────────────────────────────────────────────────────────────────
// RUNTIME CAPABILITIES
// ─────────────────────────────────────────────────────────────────

export type RuntimeTarget =
  | 'typescript'     // Node.js — pipeline leggere, prototipazione
  | 'python_polars'  // Python + Polars — analytics, data science
  | 'python_pandas'  // Python + Pandas — compatibilità legacy
  | 'java_beam'      // Apache Beam/Java — pipeline distribuite enterprise

/**
 * Capabilities di ogni runtime target.
 * Il Physical Planner usa questo registro per assegnare
 * le operazioni logiche al runtime corretto.
 */
export interface RuntimeCapabilities {
  runtime:                RuntimeTarget
  supportsStreaming:       boolean
  supportsStateful:        boolean   // join, dedup, sessionization
  supportsPushdown:        boolean   // predicato → sorgente
  supportsVectorization:   boolean   // elaborazione colonnare
  supportsWindow:          boolean   // window functions
  supportsDistributed:     boolean   // scala orizzontalmente
  /** -1 = illimitato (distribuito) */
  maxMemoryMB:             number
}

export const RUNTIME_CAPABILITIES: RuntimeCapabilities[] = [
  {
    runtime:              'typescript',
    supportsStreaming:     true,
    supportsStateful:     false,
    supportsPushdown:     true,
    supportsVectorization: false,
    supportsWindow:       false,
    supportsDistributed:  false,
    maxMemoryMB:          4096,
  },
  {
    runtime:              'python_polars',
    supportsStreaming:     true,
    supportsStateful:     true,
    supportsPushdown:     true,
    supportsVectorization: true,
    supportsWindow:       true,
    supportsDistributed:  false,
    maxMemoryMB:          32768,
  },
  {
    runtime:              'python_pandas',
    supportsStreaming:     false,
    supportsStateful:     true,
    supportsPushdown:     false,
    supportsVectorization: true,
    supportsWindow:       true,
    supportsDistributed:  false,
    maxMemoryMB:          16384,
  },
  {
    runtime:              'java_beam',
    supportsStreaming:     true,
    supportsStateful:     true,
    supportsPushdown:     true,
    supportsVectorization: false,
    supportsWindow:       true,
    supportsDistributed:  true,
    maxMemoryMB:          -1,
  },
]

// ─────────────────────────────────────────────────────────────────
// NODE SEMANTICS
// ─────────────────────────────────────────────────────────────────

/**
 * Semantica di un tipo di nodo UI.
 * Definisce cosa il nodo fa logicamente, indipendentemente
 * da come è implementato nell'interfaccia grafica.
 */
export interface NodeSemantics {
  /** Tipo UI — corrisponde a NodeDef.type nel registry */
  uiType: string

  /**
   * Operazioni logiche prodotte dal lowering di questo nodo.
   * La prima è l'operazione primaria (usata per routing e ottimizzazione).
   * Un nodo UI può produrre più operazioni logiche (es. source_http → scan + parse).
   */
  operations: LogicalOperation[]

  /**
   * Semantica di esecuzione — determina il tipo di operatore nel planner.
   * Influenza materializzazione, parallelismo, strategia di buffering.
   */
  executionSemantics: ExecutionSemantics

  /**
   * Porte di INGRESSO dichiarate.
   * Mancavano: le sapeva solo HANDLE_MAP (schemaRegistry), cioè l'altra
   * metà — divergente — dello stesso contratto. Senza queste, "cancellare
   * HANDLE_MAP" non era una cancellazione ma una perdita di informazione.
   * Lista vuota = il nodo non ha ingressi (sorgenti, bridge_in, lane_start).
   */
  staticInputPorts: PortSpec[]

  /**
   * true se il nodo produce N porte di output con schema diverso.
   * Il Lowerer deve creare N PortSpec distinti.
   * Esempi: tmap (N output), json_parser (N flussi), xml_parser (N flussi)
   */
  producesMultipleOutputs: boolean

  /**
   * true se il nodo accetta N porte di input con schema diverso.
   * Il Lowerer deve gestire ogni input come PortSpec distinto.
   * Esempi: tmap (main + N lookup), merge
   */
  acceptsMultipleInputs: boolean

  /**
   * Porte di output fisse — definite staticamente dalla semantica del nodo.
   * Usate quando le porte non dipendono dalla configurazione runtime.
   * Per nodi con porte dinamiche (json_parser, tmap) questo array è vuoto
   * e le porte vengono generate dal Lowerer leggendo la config del nodo.
   */
  staticOutputPorts: PortSpec[]

  /**
   * Runtime preferiti per questo tipo di operazione.
   * Il Physical Planner parte da questi e verifica le capabilities.
   * Ordine: dal più preferito al meno preferito.
   */
  preferredRuntimes: RuntimeTarget[]

  /**
   * Operazioni che questo nodo può trasferire alla sorgente dati
   * (pushdown). Il planner usa questa info per l'optimizer pass
   * di predicate pushdown e projection pruning.
   */
  pushdownCapable: Array<'filter' | 'projection' | 'sort' | 'limit'>
}

// ─────────────────────────────────────────────────────────────────
// REGISTRO SEMANTICHE — un entry per tipo UI
// ─────────────────────────────────────────────────────────────────

export const NODE_SEMANTICS: Record<string, NodeSemantics> = {

  // ── Sorgenti ─────────────────────────────────────────────────

  source_db: {
    uiType:                 'source_db',
    operations:             ['scan'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript', 'python_polars', 'java_beam'],
    // Il DB può ricevere WHERE, SELECT, ORDER BY, LIMIT
    pushdownCapable:   ['filter', 'projection', 'sort', 'limit'],
  },

  source_file: {
    uiType:                 'source_file',
    operations:             ['scan'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },

  source_http: {
    uiType:                 'source_http',
    operations:             ['scan', 'parse'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
      { id: 'reject', label: 'reject', isReject: true  },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  source_ftp: {
    uiType:                 'source_ftp',
    operations:             ['scan'],
    executionSemantics:     'row',        // legge file (batch), come source_file
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   ['projection', 'limit'],
  },
  source_kafka: {
    uiType:                 'source_kafka',
    operations:             ['scan', 'parse'],   // consume  deserializza
    executionSemantics:     'stream',            // consumer = flusso continuo
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },
  webhook_receiver: {
    uiType:                 'webhook_receiver',
    operations:             ['scan', 'parse'],   // riceve payload  parse
    executionSemantics:     'stream',            // server in ascolto = continuo
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  watchdog: {
    uiType:                 'watchdog',
    operations:             ['scan'],     // monitora via HEAD, sblocca il flusso
    executionSemantics:     'stream',     // monitoraggio continuo, come dir_watcher
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },

  // ── Trasformazioni ────────────────────────────────────────────
  filter: {
    uiType:                  'filter',
    operations:              ['branch'],
    executionSemantics:      'row',
    producesMultipleOutputs: true,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts:       [],        // porte dinamiche — gestite dal lowerer
    preferredRuntimes:       ['typescript', 'python_polars'],
    pushdownCapable:         [],
  },

  transform: {
    uiType:                 'transform',
    operations:             ['projection'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript', 'python_polars'],
    pushdownCapable:   ['projection'],
  },

  join: {
    uiType:                 'join',
    operations:             ['join'],
    // stateful: mantiene stato (hash table o sort-merge buffer)
    executionSemantics:     'stateful',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  true,
    staticInputPorts: [
      { id: 'input_left', label: 'input_left', isReject: false },
      { id: 'input_right', label: 'input_right', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output',          isReject: false },
      { id: 'reject', label: 'non-matched',     isReject: true  },
    ],
    preferredRuntimes: ['python_polars', 'java_beam'],
    pushdownCapable:   [],
  },

  aggregate: {
    uiType:                 'aggregate',
    operations:             ['aggregate'],
    // dataset: deve vedere tutti i record prima di emettere
    executionSemantics:     'dataset',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['python_polars', 'java_beam'],
    pushdownCapable:   [],
  },

  tmap: {
    uiType:                 'tmap',
    operations:             ['projection', 'filter'],
    executionSemantics:     'row',
    // N output con schema diverso (main_out, rejected, + custom)
    producesMultipleOutputs: true,
    // main + N lookup
    acceptsMultipleInputs:  true,
    // Porte dinamiche — generate dal Lowerer leggendo TMapConfig
    staticInputPorts: [
      { id: 'input_main', label: 'input_main', isReject: false },
    ],
    staticOutputPorts:      [],
    preferredRuntimes: ['typescript', 'python_polars'],
    pushdownCapable:   ['filter', 'projection'],
  },

  script: {
    uiType:                 'script',
    operations:             ['transform'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
      { id: 'reject', label: 'reject', isReject: true  },
    ],
    // Il runtime dipende dal linguaggio scelto (TypeScript o Java)
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },

  json_parser: {
    uiType:                 'json_parser',
    operations:             ['parse', 'projection'],
    executionSemantics:     'row',
    // N flussi output con schema diverso — generati dal Lowerer
    producesMultipleOutputs: true,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts:      [],
    preferredRuntimes: ['typescript', 'python_polars'],
    pushdownCapable:   [],
  },

  xml_parser: {
    uiType:                 'xml_parser',
    operations:             ['parse', 'projection'],
    executionSemantics:     'row',
    producesMultipleOutputs: true,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts:      [],
    preferredRuntimes: ['typescript', 'python_polars'],
    pushdownCapable:   [],
  },
  union: {
    uiType:                 'union',
    operations:             ['union'],
    // Tutte le modalità (concat, mix, zip) sono STREAMING — design-union.md:
    // "Modalità — tutte streaming". Nessun buffering: zip legge una riga per
    // input e la emette, non accumula. Quindi 'stream', non 'stateful'/'dataset'.
    executionSemantics:     'stream',
    producesMultipleOutputs: false,
    // main + N flussi aggiuntivi (input_new, stessa meccanica di tmap).
    // Il fallback generico lo trattava come mono-input → badge/porte errati.
    acceptsMultipleInputs:  true,
    staticInputPorts: [
      { id: 'input_1', label: 'input_1', isReject: false },
      { id: 'input_2', label: 'input_2', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['python_polars', 'typescript'],
    pushdownCapable:   [],
  },
  pivot: {
    uiType:                 'pivot',
    // Pivot (righe→colonne) raggruppa e rimodella come un aggregate;
    // Unpivot (colonne→righe) moltiplica le righe. Un solo nodo, due modi.
    operations:             ['aggregate'],
    // dataset: la modalità Pivot deve vedere tutte le righe di un gruppo prima
    // di emettere le colonne. Scelta conservativa: copre il modo più esigente;
    // per Unpivot è un over-materialize innocuo, non un errore.
    executionSemantics:     'dataset',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['python_polars', 'java_beam'],
    pushdownCapable:   [],
  },
  json_serializer: {
    uiType:                 'json_serializer',
    // Serializza le righe in JSON e le emette a valle in un campo (default
    // 'content') — NON è un sink terminale: continua verso un sink_file, ecc.
    operations:             ['transform'],
    // dataset: l'executor Rust bufferizza tutte le righe per handle
    // (HashMap<handle, Vec<Row>>) per costruire strutture annidate e groupBy
    // master-detail prima di emettere — non è per-riga.
    executionSemantics:     'dataset',
    producesMultipleOutputs: false,
    // Multi-handle: main + flussi aggiuntivi (input_new) annidati master-detail.
    acceptsMultipleInputs:  true,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  xml_serializer: {
    uiType:                 'xml_serializer',
    // Stesso profilo del json_serializer: serializza a valle (campo content),
    // bufferizza per costruire l'albero/nesting, accetta più handle.
    operations:             ['transform'],
    executionSemantics:     'dataset',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  true,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  dir_watcher: {
      uiType:                  'dir_watcher',
      operations:              ['scan'],
      executionSemantics:      'stream',   // watch mode è stream continuo
      producesMultipleOutputs: false,
      acceptsMultipleInputs:   false,
      staticInputPorts:        [],   // nessun ingresso: sorveglia una cartella
      staticOutputPorts: [
        { id: 'output', label: 'output', isReject: false },
        { id: 'reject', label: 'reject', isReject: true  },
      ],
      preferredRuntimes: ['typescript'],
      pushdownCapable:   [],
    },

  /**
   * log — non modifica né filtra: lo schema di uscita è identico a
   * quello d'ingresso. Mancava: lo copriva il fallback di
   * getNodeSemantics fingendolo 'transform'. Dava la porta giusta,
   * ma per caso.
   */
  log: {
    uiType:                  'log',
    operations:              ['transform'],
    executionSemantics:      'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false, role: 'data' },
    ],
    preferredRuntimes: ['typescript', 'python_polars', 'python_pandas', 'java_beam'],
    pushdownCapable:   [],
  },

  window: {
    uiType:                  'window',
    operations:              ['window'],
    executionSemantics:      'dataset',  // richiede visibilità sulla partizione
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['python_polars', 'typescript'],
    pushdownCapable:   [],
  },

  materialize: {
    uiType:                  'materialize',
    operations:              ['aggregate'],  // bufferizza
    executionSemantics:      'dataset',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
      { id: 'reject', label: 'reject', isReject: true  },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },

  source_activemq: {
    uiType:                  'source_activemq',
    operations:              ['scan'],
    executionSemantics:      'stream',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
      { id: 'reject', label: 'reject', isReject: true  },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },

  sink_activemq: {
    uiType:                  'sink_activemq',
    operations:              ['sink'],
    executionSemantics:      'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'passthrough', isReject: false },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },

  source_mqtt: {
    uiType:                  'source_mqtt',
    operations:              ['scan'],
    executionSemantics:      'stream',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },

  sink_mqtt: {
    uiType:                  'sink_mqtt',
    operations:              ['sink'],
    executionSemantics:      'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'passthrough', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  
  report_generator: {
    uiType:                  'report_generator',
    operations:              ['aggregate'],   // bufferizza tutto prima di emettere
    executionSemantics:      'dataset',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'report', isReject: false },
      { id: 'reject', label: 'reject', isReject: true  },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },

  explode: {
    uiType:                  'explode',
    operations:              ['scan'],    // produce righe da struttura
    executionSemantics:      'dataset',   // legge tutto prima di emettere
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'rows',   isReject: false },
      { id: 'reject', label: 'reject', isReject: true  },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },
  data_quality: {
    uiType:                 'data_quality',
    // Il motore ANNOTA ogni riga con campi _dq.valid/_dq.score e le passa TUTTE
    // su un solo output; per scartare le invalide si mette un filter a valle
    // (vedi data_quality.rs). NON instrada su valid/reject: è un transform che
    // arricchisce lo schema, non un branch. (La HANDLE_MAP di schemaRegistry che
    // dichiara valid/reject è stantia — allineare a ['output'] in un cleanup.)
    operations:             ['transform'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript', 'python_polars'],
    pushdownCapable:   [],
  },
  shell_exec: {
    uiType:                 'shell_exec',
    operations:             ['transform'],  // esegue comando, output nel flusso
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  ssh_exec: {
    uiType:                 'ssh_exec',
    operations:             ['transform'],  // come shell_exec, ma su host remoto
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  mail_sink: {
    uiType:                  'mail_sink',
    operations:              ['sink'],
    executionSemantics:      'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      // id = nome del FILO: deve combaciare con l'handle disegnato dal
      // canvas e con ciò che il motore cerca (take_primary_output prova
      // "output" per primo). 'passthrough' è l'ETICHETTA, cioè cosa esce.
      { id: 'output', label: 'passthrough', isReject: false, role: 'data' },
      { id: 'reject',      label: 'reject',      isReject: true  },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },

  // ── Destinazioni ──────────────────────────────────────────────


  bridge_out: {
    uiType:                  'bridge_out',
    operations:              ['sink'],     // consuma il flusso e lo invia al canale
    executionSemantics:      'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts:       [],           // nessuna uscita verso altri nodi della stessa lane
    preferredRuntimes:       ['typescript', 'java_beam'],
    pushdownCapable:         [],
  },

  bridge_in: {
    uiType:                  'bridge_in',
    operations:              ['scan'],     // produce righe dal canale
    executionSemantics:      'stream',     // riceve dati asincroni dal canale
    producesMultipleOutputs: false,
    acceptsMultipleInputs:   false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },
  
  sink_db: {
    uiType:                 'sink_db',
    operations:             ['sink'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      // I sink hanno una porta output opzionale per il passthrough
      // id = nome del FILO: deve combaciare con l'handle disegnato dal
      // canvas e con ciò che il motore cerca (take_primary_output prova
      // "output" per primo). 'passthrough' è l'ETICHETTA, cioè cosa esce.
      { id: 'output', label: 'passthrough', isReject: false, role: 'data' },
      { id: 'reject',      label: 'reject',      isReject: true  },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },

  sink_file: {
    uiType:                 'sink_file',
    operations:             ['sink'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      // id = nome del FILO: deve combaciare con l'handle disegnato dal
      // canvas e con ciò che il motore cerca (take_primary_output prova
      // "output" per primo). 'passthrough' è l'ETICHETTA, cioè cosa esce.
      { id: 'output', label: 'passthrough', isReject: false, role: 'data' },
      { id: 'reject',      label: 'reject',      isReject: true  },
    ],
    preferredRuntimes: ['typescript', 'python_polars'],
    pushdownCapable:   [],
  },

  sink_kafka: {
    uiType:                 'sink_kafka',
    operations:             ['sink'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      // id = nome del FILO: deve combaciare con l'handle disegnato dal
      // canvas e con ciò che il motore cerca (take_primary_output prova
      // "output" per primo). 'passthrough' è l'ETICHETTA, cioè cosa esce.
      { id: 'output', label: 'passthrough', isReject: false, role: 'data' },
      { id: 'reject',      label: 'reject',      isReject: true  },
    ],
    preferredRuntimes: ['typescript', 'java_beam'],
    pushdownCapable:   [],
  },
  sink_ftp: {
    uiType:                 'sink_ftp',
    operations:             ['sink'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    // come gli altri sink: porta passthrough opzionale  reject
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      // id = nome del FILO: deve combaciare con l'handle disegnato dal
      // canvas e con ciò che il motore cerca (take_primary_output prova
      // "output" per primo). 'passthrough' è l'ETICHETTA, cioè cosa esce.
      { id: 'output', label: 'passthrough', isReject: false, role: 'data' },
      { id: 'reject',      label: 'reject',      isReject: true  },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  webhook_responder: {
    uiType:                 'webhook_responder',
    operations:             ['sink'],   // risponde HTTP dalla riga corrente
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    // terminale: consuma e risponde, nessun output a valle
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts:      [],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
  error_handler: {
    uiType:                 'error_handler',
    // Collettore centrale errori della lane: riceve righe-errore via handle
    // 'catch' da N nodi e le inoltra su 'error_out' (verso log/sink).
    operations:             ['transform'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    // riceve i catch da molti nodi della lane
    acceptsMultipleInputs:  true,
    staticInputPorts: [
      { id: 'catch', label: 'catch', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'error_out', label: 'error', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },

  // ── Nodi interni canvas (non entrano nell'IR) ─────────────────

  lane_start: {
    uiType:                 'lane_start',
    operations:             ['scan'],   // trattato come punto di ingresso
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts:        [],   // nessun ingresso
    staticOutputPorts: [
      // Il marcatore di avvio non emette righe: emette il "via". Chi lo
      // riceve NON deve aspettarsi campi — è la differenza fra un arco
      // di innesco e un arco di dati (vedi PortRole).
      { id: 'output', label: 'start', isReject: false, role: 'signal' },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },

  lane_end: {
    uiType:                 'lane_end',
    operations:             ['sink'],   // trattato come punto di uscita
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts:      [],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  },
}

// ─────────────────────────────────────────────────────────────────
// HELPER — lookup con fallback sicuro
// ─────────────────────────────────────────────────────────────────

/**
 * Restituisce la semantica di un tipo di nodo UI.
 * Se il tipo non è registrato, restituisce una semantica generica
 * di tipo 'transform' per non bloccare il compilatore.
 */
export function getNodeSemantics(uiType: string): NodeSemantics {
  return NODE_SEMANTICS[uiType] ?? {
    uiType,
    operations:             ['transform'],
    executionSemantics:     'row',
    producesMultipleOutputs: false,
    acceptsMultipleInputs:  false,
    staticInputPorts: [
      { id: 'input', label: 'input', isReject: false },
    ],
    staticOutputPorts: [
      { id: 'output', label: 'output', isReject: false },
    ],
    preferredRuntimes: ['typescript'],
    pushdownCapable:   [],
  }
}

/**
 * Restituisce i runtime capaci di eseguire una data operazione logica.
 * Usato dal Physical Planner per il routing delle unità di esecuzione.
 */
export function getRuntimesForOperation(
  operation: LogicalOperation
): RuntimeCapabilities[] {
  // Operazioni che richiedono stato o distribuzione
  const needsStateful    = ['join', 'aggregate', 'window', 'sort'].includes(operation)
  const needsDistributed = false   // per ora non forziamo distribuzione

  return RUNTIME_CAPABILITIES.filter((r) => {
    if (needsStateful    && !r.supportsStateful)    return false
    if (needsDistributed && !r.supportsDistributed) return false
    return true
  })
}