/**
 * src/nodes/types/source_ftp/MappingPanel.tsx
 *
 * Mapping panel per source_ftp — sola visualizzazione per formati fissi,
 * editabile per formati strutturati (csv, tsv, ecc.)
 */
import { useFlowStore } from '../../../store/flowStore'
import type { TMapInputField, TMapFieldType } from '../../../types'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#4a9eff'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '3px 6px', outline: 'none',
}

const FIELD_TYPES: TMapFieldType[] = ['string', 'integer', 'decimal', 'boolean', 'date', 'object', 'any']

// Schema fisso per ogni formato
const FORMAT_SCHEMA: Record<string, TMapInputField[]> = {
  raw: [
    { id: 'ftp_content',     name: 'content',      type: 'string',  physicalName: 'content'     },
    { id: 'ftp_filename',    name: '_filename',     type: 'string',  physicalName: '_filename'   },
    { id: 'ftp_filepath',    name: '_filepath',     type: 'string',  physicalName: '_filepath'   },
    { id: 'ftp_filesize',    name: '_filesize',     type: 'integer', physicalName: '_filesize'   },
    { id: 'ftp_modified_at', name: '_modified_at',  type: 'date',    physicalName: '_modified_at'},
  ],
  text: [
    { id: 'ftp_line',        name: 'line',          type: 'string',  physicalName: 'line'        },
    { id: 'ftp_linenum',     name: 'lineNumber',    type: 'integer', physicalName: 'lineNumber'  },
    { id: 'ftp_filename',    name: '_filename',     type: 'string',  physicalName: '_filename'   },
    { id: 'ftp_filepath',    name: '_filepath',     type: 'string',  physicalName: '_filepath'   },
    { id: 'ftp_modified_at', name: '_modified_at',  type: 'date',    physicalName: '_modified_at'},
  ],
  list_files: [
    { id: 'ftp_name',        name: 'name',          type: 'string',  physicalName: 'name'        },
    { id: 'ftp_path',        name: 'path',          type: 'string',  physicalName: 'path'        },
    { id: 'ftp_is_dir',      name: 'is_dir',        type: 'boolean', physicalName: 'is_dir'      },
    { id: 'ftp_size',        name: 'size',          type: 'integer', physicalName: 'size'        },
    { id: 'ftp_modified_at', name: 'modified_at',   type: 'date',    physicalName: 'modified_at' },
  ],
  json: [
    { id: 'ftp_content',     name: 'content',       type: 'object',  physicalName: 'content'     },
    { id: 'ftp_raw',         name: 'raw',           type: 'string',  physicalName: 'raw'         },
    { id: 'ftp_filename',    name: '_filename',     type: 'string',  physicalName: '_filename'   },
    { id: 'ftp_filepath',    name: '_filepath',     type: 'string',  physicalName: '_filepath'   },
    { id: 'ftp_modified_at', name: '_modified_at',  type: 'date',    physicalName: '_modified_at'},
  ],
  xml: [
    { id: 'ftp_content',     name: 'content',       type: 'string',  physicalName: 'content'     },
    { id: 'ftp_filename',    name: '_filename',     type: 'string',  physicalName: '_filename'   },
    { id: 'ftp_filepath',    name: '_filepath',     type: 'string',  physicalName: '_filepath'   },
    { id: 'ftp_modified_at', name: '_modified_at',  type: 'date',    physicalName: '_modified_at'},
  ],
  binary: [
    { id: 'ftp_data',        name: 'data',          type: 'string',  physicalName: 'data'        },
    { id: 'ftp_filename',    name: '_filename',     type: 'string',  physicalName: '_filename'   },
    { id: 'ftp_filepath',    name: '_filepath',     type: 'string',  physicalName: '_filepath'   },
    { id: 'ftp_filesize',    name: '_filesize',     type: 'integer', physicalName: '_filesize'   },
    { id: 'ftp_modified_at', name: '_modified_at',  type: 'date',    physicalName: '_modified_at'},
  ],
}

// Formati con schema fisso — non editabili
const FIXED_FORMATS = new Set(['raw', 'text', 'list_files', 'json', 'xml', 'binary'])

const META_FIELDS: TMapInputField[] = [
  { id: 'ftp_filename',    name: '_filename',    type: 'string',  physicalName: '_filename'   },
  { id: 'ftp_filepath',    name: '_filepath',    type: 'string',  physicalName: '_filepath'   },
  { id: 'ftp_filesize',    name: '_filesize',    type: 'integer', physicalName: '_filesize'   },
  { id: 'ftp_modified_at', name: '_modified_at', type: 'date',    physicalName: '_modified_at'},
]

export function FtpMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null

  const outputMode = node.data.props['outputMode'] ?? 'content'
  const fileFormat = outputMode === 'list_files' ? 'list_files' : (node.data.props['fileFormat'] ?? 'csv')
  const isFixed    = FIXED_FORMATS.has(fileFormat)

  // Schema corrente
  const getSchema = (): TMapInputField[] => {
    try {
      const raw = node.data.props['outputSchema']
      if (raw) return JSON.parse(raw)
    } catch {}
    return FORMAT_SCHEMA[fileFormat] ?? []
  }

  const saveSchema = (fields: TMapInputField[]) => {
    updateProp(nodeId, 'outputSchema', JSON.stringify(fields))
    // Propaga ai TMap collegati
    const store    = useFlowStore.getState()
    const outEdges = store.edges.filter((e) => e.source === nodeId)
    outEdges.forEach((edge) => {
      const tgt = store.nodes.find((n) => n.id === edge.target)
      if (!tgt || tgt.data.type !== 'tmap') return
      const tmap = tgt.data.config?.tmap as any
      if (!tmap) return
      const input = tmap.inputs.find((i: any) => i.id === edge.targetHandle)
      if (!input) return
      const existingNames = new Set(input.fields.map((f: any) => f.name))
      const merged = [
        ...input.fields,
        ...fields.filter((f) => !existingNames.has(f.name)),
      ]
      store.updateTMapInput(tgt.id, input.id, { fields: merged })
    })
  }

  const schema = getSchema()
  const fixedSchema = FORMAT_SCHEMA[fileFormat]

  const addField = () => {
    const n = schema.length + 1
    const name = `campo_${n}`
    saveSchema([...schema, { id: `field_${Date.now()}`, name, physicalName: name, type: 'string' }])
  }

  const updateField = (idx: number, key: string, value: string) =>
    saveSchema(schema.map((f, i) => i === idx ? { ...f, [key]: value } : f))

  const deleteField = (idx: number) =>
    saveSchema(schema.filter((_, i) => i !== idx))

  // Quando il formato ha uno schema fisso, sincronizzalo automaticamente
  if (isFixed && fixedSchema) {
    const current = JSON.stringify(getSchema())
    const fixed   = JSON.stringify(fixedSchema)
    if (current !== fixed) {
      setTimeout(() => updateProp(nodeId, 'outputSchema', fixed), 0)
    }
  }

  const formatLabel = fileFormat === 'list_files' ? 'Lista file' : fileFormat.toUpperCase()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0', flex: 1 }}>
          Schema di uscita
          <span style={{ fontSize: 10, color: '#4a5a7a', fontWeight: 400, marginLeft: 8 }}>
            — campi propagati ai nodi successivi
          </span>
        </div>
      </div>

      <div style={{ borderBottom: '0.5px solid #2a3349' }} />

      {/* Info formato */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 11 }}>
        <i className="ti ti-server" style={{ fontSize: 13, color: ACCENT }} />
        <span style={{ color: '#9a9aaa' }}>Formato:</span>
        <span style={{ padding: '1px 7px', borderRadius: 8, fontSize: 10, background: '#1a3a6a', color: ACCENT, fontWeight: 600 }}>
          {formatLabel}
        </span>
        <span style={{ fontSize: 10, color: '#4a5a7a', marginLeft: 4, fontStyle: 'italic' }}>
          {isFixed ? 'schema fisso' : `${schema.length} campi`}
        </span>
      </div>

      {/* Hint per formati che vanno al parser */}
      {(fileFormat === 'raw' || fileFormat === 'json' || fileFormat === 'xml') && (
        <div style={{ padding: '7px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #22d3ee30', fontSize: 10, color: '#4a5a7a', display: 'flex', gap: 6 }}>
          <i className="ti ti-arrow-right" style={{ fontSize: 10, color: '#22d3ee', flexShrink: 0, marginTop: 1 }} />
          <span>
            Il campo <code style={{ color: '#22d3ee' }}>content</code>{fileFormat === 'json' ? '/raw' : ''} contiene il file grezzo —
            collegalo a un <strong style={{ color: '#22d3ee' }}>
              {fileFormat === 'xml' ? 'XML Parser' : 'JSON Parser'}
            </strong> per estrarne i dati strutturati.
          </span>
        </div>
      )}

      {/* Schema fisso — sola lettura */}
      {isFixed && fixedSchema && (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
            {['Campo', 'Tipo'].map((h) => (
              <div key={h} style={{ fontSize: 10, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {fixedSchema.map((f, i) => (
            <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, padding: '6px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < fixedSchema.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: f.name.startsWith('_') ? '#4a5a7a' : '#c8d4f0' }}>{f.name}</span>
              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#1a3a6a', color: ACCENT, textAlign: 'center' }}>{f.type}</span>
            </div>
          ))}
        </div>
      )}

      {/* Schema editabile (CSV, TSV, ecc.) */}
      {!isFixed && (
        <>
          {schema.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 12, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
              <i className="ti ti-file-search" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
              Aggiungi i campi manualmente oppure configurali dopo aver eseguito il flusso.
            </div>
          ) : (
            <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 24px', gap: 6, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
                {['Campo', 'Tipo', ''].map((h, i) => (
                  <div key={i} style={{ fontSize: 10, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
                ))}
              </div>
              {schema.map((field, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 24px', gap: 6, alignItems: 'center', padding: '4px 8px', background: idx % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: idx < schema.length - 1 ? '0.5px solid #2a3349' : 'none' }}>
                  <input type="text" value={field.name}
                    onChange={(e) => updateField(idx, 'name', e.target.value)}
                    style={inputStyle} placeholder="nome_campo" />
                  <CustomSelect value={field.type} onChange={(e) => updateField(idx, 'type', e.target.value)}
                    style={{ ...inputStyle, padding: '3px 4px' }}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </CustomSelect>
                  <button onClick={() => deleteField(idx)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                    <i className="ti ti-x" style={{ fontSize: 11 }} />
                  </button>
                </div>
              ))}
            </div>
          )}

          <button onClick={addField}
            style={{ background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 6, padding: '7px', fontSize: 11, color: ACCENT, cursor: 'pointer', width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}>
            <i className="ti ti-plus" style={{ fontSize: 12 }} />
            Aggiungi campo
          </button>

          {/* Metadati file sempre presenti */}
          <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a' }}>
            <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4, color: ACCENT }} />
            I campi <code style={{ color: ACCENT }}>_filename</code>, <code style={{ color: ACCENT }}>_filepath</code>,
            <code style={{ color: ACCENT }}>_filesize</code>, <code style={{ color: ACCENT }}>_modified_at</code> sono
            sempre aggiunti automaticamente dall'executor.
          </div>
        </>
      )}
    </div>
  )
}
