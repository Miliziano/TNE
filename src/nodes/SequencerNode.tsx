/**
 * src/nodes/SequencerNode.tsx
 * Pattern handle identico a FilterNode.tsx.
 */

import { memo, useCallback } from 'react'
import { Handle, Position, type NodeProps, useReactFlow } from '@xyflow/react'
import { NodeRuntimeBadges } from './RuntimeBadges'
import type { NodeData } from '../types'
import { useFlowStore } from '../store/flowStore'

const SEQ_COLOR = '#a78bfa'

const COND_COLORS: Record<string, string> = {
  onOk:    '#3ddc84',
  onError: '#ff5f57',
  always:  '#ffb347',
}

const STATUS_COLORS: Record<string, string> = {
  idle:    '#4a5a7a',
  running: SEQ_COLOR,
  done:    '#3ddc84',
  error:   '#ff5f57',
  warning: '#ffb347',
}

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

export const SequencerNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData     = data as NodeData
  const status       = nodeData.status ?? 'idle'
  const label        = (nodeData.config?.displayName as string) || nodeData.label || 'Sequencer'
  const updateProp     = useFlowStore(s => s.updateNodeProp)
  const selectNode     = useFlowStore(s => s.selectNode)
  const openNodeEditor = useFlowStore(s => s.openNodeEditor)
  const { getEdges }   = useReactFlow()

  const handleClick       = useCallback(() => selectNode(id), [id, selectNode])
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation(); openNodeEditor(id)
  }, [id, openNodeEditor])

  const rawSeqCount = nodeData.props?.['seqCount']
  const seqCount = Math.max(1, parseInt(String(rawSeqCount ?? '2'), 10))

  console.log('[SequencerNode] render', { id, rawSeqCount, seqCount, allProps: nodeData.props })

  const addSeq = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    updateProp(id, 'seqCount', String(seqCount + 1))
  }, [id, seqCount, updateProp])

  const removeLastSeq = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
    if (seqCount <= 1) return
    const hasEdge = getEdges().some(
      ed => ed.source === id && ed.sourceHandle === `seq_${seqCount}`
    )
    if (hasEdge) return
    updateProp(id, 'seqCount', String(seqCount - 1))
  }, [id, seqCount, updateProp, getEdges])

  const getSeqLabel = (i: number) =>
    String(nodeData.props?.[`seq_${i}_label`] ?? '') || `Pipeline ${i}`

  const getSeqCond = (i: number) =>
    String(nodeData.props?.[`seq_${i}_condition`] ?? 'onOk')

  // Identico a FilterNode
  const total  = seqCount
  const getPct = (idx: number) =>
    total <= 1 ? 35 : 12 + (idx / (total - 1)) * 72

  const minHeight   = Math.max(90, seqCount * 28 + 64)
  const statusColor = STATUS_COLORS[status] ?? '#4a5a7a'

  return (
    <div
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      title="Sequencer — doppio click per configurare"
      style={{
        minWidth: 180, minHeight, borderRadius: 8,
        border: `1.5px solid ${selected ? SEQ_COLOR : '#2a1a5a'}`,
        background: '#1e2535',
        boxShadow: selected ? `0 0 0 2px ${SEQ_COLOR}40` : undefined,
        userSelect: 'none', cursor: 'pointer',
        position: 'relative', display: 'flex', flexDirection: 'column',
      }}
    >
      {/* Badge edit — identico a FilterNode */}
      <div onClick={(e) => { e.stopPropagation(); openNodeEditor(id) }} title="Configura Sequencer"
        style={{ position: 'absolute', top: -8, right: -8, width: 20, height: 20, borderRadius: '50%', background: SEQ_COLOR, border: '2px solid #0f1117', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', zIndex: 10, boxShadow: `0 2px 6px ${SEQ_COLOR}60` }}>
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#0f1117' }} />
      </div>

      {/* Handle input */}
      <Handle id="input" type="target" position={Position.Left}
        style={{ background: '#4a5a7a', border: '2px solid #0f1117', width: 10, height: 10 }} />

      {/* Handle output seq_N + badge — stesso pattern di FilterNode:
          PriorityBadge e Handle DENTRO lo stesso <div key> */}
      {Array.from({ length: seqCount }, (_, i) => {
        const n   = i + 1
        const cc  = COND_COLORS[getSeqCond(n)] ?? SEQ_COLOR
        const pct = `${getPct(i)}%`
        return (
          <div key={`seq_${n}`}>
            <PriorityBadge n={n} color={cc} top={pct} />
            <Handle
              id={`seq_${n}`}
              type="source"
              position={Position.Right}
              style={{
                top: pct, background: cc, border: '2px solid #0f1117',
                width: 10, height: 10, right: -5, transform: 'none',
              }}
              title={`#${n} ${getSeqLabel(n)} — ${getSeqCond(n)}`}
            />
          </div>
        )
      })}

      {/* Header */}
      <div style={{
        padding: '5px 8px', display: 'flex', alignItems: 'center', gap: 5,
        borderBottom: '1px solid #2a1a5a',
        background: selected ? `color-mix(in srgb, ${SEQ_COLOR} 12%, #1e2535)` : '#1e2535',
        borderRadius: '6px 6px 0 0', flexShrink: 0,
      }}>
        <i className="ti ti-list-numbers" style={{ fontSize: 13, color: SEQ_COLOR }} />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ color: SEQ_COLOR, fontWeight: 600, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {label}
          </div>
          <div style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace' }}>
            {seqCount} seq | raw: {String(nodeData.props?.['seqCount'] ?? 'undef')}
          </div>
        </div>
        <div style={{
          width: 7, height: 7, borderRadius: '50%',
          background: statusColor, flexShrink: 0,
          boxShadow: status === 'running' ? `0 0 6px ${statusColor}` : 'none',
        }} />
      </div>

      {/* Body — lista sequenze, identico a FilterNode body */}
      <div style={{ padding: '5px 8px 5px 8px', flex: 1, display: 'flex', flexDirection: 'column', gap: 3 }}>
        {Array.from({ length: seqCount }, (_, i) => {
          const n  = i + 1
          const cc = COND_COLORS[getSeqCond(n)] ?? SEQ_COLOR
          return (
            <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 9, color: `${cc}50`, fontFamily: 'monospace', minWidth: 14, flexShrink: 0 }}>
                #{n}
              </span>
              <div style={{ width: 5, height: 5, borderRadius: '50%', background: cc, flexShrink: 0 }} />
              <span style={{ fontSize: 9, fontFamily: 'monospace', color: cc, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {getSeqLabel(n)}
              </span>
              <span style={{ fontSize: 7, color: '#4a5a7a', flexShrink: 0 }}>
                {getSeqCond(n) === 'onOk' ? '✓' : getSeqCond(n) === 'onError' ? '✗' : '●'}
              </span>
            </div>
          )
        })}
      </div>

      {/* Footer — bottoni +/- seq */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '4px 8px', borderTop: '0.5px solid #2a1a5a',
        background: '#161b27', borderRadius: '0 0 6px 6px', flexShrink: 0,
      }}>
        <button onClick={addSeq} title="Aggiungi sequenza"
          style={{
            flex: 1, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
            background: `color-mix(in srgb, ${SEQ_COLOR} 10%, #0f1117)`,
            border: `0.5px solid ${SEQ_COLOR}40`, borderRadius: 3,
            cursor: 'pointer', color: SEQ_COLOR, fontSize: 9,
          }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${SEQ_COLOR} 22%, #0f1117)` }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${SEQ_COLOR} 10%, #0f1117)` }}>
          <i className="ti ti-plus" style={{ fontSize: 9 }} /> seq
        </button>
        <button onClick={removeLastSeq} disabled={seqCount <= 1}
          title={seqCount <= 1 ? 'Minimo 1 sequenza' : `Rimuovi seq_${seqCount}`}
          style={{
            flex: 1, height: 18, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 3,
            background: '#1a2030', border: '0.5px solid #2a3349', borderRadius: 3,
            cursor: seqCount <= 1 ? 'not-allowed' : 'pointer',
            color: seqCount <= 1 ? '#2a3349' : '#4a5a7a', fontSize: 9, opacity: seqCount <= 1 ? 0.4 : 1,
          }}
          onMouseEnter={(e) => { if (seqCount > 1) (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = seqCount <= 1 ? '#2a3349' : '#4a5a7a' }}>
          <i className="ti ti-minus" style={{ fontSize: 9 }} /> seq
        </button>
      </div>

      {/* Status message */}
      {nodeData.statusMessage && (
        <div style={{
          position: 'absolute', bottom: -20, left: 0, right: 0,
          fontSize: 9,
          color: status === 'error' ? '#ff5f57' : status === 'done' ? '#3ddc84' : SEQ_COLOR,
          textAlign: 'center', whiteSpace: 'nowrap',
          overflow: 'hidden', textOverflow: 'ellipsis', pointerEvents: 'none',
        }}>
          {nodeData.statusMessage}
        </div>
      )}
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})

SequencerNode.displayName = 'SequencerNode'