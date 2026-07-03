import { useFlowStore } from '../../../store/flowStore'
import { TransactionGroupEditor } from '../../../components/TransactionGroupEditor'
import { CustomSelect } from '../../../components/CustomSelect'

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e2535',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#c8d4f0',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: '5px 8px',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#9a9aaa',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  marginBottom: 4,
  fontWeight: 600,
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '7px 10px',
      background: '#1a2030',
      borderRadius: 6,
      border: '0.5px solid #2a3349',
    }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function SectionTitle({ label }: { label: string }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 600, color: '#3ddc84',
      textTransform: 'uppercase', letterSpacing: '.08em',
      padding: '4px 0',
      borderBottom: '0.5px solid #2a3349',
      marginBottom: 4,
    }}>
      {label}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
      {children}
    </div>
  )
}

export function SinkKafkaPanel({ nodeId }: { nodeId: string }) {
  const node         = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp   = useFlowStore((s) => s.updateNodeProp)
  const pool         = useFlowStore((s) => s.pool)
  const updateConfig = useFlowStore((s) => s.updateNodeConfig)

  if (!node) return null

  const p = (key: string) => node.data.props[key] ?? ''
  const u = (key: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => updateProp(nodeId, key, e.target.value)

  // Risorse Kafka disponibili nella lane
  const lane      = pool.lanes.find((l) => l.id === node.data.laneId)
  const kafkaRes  = lane?.resources.filter((r) => r.kind === 'kafka') ?? []
  const resId     = node.data.config.resourceId ?? ''
  const valueFormat = p('valueFormat') || 'json'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Connessione */}
      <SectionTitle label="Connessione" />

      {kafkaRes.length === 0 ? (
        <div style={{
          padding: '12px', textAlign: 'center',
          color: '#4a5a7a', fontSize: 11,
          background: '#1a2030', borderRadius: 6,
          border: '1px dashed #2a3349',
        }}>
          <i className="ti ti-topology-star-off" style={{ fontSize: 18, display: 'block', marginBottom: 6 }} aria-hidden="true" />
          Nessuna risorsa Kafka in questa lane.
          Aggiungine una dalla resource strip.
        </div>
      ) : (
        <Field label="Risorsa Kafka">
          <CustomSelect
            style={inputStyle}
            value={resId}
            onChange={(e) => updateConfig(nodeId, { resourceId: e.target.value })}
          >
            <option value="">— seleziona —</option>
            {kafkaRes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} {r.status === 'ok' ? '✓' : '○'}
              </option>
            ))}
          </CustomSelect>
        </Field>
      )}

      {/* Topic */}
      <SectionTitle label="Topic" />

      <Field label="Nome topic" hint="Usa ${variabile} per topic dinamici">
        <input
          type="text" style={inputStyle}
          value={p('topic')}
          onChange={u('topic')}
          placeholder="pipeline-output"
        />
      </Field>

      <Field label="Topic dinamico" hint="Espressione per calcolare il topic da un campo della riga">
        <input
          type="text" style={inputStyle}
          value={p('topicExpression') || ''}
          onChange={u('topicExpression')}
          placeholder="row.tenant_id + '-events' (opzionale)"
        />
      </Field>

      {/* Chiave messaggio */}
      <SectionTitle label="Chiave messaggio" />

      <Row>
        <Field label="Tipo chiave">
          <CustomSelect style={inputStyle} value={p('keyType') || 'field'} onChange={u('keyType')}>
            <option value="none">Nessuna chiave (null)</option>
            <option value="field">Campo della riga</option>
            <option value="expression">Espressione custom</option>
            <option value="uuid">UUID casuale</option>
          </CustomSelect>
        </Field>
        {p('keyType') === 'field' && (
          <Field label="Campo chiave">
            <input
              type="text" style={inputStyle}
              value={p('key_field') || 'id'}
              onChange={u('key_field')}
              placeholder="id"
            />
          </Field>
        )}
        {p('keyType') === 'expression' && (
          <Field label="Espressione chiave">
            <input
              type="text" style={inputStyle}
              value={p('keyExpression') || ''}
              onChange={u('keyExpression')}
              placeholder="row.tenant + ':' + row.id"
            />
          </Field>
        )}
      </Row>

      {/* Formato messaggio */}
      <SectionTitle label="Formato messaggio" />

      <Row>
        <Field label="Formato valore">
          <CustomSelect style={inputStyle} value={valueFormat} onChange={u('valueFormat')}>
            <option value="json">JSON</option>
            <option value="avro">Avro</option>
            <option value="protobuf">Protobuf</option>
            <option value="string">String plain</option>
            <option value="bytes">Bytes raw</option>
          </CustomSelect>
        </Field>
        <Field label="Formato chiave">
          <CustomSelect style={inputStyle} value={p('keyFormat') || 'string'} onChange={u('keyFormat')}>
            <option value="string">String</option>
            <option value="json">JSON</option>
            <option value="long">Long</option>
            <option value="bytes">Bytes</option>
          </CustomSelect>
        </Field>
      </Row>

      {/* Schema Registry per Avro/Protobuf */}
      {['avro', 'protobuf'].includes(valueFormat) && (
        <>
          <SectionTitle label="Schema Registry" />
          <Field label="Schema Registry URL">
            <input
              type="text" style={inputStyle}
              value={p('schemaRegistryUrl') || 'http://localhost:8081'}
              onChange={u('schemaRegistryUrl')}
              placeholder="http://localhost:8081"
            />
          </Field>
          <Row>
            <Field label="Schema soggetto">
              <input
                type="text" style={inputStyle}
                value={p('schemaSubject') || ''}
                onChange={u('schemaSubject')}
                placeholder="pipeline-output-value"
              />
            </Field>
            <Field label="Versione schema">
              <CustomSelect style={inputStyle} value={p('schemaVersion') || 'latest'} onChange={u('schemaVersion')}>
                <option value="latest">Latest</option>
                <option value="1">1</option>
                <option value="2">2</option>
                <option value="3">3</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {/* Headers Kafka */}
      <SectionTitle label="Headers Kafka" />
      <Field
        label="Headers statici (JSON)"
        hint='Es: {"source": "flowpilot", "version": "1.0"}'
      >
        <textarea
          style={{ ...inputStyle, resize: 'vertical', minHeight: 48, fontFamily: 'monospace' }}
          value={p('headers') || '{}'}
          onChange={u('headers')}
          spellCheck={false}
        />
      </Field>

      {/* Partizioni */}
      <SectionTitle label="Partizioni" />
      <Row>
        <Field label="Strategia partizione">
          <CustomSelect style={inputStyle} value={p('partitionStrategy') || 'default'} onChange={u('partitionStrategy')}>
            <option value="default">Default (hash della chiave)</option>
            <option value="round_robin">Round Robin</option>
            <option value="field">Campo specifico</option>
            <option value="manual">Manuale (numero fisso)</option>
          </CustomSelect>
        </Field>
        {p('partitionStrategy') === 'field' && (
          <Field label="Campo partizione">
            <input
              type="text" style={inputStyle}
              value={p('partitionField') || ''}
              onChange={u('partitionField')}
              placeholder="region"
            />
          </Field>
        )}
        {p('partitionStrategy') === 'manual' && (
          <Field label="Numero partizione">
            <input
              type="number" style={inputStyle}
              value={p('partition') || '0'}
              onChange={u('partition')}
              min="0"
            />
          </Field>
        )}
      </Row>

      {/* Producer config */}
      <SectionTitle label="Configurazione producer" />
      <Row>
        <Field label="Acks">
          <CustomSelect style={inputStyle} value={p('acks') || 'all'} onChange={u('acks')}>
            <option value="0">0 — Fire and forget</option>
            <option value="1">1 — Leader acknowledgment</option>
            <option value="all">all — Full ISR acknowledgment</option>
          </CustomSelect>
        </Field>
        <Field label="Compression">
          <CustomSelect style={inputStyle} value={p('compression') || 'none'} onChange={u('compression')}>
            <option value="none">Nessuna</option>
            <option value="gzip">GZIP</option>
            <option value="snappy">Snappy</option>
            <option value="lz4">LZ4</option>
            <option value="zstd">ZSTD</option>
          </CustomSelect>
        </Field>
      </Row>

      <Row>
        <Field label="Batch size (bytes)">
          <input
            type="number" style={inputStyle}
            value={p('batchSize') || '16384'}
            onChange={u('batchSize')}
            min="1"
          />
        </Field>
        <Field label="Linger ms" hint="Attesa max prima di inviare batch">
          <input
            type="number" style={inputStyle}
            value={p('lingerMs') || '5'}
            onChange={u('lingerMs')}
            min="0"
          />
        </Field>
      </Row>

      <Row>
        <Field label="Retry invio">
          <input
            type="number" style={inputStyle}
            value={p('retries') || '3'}
            onChange={u('retries')}
            min="0"
          />
        </Field>
        <Field label="Timeout (ms)">
          <input
            type="number" style={inputStyle}
            value={p('deliveryTimeoutMs') || '30000'}
            onChange={u('deliveryTimeoutMs')}
            min="0"
          />
        </Field>
      </Row>
      {/*Transazione*/}
      <SectionTitle label="Transazione" />
        <TransactionGroupEditor nodeId={nodeId} nodeType="sink_kafka" />
    </div>
  )
}