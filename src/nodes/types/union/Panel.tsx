/**
 * src/nodes/types/union/Panel.tsx
 */
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#a78bfa'

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
function SectionTitle({ label, color = ACCENT }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

export function UnionPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const edges      = useFlowStore((s) => s.edges)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const unionMode = p('unionMode', 'concat')

  // Edge in ingresso attualmente collegati
  const inEdges = edges.filter((e) => e.target === nodeId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>⊕ Union</span> — fonde N flussi in uno.
        Collega i flussi sorgente agli handle di ingresso numerati sul lato sinistro del nodo.
        Un nuovo handle appare automaticamente quando tutti quelli esistenti sono connessi.
      </div>

      {/* Flussi collegati */}
      <SectionTitle label={`Flussi in ingresso — ${inEdges.length} collegati`} />
      {inEdges.length === 0 ? (
        <div style={{ padding: '12px', textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Collega almeno due flussi agli handle sul lato sinistro del nodo.
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          {inEdges.map((e, i) => (
            <div key={e.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < inEdges.length - 1 ? '0.5px solid #2a3349' : 'none' }}>
              <div style={{ width: 6, height: 6, borderRadius: '50%', background: ACCENT, flexShrink: 0 }} />
              <code style={{ fontFamily: 'monospace', fontSize: 10, color: ACCENT, flex: 1 }}>
                handle: {e.targetHandle ?? 'input'}
              </code>
              <code style={{ fontFamily: 'monospace', fontSize: 9, color: '#8593b5' }}>
                da: {e.source}
              </code>
            </div>
          ))}
        </div>
      )}

      {/* Modalità union */}
      <SectionTitle label="Mode" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value: 'concat',
            label: '▤ Concatenate',
            desc:  'One flow after another — the second starts only after the first has finished. Requires the same schema.',
            detail: 'Emission order: input_1 complete → input_2 complete → ... Useful to combine files or datasets of the same type.',
          },
          {
            value: 'mix',
            label: '⇄ Interleave',
            desc:  'The flows\' rows mix in arrival order. Accepts different schemas.',
            detail: 'The order is not guaranteed — it depends on the speed of each flow. Useful to merge real-time streams.',
          },
          {
            value: 'zip',
            label: '↕ Zip',
            desc:  'Joins rows by position — row 1 of A with row 1 of B. Requires the same number of rows.',
            detail: 'Produces one row per matching pair of rows. If the flows have different lengths, the excess rows are discarded or filled with null.',
          },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'unionMode', m.value)}
            style={{ padding: '10px 12px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: unionMode === m.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030', border: unionMode === m.value ? `1.5px solid ${ACCENT}` : '1px solid #2a3349' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: unionMode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</div>
            <div style={{ fontSize: 10, color: unionMode === m.value ? ACCENT : '#4a9eff', fontWeight: 600 }}>{m.desc}</div>
            <div style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{m.detail}</div>
          </button>
        ))}
      </div>

      {/* Opzioni per modalità */}
      {unionMode === 'mix' && (
        <>
          <Field label="Source field" hint="Adds a field with the source flow name for traceability">
            <CustomSelect style={inputStyle} value={p('addSourceField', 'true')} onChange={u('addSourceField')}>
              <option value="true">Yes — add _union_source field</option>
              <option value="false">No — do not add a source field</option>
            </CustomSelect>
          </Field>
          {p('addSourceField', 'true') === 'true' && (
            <Field label="Source field name">
              <input style={{ ...inputStyle, color: ACCENT }} value={p('sourceFieldName', '_union_source')}
                onChange={u('sourceFieldName')} placeholder="_union_source" />
            </Field>
          )}
          <Field label="Missing schema on field" hint="How to handle fields present in some flows but not others">
            <CustomSelect style={inputStyle} value={p('missingField', 'null')} onChange={u('missingField')}>
              <option value="null">Write null — field present but null</option>
              <option value="omit">Omit — field absent from the record</option>
              <option value="error">Error — requires identical schema</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {unionMode === 'zip' && (
        <>
          <Field label="On flows of different length">
            <CustomSelect style={inputStyle} value={p('zipMismatch', 'truncate')} onChange={u('zipMismatch')}>
              <option value="truncate">Truncate — discard the excess rows of the longer flow</option>
              <option value="pad_null">Null padding — fills missing rows with null</option>
              <option value="error">Error — requires the same length</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {unionMode === 'concat' && (
        <Field label="On incompatible schema">
          <CustomSelect style={inputStyle} value={p('schemaMismatch', 'error')} onChange={u('schemaMismatch')}>
            <option value="error">Error — requires identical schema</option>
            <option value="coerce">Coerce — try to adapt the types</option>
            <option value="ignore">Ignore — emit the rows as they are</option>
          </CustomSelect>
        </Field>
      )}

      
      {/* Output */}
      <SectionTitle label="Node output" color="#8593b5" />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', lineHeight: 1.8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}40` }}>output</span>
          <span style={{ fontSize: 9 }}>Unified flow of all rows from the incoming flows</span>
        </div>
      </div>
    </div>
  )
}
