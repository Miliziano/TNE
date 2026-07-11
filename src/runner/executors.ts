/**
 * src/runner/executors.ts
 * Fix: EXECUTORS usa AnyExecutor[] e getExecutor restituisce AnyExecutor
 * così il type guard isStreamingExecutor funziona correttamente nel runner.
 */

import type { Row, NodeExecutor, AnyExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { readFile } from '../lib/tauri'
import { readFileContent } from '../io/readers'
import { readBinaryFile } from '../lib/tauri'


import { reportGeneratorExecutor } from './reportGeneratorExecutor'

import { joinExecutor }            from './joinExecutor'
import { dirWatcherExecutor }      from './dirWatcherExecutor'

import { httpSourceExecutor } from './httpSourceExecutor'
import { jsonParserExecutor } from './jsonParserExecutor'

import { sourceFtpExecutor } from './sourceFtpExecutor'
import { xmlParserExecutor } from './xmlParserExecutor'

import { jsonSerializerExecutor } from './jsonSerializerExecutor'
import { xmlSerializerExecutor }  from './xmlSerializerExecutor'
import { bridgeOutExecutor, bridgeInExecutor } from './bridgeExecutor'
import { scriptExecutor } from './scriptExecutor'
import { mailSinkExecutor } from './mailSinkExecutor'
import { sourceMqttExecutor, sinkMqttExecutor } from './mqttExecutor'
import { sourceKafkaExecutor,sinkKafkaExecutor } from './kafkaExecutor'
import { sourceActiveMQExecutor, sinkActiveMQExecutor } from './activemqExecutor'

import { webhookReceiverExecutor, webhookResponderExecutor,watchdogExecutor, } from './webhookExecutor'

import { shellExecutor } from './shellExecutor'
import { sshExecutor }   from './sshExecutor'
import { errorHandlerExecutor } from './errorHandlerExecutor'

function out(rows: Row[]): Map<string, Row[]> {
  return new Map([['output', rows]])
}
function outWithReject(main: Row[], rejected: Row[]): Map<string, Row[]> {
  return new Map([['output', main], ['reject', rejected]])
}
function prop(node: FlowNode<NodeData>, key: string, def = ''): string {
  return (node.data.props?.[key] ?? def) as string
}

function applyTransform(val: unknown, transform: string): unknown {
  const str = String(val ?? '')
  switch (transform) {
    case 'uppercase':     return str.toUpperCase()
    case 'lowercase':     return str.toLowerCase()
    case 'trim':          return str.trim()
    case 'to_int':        return parseInt(str, 10)
    case 'to_float':      return parseFloat(str)
    case 'to_string':     return str
    case 'to_bool':       return ['true','1','yes','si','sì'].includes(str.toLowerCase())
    case 'to_date':       return new Date(str).toISOString().split('T')[0]
    case 'to_datetime':   return new Date(str).toISOString()
    case 'abs':           return Math.abs(Number(val))
    case 'round':         return Math.round(Number(val))
    case 'floor':         return Math.floor(Number(val))
    case 'ceil':          return Math.ceil(Number(val))
    case 'negate':        return -Number(val)
    case 'not':           return !val
    case 'nullify_empty': return str.trim() === '' ? null : val
    default:              return val
  }
}

function applySchema(
  rows:   Row[],
  schema: Array<{ name: string; physicalName?: string; sourceField?: string; transform?: string }>,
): Row[] {
  if (schema.length === 0) return rows
  return rows.map((row) => {
    const newRow: Row = {}
    for (const field of schema) {
      const src = field.sourceField ?? field.physicalName ?? field.name
      const raw = src in row ? row[src] : (row[field.name] ?? null)
      newRow[field.name] = applyTransform(raw, field.transform ?? '')
    }
    return newRow
  })
}

let _seq = 0
function resolvePath(path: string): string {
  const now = new Date()
  const pad = (n: number) => String(n).padStart(2, '0')
  const date     = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}`
  const datetime = `${date}T${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
  return path
    .replace(/\$\{datetime\}/g,  datetime)
    .replace(/\$\{date\}/g,      date)
    .replace(/\$\{uuid\}/g,      crypto.randomUUID())
    .replace(/\$\{seq\}/g,       String(++_seq).padStart(4,'0'))
    .replace(/\$\{timestamp\}/g, String(Date.now()))
    .replace(/\$\{year\}/g,      String(now.getFullYear()))
    .replace(/\$\{month\}/g,     pad(now.getMonth()+1))
    .replace(/\$\{day\}/g,       pad(now.getDate()))
    .replace(/\$\{hour\}/g,      pad(now.getHours()))
    .replace(/\$\{minute\}/g,    pad(now.getMinutes()))
}

function serializeRows(
  rows:    Row[],
  format:  string,
  options: { writeHeader?: boolean; delimiter?: string; eol?: string } = {}
): string {
  if (rows.length === 0) return ''
  const { writeHeader = true, delimiter = ',', eol = '\n' } = options
  switch (format) {
    case 'json':  return JSON.stringify(rows, null, 2)
    case 'jsonl': return rows.map((r) => JSON.stringify(r)).join(eol)
    default: {
      const sep     = format === 'tsv' ? '\t' : delimiter
      const headers = Object.keys(rows[0])
      const data    = rows.map((r) =>
        headers.map((h) => {
          const val = r[h]
          if (val === null || val === undefined) return ''
          const s = String(val)
          return (s.includes(sep) || s.includes('\n') || s.includes('"'))
            ? `"${s.replace(/"/g, '""')}"` : s
        }).join(sep)
      )
      return (writeHeader ? [headers.join(sep), ...data] : data).join(eol)
    }
  }
}

// ─── Filter ───────────────────────────────────────────────────────
function evalFilterCode(row: Row, code: string): boolean {
  try {
    const wrapped = code.trim().startsWith('(row)') || code.trim().startsWith('row =>')
      ? `(${code})(row)` : code
    // eslint-disable-next-line no-new-func
    return !!(new Function('row', `return !!(${wrapped})`)(row))
  } catch { return false }
}

function templateToCode(templateId: string, params: Record<string, string>): string {
  switch (templateId) {
    case 'num_greater':    return `Number(row.${params.field}) > ${params.threshold}`
    case 'num_less':       return `Number(row.${params.field}) < ${params.threshold}`
    case 'num_between':    return `Number(row.${params.field}) >= ${params.min} && Number(row.${params.field}) <= ${params.max}`
    case 'num_is_zero':    return `Number(row.${params.field}) === 0`
    case 'num_is_negative':return `Number(row.${params.field}) < 0`
    case 'str_contains':   return `String(row.${params.field}??'').toLowerCase().includes('${(params.text??'').toLowerCase()}')`
    case 'str_starts':     return `String(row.${params.field}??'').startsWith('${params.prefix}')`
    case 'str_ends':       return `String(row.${params.field}??'').endsWith('${params.suffix}')`
    case 'str_regex':      return `new RegExp('${params.pattern}').test(String(row.${params.field}??''))`
    case 'str_is_empty':   return `!row.${params.field} || String(row.${params.field}).trim() === ''`
    case 'is_null':        return `row.${params.field} == null`
    case 'is_not_null':    return `row.${params.field} != null`
    case 'date_is_today':  return `new Date(row.${params.field}).toDateString() === new Date().toDateString()`
    case 'date_is_past':   return `new Date(row.${params.field}) < new Date()`
    case 'date_is_future': return `new Date(row.${params.field}) > new Date()`
    case 'date_is_weekend':return `[0,6].includes(new Date(row.${params.field}).getDay())`
    case 'date_range':     return `new Date(row.${params.field}) >= new Date('${params.from}') && new Date(row.${params.field}) <= new Date('${params.to}')`
    default:               return 'true'
  }
}

function evaluateVisualClause(row: Row, clause: any, nullBehavior: string): boolean {
  const raw = row[clause.field]
  if (raw === null || raw === undefined) {
    if (clause.operator === 'is_null')  return true
    if (clause.operator === 'not_null') return false
    if (nullBehavior === 'exclude') return false
    if (nullBehavior === 'error')   throw new Error(`Campo '${clause.field}' è null`)
  }
  const str = String(raw ?? '').toLowerCase()
  const val = String(clause.value ?? '').toLowerCase()
  const num = Number(raw), numV = Number(clause.value)
  switch (clause.operator) {
    case '==':       return str === val
    case '!=':       return str !== val
    case '>':        return !isNaN(num) && num > numV
    case '>=':       return !isNaN(num) && num >= numV
    case '<':        return !isNaN(num) && num < numV
    case '<=':       return !isNaN(num) && num <= numV
    case 'contains': return str.includes(val)
    case 'starts':   return str.startsWith(val)
    case 'ends':     return str.endsWith(val)
    case 'is_null':  return raw === null || raw === undefined
    case 'not_null': return raw !== null && raw !== undefined
    case 'in': {
      const list = String(clause.value??'').split(',').map((s: string) => s.trim().toLowerCase())
      return list.includes(str)
    }
    case 'not_in': {
      const list = String(clause.value??'').split(',').map((s: string) => s.trim().toLowerCase())
      return !list.includes(str)
    }
    case 'regex': {
      try { return new RegExp(String(clause.value??''), 'i').test(String(raw??'')) } catch { return false }
    }
    default: return true
  }
}

function evaluateFilterCondition(row: Row, cond: any, nullBehavior: string): boolean {
  switch (cond.mode) {
    case 'visual': {
      const clauses = cond.clauses ?? []
      if (clauses.length === 0) return true
      let result = evaluateVisualClause(row, clauses[0], nullBehavior)
      for (let i = 1; i < clauses.length; i++) {
        const curr = evaluateVisualClause(row, clauses[i], nullBehavior)
        result = (clauses[i-1].logic ?? 'AND') === 'OR' ? result || curr : result && curr
      }
      return result
    }
    case 'template': {
      const code = templateToCode(cond.templateId ?? '', cond.templateParams ?? {})
      return evalFilterCode(row, code)
    }
    case 'code':
      return evalFilterCode(row, cond.code ?? 'true')
    default:
      return false
  }
}

const filterExecutor: NodeExecutor = {
  handles: ['filter'],
  async execute(node, input, context) {
    const filterConfig = node.data.config?.filter as any
    if (filterConfig?.conditions?.length > 0) {
      const conditions   = filterConfig.conditions as any[]
      const nullBehavior = filterConfig.nullBehavior ?? 'exclude'
      const buckets      = new Map<string, Row[]>()
      for (const cond of conditions) buckets.set(cond.id, [])
      buckets.set('reject', [])
      for (const row of input) {
        let placed = false
        for (const cond of conditions) {
          try {
            if (evaluateFilterCondition(row, cond, nullBehavior)) {
              buckets.get(cond.id)!.push(row)
              placed = true
              break
            }
          } catch (e) {
            context.callbacks.onLog('warn', `Filter '${cond.label}': ${e}`, node.id)
          }
        }
        if (!placed) buckets.get('reject')!.push(row)
      }
      const stats = conditions.map((c: any) => `${c.label}:${buckets.get(c.id)!.length}`).join(' ')
      context.callbacks.onLog('info', `Filter: ${stats} | reject:${buckets.get('reject')!.length}`, node.id)
      return buckets
    }
    let rules: Array<{ field: string; operator: string; value: string; logic?: string }> = []
    try { rules = JSON.parse(prop(node, 'rules', '[]')) } catch { return out(input) }
    if (rules.length === 0) return out(input)
    const passed: Row[] = [], rejected: Row[] = []
    for (const row of input) {
      let result = evaluateOldRule(row, rules[0])
      for (let i = 1; i < rules.length; i++) {
        const curr = evaluateOldRule(row, rules[i])
        result = (rules[i-1].logic ?? 'AND') === 'OR' ? result || curr : result && curr
      }
      if (result) passed.push(row); else rejected.push(row)
    }
    context.callbacks.onLog('info', `Filter: ${passed.length} passate, ${rejected.length} scartate`, node.id)
    return outWithReject(passed, rejected)
  },
}

function evaluateOldRule(row: Row, rule: { field: string; operator: string; value: string }): boolean {
  const raw = row[rule.field], str = String(raw??'').toLowerCase(), rv = rule.value.toLowerCase()
  const num = Number(raw), rnum = Number(rule.value)
  switch (rule.operator) {
    case 'eq':           return str === rv
    case 'neq':          return str !== rv
    case 'contains':     return str.includes(rv)
    case 'not_contains': return !str.includes(rv)
    case 'starts_with':  return str.startsWith(rv)
    case 'ends_with':    return str.endsWith(rv)
    case 'gt':           return !isNaN(num) && num > rnum
    case 'gte':          return !isNaN(num) && num >= rnum
    case 'lt':           return !isNaN(num) && num < rnum
    case 'lte':          return !isNaN(num) && num <= rnum
    case 'is_null':      return raw === null || raw === undefined || raw === ''
    case 'is_not_null':  return raw !== null && raw !== undefined && raw !== ''
    case 'regex': { try { return new RegExp(rule.value,'i').test(String(raw??'')) } catch { return false } }
    default: return true
  }
}

// ─── Map ──────────────────────────────────────────────────────────
const mapExecutor: NodeExecutor = {
  handles: ['transform'],
  async execute(node, input, _context) {
    try {
      const schema = JSON.parse(prop(node, 'outputSchema', '[]'))
      if (schema.length === 0) return out(input)
      return out(applySchema(input, schema))
    } catch { return out(input) }
  },
}

// Contatore righe per nodo Log — persiste tra le chiamate streaming
// Reset: clearLogCounters() chiamato all'avvio di ogni run
const _logRowCounters = new Map<string, number>()

export function clearLogCounters(): void {
  _logRowCounters.clear()
}
// ─── Log ──────────────────────────────────────────────────────────
// ─── Log ──────────────────────────────────────────────────────────
const logExecutor: NodeExecutor = {
  handles: ['log'],
  async execute(node, input, context) {
    if (prop(node, 'logEnabled', 'true') === 'false') return out(input)
    const level      = prop(node, 'logLevel', 'info') as any
    const template   = prop(node, 'logTemplate', '')
    const prefix     = prop(node, 'logPrefix', `[${node.data.config?.displayName || 'Log'}]`)
    const sampleMode = prop(node, 'sampleMode', 'all')
    const sampleN    = parseInt(prop(node, 'sampleN', '10'), 10)
    const samplePct  = parseInt(prop(node, 'samplePct', '10'), 10)
    const showRowNum = prop(node, 'showRowNum', 'true') !== 'false'
    const maxChars   = parseInt(prop(node, 'maxChars', '200'), 10)
    const logTarget  = prop(node, 'logTarget', 'panel')
    const nodeLabel  = (node.data.config?.displayName as string | undefined) || node.data.label || 'Log'

     // Contatore persistente tra chiamate streaming — si azzera al nuovo run
    const baseIdx = _logRowCounters.get(node.id) ?? 0
    _logRowCounters.set(node.id, baseIdx + input.length)

    let rowsToLog: Array<{ row: Row; idx: number }>
    switch (sampleMode) {
      case 'first_n':
        // Logga solo se siamo ancora nelle prime sampleN righe totali
        rowsToLog = input
          .map((r, i) => ({ row: r, idx: baseIdx + i }))
          .filter(({ idx }) => idx < sampleN)
        break
      case 'every_n':
        rowsToLog = input
          .map((r, i) => ({ row: r, idx: baseIdx + i }))
          .filter(({ idx }) => idx % sampleN === 0)
        break
      case 'random':
        rowsToLog = input
          .map((r, i) => ({ row: r, idx: baseIdx + i }))
          .filter(() => Math.random() * 100 < samplePct)
        break
      default:
        rowsToLog = input.map((r, i) => ({ row: r, idx: baseIdx + i }))
    }

    const useWindow = logTarget === 'window' || logTarget === 'both_window'
    let addRow: ((row: any) => void) | null = null
    if (useWindow) {
      const { useLogViewerStore } = await import('../store/useLogViewerStore')
      addRow = useLogViewerStore.getState().addRow
    }
    const toPanel = logTarget !== 'window'

    for (const {row, idx} of rowsToLog) {
      let msg = template ? template.replace(/\{(\w+)\}/g, (_,k) => String(row[k]??'')) : JSON.stringify(row)
      if (maxChars > 0 && msg.length > maxChars) msg = msg.slice(0, maxChars) + '…'
      if (toPanel) {
        context.callbacks.onLog(level, `${prefix} ${showRowNum ? `[${idx+1}] ` : ''}${msg}`, node.id)
      }
      if (addRow) {
        addRow({ timestamp: new Date(), nodeId: node.id, nodeLabel, rowNum: showRowNum ? idx+1 : 0, message: `${prefix} ${msg}`, level })
      }
    }
    return out(input)
  },
}

// ─── Lane Start / End ─────────────────────────────────────────────
const laneStartEndExecutor: NodeExecutor = {
  handles: ['lane_start', 'lane_end'],
  async execute(_node, input, _context) { return out(input) },
}

// ─── Materialize ──────────────────────────────────────────────────
const materializeExecutor: NodeExecutor = {
  handles: ['materialize'],
  requiresCompleteInput: (node) => {
    const matMode = prop(node, 'matMode', 'passthrough')
    return matMode === 'buffer_signal'
  },
  async execute(node, input, context) {
    const matName = prop(node, 'matName', node.id)
    const matMode = prop(node, 'matMode', 'passthrough')
    context.materialize.set(matName, [...input])
    context.callbacks.onLog('info', `Materialize '${matName}': ${input.length} righe (${matMode})`, node.id)
    if (matMode === 'buffer_signal') {
      return out([{ name: matName, row_count: input.length, status: 'completed', completed_at: new Date().toISOString(), elapsed_ms: 0 }])
    }
    return out(input)
  },
}

// ─── Registry — usa AnyExecutor[] ────────────────────────────────
// IMPORTANTE: il tipo deve essere AnyExecutor[] (non NodeExecutor[])
// altrimenti il type guard isStreamingExecutor nel runner non funziona.
const EXECUTORS: AnyExecutor[] = [
  filterExecutor,
  mapExecutor,
  logExecutor,

  reportGeneratorExecutor,
  laneStartEndExecutor,
  materializeExecutor,

  joinExecutor,
  dirWatcherExecutor,   // ← StreamingNodeExecutor — streaming: true

  httpSourceExecutor,   // ← aggiunge qui
  jsonParserExecutor,

  sourceFtpExecutor,
  xmlParserExecutor,

  jsonSerializerExecutor,
  xmlSerializerExecutor,
  bridgeOutExecutor,   // ← aggiungi
  bridgeInExecutor,    // ← aggiungi
  scriptExecutor,
  mailSinkExecutor,
  sourceMqttExecutor,
  sinkMqttExecutor,
   sourceKafkaExecutor,
   sinkKafkaExecutor ,
   sourceActiveMQExecutor, 
   sinkActiveMQExecutor,
  
   webhookReceiverExecutor,
  webhookResponderExecutor,
  watchdogExecutor,

   shellExecutor, 
   sshExecutor,
    errorHandlerExecutor,   // ← aggiungere
]

const EXECUTOR_MAP = new Map<string, AnyExecutor>()
for (const exec of EXECUTORS) {
  for (const handle of exec.handles) EXECUTOR_MAP.set(handle, exec)
}

// Restituisce AnyExecutor — il runner usa isStreamingExecutor() per distinguere
export function getExecutor(nodeType: string): AnyExecutor | undefined {
  return EXECUTOR_MAP.get(nodeType)
}