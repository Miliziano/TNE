/**
 * src/nodes/BridgeNode.tsx
 */
import { memo, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeData } from '../types'
import { useFlowStore } from '../store/flowStore'
import { BridgeInModal } from './types/bridge/BridgeModal'
import { NodeRuntimeBadges } from './RuntimeBadges'

// ─── BridgeOut ────────────────────────────────────────────────────
export const BridgeOutNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData       = data as NodeData
  const selectNode     = useFlowStore((s) => s.selectNode)
  const openNodeEditor = useFlowStore((s) => s.openNodeEditor)

  const channelName  = String(nodeData.props?.['channelName']  || '...')
  const channelColor = String(nodeData.props?.['channelColor'] || '#a78bfa')
  const syncMode     = String(nodeData.props?.['syncMode']     || 'fire_and_forget')
  const transferMode = String(nodeData.props?.['transferMode'] || 'content')
  const outputMode   = String(nodeData.props?.['outputMode']   || 'none')

  const syncIcon    = syncMode === 'wait_for_ack' ? '⇄' : syncMode === 'gate' ? '⊟' : '→'
  const modeIcon    = transferMode === 'stream' ? '▶▶' : '⬛'
  const outputBadge = outputMode === 'passthrough' ? '↻' : outputMode === 'signal' ? '⚡' : null

  return (
    <div
      onClick={() => selectNode(id)}
      onDoubleClick={() => openNodeEditor(id)}
      title={`Bridge OUT — canale "${channelName}"`}
      style={{ width: 100, position: 'relative', cursor: 'pointer', userSelect: 'none' }}>

      <svg width="100" height="68" viewBox="0 0 100 68" style={{ display: 'block' }}>
        <path d="M4 4 L64 4 Q94 34 64 64 L4 64 Z" fill="none"
          stroke={channelColor} strokeWidth={selected ? 5 : 2.5} opacity={selected ? 0.35 : 0.18} />
        <path d="M4 4 L64 4 Q94 34 64 64 L4 64 Z"
          fill={selected ? `color-mix(in srgb, ${channelColor} 22%, #1e2535)` : `color-mix(in srgb, ${channelColor} 10%, #1e2535)`}
          stroke={channelColor} strokeWidth={selected ? 2.5 : 1.5} />
        <text x="76" y="28" textAnchor="middle" dominantBaseline="middle"
          fontSize="11" fill={channelColor} fontWeight="bold" opacity="0.9">{syncIcon}</text>
        <text x="76" y="44" textAnchor="middle" dominantBaseline="middle"
          fontSize="8" fill={channelColor} opacity="0.7">{modeIcon}</text>
      </svg>

      <div style={{ position: 'absolute', top: 0, left: 0, width: 64, height: 68,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 2, pointerEvents: 'none' }}>
        <span style={{ fontSize: 7, color: channelColor, textTransform: 'uppercase', letterSpacing: '.06em', opacity: 0.8 }}>OUT</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: channelColor, fontFamily: 'monospace',
          maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
          {channelName}
        </span>
        {outputBadge && <span style={{ fontSize: 9, color: channelColor, opacity: 0.75 }}>{outputBadge}</span>}
      </div>

      {nodeData.status === 'running' && (
        <div style={{ position: 'absolute', top: -6, right: -6, width: 12, height: 12,
          borderRadius: '50%', background: '#ffb347', border: '2px solid #0f1117', animation: 'nodePulse 0.6s infinite' }} />
      )}
      {nodeData.status === 'done' && (
        <div style={{ position: 'absolute', top: -6, right: -6, width: 12, height: 12,
          borderRadius: '50%', background: '#3ddc84', border: '2px solid #0f1117' }} />
      )}
      {nodeData.status === 'error' && (
        <div style={{ position: 'absolute', top: -6, right: -6, width: 12, height: 12,
          borderRadius: '50%', background: '#ff5f57', border: '2px solid #0f1117' }} />
      )}

      <Handle id="input" type="target" position={Position.Left}
        style={{ background: channelColor, border: '2px solid #0f1117', width: 10, height: 10, left: -5 }} />
      <Handle id="output" type="source" position={Position.Right}
        style={{
          background: outputMode !== 'none' ? channelColor : 'transparent',
          border:     outputMode !== 'none' ? '2px solid #0f1117' : 'none',
          width:      outputMode !== 'none' ? 10 : 1,
          height:     outputMode !== 'none' ? 10 : 1,
          right: -5, opacity: outputMode !== 'none' ? 1 : 0,
        }} />
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})
BridgeOutNode.displayName = 'BridgeOutNode'

// ─── BridgeIn ─────────────────────────────────────────────────────
export const BridgeInNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData   = data as NodeData
  const selectNode = useFlowStore((s) => s.selectNode)
  const [showModal, setShowModal] = useState(false)

  const channelName  = String(nodeData.props?.['channelName']  || '...')
  const channelColor = String(nodeData.props?.['channelColor'] || '#a78bfa')
  const syncMode     = String(nodeData.props?.['syncMode']     || 'fire_and_forget')
  const timeoutSec   = String(nodeData.props?.['timeoutSec']   || '30')
  const schemaCount  = (() => {
    try { return JSON.parse(String(nodeData.props?.['outputSchema'] ?? '[]')).length } catch { return 0 }
  })()

  const syncIcon = syncMode === 'wait_for_ack' ? '⇄' : syncMode === 'gate' ? '⊟' : '←'

  return (
    <div
      onClick={() => selectNode(id)}
      onDoubleClick={(e) => { e.stopPropagation(); setShowModal(true) }}
      title={`Bridge IN — canale "${channelName}" (timeout ${timeoutSec}s) — doppio click per configurare`}
      style={{ width: 100, position: 'relative', cursor: 'pointer', userSelect: 'none' }}>

      <svg width="100" height="68" viewBox="0 0 100 68" style={{ display: 'block' }}>
        <path d="M96 4 L36 4 Q6 34 36 64 L96 64 Z" fill="none"
          stroke={channelColor} strokeWidth={selected ? 5 : 2.5} opacity={selected ? 0.35 : 0.18} />
        <path d="M96 4 L36 4 Q6 34 36 64 L96 64 Z"
          fill={selected ? `color-mix(in srgb, ${channelColor} 22%, #1e2535)` : `color-mix(in srgb, ${channelColor} 10%, #1e2535)`}
          stroke={channelColor} strokeWidth={selected ? 2.5 : 1.5} />
        <text x="24" y="34" textAnchor="middle" dominantBaseline="middle"
          fontSize="11" fill={channelColor} fontWeight="bold" opacity="0.9">{syncIcon}</text>
      </svg>

      <div style={{ position: 'absolute', top: 0, right: 0, width: 64, height: 68,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        gap: 2, pointerEvents: 'none' }}>
        <span style={{ fontSize: 7, color: channelColor, textTransform: 'uppercase', letterSpacing: '.06em', opacity: 0.8 }}>IN</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: channelColor, fontFamily: 'monospace',
          maxWidth: 56, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'center' }}>
          {channelName}
        </span>
        <span style={{ fontSize: 7, color: channelColor, opacity: 0.55, fontFamily: 'monospace' }}>
          ⏱ {timeoutSec}s
        </span>
      </div>

      {/* Badge editor — apre modal */}
      <div onClick={(e) => { e.stopPropagation(); setShowModal(true) }}
        style={{ position: 'absolute', top: -8, right: -8, width: 18, height: 18,
          borderRadius: '50%', background: channelColor, border: '2px solid #0f1117',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', zIndex: 10, boxShadow: `0 2px 6px ${channelColor}60` }}>
        <i className="ti ti-edit" style={{ fontSize: 9, color: '#0f1117' }} />
      </div>

      {/* Badge count campi schema */}
      {schemaCount > 0 && (
        <div style={{ position: 'absolute', bottom: -8, right: -8, minWidth: 18, height: 18,
          borderRadius: 9, background: `color-mix(in srgb, ${channelColor} 20%, #1e2535)`,
          border: `1.5px solid ${channelColor}`, display: 'flex', alignItems: 'center',
          justifyContent: 'center', padding: '0 4px', zIndex: 10, pointerEvents: 'none' }}>
          <span style={{ fontSize: 9, color: channelColor, fontWeight: 700, fontFamily: 'monospace' }}>
            {schemaCount}
          </span>
        </div>
      )}

      {nodeData.status === 'running' && (
        <div style={{ position: 'absolute', top: -6, left: -6, width: 12, height: 12,
          borderRadius: '50%', background: '#ffb347', border: '2px solid #0f1117', animation: 'nodePulse 0.6s infinite' }} />
      )}
      {nodeData.status === 'done' && (
        <div style={{ position: 'absolute', top: -6, left: -6, width: 12, height: 12,
          borderRadius: '50%', background: '#3ddc84', border: '2px solid #0f1117' }} />
      )}
      {nodeData.status === 'error' && (
        <div style={{ position: 'absolute', top: -6, left: -6, width: 12, height: 12,
          borderRadius: '50%', background: '#ff5f57', border: '2px solid #0f1117' }} />
      )}

      <Handle id="input" type="target" position={Position.Left}
        style={{ background: 'transparent', border: 'none', width: 1, height: 1, left: -1, opacity: 0 }} />
      <Handle id="output" type="source" position={Position.Right}
        style={{ background: channelColor, border: '2px solid #0f1117', width: 10, height: 10, right: -5 }} />

      {showModal && <BridgeInModal nodeId={id} onClose={() => setShowModal(false)} />}
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})
BridgeInNode.displayName = 'BridgeInNode'