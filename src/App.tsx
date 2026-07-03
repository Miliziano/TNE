import { useState } from 'react'
import { ReactFlowProvider } from '@xyflow/react'
import { Toolbar }       from './components/Toolbar'
import { Canvas }        from './components/Canvas'
import { PropertyPanel } from './components/PropertyPanel'
import { LogPanel }      from './components/LogPanel'
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
  icon, label, color, width = 420, onClose, children,
}: {
  icon:     string
  label:    string
  color:    string
  width?:   number
  onClose:  () => void
  children: React.ReactNode
}) {
  return (
    <div style={{
      width,
      minWidth:      320,
      maxWidth:      600,
      display:       'flex',
      flexDirection: 'column',
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
  const [monitorOpen,  setMonitorOpen]  = useState(false)

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
        <PropertyPanel />

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
        {monitorOpen ? (
          <SidePanel
            icon="ti-chart-line" label="Monitor" color="#a78bfa"
            onClose={() => setMonitorOpen(false)}>
            <MonitorPanel position="right" />
          </SidePanel>
        ) : (
          <SideTab
            onClick={() => setMonitorOpen(true)}
            icon="ti-chart-line" label="Monitor" color="#a78bfa" />
        )}
      </div>

      <LogPanel />
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