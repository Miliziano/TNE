/**
 * src/ir/exprTypes.ts
 *
 * Inferenza del tipo di un'espressione FPEL. UNA sola, condivisa da:
 *  - propagazione schema dello Script (i campi assegnati nel corpo)
 *  - TMap (i campi calcolati)
 *
 * Perché qui e non nei due posti: prima esistevano zero inferenze vere
 * per lo Script (i campi nuovi uscivano `any`, v. P66) e una privata,
 * legata alla TMapConfig, dentro `tmapExprConverter.ts`. Due logiche di
 * tipo destinate a divergere alla prima modifica. Il tipo di un campo
 * dev'essere lo stesso ovunque nasca da un'espressione: un posto solo.
 *
 * ALLINEATA AL MOTORE (`src-tauri/src/engine/expr.rs`): dove il Rust
 * decide un tipo a runtime, qui si predice lo stesso. Il caso più
 * insidioso è `+` (IR `ADD`): il motore concatena se ALMENO un operando
 * è stringa (`expr.rs`, "Add: se almeno uno è stringa → concatena"),
 * altrimenti è aritmetico. L'inferenza fa lo stesso.
 *
 * Onestà sui limiti: dove il tipo non è conoscibile a design-time
 * (variabile di lane, accesso a struttura, campo non in schema) si
 * restituisce `any` — mai una stringa comoda che poi il dato smentisce.
 */

import type { ExprNode } from './exprParser'
import { lookupFunction } from './functions'
import type { FieldType } from '../types/fieldTypes'

export interface InferCtx {
  /** tipo di un campo diretto della riga; undefined = non in schema */
  field: (name: string) => FieldType | undefined
  /**
   * tipo di un riferimento qualificato (`FieldRef`): TMap multi-input
   * ("Etichetta".campo) o il `__local` dello Script (i `let`).
   * undefined = sconosciuto.
   */
  qualified?: (input: string, field: string) => FieldType | undefined
}

const NUMERIC = new Set<FieldType>(['integer', 'decimal', 'number'])

/** Confronti e operatori logici → sempre boolean. */
const BOOLEAN_OPS = new Set(['EQ', 'NE', 'GT', 'LT', 'GTE', 'LTE', 'AND', 'OR'])

export function inferExprType(node: ExprNode, ctx: InferCtx): FieldType {
  switch (node.kind) {
    case 'Literal': {
      const v = node.value
      if (v === null) return 'any' // null non porta tipo
      if (typeof v === 'string') return 'string'
      if (typeof v === 'boolean') return 'boolean'
      if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'decimal'
      return 'any'
    }

    case 'DirectFieldRef':
      return ctx.field(node.field) ?? 'any'

    case 'FieldRef':
      return ctx.qualified?.(node.input, node.field) ?? 'any'

    case 'UnaryOp':
      // NOT → boolean ; NEG → numerico
      return node.op === 'NOT' ? 'boolean' : 'number'

    case 'BinaryOp':
      return inferBinary(node.op, node.left, node.right, ctx)

    case 'IsNull':
    case 'IsNotNull':
      return 'boolean'

    case 'Cast':
      return castType(node.target_type)

    case 'Coalesce':
      return unifyAll(node.args.map((a) => inferExprType(a, ctx)))

    case 'CaseWhen': {
      const rami = node.branches.map((b) => inferExprType(b.value, ctx))
      if (node.default) rami.push(inferExprType(node.default, ctx))
      return unifyAll(rami)
    }

    case 'FunctionCall':
      return inferFunction(node.name, node.args, ctx)
  }
}

function inferBinary(op: string, left: ExprNode, right: ExprNode, ctx: InferCtx): FieldType {
  if (BOOLEAN_OPS.has(op)) return 'boolean'

  if (op === 'ADD') {
    // Sovraccarico come nel motore: un lato stringa → concatenazione.
    const lt = inferExprType(left, ctx)
    const rt = inferExprType(right, ctx)
    if (lt === 'string' || rt === 'string') return 'string'
    return unifyNumeric(lt, rt)
  }

  // SUB / MUL / DIV / MOD → numerico
  return 'number'
}

function inferFunction(name: string, args: ExprNode[], ctx: InferCtx): FieldType {
  const fn = lookupFunction(name)
  if (!fn) return 'any' // sconosciuta: lo dice la validazione, qui non si indovina
  if (fn.returns !== 'polimorfo') return fn.returns

  const t = (i: number): FieldType => (args[i] ? inferExprType(args[i], ctx) : 'any')
  switch (fn.name) {
    case 'nullif':
      return t(0)
    case 'iif':
      return unify(t(1), t(2))
    case 'coalesce':
      return unifyAll(args.map((a) => inferExprType(a, ctx)))
    case 'min':
    case 'max':
      return unify(t(0), t(1))
    case 'clamp':
      return t(0)
    default:
      return 'any'
  }
}

/** target_type di un Cast → FieldType. `float`/`double` cadono su `decimal`. */
function castType(target: string): FieldType {
  switch (target.toLowerCase()) {
    case 'integer':
    case 'int':
      return 'integer'
    case 'float':
    case 'double':
    case 'decimal':
      return 'decimal'
    case 'string':
    case 'text':
      return 'string'
    case 'bool':
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'datetime':
    case 'timestamp':
      return 'datetime'
    default:
      return 'any'
  }
}

/** Tipo comune di due espressioni (rami di iif, coalesce, ecc.). */
export function unify(a: FieldType, b: FieldType): FieldType {
  if (a === b) return a
  if (a === 'any') return b
  if (b === 'any') return a
  if (NUMERIC.has(a) && NUMERIC.has(b)) return 'number'
  return 'any' // tipi incompatibili: onesto ammettere di non sapere
}

function unifyAll(tipi: FieldType[]): FieldType {
  if (tipi.length === 0) return 'any'
  return tipi.reduce(unify)
}

/** Somma numerica: integer+integer resta integer, il resto è number. */
function unifyNumeric(a: FieldType, b: FieldType): FieldType {
  if (a === 'integer' && b === 'integer') return 'integer'
  return 'number'
}
