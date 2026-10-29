/**
 * src/nodes/types/bridge/Panel.tsx
 * Pannello condiviso per BridgeOut e BridgeIn.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { getBridgeOutFields } from './bridgeSchema'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}
function SectionTitle({ label, color = '#a78bfa' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

const BRIDGE_COLORS = [
  '#a78bfa', '#f472b6', '#22d3ee', '#3ddc84',
  '#ffb347', '#4a9eff', '#fb923c', '#84cc16',
]

export function BridgePanel({ nodeId }: { nodeId: string }) {
  // Guscio: il corpo chiama i suoi hook dopo aver letto il nodo, e con
  // un `return null` in mezzo il loro numero cambierebbe quando il nodo
  // viene eliminato (rules-of-hooks). Qui si decide se c'è, là si
  // chiamano sempre tutti.
  const exists = useFlowStore((s) => s.nodes.some((n) => n.id === nodeId))
  return exists ? <BridgePanelBody nodeId={nodeId} /> : null
}

function BridgePanelBody({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))!
  const allNodes   = useFlowStore((s) => s.nodes)
  const edges      = useFlowStore((s) => s.edges)
  const pool       = useFlowStore((s) => s.pool)
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const selectNode = useFlowStore((s) => s.selectNode)
  const selectLane = useFlowStore((s) => s.selectLane)


  const isOut        = node.data.type === 'bridge_out'
  const p            = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u            = (key: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      updateProp(nodeId, key, e.target.value)

  const channelName  = p('channelName')
  const channelColor = p('channelColor', '#a78bfa')
  const syncMode     = p('syncMode', 'fire_and_forget') === 'wait_for_ack' ? 'wait_for_ack' : 'fire_and_forget'
  const timeoutSec   = p('waitTimeoutSec', '0')
  const outputMode   = p('outputMode', 'none')
  const laneId       = node.data.laneId
  const ACCENT       = channelColor

  // Nodo corrispondente nell'altra lane
  const counterpart = useMemo(() => {
    if (!channelName) return null
    const counterType = isOut ? 'bridge_in' : 'bridge_out'
    return allNodes.find((n) =>
      n.data.type === counterType &&
      n.data.props?.['channelName'] === channelName &&
      n.data.laneId !== laneId
    ) ?? null
  }, [allNodes, channelName, isOut, laneId])

  const counterLane = counterpart
    ? pool.lanes.find((l) => l.id === counterpart.data.laneId)
    : null
   const thisLane = pool.lanes.find((l) => l.id === laneId)

  // Campi che il BridgeOut trasferirà sul canale: schema LIVE del nodo
  // a monte (getHandleSchema — copre anche tmap/parser/serializer), con
  // fallback sull'incomingSchema persistito dalla propagazione.
  const transferFields = useMemo((): Array<{ id?: string; name: string; type: string }> => {
    if (!isOut) return []
    // Logica condivisa con la derivazione del BridgeIn (bridgeSchema.ts):
    // due copie divergerebbero, e il BridgeIn mostrerebbe campi diversi
    // da quelli che il BridgeOut dichiara di mandare.
    return getBridgeOutFields(node, allNodes, edges)
  }, [isOut, edges, allNodes, node])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Stato coppia ── */}
      <div style={{
        padding: '10px 12px', borderRadius: 8,
        background: counterpart ? `color-mix(in srgb, ${ACCENT} 8%, #0f1117)` : '#1a0a0a',
        border: `1px solid ${counterpart ? ACCENT + '40' : '#3d1010'}`,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, textAlign: isOut ? 'left' : 'right' }}>
            <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
              {isOut ? 'This lane (OUT)' : 'This lane (IN)'}
            </div>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0' }}>
              {thisLane?.label ?? laneId}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
            <div style={{ fontSize: 16, color: counterpart ? ACCENT : '#2a3349' }}>
              {isOut ? '→' : '←'}
            </div>
            {channelName && (
              <code style={{ fontSize: 9, color: ACCENT, fontFamily: 'monospace' }}>{channelName}</code>
            )}
          </div>
          <div style={{ flex: 1, textAlign: isOut ? 'right' : 'left' }}>
            <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
              {isOut ? 'Target lane (IN)' : 'Source lane (OUT)'}
            </div>
            {counterpart ? (
              <button
                onClick={() => { selectNode(counterpart.id); selectLane(counterpart.data.laneId) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: ACCENT, padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}>
                {counterLane?.label ?? counterpart.data.laneId}
              </button>
            ) : (
              <div style={{ fontSize: 11, color: '#ff5f57', fontStyle: 'italic' }}>
                {channelName ? 'Not found' : '—'}
              </div>
            )}
          </div>
        </div>
        {channelName && !counterpart && (
          <div style={{ marginTop: 8, padding: '5px 8px', background: '#2a1010', borderRadius: 4, fontSize: 10, color: '#ff5f57', display: 'flex', gap: 5 }}>
            <i className="ti ti-alert-circle" style={{ fontSize: 11, flexShrink: 0 }} />
            Node {isOut ? 'BridgeIn' : 'BridgeOut'} with channel "{channelName}" not found in any other lane.
          </div>
        )}
      </div>

      {/* ── Come viaggia (o non viaggia) un fallimento ──
          Il bridge porta il canale dati e una conferma di consegna: se la
          lane sorgente viene INTERROTTA, la conferma non arriva e il
          BridgeIn fallisce. Ma un fallimento NON critico non interrompe
          nulla, quindi la consegna si chiude regolarmente — magari con 0
          righe — e la lane di valle non ha modo di accorgersene. È una
          trappola che si scopre in produzione: va detta qui, dove il
          bridge si configura. */}
      <div style={{
        padding: '8px 10px', borderRadius: 6, fontSize: 10, lineHeight: 1.5,
        background: '#1c1b12', border: '0.5px solid #4a4326', color: '#c2b280',
        display: 'flex', gap: 6, alignItems: 'flex-start',
      }}>
        <i className="ti ti-info-circle" style={{ fontSize: 12, flexShrink: 0, marginTop: 1 }} />
        <span>
          {isOut
            ? <>A failure of a node in this lane reaches the downstream lane <b>only if that node is marked "critical"</b>. Otherwise the delivery closes normally and the downstream lane receives 0 rows without noticing anything.</>
            : <>A failure in the source lane reaches here <b>only if the failing node is marked "critical"</b>. Otherwise the delivery is considered complete and this node receives 0 rows as if everything were fine.</>}
        </span>
      </div>

      {/* ── Canale ── */}
      <SectionTitle label="Channel" color={ACCENT} />
      <Field label="Channel name" hint="Must match exactly between BridgeOut and BridgeIn">
        <input style={inputStyle} value={channelName} onChange={u('channelName')} placeholder="channel_a" />
      </Field>
      <Field label="Channel color">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          {BRIDGE_COLORS.map((c) => (
            <div key={c} onClick={() => updateProp(nodeId, 'channelColor', c)}
              style={{ width: 20, height: 20, borderRadius: '50%', background: c, cursor: 'pointer',
                border: channelColor === c ? '2px solid #fff' : '2px solid transparent', transition: 'border .1s' }} />
          ))}
          <input type="color" value={channelColor} onChange={u('channelColor')}
            style={{ width: 24, height: 24, border: 'none', borderRadius: 4, padding: 0, cursor: 'pointer', background: 'none', marginLeft: 4 }} />
        </div>
      </Field>

 {/* ── Modalità di trasferimento (solo BridgeOut) ── */}
      {isOut && (
        <>
          {/* ── Campi trasferiti ── */}
          <SectionTitle label={`Transferred fields (${transferFields.length})`} color={ACCENT} />
          {transferFields.length > 0 ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 1, maxHeight: 180,
              overflowY: 'auto', padding: '4px 2px', background: '#141a28',
              borderRadius: 6, border: '0.5px solid #2a3349' }}>
              {transferFields.map((f, i) => (
                <div key={f.id ?? `${f.name}_${i}`}
                  style={{ display: 'flex', justifyContent: 'space-between', gap: 8,
                    padding: '3px 8px', fontSize: 10, fontFamily: "'JetBrains Mono', monospace" }}>
                  <span style={{ color: '#c8d4f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                  <span style={{ color: ACCENT, opacity: 0.7, flexShrink: 0 }}>{f.type}</span>
                </div>
              ))}
            </div>
          ) : (
            <div style={{ padding: '8px 10px', background: '#1a2030', borderRadius: 6,
              border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5',
              fontStyle: 'italic', lineHeight: 1.5 }}>
              No schema detected upstream. Connect BridgeOut to a node
              with a defined schema; if the connection already exists, reopen or edit
              the upstream node to re-propagate the schema.
            </div>
          )}

          {/* Output mode */}
          <SectionTitle label="Output to current lane" color={ACCENT} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              {
                value: 'none',
                label: '✕ No output',
                desc:  'BridgeOut is a terminator — the lane stops here. ' +
                       'The data has been delivered to the channel.',
              },
              {
                value: 'passthrough',
                label: '↻ Passthrough',
                desc:  'The same rows sent to the channel are also emitted as output. ' +
                       'Useful to log, write to file or do something else after the bridge.',
              },
              {
                value: 'signal',
                label: '⚡ Signal',
                desc:  'Emits a single status row { channel, rows_sent, status, sent_at } when the delivery is done. ' +
                       'Useful for notifications or completion logs without reprocessing the data.',
              },
            ] as const).map((m) => (
              <button key={m.value} onClick={() => updateProp(nodeId, 'outputMode', m.value)}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                  background: outputMode === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
                  border: outputMode === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
                  display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: outputMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</span>
                <span style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{m.desc}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* ── Sincronismo (P358: solo ciò che il motore fa) ── */}
      {isOut ? (
        <>
          <SectionTitle label="Sync" color={ACCENT} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              { value: 'fire_and_forget', label: '→ Fire & Forget',
                desc: 'This node ends as soon as all rows are handed to the channel.' },
              { value: 'wait_for_ack', label: '⇄ Wait for ack',
                desc: 'This node ends only when the other lane has received all the rows. The status row then says "delivered"; if the other lane stops first, this node fails.' },
            ] as const).map((m) => (
              <button key={m.value} onClick={() => updateProp(nodeId, 'syncMode', m.value)}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                  background: syncMode === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
                  border: syncMode === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
                  display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: syncMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</span>
                <span style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{m.desc}</span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <BridgeInDelivery nodeId={nodeId} accent={ACCENT} timeoutSec={timeoutSec} />
      )}

      {/* ── Info ── */}
      <div style={{ padding: '8px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', lineHeight: 1.6 }}>
        <div style={{ color: ACCENT, fontWeight: 600, marginBottom: 4 }}>
          {isOut ? 'BridgeOut' : 'BridgeIn'} — how it works
        </div>
        {isOut ? (
          <>
            <div>• Receives the flow from the lane and publishes it to the channel <code style={{ color: ACCENT }}>{channelName || '…'}</code></div>
            <div>• Optionally passes the same rows, or a status row, to the next nodes of this lane</div>
            <div>• If the other lane is slower, this lane waits (backpressure)</div>
            <div>• The channel is isolated per run: concurrent executions do not interfere</div>
          </>
        ) : (
          <>
            <div>• Receives the rows that BridgeOut publishes on the channel <code style={{ color: ACCENT }}>{channelName || '…'}</code></div>
            <div>• Emits them to the next nodes of this lane — as they arrive, or all at once</div>
            <div>• The wait timeout protects against a source lane that never produces</div>
          </>
        )}
      </div>
    </div>
  )
}

/**
 * Consegna nella lane del BridgeIn (P358): "as it arrives" o "all at once"
 * (solo flussi completi: se la lane sorgente si interrompe, a valle non
 * arriva niente) + attesa massima. Condiviso col BridgeInModal.
 * Il valore mostrato per i progetti vecchi è quello che il builder applica:
 * "all" solo se il BridgeIn aveva syncMode "gate".
 */
export function BridgeInDelivery({ nodeId, accent, timeoutSec }: { nodeId: string; accent: string; timeoutSec: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  if (!node) return null
  const p = (k: string) => String(node.data.props?.[k] ?? '')
  const delivery = p('delivery') || (p('syncMode') === 'gate' ? 'all' : 'stream')
  return (
    <>
      <SectionTitle label="Delivery to this lane" color={accent} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {([
          { value: 'stream', label: '▶▶ As it arrives',
            desc: 'Rows go downstream as soon as they arrive. If the source lane stops halfway, the rows already passed stay passed and this node fails.' },
          { value: 'all', label: '⬛ All at once',
            desc: 'Rows are held until the whole flow has arrived and the source lane has confirmed it, then passed downstream. If the source lane stops, nothing is passed (no partial data). Rows are kept in memory.' },
        ] as const).map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'delivery', m.value)}
            style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              background: delivery === m.value ? `color-mix(in srgb, ${accent} 15%, #1a2030)` : '#1a2030',
              border: delivery === m.value ? `1px solid ${accent}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: delivery === m.value ? accent : '#c8d4f0' }}>{m.label}</span>
            <span style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{m.desc}</span>
          </button>
        ))}
      </div>
      <SectionTitle label="Timeout" color={accent} />
      <Field label="Wait timeout (seconds)"
        hint="Maximum wait for the first row (or the end of an empty flow) from the source lane. 0 = no limit. If it expires, this node fails.">
        <input type="number" style={inputStyle} value={timeoutSec}
          onChange={(e) => updateProp(nodeId, 'waitTimeoutSec', e.target.value)} min="0" max="86400" />
      </Field>
    </>
  )
}
