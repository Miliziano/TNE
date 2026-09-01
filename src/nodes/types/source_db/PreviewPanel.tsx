/**
 * src/nodes/types/source_db/PreviewPanel.tsx
 *
 * Campionamento REALE dal source DB, a richiesta.
 *
 * Legge poche righe vere dalla sorgente per rispondere a "la query funziona,
 * e cosa esce?". Non simula: esegue la query col comando `db_query` (è il
 * MOTORE a interrogare il DB) e mostra le righe.
 *
 * Per non riportare set enormi, la query dell'utente viene AVVOLTA con un
 * limite — stessa tecnica già usata da `db_infer_schema`:
 *   SELECT * FROM (<query>) AS __preview__ LIMIT N
 * (postgresql / mysql / sqlite, gli unici dialetti che `db_query` esegue).
 *
 * A richiesta e con timeout: la lettura è I/O vera, può essere lenta.
 */
import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useFlowStore } from '../../../store/flowStore'

const ACCENT = '#4a9eff'

const box: React.CSSProperties = {
  background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', padding: '10px 12px',
}
const th: React.CSSProperties = {
  fontSize: 9, color: '#4a5a7a', fontWeight: 600, textTransform: 'uppercase',
  letterSpacing: '.06em', textAlign: 'left', padding: '4px 8px', whiteSpace: 'nowrap',
}
const td: React.CSSProperties = {
  fontSize: 11, padding: '5px 8px', textAlign: 'left', fontFamily: 'monospace', whiteSpace: 'nowrap',
}

function fmt(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

const DEFAULT_PORT: Record<string, string> = {
  postgresql: '5432', mysql: '3306', sqlite: '0', oracle: '1521', informix: '9088',
}
const DIALETTI_SUPPORTATI = ['postgresql', 'mysql', 'sqlite']

export function SourceDbPreviewPanel({ nodeId }: { nodeId: string }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const pool = useFlowStore((s) => s.pool)

  const p = (k: string, d = '') => String(node?.data.props?.[k] ?? d)

  const resId = (node?.data.config?.resourceId as string | undefined) ?? ''
  const resource = useMemo(
    () => (resId ? pool.lanes.flatMap((l) => l.resources).find((r) => r.id === resId) : undefined),
    [pool.lanes, resId],
  ) as { label: string; config?: Record<string, string> } | undefined

  const dialect = (resource?.config?.dialect ?? resource?.config?.driver ?? 'postgresql') as string
  const query   = p('query').trim()

  const [limite,  setLimite]  = useState(20)
  const [output,  setOutput]  = useState<Array<Record<string, unknown>> | null>(null)
  const [errore,  setErrore]  = useState<string | null>(null)
  const [inCorso, setInCorso] = useState(false)

  async function campiona() {
    setErrore(null); setOutput(null)

    if (!resource) { setErrore('Nessuna risorsa collegata al nodo.'); return }
    if (!query)    { setErrore('Configura una query nel tab Query prima di campionare.'); return }
    if (!DIALETTI_SUPPORTATI.includes(dialect)) {
      setErrore(`Anteprima dati non disponibile per il dialetto «${dialect}» (supportati: ${DIALETTI_SUPPORTATI.join(', ')}).`)
      return
    }

    const cfg = resource.config ?? {}
    const connection = {
      dialect,
      host:           cfg.host ?? 'localhost',
      port:           parseInt(cfg.port ?? DEFAULT_PORT[dialect] ?? '5432', 10),
      database:       cfg.database ?? '',
      user:           cfg.user ?? cfg.username ?? '',
      password:       cfg.password ?? '',
      schema:         cfg.schema,
      serviceName:    cfg.serviceName,
      dbServerName:   cfg.dbServerName,
      charset:        cfg.charset,
      ssl:            cfg.ssl ?? 'false',
      connectTimeout: parseInt(cfg.connectTimeout ?? cfg.timeoutSec ?? '10', 10),
    }

    // Avvolgo la query per cappare le righe, come fa db_infer_schema.
    const base    = query.replace(/;\s*$/, '')
    const n        = Math.max(1, Math.min(500, limite))
    const wrapped  = `SELECT * FROM (${base}) AS __preview__ LIMIT ${n}`
    const timeout  = parseInt(p('queryTimeout', '30'), 10) || 30

    setInCorso(true)
    try {
      const rows = await invoke<Array<Record<string, unknown>>>('db_query', {
        request: { connection, query: wrapped, timeout },
      })
      setOutput(Array.isArray(rows) ? rows : [])
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e))
    } finally {
      setInCorso(false)
    }
  }

  if (!resource) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: '#4a5a7a', fontSize: 11,
                    background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
        <i className="ti ti-database-off" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
        Collega una risorsa DB al nodo per campionare i dati.
      </div>
    )
  }

  const cols = output && output.length > 0
    ? Array.from(new Set(output.flatMap((r) => Object.keys(r))))
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Comando */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <button onClick={campiona} disabled={inCorso}
          style={{ fontSize: 11, fontWeight: 600, padding: '6px 14px', borderRadius: 6,
                   background: inCorso ? '#2a3349' : `color-mix(in srgb, ${ACCENT} 22%, #0f1117)`,
                   color: inCorso ? '#4a5a7a' : ACCENT, border: `0.5px solid ${ACCENT}50`,
                   cursor: inCorso ? 'default' : 'pointer' }}>
          {inCorso ? 'lettura…' : '\u25b6 campiona dalla sorgente'}
        </button>
        <label style={{ fontSize: 10, color: '#9a9aaa', display: 'flex', alignItems: 'center', gap: 6 }}>
          righe
          <input type="number" min={1} max={500} value={limite}
            onChange={(e) => setLimite(parseInt(e.target.value, 10) || 1)}
            style={{ width: 60, background: '#0f1117', border: '1px solid #2a3349', borderRadius: 5,
                     color: '#c8d4f0', fontSize: 11, padding: '3px 6px' }} />
        </label>
        <span style={{ fontSize: 9, color: '#4a5a7a' }}>
          lettura reale dal DB (dialetto <b style={{ color: '#9a9aaa' }}>{dialect}</b>) — a interrogare è il motore
        </span>
      </div>

      {/* Errore */}
      {errore && (
        <div style={{ ...box, borderColor: '#ff5f5750',
                      background: 'color-mix(in srgb, #ff5f57 8%, #0f1117)',
                      color: '#ff9a94', fontSize: 11, whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
          {errore}
        </div>
      )}

      {/* Uscita */}
      {output && (
        output.length === 0 ? (
          <div style={{ ...box, fontSize: 11, color: '#4a5a7a' }}>Nessuna riga restituita.</div>
        ) : (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase',
                          letterSpacing: '.08em', padding: '4px 0',
                          borderBottom: `0.5px solid ${ACCENT}30`, marginBottom: 6 }}>
              Campione — {output.length} riga/e
            </div>
            <div style={{ ...box, overflowX: 'auto', padding: 0 }}>
              <table style={{ borderCollapse: 'collapse', width: '100%' }}>
                <thead>
                  <tr style={{ borderBottom: '0.5px solid #2a3349' }}>
                    {cols.map((c) => (
                      <th key={c} style={th}><code style={{ color: '#c8d4f0' }}>{c}</code></th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {output.map((r, i) => (
                    <tr key={i} style={{ borderBottom: '0.5px solid #1e2535' }}>
                      {cols.map((c) => (
                        <td key={c}
                            style={{ ...td, color: r[c] === null || r[c] === undefined ? '#4a5a7a' : '#c8d4f0' }}>
                          {fmt(r[c])}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
    </div>
  )
}
