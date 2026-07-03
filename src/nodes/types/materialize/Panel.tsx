/**
 * src/nodes/types/materialize/Panel.tsx
 */
import { useFlowStore } from '../../../store/flowStore'
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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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
// buffer_replay rimosso — i consumer accedono direttamente con
// .toDataset(), .values() o .get(key) senza bisogno di replay
const MODES = [
  {
    value:       'passthrough',
    label:       '⇒ Passthrough',
    desc:        'Trasparente — memorizza e passa riga per riga. Il flusso non si interrompe.',
    outputDesc:  'N righe in uscita (stesse in ingresso)',
    outputColor: '#3ddc84',
    detail:      'Utile per accumulare dati mentre il flusso transita — i consumer possono accedere mentre le righe arrivano.',
  },
  {
    value:       'buffer_signal',
    label:       '⊟ Buffer → Signal',
    desc:        'Blocca il flusso, memorizza tutto. Emette una sola riga di stato quando completo.',
    outputDesc:  '1 riga di stato in uscita',
    outputColor: '#ffb347',
    detail:      'Usato come trigger — il signal attiva altri nodi (Window, Aggregate, Pivot) che leggono il dataset completo tramite API diretta.',
  },
]

export function MaterializePanel({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp     = useFlowStore((s) => s.updateNodeProp)
  const pool           = useFlowStore((s) => s.pool)
  const addVariable    = useFlowStore((s) => s.addVariable)
  const deleteVariable = useFlowStore((s) => s.deleteVariable)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  // Migrazione: se matMode era buffer_replay → converti in buffer_signal
  const rawMode = p('matMode', 'passthrough')
  const mode    = rawMode === 'buffer_replay' ? 'buffer_signal' : rawMode

  const matName = p('matName', '')
  const laneId  = node.data.laneId

  const lane    = pool.lanes.find((l) => l.id === laneId)
  const laneVar = lane?.variables.find((v) => v.value === nodeId && v.type === 'materialize')
  const isPublished = !!laneVar

  const currentMode = MODES.find((m) => m.value === mode) ?? MODES[0]

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

  const incomingFields = useIncomingSchema(nodeId)

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
                Pubblicato in Lane come <code style={{ fontFamily: 'monospace' }}>{laneVar!.name}</code>
              </div>
              <div style={{ fontSize: 10, color: '#4a5a7a' }}>
                Accedi tramite <code style={{ color: ACCENT, fontSize: 9 }}>context.lane.{laneVar!.name}</code>
              </div>
            </>
          ) : (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#4a5a7a' }}>Non pubblicato nella lane</div>
              <div style={{ fontSize: 10, color: '#2a3349' }}>
                Pubblica per rendere accessibile da Window, Aggregate, Pivot, Join, Explode
              </div>
            </>
          )}
        </div>
        {isPublished ? (
          <button onClick={removeFromLane}
            style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a0a0a', color: '#ff5f57', border: '1px solid #3d1010', flexShrink: 0 }}>
            Rimuovi
          </button>
        ) : (
          <button onClick={publishToLane}
            style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}60`, flexShrink: 0, fontWeight: 600 }}>
            Pubblica in Lane
          </button>
        )}
      </div>

      {/* Nome */}
      <Field label="Nome" hint="Identificatore univoco nella lane — usato dai nodi consumer per accedere ai dati">
        <input style={inputStyle} value={matName}
          onChange={(e) => updateProp(nodeId, 'matName', e.target.value)}
          placeholder="lookup_clienti" />
      </Field>

      {/* Modalità flusso — solo due */}
      <SectionTitle label="Modalità flusso" />

      {/* Info architetturale */}
      <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 10, color: '#4a5a7a', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>◈ Materialize</span> accumula righe in memoria.
        Come i dati vengono letti è responsabilità del <strong style={{ color: '#c8d4f0' }}>nodo consumer</strong> —
        che sceglie tra <code style={{ color: ACCENT }}>dataset</code>, <code style={{ color: ACCENT }}>iterator</code> o <code style={{ color: ACCENT }}>lookup</code>.
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {MODES.map((m) => (
          <button key={m.value}
            onClick={() => updateProp(nodeId, 'matMode', m.value)}
            style={{
              padding: '10px 12px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              background: mode === m.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030',
              border: mode === m.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349',
              display: 'flex', alignItems: 'flex-start', gap: 10,
            }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, marginTop: 4, background: mode === m.value ? ACCENT : 'transparent', border: `1.5px solid ${mode === m.value ? ACCENT : '#2a3349'}` }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: mode === m.value ? ACCENT : '#c8d4f0', marginBottom: 3 }}>{m.label}</div>
              <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4, marginBottom: 4 }}>{m.desc}</div>
              <div style={{ fontSize: 9, color: '#2a3349', lineHeight: 1.4, marginBottom: 4, fontStyle: 'italic' }}>{m.detail}</div>
              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '1px 8px', borderRadius: 8, background: `color-mix(in srgb, ${m.outputColor} 10%, #0f1117)`, border: `0.5px solid ${m.outputColor}30` }}>
                <div style={{ width: 5, height: 5, borderRadius: '50%', background: m.outputColor }} />
                <span style={{ fontSize: 9, color: m.outputColor }}>{m.outputDesc}</span>
              </div>
            </div>
          </button>
        ))}
      </div>

      {/* ── Configurazione per modalità ── */}

      {/* PASSTHROUGH */}
      {mode === 'passthrough' && (
        <>
          <SectionTitle label="Opzioni" />
          <Field label="Campo chiave" hint="Se configurato, indicizza i dati per accesso O(1) tramite .get(key)">
            {incomingFields.length > 0 ? (
              <CustomSelect style={inputStyle} value={p('keyField')} onChange={u('keyField')}>
                <option value="">— nessuna chiave (accesso per indice) —</option>
                {incomingFields.map((f) => (
                  <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                ))}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={p('keyField')} onChange={u('keyField')} placeholder="id (opzionale)" />
            )}
          </Field>
          {p('keyField') && (
            <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', padding: '3px 8px' }}>
              Accesso O(1): <code style={{ color: ACCENT }}>context.lane.{matName || 'nome'}.get(row.{p('keyField')})</code>
            </div>
          )}
        </>
      )}

      {/* BUFFER → SIGNAL */}
      {mode === 'buffer_signal' && (
        <>
          <SectionTitle label="Configurazione buffer" />
          <Field label="Campo chiave" hint="Campo usato come chiave di accesso alla hashtable">
            {incomingFields.length > 0 ? (
              <CustomSelect style={inputStyle} value={p('keyField')} onChange={u('keyField')}>
                <option value="">— seleziona campo chiave —</option>
                {incomingFields.map((f) => (
                  <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                ))}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={p('keyField')} onChange={u('keyField')} placeholder="id" />
            )}
          </Field>
          <Field label="Su chiave duplicata">
            <CustomSelect style={inputStyle} value={p('onDuplicate', 'overwrite')} onChange={u('onDuplicate')}>
              <option value="overwrite">Sovrascrivi — mantieni l'ultimo</option>
              <option value="keep">Mantieni il primo</option>
              <option value="array">Accumula in array</option>
              <option value="error">Errore su duplicato</option>
            </CustomSelect>
          </Field>

          {/* Schema output signal */}
          <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #ffb34730' }}>
            <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 8 }}>
              Schema output — 1 riga di stato
            </div>
            {[
              { name: 'name',         type: 'string',  desc: 'Nome del materialize'      },
              { name: 'row_count',    type: 'integer', desc: 'Righe memorizzate'          },
              { name: 'status',       type: 'string',  desc: 'always "done"'             },
              { name: 'completed_at', type: 'date',    desc: 'Timestamp completamento'   },
              { name: 'elapsed_ms',   type: 'integer', desc: 'Tempo di esecuzione in ms' },
            ].map((f) => (
              <div key={f.name} style={{ display: 'flex', gap: 8, marginBottom: 3 }}>
                <code style={{ fontSize: 10, color: '#ffb347', minWidth: 110, flexShrink: 0 }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a', minWidth: 50 }}>{f.type}</span>
                <span style={{ fontSize: 9, color: '#2a3349' }}>{f.desc}</span>
              </div>
            ))}
          </div>

          <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', lineHeight: 1.5 }}>
            <i className="ti ti-info-circle" style={{ fontSize: 11, color: '#ffb347', marginRight: 6 }} />
            Pattern tipico: <code style={{ color: ACCENT }}>Materialize(signal) → BridgeOut → BridgeIn → Window/Aggregate/Pivot</code>.
            Il signal attiva il consumer che legge il dataset completo con <code style={{ color: ACCENT }}>.toDataset()</code>.
          </div>
        </>
      )}

      {/* API accesso — comune a tutte le modalità se pubblicato */}
      {isPublished && (
        <>
          <SectionTitle label="API di accesso — consumer" />
          <div style={{ padding: '10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* Dataset */}
            <div>
              <div style={{ fontSize: 9, color: '#3ddc84', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4, fontWeight: 600 }}>
                Dataset completo — Window, Aggregate, Pivot
              </div>
              <code style={{ fontSize: 10, color: '#3ddc84', fontFamily: 'monospace' }}>
                context.lane.{matName || 'nome'}.toDataset()
              </code>
              <div style={{ fontSize: 9, color: '#2a3349', marginTop: 2 }}>
                → List&lt;Row&gt; completa, zero buffering aggiuntivo nel consumer
              </div>
            </div>

            {/* Iterator */}
            <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 8 }}>
              <div style={{ fontSize: 9, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4, fontWeight: 600 }}>
                Iteratore riga per riga — Explode
              </div>
              <code style={{ fontSize: 10, color: ACCENT, fontFamily: 'monospace' }}>
                context.lane.{matName || 'nome'}.values()
              </code>
              <div style={{ fontSize: 9, color: '#2a3349', marginTop: 2 }}>
                → Iterable&lt;Row&gt; — elabora senza caricare tutto in memoria
              </div>
            </div>

            {/* Lookup */}
            <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 8 }}>
              <div style={{ fontSize: 9, color: '#ffb347', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4, fontWeight: 600 }}>
                Lookup per chiave — Join
              </div>
              <code style={{ fontSize: 10, color: '#ffb347', fontFamily: 'monospace' }}>
                context.lane.{matName || 'nome'}.get(row.{p('keyField') || 'chiave'})
              </code>
              <div style={{ fontSize: 9, color: '#2a3349', marginTop: 2 }}>
                → Row | null — accesso O(1) sulla hashtable
              </div>
            </div>

            {/* Utility */}
            <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 8 }}>
              <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Utility</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                {[
                  { code: `.has(row.${p('keyField') || 'chiave'})`, desc: '→ boolean' },
                  { code: `.size`,                                   desc: '→ number — righe memorizzate' },
                  { code: `.clear()`,                                desc: '→ void — svuota (se clearOn: manual)' },
                ].map((ex) => (
                  <div key={ex.code} style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                    <code style={{ fontSize: 9, color: '#9a9aaa', fontFamily: 'monospace', minWidth: 200 }}>
                      context.lane.{matName || 'nome'}{ex.code}
                    </code>
                    <span style={{ fontSize: 9, color: '#2a3349' }}>{ex.desc}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>
      )}

      {/* Ciclo di vita */}
      <SectionTitle label="Ciclo di vita" />
      <Field label="Quando svuotare">
        <CustomSelect style={inputStyle} value={p('clearOn', 'run_end')} onChange={u('clearOn')}>
          <option value="run_end">Fine esecuzione (default)</option>
          <option value="lane_end">Fine elaborazione della lane</option>
          <option value="manual">Manuale — .clear()</option>
        </CustomSelect>
      </Field>
      <Field label="Limite righe in memoria" hint="0 = nessun limite">
        <input type="number" style={inputStyle} value={p('maxRows', '0')} onChange={u('maxRows')} min="0" />
      </Field>

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0, marginTop: 1 }} />
        I dati sono <strong style={{ color: '#c8d4f0' }}>in-memory per esecuzione</strong> — non persistono tra run successivi.
      </div>
    </div>
  )
}