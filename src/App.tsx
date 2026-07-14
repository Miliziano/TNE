import { useEffect, useRef, useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { useFlowStore } from './store/flowStore'
import { Toolbar }       from './components/Toolbar'
import { Canvas }        from './components/Canvas'
import { PropertyPanel } from './components/PropertyPanel'
import { BottomDock }     from './components/BottomDock'
import { CodegenPanel }  from './components/CodegenPanel'
import { NODE_DEFS, PALETTE_SECTIONS } from './nodes/registry'
import { dragState }     from './dragState'
import { NodeEditorModal } from './components/NodeEditorModal'
import { LogViewerWindow } from './components/LogViewerWindow'
import './index.css'
import { setupMonitoring } from './monitoring/setup'
import { MonitorPanel } from './monitoring/MonitorPanel'

setupMonitoring({
  mode:       'ui',
  intervalMs: 2000,
})

// ─── Palette item ─────────────────────────────────────────────────
function PaletteItem({ type }: { type: string }) {
  const def = NODE_DEFS[type]

  return (
    <div
      draggable
      onDragStart={(e) => {
        dragState.type = type
        e.dataTransfer.setData('application/flowpilot-node', type)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDragEnd={() => {
        setTimeout(() => { dragState.type = null }, 100)
      }}
      style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '6px 10px',
        cursor: 'grab',
        borderLeft: '2px solid transparent',
        transition: 'all 0.12s',
        userSelect: 'none',
      }}
      onMouseEnter={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.background      = 'var(--color-background-secondary)'
        el.style.borderLeftColor = def.color
      }}
      onMouseLeave={(e) => {
        const el = e.currentTarget as HTMLElement
        el.style.background      = 'transparent'
        el.style.borderLeftColor = 'transparent'
      }}
    >
      <div style={{
        width: 8, height: 8, borderRadius: '50%',
        background: def.color, flexShrink: 0,
      }} />
      <span style={{ fontSize: 12, color: 'var(--color-text-secondary)' }}>
        {def.label}
      </span>
    </div>
  )
}

// ─── Palette ──────────────────────────────────────────────────────
function Palette() {
  return (
    <aside style={{
      width: 155,
      background: 'var(--color-background-primary)',
      borderRight: '0.5px solid var(--color-border-tertiary)',
      display: 'flex', flexDirection: 'column',
      flexShrink: 0, overflowY: 'auto',
    }}>
      <div style={{
        padding: '8px 10px 4px', fontSize: 10, fontWeight: 600,
        color: 'var(--color-text-tertiary)', textTransform: 'uppercase',
        letterSpacing: '.08em',
        borderBottom: '0.5px solid var(--color-border-tertiary)',
      }}>
        Componenti
      </div>

      {PALETTE_SECTIONS.map((section) => (
        <div key={section.label} style={{ padding: '6px 0 2px' }}>
          <div style={{
            fontSize: 10, fontWeight: 600, letterSpacing: '0.1em',
            color: 'var(--color-text-tertiary)', padding: '0 10px 4px',
            textTransform: 'uppercase',
          }}>
            {section.label}
          </div>
          {section.types.map((type) => (
            <PaletteItem key={type} type={type} />
          ))}
        </div>
      ))}

      <div style={{
        marginTop: 'auto', padding: '10px', fontSize: 10,
        color: 'var(--color-text-tertiary)',
        borderTop: '0.5px solid var(--color-border-tertiary)',
        lineHeight: 1.5,
      }}>
        Trascina un componente su una lane.
      </div>
    </aside>
  )
}

// ─── Tab verticale collassato — usato sia da Codegen che da Monitor ──
function SideTab({
  onClick, icon, label, color,
}: {
  onClick: () => void
  icon:    string
  label:   string
  color:   string
}) {
  return (
    <div
      onClick={onClick}
      title={label}
      style={{
        width:          32,
        background:     'var(--color-background-primary)',
        borderLeft:     '0.5px solid var(--color-border-tertiary)',
        display:        'flex',
        flexDirection:  'column',
        alignItems:     'center',
        justifyContent: 'center',
        cursor:         'pointer',
        flexShrink:     0,
        gap:            8,
        transition:     'background .15s',
      }}
      onMouseEnter={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--color-background-secondary)'
      }}
      onMouseLeave={(e) => {
        (e.currentTarget as HTMLElement).style.background = 'var(--color-background-primary)'
      }}
    >
      <i className={`ti ${icon}`} style={{ fontSize: 14, color }} />
      <span style={{
        fontSize:      9,
        color,
        fontWeight:    600,
        textTransform: 'uppercase',
        letterSpacing: '.1em',
        writingMode:   'vertical-rl',
        transform:     'rotate(180deg)',
      }}>
        {label}
      </span>
    </div>
  )
}

// ─── Pannello laterale generico con header e pulsante chiudi ──────
function SidePanel({
  icon, label, color, width = 420, onClose, extraAction, children,
}: {
  icon:     string
  label:    string
  color:    string
  width?:   number
  onClose:  () => void
  /** Azione opzionale nell'header, accanto al pulsante chiudi (es. "stacca") */
  extraAction?: { icon: string; title: string; onClick: () => void }
  children: React.ReactNode
}) {
  return (
    <div style={{
      width,
      minWidth:      320,
      maxWidth:      600,
      display:       'flex',
      flexDirection: 'column',
      background:    'var(--color-background-secondary)',
      borderLeft:    '0.5px solid var(--color-border-tertiary)',
      flexShrink:    0,
      overflow:      'hidden',
    }}>
      {/* Header */}
      <div style={{
        display:      'flex',
        alignItems:   'center',
        gap:          6,
        padding:      '6px 10px',
        background:   'var(--color-background-primary)',
        borderBottom: '0.5px solid var(--color-border-tertiary)',
        flexShrink:   0,
      }}>
        <i className={`ti ${icon}`} style={{ fontSize: 12, color }} />
        <span style={{ fontSize: 11, fontWeight: 600, color, flex: 1 }}>
          {label}
        </span>
        {extraAction && (
          <button
            onClick={extraAction.onClick}
            title={extraAction.title}
            style={{
              background:   'none',
              border:       '0.5px solid var(--color-border-tertiary)',
              borderRadius: 4,
              padding:      '2px 6px',
              cursor:       'pointer',
              color:        'var(--color-text-tertiary)',
              display:      'flex',
              alignItems:   'center',
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)' }}
          >
            <i className={`ti ${extraAction.icon}`} style={{ fontSize: 12 }} />
          </button>
        )}
        <button
          onClick={onClose}
          title="Chiudi"
          style={{
            background:   'none',
            border:       '0.5px solid var(--color-border-tertiary)',
            borderRadius: 4,
            padding:      '2px 6px',
            cursor:       'pointer',
            color:        'var(--color-text-tertiary)',
            display:      'flex',
            alignItems:   'center',
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)' }}
        >
          <i className="ti ti-x" style={{ fontSize: 12 }} />
        </button>
      </div>

      {/* Contenuto */}
      <div style={{ flex: 1, minHeight: 0, overflow: 'hidden' }}>
        {children}
      </div>
    </div>
  )
}

// ─── Layout ───────────────────────────────────────────────────────
function Layout() {
  const [codegenOpen,  setCodegenOpen]  = useState(false)
  const [monitorMode,  setMonitorMode]  = useState<'closed' | 'docked' | 'float'>('closed')

  // Posizione del Monitor flottante: null = ancorato in basso a destra,
  // valorizzata al primo trascinamento (persiste tra stacca/riaggancia).
  const [floatPos, setFloatPos] = useState<{ x: number; y: number } | null>(null)
  const [floatSize, setFloatSize] = useState({ w: 480, h: 440 })
  const floatRef = useRef<HTMLDivElement>(null)

  const startFloatDrag = (e: React.PointerEvent) => {
    const el = floatRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const offX = e.clientX - rect.left
    const offY = e.clientY - rect.top
    const onMove = (ev: PointerEvent) => {
      const x = Math.min(Math.max(ev.clientX - offX, 0), window.innerWidth  - rect.width)
      const y = Math.min(Math.max(ev.clientY - offY, 0), window.innerHeight - 40)
      setFloatPos({ x, y })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
    e.preventDefault()
  }
  const startFloatResize = (e: React.PointerEvent) => {
    const el = floatRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    // Se è ancorata in basso a destra, fissiamo la posizione: altrimenti
    // allargando si sposterebbe il bordo sinistro sotto il puntatore.
    if (!floatPos) setFloatPos({ x: rect.left, y: rect.top })
    const onMove = (ev: PointerEvent) => {
      setFloatSize({
        w: Math.min(Math.max(ev.clientX - rect.left, 380), window.innerWidth  - rect.left - 8),
        h: Math.min(Math.max(ev.clientY - rect.top - 26, 240), window.innerHeight - rect.top - 34),
      })
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup',   onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup',   onUp)
    e.preventDefault()
    e.stopPropagation()
  }

  const [propsOpen,    setPropsOpen]    = useState(false)

  const selectedNodeId     = useFlowStore((s) => s.selectedNodeId)
  const selectedLaneId     = useFlowStore((s) => s.selectedLaneId)
  const selectedResourceId = useFlowStore((s) => s.selectedResourceId)

  // Il pannello Proprietà è contestuale: si apre da solo alla selezione
  // di nodo/lane/risorsa e si chiude alla deselezione totale.
  useEffect(() => {
    setPropsOpen(!!(selectedNodeId || selectedLaneId || selectedResourceId))
  }, [selectedNodeId, selectedLaneId, selectedResourceId])

  return (
    <div style={{
      display:       'flex',
      flexDirection: 'column',
      height:        '100vh',
      overflow:      'hidden',
      background:    'var(--color-background-tertiary)',
      color:         'var(--color-text-primary)',
      fontFamily:    'var(--font-sans)',
    }}>
      <Toolbar />

      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        <Palette />
        <Canvas />

        {/* ── Pannello Proprietà (contestuale, a scomparsa) ── */}
        {propsOpen ? (
          <div style={{ position: 'relative', flexShrink: 0, display: 'flex' }}>
            <PropertyPanel />
            <button
              onClick={() => setPropsOpen(false)}
              title="Chiudi pannello Proprietà"
              style={{
                position: 'absolute', top: 6, right: 6, zIndex: 5,
                width: 20, height: 20, padding: 0,
                background: 'transparent', border: 'none',
                color: 'var(--color-text-tertiary)', cursor: 'pointer',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                fontSize: 12, lineHeight: 1,
              }}
            >
              <i className="ti ti-x" />
            </button>
          </div>
        ) : (
          <SideTab
            onClick={() => setPropsOpen(true)}
            icon="ti-adjustments" label="Proprietà" color="#8a9ac0" />
        )}

        {/* ── Pannello Codegen ── */}
        {codegenOpen ? (
          <SidePanel
            icon="ti-code" label="Code Generator" color="#22d3ee"
            onClose={() => setCodegenOpen(false)}>
            <CodegenPanel />
          </SidePanel>
        ) : (
          <SideTab
            onClick={() => setCodegenOpen(true)}
            icon="ti-code" label="Codegen" color="#22d3ee" />
        )}

        {/* ── Pannello Monitor ── */}
        {monitorMode === 'docked' ? (
          <SidePanel
            icon="ti-chart-line" label="Monitor" color="#a78bfa"
            onClose={() => setMonitorMode('closed')}
            extraAction={{
              icon: 'ti-picture-in-picture-top',
              title: 'Stacca in finestra flottante',
              onClick: () => setMonitorMode('float'),
            }}>
            <MonitorPanel position="right" />
          </SidePanel>
        ) : (
          <SideTab
            onClick={() => setMonitorMode('docked')}
            icon="ti-chart-line" label="Monitor" color="#a78bfa" />
        )}
      </div>

      {/* ── Monitor flottante (staccato dal dock) ── */}
      {monitorMode === 'float' && (
        <div ref={floatRef} style={{
          position:      'fixed',
          ...(floatPos ? { left: floatPos.x, top: floatPos.y } : { bottom: 16, right: 16 }),
          width:         floatSize.w,
          zIndex:        9000,
          display:       'flex',
          flexDirection: 'column',
          background:    '#0f1117',
          border:        '0.5px solid #2a3349',
          borderRadius:  8,
          boxShadow:     '0 8px 32px rgba(0,0,0,.7)',
          overflow:      'hidden',
        }}>
          <div
            onPointerDown={startFloatDrag}
            style={{
              display:        'flex',
              alignItems:     'center',
              gap:            4,
              padding:        '3px 6px',
              background:     '#161b27',
              cursor:         'grab',
              userSelect:     'none',
              touchAction:    'none',
            }}>
            <i className="ti ti-grip-horizontal" style={{ fontSize: 13, color: 'var(--color-text-tertiary)', flex: 1 }} />
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setMonitorMode('docked')}
              title="Riaggancia al dock"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', padding: 2 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#a78bfa' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)' }}
            >
              <i className="ti ti-layout-sidebar-right-expand" style={{ fontSize: 13 }} />
            </button>
            <button
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => setMonitorMode('closed')}
              title="Chiudi"
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--color-text-tertiary)', display: 'flex', alignItems: 'center', padding: 2 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = 'var(--color-text-tertiary)' }}
            >
              <i className="ti ti-x" style={{ fontSize: 13 }} />
            </button>
          </div>
          <MonitorPanel position="bottom" height={floatSize.h} />

          {/* Maniglia di ridimensionamento */}
          <div
            onPointerDown={startFloatResize}
            title="Ridimensiona"
            style={{
              position: 'absolute', bottom: 0, right: 0,
              width: 16, height: 16,
              cursor: 'nwse-resize', touchAction: 'none',
              display: 'flex', alignItems: 'flex-end', justifyContent: 'flex-end',
              color: '#4a5a7a',
            }}
          >
            <i className="ti ti-chevron-down-right" style={{ fontSize: 12 }} />
          </div>
        </div>
      )}
       

      <BottomDock />
      <NodeEditorModal />
    </div>
  )
}

// ─── Root ─────────────────────────────────────────────────────────
export default function App() {
  return (
    <ReactFlowProvider>
      <LogViewerWindow />
      <Layout />
    </ReactFlowProvider>
  )
}