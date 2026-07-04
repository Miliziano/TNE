/**
 * src/nodes/FilterNode.tsx
 * Badge #N di priorità visibili accanto agli handle di uscita.
 */
import { memo, useCallback } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NodeRuntimeBadges } from './RuntimeBadges'
import type { NodeData } from '../types'
import { useFlowStore } from '../store/flowStore'
import type { FilterConfig } from './types/filter/filterTypes'

const ACCENT = '#ffb347'

interface UIState {
  hasErrors?: boolean; errorCount?: number
  hasWarnings?: boolean; warningCount?: number
  issues?: Array<{ severity: string; message: string; code: string }>
}

function IRBadge({ uiState }: { uiState: UIState }) {
  const [show, setShow] = useState(false)
  const color = uiState.hasErrors ? '#ff5f57' : '#ffb347'
  const count = uiState.hasErrors ? uiState.errorCount : uiState.warningCount
  return (
    <div style={{ position: 'absolute', top: -8, left: -8, zIndex: 10 }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: color, border: '2px solid #0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 6px ${color}80` }}>
        <i className={`ti ${uiState.hasErrors ? 'ti-alert-circle' : 'ti-alert-triangle'}`} style={{ fontSize: 9, color: '#0f1117' }} />
        {(count ?? 0) > 1 && <span style={{ position: 'absolute', top: -4, right: -4, background: color, color: '#0f1117', fontSize: 9, fontWeight: 700, borderRadius: 8, padding: '0 3px', minWidth: 12, textAlign: 'center', lineHeight: '12px', border: '1px solid #0f1117' }}>{count}</span>}
      </div>
      {show && (uiState.issues?.length ?? 0) > 0 && (
        <div style={{ position: 'absolute', top: 22, left: 0, minWidth: 220, maxWidth: 280, background: '#1a2030', border: `1px solid ${color}60`, borderRadius: 6, padding: '4px 0', boxShadow: '0 8px 24px rgba(0,0,0,.7)', zIndex: 1000, pointerEvents: 'none' }}>
          {uiState.issues!.map((issue, i) => (
            <div key={i} style={{ padding: '4px 10px', fontSize: 10, color: issue.severity === 'error' ? '#ff5f57' : '#ffb347', borderBottom: i < uiState.issues!.length - 1 ? '0.5px solid #2a3349' : 'none', display: 'flex', gap: 6 }}>
              <i className={`ti ${issue.severity === 'error' ? 'ti-alert-circle' : 'ti-alert-triangle'}`} style={{ fontSize: 10, flexShrink: 0 }} />
              <span style={{ lineHeight: 1.4 }}>{issue.message}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Badge priorità handle ────────────────────────────────────────
function PriorityBadge({ n, color, top }: { n: number; color: string; top: string }) {
  return (
    <div style={{
      position: 'absolute',
      right: 16,
      top,
      transform: 'translateY(-50%)',
      fontSize: 9,
      fontFamily: 'monospace',
      color: `${color}90`,
      background: `color-mix(in srgb, ${color} 12%, #0f1117)`,
      border: `0.5px solid ${color}30`,
      borderRadius: 4,
      padding: '0 4px',
      lineHeight: '14px',
      pointerEvents: 'none',
      zIndex: 1,
    }}>
      #{n}
    </div>
  )
}

// ─── Fix: import useState ────────────────────────────────────────
import { useState } from 'react'

export const FilterNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData       = data as NodeData
  const selectNode     = useFlowStore((s) => s.selectNode)
  const openNodeEditor = useFlowStore((s) => s.openNodeEditor)

  const config     = nodeData.config?.filter as FilterConfig | undefined
  const conditions = config?.conditions ?? []
  const execMode   = (config as any)?.execMode ?? 'parallel'

  const handleClick       = useCallback(() => selectNode(id), [id, selectNode])
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); openNodeEditor(id)
  }, [id, openNodeEditor])

  const displayName = nodeData.config?.displayName || 'Filter'
  const handleCount = conditions.length + 1
  const minHeight   = Math.max(90, handleCount * 28 + 64)
  const uiState     = nodeData.uiState

  // Calcola la posizione % verticale di ogni handle
  // Distribuisce uniformemente lasciando margine in alto e in basso
  const total      = conditions.length + 1  // +1 per reject
  const getPct     = (idx: number) => total <= 1 ? 35 : 12 + (idx / (total - 1)) * 72

  // Icona modalità esecuzione
  const execIcon = execMode === 'ordered_wait' ? '⏱' : execMode === 'sequential' ? '→' : '⇉'
  const execTitle = execMode === 'ordered_wait' ? 'Ordinato con attesa' : execMode === 'sequential' ? 'Sequenziale' : 'Parallelo'

  return (
    <div
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title="Filter — doppio click per configurare"
      style={{
        minWidth: 170, minHeight, borderRadius: 8,
        border: `1.5px solid ${selected ? ACCENT : '#3a2a0a'}`,
        background: '#1e2535',
        boxShadow: selected ? `0 0 0 2px rgba(255,179,71,0.35)` : undefined,
        userSelect: 'none', cursor: 'pointer',
        position: 'relative', display: 'flex', flexDirection: 'column',
      }}
    >
      {uiState && (uiState.hasErrors || uiState.hasWarnings) && <IRBadge uiState={uiState} />}

      {/* Badge settings */}
      <div onClick={(e) => { e.stopPropagation(); openNodeEditor(id) }} title="Configura Filter"
        style={{ position: 'absolute', top: -8, right: -8, width: 20, height: 20, borderRadius: '50%', background: ACCENT, border: '2px solid #0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10, boxShadow: `0 2px 6px rgba(255,179,71,0.4)` }}>
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#0f1117' }} />
      </div>

      {/* Handle ingresso */}
      <Handle id="input" type="target" position={Position.Left}
        style={{ background: ACCENT, border: '2px solid #0f1117', width: 10, height: 10 }} />

      {/* Header */}
      <div style={{
        padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 5,
        borderBottom: '1px solid #3a2a0a',
        background: selected ? `color-mix(in srgb, ${ACCENT} 12%, #1e2535)` : '#1e2535',
        borderRadius: '6px 6px 0 0', flexShrink: 0,
      }}>
        <span style={{ color: ACCENT, fontSize: 13 }}>⊻</span>
        <span style={{ color: ACCENT, fontWeight: 600, fontSize: 11, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayName}
        </span>
        {/* Icona modalità esecuzione */}
        <span title={execTitle} style={{ fontSize: 9, color: `${ACCENT}70`, marginRight: 2 }}>{execIcon}</span>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: nodeData.status === 'running' ? '#ffb347' : nodeData.status === 'done' ? '#3ddc84' : nodeData.status === 'error' ? '#ff5f57' : '#4a5a7a',
        }} />
      </div>

      {/* Body — lista condizioni con numero priorità */}
      <div style={{ padding: '5px 8px 5px 8px', flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {conditions.length === 0 ? (
          <div style={{ fontSize: 9, color: '#2a3349', fontStyle: 'italic', marginTop: 2 }}>
            nessuna condizione
          </div>
        ) : (
          conditions.map((cond, idx) => (
            <div key={cond.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 9, color: `${cond.color}50`, fontFamily: 'monospace', minWidth: 14, flexShrink: 0 }}>
                #{idx + 1}
              </span>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: cond.color, flexShrink: 0 }} />
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: cond.color, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {cond.label}
              </span>
              <span style={{ fontSize: 7, color: '#4a5a7a', flexShrink: 0 }}>
                {cond.mode === 'code' ? 'λ' : cond.mode === 'template' ? '⚡' : '⊞'}
              </span>
            </div>
          ))
        )}
        {/* Reject */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
          <span style={{ fontSize: 9, color: '#ff5f5740', fontFamily: 'monospace', minWidth: 14, flexShrink: 0 }}>
            #{conditions.length + 1}
          </span>
          <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#ff5f57' }} />
          <span style={{ fontSize: 9, color: '#ff5f57' }}>reject</span>
        </div>
      </div>

      {/* Handle uscita per ogni condizione + badge priorità */}
      {conditions.map((cond, idx) => {
        const pct = `${getPct(idx)}%`
        return (
          <div key={cond.id}>
            <PriorityBadge n={idx + 1} color={cond.color} top={pct} />
            <Handle id={cond.id} type="source" position={Position.Right}
              style={{ top: pct, background: cond.color, border: '2px solid #0f1117', width: 10, height: 10, right: -5, transform: 'none' }}
              title={`#${idx + 1} ${cond.label} — ${cond.mode}`} />
          </div>
        )
      })}

      {/* Handle reject + badge */}
      <PriorityBadge n={conditions.length + 1} color="#ff5f57" top={`${getPct(conditions.length)}%`} />
      <Handle id="reject" type="source" position={Position.Right}
        style={{ top: `${getPct(conditions.length)}%`, background: '#ff5f57', border: '2px solid #0f1117', width: 10, height: 10, right: -5, transform: 'none' }}
        title={`#${conditions.length + 1} reject`} />
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})
FilterNode.displayName = 'FilterNode'