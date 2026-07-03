/**
 * src/nodes/types/json_serializer/Panel.tsx
 *
 * JSON Serializer — panel inline nel tab Configurazione.
 *
 * Layout a due colonne:
 *   - SINISTRA: flussi in ingresso con mapping campi e pallini per selezionare
 *   - DESTRA:   albero struttura JSON di destinazione (da import sample)
 *
 * Tutto persiste in node.data.props via updateProp.
 */
import { useState, useMemo, useEffect, useCallback } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { getHandleSchema } from '../../../utils/schemaRegistry'

const ACCENT = '#22d3ee'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
function SectionTitle({ label, color = ACCENT, action }: { label: string; color?: string; action?: React.ReactNode }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
      <span style={{ flex: 1 }}>{label}</span>
      {action}
    </div>
  )
}

const FLOW_COLORS = ['#22d3ee','#3ddc84','#ffb347','#a78bfa','#f472b6','#84cc16','#fb923c','#4a9eff']

// ─── Tipi ────────────────────────────────────────────────────────
interface JsonFlowInput {
  handle:  string
  jsonKey: string
  mode:    'array' | 'object' | 'value'
  field?:  string
  fields:  JsonFlowField[]
}

interface JsonFlowField {
  id:          string
  jsonKey:     string
  sourceField: string
  transform:   string
  nullable:    'null' | 'omit' | 'empty'
}

interface JsonFixedField {
  id:    string
  key:   string
  value: string
  type:  'string' | 'number' | 'boolean' | 'null'
}

// ─── Nodo albero struttura JSON ───────────────────────────────────
interface JsonTreeNode {
  id:        string
  key:       string
  valueType: 'string' | 'number' | 'boolean' | 'object' | 'array' | 'null'
  children:  JsonTreeNode[]
  collapsed: boolean
}

let _counter = 0
function buildNode(val: unknown, key: string, depth = 0): JsonTreeNode {
  const id = `jn_${++_counter}_${Date.now()}`
  if (Array.isArray(val)) {
    const sample = val[0]
    const children = (sample && typeof sample === 'object' && !Array.isArray(sample))
      ? Object.entries(sample as Record<string,unknown>).map(([k,v]) => buildNode(v, k, depth+1))
      : []
    return { id, key, valueType: 'array', children, collapsed: depth > 1 }
  }
  if (val && typeof val === 'object') {
    const children = Object.entries(val as Record<string,unknown>).map(([k,v]) => buildNode(v, k, depth+1))
    return { id, key, valueType: 'object', children, collapsed: depth > 1 }
  }
  let valueType: JsonTreeNode['valueType'] = 'string'
  if (val === null)                  valueType = 'null'
  else if (typeof val === 'boolean') valueType = 'boolean'
  else if (typeof val === 'number')  valueType = 'number'
  return { id, key, valueType, children: [], collapsed: false }
}

function parseTree(s: string): JsonTreeNode[] {
  try {
    const p = JSON.parse(s)
    if (Array.isArray(p) && p[0] && typeof p[0] === 'object')
      return Object.entries(p[0] as Record<string,unknown>).map(([k,v]) => buildNode(v, k))
    if (typeof p === 'object' && p !== null)
      return Object.entries(p as Record<string,unknown>).map(([k,v]) => buildNode(v, k))
    return []
  } catch { return [] }
}

// ─── Riga albero struttura JSON (destra) ─────────────────────────
function TreeRow({ node, depth, flowInputs, selectedFlowHandle, onToggle }: {
  node:               JsonTreeNode
  depth:              number
  flowInputs:         JsonFlowInput[]
  selectedFlowHandle: string | null
  onToggle:           (id: string) => void
}) {
  const isLeaf = node.children.length === 0
  const color  = node.valueType === 'array' ? '#ffb347'
    : node.valueType === 'object' ? '#c8d4f0' : '#3ddc84'

  // Quale flusso selezionato ha già questo campo
  const selectedFlow = flowInputs.find((f) => f.handle === selectedFlowHandle)
  const isMapped = selectedFlow?.fields.some((f) => f.jsonKey === node.key) ?? false

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '3px 6px', paddingLeft: 6 + depth * 12, borderBottom: '0.5px solid #1a2030', background: isMapped ? `color-mix(in srgb, ${color} 8%, #0f1117)` : 'transparent' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = isMapped ? `color-mix(in srgb, ${color} 12%, #0f1117)` : '#1a2535' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = isMapped ? `color-mix(in srgb, ${color} 8%, #0f1117)` : 'transparent' }}>
        {node.children.length > 0 ? (
          <button onClick={() => onToggle(node.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, width: 12, flexShrink: 0 }}>
            <i className={`ti ${node.collapsed ? 'ti-chevron-right' : 'ti-chevron-down'}`} style={{ fontSize: 9 }} />
          </button>
        ) : <div style={{ width: 12, flexShrink: 0 }} />}
        <span style={{ fontSize: 9, color, fontFamily: 'monospace', flexShrink: 0, minWidth: 14 }}>
          {node.valueType === 'array' ? '[]' : node.valueType === 'object' ? '{}' : '—'}
        </span>
        <span style={{ fontSize: 10, color, fontFamily: 'monospace', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {node.key}
        </span>
        {isLeaf && <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>{node.valueType}</span>}
        {isMapped && (
          <i className="ti ti-check" style={{ fontSize: 9, color, flexShrink: 0, marginLeft: 4 }} />
        )}
      </div>
      {!node.collapsed && node.children.map((child) => (
        <TreeRow key={child.id} node={child} depth={depth + 1}
          flowInputs={flowInputs} selectedFlowHandle={selectedFlowHandle} onToggle={onToggle} />
      ))}
    </>
  )
}

// ─── FlowCard — un flusso in ingresso (sinistra) ─────────────────
function FlowCard({ fi, idx, incomingFields, treeNodes, selectedFlowHandle, onSelect, onUpdate }: {
  fi:                 JsonFlowInput
  idx:                number
  incomingFields:     Array<{ name: string; type: string }>
  treeNodes:          JsonTreeNode[]
  selectedFlowHandle: string | null
  onSelect:           (handle: string | null) => void
  onUpdate:           (handle: string, patch: Partial<JsonFlowInput>) => void
}) {
  const [collapsed, setCollapsed] = useState(false)
  const color    = FLOW_COLORS[idx % FLOW_COLORS.length]
  const isSelected = selectedFlowHandle === fi.handle

  const addField = () => {
    const f: JsonFlowField = { id: `jf_${Date.now()}`, jsonKey: '', sourceField: '', transform: '', nullable: 'null' }
    onUpdate(fi.handle, { fields: [...fi.fields, f] })
  }

  const updateField = (id: string, patch: Partial<JsonFlowField>) =>
    onUpdate(fi.handle, { fields: fi.fields.map((f) => f.id === id ? { ...f, ...patch } : f) })

  const deleteField = (id: string) =>
    onUpdate(fi.handle, { fields: fi.fields.filter((f) => f.id !== id) })

  // Pallino — toglie/aggiunge campo dal flusso corrente
  const toggleField = (fieldName: string) => {
    const exists = fi.fields.some((f) => f.sourceField === fieldName)
    if (exists) {
      onUpdate(fi.handle, { fields: fi.fields.filter((f) => f.sourceField !== fieldName) })
    } else {
      // Cerca il jsonKey suggerito dall'albero
      const treeKey = findKeyInTree(treeNodes, fieldName) ?? fieldName
      const f: JsonFlowField = { id: `jf_${Date.now()}`, jsonKey: treeKey, sourceField: fieldName, transform: '', nullable: 'null' }
      onUpdate(fi.handle, { fields: [...fi.fields, f] })
    }
  }

  const autoPopulate = () => {
    if (incomingFields.length === 0) return
    const fields: JsonFlowField[] = incomingFields.map((f) => ({
      id: `jf_${Date.now()}_${f.name}`, jsonKey: f.name, sourceField: f.name, transform: '', nullable: 'null',
    }))
    onUpdate(fi.handle, { fields })
  }

  return (
    <div onClick={() => onSelect(isSelected ? null : fi.handle)}
      style={{ border: `1px solid ${isSelected ? color : color + '40'}`, borderRadius: 8, overflow: 'hidden', marginBottom: 8, flexShrink: 0, cursor: 'pointer', transition: 'border-color .15s' }}>

      {/* Header */}
      <div style={{ padding: '6px 10px', background: isSelected ? `color-mix(in srgb, ${color} 15%, #1a2030)` : `color-mix(in srgb, ${color} 8%, #1a2030)`, borderBottom: collapsed ? 'none' : `0.5px solid ${color}30`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: isSelected ? color : `${color}50`, border: `1.5px solid ${color}`, flexShrink: 0 }} />
        <code style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>{fi.handle}</code>
        <span style={{ fontSize: 9, color: '#4a5a7a' }}>→</span>
        <input value={fi.jsonKey} onClick={(e) => e.stopPropagation()}
          onChange={(e) => onUpdate(fi.handle, { jsonKey: e.target.value })}
          style={{ background: 'none', border: 'none', outline: 'none', fontSize: 12, fontWeight: 600, color, fontFamily: 'monospace', flex: 1, minWidth: 0 }}
          placeholder="chiave_json" />

        {/* Modalità */}
        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }} onClick={(e) => e.stopPropagation()}>
          {[
            { v: 'array',  l: '[ ]', title: 'Array — tutte le righe' },
            { v: 'object', l: '{ }', title: 'Object — prima riga' },
            { v: 'value',  l: '"x"', title: 'Scalare — un campo' },
          ].map((m) => (
            <button key={m.v} title={m.title}
              onClick={() => onUpdate(fi.handle, { mode: m.v as any })}
              style={{ padding: '1px 5px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: fi.mode === m.v ? `color-mix(in srgb, ${color} 20%, #0f1117)` : '#0f1117', color: fi.mode === m.v ? color : '#4a5a7a', border: fi.mode === m.v ? `1px solid ${color}60` : '1px solid #2a3349', fontFamily: 'monospace' }}>
              {m.l}
            </button>
          ))}
        </div>

        <button onClick={(e) => { e.stopPropagation(); setCollapsed((v) => !v) }}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}>
          <i className={`ti ${collapsed ? 'ti-chevron-down' : 'ti-chevron-up'}`} style={{ fontSize: 10 }} />
        </button>
      </div>

      {!collapsed && (
        <div style={{ background: '#161b27' }} onClick={(e) => e.stopPropagation()}>

          {/* Campi in ingresso con pallini */}
          {incomingFields.length > 0 && (
            <div style={{ padding: '6px 10px', borderBottom: '0.5px solid #2a3349' }}>
              <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1 }}>Campi in ingresso — clicca per mappare</span>
                <button onClick={autoPopulate} title="Auto-popola tutti i campi"
                  style={{ background: 'none', border: `0.5px solid ${color}40`, borderRadius: 3, padding: '1px 6px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                  <i className="ti ti-wand" style={{ fontSize: 9 }} /> tutti
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {incomingFields.map((f) => {
                  const isMapped = fi.fields.some((mf) => mf.sourceField === f.name)
                  return (
                    <button key={f.name} onClick={() => toggleField(f.name)}
                      title={isMapped ? `Rimuovi "${f.name}" dal mapping` : `Aggiungi "${f.name}" al mapping`}
                      style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 7px', borderRadius: 10, cursor: 'pointer', background: isMapped ? `color-mix(in srgb, ${color} 15%, #0f1117)` : '#1a2030', border: isMapped ? `1px solid ${color}60` : '1px solid #2a3349', transition: 'all .12s' }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: isMapped ? color : 'transparent', border: `1.5px solid ${isMapped ? color : '#4a5a7a'}`, flexShrink: 0, transition: 'all .12s' }} />
                      <span style={{ fontSize: 10, fontFamily: 'monospace', color: isMapped ? color : '#9a9aaa' }}>{f.name}</span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {/* Campo scalare */}
          {fi.mode === 'value' && (
            <div style={{ padding: '6px 10px', borderBottom: '0.5px solid #2a3349' }}>
              <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 4 }}>Campo sorgente (scalare)</div>
              {incomingFields.length > 0 ? (
                <CustomSelect value={fi.field ?? ''} onChange={(e) => onUpdate(fi.handle, { field: e.target.value })}
                  style={{ ...inputStyle, fontSize: 10, padding: '3px 6px' }}>
                  <option value="">— seleziona campo —</option>
                  {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                </CustomSelect>
              ) : (
                <input value={fi.field ?? ''} onChange={(e) => onUpdate(fi.handle, { field: e.target.value })}
                  style={{ ...inputStyle, fontSize: 10, padding: '3px 6px' }} placeholder="nome_campo" />
              )}
            </div>
          )}

          {/* Tabella mapping */}
          {fi.mode !== 'value' && (
            <>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderBottom: '0.5px solid #2a3349' }}>
                <span style={{ fontSize: 9, color: '#4a5a7a', flex: 1 }}>
                  {fi.fields.length === 0 ? 'Nessun campo mappato' : `${fi.fields.length} campi mappati`}
                </span>
                <button onClick={addField}
                  style={{ background: 'none', border: `0.5px dashed ${color}60`, borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', color }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = color }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${color}60` }}>
                  <i className="ti ti-plus" style={{ fontSize: 9 }} /> manuale
                </button>
              </div>

              {fi.fields.length > 0 && (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 65px 55px 18px', gap: 4, padding: '3px 8px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
                    {['Chiave JSON', 'Campo sorgente', 'Trasforma', 'Null', ''].map((h, i) => (
                      <div key={i} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{h}</div>
                    ))}
                  </div>
                  <div style={{ overflowY: 'auto', maxHeight: 180 }}>
                    {fi.fields.map((f, fidx) => (
                      <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 65px 55px 18px', gap: 4, alignItems: 'center', padding: '3px 8px', background: fidx % 2 === 0 ? '#1a2030' : 'transparent', borderBottom: '0.5px solid #2a3349' }}>
                        <input value={f.jsonKey} onChange={(e) => updateField(f.id, { jsonKey: e.target.value })}
                          style={{ ...inputStyle, fontSize: 10, padding: '2px 5px', color }} placeholder="chiave" />
                        {incomingFields.length > 0 ? (
                          <CustomSelect value={f.sourceField} onChange={(e) => updateField(f.id, { sourceField: e.target.value })}
                            style={{ ...inputStyle, fontSize: 10, padding: '2px 3px' }}>
                            <option value="">— campo —</option>
                            {incomingFields.map((sf) => <option key={sf.name} value={sf.name}>{sf.name}</option>)}
                          </CustomSelect>
                        ) : (
                          <input value={f.sourceField} onChange={(e) => updateField(f.id, { sourceField: e.target.value })}
                            style={{ ...inputStyle, fontSize: 10, padding: '2px 5px' }} placeholder="campo" />
                        )}
                        <CustomSelect value={f.transform} onChange={(e) => updateField(f.id, { transform: e.target.value })}
                          style={{ ...inputStyle, fontSize: 9, padding: '2px 2px' }}>
                          <option value="">—</option>
                          <option value="to_string">→ str</option>
                          <option value="to_int">→ int</option>
                          <option value="to_float">→ float</option>
                          <option value="to_bool">→ bool</option>
                          <option value="to_date">→ date</option>
                          <option value="uppercase">UPPER</option>
                          <option value="lowercase">lower</option>
                          <option value="trim">trim</option>
                        </CustomSelect>
                        <CustomSelect value={f.nullable} onChange={(e) => updateField(f.id, { nullable: e.target.value as any })}
                          style={{ ...inputStyle, fontSize: 9, padding: '2px 2px' }}>
                          <option value="null">null</option>
                          <option value="omit">omit</option>
                          <option value="empty">""</option>
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
            </>
          )}

          {isSelected && (
            <div style={{ padding: '4px 10px', background: `color-mix(in srgb, ${color} 5%, #161b27)`, fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>
              Flusso selezionato — i campi mappati sono evidenziati nell'albero a destra
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Helper: cerca un jsonKey suggerito nell'albero ───────────────
function findKeyInTree(nodes: JsonTreeNode[], sourceField: string): string | null {
  for (const n of nodes) {
    if (n.key === sourceField) return n.key
    if (n.children.length > 0) {
      const found = findKeyInTree(n.children, sourceField)
      if (found) return found
    }
  }
  return null
}

// ─── Panel principale ─────────────────────────────────────────────
export function JsonSerializerPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const edges      = useFlowStore((s) => s.edges)
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)

  // ── Campi per handle — da config.serializerInputs (come TMap usa tmap.inputs) ──
  const serializerInputs = (node.data.config?.serializerInputs ?? {}) as Record<string, { label: string; fields: Array<{ name: string; type: string }> }>


    // ── Flussi in ingresso ─────────────────────────────────────────
  const incomingEdges = edges.filter((e) => e.target === nodeId)
  
  const getFieldsForHandle = useCallback((handle: string): Array<{ name: string; type: string }> => {
    const edge = incomingEdges.find((e) => (e.targetHandle ?? 'input') === handle)
    if (!edge) return []
    const srcNode = useFlowStore.getState().nodes.find((n) => n.id === edge.source)
    if (!srcNode) return []
    return getHandleSchema(srcNode, edge.sourceHandle ?? 'output', false)
      .map((f) => ({ name: f.name, type: f.type }))
  }, [incomingEdges])



  const flowInputs: JsonFlowInput[] = useMemo(() => {
    try { return JSON.parse(p('flowInputs', '[]')) }
    catch { return [] }
  }, [p('flowInputs')])

  // Sincronizza con edge — aggiunge nuovi, non rimuove (conserva config)
  useEffect(() => {
    const handles  = incomingEdges.map((e) => e.targetHandle ?? 'input')
    const existing = new Map(flowInputs.map((f) => [f.handle, f]))
    let changed    = false
    const synced: JsonFlowInput[] = handles.map((handle, idx) => {
      if (existing.has(handle)) return existing.get(handle)!
      changed = true
      return { handle, jsonKey: handle === 'input' ? 'data' : `flusso_${idx + 1}`, mode: 'array', fields: [] }
    })
    if (changed) updateProp(nodeId, 'flowInputs', JSON.stringify(synced))
  }, [incomingEdges.map((e) => e.targetHandle).join(',')])

  const saveFlowInputs = (inputs: JsonFlowInput[]) =>
    updateProp(nodeId, 'flowInputs', JSON.stringify(inputs))

  const updateFlowInput = useCallback((handle: string, patch: Partial<JsonFlowInput>) => {
    const current: JsonFlowInput[] = (() => { try { return JSON.parse(useFlowStore.getState().nodes.find((n) => n.id === nodeId)?.data.props?.['flowInputs'] ?? '[]') } catch { return [] } })()
    saveFlowInputs(current.map((f) => f.handle === handle ? { ...f, ...patch } : f))
  }, [nodeId])

  // ── Albero struttura JSON ──────────────────────────────────────
  const rawSchema  = p('_sampleJson', '')
  const [treeRaw,  setTreeRaw]  = useState(rawSchema)
  const [parseErr, setParseErr] = useState('')

  const jsonTree: JsonTreeNode[] = useMemo(() => {
    try { return parseTree(p('_sampleJson', '')) }
    catch { return [] }
  }, [p('_sampleJson')])

  const [localTree, setLocalTree] = useState<JsonTreeNode[]>(jsonTree)

  useEffect(() => { setLocalTree(jsonTree) }, [p('_sampleJson')])

  const handleAnalyze = () => {
    try {
      const tree = parseTree(treeRaw)
      setLocalTree(tree)
      updateProp(nodeId, '_sampleJson', treeRaw)
      setParseErr('')
    } catch (e: any) { setParseErr(e.message ?? 'JSON non valido') }
  }

  const toggleTreeNode = useCallback((id: string) => {
    function toggle(ns: JsonTreeNode[]): JsonTreeNode[] {
      return ns.map((n) => n.id === id ? { ...n, collapsed: !n.collapsed } : { ...n, children: toggle(n.children) })
    }
    setLocalTree((prev) => toggle(prev))
  }, [])

  // ── Campi fissi ────────────────────────────────────────────────
  const fixedFields: JsonFixedField[] = useMemo(() => {
    try { return JSON.parse(p('fixedFields', '[]')) } catch { return [] }
  }, [p('fixedFields')])

  const saveFixed   = (fields: JsonFixedField[]) => updateProp(nodeId, 'fixedFields', JSON.stringify(fields))
  const addFixed    = () => saveFixed([...fixedFields, { id: `ff_${Date.now()}`, key: '', value: '', type: 'string' }])
  const updateFixed = (id: string, patch: Partial<JsonFixedField>) => saveFixed(fixedFields.map((f) => f.id === id ? { ...f, ...patch } : f))
  const deleteFixed = (id: string) => saveFixed(fixedFields.filter((f) => f.id !== id))

  // ── Flusso selezionato (per evidenziare albero) ────────────────
  const [selectedFlowHandle, setSelectedFlowHandle] = useState<string | null>(null)

  const handleSelectFlow = useCallback((handle: string | null) => {
    setSelectedFlowHandle((prev) => prev === handle ? null : handle)
  }, [])

  // ── Opzioni ────────────────────────────────────────────────────
  const [showOptions, setShowOptions] = useState(false)

  const hasTree = localTree.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0, height: '100%', minHeight: 400 }}>

      {/* ── Info banner ── */}
      <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderBottom: `0.5px solid ${ACCENT}20`, fontSize: 10, color: '#9a9aaa', display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>{'{ }'}</span>
        <span>Ogni flusso in ingresso diventa una chiave del documento JSON.</span>
        <span style={{ marginLeft: 'auto', fontFamily: 'monospace', color: ACCENT }}>→ {p('outputField', 'content')}</span>
        <button onClick={() => setShowOptions((v) => !v)}
          style={{ background: 'none', border: `0.5px solid ${showOptions ? ACCENT : '#2a3349'}`, borderRadius: 3, padding: '2px 8px', cursor: 'pointer', color: showOptions ? ACCENT : '#4a5a7a', fontSize: 9 }}>
          <i className="ti ti-settings-2" style={{ fontSize: 9, marginRight: 3 }} />opzioni
        </button>
      </div>

      {/* ── Opzioni documento (collassabile) ── */}
      {showOptions && (
        <div style={{ padding: '8px 10px', borderBottom: '0.5px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr 1fr 1fr', gap: 8 }}>
            {[
              { label: 'Campo output', key: 'outputField', def: 'content', type: 'input' },
              { label: 'Envelope', key: 'envelope', def: '', type: 'input' },
            ].map((opt) => (
              <div key={opt.key} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={labelStyle}>{opt.label}</div>
                <input style={{ ...inputStyle, fontSize: 10, padding: '3px 6px', color: ACCENT }}
                  value={p(opt.key, opt.def)} onChange={(e) => updateProp(nodeId, opt.key, e.target.value)}
                  placeholder={opt.def} />
              </div>
            ))}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={labelStyle}>Formato</div>
              <CustomSelect style={{ ...inputStyle, fontSize: 10, padding: '3px 4px' }} value={p('pretty', 'false')} onChange={(e) => updateProp(nodeId, 'pretty', e.target.value)}>
                <option value="false">Compatto</option>
                <option value="true">Pretty print</option>
              </CustomSelect>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={labelStyle}>Valori null</div>
              <CustomSelect style={{ ...inputStyle, fontSize: 10, padding: '3px 4px' }} value={p('nullDefault', 'null')} onChange={(e) => updateProp(nodeId, 'nullDefault', e.target.value)}>
                <option value="null">null</option>
                <option value="omit">Ometti chiave</option>
                <option value="empty">""</option>
              </CustomSelect>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={labelStyle}>Su errore</div>
              <CustomSelect style={{ ...inputStyle, fontSize: 10, padding: '3px 4px' }} value={p('onError', 'reject')} onChange={(e) => updateProp(nodeId, 'onError', e.target.value)}>
                <option value="reject">Reject</option>
                <option value="skip">Salta</option>
                <option value="stop">Interrompi</option>
              </CustomSelect>
            </div>
          </div>
        </div>
      )}

      {/* ── Layout principale ── */}
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: hasTree ? '1fr 220px' : '1fr', overflow: 'hidden' }}>

        {/* SINISTRA — flussi in ingresso */}
        <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: hasTree ? '1px solid #2a3349' : 'none' }}>
          <div style={{ padding: '6px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 6, flexShrink: 0 }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.06em', flex: 1 }}>
              Flussi in ingresso — {flowInputs.length}
            </span>
            <span style={{ fontSize: 9, color: '#4a5a7a' }}>
              usa l'handle grigio tratteggiato sul nodo per aggiungere flussi
            </span>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '8px 10px' }}>
            {flowInputs.length === 0 ? (
              <div style={{ padding: '30px', textAlign: 'center', color: '#2a3349', fontSize: 11 }}>
                <i className="ti ti-plug-connected-x" style={{ fontSize: 28, display: 'block', marginBottom: 8, color: `${ACCENT}20` }} />
                Collega un flusso al nodo sul canvas
              </div>
            ) : (
              flowInputs.map((fi, idx) => (
                <FlowCard key={fi.handle} fi={fi} idx={idx}
                  incomingFields={getFieldsForHandle(fi.handle)}
                  treeNodes={localTree}
                  selectedFlowHandle={selectedFlowHandle}
                  onSelect={handleSelectFlow}
                  onUpdate={updateFlowInput} />
              ))
            )}

            {/* Campi fissi */}
            {(flowInputs.length > 0 || fixedFields.length > 0) && (
              <div style={{ marginTop: 8 }}>
                <SectionTitle label="Campi fissi (costanti)" color="#ffb347"
                  action={
                    <button onClick={addFixed}
                      style={{ padding: '2px 8px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: 'color-mix(in srgb, #ffb347 12%, #0f1117)', color: '#ffb347', border: '0.5px solid #ffb34740' }}>
                      <i className="ti ti-plus" style={{ fontSize: 9 }} /> aggiungi
                    </button>
                  } />
                {fixedFields.length === 0 && (
                  <div style={{ fontSize: 9, color: '#2a3349', fontStyle: 'italic', padding: '4px 0' }}>Nessun campo fisso</div>
                )}
                {fixedFields.map((f) => (
                  <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 50px 18px', gap: 4, marginBottom: 4, alignItems: 'center' }}>
                    <input value={f.key} onChange={(e) => updateFixed(f.id, { key: e.target.value })}
                      style={{ ...inputStyle, fontSize: 10, padding: '3px 6px', color: '#ffb347' }} placeholder="chiave" />
                    <input value={f.value} onChange={(e) => updateFixed(f.id, { value: e.target.value })}
                      style={{ ...inputStyle, fontSize: 10, padding: '3px 6px' }} placeholder="valore" />
                    <CustomSelect value={f.type} onChange={(e) => updateFixed(f.id, { type: e.target.value as any })}
                      style={{ ...inputStyle, fontSize: 9, padding: '2px 2px' }}>
                      <option value="string">str</option>
                      <option value="number">num</option>
                      <option value="boolean">bool</option>
                      <option value="null">null</option>
                    </CustomSelect>
                    <button onClick={() => deleteFixed(f.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0 }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                      <i className="ti ti-x" style={{ fontSize: 10 }} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* DESTRA — albero struttura JSON target */}
        {hasTree && (
          <div style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden', background: '#0f1117' }}>
            <div style={{ padding: '6px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349', flexShrink: 0 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#ffb347', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Struttura JSON target
              </span>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              {localTree.map((n) => (
                <TreeRow key={n.id} node={n} depth={0}
                  flowInputs={selectedFlowHandle ? flowInputs.filter((f) => f.handle === selectedFlowHandle) : []}
                  selectedFlowHandle={selectedFlowHandle}
                  onToggle={toggleTreeNode} />
              ))}
            </div>
          </div>
        )}
      </div>

      {/* ── Area import schema JSON ── */}
      <div style={{ borderTop: '1px solid #2a3349', padding: '8px 10px', background: '#1a2030', flexShrink: 0 }}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
          <textarea style={{ ...inputStyle, resize: 'none', height: 48, fontSize: 10, fontFamily: 'monospace', flex: 1 }}
            value={treeRaw} onChange={(e) => setTreeRaw(e.target.value)}
            placeholder={'Incolla JSON di esempio per visualizzare la struttura target: {"id":1,"nome":"...","ordini":[]}'} spellCheck={false} />
          <button onClick={handleAnalyze} disabled={!treeRaw}
            style={{ padding: '6px 12px', fontSize: 10, borderRadius: 4, cursor: treeRaw ? 'pointer' : 'not-allowed', background: treeRaw ? `color-mix(in srgb, ${ACCENT} 20%, #161b27)` : '#1e2535', color: treeRaw ? ACCENT : '#4a5a7a', border: `1px solid ${treeRaw ? ACCENT + '60' : '#2a3349'}`, fontWeight: 600, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 5, height: 48 }}>
            <i className="ti ti-player-play" style={{ fontSize: 10 }} />
            Analizza
          </button>
        </div>
        {parseErr && <div style={{ fontSize: 9, color: '#ff5f57', marginTop: 4 }}>{parseErr}</div>}
        {!parseErr && hasTree && (
          <div style={{ fontSize: 9, color: '#3ddc84', marginTop: 4 }}>
            ✓ Struttura caricata — seleziona un flusso per vedere i campi mappati evidenziati
          </div>
        )}
      </div>

    </div>
  )
}