/**
 * src/nodes/types/activemq/Panel.tsx
 *
 * Panel condiviso per source_activemq (consumer) e sink_activemq (producer).
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

const ACCENT = '#fb923c'

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

export function ActiveMQPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
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
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>
            {isProducer ? 'Pubblica messaggi sulla coda/topic' : 'Riceve messaggi dalla coda/topic'}
          </div>
        </div>
      </div>

      {/* Protocollo */}
      <SectionTitle label="Protocollo" />
      <Field label="Protocollo di connessione" hint="STOMP è il più compatibile e semplice da configurare">
        <CustomSelect style={inputStyle} value={protocol} onChange={u('protocol')}>
          <option value="stomp">STOMP (porta 61613) — consigliato</option>
          <option value="openwire">OpenWire (porta 61616) — nativo ActiveMQ</option>
          <option value="amqp">AMQP (porta 5672)</option>
        </CustomSelect>
      </Field>

      {/* Connessione */}
      <SectionTitle label="Connessione broker" />
      <Row2>
        <Field label="Host">
          <input style={inputStyle} value={p('host', 'localhost')} onChange={u('host')} placeholder="localhost" />
        </Field>
        <Field label="Porta">
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
            <option value="false">Disabilitato</option>
            <option value="true">Abilitato</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Destinazione */}
      <SectionTitle label="Destinazione" />
      <Row2>
        <Field label="Tipo">
          <CustomSelect style={inputStyle} value={p('destType', 'queue')} onChange={u('destType')}>
            <option value="queue">Queue — delivery garantito</option>
            <option value="topic">Topic — publish/subscribe</option>
          </CustomSelect>
        </Field>
        <Field label="Nome">
          <input style={inputStyle} value={p('destination', 'pipeline.input')} onChange={u('destination')} placeholder="pipeline.input" />
        </Field>
      </Row2>

      {/* Opzioni consumer */}
      {!isProducer && (
        <>
          <SectionTitle label="Opzioni consumer" />
          <Row2>
            <Field label="Acknowledge mode">
              <CustomSelect style={inputStyle} value={p('ackMode', 'auto')} onChange={u('ackMode')}>
                <option value="auto">Auto — dopo ricezione</option>
                <option value="client">Client — ack manuale</option>
              </CustomSelect>
            </Field>
            <Field label="Prefetch" hint="Messaggi da pre-caricare">
              <input type="number" style={inputStyle} value={p('prefetch', '1')} onChange={u('prefetch')} min="1" />
            </Field>
          </Row2>
          <Row2>
            <Field label="Timeout ricezione (ms)" hint="0 = attesa infinita">
              <input type="number" style={inputStyle} value={p('receiveTimeout', '5000')} onChange={u('receiveTimeout')} min="0" />
            </Field>
            <Field label="Max messaggi" hint="0 = illimitato">
              <input type="number" style={inputStyle} value={p('maxMessages', '1000')} onChange={u('maxMessages')} min="0" />
            </Field>
          </Row2>
          <Field label="Selettore JMS" hint="Filtro messaggi SQL-like — es: type='order'">
            <input style={inputStyle} value={p('selector', '')} onChange={u('selector')} placeholder="type='order'" />
          </Field>
          <Field label="Durable subscription (solo topic)">
            <CustomSelect style={inputStyle} value={p('durable', 'false')} onChange={u('durable')}>
              <option value="false">No</option>
              <option value="true">Sì — mantieni messaggi offline</option>
            </CustomSelect>
          </Field>

          {/* Schema output */}
          <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
            <div style={{ color: '#4a5a7a', marginBottom: 6, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 9 }}>
              Schema output per ogni messaggio ricevuto
            </div>
            {[
              { name: 'destination', type: 'string',  desc: 'Nome coda/topic' },
              { name: 'payload',     type: 'object',  desc: 'Payload JSON o stringa' },
              { name: 'headers',     type: 'object',  desc: 'Header JMS del messaggio' },
              { name: 'message_id',  type: 'string',  desc: 'JMSMessageID' },
              { name: 'received_at', type: 'date',    desc: 'Timestamp ricezione' },
            ].map((f) => (
              <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                <code style={{ fontSize: 10, color: ACCENT, minWidth: 110 }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a', minWidth: 55 }}>{f.type}</span>
                <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
              </div>
            ))}
          </div>
        </>
      )}

      {/* Opzioni producer */}
      {isProducer && (
        <>
          <SectionTitle label="Opzioni producer" />
          <Row2>
            <Field label="Serializzazione">
              <CustomSelect style={inputStyle} value={p('serialization', 'json')} onChange={u('serialization')}>
                <option value="json">JSON</option>
                <option value="text">Testo (toString)</option>
                <option value="bytes">Bytes (base64)</option>
              </CustomSelect>
            </Field>
            <Field label="Persistente">
              <CustomSelect style={inputStyle} value={p('persistent', 'true')} onChange={u('persistent')}>
                <option value="true">Sì — PERSISTENT</option>
                <option value="false">No — NON_PERSISTENT</option>
              </CustomSelect>
            </Field>
          </Row2>
          <Row2>
            <Field label="Priority (0-9)">
              <input type="number" style={inputStyle} value={p('priority', '4')} onChange={u('priority')} min="0" max="9" />
            </Field>
            <Field label="TTL (ms)" hint="0 = nessuna scadenza">
              <input type="number" style={inputStyle} value={p('ttl', '0')} onChange={u('ttl')} min="0" />
            </Field>
          </Row2>
          <Field label="Correlation ID dal campo" hint="Campo della riga da usare come JMSCorrelationID">
            <input style={inputStyle} value={p('correlationIdField', '')} onChange={u('correlationIdField')} placeholder="request_id" />
          </Field>
        </>
      )}

      {/* Resilienza */}
      <SectionTitle label="Resilienza" />
      <Row2>
        <Field label="Retry connessione">
          <input type="number" style={inputStyle} value={p('retryCount', '3')} onChange={u('retryCount')} min="0" />
        </Field>
        <Field label="Delay retry (s)">
          <input type="number" style={inputStyle} value={p('retryDelay', '5')} onChange={u('retryDelay')} min="1" />
        </Field>
      </Row2>

    </div>
  )
}