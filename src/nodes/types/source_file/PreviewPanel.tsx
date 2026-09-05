/**
 * src/nodes/types/source_file/PreviewPanel.tsx
 *
 * Campionamento REALE da un source file (CSV/JSON/XML…), a richiesta.
 *
 * Non simula: costruisce lo spec del nodo (stessa ricetta di buildRustPlan —
 * scalari nei props, proiezione in config.fields) e lo fa leggere al MOTORE
 * col comando `engine_preview_node`, che fa girare il nodo source_file vero
 * in isolamento (solo I/O su file, nessuna lane) con un tetto di righe.
 *
 * È I/O reale → a richiesta, con timeout implicito nel tetto righe.
 */
import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useFlowStore } from '../../../store/flowStore'

const ACCENT = '#f59e0b'

const box: React.CSSProperties = {
  background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', padding: '10px 12px',
}
const th: React.CSSProperties = {
  fontSize: 9, color: '#8593b5', fontWeight: 600, textTransform: 'uppercase',
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

export function SourceFilePreviewPanel({ nodeId }: { nodeId: string }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const p = (k: string, d = '') => String(node?.data.props?.[k] ?? d)

  const pathSource = p('pathSource', 'static')
  const path       = p('path')
  const format     = p('format', 'csv')

  const outputSchema = useMemo(() => {
    try {
      return JSON.parse(p('outputSchema') || '[]') as Array<{ name: string; type: string; physicalName?: string }>
    } catch { return [] }
  }, [node?.data.props?.['outputSchema']])

  const [limite,  setLimite]  = useState(20)
  const [output,  setOutput]  = useState<Array<Record<string, unknown>> | null>(null)
  const [errore,  setErrore]  = useState<string | null>(null)
  const [inCorso, setInCorso] = useState(false)

  async function campiona() {
    setErrore(null); setOutput(null)

    if (pathSource !== 'static') {
      setErrore('Percorso dinamico (da campo): l\u2019anteprima è disponibile solo con un percorso statico.')
      return
    }
    if (!path) { setErrore('Nessun percorso file impostato nel nodo.'); return }

    // Spec del nodo — STESSA ricetta di buildRustPlan: scalari nei props,
    // proiezione dello schema in config.fields (physicalName come nome).
    const spec = {
      props: {
        path,
        format,
        delimiter: p('delimiter', ','),
        hasHeader: p('hasHeader', 'true'),
        pathSource: 'static',
      },
      config: {
        fields: outputSchema.map((f) => ({ name: f.physicalName ?? f.name, type: f.type })),
      },
    }

    setInCorso(true)
    try {
      const res = await invoke<string>('engine_preview_node', {
        nodeType:      'source_file',
        specJson:      JSON.stringify(spec),
        rowsJson:      '[]',
        variablesJson: null,
        limit:         Math.max(1, Math.min(500, limite)),
      })
      const parsed = JSON.parse(res)
      setOutput(Array.isArray(parsed) ? parsed : [])
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e))
    } finally {
      setInCorso(false)
    }
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
                   color: inCorso ? '#8593b5' : ACCENT, border: `0.5px solid ${ACCENT}50`,
                   cursor: inCorso ? 'default' : 'pointer' }}>
          {inCorso ? 'lettura…' : '\u25b6 campiona dal file'}
        </button>
        <label style={{ fontSize: 10, color: '#9a9aaa', display: 'flex', alignItems: 'center', gap: 6 }}>
          righe
          <input type="number" min={1} max={500} value={limite}
            onChange={(e) => setLimite(parseInt(e.target.value, 10) || 1)}
            style={{ width: 60, background: '#0f1117', border: '1px solid #2a3349', borderRadius: 5,
                     color: '#c8d4f0', fontSize: 11, padding: '3px 6px' }} />
        </label>
        <span style={{ fontSize: 9, color: '#8593b5' }}>
          lettura reale del file (<b style={{ color: '#9a9aaa' }}>{format}</b>) — a leggere è il motore
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
          <div style={{ ...box, fontSize: 11, color: '#8593b5' }}>Nessuna riga letta dal file.</div>
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
                            style={{ ...td, color: r[c] === null || r[c] === undefined ? '#8593b5' : '#c8d4f0' }}>
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
