/**
 * src/runner/windowExecutor.ts
 *
 * Executor per il nodo window function.
 *
 * Per ogni funzione window configurata, aggiunge un campo calcolato
 * a ogni riga mantenendo invariati i campi originali.
 *
 * Supporta:
 *   Ranking:    row_number, rank, dense_rank, percent_rank, cume_dist, ntile, topn_flag
 *   Navigation: lag, lead, first_value, last_value, nth_value
 *   Cumulative: cumsum, cumcount, cumprod
 *   Analytical: moving_avg, moving_sum, moving_min, moving_max, moving_stddev,
 *               ratio_to_report, delta
 *   ETL:        change_detect, sessionize, streak, interpolate
 *
 * Sorgente: 'flow' (input diretto) o 'materialize' (context.materialize)
 */

import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

interface WindowDef {
  id:          string
  fn:          string
  field?:      string
  offset?:     number
  n?:          number
  expr?:       string
  outputField: string
  nullDefault: string
}

// ─── Ordina le righe ──────────────────────────────────────────────
function sortRows(rows: Row[], orderBy: string, orderDir: string): Row[] {
  if (!orderBy) return rows
  return [...rows].sort((a, b) => {
    const va = a[orderBy], vb = b[orderBy]
    if (va === null || va === undefined) return 1
    if (vb === null || vb === undefined) return -1
    const cmp = String(va) < String(vb) ? -1 : String(va) > String(vb) ? 1 : 0
    return orderDir === 'desc' ? -cmp : cmp
  })
}

// ─── Raggruppa per partizione ─────────────────────────────────────
function groupByPartition(rows: Row[], partitionFields: string[]): Map<string, Row[]> {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = partitionFields.length === 0
      ? '__all__'
      : partitionFields.map((f) => String(row[f] ?? '')).join('\x00')
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key)!.push(row)
  }
  return groups
}

// ─── Calcola finestre su un gruppo già ordinato ───────────────────
function computeWindows(rows: Row[], windows: WindowDef[]): Row[] {
  const n = rows.length
  // Risultato: copia di ogni riga con i campi window aggiunti
  const result: Row[] = rows.map((r) => ({ ...r }))

  for (const win of windows) {
    const outField = win.outputField || `win_${win.fn}`
    const srcField = win.field ?? ''
    const offset   = win.offset ?? 1
    const winN     = win.n ?? 3

    switch (win.fn) {

      // ── Ranking ────────────────────────────────────────────────
      case 'row_number':
        result.forEach((r, i) => { r[outField] = i + 1 })
        break

      case 'rank': {
        // Rank con salti — basato su orderBy (i valori sono già ordinati)
        let rank = 1
        result.forEach((r, i) => {
          if (i === 0) { r[outField] = 1; return }
          const prev = result[i - 1]
          if (rows[i][srcField || ''] !== rows[i - 1][srcField || '']) rank = i + 1
          r[outField] = rank
        })
        break
      }

      case 'dense_rank': {
        let drank = 1
        result.forEach((r, i) => {
          if (i === 0) { r[outField] = 1; return }
          if (rows[i][srcField || ''] !== rows[i - 1][srcField || '']) drank++
          r[outField] = drank
        })
        break
      }

      case 'percent_rank':
        result.forEach((r, i) => {
          r[outField] = n <= 1 ? 0 : i / (n - 1)
        })
        break

      case 'cume_dist':
        result.forEach((r, i) => {
          r[outField] = (i + 1) / n
        })
        break

      case 'ntile':
        result.forEach((r, i) => {
          r[outField] = Math.floor(i * winN / n) + 1
        })
        break

      case 'topn_flag':
        result.forEach((r, i) => {
          r[outField] = i < winN
        })
        break

      // ── Navigation ─────────────────────────────────────────────
      case 'lag':
        result.forEach((r, i) => {
          const lagIdx = i - offset
          r[outField] = lagIdx >= 0
            ? (rows[lagIdx][srcField] ?? win.nullDefault ?? null)
            : (win.nullDefault ?? null)
        })
        break

      case 'lead':
        result.forEach((r, i) => {
          const leadIdx = i + offset
          r[outField] = leadIdx < n
            ? (rows[leadIdx][srcField] ?? win.nullDefault ?? null)
            : (win.nullDefault ?? null)
        })
        break

      case 'first_value': {
        const firstVal = rows.find((r) => r[srcField] !== null && r[srcField] !== undefined)?.[srcField] ?? null
        result.forEach((r) => { r[outField] = firstVal })
        break
      }

      case 'last_value': {
        const lastVal = [...rows].reverse().find((r) => r[srcField] !== null && r[srcField] !== undefined)?.[srcField] ?? null
        result.forEach((r) => { r[outField] = lastVal })
        break
      }

      case 'nth_value': {
        const nthVal = rows[winN - 1]?.[srcField] ?? null
        result.forEach((r) => { r[outField] = nthVal })
        break
      }

      // ── Cumulative ─────────────────────────────────────────────
      case 'cumsum': {
        let acc = 0
        result.forEach((r, i) => {
          const v = Number(rows[i][srcField] ?? 0)
          if (!isNaN(v)) acc += v
          r[outField] = acc
        })
        break
      }

      case 'cumcount': {
        let cnt = 0
        result.forEach((r, i) => {
          if (rows[i][srcField] !== null && rows[i][srcField] !== undefined) cnt++
          r[outField] = cnt
        })
        break
      }

      case 'cumprod': {
        let prod = 1
        result.forEach((r, i) => {
          const v = Number(rows[i][srcField] ?? 1)
          if (!isNaN(v)) prod *= v
          r[outField] = prod
        })
        break
      }

      // ── Analytical / Moving ────────────────────────────────────
      case 'moving_avg':
        result.forEach((r, i) => {
          const start = Math.max(0, i - winN + 1)
          const window = rows.slice(start, i + 1)
          const nums = window.map((w) => Number(w[srcField])).filter((v) => !isNaN(v))
          r[outField] = nums.length > 0 ? nums.reduce((a, b) => a + b, 0) / nums.length : null
        })
        break

      case 'moving_sum':
        result.forEach((r, i) => {
          const start = Math.max(0, i - winN + 1)
          const window = rows.slice(start, i + 1)
          const nums = window.map((w) => Number(w[srcField])).filter((v) => !isNaN(v))
          r[outField] = nums.reduce((a, b) => a + b, 0)
        })
        break

      case 'moving_min':
        result.forEach((r, i) => {
          const start = Math.max(0, i - winN + 1)
          const window = rows.slice(start, i + 1)
          const nums = window.map((w) => Number(w[srcField])).filter((v) => !isNaN(v))
          r[outField] = nums.length > 0 ? Math.min(...nums) : null
        })
        break

      case 'moving_max':
        result.forEach((r, i) => {
          const start = Math.max(0, i - winN + 1)
          const window = rows.slice(start, i + 1)
          const nums = window.map((w) => Number(w[srcField])).filter((v) => !isNaN(v))
          r[outField] = nums.length > 0 ? Math.max(...nums) : null
        })
        break

      case 'moving_stddev':
        result.forEach((r, i) => {
          const start = Math.max(0, i - winN + 1)
          const window = rows.slice(start, i + 1)
          const nums = window.map((w) => Number(w[srcField])).filter((v) => !isNaN(v))
          if (nums.length < 2) { r[outField] = null; return }
          const avg = nums.reduce((a, b) => a + b, 0) / nums.length
          const variance = nums.reduce((a, b) => a + (b - avg) ** 2, 0) / (nums.length - 1)
          r[outField] = Math.sqrt(variance)
        })
        break

      case 'ratio_to_report': {
        const total = rows.reduce((acc, r) => {
          const v = Number(r[srcField] ?? 0)
          return acc + (isNaN(v) ? 0 : v)
        }, 0)
        result.forEach((r, i) => {
          const v = Number(rows[i][srcField] ?? 0)
          r[outField] = total !== 0 ? v / total : null
        })
        break
      }

      case 'delta':
        result.forEach((r, i) => {
          if (i === 0) { r[outField] = null; return }
          const curr = Number(rows[i][srcField] ?? 0)
          const prev = Number(rows[i - 1][srcField] ?? 0)
          r[outField] = isNaN(curr) || isNaN(prev) ? null : curr - prev
        })
        break

      // ── ETL ────────────────────────────────────────────────────
      case 'change_detect':
        result.forEach((r, i) => {
          if (i === 0) { r[outField] = false; return }
          r[outField] = rows[i][srcField] !== rows[i - 1][srcField]
        })
        break

      case 'sessionize': {
        // winN = gap massimo in secondi
        let sessionId = 1
        result.forEach((r, i) => {
          if (i === 0) { r[outField] = `S${sessionId}`; return }
          const curr = new Date(String(rows[i][srcField] ?? '')).getTime()
          const prev = new Date(String(rows[i - 1][srcField] ?? '')).getTime()
          if (!isNaN(curr) && !isNaN(prev) && (curr - prev) / 1000 > winN) sessionId++
          r[outField] = `S${sessionId}`
        })
        break
      }

      case 'streak': {
        // expr: condizione JavaScript come "amount > 0"
        const expr = win.expr ?? 'true'
        let streak = 0
        result.forEach((r, i) => {
          try {
            // eslint-disable-next-line no-new-func
            const cond = new Function('row', `return !!(${expr})`)(rows[i])
            streak = cond ? streak + 1 : 0
          } catch { streak = 0 }
          r[outField] = streak
        })
        break
      }

      case 'interpolate': {
        // Riempie null interpolando linearmente tra il valore precedente e successivo
        const values = rows.map((r) => {
          const v = Number(r[srcField])
          return isNaN(v) ? null : v
        })
        result.forEach((r, i) => {
          if (values[i] !== null) { r[outField] = values[i]; return }
          // Cerca precedente e successivo non-null
          let prevIdx = i - 1, nextIdx = i + 1
          while (prevIdx >= 0 && values[prevIdx] === null) prevIdx--
          while (nextIdx < n && values[nextIdx] === null) nextIdx++
          if (prevIdx < 0 && nextIdx >= n) { r[outField] = null; return }
          if (prevIdx < 0) { r[outField] = values[nextIdx]; return }
          if (nextIdx >= n) { r[outField] = values[prevIdx]; return }
          // Interpolazione lineare
          const ratio = (i - prevIdx) / (nextIdx - prevIdx)
          r[outField] = values[prevIdx]! + ratio * (values[nextIdx]! - values[prevIdx]!)
        })
        break
      }

      default:
        result.forEach((r) => { r[outField] = null })
    }
  }

  return result
}

// ─── Executor ─────────────────────────────────────────────────────
export const windowExecutor: NodeExecutor = {
  handles: ['window'],
  requiresCompleteInput: () => true,

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)

    const dataSource     = p('dataSource', 'flow')
    const matName        = p('materializeName', '')
    const orderBy        = p('orderBy', '')
    const orderDir       = p('orderDir', 'asc')
    const partitionBy    = p('partitionBy', '')
    const partitionFields = partitionBy
      ? partitionBy.split(',').map((s) => s.trim()).filter(Boolean)
      : []

    let windows: WindowDef[] = []
    try { windows = JSON.parse(p('windows', '[]')) } catch {}

    if (windows.length === 0) {
      context.callbacks.onLog('warn', 'Window: nessuna funzione configurata — passthrough', node.id)
      return new Map([['output', input]])
    }

    // ── Sorgente dati ──────────────────────────────────────────────
    let rows: Row[]

    if (dataSource === 'materialize') {
      if (!matName) {
        context.callbacks.onLog('warn', 'Window: Materialize non configurato', node.id)
        return new Map([['output', []]])
      }
      const matData = context.materialize.get(matName)
      if (!matData) {
        context.callbacks.onLog('warn', `Window: Materialize '${matName}' non trovato o vuoto`, node.id)
        return new Map([['output', []]])
      }
      rows = matData
      context.callbacks.onLog('info', `Window: leggo ${rows.length} righe da Materialize '${matName}'`, node.id)
    } else {
      rows = input
    }

    if (rows.length === 0) {
      context.callbacks.onLog('warn', 'Window: nessuna riga in ingresso', node.id)
      return new Map([['output', []]])
    }

    // ── Raggruppa per partizione, ordina, calcola ──────────────────
    const groups  = groupByPartition(rows, partitionFields)
    const result: Row[] = []

    for (const groupRows of groups.values()) {
      const sorted    = sortRows(groupRows, orderBy, orderDir)
      const computed  = computeWindows(sorted, windows)
      result.push(...computed)
    }

    const fnNames = windows.map((w) => `${w.fn}→${w.outputField}`).join(', ')
    context.callbacks.onLog('info',
      `Window: ${rows.length} righe · ${groups.size} partizioni · ${windows.length} funzioni [${fnNames}]`,
      node.id,
    )

    return new Map([['output', result]])
  },
}
