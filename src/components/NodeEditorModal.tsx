import { useState, useEffect, useRef, useCallback } from 'react'
import { createPortal } from 'react-dom'
import { useFlowStore } from '../store/flowStore'
import { NODE_DEFS } from '../nodes/registry'
import { NODE_QUERY_PANELS} from '../nodes/registry'
import { NODE_MAPPING_PANELS } from '../nodes/registry'
import { NODE_PREVIEW_PANELS } from '../nodes/registry'
import type { NodeMapping } from '../types'
import { NODE_PANELS } from '../nodes/registry'
import { DefaultPanel } from '../nodes/DefaultPanel'
import { ScriptMappingPanel } from '../nodes/types/script/MappingPanel'
import { CustomSelect } from '../components/CustomSelect'

import { TabGeneral }  from './tabs/TabGeneral'
import { TabAdvanced } from './tabs/TabAdvanced'

type Tab = 'general' | 'connection' | 'query' | 'mapping' | 'advanced' | 'preview'

// ─── Hook drag ────────────────────────────────────────────────────
function useDraggable() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragging      = useRef(false)
  const offset        = useRef({ x: 0, y: 0 })
  const ref           = useRef<HTMLDivElement>(null)

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragging.current = true
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    e.preventDefault()
  }, [])

  const reset = useCallback(() => setPos(null), [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y })
    }
    const onUp = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [])

  return { ref, pos, onMouseDown, reset }
}

// ─── Stili comuni ─────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e2535',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#c8d4f0',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: '6px 10px',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#9a9aaa',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  marginBottom: 4,
  fontWeight: 600,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#c8d4f0',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  padding: '8px 0 8px',
  borderBottom: '1px solid #2a3349',
  marginBottom: 4,
}

const sectionStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 14,
}

// ─── Field ────────────────────────────────────────────────────────
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '8px 10px',
      background: '#1a2030',
      borderRadius: 6,
      border: '0.5px solid #2a3349',
    }}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      {children}
    </div>
  )
}

function SectionTitle({ label }: { label: string }) {
  return <div style={sectionTitleStyle}>{label}</div>
}


// ─── Tab: Connessione ─────────────────────────────────────────────
function TabConnection({ nodeId }: { nodeId: string }) {
  const node         = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const pool         = useFlowStore((s) => s.pool)
  const updateConfig = useFlowStore((s) => s.updateNodeConfig)
  const updateProp   = useFlowStore((s) => s.updateNodeProp)
  const def          = node ? NODE_DEFS[node.data.type] : null

  if (!node || !def) return null

  const laneId    = node.data.laneId
  const lane      = pool.lanes.find((l) => l.id === laneId)
  const resources = lane?.resources ?? []
  const resId     = node.data.config.resourceId ?? ''
  const resource  = resources.find((r) => r.id === resId)

  const STATUS_COLOR: Record<string, string> = {
    ok: '#3ddc84', error: '#ff5f57', testing: '#ffb347', untested: '#4a5a7a',
  }
  const STATUS_ICON: Record<string, string> = {
    ok: 'ti-circle-check', error: 'ti-circle-x',
    testing: 'ti-loader spin', untested: 'ti-circle-dashed',
  }

  return (
    <div style={sectionStyle}>
      <SectionTitle label="Risorsa collegata" />
      {resources.length === 0 ? (
        <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 12, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Nessuna risorsa disponibile in questa lane. Aggiungine una dalla resource strip.
        </div>
      ) : (
        <Field label="Seleziona risorsa">
          <CustomSelect style={inputStyle} value={resId}
            onChange={(e) => updateConfig(nodeId, { resourceId: e.target.value })}>
            <option value="">— nessuna —</option>
            {resources.map((r) => (
              <option key={r.id} value={r.id}>{r.label} ({r.kind})</option>
            ))}
          </CustomSelect>
        </Field>
      )}
      {resource && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '10px 14px', background: '#1a2030', borderRadius: 6, border: '1px solid #2a3349' }}>
          <i className={`ti ${STATUS_ICON[resource.status] ?? 'ti-circle-dashed'}`}
            style={{ fontSize: 14, color: STATUS_COLOR[resource.status] }} aria-hidden="true" />
          <span style={{ fontSize: 12, color: '#c8d4f0', fontWeight: 600 }}>{resource.label}</span>
          <span style={{ fontSize: 11, color: '#4a5a7a' }}>{resource.kind} · {resource.status}</span>
        </div>
      )}
      {def.fields.length > 0 && (
        <>
          <SectionTitle label="Parametri del nodo" />
          {def.fields.map((field) => (
            <Field key={field.key} label={field.label}>
              {field.type === 'select' ? (
                <CustomSelect style={inputStyle} value={node.data.props[field.key] ?? field.default}
                  onChange={(e) => updateProp(nodeId, field.key, e.target.value)}>
                  {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </CustomSelect>
              ) : field.type === 'password' ? (
                <input type="password" style={inputStyle}
                  value={node.data.props[field.key] ?? field.default}
                  onChange={(e) => updateProp(nodeId, field.key, e.target.value)} />
              ) : (
                <input type={field.type === 'number' ? 'number' : 'text'} style={inputStyle}
                  value={node.data.props[field.key] ?? field.default}
                  onChange={(e) => updateProp(nodeId, field.key, e.target.value)} />
              )}
            </Field>
          ))}
        </>
      )}
    </div>
  )
}

// ─── Tab: Query ───────────────────────────────────────────────────
function TabQuery({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  if (!node) return null
  const def        = NODE_DEFS[node.data.type]
  const codeFields = def?.fields.filter((f) => f.type === 'code') ?? []

  if (codeFields.length === 0) {
    return (
      <div style={{ padding: '32px', textAlign: 'center', color: '#4a5a7a', fontSize: 12, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8 }}>
        <i className="ti ti-code-off" style={{ fontSize: 28, color: '#2a3349' }} aria-hidden="true" />
        Questo tipo di nodo non ha campi codice o query.
      </div>
    )
  }

  return (
    <div style={sectionStyle}>
      {codeFields.map((field) => (
        <div key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 8, background: '#1a2030', border: '1px solid #2a3349', borderRadius: 6, padding: 12 }}>
          <div style={{ ...sectionTitleStyle, padding: '0 0 8px', margin: 0 }}>{field.label}</div>
          <textarea ref={textareaRef}
            style={{ ...inputStyle, minHeight: 200, resize: 'vertical', fontFamily: "'JetBrains Mono', 'Fira Code', monospace", fontSize: 12, lineHeight: 1.7, tabSize: 2 }}
            value={node.data.props[field.key] ?? field.default}
            onChange={(e) => updateProp(nodeId, field.key, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Tab') {
                e.preventDefault()
                const el = e.currentTarget
                const s = el.selectionStart
                const end = el.selectionEnd
                el.value = el.value.substring(0, s) + '  ' + el.value.substring(end)
                el.selectionStart = el.selectionEnd = s + 2
                updateProp(nodeId, field.key, el.value)
              }
            }}
            spellCheck={false} />
          <div style={{ fontSize: 10, color: '#4a5a7a' }}>Tab inserisce 2 spazi. Il codice viene eseguito sul server.</div>
        </div>
      ))}
    </div>
  )
}

// ─── Tab: Mapping ─────────────────────────────────────────────────
function TabMapping({ nodeId }: { nodeId: string }) {
  const node          = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const addMapping    = useFlowStore((s) => s.addNodeMapping)
  const updateMapping = useFlowStore((s) => s.updateNodeMapping)
  const deleteMapping = useFlowStore((s) => s.deleteNodeMapping)

  if (!node) return null
  const mappings = node.data.config.mappings ?? []

  return (
    <div style={sectionStyle}>
      <SectionTitle label="Mapping campi input → output" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 24px 1fr 90px 32px', gap: 8, padding: '4px 10px', background: '#1a2030', borderRadius: '6px 6px 0 0', border: '1px solid #2a3349', borderBottom: '1px solid #3a4a6a' }}>
        {['Campo ingresso', '', 'Campo uscita', 'Trasformazione', ''].map((h, i) => (
          <div key={i} style={{ fontSize: 10, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600 }}>{h}</div>
        ))}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', border: '1px solid #2a3349', borderTop: 'none', borderRadius: '0 0 6px 6px', overflow: 'hidden' }}>
        {mappings.length === 0 && (
          <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 12, background: '#1a2030' }}>
            Nessun mapping definito. Aggiungi una riga per mappare i campi.
          </div>
        )}
        {mappings.map((m: NodeMapping, idx: number) => (
          <div key={m.id} style={{ display: 'grid', gridTemplateColumns: '1fr 24px 1fr 90px 32px', gap: 8, alignItems: 'center', padding: '6px 10px', background: idx % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: '0.5px solid #2a3349' }}>
            <input style={inputStyle} value={m.sourceField} placeholder="campo_sorgente"
              onChange={(e) => updateMapping(nodeId, m.id, 'sourceField', e.target.value)} />
            <i className="ti ti-arrow-right" style={{ fontSize: 13, color: '#4a5a7a', textAlign: 'center' }} aria-hidden="true" />
            <input style={inputStyle} value={m.targetField} placeholder="campo_dest"
              onChange={(e) => updateMapping(nodeId, m.id, 'targetField', e.target.value)} />
            <CustomSelect style={{ ...inputStyle, padding: '5px 4px' }} value={m.transform ?? ''}
              onChange={(e) => updateMapping(nodeId, m.id, 'transform', e.target.value)}>
              <option value="">nessuna</option>
              <option value="uppercase">uppercase</option>
              <option value="lowercase">lowercase</option>
              <option value="trim">trim</option>
              <option value="to_int">to_int</option>
              <option value="to_float">to_float</option>
              <option value="to_date">to_date</option>
            </CustomSelect>
            <button onClick={() => deleteMapping(nodeId, m.id)}
              style={{ background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '4px 6px', cursor: 'pointer', color: '#ff5f57', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <i className="ti ti-x" style={{ fontSize: 11 }} aria-hidden="true" />
            </button>
          </div>
        ))}
      </div>
      <button onClick={() => addMapping(nodeId)}
        style={{ background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 6, padding: '8px', fontSize: 11, color: '#4a9eff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}>
        <i className="ti ti-plus" style={{ fontSize: 13 }} aria-hidden="true" />
        Aggiungi riga di mapping
      </button>
    </div>
  )
}





// ─── Tab: Preview ─────────────────────────────────────────────────
function TabPreview({ nodeId }: { nodeId: string }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  if (!node) return null

  const cols = ['id', 'nome', 'email', 'created_at', 'status']
  const rows = Array.from({ length: 5 }, (_, i) => ({
    id: 1000 + i,
    nome: ['Mario Rossi', 'Giulia Bianchi', 'Luca Verdi', 'Anna Neri', 'Paolo Blu'][i],
    email: `user${i}@example.com`,
    created_at: `2024-0${i + 1}-15`,
    status: i % 2 === 0 ? 'active' : 'pending',
  }))

  return (
    <div style={sectionStyle}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={sectionTitleStyle}>Anteprima dati in uscita</div>
        <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, marginLeft: 'auto', background: '#3d2a0a', color: '#ffb347', border: '0.5px solid #854f0b' }}>simulata</span>
      </div>
      <div style={{ overflowX: 'auto', border: '1px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
          <thead>
            <tr>
              {cols.map((c) => (
                <th key={c} style={{ padding: '8px 12px', textAlign: 'left', background: '#1a2030', borderBottom: '1px solid #3a4a6a', fontSize: 10, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, whiteSpace: 'nowrap' }}>{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? '#1a2030' : '#1e2535' }}>
                {cols.map((c) => (
                  <td key={c} style={{ padding: '6px 12px', borderBottom: i < rows.length - 1 ? '0.5px solid #2a3349' : 'none', color: '#9a9aaa', whiteSpace: 'nowrap' }}>
                    {String((row as Record<string, unknown>)[c] ?? '')}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>
        Prime 5 righe simulate. L'anteprima reale sarà disponibile con il backend collegato.
      </div>
    </div>
  )
}

// ─── NodeEditorModal ──────────────────────────────────────────────
export function NodeEditorModal() {
  const editingNodeId = useFlowStore((s) => s.editingNodeId)
  const closeEditor   = useFlowStore((s) => s.closeNodeEditor)
  const nodes         = useFlowStore((s) => s.nodes)
  const [activeTab, setActiveTab]   = useState<Tab>('connection')
  const [isMaximized, setIsMaximized] = useState(false)
  const [modalWidth, setModalWidth]   = useState<number | null>(null)
  const resizingRef    = useRef(false)
  const startXRef      = useRef(0)
  const startWidthRef  = useRef(0)
  const modalRef       = useRef<HTMLDivElement>(null)
  const { ref: dragRef, pos, onMouseDown, reset: resetDrag } = useDraggable()

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    resizingRef.current   = true
    startXRef.current     = e.clientX
    startWidthRef.current = modalRef.current?.getBoundingClientRect().width ?? 720
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      const delta = ev.clientX - startXRef.current
      const newW  = Math.max(480, Math.min(window.innerWidth - 48, startWidthRef.current + delta))
      setModalWidth(Math.round(newW))
    }
    const onUp = () => {
      resizingRef.current = false
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => { setActiveTab('connection') }, [editingNodeId]) 

  useEffect(() => {
    if (!editingNodeId) return
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeEditor() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [editingNodeId, closeEditor])

  if (!editingNodeId) return null
  const node = nodes.find((n) => n.id === editingNodeId)
  if (!node) return null

  const def    = NODE_DEFS[node.data.type]
 // const isTMap = node.data.type === 'tmap'

  const isErrorHandler = node.data.type === 'error_handler'

  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'connection', label: 'Configurazione',  icon: 'ti-adjustments' },
    { id: 'mapping',    label: isErrorHandler ? 'Nodi' : 'Mapping', icon: isErrorHandler ? 'ti-list-details' : 'ti-arrows-exchange' },
    { id: 'general',    label: 'Generale',       icon: 'ti-info-circle' },
    { id: 'query',      label: 'Query',           icon: 'ti-code' },
    { id: 'advanced',   label: 'Avanzate',        icon: 'ti-settings-2' },
    { id: 'preview',    label: 'Preview',         icon: 'ti-table' },
  ]

  return createPortal(
    <div style={{
      position: 'fixed', inset: 0,
      display: 'flex',
      alignItems: pos ? 'flex-start' : 'center',
      justifyContent: 'center',
      zIndex: 10000, padding: 24,
      pointerEvents: 'none',
    }}>
      {/* Box modale */}
      <div
        ref={(el) => {
          dragRef.current = el
          ;(modalRef as React.MutableRefObject<HTMLDivElement | null>).current = el
        }}
        onClick={(e) => e.stopPropagation()}
        style={{
          pointerEvents: 'all',
          background: '#161b27',
          border: '1px solid #3a4a6a',
          borderRadius: isMaximized ? 0 : 10,
          width:     modalWidth ? `${modalWidth}px` : '100%',
          maxWidth:  isMaximized ? '100vw' : modalWidth ? 'none' :  720,
          maxHeight: isMaximized ? '100vh' : '90vh',
          display: 'flex',
          flexDirection: 'column',
          overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.8), 0 0 0 1px #2a3349',
          position: 'relative',
          ...(pos && !isMaximized ? { position: 'fixed' as const, left: pos.x, top: pos.y } : {}),
          ...(isMaximized ? { position: 'fixed' as const, inset: 0 } : {}),
        }}
      >
        {/* Header */}
        <div onMouseDown={onMouseDown} style={{
          display: 'flex', alignItems: 'center', gap: 10,
          padding: '12px 16px',
          borderBottom: '1px solid #2a3349',
          background: '#1a2030',
          flexShrink: 0,
          cursor: 'grab', userSelect: 'none',
        }}>
          <span style={{ fontSize: 20, color: def?.color ?? '#4a9eff' }}>{def?.icon ?? '⬡'}</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8d4f0' }}>
              {node.data.config.displayName || def?.label || node.data.label}
            </div>
            <div style={{ fontSize: 11, color: '#4a5a7a', fontFamily: 'monospace' }}>
              {node.id} · {node.data.laneId}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button
              onClick={() => setIsMaximized((m) => { if (!m) { setModalWidth(null); resetDrag() } return !m })}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', color: '#9a9aaa', display: 'flex', alignItems: 'center' }}
              title={isMaximized ? 'Ripristina' : 'Massimizza'}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a5a7a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              <i className={`ti ${isMaximized ? 'ti-arrows-minimize' : 'ti-arrows-maximize'}`} style={{ fontSize: 13 }} aria-hidden="true" />
            </button>
            <button onClick={closeEditor}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', color: '#9a9aaa', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a5a7a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              <i className="ti ti-x" style={{ fontSize: 12 }} aria-hidden="true" />
              chiudi
            </button>
          </div>
        </div>

        {/* Tab bar */}
        <div style={{ display: 'flex', borderBottom: '1px solid #2a3349', flexShrink: 0, overflowX: 'auto', background: '#161b27' }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              style={{
                padding: '9px 16px', fontSize: 11,
                background: activeTab === t.id ? '#1e2535' : 'transparent',
                border: 'none',
                borderBottom: activeTab === t.id ? '2px solid #4a9eff' : '2px solid transparent',
                color: activeTab === t.id ? '#c8d4f0' : '#4a5a7a',
                cursor: 'pointer', whiteSpace: 'nowrap',
                display: 'flex', alignItems: 'center', gap: 6,
                transition: 'all .15s',
              }}
              onMouseEnter={(e) => { if (activeTab !== t.id) (e.currentTarget as HTMLElement).style.color = '#9a9aaa' }}
              onMouseLeave={(e) => { if (activeTab !== t.id) (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
              <i className={`ti ${t.icon}`} style={{ fontSize: 13 }} aria-hidden="true" />
              {t.label}
            </button>
          ))}
        </div>

        {/* Body — tutti i tab sempre nel DOM, display:none per quelli inattivi */}
        <div style={{ flex: 1, overflow: 'hidden', background: '#161b27', display: 'flex', flexDirection: 'column', minHeight: 0 }}>

          {/* Generale */}
          <div style={{ display: activeTab === 'general' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}>
            <TabGeneral nodeId={editingNodeId} />
          </div>

          {/* Configurazione */}
          <div style={{ display: activeTab === 'connection' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}>
            {(() => {
              const PanelComponent = NODE_PANELS[node.data.type] ?? DefaultPanel
              return <PanelComponent nodeId={editingNodeId} />
            })()}
          </div>

        {/* Query */}
          <div style={{ display: activeTab === 'query' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}>
            {(() => {
              const QueryComponent = NODE_QUERY_PANELS[node.data.type]
              if (QueryComponent) return <QueryComponent nodeId={editingNodeId} />
              return <TabQuery nodeId={editingNodeId} />
            })()}
          </div>

          {/* Mapping */}
          <div style={{ display: activeTab === 'mapping' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}>
            {(() => {
              const MappingComponent = NODE_MAPPING_PANELS[node.data.type]
              if (MappingComponent) return <MappingComponent nodeId={editingNodeId} />
              return <TabMapping nodeId={editingNodeId} />
            })()}
          </div>

          {/* Avanzate */}
          <div style={{ display: activeTab === 'advanced' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}>
            <TabAdvanced nodeId={editingNodeId} />
          </div>

          {/* Preview */}
          <div style={{ display: activeTab === 'preview' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}>
            {(() => {
              const PreviewComponent = NODE_PREVIEW_PANELS[node.data.type]
              if (PreviewComponent) return <PreviewComponent nodeId={editingNodeId} />
              return <TabPreview nodeId={editingNodeId} />
            })()}
          </div>

        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '1px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#4a5a7a', marginRight: 'auto' }}>Le modifiche sono salvate automaticamente</span>
          <button onClick={closeEditor}
            style={{ padding: '6px 20px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: '#1a3a6a', color: '#4a9eff', border: '1px solid #2a5a9a', fontWeight: 600 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a4a7a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a3a6a' }}>
            Fatto
          </button>
        </div>

        {/* Resize handle */}
        {!isMaximized && (
          <div onMouseDown={onResizeStart} title="Trascina per allargare"
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 6, cursor: 'ew-resize', background: 'color-mix(in srgb, #4a9eff 15%, #1a2030)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, transition: 'background .15s' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, #4a9eff 40%, #1a2030)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, #4a9eff 15%, #1a2030)' }}>
            <div style={{ width: 2, height: 32, borderRadius: 1, background: 'color-mix(in srgb, #4a9eff 60%, transparent)' }} />
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}