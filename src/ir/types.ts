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

export interface PortSpec {
  id: string; label: string; isReject: boolean; schema?: SchemaField[]
}

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