/**
 * src/nodes/types/bridge/BridgeInModal.tsx
 *
 * Modal dedicata al BridgeIn.
 * Tab Configurazione  — identica al BridgePanel (canale, sync, timeout)
 * Tab Schema output   — dichiarazione manuale dei campi che BridgeIn emetterà,
 *                       propagata ai TMap/nodi successivi come outputSchema.
 * Tab Generale        — TabGeneral standard
 * Tab Avanzate        — TabAdvanced standard
 *
 * Lo schema viene propagato automaticamente a ogni modifica:
 *   - ai TMap collegati come input fields
 *   - agli altri nodi come incomingSchema
 *
 * Questo risolve il problema per cui BridgeIn non trasmetteva
 * lo schema ai nodi a valle perché non aveva nessuna dichiarazione
 * di outputSchema nel config.
 */
import { useState, useCallback, useEffect, useRef, useMemo} from 'react'
import { createPortal } from 'react-dom'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { TabGeneral }  from '../../../components/tabs/TabGeneral'
import { TabAdvanced } from '../../../components/tabs/TabAdvanced'
import type { TMapConfig } from '../../../types'
import { getHandleSchema } from '../../../utils/schemaRegistry'

const ACCENT = '#a78bfa'

const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none', width: '100%',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}

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
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 8 }}>
      {label}
    </div>
  )
}

// ─── Tipi schema ──────────────────────────────────────────────────
interface SchemaField {
  id:           string
  name:         string
  physicalName: string
  type:         string
}

import { FIELD_TYPES } from '../../../types/fieldTypes'

const BRIDGE_COLORS = [
  '#a78bfa', '#f472b6', '#22d3ee', '#3ddc84',
  '#ffb347', '#4a9eff', '#fb923c', '#84cc16',
]

// ─── useDraggable ─────────────────────────────────────────────────
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
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y })
    }
    const onUp = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  return { ref, pos, onMouseDown, reset }
}

// ─── Tab Configurazione ───────────────────────────────────────────
function ConfigTab({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const allNodes   = useFlowStore((s) => s.nodes)
  const pool       = useFlowStore((s) => s.pool)
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const selectNode = useFlowStore((s) => s.selectNode)
  const selectLane = useFlowStore((s) => s.selectLane)

  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const channelName  = p('channelName')
  const channelColor = p('channelColor', '#a78bfa')
  const syncMode     = p('syncMode', 'fire_and_forget')
  const timeoutSec   = p('timeoutSec', '30')
  const laneId       = node.data.laneId

  const counterpart = useMemo(() => {
    if (!channelName) return null
    return allNodes.find((n) =>
      n.data.type === 'bridge_out' &&
      n.data.props?.['channelName'] === channelName &&
      n.data.laneId !== laneId
    ) ?? null
  }, [allNodes, channelName, laneId])

  const proposedSchema = useMemo(() => {
    if (!counterpart) return []
    return getHandleSchema(counterpart, 'input', true)
  }, [counterpart])

  const counterLane = counterpart ? pool.lanes.find((l) => l.id === counterpart.data.laneId) : null
  const thisLane    = pool.lanes.find((l) => l.id === laneId)
  const color       = channelColor

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Stato coppia */}
      <div style={{ padding: '10px 12px', borderRadius: 8,
        background: counterpart ? `color-mix(in srgb, ${color} 8%, #0f1117)` : '#1a0a0a',
        border: `1px solid ${counterpart ? color + '40' : '#3d1010'}` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, textAlign: 'right' }}>
            <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>Questa lane (IN)</div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0' }}>{thisLane?.label ?? laneId}</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div style={{ fontSize: 16, color: counterpart ? color : '#2a3349' }}>←</div>
            {channelName && <code style={{ fontSize: 9, color, fontFamily: 'monospace' }}>{channelName}</code>}
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>Lane sorgente (OUT)</div>
            {counterpart ? (
              <button onClick={() => { selectNode(counterpart.id); selectLane(counterpart.data.laneId) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color, padding: 0, textDecoration: 'underline' }}>
                {counterLane?.label ?? counterpart.data.laneId}
              </button>
            ) : (
              <div style={{ fontSize: 11, color: '#ff5f57', fontStyle: 'italic' }}>
                {channelName ? 'Non trovato' : '—'}
              </div>
            )}
          </div>
        </div>
        {channelName && !counterpart && (
          <div style={{ marginTop: 8, padding: '5px 8px', background: '#2a1010', borderRadius: 4, fontSize: 10, color: '#ff5f57', display: 'flex', gap: 5 }}>
            <i className="ti ti-alert-circle" style={{ fontSize: 11, flexShrink: 0 }} />
            BridgeOut con canale "{channelName}" non trovato in nessuna altra lane.
          </div>
        )}
      </div>

      <SectionTitle label="Canale" color={color} />
      <Field label="Nome canale" hint="Deve corrispondere esattamente al BridgeOut">
        <input style={iStyle} value={channelName} onChange={u('channelName')} placeholder="channel_a" />
      </Field>
      <Field label="Colore canale">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {BRIDGE_COLORS.map((c) => (
            <div key={c} onClick={() => updateProp(nodeId, 'channelColor', c)}
              style={{ width: 20, height: 20, borderRadius: '50%', background: c, cursor: 'pointer',
                border: channelColor === c ? '2px solid #fff' : '2px solid transparent' }} />
          ))}
          <input type="color" value={channelColor} onChange={u('channelColor')}
            style={{ width: 24, height: 24, border: 'none', borderRadius: 4, padding: 0, cursor: 'pointer', background: 'none', marginLeft: 4 }} />
        </div>
      </Field>

      <SectionTitle label="Sincronismo" color={color} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {([
          { value: 'fire_and_forget', label: '→ Fire & Forget', desc: 'Elabora i dati non appena arrivano, senza segnalare Lane A.' },
          { value: 'wait_for_ack',    label: '⇄ Wait for Ack',  desc: 'Invia ACK a ogni envelope ricevuto (per canali remoti).' },
          { value: 'gate',            label: '⊟ Gate',           desc: 'Si blocca finché Lane A non ha completato il flusso.' },
        ] as const).map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'syncMode', m.value)}
            style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              background: syncMode === m.value ? `color-mix(in srgb, ${color} 15%, #1a2030)` : '#1a2030',
              border: syncMode === m.value ? `1px solid ${color}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: syncMode === m.value ? color : '#c8d4f0' }}>{m.label}</span>
            <span style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.desc}</span>
          </button>
        ))}
      </div>

      <SectionTitle label="Timeout" color={color} />
      <Field label="Timeout attesa (secondi)"
        hint="Tempo massimo di attesa per il primo envelope. Se scade, la pipeline fallisce.">
        <input type="number" style={iStyle} value={timeoutSec} onChange={u('timeoutSec')} min="1" max="3600" />
      </Field>

      <div style={{ padding: '8px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', lineHeight: 1.6 }}>
        <div style={{ color, fontWeight: 600, marginBottom: 4 }}>BridgeIn — come funziona</div>
        <div>• Si blocca finché BridgeOut non pubblica sul canale <code style={{ color }}>{channelName || '…'}</code></div>
        <div>• Emette le righe ricevute verso i nodi successivi della lane</div>
        <div>• Il timeout protegge da BridgeOut mancante o crashato</div>
      </div>
    </div>
  )
}

// ─── Tab Schema ───────────────────────────────────────────────────
function SchemaTab({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null
  const allNodes     = useFlowStore((s) => s.nodes)
  const channelName  = String(node.data.props?.['channelName'] ?? '')
  const laneId       = node.data.laneId

  const counterpart = useMemo(() => {
    if (!channelName) return null
    return allNodes.find((n) =>
      n.data.type === 'bridge_out' &&
      n.data.props?.['channelName'] === channelName &&
      n.data.laneId !== laneId
    ) ?? null
  }, [allNodes, channelName, laneId])

  const proposedSchema = useMemo(() => {
    if (!counterpart) return []
    return getHandleSchema(counterpart, 'input', true)
  }, [counterpart])
  

  const channelColor = String(node.data.props?.['channelColor'] ?? '#a78bfa')
  const color        = channelColor

  // Legge schema corrente
  const getSchema = (): SchemaField[] => {
    try {
      const raw = node.data.props?.['outputSchema']
      if (raw) return JSON.parse(raw as string)
    } catch {}
    return []
  }

  // Salva schema e propaga ai nodi successivi
  const saveSchema = (fields: SchemaField[]) => {
    updateProp(nodeId, 'outputSchema', JSON.stringify(fields))

    const store    = useFlowStore.getState()
    const outEdges = store.edges.filter((e) => e.source === nodeId)

    outEdges.forEach((edge) => {
      const tgt = store.nodes.find((n) => n.id === edge.target)
      if (!tgt) return

      if (tgt.data.type === 'tmap') {
        const tmap  = tgt.data.config?.tmap as TMapConfig | undefined
        if (!tmap) return
        const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
        if (!input) return
        const existingNames = new Set(
          input.fields.filter((f) => !f.name.startsWith('status.')).map((f) => f.name)
        )
        const merged = [
          ...input.fields,
          ...fields
            .filter((f) => !existingNames.has(f.name))
            .map((f) => ({ id: f.id, name: f.name, type: f.type as any, physicalName: f.physicalName })),
        ]
        store.updateTMapInput(tgt.id, input.id, { fields: merged })
      } else {
        store.updateNodeProp(tgt.id, 'incomingSchema', JSON.stringify(fields))
      }
    })
  }

  const schema = getSchema()

  const addField = () => {
    const n    = schema.length + 1
    const name = `campo_${n}`
    saveSchema([...schema, { id: `f_${Date.now()}`, name, physicalName: name, type: 'string' }])
  }

  const updateField = (idx: number, key: string, value: string) =>
    saveSchema(schema.map((f, i) => i === idx ? { ...f, [key]: value } : f))

  const deleteField = (idx: number) =>
    saveSchema(schema.filter((_, i) => i !== idx))

  const moveField = (idx: number, dir: 'up' | 'down') => {
    const next = [...schema]
    const swap = dir === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= next.length) return
    ;[next[idx], next[swap]] = [next[swap], next[idx]]
    saveSchema(next)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Banner informativo */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${color} 8%, #0f1117)`,
        border: `0.5px solid ${color}30`, borderRadius: 6, fontSize: 10, color: '#9a9aaa', lineHeight: 1.6 }}>
        <div style={{ color, fontWeight: 600, marginBottom: 4 }}>Schema output di BridgeIn</div>
        <div>Dichiara qui i campi che BridgeIn riceverà dal canale. Questi campi vengono propagati
        automaticamente ai nodi successivi (TMap, Filter, ecc.) come schema di input.</div>
        <div style={{ marginTop: 4, color: '#4a5a7a' }}>
          Lo schema viene usato solo per la configurazione visuale — a runtime BridgeIn
          riceve i dati reali dal canale indipendentemente da questa dichiarazione.
        </div>
      </div>

      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={addField}
          style={{ padding: '5px 14px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
            background: `color-mix(in srgb, ${color} 15%, #1a2030)`,
            color, border: `1px solid ${color}60`, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-plus" style={{ fontSize: 11 }} /> Aggiungi campo
        </button>
        {schema.length > 0 && (
          <button onClick={() => { if (confirm('Svuotare lo schema?')) saveSchema([]) }}
            style={{ padding: '5px 10px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
              background: 'none', color: '#4a5a7a', border: '0.5px solid #2a3349' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            <i className="ti ti-trash" style={{ fontSize: 11 }} />
          </button>
        )}
        <span style={{ fontSize: 10, color: '#4a5a7a', marginLeft: 'auto' }}>
          {schema.length} {schema.length === 1 ? 'campo' : 'campi'}
        </span>
      </div>

      {/* Tabella campi */}
      {schema.length === 0 ? (
        <div style={{ padding: '40px', textAlign: 'center', color: '#2a3349', fontSize: 11,
          background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-schema" style={{ fontSize: 32, display: 'block', marginBottom: 10, color: `${color}20` }} />
          Nessun campo definito — aggiungi i campi che BridgeIn emetterà
        </div>
      ) : (
        <div style={{ background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', overflow: 'hidden' }}>
          {/* Header tabella */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 24px 24px 24px',
            gap: 6, padding: '6px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
            {['Nome campo', 'Nome fisico / alias', 'Tipo', '', '', ''].map((h, i) => (
              <div key={i} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{h}</div>
            ))}
          </div>

          {/* Righe */}
          {schema.map((field, idx) => (
            <div key={field.id}
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 100px 24px 24px 24px',
                gap: 6, alignItems: 'center', padding: '4px 10px',
                background: idx % 2 === 0 ? '#1a2030' : 'transparent',
                borderBottom: idx < schema.length - 1 ? '0.5px solid #1e2840' : 'none' }}>

              {/* Nome */}
              <input value={field.name}
                onChange={(e) => updateField(idx, 'name', e.target.value)}
                style={{ ...iStyle, fontSize: 10, padding: '3px 6px', color }}
                placeholder="nome_campo" />

              {/* Nome fisico */}
              <input value={field.physicalName}
                onChange={(e) => updateField(idx, 'physicalName', e.target.value)}
                style={{ ...iStyle, fontSize: 10, padding: '3px 6px', color: '#9a9aaa' }}
                placeholder={field.name || 'nome_fisico'} />

              {/* Tipo */}
              <CustomSelect value={field.type}
                onChange={(e) => updateField(idx, 'type', e.target.value)}
                style={{ ...iStyle, fontSize: 10, padding: '3px 4px' }}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </CustomSelect>

              {/* Su */}
              <button onClick={() => moveField(idx, 'up')} disabled={idx === 0}
                style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'not-allowed' : 'pointer',
                  color: idx === 0 ? '#2a3349' : '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { if (idx !== 0) (e.currentTarget as HTMLElement).style.color = color }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = idx === 0 ? '#2a3349' : '#4a5a7a' }}>
                <i className="ti ti-chevron-up" style={{ fontSize: 11 }} />
              </button>

              {/* Giù */}
              <button onClick={() => moveField(idx, 'down')} disabled={idx === schema.length - 1}
                style={{ background: 'none', border: 'none', cursor: idx === schema.length - 1 ? 'not-allowed' : 'pointer',
                  color: idx === schema.length - 1 ? '#2a3349' : '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { if (idx !== schema.length - 1) (e.currentTarget as HTMLElement).style.color = color }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = idx === schema.length - 1 ? '#2a3349' : '#4a5a7a' }}>
                <i className="ti ti-chevron-down" style={{ fontSize: 11 }} />
              </button>

              {/* Elimina */}
              <button onClick={() => deleteField(idx)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                <i className="ti ti-x" style={{ fontSize: 11 }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Hint propagazione */}
      {schema.length > 0 && (
        <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4,
          border: '0.5px solid #2a3349', fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 6 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 10, color, flexShrink: 0 }} />
          Lo schema viene propagato automaticamente ai nodi collegati all'output di questo BridgeIn.
          I campi verranno aggiunti come input ai TMap e come schema in ingresso agli altri nodi.
        </div>
      )}
    </div>
  )
}

// ─── Modal principale ─────────────────────────────────────────────
type Tab = 'config' | 'schema' | 'general' | 'advanced'

export function BridgeInModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const [activeTab,   setActiveTab]   = useState<Tab>('config')
  const [isMaximized, setIsMaximized] = useState(false)
  const [modalWidth,  setModalWidth]  = useState<number | null>(null)
  const resizingRef     = useRef(false)
  const startXRef       = useRef(0)
  const startWidthRef   = useRef(0)
  const modalRef        = useRef<HTMLDivElement>(null)
  const { ref: dragRef, pos, onMouseDown, reset: resetDrag } = useDraggable()

  const channelColor = String(node?.data.props?.['channelColor'] ?? '#a78bfa')
  const channelName  = String(node?.data.props?.['channelName']  ?? '…')
  const schemaFields = (() => {
    try { return JSON.parse(String(node?.data.props?.['outputSchema'] ?? '[]')).length } catch { return 0 }
  })()

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation()
    resizingRef.current  = true
    startXRef.current    = e.clientX
    startWidthRef.current = modalRef.current?.getBoundingClientRect().width ?? 700
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      setModalWidth(Math.round(Math.max(500, Math.min(window.innerWidth - 48, startWidthRef.current + ev.clientX - startXRef.current))))
    }
    const onUp = () => { resizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  if (!node) return null

  const TABS: { id: Tab; label: string; icon: string; badge?: number }[] = [
    { id: 'config',   label: 'Configurazione', icon: 'ti-adjustments' },
    { id: 'schema',   label: 'Schema output',  icon: 'ti-table',       badge: schemaFields > 0 ? schemaFields : undefined },
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
          border: `1px solid ${channelColor}40`,
          borderRadius: isMaximized ? 0 : 10,
          width:    modalWidth ? `${modalWidth}px` : '640px',
          maxWidth: isMaximized ? '100vw' : '90vw',
          maxHeight: isMaximized ? '100vh' : '88vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.8), 0 0 0 1px #2a3349',
          position: 'relative',
          ...(pos && !isMaximized ? { position: 'fixed' as const, left: pos.x, top: pos.y } : {}),
          ...(isMaximized ? { position: 'fixed' as const, inset: 0 } : {}),
        }}>

        {/* Header */}
        <div onMouseDown={onMouseDown}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px',
            borderBottom: '1px solid #2a3349', background: '#1a2030',
            flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
          <div style={{ width: 32, height: 32, borderRadius: 8, background: `color-mix(in srgb, ${channelColor} 20%, #1e2535)`,
            border: `1.5px solid ${channelColor}`, display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
            <span style={{ fontSize: 14, color: channelColor, fontWeight: 700 }}>←</span>
          </div>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8d4f0' }}>
              {node.data.config?.displayName || 'Bridge In'}
            </div>
            <div style={{ fontSize: 10, color: '#4a5a7a', fontFamily: 'monospace' }}>
              {nodeId} · canale: <span style={{ color: channelColor }}>{channelName}</span>
            </div>
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
              style={{ padding: '9px 16px', fontSize: 11, background: activeTab === t.id ? '#1e2535' : 'transparent',
                border: 'none', borderBottom: activeTab === t.id ? `2px solid ${channelColor}` : '2px solid transparent',
                color: activeTab === t.id ? '#c8d4f0' : '#4a5a7a', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 6, transition: 'all .15s', whiteSpace: 'nowrap' }}
              onMouseEnter={(e) => { if (activeTab !== t.id) (e.currentTarget as HTMLElement).style.color = '#9a9aaa' }}
              onMouseLeave={(e) => { if (activeTab !== t.id) (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
              <i className={`ti ${t.icon}`} style={{ fontSize: 13 }} />
              {t.label}
              {t.badge !== undefined && (
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8,
                  background: `color-mix(in srgb, ${channelColor} 20%, #1e2535)`,
                  color: channelColor, fontWeight: 600 }}>{t.badge}</span>
              )}
            </button>
          ))}
        </div>

        {/* Contenuto */}
        <div style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: activeTab === 'config'   ? 'block' : 'none', overflowY: 'auto', flex: 1, padding: 16 }}><ConfigTab nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'schema'   ? 'block' : 'none', overflowY: 'auto', flex: 1, padding: 16 }}><SchemaTab nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'general'  ? 'flex'  : 'none', flexDirection: 'column', flex: 1, overflowY: 'auto', padding: 16 }}><TabGeneral nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'advanced' ? 'flex'  : 'none', flexDirection: 'column', flex: 1, overflowY: 'auto', padding: 16 }}><TabAdvanced nodeId={nodeId} /></div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
          padding: '10px 16px', borderTop: '1px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#4a5a7a', marginRight: 'auto' }}>Le modifiche sono salvate automaticamente</span>
          <button onClick={onClose}
            style={{ padding: '6px 20px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
              background: `color-mix(in srgb, ${channelColor} 15%, #161b27)`,
              color: channelColor, border: `1px solid ${channelColor}60`, fontWeight: 600 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${channelColor} 25%, #161b27)` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${channelColor} 15%, #161b27)` }}>
            Fatto
          </button>
        </div>

        {/* Handle resize */}
        {!isMaximized && (
          <div onMouseDown={onResizeStart}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 6, cursor: 'ew-resize',
              background: `color-mix(in srgb, ${channelColor} 15%, #1a2030)`, zIndex: 10, transition: 'background .15s',
              display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${channelColor} 40%, #1a2030)` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${channelColor} 15%, #1a2030)` }}>
            <div style={{ width: 2, height: 32, borderRadius: 1, background: `color-mix(in srgb, ${channelColor} 60%, transparent)` }} />
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}