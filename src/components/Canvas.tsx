import { useFlowStore } from '../store/flowStore'
import { LaneCanvas } from './LaneCanvas'
import type { Lane } from '../types'

export function Canvas() {
  const lanes   = useFlowStore((s) => s.pool.lanes)
  const addLane = useFlowStore((s) => s.addLane)

  const sortedLanes = [...lanes].sort((a, b) => a.order - b.order)

  return (
    <div style={{
      flex: 1,
      overflowY: 'auto',
      display: 'flex',
      flexDirection: 'column',
      gap: 8,
      padding: 12,
      background: 'var(--color-background-tertiary)',
    }}>
      <PoolHeader />

      {sortedLanes.map((lane: Lane) => (
        <LaneCanvas key={lane.id} lane={lane} />
      ))}

      <button
        onClick={addLane}
        style={{
          background: 'none',
          border: '1px dashed var(--color-border-secondary)',
          borderRadius: 8,
          padding: '10px',
          color: 'var(--color-text-tertiary)',
          cursor: 'pointer',
          fontSize: 12,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 6,
        }}
        onMouseEnter={(e) => {
          const el = e.currentTarget as HTMLElement
          el.style.borderColor = 'var(--color-border-primary)'
          el.style.color = 'var(--color-text-secondary)'
        }}
        onMouseLeave={(e) => {
          const el = e.currentTarget as HTMLElement
          el.style.borderColor = 'var(--color-border-secondary)'
          el.style.color = 'var(--color-text-tertiary)'
        }}
      >
        <i className="ti ti-plus" style={{ fontSize: 14 }} aria-hidden="true" />
        Aggiungi lane
      </button>
    </div>
  )
}

function PoolHeader() {
  const pool       = useFlowStore((s) => s.pool)
  const updatePool = useFlowStore((s) => s.updatePool)

  return (
    <div style={{
      background: 'var(--color-background-primary)',
      border: '0.5px solid var(--color-border-secondary)',
      borderRadius: 8,
      padding: '8px 12px',
      display: 'flex',
      alignItems: 'center',
      gap: 10,
    }}>
      <i className="ti ti-hexagon" style={{
        fontSize: 16,
        color: 'var(--color-text-info)',
      }} aria-hidden="true" />

      <input
        value={pool.label}
        onChange={(e) => updatePool({ label: e.target.value })}
        style={{
          background: 'none',
          border: 'none',
          outline: 'none',
          fontWeight: 600,
          fontSize: 13,
          color: 'var(--color-text-primary)',
          cursor: 'text',
          padding: 0,
          width: 160,
        }}
      />

      <span style={{
        fontSize: 11,
        color: 'var(--color-text-tertiary)',
        marginLeft: 4,
      }}>
        {pool.lanes.length} lane · {pool.variables.length} variabili condivise
      </span>

      <div style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
        <span style={{
          fontSize: 10,
          fontWeight: 600,
          color: 'var(--color-text-tertiary)',
          textTransform: 'uppercase',
          letterSpacing: '.07em',
        }}>
          Pool
        </span>
        {pool.variables.slice(0, 3).map((v) => (
          <span
            key={v.id}
            title={`${v.name} = ${v.value}`}
            style={{
              fontSize: 11,
              padding: '2px 8px',
              borderRadius: 12,
              background: 'var(--color-background-info)',
              color: 'var(--color-text-info)',
              fontFamily: 'var(--font-mono)',
            }}
          >
            {v.name}
          </span>
        ))}
        {pool.variables.length > 3 && (
          <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
            +{pool.variables.length - 3} altri
          </span>
        )}
      </div>
    </div>
  )
}