/**
 * src/nodes/types/activemq/Panel.tsx
 *
 * Panel condiviso per source_activemq (consumer) e sink_activemq (producer).
 * Il ruolo viene dedotto dal tipo del nodo — nessun toggle visibile.
 */
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { useActiveMQSourceSchemaSync } from './schema'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}

const ACCENT = '#fb923c'

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
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

export function ActiveMQPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  // Propaga lo schema d'uscita del consumer a valle (no-op per il producer).
  // PRIMA dell'early-return, per le regole degli hook.
  useActiveMQSourceSchemaSync(nodeId)
  if (!node) return null

  // Ruolo dedotto dal tipo nodo — nessun toggle
  const isProducer = node.data.type === 'sink_activemq'

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const protocol = p('protocol', 'stomp')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge ruolo */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${ACCENT} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${ACCENT}30` }}>
        <i className={`ti ${isProducer ? 'ti-arrow-up-circle' : 'ti-arrow-down-circle'}`} style={{ fontSize: 14, color: ACCENT }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT }}>
            {isProducer ? 'Producer' : 'Consumer'}
          </div>
          <div style={{ fontSize: 9, color: '#8593b5' }}>
            {isProducer ? 'Publishes messages to the queue/topic' : 'Receives messages from the queue/topic'}
          </div>
        </div>
      </div>

      {/* Protocollo */}
      <SectionTitle label="Protocol" />
      <Field label="Connection protocol" hint="STOMP is the most compatible and simplest to configure">
        <CustomSelect style={inputStyle} value={protocol} onChange={u('protocol')}>
          <option value="stomp">STOMP (port 61613) — recommended</option>
          <option value="openwire">OpenWire (port 61616) — native ActiveMQ</option>
          <option value="amqp">AMQP (port 5672)</option>
        </CustomSelect>
      </Field>

      {/* Connessione */}
      <SectionTitle label="Broker connection" />
      <Row2>
        <Field label="Host">
          <input style={inputStyle} value={p('host', 'localhost')} onChange={u('host')} placeholder="localhost" />
        </Field>
        <Field label="Port">
          <input type="number" style={inputStyle}
            value={p('port', protocol === 'stomp' ? '61613' : protocol === 'amqp' ? '5672' : '61616')}
            onChange={u('port')} />
        </Field>
      </Row2>
      <Row2>
        <Field label="Username">
          <input style={inputStyle} value={p('username', 'admin')} onChange={u('username')} />
        </Field>
        <Field label="Password">
          <input type="password" style={inputStyle} value={p('password')} onChange={u('password')} />
        </Field>
      </Row2>
      <Row2>
        <Field label="Virtual host">
          <input style={inputStyle} value={p('vhost', '/')} onChange={u('vhost')} placeholder="/" />
        </Field>
        <Field label="TLS/SSL">
          <CustomSelect style={inputStyle} value={p('tls', 'false')} onChange={u('tls')}>
            <option value="false">Disabled</option>
            <option value="true">Enabled</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Destinazione */}
      <SectionTitle label="Destination" />
      <Row2>
        <Field label="Type">
          <CustomSelect style={inputStyle} value={p('destType', 'queue')} onChange={u('destType')}>
            <option value="queue">Queue — guaranteed delivery</option>
            <option value="topic">Topic — publish/subscribe</option>
          </CustomSelect>
        </Field>
        <Field label="Name">
          <input style={inputStyle} value={p('destination', 'pipeline.input')} onChange={u('destination')} placeholder="pipeline.input" />
        </Field>
      </Row2>

      {/* Opzioni consumer */}
      {!isProducer && (
        <>
          <SectionTitle label="Consumer options" />
          <Row2>
            <Field label="Acknowledge mode">
              <CustomSelect style={inputStyle} value={p('ackMode', 'auto')} onChange={u('ackMode')}>
                <option value="auto">Auto — after reception</option>
                <option value="client">Client — manual ack</option>
              </CustomSelect>
            </Field>
            <Field label="Prefetch" hint="Messages to pre-load">
              <input type="number" style={inputStyle} value={p('prefetch', '1')} onChange={u('prefetch')} min="1" />
            </Field>
          </Row2>
          <Row2>
            <Field label="Receive timeout (ms)" hint="0 = infinite wait">
              <input type="number" style={inputStyle} value={p('receiveTimeout', '5000')} onChange={u('receiveTimeout')} min="0" />
            </Field>
            <Field label="Max messages" hint="0 = unlimited">
              <input type="number" style={inputStyle} value={p('maxMessages', '1000')} onChange={u('maxMessages')} min="0" />
            </Field>
          </Row2>
          <Field label="JMS selector" hint="SQL-like message filter — e.g. type='order'">
            <input style={inputStyle} value={p('selector', '')} onChange={u('selector')} placeholder="type='order'" />
          </Field>
          <Field label="Durable subscription (topic only)">
            <CustomSelect style={inputStyle} value={p('durable', 'false')} onChange={u('durable')}>
              <option value="false">No</option>
              <option value="true">Yes — keep messages offline</option>
            </CustomSelect>
          </Field>

          {/* Schema output */}
          <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
            <div style={{ color: '#8593b5', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 9 }}>
              Output schema for each received message
            </div>
            {[
              { name: 'destination', type: 'string',  desc: 'Queue/topic name' },
              { name: 'payload',     type: 'object',  desc: 'JSON or string payload' },
              { name: 'headers',     type: 'object',  desc: 'Message JMS headers' },
              { name: 'message_id',  type: 'string',  desc: 'JMSMessageID' },
              { name: 'received_at', type: 'date',    desc: 'Reception timestamp' },
            ].map((f) => (
              <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                <code style={{ fontSize: 10, color: ACCENT, minWidth: 110 }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#8593b5', minWidth: 55 }}>{f.type}</span>
                <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Opzioni producer */}
      {isProducer && (
        <>
          <SectionTitle label="Producer options" />
          <Row2>
            <Field label="Serialization">
              <CustomSelect style={inputStyle} value={p('serialization', 'json')} onChange={u('serialization')}>
                <option value="json">JSON</option>
                <option value="text">Text (toString)</option>
                <option value="bytes">Bytes (base64)</option>
              </CustomSelect>
            </Field>
            <Field label="Persistent">
              <CustomSelect style={inputStyle} value={p('persistent', 'true')} onChange={u('persistent')}>
                <option value="true">Yes — PERSISTENT</option>
                <option value="false">No — NON_PERSISTENT</option>
              </CustomSelect>
            </Field>
          </Row2>
          <Row2>
            <Field label="Priority (0-9)">
              <input type="number" style={inputStyle} value={p('priority', '4')} onChange={u('priority')} min="0" max="9" />
            </Field>
            <Field label="TTL (ms)" hint="0 = no expiry">
              <input type="number" style={inputStyle} value={p('ttl', '0')} onChange={u('ttl')} min="0" />
            </Field>
          </Row2>
          <Field label="Correlation ID from field" hint="Row field to use as JMSCorrelationID">
            <input style={inputStyle} value={p('correlationIdField', '')} onChange={u('correlationIdField')} placeholder="request_id" />
          </Field>
        </>
      )}

      {/* Resilienza */}
      <SectionTitle label="Resilience" />
      <Row2>
        <Field label="Connection retry">
          <input type="number" style={inputStyle} value={p('retryCount', '3')} onChange={u('retryCount')} min="0" />
        </Field>
        <Field label="Retry delay (s)">
          <input type="number" style={inputStyle} value={p('retryDelay', '5')} onChange={u('retryDelay')} min="1" />
        </Field>
      </Row2>

    </div>
  )
}