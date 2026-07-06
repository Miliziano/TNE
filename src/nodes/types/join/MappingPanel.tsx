/**
 * src/nodes/types/join/MappingPanel.tsx
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchemaFromHandle } from '../../useIncomingSchema'


const LEFT_COLOR   = '#4a9eff'
const LOOKUP_COLOR = '#22d3ee'
const OUT_COLOR    = '#ffb347'

export function JoinMappingPanel({ nodeId }: { nodeId: string }) {
  const node  = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const edges = useFlowStore((s) => s.edges)
  const nodes = useFlowStore((s) => s.nodes)
  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const joinType   = p('join_type', 'inner')
  const leftKey    = p('leftKey')
  const rightKey   = p('rightKey')
  const rightPrefix = p('rightPrefix', 'r_')

  // Schema sinistro — da incomingSchema o dal nodo sorgente
const leftFields = useIncomingSchemaFromHandle(nodeId, 'input_left')

  // Schema destro — da rightSchema
const rightFields = useIncomingSchemaFromHandle(nodeId, 'input_right')

  // Schema output — unione con prefisso per collisioni
  const outputFields = useMemo(() => {
    const leftNames = new Set(leftFields.map((f: any) => f.name))
    const left  = leftFields.map((f: any) => ({ name: f.name, type: f.type, side: 'left' as const }))
    const right = (joinType === 'anti' || joinType === 'semi') ? [] :
      rightFields.map((f: any) => {
        const name = leftNames.has(f.name) ? `${rightPrefix}${f.name}` : f.name
        return { name, type: f.type, side: 'right' as const }
      })
    return [...left, ...right]
  }, [leftFields, rightFields, joinType, rightPrefix])

  const hasLeft  = leftFields.length > 0
  const hasRight = rightFields.length > 0

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: '#ffb347', fontWeight: 600 }}>⋈ Join</span> — schema di output.
        I campi del flusso destro che collidono con il sinistro ricevono il prefisso <code style={{ color: LOOKUP_COLOR }}>{rightPrefix}</code>.
        {(joinType === 'anti' || joinType === 'semi') && (
          <span style={{ color: '#ff5f57' }}> — {joinType.toUpperCase()} JOIN: solo campi sinistri in output.</span>
        )}
      </div>

      {/* Chiave di join */}
      {(leftKey || rightKey) && (
        <div style={{ padding: '6px 12px', background: '#161b27', borderRadius: 6, border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 8, fontSize: 10 }}>
          <span style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em' }}>Chiave</span>
          <code style={{ color: LEFT_COLOR }}>{leftKey || '?'}</code>
          <span style={{ color: '#4a5a7a' }}>=</span>
          <code style={{ color: LOOKUP_COLOR }}>{rightKey || '?'}</code>
          <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, #ffb347 15%, #0f1117)`, color: '#ffb347', border: '0.5px solid #ffb34740', marginLeft: 'auto' }}>
            {joinType.toUpperCase()}
          </span>
        </div>
      )}

      {/* Due colonne: sinistra e destra */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>

        {/* Flusso sinistro */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 600, color: LEFT_COLOR, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: LEFT_COLOR }} />
            Sinistra — {leftFields.length} campi
          </div>
          {!hasLeft ? (
            <div style={{ padding: '10px', textAlign: 'center', color: '#2a3349', fontSize: 10, background: '#1a2030', borderRadius: 4, border: '1px dashed #2a3349' }}>
              Collega flusso principale
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {leftFields.map((f: any) => (
                <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#1a2030', borderRadius: 4, border: `0.5px solid ${f.name === leftKey ? LEFT_COLOR + '60' : '#2a3349'}` }}>
                  {f.name === leftKey && <i className="ti ti-key" style={{ fontSize: 9, color: LEFT_COLOR, flexShrink: 0 }} />}
                  <code style={{ fontFamily: 'monospace', fontSize: 10, color: LEFT_COLOR, flex: 1 }}>{f.name}</code>
                  <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Flusso destro */}
        <div>
          <div style={{ fontSize: 9, fontWeight: 600, color: LOOKUP_COLOR, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6, display: 'flex', alignItems: 'center', gap: 4 }}>
            <div style={{ width: 6, height: 6, borderRadius: '50%', background: LOOKUP_COLOR }} />
            Destra — {rightFields.length} campi
          </div>
          {!hasRight ? (
            <div style={{ padding: '10px', textAlign: 'center', color: '#2a3349', fontSize: 10, background: '#1a2030', borderRadius: 4, border: '1px dashed #2a3349' }}>
              Collega lookup
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
              {rightFields.map((f: any) => (
                <div key={f.name} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#1a2030', borderRadius: 4, border: `0.5px solid ${f.name === rightKey ? LOOKUP_COLOR + '60' : '#2a3349'}` }}>
                  {f.name === rightKey && <i className="ti ti-key" style={{ fontSize: 9, color: LOOKUP_COLOR, flexShrink: 0 }} />}
                  <code style={{ fontFamily: 'monospace', fontSize: 10, color: LOOKUP_COLOR, flex: 1 }}>{f.name}</code>
                  <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Schema output */}
      <div style={{ fontSize: 9, fontWeight: 600, color: OUT_COLOR, textTransform: 'uppercase', letterSpacing: '.06em', padding: '4px 0', borderBottom: `0.5px solid ${OUT_COLOR}30` }}>
        Campi in uscita — {outputFields.length}
      </div>

      {outputFields.length === 0 ? (
        <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 10, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Collega entrambi i flussi per vedere lo schema di output.
        </div>
      ) : (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 60px', padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
            {['Campo', 'Tipo', 'Da'].map((h) => (
              <div key={h} style={{ fontSize: 9, color: OUT_COLOR, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>
          {outputFields.map((f, i) => (
            <div key={`${f.side}_${f.name}`}
              style={{ display: 'grid', gridTemplateColumns: '1fr 70px 60px', padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < outputFields.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
              <code style={{ fontFamily: 'monospace', fontSize: 11, color: f.side === 'left' ? LEFT_COLOR : LOOKUP_COLOR }}>{f.name}</code>
              <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
              <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: f.side === 'left' ? '#0d2a4a' : '#0d3d3d', color: f.side === 'left' ? LEFT_COLOR : LOOKUP_COLOR, border: `0.5px solid ${f.side === 'left' ? LEFT_COLOR : LOOKUP_COLOR}30`, textAlign: 'center' }}>
                {f.side === 'left' ? '← L' : '→ R'}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
