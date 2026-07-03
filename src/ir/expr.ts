/**
 * src/ir/expr.ts
 * ──────────────
 * Expression AST — parser, builder e utilities per le espressioni
 * del Logical IR.
 *
 * Struttura:
 *   1. Builder — costruisce ExprNode programmaticamente (type-safe)
 *   2. Parser  — traduce espressioni stringa → ExprNode
 *   3. Printer — serializza ExprNode → stringa leggibile (debug)
 *   4. Analyzer — type inference e field extraction
 *
 * Strategia di migrazione:
 *   Le espressioni stringa esistenti (TMap expressions, filtri, script)
 *   vengono wrappate in RawStringExpr durante il lowering.
 *   Il parser tenta di parsarle verso AST completo.
 *   Se il parsing fallisce → rimane RawStringExpr (compatibilità garantita).
 *
 * Il compilatore può eseguire entrambe le forme:
 *   - ExprNode completo → ottimizzabile, type-checkable, cross-runtime
 *   - RawStringExpr     → black box, eseguita solo nel runtime originale
 */

import type {
  ExprNode,
  BinaryOpExpr,
  UnaryOpExpr,
  FieldRefExpr,
  LiteralExpr,
  FunctionCallExpr,
  CaseWhenExpr,
  CastExpr,
  IsNullExpr,
  InListExpr,
  RawStringExpr,
  BinaryOp,
  FieldType,
} from './types'

// ─────────────────────────────────────────────────────────────────
// 1. BUILDER — costruisce ExprNode in modo type-safe
// ─────────────────────────────────────────────────────────────────

export const expr = {

  /** Riferimento a un campo dello schema */
  field(name: string, type: FieldType = 'any', inputId?: string): FieldRefExpr {
    return { kind: 'field_ref', fieldName: name, type, inputId }
  },

  /** Valore letterale stringa */
  str(value: string): LiteralExpr {
    return { kind: 'literal', value, type: 'string' }
  },

  /** Valore letterale intero */
  int(value: number): LiteralExpr {
    return { kind: 'literal', value: Math.trunc(value), type: 'integer' }
  },

  /** Valore letterale decimale */
  dec(value: number): LiteralExpr {
    return { kind: 'literal', value, type: 'decimal' }
  },

  /** Valore letterale booleano */
  bool(value: boolean): LiteralExpr {
    return { kind: 'literal', value, type: 'boolean' }
  },

  /** Valore null */
  null(type: FieldType = 'string'): LiteralExpr {
    return { kind: 'literal', value: null, type }
  },

  /** Operazione binaria */
  binop(op: BinaryOp, left: ExprNode, right: ExprNode): BinaryOpExpr {
    // Inferisce il tipo dell'espressione dall'operatore
    const type = inferBinaryOpType(op, left, right)
    return { kind: 'binary_op', op, left, right, type }
  },

  /** Operazione unaria NOT */
  not(operand: ExprNode): UnaryOpExpr {
    return { kind: 'unary_op', op: 'not', operand, type: 'boolean' }
  },

  /** Negazione numerica */
  negate(operand: ExprNode): UnaryOpExpr {
         return { kind: 'unary_op', op: 'negate', operand, type: getExprType(operand) }
  },

  /** Chiamata a funzione del catalogo */
  fn(name: string, args: ExprNode[], type: FieldType = 'string'): FunctionCallExpr {
    return { kind: 'function_call', name, args, type }
  },

  /** CASE WHEN ... THEN ... END */
  caseWhen(
    branches: Array<{ condition: ExprNode; result: ExprNode }>,
    else_: ExprNode | null,
    type: FieldType = 'string'
  ): CaseWhenExpr {
    return { kind: 'case_when', branches, else_, type }
  },

  /** Cast esplicito di tipo */
  cast(e: ExprNode, toType: FieldType, format?: string): CastExpr {
    return { kind: 'cast', expr: e, toType, format }
  },

  /** IS NULL */
  isNull(e: ExprNode): IsNullExpr {
    return { kind: 'is_null', expr: e, negate: false, type: 'boolean' }
  },

  /** IS NOT NULL */
  isNotNull(e: ExprNode): IsNullExpr {
    return { kind: 'is_null', expr: e, negate: true, type: 'boolean' }
  },

  /** IN (...) */
  inList(e: ExprNode, list: LiteralExpr[], negate = false): InListExpr {
    return { kind: 'in_list', expr: e, list, negate, type: 'boolean' }
  },

  /** AND logico */
  and(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return expr.binop('and', left, right)
  },

  /** OR logico */
  or(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return expr.binop('or', left, right)
  },

  /** Uguale == */
  eq(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return expr.binop('==', left, right)
  },

  /** Diverso != */
  ne(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return expr.binop('!=', left, right)
  },

  /** Maggiore > */
  gt(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return expr.binop('>', left, right)
  },

  /** Maggiore o uguale >= */
  gte(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return expr.binop('>=', left, right)
  },

  /** Minore < */
  lt(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return expr.binop('<', left, right)
  },

  /** Minore o uguale <= */
  lte(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return expr.binop('<=', left, right)
  },

  /** Concatenazione stringa */
  concat(left: ExprNode, right: ExprNode): BinaryOpExpr {
    return { kind: 'binary_op', op: 'concat', left, right, type: 'string' }
  },

  /**
   * Wrapper di compatibilità per espressioni stringa non ancora parsate.
   * Usato durante la migrazione dal modello precedente.
   */
  raw(value: string, type: FieldType = 'any'): RawStringExpr {
    return { kind: 'raw_string', value, type }
  },
}

// ─────────────────────────────────────────────────────────────────
// INFERENZA TIPO BINOP
// ─────────────────────────────────────────────────────────────────
/** Restituisce il tipo di un ExprNode in modo type-safe */
function getExprType(e: ExprNode): FieldType {
  switch (e.kind) {
    case 'binary_op':    return e.type
    case 'unary_op':     return e.type
    case 'field_ref':    return e.type
    case 'literal':      return e.type
    case 'function_call': return e.type
    case 'case_when':    return e.type
    case 'cast':         return e.toType
    case 'is_null':      return 'boolean'
    case 'in_list':      return 'boolean'
    case 'raw_string':   return e.type
  }
}

function inferBinaryOpType(op: BinaryOp, left: ExprNode, right: ExprNode): FieldType {
  if (['==', '!=', '>', '>=', '<', '<=', 'and', 'or', 'like', 'ilike', 'not_like'].includes(op)) {
    return 'boolean'
  }
  if (op === 'concat') return 'string'
  if (op === 'coalesce_op') return getExprType(left)
  if (['+', '-', '*', '/', '%'].includes(op)) {
    const lt = getExprType(left)
    const rt = getExprType(right)
    if (lt === 'decimal' || rt === 'decimal') return 'decimal'
    if (lt === 'integer' && rt === 'integer') return 'integer'
    return 'decimal'
  }
  return 'any'
}

// ─────────────────────────────────────────────────────────────────
// 2. PARSER — stringa → ExprNode
// ─────────────────────────────────────────────────────────────────

/**
 * Risultato del parsing di un'espressione stringa.
 */
export interface ParseResult {
  /** true se il parsing è riuscito completamente */
  success:  boolean
  /** ExprNode risultante (sempre presente — RawStringExpr se fallisce) */
  expr:     ExprNode
  /** Errore di parsing, se presente */
  error?:   string
}

/**
 * Tenta di parsare un'espressione stringa verso ExprNode.
 *
 * Riconosce:
 * - Confronti semplici: campo > 5, campo == 'valore', campo != null
 * - Operatori logici: AND, OR, NOT
 * - Chiamate a funzioni: trim(campo), upper(campo)
 * - Letterali: 'stringa', 42, 3.14, true, false, null
 * - Riferimenti a campi: nome_campo, input.nome_campo
 * - LIKE: campo LIKE '%pattern%'
 * - IS NULL / IS NOT NULL
 * - IN (...): campo IN ('a', 'b', 'c')
 *
 * Se il parsing fallisce per espressioni complesse (script JS, template
 * con ${}, espressioni multi-riga) → restituisce RawStringExpr.
 */
export function parseExpr(input: string, defaultType: FieldType = 'any'): ParseResult {
  const s = input.trim()

  if (!s) {
    return { success: false, expr: expr.raw(input, defaultType), error: 'Espressione vuota' }
  }

  // Script multi-riga o con JS → sempre RawStringExpr
  if (s.includes('\n') || s.includes('=>') || s.includes('function') || s.includes('return ')) {
    return { success: false, expr: expr.raw(input, defaultType) }
  }

  try {
    const result = parseExpression(s)
    return { success: true, expr: result }
  } catch (e: any) {
    return {
      success: false,
      expr:    expr.raw(input, defaultType),
      error:   e.message,
    }
  }
}

// ── Parser interno ────────────────────────────────────────────────

function parseExpression(s: string): ExprNode {
  // OR ha la precedenza più bassa
  return parseOr(s.trim())
}

function parseOr(s: string): ExprNode {
  const parts = splitBy(s, /\bOR\b/i)
  if (parts.length > 1) {
    return parts
      .map((p) => parseAnd(p.trim()))
      .reduce((acc, cur) => expr.or(acc, cur))
  }
  return parseAnd(s)
}

function parseAnd(s: string): ExprNode {
  const parts = splitBy(s, /\bAND\b/i)
  if (parts.length > 1) {
    return parts
      .map((p) => parseNot(p.trim()))
      .reduce((acc, cur) => expr.and(acc, cur))
  }
  return parseNot(s)
}

function parseNot(s: string): ExprNode {
  if (/^NOT\s+/i.test(s)) {
    return expr.not(parseComparison(s.replace(/^NOT\s+/i, '').trim()))
  }
  return parseComparison(s)
}

function parseComparison(s: string): ExprNode {
  // IS NULL / IS NOT NULL
  const isNullMatch = s.match(/^(.+?)\s+IS\s+(NOT\s+)?NULL$/i)
  if (isNullMatch) {
    const operand = parsePrimary(isNullMatch[1].trim())
    return isNullMatch[2]
      ? expr.isNotNull(operand)
      : expr.isNull(operand)
  }

  // IN (...)
  const inMatch = s.match(/^(.+?)\s+(NOT\s+)?IN\s*\((.+)\)$/i)
  if (inMatch) {
    const left     = parsePrimary(inMatch[1].trim())
    const negate   = !!inMatch[2]
    const listRaw  = inMatch[3]
    const listItems = splitBy(listRaw, /,/).map((item) => {
      const t = item.trim()
      return parseLiteral(t) ?? expr.str(t)
    })
    return expr.inList(left, listItems as LiteralExpr[], negate)
  }

  // LIKE / ILIKE
  const likeMatch = s.match(/^(.+?)\s+(NOT\s+)?(I?LIKE)\s+(.+)$/i)
  if (likeMatch) {
    const left    = parsePrimary(likeMatch[1].trim())
    const negate  = !!likeMatch[2]
    const op      = likeMatch[3].toLowerCase() as 'like' | 'ilike'
    const right   = parsePrimary(likeMatch[4].trim())
    const likeExpr: BinaryOpExpr = { kind: 'binary_op', op, left, right, type: 'boolean' }
    return negate ? expr.not(likeExpr) : likeExpr
  }

  // Operatori di confronto
  const COMPARISON_OPS = [
    { re: /^(.+?)\s*(==|===)\s*(.+)$/,  op: '==' as BinaryOp },
    { re: /^(.+?)\s*(!=|!==|<>)\s*(.+)$/, op: '!=' as BinaryOp },
    { re: /^(.+?)\s*(>=)\s*(.+)$/,      op: '>=' as BinaryOp },
    { re: /^(.+?)\s*(<=)\s*(.+)$/,      op: '<=' as BinaryOp },
    { re: /^(.+?)\s*(>)\s*(.+)$/,       op: '>'  as BinaryOp },
    { re: /^(.+?)\s*(<)\s*(.+)$/,       op: '<'  as BinaryOp },
  ]

  for (const { re, op } of COMPARISON_OPS) {
    const m = s.match(re)
    if (m) {
      const left  = parsePrimary(m[1].trim())
      const right = parsePrimary(m[3].trim())
      return expr.binop(op, left, right)
    }
  }

  // Espressioni aritmetiche semplici
  const ADD_OPS = [
    { re: /^(.+?)\s*(\+)\s*(.+)$/, op: '+' as BinaryOp },
    { re: /^(.+?)\s*(-)\s*(.+)$/,  op: '-' as BinaryOp },
  ]
  for (const { re, op } of ADD_OPS) {
    const m = s.match(re)
    if (m) {
      return expr.binop(op, parsePrimary(m[1].trim()), parsePrimary(m[3].trim()))
    }
  }

  return parsePrimary(s)
}

function parsePrimary(s: string): ExprNode {
  // Parentesi
  if (s.startsWith('(') && s.endsWith(')')) {
    return parseExpression(s.slice(1, -1))
  }

  // Letterali
  const lit = parseLiteral(s)
  if (lit) return lit

  // Chiamate a funzione: nome(args)
  const fnMatch = s.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*\((.*)?\)$/)
  if (fnMatch) {
    const name = fnMatch[1].toLowerCase()
    const argsRaw = fnMatch[2] ?? ''
    const args = argsRaw
      ? splitBy(argsRaw, /,/).map((a) => parsePrimary(a.trim()))
      : []
    const type = inferFunctionType(name)
    return expr.fn(name, args, type)
  }

  // Riferimento a campo (es. 'nome', 'input1.nome', '$campo')
  const fieldClean = s.replace(/^\$/, '')
  if (/^[a-zA-Z_][a-zA-Z0-9_.]*$/.test(fieldClean)) {
    const parts = fieldClean.split('.')
    if (parts.length === 2) {
      // input.campo
      return expr.field(parts[1], 'any', parts[0])
    }
    return expr.field(fieldClean, 'any')
  }

  // Non riconosciuto → raw
  throw new Error(`Impossibile parsare: ${s}`)
}

function parseLiteral(s: string): LiteralExpr | null {
  // Stringa con apici singoli o doppi
  if ((s.startsWith("'") && s.endsWith("'")) ||
      (s.startsWith('"') && s.endsWith('"'))) {
    return expr.str(s.slice(1, -1))
  }
  // null
  if (s.toLowerCase() === 'null') return expr.null()
  // booleani
  if (s.toLowerCase() === 'true')  return expr.bool(true)
  if (s.toLowerCase() === 'false') return expr.bool(false)
  // intero
  if (/^-?\d+$/.test(s)) return expr.int(parseInt(s, 10))
  // decimale
  if (/^-?\d+\.\d+$/.test(s)) return expr.dec(parseFloat(s))
  return null
}

/** Inferisce il tipo di ritorno di una funzione nota */
function inferFunctionType(name: string): FieldType {
  const typeMap: Record<string, FieldType> = {
    trim: 'string', ltrim: 'string', rtrim: 'string',
    upper: 'string', lower: 'string', substring: 'string',
    concat: 'string', replace: 'string', lpad: 'string', rpad: 'string',
    length: 'integer', char_length: 'integer', position: 'integer',
    to_integer: 'integer', to_int: 'integer', floor: 'integer', ceil: 'integer',
    to_decimal: 'decimal', to_float: 'decimal', round: 'decimal', abs: 'decimal',
    to_boolean: 'boolean', to_bool: 'boolean',
    to_date: 'date', date_format: 'string', date_add: 'date', date_diff: 'integer',
    to_string: 'string', cast: 'any',
    coalesce: 'any', nvl: 'any', ifnull: 'any', nullif: 'any',
    decode: 'any',
    now: 'timestamp', current_date: 'date', current_timestamp: 'timestamp',
  }
  return typeMap[name.toLowerCase()] ?? 'any'
}

/**
 * Divide una stringa per un separatore regex rispettando
 * parentesi e apici — non divide dentro (func(a, b)) o 'a, b'.
 */
function splitBy(s: string, sep: RegExp): string[] {
  const parts: string[] = []
  let   depth  = 0
  let   inStr  = false
  let   strChar = ''
  let   start  = 0
  let   i      = 0

  while (i < s.length) {
    const ch = s[i]

    if (inStr) {
      if (ch === strChar && s[i - 1] !== '\\') inStr = false
    } else if (ch === "'" || ch === '"') {
      inStr = true; strChar = ch
    } else if (ch === '(') {
      depth++
    } else if (ch === ')') {
      depth--
    } else if (depth === 0) {
      // Testa il separatore qui
      const sub = s.slice(i)
      const m   = sub.match(sep)
      if (m && m.index === 0) {
        parts.push(s.slice(start, i))
        i += m[0].length
        start = i
        continue
      }
    }
    i++
  }

  parts.push(s.slice(start))
  return parts.filter((p) => p.trim().length > 0)
}

// ─────────────────────────────────────────────────────────────────
// 3. PRINTER — ExprNode → stringa leggibile
// ─────────────────────────────────────────────────────────────────

/**
 * Serializza un ExprNode in una stringa leggibile.
 * Usato per debug, messaggi di errore e anteprima nel canvas.
 */
export function printExpr(e: ExprNode): string {
  switch (e.kind) {
    case 'field_ref':
      return e.inputId ? `${e.inputId}.${e.fieldName}` : e.fieldName

    case 'literal':
      if (e.value === null)           return 'null'
      if (typeof e.value === 'string') return `'${e.value}'`
      return String(e.value)

    case 'binary_op':
      return `(${printExpr(e.left)} ${e.op} ${printExpr(e.right)})`

    case 'unary_op':
      if (e.op === 'not') return `NOT ${printExpr(e.operand)}`
      if (e.op === 'negate') return `-${printExpr(e.operand)}`
      return `${e.op}(${printExpr(e.operand)})`

    case 'function_call':
      return `${e.name}(${e.args.map(printExpr).join(', ')})`

    case 'case_when': {
      const branches = e.branches
        .map((b) => `WHEN ${printExpr(b.condition)} THEN ${printExpr(b.result)}`)
        .join(' ')
      const else_ = e.else_ ? ` ELSE ${printExpr(e.else_)}` : ''
      return `CASE ${branches}${else_} END`
    }

    case 'cast':
      return e.format
        ? `CAST(${printExpr(e.expr)} AS ${e.toType}, '${e.format}')`
        : `CAST(${printExpr(e.expr)} AS ${e.toType})`

    case 'is_null':
      return `${printExpr(e.expr)} IS ${e.negate ? 'NOT ' : ''}NULL`

    case 'in_list': {
      const list = e.list.map(printExpr).join(', ')
      return `${printExpr(e.expr)} ${e.negate ? 'NOT ' : ''}IN (${list})`
    }

    case 'raw_string':
      return e.value
  }
}

// ─────────────────────────────────────────────────────────────────
// 4. ANALYZER — type inference e field extraction
// ─────────────────────────────────────────────────────────────────

/**
 * Estrae tutti i riferimenti a campi usati in un'espressione.
 * Usato dalla Schema Propagation per sapere quali campi
 * un'espressione richiede in input.
 */
export function extractFieldRefs(e: ExprNode): FieldRefExpr[] {
  const refs: FieldRefExpr[] = []

  function walk(node: ExprNode) {
    switch (node.kind) {
      case 'field_ref':
        refs.push(node)
        break
      case 'binary_op':
        walk(node.left); walk(node.right)
        break
      case 'unary_op':
        walk(node.operand)
        break
      case 'function_call':
        node.args.forEach(walk)
        break
      case 'case_when':
        node.branches.forEach((b) => { walk(b.condition); walk(b.result) })
        if (node.else_) walk(node.else_)
        break
      case 'cast':
        walk(node.expr)
        break
      case 'is_null':
        walk(node.expr)
        break
      case 'in_list':
        walk(node.expr)
        break
      case 'literal':
      case 'raw_string':
        // Nessun campo referenziato
        break
    }
  }

  walk(e)
  return refs
}

/**
 * Verifica se un'espressione è un predicato puro
 * (non modifica campi, solo filtra).
 * Usato dall'optimizer per identificare candidati al pushdown.
 */
export function isPredicate(e: ExprNode): boolean {
  return getExprType(e) === 'boolean'
}

/**
 * Verifica se un'espressione è costante (non referenzia campi).
 * Usato dall'optimizer per il constant folding.
 */
export function isConstant(e: ExprNode): boolean {
  return extractFieldRefs(e).length === 0 && e.kind !== 'raw_string'
}

/**
 * Tenta di valutare un'espressione costante a compile time.
 * Restituisce null se non è possibile (espressione non costante o raw).
 */
export function evaluateConstant(e: ExprNode): LiteralExpr | null {
  if (!isConstant(e)) return null
  if (e.kind === 'literal') return e

  if (e.kind === 'binary_op') {
    const left  = evaluateConstant(e.left)
    const right = evaluateConstant(e.right)
    if (!left || !right) return null

    if (typeof left.value === 'number' && typeof right.value === 'number') {
      switch (e.op) {
        case '+': return expr.dec(left.value + right.value)
        case '-': return expr.dec(left.value - right.value)
        case '*': return expr.dec(left.value * right.value)
        case '/': return right.value !== 0 ? expr.dec(left.value / right.value) : null
      }
    }
    if (e.op === '==' && left.value === right.value) return expr.bool(true)
    if (e.op === '!='  && left.value !== right.value) return expr.bool(true)
  }

  return null
}
