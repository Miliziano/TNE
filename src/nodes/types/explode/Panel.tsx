/**
 * src/nodes/types/explode/Panel.tsx
 */
import { useMemo, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import type { SchemaField } from '../../../utils/schemaUtils'
import type { Variable } from '../../../types'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCESS_OPTIONS = [
  { value: 'dataset',  label: 'Dataset — .toDataset() (recommended — full List, zero extra buffering)' },
  { value: 'iterator', label: 'Iterator — .values() (row by row with internal buffering)' },
]

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
function SectionTitle({ label, color = '#a78bfa' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

const ACCENT = '#a78bfa'

export function ExplodePanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)
  const nodes      = useFlowStore((s) => s.nodes)
  const edges      = useFlowStore((s) => s.edges)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const source  = p('explodeSource', 'materialize')
  const laneId  = node.data.laneId
  const hasInput = edges.some((e) => e.target === nodeId)

  const incomingFields = useIncomingSchema(nodeId)

  // Variabili lane
  const laneVars: Variable[] = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === laneId)
    return lane?.variables ?? []
  }, [pool, laneId])

  const materializeVars = laneVars.filter((v) => v.type === 'materialize')
  const objectFields    = incomingFields.filter((f) => f.type === 'object' || f.type === 'any')

  // ── Schema derivato dal Materialize selezionato ───────────────
  // Quando source === 'materialize' e materializeName è configurato,
  // legge incomingSchema del nodo Materialize corrispondente.
  const materializeSchema = useMemo((): SchemaField[] => {
    if (source !== 'materialize') return []
    const matName = p('materializeName')
    if (!matName) return []

    const matVar = materializeVars.find((v) => v.name === matName)
    if (!matVar) return []

    const matNodeLocal = nodes.find((n) => n.id === matVar.value)
    if (!matNodeLocal) return []

    const matModeLocal = matNodeLocal.data.props['matMode'] ?? 'passthrough'
    const isSignal     = matModeLocal === 'buffer_signal'
    const signalFields = new Set(['name', 'row_count', 'status', 'completed_at', 'elapsed_ms'])

    try {
      const raw = matNodeLocal.data.props['incomingSchema'] || matNodeLocal.data.props['outputSchema']
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []
      return parsed
        .filter((f: any) => !isSignal || !signalFields.has(f.name))
        .map((f: any, i: number) => ({
          id:           f.id   ?? `mat_field_${i}`,
          name:         f.name ?? `field_${i}`,
          type:         f.type ?? 'string',
          physicalName: f.physicalName ?? f.name,
        }))
    } catch {
      return []
    }
  }, [source, p('materializeName'), nodes, materializeVars])

  // ── Schema derivato dal campo flusso selezionato ─────────────
  const flowFieldSchema = useMemo((): SchemaField[] => {
    if (source !== 'flow_field') return []
    const fieldName = p('flowField')
    if (!fieldName) return []
    // Lo schema del campo flusso non è noto staticamente —
    // dipende dal contenuto runtime. Restituisce schema vuoto
    // per permettere configurazione manuale.
    return []
  }, [source, p('flowField')])

  // ── outputSchema effettivo ────────────────────────────────────
  const derivedSchema = source === 'materialize' ? materializeSchema : flowFieldSchema

  // Propaga outputSchema quando lo schema derivato cambia
  useEffect(() => {
    if (derivedSchema.length > 0) {
      updateProp(nodeId, 'outputSchema', JSON.stringify(derivedSchema))
    }
  }, [JSON.stringify(derivedSchema)])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info nodo */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa' }}>
        <div style={{ fontWeight: 600, color: ACCENT, marginBottom: 3 }}>⊕ Explode</div>
        Transforms a dense structure into a flow of rows.
        One row for each element of the source structure.
      </div>

      {/* Sorgente */}
      <SectionTitle label="Data source" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value:        'materialize',
            label:        '◈ From Materialize',
            desc:         'Reads a dataset stored in the lane by a Materialize node',
            disabled:     materializeVars.length === 0,
            disabledHint: 'No Materialize published in this lane',
          },
          {
            value:        'flow_field',
            label:        '→ From flow field',
            desc:         'Explodes an object/array field from each incoming row',
            disabled:     !hasInput,
            disabledHint: 'Connect an incoming node',
          },
        ].map((s) => (
          <button key={s.value}
            onClick={() => { if (!s.disabled) updateProp(nodeId, 'explodeSource', s.value) }}
            style={{
              padding: '8px 10px', borderRadius: 6,
              cursor: s.disabled ? 'not-allowed' : 'pointer',
              opacity: s.disabled ? 0.4 : 1,
              background: source === s.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030',
              border: source === s.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349',
              display: 'flex', alignItems: 'center', gap: 10, textAlign: 'left',
            }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: source === s.value ? ACCENT : 'transparent', border: `1.5px solid ${source === s.value ? ACCENT : '#2a3349'}` }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: source === s.value ? ACCENT : '#c8d4f0' }}>{s.label}</div>
              <div style={{ fontSize: 9, color: '#8593b5' }}>{s.disabled ? s.disabledHint : s.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* ── Da Materialize ── */}
      {source === 'materialize' && (
        <>
          <SectionTitle label="Materialize" />
          <Field label="Materialize name" hint="Select the Materialize to read data from">
            {materializeVars.length > 0 ? (
              <CustomSelect style={inputStyle} value={p('materializeName')} onChange={u('materializeName')}>
                <option value="">— select —</option>
                {materializeVars.map((v) => (
                  <option key={v.id} value={v.name}>{v.name}</option>
                ))}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={p('materializeName')} onChange={u('materializeName')} placeholder="materialize_name" />
            )}
          </Field>

          {p('materializeName') && (
            <div style={{ padding: '5px 10px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${ACCENT}20`, display: 'flex', gap: 5, alignItems: 'center' }}>
              <i className="ti ti-arrow-right" style={{ fontSize: 9, color: ACCENT }} />
              dataset <code style={{ fontSize: 10, color: ACCENT }}>{p('materializeName')}</code>
            </div>
          )}

          {/* Schema derivato dal Materialize */}
          {materializeSchema.length > 0 && (
            <>
              <SectionTitle label="Derived schema" color="#3ddc84" />
              <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
                  {['Field', 'Type'].map((h) => (
                    <div key={h} style={{ fontSize: 9, color: '#3ddc84', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
                  ))}
                </div>
                {materializeSchema.map((f, i, arr) => (
                  <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8, padding: '4px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                    <code style={{ fontFamily: 'monospace', fontSize: 10, color: '#c8d4f0' }}>{f.name}</code>
                    <span style={{ fontSize: 9, color: '#8593b5' }}>{f.type}</span>
                  </div>
                ))}
              </div>
              <div style={{ padding: '5px 10px', fontSize: 9, color: '#8593b5', fontStyle: 'italic', display: 'flex', gap: 5 }}>
                <i className="ti ti-check" style={{ fontSize: 9, color: '#3ddc84' }} />
                Schema propagated automatically to downstream nodes.
              </div>
            </>
          )}

          {p('materializeName') && materializeSchema.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
              The Materialize "{p('materializeName')}" has not received data yet.
              Check that it is connected to a source node.
            </div>
          )}
        </>
      )}

      {/* ── Da campo flusso ── */}
      {source === 'flow_field' && (
        <>
          <SectionTitle label="Flow field" />
          <Field label="Field to explode" hint="Field of type object or array from the incoming row">
            {incomingFields.length > 0 ? (
              <CustomSelect style={inputStyle} value={p('flowField')} onChange={u('flowField')}>
                <option value="">— select field —</option>
                {(objectFields.length > 0 ? objectFields : incomingFields).map((f) => (
                  <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                ))}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={p('flowField')} onChange={u('flowField')} placeholder="content" />
            )}
          </Field>
          <Field label="Propagate parent fields" hint="Also include the original row's fields in each exploded row">
            <CustomSelect style={inputStyle} value={p('includeParent', 'false')} onChange={u('includeParent')}>
              <option value="false">No — only the exploded element's fields</option>
              <option value="true">Yes — also include the parent row's fields</option>
            </CustomSelect>
          </Field>
          <div style={{ padding: '6px 10px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a' }}>
            <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
            The exploded element's schema depends on the field's runtime content.
            Configure the output schema manually in the section below.
          </div>
        </>
      )}

      {/* ── Struttura dati ── */}
      <SectionTitle label="Data structure" />
      <Field label="Source structure type">
        <CustomSelect style={inputStyle} value={p('structureType', 'array')} onChange={u('structureType')}>
          <option value="array">Array of objects — [ &#123;...&#125;, &#123;...&#125; ]</option>
          <option value="object_values">Object values — &#123; k1: &#123;...&#125;, k2: &#123;...&#125; &#125;</option>
          <option value="object_entries">Object entries — emits &#123; key, value &#125; for each field</option>
        </CustomSelect>
      </Field>

      {/* ── Schema output manuale (solo flow_field) ── */}
      {source === 'flow_field' && (
        <>
          <SectionTitle label="Output schema" />
          <SchemaEditor
            nodeId={nodeId}
            currentSchema={(() => {
              try { return JSON.parse(node.data.props['outputSchema'] ?? '[]') } catch { return [] }
            })()}
            onSave={(fields) => updateProp(nodeId, 'outputSchema', JSON.stringify(fields))}
          />
        </>
      )}

      {/* ── Opzioni ── */}
      <SectionTitle label="Options" />
      <Field label="On empty structure">
        <CustomSelect style={inputStyle} value={p('onEmpty', 'skip')} onChange={u('onEmpty')}>
          <option value="skip">Skip — emits nothing</option>
          <option value="null_row">Emit null row — all fields null</option>
          <option value="error">Error — stops the flow</option>
        </CustomSelect>
      </Field>
      <Field label="On non-object element" hint="What to do if an array element is a primitive value">
        <CustomSelect style={inputStyle} value={p('onPrimitive', 'wrap')} onChange={u('onPrimitive')}>
          <option value="wrap">Wrap — emits &#123; value: element &#125;</option>
          <option value="skip">Skip the element</option>
          <option value="error">Error</option>
        </CustomSelect>
      </Field>
      <Field label="Output row limit" hint="0 = no limit">
        <input type="number" style={inputStyle} value={p('limit', '0')} onChange={u('limit')} min="0" />
      </Field>

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0, marginTop: 1 }} />
        Typical pattern: <code style={{ color: '#22d3ee', fontSize: 9 }}>Materialize → Explode → TMap → Sink</code>
      </div>
    </div>
  )
}

// ─── Editor schema manuale ────────────────────────────────────────
import { FIELD_TYPES } from '../../../types/fieldTypes'

function SchemaEditor({ nodeId, currentSchema, onSave }: {
  nodeId:        string
  currentSchema: SchemaField[]
  onSave:        (fields: SchemaField[]) => void
}) {
  const addField = () => {
    const n = currentSchema.length + 1
    onSave([...currentSchema, {
      id:   `explode_field_${Date.now()}`,
      name: `field_${n}`,
      type: 'string',
    }])
  }

  const updateField = (idx: number, key: keyof SchemaField, value: string) => {
    onSave(currentSchema.map((f, i) => i === idx ? { ...f, [key]: value } : f))
  }

  const deleteField = (idx: number) =>
    onSave(currentSchema.filter((_, i) => i !== idx))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {currentSchema.length === 0 ? (
        <div style={{ padding: '12px', textAlign: 'center', fontSize: 10, color: '#2a3349', fontStyle: 'italic', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
          No field defined. Manually add the fields the Explode will produce.
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 90px 24px', gap: 6, padding: '4px 8px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
            {['Field name', 'Type', ''].map((h, i) => (
              <div key={i} style={{ fontSize: 9, color: '#a78bfa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {currentSchema.map((f, idx) => (
            <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 24px', gap: 6, alignItems: 'center', padding: '4px 8px', background: idx % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: idx < currentSchema.length - 1 ? '0.5px solid #2a3349' : 'none' }}>
              <input value={f.name} onChange={(e) => updateField(idx, 'name', e.target.value)}
                style={{ ...inputStyle, fontSize: 10, padding: '2px 6px' }} placeholder="field_name" />
              <CustomSelect value={f.type} onChange={(e) => updateField(idx, 'type', e.target.value)}
                style={{ ...inputStyle, fontSize: 9, padding: '2px 3px' }}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </CustomSelect>
              <button onClick={() => deleteField(idx)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
                <i className="ti ti-x" style={{ fontSize: 10 }} />
              </button>
            </div>
          ))}
        </div>
      )}
      <button onClick={addField}
        style={{ padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`, color: ACCENT, border: `0.5px dashed ${ACCENT}60`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = ACCENT }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${ACCENT}60` }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Aggiungi campo
      </button>
    </div>
  )
}