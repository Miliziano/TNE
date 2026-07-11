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