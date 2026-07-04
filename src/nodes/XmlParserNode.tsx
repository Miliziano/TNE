import { memo, useCallback, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeData } from '../types'
import { useFlowStore } from '../store/flowStore'
import type { XmlParserConfig } from './types/xml_parser/xmlParserTypes'
import { XmlParserModal } from './types/xml_parser/XmlParserModal'
import { NodeRuntimeBadges, HandleCount } from './RuntimeBadges'

const FLOW_COLORS = [
  '#4a9eff', '#3ddc84', '#ffb347', '#a78bfa', '#f97316',
  '#f472b6', '#84cc16', '#fb923c', '#e879f9', '#ff5f57',
]

const ACCENT = '#f97316'

export const XmlParserNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData   = data as NodeData
  const selectNode = useFlowStore((s) => s.selectNode)
  const [showModal, setShowModal] = useState(false)

  const config    = nodeData.config?.xmlParser as XmlParserConfig | undefined
  const flows     = config?.flows ?? []
  const hasReject = config?.hasReject ?? false

  const handleClick       = useCallback(() => selectNode(id), [id, selectNode])
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    setShowModal(true)
  }, [])

  const displayName = nodeData.config?.displayName || 'XML Parser'
  const sourceField = config?.sourceField || '—'
  const nsIgnored    = config?.ignoreNamespaces ?? false

  const handleCount = flows.length + (hasReject ? 1 : 0)
  const minHeight   = Math.max(80, handleCount * 24 + 64)

  const uiState = nodeData.uiState

  return (
    <div
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title="XML Parser — doppio click per configurare"
      style={{
        minWidth:     160,
        minHeight,
        borderRadius: 8,
        border:       `1.5px solid ${selected ? ACCENT : '#3a1a00'}`,
        background:   '#1e2535',
        boxShadow:    selected ? `0 0 0 2px rgba(249,115,22,0.35)` : undefined,
        userSelect:   'none',
        cursor:       'pointer',
        position:     'relative',
        display:      'flex',
        flexDirection: 'column',
      }}
    >
      {/* ── Badge IR errori/warning ── */}
      {uiState && (uiState.hasErrors || uiState.hasWarnings) && (
        <IRBadge uiState={uiState} />
      )}

      {/* ── Badge editor — sempre visibile, angolo in alto a destra ── */}
      <div
        onClick={(e) => { e.stopPropagation(); setShowModal(true) }}
        title="Apri configuratore XML Parser"
        style={{
          position:       'absolute',
          top:            -8,
          right:          -8,
          width:          20,
          height:         20,
          borderRadius:   '50%',
          background:     ACCENT,
          border:         '2px solid #0f1117',
          display:        'flex',
          alignItems:     'center',
          justifyContent: 'center',
          cursor:         'pointer',
          zIndex:         10,
          boxShadow:      `0 2px 6px rgba(249,115,22,0.4)`,
        }}
      >
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#fff' }} />
      </div>

      {/* ── Handle ingresso ── */}
      <Handle
        type="target"
        id="input"
        position={Position.Left}
        style={{ background: ACCENT, border: '2px solid #0f1117', width: 10, height: 10 }}
      />

      {/* ── Header ── */}
      <div style={{
        padding:      '5px 8px',
        display:      'flex',
        alignItems:   'center',
        gap:          5,
        borderBottom: `1px solid #3a1a00`,
        background:   selected ? `color-mix(in srgb, ${ACCENT} 12%, #1e2535)` : '#1e2535',
        borderRadius: '6px 6px 0 0',
        flexShrink:   0,
      }}>
        <span style={{ color: ACCENT, fontSize: 13, fontFamily: 'monospace', fontWeight: 700 }}>&lt;/&gt;</span>
        <span style={{ color: ACCENT, fontWeight: 600, fontSize: 11, flex: 1, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {displayName}
        </span>
        {/* Dot di stato */}
        <div style={{
          width:        7,
          height:       7,
          borderRadius: '50%',
          flexShrink:   0,
          background:   nodeData.status === 'running' ? '#ffb347'
                      : nodeData.status === 'done'    ? '#3ddc84'
                      : nodeData.status === 'error'   ? '#ff5f57'
                      : '#4a5a7a',
          animation:    nodeData.status === 'running' ? 'nodePulse 0.6s infinite' : undefined,
        }} />
      </div>

      {/* ── Body ── */}
      <div style={{ padding: '5px 8px', flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ fontSize: 9, color: ACCENT, flexShrink: 0, fontFamily: 'monospace' }}>&lt;</span>
          <code style={{ fontSize: 9, color: '#9a9aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {sourceField}
          </code>
          {nsIgnored && (
            <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }} title="Namespace ignorati">·ns off</span>
          )}
        </div>

        {flows.length > 0 && (
          <div style={{ borderTop: '0.5px solid #2a3349', marginTop: 2, paddingTop: 3, display: 'flex', flexDirection: 'column', gap: 2 }}>
            {flows.map((flow, idx) => (
              <div key={flow.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: flow.color ?? FLOW_COLORS[idx % FLOW_COLORS.length], flexShrink: 0 }} />
                <span style={{ fontSize: 9, fontFamily: 'monospace', color: flow.color ?? FLOW_COLORS[idx % FLOW_COLORS.length], flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {flow.label}
                </span>
                {flow.isRepeating && <span style={{ fontSize: 7, color: '#4a5a7a' }}>[ ]</span>}
                {flow.streaming && <i className="ti ti-wave-sine" style={{ fontSize: 7, color: '#ffb347' }} />}
              </div>
            ))}
          </div>
        )}

        {flows.length === 0 && (
          <div style={{ fontSize: 9, color: '#2a3349', fontStyle: 'italic', marginTop: 2 }}>nessun flusso configurato</div>
        )}

        {hasReject && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 1 }}>
            <div style={{ width: 5, height: 5, borderRadius: '50%', background: '#ff5f57' }} />
            <span style={{ fontSize: 9, color: '#ff5f57' }}>reject</span>
          </div>
        )}
      </div>

      {/* ── Handle uscita per ogni flusso ── */}
      {flows.map((flow, idx) => {
        const total = flows.length + (hasReject ? 1 : 0)
        const pct   = total <= 1 ? 50 : 10 + (idx / (total - 1)) * 80
        const color = flow.color ?? FLOW_COLORS[idx % FLOW_COLORS.length]
        return (
          <Handle key={flow.id} id={flow.id} type="source" position={Position.Right}
            style={{ top: `${pct}%`, background: color, border: '2px solid #0f1117', width: 10, height: 10, right: -5, transform: 'none' }}
            title={`${flow.label} — ${flow.xpath}`} />
        )
      })}

      {/* ── Handle reject ── */}
      {hasReject && (() => {
        const total = flows.length + 1
        const pct   = total <= 1 ? 80 : 10 + (flows.length / (total - 1)) * 80
        return (
          <Handle id="reject" type="source" position={Position.Right}
            style={{ top: `${pct}%`, background: '#ff5f57', border: '2px solid #0f1117', width: 10, height: 10, right: -5, transform: 'none' }}
            title="Flusso reject" />
        )
      })()}

      {/* Fase 8: conteggio righe per ciascun flusso + reject */}
      {flows.map((flow, idx) => {
        const total = flows.length + (hasReject ? 1 : 0)
        const pct   = total <= 1 ? 50 : 10 + (idx / (total - 1)) * 80
        const color = flow.color ?? FLOW_COLORS[idx % FLOW_COLORS.length]
        return <HandleCount key={`count_${flow.id}`} nodeId={id} handleId={flow.id} top={`${pct}%`} color={color} />
      })}
      {hasReject && (() => {
        const total = flows.length + 1
        const pct   = total <= 1 ? 80 : 10 + (flows.length / (total - 1)) * 80
        return <HandleCount nodeId={id} handleId="reject" top={`${pct}%`} color="#ff5f57" />
      })()}
      <NodeRuntimeBadges nodeId={id} />

      {showModal && <XmlParserModal nodeId={id} onClose={() => setShowModal(false)} />}
    </div>
  )
})

XmlParserNode.displayName = 'XmlParserNode'

// ─── IRBadge ──────────────────────────────────────────────────────
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