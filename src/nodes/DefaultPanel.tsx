import { useFlowStore } from '../store/flowStore'
import { NODE_DEFS } from './registry'
import { CustomSelect } from '../components/CustomSelect'

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e2535',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#c8d4f0',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: '5px 8px',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#9a9aaa',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  marginBottom: 4,
  fontWeight: 600,
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '7px 10px',
      background: '#1a2030',
      borderRadius: 6,
      border: '0.5px solid #2a3349',
    }}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  )
}

export function DefaultPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null
  const def = NODE_DEFS[node.data.type]
  if (!def) return null

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {def.fields.map((field) => (
        <Field key={field.key} label={field.label}>
          {field.type === 'select' ? (
            <CustomSelect
              style={inputStyle}
              value={node.data.props[field.key] ?? field.default}
              onChange={(e) => updateProp(nodeId, field.key, e.target.value)}
            >
              {field.options?.map((o) => <option key={o} value={o}>{o}</option>)}
            </CustomSelect>
          ) : field.type === 'code' ? (
            <textarea
              style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'monospace' }}
              value={node.data.props[field.key] ?? field.default}
              onChange={(e) => updateProp(nodeId, field.key, e.target.value)}
              spellCheck={false}
            />
          ) : field.type === 'password' ? (
            <input
              type="password" style={inputStyle}
              value={node.data.props[field.key] ?? field.default}
              onChange={(e) => updateProp(nodeId, field.key, e.target.value)}
            />
          ) : (
            <input
              type={field.type === 'number' ? 'number' : 'text'}
              style={inputStyle}
              value={node.data.props[field.key] ?? field.default}
              onChange={(e) => updateProp(nodeId, field.key, e.target.value)}
            />
          )}
        </Field>
      ))}

      {def.fields.length === 0 && (
        <div style={{
          padding: '20px', textAlign: 'center',
          color: '#4a5a7a', fontSize: 12,
          background: '#1a2030', borderRadius: 6,
          border: '0.5px dashed #2a3349',
        }}>
          Nessun campo configurabile per questo nodo.
        </div>
      )}
    </div>
  )
}