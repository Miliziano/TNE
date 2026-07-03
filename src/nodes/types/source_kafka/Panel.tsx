/**
 * src/nodes/types/source_kafka/Panel.tsx
 */
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#4a9eff'

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
function SectionTitle({ label, color = ACCENT }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

export function KafkaSourcePanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const laneId     = node.data.laneId
  const resourceId = node.data.config?.resourceId ?? ''
  const lane       = pool.lanes.find((l) => l.id === laneId)
  const resources  = (lane?.resources ?? []).filter((r) => r.kind === 'kafka')
  const resource   = resources.find((r) => r.id === resourceId)

  const fetchMode  = p('fetchMode', 'streaming')  // 'streaming' | 'batch'
  const offsetMode = p('offsetMode', 'latest')
  const valueFormat = p('valueFormat', 'json')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info risorsa */}
      {resource ? (
        <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 8, alignItems: 'center' }}>
          <i className="ti ti-brand-kafka" style={{ fontSize: 14, color: ACCENT }} />
          <div>
            <div style={{ fontWeight: 600, color: ACCENT }}>{resource.label}</div>
            <div style={{ fontSize: 9, color: '#4a5a7a' }}>broker: {resource.config?.broker ?? '—'}</div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '10px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Aggiungi una risorsa Kafka dalla resource strip, poi selezionala nel tab Connessione.
        </div>
      )}

      {/* Topic */}
      <SectionTitle label="Topic" />
      <Field label="Topic/i" hint="Un topic o più separati da virgola — es: ordini, clienti, prodotti">
        <input style={{ ...inputStyle, color: ACCENT }} value={p('topics')}
          onChange={u('topics')} placeholder="ordini" />
      </Field>
      <Field label="Pattern topic (regex)" hint="Alternativa al topic fisso — sottoscrivi a tutti i topic che corrispondono">
        <input style={inputStyle} value={p('topicPattern')}
          onChange={u('topicPattern')} placeholder="ordini-.*" />
        {p('topicPattern') && (
          <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>
            Il pattern ha priorità sui topic fissi.
          </div>
        )}
      </Field>

      {/* Consumer group */}
      <SectionTitle label="Consumer" />
      <Field label="Consumer group ID" hint="Identifica il gruppo — Kafka distribuisce le partizioni tra i consumer dello stesso gruppo">
        <input style={inputStyle} value={p('groupId')}
          onChange={u('groupId')} placeholder="flowpilot-consumer-1" />
      </Field>
      <Field label="Client ID" hint="Identificatore opzionale del client per il monitoring">
        <input style={inputStyle} value={p('clientId')}
          onChange={u('clientId')} placeholder="flowpilot" />
      </Field>

      {/* Offset */}
      <SectionTitle label="Offset iniziale" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'latest',    label: 'Latest',    desc: 'Leggi solo i messaggi nuovi dal momento della connessione', color: ACCENT },
          { value: 'earliest',  label: 'Earliest',  desc: 'Leggi dall\'inizio — tutti i messaggi disponibili nella retention', color: '#3ddc84' },
          { value: 'committed', label: 'Committed', desc: 'Riprendi dall\'ultimo offset committato per questo consumer group', color: '#ffb347' },
          { value: 'timestamp', label: 'Timestamp', desc: 'Leggi a partire da un timestamp specifico', color: '#a78bfa' },
        ].map((o) => (
          <button key={o.value} onClick={() => updateProp(nodeId, 'offsetMode', o.value)}
            style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, background: offsetMode === o.value ? `color-mix(in srgb, ${o.color} 8%, #1a2030)` : '#1a2030', border: offsetMode === o.value ? `1px solid ${o.color}40` : '1px solid #2a3349' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: offsetMode === o.value ? o.color : 'transparent', border: `1.5px solid ${offsetMode === o.value ? o.color : '#2a3349'}` }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: offsetMode === o.value ? o.color : '#c8d4f0' }}>{o.label}</div>
              <div style={{ fontSize: 9, color: '#4a5a7a' }}>{o.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {offsetMode === 'timestamp' && (
        <Field label="Timestamp di partenza" hint="Formato ISO 8601 — es: 2024-01-15T08:00:00Z">
          <input style={inputStyle} value={p('startTimestamp')}
            onChange={u('startTimestamp')} placeholder="2024-01-15T08:00:00Z" />
        </Field>
      )}

      {/* Deserializzazione */}
      <SectionTitle label="Deserializzazione" />
      <Row>
        <Field label="Formato valore">
          <CustomSelect style={inputStyle} value={valueFormat} onChange={u('valueFormat')}>
            <option value="json">JSON</option>
            <option value="avro">Avro (Schema Registry)</option>
            <option value="protobuf">Protobuf</option>
            <option value="string">String (testo grezzo)</option>
            <option value="bytes">Bytes (binario)</option>
          </CustomSelect>
        </Field>
        <Field label="Formato chiave">
          <CustomSelect style={inputStyle} value={p('keyFormat', 'string')} onChange={u('keyFormat')}>
            <option value="string">String</option>
            <option value="json">JSON</option>
            <option value="long">Long (integer)</option>
            <option value="ignore">Ignora chiave</option>
          </CustomSelect>
        </Field>
      </Row>

      {/* Schema Registry per Avro/Protobuf */}
      {(valueFormat === 'avro' || valueFormat === 'protobuf') && (
        <Field label="Schema Registry URL" hint="Confluent Schema Registry o compatibile">
          <input style={inputStyle} value={p('schemaRegistryUrl')}
            onChange={u('schemaRegistryUrl')} placeholder="http://schema-registry:8081" />
        </Field>
      )}

      {/* Modalità acquisizione */}
      <SectionTitle label="Modalità acquisizione" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          { value: 'streaming', label: '◎ Streaming', desc: 'Legge continuamente — emette righe man mano che arrivano', color: ACCENT },
          { value: 'batch',     label: '▤ Batch',      desc: 'Legge fino al limite configurato poi chiude la connessione', color: '#ffb347' },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'fetchMode', m.value)}
            style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: fetchMode === m.value ? `color-mix(in srgb, ${m.color} 12%, #1a2030)` : '#1a2030', border: fetchMode === m.value ? `1px solid ${m.color}60` : '1px solid #2a3349' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: fetchMode === m.value ? m.color : '#c8d4f0' }}>{m.label}</div>
            <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.desc}</div>
          </button>
        ))}
      </div>

      {fetchMode === 'batch' && (
        <Row>
          <Field label="Max messaggi" hint="0 = nessun limite (fino a fine partizione)">
            <input type="number" style={inputStyle} value={p('maxMessages', '1000')}
              onChange={u('maxMessages')} min="0" />
          </Field>
          <Field label="Timeout (ms)" hint="Attesa massima per nuovi messaggi prima di chiudere">
            <input type="number" style={inputStyle} value={p('pollTimeout', '5000')}
              onChange={u('pollTimeout')} min="100" />
          </Field>
        </Row>
      )}

      {/* Campi metadati */}
      <SectionTitle label="Metadati messaggio" color="#4a5a7a" />
      <Field label="Includi metadati Kafka nel record">
        <CustomSelect style={inputStyle} value={p('includeMetadata', 'false')} onChange={u('includeMetadata')}>
          <option value="false">No — solo il payload deserializzato</option>
          <option value="true">Sì — aggiungi campi _kafka_*</option>
        </CustomSelect>
      </Field>
      {p('includeMetadata') === 'true' && (
        <div style={{ padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 9, color: '#4a5a7a', lineHeight: 1.8 }}>
          Campi aggiunti: <code style={{ color: ACCENT }}>_kafka_topic</code>, <code style={{ color: ACCENT }}>_kafka_partition</code>,
          <code style={{ color: ACCENT }}> _kafka_offset</code>, <code style={{ color: ACCENT }}>_kafka_timestamp</code>,
          <code style={{ color: ACCENT }}> _kafka_key</code>
        </div>
      )}

      {/* Commit offset */}
      <SectionTitle label="Commit offset" color="#4a5a7a" />
      <Row>
        <Field label="Auto commit">
          <CustomSelect style={inputStyle} value={p('autoCommit', 'true')} onChange={u('autoCommit')}>
            <option value="true">Sì — commit automatico ogni intervallo</option>
            <option value="false">No — commit manuale (at-least-once)</option>
          </CustomSelect>
        </Field>
        {p('autoCommit') === 'true' && (
          <Field label="Intervallo commit (ms)">
            <input type="number" style={inputStyle} value={p('autoCommitInterval', '5000')}
              onChange={u('autoCommitInterval')} min="100" />
          </Field>
        )}
      </Row>

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', lineHeight: 1.5 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4, color: ACCENT }} />
        Con <strong style={{ color: '#c8d4f0' }}>auto commit disabilitato</strong> il commit avviene solo dopo che la riga ha
        attraversato l'intera pipeline con successo — garantisce at-least-once processing.
      </div>
    </div>
  )
}
