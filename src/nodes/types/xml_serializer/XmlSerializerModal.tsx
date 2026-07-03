/**
 * src/nodes/types/xml_serializer/XmlSerializerModal.tsx
 *
 * Modal XML Serializer — layout a due colonne identico al JSON Serializer.
 * Sinistra: flussi in ingresso con campi draggabili.
 * Destra: albero struttura XML (element/attribute/CDATA/group) costruibile
 *         manualmente, per drag o da import XSD/XML sample.
 *
 * Ogni nodo dell'albero corrisponde a un elemento/attributo XML.
 * I campi del flusso si trascinano sui nodi foglia per collegarli.
 * Expr custom e condizionali come nel JSON Serializer.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TabGeneral }  from '../../../components/tabs/TabGeneral'
import { TabAdvanced } from '../../../components/tabs/TabAdvanced'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { parseXsd, type XsdNode } from '../shared/xsdParser'
import { getHandleSchema } from '../../../utils/schemaRegistry'

const ACCENT = '#f97316'

const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10, padding: '3px 6px', outline: 'none', width: '100%',
}
const FLOW_COLORS = ['#f97316','#3ddc84','#ffb347','#a78bfa','#f472b6','#84cc16','#fb923c','#4a9eff']

// ─── Tipi ─────────────────────────────────────────────────────────
interface SerInput { label: string; fields: Array<{ name: string; type: string }> }

interface XmlFlowField {
  id: string; sourceField: string; transform: string; nullable: 'omit'|'empty'|'xsi_nil'
  isManual?: boolean
}
interface XmlFlowMapping {
  handle: string; mode: 'rows'|'single'|'value'; field?: string
  fields: XmlFlowField[]; dedup?: boolean
}

// ─── Nodo albero XML ──────────────────────────────────────────────
type XmlNodeKind = 'element'|'attribute'|'cdata'|'group'

interface XmlTreeNode {
  id: string; xmlName: string; ns: string; kind: XmlNodeKind
  children: XmlTreeNode[]; collapsed: boolean
  // metadati strutturali (popolati da import XSD)
  isArray?:  boolean   // true se maxOccurs > 1 o unbounded
  isLeaf?:   boolean   // true se foglia senza figli elemento (tipo primitivo)
  optional?: boolean   // true se minOccurs="0"
  // collegamento campo sorgente
  sourceHandle?: string; sourceField?: string
  sources?: Array<{ handle: string; field: string }>
  expr?: string; condition?: string
  // per array: quale handle guida l'iterazione
  iterHandle?: string
  groupBy?: string  // ← aggiungere
}

let _nc = 0
const uid = () => `xn_${++_nc}_${Date.now()}`

function makeNode(kind: XmlNodeKind, name = ''): XmlTreeNode {
  return { id: uid(), xmlName: name, ns: '', kind, children: [], collapsed: false }
}

// ─── Helpers albero ───────────────────────────────────────────────
function updateXNode(nodes: XmlTreeNode[], id: string, fn: (n: XmlTreeNode) => XmlTreeNode): XmlTreeNode[] {
  return nodes.map((n) => n.id === id ? fn(n) : { ...n, children: updateXNode(n.children, id, fn) })
}
function deleteXNode(nodes: XmlTreeNode[], id: string): XmlTreeNode[] {
  return nodes.filter((n) => n.id !== id).map((n) => ({ ...n, children: deleteXNode(n.children, id) }))
}
function addXChild(nodes: XmlTreeNode[], parentId: string, child: XmlTreeNode): XmlTreeNode[] {
  return nodes.map((n) => {
    if (n.id === parentId) return { ...n, collapsed: false, children: [...n.children, child] }
    return { ...n, children: addXChild(n.children, parentId, child) }
  })
}
function reorderXNode(nodes: XmlTreeNode[], dragId: string, targetId: string, pos: 'before'|'after'): XmlTreeNode[] {
  const di = nodes.findIndex((n) => n.id === dragId)
  const ti = nodes.findIndex((n) => n.id === targetId)
  if (di >= 0 && ti >= 0) {
    const r = [...nodes]; const [m] = r.splice(di, 1)
    const ins = r.findIndex((n) => n.id === targetId)
    r.splice(pos === 'before' ? ins : ins + 1, 0, m)
    return r
  }
  return nodes.map((n) => ({ ...n, children: reorderXNode(n.children, dragId, targetId, pos) }))
}
function collectXHandles(nodes: XmlTreeNode[], handle: string): string[] {
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

// ─── Parse da XML sample ──────────────────────────────────────────
function parseXmlSample(s: string): XmlTreeNode[] {
  try {
    const doc  = new DOMParser().parseFromString(s, 'application/xml')
    const root = doc.documentElement
    if (root.tagName === 'parsererror') return []
    function fromEl(el: Element): XmlTreeNode {
      const n: XmlTreeNode = { id: uid(), xmlName: el.localName, ns: el.prefix ?? '', kind: 'element', children: [], collapsed: false }
      // Attributi → nodi attribute
      Array.from(el.attributes).forEach((a) => {
        n.children.push({ id: uid(), xmlName: a.localName, ns: a.prefix ?? '', kind: 'attribute', children: [], collapsed: false })
      })
      // Figli elemento
      Array.from(el.children).forEach((c) => n.children.push(fromEl(c)))
      return n
    }
    // Ritorna i figli del root o il root stesso
    const children = Array.from(root.children)
    return children.length > 0 ? children.map(fromEl) : [fromEl(root)]
  } catch { return [] }
}

// ─── Conversione XsdNode → XmlTreeNode ───────────────────────────
function xsdNodeToXmlTree(n: XsdNode, depth = 0): XmlTreeNode {
  // Un nodo è foglia se non ha figli elemento (solo attributi o nessuno)
  const hasElementChildren = n.children.some((c) => c.kind !== 'attribute')
  return {
    id: uid(), xmlName: n.name, ns: n.ns,
    kind: n.kind === 'attribute' ? 'attribute' : 'element',
    children: n.children.map((c) => xsdNodeToXmlTree(c, depth + 1)),
    collapsed: depth > 1,
    isArray:   n.multiple,
    isLeaf:    n.kind !== 'attribute' && !hasElementChildren,
    optional:  n.optional,
  }
}

function parseXsdToXmlTree(s: string): XmlTreeNode[] {
  return parseXsd(s).map((n) => xsdNodeToXmlTree(n))
}

// ─── useDraggable ─────────────────────────────────────────────────
function useDraggable() {
  const [pos, setPos] = useState<{x:number;y:number}|null>(null)
  const dragging = useRef(false); const offset = useRef({x:0,y:0}); const ref = useRef<HTMLDivElement>(null)
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,textarea')) return
    dragging.current = true
    const rect = ref.current?.getBoundingClientRect(); if (!rect) return
    offset.current = {x: e.clientX - rect.left, y: e.clientY - rect.top}; e.preventDefault()
  }, [])
  const reset = useCallback(() => setPos(null), [])
  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (!dragging.current) return; setPos({x: e.clientX - offset.current.x, y: e.clientY - offset.current.y}) }
    const onUp = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])
  return { ref, pos, onMouseDown, reset }
}

// ─── Colori per tipo nodo ─────────────────────────────────────────
function kindColor(kind: XmlNodeKind): string {
  if (kind === 'attribute') return '#4a9eff'
  if (kind === 'cdata')     return '#a78bfa'
  if (kind === 'group')     return '#ffb347'
  return ACCENT
}
function kindLabel(kind: XmlNodeKind): string {
  if (kind === 'attribute') return '@'
  if (kind === 'cdata')     return 'CD'
  if (kind === 'group')     return 'G'
  return '</>'
}

// ─── XmlTreeNodeRow ───────────────────────────────────────────────
function XmlTreeNodeRow({
  node, depth, inputs, dragOver, onDragOver, onDrop, onToggle,
  onAddChild, onAddChildFromDrop, onDelete, onRename, onSetNs,
  onChangeKind, onChangeExpr, onChangeCondition, onSetIterHandle,
  onRemoveSource, onReorder, selectedId, onSelect,
  availableHandles, usedIterHandles,onSetGroupBy,
}: {
  node: XmlTreeNode; depth: number
  inputs: Record<string, SerInput>
  dragOver: string | null
  onDragOver: (id: string | null) => void
  onDrop: (nodeId: string, handle: string, field: string) => void
  onToggle: (id: string) => void
  onAddChild: (parentId: string, kind: XmlNodeKind) => void
  onAddChildFromDrop: (parentId: string, handle: string, field: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, name: string) => void
  onSetNs: (id: string, ns: string) => void
  onChangeKind: (id: string, kind: XmlNodeKind) => void
  onChangeExpr: (id: string, expr: string) => void
  onChangeCondition: (id: string, cond: string) => void
  onSetIterHandle: (id: string, handle: string) => void
  onRemoveSource: (id: string, idx: number) => void
  onReorder: (dragId: string, targetId: string, pos: 'before'|'after') => void
  selectedId: string | null
  onSelect: (id: string) => void
  availableHandles: string[]
  usedIterHandles: Set<string>
  onSetGroupBy: (id: string, groupBy: string) => void
}) {
  const isLeaf = (node.kind !== 'element' && node.kind !== 'group') || 
               (node.kind === 'element' && node.children.filter(c => c.kind !== 'attribute').length === 0)
  const isDragOver = dragOver === node.id
  const isSelected = selectedId === node.id
  const kc         = kindColor(node.kind)

  const mappedHandle = node.sourceHandle
  const handleIdx    = mappedHandle ? Object.keys(inputs).indexOf(mappedHandle) : -1
  const mappedColor  = handleIdx >= 0 ? FLOW_COLORS[handleIdx % FLOW_COLORS.length] : null

  const [editing, setEditing]         = useState(false)
  const [nameVal, setNameVal]         = useState(node.xmlName)
  const [nsVal, setNsVal]             = useState(node.ns)
  const [hovered, setHovered]         = useState(false)
  const [exprEditing, setExprEditing] = useState(false)
  const [exprVal, setExprVal]         = useState(node.expr ?? '')
  const [condEditing, setCondEditing] = useState(false)
  const [condVal, setCondVal]         = useState(node.condition ?? '')
  const [dropInd, setDropInd]         = useState<'before'|'after'|null>(null)

  useEffect(() => { setNameVal(node.xmlName) }, [node.xmlName])
  useEffect(() => { setNsVal(node.ns) }, [node.ns])

  const allSources: Array<{handle: string; field: string}> = node.sources?.length
    ? node.sources
    : node.sourceHandle && node.sourceField
      ? [{handle: node.sourceHandle, field: node.sourceField}]
      : []

  const canHaveChildren = node.kind === 'element' || node.kind === 'group'

  return (
    <>
      {dropInd === 'before' && (
        <div style={{ height: 2, background: '#ffb347', marginLeft: 8 + depth * 14, borderRadius: 1 }} />
      )}
      <div
        draggable
        onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.setData('tree-node-id', node.id); e.dataTransfer.effectAllowed = 'move' }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
        onDragOver={(e) => {
          e.preventDefault(); e.stopPropagation()
          const rect = e.currentTarget.getBoundingClientRect()
          setDropInd(e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
          if (!e.dataTransfer.types.includes('tree-node-id')) onDragOver(node.id)
        }}
        onDragLeave={(e) => {
          e.stopPropagation(); setDropInd(null)
          const rel = e.relatedTarget as HTMLElement | null
          if (!e.currentTarget.contains(rel)) onDragOver(null)
        }}
        onDrop={(e) => {
          e.preventDefault(); e.stopPropagation(); setDropInd(null); onDragOver(null)
          const treeId = e.dataTransfer.getData('tree-node-id')
          if (treeId && treeId !== node.id) {
            const rect = e.currentTarget.getBoundingClientRect()
            onReorder(treeId, node.id, e.clientY < rect.top + rect.height / 2 ? 'before' : 'after')
            return
          }
          const handle = e.dataTransfer.getData('handle')
          const field  = e.dataTransfer.getData('field')
          if (handle && field) {
            if (isLeaf) onDrop(node.id, handle, field)
            else onAddChildFromDrop(node.id, handle, field)
          }
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 3,
          paddingLeft: 8 + depth * 14, paddingRight: 6, paddingTop: 3, paddingBottom: 3,
          borderBottom: dropInd === 'after' ? '2px solid #ffb347' : '0.5px solid #1a2030',
          background: isDragOver ? `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`
            : isSelected ? `color-mix(in srgb, #ffb347 12%, #0f1117)`
            : mappedColor ? `color-mix(in srgb, ${mappedColor} 6%, #0f1117)` : 'transparent',
          borderLeft: isDragOver ? `2px solid ${ACCENT}`
            : isSelected ? '2px solid #ffb347'
            : mappedColor ? `2px solid ${mappedColor}60`
            : node.isArray ? '2px solid #ffb34730'
            : node.isLeaf  ? '2px solid #3ddc8420' : '2px solid transparent',
          cursor: 'grab', transition: 'background .1s',
        }}>

        {/* Chevron */}
        {canHaveChildren ? (
          <button onClick={(e) => { e.stopPropagation(); onToggle(node.id) }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, width: 12, flexShrink: 0 }}>
            <i className={`ti ${node.collapsed ? 'ti-chevron-right' : 'ti-chevron-down'}`} style={{ fontSize: 9 }} />
          </button>
        ) : <div style={{ width: 12, flexShrink: 0 }} />}

        {/* Badge kind — isArray e isLeaf da import XSD */}
        <span style={{ fontSize: 7,
          color: node.isArray ? '#ffb347' : node.isLeaf ? '#3ddc84' : kc,
          fontFamily: 'monospace', flexShrink: 0, minWidth: 16, textAlign: 'center',
          padding: '1px 3px', borderRadius: 2,
          background: `color-mix(in srgb, ${node.isArray ? '#ffb347' : node.isLeaf ? '#3ddc84' : kc} 15%, transparent)` }}>
          {node.isArray ? '[]' : node.isLeaf ? '—' : kindLabel(node.kind)}
        </span>

        {/* Namespace (compatto) */}
        {nsVal || hovered ? (
          editing ? null : (
            <input value={nsVal}
              onChange={(e) => setNsVal(e.target.value)}
              onBlur={() => { onSetNs(node.id, nsVal) }}
              onClick={(e) => e.stopPropagation()}
              style={{ ...iStyle, fontSize: 9, padding: '1px 3px', width: 36, flexShrink: 0, color: '#4a5a7a' }}
              placeholder="ns" />
          )
        ) : null}

        {/* Nome */}
        {editing ? (
          <input value={nameVal} autoFocus
            onChange={(e) => setNameVal(e.target.value)}
            onBlur={() => { onRename(node.id, nameVal); setEditing(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { onRename(node.id, nameVal); setEditing(false) } }}
            onClick={(e) => e.stopPropagation()}
            style={{ ...iStyle, fontSize: 10, padding: '1px 4px', flex: 1, minWidth: 0, color: kc }} />
        ) : (
          <>
            <span onDoubleClick={() => setEditing(true)}
              style={{ fontSize: 10, color: node.isArray ? '#ffb347' : node.isLeaf ? '#3ddc84' : kc, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}
              title="Doppio click per rinominare">
              {nsVal ? `${nsVal}:` : ''}{node.xmlName || <em style={{ color: '#4a5a7a' }}>senza nome</em>}
            </span>
            {node.isArray && <span style={{ fontSize: 9, color: '#ffb347', flexShrink: 0, marginRight: 2, fontFamily: 'monospace' }}>[ ]</span>}
            {node.optional && !node.isArray && <span style={{ fontSize: 7, color: '#4a5a7a', flexShrink: 0 }}>opt</span>}
          </>
        )}

        {/* Badge sorgenti */}
        {!node.expr && allSources.length > 0 && (
          <div style={{ display: 'flex', gap: 2, flexShrink: 0, flexWrap: 'wrap', maxWidth: 120 }}>
            {allSources.map((s, si) => {
              const hIdx = Object.keys(inputs).indexOf(s.handle)
              const sc   = hIdx >= 0 ? FLOW_COLORS[hIdx % FLOW_COLORS.length] : '#4a5a7a'
              return (
                <span key={`${s.handle}:${s.field}`}
                  onClick={(e) => { e.stopPropagation(); onRemoveSource(node.id, si) }}
                  title={`${s.handle} → ${s.field} (click per rimuovere)`}
                  style={{ fontSize: 9, color: sc, fontFamily: 'monospace', padding: '1px 4px', borderRadius: 3,
                    background: `color-mix(in srgb, ${sc} 15%, #0f1117)`, border: `0.5px solid ${sc}40`,
                    cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2 }}>
                  {s.field}
                  {allSources.length > 1 && <i className="ti ti-x" style={{ fontSize: 7 }} />}
                </span>
              )
            })}
          </div>
        )}

        {/* Expr custom */}
        {(isLeaf || node.kind === 'attribute') && (
          exprEditing ? (
            <input autoFocus value={exprVal}
              onChange={(e) => setExprVal(e.target.value)}
              onBlur={() => { onChangeExpr(node.id, exprVal); setExprEditing(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onChangeExpr(node.id, exprVal); setExprEditing(false) }
                if (e.key === 'Escape') { setExprVal(node.expr ?? ''); setExprEditing(false) }
              }}
              placeholder={node.sourceField ? `row.${node.sourceField}` : 'es: row.campo.trim()'}
              onClick={(e) => e.stopPropagation()}
              style={{ ...iStyle, fontSize: 9, padding: '1px 5px', flex: 1, minWidth: 80,
                color: '#ffb347', borderColor: '#ffb34760', background: '#1a1500' }} />
          ) : (
            <button onClick={(e) => { e.stopPropagation(); setExprVal(node.expr ?? ''); setExprEditing(true) }}
              title={node.expr ? `Expr: ${node.expr}` : 'Aggiungi espressione custom'}
              style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, cursor: 'pointer', flexShrink: 0,
                background: node.expr ? 'color-mix(in srgb, #ffb347 15%, #0f1117)' : 'none',
                color: node.expr ? '#ffb347' : '#2a3349',
                border: node.expr ? '0.5px solid #ffb34740' : '0.5px dashed #2a3349',
                fontFamily: 'monospace', maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.expr ? node.expr : 'ƒ expr'}
            </button>
          )
        )}

        {/* iterHandle per element con figli */}
        {canHaveChildren && availableHandles.length > 0 && (
          <div onClick={(e) => e.stopPropagation()} title="Flusso che guida l'iterazione" style={{ flexShrink: 0 }}>
            <CustomSelect value={node.iterHandle ?? ''}
              onChange={(e) => { onSetIterHandle(node.id, e.target.value) }}
              style={{ fontSize: 9, padding: '1px 3px', width: 68, flexShrink: 0,
                background: node.iterHandle ? 'color-mix(in srgb, #ffb347 10%, #1e2535)' : 'transparent',
                color: node.iterHandle ? '#ffb347' : '#4a5a7a',
                border: node.iterHandle ? '0.5px solid #ffb34740' : '0.5px dashed #2a3349',
                borderRadius: 3, outline: 'none', fontFamily: "'JetBrains Mono', monospace", cursor: 'pointer' }}>
              <option value="">iter…</option>
              {availableHandles.map((h) => (
                <option key={h} value={h} disabled={usedIterHandles.has(h) && node.iterHandle !== h}>
                  {h}{/*{usedIterHandles.has(h) && node.iterHandle !== h ? ' ✓' : ''}*/}
                </option>
              ))}
            </CustomSelect>
          </div>
        )}
        {canHaveChildren && node.iterHandle && (
          <div onClick={(e) => e.stopPropagation()} style={{ flexShrink: 0 }}>
            <CustomSelect value={node.groupBy ?? ''}
              onChange={(e) => onSetGroupBy(node.id, e.target.value)}
              style={{ fontSize: 9, padding: '1px 3px', width: 72,
                background: node.groupBy ? 'color-mix(in srgb, #3ddc84 10%, #1e2535)' : 'transparent',
                color: node.groupBy ? '#3ddc84' : '#4a5a7a',
                border: node.groupBy ? '0.5px solid #3ddc8440' : '0.5px dashed #2a3349',
                borderRadius: 3, outline: 'none', cursor: 'pointer',
                fontFamily: "'JetBrains Mono', monospace" }}>
              <option value="">group…</option>
              {(inputs[node.iterHandle]?.fields ?? []).map((f) => (
                <option key={f.name} value={f.name}>{f.name}</option>
              ))}
            </CustomSelect>
          </div>
        )}
        {/* Condizione */}
        {(isLeaf || node.kind === 'attribute') && node.condition && !condEditing && (
          <button onClick={(e) => { e.stopPropagation(); setCondVal(node.condition ?? ''); setCondEditing(true) }}
            style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, cursor: 'pointer', flexShrink: 0,
              background: 'color-mix(in srgb, #a78bfa 15%, #0f1117)', color: '#a78bfa', border: '0.5px solid #a78bfa40',
              fontFamily: 'monospace', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            if {node.condition}
          </button>
        )}
        {condEditing && (
          <input autoFocus value={condVal}
            onChange={(e) => setCondVal(e.target.value)}
            onBlur={() => { onChangeCondition(node.id, condVal); setCondEditing(false) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { onChangeCondition(node.id, condVal); setCondEditing(false) }
              if (e.key === 'Escape') { setCondVal(node.condition ?? ''); setCondEditing(false) }
            }}
            onClick={(e) => e.stopPropagation()}
            placeholder="es: row.valore !== null"
            style={{ ...iStyle, fontSize: 9, padding: '1px 5px', width: 120, flexShrink: 0, color: '#a78bfa', borderColor: '#a78bfa60', background: '#110d1a' }} />
        )}

        {/* Azioni hover */}
        {hovered && (
          <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>
            {canHaveChildren && (
              <>
                <button onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'element') }}
                  style={{ background: 'none', border: `0.5px solid ${kc}40`, borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: kc, fontSize: 9 }}>+elm</button>
                <button onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'attribute') }}
                  style={{ background: 'none', border: '0.5px solid #4a9eff40', borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: '#4a9eff', fontSize: 9 }}>@att</button>
                <button onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'cdata') }}
                  style={{ background: 'none', border: '0.5px solid #a78bfa40', borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: '#a78bfa', fontSize: 9 }}>CD</button>
                <button onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'group') }}
                  style={{ background: 'none', border: '0.5px solid #ffb34740', borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: '#ffb347', fontSize: 9 }}>grp</button>
              </>
            )}
            {!canHaveChildren && (
              <>
                {/* Promuovi a element con figli */}
                <button onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'element') }}
                  title="Aggiungi figlio (converte in elemento con figli)"
                  style={{ background: 'none', border: `0.5px solid ${kc}40`, borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: kc, fontSize: 9 }}>+elm</button>
                <button onClick={(e) => { e.stopPropagation(); setCondVal(node.condition ?? ''); setCondEditing(true) }}
                  title="Aggiungi condizione"
                  style={{ background: 'none', border: '0.5px solid #a78bfa40', borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#a78bfa' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>if</button>
              </>
            )}
            <button onClick={(e) => { e.stopPropagation(); onDelete(node.id) }}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
              <i className="ti ti-x" style={{ fontSize: 9 }} />
            </button>
          </div>
        )}

        {isDragOver && <span style={{ fontSize: 9, color: ACCENT, flexShrink: 0 }}>← rilascia</span>}
      </div>

      {/* Figli */}
      {!node.collapsed && node.children.map((child) => (
        <XmlTreeNodeRow key={child.id} node={child} depth={depth + 1}
          inputs={inputs} dragOver={dragOver} onDragOver={onDragOver} onDrop={onDrop}
          onToggle={onToggle} onAddChild={onAddChild} onAddChildFromDrop={onAddChildFromDrop}
          onDelete={onDelete} onRename={onRename} onSetNs={onSetNs} onChangeKind={onChangeKind}
          onChangeExpr={onChangeExpr} onChangeCondition={onChangeCondition}
          onSetIterHandle={onSetIterHandle} onRemoveSource={onRemoveSource} onReorder={onReorder}
          selectedId={selectedId} onSelect={onSelect}
          availableHandles={availableHandles} usedIterHandles={usedIterHandles} 
          onSetGroupBy={onSetGroupBy} />
      ))}
    </>
  )
}

// ─── FieldRow ─────────────────────────────────────────────────────
function FieldRow({ name, type, handle, handleIdx, isMapped, color, onDelete }: {
  name: string; type: string; handle: string; handleIdx: number
  isMapped: boolean; color: string; onDelete?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  return (
    <div onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ display: 'grid', gridTemplateColumns: '20px 1fr 52px 16px', gap: 3, alignItems: 'center',
        padding: '3px 10px 3px 8px',
        background: hovered ? '#1a2535' : isMapped ? `color-mix(in srgb, ${color} 4%, #161b27)` : 'transparent',
        borderBottom: '0.5px solid #1a2030', transition: 'background .1s' }}>
      <div draggable
        onDragStart={(e) => { e.dataTransfer.setData('handle', handle); e.dataTransfer.setData('field', name); e.dataTransfer.effectAllowed = 'copy' }}
        title="Trascina sull'albero XML"
        style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          background: isMapped ? color : 'transparent', border: `1.5px solid ${isMapped ? color : '#4a5a7a'}`,
          cursor: 'grab', transition: 'all .12s', boxShadow: isMapped ? `0 0 4px ${color}60` : 'none' }} />
      <span style={{ fontSize: 10, fontFamily: 'monospace', color: isMapped ? color : '#9a9aaa',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={`${name}${type ? ` (${type})` : ''}`}>
        {name}
      </span>
      <span style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace', textAlign: 'center',
        padding: '1px 3px', borderRadius: 2, background: '#1a2030', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {type || '—'}
      </span>
      {onDelete ? (
        <button onClick={onDelete}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-x" style={{ fontSize: 9 }} />
        </button>
      ) : <div />}
    </div>
  )
}

// ─── FlowCard ─────────────────────────────────────────────────────
function FlowCard({ mapping, idx, input, treeNodes, onUpdate, onAutoMap }: {
  mapping: XmlFlowMapping; idx: number; input: SerInput | undefined
  treeNodes: XmlTreeNode[]; onUpdate: (h: string, p: Partial<XmlFlowMapping>) => void
  onAutoMap: (handle: string) => void
}) {
  const color        = FLOW_COLORS[idx % FLOW_COLORS.length]
  const schemaFields = input?.fields ?? []
  const [collapsed, setCollapsed] = useState(false)

  // Campi usati nell'albero per questo handle
  const getMappedInTree = useCallback((nodes: XmlTreeNode[]): Set<string> => {
    const set = new Set<string>()
    function walk(ns: XmlTreeNode[]) {
      ns.forEach((n) => {
        if (n.sourceHandle === mapping.handle && n.sourceField) set.add(n.sourceField)
        if (n.sources) n.sources.forEach((s) => { if (s.handle === mapping.handle) set.add(s.field) })
        walk(n.children)
      })
    }
    walk(nodes); return set
  }, [mapping.handle])

  const mappedInTree = getMappedInTree(treeNodes)

  return (
    <div style={{ border: `1px solid ${color}40`, borderRadius: 8, overflow: 'hidden', marginBottom: 8, flexShrink: 0 }}>
      {/* Header */}
      <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${color} 10%, #1a2030)`,
        borderBottom: collapsed ? 'none' : `0.5px solid ${color}30`,
        display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0, fontFamily: 'monospace' }}>{mapping.handle}</span>
        <span style={{ flex: 1 }} />
        {/* Auto-mappa */}
        <button onClick={() => onAutoMap(mapping.handle)}
          title="Auto-mappa nel nodo selezionato"
          style={{ background: 'none', border: `0.5px solid ${color}40`, borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9, display: 'flex', alignItems: 'center', gap: 3 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-wand" style={{ fontSize: 9 }} /> auto
        </button>
        {/* Dedup */}
        <button onClick={() => onUpdate(mapping.handle, { dedup: !mapping.dedup })}
          title={mapping.dedup ? 'Dedup attivo' : 'Attiva deduplicazione'}
          style={{ background: mapping.dedup ? `color-mix(in srgb, ${color} 20%, #0f1117)` : 'none',
            border: `0.5px solid ${mapping.dedup ? color : '#2a3349'}`,
            borderRadius: 3, padding: '1px 6px', cursor: 'pointer',
            color: mapping.dedup ? color : '#4a5a7a', fontSize: 9,
            display: 'flex', alignItems: 'center', gap: 3, transition: 'all .15s' }}>
          <i className="ti ti-copy-off" style={{ fontSize: 9 }} /> dedup
        </button>
        <button onClick={() => setCollapsed((v) => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}>
          <i className={`ti ${collapsed ? 'ti-chevron-down' : 'ti-chevron-up'}`} style={{ fontSize: 10 }} />
        </button>
      </div>

      {!collapsed && (
        <div style={{ background: '#161b27' }}>
          {schemaFields.length === 0 ? (
            <div style={{ padding: '8px 10px', fontSize: 9, color: '#2a3349', fontStyle: 'italic' }}>
              Schema non disponibile — collega il nodo sorgente
            </div>
          ) : (
            <div style={{ padding: '3px 0' }}>
              {schemaFields.map((sf) => (
                <FieldRow key={sf.name} name={sf.name} type={sf.type}
                  handle={mapping.handle} handleIdx={idx}
                  isMapped={mappedInTree.has(sf.name)}
                  color={color} />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── XmlSerializerLayout ──────────────────────────────────────────
function XmlSerializerLayout({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const edges          = useFlowStore((s) => s.edges)
  const updateNodeConfig = useFlowStore((s) => s.updateNodeConfig)
  const updateNodeProp   = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null

  const serConfig  = (node.data.config as any)?.xmlSerializer ?? { inputs: {}, mappings: {} }
  const inputs: Record<string, SerInput>         = serConfig.inputs ?? {}
  const mappings: Record<string, XmlFlowMapping> = serConfig.mappings ?? {}
  const incomingEdges = edges.filter((e) => e.target === nodeId)

  const realInputs: Record<string, SerInput> = useMemo(() => {
    const result: Record<string, SerInput> = {}
    incomingEdges.forEach((edge) => {
      const handle  = edge.targetHandle ?? 'input'
      const srcNode = (useFlowStore.getState().nodes).find((n) => n.id === edge.source)
      if (!srcNode) return
      const fields = getHandleSchema(srcNode, edge.sourceHandle ?? 'output', false)
      result[handle] = {
        label:  handle,
        fields: fields.map((f) => ({ name: f.name, type: f.type })),
      }
    })
    return result
  }, [incomingEdges.map((e) => `${e.source}:${e.sourceHandle}:${e.targetHandle}`).join('|'), nodeId])


  const p = (key: string, def = '') => String((node.data as any).props?.[key] ?? def)
  const [showOptions, setShowOptions] = useState(false)

  // ── Albero XML ─────────────────────────────────────────────────
  const [treeNodes, setTreeNodesRaw] = useState<XmlTreeNode[]>(() => {
    try { return JSON.parse(p('_treeNodes', '[]')) } catch { return [] }
  })

  const setTreeNodes = useCallback((fn: (prev: XmlTreeNode[]) => XmlTreeNode[]) => {
    setTreeNodesRaw((prev) => {
      const next = fn(prev)
      useFlowStore.getState().updateNodeProp(nodeId, '_treeNodes', JSON.stringify(next))
      return next
    })
  }, [nodeId])

  useEffect(() => {
    try {
      const saved = JSON.parse(p('_treeNodes', '[]'))
      if (saved.length > 0) setTreeNodesRaw(saved)
    } catch {}
  }, [])

  const handleSetGroupBy = useCallback((id: string, groupBy: string) => {
    setTreeNodes((prev) => updateXNode(prev, id, (n) => ({ ...n, groupBy: groupBy || undefined })))
  }, [setTreeNodes])

  const [dragOver, setDragOver]                     = useState<string | null>(null)
  const [selectedTreeNodeId, setSelectedTreeNodeId] = useState<string | null>(null)
  const [sampleRaw, setSampleRaw]                   = useState('')
  const [sampleErr, setSampleErr]                   = useState('')
  const [importMode, setImportMode]                 = useState<'xml'|'xsd'>('xml')
  const [resizeW, setResizeW]                       = useState(320)
  const [showPreview, setShowPreview]               = useState(false)
  const resizing = useRef(false)

  // Handlers albero
  const handleToggle     = useCallback((id: string) => setTreeNodes((p) => updateXNode(p, id, (n) => ({ ...n, collapsed: !n.collapsed }))), [setTreeNodes])
  const handleDelete     = useCallback((id: string) => setTreeNodes((p) => deleteXNode(p, id)), [setTreeNodes])
  const handleRename     = useCallback((id: string, xmlName: string) => setTreeNodes((p) => updateXNode(p, id, (n) => ({ ...n, xmlName }))), [setTreeNodes])
  const handleSetNs      = useCallback((id: string, ns: string) => setTreeNodes((p) => updateXNode(p, id, (n) => ({ ...n, ns }))), [setTreeNodes])
  const handleChangeKind = useCallback((id: string, kind: XmlNodeKind) => setTreeNodes((p) => updateXNode(p, id, (n) => ({ ...n, kind }))), [setTreeNodes])
  const handleChangeExpr = useCallback((id: string, expr: string) => setTreeNodes((p) => updateXNode(p, id, (n) => ({ ...n, expr: expr || undefined }))), [setTreeNodes])
  const handleChangeCond = useCallback((id: string, condition: string) => setTreeNodes((p) => updateXNode(p, id, (n) => ({ ...n, condition: condition || undefined }))), [setTreeNodes])
  const handleSetIter    = useCallback((id: string, handle: string) => setTreeNodes((p) => updateXNode(p, id, (n) => ({ ...n, iterHandle: handle || undefined }))), [setTreeNodes])
  const handleReorder    = useCallback((dragId: string, targetId: string, pos: 'before'|'after') => setTreeNodes((p) => reorderXNode(p, dragId, targetId, pos)), [setTreeNodes])

  const handleRemoveSource = useCallback((id: string, sourceIdx: number) => {
    setTreeNodes((prev) => updateXNode(prev, id, (n) => {
      const all = n.sources?.length ? n.sources : n.sourceHandle && n.sourceField ? [{handle: n.sourceHandle, field: n.sourceField}] : []
      const rem = all.filter((_, i) => i !== sourceIdx)
      return { ...n, sources: rem.length > 0 ? rem : undefined, sourceHandle: rem[0]?.handle, sourceField: rem[0]?.field,
        expr: rem.length > 1 ? rem.map((s) => `row.${s.field}`).join(" + ' ' + ") : undefined }
    }))
  }, [setTreeNodes])

  const handleDrop = useCallback((nodeId_: string, handle: string, field: string) => {
    setTreeNodes((prev) => updateXNode(prev, nodeId_, (n) => {
      const existing = n.sources?.length ? n.sources : n.sourceHandle && n.sourceField ? [{handle: n.sourceHandle, field: n.sourceField}] : []
      if (existing.some((s) => s.handle === handle && s.field === field)) return n
      const newSources = [...existing, {handle, field}]
      return { ...n, sourceHandle: newSources[0].handle, sourceField: newSources[0].field, sources: newSources,
        expr: newSources.length > 1 ? newSources.map((s) => `row.${s.field}`).join(" + ' ' + ") : n.expr }
    }))
  }, [setTreeNodes])

  const handleAddChildFromDrop = useCallback((parentId: string, handle: string, field: string) => {
    const inp   = realInputs[handle]
    const fType = inp?.fields.find((f) => f.name === field)?.type ?? 'string'
    const leaf: XmlTreeNode = { id: uid(), xmlName: field, ns: '', kind: 'element', children: [], collapsed: false, sourceHandle: handle, sourceField: field }
    setTreeNodes((prev) => {
      // Se il parent è una foglia, promuovi a element
      const promoted = updateXNode(prev, parentId, (n) => {
        if (n.kind !== 'element' && n.kind !== 'group') return { ...n, kind: 'element' as XmlNodeKind }
        return n
      })
      return addXChild(promoted, parentId, leaf)
    })
  }, [inputs, setTreeNodes])

  const handleAddChild = useCallback((parentId: string, kind: XmlNodeKind) => {
    const child = makeNode(kind, kind === 'element' ? 'elemento' : kind === 'attribute' ? 'attr' : kind === 'cdata' ? 'cdata' : 'gruppo')
    setTreeNodes((prev) => {
      const promoted = updateXNode(prev, parentId, (n) => {
        if (n.kind !== 'element' && n.kind !== 'group') return { ...n, kind: 'element' as XmlNodeKind }
        return n
      })
      return addXChild(promoted, parentId, child)
    })
  }, [setTreeNodes])

  const handleAddRoot = (kind: XmlNodeKind) => {
    setTreeNodes((prev) => [...prev, makeNode(kind)])
  }

  const handleAutoMap = useCallback((handle: string) => {
    const inp = realInputs[handle]
    if (!inp?.fields.length) return
    const existingFields = new Set<string>()
    function walkExisting(ns: XmlTreeNode[]) { ns.forEach((n) => { if (n.sourceHandle === handle && n.sourceField) existingFields.add(n.sourceField); walkExisting(n.children) }) }
    setTreeNodes((prev) => {
      walkExisting(prev)
      const leaves: XmlTreeNode[] = inp.fields
        .filter((f) => !existingFields.has(f.name))
        .map((f) => ({ id: uid(), xmlName: f.name, ns: '', kind: 'element' as XmlNodeKind, children: [], collapsed: false, sourceHandle: handle, sourceField: f.name }))
      if (leaves.length === 0) return prev
      if (selectedTreeNodeId) {
        return updateXNode(prev, selectedTreeNodeId, (n) => ({
          ...n, kind: (n.kind === 'element' || n.kind === 'group') ? n.kind : 'element' as XmlNodeKind,
          collapsed: false, children: [...n.children, ...leaves],
        }))
      }
      return [...prev, ...leaves]
    })
  }, [inputs, selectedTreeNodeId, setTreeNodes])

  const handleImport = () => {
    if (!sampleRaw.trim()) return
    const nodes = importMode === 'xsd' ? parseXsdToXmlTree(sampleRaw) : parseXmlSample(sampleRaw)
    if (nodes.length === 0) { setSampleErr('Nessuna struttura rilevata'); return }
    setTreeNodes(() => nodes); setSampleErr(''); setSampleRaw('')
  }

  const getMapping = (handle: string): XmlFlowMapping =>
    mappings[handle] ?? { handle, mode: 'rows', fields: [] }

  const updateMapping = (handle: string, patch: Partial<XmlFlowMapping>) => {
    const current = { ...mappings, [handle]: { ...getMapping(handle), ...patch } }
    updateNodeConfig(nodeId, { xmlSerializer: { ...serConfig, mappings: current } } as any)
  }

  // Propagazione schema output fisso
  const propagateOutputSchema = useCallback((outputField: string) => {
    const store  = useFlowStore.getState()
    const schema = JSON.stringify([{ name: outputField, type: 'string' }])
    store.updateNodeProp(nodeId, 'outputSchema', schema)
    store.edges.filter((ed) => ed.source === nodeId && ed.sourceHandle === 'output')
      .forEach((edge) => store.updateNodeProp(edge.target, 'incomingSchema', schema))
  }, [nodeId])

  const outputField = p('outputField', 'xml_output')
  useEffect(() => { propagateOutputSchema(outputField) }, [outputField])

  // usedIterHandles
  const usedIterHandles = useMemo(() => new Set<string>(), [])
  {/*
  const usedIterHandles = useMemo(() => {
    const used = new Set<string>()
    function collect(ns: XmlTreeNode[]) { ns.forEach((n) => { if ((n.kind === 'element' || n.kind === 'group') && n.iterHandle) used.add(n.iterHandle); collect(n.children) }) }
    collect(treeNodes); return used
  }, [treeNodes])
  */}
  // Resize colonne
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); resizing.current = true
    const startX = e.clientX; const startW = resizeW
    const onMove = (ev: MouseEvent) => { if (!resizing.current) return; setResizeW(Math.max(200, Math.min(600, startW + ev.clientX - startX))) }
    const onUp   = () => { resizing.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [resizeW])

  // Anteprima struttura XML
  const xmlPreview = useMemo(() => {
    function buildPreview(nodes: XmlTreeNode[], indent: number): string {
      const pad = '  '.repeat(indent)
      return nodes.filter((n) => n.kind !== 'attribute').map((n) => {
        const tag = n.ns ? `${n.ns}:${n.xmlName || 'elem'}` : (n.xmlName || 'elem')
        const attrs = n.children.filter((c) => c.kind === 'attribute')
          .map((a) => ` ${a.ns ? a.ns + ':' : ''}${a.xmlName || 'attr'}="${a.sourceField || '…'}"`)
          .join('')
        if (n.kind === 'cdata') return `${pad}<${tag}><![CDATA[${n.sourceField || '…'}]]></${tag}>`
        const childElms = n.children.filter((c) => c.kind !== 'attribute')
        if (childElms.length > 0) return `${pad}<${tag}${attrs}>\n${buildPreview(childElms, indent + 1)}\n${pad}</${tag}>`
        return `${pad}<${tag}${attrs}>${n.sourceField ? `<${n.sourceField}>` : '…'}</${tag}>`
      }).join('\n')
    }
    const rootTag = (p('rootNsPrefix') ? p('rootNsPrefix') + ':' : '') + (p('rootElement', 'record'))
    return `<${rootTag}>\n${buildPreview(treeNodes, 1)}\n</${rootTag}>`
  }, [treeNodes, p('rootElement'), p('rootNsPrefix')])

  const hasTree = treeNodes.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Banner */}
      <div style={{ padding: '5px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderBottom: `0.5px solid ${ACCENT}20`, fontSize: 10, color: '#9a9aaa', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>&lt;/&gt;</span>
        <span>Trascina i campi sull'albero XML di output a destra.</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'monospace', color: ACCENT }}>→ {p('outputField', 'xml_output')}</span>
        <button onClick={() => setShowOptions((v) => !v)}
          style={{ background: 'none', border: `0.5px solid ${showOptions ? ACCENT : '#2a3349'}`, borderRadius: 3, padding: '2px 8px', cursor: 'pointer', color: showOptions ? ACCENT : '#4a5a7a', fontSize: 9 }}>
          <i className="ti ti-settings-2" style={{ fontSize: 9, marginRight: 3 }} />opzioni
        </button>
      </div>

      {/* Opzioni */}
      {showOptions && (
        <div style={{ padding: '6px 12px', borderBottom: '0.5px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 6 }}>
            {[{label:'Campo output',key:'outputField',def:'xml_output'},{label:'Elemento root',key:'rootElement',def:'record'},{label:'Prefisso NS root',key:'rootNsPrefix',def:''}].map((opt) => (
              <div key={opt.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{opt.label}</div>
                <input style={{ ...iStyle, fontSize: 10, padding: '3px 6px', color: ACCENT }}
                  value={p(opt.key, opt.def)}
                  onChange={(e) => {
                    updateNodeProp(nodeId, opt.key, e.target.value)
                    if (opt.key === 'outputField') propagateOutputSchema(e.target.value || 'xml_output')
                  }} placeholder={opt.def} />
              </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Pretty print</div>
              <CustomSelect style={{ ...iStyle, fontSize: 10, padding: '3px 4px' }} value={p('pretty','false')} onChange={(e) => updateNodeProp(nodeId, 'pretty', e.target.value)}>
                <option value="false">Compatto</option><option value="true">Indentato</option>
              </CustomSelect>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Dichiarazione XML</div>
              <CustomSelect style={{ ...iStyle, fontSize: 10, padding: '3px 4px' }} value={p('xmlDeclaration','true')} onChange={(e) => updateNodeProp(nodeId, 'xmlDeclaration', e.target.value)}>
                <option value="true">Includi</option><option value="false">Ometti</option>
              </CustomSelect>
            </div>
          </div>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Namespace root URI</div>
            <input style={{ ...iStyle, fontSize: 10 }} value={p('rootNamespace')} onChange={(e) => updateNodeProp(nodeId, 'rootNamespace', e.target.value)} placeholder="http://esempio.com/schema" />
          </div>
          <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
            <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Namespace aggiuntivi (prefisso=uri, uno per riga)</div>
            <textarea style={{ ...iStyle, resize: 'none', height: 44, fontSize: 9, fontFamily: 'monospace' }}
              value={p('namespaces')} onChange={(e) => updateNodeProp(nodeId, 'namespaces', e.target.value)}
              placeholder={'xsi=http://www.w3.org/2001/XMLSchema-instance'} spellCheck={false} />
          </div>
        </div>
      )}

      {/* Layout principale */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* ── SINISTRA: flussi ── */}
        <div style={{ width: resizeW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #2a3349' }}>
          <div style={{ padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', flexShrink: 0 }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.06em' }}>
              Flussi in ingresso — {incomingEdges.length}
            </span>
          </div>
          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
            {incomingEdges.length === 0 ? (
              <div style={{ padding: '30px', textAlign: 'center', color: '#2a3349', fontSize: 11 }}>
                <i className="ti ti-plug-connected-x" style={{ fontSize: 28, display: 'block', marginBottom: 8, color: `${ACCENT}20` }} />
                Collega un flusso sul canvas
              </div>
            ) : (
              incomingEdges.map((edge, idx) => {
                const handle = edge.targetHandle ?? 'input'
                return (
                  <FlowCard key={handle}
                    mapping={getMapping(handle)} idx={idx}
                    input={realInputs[handle]} treeNodes={treeNodes}
                    onUpdate={updateMapping} onAutoMap={handleAutoMap} />
                )
              })
            )}
          </div>
        </div>

        {/* ── Handle resize ── */}
        <div onMouseDown={onResizeStart}
          style={{ width: 5, flexShrink: 0, cursor: 'ew-resize', background: `color-mix(in srgb, ${ACCENT} 10%, #0f1117)`, transition: 'background .15s' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 30%, #0f1117)` }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 10%, #0f1117)` }}>
          <div style={{ width: 1, height: '100%', margin: '0 auto', background: `color-mix(in srgb, ${ACCENT} 20%, transparent)` }} />
        </div>

        {/* ── DESTRA: albero XML ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0f1117' }}>
          {/* Header albero */}
          <div style={{ padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.06em', flex: 1 }}>
              Struttura XML output
            </span>
            {/* Aggiungi root */}
            {([
              {kind:'element' as XmlNodeKind, label:'+elm', color: ACCENT},
              {kind:'attribute' as XmlNodeKind, label:'@att', color:'#4a9eff'},
              {kind:'cdata' as XmlNodeKind, label:'CDA', color:'#a78bfa'},
              {kind:'group' as XmlNodeKind, label:'+grp', color:'#ffb347'},
            ]).map((btn) => (
              <button key={btn.kind} onClick={() => handleAddRoot(btn.kind)}
                style={{ background: 'none', border: `0.5px dashed ${btn.color}60`, borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: btn.color, fontSize: 9 }}>
                {btn.label}
              </button>
            ))}
            <button onClick={() => setShowPreview((v) => !v)} title="Anteprima XML"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: showPreview ? ACCENT : '#4a5a7a', padding: '0 4px' }}>
              <i className="ti ti-eye" style={{ fontSize: 11 }} />
            </button>
            {hasTree && (
              <button onClick={() => { if (confirm('Svuotare l\'albero?')) setTreeNodes(() => []) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 4px' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                <i className="ti ti-trash" style={{ fontSize: 11 }} />
              </button>
            )}
          </div>

          {/* Anteprima */}
          {showPreview && hasTree && (
            <div style={{ padding: '6px 10px', background: '#0a0f1a', borderBottom: '0.5px solid #2a3349', flexShrink: 0, maxHeight: 140, overflowY: 'auto' }}>
              <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 4 }}>Anteprima struttura (valori come segnaposto)</div>
              <pre style={{ margin: 0, fontSize: 9, color: '#3ddc84', fontFamily: 'monospace', whiteSpace: 'pre', overflow: 'auto' }}>
                {p('xmlDeclaration','true') === 'true' ? `<?xml version="1.0" encoding="${p('encoding','UTF-8')}"?>\n` : ''}{xmlPreview}
              </pre>
            </div>
          )}

          {/* Area drop / albero */}
          <div style={{ flex: 1, overflowY: 'auto' }}
            onDragOver={(e) => { if (!dragOver) e.preventDefault() }}
            onDrop={(e) => {
              if (dragOver) return
              e.preventDefault()
              const handle = e.dataTransfer.getData('handle')
              const field  = e.dataTransfer.getData('field')
              if (!handle || !field) return
              const inp   = realInputs[handle]
              const leaf: XmlTreeNode = { id: uid(), xmlName: field, ns: '', kind: 'element', children: [], collapsed: false, sourceHandle: handle, sourceField: field }
              setTreeNodes((prev) => [...prev, leaf])
            }}>
            {treeNodes.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: '#2a3349', pointerEvents: 'none' }}>
                <i className="ti ti-code" style={{ fontSize: 32, display: 'block', marginBottom: 10, color: `${ACCENT}20` }} />
                <div style={{ fontSize: 11, marginBottom: 6 }}>Albero vuoto</div>
                <div style={{ fontSize: 9 }}>Trascina campi · usa +elm/@att/CDA/+grp · o importa XML/XSD</div>
              </div>
            ) : (
              <div style={{ paddingBottom: 8 }}>
                {treeNodes.map((n) => (
                  <XmlTreeNodeRow key={n.id} node={n} depth={0}
                    inputs={realInputs} dragOver={dragOver} onDragOver={setDragOver} onDrop={handleDrop}
                    onToggle={handleToggle} onAddChild={handleAddChild} onAddChildFromDrop={handleAddChildFromDrop}
                    onDelete={handleDelete} onRename={handleRename} onSetNs={handleSetNs}
                    onChangeKind={handleChangeKind} onChangeExpr={handleChangeExpr}
                    onChangeCondition={handleChangeCond} onSetIterHandle={handleSetIter}
                    onRemoveSource={handleRemoveSource} onReorder={handleReorder}
                    selectedId={selectedTreeNodeId} onSelect={setSelectedTreeNodeId}
                    availableHandles={Object.keys(realInputs)} usedIterHandles={usedIterHandles} 
                    onSetGroupBy={handleSetGroupBy}/>
                ))}
              </div>
            )}
          </div>

          {/* Import XML/XSD */}
          <div style={{ borderTop: '1px solid #2a3349', padding: '6px 10px', background: '#1a2030', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 4, marginBottom: 5, alignItems: 'center' }}>
              {(['xml','xsd'] as const).map((mode) => (
                <button key={mode} onClick={() => setImportMode(mode)}
                  style={{ padding: '1px 8px', fontSize: 9, borderRadius: 3, cursor: 'pointer',
                    background: importMode === mode ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : 'none',
                    color: importMode === mode ? ACCENT : '#4a5a7a',
                    border: importMode === mode ? `1px solid ${ACCENT}50` : '1px solid #2a3349' }}>
                  {mode.toUpperCase()}
                </button>
              ))}
              <span style={{ fontSize: 9, color: '#4a5a7a' }}>
                {importMode === 'xsd' ? 'Incolla XSD — elementi semplici importati come struttura' : 'Incolla XML di esempio — struttura importata come template'}
              </span>
            </div>
            <div style={{ display: 'flex', gap: 5, alignItems: 'flex-start' }}>
              <textarea style={{ ...iStyle, resize: 'none', height: 44, fontSize: 9, fontFamily: 'monospace', flex: 1 }}
                value={sampleRaw} onChange={(e) => setSampleRaw(e.target.value)}
                placeholder={importMode === 'xsd' ? '<xs:schema>...</xs:schema>' : '<record><id>1</id><nome>Mario</nome></record>'}
                spellCheck={false} />
              <button onClick={handleImport} disabled={!sampleRaw}
                style={{ padding: '5px 10px', fontSize: 9, borderRadius: 4, cursor: sampleRaw ? 'pointer' : 'not-allowed',
                  background: sampleRaw ? `color-mix(in srgb, ${ACCENT} 20%, #161b27)` : '#1e2535',
                  color: sampleRaw ? ACCENT : '#4a5a7a', border: `1px solid ${sampleRaw ? ACCENT+'60' : '#2a3349'}`,
                  fontWeight: 600, flexShrink: 0, height: 44, display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ti ti-player-play" style={{ fontSize: 9 }} /> Import
              </button>
            </div>
            {sampleErr && <div style={{ fontSize: 9, color: '#ff5f57', marginTop: 3 }}>{sampleErr}</div>}
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── XmlSerializerModal ───────────────────────────────────────────
type Tab = 'general' | 'mapping' | 'advanced'

export function XmlSerializerModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const [activeTab, setActiveTab]     = useState<Tab>('mapping')
  const [isMaximized, setIsMaximized] = useState(false)
  const [modalWidth, setModalWidth]   = useState<number | null>(null)
  const resizingRef = useRef(false); const startXRef = useRef(0); const startWidthRef = useRef(0)
  const modalRef = useRef<HTMLDivElement>(null)
  const { ref: dragRef, pos, onMouseDown, reset: resetDrag } = useDraggable()

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizingRef.current = true; startXRef.current = e.clientX
    startWidthRef.current = modalRef.current?.getBoundingClientRect().width ?? 900
    const onMove = (ev: MouseEvent) => { if (!resizingRef.current) return; setModalWidth(Math.round(Math.max(600, Math.min(window.innerWidth - 48, startWidthRef.current + ev.clientX - startXRef.current)))) }
    const onUp   = () => { resizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'general',  label: 'Generale',      icon: 'ti-info-circle' },
    { id: 'mapping',  label: 'Configurazione', icon: 'ti-adjustments' },
    { id: 'advanced', label: 'Avanzate',       icon: 'ti-settings-2' },
  ]

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: pos ? 'flex-start' : 'center', justifyContent: 'center', zIndex: 20000, padding: 24, pointerEvents: 'none' }}>
      <div
        ref={(el) => { dragRef.current = el; (modalRef as React.MutableRefObject<HTMLDivElement | null>).current = el }}
        onClick={(e) => e.stopPropagation()}
        style={{
          pointerEvents: 'all', background: '#161b27', border: `1px solid ${ACCENT}40`,
          borderRadius: isMaximized ? 0 : 10,
          width: modalWidth ? `${modalWidth}px` : '80%',
          maxWidth: isMaximized ? '100vw' : modalWidth ? 'none' : 1100,
          maxHeight: isMaximized ? '100vh' : '90vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.8), 0 0 0 1px #2a3349', position: 'relative',
          ...(pos && !isMaximized ? { position: 'fixed' as const, left: pos.x, top: pos.y } : {}),
          ...(isMaximized ? { position: 'fixed' as const, inset: 0 } : {}),
        }}>

        {/* Header */}
        <div onMouseDown={onMouseDown}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #2a3349', background: '#1a2030', flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
          <span style={{ fontSize: 18, color: ACCENT, fontWeight: 700 }}>&lt;/&gt;</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8d4f0' }}>{node?.data.config?.displayName || node?.data.label || 'XML Serializer'}</div>
            <div style={{ fontSize: 11, color: '#4a5a7a', fontFamily: 'monospace' }}>{nodeId} · {node?.data.laneId}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => setIsMaximized((m) => { if (!m) { setModalWidth(null); resetDrag() } return !m })}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', color: '#9a9aaa', display: 'flex', alignItems: 'center' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a5a7a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              <i className={`ti ${isMaximized ? 'ti-arrows-minimize' : 'ti-arrows-maximize'}`} style={{ fontSize: 13 }} />
            </button>
            <button onClick={onClose}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', color: '#9a9aaa', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a5a7a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              <i className="ti ti-x" style={{ fontSize: 12 }} /> chiudi
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid #2a3349', flexShrink: 0, background: '#161b27' }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              style={{ padding: '9px 16px', fontSize: 11, background: activeTab === t.id ? '#1e2535' : 'transparent', border: 'none', borderBottom: activeTab === t.id ? `2px solid ${ACCENT}` : '2px solid transparent', color: activeTab === t.id ? '#c8d4f0' : '#4a5a7a', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6, transition: 'all .15s' }}
              onMouseEnter={(e) => { if (activeTab !== t.id) (e.currentTarget as HTMLElement).style.color = '#9a9aaa' }}
              onMouseLeave={(e) => { if (activeTab !== t.id) (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
              <i className={`ti ${t.icon}`} style={{ fontSize: 13 }} /> {t.label}
            </button>
          ))}
        </div>

        {/* Contenuto */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: activeTab === 'general'  ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}><TabGeneral nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'mapping'  ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden', flexDirection: 'column' }}><XmlSerializerLayout nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'advanced' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}><TabAdvanced nodeId={nodeId} /></div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '1px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#4a5a7a', marginRight: 'auto' }}>Le modifiche sono salvate automaticamente</span>
          <button onClick={onClose}
            style={{ padding: '6px 20px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}60`, fontWeight: 600 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 25%, #161b27)` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 15%, #161b27)` }}>
            Fatto
          </button>
        </div>

        {/* Handle resize laterale */}
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