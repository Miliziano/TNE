/**
 * src/nodes/types/xml_parser/XmlParserModal.tsx
 */
import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFlowStore } from '../../../store/flowStore'
import type { TMapConfig } from '../../../types'
import { TabGeneral }  from '../../../components/tabs/TabGeneral'
import { TabAdvanced } from '../../../components/tabs/TabAdvanced'
import { useIncomingSchema } from '../../useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'
import type {
  XmlParserConfig, XmlParserFlow, XmlParserField,
  XmlFieldType, XmlFieldTransform, XmlFieldMissing,
} from './xmlParserTypes'
import { parseXsd, type XsdNode } from '../shared/xsdParser'

interface XmlTreeNode {
  id:          string
  name:        string
  xpath:       string
  nodeType:    'element' | 'attribute' | 'text'
  isRepeating: boolean
  children:    XmlTreeNode[]
  collapsed:   boolean
  occurrences: number
}

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}

const ACCENT = '#f97316'

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function SectionTitle({ label, color = ACCENT }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6, flexShrink: 0 }}>
      {label}
    </div>
  )
}

const FLOW_COLORS = [
  '#4a9eff', '#3ddc84', '#ffb347', '#a78bfa', '#22d3ee',
  '#f472b6', '#84cc16', '#fb923c', '#e879f9', '#ff5f57',
]

const FIELD_TYPES: XmlFieldType[] = ['string', 'integer', 'decimal', 'boolean', 'date', 'object', 'any']

const TRANSFORMS: Array<{ value: XmlFieldTransform; label: string }> = [
  { value: 'none',       label: 'Nessuna'   },
  { value: 'trim',       label: 'trim'      },
  { value: 'uppercase',  label: 'UPPERCASE' },
  { value: 'lowercase',  label: 'lowercase' },
  { value: 'to_integer', label: '→ integer' },
  { value: 'to_decimal', label: '→ decimal' },
  { value: 'to_boolean', label: '→ boolean' },
  { value: 'to_date',    label: '→ date'    },
  { value: 'to_string',  label: '→ string'  },
]

const ON_MISSING: Array<{ value: XmlFieldMissing; label: string }> = [
  { value: 'null',    label: 'null'        },
  { value: 'default', label: 'Usa default' },
  { value: 'skip',    label: 'Salta riga'  },
  { value: 'error',   label: 'Reject'      },
]

let _counter = 0

// ─── Parser XML sample (invariato) ───────────────────────────────
function buildXmlTree(xmlString: string, ignoreNs = true): XmlTreeNode[] {
  try {
    const parser = new DOMParser()
    const doc    = parser.parseFromString(xmlString, 'text/xml')
    const errors = doc.querySelector('parsererror')
    if (errors) return []
    const root = doc.documentElement
    return [buildNodeFromElement(root, '/', ignoreNs)]
  } catch { return [] }
}

function localName(el: Element, ignoreNs: boolean): string {
  return ignoreNs ? el.localName : el.tagName
}

function buildNodeFromElement(el: Element, parentXpath: string, ignoreNs: boolean, depth = 0): XmlTreeNode {
  const id    = `xn_${++_counter}_${Date.now()}`
  const name  = localName(el, ignoreNs)
  const xpath = parentXpath === '/' ? `/${name}` : `${parentXpath}/${name}`

  const siblings    = el.parentElement
    ? Array.from(el.parentElement.children).filter((c) => localName(c as Element, ignoreNs) === name)
    : [el]
  const isRepeating = siblings.length > 1
  const effectXpath = isRepeating ? `${xpath.replace(`/${name}`, '')}/${name}[*]` : xpath

  const attrChildren: XmlTreeNode[] = Array.from(el.attributes).map((attr) => ({
    id:          `xn_${++_counter}_${Date.now()}`,
    name:        `@${attr.name}`,
    xpath:       `${effectXpath}/@${attr.name}`,
    nodeType:    'attribute' as const,
    isRepeating: false,
    children:    [],
    collapsed:   false,
    occurrences: 1,
  }))

  const childElements = Array.from(el.children)
  const seenChildren  = new Set<string>()
  const elementChildren: XmlTreeNode[] = []

  childElements.forEach((child) => {
    const cName = localName(child as Element, ignoreNs)
    if (seenChildren.has(cName)) return
    seenChildren.add(cName)
    elementChildren.push(buildNodeFromElement(child as Element, effectXpath, ignoreNs, depth + 1))
  })

  return {
    id, name, xpath: effectXpath, nodeType: 'element',
    isRepeating, children: [...attrChildren, ...elementChildren],
    collapsed: depth > 1, occurrences: siblings.length,
  }
}

// ─── Parser XSD via modulo condiviso ─────────────────────────────
// Converte XsdNode → XmlTreeNode (formato interno del modal).
// Il modal usa isRepeating/occurrences; il tipo condiviso usa multiple/optional.
function xsdNodeToModalTree(n: XsdNode, depth: number): XmlTreeNode {
  return {
    id:          `xn_${++_counter}_${Date.now()}`,
    name:        n.kind === 'attribute' ? `@${n.name}` : n.name,
    xpath:       '',           // assegnato da assignModalXPaths
    nodeType:    n.kind === 'attribute' ? 'attribute' : 'element',
    isRepeating: n.multiple,
    children:    n.children.map((c) => xsdNodeToModalTree(c, depth + 1)),
    collapsed:   depth > 1,
    occurrences: n.multiple ? 2 : 1,
  }
}

function assignModalXPaths(nodes: XmlTreeNode[], parentXPath = '/'): XmlTreeNode[] {
  return nodes.map((n) => {
    const isAttr = n.nodeType === 'attribute'
    const name   = isAttr ? n.name.replace('@', '') : n.name
    const xpath  = isAttr
      ? `${parentXPath === '/' ? '' : parentXPath}/@${name}`
      : parentXPath === '/'
        ? `/${name}`
        : `${parentXPath}/${name}`
    const effectXpath = n.isRepeating ? `${xpath}[*]` : xpath
    return {
      ...n,
      xpath: effectXpath,
      children: assignModalXPaths(n.children, effectXpath),
    }
  })
}

function buildXmlTreeFromXsd(xsdString: string): XmlTreeNode[] {
  try {
    const xsdNodes = parseXsd(xsdString)
    if (xsdNodes.length === 0) return []
    return assignModalXPaths(xsdNodes.map((n) => xsdNodeToModalTree(n, 0)))
  } catch { return [] }
}

// ─── Resto invariato ──────────────────────────────────────────────
function generateFlowsFromXml(xmlString: string, ignoreNs = true): { flows: XmlParserFlow[]; tree: XmlTreeNode[] } {
  const tree: XmlTreeNode[] = buildXmlTree(xmlString, ignoreNs)
  const flows: XmlParserFlow[] = []

  try {
    const parser = new DOMParser()
    const doc    = parser.parseFromString(xmlString, 'text/xml')
    if (doc.querySelector('parsererror')) return { flows, tree }

    const root         = doc.documentElement
    const childNames   = Array.from(root.children).map((c) => localName(c as Element, ignoreNs))
    const repeatingMap = new Map<string, number>()
    childNames.forEach((n) => repeatingMap.set(n, (repeatingMap.get(n) ?? 0) + 1))

    const repeatingNames  = [...repeatingMap.entries()].filter(([, c]) => c > 1).map(([n]) => n)
    const complexChildren = Array.from(root.children).filter((c) => c.children.length > 0)
    const significant     = repeatingNames.length > 0
      ? repeatingNames
      : complexChildren.map((c) => localName(c as Element, ignoreNs))
    const rootName = localName(root, ignoreNs)

    if (significant.length > 0) {
      const seen = new Set<string>()
      significant.forEach((name, idx) => {
        if (seen.has(name)) return
        seen.add(name)
        const sample = Array.from(root.children).find((c) => localName(c as Element, ignoreNs) === name)
        if (!sample) return
        const isRep  = (repeatingMap.get(name) ?? 1) > 1
        const xpath  = isRep ? `/${rootName}/${name}[*]` : `/${rootName}/${name}`
        const fields = extractFieldsFromElement(sample as Element, xpath, ignoreNs)
        flows.push({
          id: `flow_${Date.now()}_${idx}`, label: name,
          color: FLOW_COLORS[idx % FLOW_COLORS.length],
          xpath, isRepeating: isRep, streaming: false, fields,
        })
      })
    } else {
      const xpath  = `/${rootName}`
      const fields = extractFieldsFromElement(root, xpath, ignoreNs)
      flows.push({
        id: `flow_${Date.now()}_0`, label: rootName,
        color: FLOW_COLORS[0], xpath, isRepeating: false, streaming: false, fields,
      })
    }
  } catch {}

  return { flows, tree }
}

function extractFieldsFromElement(el: Element, baseXpath: string, ignoreNs: boolean): XmlParserField[] {
  const fields: XmlParserField[] = []

  Array.from(el.attributes).forEach((attr, i) => {
    fields.push({
      id: `f_attr_${i}_${Date.now()}`, name: attr.name,
      xpath: `${baseXpath}/@${attr.name}`, type: 'string',
      isAttribute: true, transform: 'none', onMissing: 'null',
    })
  })

  const seen = new Set<string>()
  Array.from(el.children).forEach((child, i) => {
    const cName = localName(child as Element, ignoreNs)
    if (seen.has(cName)) return
    seen.add(cName)
    const isLeaf = child.children.length === 0
    const type: XmlFieldType = !isLeaf ? 'object'
      : child.textContent?.match(/^\d+$/) ? 'integer'
      : child.textContent?.match(/^\d+\.\d+$/) ? 'decimal'
      : child.textContent?.toLowerCase() === 'true' || child.textContent?.toLowerCase() === 'false' ? 'boolean'
      : 'string'
    fields.push({
      id: `f_${i}_${Date.now()}`, name: cName,
      xpath: `${baseXpath}/${cName}`, type,
      isAttribute: false, transform: 'none', onMissing: 'null',
    })
  })

  if (el.children.length === 0 && el.textContent?.trim()) {
    fields.push({
      id: `f_text_${Date.now()}`, name: 'text',
      xpath: `${baseXpath}/text()`, type: 'string',
      isAttribute: false, transform: 'none', onMissing: 'null',
    })
  }

  return fields
}

function flattenXmlTree(nodes: XmlTreeNode[]): XmlTreeNode[] {
  const result: XmlTreeNode[] = []
  function walk(n: XmlTreeNode) { result.push(n); n.children.forEach(walk) }
  nodes.forEach(walk)
  return result
}

function XmlTreeNodeRow({ node, depth, flows, onToggleFieldInFlow, onGenerateFlow, onToggle }: {
  node:                XmlTreeNode
  depth:               number
  flows:               XmlParserFlow[]
  onToggleFieldInFlow: (node: XmlTreeNode, flowId: string) => void
  onGenerateFlow:      (node: XmlTreeNode) => void
  onToggle:            (id: string) => void
}) {
  const isLeaf = node.children.length === 0
  const isAttr = node.nodeType === 'attribute'
  const color  = isAttr ? '#a78bfa' : node.isRepeating ? '#ffb347' : isLeaf ? '#3ddc84' : '#c8d4f0'
  const indent = depth * 14

  const flowMembership = flows.map((flow) => ({
    flow, isMember: flow.fields.some((f) => f.xpath === node.xpath),
  }))

  return (
    <>
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', paddingLeft: 6 + indent, cursor: 'pointer', borderBottom: '0.5px solid #1a2030', background: 'transparent' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2535' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>

        {node.children.length > 0 ? (
          <button onClick={(e) => { e.stopPropagation(); onToggle(node.id) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, width: 12, flexShrink: 0 }}>
            <i className={`ti ${node.collapsed ? 'ti-chevron-right' : 'ti-chevron-down'}`} style={{ fontSize: 9 }} />
          </button>
        ) : (
          <div style={{ width: 12, flexShrink: 0 }} />
        )}

        <span style={{ fontSize: 9, color, fontFamily: 'monospace', flexShrink: 0, minWidth: 16 }}>
          {isAttr ? '@' : node.isRepeating ? '[]' : isLeaf ? '—' : '<>'}
        </span>
        <span style={{ fontSize: 10, color, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.name}
        </span>
        {node.isRepeating && <span style={{ fontSize: 9, color: '#ffb347', flexShrink: 0, marginRight: 2 }}>×{node.occurrences}</span>}
        {isLeaf && !isAttr && <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0, marginRight: 4 }}>text</span>}
        {isAttr && <span style={{ fontSize: 9, color: '#a78bfa', flexShrink: 0, marginRight: 4 }}>attr</span>}

        {flows.length > 0 && (
          <div style={{ display: 'flex', gap: 3, flexShrink: 0, alignItems: 'center', marginLeft: 'auto' }}>
            {flowMembership.map(({ flow, isMember }) => (
              <button key={flow.id}
                onClick={(e) => { e.stopPropagation(); onToggleFieldInFlow(node, flow.id) }}
                title={isMember ? `Rimuovi da "${flow.label}"` : `Aggiungi a "${flow.label}"`}
                style={{ width: 10, height: 10, borderRadius: '50%', background: isMember ? flow.color : 'transparent', border: `1.5px solid ${flow.color}`, cursor: 'pointer', padding: 0, flexShrink: 0, transition: 'background .12s, transform .1s', transform: isMember ? 'scale(1.1)' : 'scale(1)' }}
                onMouseEnter={(e) => { const el = e.currentTarget as HTMLElement; el.style.transform = 'scale(1.25)'; el.style.background = isMember ? `color-mix(in srgb, ${flow.color} 60%, transparent)` : `color-mix(in srgb, ${flow.color} 40%, transparent)` }}
                onMouseLeave={(e) => { const el = e.currentTarget as HTMLElement; el.style.transform = isMember ? 'scale(1.1)' : 'scale(1)'; el.style.background = isMember ? flow.color : 'transparent' }}
              />
            ))}
          </div>
        )}

        {!isAttr && !isLeaf && (
          <button onClick={(e) => { e.stopPropagation(); onGenerateFlow(node) }}
            title="Genera flusso da questo elemento"
            style={{ background: '#0d3d20', border: '1px solid #1d6d40', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#3ddc84', fontSize: 9, flexShrink: 0, marginLeft: 4, display: 'flex', alignItems: 'center', gap: 2 }}>
            <i className="ti ti-plus" style={{ fontSize: 9 }} /> flusso
          </button>
        )}
      </div>

      {!node.collapsed && node.children.map((child) => (
        <XmlTreeNodeRow key={child.id} node={child} depth={depth + 1}
          flows={flows} onToggleFieldInFlow={onToggleFieldInFlow}
          onGenerateFlow={onGenerateFlow} onToggle={onToggle} />
      ))}
    </>
  )
}

function FlowFieldsTable({ flow, color, selectedFlowId, onSelect, onUpdate, onDelete }: {
  flow:           XmlParserFlow
  color:          string
  selectedFlowId: string | null
  onSelect:       (id: string | null) => void
  onUpdate:       (patch: Partial<XmlParserFlow>) => void
  onDelete:       () => void
}) {
  const [maximized, setMaximized] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const isSelected = selectedFlowId === flow.id

  const addField = () => {
    const n = flow.fields.length + 1
    onUpdate({ fields: [...flow.fields, { id: `f_${Date.now()}`, name: `campo_${n}`, xpath: `/root/campo_${n}`, type: 'string', isAttribute: false, transform: 'none', onMissing: 'null' }] })
  }
  const updateField = (id: string, key: string, value: any) =>
    onUpdate({ fields: flow.fields.map((f) => f.id === id ? { ...f, [key]: value } : f) })
  const deleteField = (id: string) =>
    onUpdate({ fields: flow.fields.filter((f) => f.id !== id) })

  return (
    <div onClick={() => onSelect(isSelected ? null : flow.id)}
      style={{ border: `1px solid ${isSelected ? color : color + '40'}`, borderRadius: 8, overflow: 'hidden', marginBottom: 8, flexShrink: 0, cursor: 'pointer', transition: 'border-color .15s' }}>

      <div style={{ padding: '6px 10px', background: isSelected ? `color-mix(in srgb, ${color} 15%, #1a2030)` : `color-mix(in srgb, ${color} 8%, #1a2030)`, borderBottom: collapsed ? 'none' : `0.5px solid ${color}30`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: isSelected ? color : `${color}50`, border: `1.5px solid ${color}`, flexShrink: 0 }} />
        <input value={flow.label} onClick={(e) => e.stopPropagation()} onChange={(e) => onUpdate({ label: e.target.value })}
          style={{ background: 'none', border: 'none', outline: 'none', fontSize: 11, fontWeight: 600, color, fontFamily: 'monospace', flex: 1, minWidth: 0 }} />
        <code style={{ fontSize: 9, color: '#4a5a7a', maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{flow.xpath}</code>
        {flow.isRepeating && <span style={{ fontSize: 9, color: '#ffb347' }}>[ ]</span>}
        {flow.streaming   && <i className="ti ti-wave-sine" style={{ fontSize: 9, color: '#ffb347' }} />}
        <button onClick={(e) => { e.stopPropagation(); setMaximized((v) => !v) }}
          style={{ background: 'none', border: `0.5px solid ${color}40`, borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: '#4a5a7a' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className={`ti ${maximized ? 'ti-arrows-minimize' : 'ti-arrows-maximize'}`} style={{ fontSize: 9 }} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); setCollapsed((v) => !v) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}>
          <i className={`ti ${collapsed ? 'ti-chevron-down' : 'ti-chevron-up'}`} style={{ fontSize: 10 }} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); onDelete() }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-x" style={{ fontSize: 10 }} />
        </button>
      </div>

      {!collapsed && (
        <div style={{ background: '#161b27' }} onClick={(e) => e.stopPropagation()}>
          <div style={{ display: 'flex', gap: 4, padding: '5px 10px', borderBottom: `0.5px solid ${color}20`, flexWrap: 'wrap', alignItems: 'center' }}>
            <input value={flow.xpath} onChange={(e) => onUpdate({ xpath: e.target.value })}
              style={{ ...inputStyle, fontSize: 9, padding: '2px 6px', width: 180 }} placeholder="/root/element" />
            {[
              { key: 'isRepeating', label: '[ ] Ripetuto', title: 'Genera una riga per ogni match' },
              { key: 'streaming',   label: '〜 Stream',     title: 'Streaming'                      },
            ].map((opt) => (
              <button key={opt.key} title={opt.title} onClick={() => onUpdate({ [opt.key]: !(flow as any)[opt.key] })}
                style={{ padding: '2px 8px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: (flow as any)[opt.key] ? `color-mix(in srgb, ${color} 20%, #161b27)` : '#1e2535', color: (flow as any)[opt.key] ? color : '#4a5a7a', border: (flow as any)[opt.key] ? `1px solid ${color}60` : '1px solid #2a3349' }}>
                {opt.label}
              </button>
            ))}
            <button onClick={addField}
              style={{ marginLeft: 'auto', background: 'none', border: `0.5px dashed ${color}60`, borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', color }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = color }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${color}60` }}>
              <i className="ti ti-plus" style={{ fontSize: 9 }} /> campo
            </button>
          </div>

          {flow.fields.length === 0 ? (
            <div style={{ padding: '12px', textAlign: 'center', fontSize: 10, color: '#2a3349', fontStyle: 'italic' }}>
              Seleziona i campi dall'albero oppure aggiungi manualmente
            </div>
          ) : (
            <>
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(60px, 0.8fr) minmax(120px, 1.3fr) 40px 70px 80px 80px 24px', gap: 4, padding: '3px 8px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', flexShrink: 0 }}>
                {['Nome', 'XPath', '@', 'Tipo', 'Trasforma', 'Mancante', ''].map((h, i) => (
                  <div key={i} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{h}</div>
                ))}
              </div>
              <div style={{ overflowY: 'auto', maxHeight: maximized ? 'none' : 200 }}>
                {flow.fields.map((f, idx) => (
                  <div key={f.id}
                    style={{ display: 'grid', gridTemplateColumns: 'minmax(60px, 0.8fr) minmax(120px, 1.3fr) 40px 70px 80px 80px 24px', gap: 4, alignItems: 'center', padding: '3px 8px', background: idx % 2 === 0 ? '#1a2030' : 'transparent', borderBottom: idx < flow.fields.length - 1 ? '0.5px solid #2a3349' : 'none' }}>
                    <input value={f.name} onChange={(e) => updateField(f.id, 'name', e.target.value)}
                      style={{ ...inputStyle, fontSize: 10, padding: '2px 5px' }} />
                    <input value={f.xpath} onChange={(e) => updateField(f.id, 'xpath', e.target.value)}
                      style={{ ...inputStyle, fontSize: 9, padding: '2px 5px', color: '#9a9aaa' }} placeholder="/root/campo" />
                    <button onClick={() => updateField(f.id, 'isAttribute', !f.isAttribute)}
                      title={f.isAttribute ? 'È un attributo XML' : 'È un elemento'}
                      style={{ padding: '2px 4px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: f.isAttribute ? '#2a1a4a' : 'transparent', color: f.isAttribute ? '#a78bfa' : '#2a3349', border: f.isAttribute ? '1px solid #4a2a8a' : '1px solid #2a3349', fontFamily: 'monospace', fontWeight: 700 }}>
                      @
                    </button>
                    <CustomSelect value={f.type} onChange={(e) => updateField(f.id, 'type', e.target.value)}
                      style={{ ...inputStyle, fontSize: 9, padding: '2px 3px' }}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </CustomSelect>
                    <CustomSelect value={f.transform} onChange={(e) => updateField(f.id, 'transform', e.target.value as XmlFieldTransform)}
                      style={{ ...inputStyle, fontSize: 9, padding: '2px 3px' }}>
                      {TRANSFORMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </CustomSelect>
                    <CustomSelect value={f.onMissing} onChange={(e) => updateField(f.id, 'onMissing', e.target.value as XmlFieldMissing)}
                      style={{ ...inputStyle, fontSize: 9, padding: '2px 3px' }}>
                      {ON_MISSING.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </CustomSelect>
                    <button onClick={() => deleteField(f.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                      <i className="ti ti-x" style={{ fontSize: 10 }} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function useResizable(initialWidth: number) {
  const [width, setWidth] = useState(initialWidth)
  const resizing = useRef(false)
  const startX   = useRef(0)
  const startW   = useRef(0)
  const modalRef = useRef<HTMLDivElement>(null)

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizing.current = true
    startX.current   = e.clientX
    startW.current   = modalRef.current?.getBoundingClientRect().width ?? initialWidth
    const onMove = (ev: MouseEvent) => {
      if (!resizing.current) return
      setWidth(Math.round(Math.max(700, Math.min(window.innerWidth - 48, startW.current + ev.clientX - startX.current))))
    }
    const onUp = () => {
      resizing.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [initialWidth])

  return { modalRef, width, onResizeStart }
}

function useDraggable() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragging = useRef(false)
  const offset   = useRef({ x: 0, y: 0 })
  const ref      = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,textarea')) return
    dragging.current = true
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    e.preventDefault()
  }, [])

  const reset = useCallback(() => setPos(null), [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (!dragging.current) return; setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }) }
    const onUp   = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  return { ref, pos, onMouseDown, reset }
}

type Tab = 'config' | 'general' | 'advanced'
type InputMode = 'xml' | 'xsd'

export function XmlParserModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))

  const [rawInput, setRawInput] = useState(() => {
    try {
      const raw = node?.data.config?.xmlParser as XmlParserConfig | undefined
      return raw?._sampleXml ?? ''
    } catch { return '' }
  })

  const [activeTab,      setActiveTab]      = useState<Tab>('config')
  const [inputMode, setInputMode] = useState<InputMode>(() => {
    try {
      const raw = node?.data.config?.xmlParser as XmlParserConfig | undefined
      return (raw as any)?.inputMode ?? 'xml'
    } catch { return 'xml' }
  })
  const [isMaximized,    setIsMaximized]    = useState(false)
  const [parseError,     setParseError]     = useState('')
  const [selectedFlowId, setSelectedFlowId] = useState<string | null>(null)
  const [xmlTree,        setXmlTree]        = useState<XmlTreeNode[]>([])

  const { ref: dragRef, pos, onMouseDown, reset: resetDrag } = useDraggable()
  const { modalRef, width, onResizeStart } = useResizable(1100)

  if (!node) return null

  const config: XmlParserConfig = useMemo(() => {
    try {
      const raw = node.data.config?.xmlParser
      if (raw) return raw as XmlParserConfig
    } catch {}
    return { sourceField: 'content', hasReject: false, flows: [], ignoreNamespaces: true, trimText: true }
  }, [node.data.config?.xmlParser])

  useEffect(() => {
    if (config._sampleXml) {
      try {
        const savedMode = (config as any).inputMode ?? 'xml'
        const tree = savedMode === 'xsd'
          ? buildXmlTreeFromXsd(config._sampleXml)
          : buildXmlTree(config._sampleXml, config.ignoreNamespaces)
        setXmlTree(tree)
      } catch {}
    }
  }, [])

  const incomingFields = useIncomingSchema(nodeId)

  const saveConfig = useCallback((newConfig: XmlParserConfig) => {
    useFlowStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, config: { ...n.data.config, xmlParser: newConfig } } }
          : n
      ),
    }))

    const store = useFlowStore.getState()
    newConfig.flows.forEach((flow) => {
      if (flow.fields.length === 0) return
      const schema = flow.fields.map((f) => ({ id: f.id, name: f.name, type: f.type, physicalName: f.name }))
      const outEdges = store.edges.filter((e) => e.source === nodeId && e.sourceHandle === flow.id)
      outEdges.forEach((edge) => {
        const tgt = store.nodes.find((n) => n.id === edge.target)
        if (!tgt) return
        if (tgt.data.type === 'tmap') {
          const tmap  = tgt.data.config?.tmap as TMapConfig | undefined
          if (!tmap) return
          const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
          if (!input) return
          const existingIds   = new Set(input.fields.map((f) => f.id))
          const existingNames = new Set(input.fields.filter((f) => !f.name.startsWith('status.')).map((f) => f.name))
          const updatedFields = [
            ...input.fields.map((existing) => {
              if (existing.name.startsWith('status.')) return existing
              const incoming = schema.find((s) => s.id === existing.id || s.name === existing.name)
              return incoming ? { ...existing, type: incoming.type as any } : existing
            }),
            ...schema
              .filter((s) => !existingIds.has(s.id) && !existingNames.has(s.name))
              .map((s) => ({ id: s.id, name: s.name, type: s.type as any, physicalName: s.physicalName ?? s.name })),
          ]
          store.updateTMapInput(tgt.id, input.id, { fields: updatedFields })
        } else {
          store.updateNodeProp(tgt.id, 'incomingSchema', JSON.stringify(schema))
        }
      })
    })
  }, [nodeId])

  const updateConfig = useCallback((patch: Partial<XmlParserConfig>) =>
    saveConfig({ ...config, ...patch }), [config, saveConfig])

  const handleAnalyze = useCallback(() => {
    if (!rawInput) return
    try {
      if (inputMode === 'xsd') {
        const tree = buildXmlTreeFromXsd(rawInput)
        if (tree.length === 0) { setParseError('XSD non valido o struttura non riconosciuta'); return }
        setXmlTree(tree)
        saveConfig({ ...config, _sampleXml: rawInput, inputMode: 'xsd' } as any)
        setParseError('')
      } else {
        const { flows, tree } = generateFlowsFromXml(rawInput, config.ignoreNamespaces)
        if (tree.length === 0) { setParseError('XML non valido'); return }
        saveConfig({ ...config, flows, _sampleXml: rawInput, inputMode: 'xml' } as any)
        setXmlTree(tree)
        setParseError('')
        if (flows.length > 0) setSelectedFlowId(flows[0].id)
      }
    } catch (e: any) {
      setParseError(e.message ?? 'Parsing fallito')
    }
  }, [rawInput, inputMode, config, saveConfig])

  const toggleTreeNode = useCallback((id: string) => {
    function toggle(ns: XmlTreeNode[]): XmlTreeNode[] {
      return ns.map((n) => n.id === id ? { ...n, collapsed: !n.collapsed } : { ...n, children: toggle(n.children) })
    }
    setXmlTree((prev) => toggle(prev))
  }, [])

  const onToggleFieldInFlow = useCallback((treeNode: XmlTreeNode, flowId: string) => {
    const flow = config.flows.find((f) => f.id === flowId)
    if (!flow) return
    const existingIdx = flow.fields.findIndex((f) => f.xpath === treeNode.xpath)
    if (existingIdx >= 0) {
      saveConfig({ ...config, flows: config.flows.map((f) => f.id === flowId ? { ...f, fields: f.fields.filter((_, i) => i !== existingIdx) } : f) })
    } else {
      const newField: XmlParserField = {
        id: `f_${Date.now()}`, name: treeNode.name.replace('@', ''), xpath: treeNode.xpath,
        type: 'string', isAttribute: treeNode.nodeType === 'attribute', transform: 'none', onMissing: 'null',
      }
      saveConfig({ ...config, flows: config.flows.map((f) => f.id === flowId ? { ...f, fields: [...f.fields, newField] } : f) })
    }
  }, [config, saveConfig])

  const generateFlowFromTree = useCallback((treeNode: XmlTreeNode) => {
    const idx   = config.flows.length
    const color = FLOW_COLORS[idx % FLOW_COLORS.length]
    const fields: XmlParserField[] = treeNode.children
      .filter((c) => c.children.length === 0)
      .map((c, i) => ({
        id: `f_${i}_${Date.now()}`, name: c.name.replace('@', ''), xpath: c.xpath,
        type: 'string' as XmlFieldType, isAttribute: c.nodeType === 'attribute',
        transform: 'none' as XmlFieldTransform, onMissing: 'null' as XmlFieldMissing,
      }))
    const newFlow: XmlParserFlow = {
      id: `flow_${Date.now()}`, label: treeNode.name, color,
      xpath: treeNode.xpath, isRepeating: treeNode.isRepeating, streaming: false, fields,
    }
    saveConfig({ ...config, flows: [...config.flows, newFlow] })
    setSelectedFlowId(newFlow.id)
  }, [config, saveConfig])

  const addFlow = useCallback(() => {
    const idx   = config.flows.length
    const color = FLOW_COLORS[idx % FLOW_COLORS.length]
    const newFlow: XmlParserFlow = {
      id: `flow_${Date.now()}`, label: `flusso_${idx + 1}`, color,
      xpath: '/root', isRepeating: false, streaming: false, fields: [],
    }
    saveConfig({ ...config, flows: [...config.flows, newFlow] })
    setSelectedFlowId(newFlow.id)
  }, [config, saveConfig])

  const updateFlow = useCallback((id: string, patch: Partial<XmlParserFlow>) =>
    saveConfig({ ...config, flows: config.flows.map((f) => f.id === id ? { ...f, ...patch } : f) }),
    [config, saveConfig])

  const deleteFlow = useCallback((id: string) => {
    saveConfig({ ...config, flows: config.flows.filter((f) => f.id !== id) })
    if (selectedFlowId === id) setSelectedFlowId(null)
    useFlowStore.setState((s) => ({
      edges: s.edges.filter((e) => !(e.source === nodeId && e.sourceHandle === id))
    }))
  }, [config, saveConfig, selectedFlowId, nodeId])

  const hasTree  = xmlTree.length > 0
  const allNodes = useMemo(() => flattenXmlTree(xmlTree), [xmlTree])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const TABS: Array<{ id: Tab; label: string; icon: string }> = [
    { id: 'config',   label: 'Configurazione', icon: 'ti-adjustments' },
    { id: 'general',  label: 'Generale',        icon: 'ti-info-circle' },
    { id: 'advanced', label: 'Avanzate',         icon: 'ti-settings-2'  },
  ]

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: pos ? 'flex-start' : 'center', justifyContent: 'center', zIndex: 20000, padding: 24, pointerEvents: 'none' }}>
      <div
        ref={(el) => {
          ;(dragRef as React.MutableRefObject<HTMLDivElement | null>).current = el
          ;(modalRef as React.MutableRefObject<HTMLDivElement | null>).current = el
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          pointerEvents: 'all', background: '#161b27',
          border: `1px solid ${ACCENT}40`, borderRadius: isMaximized ? 0 : 10,
          width: isMaximized ? '100vw' : `${width}px`,
          maxWidth: isMaximized ? '100vw' : '96vw',
          maxHeight: isMaximized ? '100vh' : '92vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.8), 0 0 0 1px #2a3349',
          position: 'relative',
          ...(pos && !isMaximized ? { position: 'fixed' as const, left: pos.x, top: pos.y } : {}),
          ...(isMaximized ? { position: 'fixed' as const, inset: 0 } : {}),
        }}>

        <div onMouseDown={onMouseDown}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #2a3349', background: '#1a2030', flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
          <span style={{ fontSize: 18, color: ACCENT, fontFamily: 'monospace', fontWeight: 700 }}>&lt;/&gt;</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8d4f0' }}>{node.data.config?.displayName || 'XML Parser'}</div>
            <div style={{ fontSize: 11, color: '#4a5a7a', fontFamily: 'monospace' }}>{nodeId}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => setIsMaximized((m) => { if (!m) resetDrag(); return !m })}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', color: '#9a9aaa', display: 'flex', alignItems: 'center' }}>
              <i className={`ti ${isMaximized ? 'ti-arrows-minimize' : 'ti-arrows-maximize'}`} style={{ fontSize: 13 }} />
            </button>
            <button onClick={onClose}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', color: '#9a9aaa', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
              <i className="ti ti-x" style={{ fontSize: 12 }} /> chiudi
            </button>
          </div>
        </div>

        <div style={{ display: 'flex', borderBottom: '1px solid #2a3349', flexShrink: 0, background: '#161b27' }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              style={{ padding: '9px 16px', fontSize: 11, background: activeTab === t.id ? '#1e2535' : 'transparent', border: 'none', borderBottom: activeTab === t.id ? `2px solid ${ACCENT}` : '2px solid transparent', color: activeTab === t.id ? '#c8d4f0' : '#4a5a7a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, transition: 'all .15s', whiteSpace: 'nowrap' }}>
              <i className={`ti ${t.icon}`} style={{ fontSize: 13 }} />
              {t.label}
            </button>
          ))}
        </div>

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: '#161b27', overflow: 'hidden' }}>

          <div style={{ display: activeTab === 'config' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column', overflow: 'hidden' }}>

            <div style={{ flexShrink: 0, padding: '10px 16px', borderBottom: '1px solid #2a3349', display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 240, overflowY: 'auto' }}>
              <SectionTitle label="Configurazione globale" />
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 200px', gap: 10 }}>

                <Field label="Campo sorgente XML">
                  <CustomSelect style={inputStyle} value={config.sourceField}
                    onChange={(e) => updateConfig({ sourceField: e.target.value })}>
                    <option value="">— seleziona —</option>
                    {incomingFields.map((f) => (
                      <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                    ))}
                    {incomingFields.length === 0 && <option value="" disabled>— collega un nodo sorgente —</option>}
                  </CustomSelect>
                </Field>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['xml', 'xsd'] as InputMode[]).map((m) => (
                      <button key={m}
                        onClick={() => { setInputMode(m); saveConfig({ ...config, inputMode: m } as any) }}
                        style={{ flex: 1, padding: '3px 8px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: inputMode === m ? `color-mix(in srgb, ${ACCENT} 20%, #161b27)` : '#1e2535', color: inputMode === m ? ACCENT : '#4a5a7a', border: inputMode === m ? `1px solid ${ACCENT}60` : '1px solid #2a3349', fontWeight: inputMode === m ? 600 : 400 }}>
                        {m.toUpperCase()} {m === 'xsd' ? '(schema)' : '(sample)'}
                      </button>
                    ))}
                  </div>
                  <textarea
                    style={{ ...inputStyle, resize: 'vertical', minHeight: 52, fontSize: 10, fontFamily: 'monospace' }}
                    value={rawInput} onChange={(e) => setRawInput(e.target.value)}
                    placeholder={inputMode === 'xsd'
                      ? '<xs:schema>\n  <xs:element name="root">\n    ...\n  </xs:element>\n</xs:schema>'
                      : '<root>\n  <item id="1">\n    <name>...</name>\n  </item>\n</root>'}
                    spellCheck={false} />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={handleAnalyze} disabled={!rawInput}
                      style={{ padding: '3px 14px', fontSize: 10, borderRadius: 4, cursor: rawInput ? 'pointer' : 'not-allowed', background: rawInput ? `color-mix(in srgb, ${ACCENT} 20%, #161b27)` : '#1e2535', color: rawInput ? ACCENT : '#4a5a7a', border: `1px solid ${rawInput ? ACCENT + '60' : '#2a3349'}`, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 5 }}>
                      <i className="ti ti-player-play" style={{ fontSize: 9 }} />
                      Analizza {inputMode.toUpperCase()} e genera flussi
                    </button>
                    {parseError && <span style={{ fontSize: 9, color: '#ff5f57' }}>{parseError}</span>}
                    {hasTree && !parseError && (
                      <span style={{ fontSize: 9, color: '#3ddc84' }}>✓ {allNodes.length} nodi · {config.flows.length} flussi</span>
                    )}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {[
                    { key: 'hasReject',        label: config.hasReject ? 'Reject attivo' : 'Reject disabilitato', color: config.hasReject ? '#ff5f57' : '#4a5a7a', activeColor: '#ff5f57', border: config.hasReject ? '#3a1a1a' : '#2a3349' },
                    { key: 'ignoreNamespaces', label: 'Ignora namespace',      color: config.ignoreNamespaces ? ACCENT : '#4a5a7a', activeColor: ACCENT, border: '#2a3349' },
                    { key: 'trimText',         label: 'Trim testo automatico', color: config.trimText ? ACCENT : '#4a5a7a', activeColor: ACCENT, border: '#2a3349' },
                  ].map((opt) => (
                    <div key={opt.key} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 8px', background: '#0f1117', borderRadius: 4, border: `1px solid ${opt.border}` }}>
                      <button onClick={() => updateConfig({ [opt.key]: !(config as any)[opt.key] })}
                        style={{ width: 28, height: 14, borderRadius: 7, border: 'none', cursor: 'pointer', background: (config as any)[opt.key] ? opt.activeColor : '#2a3349', position: 'relative', flexShrink: 0, transition: 'background .2s' }}>
                        <div style={{ width: 10, height: 10, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: (config as any)[opt.key] ? 14 : 2, transition: 'left .2s' }} />
                      </button>
                      <span style={{ fontSize: 9, color: opt.color, fontWeight: 600 }}>{opt.label}</span>
                    </div>
                  ))}
                  {incomingFields.length === 0 && (
                    <div style={{ padding: '5px 8px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a', display: 'flex', alignItems: 'center', gap: 4 }}>
                      <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
                      Nessun nodo in ingresso
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: hasTree ? '300px 1fr' : '1fr', overflow: 'hidden' }}>

              {hasTree && (
                <div style={{ borderRight: '1px solid #2a3349', display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0f1117' }}>
                  <div style={{ padding: '8px 12px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                    <i className="ti ti-code" style={{ fontSize: 12, color: ACCENT }} />
                    <span style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.06em', flex: 1 }}>
                      Struttura — {allNodes.length} nodi
                    </span>
                    {selectedFlowId && (
                      <span style={{ fontSize: 9, color: '#3ddc84', fontStyle: 'italic' }}>
                        → {config.flows.find((f) => f.id === selectedFlowId)?.label ?? ''}
                      </span>
                    )}
                  </div>
                  <div style={{ overflowY: 'auto', flex: 1 }}>
                    {xmlTree.map((n) => (
                      <XmlTreeNodeRow key={n.id} node={n} depth={0}
                        flows={config.flows} onToggleFieldInFlow={onToggleFieldInFlow}
                        onGenerateFlow={generateFlowFromTree} onToggle={toggleTreeNode} />
                    ))}
                  </div>
                  <div style={{ padding: '5px 10px', background: '#1a2030', borderTop: '0.5px solid #2a3349', display: 'flex', gap: 8, flexShrink: 0, flexWrap: 'wrap' }}>
                    {[
                      { icon: '<>', color: '#c8d4f0', label: 'element'   },
                      { icon: '[]', color: '#ffb347', label: 'ripetuto'  },
                      { icon: '@',  color: '#a78bfa', label: 'attribute' },
                      { icon: '—',  color: '#3ddc84', label: 'leaf'      },
                    ].map((item) => (
                      <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                        <code style={{ fontSize: 9, color: item.color, minWidth: 14 }}>{item.icon}</code>
                        <span style={{ fontSize: 9, color: '#4a5a7a' }}>{item.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                <div style={{ padding: '8px 12px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
                  <i className="ti ti-git-branch" style={{ fontSize: 12, color: '#3ddc84' }} />
                  <span style={{ fontSize: 10, fontWeight: 600, color: '#3ddc84', textTransform: 'uppercase', letterSpacing: '.06em', flex: 1 }}>
                    Flussi output — {config.flows.length}
                  </span>
                  {selectedFlowId && (
                    <span style={{ fontSize: 9, color: ACCENT, fontStyle: 'italic' }}>
                      selezionato: {config.flows.find((f) => f.id === selectedFlowId)?.label}
                    </span>
                  )}
                  <button onClick={addFlow}
                    style={{ padding: '3px 12px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#0d3d20', color: '#3ddc84', border: '1px solid #1d6d40', display: 'flex', alignItems: 'center', gap: 4 }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1d6d40' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#0d3d20' }}>
                    <i className="ti ti-plus" style={{ fontSize: 11 }} /> Flusso
                  </button>
                </div>
                <div style={{ flex: 1, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column' }}>
                  {config.flows.length === 0 ? (
                    <div style={{ padding: '40px', textAlign: 'center', color: '#2a3349', fontSize: 11 }}>
                      <i className="ti ti-code" style={{ fontSize: 36, display: 'block', marginBottom: 12, color: `${ACCENT}20` }} />
                      Incolla un XML o XSD di esempio e clicca "Analizza" per generare i flussi automaticamente,
                      oppure aggiungi un flusso manuale.
                    </div>
                  ) : (
                    config.flows.map((flow) => (
                      <FlowFieldsTable key={flow.id} flow={flow} color={flow.color ?? FLOW_COLORS[0]}
                        selectedFlowId={selectedFlowId} onSelect={setSelectedFlowId}
                        onUpdate={(patch) => updateFlow(flow.id, patch)}
                        onDelete={() => deleteFlow(flow.id)} />
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display: activeTab === 'general' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflowY: 'auto', padding: 16 }}>
            <TabGeneral nodeId={nodeId} />
          </div>
          <div style={{ display: activeTab === 'advanced' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflowY: 'auto', padding: 16 }}>
            <TabAdvanced nodeId={nodeId} />
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '1px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#4a5a7a', marginRight: 'auto' }}>Le modifiche sono salvate automaticamente</span>
          <button onClick={onClose}
            style={{ padding: '6px 20px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 20%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}60`, fontWeight: 600 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 35%, #161b27)` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 20%, #161b27)` }}>
            Fatto
          </button>
        </div>

        {!isMaximized && (
          <div onMouseDown={onResizeStart}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 6, cursor: 'ew-resize', background: `color-mix(in srgb, ${ACCENT} 15%, #1a2030)`, display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, transition: 'background .15s' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 40%, #1a2030)` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` }}>
            <div style={{ width: 2, height: 32, borderRadius: 1, background: `color-mix(in srgb, ${ACCENT} 60%, transparent)` }} />
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}