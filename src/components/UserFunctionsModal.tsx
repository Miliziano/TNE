/**
 * src/components/UserFunctionsModal.tsx
 *
 * Editor delle FUNZIONI UTENTE FPEL (a livello di progetto).
 *
 * Una funzione per riga, nella forma
 *   funzione nome(par1, par2) { ritorna <espressione> }
 * Vengono espanse a compile-time nelle espressioni (transform e, in seguito,
 * TMap/script). La validazione è dal vivo: nomi predefiniti non ridefinibili,
 * niente ricorsione, corpo con soli parametri, arità.
 */
import { useState, useEffect } from 'react'
import { useFlowStore } from '../store/flowStore'
import { parseUserFunctions } from '../ir/userFunctions'

const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const panel: React.CSSProperties = {
  width: 640, maxWidth: '92vw', maxHeight: '86vh', display: 'flex', flexDirection: 'column',
  background: '#161b26', border: '1px solid #2a3349', borderRadius: 10, overflow: 'hidden',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
}
const ACCENT = '#a78bfa'

export function UserFunctionsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const defs             = useFlowStore((s) => s.pool.userFunctions)
  const setUserFunctions = useFlowStore((s) => s.setUserFunctions)
  const [text, setText]  = useState('')

  useEffect(() => { if (open) setText((defs ?? []).join('\n')) }, [open, defs])

  if (!open) return null

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const { functions, errors } = parseUserFunctions(lines)

  const salva = () => { setUserFunctions(lines); onClose() }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>

        {/* header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-math-function" style={{ fontSize: 18, color: ACCENT }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e8ecf4' }}>Funzioni utente</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer', fontSize: 18 }}>
            <i className="ti ti-x" />
          </button>
        </div>

        {/* corpo */}
        <div style={{ padding: '14px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: '#8a94a8', lineHeight: 1.6 }}>
            Una funzione per riga:{' '}
            <code style={{ color: ACCENT }}>funzione nome(par1, par2) {'{'} ritorna espressione {'}'}</code>.
            Vengono <b>espanse a compile-time</b> nelle espressioni. Il corpo è una sola espressione e può usare
            solo i suoi parametri (e le funzioni predefinite); niente ricorsione né ridefinizione delle predefinite.
          </div>

          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            spellCheck={false}
            placeholder={'funzione iva(imponibile, aliquota) { ritorna imponibile * aliquota / 100 }\nfunzione pulisci(s) { ritorna trim(upper(s)) }'}
            style={{
              width: '100%', minHeight: 180, resize: 'vertical', boxSizing: 'border-box',
              background: '#0f1117', border: '1px solid #2a3349', borderRadius: 6, padding: '10px 12px',
              color: '#c8d4f0', fontFamily: 'monospace', fontSize: 12, lineHeight: 1.6,
            }}
          />

          {/* esito validazione */}
          {errors.length > 0 ? (
            <div style={{ background: 'color-mix(in srgb, #ff5f57 8%, #0f1117)', border: '1px solid #ff5f5750',
                          borderRadius: 6, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              {errors.map((e, i) => (
                <div key={i} style={{ fontSize: 11, color: '#ff9a94', fontFamily: 'monospace' }}>
                  • {e.name ? <b>{e.name}: </b> : null}{e.message}
                </div>
              ))}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#3ddc84' }}>
              {functions.length === 0 ? 'Nessuna funzione definita.' : `${functions.length} funzione/i valida/e: ${functions.map((f) => `${f.name}(${f.params.join(', ')})`).join(' · ')}`}
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid #2a3349', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '7px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                     background: 'none', border: '1px solid #2a3349', color: '#9aa4b8' }}>
            Annulla
          </button>
          <button onClick={salva} disabled={errors.length > 0}
            style={{ padding: '7px 16px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                     cursor: errors.length > 0 ? 'default' : 'pointer',
                     background: errors.length > 0 ? '#2a3349' : `color-mix(in srgb, ${ACCENT} 24%, #0f1117)`,
                     color: errors.length > 0 ? '#4a5a7a' : ACCENT, border: `0.5px solid ${ACCENT}55` }}>
            Salva
          </button>
        </div>
      </div>
    </div>
  )
}
