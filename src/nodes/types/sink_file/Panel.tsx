/**
 * src/nodes/types/sink_file/Panel.tsx
 */
import { useFlowStore } from '../../../store/flowStore'
import type { FileFormat } from '../../fileSchema'
import type { TMapConfig, TMapInputField } from '../../../types'
import { FORMAT_GROUPS, STRUCTURED_FORMATS } from '../../fileSchema'
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
function SectionTitle({ label }: { label: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color: '#3ddc84', textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #2a3349', marginBottom: 4 }}>
      {label}
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

const ACCENT = '#3ddc84'

// ─── Mappa formato → estensione file ─────────────────────────────
const FORMAT_EXT: Record<string, string> = {
  csv:        'csv',
  tsv:        'tsv',
  json:       'json',
  jsonl:      'jsonl',
  excel:      'xlsx',
  parquet:    'parquet',
  orc:        'orc',
  avro:       'avro',
  xml:        'xml',
  txt:        'txt',
  html:       'html',
  excel_b64:  'xlsx',
}

// ─── Aggiorna estensione nel path mantenendo nome e variabili ─────
function updatePathExtension(path: string, newExt: string): string {
  if (!path) return path
  // Trova l'ultima parte del path (dopo l'ultimo /)
  const lastSlash = path.lastIndexOf('/')
  const dir       = lastSlash >= 0 ? path.slice(0, lastSlash + 1) : ''
  const filename  = lastSlash >= 0 ? path.slice(lastSlash + 1) : path

  // Trova il punto dell'estensione — ma ignora variabili tipo ${date}
  // Cerca l'ultimo '.' che non sia dentro una variabile ${}
  let dotIdx = -1
  let inVar  = false
  for (let i = 0; i < filename.length; i++) {
    if (filename[i] === '$' && filename[i+1] === '{') { inVar = true; continue }
    if (inVar && filename[i] === '}') { inVar = false; continue }
    if (!inVar && filename[i] === '.') dotIdx = i
  }

  const base = dotIdx >= 0 ? filename.slice(0, dotIdx) : filename
  return `${dir}${base}.${newExt}`
}

// Schema riga di stato — fisso
const SIGNAL_SCHEMA = JSON.stringify([
  { id: 'sf_status',        name: 'status',        type: 'string',  physicalName: 'status'        },
  { id: 'sf_rows_written',  name: 'rows_written',  type: 'integer', physicalName: 'rows_written'  },
  { id: 'sf_bytes_written', name: 'bytes_written', type: 'integer', physicalName: 'bytes_written' },
  { id: 'sf_file_path',     name: 'file_path',     type: 'string',  physicalName: 'file_path'     },
  { id: 'sf_completed_at',  name: 'completed_at',  type: 'date',    physicalName: 'completed_at'  },
  { id: 'sf_error_message', name: 'error_message', type: 'string',  physicalName: 'error_message' },
  { id: 'sf_duration_ms',   name: 'duration_ms',   type: 'integer', physicalName: 'duration_ms'   },
])

// ─── Gruppi formato per il SinkFile ──────────────────────────────
// Estende FORMAT_GROUPS aggiungendo html e excel_b64
const SINK_FORMAT_GROUPS = [
  ...FORMAT_GROUPS,
  {
    label: 'Report',
    formats: [
      { value: 'html',      label: 'HTML — web document'                },
      { value: 'excel_b64', label: 'Excel from base64 (from Report Generator)' },
    ],
  },
]

export function SinkFilePanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const format     = p('format', 'csv') as FileFormat
  const writeMode  = p('mode', 'overwrite')
  const outputMode = p('outputMode', 'signal')
  const writeMode2 = p('writeMode2', 'rows')  // 'rows' | 'raw_field'
  const rawField   = p('rawField', 'content')

  // ── Cambio formato: aggiorna anche l'estensione nel path ──────
  const handleFormatChange = (newFormat: string) => {
    updateProp(nodeId, 'format', newFormat)
    const currentPath = node.data.props['path'] ?? ''
    if (currentPath) {
      const ext     = FORMAT_EXT[newFormat]
      if (ext) {
        const newPath = updatePathExtension(currentPath, ext)
        if (newPath !== currentPath) updateProp(nodeId, 'path', newPath)
      }
    }
    // Se formato html o excel_b64 → imposta automaticamente raw_field
    if (newFormat === 'html' || newFormat === 'excel_b64') {
      updateProp(nodeId, 'writeMode2', 'raw_field')
      updateProp(nodeId, 'rawField', 'content')
    }
  }

  // ── Cambio modalità output ────────────────────────────────────
  const handleOutputMode = (mode: string) => {
    updateProp(nodeId, 'outputMode', mode)
    const store    = useFlowStore.getState()
    const outEdges = store.edges.filter((e) => e.source === nodeId)

    if (mode === 'signal') {
      updateProp(nodeId, 'outputSchema', SIGNAL_SCHEMA)
    } else {
      updateProp(nodeId, 'outputSchema', '')
    }

    outEdges.forEach((edge) => {
      const tgt = store.nodes.find((n) => n.id === edge.target)
      if (!tgt || tgt.data.type !== 'tmap') return
      const tmap  = tgt.data.config?.tmap as TMapConfig | undefined
      if (!tmap) return
      const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
      if (!input) return
      if (mode === 'signal') {
        const signalFields: TMapInputField[] = JSON.parse(SIGNAL_SCHEMA).map((f: any) => ({ id: f.id, name: f.name, type: f.type }))
        store.updateTMapInput(tgt.id, input.id, { fields: signalFields })
      } else {
        const inEdge  = store.edges.find((e) => e.target === nodeId)
        const srcNode = inEdge ? store.nodes.find((n) => n.id === inEdge.source) : null
        if (srcNode) {
          try {
            const raw = srcNode.data.props['incomingSchema'] || srcNode.data.props['outputSchema']
            if (raw) {
              const fields = JSON.parse(raw).map((f: any) => ({ name: f.name, type: f.type }))
              store.updateTMapInput(tgt.id, input.id, { fields })
            }
          } catch {}
        }
      }
    })
  }

  // ── Indicatore coerenza formato/estensione ────────────────────
  const currentPath = p('path')
  const expectedExt = FORMAT_EXT[format]
  const actualExt   = (() => {
    if (!currentPath) return null
    const lastDot = currentPath.lastIndexOf('.')
    if (lastDot < 0) return null
    // Verifica che dopo il punto non ci siano variabili ${...}
    const ext = currentPath.slice(lastDot + 1)
    return ext.includes('{') ? null : ext.toLowerCase()
  })()
  const extMismatch = expectedExt && actualExt && actualExt !== expectedExt

  // ── Campi in ingresso (per raw field selector) ────────────────
  const incomingSchema = (() => {
    try { return JSON.parse(node.data.props['incomingSchema'] ?? node.data.props['outputSchema'] ?? '[]') }
    catch { return [] }
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Destinazione ── */}
      <SectionTitle label="Destination" />

      {/* Formato PRIMA del path — è la fonte di verità */}
      <Field label="File format" hint="The format sets the extension — the path is updated automatically">
        <CustomSelect style={inputStyle} value={format} onChange={(e) => handleFormatChange(e.target.value)}>
          {SINK_FORMAT_GROUPS.map((group) => (
            <optgroup key={group.label} label={group.label}>
              {group.formats.map((f) => (
                <option key={f.value} value={f.value}>{f.label}</option>
              ))}
            </optgroup>
          ))}
        </CustomSelect>
      </Field>

      {/* Path — con badge coerenza */}
      <Field label="File path" hint="Use variables ${date}, ${datetime}, ${uuid}, ${seq} for dynamic paths">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="text" style={{ ...inputStyle, flex: 1 }} value={currentPath} onChange={u('path')}
            placeholder={`/data/output/result_\${date}.${expectedExt ?? 'csv'}`} />
          {expectedExt && currentPath && (
            <div title={extMismatch ? `Path extension (.${actualExt}) does not match the format (.${expectedExt})` : 'Extension consistent with the format'}
              style={{ fontSize: 10, padding: '3px 8px', borderRadius: 4, flexShrink: 0, fontFamily: 'monospace',
                background: extMismatch ? '#2a0a0a' : '#0d1a10',
                color:      extMismatch ? '#ff5f57' : '#3ddc84',
                border: `0.5px solid ${extMismatch ? '#ff5f5740' : '#3ddc8440'}`,
                cursor: extMismatch ? 'pointer' : 'default',
              }}
              onClick={() => {
                if (extMismatch) {
                  const fixed = updatePathExtension(currentPath, expectedExt)
                  updateProp(nodeId, 'path', fixed)
                }
              }}>
              {extMismatch ? `⚠ .${actualExt} → click to fix to .${expectedExt}` : `✓ .${actualExt}`}
            </div>
          )}
        </div>

        {/* Variabili rapide */}
        <div style={{ marginTop: 6, padding: '6px 8px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
          <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5, fontWeight: 600 }}>
            Variables — click to insert
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {[
              { var: '${date}',     desc: 'Current date (2024-01-15)' },
              { var: '${datetime}', desc: 'Date and time'                 },
              { var: '${uuid}',     desc: 'Unique UUID'               },
              { var: '${seq}',      desc: 'Sequential number'         },
            ].map(({ var: v, desc }) => (
              <button key={v} title={desc}
                onClick={() => updateProp(nodeId, 'path', (node.data.props['path'] ?? '') + v)}
                style={{ background: '#1a2030', border: '0.5px solid #2a3349', borderRadius: 4, padding: '2px 7px', fontSize: 10, color: '#ffb347', cursor: 'pointer', fontFamily: 'monospace' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a1a00'; (e.currentTarget as HTMLElement).style.borderColor = '#ffb347' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030'; (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
                {v}
              </button>
            ))}
          </div>
        </div>
      </Field>

      {/* Encoding — solo per formati testo standard */}
      {STRUCTURED_FORMATS.includes(format) && !['parquet','orc','avro','html','excel_b64'].includes(format) && (
        <Field label="Encoding">
          <CustomSelect style={inputStyle} value={p('encoding', 'utf-8')} onChange={u('encoding')}>
            <option value="utf-8">UTF-8</option>
            <option value="utf-16">UTF-16</option>
            <option value="iso-8859-1">ISO-8859-1</option>
            <option value="ascii">ASCII</option>
            <option value="windows-1252">Windows-1252</option>
          </CustomSelect>
        </Field>
      )}

      {/* ── Contenuto da scrivere ── */}
      <SectionTitle label="Content to write" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value: 'rows',
            label: '⊞ Flow rows',
            desc:  'Serializes all incoming rows in the selected format.',
            disabled: format === 'html' || format === 'excel_b64',
          },
          {
            value: 'raw_field',
            label: '→ Value of a field',
            desc:  'Writes the value of a specific field directly — useful for HTML and Excel from Report Generator.',
            disabled: false,
          },
        ].map((m) => (
          <button key={m.value}
            onClick={() => { if (!m.disabled) updateProp(nodeId, 'writeMode2', m.value) }}
            style={{
              padding: '8px 12px', borderRadius: 6, cursor: m.disabled ? 'not-allowed' : 'pointer',
              opacity: m.disabled ? 0.4 : 1, textAlign: 'left',
              background: writeMode2 === m.value ? `color-mix(in srgb, ${ACCENT} 10%, #1a2030)` : '#1a2030',
              border: writeMode2 === m.value ? `1px solid ${ACCENT}50` : '1px solid #2a3349',
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 3,
              background: writeMode2 === m.value ? ACCENT : 'transparent',
              border: `1.5px solid ${writeMode2 === m.value ? ACCENT : '#2a3349'}` }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: writeMode2 === m.value ? ACCENT : '#c8d4f0', marginBottom: 2 }}>{m.label}</div>
              <div style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{m.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Configurazione raw field */}
      {writeMode2 === 'raw_field' && (
        <div style={{ padding: '10px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}30`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Field label="Field to write" hint="The value of this field is written directly to disk">
            {incomingSchema.length > 0 ? (
              <CustomSelect style={inputStyle} value={rawField} onChange={u('rawField')}>
                <option value="">— select field —</option>
                {incomingSchema.map((f: any) => (
                  <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                ))}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={rawField} onChange={u('rawField')} placeholder="content" />
            )}
          </Field>

          {/* Encoding del valore */}
          <Field label="Value encoding" hint="How to interpret the value before writing it">
            <CustomSelect style={inputStyle} value={p('rawEncoding', 'text')} onChange={u('rawEncoding')}>
              <option value="text">Text — write directly (for HTML, JSON, XML...)</option>
              <option value="base64">Base64 — decode before writing (for Excel, PDF...)</option>
            </CustomSelect>
          </Field>

          {/* Info contestuale */}
          {format === 'html' && (
            <div style={{ fontSize: 9, color: '#4a9eff', display: 'flex', gap: 5, alignItems: 'flex-start' }}>
              <i className="ti ti-info-circle" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
              Report Generator → SinkFile HTML pattern: <code style={{ color: ACCENT }}>content</code> field, <strong>text</strong> encoding.
            </div>
          )}
          {format === 'excel_b64' && (
            <div style={{ fontSize: 9, color: '#4a9eff', display: 'flex', gap: 5, alignItems: 'flex-start' }}>
              <i className="ti ti-info-circle" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
              Report Generator → SinkFile Excel pattern: <code style={{ color: ACCENT }}>content</code> field, <strong>base64</strong> encoding.
            </div>
          )}
        </div>
      )}

      {/* ── Modalità output ── */}
      <SectionTitle label="Output mode" />
      <div style={{ fontSize: 10, color: '#8593b5', padding: '4px 0', marginBottom: 4, lineHeight: 1.5 }}>
        What the node emits when writing finishes.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'signal', label: '⊟ Buffer → Signal', desc: 'Emits a single status row.', outputDesc: '1 status row', color: '#ffb347' },
          { value: 'replay', label: '⊞ Buffer → Replay', desc: 'Re-emits the original rows after writing.', outputDesc: 'N original rows', color: ACCENT },
        ].map((m) => (
          <button key={m.value} onClick={() => handleOutputMode(m.value)}
            style={{
              padding: '8px 12px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              background: outputMode === m.value ? `color-mix(in srgb, ${m.color} 10%, #1a2030)` : '#1a2030',
              border: outputMode === m.value ? `1px solid ${m.color}60` : '1px solid #2a3349',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: outputMode === m.value ? m.color : 'transparent', border: `1.5px solid ${outputMode === m.value ? m.color : '#2a3349'}` }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: outputMode === m.value ? m.color : '#c8d4f0', marginBottom: 2 }}>{m.label}</div>
              <div style={{ fontSize: 9, color: '#8593b5' }}>{m.desc}</div>
            </div>
            <div style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: `color-mix(in srgb, ${m.color} 10%, #0f1117)`, color: m.color, border: `0.5px solid ${m.color}30`, flexShrink: 0 }}>
              {m.outputDesc}
            </div>
          </button>
        ))}
      </div>

      {outputMode === 'signal' && (
        <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #ffb34730' }}>
          <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Status row schema</div>
          {[
            { name: 'status',        desc: '"done" or "error"'        },
            { name: 'rows_written',  desc: 'Rows written to the file'   },
            { name: 'file_path',     desc: 'Actual path of the file'  },
            { name: 'completed_at',  desc: 'Completion timestamp'  },
          ].map((f) => (
            <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
              <code style={{ fontSize: 10, color: '#ffb347', minWidth: 110, flexShrink: 0 }}>{f.name}</code>
              <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Modalità scrittura ── */}
      <SectionTitle label="Write mode" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          { value: 'overwrite', label: 'Overwrite', icon: 'ti-file-shredder', desc: 'Overwrites the file'      },
          { value: 'append',    label: 'Append',    icon: 'ti-file-plus',     desc: 'Appends at the end'        },
          { value: 'new',       label: 'New file',  icon: 'ti-file-plus-2',   desc: 'Creates new with timestamp' },
          { value: 'error',     label: 'Error',     icon: 'ti-file-alert',    desc: 'Error if already exists'     },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'mode', m.value)}
            style={{
              padding: '8px 6px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
              background: writeMode === m.value ? '#0d3d20' : '#1a2030',
              color:      writeMode === m.value ? '#3ddc84' : '#8593b5',
              border: writeMode === m.value ? '1px solid #1d6d40' : '1px solid #2a3349',
              fontWeight: writeMode === m.value ? 600 : 400,
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, textAlign: 'center',
            }}>
            <i className={`ti ${m.icon}`} style={{ fontSize: 14 }} />
            <span>{m.label}</span>
            <span style={{ fontSize: 9, opacity: 0.7 }}>{m.desc}</span>
          </button>
        ))}
      </div>

      {/* ── Opzioni formato specifiche ── */}
      {(format === 'csv' || format === 'tsv') && writeMode2 === 'rows' && (
        <>
          <SectionTitle label="CSV / TSV options" />
          <Row>
            <Field label="Delimiter">
              <input type="text" style={inputStyle} value={p('delimiter', format === 'tsv' ? '\t' : ',')} onChange={u('delimiter')} placeholder="," />
            </Field>
            <Field label="Quote character">
              <input type="text" style={inputStyle} value={p('quoteChar', '"')} onChange={u('quoteChar')} />
            </Field>
          </Row>
          <Row>
            <Field label="Write header">
              <CustomSelect style={inputStyle} value={p('writeHeader', 'true')} onChange={u('writeHeader')}>
                <option value="true">Yes — first row = header</option>
                <option value="false">No — data only</option>
                <option value="auto">Auto — only if new file</option>
              </CustomSelect>
            </Field>
            <Field label="Line ending">
              <CustomSelect style={inputStyle} value={p('lineEnding', 'lf')} onChange={u('lineEnding')}>
                <option value="lf">LF (Unix/Linux)</option>
                <option value="crlf">CRLF (Windows)</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {format === 'excel' && writeMode2 === 'rows' && (
        <>
          <SectionTitle label="Excel options" />
          <Row>
            <Field label="Sheet name">
              <input type="text" style={inputStyle} value={p('sheetName', 'Sheet1')} onChange={u('sheetName')} />
            </Field>
            <Field label="Header style">
              <CustomSelect style={inputStyle} value={p('headerStyle', 'bold')} onChange={u('headerStyle')}>
                <option value="none">None</option>
                <option value="bold">Bold</option>
                <option value="colored">Colored</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {(format === 'json' || format === 'jsonl') && writeMode2 === 'rows' && (
        <>
          <SectionTitle label="JSON options" />
          <Row>
            <Field label="Indentation">
              <CustomSelect style={inputStyle} value={p('jsonIndent', 'none')} onChange={u('jsonIndent')}>
                <option value="none">None (compact)</option>
                <option value="2">2 spaces</option>
                <option value="4">4 spaces</option>
              </CustomSelect>
            </Field>
            {format === 'json' && (
              <Field label="Output structure">
                <CustomSelect style={inputStyle} value={p('jsonStructure', 'array')} onChange={u('jsonStructure')}>
                  <option value="array">Array of objects</option>
                  <option value="lines">One line per object</option>
                </CustomSelect>
              </Field>
            )}
          </Row>
        </>
      )}

      {/* ── Partizioni ── */}
      <SectionTitle label="Partitions" />
      <Field label="Partition by">
        <CustomSelect style={inputStyle} value={p('partition', 'none')} onChange={u('partition')}>
          <option value="none">None — single file</option>
          <option value="field">Row field</option>
          <option value="date">Date (from timestamp field)</option>
          <option value="size">Maximum size</option>
        </CustomSelect>
      </Field>
      {p('partition') === 'field' && (
        <Field label="Partition field">
          <input type="text" style={inputStyle} value={p('partitionField', '')} onChange={u('partitionField')} placeholder="region" />
        </Field>
      )}
      {p('partition') === 'date' && (
        <Row>
          <Field label="Timestamp field">
            <input type="text" style={inputStyle} value={p('partitionTimestamp', 'created_at')} onChange={u('partitionTimestamp')} />
          </Field>
          <Field label="Granularity">
            <CustomSelect style={inputStyle} value={p('partitionGranularity', 'day')} onChange={u('partitionGranularity')}>
              <option value="year">Year</option>
              <option value="month">Month</option>
              <option value="day">Day</option>
              <option value="hour">Hour</option>
            </CustomSelect>
          </Field>
        </Row>
      )}

      {/* ── Post-processing ── */}
      <SectionTitle label="Post-processing" />
      <Field label="Post-write command" hint="Run after the file is closed">
        <input type="text" style={inputStyle} value={p('postCommand', '')} onChange={u('postCommand')} placeholder="gzip /data/output/result.csv" />
      </Field>
      <Field label="Completion notification (webhook URL)">
        <input type="text" style={inputStyle} value={p('webhookUrl', '')} onChange={u('webhookUrl')} placeholder="https://hook.example.com/notify" />
      </Field>

    </div>
  )
}