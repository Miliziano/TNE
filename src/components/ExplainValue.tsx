/**
 * src/components/ExplainValue.tsx
 *
 * "Spiega questo valore" (P391): il calcolo di un'espressione FPEL su una riga,
 * pezzo per pezzo. A calcolare è il MOTORE (comando `fpel_explain`, stesso
 * valutatore dei run); qui si mette accanto a ogni pezzo il suo testo.
 */
import { useEffect, useState } from 'react'
import type { ExprNode } from '../ir/exprParser'
import { exprToText, exprChildren, type Spiegazione } from '../ir/exprText'
import { isTauri } from '../lib/tauri'
import { spiegaValore } from '../lib/fpelEngine'

const ACCENT = '#a78bfa'

function valore(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'object') return JSON.stringify(v)
  return String(v)
}

function Passo({ n, s, livello }: { n: ExprNode; s: Spiegazione | null; livello: number }) {
  // I letterali si spiegano da sé: non si ripetono come passi.
  const figli = exprChildren(n).map((f, i) => [f, s?.c[i] ?? null] as const)
    .filter(([f]) => f.kind !== 'Literal')
  return (
    <div style={{ marginLeft: livello ? 14 : 0, borderLeft: livello ? '1px solid #2a3349' : 'none', paddingLeft: livello ? 8 : 0 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', fontFamily: 'monospace', fontSize: 11 }}>
        <span style={{ color: '#c8d4f0', wordBreak: 'break-all' }}>{exprToText(n)}</span>
        <span style={{ color: '#6a7690' }}>→</span>
        {s ? (
          <span style={{ color: s.v === null ? '#8593b5' : ACCENT, fontWeight: livello === 0 ? 700 : 400, wordBreak: 'break-all' }}>
            {valore(s.v)}
          </span>
        ) : (
          <span style={{ color: '#6a7690', fontStyle: 'italic' }}>not evaluated</span>
        )}
      </div>
      {s && figli.map(([f, sf], i) => <Passo key={i} n={f} s={sf} livello={livello + 1} />)}
    </div>
  )
}

/** Il calcolo, già ottenuto dal motore, come albero di passi. */
export function CalcoloSpiegato({ expr, s }: { expr: ExprNode; s: Spiegazione }) {
  return <Passo n={expr} s={s} livello={0} />
}

/** Riquadro con il calcolo di `expr` sulla riga `inputs` (per i nodi a un
 *  ingresso: `{ row: {...} }`). */
export function ExplainValue({ titolo, expr, inputs, variables, onClose }: {
  titolo: string
  expr: ExprNode
  inputs: Record<string, unknown>
  variables?: Record<string, unknown>
  onClose: () => void
}) {
  const [s, setS] = useState<Spiegazione | null>(null)
  const [errore, setErrore] = useState<string | null>(null)

  useEffect(() => {
    let vivo = true
    setS(null); setErrore(null)
    if (!isTauri()) { setErrore('The explanation is computed by the engine: available in the desktop app.'); return }
    spiegaValore(expr, inputs, variables)
      .then((r) => { if (vivo) setS(r) })
      .catch((e) => { if (vivo) setErrore(e instanceof Error ? e.message : String(e)) })
    return () => { vivo = false }
  }, [expr, inputs, variables])

  return (
    <div style={{ background: '#0f1117', border: `0.5px solid ${ACCENT}50`, borderRadius: 6, padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
        <i className="ti ti-bulb" style={{ color: ACCENT, fontSize: 13 }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: ACCENT }}>{titolo}</span>
        <div style={{ flex: 1 }} />
        <button onClick={onClose} title="Close"
          style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer', fontSize: 13 }}>
          <i className="ti ti-x" />
        </button>
      </div>
      {errore && <div style={{ fontSize: 11, color: '#ff9a94', fontFamily: 'monospace' }}>{errore}</div>}
      {!errore && !s && <div style={{ fontSize: 11, color: '#8593b5' }}>computing…</div>}
      {s && <CalcoloSpiegato expr={expr} s={s} />}
      <div style={{ fontSize: 9, color: '#6a7690', marginTop: 8 }}>
        Computed by the engine on this row, piece by piece. "Not evaluated" = a branch the expression did not need.
      </div>
    </div>
  )
}
