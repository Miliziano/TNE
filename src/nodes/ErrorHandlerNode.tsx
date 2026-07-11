/**
 * src/nodes/ErrorHandlerNode.tsx
 *
 * Nodo "Error Handler" — collettore centrale degli errori della lane.
 * Uno per lane, creato automaticamente alla creazione della lane,
 * non eliminabile (deletable: false sull'oggetto FlowNode).
 *
 * Comportamento (vedi sviluppo):
 * - Nessun handle di ingresso: è un collettore IMPLICITO. Ogni errore
 *   non gestito da un catch/reject esplicito confluisce qui automaticamente.
 * - Se un nodo ha catch/reject collegato altrove, l'errore segue quel
 *   percorso E arriva qui in copia per logging centralizzato
 *   (a meno che 'logAll' nel panel sia impostato a 'false').
 * - Un solo handle di uscita 'error_out' — collegabile a Filter
 *   per costruire pipeline di recovery/notifica.
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NodeRuntimeBadges } from './RuntimeBadges'
import type { NodeData, NodeStatus } from '../types'
import { useFlowStore } from '../store/flowStore'

const ERR_COLOR = '#ff5f57'

const STATUS_COLORS: Record<NodeStatus, string> = {
  idle:    '#4a5a7a',
  running: '#ffb347',
  done:    '#3ddc84',
  error:   '#ff5f57',
  warning: '#ffb347',
  ok:      '#3ddc84',
}

export const ErrorHandlerNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData       = data as NodeData
  const selectNode     = useFlowStore((s) => s.selectNode)
  const openNodeEditor = useFlowStore((s) => s.openNodeEditor)

  const statusColor = STATUS_COLORS[nodeData.status]
  const rulesCount  = (() => {
    try {
      const parsed = JSON.parse(nodeData.props?.['rules'] ?? '[]')
      return Array.isArray(parsed) ? parsed.length : 0
    } catch { return 0 }
  })()

  return (
    <div
      onClick={() => selectNode(id)}
      onDoubleClick={() => openNodeEditor(id)}
      title="Error Handler — collettore errori della lane (sempre attivo, non eliminabile)"
      style={{
        minWidth: 180, borderRadius: 8,
        background: `color-mix(in srgb, ${ERR_COLOR} 6%, #1e2535)`,
        border: `1.5px dashed ${ERR_COLOR}90`,
        boxShadow: selected ? `0 0 0 2px ${ERR_COLOR}50` : undefined,
        cursor: 'pointer', userSelect: 'none', position: 'relative',
      }}
    >
      {/* Pin — indica nodo fisso/non eliminabile */}
      <div
        title="Nodo fisso della lane — non può essere eliminato"
        style={{
          position: 'absolute', top: -8, left: -8,
          width: 18, height: 18, borderRadius: '50%',
          background: '#1a2030', border: `2px solid ${ERR_COLOR}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          zIndex: 10,
        }}
      >
        <i className="ti ti-pin" style={{ fontSize: 9, color: ERR_COLOR }} aria-hidden="true" />
      </div>

      {/* Badge edit */}
      <div
        onClick={(e) => { e.stopPropagation(); openNodeEditor(id) }}
        title="Configura Error Handler"
        style={{
          position: 'absolute', top: -8, right: -8,
          width: 20, height: 20, borderRadius: '50%',
          background: ERR_COLOR, border: '2px solid #0f1117',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', zIndex: 10,
        }}
      >
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#0f1117' }} aria-hidden="true" />
      </div>

      {/* Header */}
      <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
        <i className="ti ti-shield-exclamation" style={{ fontSize: 15, color: ERR_COLOR }} aria-hidden="true" />
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <div style={{ color: ERR_COLOR, fontWeight: 600, fontSize: 11 }}>Error Handler</div>
          <div style={{ fontSize: 9, color: '#9a9aaa', fontFamily: 'monospace' }}>
            sempre attivo · {rulesCount} regol{rulesCount === 1 ? 'a' : 'e'}
          </div>
        </div>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', background: statusColor, flexShrink: 0,
          boxShadow: nodeData.status === 'running' ? `0 0 6px ${statusColor}` : 'none',
        }} />
      </div>

      {/* Output — verso pipeline di recovery */}
      <Handle id="error_out" type="source" position={Position.Right}
        style={{ background: ERR_COLOR, border: '2px solid #0f1117', width: 10, height: 10 }}
        title="error_out — collega un Filter per il recovery" />
      <div style={{
        position: 'absolute', right: 14, top: 'calc(50% - 7px)',
        fontSize: 9, color: ERR_COLOR, fontFamily: 'monospace', fontWeight: 600,
        pointerEvents: 'none', userSelect: 'none',
      }}>
        error_out
      </div>
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})

ErrorHandlerNode.displayName = 'ErrorHandlerNode'