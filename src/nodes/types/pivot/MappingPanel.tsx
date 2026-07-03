/**
 * src/nodes/types/pivot/MappingPanel.tsx
 *
 * Sola lettura — mostra schema ingresso con ruoli e schema uscita.
 * La configurazione avviene nel tab Configurazione.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { useMaterializeSchema } from '../../../nodes/useMaterializeSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#f97316'

export function PivotMappingPanel({ nodeId }: { nodeId: string }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def

  const mode       = p('pivotMode',  'pivot')
  const dataSource = p('dataSource', 'flow')
  const matName    = p('materializeName', '')

  const flowFields = useIncomingSchema(nodeId)
  const matFields  = useMaterializeSchema(nodeId, matName)
  const activeFields = dataSource === 'materialize' ? matFields : flowFields

  // Ruoli campi in ingresso
  const identityFields = p('identityField').split(',').map((s: string) => s.trim()).filter(Boolean)
  const pivotField     = p('pivotField')
  const valueField     = p('valueField')
  const unpivotCols: string[] = useMemo(() => {
    try { return JSON.parse(p('unpivotColumns', '[]')) } catch { return [] }
  }, [p('unpivotColumns')])

  // Schema output
  const outputSchema = useMemo(() => {
    try { return JSON.parse(p('outputSchema', '[]')) } catch { return [] }
  }, [p('outputSchema')])

  const isDynamic = outputSchema[0]?.name === '__pivot_dynamic__'

  function getRole(fieldName: string): { label: string; color: string } {
    if (mode === 'pivot') {
      if (identityFields.includes(fieldName)) return { label: 'identità', color: '#3ddc84' }
      if (fieldName === pivotField)           return { label: 'pivot',    color: ACCENT    }
      if (fieldName === valueField)           return { label: 'valore',   color: '#ffb347' }
      return { label: 'ignorato', color: '#2a3349' }
    } else {
      if (unpivotCols.includes(fieldName)) return { label: '→ righe', color: ACCENT }
      return { label: 'fissa', color: '#3ddc84' }
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa' }}>
        <div style={{ fontWeight: 600, color: ACCENT, marginBottom: 2 }}>
          {mode === 'pivot' ? '⊞ Pivot' : '⊟ Unpivot'}
          {mode === 'pivot' && ` · ${p('pivotType', 'static') === 'dynamic' ? 'dinamico' : 'statico'}`}
        </div>
        Sorgente: <strong style={{ color: '#c8d4f0' }}>
          {dataSource === 'materialize' ? `Materialize "${matName || '—'}"` : 'Flusso in ingresso'}
        </strong>
      </div>

      {/* Campi in ingresso con ruoli */}
      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Campi in ingresso — {activeFields.length} campi
      </div>

      {activeFields.length === 0 ? (
        <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 20, display: 'block', marginBottom: 6 }} />
          {dataSource === 'materialize' ? `Il Materialize "${matName || '—'}" non ha ancora ricevuto campi.` : 'Collega un nodo in ingresso.'}
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
            {['Campo', 'Tipo', 'Ruolo'].map((h) => (
              <div key={h} style={{ fontSize: 9, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {activeFields.map((f, i, arr) => {
            const role = getRole(f.name)
            return (
              <div key={f.name}
                style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center', opacity: role.label === 'ignorato' ? 0.35 : 1 }}>
                <code style={{ fontFamily: 'monospace', fontSize: 11, color: role.color }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, ${role.color} 12%, #0f1117)`, color: role.color, border: `0.5px solid ${role.color}30`, textAlign: 'center' }}>
                  {role.label}
                </span>
              </div>
            )
          })}
        </div>
      )}

      {/* Schema output */}
      <div style={{ fontSize: 10, fontWeight: 600, color: '#22d3ee', textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #22d3ee30' }}>
        Campi in uscita
      </div>

      {isDynamic ? (
        <div style={{ padding: '8px 12px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34740', fontSize: 10, color: '#ffb347', lineHeight: 1.5 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 6 }} />
          Pivot dinamico — schema determinato a runtime. Non propagabile a design time.
        </div>
      ) : outputSchema.length === 0 ? (
        <div style={{ padding: '10px', textAlign: 'center', color: '#4a5a7a', fontSize: 10, fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
          Configura i campi nel tab Configurazione.
        </div>
      ) : (
        <>
          <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
              {['Campo', 'Tipo', 'Origine'].map((h) => (
                <div key={h} style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
              ))}
            </div>
            {outputSchema.map((f: any, i: number, arr: any[]) => {
              const isPivotCol = mode === 'pivot'   && !identityFields.includes(f.name)
              const isKeyVal   = mode === 'unpivot' && (f.id === 'upv_key' || f.id === 'upv_value')
              const color      = isPivotCol ? ACCENT : isKeyVal ? '#4a9eff' : '#9a9aaa'
              const badge      = isPivotCol ? 'pivot' : isKeyVal ? (f.id === 'upv_key' ? 'chiave' : 'valore') : 'fisso'
              const bc         = isPivotCol ? ACCENT : isKeyVal ? '#4a9eff' : '#4a5a7a'
              return (
                <div key={f.id ?? f.name}
                  style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                  <code style={{ fontFamily: 'monospace', fontSize: 11, color }}>{f.name}</code>
                  <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, ${bc} 12%, #0f1117)`, color: bc, border: `0.5px solid ${bc}30`, textAlign: 'center' }}>{badge}</span>
                </div>
              )
            })}
          </div>
          <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', display: 'flex', gap: 5 }}>
            <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
            Schema propagato automaticamente ai nodi a valle.
          </div>
        </>
      )}

      <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
        Modifica campi e modalità nel tab <strong style={{ color: '#c8d4f0' }}>Configurazione</strong>.
      </div>
    </div>
  )
}
