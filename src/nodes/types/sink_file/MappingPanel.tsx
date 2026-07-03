/**
 * src/nodes/types/sink_file/MappingPanel.tsx
 *
 * Modifiche rispetto alla versione precedente:
 * - saveSchema ora sincronizza incomingSchema nel formato canonico
 *   { id, name, type, physicalName } dopo ogni scrittura in outputSchema.
 *   Stesso principio del SinkDbMappingPanel — canale canonico unico
 *   per ImportSchemaButton e getHandleSchema.
 */
import { useFlowStore } from '../../../store/flowStore'
import type { TMapFieldType } from '../../../types'
import { useIncomingSchema } from '../../useIncomingSchema'
import { useState, useEffect } from 'react'
import { CustomSelect } from '../../../components/CustomSelect'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const FIELD_TYPES: TMapFieldType[] = [
  'string', 'number', 'integer', 'decimal', 'boolean', 'date', 'object', 'any',
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

  const outputMode = node.data.props['outputMode'] ?? 'signal'
  const isSignal   = outputMode === 'signal'
  const isReadOnly = isSignal

  const getSchema = (): OutputField[] => {
    try {
      const raw = node.data.props['outputSchema']
      if (raw) {
        const parsed = JSON.parse(raw)
        if (parsed[0]?.sourceField !== undefined) return parsed
      }
    } catch {}
    return incomingFields.map((f) => ({
      sourceField: f.name, outputName: f.name, type: f.type, transform: '', include: true,
    }))
  }

  // ─── saveSchema — punto unico di scrittura ────────────────────
  // Scrive outputSchema (formato interno OutputField[]) E sincronizza
  // incomingSchema nel formato canonico { id, name, type, physicalName }.
  // Solo i campi con include=true e outputName valorizzato entrano
  // in incomingSchema — riflette esattamente ciò che il nodo espone.
  const saveSchema = (fields: OutputField[]) => {
    updateProp(nodeId, 'outputSchema', JSON.stringify(fields))

    // Sincronizza incomingSchema — canale canonico per ImportSchemaButton e getHandleSchema
    const normalized = fields
      .filter((f) => f.include && f.outputName)
      .map((f) => ({
        id:           `sinkfile__${f.sourceField}`,
        name:         f.outputName,
        type:         f.type ?? 'string',
        physicalName: f.sourceField,
      }))
    updateProp(nodeId, 'incomingSchema', JSON.stringify(normalized))
  }

  const schema = getSchema()

  useEffect(() => {
    if (!isReadOnly && incomingFields.length > 0 && schema.length === 0) {
      saveSchema(incomingFields.map((f) => ({
        sourceField: f.name, outputName: f.name, type: f.type, transform: '', include: true,
      })))
    }
  }, [incomingFields.map((f) => f.name).join(',')])

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

  if (isReadOnly) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div style={{ padding: '8px 12px', background: 'color-mix(in srgb, #ffb347 8%, #0f1117)', borderRadius: 6, border: '0.5px solid #ffb34740', fontSize: 10, color: '#ffb347', display: 'flex', gap: 6 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
          Modalità <strong>Buffer → Signal</strong> — questo nodo emette una sola riga di stato,
          non le righe originali. Il mapping non è configurabile.
          Passa alla modalità <strong>Buffer → Replay</strong> nel tab Configurazione
          per scrivere il file e riemettere le righe originali.
        </div>
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1fr', gap: 8, padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
            {['Campo', 'Tipo', 'Descrizione'].map((h) => (
              <div key={h} style={{ fontSize: 10, color: '#ffb347', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {[
            { name: 'status',        type: 'string',  desc: '"done" o "error"'           },
            { name: 'rows_written',  type: 'integer', desc: 'Righe scritte nel file'      },
            { name: 'bytes_written', type: 'integer', desc: 'Dimensione file in bytes'    },
            { name: 'file_path',     type: 'string',  desc: 'Path effettivo del file'     },
            { name: 'completed_at',  type: 'date',    desc: 'Timestamp completamento'     },
            { name: 'error_message', type: 'string',  desc: 'Messaggio errore se fallito' },
            { name: 'duration_ms',   type: 'integer', desc: 'Durata scrittura in ms'      },
          ].map((f, i, arr) => (
            <div key={f.name} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 1fr', gap: 8, padding: '6px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
              <code style={{ fontFamily: 'monospace', fontSize: 11, color: '#ffb347' }}>{f.name}</code>
              <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#1a1000', color: '#ffb347', textAlign: 'center' }}>{f.type}</span>
              <span style={{ fontSize: 10, color: '#4a5a7a' }}>{f.desc}</span>
            </div>
          ))}
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      <div style={{ padding: '6px 12px', background: 'color-mix(in srgb, #3ddc84 8%, #0f1117)', borderRadius: 6, border: '0.5px solid #3ddc8440', fontSize: 10, color: '#3ddc84', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
        Modalità <strong>Buffer → Replay</strong> — scrive il file e riemette le righe originali.
        Questo mapping definisce quali campi vengono scritti nel file.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0', flex: 1 }}>
          Campi da scrivere nel file
          <span style={{ fontSize: 10, color: '#4a5a7a', fontWeight: 400, marginLeft: 8 }}>
            — {includedCount} di {schema.length} selezionati
          </span>
        </div>
        {incomingFields.length > 0 && (
          <button onClick={syncFromIncoming}
            style={{ padding: '5px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: '#0d3d20', color: ACCENT, border: '1px solid #1d6d40', display: 'flex', alignItems: 'center', gap: 5 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1d6d40' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#0d3d20' }}>
            <i className="ti ti-refresh" style={{ fontSize: 12 }} />
            Sincronizza dal pipeline
          </button>
        )}
      </div>

      <div style={{ borderBottom: '0.5px solid #2a3349' }} />

      {schema.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 12, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          Collega un nodo in ingresso per ricevere automaticamente i campi da scrivere nel file.
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '24px 28px minmax(80px,1fr) minmax(80px,1fr) 80px minmax(80px,1fr) 24px', gap: 6, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
            {['', '✓', 'Campo sorgente', 'Nome nel file', 'Tipo', 'Trasformazione', ''].map((h, i) => (
              <div key={i} style={{ fontSize: 10, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {schema.map((field, idx) => (
            <div key={idx} style={{ display: 'grid', gridTemplateColumns: '24px 28px minmax(80px,1fr) minmax(80px,1fr) 80px minmax(80px,1fr) 24px', gap: 6, alignItems: 'center', padding: '4px 8px', background: !field.include ? '#0f1117' : idx % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: idx < schema.length - 1 ? '0.5px solid #2a3349' : 'none', opacity: field.include ? 1 : 0.4 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <button onClick={() => moveField(idx, 'up')} disabled={idx === 0}
                  style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'not-allowed' : 'pointer', color: idx === 0 ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
                  <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
                </button>
                <button onClick={() => moveField(idx, 'down')} disabled={idx === schema.length - 1}
                  style={{ background: 'none', border: 'none', cursor: idx === schema.length - 1 ? 'not-allowed' : 'pointer', color: idx === schema.length - 1 ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
                  <i className="ti ti-chevron-down" style={{ fontSize: 9 }} />
                </button>
              </div>
              <div onClick={() => toggleInclude(idx)}
                style={{ width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${field.include ? ACCENT : '#2a3349'}`, background: field.include ? '#0d3d20' : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {field.include && <i className="ti ti-check" style={{ fontSize: 10, color: ACCENT }} />}
              </div>
              <div title={field.sourceField}
                style={{ fontFamily: 'monospace', fontSize: 10, color: '#4a5a7a', padding: '3px 6px', background: '#161b27', borderRadius: 4, border: '0.5px solid #2a3349', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {field.sourceField}
              </div>
              <input type="text" value={field.outputName}
                onChange={(e) => updateField(idx, 'outputName', e.target.value)}
                disabled={!field.include}
                style={{ ...inputStyle, fontSize: 11, padding: '3px 6px', color: ACCENT }}
                placeholder="nome_colonna" />
              <CustomSelect value={field.type} onChange={(e) => updateField(idx, 'type', e.target.value)}
                disabled={!field.include} style={{ ...inputStyle, fontSize: 10, padding: '3px 4px' }}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </CustomSelect>
              <CustomSelect value={field.transform} onChange={(e) => updateField(idx, 'transform', e.target.value)}
                disabled={!field.include} style={{ ...inputStyle, fontSize: 10, padding: '3px 2px' }}>
                <option value="">nessuna</option>
                <option value="trim">trim</option>
                <option value="uppercase">UPPER</option>
                <option value="lowercase">lower</option>
                <option value="to_int">→ int</option>
                <option value="to_float">→ dec</option>
                <option value="to_date">→ data</option>
                <option value="to_bool">→ bool</option>
                <option value="to_string">→ str</option>
                <option value="nullify_empty">vuoto→null</option>
              </CustomSelect>
              <button onClick={() => saveSchema(schema.filter((_, i) => i !== idx))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
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
            <i className="ti ti-checks" style={{ fontSize: 11 }} /> Seleziona tutti
          </button>
          <button onClick={() => saveSchema(schema.map((f) => ({ ...f, include: false })))}
            style={{ flex: 1, padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <i className="ti ti-square" style={{ fontSize: 11 }} /> Deseleziona tutti
          </button>
        </div>
      )}

      <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, marginRight: 4 }} />
        Questo mapping definisce <strong style={{ color: '#9a9aaa' }}>cosa viene scritto nel file</strong>.
        Le righe originali vengono riemesse invariate al nodo successivo dopo la scrittura.
      </div>
    </div>
  )
}