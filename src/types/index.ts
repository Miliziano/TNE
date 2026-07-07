import type { JsonParserConfig } from '../nodes/types/json_parser/jsonParserTypes'
import type { XmlParserConfig }  from '../nodes/types/xml_parser/xmlParserTypes'
import type { TMapFieldType } from './fieldTypes'

// ─── Categorie e stati ────────────────────────────────────────────
export type NodeCategory = 'input' | 'transform' | 'output'
export type NodeStatus   = 'idle' | 'running' | 'done' | 'error' | 'warning' | 'ok'

// ─── Definizione statica di un tipo di nodo (registry) ───────────
export interface FieldDef {
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'code' | 'password'
  default: string
  options?: string[]
}

export interface NodeDef {
  type: string
  label: string
  category: NodeCategory
  icon: string
  color: string
  fields: FieldDef[]
  description: string
}

// ─── Configurazione avanzata del nodo ────────────────────────────
export interface NodeMapping {
  id: string
  sourceField: string
  targetField: string
  transform?: string
}

export interface NodeAdvanced {
  timeoutSec:    string
  retryCount:    string
  retryDelaySec: string
  onError:       'stop' | 'skip' | 'retry' | 'propagate'
  batchSize:     string
  parallel:      'false' | 'true'
   // ← aggiungere questi due:
  excludeFromErrorLog?: 'true' | 'false'
  critical?:            'true' | 'false'
}


export interface NodeConfig {
  // Generale
  displayName:  string
  shortLabel:   string
  description:  string
  notes:        string
  enabled:      'true' | 'false'

  // Connessione
  resourceId:   string

  // Mapping
  mappings:     NodeMapping[]

  // Avanzate
  advanced:     NodeAdvanced

  // TMap
  tmap?:        TMapConfig

  // Parser
  jsonParser?:  JsonParserConfig
  xmlParser?:   XmlParserConfig

   [key: string]: unknown
}
// ─── Error Handler — regole automatiche ──────────────────────────
export interface ErrorRule {
  id:         string
  matchType:  'always' | 'node_type' | 'error_code'
  matchValue: string
  action:     'retry' | 'skip' | 'ignore'
  retryCount?: string
}

// Campi aggiunti alle righe che escono dall'handle 'catch'
export const CATCH_SCHEMA = [
  { id: 'catch_error_message',   name: '_error_message',   type: 'string'  as const },
  { id: 'catch_error_code',      name: '_error_code',      type: 'string'  as const },
  { id: 'catch_error_node_id',   name: '_error_node_id',   type: 'string'  as const },
  { id: 'catch_error_node_type', name: '_error_node_type', type: 'string'  as const },
  { id: 'catch_error_at',        name: '_error_at',        type: 'date'    as const },
  { id: 'catch_error_row',       name: '_error_row',       type: 'object'  as const },
  { id: 'error_lane_id', name: '_error_lane_id', type: 'string' as const },
  { id: 'error_source',  name: '_error_source',  type: 'string' as const },
  { id: 'tx_group_id',     name: '_transaction_group_id',     type: 'string' as const },
  { id: 'tx_mode',         name: '_transaction_mode',         type: 'string' as const },
  { id: 'tx_participants', name: '_transaction_participants', type: 'object' as const },
] as const
// ─── Error Handler — regole automatiche ──────────────────────────


export const ERROR_HANDLER_SCHEMA = CATCH_SCHEMA

// ─── Dati runtime di un nodo sul canvas ──────────────────────────
export interface NodeData extends Record<string, unknown> {
  type:  string
  label: string

  /**
   * Props flat per compatibilità con il sistema attuale.
   * Usato dai pannelli UI e dalla schema propagation corrente.
   * Verrà progressivamente sostituito da config strutturata.
   */
  props:  Record<string, string>

  /**
   * Configurazione strutturata del nodo.
   * Contiene config specifiche per tipo (tmap, jsonParser, xmlParser...)
   * e le impostazioni generali (displayName, advanced, mappings...).
   */
  config: Partial<NodeConfig>

  /**
   * Status di esecuzione — prodotto dal runtime, non dal compilatore.
   * Mantenuto per retrocompatibilità con il sistema di log e feedback.
   */
  status:          NodeStatus
  statusMessage?:  string

  /** Lane di appartenenza — riferimento al modello Pool/Lane */
  laneId: string

  /**
   * Stato UI del nodo — separato dai dati del compilatore.
   *
   * Il compilatore (src/ir/) ignora completamente questo campo.
   * Usato solo da componenti React per decisioni di rendering.
   *
   * Progressivamente popolato dal DAG validator (Step 8)
   * per mostrare badge di errore/warning sui nodi.
   */
  uiState?: {
    /** true se il DAG validator ha trovato errori su questo nodo */
    hasErrors?:   boolean
    /** Numero di errori (per il badge) */
    errorCount?:  number
    /** true se ha warning ma nessun errore bloccante */
    hasWarnings?: boolean
    warningCount?: number
    /** Messaggi da mostrare nel tooltip del badge */
    issues?:      Array<{
      severity: 'error' | 'warning' | 'info'
      message:  string
      code:     string
    }>
  }

  /**
   * Riferimento al piano logico IR.
   * Popolato dal Lowerer (Step 4) — collega questo nodo canvas
   * al suo corrispondente LogicalNode nell'IR.
   *
   * Usato dal compilatore per trovare il nodo logico
   * senza dover rieseguire il lowering ogni volta.
   */
  irRef?: IRRef
}
/**
 * Collegamento tra un nodo canvas e il suo LogicalNode nell'IR.
 * Creato dal Lowerer durante canvasToIR() e scritto in NodeData.irRef.
 *
 * Permette di:
 * - trovare il LogicalNode a partire dal nodo React Flow
 * - propagare errori IR → badge canvas senza rieseguire il lowering
 * - tenere sincronizzato canvas e IR senza accoppiamento forte
 */
export interface IRRef {
  /** id del LogicalNode corrispondente in LogicalPlan.nodes */
  logicalNodeId: string
  /**
   * Versione dell'IR al momento della creazione del ref.
   * Se non corrisponde alla versione attuale → il ref è stale
   * e il Lowerer deve essere rieseguito.
   */
  irVersion:     string
}
// ─── Variabili con scope ─────────────────────────────────────────
export type VariableType  = 'string' | 'number' | 'boolean' | 'json' | 'object' | 'materialize'
export type VariableScope = 'pool' | 'lane'

export interface Variable {
  id: string
  name: string
  type: VariableType
  value: string
  scope: VariableScope
}

// ─── Stato connessione risorsa ────────────────────────────────────
export type ResourceStatus = 'untested' | 'ok' | 'error' | 'testing' 

// ─── Azione generata dal chip risorsa ────────────────────────────
export interface ResourceAction {
  id: string
  label: string
  nodeType: string
  propsOverride: Record<string, string>
}

// ─── Risorsa configurata nella resource strip ─────────────────────

export type ResourceKind = 'db' | 'http' | 'kafka' | 'mqtt' | 'ftp' | 'webhook' | 'ssh'

export interface LaneResource {
  id: string
  kind: ResourceKind
  label: string
  status: ResourceStatus
  config: Record<string, string>
  actions: ResourceAction[]
}
// ─── Transactions ─────────────────────────────────────────────────────
export interface LaneTransaction {
  id:      string
  name:    string
  mode:    'native' | 'xa'
  timeout: number   // secondi
  onError: 'rollback_all' | 'rollback_self'
}
// ─── Lane ────────────────────────────────────────────────────────
export interface Lane {
  id: string
  label: string
  color: string
  order: number
  collapsed: boolean
  height: number
  variables: Variable[]
  resources: LaneResource[]
  transactions: LaneTransaction[]
}

// ─── Pool ────────────────────────────────────────────────────────
export interface Pool {
  id: string
  label: string
  variables: Variable[]
  lanes: Lane[]
}

// ─── Log e risultati di esecuzione ───────────────────────────────
export interface LogEntry {
  id: string
  timestamp: Date
  level: 'info' | 'done' |  'warn' | 'error' | 'debug'| 'ok' 
  nodeId?: string
  laneId?: string
  message: string
}

export interface RunResult {
  nodeId: string
  ok: boolean
  rows?: number
  message?: string
  passthrough?: boolean
}

// ─── TMap — tipi base ────────────────────────────────────────────

export type { TMapFieldType } from './fieldTypes'
export type TMapJoinType  = 'inner' | 'left' | 'first' | 'none'

// ─── Campo input ─────────────────────────────────────────────────
export interface TMapInputField {
  // id stabile — NON cambia mai, anche dopo rename del nome logico
  id?:           string
  // Nome logico — quello che vede l'utente, può essere rinominato
  name:          string
  type:          TMapFieldType
  // Nome fisico originale — immutabile, corrisponde al campo nel file/db sorgente
  physicalName?: string
}

// ─── Flusso input ────────────────────────────────────────────────
export interface TMapInput {
  id:             string
  label:          string
  isMain:         boolean
  joinKey?:       string
  sourceJoinKey?: string
  joinType:       TMapJoinType
  fields:         TMapInputField[]
}

// ─── Campo output ────────────────────────────────────────────────
export interface TMapOutputField {
  id:               string
  name:             string
  type:             TMapFieldType
  expression:       string
  sourceInputId?:   string
  sourceFieldName?: string
}

// ─── Flusso output ───────────────────────────────────────────────
export interface TMapOutput {
  id:      string
  label:   string
  color:   string
  filter?: string
  fields:  TMapOutputField[]
}

// ─── Connessione visiva ──────────────────────────────────────────
export interface TMapConnection {
  id:        string
  inputId:   string
  fieldName: string
  outputId:  string
  fieldId:   string
  color:     string
}

// ─── Riferimento a campo input in un transform ───────────────────
// TMapTransformInput esteso — i campi perField vivono qui
export interface TMapTransformInput {
  inputId:        string
  fieldName:      string
  // trasformazione per-campo (solo inline)
  perFieldFn?:     string
  perFieldParams?: Record<string, string>
}

// ─── Pipeline di trasformazione — nuovo modello ──────────────────

// Modalità di editing del transform
export type TransformMode = 'pipeline' | 'inline' | 'script'

// Singolo step della pipeline — riferisce una funzione del catalogo
export interface PipelineStep {
  // id locale stabile nello step
  id:      string
  // id della funzione nel catalogo (es. 'date_iso', 'str_trim')
  fnId:    string
  // Parametri configurati — key = param.key del catalogo
  params:  Record<string, string>
}

// Cast esplicito di tipo — applicato PRIMA degli step della pipeline
export interface CastStep {
  fromType: TMapFieldType
  toType:   TMapFieldType
  // formato opzionale (es. per date: "DD/MM/YYYY")
  format?:  string
}

// ─── Nodo trasformazione ─────────────────────────────────────────
export interface TMapTransformNode {
  id:         string
  label:      string

  mode: 'inline' | 'script'   // pipeline eliminata

  inputs: TMapTransformInput[]

  // Per-campo (solo inline, max 2 campi)
  // inputs[i].perFieldFn    = id funzione catalogo applicata al campo i
  // inputs[i].perFieldParams = parametri della funzione
  // Esteso direttamente su TMapTransformInput tramite cast (vedi sotto)

  cast?:     CastStep
  pipeline?: PipelineStep[]   // mantenuto per retrocompatibilità dati esistenti

  // Espressione combinata (inline 2 campi: editabile; script: codice libero)
  expression: string

  // Funzione finale sull'espressione composta (solo inline 2 campi)
  finalFn?:     string
  finalParams?: Record<string, string>

  outputName: string
  outputType: TMapFieldType
  nullable?:  boolean
  reject?:    boolean

  // UI state
  collapsed?: boolean
}


// ─── Rename tracking ─────────────────────────────────────────────
// Mappa gli id stabili dei campi ai loro nomi logici correnti.
// Usata per propagare i rename dall'esterno (es. da un nodo sorgente)
// senza perdere le trasformazioni già configurate.
//
// Flusso rename:
//   1. Il nodo sorgente rinomina il campo (nome fisico invariato, id invariato)
//   2. saveSchema in MappingPanel aggiorna la FieldRenameMap
//   3. applyRenameMap() in utils.ts aggiorna label, variabili e pipeline
//      di ogni transform che referenzia quel campo
//
export interface FieldRenameEntry {
  // id stabile del campo (TMapInputField.id)
  fieldId:     string
  // inputId della sezione TMap a cui appartiene
  inputId:     string
  // vecchio nome logico
  oldName:     string
  // nuovo nome logico
  newName:     string
}

// ─── Configurazione TMap ────────────────────────────────────────
export interface TMapConfig {
  inputs:       TMapInput[]
  outputs:      TMapOutput[]
  connections?: TMapConnection[]
  transforms?:  TMapTransformNode[]
}

// ─── TMap Editor Canvas (interno) ────────────────────────────────
export type TMapEditorNodeType = 'input_field' | 'transform' | 'output_field'

export interface TMapEditorNodeData extends Record<string, unknown> {
  nodeType:    TMapEditorNodeType
  inputId?:    string
  fieldName?:  string
  fieldType?:  TMapFieldType
  isMain?:     boolean
  expression?: string
  label?:      string
  outputId?:   string
  outputName?: string
  outputType?: TMapFieldType
  color?:      string
}

export interface TMapEditorEdge {
  id:            string
  source:        string
  sourceHandle?: string
  target:        string
  targetHandle?: string
}

export interface TMapEditorGraph {
  nodes: Array<{
    id:       string
    type:     TMapEditorNodeType
    position: { x: number; y: number }
    data:     TMapEditorNodeData
  }>
  edges: TMapEditorEdge[]
}

// ─── Pipeline messaging ──────────────────────────────────────────
export interface NodeExecutionStatus {
  ok:             boolean
  node_id:        string
  node_type:      string
  timestamp:      string
  rows_processed: number
  error_message?: string
  rows_written?:  number
  bytes_written?: number
  file_path?:     string
  rows_inserted?: number
  rows_updated?:  number
  rows_rejected?: number
  rows_read?:     number
  duration_ms?:   number
  [key: string]:  unknown
}

export interface PipelineMessage {
  row:    Record<string, unknown>
  status: NodeExecutionStatus
}