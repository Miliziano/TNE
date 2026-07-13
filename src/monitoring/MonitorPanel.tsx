/**
 * src/monitoring/MonitorPanel.tsx
 *
 * Pannello UI per il monitoring in tempo reale nell'interfaccia Tauri.
 * Si aggancia al MonitoringBus come UIReporter e riceve eventi via callback.
 *
 * Caratteristiche:
 * - Grafico heap in tempo reale (ultimi 60 campioni)
 * - Tabella nodi con timing e throughput, aggiornata live
 * - Lista connessioni aperte / chiuse / in errore
 * - Avvisi loitering objects con crescita
 * - Riepilogo run corrente / ultimo run
 * - Toggle enable/disable monitoring
 */

import { useState, useEffect, useRef, useCallback } from 'react'
import { monitor } from '../monitoring/MonitoringBus'
import type {
  Reporter, MonitorEvent, ExecutionSummary,
  MemorySnapshot, NodeTiming, ConnectionEvent, LoiteringObject,
} from '../monitoring/MonitoringBus'
import { useFlowStore } from '../store/flowStore'

// ─── Costanti ─────────────────────────────────────────────────────

const MAX_MEMORY_SAMPLES = 60
const ACCENT = '#a78bfa'
const GREEN  = '#3ddc84'
const RED    = '#ff5f57'
const ORANGE = '#ffb347'
const BLUE   = '#4a9eff'

// ─── Stili base ───────────────────────────────────────────────────

const card: React.CSSProperties = {
  background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349',
  overflow: 'hidden',
}

const sectionTitle = (color = ACCENT): React.CSSProperties => ({
  fontSize: 9, fontWeight: 700, color, textTransform: 'uppercase',
  letterSpacing: '.08em', padding: '5px 10px',
  background: '#161b27', borderBottom: '0.5px solid #2a3349',
})

function mb(bytes: number): string {
  return `${Math.round(bytes / 1024 / 1024 * 10) / 10} MB`
}

function ms(n: number | undefined): string {
  if (n === undefined) return '—'
  if (n < 1000) return `${Math.round(n)} ms`
  return `${(n / 1000).toFixed(2)} s`
}

// ─── Mini grafico heap (SVG) ──────────────────────────────────────

// ─── Mini grafico singola serie ──────────────────────────────────
function MiniChart({ values, color, label, unit = 'MB' }: {
  values: number[]; color: string; label: string; unit?: string
}) {
  if (values.length < 2) {
    return (
      <div style={{ height: 52, display: 'flex', alignItems: 'center',
        justifyContent: 'center', color: '#2a3349', fontSize: 9 }}>
        In attesa…
      </div>
    )
  }
  const W = 300, H = 52, PAD = 3
  const max   = Math.max(...values, 1)
  const min   = 0
  const last  = values[values.length - 1]
  const peak  = Math.max(...values)
  const trend = values.length > 5 ? values[values.length - 1] - values[values.length - 6] : 0
  const tc    = trend > 0 ? (color === GREEN ? ORANGE : RED) : color

  const toMb = (b: number) => Math.round(b / 1024 / 1024)

  const points = values.map((v, i) => {
    const x = PAD + (i / (values.length - 1)) * (W - PAD * 2)
    const y = H - PAD - ((v - min) / (max - min || 1)) * (H - PAD * 2)
    return `${x},${y}`
  }).join(' ')

  return (
    <div style={{ padding: '5px 10px 4px' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3, alignItems: 'baseline' }}>
        <span style={{ fontSize: 10, color: '#c8d4f0' }}>
          {label}: <strong style={{ color: tc }}>{toMb(last)} {unit}</strong>
        </span>
        <span style={{ fontSize: 9, color: '#4a5a7a' }}>
          peak {toMb(peak)} {unit}
          {trend !== 0 && (
            <span style={{ color: tc, marginLeft: 5 }}>
              {trend > 0 ? '↑' : '↓'}{toMb(Math.abs(trend))}
            </span>
          )}
        </span>
      </div>
      <svg width="100%" viewBox={`0 0 ${W} ${H}`} style={{ display: 'block' }}>
        <polyline points={`${PAD},${H} ${points} ${W - PAD},${H}`}
          fill={color} fillOpacity={0.08} stroke="none" />
        <polyline points={points} fill="none" stroke={color} strokeWidth={1.5} opacity={0.85} />
        <line x1={PAD} y1={H - PAD} x2={W - PAD} y2={H - PAD}
          stroke="#1e2535" strokeWidth={0.5} />
      </svg>
    </div>
  )
}

// ─── ProcessTable — dettaglio per processo ───────────────────────
function ProcessTable({ processes }: { processes: NonNullable<MemorySnapshot['processes']> }) {
  const ROLE_COLOR: Record<string, string> = {
    Main: GREEN, WebKitWeb: '#a78bfa', WebKitNetwork: BLUE, WebKitGpu: ORANGE, Other: '#4a5a7a',
  }
  const ROLE_LABEL: Record<string, string> = {
    Main: 'Tauri (Rust)', WebKitWeb: 'WebKit — Render', WebKitNetwork: 'WebKit — Network',
    WebKitGpu: 'WebKit — GPU', Other: 'Altro',
  }
  const sorted = [...processes].sort((a, b) => b.rss - a.rss)

  return (
    <div style={{ padding: '0 10px 6px' }}>
      {sorted.map(p => (
        <div key={p.pid} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '2px 0', fontSize: 9 }}>
          <span style={{ width: 6, height: 6, borderRadius: '50%', background: ROLE_COLOR[p.role] ?? '#4a5a7a', flexShrink: 0 }} />
          <span style={{ color: '#9a9aaa', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {ROLE_LABEL[p.role] ?? p.role} <span style={{ color: '#4a5a7a' }}>· pid {p.pid}</span>
          </span>
          <span style={{ color: ROLE_COLOR[p.role] ?? '#9a9aaa', fontFamily: 'monospace', textAlign: 'right' }}>
            {Math.round(p.rss / 1024 / 1024)} MB
            {p.private > 0 && (
              <span style={{ color: '#4a5a7a', marginLeft: 4 }}>
                ({Math.round(p.private / 1024 / 1024)} priv)
              </span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

// ─── HeapChart — pannelli separati + PSS quando disponibile ──────
function HeapChart({ samples }: { samples: MemorySnapshot[] }) {
  if (samples.length < 2) {
    return (
      <div style={{ padding: '10px', textAlign: 'center', color: '#2a3349', fontSize: 10 }}>
        In attesa di dati…
      </div>
    )
  }

  const hasWebkit      = samples.some(s => (s.rssWebkit ?? 0) > 0)
  const hasPss         = samples.some(s => s.pssAvailable && (s.totalPss ?? 0) > 0)
  const lastSample     = samples[samples.length - 1]

  const valuesMain     = samples.map(s => s.heapUsed)
  const valuesWebkit   = hasWebkit ? samples.map(s => s.rssWebkit ?? 0) : []
  const valuesTotalRss = samples.map(s => s.totalRss ?? s.heapUsed)
  const valuesTotalPss = hasPss ? samples.map(s => s.totalPss ?? 0) : []
  const valuesPrivate  = hasPss ? samples.map(s => s.totalPrivate ?? 0) : []
  const valuesShared   = hasPss ? samples.map(s => s.totalShared ?? 0) : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>

      {/* Private — la metrica migliore per i memory leak: solo memoria
          esclusiva dell'app, non cresce per via di librerie condivise */}
      {hasPss && (
        <div style={{ borderBottom: '0.5px solid #1e2535', background: 'color-mix(in srgb, #3ddc84 4%, transparent)' }}>
          <div style={{ fontSize: 9, color: GREEN, padding: '4px 10px 0',
            textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
            <i className="ti ti-certificate" style={{ fontSize: 10 }} />
            Memoria privata (Private) — la metrica migliore per i leak
          </div>
          <MiniChart values={valuesPrivate} color={GREEN} label="Private" />
        </div>
      )}

      {/* PSS totale */}
      {hasPss && (
        <div style={{ borderBottom: '0.5px solid #1e2535' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', padding: '4px 10px 0',
            textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
            PSS totale (proportional set size)
          </div>
          <MiniChart values={valuesTotalPss} color={BLUE} label="PSS totale" />
        </div>
      )}

      {/* Shared — pagine condivise, dovrebbe restare stabile */}
      {hasPss && (
        <div style={{ borderBottom: '0.5px solid #1e2535' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', padding: '4px 10px 0',
            textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
            Memoria condivisa (Shared) — librerie, mmap
          </div>
          <MiniChart values={valuesShared} color="#4a5a7a" label="Shared" />
        </div>
      )}

      {/* RSS totale — somma semplice, può sovrastimare per pagine condivise */}
      <div style={{ borderBottom: '0.5px solid #1e2535' }}>
        <div style={{ fontSize: 9, color: '#4a5a7a', padding: '4px 10px 0',
          textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
          RSS totale app {hasPss && <span style={{ fontStyle: 'italic' }}>(può sovrastimare — vedi PSS sopra)</span>}
        </div>
        <MiniChart values={valuesTotalRss} color={hasPss ? '#4a5a7a' : BLUE} label="RSS totale" />
      </div>

      {/* Processo principale */}
      <div style={{ borderBottom: '0.5px solid #1e2535' }}>
        <div style={{ fontSize: 9, color: '#4a5a7a', padding: '4px 10px 0',
          textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
          Processo principale (Tauri/Rust)
        </div>
        <MiniChart values={valuesMain} color={GREEN} label="RSS main" />
      </div>

      {/* WebKit — solo se misurabile (Linux) */}
      {hasWebkit && valuesWebkit.some(v => v > 0) && (
        <div style={{ borderBottom: '0.5px solid #1e2535' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', padding: '4px 10px 0',
            textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
            WebKit (renderer JS/React)
          </div>
          <MiniChart values={valuesWebkit} color="#a78bfa" label="RSS WebKit" />
        </div>
      )}

      {/* Dettaglio per processo */}
      {lastSample.processes && lastSample.processes.length > 0 && (
        <div>
          <div style={{ fontSize: 9, color: '#4a5a7a', padding: '6px 10px 3px',
            textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>
            Dettaglio processi ({lastSample.processes.length})
          </div>
          <ProcessTable processes={lastSample.processes} />
        </div>
      )}
    </div>
  )
}

// ─── Tabella nodi ─────────────────────────────────────────────────

function NodeTable({ timings }: { timings: NodeTiming[] }) {
  if (timings.length === 0) {
    return <div style={{ padding: '10px', fontSize: 10, color: '#4a5a7a', textAlign: 'center' }}>Nessun nodo eseguito</div>
  }

  const sorted = [...timings].sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))

  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
        <thead>
          <tr style={{ background: '#161b27' }}>
            {['Nodo', 'Tipo', 'Durata', 'Righe in', 'Righe out', 'Scartate', 'Stato'].map(h => (
              <th key={h} style={{ padding: '4px 8px', textAlign: 'left', color: '#4a5a7a', fontWeight: 600, fontSize: 9, textTransform: 'uppercase', letterSpacing: '.05em', borderBottom: '0.5px solid #2a3349', whiteSpace: 'nowrap' }}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((t, i) => {
            const isRunning = !t.endAt
            const hasError  = !!t.error
            const color     = hasError ? RED : isRunning ? ORANGE : '#c8d4f0'
            return (
              <tr key={t.nodeId} style={{ borderBottom: '0.5px solid #1e2535', background: i % 2 === 0 ? '#1a2030' : 'transparent' }}>
                <td style={{ padding: '4px 8px', color, fontFamily: 'monospace', fontSize: 10 }} title={t.error}>
                  {t.nodeLabel}
                </td>
                <td style={{ padding: '4px 8px', color: '#7a86a4', fontSize: 10 }}>{t.nodeType}</td>
                <td style={{ padding: '4px 8px', color: t.durationMs && t.durationMs > 5000 ? ORANGE : '#9a9aaa', fontFamily: 'monospace' }}>
                  {isRunning ? <span style={{ color: ORANGE }}>⏳ running</span> : ms(t.durationMs)}
                </td>
                <td style={{ padding: '4px 8px', color: '#9a9aaa', fontFamily: 'monospace' }}>{t.rowsIn.toLocaleString()}</td>
                <td style={{ padding: '4px 8px', color: GREEN, fontFamily: 'monospace' }}>{t.rowsOut.toLocaleString()}</td>
                <td style={{ padding: '4px 8px', color: t.rowsRejected > 0 ? ORANGE : '#4a5a7a', fontFamily: 'monospace' }}>
                  {t.rowsRejected > 0 ? t.rowsRejected.toLocaleString() : '—'}
                </td>
                <td style={{ padding: '4px 8px' }}>
                  {hasError
                    ? <span style={{ color: RED, fontSize: 9 }}>✗ errore</span>
                    : isRunning
                    ? <span style={{ color: ORANGE, fontSize: 9 }}>● running</span>
                    : <span style={{ color: GREEN, fontSize: 9 }}>✓ ok</span>
                  }
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}



// ─── Lista connessioni (raggruppata per contesto di connessione) ────
//
// ONESTÀ DEI DATI (requisito esplicito):
// - I numeri mostrati sono OSSERVATI dagli eventi: quali nodi hanno usato
//   una risorsa, per quanto, con che esito. Mai dedotti.
// - Il RAGGRUPPAMENTO riflette la CONFIGURAZIONE dichiarata (il nodo ha o
//   non ha un transactionId): è un fatto verificabile, non un'ipotesi
//   sulle connessioni fisiche, che il monitor NON osserva.
// - Non affermiamo mai "N connessioni fisiche": mostriamo "N nodi", che è
//   ciò che gli eventi dicono davvero.
// - Un nodo senza evento di chiusura a run terminato è "stato ignoto",
//   non "aperta": a run finito la lane ha chiuso tutto (close_all), quindi
//   dire "aperta" sarebbe falso.

function ConnectionList({ connections, runEnded }: { connections: ConnectionEvent[]; runEnded: boolean }) {
  const pool  = useFlowStore((s) => s.pool)
  const nodes = useFlowStore((s) => s.nodes)

  type Conn = { node: string; nodeId?: string; status: 'open' | 'closed' | 'error'; durationMs?: number }

  // 1. Raccoglie gli usi OSSERVATI, per risorsa.
  const byResource = new Map<string, { resource: string; type: string; conns: Map<string, Conn> }>()
  for (const c of connections) {
    const key = `${c.resource}::${c.type}`
    if (!byResource.has(key)) byResource.set(key, { resource: c.resource, type: c.type, conns: new Map() })
    const grp = byResource.get(key)!
    const cur: Conn = grp.conns.get(c.id) ?? { node: c.detail ?? c.id, nodeId: c.nodeId, status: 'open' }
    if (c.detail) cur.node = c.detail
    if (c.nodeId) cur.nodeId = c.nodeId
    if (c.action === 'close') { cur.status = 'closed'; cur.durationMs = c.durationMs }
    if (c.action === 'error') { cur.status = 'error';  cur.durationMs = c.durationMs }
    grp.conns.set(c.id, cur)
  }

  if (byResource.size === 0) {
    return <div style={{ padding: '10px', fontSize: 10, color: '#4a5a7a', textAlign: 'center' }}>Nessuna connessione</div>
  }

  // 2. Per ogni nodo, il contesto di connessione DICHIARATO (config, non dedotto).
  const txOfNode = (nodeId?: string): { id: string; name: string; mode: string } | null => {
    if (!nodeId) return null
    const n = nodes.find((x) => x.id === nodeId)
    const txId = n?.data.props?.['transactionId']
    if (!txId) return null
    const lane = pool.lanes.find((l) => l.id === n?.data.laneId)
    const tx = (lane?.transactions ?? []).find((t) => t.id === txId)
    return tx ? { id: tx.id, name: tx.name, mode: tx.mode } : null
  }

  const statusColor = (s: Conn['status']) =>
    s === 'error' ? RED : s === 'open' ? (runEnded ? '#6b7280' : ORANGE) : GREEN
  const statusLabel = (s: Conn['status']) =>
    s === 'error' ? '✗ errore'
    : s === 'open' ? (runEnded ? '? stato ignoto' : '● in uso')
    : '✓ chiusa'

  const fmt = (ms?: number) => ms === undefined ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`

  return (
    <div style={{ display: 'flex', flexDirection: 'column' }}>
      {[...byResource.values()].map(({ resource, type, conns }) => {
        const list = [...conns.values()]

        // Raggruppa per contesto dichiarato: transazione X, oppure autocommit.
        const groups = new Map<string, { label: string; mode?: string; items: Conn[] }>()
        for (const c of list) {
          const tx = txOfNode(c.nodeId)
          const key = tx ? `tx:${tx.id}` : 'autocommit'
          if (!groups.has(key)) {
            groups.set(key, tx
              ? { label: tx.name, mode: tx.mode, items: [] }
              : { label: 'Autocommit', items: [] })
          }
          groups.get(key)!.items.push(c)
        }

        return (
          <div key={`${resource}::${type}`} style={{ borderBottom: '1px solid #1e2535' }}>
            {/* Intestazione risorsa — conteggio OSSERVATO: nodi, non connessioni */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '7px 10px', background: '#161b27' }}>
              <i className="ti ti-plug-connected" style={{ fontSize: 12, color: ORANGE }} />
              <span style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0' }}>{resource}</span>
              <span style={{ fontSize: 9, color: '#4a5a7a' }}>{type}</span>
              <span style={{ fontSize: 9, marginLeft: 'auto', color: '#4a5a7a' }}>
                {list.length} {list.length === 1 ? 'nodo' : 'nodi'}
              </span>
            </div>

            {[...groups.entries()].map(([key, grp]) => {
              const isTx    = key.startsWith('tx:')
              const txColor = grp.mode === 'xa' ? '#f59e0b' : '#34d399'
              return (
                <div key={key}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 10px 4px 22px',
                                background: '#12161f' }}>
                    <i className={isTx ? 'ti ti-arrows-exchange' : 'ti ti-circle-dot'}
                       style={{ fontSize: 10, color: isTx ? txColor : '#4a5a7a' }} />
                    <span style={{ fontSize: 10, fontWeight: 600, color: isTx ? txColor : '#9a9aaa' }}>
                      {grp.label}
                    </span>
                    {isTx && (
                      <span style={{ fontSize: 8, fontWeight: 700, padding: '1px 5px', borderRadius: 3,
                                     background: `${txColor}20`, color: txColor, border: `0.5px solid ${txColor}50` }}>
                        {grp.mode?.toUpperCase()}
                      </span>
                    )}
                    <span style={{ fontSize: 9, marginLeft: 'auto', color: '#4a5a7a' }}>
                      {grp.items.length} {grp.items.length === 1 ? 'nodo' : 'nodi'}
                    </span>
                  </div>

                  {grp.items.map((c, i) => (
                    <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8,
                                          padding: '4px 10px 4px 38px', fontSize: 10 }}>
                      <span style={{ width: 5, height: 5, borderRadius: '50%', background: statusColor(c.status) }} />
                      <span style={{ color: '#c8d4f0' }}>{c.node}</span>
                      <span style={{ marginLeft: 'auto', color: statusColor(c.status) }}>{statusLabel(c.status)}</span>
                      <span style={{ color: '#4a5a7a', minWidth: 52, textAlign: 'right' }}>{fmt(c.durationMs)}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}

// ─── Lista loitering ──────────────────────────────────────────────

function LoiteringList({ objects }: { objects: LoiteringObject[] }) {
  if (objects.length === 0) {
    return <div style={{ padding: '10px', fontSize: 10, color: GREEN, textAlign: 'center' }}>✓ Nessun loitering object rilevato</div>
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      {objects.map(obj => {
        const growth   = obj.sizeCurrent - obj.sizeAtStart
        const severity = growth > 1000 ? RED : growth > 100 ? ORANGE : ORANGE
        return (
          <div key={obj.id} style={{ padding: '6px 10px', borderBottom: '0.5px solid #1e2535', display: 'flex', gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: 2, background: severity, flexShrink: 0, marginTop: 3 }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 10, color: severity }}>{obj.label}</div>
              <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 2 }}>
                {obj.type} · {obj.sizeAtStart} → {obj.sizeCurrent} entries
                (+{growth} · {obj.growthRate > 0 ? `${obj.growthRate}/s` : 'stabile'})
              </div>
            </div>
          </div>
        )
      })}
    </div>
  )
}

// ─── Componente principale ────────────────────────────────────────

interface MonitorPanelProps {
  /** Posizione del pannello — default: 'bottom' */
  position?: 'bottom' | 'right' | 'float'
  /** Larghezza in px per position='right' — default: 420 */
  width?: number
  /** Altezza in px per position='bottom' — default: 320 */
  height?: number
}

// ─── Tab Run/Overview ─────────────────────────────────────────────
// Vista aggregata del run: totali, colli di bottiglia, scarti per nodo.
// Legge i dati live durante il run (nodeTimings) e il summary a fine run.
function RunOverview({ timings, summary, isRunning }: {
  timings: NodeTiming[]; summary: ExecutionSummary | null; isRunning: boolean
}) {
  if (timings.length === 0 && !summary) {
    return <div style={{ padding: 16, color: '#4a5a7a', fontSize: 11 }}>
      Nessun run ancora — lancia un flusso.
    </div>
  }

  const useLive  = isRunning || !summary
  const totalIn  = useLive ? timings.reduce((s, t) => s + t.rowsIn, 0)       : summary!.totalRowsIn
  const totalOut = useLive ? timings.reduce((s, t) => s + t.rowsOut, 0)      : summary!.totalRowsOut
  const totalRej = useLive ? timings.reduce((s, t) => s + t.rowsRejected, 0) : summary!.totalRejected
  const duration = !isRunning && summary ? summary.totalDurationMs : undefined

  const slowest   = [...timings].filter(t => t.durationMs != null)
    .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0)).slice(0, 3)
  const rejecting = timings.filter(t => t.rowsRejected > 0)
    .sort((a, b) => b.rowsRejected - a.rowsRejected)

  const stat = (label: string, value: string, color = '#c8d4f0') => (
    <div>
      <div style={{ fontSize: 9, color: '#4a5a7a' }}>{label}</div>
      <div style={{ fontSize: 15, color, fontFamily: 'monospace', fontWeight: 600 }}>{value}</div>
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
      <div style={card}>
        <div style={sectionTitle()}>{isRunning ? '● Run in corso' : 'Ultimo run'}</div>
        <div style={{ padding: '10px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12 }}>
          {stat('Stato', isRunning ? 'in corso' : 'completato', isRunning ? ORANGE : GREEN)}
          {stat('Durata', duration != null ? ms(duration) : '—')}
          {stat('Nodi', String(timings.length))}
          {stat('Righe in', totalIn.toLocaleString())}
          {stat('Righe out', totalOut.toLocaleString())}
          {stat('Scartate', totalRej.toLocaleString(), totalRej > 0 ? RED : '#c8d4f0')}
        </div>
      </div>

      {slowest.length > 0 && (
        <div style={card}>
          <div style={sectionTitle(BLUE)}>Colli di bottiglia</div>
          <div style={{ padding: '4px 10px 8px' }}>
            {slowest.map(t => (
              <div key={t.nodeId} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11 }}>
                <span style={{ color: '#c8d4f0' }}>{t.nodeLabel}</span>
                <span style={{ color: '#8a96b4', fontFamily: 'monospace' }}>{ms(t.durationMs ?? 0)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {rejecting.length > 0 && (
        <div style={card}>
          <div style={sectionTitle(RED)}>Scarti per nodo</div>
          <div style={{ padding: '4px 10px 8px' }}>
            {rejecting.map(t => (
              <div key={t.nodeId} style={{ display: 'flex', justifyContent: 'space-between', padding: '3px 0', fontSize: 11 }}>
                <span style={{ color: '#c8d4f0' }}>{t.nodeLabel}</span>
                <span style={{ color: RED, fontFamily: 'monospace' }}>
                  {t.rowsRejected.toLocaleString()} / {t.rowsIn.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── Tab Timeline/Profilo ─────────────────────────────────────────
// Gantt dei nodi con la curva di memoria sovrapposta sullo stesso asse
// temporale: mostra QUALE nodo era attivo quando la memoria è salita.
// È la "memoria per nodo" onesta (correlazione, non attribuzione RSS).
function TimelineProfile({ timings, samples }: {
  timings: NodeTiming[]; samples: MemorySnapshot[]
}) {
  const done = timings.filter(t => t.endAt != null)
  if (done.length === 0) {
    return <div style={{ padding: 16, color: '#4a5a7a', fontSize: 11 }}>
      Timeline disponibile a run completato.
    </div>
  }

  const memTs = samples.map(s => s.timestamp)
  const t0 = Math.min(...done.map(t => t.startAt),        ...(memTs.length ? memTs : [Infinity]))
  const t1 = Math.max(...done.map(t => t.endAt ?? t.startAt), ...(memTs.length ? memTs : [-Infinity]))
  const span = Math.max(1, t1 - t0)

  const W = 320, rowH = 17, padL = 88, padR = 8, chartH = 46
  const x = (t: number) => padL + ((t - t0) / span) * (W - padL - padR)

  const mem = samples.map(s => ({ t: s.timestamp, v: (s.totalRss ?? s.heapUsed) / 1024 / 1024 }))
  const memMax = Math.max(1, ...mem.map(m => m.v))
  const memPath = mem
    .map((m, i) => `${i === 0 ? 'M' : 'L'} ${x(m.t).toFixed(1)} ${(chartH - (m.v / memMax) * chartH + 2).toFixed(1)}`)
    .join(' ')

  const rows = [...done].sort((a, b) => a.startAt - b.startAt)
  const H = chartH + 8 + rows.length * rowH + 6

  return (
    <div style={card}>
      <div style={sectionTitle(BLUE)}>Timeline — nodi × memoria</div>
      <div style={{ padding: 8, overflowX: 'auto' }}>
        <svg width={W} height={H} style={{ display: 'block' }}>
          {mem.length > 0 && <path d={memPath} fill="none" stroke={ACCENT} strokeWidth={1.2} opacity={0.85} />}
          <text x={padL} y={9} fontSize={9} fill="#4a5a7a">memoria — picco {Math.round(memMax)}MB</text>
          {rows.map((t, i) => {
            const y  = chartH + 8 + i * rowH
            const bx = x(t.startAt)
            const bw = Math.max(2, x(t.endAt ?? t.startAt) - bx)
            const col = t.error ? RED : t.rowsRejected > 0 ? ORANGE : GREEN
            return (
              <g key={t.nodeId}>
                <text x={0} y={y + rowH - 5} fontSize={10} fill="#8a96b4">{t.nodeLabel.slice(0, 13)}</text>
                <rect x={bx} y={y + 1} width={bw} height={rowH - 5} rx={2} fill={col} opacity={0.8}>
                  <title>{t.nodeLabel}: {ms(t.durationMs ?? 0)}</title>
                </rect>
              </g>
            )
          })}
        </svg>
      </div>
    </div>
  )
}

export function MonitorPanel({ position = 'bottom', width = 420, height = 320 }: MonitorPanelProps) {
  const [enabled,     setEnabled]     = useState(monitor.enabled)
  const [activeTab,   setActiveTab]   = useState<'run' | 'memory' | 'nodes' | 'timeline' | 'connections' | 'loitering'>('run')
  const [memorySamples, setMemorySamples] = useState<MemorySnapshot[]>([])
  const [nodeTimings, setNodeTimings] = useState<NodeTiming[]>([])
  const [connections, setConnections] = useState<ConnectionEvent[]>([])
  const [loitering,   setLoitering]   = useState<LoiteringObject[]>([])
  const [lastSummary, setLastSummary] = useState<ExecutionSummary | null>(null)
  const [isRunning,   setIsRunning]   = useState(false)
  const reporterRef = useRef<Reporter | null>(null)

  useEffect(() => {
    // Fetch immediato memoria — prova Tauri invoke, fallback a performance.memory
    import('@tauri-apps/api/core').then(({ invoke }) => {
      return invoke('get_memory_info') as Promise<any>
    }).then(m => {
      const snap = {
        heapUsed:     m.main_rss,
        heapTotal:    m.total_ram,
        rss:          m.main_rss,
        rssWebkit:    m.webkit_rss,
        totalRss:     m.total_rss,
        totalPss:     m.total_pss,
        totalPrivate: m.total_private,
        totalShared:  m.total_shared,
        pssAvailable: m.pss_available,
        processes:    (m.processes ?? []).map((p: any) => ({
          pid: p.pid, name: p.name, role: p.role, rss: p.rss, pss: p.pss,
          private: p.private, shared: p.shared,
        })),
        totalRam:     m.total_ram,
        usedRam:      m.used_ram,
        timestamp:    m.timestamp,
      }
      setMemorySamples([snap])
    }).catch(() => {
      // Browser o Tauri senza comando: prova performance.memory
      const pm = (performance as any).memory
      if (pm?.usedJSHeapSize > 0) {
        setMemorySamples([{
          heapUsed:  pm.usedJSHeapSize,
          heapTotal: pm.totalJSHeapSize,
          timestamp: Date.now(),
        }])
      }
    })

    // Avvia il polling memoria — anche senza run attivo
    if (monitor.enabled) {
      monitor.startIdlePolling()
    } else {
      monitor.enable(2000)
      monitor.startIdlePolling()
    }

    // UIReporter inline — aggiorna lo stato React ad ogni evento
    const reporter: Reporter = {
      onEvent(event: MonitorEvent) {
        switch (event.type) {
          case 'memory': {
            const snap = event.payload as MemorySnapshot
            // Scarta campioni vuoti (heapUsed=0 e rss assente/0)
            if (snap.heapUsed === 0 && (!snap.rss || snap.rss === 0)) break
            setMemorySamples(prev => {
              const next = [...prev, snap]
              return next.slice(-MAX_MEMORY_SAMPLES)
            })
            break
          }
          case 'node_start':
            setIsRunning(true)
            setNodeTimings(prev => {
              const t = event.payload as NodeTiming
              return [...prev.filter(n => n.nodeId !== t.nodeId), t]
            })
            break
          case 'node_end':
            setNodeTimings(prev => {
              const t = event.payload as NodeTiming
              return prev.map(n => n.nodeId === t.nodeId ? t : n)
            })
            break
          case 'connection':
            setConnections(prev => [...prev, event.payload as ConnectionEvent])
            break
          case 'loitering':
            setLoitering(prev => {
              const l = event.payload as LoiteringObject
              return [...prev.filter(o => o.id !== l.id), l]
            })
            break
          case 'run_start':
            setNodeTimings([])
            setConnections([])
            setLoitering([])
            setIsRunning(true)
            break
          case 'run_end':
            setIsRunning(false)
            break
        }
      },
      onRunEnd(summary: ExecutionSummary) {
        setLastSummary(summary)
        setLoitering(summary.loitering)
        setIsRunning(false)
      },
    }
    reporterRef.current = reporter
    monitor.addReporter(reporter)
    return () => {
      if (reporterRef.current) monitor.removeReporter(reporterRef.current)
      monitor.stopIdlePolling()
    }
  }, [])

  const toggleMonitor = useCallback(() => {
    if (enabled) {
      monitor.disable()
      setEnabled(false)
    } else {
      monitor.enable(2000)
      setEnabled(true)
    }
  }, [enabled])

  const TABS = [
    { id: 'run' as const,         label: 'Run',          badge: null },
    { id: 'memory' as const,      label: 'Memoria',      badge: null },
    { id: 'nodes' as const,       label: 'Nodi',         badge: nodeTimings.length || null },
    { id: 'timeline' as const,    label: 'Timeline',     badge: null },
    { id: 'connections' as const, label: 'Connessioni',  badge: connections.filter(c => c.action === 'open').length || null },
    { id: 'loitering' as const,   label: 'Loitering',    badge: loitering.length || null },
  ]

  const panelStyle: React.CSSProperties = position === 'right'
    ? { width, height: '100%', border: '0.5px solid #2a3349', borderRadius: 8 }
    : position === 'float'
    ? { width: 480, position: 'fixed', bottom: 16, right: 16, boxShadow: '0 8px 32px rgba(0,0,0,.7)', borderRadius: 8 }
    : { width: '100%', height, borderTop: '1px solid #2a3349' }

  return (
    <div style={{ ...panelStyle, background: '#0f1117', display: 'flex', flexDirection: 'column', fontSize: 11, overflow: 'hidden', zIndex: position === 'float' ? 9000 : undefined }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: '#161b27', borderBottom: '0.5px solid #2a3349', flexShrink: 0 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: enabled ? (isRunning ? ORANGE : GREEN) : '#2a3349', flexShrink: 0, boxShadow: enabled && isRunning ? `0 0 6px ${ORANGE}` : undefined }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0', flex: 1 }}>
          FlowPilot Monitor
          {isRunning && <span style={{ fontSize: 9, color: ORANGE, marginLeft: 8 }}>● running</span>}
        </span>

        {lastSummary && !isRunning && (
          <span style={{ fontSize: 9, color: '#4a5a7a' }}>
            Ultimo run: {ms(lastSummary.totalDurationMs)} · {Math.round(lastSummary.peakHeapMb)}MB peak
          </span>
        )}

        <button onClick={toggleMonitor}
          style={{ padding: '2px 10px', fontSize: 9, borderRadius: 4, cursor: 'pointer', fontWeight: 600, border: `1px solid ${enabled ? RED + '60' : GREEN + '60'}`, background: enabled ? `${RED}15` : `${GREEN}15`, color: enabled ? RED : GREEN }}>
          {enabled ? 'Disabilita' : 'Abilita'}
        </button>
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: 'flex', borderBottom: '0.5px solid #2a3349', flexShrink: 0, background: '#161b27' }}>
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            style={{ padding: '5px 12px', fontSize: 10, background: 'none', border: 'none', borderBottom: activeTab === tab.id ? `2px solid ${ACCENT}` : '2px solid transparent', color: activeTab === tab.id ? ACCENT : '#4a5a7a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            {tab.label}
            {tab.badge !== null && tab.badge > 0 && (
              <span style={{ fontSize: 8, padding: '1px 4px', borderRadius: 8, background: tab.id === 'loitering' ? `${RED}30` : tab.id === 'connections' ? `${ORANGE}30` : `${ACCENT}30`, color: tab.id === 'loitering' ? RED : tab.id === 'connections' ? ORANGE : ACCENT, fontWeight: 700 }}>
                {tab.badge}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* ── Contenuto ── */}
      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        {!enabled ? (
          <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 11 }}>
            <i className="ti ti-chart-line" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
            Monitor disabilitato — premi Abilita per iniziare
          </div>
        ) : (
          <>
            {activeTab === 'run' && (
              <RunOverview timings={nodeTimings} summary={lastSummary} isRunning={isRunning} />
            )}

            {activeTab === 'timeline' && (
              <TimelineProfile timings={nodeTimings} samples={memorySamples} />
            )}

            {activeTab === 'memory' && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, padding: 8 }}>
                <div style={card}>
                  <div style={sectionTitle()}>Memoria</div>
                  <HeapChart samples={memorySamples} />
                </div>
                {lastSummary && (
                  <div style={card}>
                    <div style={sectionTitle('#4a5a7a')}>Ultimo run</div>
                    <div style={{ padding: '8px 10px', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                      {[
                        ['Durata',      ms(lastSummary.totalDurationMs)],
                        ['Peak heap',   `${Math.round(lastSummary.peakHeapMb)} MB`],
                        ['Avg heap',    `${Math.round(lastSummary.avgHeapMb)} MB`],
                        ['Righe in',    lastSummary.totalRowsIn.toLocaleString()],
                        ['Righe out',   lastSummary.totalRowsOut.toLocaleString()],
                        ['Scartate',    lastSummary.totalRejected.toLocaleString()],
                      ].map(([k, v]) => (
                        <div key={k}>
                          <div style={{ fontSize: 9, color: '#4a5a7a' }}>{k}</div>
                          <div style={{ fontSize: 11, color: '#c8d4f0', fontFamily: 'monospace' }}>{v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {activeTab === 'nodes' && (
              <div style={card}>
                <div style={sectionTitle(BLUE)}>Nodi — timing e throughput</div>
                <NodeTable timings={nodeTimings} />
              </div>
            )}

            {activeTab === 'connections' && (
              <div style={card}>
                <div style={sectionTitle(ORANGE)}>Connessioni risorse</div>
                <ConnectionList connections={connections} runEnded={isRunning} />
              </div>
            )}

            {activeTab === 'loitering' && (
              <div style={card}>
                <div style={sectionTitle(RED)}>Loitering objects</div>
                <LoiteringList objects={loitering} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}