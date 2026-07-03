/**
 * src/codegen/typescript/generators/remaining.ts
 */

import type { LogicalNode } from '../../../ir/types'
import type { CodegenContext } from '../index'
import type { NodeGenerator } from './index'
import { canvasNodeId } from '../../../ir/lowering'

// ─────────────────────────────────────────────────────────────────
// HELPER FUNCTIONS — definite prima di tutti i generatori
// ─────────────────────────────────────────────────────────────────

function generateAggrUpdate(fn: string, field: string): string {
  const f = JSON.stringify(field)
  switch (fn.toLowerCase()) {
    case 'count':
      return `    // count`
    case 'sum':
      return `    state.sums[${f}] = (state.sums[${f}] ?? 0) + (Number(row[${f}]) || 0)`
    case 'avg':
      return `    state.sums[${f}] = (state.sums[${f}] ?? 0) + (Number(row[${f}]) || 0)`
    case 'min':
      return `    if (state.mins[${f}] === undefined || Number(row[${f}]) < state.mins[${f}]) state.mins[${f}] = Number(row[${f}])`
    case 'max':
      return `    if (state.maxs[${f}] === undefined || Number(row[${f}]) > state.maxs[${f}]) state.maxs[${f}] = Number(row[${f}])`
    case 'first':
      return `    if (state.firsts[${f}] === undefined) state.firsts[${f}] = row[${f}]`
    case 'last':
      return `    state.lasts[${f}] = row[${f}]`
    case 'array_agg':
      return `    ;(state.arrays[${f}] = state.arrays[${f}] ?? []).push(row[${f}])`
    default:
      return `    // TODO: funzione '${fn}' non implementata`
  }
}

function generateAggrResult(fn: string, field: string): string {
  const f   = JSON.stringify(field)
  const key = JSON.stringify(`${fn}_${field}`)
  switch (fn.toLowerCase()) {
    case 'count':     return `      ${key}: state.count,`
    case 'sum':       return `      ${key}: state.sums[${f}] ?? 0,`
    case 'avg':       return `      ${key}: state.count > 0 ? (state.sums[${f}] ?? 0) / state.count : null,`
    case 'min':       return `      ${key}: state.mins[${f}] ?? null,`
    case 'max':       return `      ${key}: state.maxs[${f}] ?? null,`
    case 'first':     return `      ${key}: state.firsts[${f}] ?? null,`
    case 'last':      return `      ${key}: state.lasts[${f}] ?? null,`
    case 'array_agg': return `      ${key}: state.arrays[${f}] ?? [],`
    default:          return `      ${key}: null, // TODO: '${fn}' non implementata`
  }
}

function generateWindowFnBody(fn: string, outputField: string): string {
  const out = JSON.stringify(outputField)
  switch (fn.toLowerCase()) {
    case 'row_number':
      return `partition.forEach((row, i) => { row[${out}] = i + 1 })`
    case 'rank':
      return `let rank = 1
    partition.forEach((row, i) => {
      if (i > 0) {
        const prev = partition[i - 1]
        const sameValues = Object.keys(prev).every((k) => k === ${out} || prev[k] === row[k])
        if (!sameValues) rank = i + 1
      }
      row[${out}] = rank
    })`
    case 'lag':
      return `partition.forEach((row, i) => { row[${out}] = i > 0 ? partition[i - 1] : null })`
    case 'lead':
      return `partition.forEach((row, i) => { row[${out}] = i < partition.length - 1 ? partition[i + 1] : null })`
    case 'cumsum':
      return `let cum = 0
    partition.forEach((row) => { cum += Number(row['value'] ?? 0); row[${out}] = cum })`
    default:
      return `// TODO: window function '${fn}' non implementata
    partition.forEach((_row, _i) => { /* noop */ })`
  }
}

function sanitizeLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9]/g, '_')
}

// ─────────────────────────────────────────────────────────────────
// JOIN
// ─────────────────────────────────────────────────────────────────

export const joinGenerator: NodeGenerator = {
  operation: 'join',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName  = ctx.nodeVarMap.get(node.id)!
    const label    = node._uiRef?.label ?? canvasNodeId(node.id)
    const config   = (node._uiRef?.config ?? {}) as any
    const props    = config?.props ?? {}
    const joinType = props.join_type ?? 'inner'
    const key      = props.key       ?? 'id'
    const keyStr   = JSON.stringify(key)
    const jtStr    = JSON.stringify(joinType)

    return [
      `/** Join: ${label} | Tipo: ${joinType} | Chiave: ${key} */`,
      ``,
      `export type Row = Record<string, unknown>`,
      ``,
      `export interface ${varName}Result {`,
      `  rows:          Row[]`,
      `  rowsProcessed: number`,
      `  rowsRejected:  number`,
      `}`,
      ``,
      `export async function run(leftRows: Row[], rightRows: Row[]): Promise<${varName}Result> {`,
      `  const rightIndex = new Map<unknown, Row[]>()`,
      `  for (const row of rightRows) {`,
      `    const k = row[${keyStr}]`,
      `    const existing = rightIndex.get(k) ?? []`,
      `    existing.push(row)`,
      `    rightIndex.set(k, existing)`,
      `  }`,
      ``,
      `  const rows: Row[] = []`,
      `  const matched = new Set<unknown>()`,
      ``,
      `  for (const leftRow of leftRows) {`,
      `    const k     = leftRow[${keyStr}]`,
      `    const right = rightIndex.get(k)`,
      `    if (right?.length) {`,
      `      for (const rightRow of right) { rows.push({ ...leftRow, ...rightRow }) }`,
      `      matched.add(k)`,
      `    } else if (${jtStr} === 'left' || ${jtStr} === 'full') {`,
      `      rows.push({ ...leftRow })`,
      `    }`,
      `  }`,
      ``,
      `  if (${jtStr} === 'right' || ${jtStr} === 'full') {`,
      `    for (const rightRow of rightRows) {`,
      `      const k = rightRow[${keyStr}]`,
      `      if (!matched.has(k)) rows.push({ ...rightRow })`,
      `    }`,
      `  }`,
      ``,
      `  return { rows, rowsProcessed: rows.length, rowsRejected: 0 }`,
      `}`,
    ].join('\n')
  },
}

// ─────────────────────────────────────────────────────────────────
// AGGREGATE
// ─────────────────────────────────────────────────────────────────

export const aggregateGenerator: NodeGenerator = {
  operation: 'aggregate',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName  = ctx.nodeVarMap.get(node.id)!
    const label    = node._uiRef?.label ?? canvasNodeId(node.id)
    const config   = (node._uiRef?.config ?? {}) as any
    const props    = config?.props ?? {}
    const groupBy: string[] = (props.group_by ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const fnsRaw   = props.functions ?? '{}'

    let aggrFunctions: Record<string, string> = {}
    try { aggrFunctions = JSON.parse(fnsRaw) } catch { /* ignore */ }
    const aggrEntries = Object.entries(aggrFunctions)

    const groupKeyExpr = groupBy.length > 0
      ? `${JSON.stringify(groupBy)}.map((k) => String(row[k] ?? '')).join('|')`
      : `'__global__'`

    const keysExpr = groupBy.length > 0
      ? `Object.fromEntries(${JSON.stringify(groupBy)}.map((k) => [k, row[k]]))`
      : `{}`

    const updateLines = aggrEntries.map(([fn, field]) => generateAggrUpdate(fn, field)).join('\n')
    const resultLines = aggrEntries.map(([fn, field]) => generateAggrResult(fn, field)).join('\n')

    const fnSummary = aggrEntries.map(([fn, field]) => `${fn}(${field})`).join(', ')

    return [
      `/** Aggregazione: ${label} | Group by: ${groupBy.join(', ') || 'globale'} | ${fnSummary} */`,
      ``,
      `export type Row = Record<string, unknown>`,
      ``,
      `export interface ${varName}Result {`,
      `  rows:          Row[]`,
      `  rowsProcessed: number`,
      `  rowsRejected:  number`,
      `}`,
      ``,
      `interface AggState {`,
      `  count:  number`,
      `  sums:   Record<string, number>`,
      `  mins:   Record<string, number>`,
      `  maxs:   Record<string, number>`,
      `  firsts: Record<string, unknown>`,
      `  lasts:  Record<string, unknown>`,
      `  arrays: Record<string, unknown[]>`,
      `  keys:   Record<string, unknown>`,
      `}`,
      ``,
      `export async function run(inputRows: Row[]): Promise<${varName}Result> {`,
      `  const groups = new Map<string, AggState>()`,
      ``,
      `  for (const row of inputRows) {`,
      `    const groupKey = ${groupKeyExpr}`,
      `    if (!groups.has(groupKey)) {`,
      `      groups.set(groupKey, {`,
      `        count: 0, sums: {}, mins: {}, maxs: {}, firsts: {}, lasts: {}, arrays: {},`,
      `        keys: ${keysExpr},`,
      `      })`,
      `    }`,
      `    const state = groups.get(groupKey)!`,
      `    state.count++`,
      updateLines,
      `  }`,
      ``,
      `  const rows: Row[] = []`,
      `  for (const state of groups.values()) {`,
      `    rows.push({ ...state.keys,`,
      resultLines,
      `    })`,
      `  }`,
      ``,
      `  return { rows, rowsProcessed: rows.length, rowsRejected: 0 }`,
      `}`,
    ].join('\n')
  },
}

// ─────────────────────────────────────────────────────────────────
// WINDOW
// ─────────────────────────────────────────────────────────────────

export const windowGenerator: NodeGenerator = {
  operation: 'window',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName     = ctx.nodeVarMap.get(node.id)!
    const label       = node._uiRef?.label ?? canvasNodeId(node.id)
    const config      = (node._uiRef?.config ?? {}) as any
    const props       = config?.props ?? {}
    const partitionBy: string[] = (props.partition_by ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const orderBy: string[]     = (props.order_by ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const windowFn    = props.window_fn    ?? 'row_number'
    const outputField = props.output_field ?? `${windowFn}_result`

    const partKeyExpr = partitionBy.length > 0
      ? `${JSON.stringify(partitionBy)}.map((k) => String(row[k] ?? '')).join('|')`
      : `'__global__'`

    const sortBlock = orderBy.length > 0
      ? [
          `    partition.sort((a, b) => {`,
          `      for (const col of ${JSON.stringify(orderBy)}) {`,
          `        const av = a[col], bv = b[col]`,
          `        if (av === bv) continue`,
          `        return av < bv ? -1 : 1`,
          `      }`,
          `      return 0`,
          `    })`,
        ].join('\n')
      : `    // nessun ordinamento`

    const windowBody = generateWindowFnBody(windowFn, outputField)

    return [
      `/** Window: ${label} | fn: ${windowFn} | partition: ${partitionBy.join(', ') || 'nessuna'} */`,
      ``,
      `export type Row = Record<string, unknown>`,
      ``,
      `export interface ${varName}Result {`,
      `  rows:          Row[]`,
      `  rowsProcessed: number`,
      `  rowsRejected:  number`,
      `}`,
      ``,
      `export async function run(inputRows: Row[]): Promise<${varName}Result> {`,
      `  const partitions = new Map<string, Row[]>()`,
      `  for (const row of inputRows) {`,
      `    const key = ${partKeyExpr}`,
      `    const group = partitions.get(key) ?? []`,
      `    group.push(row)`,
      `    partitions.set(key, group)`,
      `  }`,
      ``,
      `  const result: Row[] = []`,
      `  for (const partition of partitions.values()) {`,
      sortBlock,
      `    ${windowBody}`,
      `    result.push(...partition)`,
      `  }`,
      ``,
      `  return { rows: result, rowsProcessed: result.length, rowsRejected: 0 }`,
      `}`,
    ].join('\n')
  },
}

// ─────────────────────────────────────────────────────────────────
// UNION
// ─────────────────────────────────────────────────────────────────

export const unionGenerator: NodeGenerator = {
  operation: 'union',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName  = ctx.nodeVarMap.get(node.id)!
    const label    = node._uiRef?.label ?? canvasNodeId(node.id)
    const config   = (node._uiRef?.config ?? {}) as any
    const distinct = (config?.props?.distinct ?? 'false') === 'true'

    const deduplicateFn = distinct ? [
      ``,
      `function deduplicateRows(rows: Row[]): Row[] {`,
      `  const seen = new Set<string>()`,
      `  return rows.filter((row) => {`,
      `    const key = JSON.stringify(Object.entries(row).sort())`,
      `    if (seen.has(key)) return false`,
      `    seen.add(key)`,
      `    return true`,
      `  })`,
      `}`,
    ].join('\n') : ''

    const rowsExpr = distinct ? `deduplicateRows(all)` : `all`

    return [
      `/** Union: ${label} | distinct: ${distinct} */`,
      ``,
      `export type Row = Record<string, unknown>`,
      ``,
      `export interface ${varName}Result {`,
      `  rows:          Row[]`,
      `  rowsProcessed: number`,
      `  rowsRejected:  number`,
      `}`,
      ``,
      `export async function run(...inputSets: Row[][]): Promise<${varName}Result> {`,
      `  const all = inputSets.flat()`,
      `  const rows = ${rowsExpr}`,
      `  return { rows, rowsProcessed: rows.length, rowsRejected: 0 }`,
      `}`,
      deduplicateFn,
    ].join('\n')
  },
}

// ─────────────────────────────────────────────────────────────────
// SORT
// ─────────────────────────────────────────────────────────────────

export const sortGenerator: NodeGenerator = {
  operation: 'sort',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName    = ctx.nodeVarMap.get(node.id)!
    const label      = node._uiRef?.label ?? canvasNodeId(node.id)
    const config     = (node._uiRef?.config ?? {}) as any
    const props      = config?.props ?? {}
    const orderBy: string[]    = (props.order_by ?? '').split(',').map((s: string) => s.trim()).filter(Boolean)
    const directions: string[] = (props.directions ?? '').split(',').map((s: string) => s.trim())

    const sortSpec = orderBy.map((col, i) => ({
      col,
      dir: directions[i]?.toLowerCase() === 'desc' ? 'desc' : 'asc',
    }))

    const sortSummary = sortSpec.map((s) => `${s.col} ${s.dir.toUpperCase()}`).join(', ') || 'nessun ordine'

    return [
      `/** Sort: ${label} | ${sortSummary} */`,
      ``,
      `export type Row = Record<string, unknown>`,
      ``,
      `export interface ${varName}Result {`,
      `  rows:          Row[]`,
      `  rowsProcessed: number`,
      `  rowsRejected:  number`,
      `}`,
      ``,
      `const SORT_SPEC = ${JSON.stringify(sortSpec)} as Array<{ col: string; dir: 'asc' | 'desc' }>`,
      ``,
      `export async function run(inputRows: Row[]): Promise<${varName}Result> {`,
      `  const rows = [...inputRows].sort((a, b) => {`,
      `    for (const { col, dir } of SORT_SPEC) {`,
      `      const av = a[col], bv = b[col]`,
      `      if (av === bv) continue`,
      `      const cmp = av < bv ? -1 : 1`,
      `      return dir === 'desc' ? -cmp : cmp`,
      `    }`,
      `    return 0`,
      `  })`,
      `  return { rows, rowsProcessed: rows.length, rowsRejected: 0 }`,
      `}`,
    ].join('\n')
  },
}

// ─────────────────────────────────────────────────────────────────
// LIMIT
// ─────────────────────────────────────────────────────────────────

export const limitGenerator: NodeGenerator = {
  operation: 'limit',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName = ctx.nodeVarMap.get(node.id)!
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)
    const config  = (node._uiRef?.config ?? {}) as any
    const limit   = parseInt(config?.props?.limit  ?? '100', 10)
    const offset  = parseInt(config?.props?.offset ?? '0',   10)
    const sliceEnd = offset > 0 ? `${offset} + ${limit}` : `${limit}`

    return [
      `/** Limit: ${label} | ${limit} righe${offset > 0 ? ` offset ${offset}` : ''} */`,
      ``,
      `export type Row = Record<string, unknown>`,
      ``,
      `export interface ${varName}Result {`,
      `  rows:          Row[]`,
      `  rowsProcessed: number`,
      `  rowsRejected:  number`,
      `}`,
      ``,
      `export async function run(inputRows: Row[]): Promise<${varName}Result> {`,
      `  const rows = inputRows.slice(${offset}, ${sliceEnd})`,
      `  return { rows, rowsProcessed: rows.length, rowsRejected: 0 }`,
      `}`,
    ].join('\n')
  },
}

// ─────────────────────────────────────────────────────────────────
// BRANCH
// ─────────────────────────────────────────────────────────────────

export const branchGenerator: NodeGenerator = {
  operation: 'branch',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName = ctx.nodeVarMap.get(node.id)!
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)
    const config  = (node._uiRef?.config ?? {}) as any
    const tmap    = config?.tmap as any
    const outputs: any[] = (tmap?.outputs ?? []).filter((o: any) => !o.id.includes('rejected'))

    const resultFields = outputs
      .map((o) => `  ${sanitizeLabel(o.label)}: Row[]`)
      .join('\n')

    const resultInit = outputs
      .map((o) => `    ${sanitizeLabel(o.label)}: [],`)
      .join('\n')

    const branchBlocks = outputs.map((o) => {
      const outName  = sanitizeLabel(o.label)
      const filter   = o.filter ?? ''
      const condition = filter
        ? filter.replace(
            /\b([a-zA-Z_][a-zA-Z0-9_.]*)\b(?!\s*\()/g,
            (m: string) => ['true', 'false', 'null', 'and', 'or', 'not'].includes(m.toLowerCase())
              ? m
              : `row[${JSON.stringify(m)}]`
          )
        : 'true'
      return [
        `    if (!matched && (${condition})) {`,
        `      result.${outName}.push(projectRow_${outName}(row))`,
        `      matched = true`,
        `    }`,
      ].join('\n')
    }).join('\n')

    const projectFns = outputs.map((o) => {
      const outName = sanitizeLabel(o.label)
      const fields: Array<{ name: string; expression?: string }> = o.fields ?? []
      const fieldLines = fields.length > 0
        ? fields.map((f) => {
            const rawExpr = f.expression || `row[${JSON.stringify(f.name)}]`
            const safeExpr = rawExpr.replace(
              /\b([a-zA-Z_][a-zA-Z0-9_.]*)\b(?!\s*\()/g,
              (m: string) => ['true', 'false', 'null'].includes(m) ? m : `row[${JSON.stringify(m)}]`
            )
            return `    ${JSON.stringify(f.name)}: ${safeExpr},`
          }).join('\n')
        : `    ...row,`
      return [
        `function projectRow_${outName}(row: Row): Row {`,
        `  return {`,
        fieldLines,
        `  }`,
        `}`,
      ].join('\n')
    }).join('\n\n')

    return [
      `/** Branch: ${label} */`,
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
      ``,
      projectFns,
    ].join('\n')
  },
}

// ─────────────────────────────────────────────────────────────────
// MERGE
// ─────────────────────────────────────────────────────────────────

export const mergeGenerator: NodeGenerator = {
  operation: 'merge',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName = ctx.nodeVarMap.get(node.id)!
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)

    return [
      `/** Merge: ${label} */`,
      ``,
      `export type Row = Record<string, unknown>`,
      ``,
      `export interface ${varName}Result {`,
      `  rows:          Row[]`,
      `  rowsProcessed: number`,
      `  rowsRejected:  number`,
      `}`,
      ``,
      `export async function run(...inputSets: Row[][]): Promise<${varName}Result> {`,
      `  const rows = inputSets.flat()`,
      `  return { rows, rowsProcessed: rows.length, rowsRejected: 0 }`,
      `}`,
    ].join('\n')
  },
}
