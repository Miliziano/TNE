/**
 * src/runner/pivotExecutor.ts
 *
 * Executor per il nodo pivot/unpivot.
 *
 * Modalità PIVOT (righe → colonne):
 *   - Legge campo identità (GROUP BY), campo pivot, campo valore
 *   - Statico: colonne predefinite dall'utente
 *   - Dinamico: colonne dai valori distinti a runtime
 *   - Funzioni aggregazione: sum, count, avg, max, min, first, last
 *
 * Modalità UNPIVOT (colonne → righe):
 *   - Colonne selezionate diventano coppie chiave/valore
 *   - Colonne non selezionate rimangono fisse
 *
 * Sorgente dati:
 *   - 'flow': righe in ingresso normali
 *   - 'materialize': legge da context.materialize (la riga in ingresso è trigger)
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Funzioni di aggregazione ─────────────────────────────────────
function aggregate(values: unknown[], fn: string): unknown {
  const nums = values
    .filter((v) => v !== null && v !== undefined && !isNaN(Number(v)))
    .map(Number)

  switch (fn) {
    case 'sum':   return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) : null
    case 'count': return values.filter((v) => v !== null && v !== undefined).length
    case 'avg':   return nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null
    case 'max':   return nums.length > 0 ? Math.max(...nums) : null
    case 'min':   return nums.length > 0 ? Math.min(...nums) : null
    case 'first': return values.find((v) => v !== null && v !== undefined) ?? null
    case 'last': {
      const nonNull = values.filter((v) => v !== null && v !== undefined)
      return nonNull.length > 0 ? nonNull[nonNull.length - 1] : null
    }
    default: return null
  }
}

// ─── Pivot ────────────────────────────────────────────────────────
function executePivot(
  rows:           Row[],
  identityFields: string[],
  pivotField:     string,
  valueField:     string,
  aggFn:          string,
  nullValue:      unknown,
  pivotColumns:   Array<{ id: string; value: string; alias: string }>,
  pivotType:      string,
  addRowTotal:    boolean,
): Row[] {

  if (!pivotField || !valueField) return rows

  // Raggruppa per chiave identità
  const groups = new Map<string, Row[]>()

  for (const row of rows) {
    const key = identityFields.map((f) => String(row[f] ?? '')).join('\x00')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }

  // Determina le colonne pivot
  let colDefs: Array<{ pivotValue: string; colName: string }>

  if (pivotType === 'dynamic') {
    // Raccoglie tutti i valori distinti del campo pivot
    const distinct = new Set<string>()
    for (const row of rows) {
      const val = row[pivotField]
      if (val !== null && val !== undefined) distinct.add(String(val))
    }
    colDefs = Array.from(distinct).sort().map((v) => ({ pivotValue: v, colName: v }))
  } else {
    colDefs = pivotColumns.map((c) => ({
      pivotValue: c.value,
      colName:    c.alias || c.value,
    }))
  }

  const result: Row[] = []

  for (const [key, groupRows] of groups) {
    // Ricostruisce i campi identità dalla prima riga del gruppo
    const firstRow = groupRows[0]
    const outRow: Row = {}

    for (const f of identityFields) {
      outRow[f] = firstRow[f] ?? null
    }

    // Per ogni colonna pivot, aggrega i valori
    let rowTotal = 0
    for (const col of colDefs) {
      const matchingValues = groupRows
        .filter((r) => String(r[pivotField] ?? '') === col.pivotValue)
        .map((r) => r[valueField])

      const val = matchingValues.length > 0
        ? aggregate(matchingValues, aggFn)
        : nullValue

      outRow[col.colName] = val ?? nullValue
      if (addRowTotal && typeof val === 'number') rowTotal += val
    }

    if (addRowTotal) outRow['_totale'] = rowTotal

    result.push(outRow)
  }

  return result
}

// ─── Unpivot ──────────────────────────────────────────────────────
function executeUnpivot(
  rows:           Row[],
  unpivotCols:    string[],
  keyFieldName:   string,
  valueFieldName: string,
  nullMode:       string,
): Row[] {

  if (unpivotCols.length === 0) return rows

  const result: Row[] = []

  for (const row of rows) {
    // Campi fissi (non ruotati)
    const fixedFields: Row = {}
    for (const [k, v] of Object.entries(row)) {
      if (!unpivotCols.includes(k)) fixedFields[k] = v
    }

    // Genera una riga per ogni colonna da ruotare
    for (const col of unpivotCols) {
      const val = row[col]

      // Gestisci null
      if (val === null || val === undefined) {
        if (nullMode === 'exclude') continue
        if (nullMode === 'zero')    {
          result.push({ ...fixedFields, [keyFieldName]: col, [valueFieldName]: 0 })
          continue
        }
      }

      result.push({
        ...fixedFields,
        [keyFieldName]:   col,
        [valueFieldName]: val ?? null,
      })
    }
  }

  return result
}

// ─── Executor ─────────────────────────────────────────────────────
export const pivotExecutor: NodeExecutor = {
  handles: ['pivot'],
  requiresCompleteInput: () => true,

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const p = (key: string, def = '') =>
      String(node.data.props?.[key] ?? def)

    const mode       = p('pivotMode',  'pivot')
    const dataSource = p('dataSource', 'flow')
    const matName    = p('materializeName', '')

    // ── Sorgente dati ─────────────────────────────────────────────
    let rows: Row[]

    if (dataSource === 'materialize') {
      if (!matName) {
        context.callbacks.onLog('warn', 'Pivot: Materialize non configurato', node.id)
        return new Map([['output', []]])
      }
      const matData = context.materialize.get(matName)
      if (!matData) {
        context.callbacks.onLog('warn', `Pivot: Materialize '${matName}' non trovato o vuoto`, node.id)
        return new Map([['output', []]])
      }
      rows = matData
      context.callbacks.onLog('info', `Pivot: leggo ${rows.length} righe da Materialize '${matName}'`, node.id)
    } else {
      rows = input
    }

    if (rows.length === 0) {
      context.callbacks.onLog('warn', 'Pivot: nessuna riga in ingresso', node.id)
      return new Map([['output', []]])
    }

    // ── PIVOT ─────────────────────────────────────────────────────
    if (mode === 'pivot') {
      const identityFields = p('identityField')
        .split(',').map((s) => s.trim()).filter(Boolean)
      const pivotField  = p('pivotField')
      const valueField  = p('valueField')
      const aggFn       = p('aggFn', 'sum')
      const nullValue   = p('nullValue', '0')
      const pivotType   = p('pivotType', 'static')
      const addRowTotal = p('addRowTotal', 'false') === 'true'

      let pivotColumns: Array<{ id: string; value: string; alias: string }> = []
      try { pivotColumns = JSON.parse(p('pivotColumns', '[]')) } catch {}

      if (!pivotField) {
        context.callbacks.onLog('warn', 'Pivot: campo pivot non configurato', node.id)
        return new Map([['output', rows]])
      }
      if (!valueField) {
        context.callbacks.onLog('warn', 'Pivot: campo valore non configurato', node.id)
        return new Map([['output', rows]])
      }

      // Valore null numerico o stringa
      const nullVal = nullValue === '' ? null
        : isNaN(Number(nullValue)) ? nullValue
        : Number(nullValue)

      const result = executePivot(
        rows, identityFields, pivotField, valueField,
        aggFn, nullVal, pivotColumns, pivotType, addRowTotal,
      )

      context.callbacks.onLog('info',
        `Pivot: ${rows.length} righe → ${result.length} righe (${identityFields.length > 0 ? identityFields.join(', ') : 'nessuna identità'} · pivot su '${pivotField}' · ${aggFn.toUpperCase()}(${valueField}))`,
        node.id,
      )

      return new Map([['output', result]])
    }

    // ── UNPIVOT ───────────────────────────────────────────────────
    if (mode === 'unpivot') {
      let unpivotCols: string[] = []
      try { unpivotCols = JSON.parse(p('unpivotColumns', '[]')) } catch {}

      const keyFieldName   = p('unpivotKeyField',   'chiave')
      const valueFieldName = p('unpivotValueField', 'valore')
      const nullMode       = p('unpivotNullMode',   'exclude')

      if (unpivotCols.length === 0) {
        context.callbacks.onLog('warn', 'Unpivot: nessuna colonna selezionata da ruotare', node.id)
        return new Map([['output', rows]])
      }

      const result = executeUnpivot(
        rows, unpivotCols, keyFieldName, valueFieldName, nullMode,
      )

      context.callbacks.onLog('info',
        `Unpivot: ${rows.length} righe × ${unpivotCols.length} colonne → ${result.length} righe`,
        node.id,
      )

      return new Map([['output', result]])
    }

    context.callbacks.onLog('warn', `Pivot: modalità '${mode}' non riconosciuta`, node.id)
    return new Map([['output', rows]])
  },
}
