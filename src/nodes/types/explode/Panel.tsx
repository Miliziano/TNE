/**
 * src/nodes/types/explode/Panel.tsx
 */
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import type { SchemaField } from '../../../utils/schemaUtils'
import type { Variable } from '../../../types'
import { CustomSelect } from '../../../components/CustomSelect'
import { materializeSchemaOf } from './schema'


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

  // Gli hook prima di ogni return (regole di React).
  const incomingFields = useIncomingSchema(nodeId)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const source  = p('explodeSource', 'materialize')
  const laneId  = node.data.laneId
  const hasInput = edges.some((e) => e.target === nodeId)

  // Variabili lane
  const laneVars: Variable[] = pool.lanes.find((l) => l.id === laneId)?.variables ?? []
  const materializeVars = laneVars.filter((v) => v.type === 'materialize')
  const objectFields    = incomingFields.filter((f) => f.type === 'object' || f.type === 'any')

  // ── Campi del dataset del Materialize selezionato (solo da mostrare:
  // lo schema d'uscita lo calcola il MappingPanel, v. ./schema.ts) ──
  const matVarSel  = source === 'materialize' ? materializeVars.find((v) => v.name === p('materializeName')) : undefined
  const matNodeSel = matVarSel ? nodes.find((n) => n.id === matVarSel.value) : null
  const materializeSchema: SchemaField[] = materializeSchemaOf(matNodeSel)

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
              <SectionTitle label="Dataset fields" color="#3ddc84" />
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
                Choose, rename and convert the emitted fields in the Mapping tab.
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
            The exploded element's fields depend on the field's runtime content.
            Declare them in the Mapping tab: without a mapping every field is emitted as it is.
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

      {/* ── Opzioni ── */}
      <SectionTitle label="Options" />
      <Field label="On empty structure">
        <CustomSelect style={inputStyle} value={p('onEmpty', 'skip')} onChange={u('onEmpty')}>
          <option value="skip">Skip — emits nothing</option>
          <option value="null_row">Emit one row — mapped fields null</option>
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
