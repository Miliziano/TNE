/**
 * src/nodes/types/aggregate/MappingPanel.tsx
 *
 * Mostra lo schema in ingresso e lo schema in uscita derivato
 * dalla configurazione del nodo Aggregate.
 * Sola lettura — la configurazione avviene nel tab Configurazione.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { useMaterializeSchema } from '../../../nodes/useMaterializeSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#4a9eff'

const AGG_FUNCTIONS: Record<string, { label: string; outputType: string; color: string }> = {
  count:          { label: 'COUNT',          outputType: 'integer', color: '#4a9eff' },
  count_distinct: { label: 'COUNT DISTINCT', outputType: 'integer', color: '#4a9eff' },
  sum:            { label: 'SUM',            outputType: 'decimal', color: '#3ddc84' },
  avg:            { label: 'AVG',            outputType: 'decimal', color: '#3ddc84' },
  median:         { label: 'MEDIAN',         outputType: 'decimal', color: '#3ddc84' },
  std_dev:        { label: 'STD DEV',        outputType: 'decimal', color: '#3ddc84' },
  variance:       { label: 'VARIANCE',       outputType: 'decimal', color: '#3ddc84' },
  min:            { label: 'MIN',            outputType: 'any',     color: '#ffb347' },
  max:            { label: 'MAX',            outputType: 'any',     color: '#ffb347' },
  first:          { label: 'FIRST',          outputType: 'any',     color: '#a78bfa' },
  last:           { label: 'LAST',           outputType: 'any',     color: '#a78bfa' },
  array_agg:      { label: 'ARRAY AGG',      outputType: 'object',  color: '#f97316' },
  string_agg:     { label: 'STRING AGG',     outputType: 'string',  color: '#f97316' },
  json_agg:       { label: 'JSON AGG',       outputType: 'object',  color: '#f97316' },
}

export function AggregateMappingPanel({ nodeId }: { nodeId: string }) {
  const node  = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def

  const dataSource = p('dataSource', 'flow')
  const matName    = p('materializeName', '')

  const flowFields        = useIncomingSchema(nodeId)
  const materializeFields = useMaterializeSchema(nodeId, matName)
  const activeFields      = dataSource === 'materialize' ? materializeFields : flowFields

  const groupByFields = p('group_by').split(',').map((s: string) => s.trim()).filter(Boolean)

  // Leggi funzioni di aggregazione configurate
  const aggFunctions: Array<{ id: string; fn: string; field: string; alias: string; filter: string }> =
    useMemo(() => {
      try { return JSON.parse(p('aggFunctions', '[]')) }
      catch { return [] }
    }, [p('aggFunctions')])

  // Schema output derivato
  const outputFields = useMemo(() => [
    ...groupByFields.map((name: string) => {
      const incoming = activeFields.find((f) => f.name === name)
      return { name, type: incoming?.type ?? 'string', role: 'group' as const }
    }),
    ...aggFunctions.map((a) => {
      const meta  = AGG_FUNCTIONS[a.fn]
      const alias = a.alias || `${a.fn}_result`
      return { name: alias, type: meta?.outputType ?? 'string', role: 'agg' as const, fn: a.fn, field: a.field, filter: a.filter }
    }),
  ], [groupByFields.join(','), aggFunctions, activeFields.map((f) => f.name).join(',')])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info sorgente */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa' }}>
        <div style={{ fontWeight: 600, color: ACCENT, marginBottom: 2 }}>Σ Aggregate</div>
        Sorgente: <strong style={{ color: '#c8d4f0' }}>
          {dataSource === 'materialize' ? `Materialize "${matName || '—'}"` : 'Flusso in ingresso'}
        </strong>
        {groupByFields.length > 0 && (
          <span style={{ marginLeft: 8, color: '#4a5a7a' }}>
            GROUP BY: {groupByFields.map((f: string) => (
              <code key={f} style={{ color: '#3ddc84', marginRight: 4 }}>{f}</code>
            ))}
          </span>
        )}
      </div>

      {/* Schema in ingresso */}
      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Campi in ingresso — {activeFields.length} campi
      </div>

      {activeFields.length === 0 ? (
        <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 20, display: 'block', marginBottom: 6 }} />
          {dataSource === 'materialize'
            ? `Il Materialize "${matName || '—'}" non ha ancora ricevuto campi.`
            : 'Collega un nodo in ingresso.'}
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
            {['Campo', 'Tipo', 'Ruolo'].map((h) => (
              <div key={h} style={{ fontSize: 9, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {activeFields.map((f, i, arr) => {
            const isGroupBy = groupByFields.includes(f.name)
            return (
              <div key={f.name}
                style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                <code style={{ fontFamily: 'monospace', fontSize: 11, color: isGroupBy ? '#3ddc84' : '#c8d4f0', fontWeight: isGroupBy ? 600 : 400 }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                {isGroupBy ? (
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#0d3d20', color: '#3ddc84', border: '0.5px solid #1d6d4060', display: 'inline-block', textAlign: 'center' }}>GROUP BY</span>
                ) : (
                  <span style={{ fontSize: 9, color: '#2a3349', fontStyle: 'italic' }}>non usato</span>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Schema in uscita */}
      <div style={{ fontSize: 10, fontWeight: 600, color: '#ffb347', textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #ffb34730' }}>
        Campi in uscita — {outputFields.length} campi (1 riga per gruppo)
      </div>

      {outputFields.length === 0 ? (
        <div style={{ padding: '12px', textAlign: 'center', color: '#4a5a7a', fontSize: 10, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349', fontStyle: 'italic' }}>
          Configura GROUP BY e funzioni nel tab Configurazione.
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
            {['Campo output', 'Tipo', 'Origine'].map((h) => (
              <div key={h} style={{ fontSize: 9, color: '#ffb347', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {outputFields.map((f, i, arr) => {
            const meta  = f.role === 'agg' ? AGG_FUNCTIONS[f.fn!] : null
            const color = meta?.color ?? '#3ddc84'
            return (
              <div key={f.name}
                style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                <div>
                  <code style={{ fontFamily: 'monospace', fontSize: 11, color }}>{f.name}</code>
                  {f.role === 'agg' && f.field && (
                    <span style={{ fontSize: 9, color: '#2a3349', marginLeft: 6 }}>← {f.field}</span>
                  )}
                  {f.role === 'agg' && (f as any).filter && (
                    <div style={{ fontSize: 9, color: '#2a3349', fontStyle: 'italic' }}>WHERE {(f as any).filter}</div>
                  )}
                </div>
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                {f.role === 'group' ? (
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#0d3d20', color: '#3ddc84', border: '0.5px solid #1d6d4060', display: 'inline-block', textAlign: 'center' }}>GROUP BY</span>
                ) : (
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, ${color} 12%, #0f1117)`, color, border: `0.5px solid ${color}40`, display: 'inline-block', textAlign: 'center' }}>
                    {meta?.label ?? f.fn}
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
        Schema derivato automaticamente dalla configurazione. Modifica GROUP BY e funzioni nel tab <strong style={{ color: '#c8d4f0' }}>Configurazione</strong>.
      </div>
    </div>
  )
}
