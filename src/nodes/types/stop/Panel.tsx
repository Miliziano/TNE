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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

const ACCENT = '#ff5f57'

const TRIGGER_HINT: Record<string, string> = {
  immediate:   'Ferma la lane appena una riga raggiunge questo nodo.',
  after_input: "Aspetta che il monte esaurisca le righe (le processa/logga tutte), poi ferma.",
}

export function StopPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  if (!node) return null

  const trigger = String(node.data.props['trigger'] ?? 'immediate')
  const message = String(node.data.props['message'] ?? '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <Field label="Innesco" hint={TRIGGER_HINT[trigger]}>
        <CustomSelect
          style={inputStyle}
          value={trigger}
          onChange={(e) => updateProp(nodeId, 'trigger', e.target.value)}
        >
          <option value="immediate">Immediato (alla 1ª riga)</option>
          <option value="after_input">Dopo l'input (a ramo esaurito)</option>
        </CustomSelect>
      </Field>

      <Field label="Messaggio (opzionale)" hint="Accompagna il motivo «stop deliberato» nei nodi interrotti e nel log.">
        <input
          type="text" style={inputStyle}
          placeholder="es. soglia di scarti superata"
          value={message}
          onChange={(e) => updateProp(nodeId, 'message', e.target.value)}
        />
      </Field>

      <div style={{ fontSize: 10, color: '#7a8aaa', lineHeight: 1.5, padding: '8px 10px', background: '#1a2030', borderRadius: 6, border: `0.5px solid ${ACCENT}30` }}>
        <div style={{ color: ACCENT, fontWeight: 600, marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.06em', fontSize: 9 }}>
          Cosa fa
        </div>
        Ferma la lane in modo pulito: <b>rollback</b> delle transazioni attive e
        chiusura delle connessioni. I nodi ancora attivi risultano
        <b> interrotti</b> (non falliti), col motivo «stop deliberato».
        <div style={{ marginTop: 6 }}>
          Se la lane ha un <b>Error Handler</b>, gli effetti collaterali disegnati
          lì (log, mail, http, sink) valgono anche per lo stop. Senza EH la lane
          si ferma comunque, solo senza quegli effetti.
        </div>
        <div style={{ marginTop: 6, color: '#c99' }}>
          ⚠️ Un eventuale salva-stato che deve <b>sopravvivere</b> allo stop va
          tenuto fuori dal gruppo transazionale: il rollback se lo porterebbe via.
        </div>
      </div>
    </div>
  )
}
