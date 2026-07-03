/**
 * src/runner/unionExecutor.ts
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Normalizza una riga applicando la renameMap ──────────────────
function normalizeRow(
  row:          Row,
  allCols:      string[],
  missingField: string,
  renameMap:    Map<string, string>,
  handle:       string,
  sourceLabel?: string,
  sourceField?: string,
): Row {
  // Costruisce: nomeOriginale → nomeFinalizzato per questo handle
  const origToFinal = new Map<string, string>()
  for (const [k, v] of renameMap.entries()) {
    if (k.startsWith(`${handle}::`) && !k.startsWith('existing::')) {
      const orig = k.slice(handle.length + 2)
      origToFinal.set(orig, v)
    }
  }

  // Costruisce: nomeFinalizzato → nomeOriginale (inverso)
  const finalToOrig = new Map<string, string>()
  for (const [orig, final] of origToFinal.entries()) {
    finalToOrig.set(final, orig)
  }

  const out: Row = {}
  for (const finalCol of allCols) {
    const origCol = finalToOrig.get(finalCol)
    if (origCol !== undefined) {
      // Questo handle ha questo campo — scrivi il valore
      out[finalCol] = origCol in row ? row[origCol] : (missingField !== 'omit' ? null : undefined)
    } else {
      // Questo handle NON ha questo campo — metti null o ometti
      if (missingField !== 'omit') out[finalCol] = null
    }
    if (out[finalCol] === undefined) delete out[finalCol]
  }

  if (sourceField && sourceLabel !== undefined) out[sourceField] = sourceLabel
  return out
}

// ─── Executor ─────────────────────────────────────────────────────
export const unionExecutor: NodeExecutor = {
  handles: ['union'],
  requiresCompleteInput: () => true,

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props       = node.data.props ?? {}
    const p           = (k: string, d = '') => String(props[k] ?? d)
    const unionMode   = p('unionMode', 'concat')
    const missingField  = p('missingField', 'null')
    const zipMismatch   = p('zipMismatch', 'truncate')
    const addSource     = p('addSourceField', 'false') === 'true'
    const sourceField   = addSource ? p('sourceFieldName', '_union_source') : undefined
    const outputOrder   = p('outputOrder', 'natural')
    const orderField    = p('orderField', '')

    // ── Smista le righe per handle ────────────────────────────────
    // Completamente agnostico rispetto al nome dell'handle —
    // usa l'ordine di primo arrivo come discriminante
    const handleOrder: string[] = []
    const rowsByInput = new Map<string, Row[]>()

    for (const row of input) {
      const handle = ((row as any).__sourceHandle as string | undefined) ?? '__default'
      const clean  = { ...row }
      delete (clean as any).__sourceHandle

      if (!rowsByInput.has(handle)) {
        rowsByInput.set(handle, [])
        handleOrder.push(handle)
      }
      rowsByInput.get(handle)!.push(clean)
    }

    const orderedHandles = handleOrder

    if (orderedHandles.length === 0) {
      context.callbacks.onLog('warn', 'Union: nessuna riga in input', node.id)
      return new Map([['output', []]])
    }

    context.callbacks.onLog('info',
      `Union [${unionMode}]: ` +
      orderedHandles.map((h) => `${h}=${rowsByInput.get(h)!.length}`).join(', '),
      node.id,
    )

    // ── Schema unificato con rinomina duplicati ───────────────────
    const allColsSet   = new Set<string>()  // "nome::tipo" già visti
    const allNamesUsed = new Set<string>()  // nomi finali già usati
    const allColsOrdered: string[] = []
    const renameMap = new Map<string, string>()

    for (const [hIdx, handle] of orderedHandles.entries()) {
      const rows = rowsByInput.get(handle)!
      const handleSuffix = `_${hIdx + 1}`  // _1, _2, _3... indipendente dal nome

      const colsThisHandle = new Set<string>()
      for (const row of rows) {
        for (const key of Object.keys(row)) colsThisHandle.add(key)
      }

      for (const col of colsThisHandle) {
        const sampleVal  = rows.find((r) => col in r)?.[col]
        const sampleType = typeof sampleVal === 'number'  ? 'number'
                         : typeof sampleVal === 'boolean' ? 'boolean'
                         : 'string'
        const key = `${col}::${sampleType}`

        if (allColsSet.has(key)) {
          const existingFinal = renameMap.get(`existing::${key}`) ?? col
          renameMap.set(`${handle}::${col}`, existingFinal)
          continue
        }

        let finalName = col
        if (allNamesUsed.has(col)) {
          finalName = `${col}${handleSuffix}`
          let i = 2
          while (allNamesUsed.has(finalName)) finalName = `${col}${handleSuffix}_${i++}`
        }

        allColsSet.add(key)
        allNamesUsed.add(finalName)
        allColsOrdered.push(finalName)
        renameMap.set(`${handle}::${col}`, finalName)
        renameMap.set(`existing::${key}`, finalName)
      }
    }

    let result: Row[] = []

    // ── MODALITÀ CONCAT ───────────────────────────────────────────
    if (unionMode === 'concat') {
      for (const h of orderedHandles) {
        if (context.callbacks.isAborted()) break
        for (const row of rowsByInput.get(h)!) {
          result.push(normalizeRow(row, allColsOrdered, missingField, renameMap, h, h, sourceField))
        }
      }
    }

    // ── MODALITÀ MIX ─────────────────────────────────────────────
    else if (unionMode === 'mix') {
      const queues = orderedHandles.map((h) => ({ h, rows: [...rowsByInput.get(h)!] }))
      let hasMore = true
      while (hasMore) {
        hasMore = false
        for (const { h, rows } of queues) {
          if (context.callbacks.isAborted()) break
          if (rows.length > 0) {
            result.push(normalizeRow(rows.shift()!, allColsOrdered, missingField, renameMap, h, h, sourceField))
            hasMore = true
          }
        }
      }
    }

    // ── MODALITÀ ZIP ─────────────────────────────────────────────
    else if (unionMode === 'zip') {
      const queues  = orderedHandles.map((h) => rowsByInput.get(h)!)
      const lengths = queues.map((q) => q.length)
      const minLen  = Math.min(...lengths)
      const maxLen  = Math.max(...lengths)

      if (zipMismatch === 'error' && minLen !== maxLen) {
        throw new Error(`Union [zip]: flussi di lunghezza diversa. Usa truncate o pad_null.`)
      }

      const len = zipMismatch === 'truncate' ? minLen : maxLen
      for (let i = 0; i < len; i++) {
        if (context.callbacks.isAborted()) break
        const merged: Row = {}
        for (let qi = 0; qi < queues.length; qi++) {
          const row = queues[qi][i]
          if (row) {
            const h = orderedHandles[qi]
            Object.assign(merged, normalizeRow(row, allColsOrdered, 'omit', renameMap, h))
          } else if (zipMismatch === 'pad_null') {
            const sample = queues[qi][0]
            if (sample) {
              for (const key of Object.keys(sample)) {
                if (!(key in merged)) merged[key] = null
              }
            }
          }
        }
        result.push(merged)
      }
    }

    // ── Ordinamento ───────────────────────────────────────────────
    if (outputOrder !== 'natural' && orderField && result.length > 0) {
      const dir = outputOrder === 'field_asc' ? 1 : -1
      result.sort((a, b) => {
        const av = a[orderField], bv = b[orderField]
        if (av == null) return dir
        if (bv == null) return -dir
        return av < bv ? -dir : av > bv ? dir : 0
      })
    }

    context.callbacks.onLog('info', `Union: ${result.length} righe in output`, node.id)
    return new Map([['output', result]])
  },
}