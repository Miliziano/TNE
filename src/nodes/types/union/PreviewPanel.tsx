/**
 * src/nodes/types/union/PreviewPanel.tsx
 *
 * Anteprima STRUTTURALE del risultato di Union.
 *
 * Non legge dati: mostra la FORMA del flusso in uscita, derivata dalla
 * mappatura salvata dal MappingPanel e dalla modalità scelta nel Panel.
 * Stessa filosofia della preview di sink_db, che mostra l'SQL generato e
 * non i record scritti.
 *
 * Per ogni flusso e ogni colonna di uscita indica:
 *   ●  la colonna è alimentata da questo flusso
 *   ○  la colonna sarà null (il flusso non ha quel campo)
 *   —  la colonna è omessa (missingField = "omit")
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'

const ACCENT = '#a78bfa'

const HANDLE_COLORS: Record<string, string> = { input_main: '#4a9eff' }
const EXTRA_COLORS = ['#3ddc84','#a78bfa','#ffb347','#22d3ee','#f97316','#ff5f57','#84cc16']
const handleColor = (h: string, i: number) => HANDLE_COLORS[h] ?? EXTRA_COLORS[i % EXTRA_COLORS.length]

interface UnionField {
  name: string
  type: string
  from: Record<string, string>
}

const MODE_INFO: Record<string, { label: string; rows: string; note: string }> = {
  concat: {
    label: 'CONCAT',
    rows:  'somma delle righe',
    note:  'I flussi vengono emessi uno dopo l\'altro: prima tutte le righe del flusso 1, poi del flusso 2, e così via. Ordine deterministico.',
  },
  mix: {
    label: 'INTERLEAVE',
    rows:  'somma delle righe',
    note:  'Le righe si mescolano nell\'ordine di arrivo. L\'ordine NON è garantito: dipende dalla velocità di ciascun flusso.',
  },
  zip: {
    label: 'ZIP',
    rows:  'righe del flusso più corto',
    note:  'Accoppia la riga N di ogni flusso in un\'unica riga di uscita, fondendone i campi. Se i flussi hanno lunghezza diversa, il comportamento dipende da "Disallineamento zip".',
  },
}

export function UnionPreviewPanel({ nodeId }: { nodeId: string }) {
  const node  = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const edges = useFlowStore((s) => s.edges)

  const p = (k: string, d = '') => String(node?.data.props?.[k] ?? d)

  const mode         = p('unionMode', 'concat')
  const missingField = p('missingField', 'null')
  const addSource    = p('addSourceField', 'false') === 'true'
  const sourceField  = p('sourceFieldName', '_union_source')
  const zipMismatch  = p('zipMismatch', 'truncate')

  const fields: UnionField[] = useMemo(() => {
    try { return JSON.parse(p('unionMapping', '[]')) } catch { return [] }
  }, [node?.data.props?.['unionMapping']])

  // Handle collegati, in ordine (input_main, poi i dinamici)
  const handles = useMemo(() => {
    const extra = ((node?.data.config as any)?.unionInputs ?? []) as Array<{ id: string; label: string }>
    const connected = new Set(edges.filter((e) => e.target === nodeId).map((e) => e.targetHandle))
    const out: Array<{ handle: string; label: string }> = []
    if (connected.has('input_main')) out.push({ handle: 'input_main', label: 'flusso 1' })
    for (const inp of extra) if (connected.has(inp.id)) out.push({ handle: inp.id, label: inp.label })
    return out
  }, [edges, nodeId, node?.data.config])

  const info = MODE_INFO[mode] ?? MODE_INFO.concat
  const omit = missingField === 'omit'

  const box: React.CSSProperties = {
    background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', padding: '10px 12px',
  }
  const th: React.CSSProperties = {
    fontSize: 9, color: '#4a5a7a', fontWeight: 600, textTransform: 'uppercase',
    letterSpacing: '.06em', textAlign: 'left', padding: '4px 8px', whiteSpace: 'nowrap',
  }
  const td: React.CSSProperties = {
    fontSize: 11, padding: '5px 8px', textAlign: 'center', fontFamily: 'monospace',
  }

  if (handles.length === 0 || fields.length === 0) {
    return (
      <div style={{ padding: 20, textAlign: 'center', color: '#4a5a7a', fontSize: 11,
                    background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
        <i className="ti ti-eye-off" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
        Collega i flussi e apri il tab <b>Mapping</b> per vedere l'anteprima della struttura.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Modalità ── */}
      <div style={{ ...box, background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`,
                    border: `0.5px solid ${ACCENT}30` }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
          <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: '.06em', padding: '2px 8px',
                         borderRadius: 4, background: `color-mix(in srgb, ${ACCENT} 20%, #0f1117)`,
                         color: ACCENT, border: `0.5px solid ${ACCENT}50` }}>
            {info.label}
          </span>
          <span style={{ fontSize: 10, color: '#9a9aaa' }}>
            {handles.length} flussi → {fields.length + (addSource ? 1 : 0)} colonne, {info.rows}
          </span>
        </div>
        <div style={{ fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>{info.note}</div>
        {mode === 'zip' && (
          <div style={{ fontSize: 10, color: '#ffb347', marginTop: 6 }}>
            Disallineamento: <b>{
              zipMismatch === 'truncate' ? 'tronca al flusso più corto'
              : zipMismatch === 'pad_null' ? 'prosegue, campi mancanti a null'
              : 'errore se le lunghezze differiscono'
            }</b>
          </div>
        )}
      </div>

      {/* ── Matrice flusso × colonna ── */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase',
                      letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30`,
                      marginBottom: 6 }}>
          Provenienza delle colonne
        </div>

        <div style={{ ...box, overflowX: 'auto', padding: 0 }}>
          <table style={{ borderCollapse: 'collapse', width: '100%' }}>
            <thead>
              <tr style={{ borderBottom: '0.5px solid #2a3349' }}>
                <th style={{ ...th, position: 'sticky', left: 0, background: '#0f1117' }}>flusso</th>
                {fields.map((f) => (
                  <th key={f.name} style={th} title={f.type}>
                    <code style={{ color: '#c8d4f0' }}>{f.name}</code>
                  </th>
                ))}
                {addSource && (
                  <th style={{ ...th, color: ACCENT }}><code>{sourceField}</code></th>
                )}
              </tr>
            </thead>
            <tbody>
              {handles.map(({ handle, label }, i) => {
                const color = handleColor(handle, i)
                return (
                  <tr key={handle} style={{ borderBottom: '0.5px solid #1e2535' }}>
                    <td style={{ ...td, textAlign: 'left', position: 'sticky', left: 0,
                                 background: '#0f1117', color, fontSize: 10, whiteSpace: 'nowrap' }}>
                      <span style={{ display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
                                     background: color, marginRight: 6 }} />
                      {label}
                    </td>
                    {fields.map((f) => {
                      const src = f.from[handle]
                      return (
                        <td key={f.name} style={td}
                            title={src ? `${label}.${src} → ${f.name}` : `${label} non ha questo campo`}>
                          {src
                            ? <span style={{ color }}>●</span>
                            : omit
                              ? <span style={{ color: '#3a4560' }}>—</span>
                              : <span style={{ color: '#4a5a7a' }}>○</span>}
                        </td>
                      )
                    })}
                    {addSource && (
                      <td style={{ ...td, color: ACCENT, fontSize: 9 }}>"{label}"</td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div style={{ display: 'flex', gap: 14, marginTop: 6, fontSize: 9, color: '#4a5a7a' }}>
          <span><span style={{ color: '#9a9aaa' }}>●</span> alimentata dal flusso</span>
          {omit
            ? <span><span style={{ color: '#3a4560' }}>—</span> colonna omessa dalla riga</span>
            : <span><span style={{ color: '#4a5a7a' }}>○</span> valore <code>null</code></span>}
        </div>
      </div>

      {/* ── Campi rinominati ── */}
      {fields.some((f) => Object.values(f.from).some((src) => src !== f.name)) && (
        <div style={box}>
          <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 6, textTransform: 'uppercase',
                        letterSpacing: '.06em', fontWeight: 600 }}>
            Rinomine applicate
          </div>
          {fields.map((f) =>
            Object.entries(f.from)
              .filter(([, src]) => src !== f.name)
              .map(([h, src]) => {
                const lbl = handles.find((x) => x.handle === h)?.label ?? h
                return (
                  <div key={`${h}::${src}`} style={{ fontSize: 10, color: '#9a9aaa', padding: '2px 0' }}>
                    <code style={{ color: '#4a5a7a' }}>{lbl}.{src}</code>
                    <span style={{ margin: '0 6px', color: ACCENT }}>→</span>
                    <code style={{ color: '#c8d4f0' }}>{f.name}</code>
                  </div>
                )
              })
          )}
        </div>
      )}

      {/* ── Esempio di riga ── */}
      <div>
        <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase',
                      letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30`,
                      marginBottom: 6 }}>
          Riga in uscita — struttura
        </div>
        <div style={{ ...box, fontFamily: 'monospace', fontSize: 10, lineHeight: 1.7, color: '#9a9aaa' }}>
          {'{'}
          {fields.map((f, i) => (
            <div key={f.name} style={{ paddingLeft: 14 }}>
              <span style={{ color: '#c8d4f0' }}>"{f.name}"</span>
              <span>: </span>
              <span style={{ color: '#4a5a7a' }}>{f.type}</span>
              {mode !== 'zip' && Object.keys(f.from).length < handles.length && !omit && (
                <span style={{ color: '#ffb347' }}> | null</span>
              )}
              {i < fields.length - 1 || addSource ? ',' : ''}
            </div>
          ))}
          {addSource && (
            <div style={{ paddingLeft: 14 }}>
              <span style={{ color: ACCENT }}>"{sourceField}"</span>
              <span>: </span>
              <span style={{ color: '#4a5a7a' }}>string</span>
            </div>
          )}
          {'}'}
        </div>
      </div>

    </div>
  )
}
