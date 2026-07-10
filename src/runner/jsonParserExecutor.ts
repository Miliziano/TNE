/**
 * src/runner/jsonParserExecutor.ts
 * ─────────────────────────────────
 * Executor per il nodo json_parser.
 *
 * Per ogni riga in ingresso:
 *   1. Legge il campo sorgente (stringa JSON o oggetto già parsato)
 *   2. Per ogni flusso configurato:
 *      a. Naviga al JSONPath del flusso
 *      b. Se isArray: itera sugli elementi, emette una riga per elemento
 *      c. Se oggetto singolo: emette una riga
 *      d. Per ogni campo: risolve il JSONPath, applica trasformazione
 *      e. Gestisce valori mancanti (null, default, skip, error→reject)
 *   3. Produce un output handle per ogni flusso (flow.id = sourceHandle)
 *      più un handle 'reject' se hasReject = true
 *
 * Aggiungere in executors.ts:
 *   import { jsonParserExecutor } from './jsonParserExecutor'
 *   // in EXECUTORS[]: jsonParserExecutor
 */
/**
 * src/runner/jsonParserExecutor.ts
 */

import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import type {
  JsonParserConfig,
  JsonParserFlow,
  JsonParserField,
  JsonParserFieldTransform,
  JsonParserFieldMissing,
} from '../nodes/types/json_parser/jsonParserTypes'

// ─── Naviga un JSONPath su un oggetto ─────────────────────────────
function resolveJsonPath(data: unknown, path: string): unknown {
  if (!path || path === '$') return data

  let p = path.replace(/^\$\.?/, '')
  if (!p) return data

  const arrayWildcard = p.endsWith('[*]')
  if (arrayWildcard) p = p.slice(0, -3).replace(/\.$/, '')

  const parts = p.split('.').filter(Boolean)
  let cur: unknown = data
  for (const part of parts) {
    if (cur === null || cur === undefined) return undefined
    const bracketMatch = part.match(/^([^\[]+)\[(\d+)\]$/)
    if (bracketMatch) {
      const [, key, idx] = bracketMatch
      cur = (cur as Record<string, unknown>)[key]
      if (Array.isArray(cur)) cur = cur[parseInt(idx, 10)]
      else return undefined
    } else {
      cur = (cur as Record<string, unknown>)[part]
    }
  }

  return cur
}

// ─── Applica trasformazione ────────────────────────────────────────
function applyTransform(val: unknown, transform: JsonParserFieldTransform): unknown {
  if (val === null || val === undefined) return val
  const s = String(val)
  switch (transform) {
    case 'none':       return val
    case 'trim':       return s.trim()
    case 'uppercase':  return s.toUpperCase()
    case 'lowercase':  return s.toLowerCase()
    case 'to_integer': { const n = parseInt(s.replace(/[^\d\-]/g, ''), 10); return isNaN(n) ? null : n }
    case 'to_decimal': { const n = parseFloat(s.replace(',', '.')); return isNaN(n) ? null : n }
    case 'to_boolean': return ['true', '1', 'yes', 'si', 'sì', 'on'].includes(s.toLowerCase())
    case 'to_date':    { const d = new Date(s); return isNaN(d.getTime()) ? null : d.toISOString().split('T')[0] }
    case 'to_string':  return s
    default:           return val
  }
}

// ─── Risolve il path di un campo ──────────────────────────────────
// Strategia a cascata:
// 1. Prova il path sull'elemento corrente del flusso
// 2. Se non trovato, prova sull'oggetto radice (parsed)
// Questo permette di usare path assoluti ($.nome) anche quando
// il flusso è posizionato su un sotto-percorso ($.hobby)
function resolveFieldValue(
  element:   unknown,   // elemento corrente del flusso (o il target del flusso)
  root:      unknown,   // documento radice completo
  fieldPath: string,
  flowPath:  string,
): unknown {
  // Path speciale $ = l'elemento stesso
  if (fieldPath === '$') return element

  // Prima prova: naviga il path relativo all'elemento
  // Calcola il path relativo rimuovendo il prefisso del flusso
  const normalizedFlow = flowPath.replace(/\[\*\]$/, '').replace(/\.$/, '')
  const prefixBracket  = normalizedFlow + '[*].'
  const prefixDot      = normalizedFlow + '.'

  let relativePath = fieldPath
  if (fieldPath.startsWith(prefixBracket)) {
    relativePath = '$.' + fieldPath.slice(prefixBracket.length)
  } else if (fieldPath.startsWith(prefixDot)) {
    relativePath = '$.' + fieldPath.slice(prefixDot.length)
  } else if (fieldPath === normalizedFlow || fieldPath === normalizedFlow + '[*]') {
    return element
  }

  // Prova sull'elemento
  const fromElement = resolveJsonPath(element, relativePath)
  if (fromElement !== undefined) return fromElement

  // Fallback: prova il path assoluto sull'oggetto radice
  // Questo permette $.nome quando il flusso è su $.hobby
  const fromRoot = resolveJsonPath(root, fieldPath)
  if (fromRoot !== undefined) return fromRoot

  return undefined
}

// ─── Elabora un singolo elemento ──────────────────────────────────
function processElement(
  element:    unknown,
  root:       unknown,
  flow:       JsonParserFlow,
  rejectRows: Row[],
): Row | null {
  const outRow: Row = {}
  let shouldReject = false

  for (const field of flow.fields) {
    const raw = resolveFieldValue(element, root, field.jsonPath, flow.jsonPath)

    if (raw === undefined || raw === null) {
      switch (field.onMissing) {
        case 'null':    outRow[field.name] = null; break
        case 'default': outRow[field.name] = field.defaultValue ?? null; break
        case 'skip':    return null
        case 'error':   shouldReject = true; outRow[field.name] = null; break
        default:        outRow[field.name] = null
      }
      continue
    }

    outRow[field.name] = applyTransform(raw, field.transform)
  }

  if (shouldReject) {
    rejectRows.push({ ...outRow, _reject_reason: 'missing_required_field', _source_flow: flow.label })
    return null
  }

  return outRow
}

// ─── Executor ─────────────────────────────────────────────────────
export const jsonParserExecutor: NodeExecutor = {
  handles: ['json_parser'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const config = node.data.config?.jsonParser as JsonParserConfig | undefined
    if (!config) {
      context.callbacks.onLog('warn', 'JsonParser: nessuna configurazione', node.id)
      return new Map([['output', input]])
    }

    const { sourceField, hasReject, flows } = config

    if (!sourceField) {
      context.callbacks.onLog('warn', 'JsonParser: campo sorgente non configurato', node.id)
      return new Map([['output', input]])
    }

    if (flows.length === 0) {
      context.callbacks.onLog('warn', 'JsonParser: nessun flusso configurato', node.id)
      return new Map([['output', input]])
    }

    const outputMap = new Map<string, Row[]>()
    for (const flow of flows) outputMap.set(flow.id, [])
    if (hasReject) outputMap.set('reject', [])

    const rejectRows: Row[] = hasReject ? outputMap.get('reject')! : []

    let totalProcessed = 0
    let totalRejected  = 0

    for (const inputRow of input) {
      if (context.callbacks.isAborted()) break

      const rawValue = inputRow[sourceField]
      let parsed: unknown

      if (rawValue === null || rawValue === undefined) {
        context.callbacks.onLog('warn', `JsonParser: campo '${sourceField}' assente o null`, node.id)
        if (hasReject) rejectRows.push({ ...inputRow, _reject_reason: 'source_field_missing' })
        continue
      }

      if (typeof rawValue === 'string') {
        try { parsed = JSON.parse(rawValue) }
        catch (e) {
          context.callbacks.onLog('warn', `JsonParser: '${sourceField}' non è JSON valido — ${(e as Error).message}`, node.id)
          if (hasReject) rejectRows.push({ ...inputRow, _reject_reason: 'invalid_json' })
          continue
        }
      } else if (typeof rawValue === 'object') {
        parsed = rawValue
      } else {
        context.callbacks.onLog('warn', `JsonParser: '${sourceField}' ha tipo inatteso: ${typeof rawValue}`, node.id)
        if (hasReject) rejectRows.push({ ...inputRow, _reject_reason: 'unexpected_type' })
        continue
      }

      for (const flow of flows) {
        const flowOutput = outputMap.get(flow.id)!

        let target: unknown
        try { target = resolveJsonPath(parsed, flow.jsonPath) }
        catch { target = undefined }

        if (target === undefined || target === null) {
          context.callbacks.onLog('warn', `JsonParser flusso '${flow.label}': path '${flow.jsonPath}' non trovato`, node.id)
          continue
        }

        if (flow.isArray) {
          const arr = Array.isArray(target) ? target : [target]
          for (const element of arr) {
            if (context.callbacks.isAborted()) break
            const row = processElement(element, parsed, flow, rejectRows)
            if (row) {
              const merged = flow.mergeParent ? { ...buildParentData(inputRow, sourceField, flow), ...row } : row
              flowOutput.push(merged)
              totalProcessed++
            } else {
              totalRejected++
            }
          }
        } else {
          const element = Array.isArray(target) ? target[0] : target
          const row = processElement(element, parsed, flow, rejectRows)
          if (row) {
            const merged = flow.mergeParent ? { ...buildParentData(inputRow, sourceField, flow), ...row } : row
            flowOutput.push(merged)
            totalProcessed++
          } else {
            totalRejected++
          }
        }
      }
    }

    context.callbacks.onLog('info',
      `JsonParser: ${totalProcessed} righe prodotte, ${totalRejected} rifiutate. ` +
      `Flussi: ${flows.map((f) => `${f.label}=${outputMap.get(f.id)?.length ?? 0}`).join(', ')}`,
      node.id,
    )

    return outputMap
  },
}

function buildParentData(inputRow: Row, sourceField: string, flow: JsonParserFlow): Row {
  const parentData: Row = {}
  if (flow.parentFields.length === 0) {
    for (const [k, v] of Object.entries(inputRow)) {
      if (k !== sourceField) parentData[k] = v
    }
  } else {
    for (const fname of flow.parentFields) {
      parentData[fname] = inputRow[fname]
    }
  }
  return parentData
}