/**
 * src/nodes/types/join/JoinNode.tsx
 */
import { memo, useCallback } from 'react'
import { ValidationBadge } from "../../ValidationBadge"
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NodeRuntimeBadges } from '../../RuntimeBadges'
import type { NodeData, NodeStatus } from '../../../types'
import { useFlowStore } from '../../../store/flowStore'

const STATUS_COLORS: Record<NodeStatus, string> = {
  idle:    '#4a5a7a',
  running: '#ffb347',
  done:    '#3ddc84',
  error:   '#ff5f57',
  warning: '#ffb347',
  ok:      '#3ddc84',
}

const LEFT_COLOR   = '#4a9eff'
const LOOKUP_COLOR = '#22d3ee'
const BORDER_COLOR = '#3d2a0a'

export const JoinNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData       = data as NodeData
  const selectNode     = useFlowStore((s) => s.selectNode)
  const openNodeEditor = useFlowStore((s) => s.openNodeEditor)

  const handleClick       = useCallback(() => selectNode(id), [id, selectNode])
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); openNodeEditor(id)
  }, [id, openNodeEditor])

  const displayName = nodeData.config?.displayName || 'Join'
  const joinType    = nodeData.props?.['join_type']       ?? 'inner'
  const rightSource = nodeData.props?.['rightSource']     ?? 'stream'
  const matName     = nodeData.props?.['materializeName'] ?? ''
  const leftKey     = nodeData.props?.['leftKey']         ?? ''
  const rightKey    = nodeData.props?.['rightKey']        ?? ''
  const statusColor = STATUS_COLORS[nodeData.status]
  const borderColor = selected ? LEFT_COLOR : BORDER_COLOR
  const uiState     = nodeData.uiState

  const lookupLabel = rightSource === 'materialize' ? `◈ ${matName || 'materialize'}`
                    : rightSource === 'inline'       ? '⬡ inline query'
                    : '→ stream'

  const joinColor = joinType === 'anti'   ? '#ff5f57'
                  : joinType === 'semi'   ? '#3ddc84'
                  : joinType === 'cross'  ? '#ffb347'
                  : joinType === 'custom' ? '#a78bfa'
                  : LEFT_COLOR

  return (
    <div onClick={handleClick} onDoubleClick={handleDoubleClick}
     
      style={{
        minWidth: 170, minHeight: 120,
        borderRadius: 8, background: '#1e2535',
        border: `1.5px solid ${borderColor}`,
        boxShadow: selected ? `0 0 0 2px ${LEFT_COLOR}40` : undefined,
        cursor: 'pointer', userSelect: 'none',
        position: 'relative', display: 'flex', flexDirection: 'column',
      }}>

      {uiState && (uiState.hasErrors || uiState.hasWarnings) && <ValidationBadge uiState={uiState} />}

      {/* Badge editor */}
      <div onClick={(e) => { e.stopPropagation(); openNodeEditor(id) }}
        style={{ position: 'absolute', top: -8, right: -8, width: 20, height: 20, borderRadius: '50%', background: LEFT_COLOR, border: '2px solid #0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10 }}>
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#fff' }} />
      </div>

      {/* ── Handle principale — 22% — blu ── */}
      <Handle id="input_left" type="target" position={Position.Left}
        style={{ top: '22%', left: -5, transform: 'none', background: LEFT_COLOR, border: '2px solid #0f1117', width: 10, height: 10 }}
        title="Flusso principale (sinistra)" />

      {/* Label handle sinistra */}
      <div style={{ position: 'absolute', top: 'calc(22% - 5px)', left: 4, fontSize: 10, fontWeight: 700, color: LEFT_COLOR, fontFamily: 'monospace', pointerEvents: 'none' }}>
          L
      </div>

      {/* ── Handle lookup — 78% — ciano ── */}
      <Handle id="input_right" type="target" position={Position.Left}
        style={{ top: '78%', left: -5, transform: 'none', background: LOOKUP_COLOR, border: '2px solid #0f1117', width: 10, height: 10 }}
        title="Lookup (destra)" />

      {/* Label handle destra */}
      <div style={{ position: 'absolute', top: 'calc(78% - 5px)', left: 4, fontSize: 10, fontWeight: 700, color: LOOKUP_COLOR, fontFamily: 'monospace', pointerEvents: 'none' }}>
          R
      </div>

      {/* Header */}
      <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: `1px solid ${BORDER_COLOR}`, borderRadius: '6px 6px 0 0' }}>
        <span style={{ color: '#ffb347', fontSize: 14 }}>⋈</span>
        <span style={{ color: '#ffb347', fontWeight: 600, fontSize: 12, flex: 1 }}>{displayName}</span>
        <div style={{ width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0, animation: nodeData.status === 'running' ? 'nodePulse 0.6s infinite' : undefined }} />
      </div>

      {/* Body */}
      <div style={{ padding: '6px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span style={{ fontSize: 9, padding: '1px 7px', borderRadius: 8, fontWeight: 700, background: `color-mix(in srgb, ${joinColor} 15%, #1a2030)`, color: joinColor, border: `0.5px solid ${joinColor}40`, textTransform: 'uppercase' }}>
            {joinType}
          </span>
          <span style={{ fontSize: 9, color: '#4a5a7a' }}>join</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: LEFT_COLOR, flexShrink: 0 }} />
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: LEFT_COLOR }}>{leftKey || 'principale'}</span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: LOOKUP_COLOR, flexShrink: 0 }} />
          <span style={{ fontSize: 10, fontFamily: 'monospace', color: LOOKUP_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 120 }}>
            {lookupLabel}
          </span>
        </div>

        {(leftKey || rightKey) && (
          <div style={{ marginTop: 2, fontSize: 9, fontFamily: 'monospace', color: '#2a3349', display: 'flex', alignItems: 'center', gap: 3, borderTop: '0.5px solid #2a3349', paddingTop: 4 }}>
            <code style={{ color: LEFT_COLOR }}>{leftKey || '?'}</code>
            <span style={{ color: '#2a3349' }}>=</span>
            <code style={{ color: LOOKUP_COLOR }}>{rightKey || '?'}</code>
          </div>
        )}
      </div>

      {/* Handle uscita */}
      <Handle id="output" type="source" position={Position.Right}
        style={{ background: '#ffb347', border: '2px solid #0f1117', width: 10, height: 10 }} />
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})

JoinNode.displayName = 'JoinNode'