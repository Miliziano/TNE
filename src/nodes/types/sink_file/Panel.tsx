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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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
      { value: 'html',      label: 'HTML — documento web'                },
      { value: 'excel_b64', label: 'Excel da base64 (da Report Generator)' },
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
      <SectionTitle label="Destinazione" />

      {/* Formato PRIMA del path — è la fonte di verità */}
      <Field label="Formato file" hint="Il formato determina l'estensione — il path viene aggiornato automaticamente">
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
      <Field label="Path file" hint="Usa variabili ${date}, ${datetime}, ${uuid}, ${seq} per path dinamici">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input type="text" style={{ ...inputStyle, flex: 1 }} value={currentPath} onChange={u('path')}
            placeholder={`/data/output/result_\${date}.${expectedExt ?? 'csv'}`} />
          {expectedExt && currentPath && (
            <div title={extMismatch ? `Estensione nel path (.${actualExt}) non corrisponde al formato (.${expectedExt})` : 'Estensione coerente con il formato'}
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
              {extMismatch ? `⚠ .${actualExt} → clicca per correggere in .${expectedExt}` : `✓ .${actualExt}`}
            </div>
          )}
        </div>

        {/* Variabili rapide */}
        <div style={{ marginTop: 6, padding: '6px 8px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 5, fontWeight: 600 }}>
            Variabili — clicca per inserire
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {[
              { var: '${date}',     desc: 'Data corrente (2024-01-15)' },
              { var: '${datetime}', desc: 'Data e ora'                 },
              { var: '${uuid}',     desc: 'UUID univoco'               },
              { var: '${seq}',      desc: 'Numero sequenziale'         },
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
      <SectionTitle label="Contenuto da scrivere" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value: 'rows',
            label: '⊞ Righe del flusso',
            desc:  'Serializza tutte le righe in ingresso nel formato selezionato.',
            disabled: format === 'html' || format === 'excel_b64',
          },
          {
            value: 'raw_field',
            label: '→ Valore di un campo',
            desc:  'Scrive direttamente il valore di un campo specifico — utile per HTML e Excel da Report Generator.',
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
              <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Configurazione raw field */}
      {writeMode2 === 'raw_field' && (
        <div style={{ padding: '10px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}30`, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <Field label="Campo da scrivere" hint="Il valore di questo campo viene scritto direttamente su disco">
            {incomingSchema.length > 0 ? (
              <CustomSelect style={inputStyle} value={rawField} onChange={u('rawField')}>
                <option value="">— seleziona campo —</option>
                {incomingSchema.map((f: any) => (
                  <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                ))}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={rawField} onChange={u('rawField')} placeholder="content" />
            )}
          </Field>

          {/* Encoding del valore */}
          <Field label="Encoding valore" hint="Come interpretare il valore prima di scriverlo">
            <CustomSelect style={inputStyle} value={p('rawEncoding', 'text')} onChange={u('rawEncoding')}>
              <option value="text">Testo — scrivi direttamente (per HTML, JSON, XML...)</option>
              <option value="base64">Base64 — decodifica prima di scrivere (per Excel, PDF...)</option>
            </CustomSelect>
          </Field>

          {/* Info contestuale */}
          {format === 'html' && (
            <div style={{ fontSize: 9, color: '#4a9eff', display: 'flex', gap: 5, alignItems: 'flex-start' }}>
              <i className="ti ti-info-circle" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
              Pattern Report Generator → SinkFile HTML: campo <code style={{ color: ACCENT }}>content</code>, encoding <strong>testo</strong>.
            </div>
          )}
          {format === 'excel_b64' && (
            <div style={{ fontSize: 9, color: '#4a9eff', display: 'flex', gap: 5, alignItems: 'flex-start' }}>
              <i className="ti ti-info-circle" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
              Pattern Report Generator → SinkFile Excel: campo <code style={{ color: ACCENT }}>content</code>, encoding <strong>base64</strong>.
            </div>
          )}
        </div>
      )}

      {/* ── Modalità output ── */}
      <SectionTitle label="Modalità output" />
      <div style={{ fontSize: 10, color: '#4a5a7a', padding: '4px 0', marginBottom: 4, lineHeight: 1.5 }}>
        Cosa emette il nodo al termine della scrittura.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'signal', label: '⊟ Buffer → Signal', desc: 'Emette una sola riga di stato.', outputDesc: '1 riga di stato', color: '#ffb347' },
          { value: 'replay', label: '⊞ Buffer → Replay', desc: 'Riemette le righe originali dopo la scrittura.', outputDesc: 'N righe originali', color: ACCENT },
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
              <div style={{ fontSize: 9, color: '#4a5a7a' }}>{m.desc}</div>
            </div>
            <div style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: `color-mix(in srgb, ${m.color} 10%, #0f1117)`, color: m.color, border: `0.5px solid ${m.color}30`, flexShrink: 0 }}>
              {m.outputDesc}
            </div>
          </button>
        ))}
      </div>

      {outputMode === 'signal' && (
        <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #ffb34730' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Schema riga di stato</div>
          {[
            { name: 'status',        desc: '"done" o "error"'        },
            { name: 'rows_written',  desc: 'Righe scritte nel file'   },
            { name: 'file_path',     desc: 'Path effettivo del file'  },
            { name: 'completed_at',  desc: 'Timestamp completamento'  },
          ].map((f) => (
            <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 2 }}>
              <code style={{ fontSize: 10, color: '#ffb347', minWidth: 110, flexShrink: 0 }}>{f.name}</code>
              <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
            </div>
          ))}
        </div>
      )}

      {/* ── Modalità scrittura ── */}
      <SectionTitle label="Modalità scrittura" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          { value: 'overwrite', label: 'Overwrite', icon: 'ti-file-shredder', desc: 'Sovrascrive il file'      },
          { value: 'append',    label: 'Append',    icon: 'ti-file-plus',     desc: 'Aggiunge in fondo'        },
          { value: 'new',       label: 'New file',  icon: 'ti-file-plus-2',   desc: 'Crea nuovo con timestamp' },
          { value: 'error',     label: 'Error',     icon: 'ti-file-alert',    desc: 'Errore se esiste già'     },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'mode', m.value)}
            style={{
              padding: '8px 6px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
              background: writeMode === m.value ? '#0d3d20' : '#1a2030',
              color:      writeMode === m.value ? '#3ddc84' : '#4a5a7a',
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
          <SectionTitle label="Opzioni CSV / TSV" />
          <Row>
            <Field label="Separatore">
              <input type="text" style={inputStyle} value={p('delimiter', format === 'tsv' ? '\t' : ',')} onChange={u('delimiter')} placeholder="," />
            </Field>
            <Field label="Carattere virgolette">
              <input type="text" style={inputStyle} value={p('quoteChar', '"')} onChange={u('quoteChar')} />
            </Field>
          </Row>
          <Row>
            <Field label="Scrivi intestazione">
              <CustomSelect style={inputStyle} value={p('writeHeader', 'true')} onChange={u('writeHeader')}>
                <option value="true">Sì — prima riga = intestazione</option>
                <option value="false">No — solo dati</option>
                <option value="auto">Auto — solo se file nuovo</option>
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
          <SectionTitle label="Opzioni Excel" />
          <Row>
            <Field label="Nome foglio">
              <input type="text" style={inputStyle} value={p('sheetName', 'Sheet1')} onChange={u('sheetName')} />
            </Field>
            <Field label="Stile intestazione">
              <CustomSelect style={inputStyle} value={p('headerStyle', 'bold')} onChange={u('headerStyle')}>
                <option value="none">Nessuno</option>
                <option value="bold">Grassetto</option>
                <option value="colored">Colorato</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {(format === 'json' || format === 'jsonl') && writeMode2 === 'rows' && (
        <>
          <SectionTitle label="Opzioni JSON" />
          <Row>
            <Field label="Indentazione">
              <CustomSelect style={inputStyle} value={p('jsonIndent', 'none')} onChange={u('jsonIndent')}>
                <option value="none">Nessuna (compatto)</option>
                <option value="2">2 spazi</option>
                <option value="4">4 spazi</option>
              </CustomSelect>
            </Field>
            {format === 'json' && (
              <Field label="Struttura output">
                <CustomSelect style={inputStyle} value={p('jsonStructure', 'array')} onChange={u('jsonStructure')}>
                  <option value="array">Array di oggetti</option>
                  <option value="lines">Una riga per oggetto</option>
                </CustomSelect>
              </Field>
            )}
          </Row>
        </>
      )}

      {/* ── Partizioni ── */}
      <SectionTitle label="Partizioni" />
      <Field label="Partiziona per">
        <CustomSelect style={inputStyle} value={p('partition', 'none')} onChange={u('partition')}>
          <option value="none">Nessuna — file singolo</option>
          <option value="field">Campo della riga</option>
          <option value="date">Data (da campo timestamp)</option>
          <option value="size">Dimensione massima</option>
        </CustomSelect>
      </Field>
      {p('partition') === 'field' && (
        <Field label="Campo partizione">
          <input type="text" style={inputStyle} value={p('partitionField', '')} onChange={u('partitionField')} placeholder="region" />
        </Field>
      )}
      {p('partition') === 'date' && (
        <Row>
          <Field label="Campo timestamp">
            <input type="text" style={inputStyle} value={p('partitionTimestamp', 'created_at')} onChange={u('partitionTimestamp')} />
          </Field>
          <Field label="Granularità">
            <CustomSelect style={inputStyle} value={p('partitionGranularity', 'day')} onChange={u('partitionGranularity')}>
              <option value="year">Anno</option>
              <option value="month">Mese</option>
              <option value="day">Giorno</option>
              <option value="hour">Ora</option>
            </CustomSelect>
          </Field>
        </Row>
      )}

      {/* ── Post-processing ── */}
      <SectionTitle label="Post-processing" />
      <Field label="Comando post-scrittura" hint="Eseguito dopo la chiusura del file">
        <input type="text" style={inputStyle} value={p('postCommand', '')} onChange={u('postCommand')} placeholder="gzip /data/output/result.csv" />
      </Field>
      <Field label="Notifica completamento (webhook URL)">
        <input type="text" style={inputStyle} value={p('webhookUrl', '')} onChange={u('webhookUrl')} placeholder="https://hook.example.com/notify" />
      </Field>

    </div>
  )
}