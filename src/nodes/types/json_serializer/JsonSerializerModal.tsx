/**
 * src/nodes/types/json_serializer/JsonSerializerModal.tsx
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TabGeneral }  from '../../../components/tabs/TabGeneral'
import { TabAdvanced } from '../../../components/tabs/TabAdvanced'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { getHandleSchema } from '../../../utils/schemaRegistry'

const ACCENT = '#22d3ee'

const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10, padding: '3px 6px', outline: 'none', width: '100%',
}
const FLOW_COLORS = ['#22d3ee','#3ddc84','#ffb347','#a78bfa','#f472b6','#84cc16','#fb923c','#4a9eff']

// ─── Tipi ─────────────────────────────────────────────────────────
interface SerInput { label: string; fields: Array<{ name: string; type: string }> }

interface JsonFlowField {
  id: string; jsonKey: string; sourceField: string; transform: string
  nullable: 'null'|'omit'|'empty'; isManual?: boolean
}
interface JsonFlowMapping {
  handle: string; jsonKey: string; mode: 'array'|'object'|'value'; field?: string
  fields: JsonFlowField[]; dedup?: boolean
}

// ─── Nodo albero JSON (output) ────────────────────────────────────
type JsonNodeType = 'string'|'number'|'boolean'|'object'|'array'|'null'
interface JsonTreeNode {
  id: string; key: string; type: JsonNodeType
  children: JsonTreeNode[]; collapsed: boolean
  sourceHandle?: string; sourceField?: string
  sources?: Array<{ handle: string; field: string }>
  expr?: string
  // Array annidati: handle che guida l'iterazione (es. flusso3 dentro paziente[])
  iterHandle?: string
  // Condizionale: espressione JS — se falsa il campo viene omesso
  condition?: string
  groupBy?: string
}

let _nc = 0
const uid = () => `jn_${++_nc}_${Date.now()}`

function makeLeaf(key: string, type: JsonNodeType = 'string'): JsonTreeNode {
  return { id: uid(), key, type, children: [], collapsed: false }
}
function makeObject(key: string, children: JsonTreeNode[] = []): JsonTreeNode {
  return { id: uid(), key, type: 'object', children, collapsed: false }
}
function makeArray(key: string, children: JsonTreeNode[] = []): JsonTreeNode {
  return { id: uid(), key, type: 'array', children, collapsed: false }
}

function buildFromValue(val: unknown, key: string, depth = 0): JsonTreeNode {
  if (Array.isArray(val)) {
    const sample = val[0]
    const children = (sample && typeof sample === 'object' && !Array.isArray(sample))
      ? Object.entries(sample as Record<string,unknown>).map(([k,v]) => buildFromValue(v, k, depth+1))
      : []
    return { id: uid(), key, type: 'array', children, collapsed: depth > 1 }
  }
  if (val && typeof val === 'object') {
    const children = Object.entries(val as Record<string,unknown>).map(([k,v]) => buildFromValue(v, k, depth+1))
    return { id: uid(), key, type: 'object', children, collapsed: depth > 1 }
  }
  let type: JsonNodeType = 'string'
  if (val === null) type = 'null'
  else if (typeof val === 'boolean') type = 'boolean'
  else if (typeof val === 'number') type = 'number'
  return { id: uid(), key, type, children: [], collapsed: false }
}

function parseTreeFromJson(s: string): JsonTreeNode[] {
  try {
    const p = JSON.parse(s)
    if (Array.isArray(p) && p[0] && typeof p[0] === 'object')
      return Object.entries(p[0] as Record<string,unknown>).map(([k,v]) => buildFromValue(v, k))
    if (typeof p === 'object' && p !== null)
      return Object.entries(p as Record<string,unknown>).map(([k,v]) => buildFromValue(v, k))
    return []
  } catch { return [] }
}

function treeToJson(nodes: JsonTreeNode[]): string {
  function nodeToVal(n: JsonTreeNode): unknown {
    if (n.type === 'object') {
      const obj: Record<string,unknown> = {}
      n.children.forEach((c) => { obj[c.key] = nodeToVal(c) })
      return obj
    }
    if (n.type === 'array') {
      if (n.children.length > 0) return [nodeToVal(n.children[0])]
      return []
    }
    if (n.type === 'null') return null
    if (n.type === 'boolean') return false
    if (n.type === 'number') return 0
    return ''
  }
  const root: Record<string,unknown> = {}
  nodes.forEach((n) => { root[n.key] = nodeToVal(n) })
  return JSON.stringify(root, null, 2)
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

// ─── TreeNodeRow — riga dell'albero output ────────────────────────
function TreeNodeRow({
  node, depth, inputs, mappings,
  dragOver, onDragOver, onDrop, onToggle,
  onAddChild, onAddChildFromDrop, onDelete, onRename, onChangeType, onChangeExpr, onRemoveSource,
  selectedId, onSelect, onReorder, onSetIterHandle,onSetGroupBy, onChangeCondition, availableHandles, usedIterHandles,
}: {
  node: JsonTreeNode; depth: number
  inputs: Record<string, SerInput>
  mappings: Record<string, JsonFlowMapping>
  selectedId: string | null
  onSelect: (id: string) => void
  dragOver: string | null
  onDragOver: (id: string | null) => void
  onDrop: (nodeId: string, handle: string, field: string) => void
  onToggle: (id: string) => void
  onAddChild: (parentId: string, type: 'leaf'|'object'|'array') => void
  onAddChildFromDrop: (parentId: string, handle: string, field: string) => void
  onDelete: (id: string) => void
  onRename: (id: string, key: string) => void
  onChangeType: (id: string, type: JsonNodeType) => void
  onChangeExpr: (id: string, expr: string) => void
  onRemoveSource: (id: string, sourceIdx: number) => void
  onReorder: (dragId: string, targetId: string, position: 'before'|'after') => void
  onSetIterHandle: (id: string, handle: string) => void
  onSetGroupBy: (id: string, groupBy: string) => void
  onChangeCondition: (id: string, condition: string) => void
  availableHandles: string[]
  usedIterHandles: Set<string>
}) {
  const isLeaf = node.type !== 'object' && node.type !== 'array'
  const isDragOver = dragOver === node.id

  // Trova il colore del flusso mappato
  const mappedHandle = node.sourceHandle
  const mappedField  = node.sourceField
  const handleIdx    = mappedHandle ? Object.keys(inputs).indexOf(mappedHandle) : -1
  const mappedColor  = handleIdx >= 0 ? FLOW_COLORS[handleIdx % FLOW_COLORS.length] : null

  const typeColor = node.type === 'array' ? '#ffb347'
    : node.type === 'object' ? '#9a9aaa'
    : node.type === 'string' ? '#3ddc84'
    : node.type === 'number' ? '#4a9eff'
    : node.type === 'boolean' ? '#a78bfa'
    : '#4a5a7a'

  const isSelected = selectedId === node.id
  const [editing, setEditing]             = useState(false)
  const [keyVal, setKeyVal]               = useState(node.key)
  const [hovered, setHovered]             = useState(false)
  const [exprEditing, setExprEditing]     = useState(false)
  const [exprVal, setExprVal]             = useState(node.expr ?? '')
  const [condEditing, setCondEditing]     = useState(false)
  const [condVal, setCondVal]             = useState(node.condition ?? '')
  const [dropIndicator, setDropIndicator] = useState<'before'|'after'|null>(null)

  return (
    <>
      {/* Indicatore drop BEFORE */}
      {dropIndicator === 'before' && (
        <div style={{ height: 2, background: '#ffb347', marginLeft: 8 + depth * 14, borderRadius: 1 }} />
      )}
      <div
        draggable
        onDragStart={(e) => {
          e.stopPropagation()
          e.dataTransfer.setData('tree-node-id', node.id)
          e.dataTransfer.effectAllowed = 'move'
        }}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        onClick={(e) => { e.stopPropagation(); onSelect(node.id) }}
        onDragOver={(e) => {
          e.preventDefault()
          e.stopPropagation()
          const treeId = e.dataTransfer.types.includes('tree-node-id') || true
          if (treeId) {
            // Determina se drop prima o dopo in base alla posizione Y
            const rect = e.currentTarget.getBoundingClientRect()
            const mid  = rect.top + rect.height / 2
            setDropIndicator(e.clientY < mid ? 'before' : 'after')
          }
          // Drop da FieldPill (handle+field)
          if (!e.dataTransfer.types.includes('tree-node-id')) {
            onDragOver(node.id)
          }
        }}
        onDragLeave={(e) => {
          e.stopPropagation()
          setDropIndicator(null)
          const related = e.relatedTarget as HTMLElement | null
          if (!e.currentTarget.contains(related)) onDragOver(null)
        }}
        onDrop={(e) => {
          e.preventDefault()
          e.stopPropagation()
          setDropIndicator(null)
          onDragOver(null)

          const treeNodeId = e.dataTransfer.getData('tree-node-id')
          if (treeNodeId && treeNodeId !== node.id) {
            // Riordino nodi albero
            const rect = e.currentTarget.getBoundingClientRect()
            const pos  = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after'
            onReorder(treeNodeId, node.id, pos)
            return
          }

          const handle = e.dataTransfer.getData('handle')
          const field  = e.dataTransfer.getData('field')
          if (handle && field) {
            if (isLeaf) {
              onDrop(node.id, handle, field)
            } else {
              onAddChildFromDrop(node.id, handle, field)
            }
          }
        }}
        style={{
          display: 'flex', alignItems: 'center', gap: 3,
          paddingLeft: 8 + depth * 14, paddingRight: 6, paddingTop: 3, paddingBottom: 3,
          borderBottom: dropIndicator === 'after' ? '2px solid #ffb347' : '0.5px solid #1a2030',
          background: isDragOver ? `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`
            : isSelected ? `color-mix(in srgb, #ffb347 12%, #0f1117)`
            : mappedColor ? `color-mix(in srgb, ${mappedColor} 6%, #0f1117)` : 'transparent',
          borderLeft: isDragOver ? `2px solid ${ACCENT}`
            : isSelected ? '2px solid #ffb347'
            : mappedColor ? `2px solid ${mappedColor}60` : '2px solid transparent',
          transition: 'background .1s',
          cursor: 'grab',
        }}
      >
        {/* Chevron per oggetti/array */}
        {!isLeaf ? (
          <button onClick={() => onToggle(node.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, width: 12, flexShrink: 0 }}>
            <i className={`ti ${node.collapsed ? 'ti-chevron-right' : 'ti-chevron-down'}`} style={{ fontSize: 9 }} />
          </button>
        ) : <div style={{ width: 12, flexShrink: 0 }} />}

        {/* Badge tipo */}
        <span style={{ fontSize: 9, color: typeColor, fontFamily: 'monospace', flexShrink: 0, minWidth: 16, textAlign: 'center',
          padding: '1px 3px', borderRadius: 2, background: `color-mix(in srgb, ${typeColor} 12%, transparent)` }}>
          {node.type === 'array' ? '[]' : node.type === 'object' ? '{}' : node.type.slice(0,3)}
        </span>

        {/* Key editabile */}
        {editing ? (
          <input value={keyVal} autoFocus
            onChange={(e) => setKeyVal(e.target.value)}
            onBlur={() => { onRename(node.id, keyVal); setEditing(false) }}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === 'Escape') { onRename(node.id, keyVal); setEditing(false) } }}
            style={{ ...iStyle, fontSize: 10, padding: '1px 4px', flex: 1, minWidth: 0, color: typeColor }} />
        ) : (
          <span onDoubleClick={() => setEditing(true)} title="Doppio click per rinominare"
            style={{ fontSize: 10, color: typeColor, fontFamily: 'monospace', flex: 1, overflow: 'hidden',
              textOverflow: 'ellipsis', whiteSpace: 'nowrap', cursor: 'text' }}>
            {node.key}
          </span>
        )}

        {/* Badge sorgenti — una o più */}
        {isLeaf && !node.expr && (() => {
          const allSources: Array<{ handle: string; field: string }> = node.sources?.length
            ? node.sources
            : node.sourceHandle && node.sourceField
              ? [{ handle: node.sourceHandle, field: node.sourceField }]
              : []
          if (allSources.length === 0) return null
          return (
            <div style={{ display: 'flex', gap: 2, flexShrink: 0, flexWrap: 'wrap', maxWidth: 140 }}>
              {allSources.map((s, si) => {
                const hIdx = Object.keys(inputs).indexOf(s.handle)
                const sc   = hIdx >= 0 ? FLOW_COLORS[hIdx % FLOW_COLORS.length] : '#4a5a7a'
                return (
                  <span key={`${s.handle}:${s.field}`}
                    style={{ fontSize: 9, color: sc, fontFamily: 'monospace',
                      padding: '1px 4px', borderRadius: 3,
                      background: `color-mix(in srgb, ${sc} 15%, #0f1117)`,
                      border: `0.5px solid ${sc}40`,
                      cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2 }}
                    title={`${s.handle} → ${s.field} (click per rimuovere)`}
                    onClick={() => onRemoveSource(node.id, si)}>
                    {s.field}
                    {allSources.length > 1 && <i className="ti ti-x" style={{ fontSize: 7 }} />}
                  </span>
                )
              })}
            </div>
          )
        })()}

        {/* Expr custom — badge se impostata, input se in editing */}
        {isLeaf && (
          exprEditing ? (
            <input
              autoFocus
              value={exprVal}
              onChange={(e) => setExprVal(e.target.value)}
              onBlur={() => { onChangeExpr(node.id, exprVal); setExprEditing(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onChangeExpr(node.id, exprVal); setExprEditing(false) }
                if (e.key === 'Escape') { setExprVal(node.expr ?? ''); setExprEditing(false) }
              }}
              placeholder={mappedField ? `row.${mappedField}` : 'es: row.campo.trim()'}
              style={{ ...iStyle, fontSize: 9, padding: '1px 5px', flex: 1, minWidth: 80,
                color: '#ffb347', borderColor: '#ffb34760', background: '#1a1500' }}
            />
          ) : (
            <button
              onClick={() => { setExprVal(node.expr ?? ''); setExprEditing(true) }}
              title={node.expr ? `Espressione: ${node.expr}` : 'Aggiungi espressione custom'}
              style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, cursor: 'pointer', flexShrink: 0,
                background: node.expr ? 'color-mix(in srgb, #ffb347 15%, #0f1117)' : 'none',
                color: node.expr ? '#ffb347' : '#2a3349',
                border: node.expr ? '0.5px solid #ffb34740' : '0.5px dashed #2a3349',
                fontFamily: 'monospace', maxWidth: 100, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {node.expr ? node.expr : 'ƒ expr'}
            </button>
          )
        )}

        {/* Indicatore drag-over da FieldPill */}
        {isDragOver && (
          <span style={{ fontSize: 9, color: ACCENT, flexShrink: 0 }}>← rilascia</span>
        )}

        {/* iterHandle — solo per nodi array: quale flusso guida l'iterazione */}
        {node.type === 'array' && availableHandles.length > 0 && (
          <div onClick={(e) => e.stopPropagation()} title="Flusso che guida l'iterazione di questo array" style={{ flexShrink: 0 }}>
            <CustomSelect value={node.iterHandle ?? ''}
              onChange={(e) => { onSetIterHandle(node.id, e.target.value) }}
              style={{ fontSize: 9, padding: '1px 3px', width: 68,
                background: node.iterHandle ? 'color-mix(in srgb, #ffb347 10%, #1e2535)' : 'transparent',
                color: node.iterHandle ? '#ffb347' : '#4a5a7a',
                border: node.iterHandle ? '0.5px solid #ffb34740' : '0.5px dashed #2a3349',
                borderRadius: 3, outline: 'none', fontFamily: "'JetBrains Mono', monospace",
                cursor: 'pointer' }}>
              <option value="">iter…</option>
              {availableHandles.map((h) => (
                <option key={h} value={h}
                  disabled={usedIterHandles.has(h) && node.iterHandle !== h}>
                  {h}{usedIterHandles.has(h) && node.iterHandle !== h ? ' ✓' : ''}
                </option>
              ))}
            </CustomSelect>
          </div>

        )}
        {node.type === 'array' && node.iterHandle && (
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
        {/* Condizionale */}
        {isLeaf && (
          condEditing ? (
            <input autoFocus value={condVal}
              onChange={(e) => setCondVal(e.target.value)}
              onBlur={() => { onChangeCondition(node.id, condVal); setCondEditing(false) }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { onChangeCondition(node.id, condVal); setCondEditing(false) }
                if (e.key === 'Escape') { setCondVal(node.condition ?? ''); setCondEditing(false) }
              }}
              placeholder="es: row.età > 0"
              style={{ ...iStyle, fontSize: 9, padding: '1px 5px', width: 120, flexShrink: 0,
                color: '#a78bfa', borderColor: '#a78bfa60', background: '#110d1a' }}
              onClick={(e) => e.stopPropagation()} />
          ) : node.condition ? (
            <button onClick={(e) => { e.stopPropagation(); setCondVal(node.condition ?? ''); setCondEditing(true) }}
              title={`Condizione: ${node.condition}`}
              style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, cursor: 'pointer', flexShrink: 0,
                background: 'color-mix(in srgb, #a78bfa 15%, #0f1117)',
                color: '#a78bfa', border: '0.5px solid #a78bfa40',
                fontFamily: 'monospace', maxWidth: 80, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              if {node.condition}
            </button>
          ) : null
        )}

        {/* Azioni — visibili solo su hover della riga */}
        {hovered && (
        <div style={{ display: 'flex', gap: 2, flexShrink: 0 }}>

          {/* Aggiungi figli — disponibile su tutti i nodi */}
          <button onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'leaf') }}
            title="Aggiungi campo figlio"
            style={{ background: 'none', border: `0.5px solid ${typeColor}40`, borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: typeColor, fontSize: 9 }}>
            +campo
          </button>
          <button onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'object') }}
            title="Aggiungi oggetto figlio"
            style={{ background: 'none', border: '0.5px solid #2a3349', borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9 }}>
            +{'{}'}
          </button>
          <button onClick={(e) => { e.stopPropagation(); onAddChild(node.id, 'array') }}
            title="Aggiungi array figlio"
            style={{ background: 'none', border: '0.5px solid #2a3349', borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9 }}>
            +{'[]'}
          </button>

          {/* Bottone condizione — solo foglie */}
          {isLeaf && (
            <button onClick={(e) => { e.stopPropagation(); setCondVal(node.condition ?? ''); setCondEditing(true) }}
              title="Aggiungi condizione (il campo viene omesso se falsa)"
              style={{ background: 'none', border: '0.5px solid #a78bfa40', borderRadius: 3, padding: '1px 4px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#a78bfa' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
              if
            </button>
          )}

          <button onClick={() => onDelete(node.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            <i className="ti ti-x" style={{ fontSize: 9 }} />
          </button>
        </div>
        )}
      </div>

      {/* Figli */}
      {!node.collapsed && node.children.map((child) => (
        <TreeNodeRow key={child.id} node={child} depth={depth + 1}
          inputs={inputs} mappings={mappings}
          dragOver={dragOver} onDragOver={onDragOver} onDrop={onDrop}
          onToggle={onToggle} onAddChild={onAddChild} onAddChildFromDrop={onAddChildFromDrop} onDelete={onDelete}
          onRename={onRename} onChangeType={onChangeType} onChangeExpr={onChangeExpr} onRemoveSource={onRemoveSource}
          onSetGroupBy={onSetGroupBy}
          selectedId={selectedId} onSelect={onSelect}
          onReorder={onReorder} onSetIterHandle={onSetIterHandle} onChangeCondition={onChangeCondition}
          availableHandles={availableHandles} usedIterHandles={usedIterHandles} 
        />
      ))}
    </>
  )
}


// ─── FlowCard ─────────────────────────────────────────────────────
// Lista unificata: ogni campo (da schema o manuale) ha pallino + nome + trasformazione
function FlowCard({ mapping, idx, input, treeNodes, onUpdate, onAutoMap }: {
  mapping: JsonFlowMapping; idx: number; input: SerInput | undefined
  treeNodes: JsonTreeNode[]; onUpdate: (h: string, p: Partial<JsonFlowMapping>) => void
  onAutoMap: (handle: string) => void
}) {
  const color      = FLOW_COLORS[idx % FLOW_COLORS.length]
  const schemaFields = input?.fields ?? []
  const [collapsed, setCollapsed] = useState(false)

  // Raccoglie sourceField mappati nell'albero per questo handle
  const getMappedInTree = useCallback((nodes: JsonTreeNode[]): Set<string> => {
    const set = new Set<string>()
    function walk(ns: JsonTreeNode[]) {
      ns.forEach((n) => {
        if (n.sourceHandle === mapping.handle && n.sourceField) set.add(n.sourceField)
        walk(n.children)
      })
    }
    walk(nodes); return set
  }, [mapping.handle])

  const mappedInTree = getMappedInTree(treeNodes)

  const schemaNames = new Set(schemaFields.map((f) => f.name))

  // Cerca il JsonFlowField per un campo schema (se ha trasformazione configurata)
  const getFieldConfig = (name: string): JsonFlowField | undefined =>
    mapping.fields.find((f) => f.sourceField === name)

  // Aggiorna o crea la config per un campo schema
  const upsertFieldConfig = (name: string, patch: Partial<JsonFlowField>) => {
    const existing = mapping.fields.find((f) => f.sourceField === name)
    if (existing) {
      onUpdate(mapping.handle, { fields: mapping.fields.map((f) => f.sourceField === name ? { ...f, ...patch } : f) })
    } else {
      const f: JsonFlowField = { id: `jf_${Date.now()}`, jsonKey: name, sourceField: name, transform: '', nullable: 'null', ...patch }
      onUpdate(mapping.handle, { fields: [...mapping.fields, f] })
    }
  }

/*
  const updateField = (id: string, patch: Partial<JsonFlowField>) =>
    onUpdate(mapping.handle, { fields: mapping.fields.map((f) => f.id === id ? { ...f, ...patch } : f) })
  const deleteField = (id: string) =>
    onUpdate(mapping.handle, { fields: mapping.fields.filter((f) => f.id !== id) })
*/
  return (
    <div style={{ border: `1px solid ${color}40`, borderRadius: 8, overflow: 'hidden', marginBottom: 8, flexShrink: 0 }}>
      {/* Header */}
      <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${color} 10%, #1a2030)`,
        borderBottom: collapsed ? 'none' : `0.5px solid ${color}30`,
        display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0, fontFamily: 'monospace' }}>{mapping.handle}</span>
        <span style={{ fontSize: 9, color: '#4a5a7a', flex: 1 }} />
        {/* Bacchetta auto-mappa — inserisce sotto nodo selezionato nell'albero */}
        <button onClick={() => onAutoMap(mapping.handle)}
          title="Auto-mappa tutti i campi nel nodo selezionato dell'albero (o in root se nessuno selezionato)"
          style={{ background: 'none', border: `0.5px solid ${color}40`, borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9, display: 'flex', alignItems: 'center', gap: 3 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-wand" style={{ fontSize: 9 }} /> auto
        </button>
        {/* Toggle deduplicazione */}
        <button
          onClick={() => onUpdate(mapping.handle, { dedup: !mapping.dedup })}
          title={mapping.dedup ? 'Deduplicazione attiva — click per disattivare' : 'Attiva deduplicazione righe'}
          style={{
            background: mapping.dedup ? `color-mix(in srgb, ${color} 20%, #0f1117)` : 'none',
            border: `0.5px solid ${mapping.dedup ? color : '#2a3349'}`,
            borderRadius: 3, padding: '1px 6px', cursor: 'pointer',
            color: mapping.dedup ? color : '#4a5a7a', fontSize: 9,
            display: 'flex', alignItems: 'center', gap: 3, transition: 'all .15s',
          }}>
          <i className="ti ti-copy-off" style={{ fontSize: 9 }} />
          dedup
        </button>
        <button onClick={() => setCollapsed((v) => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}>
          <i className={`ti ${collapsed ? 'ti-chevron-down' : 'ti-chevron-up'}`} style={{ fontSize: 10 }} />
        </button>
      </div>

      {!collapsed && (
        <div style={{ background: '#161b27' }}>

          {/* ── Lista unificata campi ── */}
          <div style={{ padding: '4px 0' }}>

            {/* Campi da schema */}
            {schemaFields.map((sf) => {
              const cfg      = getFieldConfig(sf.name)
              const isMapped = mappedInTree.has(sf.name) || !!cfg
              return (
                <FieldRow key={sf.name}
                  name={sf.name} type={sf.type}
                  handle={mapping.handle} handleIdx={idx}
                  isMapped={isMapped} color={color}
                  isManual={false}
                  onDelete={undefined}
                />
              )
            })}

          </div>
        </div>
      )}
    </div>
  )
}

// ─── FieldRow — riga campo unificata ──────────────────────────────
// Usata sia per campi da schema (readonly name) che manuali (name editabile)
function FieldRow({ name, type, handle, handleIdx, isMapped, color, isManual,
  onNameChange, onDelete }: {
  name: string; type: string; handle: string; handleIdx: number
  isMapped: boolean; color: string; isManual: boolean
  onNameChange?: (name: string) => void
  onDelete?: () => void
}) {
  const [hovered, setHovered] = useState(false)
  // Stato locale per il nome del campo manuale — evita perdita focus ad ogni keystroke
  const [localName, setLocalName] = useState(name)
  // Sincronizza se il nome cambia dall'esterno (es. reset)
  useEffect(() => { setLocalName(name) }, [name])
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: 'grid', gridTemplateColumns: '20px 1fr 52px 16px', gap: 3, alignItems: 'center',
        padding: '3px 10px 3px 8px',
        background: hovered ? '#1a2535' : isMapped ? `color-mix(in srgb, ${color} 4%, #161b27)` : 'transparent',
        borderBottom: '0.5px solid #1a2030', transition: 'background .1s' }}>

      {/* Pallino draggabile */}
      <div
        draggable
        onDragStart={(e) => {
          e.dataTransfer.setData('handle', handle)
          e.dataTransfer.setData('field', name)
          e.dataTransfer.effectAllowed = 'copy'
        }}
        title="Trascina sull'albero JSON"
        style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0,
          background: isMapped ? color : 'transparent',
          border: `1.5px solid ${isMapped ? color : '#4a5a7a'}`,
          cursor: 'grab', transition: 'all .12s',
          boxShadow: isMapped ? `0 0 4px ${color}60` : 'none' }} />

      {/* Nome campo — readonly per schema, editabile per manuali */}
      {isManual ? (
        <input value={localName}
          onChange={(e) => setLocalName(e.target.value)}
          onBlur={() => onNameChange?.(localName)}
          onKeyDown={(e) => { if (e.key === 'Enter') { onNameChange?.(localName); (e.target as HTMLInputElement).blur() } }}
          style={{ ...iStyle, fontSize: 9, padding: '2px 4px', color, background: '#1a2030' }}
          placeholder="nome_campo" />
      ) : (
        <span style={{ fontSize: 10, fontFamily: 'monospace', color: isMapped ? color : '#9a9aaa',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={type ? `${name} (${type})` : name}>
          {name}
        </span>
      )}

      {/* Tipo originale dal flusso */}
      <span style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace', textAlign: 'center',
        padding: '1px 3px', borderRadius: 2, background: '#1a2030',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
        title={type || 'tipo sconosciuto'}>
        {type || '—'}
      </span>

      {/* Elimina — solo campi manuali */}
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

// ─── helpers albero ───────────────────────────────────────────────
function updateNode(nodes: JsonTreeNode[], id: string, fn: (n: JsonTreeNode) => JsonTreeNode): JsonTreeNode[] {
  return nodes.map((n) => {
    if (n.id === id) return fn(n)
    return { ...n, children: updateNode(n.children, id, fn) }
  })
}
function deleteNode(nodes: JsonTreeNode[], id: string): JsonTreeNode[] {
  return nodes.filter((n) => n.id !== id).map((n) => ({ ...n, children: deleteNode(n.children, id) }))
}
function addChildNode(nodes: JsonTreeNode[], parentId: string, child: JsonTreeNode): JsonTreeNode[] {
  return nodes.map((n) => {
    if (n.id === parentId) return { ...n, collapsed: false, children: [...n.children, child] }
    return { ...n, children: addChildNode(n.children, parentId, child) }
  })
}

// Sposta il nodo dragId prima o dopo targetId nello stesso livello
function reorderNode(nodes: JsonTreeNode[], dragId: string, targetId: string, position: 'before'|'after'): JsonTreeNode[] {
  // Prova a livello corrente
  const dragIdx   = nodes.findIndex((n) => n.id === dragId)
  const targetIdx = nodes.findIndex((n) => n.id === targetId)
  if (dragIdx >= 0 && targetIdx >= 0) {
    const result  = [...nodes]
    const [moved] = result.splice(dragIdx, 1)
    const insertAt = result.findIndex((n) => n.id === targetId)
    result.splice(position === 'before' ? insertAt : insertAt + 1, 0, moved)
    return result
  }
  // Ricorsione nei figli
  return nodes.map((n) => ({ ...n, children: reorderNode(n.children, dragId, targetId, position) }))
}

// ─── JsonSerializerLayout ─────────────────────────────────────────
function JsonSerializerLayout({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const edges          = useFlowStore((s) => s.edges)
  const updateNodeConfig = useFlowStore((s) => s.updateNodeConfig)
  const updateNodeProp   = useFlowStore((s) => s.updateNodeProp)
  const nodes = useFlowStore((s) => s.nodes)

  if (!node) return null

  const serConfig = (node.data.config as any)?.jsonSerializer ?? { inputs: {}, mappings: {} }
  const inputs: Record<string, SerInput>         = serConfig.inputs ?? {}
  const mappings: Record<string, JsonFlowMapping> = serConfig.mappings ?? {}
  const incomingEdges = edges.filter((e) => e.target === nodeId)

// Legge gli schemi per handle usando la stessa logica di useIncomingSchemaFromHandle
// ma in un unico useMemo per rispettare le regole degli hook.
  const realInputs: Record<string, SerInput> = useMemo(() => {
    const result: Record<string, SerInput> = {}
    const allNodes = useFlowStore.getState().nodes
    const allEdges = useFlowStore.getState().edges

    incomingEdges.forEach((edge) => {
      const handle  = edge.targetHandle ?? 'input'
      const srcNode = allNodes.find((n) => n.id === edge.source)
      if (!srcNode) return

      // Pattern corretto: legge incomingSchema propagato sul nodo corrente
      // per questo handle, oppure risale al sorgente come useIncomingSchemaFromHandle
      let fields: Array<{ name: string; type: string }> = []

      if (srcNode.data.type === 'tmap') {
        const tmap   = srcNode.data.config?.tmap
        const output = tmap?.outputs?.find((o: any) => o.id === edge.sourceHandle)
          ?? tmap?.outputs?.[0]
        fields = (output?.fields ?? [])
          .filter((f: any) => f.name)
          .map((f: any) => ({ name: f.name, type: f.type ?? 'string' }))
      } else {
        // Legge outputSchema propagato dal sorgente
        const raw = srcNode.data.props?.['outputSchema']
        if (raw) {
          try {
            const parsed = JSON.parse(raw)
            fields = parsed.map((f: any) => ({ name: f.name ?? f.sourceField, type: f.type ?? 'string' }))
          } catch {}
        }
        // Fallback: incomingSchema del sorgente se è passthrough
        if (!fields.length) {
          const inc = srcNode.data.props?.['incomingSchema']
          if (inc) {
            try { fields = JSON.parse(inc).map((f: any) => ({ name: f.name, type: f.type ?? 'string' })) }
            catch {}
          }
        }
      }

      result[handle] = { label: handle, fields }
    })
    return result
  }, [
    incomingEdges.map((e) => `${e.source}:${e.sourceHandle}:${e.targetHandle}`).join('|'),
    nodes, // reagisce ai cambiamenti di schema nei nodi sorgente
    nodeId,
  ])

  const p = (key: string, def = '') => String((node.data as any).props?.[key] ?? def)
  const [showOptions, setShowOptions] = useState(false)

  // ── Albero output ──────────────────────────────────────────────
  const [treeNodes, setTreeNodesRaw] = useState<JsonTreeNode[]>(() => {
    try { return JSON.parse(p('_treeNodes', '[]')) } catch { return [] }
  })

  const setTreeNodes = useCallback((fn: (prev: JsonTreeNode[]) => JsonTreeNode[]) => {
    setTreeNodesRaw((prev) => {
      const next = fn(prev)
      // Persiste
      useFlowStore.getState().updateNodeProp(nodeId, '_treeNodes', JSON.stringify(next))
      return next
    })
  }, [nodeId])

  // Aggiorna quando props cambiano (apertura modal)
  useEffect(() => {
    try {
      const saved = JSON.parse(p('_treeNodes', '[]'))
      if (saved.length > 0) setTreeNodesRaw(saved)
    } catch {}
  }, [])

  const [dragOver, setDragOver]                     = useState<string | null>(null)
  const [selectedTreeNodeId, setSelectedTreeNodeId] = useState<string | null>(null)
  const [sampleRaw, setSampleRaw] = useState('')
  const [sampleErr, setSampleErr] = useState('')
  const [resizeW, setResizeW]     = useState(320)
  const resizing = useRef(false)

  // ── Operazioni albero ──────────────────────────────────────────
  const handleToggle = useCallback((id: string) => {
    setTreeNodes((prev) => updateNode(prev, id, (n) => ({ ...n, collapsed: !n.collapsed })))
  }, [setTreeNodes])

  const handleDelete = useCallback((id: string) => {
    setTreeNodes((prev) => deleteNode(prev, id))
  }, [setTreeNodes])

  const handleRename = useCallback((id: string, key: string) => {
    setTreeNodes((prev) => updateNode(prev, id, (n) => ({ ...n, key })))
  }, [setTreeNodes])

  const handleChangeType = useCallback((id: string, type: JsonNodeType) => {
    setTreeNodes((prev) => updateNode(prev, id, (n) => ({ ...n, type, children: [] })))
  }, [setTreeNodes])

  const handleRemoveSource = useCallback((id: string, sourceIdx: number) => {
    setTreeNodes((prev) => updateNode(prev, id, (n) => {
      const allSources: Array<{ handle: string; field: string }> = n.sources?.length
        ? n.sources
        : n.sourceHandle && n.sourceField
          ? [{ handle: n.sourceHandle, field: n.sourceField }]
          : []
      const remaining = allSources.filter((_, i) => i !== sourceIdx)
      return {
        ...n,
        sources:      remaining.length > 0 ? remaining : undefined,
        sourceHandle: remaining[0]?.handle,
        sourceField:  remaining[0]?.field,
        expr:         remaining.length > 1
          ? remaining.map((s) => `row.${s.field}`).join(" + ' ' + ")
          : undefined,
      }
    }))
  }, [setTreeNodes])

  const handleChangeCondition = useCallback((id: string, condition: string) => {
    setTreeNodes((prev) => updateNode(prev, id, (n) => ({ ...n, condition: condition || undefined })))
  }, [setTreeNodes])

  const handleSetIterHandle = useCallback((id: string, handle: string) => {
    setTreeNodes((prev) => updateNode(prev, id, (n) => ({ ...n, iterHandle: handle || undefined })))
  }, [setTreeNodes])

  const handleSetGroupBy = useCallback((id: string, groupBy: string) => {
  setTreeNodes((prev) => updateNode(prev, id, (n) => ({ ...n, groupBy: groupBy || undefined })))
  }, [setTreeNodes])

  const handleReorder = useCallback((dragId: string, targetId: string, position: 'before'|'after') => {
    setTreeNodes((prev) => reorderNode(prev, dragId, targetId, position))
  }, [setTreeNodes])

  const handleChangeExpr = useCallback((id: string, expr: string) => {
    setTreeNodes((prev) => updateNode(prev, id, (n) => ({ ...n, expr: expr || undefined })))
  }, [setTreeNodes])

  const handleAddChildFromDrop = useCallback((parentId: string, handle: string, field: string) => {
    const inp   = realInputs[handle]
    const fType = inp?.fields.find((f) => f.name === field)?.type ?? 'string'
    const leaf: JsonTreeNode = {
      id: uid(), key: field, type: fType as JsonNodeType,
      children: [], collapsed: false,
      sourceHandle: handle, sourceField: field,
    }
    setTreeNodes((prev) => addChildNode(prev, parentId, leaf))
  }, [inputs, setTreeNodes])

  const handleAddChild = useCallback((parentId: string, type: 'leaf'|'object'|'array') => {
    const child = type === 'object' ? makeObject('oggetto')
      : type === 'array' ? makeArray('lista')
      : makeLeaf('campo')
    setTreeNodes((prev) => {
      // Se il parent è una foglia, lo converte in object prima di aggiungere il figlio
      const promoted = updateNode(prev, parentId, (n) => {
        if (n.type !== 'object' && n.type !== 'array') {
          return { ...n, type: 'object' as JsonNodeType, collapsed: false }
        }
        return n
      })
      return addChildNode(promoted, parentId, child)
    })
  }, [setTreeNodes])

  const handleAddRoot = (type: 'leaf'|'object'|'array') => {
    const n = type === 'object' ? makeObject('oggetto')
      : type === 'array' ? makeArray('lista')
      : makeLeaf('campo')
    setTreeNodes((prev) => [...prev, n])
  }

  // Drop da FieldPill → nodo albero
  const handleDrop = useCallback((nodeId_: string, handle: string, field: string) => {
    setTreeNodes((prev) => updateNode(prev, nodeId_, (n) => {
      // Raccoglie tutte le sorgenti esistenti + la nuova
      const existing: Array<{ handle: string; field: string }> = n.sources?.length
        ? n.sources
        : n.sourceHandle && n.sourceField
          ? [{ handle: n.sourceHandle, field: n.sourceField }]
          : []

      // Evita duplicati
      const alreadyPresent = existing.some((s) => s.handle === handle && s.field === field)
      if (alreadyPresent) return n

      const newSources = [...existing, { handle, field }]

      // Pre-popola expr se ci sono più sorgenti (l'utente può modificarla)
      const newExpr = newSources.length > 1
        ? newSources.map((s) => `row.${s.field}`).join(" + ' ' + ")
        : undefined

      return {
        ...n,
        sourceHandle: newSources[0].handle,
        sourceField:  newSources[0].field,
        sources: newSources,
        expr: newExpr ?? n.expr,
      }
    }))
  }, [setTreeNodes])

  // Import da sample JSON
  const handleImportSample = () => {
    try {
      const nodes = parseTreeFromJson(sampleRaw)
      if (nodes.length === 0) { setSampleErr('JSON vuoto o non valido'); return }
      setTreeNodes(() => nodes)
      setSampleErr('')
      setSampleRaw('')
    } catch { setSampleErr('JSON non valido') }
  }

  // Auto-map: aggiunge a ogni flusso una entry foglia nell'albero
  const handleAutoMap = useCallback((handle: string) => {
    const inp = realInputs[handle]
    if (!inp?.fields.length) return
    const mapping = mappings[handle] ?? { handle, jsonKey: handle === 'input' ? 'data' : handle, mode: 'array', fields: [] }

    const newLeaves: JsonTreeNode[] = []
    setTreeNodes((prev) => {
      // Controlla quali campi esistono già nell'albero per questo handle
      const existingFields = new Set<string>()
      function walkExisting(ns: JsonTreeNode[]) {
        ns.forEach((n) => {
          if (n.sourceHandle === handle && n.sourceField) existingFields.add(n.sourceField)
          walkExisting(n.children)
        })
      }
      walkExisting(prev)

      // Crea foglie solo per campi non ancora presenti
      const leaves: JsonTreeNode[] = inp.fields
        .filter((f) => !existingFields.has(f.name))
        .map((f) => ({
          id: uid(), key: f.name, type: (f.type as JsonNodeType) || 'string',
          children: [], collapsed: false, sourceHandle: handle, sourceField: f.name,
        }))

      if (leaves.length === 0) return prev

      // Se c'è un nodo selezionato → aggiunge come figli di quel nodo
      if (selectedTreeNodeId) {
        return updateNode(prev, selectedTreeNodeId, (n) => ({
          ...n,
          // Se foglia, diventa object
          type: (n.type === 'object' || n.type === 'array') ? n.type : 'object' as JsonNodeType,
          collapsed: false,
          children: [...n.children, ...leaves],
        }))
      }

      // Altrimenti aggiunge in root
      return [...prev, ...leaves]
    })

    // Aggiorna mapping
    const newFields = inp.fields.map((f) => ({
      id: `jf_${Date.now()}_${f.name}`, jsonKey: f.name, sourceField: f.name, transform: '', nullable: 'null' as const,
    }))
    const current = { ...mappings, [handle]: { ...mapping, fields: newFields } }
    updateNodeConfig(nodeId, { jsonSerializer: { ...serConfig, mappings: current } } as any)
  }, [inputs, mappings, serConfig, nodeId, updateNodeConfig, setTreeNodes, selectedTreeNodeId])

  const getMapping = (handle: string): JsonFlowMapping =>
    mappings[handle] ?? { handle, jsonKey: handle === 'input' ? 'data' : handle, mode: 'array', fields: [] }

  const updateMapping = (handle: string, patch: Partial<JsonFlowMapping>) => {
    const current = { ...mappings, [handle]: { ...getMapping(handle), ...patch } }
    updateNodeConfig(nodeId, { jsonSerializer: { ...serConfig, mappings: current } } as any)
  }

  // Propagazione schema fisso
  const propagateOutputSchema = useCallback((outputField: string) => {
    const store = useFlowStore.getState()
    const schema = JSON.stringify([{ name: outputField, type: 'string' }])
    store.updateNodeProp(nodeId, 'outputSchema', schema)
    store.edges.filter((ed) => ed.source === nodeId && ed.sourceHandle === 'output')
      .forEach((edge) => store.updateNodeProp(edge.target, 'incomingSchema', schema))
  }, [nodeId])

  useEffect(() => { propagateOutputSchema(p('outputField', 'content')) }, [p('outputField')])

  // Resize handle tra le due colonne
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); resizing.current = true
    const startX = e.clientX; const startW = resizeW
    const onMove = (ev: MouseEvent) => { if (!resizing.current) return; setResizeW(Math.max(200, Math.min(600, startW + ev.clientX - startX))) }
    const onUp   = () => { resizing.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [resizeW])

  const hasTree = treeNodes.length > 0

  // Handle già assegnati ad altri nodi array — per la select iter esclusiva
  const usedIterHandles = useMemo(() => {
    const used = new Set<string>()
    function collect(ns: JsonTreeNode[]) {
      ns.forEach((n) => {
        if (n.type === 'array' && n.iterHandle) used.add(n.iterHandle)
        collect(n.children)
      })
    }
    collect(treeNodes)
    return used
  }, [treeNodes])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', overflow: 'hidden' }}>

      {/* Banner */}
      <div style={{ padding: '5px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderBottom: `0.5px solid ${ACCENT}20`, fontSize: 10, color: '#9a9aaa', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>{'{ }'}</span>
        <span>Trascina i campi sull'albero JSON di output a destra.</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'monospace', color: ACCENT }}>→ {p('outputField', 'content')}</span>
        <button onClick={() => setShowOptions((v) => !v)}
          style={{ background: 'none', border: `0.5px solid ${showOptions ? ACCENT : '#2a3349'}`, borderRadius: 3, padding: '2px 8px', cursor: 'pointer', color: showOptions ? ACCENT : '#4a5a7a', fontSize: 9 }}>
          <i className="ti ti-settings-2" style={{ fontSize: 9, marginRight: 3 }} />opzioni
        </button>
      </div>

      {/* Opzioni */}
      {showOptions && (
        <div style={{ padding: '6px 12px', borderBottom: '0.5px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr', gap: 8 }}>
            {[{label:'Campo output',key:'outputField',def:'content'},{label:'Envelope',key:'envelope',def:''}].map((opt) => (
              <div key={opt.key} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{opt.label}</div>
                <input style={{ ...iStyle, fontSize: 10, padding: '3px 6px', color: ACCENT }}
                  value={p(opt.key, opt.def)}
                  onChange={(e) => {
                    updateNodeProp(nodeId, opt.key, e.target.value)
                    if (opt.key === 'outputField') propagateOutputSchema(e.target.value || 'content')
                  }} placeholder={opt.def} />
              </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Formato</div>
              <CustomSelect style={{ ...iStyle, fontSize: 10, padding: '3px 4px' }} value={p('pretty','false')} onChange={(e) => updateNodeProp(nodeId, 'pretty', e.target.value)}>
                <option value="false">Compatto</option><option value="true">Pretty print</option>
              </CustomSelect>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Valori null</div>
              <CustomSelect style={{ ...iStyle, fontSize: 10, padding: '3px 4px' }} value={p('nullDefault','null')} onChange={(e) => updateNodeProp(nodeId, 'nullDefault', e.target.value)}>
                <option value="null">null</option><option value="omit">Ometti</option><option value="empty">""</option>
              </CustomSelect>
            </div>
          </div>
        </div>
      )}

      {/* Layout principale a due colonne */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', overflow: 'hidden' }}>

        {/* ── SINISTRA: flussi in ingresso ── */}
        <div style={{ width: resizeW, flexShrink: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: '1px solid #2a3349' }}>
          <div style={{ padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.06em', flex: 1 }}>
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
                    input={realInputs[handle]}
                    treeNodes={treeNodes}
                    onUpdate={updateMapping}
                    onAutoMap={handleAutoMap} />
                )
              })
            )}
          </div>
        </div>

        {/* ── Handle resize ── */}
        <div onMouseDown={onResizeStart}
          style={{ width: 5, flexShrink: 0, cursor: 'ew-resize', background: `color-mix(in srgb, ${ACCENT} 10%, #0f1117)`, transition: 'background .15s', zIndex: 10 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 30%, #0f1117)` }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 10%, #0f1117)` }}>
          <div style={{ width: 1, height: '100%', margin: '0 auto', background: `color-mix(in srgb, ${ACCENT} 20%, transparent)` }} />
        </div>

        {/* ── DESTRA: albero JSON output ── */}
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0f1117' }}>
          {/* Header albero */}
          <div style={{ padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, fontWeight: 600, color: '#ffb347', textTransform: 'uppercase', letterSpacing: '.06em', flex: 1 }}>
              Struttura JSON output
            </span>
            {/* Aggiungi nodi radice */}
            <button onClick={() => handleAddRoot('leaf')}
              style={{ background: 'none', border: '0.5px dashed #ffb34760', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#ffb347', fontSize: 9 }}>
              +campo
            </button>
            <button onClick={() => handleAddRoot('object')}
              style={{ background: 'none', border: '0.5px dashed #4a5a7a', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9 }}>
              +{'{}'}
            </button>
            <button onClick={() => handleAddRoot('array')}
              style={{ background: 'none', border: '0.5px dashed #4a5a7a', borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9 }}>
              +{'[]'}
            </button>
            {hasTree && (
              <button onClick={() => {
                  const json = treeToJson(treeNodes)
                  navigator.clipboard?.writeText(json).catch(() => {})
                }}
                title="Copia struttura JSON"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 4px' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = ACCENT }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                <i className="ti ti-copy" style={{ fontSize: 11 }} />
              </button>
            )}
            {hasTree && (
              <button onClick={() => { if (confirm('Svuotare l\'albero?')) setTreeNodes(() => []) }}
                title="Svuota albero"
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 4px' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                <i className="ti ti-trash" style={{ fontSize: 11 }} />
              </button>
            )}
          </div>

          {/* Area drop / albero */}
          <div style={{ flex: 1, overflowY: 'auto' }}
            onDragOver={(e) => {
              if (dragOver) { e.preventDefault(); e.stopPropagation() }
              else e.preventDefault()
            }}
            onDrop={(e) => {
              // Drop su area vuota (nessun nodo in dragOver) → aggiunge foglia radice
              if (dragOver) return  // il drop è già gestito dal TreeNodeRow
              e.preventDefault()
              const handle = e.dataTransfer.getData('handle')
              const field  = e.dataTransfer.getData('field')
              if (!handle || !field) return
              const inp = realInputs[handle]
              const fType = inp?.fields.find((f) => f.name === field)?.type ?? 'string'
              const leaf: JsonTreeNode = { id: uid(), key: field, type: fType as JsonNodeType, children: [], collapsed: false, sourceHandle: handle, sourceField: field }
              setTreeNodes((prev) => [...prev, leaf])
            }}>
            {treeNodes.length === 0 ? (
              <div style={{ padding: '40px 20px', textAlign: 'center', color: '#2a3349', pointerEvents: 'none' }}>
                <i className="ti ti-file-code" style={{ fontSize: 32, display: 'block', marginBottom: 10, color: '#ffb34720' }} />
                <div style={{ fontSize: 11, marginBottom: 6 }}>Albero vuoto</div>
                <div style={{ fontSize: 9, color: '#2a3349' }}>
                  Trascina campi qui · usa +campo/+{'{}'}/+[] · oppure importa da JSON
                </div>
              </div>
            ) : (
              <div style={{ paddingBottom: 8 }}>
                {treeNodes.map((n) => (
                  <TreeNodeRow key={n.id} node={n} depth={0}
                    inputs={realInputs} mappings={mappings}
                    dragOver={dragOver} onDragOver={setDragOver} onDrop={handleDrop}
                    onToggle={handleToggle} onAddChild={handleAddChild}
                    onAddChildFromDrop={handleAddChildFromDrop}
                    onDelete={handleDelete} onRename={handleRename} onChangeType={handleChangeType}
                    onChangeExpr={handleChangeExpr} onRemoveSource={handleRemoveSource}
                    selectedId={selectedTreeNodeId} onSelect={setSelectedTreeNodeId}
                    onReorder={handleReorder} onSetIterHandle={handleSetIterHandle}
                    onChangeCondition={handleChangeCondition}
                    availableHandles={Object.keys(realInputs)}
                    usedIterHandles={usedIterHandles}
                    onSetGroupBy={handleSetGroupBy} 
                  />
                ))}
              </div>
            )}
          </div>

          {/* Import da sample JSON */}
          <div style={{ borderTop: '1px solid #2a3349', padding: '6px 10px', background: '#1a2030', flexShrink: 0 }}>
            <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 4 }}>IMPORTA STRUTTURA DA JSON DI ESEMPIO</div>
            <div style={{ display: 'flex', gap: 5, alignItems: 'flex-start' }}>
              <textarea style={{ ...iStyle, resize: 'none', height: 44, fontSize: 9, fontFamily: 'monospace', flex: 1 }}
                value={sampleRaw} onChange={(e) => setSampleRaw(e.target.value)}
                placeholder={'{"id":1,"nome":"...","ordini":[]}'} spellCheck={false} />
              <button onClick={handleImportSample} disabled={!sampleRaw}
                style={{ padding: '5px 10px', fontSize: 9, borderRadius: 4, cursor: sampleRaw ? 'pointer' : 'not-allowed',
                  background: sampleRaw ? `color-mix(in srgb, #ffb347 20%, #161b27)` : '#1e2535',
                  color: sampleRaw ? '#ffb347' : '#4a5a7a',
                  border: `1px solid ${sampleRaw ? '#ffb34760' : '#2a3349'}`,
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

// ─── JsonSerializerModal ──────────────────────────────────────────
type Tab = 'general' | 'mapping' | 'advanced'

export function JsonSerializerModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
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
          maxWidth: isMaximized ? '100vw' : modalWidth ? 'none' : 1000,
          maxHeight: isMaximized ? '100vh' : '90vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.8), 0 0 0 1px #2a3349', position: 'relative',
          ...(pos && !isMaximized ? { position: 'fixed' as const, left: pos.x, top: pos.y } : {}),
          ...(isMaximized ? { position: 'fixed' as const, inset: 0 } : {}),
        }}>

        <div onMouseDown={onMouseDown}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #2a3349', background: '#1a2030', flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
          <span style={{ fontSize: 20, color: ACCENT, fontFamily: 'monospace', fontWeight: 700 }}>{'{ }'}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8d4f0' }}>{node?.data.config?.displayName || node?.data.label || 'JSON Serializer'}</div>
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

        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: activeTab === 'general'  ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}><TabGeneral nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'mapping'  ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden', flexDirection: 'column' }}><JsonSerializerLayout nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'advanced' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}><TabAdvanced nodeId={nodeId} /></div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '1px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#4a5a7a', marginRight: 'auto' }}>Le modifiche sono salvate automaticamente</span>
          <button onClick={onClose}
            style={{ padding: '6px 20px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}60`, fontWeight: 600 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 25%, #161b27)` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 15%, #161b27)` }}>
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