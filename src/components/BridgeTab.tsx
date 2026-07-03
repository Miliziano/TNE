/**
 * src/components/BridgeTab.tsx
 *
 * Tab "Bridge" nel PropertyPanel — mostra tutti i canali bridge
 * attivi nella pool con stato della coppia e link ai nodi.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../store/flowStore'

const ACCENT = '#a78bfa'

interface BridgeChannel {
  id:           string
  name:         string
  color:        string
  syncMode:     string
  outNode?:     { id: string; laneId: string; laneLabel: string }
  inNode?:      { id: string; laneId: string; laneLabel: string }
  isComplete:   boolean
}

export function BridgeTab() {
  const nodes      = useFlowStore((s) => s.nodes)
  const pool       = useFlowStore((s) => s.pool)
  const selectNode = useFlowStore((s) => s.selectNode)
  const selectLane = useFlowStore((s) => s.selectLane)
  const addNode    = useFlowStore((s) => s.addNode)

  // Costruisce la lista di canali bridge da tutti i nodi bridge_out e bridge_in
  const channels = useMemo((): BridgeChannel[] => {
    const laneLabel = (laneId: string) =>
      pool.lanes.find((l) => l.id === laneId)?.label ?? laneId

    const outNodes = nodes.filter((n) => n.data.type === 'bridge_out')
    const inNodes  = nodes.filter((n) => n.data.type === 'bridge_in')

    // Raccoglie tutti i nomi canale unici
    const allNames = new Set<string>([
      ...outNodes.map((n) => n.data.props?.['channelName'] || ''),
      ...inNodes.map((n)  => n.data.props?.['channelName'] || ''),
    ])
    allNames.delete('')

    return Array.from(allNames).map((name) => {
      const outNode = outNodes.find((n) => n.data.props?.['channelName'] === name)
      const inNode  = inNodes.find((n)  => n.data.props?.['channelName'] === name)
      const color   = outNode?.data.props?.['channelColor']
                   ?? inNode?.data.props?.['channelColor']
                   ?? '#a78bfa'
      const syncMode = outNode?.data.props?.['syncMode']
                    ?? inNode?.data.props?.['syncMode']
                    ?? 'fire_and_forget'
      return {
        id:         `bridge_${name}`,
        name,
        color,
        syncMode,
        outNode:    outNode ? { id: outNode.id, laneId: outNode.data.laneId, laneLabel: laneLabel(outNode.data.laneId) } : undefined,
        inNode:     inNode  ? { id: inNode.id,  laneId: inNode.data.laneId,  laneLabel: laneLabel(inNode.data.laneId) }  : undefined,
        isComplete: !!outNode && !!inNode,
      }
    }).sort((a, b) => {
      // Canali completi prima, poi ordinati per nome
      if (a.isComplete !== b.isComplete) return a.isComplete ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  }, [nodes, pool])

  const navigateTo = (nodeId: string, laneId: string) => {
    selectNode(nodeId)
    selectLane(laneId)
  }

  const syncLabel = (mode: string) =>
    mode === 'fire_and_forget' ? '→ Fire & Forget'
    : mode === 'wait_for_ack'  ? '⇄ Wait for Ack'
    : '⊟ Gate'

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
      {/* Header info */}
      <div style={{ margin: '4px 8px 10px', padding: '8px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a' }}>
        <div style={{ display: 'flex', gap: 5, marginBottom: 4 }}>
          <i className="ti ti-arrows-transfer-up" style={{ fontSize: 11, color: ACCENT, flexShrink: 0 }} />
          <span>I canali bridge collegano nodi <code style={{ color: ACCENT }}>BridgeOut</code> e <code style={{ color: ACCENT }}>BridgeIn</code> in lane diverse.</span>
        </div>
        <div>Trascina i nodi dalla palette e assegna lo stesso nome canale per creare la coppia.</div>
      </div>

      {channels.length === 0 ? (
        <div style={{ margin: '8px 12px', padding: '24px 12px', fontSize: 11, color: '#2a3349', textAlign: 'center', background: '#1a2030', borderRadius: 6, border: '0.5px dashed #2a3349' }}>
          <i className="ti ti-arrows-transfer-up" style={{ fontSize: 32, display: 'block', marginBottom: 10, color: '#2a3349' }} />
          Nessun canale bridge configurato.<br />
          Aggiungi nodi <strong>BridgeOut</strong> e <strong>BridgeIn</strong> dalla palette.
        </div>
      ) : (
        channels.map((ch) => (
          <div key={ch.id} style={{
            margin: '4px 8px',
            background: ch.isComplete
              ? `color-mix(in srgb, ${ch.color} 5%, #1a2030)`
              : '#1a0a0a',
            borderRadius: 8,
            border: `1px solid ${ch.isComplete ? ch.color + '40' : '#3d1010'}`,
            overflow: 'hidden',
          }}>
            {/* Header canale */}
            <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8, borderBottom: `0.5px solid ${ch.color}20` }}>
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: ch.color, flexShrink: 0 }} />
              <code style={{ fontSize: 12, fontWeight: 700, color: ch.color, flex: 1, fontFamily: 'monospace' }}>
                {ch.name}
              </code>
              {ch.isComplete ? (
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `${ch.color}20`, color: ch.color, border: `0.5px solid ${ch.color}40` }}>
                  ✓ completo
                </span>
              ) : (
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#2a1010', color: '#ff5f57', border: '0.5px solid #3d1010' }}>
                  ⚠ incompleto
                </span>
              )}
            </div>

            {/* Flusso lane A → lane B */}
            <div style={{ padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
              {/* Lane OUT */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3 }}>OUT</div>
                {ch.outNode ? (
                  <button
                    onClick={() => navigateTo(ch.outNode!.id, ch.outNode!.laneId)}
                    style={{ background: 'none', border: `0.5px solid ${ch.color}40`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', color: ch.color, fontSize: 10, fontWeight: 600, width: '100%', textAlign: 'left' }}>
                    {ch.outNode.laneLabel}
                  </button>
                ) : (
                  <div style={{ fontSize: 10, color: '#ff5f57', fontStyle: 'italic', padding: '3px 0' }}>mancante</div>
                )}
              </div>

              {/* Freccia + sync */}
              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                <div style={{ fontSize: 16, color: ch.isComplete ? ch.color : '#2a3349' }}>→</div>
                <span style={{ fontSize: 9, color: '#4a5a7a', whiteSpace: 'nowrap' }}>
                  {syncLabel(ch.syncMode)}
                </span>
              </div>

              {/* Lane IN */}
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.05em', marginBottom: 3, textAlign: 'right' }}>IN</div>
                {ch.inNode ? (
                  <button
                    onClick={() => navigateTo(ch.inNode!.id, ch.inNode!.laneId)}
                    style={{ background: 'none', border: `0.5px solid ${ch.color}40`, borderRadius: 4, padding: '3px 8px', cursor: 'pointer', color: ch.color, fontSize: 10, fontWeight: 600, width: '100%', textAlign: 'right' }}>
                    {ch.inNode.laneLabel}
                  </button>
                ) : (
                  <div style={{ fontSize: 10, color: '#ff5f57', fontStyle: 'italic', padding: '3px 0', textAlign: 'right' }}>mancante</div>
                )}
              </div>
            </div>

            {/* Errore coppia incompleta */}
            {!ch.isComplete && (
              <div style={{ padding: '5px 10px', background: '#2a1010', fontSize: 10, color: '#ff5f57', display: 'flex', gap: 5, alignItems: 'center' }}>
                <i className="ti ti-alert-circle" style={{ fontSize: 10, flexShrink: 0 }} />
                {!ch.outNode && !ch.inNode
                  ? 'Entrambi i nodi mancanti'
                  : !ch.outNode
                  ? `Manca il nodo BridgeOut con canale "${ch.name}"`
                  : `Manca il nodo BridgeIn con canale "${ch.name}"`}
              </div>
            )}
          </div>
        ))
      )}

      {/* Contatore */}
      {channels.length > 0 && (
        <div style={{ padding: '8px 12px', fontSize: 10, color: '#4a5a7a', textAlign: 'center' }}>
          {channels.filter((c) => c.isComplete).length} / {channels.length} canali completi
        </div>
      )}
    </div>
  )
}
