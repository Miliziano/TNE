import { memo } from 'react'
import { getNodePorts } from '../utils/schemaRegistry'
import { isRejectPort } from '../ir/types'
import { ValidationBadge } from "./ValidationBadge"
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeData, NodeStatus } from '../types'
import { NODE_DEFS } from './registry'
import { useFlowStore } from '../store/flowStore'
import type { NodeRunStats } from '../store/flowStore'
import { getNodeSubtitle } from './nodeSubtitle'


const STATUS_COLORS: Record<NodeStatus, string> = {
  idle:    '#4a5a7a',
  running: '#ffb347',
  done:    '#3ddc84',
  error:   '#ff5f57',
  warning: '#ffb347',
  ok:    '#3ddc84',
}

const CATEGORY_BORDER: Record<string, string> = {
  input:     '#1a3a6a',
  transform: '#3d2a0a',
  output:    '#0d3d20',
}

// Colore handle catch — arancione per distinguerlo da reject (rosso) e output (verde/colore nodo)
const CATCH_COLOR = '#f97316'

// ── Fase 8: StatusDot ──────────────────────────────────────────
// Pallino stato runtime: grigio (idle) / giallo pulse (running) /
// verde (done|ok) / rosso (error). Lo stato runtime dal Rust engine
// (nodeStats) ha precedenza su quello statico del nodo.
function StatusDot({ status }: { status: NodeStatus }) {
  return (
    <div style={{
      width: 7, height: 7, borderRadius: '50%',
      background: STATUS_COLORS[status] ?? '#4a5a7a',
      flexShrink: 0,
      animation: status === 'running' ? 'nodePulse 0.6s infinite' : undefined,
      boxShadow: status === 'running' ? `0 0 6px ${STATUS_COLORS.running}` : undefined,
    }} />
  )
}

// ── Fase 8: CounterBadge ───────────────────────────────────────
// Badge contatori sotto il nodo: righe in ingresso / uscita + tempo.
// Visibile solo quando il nodo ha prodotto/consumato qualcosa o sta girando.
function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000)    return `${Math.round(n / 1_000)}k`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

function fmtElapsed(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000)  return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

function CounterBadge({ stats }: { stats: NodeRunStats }) {
  const active = stats.status !== 'idle' || stats.rowsIn > 0 || stats.rowsOut > 0
  if (!active) return null
  const color = STATUS_COLORS[stats.status] ?? '#4a5a7a'
  return (
    <div style={{
      position: 'absolute', bottom: -22, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '1px 8px', borderRadius: 8, whiteSpace: 'nowrap',
      background: `color-mix(in srgb, ${color} 12%, #0f1117)`,
      border: `1px solid ${color}50`,
      fontFamily: 'monospace', fontSize: 9, fontWeight: 600, color,
      zIndex: 9, cursor: 'default', userSelect: 'none', pointerEvents: 'none',
    }}>
      <span title="righe in ingresso">↓ {fmtRows(stats.rowsIn)}</span>
      <span title="righe in uscita">↑ {fmtRows(stats.rowsOut)}</span>
      {stats.elapsedMs != null && stats.elapsedMs > 0 && (
        <span style={{ opacity: 0.75 }}>{fmtElapsed(stats.elapsedMs)}</span>
      )}
    </div>
  )
}

export const FlowNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData       = data as NodeData
  const def            = NODE_DEFS[nodeData.type]
  const selectNode     = useFlowStore((s) => s.selectNode)
  const openNodeEditor = useFlowStore((s) => s.openNodeEditor)
  // Fase 8: statistiche runtime dal polling del Rust engine
  const stats          = useFlowStore((s) => s.nodeStats[id])

  if (!def) return null

  const borderColor  = selected ? '#4a9eff' : (CATEGORY_BORDER[def.category] ?? '#2a3349')
  // Lo stato runtime (Rust engine) ha precedenza su quello statico del nodo
  const runStatus: NodeStatus = stats?.status ?? nodeData.status
  const displayName  = nodeData.config?.displayName || def.label
  const subtitle = (() => {
    const label = (nodeData.config as Record<string, unknown> | undefined)?.shortLabel
    if (typeof label === 'string' && label.trim() !== '') return label
    return getNodeSubtitle(nodeData)
  })()

  const isBuffered = nodeData.type === 'sink_file' && nodeData.props?.['passthrough'] === 'true'

  // Badge transazione: il nodo porta solo transactionId; mode/nome
  // vivono sull'oggetto-transazione della lane (design v2).
  const pool = useFlowStore((s) => s.pool)
  const txConfig = (() => {
    const txId = nodeData.props?.['transactionId']
    if (!txId) return null
    const lane = pool.lanes.find((l) => l.id === nodeData.laneId)
    const tx = (lane?.transactions ?? []).find((t) => t.id === txId)
    return tx ? { mode: tx.mode, name: tx.name } : null
  })()
  const txColor = txConfig?.mode === 'xa' ? '#ffb347' : '#3ddc84'

  // ── onError: propagate → badge catch ──────────────────────────
  const onError    = (nodeData.config?.advanced?.onError) ?? 'stop'
  const hasCatch   = onError === 'propagate'

  // ── Handle di uscita ──────────────────────────────────────────
  // Qui c'era `{ id: 'output', show: true, ... }`: il canvas disegnava
  // un'uscita su OGNI nodo, sempre, senza chiedere a nessuno. Da un
  // bridge_out o da un sink si poteva così tirare un arco che l'IR non
  // conosceva e il motore non percorreva: a valle non arrivava niente,
  // in silenzio. Ora le porte le dichiara il contratto e qui non si
  // decide più nulla — catch e reject condizionale compresi.
  const outputHandles = getNodePorts({ data: nodeData }).outputs.map((p) => ({
    id:    p.id,
    label: p.role === 'catch' ? '⚡ catch' : p.label,
    color: p.role === 'catch' ? CATCH_COLOR
         : isRejectPort(p)    ? '#ff5f57'
         : def.color,
  }))

  // Distribuisce gli handle visibili verticalmente
  const visibleCount = outputHandles.length
  const handleTop = (idx: number) =>
    visibleCount === 1 ? '50%' : `${15 + (idx / (visibleCount - 1)) * 70}%`

  const uiState = nodeData.uiState

  return (
    <div
      onClick={() => selectNode(id)}
      onDoubleClick={() => { if (nodeData.type !== 'tmap' ) openNodeEditor(id) }}
      
      style={{
        border: `1.5px solid ${borderColor}`,
        boxShadow: selected ? '0 0 0 2px rgba(74,158,255,0.4)' : undefined,
        minWidth: 130, borderRadius: 8, background: '#1e2535',
        cursor: 'pointer', userSelect: 'none', position: 'relative',
      }}
    >
      {uiState && (uiState.hasErrors || uiState.hasWarnings) && <ValidationBadge uiState={uiState} />}

      {/* Badge editor */}
      <div
        onClick={(e) => { e.stopPropagation(); if (nodeData.type !== 'tmap'  ) openNodeEditor(id) }}
        title="Apri editor"
        style={{
          position: 'absolute', top: -8, right: -8,
          width: 20, height: 20, borderRadius: '50%',
          background: '#4a9eff', border: '2px solid #0f1117',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', zIndex: 10,
        }}
      >
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#fff' }} aria-hidden="true" />
      </div>

      {/* Handle ingresso */}
      <Handle
        id="input"
        type="target"
        position={Position.Left}
        style={{ background: '#4a5a7a', border: '2px solid #0f1117', width: 10, height: 10 }}
      />

      {/* Header */}
      <div style={{
        padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
        borderBottom: `1px solid ${CATEGORY_BORDER[def.category] ?? '#2a3349'}`,
      }}>
        <span style={{ color: def.color, fontSize: 14 }}>{def.icon}</span>
        <span style={{ color: def.color, fontWeight: 600, fontSize: 12, flex: 1 }}>{displayName}</span>
        <StatusDot status={runStatus} />
      </div>

      {/* Anteprima */}
      <div style={{
        padding: '5px 10px', fontSize: 11, color: '#9a9aaa',
        fontFamily: 'monospace', whiteSpace: 'nowrap', overflow: 'hidden',
        textOverflow: 'ellipsis', maxWidth: 160,
      }}>
        {subtitle || '\u00a0'}
      </div>

      {/* Badge buffered */}
      {isBuffered && (
        <div style={{ padding: '2px 10px 5px', display: 'flex', alignItems: 'center', gap: 4 }}>
          <i className="ti ti-stack" style={{ fontSize: 9, color: '#ffb347' }} />
          <span style={{ fontSize: 9, color: '#ffb347', fontStyle: 'italic' }}>buffered output</span>
        </div>
      )}

      {/* Badge catch — visibile nel corpo del nodo quando propagate attivo */}
      {hasCatch && (
        <div style={{
          padding: '2px 10px 5px', display: 'flex', alignItems: 'center', gap: 4,
        }}>
          <i className="ti ti-bug" style={{ fontSize: 9, color: CATCH_COLOR }} />
          <span style={{ fontSize: 9, color: CATCH_COLOR, fontStyle: 'italic' }}>catch attivo</span>
        </div>
      )}

      {/* Handle uscita — output, catch, reject distribuiti verticalmente */}
      {outputHandles.map((h, idx) => (
        <Handle
          key={h.id}
          id={h.id}
          type="source"
          position={Position.Right}
          style={{
            background: h.color,
            border: '2px solid #0f1117',
            width: 10, height: 10,
            top: handleTop(idx),
            right: -5,
            transform: 'none',
          } as React.CSSProperties}
          title={h.label}
        />
      ))}

      {/* Etichette handle uscita — solo se più di uno */}
      {visibleCount > 1 && outputHandles.map((h, idx) => (
        <div key={`lbl_${h.id}`} style={{
          position:   'absolute',
          right:      14,
          top:        `calc(${handleTop(idx)} - 7px)`,
          fontSize:   8,
          color:      h.color,
          fontFamily: 'monospace',
          fontWeight: 600,
          pointerEvents: 'none',
          userSelect: 'none',
          textAlign:  'right',
        }}>
          {h.label}
        </div>
      ))}

      {/* Badge transazione */}
      {txConfig && (
        <div
          title={`Transazione ${txConfig.mode === 'xa' ? 'XA' : 'nativa'} · gruppo "${txConfig.name}"}s`}
          style={{
            position: 'absolute', bottom: -11, left: -11,
            display: 'flex', alignItems: 'center', gap: 3,
            padding: '1px 7px 1px 5px', borderRadius: 8,
            background: `color-mix(in srgb, ${txColor} 15%, #0f1117)`,
            border: `1px solid ${txColor}60`,
            boxShadow: `0 0 6px ${txColor}30`,
            zIndex: 10, cursor: 'default', userSelect: 'none',
          }}>
          <i className="ti ti-lock" style={{ fontSize: 9, color: txColor }} />
          <span style={{ fontSize: 9, color: txColor, fontFamily: 'monospace', fontWeight: 600 }}>
            {txConfig.mode === 'xa' ? 'XA' : 'TX'} {txConfig.mode}
          </span>
        </div>
      )}

      {/* Fase 8: contatori runtime sotto il nodo */}
      {stats && <CounterBadge stats={stats} />}
    </div>
  )
})

FlowNode.displayName = 'FlowNode'