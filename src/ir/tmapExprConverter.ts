/**
 * src/ir/tmapExprConverter.ts
 *
 * Converte le TMapConfig in TMapPlan — la struttura tipizzata
 * che viene serializzata nel Plan JSON e mandata al Engine Rust.
 *
 * Responsabilità:
 * 1. Converte le expression string dei campi output in ExprNode
 * 2. Inferisce il tipo output da ogni ExprNode (risolve il problema
 *    di propagazione dei tipi: il tipo non è più impostato a mano
 *    ma derivato automaticamente dall'espressione)
 * 3. Costruisce la struttura lookup con join_pairs risolta
 * 4. Converte le transforms in ExprNode
 *
 * Output: TMapPlan — JSON-serializzabile, direttamente usabile
 * dal nodo Rust `tmap` tramite serde_json::from_value.
 */

import type { TMapConfig, TMapInput, TMapOutput, TMapOutputField } from '../types'
import type { JoinPair, JoinFieldExpr } from '../nodes/types/tmap/TMapModal'
import { parseExpression, ExprParseError } from './exprParser'

// ─── Tipi del Plan ────────────────────────────────────────────────
// Questi tipi vengono serializzati in JSON e letti da Rust.
// Devono corrispondere esattamente alle struct Rust in engine/nodes/tmap.rs

export interface TMapPlan {
  /** Id dell'input isMain */
  main_input_id: string

  /** Lookup in ordine topologico di materializzazione */
  lookups: TMapLookupPlan[]

  /** Output del TMap */
  outputs: TMapOutputPlan[]

  /** Transforms (variabili intermedie) in ordine di dipendenza */
  transforms: TMapTransformPlan[]

  /** Variabili di lane accessibili a tutti i nodi */
  lane_variables: string[]
}

export interface TMapLookupPlan {
  /** Id dell'input nel TMapConfig */
  input_id: string
  label: string
  join_type: 'inner' | 'left' | 'first'

  /**
   * Coppie di join risolte — come costruire la chiave di lookup.
   * Una coppia = una condizione di match.
   * Se più coppie → AND logico (tutte devono matchare).
   */
  join_pairs: TMapJoinPairPlan[]
}

export interface TMapJoinPairPlan {
  /** Espressione che produce la chiave lato sorgente */
  src_key_expr: ExprNode
  /** Campo del lookup su cui fare il match */
  dst_field: string
  /** Espressione opzionale per trasformare il campo del lookup */
  dst_key_expr?: ExprNode
}

export interface TMapOutputPlan {
  output_id: string
  label: string
  /** null = default (tutte le righe con match) */
  filter_expr: ExprNode | null
  fields: TMapOutputFieldPlan[]
}

export interface TMapOutputFieldPlan {
  name: string
  type: string
  /** ExprNode che produce il valore del campo */
  expr: ExprNode
}

export interface TMapTransformPlan {
  id: string
  output_name: string
  output_type: string
  /** ExprNode che produce il valore della transform */
  expr: ExprNode
}

// ─── ExprNode (speculare a engine/expr.rs) ───────────────────────
// Importato da types o ridefinito qui per chiarezza
export type ExprNode =
  | { kind: 'Literal'; value: string | number | boolean | null }
  | { kind: 'FieldRef'; input: string; field: string }
  | { kind: 'DirectFieldRef'; field: string }
  | { kind: 'BinaryOp'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'UnaryOp'; op: string; expr: ExprNode }
  | { kind: 'FunctionCall'; name: string; args: ExprNode[] }
  | { kind: 'CaseWhen'; branches: Array<{ condition: ExprNode; value: ExprNode }>; default: ExprNode | null }
  | { kind: 'Cast'; expr: ExprNode; target_type: string }
  | { kind: 'IsNull'; expr: ExprNode }
  | { kind: 'IsNotNull'; expr: ExprNode }
  | { kind: 'Coalesce'; args: ExprNode[] }

// ─── Entry point ──────────────────────────────────────────────────

export function buildTMapPlan(tmap: TMapConfig): TMapPlan {
  const mainInput = tmap.inputs.find(i => i.isMain)
  if (!mainInput) throw new Error('TMap: nessun input main trovato')

  // Mappa label → inputId (per parsing delle expression)
  const labelToInputId = new Map<string, string>()
  for (const inp of tmap.inputs) {
    labelToInputId.set(inp.label, inp.id)
  }

  // Mappa inputId → campi (per inferenza dei tipi)
  const inputFields = new Map<string, Map<string, string>>()
  for (const inp of tmap.inputs) {
    const fieldMap = new Map<string, string>()
    for (const f of inp.fields) {
      fieldMap.set(f.name, f.type)
    }
    inputFields.set(inp.id, fieldMap)
  }

  // Mappa transformId → outputName e outputType (per referenze da output)
  const transformByOutputName = new Map<string, { id: string; outputType: string }>()
  for (const tr of tmap.transforms ?? []) {
    if (tr.outputName) {
      transformByOutputName.set(tr.outputName, { id: tr.id, outputType: tr.outputType })
    }
  }

  // ── 1. Ordine topologico dei lookup ───────────────────────────
  const lookups = buildLookupOrder(tmap, mainInput.id, labelToInputId, inputFields)

  // ── 2. Transforms ─────────────────────────────────────────────
  const transforms = buildTransforms(tmap, labelToInputId, inputFields)

  // ── 3. Output ─────────────────────────────────────────────────
  const outputs = buildOutputs(
    tmap, labelToInputId, inputFields, transformByOutputName
  )

  return {
    main_input_id:  mainInput.id,
    lookups,
    outputs,
    transforms,
    lane_variables: [],
  }
}

// ─── Lookup in ordine topologico ──────────────────────────────────

function buildLookupOrder(
  tmap:           TMapConfig,
  mainInputId:    string,
  labelToInputId: Map<string, string>,
  inputFields:    Map<string, Map<string, string>>,
): TMapLookupPlan[] {
  const lookupInputs = tmap.inputs.filter(i => !i.isMain)

  // Ordine topologico: se lookup B dipende da lookup A (join A→B),
  // A deve essere materializzato prima di B
  const deps = new Map<string, Set<string>>()
  for (const inp of lookupInputs) {
    deps.set(inp.id, new Set())
    const pairs: JoinPair[] = (inp as any).joinPairs ?? []
    for (const pair of pairs) {
      if (pair.srcInputId !== mainInputId) {
        deps.get(inp.id)!.add(pair.srcInputId)
      }
    }
  }

  // Kahn's algorithm
  const result: string[] = []
  const visited = new Set<string>()
  const queue = lookupInputs
    .filter(i => (deps.get(i.id)?.size ?? 0) === 0)
    .map(i => i.id)

  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(id)
    visited.add(id)
    for (const [lid, ldeps] of deps) {
      if (ldeps.has(id)) {
        ldeps.delete(id)
        if (ldeps.size === 0 && !visited.has(lid)) {
          queue.push(lid)
        }
      }
    }
  }

  return result.map(inputId => {
    const inp = tmap.inputs.find(i => i.id === inputId)!
    const pairs: JoinPair[] = (inp as any).joinPairs ?? []

    const joinPairs: TMapJoinPairPlan[] = pairs.flatMap(pair => {
      // Ogni JoinPair può avere N srcFields e M dstFields
      // Per semplicità: combina con combineExpr se N>1
      const srcExpr = buildJoinKeyExpr(
        pair.srcFields, pair.combineExpr, pair.srcInputId,
        labelToInputId, inputFields
      )
      const dstExpr = buildJoinKeyExpr(
        pair.dstFields, pair.dstCombineExpr ?? '', inputId,
        labelToInputId, inputFields
      )

      // Il dst_field è il primo campo del dst — usato come chiave
      // per l'HashMap di materializzazione
      const primaryDstField = pair.dstFields?.[0]?.field ?? ''

      return [{
        src_key_expr: srcExpr,
        dst_field:    primaryDstField,
        dst_key_expr: dstExpr,
      }]
    })

    return {
      input_id:   inputId,
      label:      inp.label,
      join_type:  (inp.joinType as 'inner' | 'left' | 'first') ?? 'left',
      join_pairs: joinPairs,
    }
  })
}

// ─── Costruisce l'ExprNode per una chiave join ────────────────────

function buildJoinKeyExpr(
  fields:         JoinFieldExpr[],
  combineExpr:    string,
  inputId:        string,
  labelToInputId: Map<string, string>,
  inputFields:    Map<string, Map<string, string>>,
): ExprNode {
  if (!fields || fields.length === 0) {
    return { kind: 'Literal', value: null }
  }

  if (fields.length === 1) {
    return buildJoinFieldExpr(fields[0], inputId, labelToInputId)
  }

  // Chiave composta: usa combineExpr se presente, altrimenti concatenazione
  if (combineExpr) {
    return parseExpressionString(combineExpr, labelToInputId, inputFields)
  }

  // Concatenazione automatica con separatore "-"
  let result: ExprNode = buildJoinFieldExpr(fields[0], inputId, labelToInputId)
  for (let i = 1; i < fields.length; i++) {
    result = {
      kind: 'BinaryOp',
      op: 'CONCAT',
      left: { kind: 'BinaryOp', op: 'CONCAT', left: result, right: { kind: 'Literal', value: '-' } },
      right: buildJoinFieldExpr(fields[i], inputId, labelToInputId),
    }
  }
  return result
}

function buildJoinFieldExpr(
  jf:             JoinFieldExpr,
  inputId:        string,
  labelToInputId: Map<string, string>,
): ExprNode {
  if (jf.fn === 'free' && jf.arg1) {
    // Espressione libera — parsala come stringa
    return parseJoinTransformExpr(jf.arg1, inputId, labelToInputId)
  }

  const baseExpr: ExprNode = { kind: 'DirectFieldRef', field: jf.field }

  switch (jf.fn) {
    case 'none':   return baseExpr
    case 'trim':   return { kind: 'FunctionCall', name: 'trim',  args: [baseExpr] }
    case 'lower':  return { kind: 'FunctionCall', name: 'lower', args: [baseExpr] }
    case 'upper':  return { kind: 'FunctionCall', name: 'upper', args: [baseExpr] }
    case 'year':   return { kind: 'FunctionCall', name: 'year',  args: [baseExpr] }
    case 'month':  return { kind: 'FunctionCall', name: 'month', args: [baseExpr] }
    case 'day':    return { kind: 'FunctionCall', name: 'day',   args: [baseExpr] }
    case 'date':   return { kind: 'FunctionCall', name: 'substring', args: [baseExpr, { kind: 'Literal', value: 0 }, { kind: 'Literal', value: 10 }] }
    case 'substr': return { kind: 'FunctionCall', name: 'substring', args: [
      baseExpr,
      { kind: 'Literal', value: parseInt(jf.arg1 || '0') },
      { kind: 'Literal', value: parseInt(jf.arg2 || '8') },
    ]}
    case 'regex':  return { kind: 'FunctionCall', name: 'regex_match', args: [baseExpr, { kind: 'Literal', value: jf.arg1 || '(.+)' }] }
    default:       return baseExpr
  }
}

function parseJoinTransformExpr(
  expr:           string,
  inputId:        string,
  labelToInputId: Map<string, string>,
): ExprNode {
  // Trasforma "row.campo" → DirectFieldRef
  const rowMatch = expr.match(/^row\.(\w+)$/)
  if (rowMatch) return { kind: 'DirectFieldRef', field: rowMatch[1] }
  // Trasforma "$label.campo" → FieldRef
  const dollarMatch = expr.match(/^\$(\w+)\.(\w+)$/)
  if (dollarMatch) {
    const id = labelToInputId.get(dollarMatch[1])
    if (id) return { kind: 'FieldRef', input: id, field: dollarMatch[2] }
  }
  // Fallback: literal stringa (espressione non parsabile)
  return { kind: 'Literal', value: expr }
}

// ─── Transforms ───────────────────────────────────────────────────

function buildTransforms(
  tmap:           TMapConfig,
  labelToInputId: Map<string, string>,
  inputFields:    Map<string, Map<string, string>>,
): TMapTransformPlan[] {
  return (tmap.transforms ?? []).map(tr => ({
    id:          tr.id,
    output_name: tr.outputName,
    output_type: tr.outputType,
    expr:        parseTransformExpression(tr.expression, labelToInputId, inputFields),
  }))
}

// ─── Output ───────────────────────────────────────────────────────

function buildOutputs(
  tmap:                  TMapConfig,
  labelToInputId:        Map<string, string>,
  inputFields:           Map<string, Map<string, string>>,
  transformByOutputName: Map<string, { id: string; outputType: string }>,
): TMapOutputPlan[] {
  return tmap.outputs.map(out => {
    const filterExpr = out.filter?.trim()
      ? parseExpressionString(out.filter, labelToInputId, inputFields)
      : null

    const fields: TMapOutputFieldPlan[] = out.fields.map(f => {
      const expr = parseOutputFieldExpression(f, tmap, labelToInputId, inputFields, transformByOutputName)
      const inferredType = inferExprType(expr, tmap, inputFields, transformByOutputName)
      return {
        name: f.name,
        // Usa il tipo inferito se disponibile, altrimenti quello manuale
        type: inferredType ?? f.type ?? 'string',
        expr,
      }
    })

    return {
      output_id:   out.id,
      label:       out.label,
      filter_expr: filterExpr,
      fields,
    }
  })
}

// ─── Parser expression string → ExprNode ─────────────────────────
//
// Gestisce i formati che vediamo nel JSON reale:
//   "main.film_id"         → FieldRef { input: mainInputId, field: "film_id" }
//   "DBCategory.name"      → FieldRef { input: lookupInputId, field: "name" }
//   "first_name"           → DirectFieldRef { field: "first_name" } (da transform)
//   "counter"              → DirectFieldRef { field: "counter" }
//   "$DBActor.first_name"  → FieldRef con $ prefix

function parseOutputFieldExpression(
  field:                 TMapOutputField & { sourceInputId?: string; sourceFieldName?: string },
  tmap:                  TMapConfig,
  labelToInputId:        Map<string, string>,
  inputFields:           Map<string, Map<string, string>>,
  transformByOutputName: Map<string, { id: string; outputType: string }>,
): ExprNode {
  const expr = field.expression?.trim() ?? ''

  if (!expr) return { kind: 'Literal', value: null }

 // Caso 1: "label.campo" — il label può contenere spazi, quindi invece
  // di una regex rigida (\w+) cerchiamo il nome sorgente noto prendendo
  // tutto ciò che precede l'ULTIMO punto, e verificando che sia un input
  // conosciuto in labelToInputId.
  if (expr.includes('.')) {
    const lastDot = expr.lastIndexOf('.')
    const label = expr.slice(0, lastDot)
    const fieldName = expr.slice(lastDot + 1)
    const inputId = labelToInputId.get(label)
    if (inputId && /^\w+$/.test(fieldName)) {
      return { kind: 'FieldRef', input: inputId, field: fieldName }
    }
  }

  // Caso 2: "$label.campo" (dalle transforms)
  const dollarMatch = expr.match(/^\$(\w+)\.(\w+)$/)
  if (dollarMatch) {
    const inputId = labelToInputId.get(dollarMatch[1])
    if (inputId) return { kind: 'FieldRef', input: inputId, field: dollarMatch[2] }
  }

  // Caso 3: nome semplice senza punto — potrebbe essere
  //   a) outputName di una transform ("first_name", "counter")
  //   b) un campo di un lookup (se sourceFieldName è impostato)
  if (/^\w+$/.test(expr)) {
    // È il nome di una transform?
    if (transformByOutputName.has(expr)) {
      // Referenza a una transform — DirectFieldRef che Rust risolverà
      // cercando nel contesto delle transform già calcolate
      return { kind: 'DirectFieldRef', field: expr }
    }
    // È un campo con sourceInputId esplicito?
    if (field.sourceInputId) {
      const inp = tmap.inputs.find(i => i.id === field.sourceInputId)
      if (inp) {
        return { kind: 'FieldRef', input: field.sourceInputId, field: field.sourceFieldName ?? expr }
      }
    }
    // Fallback: DirectFieldRef (Rust cercherà in tutti gli input disponibili)
    return { kind: 'DirectFieldRef', field: expr }
  }

  // Caso 4: espressione complessa — usa il parser generico
  return parseExpressionString(expr, labelToInputId, inputFields)
}

// ─── Parser per transform expressions ────────────────────────────
// Gestisce: "$DBActor.first_name + \"-\" + $DBActor.last_name"
//           "lane.counter++"
//           espressioni più complesse

function parseTransformExpression(
  expr:           string,
  labelToInputId: Map<string, string>,
  inputFields:    Map<string, Map<string, string>>,
): ExprNode {
  if (!expr?.trim()) return { kind: 'Literal', value: null }

  // "lane.variabile++" → variabile di lane
  const laneMatch = expr.match(/^lane\.(\w+)\+\+$/)
  if (laneMatch) {
    return { kind: 'DirectFieldRef', field: `lane.${laneMatch[1]}` }
  }

  // Tokenizza l'espressione in parti: $label.campo, "stringa", operatori
  // Esempio: '$DBActor.first_name +"-"+ $DBActor.last_name'
  // → [FieldRef(DBActor,first_name), Literal("-"), FieldRef(DBActor,last_name)]
  const tokens = tokenizeExpr(expr, labelToInputId)
  if (tokens.length === 0) return { kind: 'Literal', value: null }
  if (tokens.length === 1) return tokens[0]

  // Costruisce un albero di BinaryOp da sinistra a destra
  // per tutti i token separati da operatori
  return buildBinaryTree(tokens)
}

function tokenizeExpr(
  expr:           string,
  labelToInputId: Map<string, string>,
): ExprNode[] {
  const nodes: ExprNode[] = []
  let remaining = expr.trim()

  while (remaining.length > 0) {
    remaining = remaining.trimStart()
    if (!remaining) break

    // Stringa quoted "..." o '...'
    if (remaining[0] === '"' || remaining[0] === "'") {
      const q   = remaining[0]
      let i     = 1
      let value = ''
      while (i < remaining.length && remaining[i] !== q) {
        if (remaining[i] === '\\') { i++; value += remaining[i] ?? '' }
        else value += remaining[i]
        i++
      }
      nodes.push({ kind: 'Literal', value })
      remaining = remaining.slice(i + 1)
      continue
    }

    // $label.campo
    const dollarMatch = remaining.match(/^\$(\w+)\.(\w+)/)
    if (dollarMatch) {
      const inputId = labelToInputId.get(dollarMatch[1])
      if (inputId) {
        nodes.push({ kind: 'FieldRef', input: inputId, field: dollarMatch[2] })
      } else {
        nodes.push({ kind: 'DirectFieldRef', field: dollarMatch[2] })
      }
      remaining = remaining.slice(dollarMatch[0].length)
      continue
    }

    // Operatore + - * /
    const opMatch = remaining.match(/^(\s*[+\-*\/]\s*)/)
    if (opMatch) {
      remaining = remaining.slice(opMatch[0].length)
      continue  // gli operatori vengono ignorati — usiamo ADD come default
    }

    // Numero
    const numMatch = remaining.match(/^(\d+\.?\d*)/)
    if (numMatch) {
      nodes.push({ kind: 'Literal', value: parseFloat(numMatch[1]) })
      remaining = remaining.slice(numMatch[0].length)
      continue
    }

    // Identifier semplice (campo diretto)
    const identMatch = remaining.match(/^(\w+)/)
    if (identMatch) {
      nodes.push({ kind: 'DirectFieldRef', field: identMatch[1] })
      remaining = remaining.slice(identMatch[0].length)
      continue
    }

    // Carattere non riconosciuto — salta
    remaining = remaining.slice(1)
  }

  return nodes
}

function buildBinaryTree(nodes: ExprNode[]): ExprNode {
  if (nodes.length === 1) return nodes[0]
  // Concatenazione/somma da sinistra a destra con ADD
  let result = nodes[0]
  for (let i = 1; i < nodes.length; i++) {
    result = { kind: 'BinaryOp', op: 'ADD', left: result, right: nodes[i] }
  }
  return result
}

// ─── Parser generico per espressioni JavaScript-like ─────────────
// Tokenizer minimale che gestisce i pattern comuni del TMap.
// Non è un parser JS completo — copre i casi reali che vediamo.

// Sostituisci la funzione parseExpressionString con questa versione

function parseExpressionString(
  expr:           string,
  labelToInputId: Map<string, string>,
  _inputFields:   Map<string, Map<string, string>>,
  ): ExprNode {
    return parseExpression(expr, { labelToInputId })
}
/*
// ← FIX: restituisce oggetto o null invece di tuple
function splitByOperator(
  expr: string,
): { left: string; op: string; right: string } | null {
  const ops = [' + ', ' - ', ' * ', ' / ', ' == ', ' != ', ' >= ', ' <= ', ' > ', ' < ', ' && ', ' || ']
  for (const op of ops) {
    const idx = findOperatorOutsideQuotes(expr, op)
    if (idx !== -1) {
      return {
        left:  expr.slice(0, idx),
        op:    op.trim(),
        right: expr.slice(idx + op.length),
      }
    }
  }
  return null
}
*/
/*
// E sostituisci anche findOperatorOutsideQuotes con questa versione
// che gestisce correttamente sia ' che ":
function findOperatorOutsideQuotes(s: string, op: string): number {
  let inStr  = false
  let strChar = ''
  let i = 0

  while (i < s.length) {
    const c = s[i]

    // Inizio/fine stringa
    if (!inStr && (c === '"' || c === "'")) {
      inStr = true
      strChar = c
      i++
      continue
    }
    if (inStr && c === '\\') {
      // Escape — salta il carattere successivo
      i += 2
      continue
    }
    if (inStr && c === strChar) {
      inStr = false
      i++
      continue
    }

    // Se non siamo in una stringa, cerca l'operatore
    if (!inStr && s.slice(i, i + op.length) === op) {
      return i
    }
    i++
  }
  return -1
}
*/
/*
function jsOpToRustOp(op: string): string {
  const MAP: Record<string, string> = {
    '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV',
    '==': 'EQ', '!=': 'NE', '>': 'GT', '<': 'LT', '>=': 'GTE', '<=': 'LTE',
    '&&': 'AND', '||': 'OR',
  }
  return MAP[op] ?? 'CONCAT'
}
*/
// ─── Inferenza dei tipi ───────────────────────────────────────────
// Risolve il problema di propagazione: il tipo del campo output
// non è più impostato a mano ma derivato dall'espressione.

function inferExprType(
  expr:                  ExprNode,
  tmap:                  TMapConfig,
  inputFields:           Map<string, Map<string, string>>,
  transformByOutputName: Map<string, { id: string; outputType: string }>,
): string | null {
  switch (expr.kind) {
    case 'Literal': {
      if (expr.value === null) return null
      if (typeof expr.value === 'boolean') return 'boolean'
      if (typeof expr.value === 'number')  return Number.isInteger(expr.value) ? 'integer' : 'decimal'
      return 'string'
    }
    case 'FieldRef': {
      const fields = inputFields.get(expr.input)
      return fields?.get(expr.field) ?? null
    }
    case 'DirectFieldRef': {
      // Cerca in tutti gli input
      for (const [, fields] of inputFields) {
        const t = fields.get(expr.field)
        if (t) return t
      }
      // Cerca nelle transforms
      const tr = transformByOutputName.get(expr.field)
      if (tr) return tr.outputType
      return null
    }
    case 'BinaryOp': {
      const leftType  = inferExprType(expr.left,  tmap, inputFields, transformByOutputName)
      const rightType = inferExprType(expr.right, tmap, inputFields, transformByOutputName)
      // Stringa + qualsiasi → stringa
      if (leftType === 'string' || rightType === 'string') return 'string'
      // Numerici → tipo del lato sinistro
      if (leftType === 'decimal' || rightType === 'decimal') return 'decimal'
      if (leftType === 'integer' && rightType === 'integer') return 'integer'
      // Operatori booleani → boolean
      if (['EQ', 'NE', 'GT', 'GTE', 'LT', 'LTE', 'AND', 'OR'].includes(expr.op)) return 'boolean'
      return leftType
    }
    case 'FunctionCall': {
      const funcTypes: Record<string, string> = {
        trim: 'string', upper: 'string', lower: 'string', concat: 'string',
        length: 'integer', year: 'integer', month: 'integer', day: 'integer',
        round: 'decimal', abs: 'decimal', ceil: 'integer', floor: 'integer',
        to_string: 'string', to_int: 'integer', to_float: 'decimal', to_bool: 'boolean',
      }
      return funcTypes[expr.name.toLowerCase()] ?? null
    }
    case 'Cast':       return expr.target_type
    case 'IsNull':     return 'boolean'
    case 'IsNotNull':  return 'boolean'
    default:           return null
  }
}
