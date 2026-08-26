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
  const pool        = useFlowStore((s) => s.pool)
  const updatePool  = useFlowStore((s) => s.updatePool)
  const currentPath = useFlowStore((s) => s.currentPath)

  // Nome del PROGETTO (il file .ffplan aperto) — da non confondere col nome del
  // POOL, che è un'etichetta interna al progetto e si modifica lì accanto.
  // Stessa regola del `planName` dell'artifact: studio, log e monitor chiamano
  // il progetto allo stesso modo.
  const nomeProgetto = currentPath
    ? currentPath.split(/[\\/]/).pop()!.replace(/\.ffplan$/i, '')
    : null

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

      {/* separatore + nome del progetto aperto */}
      <span style={{
        width: 1, alignSelf: 'stretch', margin: '0 2px',
        background: 'var(--color-border-secondary)',
      }} aria-hidden="true" />

      <span
        title={currentPath ?? 'Progetto non ancora salvato'}
        style={{
          display: 'flex', alignItems: 'center', gap: 5,
          fontSize: 12,
          fontWeight: nomeProgetto ? 600 : 400,
          fontStyle: nomeProgetto ? 'normal' : 'italic',
          color: nomeProgetto ? 'var(--color-text-primary)' : 'var(--color-text-tertiary)',
          maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
      >
        <i className="ti ti-file-text" style={{ fontSize: 13, opacity: 0.7 }} aria-hidden="true" />
        {nomeProgetto ?? 'progetto non salvato'}
      </span>
    </div>
  )
}