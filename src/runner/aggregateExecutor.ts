/**
 * src/runner/aggregateExecutor.ts
 * ────────────────────────────────
 * Executor per il nodo Aggregate.
 * Aggiungere in executors.ts:
 *   import { aggregateExecutor } from './aggregateExecutor'
 *   // e in EXECUTORS[]: aggregateExecutor
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

interface AggFunction {
  id:         string
  field:      string
  fn:         string
  alias:      string
  filter:     string
  separator?: string
}

// ─── Chiave gruppo da una riga ────────────────────────────────────
function groupKey(row: Row, fields: string[]): string {
  return fields.map((f) => {
    const v = row[f]
    return v === null || v === undefined ? '__null__' : String(v)
  }).join('\x00')  // separatore non-printable per evitare collisioni
}

// ─── Applica filtro FILTER WHERE su una riga ─────────────────────
// Supporto semplice: campo operatore valore (AND implicito)
// Es: "status = 'active'", "amount > 100"
function matchesFilter(row: Row, filter: string): boolean {
  if (!filter.trim()) return true
  try {
    // Usa Function per valutare espressioni JS-like
    // Converte SQL-like in JS: = → ===, <> → !==, IS NULL → == null
    const expr = filter
      .replace(/\bIS\s+NULL\b/gi,     '== null')
      .replace(/\bIS\s+NOT\s+NULL\b/gi,'!= null')
      .replace(/\bAND\b/gi,           '&&')
      .replace(/\bOR\b/gi,            '||')
      .replace(/\bNOT\b/gi,           '!')
      .replace(/<>/g,                  '!==')
      .replace(/(?<![<>!])=(?!=)/g,   '===')
      .replace(/\b(\w+)\b/g, (m) => {
        // Se è un campo della riga, rimpiazza con il valore
        if (m in row) return `row["${m}"]`
        // Se è una keyword JS, lascia invariato
        if (['null','undefined','true','false','&&','||','!'].includes(m)) return m
        return m
      })
    // eslint-disable-next-line no-new-func
    return !!(new Function('row', `return !!(${expr})`)(row))
  } catch {
    return true  // in caso di errore di parsing, include la riga
  }
}

// ─── Calcola una funzione di aggregazione su un gruppo ────────────
function calcAgg(rows: Row[], agg: AggFunction): unknown {
  // Filtra righe se c'è un filtro FILTER WHERE
  const filtered = agg.filter
    ? rows.filter((r) => matchesFilter(r, agg.filter))
    : rows

  const vals = filtered.map((r) => r[agg.field])
  const nums = vals.map(Number).filter((n) => !isNaN(n))

  switch (agg.fn) {
    case 'count':
      return filtered.length

    case 'count_distinct': {
      const unique = new Set(vals.map((v) => (v === null || v === undefined ? '__null__' : String(v))))
      return unique.size
    }

    case 'sum':
      return nums.reduce((a, b) => a + b, 0)

    case 'avg':
      return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null

    case 'min': {
      if (vals.length === 0) return null
      // Prova numerico, fallback stringa
      if (nums.length === vals.filter((v) => v !== null && v !== undefined).length && nums.length > 0) {
        return Math.min(...nums)
      }
      return vals.filter((v) => v !== null && v !== undefined).sort()[0] ?? null
    }

    case 'max': {
      if (vals.length === 0) return null
      if (nums.length === vals.filter((v) => v !== null && v !== undefined).length && nums.length > 0) {
        return Math.max(...nums)
      }
      const sorted = vals.filter((v) => v !== null && v !== undefined).sort()
      return sorted[sorted.length - 1] ?? null
    }

    case 'first':
      return filtered.length > 0 ? filtered[0][agg.field] ?? null : null

    case 'last':
      return filtered.length > 0 ? filtered[filtered.length - 1][agg.field] ?? null : null

    case 'std_dev': {
      if (nums.length < 2) return null
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length
      const variance = nums.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / nums.length
      return Math.sqrt(variance)
    }

    case 'variance': {
      if (nums.length < 2) return null
      const mean = nums.reduce((a, b) => a + b, 0) / nums.length
      return nums.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / nums.length
    }

    case 'median': {
      if (nums.length === 0) return null
      const sorted = [...nums].sort((a, b) => a - b)
      const mid    = Math.floor(sorted.length / 2)
      return sorted.length % 2 === 0
        ? (sorted[mid - 1] + sorted[mid]) / 2
        : sorted[mid]
    }

    case 'array_agg':
      return vals

    case 'string_agg': {
      const sep = agg.separator ?? ', '
      return vals.filter((v) => v !== null && v !== undefined).map(String).join(sep)
    }

    case 'json_agg':
      return vals

    default:
      return null
  }
}

// ─── Valuta condizione HAVING ─────────────────────────────────────
function matchesHaving(row: Row, having: string): boolean {
  if (!having.trim()) return true
  try {
    const expr = having
      .replace(/\bIS\s+NULL\b/gi,      '== null')
      .replace(/\bIS\s+NOT\s+NULL\b/gi, '!= null')
      .replace(/\bAND\b/gi,            '&&')
      .replace(/\bOR\b/gi,             '||')
      .replace(/\bNOT\b/gi,            '!')
      .replace(/<>/g,                   '!==')
      .replace(/(?<![<>!])=(?!=)/g,    '===')
      .replace(/\b(\w+)\b/g, (m) => {
        if (m in row) return `row["${m}"]`
        if (['null','undefined','true','false','&&','||','!'].includes(m)) return m
        return m
      })
    // eslint-disable-next-line no-new-func
    return !!(new Function('row', `return !!(${expr})`)(row))
  } catch {
    return true
  }
}

// ─── Ordina un array di righe ─────────────────────────────────────
// orderBy: "count DESC, region ASC"
function sortRows(rows: Row[], orderBy: string): Row[] {
  if (!orderBy.trim()) return rows

  const parts = orderBy.split(',').map((s) => {
    const tokens = s.trim().split(/\s+/)
    return {
      field: tokens[0],
      desc:  tokens[1]?.toUpperCase() === 'DESC',
    }
  }).filter((p) => p.field)

  return [...rows].sort((a, b) => {
    for (const { field, desc } of parts) {
      const av = a[field], bv = b[field]
      if (av === bv) continue
      if (av === null || av === undefined) return desc ? -1 : 1
      if (bv === null || bv === undefined) return desc ? 1 : -1
      const na = Number(av), nb = Number(bv)
      const cmp = !isNaN(na) && !isNaN(nb)
        ? na - nb
        : String(av).localeCompare(String(bv))
      return desc ? -cmp : cmp
    }
    return 0
  })
}

// ─── Executor ─────────────────────────────────────────────────────
export const aggregateExecutor: NodeExecutor = {
  handles: ['aggregate'],
  requiresCompleteInput: () => true,
  

  async execute(node: FlowNode<NodeData>, input: Row[], context: ExecutionContext) {
    const props = node.data.props ?? {}

    const dataSource  = (props['dataSource']  as string) ?? 'flow'
    const matName     = (props['materializeName'] as string) ?? ''
    const groupByRaw  = (props['group_by']    as string) ?? ''
    const havingExpr  = (props['having']      as string) ?? ''
    const orderByRaw  = (props['orderBy']     as string) ?? ''
    const limitStr    = (props['limit']       as string) ?? '0'
    const nullGroups  = (props['nullGroups']  as string) ?? 'include'
    const limit       = parseInt(limitStr, 10)

    let aggFunctions: AggFunction[] = []
    try { aggFunctions = JSON.parse((props['aggFunctions'] as string) ?? '[]') } catch {}

    // ── Sorgente dati ─────────────────────────────────────────────
    let dataset: Row[]

    if (dataSource === 'materialize') {
      if (!matName) {
        context.callbacks.onLog('warn', 'Aggregate: nessun Materialize configurato', node.id)
        return new Map([['output', []]])
      }
      const mat = context.materialize.get(matName)
      if (!mat || mat.length === 0) {
        context.callbacks.onLog('warn', `Aggregate: Materialize '${matName}' vuoto o non ancora eseguito`, node.id)
        return new Map([['output', []]])
      }
      dataset = mat
      context.callbacks.onLog('info', `Aggregate da Materialize '${matName}': ${dataset.length} righe`, node.id)
    } else {
      // Da flusso — usa le righe in ingresso
      dataset = input
      context.callbacks.onLog('info', `Aggregate da flusso: ${dataset.length} righe`, node.id)
    }

    if (dataset.length === 0) {
      return new Map([['output', []]])
    }

    // ── GROUP BY ──────────────────────────────────────────────────
    const groupByFields = groupByRaw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    // Raggruppa le righe
    const groups = new Map<string, Row[]>()
    const groupKeyToValues = new Map<string, Row>()  // chiave → valori campi GROUP BY

    for (const row of dataset) {
      // Gestione null nei campi di raggruppamento
      if (nullGroups === 'exclude') {
        const hasNull = groupByFields.some((f) => row[f] === null || row[f] === undefined)
        if (hasNull) continue
      }

      const key = groupByFields.length > 0 ? groupKey(row, groupByFields) : '__all__'

      if (!groups.has(key)) {
        groups.set(key, [])
        // Salva i valori dei campi GROUP BY per questo gruppo
        const gbVals: Row = {}
        for (const f of groupByFields) gbVals[f] = row[f] ?? null
        groupKeyToValues.set(key, gbVals)
      }
      groups.get(key)!.push(row)
    }

    context.callbacks.onLog('debug', `Aggregate: ${groups.size} gruppi`, node.id)

    // ── Calcola funzioni per ogni gruppo ──────────────────────────
    let result: Row[] = []

    for (const [key, rows] of groups) {
      const outRow: Row = {}

      // Campi GROUP BY
      const gbVals = groupKeyToValues.get(key) ?? {}
      for (const f of groupByFields) {
        outRow[f] = gbVals[f]
      }

      // Funzioni di aggregazione
      for (const agg of aggFunctions) {
        const alias = agg.alias || `${agg.fn}_result`
        try {
          outRow[alias] = calcAgg(rows, agg)
        } catch (e) {
          context.callbacks.onLog('warn', `Aggregate: errore in ${agg.fn}(${agg.field}): ${e}`, node.id)
          outRow[alias] = null
        }
      }

      result.push(outRow)
    }

    // ── HAVING ────────────────────────────────────────────────────
    if (havingExpr.trim()) {
      const before = result.length
      result = result.filter((row) => matchesHaving(row, havingExpr))
      context.callbacks.onLog('debug', `Aggregate HAVING: ${before} → ${result.length} gruppi`, node.id)
    }

    // ── ORDER BY ──────────────────────────────────────────────────
    if (orderByRaw.trim()) {
      result = sortRows(result, orderByRaw)
    }

    // ── LIMIT ─────────────────────────────────────────────────────
    if (limit > 0 && result.length > limit) {
      result = result.slice(0, limit)
    }

    context.callbacks.onLog(
      'info',
      `Aggregate: ${dataset.length} righe → ${result.length} gruppi`,
      node.id
    )

    return new Map([['output', result]])
  },
}
