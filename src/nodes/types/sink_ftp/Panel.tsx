/**
 * src/nodes/types/sink_ftp/Panel.tsx
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
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}
function SectionTitle({ label, color = '#3ddc84' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

const ACCENT = '#3ddc84'

export function SinkFtpPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const laneId     = node.data.laneId
  const resourceId = node.data.config?.resourceId ?? ''
  const lane       = pool.lanes.find((l) => l.id === laneId)
  const resources  = (lane?.resources ?? []).filter((r) => r.kind === 'ftp')
  const resource   = resources.find((r) => r.id === resourceId)

  const protocol    = resource?.config?.protocol ?? p('protocol', 'sftp')
  const fileFormat  = p('fileFormat', 'csv')
  const writeMode   = p('writeMode', 'overwrite')
  const outputMode  = p('outputMode', 'signal')    // 'signal' | 'passthrough'
  const atomicWrite = p('atomicWrite', 'true')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info risorsa */}
      {resource ? (
        <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 8, alignItems: 'center' }}>
          <i className="ti ti-server" style={{ fontSize: 14, color: ACCENT }} />
          <div>
            <div style={{ fontWeight: 600, color: ACCENT }}>{resource.label}</div>
            <div style={{ fontSize: 9, color: '#8593b5' }}>
              {protocol.toUpperCase()} · {resource.config?.host ?? '—'}:{resource.config?.port ?? (protocol === 'sftp' ? '22' : '21')}
            </div>
          </div>
        </div>
      ) : (
        <div style={{ padding: '10px', textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-server-off" style={{ fontSize: 20, display: 'block', marginBottom: 6 }} />
          Aggiungi una risorsa FTP/SFTP dalla resource strip, poi selezionala nel tab Connessione.
        </div>
      )}

      {/* Destinazione */}
      <SectionTitle label="Remote destination" />
      <Field label="Remote directory" hint="Destination directory path on the server">
        <input style={inputStyle} value={p('remotePath')} onChange={u('remotePath')} placeholder="/data/output/" />
      </Field>
      <Field
        label="File name"
        hint="Supports variables: {timestamp}, {date}, {datetime}, {run_id}, {batch_id}">
        <input style={inputStyle} value={p('fileName')} onChange={u('fileName')} placeholder="output_{timestamp}.csv" />
        <div style={{ fontSize: 9, color: '#8593b5', marginTop: 3 }}>
          Esempi: <code style={{ color: ACCENT }}>report_{'{'}date{'}'}.csv</code> · <code style={{ color: ACCENT }}>export_{'{'}run_id{'}'}.json</code> · <code style={{ color: ACCENT }}>data_{'{'}datetime{'}'}.parquet</code>
        </div>
      </Field>

      {/* Modalità scrittura */}
      <SectionTitle label="Write mode" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'overwrite', label: '↺ Overwrite',    desc: 'If the file exists, overwrites it completely' },
          { value: 'append',    label: '+ Append',          desc: 'Appends the data at the end of the existing file' },
          { value: 'new',       label: '✦ New file',      desc: 'Always creates a new file — adds a numeric suffix if it already exists' },
          { value: 'error',     label: '✕ Error',          desc: 'Raises an error if the file already exists' },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'writeMode', m.value)}
            style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, background: writeMode === m.value ? `color-mix(in srgb, ${ACCENT} 8%, #1a2030)` : '#1a2030', border: writeMode === m.value ? `1px solid ${ACCENT}40` : '1px solid #2a3349' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: writeMode === m.value ? ACCENT : 'transparent', border: `1.5px solid ${writeMode === m.value ? ACCENT : '#2a3349'}` }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: writeMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</div>
              <div style={{ fontSize: 9, color: '#8593b5' }}>{m.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Scrittura atomica */}
      <Field
        label="Atomic write"
        hint="Writes first to a temporary file (.tmp), then renames — avoids corrupted files on error">
        <CustomSelect style={inputStyle} value={atomicWrite} onChange={u('atomicWrite')}>
          <option value="true">Yes — write to .tmp then rename (recommended)</option>
          <option value="false">No — write directly to the final file</option>
        </CustomSelect>
        {atomicWrite === 'true' && (
          <div style={{ fontSize: 9, color: '#8593b5', marginTop: 3 }}>
            The temporary file will have a <code style={{ color: ACCENT }}>.tmp</code> extension while writing.
            On error the .tmp file is deleted, the final file stays intact.
          </div>
        )}
      </Field>

      {/* Formato file */}
      <SectionTitle label="File format" />
      <Row>
        <Field label="Format">
          <CustomSelect style={inputStyle} value={fileFormat} onChange={u('fileFormat')}>
            <option value="csv">CSV</option>
            <option value="tsv">TSV</option>
            <option value="json">JSON</option>
            <option value="jsonl">JSON Lines</option>
            <option value="xml">XML</option>
            <option value="excel">Excel (.xlsx)</option>
            <option value="parquet">Parquet</option>
            <option value="fixed">Fixed width</option>
          </CustomSelect>
        </Field>
        <Field label="Encoding">
          <CustomSelect style={inputStyle} value={p('encoding', 'utf-8')} onChange={u('encoding')}>
            <option value="utf-8">UTF-8</option>
            <option value="utf-16">UTF-16</option>
            <option value="iso-8859-1">ISO-8859-1 (Latin-1)</option>
            <option value="windows-1252">Windows-1252</option>
          </CustomSelect>
        </Field>
      </Row>

      {/* Opzioni CSV */}
      {(fileFormat === 'csv' || fileFormat === 'tsv') && (
        <>
          <Row>
            <Field label="Delimiter">
              <input style={inputStyle} value={p('delimiter', fileFormat === 'tsv' ? '\t' : ',')} onChange={u('delimiter')} placeholder="," />
            </Field>
            <Field label="Quote character">
              <input style={inputStyle} value={p('quoteChar', '"')} onChange={u('quoteChar')} placeholder={'"'} />
            </Field>
          </Row>
          <Field label="Include header">
            <CustomSelect style={inputStyle} value={p('writeHeader', 'true')} onChange={u('writeHeader')}>
              <option value="true">Yes — write column names in the first row</option>
              <option value="false">No — data only</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {/* Compressione */}
      <Field label="Compression">
        <CustomSelect style={inputStyle} value={p('compression', 'none')} onChange={u('compression')}>
          <option value="none">None</option>
          <option value="gzip">GZIP (.gz)</option>
          <option value="zip">ZIP (.zip)</option>
          <option value="bzip2">BZIP2 (.bz2)</option>
        </CustomSelect>
      </Field>

      {/* Output del nodo */}
      <SectionTitle label="Node output" color="#22d3ee" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          { value: 'signal',      label: '⊟ Signal',      desc: 'Emits 1 status row after completion — path, rows written, bytes', color: '#ffb347' },
          { value: 'passthrough', label: '⇒ Passthrough', desc: 'Re-emits the original rows after writing — useful for chained pipelines', color: '#22d3ee' },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'outputMode', m.value)}
            style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: outputMode === m.value ? `color-mix(in srgb, ${m.color} 10%, #1a2030)` : '#1a2030', border: outputMode === m.value ? `1px solid ${m.color}50` : '1px solid #2a3349' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: outputMode === m.value ? m.color : '#c8d4f0' }}>{m.label}</div>
            <div style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{m.desc}</div>
          </button>
        ))}
      </div>

      {/* Schema signal */}
      {outputMode === 'signal' && (
        <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #ffb34730' }}>
          <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>Status row schema</div>
          {[
            { name: 'remote_path',    type: 'string',  desc: 'Full path of the file on the server'   },
            { name: 'file_name',      type: 'string',  desc: 'Name of the written file'               },
            { name: 'rows_written',   type: 'integer', desc: 'Number of rows written'             },
            { name: 'bytes_written',  type: 'integer', desc: 'File size in bytes'         },
            { name: 'status',         type: 'string',  desc: 'always "done"'                       },
            { name: 'completed_at',   type: 'date',    desc: 'Completion timestamp'             },
            { name: 'elapsed_ms',     type: 'integer', desc: 'Transfer duration in ms'          },
          ].map((f) => (
            <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
              <code style={{ fontSize: 10, color: '#ffb347', minWidth: 120, flexShrink: 0 }}>{f.name}</code>
              <span style={{ fontSize: 9, color: '#8593b5', minWidth: 55 }}>{f.type}</span>
              <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* Opzioni avanzate */}
      <SectionTitle label="Advanced options" color="#8593b5" />
      <Row>
        <Field label="Connection timeout (sec)">
          <input type="number" style={inputStyle} value={p('connectTimeout', '30')} onChange={u('connectTimeout')} min="5" />
        </Field>
        <Field label="File permissions (chmod)" hint="SFTP/FTP Unix only — e.g. 644, 755">
          <input style={inputStyle} value={p('filePermissions', '644')} onChange={u('filePermissions')} placeholder="644" />
        </Field>
      </Row>
      <Field label="Create directory if missing">
        <CustomSelect style={inputStyle} value={p('createDirs', 'true')} onChange={u('createDirs')}>
          <option value="true">Yes — automatically create missing directories</option>
          <option value="false">No — error if the directory does not exist</option>
        </CustomSelect>
      </Field>

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', lineHeight: 1.5 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4, color: ACCENT }} />
        The connection is opened and closed for each batch. For frequent transfers consider
        increasing the <strong style={{ color: '#c8d4f0' }}>batch size</strong> in the Advanced tab to reduce the number of connections.
      </div>
    </div>
  )
}
