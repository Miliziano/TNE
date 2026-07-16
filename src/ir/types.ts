/**
 * src/ir/types.ts
 */
import type { Pool } from '../types'
export type FieldType =
  | 'string' | 'integer' | 'decimal' | 'boolean'
  | 'date' | 'datetime' | 'timestamp'
  | 'binary' | 'json' | 'xml' | 'object' | 'array' | 'any'

export interface SchemaField {
  id:            string
  name:          string
  type:          FieldType
  physicalName?: string
  nullable?:     boolean
  description?:  string
}

// ─────────────────────────────────────────────────────────────────
// OPERAZIONI LOGICHE
// ─────────────────────────────────────────────────────────────────

export type LogicalOperation =
  | 'scan'
  | 'projection'
  | 'filter'
  | 'join'
  | 'aggregate'
  | 'window'
  | 'union'
  | 'sort'
  | 'limit'
  | 'transform'
  | 'parse'
  | 'sink'
  | 'branch'
  | 'merge'
  /**
   * lane_boundary — nodo speciale che rappresenta i marker di inizio/fine
   * lane (lane_start e lane_end). Non produce né consuma dati — serve solo
   * come punto di ancoraggio per la validazione del DAG.
   * Il codegen lo ignora completamente.
   * Il validator riconosce i nodi adiacenti come connessi alla pipeline.
   */
  | 'lane_boundary'

export type ExecutionSemantics = 'row' | 'dataset' | 'stateful' | 'stream'

// ─────────────────────────────────────────────────────────────────
// EXPRESSION AST
// ─────────────────────────────────────────────────────────────────

export type ExprNode =
  | BinaryOpExpr | UnaryOpExpr | FieldRefExpr | LiteralExpr
  | FunctionCallExpr | CaseWhenExpr | CastExpr | IsNullExpr
  | InListExpr | RawStringExpr

export type BinaryOp =
  | '+' | '-' | '*' | '/' | '%'
  | '==' | '!=' | '>' | '>=' | '<' | '<='
  | 'and' | 'or'
  | 'like' | 'ilike' | 'not_like'
  | 'concat' | 'coalesce_op'

export interface BinaryOpExpr {
  kind: 'binary_op'; op: BinaryOp; left: ExprNode; right: ExprNode; type: FieldType
}
export interface UnaryOpExpr {
  kind: 'unary_op'; op: 'not' | 'negate' | 'is_null' | 'is_not_null'; operand: ExprNode; type: FieldType
}
export interface FieldRefExpr {
  kind: 'field_ref'; fieldName: string; inputId?: string; type: FieldType
}
export interface LiteralExpr {
  kind: 'literal'; value: string | number | boolean | null; type: FieldType
}
export interface FunctionCallExpr {
  kind: 'function_call'; name: string; args: ExprNode[]; type: FieldType
}
export interface CaseWhenExpr {
  kind: 'case_when'
  branches: Array<{ condition: ExprNode; result: ExprNode }>
  else_: ExprNode | null
  type: FieldType
}
export interface CastExpr {
  kind: 'cast'; expr: ExprNode; toType: FieldType; format?: string
}
export interface IsNullExpr {
  kind: 'is_null'; expr: ExprNode; negate: boolean; type: 'boolean'
}
export interface InListExpr {
  kind: 'in_list'; expr: ExprNode; list: LiteralExpr[]; negate: boolean; type: 'boolean'
}
export interface RawStringExpr {
  kind: 'raw_string'; value: string; type: FieldType
}

// ─────────────────────────────────────────────────────────────────
// PORT, LINEAGE, CONTRACT
// ─────────────────────────────────────────────────────────────────

/**
 * Ruolo del payload che porta una porta. Da qui — e SOLO da qui —
 * discende la regola di schema applicata in schemaPropagation:
 *   data   → lo schema in ingresso
 *   signal → SIGNAL_SCHEMA (una riga di stato)
 *   reject → ingresso + campi d'errore
 *   catch  → riga d'errore per l'Error Handler
 *
 * OBBLIGATORIO (P19a). Prima era opzionale e veniva dedotto da un
 * secondo campo `isReject: boolean` che diceva la stessa cosa: due modi
 * di dire un fatto solo, popolati in modo diverso (role era dichiarato
 * su 10 porte su 43 in ingresso e 10 su 50 in uscita, mentre §6 del
 * contratto dice che è da role che discende la regola di schema).
 * Ora il fatto sta in un posto solo e il typecheck lo pretende da chi
 * aggiunge un nodo. `isReject` non si dichiara più: si DERIVA, con
 * l'helper isRejectPort() qui sotto.
 *
 * V. src-tauri/docs/contratto-porte.md §4 e §9.6.
 */
export type PortRole = 'data' | 'signal' | 'reject' | 'catch'

/**
 * Condizione di esistenza di una porta, valutata sui props del nodo.
 * Serve a dichiarare le porte che oggi sono CABLATE dentro FlowNode
 * (catch se onError='propagate', reject dello script se hasReject,
 * uscita di un sink se outputMode≠'none').
 *
 * Due porte con lo STESSO id e condizioni mutuamente esclusive sono
 * legittime: è il modo di dire "questa porta cambia ruolo secondo la
 * configurazione" — es. sink_file outputMode passthrough|signal.
 */
export interface PortCondition {
  /** chiave in node.data.props */
  prop:       string
  /** la porta esiste se il valore è uno di questi */
  equals?:    string[]
  /** ...oppure se NON è uno di questi */
  notEquals?: string[]
  /** valore assunto quando la prop non è valorizzata */
  fallback?:  string
}

/**
 * `id`    = il nome del filo: deve combaciare con l'handle disegnato e
 *           con ciò che cerca il motore (take_primary_output prova
 *           "output" per primo). Id sbagliato = archi scollegati.
 * `label` = cosa esce (es. id `output`, label `passthrough`).
 * `role`  = cosa porta la porta. Obbligatorio — v. PortRole.
 */
export interface PortSpec {
  id: string; label: string; role: PortRole; schema?: SchemaField[]
  /** Omesso ⇒ porta sempre presente. */
  when?: PortCondition

  /**
   * Solo INGRESSI — quanti ARCHI la porta accetta. Omesso ⇒ 1.
   * Design-time: è la regola che oggi vive sparsa in connectionResolver
   * ("Nodo già collegato", "Handle input_main già collegato", …).
   */
  maxEdges?: 1 | 'many'

  /**
   * Solo INGRESSI — quante RIGHE la porta accetta a RUNTIME. Omesso ⇒ 'many'.
   * NON è maxEdges: un arco solo può portare mille righe. Serve alla R8
   * (un source si configura con UNA riga di parametri; 2+ = errore parlante).
   * V. contratto-porte.md R8.
   */
  maxRows?: 1 | 'many'

  /**
   * false ⇒ porta LOGICA: esiste per la validazione e per il motore, ma il
   * canvas non la disegna e non ci si può attaccare un arco. Omesso ⇒ true.
   * Caso: il `catch` dell'error_handler — la raccolta degli errori è una
   * proprietà della lane, non un filo da cablare a mano.
   * V. contratto-porte.md R9.
   */
  connectable?: boolean
}

/**
 * Una porta è di scarto se il suo ruolo lo dice. Un fatto, un posto:
 * questo sostituisce il vecchio campo dichiarato `isReject`.
 */
export const isRejectPort = (p: { role: PortRole }): boolean => p.role === 'reject'

export interface FieldLineageEntry {
  fieldId: string; fieldName: string; sourceNodeId: string
  sourceFieldId?: string; sourceFieldName?: string; transformation?: ExprNode
}

export interface DataContract {
  id: string; schemaVersion: string
  fields: ContractField[]; guarantees: DataConstraint[]
}
export interface ContractField {
  name: string; type: FieldType; nullable: boolean; unique?: boolean; pattern?: string
}
export interface DataConstraint {
  type: 'not_null' | 'unique' | 'range' | 'referential' | 'custom'
  expression: ExprNode; action: 'reject' | 'warn' | 'coerce'; message?: string
}

// ─────────────────────────────────────────────────────────────────
// NODO LOGICO
// ─────────────────────────────────────────────────────────────────

export interface LogicalNode {
  id:        string
  operation: LogicalOperation
  inputs:    PortSpec[]
  outputs:   PortSpec[]
  schema: {
    input:  SchemaField[]
    output: SchemaField[]
  }
  executionSemantics: ExecutionSemantics
  expressions:        ExprNode[]
  dataContract?:      DataContract
  _uiRef?: {
    type:   string
    label:  string
    laneId: string
    config: unknown
    props?: Record<string, string>
  }
}

export interface LogicalEdge {
  id:         string
  source:     string
  sourcePort: string
  target:     string
  targetPort: string
  schema:     SchemaField[]
  lineage:    FieldLineageEntry[]
}
export interface LogicalPlan {
  id:      string
  name:    string
  version: string
  nodes:   LogicalNode[]
  edges:   LogicalEdge[]
  metadata?: {
    createdAt: string; description: string; tags: string[]
  }
  pool?: Pool
}

export interface ValidationIssue {
  nodeId?:  string
  edgeId?:  string
  fieldId?: string
  code:     string
  message:  string
  severity: 'error' | 'warning' | 'info'
  hint?:    string
}

export interface ValidationResult {
  valid:    boolean
  issues:   ValidationIssue[]
  errors:   ValidationIssue[]
  warnings: ValidationIssue[]
}

export interface MaterializationPoint {
  afterNodeId: string
  strategy:    'memory' | 'disk' | 'parquet' | 'checkpoint'
  reason:      'barrier' | 'retry_boundary' | 'cache' | 'shuffle'
}