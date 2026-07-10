/**
 * src/runner/xmlSerializerExecutor.ts
 *
 * Executor xml_serializer — usa _treeNodes (albero XmlTreeNode[])
 * come struttura primaria, con fallback al vecchio xmlStructure.
 * Supporta multi-flusso (byHandle), dedup, expr, condizionali.
 */
import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Tipi ─────────────────────────────────────────────────────────
type XmlNodeKind = 'element'|'attribute'|'cdata'|'group'

interface XmlTreeNode {
  id: string; xmlName: string; ns: string; kind: XmlNodeKind
  children: XmlTreeNode[]; collapsed: boolean
  sourceHandle?: string; sourceField?: string
  sources?: Array<{ handle: string; field: string }>
  expr?: string; condition?: string; iterHandle?: string
   groupBy?: string  // ← aggiungere
}

// Legacy (vecchio Panel.tsx)
interface XmlOutputNode {
  id: string; xmlName: string; sourceField: string
  kind: XmlNodeKind; namespace: string; transform: string
  nullable: 'omit'|'empty'|'xsi_nil'; children?: XmlOutputNode[]
}

interface XmlFlowMapping {
  handle: string; mode: 'rows'|'single'|'value'; field?: string
  fields: Array<{ id: string; sourceField: string; transform: string; nullable: 'omit'|'empty'|'xsi_nil' }>
  dedup?: boolean
}

// ─── Trasformazioni ───────────────────────────────────────────────
function applyTransform(val: unknown, transform: string): string {
  if (val === null || val === undefined) return ''
  const s = String(val)
  switch (transform) {
    case 'to_string':  return s
    case 'to_int':     return String(parseInt(s, 10))
    case 'to_float':   return String(parseFloat(s.replace(',', '.')))
    case 'to_bool':    return String(['true','1','yes','si','sì'].includes(s.toLowerCase()))
    case 'to_date':    { const d = new Date(s); return isNaN(d.getTime()) ? s : d.toISOString().split('T')[0] }
    case 'uppercase':  return s.toUpperCase()
    case 'lowercase':  return s.toLowerCase()
    case 'trim':       return s.trim()
    default:           return s
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;')
}

// ─── Dedup ────────────────────────────────────────────────────────
function dedupRows(rows: Row[], fields: string[]): Row[] {
  if (!fields.length) return rows
  const seen = new Set<string>()
  return rows.filter((row) => {
    const key = fields.map((f) => String(row[f] ?? '').trim()).join('\x00')
    if (seen.has(key)) return false; seen.add(key); return true
  })
}

function getRows(handle: string, byHandle: Map<string, Row[]>, mappings: Record<string, XmlFlowMapping>, dedupFields?: string[]): Row[] {
  const rows    = byHandle.get(handle) ?? []
  const mapping = mappings[handle]
  if (!mapping?.dedup) return rows
  const fields = dedupFields?.length ? dedupFields
    : mapping.fields.length > 0 ? mapping.fields.map((f) => f.sourceField).filter(Boolean) as string[]
    : Object.keys(rows[0] ?? {}).filter((k) => !k.startsWith('__'))
  return dedupRows(rows, fields)
}

function collectHandleFields(nodes: XmlTreeNode[], handle: string): string[] {
  const f: string[] = []
  function walk(ns: XmlTreeNode[]) {
    ns.forEach((n) => {
      if (n.sourceHandle === handle && n.sourceField) f.push(n.sourceField)
      if (n.sources) n.sources.forEach((s) => { if (s.handle === handle) f.push(s.field) })
      walk(n.children)
    })
  }
  walk(nodes); return [...new Set(f)]
}

// ─── Valuta condizione ────────────────────────────────────────────
function evalCond(cond: string, row: Record<string, unknown>): boolean {
  try { return !!new Function('row', `return (${cond})`)(row) } catch { return true }
}

// ─── Costruisce XML dall'albero nuovo ─────────────────────────────
function buildXmlFromTree(
  nodes:       XmlTreeNode[],
  byHandle:    Map<string, Row[]>,
  mappings:    Record<string, XmlFlowMapping>,
  treeNodes:   XmlTreeNode[],
  indent:      number,
  pretty:      boolean,
  rowContext?:  Map<string, Row>,
): string {
  const pad = pretty ? '  '.repeat(indent) : ''
  const nl  = pretty ? '\n' : ''
  const parts: string[] = []

  for (const n of nodes) {
    //console.log('[XML node]', n.xmlName, 'kind=', n.kind, 'iterHandle=', n.iterHandle, 'children=', n.children.length)
    if (n.kind === 'attribute') continue // gestiti dal padre
    if (!n.xmlName) continue

    const tag = n.ns ? `${n.ns}:${n.xmlName}` : n.xmlName

    // Risolve riga effettiva
    const getRow = (handle: string): Record<string, unknown> => {
      if (rowContext?.has(handle)) return rowContext.get(handle) as Record<string, unknown>
      return (byHandle.get(handle) ?? [])[0] ?? {}
    }

    // Attributi del nodo
    const attrNodes = n.children.filter((c) => c.kind === 'attribute')
    const attrStr   = attrNodes.map((a) => {
      const atag = a.ns ? `${a.ns}:${a.xmlName}` : a.xmlName
      const aRow = a.sourceHandle ? getRow(a.sourceHandle) : {}
      let aVal: unknown = a.sourceField ? (aRow[a.sourceField] ?? null) : null
      if (a.expr) { try { aVal = new Function('row', `return (${a.expr})`)(aRow) } catch {} }
      if (aVal === null || aVal === undefined) return ''
      return ` ${atag}="${escapeXml(String(aVal))}"`
    }).join('')

    // CDATA
    if (n.kind === 'cdata') {
      const row = n.sourceHandle ? getRow(n.sourceHandle) : {}
      let val: unknown = n.sourceField ? (row[n.sourceField] ?? null) : null
      if (n.expr) { try { val = new Function('row', `return (${n.expr})`)(row) } catch {} }
      parts.push(`${pad}<${tag}><![CDATA[${val ?? ''}]]></${tag}>`)
      continue
    }

    // Elemento/group con figli strutturati
    const childElms = n.children.filter((c) => c.kind !== 'attribute')
    if (n.kind === 'group' || childElms.length > 0) {
      // Determina handle iterazione
      const iterH = n.iterHandle
        

      if (iterH) {
  
        const dedupF = collectHandleFields(treeNodes, iterH)
        const rows   = getRows(iterH, byHandle, mappings, dedupF.length ? dedupF : undefined)

        const rendered = (() => {
          // groupBy: raggruppa le righe per campo chiave
          if (n.groupBy) {
 // console.log('[XML groupBy start]', n.xmlName, 'rows=', rows.length, 'groupField=', n.groupBy)
            const groupField = n.groupBy  // ← estrai qui
            const handle = iterH!
            const groups = new Map<string, Row[]>()
            for (const row of rows) {
              const k = String(row[groupField] ?? '\x00null\x00')
              if (!groups.has(k)) groups.set(k, [])
              groups.get(k)!.push(row)
            }
           
            return Array.from(groups.values()).map((groupRows) => {
 // console.log('[XML group]', n.xmlName, 'groupRows=', groupRows.length, 'key=', groupRows[0]?.[n.groupBy!])
              const groupByHandle = new Map(byHandle)
              groupByHandle.set(handle, groupRows)
              const ctx = new Map<string, Row>(rowContext ?? [])
            
              ctx.set(handle, groupRows[0])
//console.log('[XML groupBy]', n.groupBy, 'key=', groupRows[0]?.[groupField], 'ctx[input]=', ctx.get(handle)?.[groupField])
              // ← calcola attrStr QUI con il ctx del gruppo
              const groupAttrStr = attrNodes.map((a) => {
   //console.log('[XML attr]', a.xmlName, 'sourceHandle=', a.sourceHandle, 'sourceField=', a.sourceField)
  
                const atag = a.ns ? `${a.ns}:${a.xmlName}` : a.xmlName
                const aRow = a.sourceHandle ? (ctx.has(a.sourceHandle) ? ctx.get(a.sourceHandle) as Record<string,unknown> : (groupByHandle.get(a.sourceHandle) ?? [])[0] ?? {}) : {}
//console.log('[XML attr val]', 'ctx.has=', ctx.has(a.sourceHandle!), 'aRow[film_id]=', aRow['film_id'])
                let aVal: unknown = a.sourceField ? (aRow[a.sourceField] ?? null) : null
                if (a.expr) { try { aVal = new Function('row', `return (${a.expr})`)(aRow) } catch {} }
                if (aVal === null || aVal === undefined) return ''
                return ` ${atag}="${escapeXml(String(aVal))}"`
              }).join('')

              const inner = buildXmlFromTree(childElms, groupByHandle, mappings, treeNodes, indent + 1, pretty, ctx)
              return `${pad}<${tag}${groupAttrStr}>${nl}${inner}${nl}${pad}</${tag}>`
            }).join(nl)
          }
          // iterazione normale
          return rows.map((row) => {
            const ctx = new Map<string, Row>(rowContext ?? [])
            ctx.set(iterH, row)
            const inner = buildXmlFromTree(childElms, byHandle, mappings, treeNodes, indent + 1, pretty, ctx)
            return `${pad}<${tag}${attrStr}>${nl}${inner}${nl}${pad}</${tag}>`
          }).join(nl)
        })()

        parts.push(rendered)
      } else {
        //console.log('[XML wrapper]', n.xmlName, 'depth=', indent)
        const inner = buildXmlFromTree(childElms, byHandle, mappings, treeNodes, indent + 1, pretty, rowContext)
        parts.push(`${pad}<${tag}${attrStr}>${nl}${inner}${nl}${pad}</${tag}>`)
      }
      continue
    }


    // Foglia con iterHandle — itera su tutte le righe dell'handle
    if (n.iterHandle) {
      const iterH2 = n.iterHandle
      const iterRows = byHandle.get(iterH2) ?? []
      const iterParts = iterRows.map((irow) => {
        let val: unknown = n.sourceField ? (irow[n.sourceField] ?? null) : null
        if (n.expr) {
          try { val = new Function('row', `return (${n.expr})`)(irow) } catch { val = null }
        }
        if (n.condition && !evalCond(n.condition, irow as Record<string, unknown>)) return ''
        if (val === null || val === undefined) return `${pad}<${tag}${attrStr}/>`
        return `${pad}<${tag}${attrStr}>${escapeXml(String(val))}</${tag}>`
      }).filter(Boolean)
      parts.push(iterParts.join(nl))
      continue
    }

   
    // Foglia
    const row = n.sourceHandle ? getRow(n.sourceHandle) : {}
    let val: unknown = n.sourceField ? (row[n.sourceField] ?? null) : null

    if (n.expr) {
      try {
        const sources = n.sources?.length ? n.sources : n.sourceHandle && n.sourceField ? [{handle: n.sourceHandle, field: n.sourceField}] : []
        const mergedRow: Record<string, unknown> = {}
        sources.forEach((s) => Object.assign(mergedRow, getRow(s.handle)))
        val = new Function('row', `return (${n.expr})`)(mergedRow)
      } catch { val = null }
    }

    if (n.condition && !evalCond(n.condition, row)) continue

    if (val === null || val === undefined) {
      parts.push(`${pad}<${tag}${attrStr}/>`)
      continue
    }

    parts.push(`${pad}<${tag}${attrStr}>${escapeXml(String(val))}</${tag}>`)
  }

  return parts.join(nl)
}

// ─── Costruisce XML dal vecchio schema (legacy) ───────────────────
function buildXmlLegacy(row: Row, nodes: XmlOutputNode[], indent: number, pretty: boolean): string {
  const pad = pretty ? '  '.repeat(indent) : ''
  const nl  = pretty ? '\n' : ''
  const parts: string[] = []
  for (const n of nodes) {
    if (!n.xmlName || n.kind === 'attribute') continue
    const tag    = n.namespace ? `${n.namespace}:${n.xmlName}` : n.xmlName
    const rawVal = n.sourceField ? (row[n.sourceField] ?? null) : null
    const isNull = rawVal === null || rawVal === undefined
    if (n.kind === 'cdata') {
      if (isNull && n.nullable === 'omit') continue
      parts.push(`${pad}<${tag}><![CDATA[${isNull ? '' : applyTransform(rawVal, n.transform)}]]></${tag}>`)
      continue
    }
    if (n.kind === 'group' || (n.children && n.children.length > 0)) {
      const attrs    = (n.children ?? []).filter((c) => c.kind === 'attribute')
        .map((a) => { const v = a.sourceField ? (row[a.sourceField] ?? null) : null; if (!v) return ''; return ` ${a.namespace ? a.namespace + ':' : ''}${a.xmlName}="${escapeXml(applyTransform(v, a.transform))}"` }).join('')
      const childElm = (n.children ?? []).filter((c) => c.kind !== 'attribute')
      const inner    = buildXmlLegacy(row, childElm, indent + 1, pretty)
      parts.push(inner ? `${pad}<${tag}${attrs}>${nl}${inner}${nl}${pad}</${tag}>` : `${pad}<${tag}${attrs}/>`)
      continue
    }
    if (isNull) { switch (n.nullable) { case 'omit': continue; case 'empty': parts.push(`${pad}<${tag}/>`); continue; case 'xsi_nil': parts.push(`${pad}<${tag} xsi:nil="true"/>`); continue } }
    parts.push(`${pad}<${tag}>${escapeXml(applyTransform(rawVal, n.transform))}</${tag}>`)
  }
  return parts.join(nl)
}

// ─── Serializza riga ──────────────────────────────────────────────
function serializeRow(
  row: Row, treeNodes: XmlTreeNode[], legacyStructure: XmlOutputNode[],
  byHandle: Map<string, Row[]>, mappings: Record<string, XmlFlowMapping>,
  rootElement: string, rootNsPrefix: string, rootNs: string,
  namespaces: string, declaration: boolean, encoding: string, pretty: boolean,
): string {
  const parts: string[] = []
  if (declaration) parts.push(`<?xml version="1.0" encoding="${encoding}"?>`)

  const rootTag = rootNsPrefix ? `${rootNsPrefix}:${rootElement}` : rootElement
  const nsAttrs: string[] = []
  if (rootNs && rootNsPrefix) nsAttrs.push(`xmlns:${rootNsPrefix}="${rootNs}"`)
  else if (rootNs) nsAttrs.push(`xmlns="${rootNs}"`)
  if (namespaces) {
    for (const line of namespaces.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const [prefix, uri] = line.split('=').map((s) => s.trim())
      if (prefix && uri) nsAttrs.push(`xmlns:${prefix}="${uri}"`)
    }
  }
  const nsStr = nsAttrs.length > 0 ? ' ' + nsAttrs.join(' ') : ''
  const nl    = pretty ? '\n' : ''

  let body = ''
  if (treeNodes.length > 0) {
    // rowContext: per la riga corrente imposta l'handle principale
    const ctx = new Map<string, Row>()
    byHandle.forEach((rows, h) => { if (rows.length > 0) ctx.set(h, row) })
    body = buildXmlFromTree(treeNodes, byHandle, mappings, treeNodes, 1, pretty, ctx)
  } else if (legacyStructure.length > 0) {
    body = buildXmlLegacy(row, legacyStructure, 1, pretty)
  } else {
    // Auto: tutti i campi
    const autoNodes: XmlOutputNode[] = Object.keys(row)
      .filter((k) => !k.startsWith('__'))
      .map((k) => ({ id: k, xmlName: k, sourceField: k, kind: 'element' as const, namespace: '', transform: '', nullable: 'omit' as const }))
    body = buildXmlLegacy(row, autoNodes, 1, pretty)
  }

  parts.push(`<${rootTag}${nsStr}>${nl}${body}${nl}</${rootTag}>`)
  return parts.join(nl)
}

// ─── Executor ─────────────────────────────────────────────────────
export const xmlSerializerExecutor: NodeExecutor = {
  handles: ['xml_serializer'],

  requiresCompleteInput: (node) => {
    const serConfig = (node.data.config as any)?.xmlSerializer ?? {}
    const mappings  = serConfig.mappings ?? {}
    return Object.keys(mappings).length > 1
  },

  async execute(node: FlowNode<NodeData>, input: Row[], context: ExecutionContext): Promise<Map<string, Row[]>> {
    const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)

    const outputField  = p('outputField', 'xml_output')
    const rootElement  = p('rootElement', 'record')
    const rootNsPrefix = p('rootNsPrefix', '')
    const rootNs       = p('rootNamespace', '')
    const namespaces   = p('namespaces', '')
    const declaration  = p('xmlDeclaration', 'true') === 'true'
    const encoding     = p('encoding', 'UTF-8')
    const pretty       = p('pretty', 'false') === 'true'
    const onError      = p('onError', 'reject')

    let treeNodes: XmlTreeNode[] = []
    let legacyStructure: XmlOutputNode[] = []
    try { treeNodes = JSON.parse(p('_treeNodes', '[]')) } catch {}
    if (!treeNodes.length) {
      try { legacyStructure = JSON.parse(p('xmlStructure', '[]')) } catch {}
    }

    const serConfig  = (node.data.config as any)?.xmlSerializer ?? {}
    const mappings:  Record<string, XmlFlowMapping> = serConfig.mappings ?? {}

    // Raggruppa per handle
    const byHandle = new Map<string, Row[]>()
    for (const row of input) {
      const r = row as any
      const handle = String(r['__sourceHandle'] ?? 'input')
      if (!byHandle.has(handle)) byHandle.set(handle, [])
      const { __sourceHandle, ...cleanRow } = r
      byHandle.get(handle)!.push(cleanRow)
    }
    if (byHandle.size === 0) byHandle.set('input', input)

    context.callbacks.onLog('info',
      `XmlSerializer handles: ${[...byHandle.entries()].map(([h,r]) => `${h}(${r.length})`).join(', ')}`,
      node.id)

    const output:  Row[] = []
    const rejects: Row[] = []

    // Se albero multi-flusso: serializza una volta sola (documento aggregato) - sarebbe da mettere una opzione 
    if (treeNodes.length > 0) {
      try {
        const nl = pretty ? '\n' : ''
        const rootTag = rootNsPrefix ? `${rootNsPrefix}:${rootElement}` : rootElement
        const nsAttrs: string[] = []
        if (rootNs && rootNsPrefix) nsAttrs.push(`xmlns:${rootNsPrefix}="${rootNs}"`)
        else if (rootNs) nsAttrs.push(`xmlns="${rootNs}"`)
        if (namespaces) {
          for (const line of namespaces.split('\n').map((l) => l.trim()).filter(Boolean)) {
            const [prefix, uri] = line.split('=').map((s) => s.trim())
            if (prefix && uri) nsAttrs.push(`xmlns:${prefix}="${uri}"`)
          }
        }
        const nsStr = nsAttrs.length > 0 ? ' ' + nsAttrs.join(' ') : ''
        const parts: string[] = []
        if (declaration) parts.push(`<?xml version="1.0" encoding="${encoding}"?>`)
        const body = buildXmlFromTree(treeNodes, byHandle, mappings, treeNodes, 1, pretty, undefined)
        parts.push(`<${rootTag}${nsStr}>${nl}${body}${nl}</${rootTag}>`)
        output.push({ [outputField]: parts.join(nl) })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        switch (onError) {
          case 'reject': rejects.push({ _xml_error: msg }); break
          case 'empty':  output.push({ [outputField]: `<${rootElement}/>` }); break
          case 'stop':   throw new Error(`XmlSerializer: ${msg}`)
        }
      }

    } else {
      // Flusso singolo: serializza riga per riga
      const rows = byHandle.get('input') ?? input
      for (const row of rows) {
        if (context.callbacks.isAborted()) break
        try {
          const xml = serializeRow(row, treeNodes, legacyStructure, byHandle, mappings, rootElement, rootNsPrefix, rootNs, namespaces, declaration, encoding, pretty)
          output.push({ ...row, [outputField]: xml })
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err)
          switch (onError) {
            case 'reject': rejects.push({ ...row, _xml_error: msg }); break
            case 'empty':  output.push({ ...row, [outputField]: `<${rootElement}/>` }); break
            case 'skip':   break
            case 'stop':   throw new Error(`XmlSerializer: ${msg}`)
          }
        }
      }
    }

    context.callbacks.onLog('info',
      `XmlSerializer: ${output.length} righe → '${outputField}'${rejects.length > 0 ? `, ${rejects.length} rifiutate` : ''}`,
      node.id)

    const result = new Map<string, Row[]>([['output', output]])
    if (rejects.length > 0) result.set('reject', rejects)
    return result
  },
}