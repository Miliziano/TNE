/**
 * src/runner/dataQualityExecutor.ts
 * ──────────────────────────────────
 * Executor per il nodo Data Quality.
 * Importare e aggiungere a EXECUTORS in executors.ts.
 *
 * Aggiungere in executors.ts:
 *   import { dataQualityExecutor } from './dataQualityExecutor'
 *   // e in EXECUTORS[]: dataQualityExecutor
 */

import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import type {
  DQRule, DQConfig, DQDimension, DQIssue, DQResult,
} from '../nodes/types/data_quality/dqTypes'
import { DEFAULT_DQ_CONFIG } from '../nodes/types/data_quality/dqTypes'
import { readFile } from '../lib/tauri'
import { readFileContent } from '../io/readers'

// ─── Cache lookup file ────────────────────────────────────────────
const _lookupCache = new Map<string, Map<string, string>>()

async function loadLookupFile(
  path:      string,
  keyField:  string,
  valField:  string,
): Promise<Map<string, string>> {
  const cacheKey = `${path}:${keyField}:${valField}`
  if (_lookupCache.has(cacheKey)) return _lookupCache.get(cacheKey)!

  try {
    const content = await readFile(path)
    const rows    = await readFileContent(content, path.split('/').pop() ?? path)
    const map     = new Map<string, string>()
    for (const row of rows) {
      const k = String(row[keyField] ?? '')
      const v = String(row[valField] ?? '')
      if (k) map.set(k, v)
    }
    _lookupCache.set(cacheKey, map)
    return map
  } catch {
    return new Map()
  }
}

// ─── Check ────────────────────────────────────────────────────────
function runCheck(row: Row, rule: DQRule, context: ExecutionContext): boolean {
  const val = row[rule.field]
  const str = String(val ?? '')

  switch (rule.checkType) {
    case 'not_null':    return val !== null && val !== undefined
    case 'not_empty':   return val !== null && val !== undefined && str.trim() !== ''
    case 'min_length':  return str.length >= parseInt(rule.min ?? '0', 10)
    case 'max_length':  return str.length <= parseInt(rule.max ?? '9999', 10)
    case 'pattern':
      if (!rule.pattern) return true
      try { return new RegExp(rule.pattern).test(str) } catch { return false }
    case 'is_numeric':  return !isNaN(Number(val)) && str.trim() !== ''
    case 'is_date':     return str !== '' && !isNaN(new Date(str).getTime())
    case 'is_email':    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(str)
    case 'is_url':      try { new URL(str); return true } catch { return false }
    case 'range': {
      const n = Number(val); if (isNaN(n)) return false
      const min = rule.min !== undefined ? Number(rule.min) : -Infinity
      const max = rule.max !== undefined ? Number(rule.max) : Infinity
      return n >= min && n <= max
    }
    case 'in_list':
      if (!rule.list) return true
      return rule.list.split(',').map((s) => s.trim().toLowerCase()).includes(str.toLowerCase())
    case 'not_in_list':
      if (!rule.list) return true
      return !rule.list.split(',').map((s) => s.trim().toLowerCase()).includes(str.toLowerCase())
    case 'compare_fields': {
      if (!rule.compareField) return true
      const a = Number(val), b = Number(row[rule.compareField])
      if (isNaN(a) || isNaN(b)) {
        // confronto stringhe
        const sa = str, sb = String(row[rule.compareField] ?? '')
        switch (rule.compareOp) {
          case '==': return sa === sb; case '!=': return sa !== sb
          default: return true
        }
      }
      switch (rule.compareOp) {
        case '>':  return a > b;  case '>=': return a >= b
        case '<':  return a < b;  case '<=': return a <= b
        case '==': return a === b; case '!=': return a !== b
        default: return true
      }
    }
    case 'referential': {
      if (!rule.matName) return true
      const ds = context.materialize.get(rule.matName)
      if (!ds) return true
      return new Set(ds.map((r) => r[rule.refField ?? rule.field])).has(val)
    }
    case 'custom':
      if (!rule.expression) return true
      try { return !!(new Function('row', `return !!(${rule.expression})`)(row)) } catch { return false }
    default: return true
  }
}

// ─── Repair ───────────────────────────────────────────────────────
async function runRepair(
  row:      Row,
  rule:     DQRule,
  prev:     Row | null,
  context:  ExecutionContext,
): Promise<unknown> {
  const current = row[rule.field]

  switch (rule.repair) {
    case 'set_default':
      return rule.repairDefault ?? null

    case 'set_null':
      return null

    case 'set_empty_string':
      return ''

    case 'copy_from_field':
      return rule.repairField ? row[rule.repairField] ?? null : current

    case 'concat_fields': {
      if (!rule.repairFields) return current
      const fields = rule.repairFields.split(',').map((f) => f.trim())
      const sep    = rule.repairSeparator ?? ' '
      return fields.map((f) => String(row[f] ?? '')).filter(Boolean).join(sep) || current
    }

    case 'copy_from_previous':
      return prev ? (prev[rule.field] ?? current) : current

    case 'lookup_from_file': {
      if (!rule.repairFile || !rule.repairFileKey || !rule.repairFileValue) return current
      const map = await loadLookupFile(rule.repairFile, rule.repairFileKey, rule.repairFileValue)
      return map.get(String(current ?? '')) ?? current
    }

    case 'lookup_from_materialize': {
      if (!rule.matName || !rule.repairFileKey || !rule.repairFileValue) return current
      const ds = context.materialize.get(rule.matName)
      if (!ds) return current
      const match = ds.find((r) => r[rule.repairFileKey!] === current)
      return match ? match[rule.repairFileValue!] ?? current : current
    }

    case 'expression': {
      if (!rule.repairExpression) return current
      try {
        return new Function('row', 'prev', `return (${rule.repairExpression})`)(row, prev)
      } catch { return current }
    }

    default:
      return current
  }
}

// ─── Calcolo DTS ─────────────────────────────────────────────────
function calcDimensionScore(
  issues:    DQIssue[],
  rules:     DQRule[],
  dimension: DQDimension,
): number {
  const dimRules = rules.filter((r) => r.enabled && r.dimension === dimension)
  if (dimRules.length === 0) return 1.0  // nessuna regola = perfetto

  const dimIssues = issues.filter((i) => i.dimension === dimension && i.severity === 'error')
  const failed    = dimIssues.length
  return Math.max(0, 1 - failed / dimRules.length)
}

function calcScore(
  issues:  DQIssue[],
  rules:   DQRule[],
  weights: DQConfig['weights'],
): { score: number; dimensions: DQResult['dimensions'] } {
  const dims = {
    completeness: calcDimensionScore(issues, rules, 'completeness'),
    conformity:   calcDimensionScore(issues, rules, 'conformity'),
    consistency:  calcDimensionScore(issues, rules, 'consistency'),
    accuracy:     calcDimensionScore(issues, rules, 'accuracy'),
  }

  const totalWeight = weights.completeness + weights.conformity + weights.consistency + weights.accuracy
  const score = totalWeight > 0
    ? (dims.completeness * weights.completeness +
       dims.conformity   * weights.conformity   +
       dims.consistency  * weights.consistency  +
       dims.accuracy     * weights.accuracy) / totalWeight
    : 1.0

  return { score: Math.round(score * 1000) / 1000, dimensions: dims }
}

// ─── Executor ────────────────────────────────────────────────────
export const dataQualityExecutor: NodeExecutor = {
  handles: ['data_quality'],

  async execute(node: FlowNode<NodeData>, input: Row[], context: ExecutionContext) {
    const cfgJson = node.data.props?.['dqConfig'] as string | undefined
    let config: DQConfig = DEFAULT_DQ_CONFIG
    try { if (cfgJson) config = { ...DEFAULT_DQ_CONFIG, ...JSON.parse(cfgJson) } } catch {}

    const { rules, weights, thresholds, outputField, showOriginal, scoreBeforeRepair } = config
    const activeRules = rules.filter((r) => r.enabled)

    if (activeRules.length === 0) {
      context.callbacks.onLog('warn', 'DataQuality: nessuna regola attiva — passo tutto con score=1', node.id)
      const out = input.map((row) => ({
        ...row,
        [outputField]: { score: 1, valid: true, level: 'ok', repaired: false, issues: [], dimensions: { completeness: 1, conformity: 1, consistency: 1, accuracy: 1 } } as DQResult,
      }))
      return new Map([['output', out]])
    }

    const result: Row[] = []
    let prevRow: Row | null = null
    let totalRepaired = 0
    let totalIssues   = 0

    for (const row of input) {
      const workRow = { ...row }  // copia per repair in-place

      // ── Score pre-repair ─────────────────────────────────────────
      let issuesBefore: DQIssue[] = []
      let scoreBefore  = 1
      if (scoreBeforeRepair) {
        for (const rule of activeRules) {
          const pass = runCheck(workRow, rule, context)
          if (!pass) {
            issuesBefore.push({
              rule: rule.id, field: rule.field, dimension: rule.dimension,
              severity: rule.severity, message: buildMessage(rule, workRow),
              repaired: false,
            })
          }
        }
        scoreBefore = calcScore(issuesBefore, activeRules, weights).score
      }

      // ── Check + repair ───────────────────────────────────────────
      const issues: DQIssue[] = []
      let   rowRepaired = false

      for (const rule of activeRules) {
        const pass = runCheck(workRow, rule, context)
        if (!pass) {
          const original = workRow[rule.field]
          let   newValue = original
          let   repaired = false

          if (rule.repair !== 'none') {
            try {
              newValue  = await runRepair(workRow, rule, prevRow, context)
              workRow[rule.field] = newValue
              repaired  = newValue !== original
              rowRepaired = rowRepaired || repaired
            } catch {}
          }

          issues.push({
            rule:      rule.id,
            field:     rule.field,
            dimension: rule.dimension,
            severity:  rule.severity,
            message:   buildMessage(rule, row),  // messaggio sul valore originale
            repaired,
            action:    repaired ? rule.repair : undefined,
            original:  showOriginal ? original : undefined,
            newValue:  repaired ? newValue : undefined,
          })
        }
      }

      if (rowRepaired) totalRepaired++
      totalIssues += issues.length

      // ── Score post-repair ────────────────────────────────────────
      const { score, dimensions } = calcScore(issues, activeRules, weights)
      const level: DQResult['level'] = score >= thresholds.valid   ? 'ok'
                                     : score >= thresholds.warning ? 'warn'
                                     : 'error'

      const dqResult: DQResult = {
        score,
        valid:    score >= thresholds.valid,
        level,
        repaired: rowRepaired,
        issues,
        dimensions,
        ...(scoreBeforeRepair ? { scoreOriginal: scoreBefore } : {}),
      }

      result.push({ ...workRow, [outputField]: dqResult })
      prevRow = workRow
    }

    context.callbacks.onLog(
      totalIssues > 0 ? 'warn' : 'info',
      `DataQuality: ${input.length} righe · ${totalIssues} problemi · ${totalRepaired} riparate`,
      node.id
    )

    return new Map([['output', result]])
  },
}

function buildMessage(rule: DQRule, row: Row): string {
  const val = row[rule.field]
  switch (rule.checkType) {
    case 'not_null':      return `'${rule.field}' è null`
    case 'not_empty':     return `'${rule.field}' è vuoto`
    case 'min_length':    return `'${rule.field}' troppo corto (min ${rule.min})`
    case 'max_length':    return `'${rule.field}' troppo lungo (max ${rule.max})`
    case 'range':         return `'${rule.field}' = ${val} fuori range [${rule.min??'-∞'}, ${rule.max??'+∞'}]`
    case 'pattern':       return `'${rule.field}' = '${val}' non corrisponde al pattern`
    case 'in_list':       return `'${rule.field}' = '${val}' non in lista`
    case 'not_in_list':   return `'${rule.field}' = '${val}' in lista esclusa`
    case 'is_numeric':    return `'${rule.field}' = '${val}' non è un numero`
    case 'is_date':       return `'${rule.field}' = '${val}' non è una data`
    case 'is_email':      return `'${rule.field}' = '${val}' non è un'email`
    case 'is_url':        return `'${rule.field}' = '${val}' non è un URL`
    case 'compare_fields':return `'${rule.field}' ${rule.compareOp} '${rule.compareField}' non rispettato`
    case 'referential':   return `'${rule.field}' = '${val}' non trovato in '${rule.matName}'`
    case 'custom':        return rule.label || `Regola custom fallita su '${rule.field}'`
    default:              return `Regola fallita su '${rule.field}'`
  }
}
