/**
 * src/runner/jsonSerializerExecutor.ts
 *
 * Legge la struttura dell'albero JSON da props._treeNodes e
 * config.jsonSerializer (mappings + inputs) per costruire il documento.
 *
 * Struttura dati:
 *   props._treeNodes    — albero JsonTreeNode[] serializzato
 *   config.jsonSerializer.inputs[handle]   — { label, fields }
 *   config.jsonSerializer.mappings[handle] — { handle, jsonKey, mode, fields[] }
 *   props.outputField   — nome del campo output (default: 'content')
 *   props.pretty        — 'true' per pretty print
 *   props.nullDefault   — 'null' | 'omit' | 'empty'
 *   props.envelope      — chiave envelope opzionale
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Tipi mirroring della modal ───────────────────────────────────
type JsonNodeType = 'string'|'number'|'boolean'|'object'|'array'|'null'

interface JsonTreeNode {
  id: string; key: string; type: JsonNodeType
  children: JsonTreeNode[]; collapsed: boolean
  sourceHandle?: string; sourceField?: string
  sources?: Array<{ handle: string; field: string }>
  expr?: string
  iterHandle?: string
  condition?: string
  groupBy?: string
}

// ─── Valuta condizione JS ─────────────────────────────────────────
function evalCondition(condition: string, row: Record<string, unknown>): boolean {
  try {
    // eslint-disable-next-line no-new-func
    return !!new Function('row', `return (${condition})`)(row)
  } catch { return true }  // se la condizione è invalida, non omette
}

interface JsonFlowField {
  id: string; jsonKey: string; sourceField: string; transform: string; nullable: 'null'|'omit'|'empty'
}
interface JsonFlowMapping {
  handle: string; jsonKey: string; mode: 'array'|'object'|'value'; field?: string
  fields: JsonFlowField[]; dedup?: boolean
}

// ─── Deduplicazione righe sui campi specificati ───────────────────
function dedupRows(rows: Row[], fields: string[]): Row[] {
  if (fields.length === 0) return rows
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = fields.map((f) => String(row[f] ?? '').trim()).join('\x00')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
interface SerInput { label: string; fields: Array<{ name: string; type: string }> }

// ─── Trasformazioni ───────────────────────────────────────────────
function applyTransform(val: unknown, transform: string): unknown {
  const s = String(val ?? '')
  switch (transform) {
    case 'to_string':  return s
    case 'to_int':     return parseInt(s, 10)
    case 'to_float':   return parseFloat(s)
    case 'to_bool':    return ['true','1','yes','si','sì'].includes(s.toLowerCase())
    case 'to_date':    return s.split('T')[0]
    case 'uppercase':  return s.toUpperCase()
    case 'lowercase':  return s.toLowerCase()
    case 'trim':       return s.trim()
    default:           return val
  }
}

function applyNullable(val: unknown, nullable: string): unknown {
  if (val === null || val === undefined) {
    if (nullable === 'empty') return ''
    if (nullable === 'omit')  return undefined
    return null
  }
  return val
}

// ─── Legge righe con dedup opzionale ─────────────────────────────
function getRows(
  handle:      string,
  byHandle:    Map<string, Row[]>,
  mappings:    Record<string, JsonFlowMapping>,
  dedupFields?: string[],  // campi espliciti su cui deduplicare
): Row[] {
  const rows    = byHandle.get(handle) ?? []
  const mapping = mappings[handle]
  if (!mapping?.dedup) return rows

  // Priorità campi dedup:
  // 1. campi esplicitamente passati dal chiamante
  // 2. sourceField configurati nel mapping manuale
  // 3. tutti i campi della riga (fallback)
  const fields = dedupFields?.length
    ? dedupFields
    : mapping.fields.length > 0
      ? mapping.fields.map((f) => f.sourceField).filter(Boolean) as string[]
      : Object.keys(rows[0] ?? {}).filter((k) => !k.startsWith('__'))

  return dedupRows(rows, fields)
}
// Raccoglie i sourceField usati nell'albero per un dato handle
function collectTreeFields(nodes: JsonTreeNode[], handle: string): string[] {
  const fields: string[] = []
  function walk(ns: JsonTreeNode[]) {
    ns.forEach((n) => {
      if (n.sourceHandle === handle && n.sourceField) fields.push(n.sourceField)
      if (n.sources) n.sources.forEach((s) => { if (s.handle === handle) fields.push(s.field) })
      walk(n.children)
    })
  }
  walk(nodes)
  return [...new Set(fields)]
}

function buildNodeValue(
  node:        JsonTreeNode,
  byHandle:    Map<string, Row[]>,
  mappings:    Record<string, JsonFlowMapping>,
  nullDefault: string,
  rowContext?:  Map<string, Row>,
  treeNodes?:  JsonTreeNode[],
): unknown {


  // ── Foglia ────────────────────────────────────────────────────
  if (node.type !== 'object' && node.type !== 'array') {
    const getEffectiveRow = (handle: string): Record<string, unknown> => {
      if (rowContext?.has(handle)) return rowContext.get(handle) as Record<string, unknown>
      return (byHandle.get(handle) ?? [])[0] ?? {}
    }

    if (node.expr) {
      try {
        const sources = node.sources?.length
          ? node.sources
          : node.sourceHandle && node.sourceField
            ? [{ handle: node.sourceHandle, field: node.sourceField }]
            : []
        const row: Record<string, unknown> = {}
        sources.forEach((s) => Object.assign(row, getEffectiveRow(s.handle)))
        // eslint-disable-next-line no-new-func
        const result = new Function('row', `return (${node.expr})`)(row)
        if (node.condition && !evalCondition(node.condition, row)) return undefined
        return applyNullable(result, nullDefault)
      } catch { return null }
    }

    if (node.sourceHandle && node.sourceField) {
      const row = getEffectiveRow(node.sourceHandle)
      const val: unknown = (row[node.sourceField] as unknown) ?? null
      if (node.condition && !evalCondition(node.condition, row)) return undefined
      return applyNullable(val, nullDefault)
    }

    return null
  }

  // ── Object ────────────────────────────────────────────────────
  if (node.type === 'object') {
    const obj: Record<string, unknown> = {}
    for (const child of node.children) {
      const v = buildNodeValue(child, byHandle, mappings, nullDefault, rowContext, treeNodes)
      if (v === undefined) continue
      obj[child.key] = v
    }
    return obj
  }

  // ── Array ─────────────────────────────────────────────────────
  if (node.type === 'array') {
    const iterH = node.iterHandle
      ?? node.sourceHandle
      ?? (() => {
        const counts = new Map<string, number>()
        const walkH = (ns: JsonTreeNode[]) => ns.forEach((n) => {
          if (n.sourceHandle) counts.set(n.sourceHandle, (counts.get(n.sourceHandle) ?? 0) + 1)
          walkH(n.children)
        })
        walkH(node.children)
        let best: string | undefined; let max = 0
        counts.forEach((c, h) => { if (c > max) { max = c; best = h } })
        return best
      })()

    if (!iterH) {
      if (node.children.length > 0) {
        const obj: Record<string, unknown> = {}
        for (const child of node.children) {
          const v = buildNodeValue(child, byHandle, mappings, nullDefault, rowContext, treeNodes)
          if (v === undefined) continue
          obj[child.key] = v
        }
        return [obj]
      }
      return []
    }

    const dedupFields = treeNodes ? collectTreeFields(treeNodes, iterH) : undefined
    const rows = getRows(iterH, byHandle, mappings, dedupFields?.length ? dedupFields : undefined)

    if (node.children.length === 0) {
      const mapping = mappings[iterH]
      if (mapping && mapping.fields.length > 0) {
        return rows.map((row) => {
          const obj: Record<string, unknown> = {}
          for (const mf of mapping.fields) {
            if (!mf.jsonKey || !mf.sourceField) continue
            let val: unknown = (row[mf.sourceField] as unknown) ?? null
            if (mf.transform) val = applyTransform(val, mf.transform)
            const nulled = applyNullable(val, mf.nullable ?? nullDefault)
            if (nulled === undefined) continue
            obj[mf.jsonKey] = nulled
          }
          return obj
        })
      }
      return rows
    }

    if (node.groupBy) {
        const groupField = node.groupBy
        const groups = new Map<string, Row[]>()
        for (const row of rows) {
          const k = String(row[groupField] ?? '\x00null\x00')
          if (!groups.has(k)) groups.set(k, [])
          groups.get(k)!.push(row)
        }
        return Array.from(groups.values()).map((groupRows) => {
          const groupByHandle = new Map(byHandle)
          groupByHandle.set(iterH, groupRows)
          const ctx = new Map<string, Row>(rowContext ?? [])
          ctx.set(iterH, groupRows[0])
          const obj: Record<string, unknown> = {}
          for (const child of node.children) {
            const v = buildNodeValue(child, groupByHandle, mappings, nullDefault, ctx, treeNodes)
            if (v === undefined) continue
            obj[child.key] = v
          }
          return obj
        })
      }

      return rows.map((row) => {
        const ctx = new Map<string, Row>(rowContext ?? [])
        ctx.set(iterH, row)
        const obj: Record<string, unknown> = {}
        for (const child of node.children) {
          const v = buildNodeValue(child, byHandle, mappings, nullDefault, ctx, treeNodes)
          if (v === undefined) continue
          obj[child.key] = v
        }
        return obj
      })
    }

    return null
  }

// ─── Costruisce documento dal mapping legacy (senza albero) ───────
function buildFromMappings(
  mappings:    Record<string, JsonFlowMapping>,
  byHandle:    Map<string, Row[]>,
  nullDefault: string,
): Record<string, unknown> {
  const doc: Record<string, unknown> = {}
  for (const [handle, mapping] of Object.entries(mappings)) {
    if (!mapping.jsonKey) continue
    const rows = getRows(handle, byHandle, mappings)
    switch (mapping.mode) {
      case 'array': {
        if (mapping.fields.length > 0) {
          doc[mapping.jsonKey] = rows.map((row) => {
            const obj: Record<string, unknown> = {}
            for (const mf of mapping.fields) {
              if (!mf.jsonKey || !mf.sourceField) continue
              let val: unknown = (row[mf.sourceField] as unknown) ?? null
              if (mf.transform) val = applyTransform(val, mf.transform)
              const nulled = applyNullable(val, mf.nullable ?? nullDefault)
              if (nulled === undefined) continue
              obj[mf.jsonKey] = nulled
            }
            return obj
          })
        } else {
          doc[mapping.jsonKey] = rows
        }
        break
      }
      case 'object': {
        const row = rows[0] ?? {}
        if (mapping.fields.length > 0) {
          const obj: Record<string, unknown> = {}
          for (const mf of mapping.fields) {
            if (!mf.jsonKey || !mf.sourceField) continue
            let val: unknown = (row[mf.sourceField] as unknown) ?? null
            if (mf.transform) val = applyTransform(val, mf.transform)
            const nulled = applyNullable(val, mf.nullable ?? nullDefault)
            if (nulled === undefined) continue
            obj[mf.jsonKey] = nulled
          }
          doc[mapping.jsonKey] = obj
        } else {
          doc[mapping.jsonKey] = row
        }
        break
      }
      case 'value': {
        const row = rows[0] ?? {}
        const val: unknown = mapping.field ? ((row[mapping.field] as unknown) ?? null) : null
        doc[mapping.jsonKey] = applyNullable(val, nullDefault)
        break
      }
    }
  }
  return doc
}

// ─── Executor ─────────────────────────────────────────────────────
export const jsonSerializerExecutor: NodeExecutor = {
  handles: ['json_serializer'],

   requiresCompleteInput: (node) => {
    const serConfig = (node.data.config as any)?.jsonSerializer ?? {}
    const mappings  = serConfig.mappings ?? {}
    // Più di un handle mappato → documento aggregato, serve il
    // dataset completo di ciascun handle per costruirlo correttamente.
    return Object.keys(mappings).length > 1
  },

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)

    const outputField = p('outputField', 'content')
    const pretty      = p('pretty', 'false') === 'true'
    const nullDefault = p('nullDefault', 'null')
    const envelope    = p('envelope', '')
    const onError     = p('onError', 'reject')

    const serConfig  = (node.data.config as any)?.jsonSerializer ?? {}
    const mappings:  Record<string, JsonFlowMapping> = serConfig.mappings ?? {}
    const inputs:    Record<string, SerInput>        = serConfig.inputs ?? {}

    // Albero JSON dalla struttura configurata nella modal
    let treeNodes: JsonTreeNode[] = []
    try { treeNodes = JSON.parse(p('_treeNodes', '[]')) } catch {}

    // ── Raggruppa righe per handle ────────────────────────────────
    // Il runner inietta __sourceHandle (doppio underscore) per handle != 'input'
    const byHandle = new Map<string, Row[]>()

    for (const row of input) {
      const r = row as any
      // __sourceHandle è il targetHandle dell'edge (es. 'input', 'input_2', ...)
      const handle = String(r['__sourceHandle'] ?? 'input')
      if (!byHandle.has(handle)) byHandle.set(handle, [])
      const { __sourceHandle, _sourceHandle, ...cleanRow } = r
      byHandle.get(handle)!.push(cleanRow)
    }

    context.callbacks.onLog('info',
      `JsonSerializer handles ricevuti: ${[...byHandle.entries()].map(([h,r]) => `${h}(${r.length} righe)`).join(', ')}`,
      node.id)

    try {
      let doc: Record<string, unknown>

      if (treeNodes.length > 0) {
        // ── Usa la struttura dell'albero configurata ──────────────
        doc = {}

        // Per ogni nodo radice dell'albero
        for (const rootNode of treeNodes) {
          if (rootNode.type === 'array' && rootNode.sourceHandle) {
            const dedupF  = collectTreeFields(treeNodes, rootNode.sourceHandle)
            const rows    = getRows(rootNode.sourceHandle, byHandle, mappings, dedupF.length ? dedupF : undefined)
            const mapping = mappings[rootNode.sourceHandle]
            if (mapping && mapping.fields.length > 0) {
              doc[rootNode.key] = rows.map((row) => {
                const obj: Record<string, unknown> = {}
                for (const mf of mapping.fields) {
                  if (!mf.jsonKey || !mf.sourceField) continue
                  let val: unknown = (row[mf.sourceField] as unknown) ?? null
                  if (mf.transform) val = applyTransform(val, mf.transform)
                  const nulled = applyNullable(val, mf.nullable ?? nullDefault)
                  if (nulled === undefined) continue
                  obj[mf.jsonKey] = nulled
                }
                return obj
              })
            } else {
              doc[rootNode.key] = rows
            }
          } else {
            const v = buildNodeValue(rootNode, byHandle, mappings, nullDefault, undefined, treeNodes)
            if (v !== undefined) doc[rootNode.key] = v
          }
        }
      } else if (Object.keys(mappings).length > 0) {
        // ── Fallback: usa i mapping configurati senza albero ──────
        doc = buildFromMappings(mappings, byHandle, nullDefault)
      } else {
        // ── Fallback finale: tutti i flussi come chiavi ───────────
        doc = {}
        byHandle.forEach((rows, handle) => {
          doc[handle === 'input' ? 'data' : handle] = rows
        })
      }

      const result = envelope ? { [envelope]: doc } : doc
      const json   = pretty ? JSON.stringify(result, null, 2) : JSON.stringify(result)

      context.callbacks.onLog('info',
        `JsonSerializer: ${Object.keys(doc).length} chiavi, ${json.length} car.`, node.id)

      return new Map([['output', [{ [outputField]: json }]]])

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      context.callbacks.onLog('warn', `JsonSerializer: errore — ${msg}`, node.id)
      switch (onError) {
        case 'reject': return new Map([['output', []], ['reject', [{ _json_error: msg }]]])
        case 'stop':   throw new Error(`JsonSerializer: ${msg}`)
        default:       return new Map([['output', [{ [outputField]: null }]]])
      }
    }
  },
}