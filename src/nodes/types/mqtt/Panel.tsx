/**
 * src/nodes/types/mqtt/Panel.tsx
 *
 * Panel condiviso per source_mqtt (subscriber) e sink_mqtt (publisher).
 * Il ruolo viene dedotto dal tipo del nodo — nessun toggle visibile.
 */
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}

const ACCENT = '#84cc16'

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

function SectionTitle({ label, color = ACCENT }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

export function MQTTPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  if (!node) return null

  // Ruolo dedotto dal tipo nodo — nessun toggle
  const isPublisher = node.data.type === 'sink_mqtt'
  const role        = isPublisher ? 'publisher' : 'subscriber'

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge ruolo — informativo, non modificabile */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${ACCENT} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${ACCENT}30` }}>
        <i className={`ti ${isPublisher ? 'ti-arrow-up-circle' : 'ti-arrow-down-circle'}`} style={{ fontSize: 14, color: ACCENT }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT }}>
            {isPublisher ? 'Publisher' : 'Subscriber'}
          </div>
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>
            {isPublisher ? 'Pubblica messaggi sul topic' : 'Riceve messaggi dal topic'}
          </div>
        </div>
      </div>

      {/* Broker */}
      <SectionTitle label="Broker" />
      <Row2>
        <Field label="Host">
          <input style={inputStyle} value={p('host', 'localhost')} onChange={u('host')} placeholder="localhost" />
        </Field>
        <Field label="Porta">
          <input type="number" style={inputStyle} value={p('port', '1883')} onChange={u('port')} />
        </Field>
      </Row2>

      <Field label="Protocollo">
        <CustomSelect style={inputStyle} value={p('scheme', 'mqtt')} onChange={u('scheme')}>
          <option value="mqtt">mqtt:// — TCP (porta 1883)</option>
          <option value="mqtts">mqtts:// — TLS (porta 8883)</option>
        </CustomSelect>
      </Field>

      <Row2>
        <Field label="Client ID" hint="Vuoto = auto-generato">
          <input style={inputStyle} value={p('clientId', '')} onChange={u('clientId')} placeholder="flowpilot-1" />
        </Field>
        <Field label="Versione MQTT">
          <CustomSelect style={inputStyle} value={p('version', '5')} onChange={u('version')}>
            <option value="3">MQTT 3.1.1</option>
            <option value="5">MQTT 5.0</option>
          </CustomSelect>
        </Field>
      </Row2>

      <Row2>
        <Field label="Username">
          <input style={inputStyle} value={p('username', '')} onChange={u('username')} />
        </Field>
        <Field label="Password">
          <input type="password" style={inputStyle} value={p('password', '')} onChange={u('password')} />
        </Field>
      </Row2>

      {/* Topic */}
      <SectionTitle label="Topic" />
      <Field
        label={isPublisher ? 'Topic di pubblicazione' : 'Topic / Pattern'}
        hint={isPublisher
          ? 'Può essere sovrascritto da un campo della riga (vedi sotto)'
          : 'Supporta wildcard: + (livello singolo), # (tutti i livelli)'}
      >
        <input style={inputStyle} value={p('topic', isPublisher ? 'pipeline/output' : 'sensor/+/data')} onChange={u('topic')}
          placeholder={isPublisher ? 'pipeline/output' : 'sensor/+/data'} />
      </Field>

      {isPublisher && (
        <Field label="Topic da campo riga" hint="Se impostato, usa questo campo come topic dinamico (sovrascrive il topic statico)">
          <input style={inputStyle} value={p('topicField', '')} onChange={u('topicField')} placeholder="device_id" />
        </Field>
      )}

      {/* QoS */}
      <SectionTitle label="Qualità del servizio (QoS)" />
      <Field label="Livello QoS">
        <CustomSelect style={inputStyle} value={p('qos', '1')} onChange={u('qos')}>
          <option value="0">QoS 0 — At most once (fire and forget)</option>
          <option value="1">QoS 1 — At least once (con ack)</option>
          <option value="2">QoS 2 — Exactly once (con handshake)</option>
        </CustomSelect>
      </Field>

      {/* Opzioni specifiche publisher */}
      {isPublisher && (
        <>
          <SectionTitle label="Opzioni publisher" />
          <Row2>
            <Field label="Retain">
              <CustomSelect style={inputStyle} value={p('retain', 'false')} onChange={u('retain')}>
                <option value="false">No</option>
                <option value="true">Sì — il broker mantiene l'ultimo messaggio</option>
              </CustomSelect>
            </Field>
            <Field label="Serializzazione payload">
              <CustomSelect style={inputStyle} value={p('serialization', 'json')} onChange={u('serialization')}>
                <option value="json">JSON</option>
                <option value="text">Testo (toString)</option>
                <option value="bytes">Bytes (base64)</option>
              </CustomSelect>
            </Field>
          </Row2>
        </>
      )}

      {/* Opzioni specifiche subscriber */}
      {!isPublisher && (
        <>
          <SectionTitle label="Opzioni subscriber" />
          <Row2>
            <Field label="Clean session">
              <CustomSelect style={inputStyle} value={p('cleanSession', 'true')} onChange={u('cleanSession')}>
                <option value="true">Sì — nessuna persistenza</option>
                <option value="false">No — sessione duratura</option>
              </CustomSelect>
            </Field>
            <Field label="Max messaggi in coda" hint="0 = illimitato">
              <input type="number" style={inputStyle} value={p('maxQueue', '1000')} onChange={u('maxQueue')} min="0" />
            </Field>
          </Row2>
          <Row2>
            <Field label="Timeout raccolta (ms)" hint="Quanto aspettare messaggi prima di procedere">
              <input type="number" style={inputStyle} value={p('subscribeTimeout', '5000')} onChange={u('subscribeTimeout')} min="100" />
            </Field>
            <Field label="Schema payload">
              <CustomSelect style={inputStyle} value={p('payloadFormat', 'json')} onChange={u('payloadFormat')}>
                <option value="json">JSON — parse automatico</option>
                <option value="text">Testo — campo payload come stringa</option>
                <option value="bytes">Bytes — campo payload come base64</option>
              </CustomSelect>
            </Field>
          </Row2>

          {/* Schema output */}
          <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
            <div style={{ color: '#4a5a7a', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 9 }}>
              Schema output per ogni messaggio ricevuto
            </div>
            {[
              { name: 'topic',       type: 'string',  desc: 'Topic del messaggio' },
              { name: 'payload',     type: 'object',  desc: 'Payload JSON o stringa' },
              { name: 'qos',         type: 'integer', desc: 'Livello QoS' },
              { name: 'retain',      type: 'boolean', desc: 'Flag retain' },
              { name: 'received_at', type: 'date',    desc: 'Timestamp ricezione' },
            ].map((f) => (
              <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                <code style={{ fontSize: 10, color: ACCENT, minWidth: 100 }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a', minWidth: 55 }}>{f.type}</span>
                <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Connessione */}
      <SectionTitle label="Connessione" />
      <Row2>
        <Field label="Keep alive (s)">
          <input type="number" style={inputStyle} value={p('keepAlive', '60')} onChange={u('keepAlive')} min="0" />
        </Field>
        <Field label="Timeout connessione (s)">
          <input type="number" style={inputStyle} value={p('connectTimeout', '10')} onChange={u('connectTimeout')} min="1" />
        </Field>
      </Row2>

    </div>
  )
}