/**
 * src/nodes/types/source_ftp/MappingPanel.tsx
 *
 * Schema d'uscita del FTP/SFTP Source (P362). Formati a schema fisso: sola
 * lettura (./schema.ts, allineato al motore). CSV, TSV ed Excel: i campi
 * scelti qui — colonna nel file, nome, tipo — che il motore applica (il
 * builder li passa come `fields`, come per il File Input). I metadati del
 * file (_filename…) si aggiungono sempre.
 */
import { useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import type { TMapConfig, TMapInputField } from '../../../types'
import { CustomSelect } from '../../../components/CustomSelect'
import { FIELD_TYPES } from '../../../types/fieldTypes'
import { FTP_META_FIELDS, ftpFixedSchema } from './schema'

const ACCENT = '#4a9eff'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '3px 6px', outline: 'none',
}

const META_NAMES = new Set(FTP_META_FIELDS.map((f) => f.name))

/** I campi scelti dall'utente (senza i metadati) dallo schema salvato. */
function userFields(raw: string | undefined): TMapInputField[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    return Array.isArray(parsed) ? parsed.filter((f: TMapInputField) => !META_NAMES.has(f.name)) : []
  } catch { return [] }
}

export function FtpMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  const props      = node?.data.props ?? {}
  const outputMode = props['outputMode'] ?? 'content'
  const fileFormat = props['fileFormat'] ?? 'csv'
  const fixed      = ftpFixedSchema(outputMode, fileFormat)
  const fixedJson  = fixed ? JSON.stringify(fixed) : null

  // Formato a schema fisso: lo schema salvato deve essere quello.
  useEffect(() => {
    if (node && fixedJson && props['outputSchema'] !== fixedJson) updateProp(nodeId, 'outputSchema', fixedJson)
  }, [fixedJson])

  if (!node) return null

  const schema = fixed ? [] : userFields(props['outputSchema'])

  const saveSchema = (fields: TMapInputField[]) => {
    // Nessun campo scelto: schema ignoto (il motore emette tutte le colonne).
    const full = fields.length > 0 ? [...fields, ...FTP_META_FIELDS] : []
    updateProp(nodeId, 'outputSchema', full.length > 0 ? JSON.stringify(full) : '')
    // Propaga ai TMap collegati
    const store    = useFlowStore.getState()
    store.edges.filter((e) => e.source === nodeId).forEach((edge) => {
      const tgt = store.nodes.find((n) => n.id === edge.target)
      if (!tgt || tgt.data.type !== 'tmap') return
      const tmap = tgt.data.config?.tmap as TMapConfig | undefined
      const input = tmap?.inputs.find((i) => i.id === edge.targetHandle)
      if (!input) return
      const existingNames = new Set(input.fields.map((f) => f.name))
      store.updateTMapInput(tgt.id, input.id, { fields: [...input.fields, ...full.filter((f) => !existingNames.has(f.name))] })
    })
  }

  const addField = () => {
    const name = `field_${schema.length + 1}`
    saveSchema([...schema, { id: `field_${Date.now()}`, name, physicalName: name, type: 'string' }])
  }
  const updateField = (idx: number, key: 'name' | 'physicalName' | 'type', value: string) =>
    saveSchema(schema.map((f, i) => {
      if (i !== idx) return f
      // Finché colonna e nome coincidono, rinominare il campo rinomina anche la colonna.
      if (key === 'name' && (f.physicalName ?? f.name) === f.name) return { ...f, name: value, physicalName: value }
      return { ...f, [key]: value }
    }))
  const deleteField = (idx: number) => saveSchema(schema.filter((_, i) => i !== idx))

  const formatLabel = outputMode === 'list_files' ? 'File list' : fileFormat.toUpperCase()

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0' }}>
        Output schema
        <span style={{ fontSize: 10, color: '#8593b5', fontWeight: 400, marginLeft: 8 }}>
          — fields propagated to downstream nodes
        </span>
      </div>

      <div style={{ borderBottom: '0.5px solid #2a3349' }} />

      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 11 }}>
        <i className="ti ti-server" style={{ fontSize: 13, color: ACCENT }} />
        <span style={{ color: '#9a9aaa' }}>Format:</span>
        <span style={{ padding: '1px 7px', borderRadius: 8, fontSize: 10, background: '#1a3a6a', color: ACCENT, fontWeight: 600 }}>
          {formatLabel}
        </span>
        <span style={{ fontSize: 10, color: '#8593b5', marginLeft: 4, fontStyle: 'italic' }}>
          {fixed ? 'fixed schema' : `${schema.length} field${schema.length === 1 ? '' : 's'}`}
        </span>
      </div>

      {outputMode !== 'list_files' && (fileFormat === 'raw' || fileFormat === 'json' || fileFormat === 'jsonl' || fileFormat === 'xml') && (
        <div style={{ padding: '7px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #22d3ee30', fontSize: 10, color: '#8593b5', display: 'flex', gap: 6 }}>
          <i className="ti ti-arrow-right" style={{ fontSize: 10, color: '#22d3ee', flexShrink: 0, marginTop: 1 }} />
          <span>
            The <code style={{ color: '#22d3ee' }}>content</code> field holds the {fileFormat === 'jsonl' ? 'object of each line' : 'whole document'} —
            connect it to a <strong style={{ color: '#22d3ee' }}>{fileFormat === 'xml' ? 'XML Parser' : 'JSON Parser'}</strong> to extract the structured data.
          </span>
        </div>
      )}

      {/* Schema fisso — sola lettura */}
      {fixed && (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
            {['Field', 'Type'].map((h) => (
              <div key={h} style={{ fontSize: 10, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {fixed.map((f, i) => (
            <div key={f.name} style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, padding: '6px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < fixed.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
              <span style={{ fontFamily: 'monospace', fontSize: 11, color: f.name.startsWith('_') ? '#8593b5' : '#c8d4f0' }}>{f.name}</span>
              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#1a3a6a', color: ACCENT, textAlign: 'center' }}>{f.type}</span>
            </div>
          ))}
        </div>
      )}

      {/* Schema scelto (CSV, TSV, Excel) */}
      {!fixed && (
        <>
          {schema.length === 0 ? (
            <div style={{ padding: '20px', textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
              <i className="ti ti-file-search" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
              No field chosen: every column of the file is read as text.
              Add the fields to choose, rename and type them.
            </div>
          ) : (
            <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 24px', gap: 6, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
                {['Column in file', 'Field name', 'Type', ''].map((h, i) => (
                  <div key={i} style={{ fontSize: 10, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
                ))}
              </div>
              {schema.map((field, idx) => (
                <div key={idx} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 80px 24px', gap: 6, alignItems: 'center', padding: '4px 8px', background: idx % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: idx < schema.length - 1 ? '0.5px solid #2a3349' : 'none' }}>
                  <input type="text" value={field.physicalName ?? field.name}
                    onChange={(e) => updateField(idx, 'physicalName', e.target.value)}
                    style={{ ...inputStyle, color: '#8593b5' }} placeholder="column" />
                  <input type="text" value={field.name}
                    onChange={(e) => updateField(idx, 'name', e.target.value)}
                    style={inputStyle} placeholder="field_name" />
                  <CustomSelect value={field.type} onChange={(e) => updateField(idx, 'type', e.target.value)}
                    style={{ ...inputStyle, padding: '3px 4px' }}>
                    {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                  </CustomSelect>
                  <button onClick={() => deleteField(idx)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
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
            Add field
          </button>

          <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5' }}>
            <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4, color: ACCENT }} />
            With fields chosen, only those columns are read, with their name and type.
            The fields <code style={{ color: ACCENT }}>_filename</code>, <code style={{ color: ACCENT }}>_filepath</code>,{' '}
            <code style={{ color: ACCENT }}>_filesize</code>, <code style={{ color: ACCENT }}>_modified_at</code> are always added.
          </div>
        </>
      )}
    </div>
  )
}
