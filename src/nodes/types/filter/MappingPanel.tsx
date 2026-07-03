/**
 * src/nodes/types/filter/MappingPanel.tsx
 * ─────────────────────────────────────────
 * Tab Mapping del Filter — mostra le uscite (condizioni named + reject)
 * con i campi in transito e il codice generato per ogni condizione.
 * Sola lettura — il Filter non trasforma i dati, li instrada.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import type { FilterConfig } from './filterTypes'
import { conditionToCode } from './filterTypes'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#ffb347'

export function FilterMappingPanel({ nodeId }: { nodeId: string }) {
  const node   = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const fields = useIncomingSchema(nodeId)

  if (!node) return null

  const config: FilterConfig = useMemo(() => {
    try {
      const raw = node.data.config?.filter
      if (raw) return raw as FilterConfig
    } catch {}
    return { conditions: [], nullBehavior: 'exclude', caseSensitive: true }
  }, [node.data.config?.filter])

  const conditions = config.conditions

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>⊻ Filter</span> — routing passthrough.
        I campi transitano invariati su ogni uscita. L'ordine delle condizioni è la priorità di valutazione (first-match).
      </div>

      {/* Campi in transito */}
      {fields.length > 0 && (
        <div style={{ padding: '8px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>
            Campi in transito su tutte le uscite
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {fields.map((f) => (
              <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349' }}>
                <code style={{ fontSize: 10, color: ACCENT }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Uscite */}
      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Uscite — {conditions.length + 1}
      </div>

      {conditions.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-filter-off" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          Nessuna condizione configurata. Configura le condizioni nel tab Configurazione.
          <br />
          <span style={{ fontSize: 10, color: '#3a4a6a', marginTop: 4, display: 'block' }}>
            Attualmente tutte le righe vanno al reject.
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {conditions.map((cond, idx) => (
            <div key={cond.id} style={{
              padding: '8px 10px', background: '#1a2030', borderRadius: 6,
              border: `0.5px solid ${cond.color}30`,
              borderLeft: `3px solid ${cond.color}`,
            }}>
              {/* Header uscita */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                <span style={{ fontSize: 9, color: `${cond.color}60`, fontFamily: 'monospace', flexShrink: 0 }}>
                  #{idx + 1}
                </span>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: cond.color, flexShrink: 0 }} />
                <code style={{ fontSize: 11, color: cond.color, fontWeight: 600, flex: 1 }}>{cond.label}</code>
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6,
                  background: `color-mix(in srgb, ${cond.color} 10%, #0f1117)`,
                  color: cond.color, border: `0.5px solid ${cond.color}30` }}>
                  {cond.mode === 'code' ? 'λ codice' : cond.mode === 'template' ? '⚡ template' : '⊞ visuale'}
                </span>
              </div>

              {/* Codice condizione */}
              <div style={{ padding: '5px 8px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
                <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 2 }}>
                  condizione
                </div>
                <code style={{ fontSize: 9, color: '#3ddc84', fontFamily: 'monospace', wordBreak: 'break-all', lineHeight: 1.6 }}>
                  {conditionToCode(cond) || '/* nessuna condizione */' }
                </code>
              </div>

              {/* Campi passthrough */}
              <div style={{ marginTop: 6, fontSize: 9, color: '#4a5a7a' }}>
                Tutti i campi passano invariati →
                <span style={{ color: cond.color, marginLeft: 4 }}>{fields.length} campi</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Reject */}
      <div style={{ padding: '8px 12px', background: '#1a0a0a', border: '1px solid #3a1a1a', borderRadius: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff5f57' }} />
          <code style={{ fontSize: 11, color: '#ff5f57', fontWeight: 600 }}>reject</code>
          <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: '#2a0000', color: '#ff5f57', border: '0.5px solid #ff5f5730' }}>
            #{conditions.length + 1} — sempre presente
          </span>
        </div>
        <div style={{ fontSize: 9, color: '#4a5a7a' }}>
          Righe che non soddisfano nessuna delle condizioni precedenti.
          {fields.length > 0 && <span style={{ color: '#ff5f5780', marginLeft: 4 }}>Tutti i campi passano invariati.</span>}
        </div>
      </div>

      {/* Nota opzioni */}
      <div style={{ padding: '6px 10px', fontSize: 9, color: '#4a5a7a', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
        <span>
          Comportamento su null: <strong style={{ color: '#9a9aaa' }}>{config.nullBehavior}</strong>
          {' · '}
          Case sensitive: <strong style={{ color: '#9a9aaa' }}>{config.caseSensitive ? 'sì' : 'no'}</strong>
          {' · '}
          Modifica nel tab Configurazione.
        </span>
      </div>
    </div>
  )
}
