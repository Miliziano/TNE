/**
 * src/nodes/XmlSerializerNode.tsx
 * Pattern identico a JsonSerializerNode.
 */
import { memo, useCallback, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NodeRuntimeBadges, HandleCount } from './RuntimeBadges'
import type { NodeData } from '../types'
import { useFlowStore } from '../store/flowStore'
import { XmlSerializerModal } from './types/xml_serializer/XmlSerializerModal'

const ACCENT = '#f97316'
const FLOW_COLORS = ['#f97316','#3ddc84','#ffb347','#a78bfa','#f472b6','#84cc16','#fb923c','#4a9eff']

// ─── IRBadge ─────────────────────────────────────────────────────
interface UIState {
  hasErrors?: boolean; errorCount?: number
  hasWarnings?: boolean; warningCount?: number
  issues?: Array<{ severity: string; message: string; code: string }>
}
function IRBadge({ uiState }: { uiState: UIState }) {
  const [show, setShow] = useState(false)
  const color = uiState.hasErrors ? '#ff5f57' : '#ffb347'
  const count = uiState.hasErrors ? uiState.errorCount : uiState.warningCount
  const icon  = uiState.hasErrors ? 'ti-alert-circle' : 'ti-alert-triangle'
  return (
    <div style={{ position: 'absolute', top: -8, left: -8, zIndex: 10 }}
      onMouseEnter={() => setShow(true)} onMouseLeave={() => setShow(false)}>
      <div style={{ width: 18, height: 18, borderRadius: '50%', background: color, border: '2px solid #0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', boxShadow: `0 0 6px ${color}80` }}>
        <i className={`ti ${icon}`} style={{ fontSize: 9, color: '#0f1117' }} />
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

// ─── XmlSerializerNode ───────────────────────────────────────────
export const XmlSerializerNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData   = data as NodeData
  const selectNode = useFlowStore((s) => s.selectNode)
  const edges      = useFlowStore((s) => s.edges)
  const [showModal, setShowModal] = useState(false)

  const handleClick       = useCallback(() => selectNode(id), [id, selectNode])
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); setShowModal(true)
  }, [])

  const serConfig     = (nodeData.config as any)?.xmlSerializer ?? {}
  const incomingEdges = edges.filter((e) => e.target === id)
  const minHeight     = Math.max(100, incomingEdges.length * 28 + 60)
  const displayName   = String(nodeData.config?.displayName ?? 'XML Serializer')
  const outputField   = String((nodeData.props as any)?.outputField ?? 'xml_output')
  const uiState       = nodeData.uiState as UIState | undefined

  return (
    <div onClick={handleClick} onDoubleClick={handleDoubleClick}
      title="XML Serializer — doppio click per aprire l'editor"
      style={{
        minWidth: 170, minHeight, borderRadius: 8,
        border: `1.5px solid ${selected ? ACCENT : '#4a1a00'}`,
        background: '#1e2535',
        boxShadow: selected ? `0 0 0 2px ${ACCENT}35` : undefined,
        userSelect: 'none', cursor: 'pointer', position: 'relative',
        display: 'flex', flexDirection: 'column',
      }}>
      {uiState && (uiState.hasErrors || uiState.hasWarnings) && <IRBadge uiState={uiState} />}

      {/* Badge editor */}
      <div onClick={(e) => { e.stopPropagation(); setShowModal(true) }}
        style={{ position: 'absolute', top: -8, right: -8, width: 20, height: 20, borderRadius: '50%', background: ACCENT, border: '2px solid #0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10, boxShadow: `0 2px 6px ${ACCENT}60` }}>
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#0f1117' }} />
      </div>

      {/* Handle ingressi */}
      {incomingEdges.length === 0 ? (
        <Handle id="input" type="target" position={Position.Left}
          style={{ top: '50%', background: '#4a5a7a', border: '2px solid #0f1117', width: 10, height: 10, left: -5, transform: 'none' }} />
      ) : (
        incomingEdges.map((edge, idx) => {
          const handle = edge.targetHandle ?? 'input'
          const total  = incomingEdges.length
          const pct    = total === 1 ? 50 : 10 + (idx / (total - 1)) * 80
          const color  = FLOW_COLORS[idx % FLOW_COLORS.length]
          const label  = (serConfig.inputs?.[handle] as any)?.label ?? handle
          return (
            <Handle key={handle} id={handle} type="target" position={Position.Left}
              style={{ top: `${pct}%`, background: color, border: '2px solid #0f1117', width: 10, height: 10, left: -5, transform: 'none' }}
              title={label} />
          )
        })
      )}

      {/* Handle servizio */}
      <Handle id="input_new" type="target" position={Position.Left}
        style={{ top: '75%', background: '#2a3349', border: '2px dashed #4a5a7a', width: 12, height: 12, left: -20, transform: 'none', borderRadius: '50%', opacity: 0.6 }}
        title="Trascina qui per aggiungere un nuovo flusso" />

      {/* Header */}
      <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: `1px solid #4a1a00`, background: selected ? `color-mix(in srgb, ${ACCENT} 12%, #1e2535)` : '#1e2535', borderRadius: '6px 6px 0 0', flexShrink: 0 }}>
        <span style={{ fontSize: 14, color: ACCENT, fontWeight: 700 }}>&lt;/&gt;</span>
        <span style={{ color: ACCENT, fontWeight: 600, fontSize: 12, flex: 1 }}>{displayName}</span>
        <div style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: nodeData.status === 'running' ? '#ffb347' : nodeData.status === 'done' ? '#3ddc84' : nodeData.status === 'error' ? '#ff5f57' : '#4a5a7a', animation: nodeData.status === 'running' ? 'nodePulse 0.6s infinite' : undefined }} />
      </div>

      {/* Body */}
      <div style={{ padding: '6px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {incomingEdges.length === 0 ? (
          <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>Collega un flusso</div>
        ) : (
          incomingEdges.map((edge, idx) => {
            const handle = edge.targetHandle ?? 'input'
            const color  = FLOW_COLORS[idx % FLOW_COLORS.length]
            const label  = (serConfig.inputs?.[handle] as any)?.label ?? handle
            return (
              <div key={handle} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 10, fontFamily: 'monospace', color, flex: 1 }}>{label}</span>
              </div>
            )
          })
        )}
        <div style={{ marginTop: 2, borderTop: '0.5px solid #2a3349', paddingTop: 3, fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace' }}>
          → <code style={{ color: ACCENT }}>{outputField}</code>
        </div>
      </div>

      {/* Handle uscite */}
      <Handle id="output" type="source" position={Position.Right}
        style={{ top: '35%', background: ACCENT, border: '2px solid #0f1117', width: 10, height: 10, right: -5, transform: 'none' }}
        title="output — documento XML" />
      <Handle id="reject" type="source" position={Position.Right}
        style={{ top: '65%', background: '#ff5f57', border: '2px solid #0f1117', width: 10, height: 10, right: -5, transform: 'none' }}
        title="reject" />

      {/* Fase 8: conteggio righe output/reject */}
      <HandleCount nodeId={id} handleId="output" top="35%" color={ACCENT} />
      <HandleCount nodeId={id} handleId="reject" top="65%" color="#ff5f57" />
      <NodeRuntimeBadges nodeId={id} />

      {showModal && <XmlSerializerModal nodeId={id} onClose={() => setShowModal(false)} />}
    </div>
  )
})

XmlSerializerNode.displayName = 'XmlSerializerNode'