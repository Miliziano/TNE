/**
 * src/nodes/types/log/Panel.tsx
 *
 * Nodo trasparente — logga le righe che transitano senza modificarle.
 * Utile per debug del flusso durante lo sviluppo della pipeline.
 */
import { useIncomingSchema } from '../../useIncomingSchema'
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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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

export function LogPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const inFields   = useIncomingSchema(nodeId)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const logLevel   = p('logLevel',   'info')
  const logTarget  = p('logTarget',  'panel')   // 'panel' | 'console' | 'both'
  const sampleMode = p('sampleMode', 'all')      // 'all' | 'first_n' | 'every_n' | 'random'

  const levelColor = logLevel === 'warn'  ? '#ffb347'
                   : logLevel === 'error' ? '#ff5f57'
                   : logLevel === 'debug' ? '#4a5a7a'
                   : ACCENT

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>📋 Log</span> — nodo trasparente.
        Le righe passano invariate — questo nodo le osserva e le logga senza modificarle.
        <div style={{ marginTop: 4, fontSize: 9, color: '#4a5a7a' }}>
          Rimuovilo dalla pipeline prima del deploy in produzione.
        </div>
      </div>

      {/* Livello e destinazione */}
      <SectionTitle label="Configurazione log" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Livello">
          <CustomSelect style={{ ...inputStyle, color: levelColor }} value={logLevel} onChange={u('logLevel')}>
            <option value="debug">DEBUG — dettaglio massimo</option>
            <option value="info">INFO — normale</option>
            <option value="warn">WARN — attenzione</option>
            <option value="error">ERROR — errore</option>
          </CustomSelect>
        </Field>
        <Field label="Destinazione">
          <CustomSelect style={inputStyle} value={logTarget} onChange={u('logTarget')}>
            <option value="panel">Pannello log FlowPilot</option>
            <option value="window">Finestra dedicata (Log Viewer)</option>
            <option value="console">Console browser</option>
            <option value="both">Entrambi</option>
          </CustomSelect>
        </Field>
      </div>

      {/* Prefisso */}
      <Field label="Prefisso messaggio" hint="Etichetta visibile nel log per identificare questo nodo">
        <input style={{ ...inputStyle, color: ACCENT }} value={p('logPrefix')}
          onChange={u('logPrefix')} placeholder={`[${node.data.config?.displayName || 'Log'}]`} />
      </Field>

      {/* Template messaggio */}
      <Field
        label="Template messaggio"
        hint="Usa {campo} per accedere ai valori della riga. Lascia vuoto per loggare la riga intera come JSON.">
        <textarea
          style={{ ...inputStyle, minHeight: 60, resize: 'vertical', fontFamily: 'monospace' }}
          value={p('logTemplate')}
          onChange={u('logTemplate')}
          placeholder="id={id} nome={nome} status={status}"
          spellCheck={false} />

        {/* Suggerimenti campi disponibili */}
        {inFields.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
            <span style={{ fontSize: 9, color: '#4a5a7a', alignSelf: 'center' }}>campi:</span>
            {inFields.map((f) => (
              <button key={f.name}
                onClick={() => {
                  const cur = p('logTemplate')
                  updateProp(nodeId, 'logTemplate', cur + `{${f.name}}`)
                }}
                style={{ padding: '1px 6px', fontSize: 9, borderRadius: 6, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`, color: ACCENT, border: `0.5px solid ${ACCENT}30`, fontFamily: 'monospace' }}>
                {'{' + f.name + '}'}
              </button>
            ))}
          </div>
        )}
      </Field>

      {/* Modalità sampling */}
      <SectionTitle label="Campionamento" color="#22d3ee" />
      <div style={{ fontSize: 10, color: '#4a5a7a', marginBottom: 4 }}>
        Su flussi ad alto volume, logga solo un sottoinsieme di righe per non intasare il log.
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'all',     label: 'Tutte le righe',          desc: 'Logga ogni riga — attenzione su volumi alti' },
          { value: 'first_n', label: 'Prime N righe',           desc: 'Logga solo le prime N righe del flusso' },
          { value: 'every_n', label: 'Una ogni N righe',        desc: 'Campionamento uniforme — 1 ogni N righe' },
          { value: 'random',  label: 'Campionamento casuale',   desc: 'Logga una percentuale casuale delle righe' },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'sampleMode', m.value)}
            style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', alignItems: 'center', gap: 10, background: sampleMode === m.value ? 'color-mix(in srgb, #22d3ee 8%, #1a2030)' : '#1a2030', border: sampleMode === m.value ? '1px solid #22d3ee40' : '1px solid #2a3349' }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: sampleMode === m.value ? '#22d3ee' : 'transparent', border: `1.5px solid ${sampleMode === m.value ? '#22d3ee' : '#2a3349'}` }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: sampleMode === m.value ? '#22d3ee' : '#c8d4f0' }}>{m.label}</div>
              <div style={{ fontSize: 9, color: '#4a5a7a' }}>{m.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Parametro N */}
      {sampleMode === 'first_n' && (
        <Field label="Numero di righe da loggare" hint="Dopo N righe il nodo smette di loggare">
          <input type="number" style={inputStyle} value={p('sampleN', '10')}
            onChange={u('sampleN')} min="1" />
        </Field>
      )}
      {sampleMode === 'every_n' && (
        <Field label="Logga 1 ogni N righe" hint="Es: 10 = logga la riga 1, 11, 21, 31...">
          <input type="number" style={inputStyle} value={p('sampleN', '10')}
            onChange={u('sampleN')} min="2" />
        </Field>
      )}
      {sampleMode === 'random' && (
        <Field label="Percentuale righe da loggare (1-100)" hint="Es: 10 = logga circa il 10% delle righe">
          <input type="number" style={inputStyle} value={p('samplePct', '10')}
            onChange={u('samplePct')} min="1" max="100" />
        </Field>
      )}

      {/* Opzioni avanzate */}
      <SectionTitle label="Opzioni" color="#4a5a7a" />
      <Field label="Includi numero riga nel messaggio">
        <CustomSelect style={inputStyle} value={p('showRowNum', 'true')} onChange={u('showRowNum')}>
          <option value="true">Sì — mostra il contatore righe</option>
          <option value="false">No</option>
        </CustomSelect>
      </Field>
      <Field label="Limita output a N caratteri per riga" hint="0 = nessun limite — utile per evitare log giganti">
        <input type="number" style={inputStyle} value={p('maxChars', '200')}
          onChange={u('maxChars')} min="0" />
      </Field>
      <Field label="Attivo">
        <CustomSelect style={inputStyle} value={p('logEnabled', 'true')} onChange={u('logEnabled')}>
          <option value="true">Sì — logga normalmente</option>
          <option value="false">No — nodo disabilitato (passthrough silenzioso)</option>
        </CustomSelect>
      </Field>

      {/* Output */}
      <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 10, color: '#4a5a7a', lineHeight: 1.8 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}40` }}>output</span>
          <span style={{ fontSize: 9 }}>Righe originali invariate — il Log non modifica i dati</span>
        </div>
      </div>
    </div>
  )
}
