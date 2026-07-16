/**
 * src/nodes/JsonSerializerNode.tsx
 * Pattern identico a TMapNode.
 */
import { memo, useCallback, useState } from 'react'
import { ValidationBadge } from "./ValidationBadge"
import { getNodePorts } from '../utils/schemaRegistry'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { NodeRuntimeBadges, HandleCount } from './RuntimeBadges'
import type { NodeData } from '../types'
import { useFlowStore } from '../store/flowStore'
import { JsonSerializerModal } from './types/json_serializer/JsonSerializerModal'

const ACCENT = '#22d3ee'
const FLOW_COLORS = ['#22d3ee','#3ddc84','#ffb347','#a78bfa','#f472b6','#84cc16','#fb923c','#4a9eff']

// ─── IRBadge — identico a TMapNode ───────────────────────────────
// ─── JsonSerializerNode ───────────────────────────────────────────
export const JsonSerializerNode = memo(({ id, data, selected }: NodeProps) => {
  const nodeData   = data as NodeData
  const selectNode = useFlowStore((s) => s.selectNode)
  const [showModal, setShowModal] = useState(false)

  const handleClick       = useCallback(() => selectNode(id), [id, selectNode])
  const handleDoubleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation()
     console.log('double click json serializer', id)  
    setShowModal(true)
  }, [])

  // Gli ingressi DICHIARATI: li scrive connectionResolver alla connessione e
  // li ripulisce LaneCanvas alla cancellazione, come per la union.
  // NB il commento qui sopra diceva "salvati da onConnect in LaneCanvas" e
  // `configInputs` leggeva `jsonSerializer.inputs`: onConnect non salvava
  // NULLA per i serializer e quella mappa non l'ha mai scritta nessuno —
  // variabile morta sotto un commento che descriveva un meccanismo mai
  // costruito. Ora esiste davvero. V. contratto-porte.md §9.3.
  const declaredInputs = ((nodeData.config as any)?.serializerInputs ?? []) as Array<{ id: string; label: string; color: string }>
  const inputPorts     = getNodePorts({ data: nodeData }).inputs

  const minHandles = Math.max(inputPorts.length, 1)
  const minHeight  = Math.max(100, minHandles * 28 + 60)
  const displayName = String(nodeData.config?.displayName ?? 'JSON Serializer')
  const outputField = String((nodeData.config as any)?.outputField ?? 'content')
  const uiState = nodeData.uiState

  return (
    <div
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    
      style={{
        minWidth: 170, minHeight, borderRadius: 8,
        border: `1.5px solid ${selected ? ACCENT : '#0a3a4a'}`,
        background: '#1e2535',
        boxShadow: selected ? `0 0 0 2px ${ACCENT}35` : undefined,
        userSelect: 'none', cursor: 'pointer', position: 'relative',
        display: 'flex', flexDirection: 'column',
      }}
    >
      {uiState && (uiState.hasErrors || uiState.hasWarnings) && <ValidationBadge uiState={uiState} />}

      {/* ── Badge editor ── */}
      <div
        onClick={(e) => { e.stopPropagation(); setShowModal(true) }}
        title="Apri editor JSON Serializer"
        style={{
          position: 'absolute', top: -8, right: -8,
          width: 20, height: 20, borderRadius: '50%',
          background: ACCENT, border: '2px solid #0f1117',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          cursor: 'pointer', zIndex: 10, boxShadow: `0 2px 6px ${ACCENT}60`,
        }}>
        <i className="ti ti-edit" style={{ fontSize: 10, color: '#0f1117' }} />
      </div>

      {/* ── Handle ingressi — uno per ogni edge ── */}
      {/* Ingressi — dal contratto (getNodePorts), non dagli archi.
          Prima l'arco CREAVA la porta: `incomingEdges.map(...)`. Il colore
          resta qui perché è presentazione, ma si prende per ID dal flusso
          dichiarato, così non balla quando cambia l'ordine degli archi. */}
      {inputPorts.map((port, idx) => {
        const total = inputPorts.length
        const pct   = total === 1 ? 50 : 10 + (idx / (total - 1)) * 80
        const color = declaredInputs.find((i) => i.id === port.id)?.color
                      ?? (total === 1 ? '#4a5a7a' : FLOW_COLORS[idx % FLOW_COLORS.length])
        return (
          <Handle key={port.id} id={port.id} type="target" position={Position.Left}
            style={{ top: `${pct}%`, background: color, border: '2px solid #0f1117', width: 10, height: 10, left: -5, transform: 'none' }}
            title={port.label} />
        )
      })}

      {/* ── Handle di servizio — identico a TMapNode ── */}
      <Handle id="input_new" type="target" position={Position.Left}
        style={{ top: '75%', background: '#2a3349', border: '2px dashed #4a5a7a', width: 12, height: 12, left: -20, transform: 'none', borderRadius: '50%', opacity: 0.6 }}
        title="Trascina qui per aggiungere un nuovo flusso" />

      {/* ── Header ── */}
      <div style={{
        padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6,
        borderBottom: `1px solid #0a3a4a`,
        background: selected ? `color-mix(in srgb, ${ACCENT} 12%, #1e2535)` : '#1e2535',
        borderRadius: '6px 6px 0 0', flexShrink: 0,
      }}>
        <span style={{ fontSize: 16, color: ACCENT, fontFamily: 'monospace', fontWeight: 700 }}>{'{ }'}</span>
        <span style={{ color: ACCENT, fontWeight: 600, fontSize: 12, flex: 1 }}>{displayName}</span>
        <div style={{
          width: 7, height: 7, borderRadius: '50%', flexShrink: 0,
          background: nodeData.status === 'running' ? '#ffb347' : nodeData.status === 'done' ? '#3ddc84' : nodeData.status === 'error' ? '#ff5f57' : '#4a5a7a',
          animation: nodeData.status === 'running' ? 'nodePulse 0.6s infinite' : undefined,
        }} />
      </div>

      {/* ── Body ── */}
      <div style={{ padding: '6px 10px', flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {declaredInputs.length === 0 ? (
          <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>Collega un flusso</div>
        ) : (
          declaredInputs.map((inp, idx) => {
            const color = inp.color ?? FLOW_COLORS[idx % FLOW_COLORS.length]
            return (
              <div key={inp.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <span style={{ fontSize: 10, fontFamily: 'monospace', color, flex: 1 }}>{inp.label}</span>
              </div>
            )
          })
        )}
        <div style={{ marginTop: 2, borderTop: '0.5px solid #2a3349', paddingTop: 3, fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace' }}>
          → <code style={{ color: ACCENT }}>{outputField}</code>
        </div>
      </div>

      {/* ── Handle uscite ── */}
      <Handle id="output" type="source" position={Position.Right}
        style={{ top: '35%', background: ACCENT, border: '2px solid #0f1117', width: 10, height: 10, right: -5, transform: 'none' }}
        title="output — documento JSON" />
      <Handle id="reject" type="source" position={Position.Right}
        style={{ top: '65%', background: '#ff5f57', border: '2px solid #0f1117', width: 10, height: 10, right: -5, transform: 'none' }}
        title="reject" />

      {/* Fase 8: conteggio righe output/reject */}
      <HandleCount nodeId={id} handleId="output" top="35%" color={ACCENT} />
      <HandleCount nodeId={id} handleId="reject" top="65%" color="#ff5f57" />
      <NodeRuntimeBadges nodeId={id} />

      {showModal && <JsonSerializerModal nodeId={id} onClose={() => setShowModal(false)} />}
    </div>
  )
})

JsonSerializerNode.displayName = 'JsonSerializerNode'