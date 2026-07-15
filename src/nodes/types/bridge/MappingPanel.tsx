/**
 * src/nodes/types/bridge/MappingPanel.tsx
 *
 * Vista schema per bridge_in — SOLA LETTURA.
 *
 * Il BridgeOut è dominante: i campi che il BridgeIn emette sono quelli
 * che il suo BridgeOut manda sul canale, derivati automaticamente (vedi
 * bridgeSchema.ts). Qui non si dichiara più niente a mano — prima si
 * poteva, e nulla garantiva che la dichiarazione corrispondesse a ciò
 * che arrivava davvero.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { findBridgeOutFor, getBridgeOutFields } from './bridgeSchema'

export function BridgeInMappingPanel({ nodeId }: { nodeId: string }) {
  const node     = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const allNodes = useFlowStore((s) => s.nodes)
  const edges    = useFlowStore((s) => s.edges)
  const lanes    = useFlowStore((s) => s.pool.lanes)

  if (!node) return null

  const color       = String(node.data.props?.['channelColor'] ?? '#a78bfa')
  const channelName = String(node.data.props?.['channelName'] ?? '')

  // Produttore del canale. Se ce n'è più d'uno il canale è ambiguo e
  // NON deriviamo: sceglierne uno a caso sarebbe peggio.
  const outNode = useMemo(
    () => findBridgeOutFor(node, allNodes),
    [node, allNodes],
  )
  const ambiguous = useMemo(() => {
    if (!channelName) return false
    return allNodes.filter(
      (n) => n.data.type === 'bridge_out' &&
             String(n.data.props?.['channelName'] ?? '') === channelName,
    ).length > 1
  }, [allNodes, channelName])

  const fields = useMemo(
    () => (outNode ? getBridgeOutFields(outNode, allNodes, edges) : []),
    [outNode, allNodes, edges],
  )

  const outLane = outNode ? lanes.find((l) => l.id === outNode.data.laneId) : null

  const box: React.CSSProperties = {
    padding: '7px 10px', borderRadius: 6, fontSize: 10,
    color: '#9a9aaa', lineHeight: 1.5,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ── Da dove arriva ── */}
      <div style={{ ...box, background: `color-mix(in srgb, ${color} 8%, #0f1117)`,
        border: `0.5px solid ${color}30`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <i className="ti ti-lock" style={{ fontSize: 12, color, flexShrink: 0 }} />
        <span style={{ flex: 1 }}>
          Schema <strong style={{ color }}>derivato</strong> dal BridgeOut del canale:
          il BridgeIn emette esattamente ciò che gli viene mandato. Per cambiarlo,
          agisci sul BridgeOut.
        </span>
      </div>

      {/* ── Sorgente ── */}
      {!channelName ? (
        <div style={{ ...box, background: '#1a2030', border: '0.5px solid #3a2a2a', color: '#c88' }}>
          Canale senza nome: configuralo nel pannello del nodo.
        </div>
      ) : ambiguous ? (
        <div style={{ ...box, background: '#1a2030', border: '0.5px solid #3a2a2a', color: '#c88' }}>
          Il canale <code style={{ color }}>{channelName}</code> ha più di un BridgeOut:
          il produttore è ambiguo e lo schema non può essere derivato.
          Vedi il pannello Validazione.
        </div>
      ) : !outNode ? (
        <div style={{ ...box, background: '#1a2030', border: '0.5px solid #3a2a2a', color: '#c88' }}>
          Nessun BridgeOut sul canale <code style={{ color }}>{channelName}</code>:
          finché manca il produttore non c'è nulla da derivare.
        </div>
      ) : (
        <div style={{ ...box, background: '#1a2030', border: '0.5px solid #2a3349',
          display: 'flex', alignItems: 'center', gap: 6 }}>
          <i className="ti ti-arrow-narrow-right" style={{ fontSize: 12, color, flexShrink: 0 }} />
          <span style={{ flex: 1 }}>
            Sorgente: <strong style={{ color }}>{outLane?.label ?? 'lane ignota'}</strong>
            {' · '}{String(outNode.data.label ?? outNode.id)}
          </span>
          <span style={{ fontSize: 10, color: '#4a5a7a' }}>
            {fields.length} {fields.length === 1 ? 'campo' : 'campi'}
          </span>
        </div>
      )}

      {/* ── Tabella (sola lettura) ── */}
      {outNode && fields.length === 0 && (
        <div style={{ padding: '32px 12px', textAlign: 'center', color: '#2a3349', fontSize: 11,
          background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Il BridgeOut non ha ancora uno schema in ingresso — collega una sorgente nella sua lane.
        </div>
      )}

      {fields.length > 0 && (
        <div style={{ background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px',
            gap: 4, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
            {['Nome campo', 'Nome fisico', 'Tipo'].map((h) => (
              <div key={h} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase',
                letterSpacing: '.05em', fontWeight: 600 }}>{h}</div>
            ))}
          </div>
          {fields.map((field, idx) => (
            <div key={field.id}
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px',
                gap: 4, alignItems: 'center', padding: '5px 8px',
                background: idx % 2 === 0 ? '#1a2030' : 'transparent',
                borderBottom: idx < fields.length - 1 ? '0.5px solid #1e2840' : 'none',
                fontFamily: "'JetBrains Mono', monospace", fontSize: 10 }}>
              <div style={{ color }}>{field.name}</div>
              <div style={{ color: '#9a9aaa' }}>{field.physicalName}</div>
              <div style={{ color: '#4a5a7a' }}>{field.type}</div>
            </div>
          ))}
        </div>
      )}

      {fields.length > 0 && (
        <div style={{ padding: '5px 8px', background: '#1a2030', borderRadius: 4,
          border: '0.5px solid #2a3349', fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 5 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 10, color, flexShrink: 0 }} />
          Propagato automaticamente ai TMap e agli altri nodi collegati all'output.
        </div>
      )}
    </div>
  )
}