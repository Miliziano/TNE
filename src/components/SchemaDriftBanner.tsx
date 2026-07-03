/**
 * src/components/SchemaDriftBanner.tsx
 *
 * Banner condiviso — avvisa quando lo schema upstream è cambiato
 * rispetto all'ultimo import/mapping salvato in un pannello.
 * Riusabile da qualsiasi pannello con un meccanismo "sourceField"
 * testuale scollegato dallo schema live (sink mapping, query panel...).
 */
import type { SchemaDriftResult } from '../utils/schemaUtils'

export function SchemaDriftBanner({
  drift, onResync, color = '#ffb347',
}: {
  drift:    SchemaDriftResult
  onResync: () => void
  color?:   string
}) {
  if (!drift.hasDrift) return null

  const parts: string[] = []
  if (drift.added.length   > 0) parts.push(`${drift.added.length} nuovo${drift.added.length > 1 ? 'i' : ''}`)
  if (drift.removed.length > 0) parts.push(`${drift.removed.length} rimosso${drift.removed.length > 1 ? 'i' : ''}`)
  if (drift.retyped.length > 0) parts.push(`${drift.retyped.length} tipo cambiato`)

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 8,
      padding: '8px 10px', background: '#2a1e10', borderRadius: 6,
      border: `1px solid ${color}60`,
    }}>
      <i className="ti ti-refresh-alert" style={{ fontSize: 14, color, flexShrink: 0, marginTop: 1 }} />
      <div style={{ flex: 1, fontSize: 10, color, lineHeight: 1.5 }}>
        <strong>Lo schema a monte è cambiato</strong> — {parts.join(', ')} rispetto all'ultimo import.
        {drift.added.length > 0 && (
          <div style={{ marginTop: 3, opacity: 0.85 }}>Nuovi: {drift.added.join(', ')}</div>
        )}
        {drift.removed.length > 0 && (
          <div style={{ marginTop: 3, opacity: 0.85 }}>Rimossi: {drift.removed.join(', ')}</div>
        )}
        {drift.retyped.length > 0 && (
          <div style={{ marginTop: 3, opacity: 0.85 }}>
            Tipo cambiato: {drift.retyped.map(r => `${r.name} (${r.from} → ${r.to})`).join(', ')}
          </div>
        )}
      </div>
      <button onClick={onResync}
        style={{ padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `${color}20`, border: `1px solid ${color}60`, color, fontWeight: 600, flexShrink: 0 }}>
        Re-importa
      </button>
    </div>
  )
}