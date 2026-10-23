import { useFlowStore } from '../../store/flowStore'
import { CustomSelect } from '../../components/CustomSelect'
import { normalizeOnError, CATCH_PORT_SCHEMA } from '../../types'

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

/** Nodi che ritentano da sé la prima operazione (connessione al DB,
 *  upload FTP):
 *  allineato a RETRY_IN_NODE in src-tauri/src/engine/executor.rs. */
const RETRY_IN_NODE = new Set(['source_db', 'sink_db', 'sink_ftp'])

function Hint({ children, color = '#8593b5' }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{ padding: '6px 10px', fontSize: 10, color, background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', lineHeight: 1.5 }}>
      <i className="ti ti-info-circle" style={{ fontSize: 11, marginRight: 4 }} />
      {children}
    </div>
  )
}

export function TabAdvanced({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const hasInputEdge   = useFlowStore((s) => s.edges.some((e) => e.target === nodeId))
  const updateAdvanced = useFlowStore((s) => s.updateNodeAdvanced)
  const updateProp     = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null
  const adv     = node.data.config.advanced
  const onError = normalizeOnError(adv?.onError)
  const isRetry = onError === 'retry_handler' || onError === 'retry_catch'
  const isDirWatcher = node.data.type === 'dir_watcher'
  // Il motore rilancia un nodo solo se non ha ingressi di dati (un
  // ingresso già letto non si rilegge) — i nodi DB ritentano da sé.
  const retrySupported = RETRY_IN_NODE.has(node.data.type) || (!hasInputEdge && node.data.type !== 'bridge_in')

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
      <SectionTitle label="Timeout and retry" />

      {/* Nota contestuale per DirWatcher */}
      {isDirWatcher && (
        <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${ACCENT_DW} 8%, #0f1117)`, borderRadius: 4, border: `0.5px solid ${ACCENT_DW}30`, fontSize: 9, color: ACCENT_DW, display: 'flex', gap: 6 }}>
          <i className="ti ti-refresh" style={{ fontSize: 10, flexShrink: 0 }} />
          The <strong>Timeout</strong> field is synced with <strong>Watch timeout</strong> in the Configuration tab — changing one updates the other.
        </div>
      )}

      <Row>
        <Field label={isDirWatcher ? 'Watch timeout (seconds)' : 'Max run time (seconds)'}>
          <input type="number" min="0" style={inputStyle} value={adv?.timeoutSec ?? '0'}
            onChange={(e) => handleTimeoutChange(e.target.value)} />
        </Field>
        <Field label="On error">
          <CustomSelect style={inputStyle} value={onError}
            onChange={(e) => updateAdvanced(nodeId, 'onError', e.target.value)}>
            <option value="handler">Error handler — the lane decides</option>
            <option value="catch">Catch on node — enables catch handle</option>
            {(retrySupported || onError === 'retry_handler') && <option value="retry_handler">Retry, then error handler</option>}
            {(retrySupported || onError === 'retry_catch') && <option value="retry_catch">Retry, then catch on node</option>}
          </CustomSelect>
        </Field>
      </Row>
      {!isDirWatcher && (
        <Hint>
          0 = no limit. If the node runs longer, it is stopped and fails with a timeout error,
          handled like any other error (error handler or catch).
        </Hint>
      )}
      {isRetry && (
        <Row>
          <Field label="Retry count">
            <input type="number" min="0" style={inputStyle} value={adv?.retryCount ?? '0'}
              onChange={(e) => updateAdvanced(nodeId, 'retryCount', e.target.value)} />
          </Field>
          <Field label="Delay between retries (seconds)">
            <input type="number" min="0" style={inputStyle} value={adv?.retryDelaySec ?? '5'}
              onChange={(e) => updateAdvanced(nodeId, 'retryDelaySec', e.target.value)} />
          </Field>
        </Row>
      )}
      {isRetry && (retrySupported ? (
        <Hint>
          {RETRY_IN_NODE.has(node.data.type)
            ? (node.data.type === 'sink_ftp'
              ? 'The node retries the connection and the upload, waiting the delay between attempts (the upload is not retried in append mode).'
              : 'The node retries opening the database connection, waiting the delay between attempts.')
            : 'If the node fails before emitting any row, it is run again from the start after the delay. Once rows have been emitted it is not retried, so downstream never gets duplicates.'}
        </Hint>
      ) : (
        <Hint color="#ffb347">
          Retry is not available here: the node receives incoming data, which cannot be read twice.
          It applies to nodes without incoming data (sources) and to the database nodes.
        </Hint>
      ))}

      {(onError === 'catch' || onError === 'retry_catch') && (
        <div style={{
          padding: '10px 12px', fontSize: 10, color: CATCH_COLOR,
          background: `color-mix(in srgb, ${CATCH_COLOR} 8%, #0f1117)`,
          borderRadius: 6, border: `0.5px solid ${CATCH_COLOR}30`,
          display: 'flex', gap: 8, alignItems: 'flex-start', lineHeight: 1.6,
        }}>
          <i className="ti ti-bug" style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 4 }}>Catch handle active</div>
            The <strong style={{ color: CATCH_COLOR }}>catch</strong> handle is now visible on the node.
            If the node fails, the error leaves through catch as one row with the fields below,
            and counts as handled: the lane goes on. Rows rejected one by one go to the node's
            reject port, where it has one.
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 2 }}>
              {CATCH_PORT_SCHEMA.map((f) => (
                <div key={f.name} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <code style={{ fontSize: 10, color: CATCH_COLOR, minWidth: 140, flexShrink: 0 }}>{f.name}</code>
                  <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 4, background: '#1a1000', color: CATCH_COLOR, border: `0.5px solid ${CATCH_COLOR}30`, flexShrink: 0 }}>{f.type}</span>
                  <span style={{ fontSize: 9, color: '#8593b5' }}>{f.desc}</span>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 8, padding: '6px 8px', background: '#1a1000', borderRadius: 4, border: `0.5px solid ${CATCH_COLOR}20`, fontSize: 9, color: '#8593b5' }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 9, marginRight: 4, color: CATCH_COLOR }} />
              If the catch handle isn't connected, the error goes to the lane's error handler.
              If the node belongs to a transaction group, the group is rolled back even when the
              error is caught.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
