import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFlowStore } from '../../../store/flowStore'
import { TabGeneral }  from '../../../components/tabs/TabGeneral'
import { TabAdvanced } from '../../../components/tabs/TabAdvanced'
import { useIncomingSchema } from '../../useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'

import type {
  JsonParserConfig, JsonParserFlow, JsonParserField,
  JsonParserFieldTransform, JsonParserFieldMissing,
} from './jsonParserTypes'

import { FIELD_TYPES } from '../../../types/fieldTypes'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
const ACCENT = '#22d3ee'

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

const FLOW_COLORS = ['#4a9eff','#3ddc84','#ffb347','#a78bfa','#22d3ee','#f472b6','#84cc16','#fb923c','#e879f9','#ff5f57']

const TRANSFORMS: Array<{ value: JsonParserFieldTransform; label: string }> = [
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
const ON_MISSING: Array<{ value: JsonParserFieldMissing; label: string }> = [
  { value: 'null',    label: 'null'        },
  { value: 'default', label: 'Usa default' },
  { value: 'skip',    label: 'Salta riga'  },
  { value: 'error',   label: 'Reject'      },
]

// ─── Albero JSON ──────────────────────────────────────────────────
interface JsonTreeNode {
  id: string; name: string; path: string; valueType: string
  isArray: boolean; children: JsonTreeNode[]; collapsed: boolean
}

let _counter = 0
function buildTree(val: unknown, name: string, path: string, depth = 0): JsonTreeNode {
  const id = `jn_${++_counter}_${Date.now()}`
  if (Array.isArray(val)) {
    const sample   = val[0]
    const children = (sample && typeof sample === 'object' && !Array.isArray(sample))
      ? Object.entries(sample as Record<string,unknown>).map(([k,v]) => buildTree(v,k,`${path}[*].${k}`,depth+1))
      : []
    return { id, name, path, valueType: 'array', isArray: true, children, collapsed: depth > 1 }
  }
  if (val && typeof val === 'object') {
    const children = Object.entries(val as Record<string,unknown>).map(([k,v]) => buildTree(v,k,`${path}.${k}`,depth+1))
    return { id, name, path, valueType: 'object', isArray: false, children, collapsed: depth > 1 }
  }
  let valueType = 'string'
  if (val === null)                  valueType = 'string'
  else if (typeof val === 'boolean') valueType = 'boolean'
  else if (typeof val === 'number')  valueType = Number.isInteger(val) ? 'integer' : 'decimal'
  return { id, name, path, valueType, isArray: false, children: [], collapsed: false }
}

function buildTreeFromJson(s: string): JsonTreeNode[] {
  try {
    const p = JSON.parse(s)
    if (Array.isArray(p) || (typeof p === 'object' && p !== null)) return [buildTree(p, 'root', '$')]
    return []
  } catch { return [] }
}

function flattenJsonTree(nodes: JsonTreeNode[]): JsonTreeNode[] {
  const r: JsonTreeNode[] = []
  function walk(n: JsonTreeNode) { r.push(n); n.children.forEach(walk) }
  nodes.forEach(walk)
  return r
}

// ─── makeFields — funzione helper esterna ─────────────────────────
function makeFields(obj: unknown, basePath: string, parentIsArray = false): JsonParserField[] {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
  const prefix = parentIsArray ? `${basePath}[*]` : basePath
  return Object.entries(obj as Record<string,unknown>).map(([key,val],i) => {
    let type = 'string'
    if (val === null)                  type = 'string'
    else if (typeof val === 'boolean') type = 'boolean'
    else if (typeof val === 'number')  type = Number.isInteger(val) ? 'integer' : 'decimal'
    else if (typeof val === 'string')  type = 'string'
    else if (typeof val === 'object')  type = 'object'
    return {
      id: `f_${i}_${Date.now()}`,
      name: key,
      jsonPath: `${prefix}.${key}`,
      type,
      transform: 'none' as JsonParserFieldTransform,
      onMissing: 'null' as JsonParserFieldMissing,
    }
  })
}



function generateFlowsFromJson(jsonString: string): { flows: JsonParserFlow[]; tree: JsonTreeNode[] } {
  const tree  = buildTreeFromJson(jsonString)
  const flows: JsonParserFlow[] = []
  try {
    const parsed = JSON.parse(jsonString)

    if (Array.isArray(parsed)) {
      // Array di oggetti — un flusso root con tutti i campi
      flows.push({
        id: `flow_${Date.now()}_0`,
        label: 'root',
        color: FLOW_COLORS[0],
        jsonPath: '$',
        isArray: true,
        streaming: false,
        mergeParent: false,
        parentFields: [],
        fields: makeFields(parsed[0], '$', true),
      })
    } else if (typeof parsed === 'object' && parsed !== null) {

      // Campi flat della radice — scalari e null
      const rootEntries = Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => !Array.isArray(v) && !(typeof v === 'object' && v !== null))

      // Strutture annidate — array e oggetti
      const nested = Object.entries(parsed as Record<string, unknown>)
        .filter(([, v]) => Array.isArray(v) || (typeof v === 'object' && v !== null))

      // Flusso root solo se ci sono campi flat
      if (rootEntries.length > 0) {
        flows.push({
          id: `flow_${Date.now()}_root`,
          label: 'root',
          color: FLOW_COLORS[0],
          jsonPath: '$',
          isArray: false,
          streaming: false,
          mergeParent: false,
          parentFields: [],
          fields: rootEntries.map(([key, val], i) => {
            let type = 'string'
            if (typeof val === 'boolean') type = 'boolean'
            else if (typeof val === 'number') type = Number.isInteger(val) ? 'integer' : 'decimal'
            return {
              id: `f_root_${i}_${Date.now()}`,
              name: key,
              jsonPath: `$.${key}`,
              type,
              transform: 'none' as JsonParserFieldTransform,
              onMissing: 'null' as JsonParserFieldMissing,
            }
          }),
        })
      }

      // Flussi per strutture annidate
      nested.forEach(([key, val], idx) => {
        const isArr    = Array.isArray(val)
        const sample   = isArr ? (val as unknown[])[0] : val
        const colorIdx = (rootEntries.length > 0 ? 1 : 0) + idx
        flows.push({
          id: `flow_${Date.now()}_${idx}`,
          label: key,
          color: FLOW_COLORS[colorIdx % FLOW_COLORS.length],
          jsonPath: `$.${key}`,
          isArray: isArr,
          streaming: false,
          mergeParent: false,
          parentFields: [],
          fields: makeFields(sample, `$.${key}`, isArr),
        })
      })
    }
  } catch {}
  return { flows, tree }
}

// ─── JsonTreeNodeRow ──────────────────────────────────────────────
function JsonTreeNodeRow({ node, depth, selectedFlowId, flows, onToggleFieldInFlow, onGenerateFlow, onToggle }: {
  node: JsonTreeNode; depth: number; selectedFlowId: string|null; flows: JsonParserFlow[]
  onToggleFieldInFlow: (node: JsonTreeNode, flowId: string) => void
  onGenerateFlow: (node: JsonTreeNode) => void; onToggle: (id: string) => void
}) {
  const isLeaf = node.children.length === 0
  const color  = node.isArray ? '#ffb347' : node.valueType === 'object' ? '#c8d4f0' : '#3ddc84'
  const indent = depth * 14
  const flowMembership = flows.map((flow) => ({ flow, isMember: flow.fields.some((f) => f.jsonPath === node.path) }))

  return (
    <>
      <div style={{ display:'flex', alignItems:'center', gap:4, padding:'3px 6px', paddingLeft:6+indent, cursor:'pointer', borderBottom:'0.5px solid #1a2030', background:'transparent' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background='#1a2535' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background='transparent' }}>
        {node.children.length > 0 ? (
          <button onClick={(e) => { e.stopPropagation(); onToggle(node.id) }}
            style={{ background:'none', border:'none', cursor:'pointer', color:'#4a5a7a', padding:0, width:12, flexShrink:0 }}>
            <i className={`ti ${node.collapsed?'ti-chevron-right':'ti-chevron-down'}`} style={{ fontSize:9 }} />
          </button>
        ) : <div style={{ width:12, flexShrink:0 }} />}
        <span style={{ fontSize:9, color, fontFamily:'monospace', flexShrink:0, minWidth:14 }}>
          {node.isArray ? '[]' : node.valueType === 'object' ? '{}' : '—'}
        </span>
        <span style={{ fontSize:10, color, fontFamily:'monospace', flex:1, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{node.name}</span>
        {isLeaf && <span style={{ fontSize:8, color:'#4a5a7a', flexShrink:0, marginRight:4 }}>{node.valueType}</span>}
        {flows.length > 0 && (
          <div style={{ display:'flex', gap:3, flexShrink:0, alignItems:'center', marginLeft:'auto' }}>
            {flowMembership.map(({ flow, isMember }) => (
              <button key={flow.id} onClick={(e) => { e.stopPropagation(); onToggleFieldInFlow(node, flow.id) }}
                title={isMember ? `Rimuovi da "${flow.label}"` : `Aggiungi a "${flow.label}"`}
                style={{ width:10, height:10, borderRadius:'50%', background:isMember?flow.color:'transparent', border:`1.5px solid ${flow.color}`, cursor:'pointer', padding:0, flexShrink:0, transition:'background .12s, transform .1s', transform:isMember?'scale(1.1)':'scale(1)' }}
                onMouseEnter={(e) => { const el=e.currentTarget as HTMLElement; el.style.transform='scale(1.25)'; el.style.background=isMember?`color-mix(in srgb, ${flow.color} 60%, transparent)`:`color-mix(in srgb, ${flow.color} 40%, transparent)` }}
                onMouseLeave={(e) => { const el=e.currentTarget as HTMLElement; el.style.transform=isMember?'scale(1.1)':'scale(1)'; el.style.background=isMember?flow.color:'transparent' }}
              />
            ))}
            {(node.isArray || node.valueType === 'object') && (
              <button onClick={(e) => { e.stopPropagation(); onGenerateFlow(node) }}
                style={{ background:'#0d3d20', border:'1px solid #1d6d40', borderRadius:3, padding:'1px 6px', cursor:'pointer', color:'#3ddc84', fontSize:8, flexShrink:0, marginLeft:4, display:'flex', alignItems:'center', gap:2 }}>
                <i className="ti ti-plus" style={{ fontSize:8 }} /> flusso
              </button>
            )}
          </div>
        )}
      </div>
      {!node.collapsed && node.children.map((child) => (
        <JsonTreeNodeRow key={child.id} node={child} depth={depth+1} selectedFlowId={selectedFlowId}
          flows={flows} onToggleFieldInFlow={onToggleFieldInFlow} onGenerateFlow={onGenerateFlow} onToggle={onToggle} />
      ))}
    </>
  )
}

// ─── FlowFieldsTable ──────────────────────────────────────────────
function FlowFieldsTable({ flow, color, selectedFlowId, onSelect, onUpdate, onDelete }: {
  flow: JsonParserFlow; color: string; selectedFlowId: string|null
  onSelect: (id: string|null) => void; onUpdate: (patch: Partial<JsonParserFlow>) => void; onDelete: () => void
}) {
  const [maximized, setMaximized] = useState(false)
  const [collapsed, setCollapsed] = useState(false)
  const isSelected = selectedFlowId === flow.id

  const addField = () => {
    const n = flow.fields.length + 1
    onUpdate({ fields: [...flow.fields, { id:`f_${Date.now()}`, name:`campo_${n}`, jsonPath:`$.campo_${n}`, type:'string', transform:'none', onMissing:'null' }]})
  }
  const updateField = (id: string, key: string, value: any) =>
    onUpdate({ fields: flow.fields.map((f) => f.id===id ? {...f,[key]:value} : f) })
  const deleteField = (id: string) =>
    onUpdate({ fields: flow.fields.filter((f) => f.id!==id) })

  return (
    <div onClick={() => onSelect(isSelected ? null : flow.id)}
      style={{ border:`1px solid ${isSelected?color:color+'40'}`, borderRadius:8, overflow:'hidden', marginBottom:8, flexShrink:0, cursor:'pointer', transition:'border-color .15s' }}>
      <div style={{ padding:'6px 10px', background:isSelected?`color-mix(in srgb, ${color} 15%, #1a2030)`:`color-mix(in srgb, ${color} 8%, #1a2030)`, borderBottom:collapsed?'none':`0.5px solid ${color}30`, display:'flex', alignItems:'center', gap:8 }}>
        <div style={{ width:8, height:8, borderRadius:'50%', background:isSelected?color:`${color}50`, border:`1.5px solid ${color}`, flexShrink:0 }} />
        <input value={flow.label} onClick={(e)=>e.stopPropagation()} onChange={(e)=>onUpdate({label:e.target.value})}
          style={{ background:'none', border:'none', outline:'none', fontSize:11, fontWeight:600, color, fontFamily:'monospace', flex:1, minWidth:0 }} />
        <code style={{ fontSize:8, color:'#4a5a7a', maxWidth:120, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}>{flow.jsonPath}</code>
        {flow.isArray   && <span style={{ fontSize:9, color:'#4a5a7a' }}>[ ]</span>}
        {flow.streaming && <i className="ti ti-wave-sine" style={{ fontSize:9, color:'#ffb347' }} />}
        <button onClick={(e)=>{e.stopPropagation();setMaximized(v=>!v)}} style={{ background:'none', border:`0.5px solid ${color}40`, borderRadius:3, padding:'1px 4px', cursor:'pointer', color:'#4a5a7a' }}
          onMouseEnter={(e)=>{(e.currentTarget as HTMLElement).style.color=color}}
          onMouseLeave={(e)=>{(e.currentTarget as HTMLElement).style.color='#4a5a7a'}}>
          <i className={`ti ${maximized?'ti-arrows-minimize':'ti-arrows-maximize'}`} style={{ fontSize:9 }} />
        </button>
        <button onClick={(e)=>{e.stopPropagation();setCollapsed(v=>!v)}} style={{ background:'none', border:'none', cursor:'pointer', color:'#4a5a7a', padding:'0 2px' }}>
          <i className={`ti ${collapsed?'ti-chevron-down':'ti-chevron-up'}`} style={{ fontSize:10 }} />
        </button>
        <button onClick={(e)=>{e.stopPropagation();onDelete()}} style={{ background:'none', border:'none', cursor:'pointer', color:'#4a5a7a', padding:'0 2px' }}
          onMouseEnter={(e)=>{(e.currentTarget as HTMLElement).style.color='#ff5f57'}}
          onMouseLeave={(e)=>{(e.currentTarget as HTMLElement).style.color='#4a5a7a'}}>
          <i className="ti ti-x" style={{ fontSize:10 }} />
        </button>
      </div>
      {!collapsed && (
        <div style={{ background:'#161b27' }} onClick={(e)=>e.stopPropagation()}>
          <div style={{ display:'flex', gap:4, padding:'5px 10px', borderBottom:`0.5px solid ${color}20`, flexWrap:'wrap', alignItems:'center' }}>
            <input value={flow.jsonPath} onChange={(e)=>onUpdate({jsonPath:e.target.value})}
              style={{ ...inputStyle, fontSize:9, padding:'2px 6px', width:140 }} placeholder="$.percorso" />
            {[{key:'isArray',label:'[ ] Array',title:'Array → righe'},{key:'streaming',label:'〜 Stream',title:'Streaming'}].map((opt) => (
              <button key={opt.key} title={opt.title} onClick={()=>onUpdate({[opt.key]:!(flow as any)[opt.key]})}
                style={{ padding:'2px 8px', fontSize:9, borderRadius:3, cursor:'pointer', background:(flow as any)[opt.key]?`color-mix(in srgb, ${color} 20%, #161b27)`:'#1e2535', color:(flow as any)[opt.key]?color:'#4a5a7a', border:(flow as any)[opt.key]?`1px solid ${color}60`:'1px solid #2a3349' }}>
                {opt.label}
              </button>
            ))}
            <button onClick={addField} style={{ marginLeft:'auto', background:'none', border:`0.5px dashed ${color}60`, borderRadius:4, padding:'2px 8px', fontSize:9, cursor:'pointer', color }}
              onMouseEnter={(e)=>{(e.currentTarget as HTMLElement).style.borderColor=color}}
              onMouseLeave={(e)=>{(e.currentTarget as HTMLElement).style.borderColor=`${color}60`}}>
              <i className="ti ti-plus" style={{ fontSize:9 }} /> campo
            </button>
          </div>
          {flow.fields.length === 0 ? (
            <div style={{ padding:'12px', textAlign:'center', fontSize:10, color:'#2a3349', fontStyle:'italic' }}>
              Seleziona il flusso e clicca "+ campo" nell'albero, oppure aggiungi manualmente
            </div>
          ) : (
            <>
              <div style={{ display:'grid', gridTemplateColumns:'minmax(60px, 0.8fr) minmax(110px, 1.2fr) 70px 80px 80px 24px', gap:4, padding:'3px 8px', background:'#1a2030', borderBottom:'0.5px solid #2a3349', flexShrink:0 }}>
                {['Nome','JSONPath','Tipo','Trasforma','Mancante',''].map((h,i) => (
                  <div key={i} style={{ fontSize:8, color:'#4a5a7a', textTransform:'uppercase', letterSpacing:'.05em', fontWeight:600 }}>{h}</div>
                ))}
              </div>
              <div style={{ overflowY:'auto', maxHeight:maximized?'none':200 }}>
                {flow.fields.map((f,idx) => (
                  <div key={f.id} style={{ display:'grid', gridTemplateColumns:'minmax(60px, 0.8fr) minmax(110px, 1.2fr) 70px 80px 80px 24px', gap:4, alignItems:'center', padding:'3px 8px', background:idx%2===0?'#1a2030':'transparent', borderBottom:idx<flow.fields.length-1?'0.5px solid #2a3349':'none' }}>
                    <input value={f.name} onChange={(e)=>updateField(f.id,'name',e.target.value)} style={{ ...inputStyle, fontSize:10, padding:'2px 5px' }} />
                    <input value={f.jsonPath} onChange={(e)=>updateField(f.id,'jsonPath',e.target.value)} style={{ ...inputStyle, fontSize:9, padding:'2px 5px', color:'#9a9aaa' }} placeholder="$.campo" />
                    <CustomSelect value={f.type} onChange={(e)=>updateField(f.id,'type',e.target.value)} style={{ ...inputStyle, fontSize:9, padding:'2px 3px' }}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </CustomSelect>
                    <CustomSelect value={f.transform} onChange={(e)=>updateField(f.id,'transform',e.target.value as JsonParserFieldTransform)} style={{ ...inputStyle, fontSize:9, padding:'2px 3px' }}>
                      {TRANSFORMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </CustomSelect>
                    <CustomSelect value={f.onMissing} onChange={(e)=>updateField(f.id,'onMissing',e.target.value as JsonParserFieldMissing)} style={{ ...inputStyle, fontSize:9, padding:'2px 3px' }}>
                      {ON_MISSING.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                    </CustomSelect>
                    <button onClick={()=>deleteField(f.id)} style={{ background:'none', border:'none', cursor:'pointer', color:'#4a5a7a', padding:0, display:'flex', alignItems:'center', justifyContent:'center' }}
                      onMouseEnter={(e)=>{(e.currentTarget as HTMLElement).style.color='#ff5f57'}}
                      onMouseLeave={(e)=>{(e.currentTarget as HTMLElement).style.color='#4a5a7a'}}>
                      <i className="ti ti-x" style={{ fontSize:10 }} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
          {isSelected && (
            <div style={{ padding:'4px 10px', background:`color-mix(in srgb, ${color} 5%, #161b27)`, fontSize:9, color:'#4a5a7a', fontStyle:'italic' }}>
              Flusso selezionato — clicca "+ campo" nell'albero per aggiungere campi
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── useResizable / useDraggable ──────────────────────────────────
function useResizable(initialWidth: number) {
  const [width, setWidth] = useState(initialWidth)
  const resizing = useRef(false); const startX = useRef(0); const startW = useRef(0)
  const modalRef = useRef<HTMLDivElement>(null)
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizing.current=true; startX.current=e.clientX; startW.current=modalRef.current?.getBoundingClientRect().width??initialWidth
    const onMove=(ev: MouseEvent)=>{ if(!resizing.current)return; setWidth(Math.round(Math.max(700,Math.min(window.innerWidth-48,startW.current+ev.clientX-startX.current)))) }
    const onUp=()=>{ resizing.current=false; window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp) }
    window.addEventListener('mousemove',onMove); window.addEventListener('mouseup',onUp)
  }, [initialWidth])
  return { modalRef, width, onResizeStart }
}

function useDraggable() {
  const [pos, setPos] = useState<{ x: number; y: number }|null>(null)
  const dragging=useRef(false); const offset=useRef({x:0,y:0}); const ref=useRef<HTMLDivElement>(null)
  const onMouseDown=useCallback((e: React.MouseEvent)=>{
    if((e.target as HTMLElement).closest('button,input,select,textarea'))return
    dragging.current=true; const rect=ref.current?.getBoundingClientRect(); if(!rect)return
    offset.current={x:e.clientX-rect.left,y:e.clientY-rect.top}; e.preventDefault()
  },[])
  const reset=useCallback(()=>setPos(null),[])
  useEffect(()=>{
    const onMove=(e: MouseEvent)=>{ if(!dragging.current)return; setPos({x:e.clientX-offset.current.x,y:e.clientY-offset.current.y}) }
    const onUp=()=>{ dragging.current=false }
    window.addEventListener('mousemove',onMove); window.addEventListener('mouseup',onUp)
    return()=>{ window.removeEventListener('mousemove',onMove); window.removeEventListener('mouseup',onUp) }
  },[])
  return { ref, pos, onMouseDown, reset }
}

type Tab = 'config' | 'general' | 'advanced'

// ─── JsonParserModal ──────────────────────────────────────────────
export function JsonParserModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))

  const [activeTab,      setActiveTab]      = useState<Tab>('config')
  const [isMaximized,    setIsMaximized]    = useState(false)
  const [rawJson,        setRawJson]        = useState(() => {
    try { return (node?.data.config?.jsonParser as JsonParserConfig|undefined)?._sampleJson??'' } catch { return '' }
  })
  const [parseError,     setParseError]     = useState('')
  const [selectedFlowId, setSelectedFlowId] = useState<string|null>(null)
  const [jsonTree,       setJsonTree]       = useState<JsonTreeNode[]>([])

  const { ref: dragRef, pos, onMouseDown, reset: resetDrag } = useDraggable()
  const { modalRef, width, onResizeStart } = useResizable(1100)

  if (!node) return null

  const config: JsonParserConfig = useMemo(() => {
    try { const r=node.data.config?.jsonParser; if(r) return r as JsonParserConfig } catch {}
    return { sourceField:'body', hasReject:false, flows:[] }
  }, [node.data.config?.jsonParser])

  useEffect(() => {
    if (config._sampleJson) {
      try { const { tree }=generateFlowsFromJson(config._sampleJson); setJsonTree(tree) } catch {}
    }
  }, [])

  const incomingFields = useIncomingSchema(nodeId)

  const saveConfig = useCallback((newConfig: JsonParserConfig) => {
    useFlowStore.getState().updateNodeConfig(nodeId, { jsonParser: newConfig } as any)
  }, [nodeId])

  const updateConfig = useCallback((patch: Partial<JsonParserConfig>) =>
    saveConfig({ ...config, ...patch }), [config, saveConfig])

  const pruneOrphanEdges = useCallback((validFlowIds: string[]) => {
    const keep = new Set<string>([...validFlowIds, 'reject', 'output', 'catch'])
    useFlowStore.setState((s) => ({
      edges: s.edges.filter((e) =>
        e.source !== nodeId || keep.has(e.sourceHandle ?? 'output')
      ),
    }))
  }, [nodeId])

  const handleAnalyze = useCallback(() => {
    if (!rawJson) return
    try {
      const { flows, tree } = generateFlowsFromJson(rawJson)
      saveConfig({ ...config, flows, _sampleJson: rawJson })
      pruneOrphanEdges(flows.map((f) => f.id))
      setJsonTree(tree); setParseError('')
      if (flows.length > 0) setSelectedFlowId(flows[0].id)
    } catch (e: any) { setParseError(e.message ?? 'JSON non valido') }
  }, [rawJson, config, saveConfig, pruneOrphanEdges])

  const toggleTreeNode = useCallback((id: string) => {
    function toggle(ns: JsonTreeNode[]): JsonTreeNode[] {
      return ns.map((n) => n.id===id ? {...n,collapsed:!n.collapsed} : {...n,children:toggle(n.children)})
    }
    setJsonTree((prev) => toggle(prev))
  }, [])

  const generateFlowFromTree = useCallback((treeNode: JsonTreeNode) => {
    const idx=config.flows.length; const color=FLOW_COLORS[idx%FLOW_COLORS.length]
    const fields: JsonParserField[] = treeNode.children.filter((c)=>c.children.length===0).map((c,i)=>({
      id:`f_${i}_${Date.now()}`, name:c.name, jsonPath:c.path, type:c.valueType,
      transform:'none' as JsonParserFieldTransform, onMissing:'null' as JsonParserFieldMissing,
    }))
    const newFlow: JsonParserFlow = { id:`flow_${Date.now()}`, label:treeNode.name, color, jsonPath:treeNode.path, isArray:treeNode.isArray, streaming:false, mergeParent:false, parentFields:[], fields }
    saveConfig({ ...config, flows:[...config.flows,newFlow] }); setSelectedFlowId(newFlow.id)
  }, [config, saveConfig])

  const addFlow = useCallback(() => {
    const idx=config.flows.length; const color=FLOW_COLORS[idx%FLOW_COLORS.length]
    const newFlow: JsonParserFlow = { id:`flow_${Date.now()}`, label:`flusso_${idx+1}`, color, jsonPath:'$', isArray:false, streaming:false, mergeParent:false, parentFields:[], fields:[] }
    saveConfig({ ...config, flows:[...config.flows,newFlow] }); setSelectedFlowId(newFlow.id)
  }, [config, saveConfig])

  const updateFlow = useCallback((id: string, patch: Partial<JsonParserFlow>) =>
    saveConfig({ ...config, flows:config.flows.map((f)=>f.id===id?{...f,...patch}:f) }), [config, saveConfig])

  const deleteFlow = useCallback((id: string) => {
    saveConfig({ ...config, flows:config.flows.filter((f)=>f.id!==id) })
    if (selectedFlowId===id) setSelectedFlowId(null)
  }, [config, saveConfig, selectedFlowId])

  const onToggleFieldInFlow = useCallback((treeNode: JsonTreeNode, flowId: string) => {
    const flow=config.flows.find((f)=>f.id===flowId); if(!flow) return
    const existingIdx=flow.fields.findIndex((f)=>f.jsonPath===treeNode.path)
    if (existingIdx >= 0) {
      saveConfig({ ...config, flows:config.flows.map((f)=>f.id===flowId?{...f,fields:f.fields.filter((_,i)=>i!==existingIdx)}:f) })
    } else {
      const newField: JsonParserField = { id:`f_${Date.now()}`, name:treeNode.name, jsonPath:treeNode.path, type:treeNode.valueType, transform:'none', onMissing:'null' }
      saveConfig({ ...config, flows:config.flows.map((f)=>f.id===flowId?{...f,fields:[...f.fields,newField]}:f) })
    }
  }, [config, saveConfig])

  const hasTree  = jsonTree.length > 0
  const allNodes = useMemo(() => flattenJsonTree(jsonTree), [jsonTree])

  useEffect(() => {
    const handler=(e: KeyboardEvent)=>{ if(e.key==='Escape') onClose() }
    document.addEventListener('keydown',handler); return()=>document.removeEventListener('keydown',handler)
  }, [onClose])

  const TABS: Array<{id:Tab;label:string;icon:string}> = [
    { id:'config',   label:'Configurazione', icon:'ti-adjustments' },
    { id:'general',  label:'Generale',        icon:'ti-info-circle' },
    { id:'advanced', label:'Avanzate',         icon:'ti-settings-2'  },
  ]

  return createPortal(
    <div style={{ position:'fixed', inset:0, display:'flex', alignItems:pos?'flex-start':'center', justifyContent:'center', zIndex:20000, padding:24, pointerEvents:'none' }}>
      <div
        ref={(el)=>{ ;(dragRef as React.MutableRefObject<HTMLDivElement|null>).current=el; ;(modalRef as React.MutableRefObject<HTMLDivElement|null>).current=el }}
        onClick={(e)=>e.stopPropagation()}
        style={{ pointerEvents:'all', background:'#161b27', border:`1px solid ${ACCENT}40`, borderRadius:isMaximized?0:10, width:isMaximized?'100vw':`${width}px`, maxWidth:isMaximized?'100vw':'96vw', maxHeight:isMaximized?'100vh':'92vh', display:'flex', flexDirection:'column', overflow:'hidden', boxShadow:'0 24px 64px rgba(0,0,0,.8), 0 0 0 1px #2a3349', position:'relative',
          ...(pos&&!isMaximized?{position:'fixed' as const,left:pos.x,top:pos.y}:{}),
          ...(isMaximized?{position:'fixed' as const,inset:0}:{}),
        }}>

        <div onMouseDown={onMouseDown} style={{ display:'flex', alignItems:'center', gap:10, padding:'12px 16px', borderBottom:'1px solid #2a3349', background:'#1a2030', flexShrink:0, cursor:'grab', userSelect:'none' }}>
          <span style={{ fontSize:18, color:ACCENT, fontFamily:'monospace', fontWeight:700 }}>&#123;&#125;</span>
          <div>
            <div style={{ fontSize:14, fontWeight:600, color:'#c8d4f0' }}>{node.data.config?.displayName||'JSON Parser'}</div>
            <div style={{ fontSize:11, color:'#4a5a7a', fontFamily:'monospace' }}>{nodeId}</div>
          </div>
          <div style={{ marginLeft:'auto', display:'flex', gap:6 }}>
            <button onClick={()=>setIsMaximized((m)=>{ if(!m)resetDrag(); return !m })} style={{ background:'none', border:'1px solid #2a3349', borderRadius:4, padding:'4px 8px', cursor:'pointer', color:'#9a9aaa', display:'flex', alignItems:'center' }}>
              <i className={`ti ${isMaximized?'ti-arrows-minimize':'ti-arrows-maximize'}`} style={{ fontSize:13 }} />
            </button>
            <button onClick={onClose} style={{ background:'none', border:'1px solid #2a3349', borderRadius:4, padding:'4px 12px', cursor:'pointer', color:'#9a9aaa', fontSize:12, display:'flex', alignItems:'center', gap:5 }}>
              <i className="ti ti-x" style={{ fontSize:12 }} /> chiudi
            </button>
          </div>
        </div>

        <div style={{ display:'flex', borderBottom:'1px solid #2a3349', flexShrink:0, background:'#161b27' }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={()=>setActiveTab(t.id)}
              style={{ padding:'9px 16px', fontSize:11, background:activeTab===t.id?'#1e2535':'transparent', border:'none', borderBottom:activeTab===t.id?`2px solid ${ACCENT}`:'2px solid transparent', color:activeTab===t.id?'#c8d4f0':'#4a5a7a', cursor:'pointer', display:'flex', alignItems:'center', gap:6, transition:'all .15s', whiteSpace:'nowrap' }}
              onMouseEnter={(e)=>{ if(activeTab!==t.id)(e.currentTarget as HTMLElement).style.color='#9a9aaa' }}
              onMouseLeave={(e)=>{ if(activeTab!==t.id)(e.currentTarget as HTMLElement).style.color='#4a5a7a' }}>
              <i className={`ti ${t.icon}`} style={{ fontSize:13 }} />{t.label}
            </button>
          ))}
        </div>

        <div style={{ flex:1, minHeight:0, display:'flex', flexDirection:'column', background:'#161b27', overflow:'hidden' }}>

          <div style={{ display:activeTab==='config'?'flex':'none', flex:1, minHeight:0, flexDirection:'column', overflow:'hidden' }}>

            <div style={{ flexShrink:0, padding:'10px 16px', borderBottom:'1px solid #2a3349', display:'flex', flexDirection:'column', gap:8, maxHeight:220, overflowY:'auto' }}>
              <SectionTitle label="Configurazione globale" />
              <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 180px', gap:10 }}>
                <Field label="Campo sorgente JSON">
                  <CustomSelect style={inputStyle} value={config.sourceField} onChange={(e)=>updateConfig({sourceField:e.target.value})}>
                    <option value="">— seleziona —</option>
                    {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                    {incomingFields.length===0 && <option value="" disabled>— collega un nodo sorgente —</option>}
                  </CustomSelect>
                </Field>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  <textarea style={{ ...inputStyle, resize:'vertical', minHeight:52, fontSize:10, fontFamily:'monospace' }}
                    value={rawJson} onChange={(e)=>setRawJson(e.target.value)}
                    placeholder={'{\n  "ordini": [...],\n  "clienti": [...]\n}'} spellCheck={false} />
                  <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                    <button onClick={handleAnalyze} disabled={!rawJson}
                      style={{ padding:'3px 14px', fontSize:10, borderRadius:4, cursor:rawJson?'pointer':'not-allowed', background:rawJson?`color-mix(in srgb, ${ACCENT} 20%, #161b27)`:'#1e2535', color:rawJson?ACCENT:'#4a5a7a', border:`1px solid ${rawJson?ACCENT+'60':'#2a3349'}`, fontWeight:600, display:'flex', alignItems:'center', gap:5 }}>
                      <i className="ti ti-player-play" style={{ fontSize:9 }} /> Analizza JSON e genera flussi
                    </button>
                    {parseError && <span style={{ fontSize:9, color:'#ff5f57' }}>{parseError}</span>}
                    {hasTree && !parseError && <span style={{ fontSize:9, color:'#3ddc84' }}>✓ {allNodes.length} nodi · {config.flows.length} flussi</span>}
                  </div>
                </div>
                <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
                  <div style={{ display:'flex', alignItems:'center', gap:6, padding:'5px 8px', background:'#0f1117', borderRadius:4, border:`1px solid ${config.hasReject?'#3a1a1a':'#2a3349'}` }}>
                    <button onClick={()=>updateConfig({hasReject:!config.hasReject})}
                      style={{ width:28, height:14, borderRadius:7, border:'none', cursor:'pointer', background:config.hasReject?'#ff5f57':'#2a3349', position:'relative', flexShrink:0, transition:'background .2s' }}>
                      <div style={{ width:10, height:10, borderRadius:'50%', background:'#fff', position:'absolute', top:2, left:config.hasReject?14:2, transition:'left .2s' }} />
                    </button>
                    <span style={{ fontSize:9, color:config.hasReject?'#ff5f57':'#4a5a7a', fontWeight:600 }}>
                      {config.hasReject?'Reject attivo':'Reject disabilitato'}
                    </span>
                  </div>
                  {incomingFields.length===0 && (
                    <div style={{ padding:'5px 8px', fontSize:9, color:'#ffb347', background:'#1a1000', borderRadius:4, border:'0.5px solid #3a2a0a', display:'flex', alignItems:'center', gap:4 }}>
                      <i className="ti ti-alert-triangle" style={{ fontSize:10 }} /> Nessun nodo in ingresso
                    </div>
                  )}
                </div>
              </div>
            </div>

            <div style={{ flex:1, minHeight:0, display:'grid', gridTemplateColumns:hasTree?'300px 1fr':'1fr', overflow:'hidden' }}>
              {hasTree && (
                <div style={{ borderRight:'1px solid #2a3349', display:'flex', flexDirection:'column', overflow:'hidden', background:'#0f1117' }}>
                  <div style={{ padding:'8px 12px', background:'#1a2030', borderBottom:'0.5px solid #2a3349', display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                    <i className="ti ti-braces" style={{ fontSize:12, color:ACCENT }} />
                    <span style={{ fontSize:10, fontWeight:600, color:ACCENT, textTransform:'uppercase', letterSpacing:'.06em', flex:1 }}>Struttura — {allNodes.length} nodi</span>
                    {selectedFlowId && <span style={{ fontSize:9, color:'#3ddc84', fontStyle:'italic' }}>→ {config.flows.find((f)=>f.id===selectedFlowId)?.label??''}</span>}
                  </div>
                  <div style={{ overflowY:'auto', flex:1 }}>
                    {jsonTree.map((n) => (
                      <JsonTreeNodeRow key={n.id} node={n} depth={0} selectedFlowId={selectedFlowId} flows={config.flows}
                        onToggleFieldInFlow={onToggleFieldInFlow} onGenerateFlow={generateFlowFromTree} onToggle={toggleTreeNode} />
                    ))}
                  </div>
                  <div style={{ padding:'5px 10px', background:'#1a2030', borderTop:'0.5px solid #2a3349', display:'flex', gap:8, flexShrink:0 }}>
                    {[{icon:'[]',color:'#ffb347',label:'array'},{icon:'{}',color:'#c8d4f0',label:'oggetto'},{icon:'—',color:'#3ddc84',label:'valore'},{icon:'●',color:'#3ddc84',label:'mappato'}].map((item) => (
                      <div key={item.label} style={{ display:'flex', alignItems:'center', gap:2 }}>
                        <code style={{ fontSize:8, color:item.color, minWidth:12 }}>{item.icon}</code>
                        <span style={{ fontSize:8, color:'#4a5a7a' }}>{item.label}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div style={{ display:'flex', flexDirection:'column', overflow:'hidden' }}>
                <div style={{ padding:'8px 12px', background:'#1a2030', borderBottom:'0.5px solid #2a3349', display:'flex', alignItems:'center', gap:6, flexShrink:0 }}>
                  <i className="ti ti-git-branch" style={{ fontSize:12, color:'#3ddc84' }} />
                  <span style={{ fontSize:10, fontWeight:600, color:'#3ddc84', textTransform:'uppercase', letterSpacing:'.06em', flex:1 }}>Flussi output — {config.flows.length}</span>
                  {selectedFlowId && <span style={{ fontSize:9, color:ACCENT, fontStyle:'italic' }}>selezionato: {config.flows.find((f)=>f.id===selectedFlowId)?.label}</span>}
                  <button onClick={addFlow} style={{ padding:'3px 12px', fontSize:10, borderRadius:4, cursor:'pointer', background:'#0d3d20', color:'#3ddc84', border:'1px solid #1d6d40', display:'flex', alignItems:'center', gap:4 }}
                    onMouseEnter={(e)=>{(e.currentTarget as HTMLElement).style.background='#1d6d40'}}
                    onMouseLeave={(e)=>{(e.currentTarget as HTMLElement).style.background='#0d3d20'}}>
                    <i className="ti ti-plus" style={{ fontSize:11 }} /> Flusso
                  </button>
                </div>
                <div style={{ flex:1, overflowY:'auto', padding:12, display:'flex', flexDirection:'column' }}>
                  {config.flows.length === 0 ? (
                    <div style={{ padding:'40px', textAlign:'center', color:'#2a3349', fontSize:11 }}>
                      <i className="ti ti-git-branch" style={{ fontSize:36, display:'block', marginBottom:12, color:`${ACCENT}20` }} />
                      Incolla un JSON di esempio e clicca "Analizza" per generare i flussi automaticamente, oppure aggiungi un flusso manuale.
                    </div>
                  ) : (
                    config.flows.map((flow) => (
                      <FlowFieldsTable key={flow.id} flow={flow} color={flow.color??FLOW_COLORS[0]}
                        selectedFlowId={selectedFlowId} onSelect={setSelectedFlowId}
                        onUpdate={(patch)=>updateFlow(flow.id,patch)} onDelete={()=>deleteFlow(flow.id)} />
                    ))
                  )}
                </div>
              </div>
            </div>
          </div>

          <div style={{ display:activeTab==='general'?'flex':'none', flexDirection:'column', flex:1, overflowY:'auto', padding:16 }}>
            <TabGeneral nodeId={nodeId} />
          </div>
          <div style={{ display:activeTab==='advanced'?'flex':'none', flexDirection:'column', flex:1, overflowY:'auto', padding:16 }}>
            <TabAdvanced nodeId={nodeId} />
          </div>
        </div>

        <div style={{ display:'flex', alignItems:'center', justifyContent:'flex-end', gap:8, padding:'10px 16px', borderTop:'1px solid #2a3349', background:'#1a2030', flexShrink:0 }}>
          <span style={{ fontSize:11, color:'#4a5a7a', marginRight:'auto' }}>Le modifiche sono salvate automaticamente</span>
          <button onClick={onClose}
            style={{ padding:'6px 20px', fontSize:12, borderRadius:4, cursor:'pointer', background:`color-mix(in srgb, ${ACCENT} 20%, #161b27)`, color:ACCENT, border:`1px solid ${ACCENT}60`, fontWeight:600 }}
            onMouseEnter={(e)=>{(e.currentTarget as HTMLElement).style.background=`color-mix(in srgb, ${ACCENT} 35%, #161b27)`}}
            onMouseLeave={(e)=>{(e.currentTarget as HTMLElement).style.background=`color-mix(in srgb, ${ACCENT} 20%, #161b27)`}}>
            Fatto
          </button>
        </div>

        {!isMaximized && (
          <div onMouseDown={onResizeStart}
            style={{ position:'absolute', top:0, right:0, bottom:0, width:6, cursor:'ew-resize', background:`color-mix(in srgb, ${ACCENT} 15%, #1a2030)`, display:'flex', alignItems:'center', justifyContent:'center', zIndex:10, transition:'background .15s' }}
            onMouseEnter={(e)=>{(e.currentTarget as HTMLElement).style.background=`color-mix(in srgb, ${ACCENT} 40%, #1a2030)`}}
            onMouseLeave={(e)=>{(e.currentTarget as HTMLElement).style.background=`color-mix(in srgb, ${ACCENT} 15%, #1a2030)`}}>
            <div style={{ width:2, height:32, borderRadius:1, background:`color-mix(in srgb, ${ACCENT} 60%, transparent)` }} />
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}