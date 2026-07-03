/**
 * src/runner/xmlParserExecutor.ts
 *
 * Executor per xml_parser.
 * Per ogni riga in ingresso:
 *   1. Legge il campo sorgente (stringa XML)
 *   2. Parsa il documento con DOMParser
 *   3. Per ogni flusso configurato:
 *      a. Naviga all'XPath del flusso
 *      b. Se isRepeating: itera su tutti i match, emette una riga per elemento
 *      c. Se singolo: emette una riga
 *      d. Per ogni campo: risolve l'XPath, applica trasformazione
 *      e. Gestisce valori mancanti
 *   4. Produce un output handle per ogni flusso (flow.id = sourceHandle)
 *      più un handle 'reject' se hasReject = true
 *
 * Aggiungere in executors.ts:
 *   import { xmlParserExecutor } from './xmlParserExecutor'
 *   // in EXECUTORS[]: xmlParserExecutor
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import type {
  XmlParserConfig,
  XmlParserFlow,
  XmlParserField,
  XmlParserFieldTransform,
  XmlParserFieldMissing,
} from '../nodes/types/xml_parser/xmlParserTypes'

// ─── Risolve un XPath semplice su un Element DOM ──────────────────
// Supporta:
//   /root/element          → navigazione assoluta
//   /root/element[*]       → tutti i figli con quel nome
//   /root/element/@attr    → attributo
//   element/child          → navigazione relativa
//   @attr                  → attributo sull'elemento corrente
//   text()                 → testo dell'elemento corrente
function resolveXPath(
  el:         Element | Document,
  xpath:      string,
  ignoreNs:   boolean,
  multiple:   boolean,
): Element[] | string | null {

  // Normalizza: rimuove [*] — gestiamo la molteplicità altrove
  const path = xpath.replace(/\[\*\]/g, '').replace(/\[\d+\]/g, '')

  // Attributo diretto sull'elemento
  if (path.startsWith('@')) {
    const attrName = path.slice(1)
    const elem = el instanceof Document ? el.documentElement : el
    return elem.getAttribute(attrName)
  }

  // text() diretto
  if (path === 'text()' || path.endsWith('/text()')) {
    const cleanPath = path.endsWith('/text()') ? path.slice(0, -7) : ''
    const target = cleanPath
      ? navigatePath(el, cleanPath, ignoreNs)
      : (el instanceof Document ? el.documentElement : el)
    if (!target) return null
    return target.textContent?.trim() ?? null
  }

  // Attributo alla fine del path: /root/element/@attr
  if (path.includes('/@')) {
    const atIdx   = path.lastIndexOf('/@')
    const elemPath = path.slice(0, atIdx)
    const attrName = path.slice(atIdx + 2)
    const target   = navigatePath(el, elemPath, ignoreNs)
    if (!target) return null
    return target.getAttribute(attrName)
  }

  // Path normale — naviga e restituisce Element(s)
  if (multiple) {
    return navigatePathAll(el, path, ignoreNs)
  } else {
    const found = navigatePath(el, path, ignoreNs)
    return found ? [found] : []
  }
}

function lname(el: Element, ignoreNs: boolean): string {
  return ignoreNs ? el.localName : el.tagName
}

function navigatePath(root: Element | Document, path: string, ignoreNs: boolean): Element | null {
  const parts = path.split('/').filter(Boolean)
  let current: Element | null = root instanceof Document ? root.documentElement : root

  for (let i = 0; i < parts.length; i++) {
    if (!current) return null
    const part = parts[i]
    // Salta il primo segmento se coincide con l'elemento corrente (documentElement)
    if (i === 0 && lname(current, ignoreNs) === part) continue
    const found: Element | undefined = Array.from(current.children).find((c) => lname(c, ignoreNs) === part)
    current = found ?? null
  }

  return current
}

function navigatePathAll(root: Element | Document, path: string, ignoreNs: boolean): Element[] {
  const parts = path.split('/').filter(Boolean)
  if (parts.length === 0) return []

  let current: Element[] = [root instanceof Document ? root.documentElement : root]

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i]
    const isLast = i === parts.length - 1

    // Salta il primo segmento se coincide con documentElement
    if (i === 0 && current.length === 1 && lname(current[0], ignoreNs) === part) continue

    const next: Element[] = []
    for (const el of current) {
      const children = Array.from(el.children) as Element[]
      // Sia per segmenti intermedi che per l'ultimo: raccoglie TUTTI i match
      next.push(...children.filter((c) => lname(c, ignoreNs) === part))
    }
    current = next
    if (current.length === 0) return []
  }

  return current
}

// ─── Estrae il valore testuale da un Element o stringa ────────────
function extractValue(result: Element[] | string | null): string | null {
  if (result === null || result === undefined) return null
  if (typeof result === 'string') return result
  if (result.length === 0) return null
  return result[0].textContent?.trim() ?? null
}

// ─── Applica trasformazione ───────────────────────────────────────
function applyTransform(val: unknown, transform: XmlParserFieldTransform): unknown {
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

// ─── Risolve il path di un campo rispetto al contesto del flusso ──
// Il campo ha un path assoluto tipo /railML/infrastructure/tracks/track/@id
// Il flusso è posizionato su /railML/infrastructure/tracks/track[*]
// Dobbiamo risolvere il path RELATIVO all'elemento corrente
function resolveFieldOnElement(
  element:   Element,
  doc:       Document,
  field:     XmlParserField,
  flowXPath: string,
  ignoreNs:  boolean,
): string | null {

  const cleanFlow  = flowXPath.replace(/\[\*\]$/, '').replace(/\[\*\]/g, '')
  const cleanField = field.xpath.replace(/\[\*\]/g, '')

  // Caso 1: path relativo semplice (es: "@id", "length", "trackRef/@ref")
  if (!cleanField.startsWith('/')) {
    if (cleanField.startsWith('@')) {
      return element.getAttribute(cleanField.slice(1))
    }
    if (cleanField === 'text()') {
      return element.textContent?.trim() ?? null
    }
    const result = resolveXPath(element, cleanField, ignoreNs, false)
    return extractValue(result)
  }

  // Caso 2: path assoluto sotto il flusso corrente
  let relativePath = cleanField
  if (cleanField.startsWith(cleanFlow + '/')) {
    relativePath = cleanField.slice(cleanFlow.length + 1)
  } else if (cleanField === cleanFlow) {
    return element.textContent?.trim() ?? null
  } else {
    // Il campo ha un path assoluto che non è sotto il flusso corrente.
    // Esempio: flusso su /railML/timetable/trains/train/timetablePeriods/stopActivity[*]
    //          campo su  /railML/timetable/trains/train[*]/@trainNumber
    // Strategia: naviga il path dal documento, poi prendi il valore
    // dell'elemento che è ANTENATO dell'elemento corrente del flusso.

    // Separa eventuale attributo finale
    let elemPath  = cleanField
    let attrName: string | null = null
    if (cleanField.includes('/@')) {
      const atIdx = cleanField.lastIndexOf('/@')
      elemPath  = cleanField.slice(0, atIdx)
      attrName  = cleanField.slice(atIdx + 2)
    }

    // Naviga tutti i candidati dal documento
    const candidates = navigatePathAll(doc, elemPath, ignoreNs)

    // Prendi il candidato che è antenato dell'elemento corrente
    for (const candidate of candidates) {
      if (isAncestorOf(candidate, element)) {
        if (attrName) return candidate.getAttribute(attrName)
        return candidate.textContent?.trim() ?? null
      }
    }

    // Fallback: se c'è un solo candidato, usalo (documento non ripetuto)
    if (candidates.length === 1) {
      if (attrName) return candidates[0].getAttribute(attrName)
      return candidates[0].textContent?.trim() ?? null
    }

    return null
  }

  // Attributo relativo
  if (relativePath.startsWith('@')) {
    return element.getAttribute(relativePath.slice(1))
  }
  if (relativePath === 'text()') {
    return element.textContent?.trim() ?? null
  }

  const result = resolveXPath(element, relativePath, ignoreNs, false)
  return extractValue(result)
}

// ─── Controlla se candidate è antenato di el ─────────────────────
function isAncestorOf(candidate: Element, el: Element): boolean {
  let current: Element | null = el.parentElement
  while (current) {
    if (current === candidate) return true
    current = current.parentElement
  }
  return false
}

// ─── Elabora un singolo elemento per un flusso ────────────────────
function processElement(
  element:    Element,
  doc:        Document,
  flow:       XmlParserFlow,
  ignoreNs:   boolean,
  trimText:   boolean,
  rejectRows: Row[],
): Row | null {
  const outRow: Row = {}
  let shouldReject = false

  for (const field of flow.fields) {
    let raw = resolveFieldOnElement(element, doc, field, flow.xpath, ignoreNs)

    // Trim automatico
    if (trimText && typeof raw === 'string') raw = raw.trim()

    if (raw === null || raw === undefined || raw === '') {
      switch (field.onMissing as XmlParserFieldMissing) {
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

// ─── Trova gli elementi target di un flusso nel documento ─────────
function findFlowElements(
  doc:      Document,
  flow:     XmlParserFlow,
  ignoreNs: boolean,
): Element[] {
  const xpath    = flow.xpath.replace(/\[\*\]/g, '')
  const parts    = xpath.split('/').filter(Boolean)
  if (parts.length === 0) return [doc.documentElement]

  // Naviga fino al penultimo segmento, poi raccoglie tutti i figli dell'ultimo
  const parentParts = parts.slice(0, -1)
  const lastName    = parts[parts.length - 1]

  let parents: Element[] = [doc.documentElement]

  for (const part of parentParts) {
    // Salta se il primo segmento coincide con documentElement
    if (parents.length === 1 && lname(parents[0], ignoreNs) === part) continue
    const next: Element[] = []
    for (const el of parents) {
      const children = Array.from(el.children) as Element[]
      next.push(...children.filter((c) => lname(c, ignoreNs) === part))
    }
    parents = next
    if (parents.length === 0) return []
  }

  // Raccoglie tutti i figli con il nome target
  const result: Element[] = []
  for (const parent of parents) {
    if (lname(parent, ignoreNs) === lastName) {
      result.push(parent)
    } else {
      const children = Array.from(parent.children) as Element[]
      result.push(...children.filter((c) => lname(c, ignoreNs) === lastName))
    }
  }

  return result
}

// ─── Executor ─────────────────────────────────────────────────────
export const xmlParserExecutor: NodeExecutor = {
  handles: ['xml_parser'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const config = node.data.config?.xmlParser as XmlParserConfig | undefined
    if (!config) {
      context.callbacks.onLog('warn', 'XmlParser: nessuna configurazione', node.id)
      return new Map([['output', input]])
    }

    const { sourceField, hasReject, flows, ignoreNamespaces = true, trimText = true } = config

    if (!sourceField) {
      context.callbacks.onLog('warn', 'XmlParser: campo sorgente non configurato', node.id)
      return new Map([['output', input]])
    }

    if (flows.length === 0) {
      context.callbacks.onLog('warn', 'XmlParser: nessun flusso configurato', node.id)
      return new Map([['output', input]])
    }

    const outputMap = new Map<string, Row[]>()
    for (const flow of flows) outputMap.set(flow.id, [])
    if (hasReject) outputMap.set('reject', [])

    const rejectRows: Row[] = hasReject ? outputMap.get('reject')! : []

    const domParser      = new DOMParser()
    let totalProcessed   = 0
    let totalRejected    = 0

    for (const inputRow of input) {
      if (context.callbacks.isAborted()) break

      const rawValue = inputRow[sourceField]

      if (rawValue === null || rawValue === undefined) {
        context.callbacks.onLog('warn', `XmlParser: campo '${sourceField}' assente o null`, node.id)
        if (hasReject) rejectRows.push({ ...inputRow, _reject_reason: 'source_field_missing' })
        continue
      }

      const xmlString = typeof rawValue === 'string' ? rawValue : String(rawValue)

      let doc: Document
      try {
        doc = domParser.parseFromString(xmlString, 'text/xml')
        const parseErr = doc.querySelector('parsererror')
        if (parseErr) throw new Error(parseErr.textContent ?? 'XML non valido')
      } catch (e) {
        context.callbacks.onLog('warn', `XmlParser: XML non valido — ${(e as Error).message}`, node.id)
        if (hasReject) rejectRows.push({ ...inputRow, _reject_reason: 'invalid_xml' })
        continue
      }

      for (const flow of flows) {
        const flowOutput = outputMap.get(flow.id)!

        const elements = findFlowElements(doc, flow, ignoreNamespaces)

        if (elements.length === 0) {
          context.callbacks.onLog('warn', `XmlParser flusso '${flow.label}': XPath '${flow.xpath}' non ha match`, node.id)
          continue
        }

        if (flow.isRepeating) {
          for (const element of elements) {
            if (context.callbacks.isAborted()) break
            const row = processElement(element, doc, flow, ignoreNamespaces, trimText, rejectRows)
            if (row) {
              flowOutput.push(row)
              totalProcessed++
            } else {
              totalRejected++
            }
          }
        } else {
          // Singolo — usa il primo elemento
          const row = processElement(elements[0], doc, flow, ignoreNamespaces, trimText, rejectRows)
          if (row) {
            flowOutput.push(row)
            totalProcessed++
          } else {
            totalRejected++
          }
        }
      }
    }

    context.callbacks.onLog('info',
      `XmlParser: ${totalProcessed} righe prodotte, ${totalRejected} rifiutate. ` +
      `Flussi: ${flows.map((f) => `${f.label}=${outputMap.get(f.id)?.length ?? 0}`).join(', ')}`,
      node.id,
    )

    return outputMap
  },
}