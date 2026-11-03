/**
 * src/components/DecodeTablesModal.tsx
 *
 * Editor delle TABELLE DI DECODIFICA del progetto (P390): elenchi codice →
 * descrizione usati in FPEL con `decode("nome", codice)`. Si incollano da un
 * foglio di calcolo (due colonne) o si scrivono a mano, una voce per riga.
 * Le tabelle si risolvono a compile-time dentro le espressioni
 * (src/ir/decodeTables.ts): l'artifact resta autonomo.
 */
import { useState, useEffect } from 'react'
import { useFlowStore } from '../store/flowStore'
import { parseEntries, formatEntries, validateDecodeTables, type DecodeTable } from '../ir/decodeTables'

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const panel: React.CSSProperties = {
  width: 760, maxWidth: '94vw', height: '78vh', display: 'flex', flexDirection: 'column',
  background: '#161b26', border: '1px solid #2a3349', borderRadius: 10, overflow: 'hidden',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
}
const ACCENT = '#38bdf8'
const input: React.CSSProperties = {
  background: '#0f1117', border: '1px solid #2a3349', borderRadius: 5, color: '#e8ecf4',
  padding: '5px 8px', fontSize: 12, fontFamily: 'monospace',
}

interface Bozza { name: string; text: string }

export function DecodeTablesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const tables          = useFlowStore((s) => s.pool.decodeTables)
  const setDecodeTables = useFlowStore((s) => s.setDecodeTables)
  const [bozze, setBozze] = useState<Bozza[]>([])
  const [sel, setSel]     = useState(0)

  useEffect(() => {
    if (!open) return
    setBozze((tables ?? []).map((t) => ({ name: t.name, text: formatEntries(t.entries) })))
    setSel(0)
  }, [open, tables])

  if (!open) return null

  const definitive: DecodeTable[] = bozze.map((b) => ({ name: b.name.trim(), entries: parseEntries(b.text) }))
  const problemi = validateDecodeTables(definitive)
  const corrente = bozze[sel]

  const aggiorna = (patch: Partial<Bozza>) =>
    setBozze((bs) => bs.map((b, i) => (i === sel ? { ...b, ...patch } : b)))
  const nuova = () => {
    let n = 1
    const nomi = new Set(bozze.map((b) => b.name.toLowerCase()))
    while (nomi.has(`table_${n}`)) n++
    setBozze((bs) => [...bs, { name: `table_${n}`, text: '' }])
    setSel(bozze.length)
  }
  const elimina = (i: number) => {
    if (!confirm(`Delete the table "${bozze[i].name}"? Expressions that use it will show an error.`)) return
    setBozze((bs) => bs.filter((_, k) => k !== i))
    setSel((s) => Math.max(0, s >= i ? s - 1 : s))
  }
  const salva = () => { setDecodeTables(definitive); onClose() }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>

        <div style={{ padding: '14px 18px', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-table" style={{ fontSize: 18, color: ACCENT }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e8ecf4' }}>Decode tables</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer', fontSize: 18 }}>
            <i className="ti ti-x" />
          </button>
        </div>

        <div style={{ padding: '10px 18px', fontSize: 11, color: '#8a94a8', lineHeight: 1.6, borderBottom: '1px solid #2a3349' }}>
          Lists of codes and descriptions for the whole project. In an expression:{' '}
          <code style={{ color: ACCENT }}>decode("countries", country_code)</code> or{' '}
          <code style={{ color: ACCENT }}>decode("countries", country_code, "unknown")</code>.
          A missing code gives the third argument, or null. Keys are compared as text.
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* elenco delle tabelle */}
          <div style={{ width: 200, borderRight: '1px solid #2a3349', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {bozze.length === 0 && (
                <div style={{ padding: 14, fontSize: 11, color: '#6a7690' }}>No tables yet.</div>
              )}
              {bozze.map((b, i) => (
                <div key={i} onClick={() => setSel(i)}
                  style={{ padding: '8px 12px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                           background: i === sel ? 'color-mix(in srgb, #38bdf8 12%, #161b26)' : 'none',
                           borderLeft: `2px solid ${i === sel ? ACCENT : 'transparent'}` }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 12, color: '#e8ecf4', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {b.name || '(no name)'}
                    </div>
                    <div style={{ fontSize: 10, color: '#6a7690' }}>{parseEntries(b.text).length} entries</div>
                  </div>
                  <button title="Delete the table" onClick={(e) => { e.stopPropagation(); elimina(i) }}
                    style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer', fontSize: 13 }}>
                    <i className="ti ti-trash" />
                  </button>
                </div>
              ))}
            </div>
            <button onClick={nuova}
              style={{ margin: 10, padding: '6px 10px', fontSize: 11, borderRadius: 5, cursor: 'pointer',
                       background: 'none', border: `1px solid ${ACCENT}55`, color: ACCENT }}>
              <i className="ti ti-plus" style={{ fontSize: 11 }} /> New table
            </button>
          </div>

          {/* tabella selezionata */}
          <div style={{ flex: 1, padding: '12px 16px', display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>
            {corrente ? (
              <>
                <label style={{ fontSize: 11, color: '#8a94a8', display: 'flex', alignItems: 'center', gap: 8 }}>
                  Name
                  <input style={{ ...input, flex: 1 }} value={corrente.name}
                    onChange={(e) => aggiorna({ name: e.target.value })} spellCheck={false} />
                </label>
                <div style={{ fontSize: 10, color: '#6a7690' }}>
                  One entry per line: code, then description, separated by a TAB (paste two columns from a
                  spreadsheet), a semicolon or the first comma.
                </div>
                <textarea style={{ ...input, flex: 1, resize: 'none', lineHeight: 1.6 }}
                  value={corrente.text} onChange={(e) => aggiorna({ text: e.target.value })}
                  placeholder={'IT\tItaly\nFR\tFrance\nDE\tGermany'} spellCheck={false} />
              </>
            ) : (
              <div style={{ fontSize: 12, color: '#6a7690', margin: 'auto' }}>Create a table to start.</div>
            )}
          </div>
        </div>

        {problemi.length > 0 && (
          <div style={{ margin: '0 18px 10px', background: 'color-mix(in srgb, #ff5f57 8%, #0f1117)', border: '1px solid #ff5f5750',
                        borderRadius: 6, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
            {problemi.map((p, i) => (
              <div key={i} style={{ fontSize: 11, color: '#ff9a94', fontFamily: 'monospace' }}>
                • {p.table ? <b>{p.table}: </b> : null}{p.message}
              </div>
            ))}
          </div>
        )}

        <div style={{ padding: '12px 18px', borderTop: '1px solid #2a3349', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '7px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                     background: 'none', border: '1px solid #2a3349', color: '#9aa4b8' }}>
            Cancel
          </button>
          <button onClick={salva} disabled={problemi.length > 0}
            style={{ padding: '7px 16px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                     cursor: problemi.length > 0 ? 'default' : 'pointer',
                     background: problemi.length > 0 ? '#2a3349' : `color-mix(in srgb, ${ACCENT} 24%, #0f1117)`,
                     color: problemi.length > 0 ? '#8593b5' : ACCENT, border: `0.5px solid ${ACCENT}55` }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
