/**
 * src/nodes/types/sink_file/MappingPanel.tsx
 *
 * Colonne del file (P361): quali campi si scrivono, in che ordine, con che
 * nome, tipo e trasformazione. Le salva `fileColumns` e le applica il
 * motore (sink_file.rs, engine/field_mapping.rs) a ogni formato a righe,
 * in entrambe le modalità d'uscita. Senza colonne si scrivono tutti i
 * campi, in ordine alfabetico. Lo schema d'uscita del nodo NON dipende da
 * qui: signal = riga di stato, replay = le righe in ingresso invariate.
 */
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'
import { FIELD_TYPES } from '../../../types/fieldTypes'
import { SINK_FIELD_FORMATS } from './schema'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}

/** Trasformazioni del testo (le conversioni le fa la colonna Type). */
const TRANSFORMS = [
  { value: '',              label: 'none'       },
  { value: 'trim',          label: 'trim'       },
  { value: 'uppercase',     label: 'UPPER'      },
  { value: 'lowercase',     label: 'lower'      },
  { value: 'nullify_empty', label: 'empty→null' },
]

type OutputField = {
  sourceField: string
  outputName:  string
  type:        string
  transform:   string
  include:     boolean
}

const ACCENT = '#3ddc84'

export function SinkFileMappingPanel({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp     = useFlowStore((s) => s.updateNodeProp)
  const incomingFields = useIncomingSchema(nodeId)

  if (!node) return null

  const format    = node.data.props['format'] ?? 'csv'
  const rawMode   = !!SINK_FIELD_FORMATS[format] || node.data.props['writeMode2'] === 'raw_field'

  const schema: OutputField[] = (() => {
    try {
      const parsed = JSON.parse(node.data.props['fileColumns'] ?? '[]')
      return Array.isArray(parsed) ? parsed : []
    } catch { return [] }
  })()

  const saveSchema = (fields: OutputField[]) =>
    updateProp(nodeId, 'fileColumns', JSON.stringify(fields))

  const loadIncoming = () =>
    saveSchema(incomingFields.map((f) => ({
      sourceField: f.name, outputName: f.name, type: f.type, transform: '', include: true,
    })))

  const toggleInclude = (idx: number) =>
    saveSchema(schema.map((f, i) => i === idx ? { ...f, include: !f.include } : f))

  const updateField = (idx: number, key: keyof OutputField, value: string | boolean) =>
    saveSchema(schema.map((f, i) => i === idx ? { ...f, [key]: value } : f))

  const moveField = (idx: number, dir: 'up' | 'down') => {
    const arr     = [...schema]
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= arr.length) return
    ;[arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]]
    saveSchema(arr)
  }

  const syncFromIncoming = () => {
    const existingSources = new Set(schema.map((f) => f.sourceField))
    const newFields = incomingFields
      .filter((f) => !existingSources.has(f.name))
      .map((f) => ({ sourceField: f.name, outputName: f.name, type: f.type, transform: '', include: true }))
    if (newFields.length > 0) saveSchema([...schema, ...newFields])
  }

  const includedCount = schema.filter((f) => f.include).length

  if (rawMode) {
    return (
      <div style={{ padding: '10px 12px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1, color: ACCENT }} />
        The node writes the value of a single field per row ("Value of a field" in the Configuration tab): there are no columns to map.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      <div style={{ padding: '6px 12px', background: 'color-mix(in srgb, #3ddc84 8%, #0f1117)', borderRadius: 6, border: '0.5px solid #3ddc8440', fontSize: 10, color: '#3ddc84', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
        The columns written to the file: only the selected fields, in this order, with the name, type and transformation chosen here.
        It does not change what the node emits downstream.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0', flex: 1 }}>
          Columns of the file
          <span style={{ fontSize: 10, color: '#8593b5', fontWeight: 400, marginLeft: 8 }}>
            — {includedCount} of {schema.length} selected
          </span>
        </div>
        {incomingFields.length > 0 && schema.length > 0 && (
          <button onClick={syncFromIncoming}
            style={{ padding: '5px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: '#0d3d20', color: ACCENT, border: '1px solid #1d6d40', display: 'flex', alignItems: 'center', gap: 5 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1d6d40' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#0d3d20' }}>
            <i className="ti ti-refresh" style={{ fontSize: 12 }} />
            Add new incoming fields
          </button>
        )}
      </div>

      <div style={{ borderBottom: '0.5px solid #2a3349' }} />

      {schema.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-columns" style={{ fontSize: 24 }} />
          <div>No columns chosen: every incoming field is written, in alphabetical order.</div>
          {incomingFields.length > 0 ? (
            <button onClick={loadIncoming}
              style={{ padding: '5px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: '#0d3d20', color: ACCENT, border: '1px solid #1d6d40', display: 'flex', alignItems: 'center', gap: 5 }}>
              <i className="ti ti-list-check" style={{ fontSize: 12 }} />
              Choose the columns from the {incomingFields.length} incoming fields
            </button>
          ) : (
            <div style={{ fontSize: 10 }}>Connect an incoming node to choose the columns.</div>
          )}
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '24px 28px minmax(80px,1fr) minmax(80px,1fr) 80px minmax(80px,1fr) 24px', gap: 6, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
            {['', '✓', 'Source field', 'Column name', 'Type', 'Transformation', ''].map((h, i) => (
              <div key={i} style={{ fontSize: 10, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {schema.map((field, idx) => (
            <div key={idx} style={{ display: 'grid', gridTemplateColumns: '24px 28px minmax(80px,1fr) minmax(80px,1fr) 80px minmax(80px,1fr) 24px', gap: 6, alignItems: 'center', padding: '4px 8px', background: !field.include ? '#0f1117' : idx % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: idx < schema.length - 1 ? '0.5px solid #2a3349' : 'none', opacity: field.include ? 1 : 0.4 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <button onClick={() => moveField(idx, 'up')} disabled={idx === 0}
                  style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'not-allowed' : 'pointer', color: idx === 0 ? '#2a3349' : '#8593b5', padding: 0, lineHeight: 1 }}>
                  <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
                </button>
                <button onClick={() => moveField(idx, 'down')} disabled={idx === schema.length - 1}
                  style={{ background: 'none', border: 'none', cursor: idx === schema.length - 1 ? 'not-allowed' : 'pointer', color: idx === schema.length - 1 ? '#2a3349' : '#8593b5', padding: 0, lineHeight: 1 }}>
                  <i className="ti ti-chevron-down" style={{ fontSize: 9 }} />
                </button>
              </div>
              <div onClick={() => toggleInclude(idx)}
                style={{ width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${field.include ? ACCENT : '#2a3349'}`, background: field.include ? '#0d3d20' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {field.include && <i className="ti ti-check" style={{ fontSize: 10, color: ACCENT }} />}
              </div>
              <div title={field.sourceField}
                style={{ fontFamily: 'monospace', fontSize: 10, color: '#8593b5', padding: '3px 6px', background: '#161b27', borderRadius: 4, border: '0.5px solid #2a3349', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {field.sourceField}
              </div>
              <input type="text" value={field.outputName}
                onChange={(e) => updateField(idx, 'outputName', e.target.value)}
                disabled={!field.include}
                style={{ ...inputStyle, fontSize: 11, padding: '3px 6px', color: ACCENT }}
                placeholder="column_name" />
              <CustomSelect value={field.type} onChange={(e) => updateField(idx, 'type', e.target.value)}
                disabled={!field.include} style={{ ...inputStyle, fontSize: 10, padding: '3px 4px' }}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </CustomSelect>
              <CustomSelect value={field.transform ?? ''} onChange={(e) => updateField(idx, 'transform', e.target.value)}
                disabled={!field.include} style={{ ...inputStyle, fontSize: 10, padding: '3px 2px' }}>
                {/* Valori vecchi (to_int, to_float…) il motore li applica come tipo. */}
                {TRANSFORMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                {field.transform && !TRANSFORMS.some((t) => t.value === field.transform) && (
                  <option value={field.transform}>{field.transform} (legacy)</option>
                )}
              </CustomSelect>
              <button onClick={() => saveSchema(schema.filter((_, i) => i !== idx))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
                <i className="ti ti-x" style={{ fontSize: 11 }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {schema.length > 0 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => saveSchema(schema.map((f) => ({ ...f, include: true })))}
            style={{ flex: 1, padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#0d3d20', color: ACCENT, border: '0.5px solid #1d6d40', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <i className="ti ti-checks" style={{ fontSize: 11 }} /> Select all
          </button>
          <button onClick={() => saveSchema(schema.map((f) => ({ ...f, include: false })))}
            style={{ flex: 1, padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#8593b5', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <i className="ti ti-square" style={{ fontSize: 11 }} /> Deselect all
          </button>
        </div>
      )}

      <div style={{ padding: '6px 10px', fontSize: 10, color: '#8593b5', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, marginRight: 4 }} />
        Removing every column (✕ on each row) goes back to writing all incoming fields.
      </div>
    </div>
  )
}