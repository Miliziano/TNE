import { useFlowStore } from '../../store/flowStore'
import { CustomSelect } from '../../components/CustomSelect'
const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e2535',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#c8d4f0',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: '6px 10px',
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

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  color: '#c8d4f0',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  padding: '8px 0 8px',
  borderBottom: '1px solid #2a3349',
  marginBottom: 4,
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '8px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
      {children}
    </div>
  )
}

function SectionTitle({ label }: { label: string }) {
  return <div style={sectionTitleStyle}>{label}</div>
}

export function TabGeneral({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateConfig   = useFlowStore((s) => s.updateNodeConfig)
  const updateAdvanced = useFlowStore((s) => s.updateNodeAdvanced)

  if (!node) return null
  const c = node.data.config

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      <SectionTitle label="Identità" />
      <Row>
        <Field label="Nome visualizzato">
          <input style={inputStyle} value={c.displayName ?? node.data.label}
            onChange={(e) => updateConfig(nodeId, { displayName: e.target.value })}
            placeholder={node.data.label} />
        </Field>
        <Field label="Etichetta breve (canvas)">
          <input style={inputStyle} value={c.shortLabel ?? ''}
            onChange={(e) => updateConfig(nodeId, { shortLabel: e.target.value })}
            placeholder="es. ordini" />
        </Field>
      </Row>
      <Field label="Descrizione">
        <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 64, fontFamily: 'inherit' }}
          value={c.description ?? ''}
          onChange={(e) => updateConfig(nodeId, { description: e.target.value })}
          placeholder="Cosa fa questo nodo?" />
      </Field>
      <Field label="Note interne">
        <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 48, fontFamily: 'inherit' }}
          value={c.notes ?? ''}
          onChange={(e) => updateConfig(nodeId, { notes: e.target.value })}
          placeholder="Note tecniche, avvertenze, TODO…" />
      </Field>
      <SectionTitle label="Comportamento" />
      <Row>
        <Field label="Abilitato">
          <CustomSelect style={inputStyle} value={c.enabled ?? 'true'}
            onChange={(e) => updateConfig(nodeId, { enabled: e.target.value as 'true' | 'false' })}>
            <option value="true">Sì</option>
            <option value="false">No — salta durante l'esecuzione</option>
          </CustomSelect>
        </Field>
        <Field label="Esegui in parallelo">
          <CustomSelect style={inputStyle} value={c.advanced?.parallel ?? 'false'}
            onChange={(e) => updateAdvanced(nodeId, 'parallel', e.target.value)}>
            <option value="false">No — sequenziale</option>
            <option value="true">Sì — parallelo</option>
          </CustomSelect>
        </Field>
      </Row>
    </div>
  )
}