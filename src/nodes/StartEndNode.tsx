import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeData } from '../types'
import { useFlowStore } from '../store/flowStore'

const SIZE = 54

export const StartNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData   = data as NodeData
  const selectNode = useFlowStore((s) => s.selectNode)
  const label      = nodeData.props?.label ?? 'Start'

  return (
    <div
      onClick={() => selectNode(id)}
      title="Punto di avvio della lane — non eliminabile"
      style={{
        width: SIZE, height: SIZE, borderRadius: '50%',
        background: selected ? 'color-mix(in srgb, #3ddc84 25%, #1e2535)' : '#1e2535',
        border: `2px solid ${selected ? '#3ddc84' : '#0d3d20'}`,
        boxShadow: selected ? '0 0 0 3px rgba(61,220,132,0.25)' : '0 0 0 1px rgba(61,220,132,0.12)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', cursor: 'pointer', userSelect: 'none', gap: 1,
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1, color: '#3ddc84' }}>▶</span>
      <span style={{ fontSize: 9, fontWeight: 600, color: '#3ddc84', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        {label}
      </span>
      <Handle
        id="output"
        type="source"
        position={Position.Right}
        style={{ background: '#3ddc84', border: '2px solid #0f1117', width: 10, height: 10 }}
      />
    </div>
  )
})
StartNode.displayName = 'StartNode'

export const EndNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData   = data as NodeData
  const selectNode = useFlowStore((s) => s.selectNode)
  const label      = nodeData.props?.label ?? 'End'

  return (
    <div
      onClick={() => selectNode(id)}
      title="Punto di fine della lane — non eliminabile"
      style={{
        width: SIZE, height: SIZE, borderRadius: '50%',
        background: selected ? 'color-mix(in srgb, #ff5f57 25%, #1e2535)' : '#1e2535',
        border: `2px solid ${selected ? '#ff5f57' : '#3d1010'}`,
        boxShadow: selected ? '0 0 0 3px rgba(255,95,87,0.25)' : '0 0 0 1px rgba(255,95,87,0.12)',
        display: 'flex', flexDirection: 'column', alignItems: 'center',
        justifyContent: 'center', cursor: 'pointer', userSelect: 'none', gap: 1,
      }}
    >
      <span style={{ fontSize: 14, lineHeight: 1, color: '#ff5f57' }}>⏹</span>
      <span style={{ fontSize: 9, fontWeight: 600, color: '#ff5f57', letterSpacing: '0.05em', textTransform: 'uppercase' }}>
        {label}
      </span>
      <Handle
        id="input"
        type="target"
        position={Position.Left}
        style={{ background: '#ff5f57', border: '2px solid #0f1117', width: 10, height: 10 }}
      />
    </div>
  )
})
EndNode.displayName = 'EndNode'
