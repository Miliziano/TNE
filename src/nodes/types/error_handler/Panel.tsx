/**
 * src/nodes/types/error_handler/Panel.tsx
 *
 * Pannello "Configurazione" del nodo Error Handler.
 * Due livelli, come da progettazione:
 *  1. Regole dichiarative semplici (policy default + tabella regole)
 *     per i casi comuni, senza disegnare nulla.
 *  2. Handle 'error_out' per pipeline di recovery visuali (Sequencer/Filter)
 *     per i casi complessi — quello che le regole non risolvono.
 *
 * Dati salvati nei props del nodo (Record<string,string>):
 *  - defaultOnError: policy ereditata dai nodi della lane (documentale per ora)
 *  - logAll: 'true'|'false' — se true, anche gli errori gestiti da catch/reject
 *            espliciti arrivano qui in copia per logging centralizzato
 *  - rules: JSON.stringify(ErrorRule[])
 */

import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import type { ErrorRule } from '../../../types'
import { normalizeErrorRuleAction } from '../../../types'
import { ERROR_HANDLER_SCHEMA } from '../../../types'

const ERR_COLOR = '#ff5f57'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}

function SectionTitle({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 8 }}>
      {label}
    </div>
  )
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}
function Row2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}
function InfoBox({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div style={{ padding: '7px 10px', background: `color-mix(in srgb, ${color} 6%, #0f1117)`, borderRadius: 4, border: `0.5px solid ${color}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}
function SchemaRow({ name, type, desc }: { name: string; type: string; desc: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 3, alignItems: 'baseline' }}>
      <code style={{ color: ERR_COLOR, fontSize: 10, minWidth: 140, flexShrink: 0 }}>{name}</code>
      <span style={{ color: '#3a4a6a', fontSize: 9, minWidth: 50, flexShrink: 0 }}>{type}</span>
      <span style={{ color: '#4a5a7a', fontSize: 9 }}>{desc}</span>
    </div>
  )
}

function parseRules(raw: string | undefined): ErrorRule[] {
  try {
    const parsed = JSON.parse(raw ?? '[]')
    if (!Array.isArray(parsed)) return []
    // Migrazione in LETTURA: le regole salvate col vocabolario vecchio
    // (retry/skip) si mostrano già tradotte, così il pannello non offre
    // un'azione che il motore non può eseguire. Il salvataggio avviene
    // alla prima modifica; finché non arriva, la validazione avvisa.
    return parsed.map((r) => ({ ...r, action: normalizeErrorRuleAction(r?.action) }))
  } catch { return [] }
}

const ruleUid = () => `rule_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

export function ErrorHandlerPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const rules = parseRules(node.data.props?.['rules'])

  const setRules = (next: ErrorRule[]) =>
    updateProp(nodeId, 'rules', JSON.stringify(next))

  const addRule = () => setRules([
    ...rules,
    { id: ruleUid(), matchType: 'always', matchValue: '', action: 'emit' },
  ])
  const updateRule = (id: string, patch: Partial<ErrorRule>) =>
    setRules(rules.map((r) => r.id === id ? { ...r, ...patch } : r))
  const removeRule = (id: string) =>
    setRules(rules.filter((r) => r.id !== id))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${ERR_COLOR} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${ERR_COLOR}30` }}>
        <i className="ti ti-shield-exclamation" style={{ fontSize: 16, color: ERR_COLOR }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: ERR_COLOR }}>Error Handler — Gestione errori</div>
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>Collettore centrale degli errori di questa lane</div>
        </div>
      </div>

      <InfoBox color={ERR_COLOR}>
        Ogni errore non gestito da un <code style={{ color: ERR_COLOR }}>catch</code>/<code style={{ color: ERR_COLOR }}>reject</code> esplicito
        confluisce automaticamente qui — nessun cavo da disegnare. Se un nodo ha
        <code style={{ color: ERR_COLOR }}> catch</code>/<code style={{ color: ERR_COLOR }}>reject</code> collegato altrove, l'errore segue
        comunque quel percorso <strong>e</strong> arriva qui in copia (se "Log centralizzato" è attivo)
        per audit/log unificato. Collega <code style={{ color: ERR_COLOR }}>error_out</code> a un Sequencer
        o Filter per costruire un percorso di recovery/notifica personalizzato.
      </InfoBox>

      {/* Policy default lane */}
      <SectionTitle label="Policy di default della lane" color={ERR_COLOR} />
      <Row2>
        <Field label="In caso di errore (default nodi)" hint="Policy ereditata dai nuovi nodi di questa lane">
          <CustomSelect style={inputStyle} value={p('defaultOnError', 'stop')}
            onChange={(e) => updateProp(nodeId, 'defaultOnError', e.target.value)}>
            <option value="stop">Stop — interrompi pipeline</option>
            <option value="skip">Skip — salta il nodo</option>
            <option value="retry">Retry — riprova N volte</option>
            <option value="propagate">Trasmetti — usa catch/reject</option>
          </CustomSelect>
        </Field>
        <Field label="Log centralizzato" hint="Copia anche gli errori gestiti da catch/reject espliciti">
          <CustomSelect style={inputStyle} value={p('logAll', 'true')}
            onChange={(e) => updateProp(nodeId, 'logAll', e.target.value)}>
            <option value="true">Sì — logga tutto qui</option>
            <option value="false">No — solo errori non gestiti</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Regole automatiche */}
      <SectionTitle label={`Regole automatiche — ${rules.length}`} color={ERR_COLOR} />
      <InfoBox color={ERR_COLOR}>
        Valutate in ordine, dall'alto verso il basso. La prima regola che corrisponde determina
        l'azione; ciò che non corrisponde a nessuna regola procede verso <code style={{ color: ERR_COLOR }}>error_out</code>.
        Una regola può alzare la gravità, non abbassarla: un nodo marcato <b>critico</b> interrompe
        comunque la lane, anche se la regola dice altro.
      </InfoBox>

      {rules.length === 0 && (
        <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Nessuna regola — tutti gli errori procedono verso <code>error_out</code>.
        </div>
      )}

      {rules.map((rule, idx) => (
        <div key={rule.id} style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace', minWidth: 18 }}>#{idx + 1}</span>
            <CustomSelect style={{ ...inputStyle, flex: '0 0 130px' }} value={rule.matchType}
              onChange={(e) => updateRule(rule.id, { matchType: e.target.value as ErrorRule['matchType'] })}>
              <option value="always">Sempre</option>
              <option value="node_type">Tipo nodo è</option>
              {/* Il motore non popola ancora `_error_code` (gli errori di nodo
                  sono stringhe): una regola su questo campo non scatterebbe
                  mai. Meglio dichiararlo indisponibile che offrirlo inerte. */}
              <option value="error_code" disabled>Codice errore contiene — non ancora disponibile</option>
            </CustomSelect>
            {rule.matchType !== 'always' && (
              <input style={{ ...inputStyle, flex: 1 }} value={rule.matchValue}
                placeholder={rule.matchType === 'node_type' ? 'es. sink_db' : 'es. timeout'}
                onChange={(e) => updateRule(rule.id, { matchValue: e.target.value })} />
            )}
            <button onClick={() => removeRule(rule.id)}
              style={{ background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '4px 6px', cursor: 'pointer', color: '#ff5f57', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
              <i className="ti ti-x" style={{ fontSize: 11 }} />
            </button>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: 9, color: '#4a5a7a', minWidth: 18 }}>→</span>
            <CustomSelect style={{ ...inputStyle, flex: '0 0 160px' }} value={rule.action}
              onChange={(e) => updateRule(rule.id, { action: e.target.value as ErrorRule['action'] })}>
              <option value="emit">Emetti — log + error_out</option>
              <option value="log_only">Solo log — non manda a valle</option>
              <option value="ignore">Ignora — né log né error_out</option>
              <option value="stop">Interrompi la lane</option>
            </CustomSelect>
            {rule.action === 'stop' && (
              <span style={{ fontSize: 9, color: ERR_COLOR }}>
                ferma i nodi ancora in esecuzione
              </span>
            )}
            {rule.action === 'ignore' && (
              <span style={{ fontSize: 9, color: '#4a5a7a' }}>
                l'errore sparisce: il nodo resta rosso nel Monitor
              </span>
            )}
          </div>
        </div>
      ))}

      <button onClick={addRule}
        style={{ background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 6, padding: '8px', fontSize: 11, color: ERR_COLOR, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
        <i className="ti ti-plus" style={{ fontSize: 13 }} />
        Aggiungi regola
      </button>

      {/* Schema output */}
      <SectionTitle label="Campi aggiunti alle righe in uscita (error_out)" color={ERR_COLOR} />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        {ERROR_HANDLER_SCHEMA.map((f) => (
          <SchemaRow key={f.id} name={f.name} type={f.type}
            desc={
              f.name === '_error_lane_id'   ? 'ID della lane in cui si è verificato l\'errore' :
              f.name === '_error_source'    ? "'unhandled' oppure 'explicit' (copia da catch/reject)" :
              f.name === '_error_message'   ? "Messaggio dell'eccezione" :
              f.name === '_error_code'      ? 'Tipo / codice errore' :
              f.name === '_error_node_id'   ? 'ID del nodo che ha generato l\'errore' :
              f.name === '_error_node_type' ? 'Tipo del nodo' :
              f.name === '_error_at'        ? "Timestamp dell'eccezione" :
              f.name === '_error_row'       ? 'La riga originale che ha causato l\'errore' :
              f.name === '_error_critical'  ? "'true' se l'errore ha interrotto la lane" : ''
            } />
        ))}
      </div>

    </div>
  )
}
