/**
 * src/nodes/types/materialize/Panel.tsx
 *
 * P366: ogni opzione è applicata dal motore (materialize.rs). Duplicati per
 * chiave, limite di righe con troncamento, riga di stato allineata. Tolti
 * "clearOn" e l'API `context.lane…` (codegen, non il motore).
 */
import { useFlowStore } from '../../../store/flowStore'
import { MATERIALIZE_SIGNAL_SCHEMA, MATERIALIZE_SIGNAL_SCHEMA_JSON, materializeMode } from './schema'
import type { Variable } from '../../../types'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
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
function SectionTitle({ label, color = '#22d3ee' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

const ACCENT = '#22d3ee'

// ─── Due modalità di flusso ───────────────────────────────────────
const MODES = [
  {
    value:       'passthrough',
    label:       '⇒ Passthrough',
    desc:        'Stores the rows and passes them on one by one. The flow does not stop.',
    outputDesc:  'N output rows (the incoming ones)',
    outputColor: '#3ddc84',
    detail:      'The dataset is complete when the input ends: the nodes that read it by name wait until then.',
  },
  {
    value:       'buffer_signal',
    label:       '⊟ Buffer → Signal',
    desc:        'Stores everything, publishes the dataset, then emits a single status row.',
    outputDesc:  '1 status row',
    outputColor: '#ffb347',
    detail:      'The status row is a trigger: the nodes after it can read the full dataset by name.',
  },
]

export function MaterializePanel({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp     = useFlowStore((s) => s.updateNodeProp)
  const pool           = useFlowStore((s) => s.pool)
  const addVariable    = useFlowStore((s) => s.addVariable)
  const deleteVariable = useFlowStore((s) => s.deleteVariable)
  const incomingFields = useIncomingSchema(nodeId)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const mode     = materializeMode(node.data.props)
  const matName  = p('matName', '')
  const keyField = p('keyField', '')
  const laneId   = node.data.laneId

  const lane    = pool.lanes.find((l) => l.id === laneId)
  const laneVar = lane?.variables.find((v) => v.value === nodeId && v.type === 'materialize')
  const isPublished = !!laneVar

  const setMode = (m: string) => {
    updateProp(nodeId, 'matMode', m)
    // Lo schema d'uscita: la riga di stato in signal, l'ingresso in passthrough.
    updateProp(nodeId, 'outputSchema', m === 'buffer_signal' ? MATERIALIZE_SIGNAL_SCHEMA_JSON : '')
  }

  const publishToLane = () => {
    const name = matName || `materialize_${nodeId.slice(-4)}`
    if (!matName) updateProp(nodeId, 'matName', name)
    addVariable('lane', laneId, {
      name, type: 'materialize', value: nodeId, scope: 'lane',
    } as Omit<Variable, 'id' | 'scope'>)
  }

  const removeFromLane = () => {
    if (laneVar) deleteVariable('lane', laneId, laneVar.id)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Stato variabile lane */}
      <div style={{
        padding: '10px 12px',
        background: isPublished ? `color-mix(in srgb, ${ACCENT} 8%, #0f1117)` : '#1a2030',
        borderRadius: 8, border: `1px solid ${isPublished ? ACCENT + '40' : '#2a3349'}`,
        display: 'flex', alignItems: 'center', gap: 10,
      }}>
        <span style={{ fontSize: 20, color: isPublished ? ACCENT : '#2a3349', flexShrink: 0 }}>◈</span>
        <div style={{ flex: 1, minWidth: 0 }}>
          {isPublished ? (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT }}>
                Published in the lane as <code style={{ fontFamily: 'monospace' }}>{laneVar!.name}</code>
              </div>
              <div style={{ fontSize: 10, color: '#8593b5' }}>
                Explode, Join, Window, Aggregate, Pivot and Data Quality can read it by name.
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#8593b5' }}>Not published in the lane</div>
              <div style={{ fontSize: 10, color: '#8593b5' }}>
                Publish it so that other nodes can read the dataset by name
              </div>
            </>
          )}
        </div>
        {isPublished ? (
          <button onClick={removeFromLane}
            style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a0a0a', color: '#ff5f57', border: '1px solid #3d1010', flexShrink: 0 }}>
            Remove
          </button>
        ) : (
          <button onClick={publishToLane}
            style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}60`, flexShrink: 0, fontWeight: 600 }}>
            Publish in lane
          </button>
        )}
      </div>

      {/* Nome */}
      <Field label="Name" hint="Unique identifier in the lane — the nodes that read the dataset select it by this name">
        <input style={inputStyle} value={matName}
          onChange={(e) => updateProp(nodeId, 'matName', e.target.value)}
          placeholder="customers_lookup" />
      </Field>

      <SectionTitle label="Flow mode" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {MODES.map((m) => (
          <button key={m.value}
            onClick={() => setMode(m.value)}
            style={{
              padding: '10px 12px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              background: mode === m.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030',
              border: mode === m.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349',
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, marginTop: 4, background: mode === m.value ? ACCENT : 'transparent', border: `1.5px solid ${mode === m.value ? ACCENT : '#2a3349'}` }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: mode === m.value ? ACCENT : '#c8d4f0', marginBottom: 3 }}>{m.label}</div>
              <div style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4, marginBottom: 4 }}>{m.desc}</div>
              <div style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4, marginBottom: 4, fontStyle: 'italic' }}>{m.detail}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 8, background: `color-mix(in srgb, ${m.outputColor} 10%, #0f1117)`, border: `0.5px solid ${m.outputColor}30` }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: m.outputColor }} />
                <span style={{ fontSize: 9, color: m.outputColor }}>{m.outputDesc}</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      <SectionTitle label="Dataset" />
      <Field label="Key field" hint="Indexes the dataset by this field: Data Quality uses it for lookups">
        {incomingFields.length > 0 ? (
          <CustomSelect style={inputStyle} value={keyField} onChange={u('keyField')}>
            <option value="">— no key —</option>
            {incomingFields.map((f) => (
              <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
            ))}
          </CustomSelect>
        ) : (
          <input style={inputStyle} value={keyField} onChange={u('keyField')} placeholder="id (optional)" />
        )}
      </Field>
      {keyField && (
        <Field label="On repeated key" hint="Applies to the stored dataset; in passthrough the rows passing downstream are not touched">
          <CustomSelect style={inputStyle} value={p('onDuplicate', 'all')} onChange={u('onDuplicate')}>
            <option value="all">Keep all rows — one key, several rows</option>
            <option value="overwrite">Overwrite — keep the last row of each key</option>
            <option value="keep">Keep the first row of each key</option>
            <option value="error">Error on a repeated key</option>
          </CustomSelect>
        </Field>
      )}
      <Row2>
        <Field label="Row limit in memory" hint="0 = no limit">
          <input type="number" style={inputStyle} value={p('maxRows', '0')} onChange={u('maxRows')} min="0" />
        </Field>
        <Field label="Beyond the limit">
          <CustomSelect style={inputStyle} value={p('onOverflow', 'error')} onChange={u('onOverflow')}>
            <option value="error">Error — stop the node</option>
            <option value="truncate">Truncate — extra rows go to reject</option>
          </CustomSelect>
        </Field>
      </Row2>

      {mode === 'buffer_signal' && (
        <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #ffb34730' }}>
          <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
            Output schema — 1 status row
          </div>
          {MATERIALIZE_SIGNAL_SCHEMA.map((f) => (
            <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
              <code style={{ fontSize: 10, color: '#ffb347', minWidth: 110, flexShrink: 0 }}>{f.name}</code>
              <span style={{ fontSize: 9, color: '#8593b5', minWidth: 50 }}>{f.type}</span>
              <span style={{ fontSize: 9, color: '#8593b5' }}>{f.desc}</span>
            </div>
          ))}
        </div>
      )}

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0, marginTop: 1 }} />
        The data is <strong style={{ color: '#c8d4f0' }}>in memory for one run of the lane</strong> (in continuous listening: for one session) — it does not persist across runs.
      </div>
    </div>
  )
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}
