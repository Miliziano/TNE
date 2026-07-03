/**
 * src/runner/tmapExecutor.ts
 *
 * Modifiche rispetto alla versione precedente:
 * - Usa buildLaneProxy da types.ts invece della versione locale.
 *   Legge da context.laneVariables (Map live) invece dello snapshot stale.
 * - context è disponibile come alias { lane } nelle espressioni,
 *   per compatibilità con la sintassi context.lane.* dello Script.
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import { buildLaneProxy } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData, TMapConfig } from '../types'
import { evalPreset, getPresetsForType } from '../transforms/presets'
import type { FieldType } from '../transforms/presets'
import { TRANSFORM_CATALOG } from '../transforms/catalog'

interface JoinFieldExpr { id: string; field: string; fn: string; arg1: string; arg2: string }
interface JoinPair {
  id: string; srcInputId: string
  srcFields: JoinFieldExpr[]; combineExpr: string
  dstFields: JoinFieldExpr[]; dstCombineExpr: string
}

// ─── Cache indici per run ──────────────────────────────────────────

interface TMapCache {
  labelById:     Map<string, string>
  lookupIndices: Map<string, JoinIndex[]>
  lookupInputs:  TMapConfig['inputs']
  transforms:    TMapTransformFull[]
  dedupNames:    Map<string, string[]>
  rejectOut:     TMapConfig['outputs'][0]
  tmap:          TMapConfig
  mainInp:       TMapConfig['inputs'][0]
}

const _tmapIndexCache = new Map<string, TMapCache>()

export function clearTMapIndexCache(): void {
  _tmapIndexCache.clear()
}

// ─── Catalogo trasformazioni ───────────────────────────────────────

function applyCatalogFn(value: unknown, fnId: string, params?: Record<string, string>): unknown {
  if (!fnId) return value
  const allFns = Object.values(TRANSFORM_CATALOG).flat()
  const fn = allFns.find(f => f.id === fnId)
  if (!fn) return value
  const allPresets = Object.keys(TRANSFORM_CATALOG).flatMap(t => getPresetsForType(t as FieldType))
  const preset = allPresets.find(p => p.id === fnId)
  if (!preset) {
    return evalPreset({
      id: fn.id, label: fn.label, desc: fn.description,
      jsExpr: fn.expression, outputType: fn.outputType as FieldType | undefined, params: fn.params,
    }, value, params)
  }
  return evalPreset(preset, value, params)
}

// ─── Join helpers ──────────────────────────────────────────────────

function applyJoinFn(value: unknown, fn: string, arg1: string, arg2: string): unknown {
  const s = value === null || value === undefined ? '' : String(value)
  switch (fn) {
    case 'none':   return value
    case 'trim':   return s.trim()
    case 'lower':  return s.toLowerCase()
    case 'upper':  return s.toUpperCase()
    case 'year':   { const d = new Date(s); return isNaN(d.getTime()) ? null : d.getFullYear() }
    case 'month':  { const d = new Date(s); return isNaN(d.getTime()) ? null : d.getMonth() + 1 }
    case 'day':    { const d = new Date(s); return isNaN(d.getTime()) ? null : d.getDate() }
    case 'date':   return s.split('T')[0] ?? s
    case 'substr': return s.substring(parseInt(arg1 || '0', 10), parseInt(arg2 || '8', 10))
    case 'regex':  { try { return s.match(new RegExp(arg1 || '(.+)'))?.[1] ?? null } catch { return null } }
    case 'free':   { if (!arg1) return value; try { return new Function('v', `return (${arg1})`)(value) } catch { return null } }
    default:       return value
  }
}

function buildJoinKey(row: Row, fields: JoinFieldExpr[], combineExpr: string): string {
  if (fields.length === 0) return ''
  const values = fields.map(f => applyJoinFn(row[f.field], f.fn, f.arg1, f.arg2))
  if (fields.length === 1) {
    const v = values[0]
    return v === null || v === undefined ? '\x00null\x00' : String(v)
  }
  if (combineExpr?.trim()) {
    try {
      let expr = combineExpr
      values.forEach((v, i) => {
        expr = expr.replace(new RegExp(`\\$${i}`, 'g'),
          JSON.stringify(v === null || v === undefined ? '' : String(v)))
      })
      const result = new Function(`return (${expr})`)()
      return result === null || result === undefined ? '\x00null\x00' : String(result)
    } catch {}
  }
  return values.map(v => v === null || v === undefined ? '' : String(v)).join('\x00')
}

function buildIndex(
  rows:        Row[],
  fields:      JoinFieldExpr[],
  combineExpr: string,
  joinType:    string,
): Map<string, Row[]> {
  const idx = new Map<string, Row[]>()
  for (const row of rows) {
    const k = buildJoinKey(row, fields, combineExpr)
    if (joinType === 'first') {
      if (!idx.has(k)) idx.set(k, [row])
    } else {
      if (!idx.has(k)) idx.set(k, [])
      idx.get(k)!.push(row)
    }
  }
  return idx
}

// ─── Transform ────────────────────────────────────────────────────

interface TMapTransformFull {
  id: string; outputName: string; expression: string
  inputs: Array<{ inputId: string; fieldName: string; perFieldFn?: string; perFieldParams?: Record<string, string> }>
  finalFn?: string; finalParams?: Record<string, string>
  cast?: { fromType: string; toType: string }
  mode?: string
  pipeline?: Array<{ id: string; fnId: string; params: Record<string, string> }>
}

interface JoinIndex {
  pair:     JoinPair
  dstIndex: Map<string, Row[]>
  joinType: string
}

function sv(val: unknown): string {
  if (val === null || val === undefined) return 'null'
  if (typeof val === 'string')  return JSON.stringify(val)
  if (typeof val === 'boolean') return String(val)
  if (typeof val === 'number')  return String(val)
  return JSON.stringify(val)
}

function strReplace(str: string, search: string, replacement: string): string {
  if (!search) return str
  return str.split(search).join(replacement)
}

// ─── evalTransform ────────────────────────────────────────────────
//
// Variabili disponibili nelle espressioni:
//   lane.*          → variabili di lane (via Proxy live)
//   context.lane.*  → alias identico (compatibilità con Script)
//
function evalTransform(
  tr:        TMapTransformFull,
  ctx:       Record<string, Row>,
  labelById: Map<string, string>,
  lane?:     Record<string, unknown>,
): unknown {
  const laneObj    = lane ?? {}
  const contextObj = { lane: laneObj }  // alias context.lane.*

  const varValues = new Map<string, unknown>()
  for (const inp of tr.inputs) {
    const label = labelById.get(inp.inputId) ?? inp.inputId
    const row   = ctx[label]
    let val: unknown = row?.[inp.fieldName]
    if (tr.cast && tr.cast.fromType !== tr.cast.toType)
      val = applyCatalogFn(val, `any_to_${tr.cast.toType}`)
    if (inp.perFieldFn)
      val = applyCatalogFn(val, inp.perFieldFn, inp.perFieldParams)
    varValues.set(`$${label}.${inp.fieldName}`, val)
  }

  let result: unknown
  const rawExpr = tr.expression?.trim() ?? ''

  if (tr.mode === 'script') {
    let script = rawExpr
    for (const [k, v] of varValues) script = strReplace(script, k, sv(v))
    script = strReplace(script, '$value', sv(varValues.values().next().value))
    try {
      result = new Function('lane', 'context', `"use strict"; ${script}`)(laneObj, contextObj)
    } catch (e) {
      console.warn(`[TMap] script "${tr.outputName}" errore: ${e instanceof Error ? e.message : String(e)}`)
      result = undefined
    }
  } else if (!rawExpr) {
    if (tr.inputs.length === 1) {
      result = varValues.values().next().value
    } else {
      result = tr.inputs.map(inp => {
        const label = labelById.get(inp.inputId) ?? inp.inputId
        const val   = varValues.get(`$${label}.${inp.fieldName}`)
        return val === null || val === undefined ? '' : String(val)
      }).join('')
    }
  } else {
    let expr = rawExpr
    for (const [k, v] of varValues) expr = strReplace(expr, k, sv(v))
    for (const [label, row] of Object.entries(ctx)) {
      if (label === '__noMatch') continue
      for (const [field, rawVal] of Object.entries(row)) {
        const varName = `$${label}.${field}`
        if (expr.includes(varName)) expr = strReplace(expr, varName, sv(rawVal))
      }
    }
    expr = strReplace(expr, '$value', sv(varValues.values().next().value))
    try {
      result = new Function('lane', 'context', `"use strict"; return (${expr})`)(laneObj, contextObj)
    } catch { result = undefined }
  }

  if (tr.pipeline?.length && result !== undefined)
    for (const step of tr.pipeline) result = applyCatalogFn(result, step.fnId, step.params)

  if (tr.finalFn && tr.finalFn !== 'none' && result !== undefined) {
    const FINAL: Record<string, string> = {
      trim:       'String($v??"").trim()',
      upper:      'String($v??"").toUpperCase()',
      lower:      'String($v??"").toLowerCase()',
      capitalize: '(()=>{const _s=String($v??"").toLowerCase();return _s.charAt(0).toUpperCase()+_s.slice(1)})()',
      slug:       'String($v??"").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-")',
      null_empty: '($v===\'\'||$v==null?null:$v)',
      to_string:  'String($v??"")',
      to_int:     'parseInt(String($v??"0").replace(",",""),10)',
      to_decimal: 'parseFloat(String($v??"0").replace(",","."))',
      to_bool:    '["true","1","yes","si","sì","on"].includes(String($v??"").toLowerCase())',
      to_date:    '(()=>{const _d=new Date($v);return isNaN(_d.getTime())?null:_d.toISOString().split("T")[0]})()',
    }
    const tpl = FINAL[tr.finalFn]
    if (tpl) {
      try {
        const s = result === null ? 'null'
          : typeof result === 'string' ? JSON.stringify(result)
          : String(result)
        result = new Function(`"use strict"; return (${tpl.split('$v').join(s)})`)()
      } catch {}
    } else {
      result = applyCatalogFn(result, tr.finalFn, tr.finalParams)
    }
  }

  return result
}

// ─── evalOutputExpr ───────────────────────────────────────────────

function evalOutputExpr(
  expression:  string,
  ctx:         Record<string, Row>,
  transforms?: TMapTransformFull[],
  labelById?:  Map<string, string>,
  lane?:       Record<string, unknown>,
): unknown {
  if (!expression?.trim()) return undefined

  if (transforms) {
    const tr = transforms.find(t => t.outputName === expression)
    if (tr) return evalTransform(tr, ctx, labelById ?? new Map(), lane)
  }

  const dotIdx = expression.indexOf('.')
  if (dotIdx > 0) {
    const label = expression.substring(0, dotIdx)
    const field = expression.substring(dotIdx + 1)
    if (label === 'lane' && lane !== undefined) return lane[field]
    if (ctx[label] !== undefined) return ctx[label][field]
    const ll = label.toLowerCase()
    for (const [k, row] of Object.entries(ctx))
      if (k.toLowerCase() === ll) return row[field]
  }

  try {
    const laneObj    = lane ?? {}
    const contextObj = { lane: laneObj }
    return new Function('lane', 'context', ...Object.keys(ctx), `return (${expression})`)(
      laneObj, contextObj, ...Object.values(ctx)
    )
  } catch { return undefined }
}

// ─── evalFilter ───────────────────────────────────────────────────

function evalFilter(
  filter: string,
  ctx:    Record<string, Row>,
  lane?:  Record<string, unknown>,
): boolean {
  if (!filter?.trim()) return true
  try {
    const laneObj    = lane ?? {}
    const contextObj = { lane: laneObj }
    return !!(new Function('lane', 'context', ...Object.keys(ctx), `return !!(${filter})`)(
      laneObj, contextObj, ...Object.values(ctx)
    ))
  } catch { return false }
}

// ─── processMainRow ───────────────────────────────────────────────

function processMainRow(
  mainRow:   Row,
  cache:     TMapCache,
  outputMap: Map<string, Row[]>,
  lane?:     Record<string, unknown>,
): void {
  const { mainInp, lookupInputs, lookupIndices, labelById, tmap, transforms, dedupNames, rejectOut } = cache

  let ctxList: Array<Record<string, Row>> = [{ [mainInp.label]: mainRow }]

  for (const lookupInp of lookupInputs) {
    const indices  = lookupIndices.get(lookupInp.id) ?? []
    const joinType = (lookupInp.joinType as string) ?? 'left'

    if (indices.length === 0) {
      ctxList = ctxList.map(ctx => ({ ...ctx, [lookupInp.label]: {} }))
      continue
    }

    const expanded: Array<Record<string, Row>> = []
    for (const ctx of ctxList) {
      let candidates: Row[] | null = null
      let anyInnerMiss = false
      let anyMiss      = false

      for (const { pair, dstIndex } of indices) {
        const srcLabel = labelById.get(pair.srcInputId) ?? pair.srcInputId
        const srcRow   = ctx[srcLabel]
        if (!srcRow) {
          if (joinType === 'inner' || joinType === 'first') { anyInnerMiss = true; break }
          anyMiss = true; break
        }
        const key     = buildJoinKey(srcRow, pair.srcFields, pair.combineExpr ?? '')
        const matches = dstIndex.get(key) ?? []
        if (matches.length === 0) {
          if (joinType === 'inner' || joinType === 'first') { anyInnerMiss = true; break }
          anyMiss = true; break
        }
        candidates = candidates === null
          ? matches
          : (() => {
              const m: Row[] = []
              for (const e of candidates!) for (const n of matches) m.push({ ...e as object, ...n as object } as Row)
              return m
            })()
      }

      if (anyInnerMiss) { expanded.push({ ...ctx, __noMatch: {} as Row }); continue }
      if (anyMiss || !candidates?.length) { expanded.push({ ...ctx, [lookupInp.label]: {} }); continue }
      const eff = joinType === 'first' ? [candidates[0]] : candidates
      for (const c of eff) expanded.push({ ...ctx, [lookupInp.label]: c })
    }
    ctxList = expanded
  }

  for (const ctx of ctxList) {
    if ('__noMatch' in ctx) {
      const rejectRow: Row = {}
      const dNames    = dedupNames.get(rejectOut.id) ?? []
      const rejectCtx = { [mainInp.label]: mainRow }
      for (let fi = 0; fi < rejectOut.fields.length; fi++) {
        const field   = rejectOut.fields[fi]
        const outName = dNames[fi] || field.name
        if (!outName) continue
        const expr = (field.expression ?? '').trim()
        rejectRow[outName] = expr ? evalOutputExpr(expr, rejectCtx, transforms, labelById, lane) : undefined
      }
      outputMap.get(rejectOut.id)!.push(rejectOut.fields.length > 0 ? rejectRow : mainRow)
      continue
    }

    let routed = false
    for (let oi = 0; oi < tmap.outputs.length; oi++) {
      const out = tmap.outputs[oi]
      if (oi === 1 && !out.filter?.trim()) continue
      if (out.filter?.trim() && !evalFilter(out.filter, ctx, lane)) continue

      const outRow: Row = {}
      const dNames = dedupNames.get(out.id) ?? []
      for (let fi = 0; fi < out.fields.length; fi++) {
        const field   = out.fields[fi]
        const outName = dNames[fi] || field.name
        if (!outName) continue
        const expr = (field.expression ?? '').trim()
        outRow[outName] = expr ? evalOutputExpr(expr, ctx, transforms, labelById, lane) : undefined
      }
      outputMap.get(out.id)!.push(outRow)
      routed = true
    }

    if (!routed) {
      const rejectRow: Row = {}
      const dNames = dedupNames.get(rejectOut.id) ?? []
      for (let fi = 0; fi < rejectOut.fields.length; fi++) {
        const field   = rejectOut.fields[fi]
        const outName = dNames[fi] || field.name
        if (!outName) continue
        const expr = (field.expression ?? '').trim()
        rejectRow[outName] = expr ? evalOutputExpr(expr, ctx, transforms, labelById, lane) : undefined
      }
      outputMap.get(rejectOut.id)!.push(rejectOut.fields.length > 0 ? rejectRow : mainRow)
    }
  }
}

// ─── buildAndCacheIndices ─────────────────────────────────────────

function buildAndCacheIndices(
  cacheKey:      string,
  node:          FlowNode<NodeData>,
  tmap:          TMapConfig,
  rowsByInputId: Map<string, Row[]>,
  context:       ExecutionContext,
): TMapCache {
  const mainInp      = tmap.inputs.find(i => i.isMain)!
  const lookupInputs = tmap.inputs.filter(i => !i.isMain)
  const labelById    = new Map<string, string>()
  for (const inp of tmap.inputs) labelById.set(inp.id, inp.label)

  const lookupIndices = new Map<string, JoinIndex[]>()
  for (const lookupInp of lookupInputs) {
    const lookupRows = rowsByInputId.get(lookupInp.id) ?? []
    const joinPairs  = ((lookupInp as any).joinPairs ?? []) as JoinPair[]
    const joinType   = (lookupInp.joinType as string) ?? 'left'

    if (lookupRows.length === 0)
      context.callbacks.onLog('warn', `TMap lookup '${lookupInp.label}': nessuna riga`, node.id)

    if (joinPairs.length === 0) { lookupIndices.set(lookupInp.id, []); continue }

    const indices: JoinIndex[] = []
    for (const pair of joinPairs) {
      const dstFields = pair.dstFields?.length > 0
        ? pair.dstFields
        : (pair as any).dstField
          ? [{ id: 'legacy', field: (pair as any).dstField, fn: (pair as any).dstFn ?? 'none', arg1: '', arg2: '' }]
          : []
      if (!dstFields[0]?.field || !pair.srcInputId || !pair.srcFields?.[0]?.field) continue
      indices.push({
        pair,
        dstIndex: buildIndex(lookupRows, dstFields, pair.dstCombineExpr ?? '', joinType),
        joinType,
      })
    }
    lookupIndices.set(lookupInp.id, indices)
  }

  const rejectOut  = tmap.outputs.length > 1 ? tmap.outputs[1] : tmap.outputs[0]
  const transforms = (tmap.transforms ?? []) as TMapTransformFull[]

  const dedupNames = new Map<string, string[]>()
  for (const out of tmap.outputs) {
    const seen  = new Map<string, number>()
    const names: string[] = []
    for (const field of out.fields) {
      if (!field.name) { names.push(''); continue }
      const count = seen.get(field.name) ?? 0
      if (count === 0) {
        names.push(field.name)
      } else {
        const expr = (field.expression ?? '').trim()
        const dot  = expr.indexOf('.')
        const pre  = dot > 0 ? expr.substring(0, dot).replace(/\s+/g, '_') : `dup${count}`
        names.push(`${pre}__${field.name}`)
      }
      seen.set(field.name, count + 1)
    }
    dedupNames.set(out.id, names)
  }

  const cache: TMapCache = {
    labelById, lookupIndices, lookupInputs, transforms, dedupNames, rejectOut, tmap, mainInp,
  }

  context.callbacks.onLog('info',
    `TMap: indici costruiti — lookup: ${lookupInputs.map(l => `${l.label}=${rowsByInputId.get(l.id)?.length ?? 0}`).join(', ')}`,
    node.id)

  _tmapIndexCache.set(cacheKey, cache)
  return cache
}

// ─── Executor ──────────────────────────────────────────────────────

export const tmapExecutor: NodeExecutor = {
  handles: ['tmap'],

  requiresCompleteInput: (node, inputHandle) => {
    const tmap  = node.data.config?.tmap as TMapConfig | undefined
    if (!tmap) return false
    const input = tmap.inputs.find((i) => i.id === inputHandle)
    if (!input) return false
    return !input.isMain
  },

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {
    const tmap = node.data.config?.tmap as TMapConfig | undefined
    if (!tmap) {
      context.callbacks.onLog('warn', 'TMap: nessuna configurazione', node.id)
      return new Map()
    }

    const mainInp = tmap.inputs.find(i => i.isMain)
    if (!mainInp) {
      context.callbacks.onLog('warn', 'TMap: nessun main', node.id)
      return new Map()
    }

    // ── Proxy lane — usa buildLaneProxy da types.ts ────────────
    // Legge sempre da context.laneVariables (Map live aggiornata da tutti
    // i nodi). Se lo Script ha scritto lane.counter=0 prima di questo nodo,
    // il Proxy lo vedrà immediatamente senza snapshot stale.
    const lane = buildLaneProxy(node.data.laneId, context)

    // ── Smista righe per __sourceHandle ───────────────────────
    const rowsByInputId = new Map<string, Row[]>()
    for (const inp of tmap.inputs) rowsByInputId.set(inp.id, [])

    for (const row of input) {
      const handle = (row as any).__sourceHandle as string | undefined
      delete (row as any).__sourceHandle
      if (handle && rowsByInputId.has(handle)) rowsByInputId.get(handle)!.push(row)
      else rowsByInputId.get(mainInp.id)!.push(row)
    }

    const mainRows = rowsByInputId.get(mainInp.id) ?? []

    // ── Cache indici ───────────────────────────────────────────
    const cacheKey = `${context.runId}::${node.id}`
    let cache = _tmapIndexCache.get(cacheKey)

    const hasLookupRows = tmap.inputs
      .filter(i => !i.isMain)
      .some(inp => (rowsByInputId.get(inp.id)?.length ?? 0) > 0)

    if (!cache || hasLookupRows) {
      cache = buildAndCacheIndices(cacheKey, node, tmap, rowsByInputId, context)
    }

    // ── Elabora righe del main ─────────────────────────────────
    const outputMap = new Map<string, Row[]>()
    for (const out of tmap.outputs) outputMap.set(out.id, [])

    for (const mainRow of mainRows) {
      if (context.callbacks.isAborted()) break
      processMainRow(mainRow, cache, outputMap, lane)
    }

    if (mainRows.length > 0) {
      const outCounts = tmap.outputs
        .map(o => `${o.label}=${outputMap.get(o.id)?.length ?? 0}`)
        .join(', ')
      context.callbacks.onLog('debug',
        `TMap: ${mainRows.length} riga/righe → ${outCounts}`, node.id)
    }

    return outputMap
  },
}