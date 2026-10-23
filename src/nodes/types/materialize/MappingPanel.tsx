/**
 * src/nodes/types/materialize/MappingPanel.tsx
 */
import { useFlowStore } from '../../../store/flowStore'
import { MATERIALIZE_SIGNAL_SCHEMA, materializeMode } from './schema'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#22d3ee'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}

export function MaterializeMappingPanel({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp     = useFlowStore((s) => s.updateNodeProp)
  const incomingFields = useIncomingSchema(nodeId)

  if (!node) return null

  const matMode = materializeMode(node.data.props)
  const keyField = node.data.props['keyField'] ?? ''

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info modalità */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 16, color: ACCENT }}>◈</span>
        <div>
          <div style={{ fontWeight: 600, color: ACCENT, marginBottom: 2 }}>
            Mode: {matMode === 'passthrough' ? 'Passthrough' : 'Buffer → Signal'}
          </div>
          <div>
            {matMode === 'passthrough' && 'Stores the rows and passes them on one by one.'}
            {matMode === 'buffer_signal' && 'Stores everything, publishes the dataset, then emits one status row.'}
          </div>
        </div>
      </div>

      {/* Campo chiave */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
        <div style={{ fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600, marginBottom: 4 }}>
          Key field — dataset index
        </div>
        {incomingFields.length > 0 ? (
          <CustomSelect style={inputStyle} value={keyField}
            onChange={(e) => updateProp(nodeId, 'keyField', e.target.value)}>
            <option value="">— no key (access by index) —</option>
            {incomingFields.map((f) => (
              <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
            ))}
          </CustomSelect>
        ) : (
          <input style={inputStyle} value={keyField}
            onChange={(e) => updateProp(nodeId, 'keyField', e.target.value)}
            placeholder="id" />
        )}
        {keyField && (
          <div style={{ fontSize: 9, color: '#8593b5', fontStyle: 'italic' }}>
            Repeated keys: see "On repeated key" in the Configuration tab.
          </div>
        )}
      </div>

      {/* Schema campi in ingresso */}
      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Incoming fields (the dataset) — {incomingFields.length}
      </div>

      {incomingFields.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#8593b5', fontSize: 12, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          Connect an incoming node to see the available fields.
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px', gap: 8, padding: '5px 10px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
            {['Field', 'Type', 'Key'].map((h) => (
              <div key={h} style={{ fontSize: 9, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {incomingFields.map((f, i, arr) => (
            <div key={f.name}
              style={{ display: 'grid', gridTemplateColumns: '1fr 80px 80px', gap: 8, padding: '6px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
              <code style={{ fontFamily: 'monospace', fontSize: 11, color: f.name === keyField ? ACCENT : '#c8d4f0', fontWeight: f.name === keyField ? 600 : 400 }}>
                {f.name}
              </code>
              <span style={{ fontSize: 9, color: '#8593b5', padding: '1px 6px', borderRadius: 8, background: '#0f1117', textAlign: 'center' }}>
                {f.type}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {f.name === keyField && (
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}40` }}>
                    ◈ key
                  </span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Schema output signal */}
      {matMode === 'buffer_signal' && (
        <>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#ffb347', textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #ffb34730' }}>
            Output fields — status row
          </div>
          <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            {MATERIALIZE_SIGNAL_SCHEMA.map((f, i, arr) => (
              <div key={f.name}
                style={{ display: 'grid', gridTemplateColumns: '1fr 70px 1fr', gap: 8, padding: '6px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                <code style={{ fontFamily: 'monospace', fontSize: 11, color: '#ffb347' }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#8593b5', textAlign: 'center' }}>{f.type}</span>
                <span style={{ fontSize: 9, color: '#8593b5' }}>{f.desc}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  )
}