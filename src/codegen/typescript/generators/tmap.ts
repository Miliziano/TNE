/**
 * src/codegen/typescript/generators/tmap.ts
 *
 * Generatore TypeScript dedicato al nodo TMap.
 * Sostituisce la gestione TMap dentro branchGenerator.
 *
 * Struttura del codice generato:
 *
 *   Phase 1 — Pre-materialization:
 *     Tutti gli input non-main vengono caricati in hash map
 *     in ordine topologico (lookup che dipendono da altri lookup
 *     vengono caricati dopo quelli da cui dipendono).
 *     Column pruning: ogni hash map carica solo le colonne
 *     referenziate nelle espressioni, join e output.
 *
 *   Phase 2 — Main loop:
 *     Per ogni riga del main:
 *     - Lookup O(1) nelle hash map
 *     - Applicazione trasformazioni
 *     - Routing agli output in base ai filtri
 *     - Column pruning: costruisce record parziali con
 *       solo le colonne necessarie per ogni output
 */

import type { LogicalNode } from '../../../ir/types'
import type { CodegenContext } from '../index'
import type { NodeGenerator } from './types'
import type { TMapConfig, TMapInput, TMapOutput, TMapOutputField } from '../../../types'
import type { JoinPair } from '../../../nodes/types/tmap/TMapModal'
import { canvasNodeId } from '../../../ir/lowering'
import {
  analyzeTMapColumnUsage,
  getColumnsToLoad,
  formatPruningComment,
  WILDCARD,
  type ColumnUsageResult,
} from '../../../ir/analyzeTMapColumnUsage'

// ─────────────────────────────────────────────────────────────────

export const tmapGenerator: NodeGenerator = {
  operation: 'branch',  // TMap viene abbassato a 'branch' nel lowering

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName = ctx.nodeVarMap.get(node.id)!
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)
    const config  = (node._uiRef?.config ?? {}) as any
    const tmap    = config?.tmap as TMapConfig | undefined

    // Fallback al branchGenerator originale se non è un TMap completo
    if (!tmap?.inputs?.length || !tmap?.outputs?.length) {
      return generateSimpleBranch(node, varName, label, tmap)
    }

    // Recupera il column usage calcolato in pipeline.ts (o ricalcola)
    const columnUsage: ColumnUsageResult = (node as any).columnUsage
      ?? analyzeTMapColumnUsage(tmap)

    const mainInput   = tmap.inputs.find((i) => i.isMain)
    const lookupInputs = tmap.inputs.filter((i) => !i.isMain)

    if (!mainInput) {
      ctx.warnings.push(`TMap ${canvasNodeId(node.id)}: nessun input main trovato`)
      return generateSimpleBranch(node, varName, label, tmap)
    }

    const lines: string[] = []

    // ── Header ───────────────────────────────────────────────────
    lines.push(`/**`)
    lines.push(` * TMap: ${label}`)
    lines.push(` * Input main: ${mainInput.label}`)
    if (lookupInputs.length > 0) {
      lines.push(` * Lookup: ${lookupInputs.map(i => i.label).join(', ')}`)
    }
    lines.push(` * Output: ${tmap.outputs.map(o => o.label).join(', ')}`)
    lines.push(` *`)
    lines.push(` * Ottimizzazioni attive:`)
    lines.push(` *   - Pre-materialization lookup (caricati prima del main)`)
    if (lookupInputs.length > 0) {
      lines.push(` *   - Ordine topologico lookup: ${columnUsage.lookupLoadOrder.join(' → ')}`)
    }
    // Mostra stats pruning per ogni input
    for (const inp of tmap.inputs) {
      const s = columnUsage.stats[inp.id]
      if (s && s.pruned > 0) {
        lines.push(` *   - Column pruning ${inp.label}: ${s.used}/${s.total} colonne`)
      }
    }
    lines.push(` */`)
    lines.push(``)

    // ── Interfacce result ─────────────────────────────────────────
    lines.push(`export type Row = Record<string, unknown>`)
    lines.push(``)
    lines.push(`export interface ${varName}Result {`)
    for (const out of tmap.outputs) {
      lines.push(`  ${sanitize(out.label)}: Row[]`)
    }
    lines.push(`  rowsProcessed: number`)
    lines.push(`  rowsRejected:  number`)
    lines.push(`}`)
    lines.push(``)

    // ── Funzione principale ───────────────────────────────────────
    lines.push(`export async function run(`)
    lines.push(`  ${sanitize(mainInput.label)}Rows: Row[],`)
    for (const inp of lookupInputs) {
      lines.push(`  ${sanitize(inp.label)}Rows: Row[],`)
    }
    lines.push(`): Promise<${varName}Result> {`)
    lines.push(``)

    // ── Phase 1: Pre-materialization dei lookup ───────────────────
    if (lookupInputs.length > 0) {
      lines.push(`  // ═══ Phase 1: Pre-materialization lookup ═══`)
      lines.push(`  // I lookup vengono caricati in hash map PRIMA che il main inizi.`)
      lines.push(`  // Questo permette lookup O(1) per ogni riga del main.`)
      lines.push(`  // Ordine: ${columnUsage.lookupLoadOrder.join(' → ')}`)
      lines.push(``)

      // Carica in ordine topologico
      for (const lookupId of columnUsage.lookupLoadOrder) {
        const inp = tmap.inputs.find(i => i.id === lookupId)
        if (!inp) continue

        const cols = getColumnsToLoad(columnUsage, inp.id)
        const comment = formatPruningComment(columnUsage, inp.id, inp.label)
        if (comment) lines.push(`  ${comment}`)

        const joinKey = getJoinKey(inp, tmap)
        const mapName = `__map_${sanitize(inp.label)}`

        lines.push(`  const ${mapName} = new Map<unknown, Row[]>()`)
        lines.push(`  for (const row of ${sanitize(inp.label)}Rows) {`)

        // Column pruning: costruisce oggetto parziale se non wildcard
        if (cols && !cols.includes(WILDCARD)) {
          const colSet = JSON.stringify(cols)
          lines.push(`    // Column pruning: solo le colonne necessarie`)
          lines.push(`    const pruned = Object.fromEntries(`)
          lines.push(`      ${colSet}.map((k: string) => [k, row[k]])`)
          lines.push(`    )`)
          lines.push(`    const key = pruned[${JSON.stringify(joinKey)}]`)
          lines.push(`    const existing = ${mapName}.get(key) ?? []`)
          lines.push(`    existing.push(pruned)`)
        } else {
          lines.push(`    const key = row[${JSON.stringify(joinKey)}]`)
          lines.push(`    const existing = ${mapName}.get(key) ?? []`)
          lines.push(`    existing.push(row)`)
        }

        lines.push(`    ${mapName}.set(key, existing)`)
        lines.push(`  }`)
        lines.push(``)
      }
    }

    // ── Phase 2: Main loop ────────────────────────────────────────
    lines.push(`  // ═══ Phase 2: Streaming main + lookup O(1) ═══`)
    lines.push(`  const result: ${varName}Result = {`)
    for (const out of tmap.outputs) {
      lines.push(`    ${sanitize(out.label)}: [],`)
    }
    lines.push(`    rowsProcessed: 0,`)
    lines.push(`    rowsRejected:  0,`)
    lines.push(`  }`)
    lines.push(``)

    // Column pruning sul main
    const mainCols = getColumnsToLoad(columnUsage, mainInput.id)
    const mainComment = formatPruningComment(columnUsage, mainInput.id, mainInput.label)

    lines.push(`  for (const __rawMain of ${sanitize(mainInput.label)}Rows) {`)

    if (mainCols && !mainCols.includes(WILDCARD) && mainCols.length > 0) {
      if (mainComment) lines.push(`    ${mainComment}`)
      const colSet = JSON.stringify(mainCols)
      lines.push(`    const ${sanitize(mainInput.label)} = Object.fromEntries(`)
      lines.push(`      ${colSet}.map((k: string) => [k, __rawMain[k]])`)
      lines.push(`    )`)
    } else {
      lines.push(`    const ${sanitize(mainInput.label)} = __rawMain`)
    }
    lines.push(``)

    // Lookup nelle hash map per ogni input secondario
    for (const inp of lookupInputs) {
      const joinKey  = getJoinKey(inp, tmap)
      const mapName  = `__map_${sanitize(inp.label)}`
      const joinType = inp.joinType ?? 'left'

      // Costruisce l'espressione per la chiave di join lato main
      const mainKeyExpr = getMainKeyExpr(inp, tmap, sanitize(mainInput.label))

      lines.push(`    // Lookup ${inp.label} (${joinType} join)`)
      lines.push(`    const __${sanitize(inp.label)}_matches = ${mapName}.get(${mainKeyExpr}) ?? []`)

      // Per inner join: salta se nessun match
      if (joinType === 'inner') {
        lines.push(`    if (__${sanitize(inp.label)}_matches.length === 0) {`)
        lines.push(`      result.rowsRejected++`)
        lines.push(`      continue`)
        lines.push(`    }`)
      }
      // Per 'first': usa solo il primo match
      if (joinType === 'first') {
        lines.push(`    const ${sanitize(inp.label)} = __${sanitize(inp.label)}_matches[0] ?? null`)
      }
      lines.push(``)
    }

    // Per join 'left' o senza lookup: genera il corpo diretto
    const hasMultiMatchLookup = lookupInputs.some(i => (i.joinType ?? 'left') === 'left' || !i.joinType)

    if (lookupInputs.length === 0 || !hasMultiMatchLookup) {
      // Caso semplice: nessun lookup o tutti 'first'/'inner'
      lines.push(`    // Applica mapping e routing agli output`)
      lines.push(`    let __matched = false`)
      lines.push(`    try {`)
      lines.push(generateOutputRouting(tmap, mainInput, lookupInputs, '      '))
      lines.push(`      if (!__matched) result.rowsRejected++`)
      lines.push(`      else result.rowsProcessed++`)
      lines.push(`    } catch (err) {`)
      lines.push(`      result.rowsRejected++`)
      lines.push(`      console.error('[${label}] Errore elaborazione riga:', err)`)
      lines.push(`    }`)
    } else {
      // Caso con lookup multi-match: itera le combinazioni
      const leftLookups = lookupInputs.filter(i => (i.joinType ?? 'left') === 'left')
      lines.push(`    // Itera le combinazioni con i lookup left`)

      // Genera loop annidati per i lookup left
      let indent = '    '
      for (const inp of leftLookups) {
        lines.push(`${indent}const __${sanitize(inp.label)}_list = __${sanitize(inp.label)}_matches.length > 0`)
        lines.push(`${indent}  ? __${sanitize(inp.label)}_matches`)
        lines.push(`${indent}  : [null]  // left join: emetti anche senza match`)
        lines.push(`${indent}for (const ${sanitize(inp.label)} of __${sanitize(inp.label)}_list) {`)
        indent += '  '
      }

      lines.push(`${indent}let __matched = false`)
      lines.push(`${indent}try {`)
      lines.push(generateOutputRouting(tmap, mainInput, lookupInputs, indent + '  '))
      lines.push(`${indent}  if (!__matched) result.rowsRejected++`)
      lines.push(`${indent}  else result.rowsProcessed++`)
      lines.push(`${indent}} catch (err) {`)
      lines.push(`${indent}  result.rowsRejected++`)
      lines.push(`${indent}  console.error('[${label}] Errore elaborazione riga:', err)`)
      lines.push(`${indent}}`)

      // Chiudi loop annidati
      for (const _ of leftLookups) {
        indent = indent.slice(2)
        lines.push(`${indent}}`)
      }
    }

    lines.push(`  }`)  // fine main loop
    lines.push(``)
    lines.push(`  return result`)
    lines.push(`}`)
    lines.push(``)

    // ── Funzioni di proiezione per ogni output ────────────────────
    lines.push(generateProjectionFunctions(tmap, varName))

    // ── Funzioni di valutazione espressioni ──────────────────────
    lines.push(generateExprEvaluators(tmap))

    return lines.join('\n')
  },
}

// ─── Generatori di sezioni ────────────────────────────────────────

/**
 * Genera il blocco di routing agli output:
 * - Valuta il filtro di ogni output
 * - Se passa, proietta i campi e aggiunge all'output
 * - Il primo output che matcha (o quello senza filtro) prende la riga
 */
function generateOutputRouting(
  tmap:         TMapConfig,
  mainInput:    TMapInput,
  lookupInputs: TMapInput[],
  indent:       string,
): string {
  const lines: string[] = []
  const outputs = tmap.outputs

  for (let i = 0; i < outputs.length; i++) {
    const out    = outputs[i]
    const isLast = i === outputs.length - 1
    const outVar = sanitize(out.label)

    // Genera condizione filtro
    const filterExpr = out.filter
      ? translateExpression(out.filter, mainInput, lookupInputs)
      : 'true'

    if (i === 0) {
      lines.push(`${indent}if (${filterExpr}) {`)
    } else if (isLast && !out.filter) {
      // Ultimo output senza filtro = rejected
      lines.push(`${indent}} else {`)
    } else {
      lines.push(`${indent}} else if (${filterExpr}) {`)
    }

    lines.push(`${indent}  result.${outVar}.push(project_${outVar}(${getProjectionArgs(mainInput, lookupInputs)}))`)
    lines.push(`${indent}  __matched = true`)
  }

  lines.push(`${indent}}`)
  return lines.join('\n')
}

/**
 * Genera le funzioni di proiezione per ogni output.
 * Ogni funzione riceve il contesto completo (main + lookup)
 * e restituisce il record con i campi dell'output.
 */
function generateProjectionFunctions(tmap: TMapConfig, varName: string): string {
  const lines: string[] = []
  const mainInput    = tmap.inputs.find(i => i.isMain)!
  const lookupInputs = tmap.inputs.filter(i => !i.isMain)

  for (const out of tmap.outputs) {
    const outVar = sanitize(out.label)
    const args   = getProjectionArgs(mainInput, lookupInputs)
    const argDefs = [
      `${sanitize(mainInput.label)}: Row`,
      ...lookupInputs.map(i => `${sanitize(i.label)}: Row | null`),
    ].join(', ')

    lines.push(`function project_${outVar}(${argDefs}): Row {`)
    lines.push(`  return {`)

    for (const field of out.fields) {
      if (!field.name) continue
      const expr = field.expression
        ? translateExpression(field.expression, mainInput, lookupInputs)
        : `${sanitize(mainInput.label)}[${JSON.stringify(field.name)}]`
      lines.push(`    ${JSON.stringify(field.name)}: ${expr},`)
    }

    lines.push(`  }`)
    lines.push(`}`)
    lines.push(``)
  }

  return lines.join('\n')
}

/**
 * Genera funzioni helper per la valutazione di espressioni complesse.
 * Le trasformazioni della zona centrale vengono materializzate qui.
 */
function generateExprEvaluators(tmap: TMapConfig): string {
  if (!tmap.transforms?.length) return ''

  const lines: string[] = []
  lines.push(`// ── Trasformazioni ───────────────────────────────────────────`)

  for (const tr of tmap.transforms) {
    const fnName = `transform_${sanitize(tr.outputName || tr.id)}`
    const mainInput    = tmap.inputs.find(i => i.isMain)!
    const lookupInputs = tmap.inputs.filter(i => !i.isMain)

    const argDefs = [
      `${sanitize(mainInput.label)}: Row`,
      ...lookupInputs.map(i => `${sanitize(i.label)}: Row | null`),
    ].join(', ')

    lines.push(`function ${fnName}(${argDefs}): unknown {`)

    if (tr.expression) {
      const expr = translateExpression(tr.expression, mainInput, lookupInputs)
      lines.push(`  return ${expr}`)
    } else {
      lines.push(`  return null // TODO: espressione non configurata`)
    }

    lines.push(`}`)
    lines.push(``)
  }

  return lines.join('\n')
}

// ─── Traduzione espressioni ───────────────────────────────────────

/**
 * Traduce un'espressione TMap in codice TypeScript eseguibile.
 *
 * Sostituisce:
 *   main.campo         → main['campo']
 *   $main.campo        → main['campo']
 *   lookup.campo       → lookup?.['campo']
 *   $lookup.campo      → lookup?.['campo']
 *   transformName      → transform_transformName(main, lookup, ...)
 */
function translateExpression(
  expression:   string,
  mainInput:    TMapInput,
  lookupInputs: TMapInput[],
): string {
  let result = expression

  // $label.campo → label['campo'] o label?.['campo']
  for (const inp of [...[mainInput], ...lookupInputs]) {
    const label     = inp.label
    const varName   = sanitize(label)
    const isLookup  = !inp.isMain
    const accessor  = isLookup ? `?.` : `.`

    // $label.campo
    result = result.replace(
      new RegExp(`\\$${escapeRegex(label)}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, 'g'),
      (_, field) => `${varName}${accessor}[${JSON.stringify(field)}]`
    )

    // label.campo (senza $)
    result = result.replace(
      new RegExp(`\\b${escapeRegex(label)}\\.([a-zA-Z_][a-zA-Z0-9_]*)`, 'g'),
      (_, field) => `${varName}${accessor}[${JSON.stringify(field)}]`
    )
  }

  // row.campo → main['campo'] (espressioni nei JOIN_TRANSFORMS)
  result = result.replace(
    /\brow\.([a-zA-Z_][a-zA-Z0-9_]*)/g,
    (_, field) => `${sanitize(mainInput.label)}[${JSON.stringify(field)}]`
  )

  return result
}

// ─── Helpers join ─────────────────────────────────────────────────

/**
 * Restituisce il nome del campo chiave per un lookup.
 * Prende la prima chiave dalle joinPairs se disponibili,
 * altrimenti usa 'id' come fallback.
 */
function getJoinKey(inp: TMapInput, tmap: TMapConfig): string {
  const pairs: JoinPair[] = (inp as any).joinPairs ?? []
  if (pairs.length > 0) {
    const firstPair  = pairs[0]
    const firstDst   = firstPair.dstFields?.[0]
    if (firstDst?.field) return firstDst.field
  }
  return 'id'
}

/**
 * Restituisce l'espressione per la chiave lato main
 * da usare nel lookup della hash map.
 */
function getMainKeyExpr(
  inp:       TMapInput,
  tmap:      TMapConfig,
  mainVar:   string,
): string {
  const pairs: JoinPair[] = (inp as any).joinPairs ?? []
  if (pairs.length === 0) return `${mainVar}['id']`

  const firstPair = pairs[0]
  const srcInp    = tmap.inputs.find(i => i.id === firstPair.srcInputId)

  if (!srcInp) return `${mainVar}['id']`

  const firstSrc = firstPair.srcFields?.[0]
  if (!firstSrc?.field) return `${mainVar}['id']`

  const srcVar = sanitize(srcInp.label)

  // Applica la trasformazione se presente
  if (firstSrc.fn && firstSrc.fn !== 'none') {
    return applyJoinTransform(firstSrc.fn, firstSrc.arg1 ?? '', `${srcVar}['${firstSrc.field}']`)
  }

  return `${srcVar}[${JSON.stringify(firstSrc.field)}]`
}

/**
 * Applica una trasformazione JOIN_TRANSFORMS a un'espressione.
 */
function applyJoinTransform(fn: string, arg1: string, expr: string): string {
  switch (fn) {
    case 'trim':   return `String(${expr} ?? '').trim()`
    case 'lower':  return `String(${expr} ?? '').toLowerCase()`
    case 'upper':  return `String(${expr} ?? '').toUpperCase()`
    case 'year':   return `new Date(${expr}).getFullYear()`
    case 'month':  return `new Date(${expr}).getMonth() + 1`
    case 'day':    return `new Date(${expr}).getDate()`
    case 'date':   return `String(${expr} ?? '').split('T')[0]`
    case 'substr': return `String(${expr} ?? '').substring(${arg1 || '0, 8'})`
    case 'regex':  return `(String(${expr} ?? '').match(/${arg1 || '(.+)'}/)?.[1] ?? '')`
    case 'free':   return arg1 || expr
    default:       return expr
  }
}

/** Argomenti da passare alle funzioni di proiezione */
function getProjectionArgs(mainInput: TMapInput, lookupInputs: TMapInput[]): string {
  return [sanitize(mainInput.label), ...lookupInputs.map(i => sanitize(i.label))].join(', ')
}

// ─── Fallback per TMap semplici ───────────────────────────────────

/**
 * Generatore semplificato per TMap senza configurazione completa.
 * Equivalente al vecchio branchGenerator.
 */
function generateSimpleBranch(
  node:    LogicalNode,
  varName: string,
  label:   string,
  tmap:    TMapConfig | undefined,
): string {
  const outputs: any[] = (tmap?.outputs ?? []).filter((o: any) => !o.id?.includes('rejected'))

  const resultFields = outputs.map(o => `  ${sanitize(o.label)}: Row[]`).join('\n')
  const resultInit   = outputs.map(o => `    ${sanitize(o.label)}: [],`).join('\n')

  const branchBlocks = outputs.map((o, i) => {
    const condition = o.filter
      ? o.filter.replace(/\b(\w+)\b(?!\s*\()/g, (m: string) =>
          ['true','false','null'].includes(m) ? m : `row[${JSON.stringify(m)}]`)
      : 'true'
    const prefix = i === 0 ? 'if' : 'else if'
    return [
      `    ${prefix} (${condition}) {`,
      `      result.${sanitize(o.label)}.push({ ...row })`,
      `      matched = true`,
      `    }`,
    ].join('\n')
  }).join('\n')

  return [
    `/** TMap (branch): ${label} */`,
    ``,
    `export type Row = Record<string, unknown>`,
    ``,
    `export interface ${varName}Result {`,
    resultFields,
    `  rejected:      Row[]`,
    `  rowsProcessed: number`,
    `  rowsRejected:  number`,
    `}`,
    ``,
    `export async function run(inputRows: Row[]): Promise<${varName}Result> {`,
    `  const result: ${varName}Result = {`,
    resultInit,
    `    rejected: [], rowsProcessed: 0, rowsRejected: 0,`,
    `  }`,
    `  for (const row of inputRows) {`,
    `    let matched = false`,
    branchBlocks,
    `    if (!matched) { result.rejected.push(row); result.rowsRejected++ }`,
    `    else { result.rowsProcessed++ }`,
    `  }`,
    `  return result`,
    `}`,
  ].join('\n')
}

// ─── Utils ────────────────────────────────────────────────────────

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9]/g, '_').replace(/^(\d)/, '_$1')
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}