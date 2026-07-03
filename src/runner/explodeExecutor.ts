/**
 * src/runner/explodeExecutor.ts
 * ──────────────────────────────
 * Executor per il nodo Explode.
 * Aggiungere in executors.ts:
 *   import { explodeExecutor } from './explodeExecutor'
 *   // e in EXECUTORS[]: explodeExecutor
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Applica trasformazione su un valore ──────────────────────────
function applyTransform(val: unknown, transform: string): unknown {
  const str = String(val ?? '')
  switch (transform) {
    case 'trim':          return str.trim()
    case 'uppercase':     return str.toUpperCase()
    case 'lowercase':     return str.toLowerCase()
    case 'to_int':        return parseInt(str, 10)
    case 'to_float':      return parseFloat(str)
    case 'to_string':     return str
    case 'to_bool':       return ['true','1','yes','si','sì'].includes(str.toLowerCase())
    case 'to_date':       return new Date(str).toISOString().split('T')[0]
    case 'nullify_empty': return str.trim() === '' ? null : val
    default:              return val
  }
}

// ─── Applica mapping ai campi esplosi ────────────────────────────
function applyMapping(
  row:     Row,
  mapping: Array<{ sourceField: string; outputName: string; type: string; transform: string; include: boolean }>,
): Row {
  if (mapping.length === 0) return row
  const out: Row = {}
  for (const field of mapping) {
    if (!field.include) continue
    const src = field.sourceField || field.outputName
    const val = src in row ? row[src] : null
    out[field.outputName] = applyTransform(val, field.transform)
  }
  return out
}

// ─── Esplodi una struttura in righe ──────────────────────────────
function explodeStructure(
  data:          unknown,
  structureType: string,
  jsonPath:      string,
): Row[] {
  if (data === null || data === undefined) return []

  switch (structureType) {
    case 'array': {
      if (!Array.isArray(data)) {
        // prova a parsare se è stringa
        if (typeof data === 'string') {
          try { return explodeStructure(JSON.parse(data), structureType, jsonPath) } catch {}
        }
        return []
      }
      return data.map((item) =>
        typeof item === 'object' && item !== null ? item as Row : { value: item }
      )
    }

    case 'object_values': {
      if (typeof data !== 'object' || Array.isArray(data) || data === null) return []
      return Object.values(data as Record<string, unknown>).map((v) =>
        typeof v === 'object' && v !== null ? v as Row : { value: v }
      )
    }

    case 'object_entries': {
      if (typeof data !== 'object' || Array.isArray(data) || data === null) return []
      return Object.entries(data as Record<string, unknown>).map(([key, value]) => ({ key, value }))
    }

    case 'json_path': {
      // JSONPath semplificato — supporta $[*], $.field, $.field[*]
      if (typeof data === 'string') {
        try { data = JSON.parse(data) } catch { return [] }
      }
      const path = (jsonPath || '$[*]').replace(/^\$\.?/, '')
      if (!path || path === '[*]') {
        return explodeStructure(data, 'array', '')
      }
      // Naviga il path
      const parts = path.split('.').filter(Boolean)
      let current: unknown = data
      for (const part of parts) {
        const m = part.match(/^(\w+)\[\*\]$/)
        if (m) {
          // es: items[*] — accedi al campo e poi esplodi
          if (typeof current === 'object' && current !== null) {
            current = (current as Record<string, unknown>)[m[1]]
          }
          return explodeStructure(current, 'array', '')
        }
        if (part === '[*]') {
          return explodeStructure(current, 'array', '')
        }
        if (typeof current === 'object' && current !== null) {
          current = (current as Record<string, unknown>)[part]
        } else {
          return []
        }
      }
      return explodeStructure(current, 'array', '')
    }

    default:
      return explodeStructure(data, 'array', jsonPath)
  }
}

export const explodeExecutor: NodeExecutor = {
  handles: ['explode'],
  requiresCompleteInput: (node) => {
    const source = (node.data.props?.['explodeSource'] as string) ?? 'materialize'
    return source === 'materialize'
  },

  async execute(node: FlowNode<NodeData>, input: Row[], context: ExecutionContext) {
    const props = node.data.props ?? {}

    const source        = (props['explodeSource']  as string) ?? 'materialize'
    const structureType = (props['structureType']  as string) ?? 'array'
    const jsonPath      = (props['jsonPath']        as string) ?? '$[*]'
    const onEmpty       = (props['onEmpty']         as string) ?? 'skip'
    const onPrimitive   = (props['onPrimitive']     as string) ?? 'wrap'
    const includeParent = (props['includeParent']   as string) === 'true'
    const limitStr      = (props['limit']           as string) ?? '0'
    const limit         = parseInt(limitStr, 10)

    // Mapping configurato nel MappingPanel
    let mapping: Array<{ sourceField: string; outputName: string; type: string; transform: string; include: boolean }> = []
    try {
      const raw = props['explodeMapping'] as string | undefined
      if (raw) mapping = JSON.parse(raw)
    } catch {}

    const result: Row[] = []

    // ── Sorgente: Materialize ─────────────────────────────────────
    if (source === 'materialize') {
      const matName = (props['materializeName'] as string) ?? ''
      if (!matName) {
        context.callbacks.onLog('warn', 'Explode: nessun Materialize configurato', node.id)
        return new Map([['output', []]])
      }

      const dataset = context.materialize.get(matName)
      if (!dataset || dataset.length === 0) {
        context.callbacks.onLog('warn', `Explode: Materialize '${matName}' vuoto o non ancora eseguito`, node.id)
        if (onEmpty === 'error') throw new Error(`Explode: Materialize '${matName}' vuoto`)
        return new Map([['output', onEmpty === 'null_row' ? [{}] : []]])
      }

      context.callbacks.onLog('info', `Explode da Materialize '${matName}': ${dataset.length} righe`, node.id)

      for (const row of dataset) {
        const mapped = mapping.length > 0 ? applyMapping(row, mapping) : row
        result.push(mapped)
      }
    }

    // ── Sorgente: Variabile Lane ──────────────────────────────────
    else if (source === 'lane_var') {
      const varName = (props['laneVarName'] as string) ?? ''
      context.callbacks.onLog('warn', `Explode: variabili lane '${varName}' non disponibili a runtime locale`, node.id)
      return new Map([['output', []]])
    }

    // ── Sorgente: Campo Flusso ────────────────────────────────────
    else if (source === 'flow_field') {
      const fieldName = (props['flowField'] as string) ?? ''
      if (!fieldName) {
        context.callbacks.onLog('warn', 'Explode: campo flusso non configurato', node.id)
        return new Map([['output', input]])
      }

      for (const parentRow of input) {
        const fieldData = parentRow[fieldName]

        if (fieldData === null || fieldData === undefined) {
          if (onEmpty === 'error') throw new Error(`Explode: campo '${fieldName}' è null nella riga`)
          if (onEmpty === 'null_row') result.push(includeParent ? { ...parentRow } : {})
          continue  // skip
        }

        const exploded = explodeStructure(fieldData, structureType, jsonPath)

        if (exploded.length === 0) {
          if (onEmpty === 'error') throw new Error(`Explode: campo '${fieldName}' produce struttura vuota`)
          if (onEmpty === 'null_row') result.push(includeParent ? { ...parentRow } : {})
          continue
        }

        for (const item of exploded) {
          // Gestione primitivi
          const itemRow: Row = (typeof item === 'object' && item !== null)
            ? item as Row
            : onPrimitive === 'wrap'
              ? { value: item }
              : onPrimitive === 'skip'
                ? null as unknown as Row
                : (() => { throw new Error(`Explode: elemento primitivo in '${fieldName}'`) })()

          if (itemRow === null) continue

          // Merge con padre: padre + campi esplosi (esplosi vincono su conflitti)
          const merged: Row = includeParent
            ? { ...parentRow, ...itemRow }
            : { ...itemRow }

          // Rimuovi il campo esploso dal record finale se includi il padre
          if (includeParent) delete merged[fieldName]

          const mapped = mapping.length > 0 ? applyMapping(merged, mapping) : merged
          result.push(mapped)
        }
      }
    }

    // Applica limite
    const output = limit > 0 ? result.slice(0, limit) : result

    context.callbacks.onLog(
      'info',
      `Explode: ${output.length} righe prodotte${limit > 0 && result.length > limit ? ` (limite ${limit} applicato su ${result.length})` : ''}`,
      node.id
    )

    return new Map([['output', output]])
  },
}
