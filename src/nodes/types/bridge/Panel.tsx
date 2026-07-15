/**
 * src/nodes/types/bridge/Panel.tsx
 * Pannello condiviso per BridgeOut e BridgeIn.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const allNodes   = useFlowStore((s) => s.nodes)
  const edges      = useFlowStore((s) => s.edges)
  const pool       = useFlowStore((s) => s.pool)
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const selectNode = useFlowStore((s) => s.selectNode)
  const selectLane = useFlowStore((s) => s.selectLane)

  if (!node) return null

  const isOut        = node.data.type === 'bridge_out'
  const p            = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u            = (key: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
      updateProp(nodeId, key, e.target.value)

  const channelName  = p('channelName')
  const channelColor = p('channelColor', '#a78bfa')
  const syncMode     = p('syncMode', 'fire_and_forget')
  const transferMode = p('transferMode', 'content')
  const batchSize    = p('batchSize', '100')
  const timeoutSec   = p('timeoutSec', '30')
  const bufferSize   = p('bufferSize', '0')
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
            <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
              {isOut ? 'Questa lane (OUT)' : 'Questa lane (IN)'}
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
            <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
              {isOut ? 'Lane target (IN)' : 'Lane sorgente (OUT)'}
            </div>
            {counterpart ? (
              <button
                onClick={() => { selectNode(counterpart.id); selectLane(counterpart.data.laneId) }}
                style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, fontWeight: 600, color: ACCENT, padding: 0, textDecoration: 'underline', textUnderlineOffset: 2 }}>
                {counterLane?.label ?? counterpart.data.laneId}
              </button>
            ) : (
              <div style={{ fontSize: 11, color: '#ff5f57', fontStyle: 'italic' }}>
                {channelName ? 'Non trovato' : '—'}
              </div>
            )}
          </div>
        </div>
        {channelName && !counterpart && (
          <div style={{ marginTop: 8, padding: '5px 8px', background: '#2a1010', borderRadius: 4, fontSize: 10, color: '#ff5f57', display: 'flex', gap: 5 }}>
            <i className="ti ti-alert-circle" style={{ fontSize: 11, flexShrink: 0 }} />
            Nodo {isOut ? 'BridgeIn' : 'BridgeOut'} con canale "{channelName}" non trovato in nessuna altra lane.
          </div>
        )}
      </div>

      {/* ── Canale ── */}
      <SectionTitle label="Canale" color={ACCENT} />
      <Field label="Nome canale" hint="Deve corrispondere esattamente tra BridgeOut e BridgeIn">
        <input style={inputStyle} value={channelName} onChange={u('channelName')} placeholder="channel_a" />
      </Field>
      <Field label="Colore canale">
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
          <SectionTitle label={`Campi trasferiti (${transferFields.length})`} color={ACCENT} />
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
              border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a',
              fontStyle: 'italic', lineHeight: 1.5 }}>
              Nessuno schema rilevato a monte. Collega il BridgeOut a un nodo
              con schema definito; se il collegamento c'è già, riapri o modifica
              il nodo a monte per ripropagare lo schema.
            </div>
          )}

          <SectionTitle label="Trasferimento" color={ACCENT} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              {
                value: 'content',
                label: '⬛ Content — one-shot',
                desc:  'Tutto il flusso viene inviato in un unico payload. ' +
                       'BridgeIn riceve tutte le righe prima di proseguire. ' +
                       'Ideale per dataset piccoli o quando B ha bisogno del quadro completo.',
              },
              {
                value: 'stream',
                label: '▶▶ Stream — row-by-row',
                desc:  'Il flusso viene inviato in batch progressivi. ' +
                       'BridgeIn elabora man mano che arrivano i dati. ' +
                       'Ideale per dataset grandi — backpressure naturale.',
              },
            ] as const).map((m) => (
              <button key={m.value} onClick={() => updateProp(nodeId, 'transferMode', m.value)}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                  background: transferMode === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
                  border: transferMode === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
                  display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: transferMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</span>
                <span style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.desc}</span>
              </button>
            ))}
          </div>

          {transferMode === 'stream' && (
            <Field label="Dimensione batch (righe per envelope)"
              hint="Quante righe inviare per envelope. Default 100.">
              <input type="number" style={inputStyle} value={batchSize} onChange={u('batchSize')} min="1" max="10000" />
            </Field>
          )}

          {/* Output mode */}
          <SectionTitle label="Output verso lane corrente" color={ACCENT} />
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {([
              {
                value: 'none',
                label: '✕ Nessun output',
                desc:  'BridgeOut è un terminatore — la lane si ferma qui. ' +
                       'I dati sono stati consegnati al canale.',
              },
              {
                value: 'passthrough',
                label: '↻ Passthrough',
                desc:  'Le stesse righe inviate al canale vengono anche emesse in output. ' +
                       'Utile per loggare, scrivere su file o fare altro dopo il bridge.',
              },
              {
                value: 'signal',
                label: '⚡ Signal',
                desc:  'Emette una sola riga di segnale { channel, rows_sent, status, sent_at }. ' +
                       'Utile per notifiche o log di completamento senza riprocessare i dati.',
              },
            ] as const).map((m) => (
              <button key={m.value} onClick={() => updateProp(nodeId, 'outputMode', m.value)}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                  background: outputMode === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
                  border: outputMode === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
                  display: 'flex', flexDirection: 'column', gap: 3 }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: outputMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</span>
                <span style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.desc}</span>
              </button>
            ))}
          </div>
        </>
      )}

      {/* ── Sincronismo ── */}
      <SectionTitle label="Sincronismo" color={ACCENT} />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {([
          {
            value: 'fire_and_forget',
            label: '→ Fire & Forget',
            desc:  isOut
              ? 'Lane A invia i dati e prosegue immediatamente senza aspettare nulla.'
              : 'Lane B elabora i dati non appena arrivano, senza segnalare Lane A.',
          },
          {
            value: 'wait_for_ack',
            label: '⇄ Wait for Ack',
            desc:  isOut
              ? 'Lane A aspetta la conferma di ricezione di ogni batch prima di inviare il successivo. Produce backpressure.'
              : 'Lane B invia ACK a ogni envelope ricevuto (futuro: per canali remoti).',
          },
          {
            value: 'gate',
            label: '⊟ Gate',
            desc:  isOut
              ? 'Lane A si blocca finché Lane B non è pronta (reserved — implementazione futura).'
              : 'Lane B si blocca finché Lane A non ha completato il flusso (comportamento default di BridgeIn).',
          },
        ] as const).map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'syncMode', m.value)}
            style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              background: syncMode === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: syncMode === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: syncMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</span>
            <span style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.desc}</span>
          </button>
        ))}
      </div>

      {/* ── Timeout (solo BridgeIn) ── */}
      {!isOut && (
        <>
          <SectionTitle label="Timeout" color={ACCENT} />
          <Field label="Timeout attesa (secondi)"
            hint="Tempo massimo di attesa per il primo envelope da BridgeOut. Se scade, la pipeline fallisce con errore esplicito.">
            <input type="number" style={inputStyle} value={timeoutSec} onChange={u('timeoutSec')} min="1" max="3600" />
          </Field>
        </>
      )}

      {/* ── Buffer (solo BridgeOut) ── */}
      {isOut && (
        <>
          <SectionTitle label="Buffer" color={ACCENT} />
          <Field label="Dimensione buffer (righe)" hint="0 = illimitato. Il buffer accoda le righe se BridgeIn non è ancora in ascolto.">
            <input type="number" style={inputStyle} value={bufferSize} onChange={u('bufferSize')} min="0" />
          </Field>
          {parseInt(bufferSize) > 0 && (
            <Field label="Comportamento buffer pieno">
              <CustomSelect style={inputStyle} value={p('bufferFull', 'block')} onChange={u('bufferFull')}>
                <option value="block">Blocca Lane A fino a svuotamento</option>
                <option value="drop">Scarta le nuove righe</option>
                <option value="drop_oldest">Scarta le righe più vecchie</option>
                <option value="error">Errore — interrompe la pipeline</option>
              </CustomSelect>
            </Field>
          )}
        </>
      )}

      {/* ── Info ── */}
      <div style={{ padding: '8px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', lineHeight: 1.6 }}>
        <div style={{ color: ACCENT, fontWeight: 600, marginBottom: 4 }}>
          {isOut ? 'BridgeOut' : 'BridgeIn'} — come funziona
        </div>
        {isOut ? (
          <>
            <div>• Riceve il flusso dalla lane e lo pubblica sul canale <code style={{ color: ACCENT }}>{channelName || '…'}</code></div>
            <div>• Non produce output verso i nodi successivi della lane</div>
            <div>• Il canale è isolato per run: esecuzioni concorrenti non si interferiscono</div>
          </>
        ) : (
          <>
            <div>• Si blocca finché BridgeOut non pubblica sul canale <code style={{ color: ACCENT }}>{channelName || '…'}</code></div>
            <div>• Emette le righe ricevute verso i nodi successivi della lane</div>
            <div>• Il timeout protegge da BridgeOut mancante o crashato</div>
          </>
        )}
      </div>
    </div>
  )
}