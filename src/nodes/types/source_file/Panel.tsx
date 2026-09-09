import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import type { TMapFieldType, Variable } from '../../../types'
import type { FileFormat } from '../../fileSchema'
import { FIXED_SCHEMA,STRUCTURED_FORMATS, FORMAT_GROUPS } from '../../fileSchema'
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
    <div style={{ fontSize: 10, fontWeight: 600, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #2a3349', marginBottom: 4 }}>
      {label}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

const ACCENT = '#4a9eff'

export function SourceFilePanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const edges      = useFlowStore((s) => s.edges)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const format     = p('format', 'csv') as FileFormat
  const pathSource = p('pathSource', 'static')  // 'static' | 'lane_var' | 'flow'
  const hasInput   = edges.some((e) => e.target === nodeId)

  // Variabili stringa della lane corrente
  const laneVars: Variable[] = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === node.data.laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'string' || v.type === 'object')
  }, [pool, node.data.laneId])

  // Path effettivo da mostrare come preview
  const effectivePath = (() => {
    if (pathSource === 'static')   return p('path') || null
    if (pathSource === 'lane_var') return p('laneVarName') ? `var("${p('laneVarName')}")` : null
    if (pathSource === 'flow')     return p('pathField') ? `row.${p('pathField')}` : null
    return null
  })()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Sorgente path ── */}
      <SectionTitle label="File path source" />

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'static',   label: '📄 Static',         desc: 'Path configured directly below' },
          { value: 'lane_var', label: '◎ Lane variable',   desc: 'Reads the path from a lane variable' },
          { value: 'flow',     label: '→ From flow',       desc: 'Uses the path field from each incoming row (e.g. from DirWatcher)' },
        ].map((s) => {
          const disabled = s.value === 'flow' && !hasInput
          return (
            <button key={s.value}
              onClick={() => { if (!disabled) updateProp(nodeId, 'pathSource', s.value) }}
              style={{
                padding: '7px 10px', borderRadius: 6,
                cursor: disabled ? 'not-allowed' : 'pointer',
                opacity: disabled ? 0.4 : 1,
                background: pathSource === s.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030',
                border: pathSource === s.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349',
                display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
              }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: pathSource === s.value ? ACCENT : '#2a3349' }} />
              <div>
                <div style={{ fontSize: 11, fontWeight: 600, color: pathSource === s.value ? ACCENT : '#c8d4f0' }}>{s.label}</div>
                <div style={{ fontSize: 9, color: '#8593b5' }}>{s.desc}{disabled ? ' — connect an edge first' : ''}</div>
              </div>
            </button>
          )
        })}
      </div>

      {/* Configurazione sorgente */}
      {pathSource === 'static' && (
        <Field label="File path" hint="Absolute or relative path to the job base directory">
          <input type="text" style={inputStyle} value={p('path')} onChange={u('path')}
            placeholder="/data/input/file.csv" />
        </Field>
      )}

      {pathSource === 'lane_var' && (
        <Field label="Lane variable" hint="String variable containing the file path">
          {laneVars.length > 0 ? (
            <CustomSelect style={inputStyle} value={p('laneVarName')} onChange={u('laneVarName')}>
              <option value="">— select variable —</option>
              {laneVars.map((v) => (
                <option key={v.id} value={v.name}>
                  {v.name}{v.value ? ` = "${v.value}"` : ' (empty)'}
                </option>
              ))}
            </CustomSelect>
          ) : (
            <div style={{ fontSize: 10, color: '#ff5f57', fontStyle: 'italic', padding: '4px 0' }}>
              No string variable available in this lane.
              Add it from the Lane tab in the properties panel.
            </div>
          )}
        </Field>
      )}

      {pathSource === 'flow' && (
        <Field
          label="Path field from flow"
          hint="Name of the row field containing the file path — usually 'path' from the DirWatcher"
        >
          <input style={inputStyle} value={p('pathField', 'path')} onChange={u('pathField')}
            placeholder="path" />
        </Field>
      )}

      {/* Preview path effettivo */}
      {effectivePath && (
        <div style={{ padding: '5px 10px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${ACCENT}30`, display: 'flex', gap: 6, alignItems: 'center' }}>
          <i className="ti ti-arrow-right" style={{ fontSize: 10, color: ACCENT, flexShrink: 0 }} />
          <code style={{ fontSize: 10, color: ACCENT, fontFamily: 'monospace' }}>{effectivePath}</code>
        </div>
      )}

      {/* ── Formato ── */}
      <SectionTitle label="Format" />

      <Row>
        <Field label="Format">
          <CustomSelect style={inputStyle} value={format} onChange={(e) => {
            const newFormat = e.target.value
            updateProp(nodeId, 'format', newFormat)
            // Se il formato ha schema fisso — scrivi outputSchema automaticamente
            const fixed = FIXED_SCHEMA[newFormat]
            if (fixed) {
              updateProp(nodeId, 'outputSchema', JSON.stringify(fixed))
            } else if (!STRUCTURED_FORMATS.includes(newFormat as FileFormat)) {
              // formato non strutturato senza schema fisso — azzera
              updateProp(nodeId, 'outputSchema', '')
            }
          }}>
            {FORMAT_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.formats.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </optgroup>
            ))}
          </CustomSelect>
        </Field>

        {STRUCTURED_FORMATS.includes(format) &&
          format !== 'parquet' && format !== 'orc' && format !== 'avro' && (
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

        {(format === 'pdf_binary' || format === 'binary') && (
          <Field label="Output encoding">
            <CustomSelect style={inputStyle} value={p('binaryEncoding', 'base64')} onChange={u('binaryEncoding')}>
              <option value="base64">Base64</option>
              <option value="hex">Hex</option>
            </CustomSelect>
          </Field>
        )}
      </Row>

      {/* ── Opzioni formato ── */}
      {(format === 'csv' || format === 'tsv') && (
        <>
          <SectionTitle label="CSV / TSV options" />
          <Row>
            <Field label="Delimiter">
              <input type="text" style={inputStyle}
                value={p('delimiter', format === 'tsv' ? '\t' : ',')} onChange={u('delimiter')} placeholder="," />
            </Field>
            <Field label="Quote character">
              <input type="text" style={inputStyle} value={p('quoteChar', '"')} onChange={u('quoteChar')} />
            </Field>
          </Row>
          <Row>
            <Field label="Header">
              <CustomSelect style={inputStyle} value={p('hasHeader', 'true')} onChange={u('hasHeader')}>
                <option value="true">First row = header</option>
                <option value="false">No header</option>
              </CustomSelect>
            </Field>
            <Field label="Escape character">
              <input type="text" style={inputStyle} value={p('escapeChar', '\\')} onChange={u('escapeChar')} />
            </Field>
          </Row>
          <Field label="Comment" hint="Rows starting with this character are skipped">
            <input type="text" style={inputStyle} value={p('commentChar', '')} onChange={u('commentChar')}
              placeholder="# (optional)" />
          </Field>
        </>
      )}

      {format === 'excel' && (
        <>
          <SectionTitle label="Excel options" />
          <Row>
            <Field label="Sheet name" hint="Leave empty for the first sheet">
              <input type="text" style={inputStyle} value={p('sheetName', '')} onChange={u('sheetName')}
                placeholder="Sheet1 (optional)" />
            </Field>
            <Field label="Data start row" hint="1 = first row">
              <input type="number" style={inputStyle} value={p('startRow', '1')} onChange={u('startRow')} min="1" />
            </Field>
          </Row>
          <Field label="Header">
            <CustomSelect style={inputStyle} value={p('hasHeader', 'true')} onChange={u('hasHeader')}>
              <option value="true">First row = header</option>
              <option value="false">No header</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {(format === 'json' || format === 'jsonl') && (
        <>
          <SectionTitle label="JSON options" />
          <Field label="Root JSON Path" hint="E.g. $.data.items for a nested array">
            <input type="text" style={inputStyle} value={p('jsonPath', '$')} onChange={u('jsonPath')} placeholder="$" />
          </Field>
          {format === 'json' && (
            <Field label="Structure">
              <CustomSelect style={inputStyle} value={p('jsonStructure', 'array')} onChange={u('jsonStructure')}>
                <option value="array">Array of objects</option>
                <option value="object">Single object</option>
              </CustomSelect>
            </Field>
          )}
        </>
      )}

      {(format === 'parquet' || format === 'orc' || format === 'avro') && (
        <>
          <SectionTitle label={`${format.toUpperCase()} options`} />
          <Field label="Schema" hint="Leave empty to read the schema embedded in the file">
            <textarea
              style={{ ...inputStyle, resize: 'vertical', minHeight: 60, fontFamily: 'monospace' }}
              value={p('schemaOverride', '')} onChange={u('schemaOverride')}
              placeholder='{"fields": [{"name": "id", "type": "long"}, ...]}'
              spellCheck={false} />
          </Field>
        </>
      )}

      {format === 'pdf_text' && (
        <>
          <SectionTitle label="PDF extraction options" />
          <Row>
            <Field label="Pages" hint="E.g. 1-5, or empty for all">
              <input type="text" style={inputStyle} value={p('pdfPages', '')} onChange={u('pdfPages')} placeholder="all" />
            </Field>
            <Field label="Output granularity">
              <CustomSelect style={inputStyle} value={p('pdfGranularity', 'document')} onChange={u('pdfGranularity')}>
                <option value="document">Whole document</option>
                <option value="page">One row per page</option>
                <option value="paragraph">One record per paragraph</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {/* ── Opzioni lettura ── */}
      <SectionTitle label="Read options" />
      <Row>
        <Field label="Rows to skip" hint="Initial rows to ignore">
          <input type="number" style={inputStyle} value={p('skipRows', '0')} onChange={u('skipRows')} min="0" />
        </Field>
        <Field label="Row limit" hint="0 = all rows">
          <input type="number" style={inputStyle} value={p('limit', '0')} onChange={u('limit')} min="0" />
        </Field>
      </Row>

      {STRUCTURED_FORMATS.includes(format) && (
        <Field label="Glob pattern" hint="To read multiple files: /data/*.csv — used only in static mode">
          <input type="text" style={inputStyle} value={p('glob', '')} onChange={u('glob')}
            placeholder="/data/input/*.csv (optional)" />
        </Field>
      )}

    </div>
  )
}
