/**
 * src/components/UserFunctionsModal.tsx
 *
 * Editor delle FUNZIONI UTENTE FPEL (a livello di progetto).
 *
 * Una funzione per riga, nella forma
 *   function name(par1, par2) { ritorna <espressione> }
 * Vengono espanse a compile-time nelle espressioni (transform e, in seguito,
 * TMap/script). La validazione è dal vivo: nomi predefiniti non ridefinibili,
 * niente ricorsione, corpo con soli parametri, arità.
 */
import { useState, useEffect } from 'react'
import { useFlowStore } from '../store/flowStore'
import { parseUserFunctions } from '../ir/userFunctions'
import { ScriptEditor } from './ScriptEditor'
import { FunctionPicker } from './FunctionPicker'
import { isTauri, openFileDialog, saveFileDialog, readFile, writeFile } from '../lib/tauri'

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
  const [wrap, setWrap]  = useState<string | undefined>(undefined)
  const [pickerOpen, setPickerOpen] = useState(false)

  useEffect(() => { if (open) setText((defs ?? []).join('\n')) }, [open, defs])

  if (!open) return null

  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  const { functions, errors } = parseUserFunctions(lines)

  const salva = () => { setUserFunctions(lines); onClose() }

  // ── Librerie .ffpel (funzioni riusabili fra progetti) ──
  const mergeDefs = (content: string) => {
    const esistenti = new Set(parseUserFunctions(lines).functions.map((fn) => fn.name))
    const aggiunte: string[] = []
    for (const riga of content.split('\n').map((l) => l.trim()).filter(Boolean)) {
      const m = /funzione\s+([A-Za-z_][A-Za-z0-9_]*)/i.exec(riga)
      if (!m) continue
      const nome = m[1].toLowerCase()
      if (esistenti.has(nome)) continue   // duplicato: salta
      esistenti.add(nome)
      aggiunte.push(riga)
    }
    if (aggiunte.length) setText([text.trim(), ...aggiunte].filter(Boolean).join('\n'))
  }
  const esportaLib = async () => {
    if (isTauri()) {
      const path = await saveFileDialog({ title: 'Esporta libreria funzioni',
        filters: [{ name: 'Libreria FPEL', extensions: ['ffpel'] }], defaultPath: 'libreria.ffpel' })
      if (!path) return
      try { await writeFile(path, text) }
      catch (e) { alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`) }
      return
    }
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a')
    a.href = url; a.download = 'libreria.ffpel'; document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
  }
  const importaLib = async () => {
    if (isTauri()) {
      const res = await openFileDialog({ title: 'Importa libreria funzioni',
        filters: [{ name: 'Libreria FPEL', extensions: ['ffpel'] }] })
      const path = Array.isArray(res) ? res[0] : res
      if (!path) return
      try { mergeDefs(await readFile(path)) }
      catch (e) { alert(`Read failed: ${e instanceof Error ? e.message : String(e)}`) }
      return
    }
    const input = document.createElement('input')
    input.type = 'file'; input.accept = '.ffpel,text/plain'
    input.onchange = () => {
      const file = input.files?.[0]; if (!file) return
      const reader = new FileReader()
      reader.onload = () => mergeDefs(String(reader.result))
      reader.readAsText(file)
    }
    input.click()
  }

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>

        {/* header */}
        <div style={{ padding: '14px 18px', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-math-function" style={{ fontSize: 18, color: ACCENT }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e8ecf4' }}>User functions</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer', fontSize: 18 }}>
            <i className="ti ti-x" />
          </button>
        </div>

        {/* corpo */}
        <div style={{ padding: '14px 18px', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 11, color: '#8a94a8', lineHeight: 1.6 }}>
            One function per line:{' '}
            <code style={{ color: ACCENT }}>function name(par1, par2) {'{'} return expression {'}'}</code>.
            They are <b>expanded at compile-time</b> in expressions. The body is a single expression and can use
            only its parameters (and the built-in functions); no recursion, no redefining the built-ins.
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <button onClick={importaLib}
              title="Import functions from a .ffpel library (adds them, skipping names already present)"
              style={{ fontSize: 10, padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
                       background: 'none', border: '1px solid #2a3349', color: '#8aa4d0' }}>
              <i className="ti ti-download" style={{ fontSize: 10 }} /> import .ffpel
            </button>
            <button onClick={esportaLib}
              title="Export the functions as a reusable .ffpel library for other projects"
              style={{ fontSize: 10, padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
                       background: 'none', border: '1px solid #2a3349', color: '#8aa4d0' }}>
              <i className="ti ti-upload" style={{ fontSize: 10 }} /> export .ffpel
            </button>
            <div style={{ flex: 1 }} />
            <button
              onClick={() => setPickerOpen(true)}
              title="Apply a function: wraps the selection in the editor (searchable)"
              style={{ fontSize: 10, padding: '3px 9px', borderRadius: 5, cursor: 'pointer',
                       background: 'none', border: `1px solid ${ACCENT}55`, color: ACCENT }}>
              ƒ apply…
            </button>
            {pickerOpen && (
              <FunctionPicker
                tipo="string"
                onChiudi={() => setPickerOpen(false)}
                onScegli={(voce) => setWrap(voce.codice.replace(/\$sel/g, '$selection'))} />
            )}
          </div>
          <div style={{ border: '1px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            <ScriptEditor
              value={text}
              onChange={setText}
              language="flowpilot"
              height={200}
              wrapToInsert={wrap}
              onWrapInserted={() => setWrap(undefined)}
            />
          </div>

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
              {functions.length === 0 ? 'No functions defined.' : `${functions.length} valid function(s): ${functions.map((f) => `${f.name}(${f.params.join(', ')})`).join(' · ')}`}
            </div>
          )}
        </div>

        {/* footer */}
        <div style={{ padding: '12px 18px', borderTop: '1px solid #2a3349', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose}
            style={{ padding: '7px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                     background: 'none', border: '1px solid #2a3349', color: '#9aa4b8' }}>
            Cancel
          </button>
          <button onClick={salva} disabled={errors.length > 0}
            style={{ padding: '7px 16px', fontSize: 12, fontWeight: 600, borderRadius: 6,
                     cursor: errors.length > 0 ? 'default' : 'pointer',
                     background: errors.length > 0 ? '#2a3349' : `color-mix(in srgb, ${ACCENT} 24%, #0f1117)`,
                     color: errors.length > 0 ? '#8593b5' : ACCENT, border: `0.5px solid ${ACCENT}55` }}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
