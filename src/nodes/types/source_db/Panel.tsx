import { useState, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import {
  DB_DIALECT_LABELS,
  DB_DIALECT_COLORS,
  type DbDialect,
} from '../../../nodes/resourceDefaults'

const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e2535',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#c8d4f0',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: '5px 8px',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#9a9aaa',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  marginBottom: 4,
  fontWeight: 600,
}

function Field({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function SectionTitle({ label, color = '#4a9eff' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #2a3349', marginBottom: 4 }}>
      {label}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

// ─── Info connessione in sola lettura ─────────────────────────────
function ConnectionInfo({ resource, dialect }: {
  resource: { label: string; status: string; config?: Record<string, string> } | undefined
  dialect:  DbDialect
}) {
  const color = DB_DIALECT_COLORS[dialect] ?? '#4a9eff'

  if (!resource) {
    return (
      <div style={{ padding: '10px 12px', background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349', display: 'flex', alignItems: 'center', gap: 8 }}>
        <i className="ti ti-database-off" style={{ fontSize: 14, color: '#4a5a7a' }} />
        <span style={{ fontSize: 11, color: '#4a5a7a', fontStyle: 'italic' }}>
          Nessuna risorsa selezionata — selezionane una sopra
        </span>
      </div>
    )
  }

  const cfg = resource.config ?? {}
  const isSqlite = dialect === 'sqlite'

  const STATUS_COLORS: Record<string, string> = {
    ok:       '#3ddc84',
    error:    '#ff5f57',
    testing:  '#ffb347',
    untested: '#4a5a7a',
  }
  const statusColor = STATUS_COLORS[resource.status] ?? '#4a5a7a'
  const statusLabel = { ok: 'Connessa', error: 'Errore', testing: 'Test in corso…', untested: 'Non testata' }[resource.status] ?? resource.status

  return (
    <div style={{ padding: '10px 12px', background: `color-mix(in srgb, ${color} 5%, #161b27)`, borderRadius: 6, border: `1px solid color-mix(in srgb, ${color} 25%, transparent)`, display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* Stato connessione */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0 }} />
        <span style={{ fontSize: 12, fontWeight: 600, color, flex: 1 }}>{resource.label}</span>
        <span style={{ fontSize: 10, color: statusColor }}>{statusLabel}</span>
      </div>

      {/* Dettagli connessione — sola lettura */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, fontSize: 10, fontFamily: 'monospace' }}>
        {isSqlite ? (
          <div style={{ gridColumn: '1 / -1', color: '#9a9aaa' }}>
            <span style={{ color: '#4a5a7a' }}>file: </span>
            <span style={{ color: '#c8d4f0' }}>{cfg.database || '—'}</span>
          </div>
        ) : (
          <>
            <div style={{ color: '#9a9aaa' }}>
              <span style={{ color: '#4a5a7a' }}>host: </span>
              <span style={{ color: '#c8d4f0' }}>{cfg.host || 'localhost'}</span>
              <span style={{ color: '#4a5a7a' }}>:{cfg.port || '—'}</span>
            </div>
            <div style={{ color: '#9a9aaa' }}>
              <span style={{ color: '#4a5a7a' }}>db: </span>
              <span style={{ color: '#c8d4f0' }}>{cfg.database || '—'}</span>
            </div>
            <div style={{ color: '#9a9aaa' }}>
              <span style={{ color: '#4a5a7a' }}>utente: </span>
              <span style={{ color: '#c8d4f0' }}>{cfg.user || '—'}</span>
            </div>
            {cfg.schema && (
              <div style={{ color: '#9a9aaa' }}>
                <span style={{ color: '#4a5a7a' }}>schema: </span>
                <span style={{ color: '#c8d4f0' }}>{cfg.schema}</span>
              </div>
            )}
            {cfg.ssl && cfg.ssl !== 'false' && (
              <div style={{ color: '#3ddc84', fontSize: 9 }}>
                <i className="ti ti-lock" style={{ fontSize: 9, marginRight: 3 }} />
                SSL {cfg.ssl}
              </div>
            )}
          </>
        )}
      </div>

      {/* Hint per modificare */}
      <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', display: 'flex', alignItems: 'center', gap: 4 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 9 }} />
        Per modificare i parametri di connessione usa le proprietà della risorsa nella resource strip
      </div>
    </div>
  )
}

export function SourceDbPanel({ nodeId }: { nodeId: string }) {
  const node         = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp   = useFlowStore((s) => s.updateNodeProp)
  const updateConfig = useFlowStore((s) => s.updateNodeConfig)
  // pool è un oggetto stabile — Zustand lo aggiorna per reference solo quando cambia davvero
  const pool         = useFlowStore((s) => s.pool)

  if (!node) return null

  const laneId = node.data.laneId
  const resId  = (node.data.config?.resourceId as string | undefined) ?? ''

  // Derivazioni stabili con useMemo — si ricalcolano solo quando pool o resId cambiano
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const dbRes = useMemo(
    () => pool.lanes.find((l) => l.id === laneId)?.resources.filter((r) => r.kind === 'db') ?? [],
    [pool, laneId]
  )
  // eslint-disable-next-line react-hooks/rules-of-hooks
  const selectedResource = useMemo(
    () => resId
      ? pool.lanes.flatMap((l) => l.resources).find((r) => r.id === resId) as
          | { label: string; status: string; config?: Record<string, string> }
          | undefined
      : undefined,
    [pool, resId]
  )

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  // Dialetto letto dalla risorsa — fallback sul prop del nodo per compatibilità
  const dialect  = ((selectedResource?.config?.dialect ?? selectedResource?.config?.driver ?? p('dialect', 'postgresql'))) as DbDialect
  const isSqlite = dialect === 'sqlite'
  const color    = DB_DIALECT_COLORS[dialect] ?? '#4a9eff'

  const handleResourceChange = (newResId: string) => {
    updateConfig(nodeId, { resourceId: newResId })
    const res = dbRes.find((r) => r.id === newResId)
    const newDialect = res?.config?.dialect ?? res?.config?.driver
    if (newDialect) updateProp(nodeId, 'dialect', newDialect)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Selezione risorsa DB ─────────────────────────────── */}
      <SectionTitle label="Connessione" color={color} />

      {dbRes.length === 0 ? (
        <div style={{ padding: '12px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-database-off" style={{ fontSize: 18, display: 'block', marginBottom: 6 }} />
          Nessuna risorsa DB in questa lane. Aggiungine una dalla resource strip.
        </div>
      ) : (
        <Field label="Risorsa DB" hint="I parametri di connessione si configurano nelle proprietà della risorsa">
          <CustomSelect style={inputStyle} value={resId} onChange={(e) => handleResourceChange(e.target.value)}>
            <option value="">— seleziona —</option>
            {dbRes.map((r) => (
              <option key={r.id} value={r.id}>
                {r.label} {r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '○'}
              </option>
            ))}
          </CustomSelect>
        </Field>
      )}

      {/* ── Info connessione in sola lettura ─────────────────── */}
      <ConnectionInfo resource={selectedResource} dialect={dialect} />

      {/* ── Sorgente dati ────────────────────────────────────── */}
      <SectionTitle label="Sorgente dati" color={color} />

      <Row>
        {!isSqlite && (
          <Field label="Schema" hint="Schema della tabella (es: public)">
            <input type="text" style={inputStyle} value={p('querySchema', 'public')} onChange={u('querySchema')} placeholder="public" />
          </Field>
        )}
        <Field label="Tabella" hint="Usata se non c'è una query personalizzata nel tab Query">
          <input type="text" style={inputStyle} value={p('table')} onChange={u('table')} placeholder="nome_tabella" />
        </Field>
      </Row>

    </div>
  )
}