/**
 * src/nodes/types/transform/PreviewPanel.tsx
 *
 * Anteprima SUL DATO VERO del nodo Transform, in ISOLAMENTO.
 *
 * Non simula nulla: prende le righe di prova salvate SUL NODO, compila lo
 * spec del transform con lo STESSO compilatore del run (compileTransformFields)
 * e le fa elaborare al MOTORE (comando `engine_preview_node`). Il nodo è
 * autosufficiente — i mock vivono qui, non serve risalire la catena a monte.
 *
 * A ESEGUIRE è sempre e solo il motore: qui non c'è un valutatore FPEL, si
 * spedisce lo spec compilato e si mostra ciò che il motore restituisce.
 */
import { useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useFlowStore } from '../../../store/flowStore'
import { compileTransformFields, type TransformFieldSpec } from '../../../transforms/templateCompiler'

const ACCENT = '#ffb347'

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

export function TransformPreviewPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  // Stessa fonte che usa buildRustPlan: i campi salvati dal Mapping.
  const fields: TransformFieldSpec[] = useMemo(() => {
    try { return JSON.parse(String(node?.data.props?.['transformFields'] ?? '[]')) } catch { return [] }
  }, [node?.data.props?.['transformFields']])

  // Righe di prova, salvate SUL NODO → indipendenza dalla catena.
  const mockRaw = String(node?.data.props?.['previewMockRows'] ?? '')

  const [output,  setOutput]  = useState<Array<Record<string, unknown>> | null>(null)
  const [errore,  setErrore]  = useState<string | null>(null)
  const [inCorso, setInCorso] = useState(false)

  // Semina una riga vuota con i campi sorgente del transform.
  function semeVuoto() {
    const sorgenti = Array.from(new Set(fields.map((f) => f.source).filter(Boolean)))
    const riga: Record<string, string> = {}
    for (const s of sorgenti) riga[s] = ''
    updateProp(nodeId, 'previewMockRows', JSON.stringify([riga], null, 2))
  }

  async function esegui() {
    setErrore(null); setOutput(null)

    // 1) righe di prova
    let rows: unknown
    try {
      rows = JSON.parse(mockRaw || '[]')
      if (!Array.isArray(rows)) throw new Error('devono essere un array JSON di oggetti')
    } catch (e) {
      setErrore(`Righe di prova non valide: ${e instanceof Error ? e.message : String(e)}`)
      return
    }

    // 2) spec del nodo — STESSA ricetta di buildRustPlan (Toolbar):
    //    compileTransformFields + traduzione unmappedFields → mode.
    const { compiled, errors } = compileTransformFields(fields)
    if (errors.length > 0) {
      setErrore(errors.map((x) => `\u2022 ${x.message}`).join('\n'))
      return
    }
    const unmapped = String(node?.data.props?.['unmappedFields'] ?? 'drop')
    const mode     = unmapped === 'passthrough' ? 'add' : 'select'
    const specJson = JSON.stringify({ config: { mode, fields: compiled } })

    // 3) al MOTORE
    setInCorso(true)
    try {
      const res = await invoke<string>('engine_preview_node', {
        nodeType:      'transform',
        specJson,
        rowsJson:      JSON.stringify(rows),
        variablesJson: null,
      })
      const parsed = JSON.parse(res)
      setOutput(Array.isArray(parsed) ? parsed : [])
    } catch (e) {
      setErrore(e instanceof Error ? e.message : String(e))
    } finally {
      setInCorso(false)
    }
  }

  if (fields.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: '#4a5a7a', fontSize: 11,
                    background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
        <i className="ti ti-eye-off" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
        Configura almeno un campo nel tab <b>Mapping</b> per provare l'anteprima.
      </div>
    )
  }

  const cols = output && output.length > 0
    ? Array.from(new Set(output.flatMap((r) => Object.keys(r))))
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Righe di prova */}
      <div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase',
                         letterSpacing: '.08em' }}>Righe di prova</span>
          <div style={{ flex: 1 }} />
          <button onClick={semeVuoto}
            style={{ fontSize: 9, padding: '2px 7px', borderRadius: 5, background: 'none',
                     border: '1px solid #2a3349', color: '#8aa4d0', cursor: 'pointer' }}>
            riga vuota dai campi
          </button>
        </div>
        <textarea
          value={mockRaw}
          onChange={(e) => updateProp(nodeId, 'previewMockRows', e.target.value)}
          spellCheck={false}
          placeholder={'[\n  { "campo": "valore" }\n]'}
          style={{ ...box, width: '100%', minHeight: 90, resize: 'vertical', color: '#c8d4f0',
                   fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5, boxSizing: 'border-box' }}
        />
        <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 4, lineHeight: 1.5 }}>
          Un array JSON di oggetti; ogni oggetto è una riga in ingresso. Vivono su questo nodo:
          l'anteprima è indipendente dalla catena a monte.
        </div>
      </div>

      {/* Azione */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <button onClick={esegui} disabled={inCorso}
          style={{ fontSize: 11, fontWeight: 600, padding: '6px 14px', borderRadius: 6,
                   background: inCorso ? '#2a3349' : `color-mix(in srgb, ${ACCENT} 22%, #0f1117)`,
                   color: inCorso ? '#4a5a7a' : ACCENT, border: `0.5px solid ${ACCENT}50`,
                   cursor: inCorso ? 'default' : 'pointer' }}>
          {inCorso ? 'elaborazione…' : '\u25b6 elabora col motore'}
        </button>
        <span style={{ fontSize: 9, color: '#4a5a7a' }}>a eseguire è il motore, come in produzione</span>
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
          <div style={{ ...box, fontSize: 11, color: '#4a5a7a' }}>Nessuna riga in uscita.</div>
        ) : (
          <div>
            <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase',
                          letterSpacing: '.08em', padding: '4px 0',
                          borderBottom: `0.5px solid ${ACCENT}30`, marginBottom: 6 }}>
              Uscita — {output.length} riga/e
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
