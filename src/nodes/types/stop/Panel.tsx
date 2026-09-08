/**
 * src/nodes/types/stop/Panel.tsx
 *
 * Nodo di controllo di flusso "Stop": ferma deliberatamente la lane.
 * Disegno: src-tauri/docs/design-service-mode.md §2.
 */
import { useFlowStore } from '../../../store/flowStore'
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

const ACCENT = '#ff5f57'

const TRIGGER_HINT: Record<string, string> = {
  immediate:   'Stops the lane as soon as a row reaches this node.',
  after_input: "Waits for the upstream to exhaust its rows (processes/logs them all), then stops.",
}

export function StopPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  if (!node) return null

  const trigger = String(node.data.props['trigger'] ?? 'immediate')
  const message = String(node.data.props['message'] ?? '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Field label="Trigger" hint={TRIGGER_HINT[trigger]}>
        <CustomSelect
          style={inputStyle}
          value={trigger}
          onChange={(e) => updateProp(nodeId, 'trigger', e.target.value)}
        >
          <option value="immediate">Immediate (on the 1st row)</option>
          <option value="after_input">After input (when the branch is exhausted)</option>
        </CustomSelect>
      </Field>

      <Field label="Message (optional)" hint="Accompanies the «deliberate stop» reason in interrupted nodes and in the log.">
        <input
          type="text" style={inputStyle}
          placeholder="e.g. reject threshold exceeded"
          value={message}
          onChange={(e) => updateProp(nodeId, 'message', e.target.value)}
        />
      </Field>

      <div style={{ fontSize: 10, color: '#7a8aaa', lineHeight: 1.5, padding: '8px 10px', background: '#1a2030', borderRadius: 6, border: `0.5px solid ${ACCENT}30` }}>
        <div style={{ color: ACCENT, fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 9 }}>
          What it does
        </div>
        Stops the lane cleanly: <b>rollback</b> of active transactions and
        closing of connections. Nodes still active are marked
        <b> interrupted</b> (not failed), with the reason «deliberate stop».
        <div style={{ marginTop: 6 }}>
          If the lane has an <b>Error Handler</b>, the side effects designed
          there (log, mail, http, sink) apply to the stop as well. Without an EH the lane
          stops anyway, just without those effects.
        </div>
        <div style={{ marginTop: 6, color: '#c99' }}>
          ⚠️ Any state-save that must <b>survive</b> the stop must be
          kept outside the transactional group: the rollback would sweep it away.
        </div>
      </div>
    </div>
  )
}
