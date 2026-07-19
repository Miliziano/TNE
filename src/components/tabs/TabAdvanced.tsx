import { useFlowStore } from '../../store/flowStore'
import { CustomSelect } from '../../components/CustomSelect'
import { normalizeOnError } from '../../types'

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e2535',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#c8d4f0',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: '6px 10px',
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

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#c8d4f0',
  textTransform: 'uppercase', letterSpacing: '.08em',
  padding: '8px 0 8px', borderBottom: '1px solid #2a3349', marginBottom: 4,
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      {children}
    </div>
  )
}

function SectionTitle({ label }: { label: string }) {
  return <div style={sectionTitleStyle}>{label}</div>
}

const CATCH_COLOR = '#f97316'
const ACCENT_DW   = '#22d3ee'

function NodeStatusSection({ nodeId }: { nodeId: string }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  if (!node) return null

  const passthrough    = node.data.props['passthrough'] === 'true'
  const processingMode = node.data.props['processingMode'] ?? 'streaming'

  const statusFields: Array<{ name: string; type: string; desc: string }> = (() => {
    const base = [
      { name: 'ok',             type: 'boolean', desc: 'Esecuzione riuscita' },
      { name: 'node_id',        type: 'string',  desc: 'ID del nodo' },
      { name: 'node_type',      type: 'string',  desc: 'Tipo del nodo' },
      { name: 'timestamp',      type: 'date',    desc: 'Timestamp elaborazione' },
      { name: 'rows_processed', type: 'integer', desc: 'Righe elaborate' },
      { name: 'duration_ms',    type: 'integer', desc: 'Durata in millisecondi' },
      { name: 'error_message',  type: 'string',  desc: 'Messaggio errore (vuoto se ok)' },
    ]
    switch (node.data.type) {
      case 'source_db': case 'source_file': case 'source_http':
        return [...base, { name: 'rows_read', type: 'integer', desc: 'Righe lette dalla sorgente' }]
      case 'sink_file':
        return [...base,
          { name: 'rows_written',  type: 'integer', desc: 'Righe scritte nel file' },
          { name: 'bytes_written', type: 'integer', desc: 'Byte scritti' },
          { name: 'file_path',     type: 'string',  desc: 'Path del file scritto' },
        ]
      case 'sink_db':
        return [...base,
          { name: 'rows_inserted', type: 'integer', desc: 'Righe inserite' },
          { name: 'rows_updated',  type: 'integer', desc: 'Righe aggiornate' },
          { name: 'rows_rejected', type: 'integer', desc: 'Righe rifiutate' },
        ]
      case 'filter':
        return [...base, { name: 'rows_filtered', type: 'integer', desc: 'Righe filtrate (scartate)' }]
      default:
        return base
    }
  })()

  return (
    <>
      <SectionTitle label="Status — campi emessi verso il nodo successivo" />
      {node.data.type === 'sink_file' && (
        <div style={{ padding: '8px 10px', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 8 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 13, color: '#4a9eff' }} />
          <div style={{ flex: 1, fontSize: 10, color: '#9a9aaa' }}>
            {passthrough
              ? processingMode === 'streaming'
                ? 'row: dati originali (riga per riga) + status'
                : 'row: dati originali (dopo chiusura file, riga per riga) + status'
              : 'row: {} vuoto + status — un solo messaggio alla fine'}
          </div>
        </div>
      )}
      <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 1fr', gap: 8, padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
          {['status.*', 'Tipo', 'Descrizione'].map((h) => (
            <div key={h} style={{ fontSize: 10, color: '#4a9eff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
          ))}
        </div>
        {statusFields.map((f, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 1fr', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < statusFields.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
            <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#c8d4f0' }}>{f.name}</span>
            <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#1a3a6a', color: '#4a9eff', textAlign: 'center' }}>{f.type}</span>
            <span style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{f.desc}</span>
          </div>
        ))}
      </div>
      <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, marginRight: 4 }} />
        Tutti i campi status vengono anche scritti nelle variabili di lane come{' '}
        <strong style={{ color: '#9a9aaa' }}>{node.data.type}.{nodeId}.*</strong>
      </div>
    </>
  )
}

export function TabAdvanced({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateAdvanced = useFlowStore((s) => s.updateNodeAdvanced)
  const updateProp     = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null
  const adv     = node.data.config.advanced
  const onError = normalizeOnError(adv?.onError)
  const isRetry = onError === 'retry_handler' || onError === 'retry_catch'
  const isDirWatcher = node.data.type === 'dir_watcher'

  // Handler timeout — per dir_watcher sincronizza anche watchTimeoutSec
  const handleTimeoutChange = (value: string) => {
    updateAdvanced(nodeId, 'timeoutSec', value)
    if (isDirWatcher) {
      // Sincronizza con il campo watchTimeoutSec nel tab Configurazione
      updateProp(nodeId, 'watchTimeoutSec', value)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionTitle label="Timeout e retry" />

      {/* Nota contestuale per DirWatcher */}
      {isDirWatcher && (
        <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${ACCENT_DW} 8%, #0f1117)`, borderRadius: 4, border: `0.5px solid ${ACCENT_DW}30`, fontSize: 9, color: ACCENT_DW, display: 'flex', gap: 6 }}>
          <i className="ti ti-refresh" style={{ fontSize: 10, flexShrink: 0 }} />
          Il campo <strong>Timeout</strong> è sincronizzato con <strong>Timeout watch</strong> nel tab Configurazione — modificando uno si aggiorna l'altro.
        </div>
      )}

      <Row>
        <Field label={isDirWatcher ? 'Timeout watch (secondi)' : 'Timeout (secondi)'}>
          <input type="number" style={inputStyle} value={adv?.timeoutSec ?? '30'}
            onChange={(e) => handleTimeoutChange(e.target.value)} />
        </Field>
        <Field label="In caso di errore">
          <CustomSelect style={inputStyle} value={onError}
            onChange={(e) => updateAdvanced(nodeId, 'onError', e.target.value)}>
            <option value="handler">Error handler — la lane decide</option>
            <option value="catch">Cattura sul nodo — abilita handle catch</option>
            <option value="retry_handler">Riprova, poi error handler</option>
            <option value="retry_catch">Riprova, poi cattura sul nodo</option>
          </CustomSelect>
        </Field>
      </Row>
      {isRetry && (
        <Row>
          <Field label="Numero di retry">
            <input type="number" style={inputStyle} value={adv?.retryCount ?? '0'}
              onChange={(e) => updateAdvanced(nodeId, 'retryCount', e.target.value)} />
          </Field>
          <Field label="Delay tra retry (secondi)">
            <input type="number" style={inputStyle} value={adv?.retryDelaySec ?? '5'}
              onChange={(e) => updateAdvanced(nodeId, 'retryDelaySec', e.target.value)} />
          </Field>
        </Row>
      )}

      {(onError === 'catch' || onError === 'retry_catch') && (
        <div style={{
          padding: '10px 12px', fontSize: 10, color: CATCH_COLOR,
          background: `color-mix(in srgb, ${CATCH_COLOR} 8%, #0f1117)`,
          borderRadius: 6, border: `0.5px solid ${CATCH_COLOR}30`,
          display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.6,
        }}>
          <i className="ti ti-bug" style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Handle catch attivo</div>
            L'handle <strong style={{ color: CATCH_COLOR }}>catch</strong> è ora visibile sul nodo.
            Le righe che causano un'eccezione non controllata escono da catch
            arricchite dei campi:
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {[
                { name: '_error_message',   type: 'string', desc: 'Messaggio dell\'eccezione' },
                { name: '_error_code',      type: 'string', desc: 'Tipo / codice errore' },
                { name: '_error_node_id',   type: 'string', desc: 'ID del nodo che ha generato l\'errore' },
                { name: '_error_node_type', type: 'string', desc: 'Tipo del nodo' },
                { name: '_error_at',        type: 'date',   desc: 'Timestamp dell\'eccezione' },
                { name: '_error_row',       type: 'object', desc: 'La riga originale che ha causato l\'errore' },
              ].map((f) => (
                <div key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <code style={{ fontSize: 10, color: CATCH_COLOR, minWidth: 140, flexShrink: 0 }}>{f.name}</code>
                  <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 4, background: '#1a1000', color: CATCH_COLOR, border: `0.5px solid ${CATCH_COLOR}30`, flexShrink: 0 }}>{f.type}</span>
                  <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.desc}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8, padding: '6px 8px', background: '#1a1000', borderRadius: 4, border: `0.5px solid ${CATCH_COLOR}20`, fontSize: 9, color: '#4a5a7a' }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 9, marginRight: 4, color: CATCH_COLOR }} />
              Se l'handle catch non è collegato a nessun nodo, le eccezioni vengono
              gestite dalla configurazione globale della lane.
            </div>
          </div>
        </div>
      )}

      <SectionTitle label="Performance" />
      <Row>
        <Field label="Batch size (righe per batch)">
          <input type="number" style={inputStyle} value={adv?.batchSize ?? '1000'}
            onChange={(e) => updateAdvanced(nodeId, 'batchSize', e.target.value)} />
        </Field>
        <Field label="Esecuzione parallela">
          <CustomSelect style={inputStyle} value={adv?.parallel ?? 'false'}
            onChange={(e) => updateAdvanced(nodeId, 'parallel', e.target.value)}>
            <option value="false">Sequenziale</option>
            <option value="true">Parallela</option>
          </CustomSelect>
        </Field>
      </Row>
      <NodeStatusSection nodeId={nodeId} />
    </div>
  )
}