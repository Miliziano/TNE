/**
 * src/components/EnvironmentsModal.tsx
 *
 * Editor Ambienti — un unico posto per:
 *   1) VARIABILI DI POOL (condivise): crea / rinomina / valore di default / elimina;
 *   2) PROFILI (test/dev/prod): profilo attivo, crea/elimina, valori per profilo;
 *   3) IMPORT / EXPORT dei profili da/su FILE esterno. Il progetto resta il
 *      padrone (i valori stanno nel .ffplan); il file esterno è comodità:
 *      esporti per condividere/preparare fuori, importi per portare dentro.
 *      Se un profilo viene da un file, il progetto ne ricorda il percorso
 *      (profileRefs) e l'utente può RICARICARLO a mano quando vuole — nessun
 *      auto-reload all'apertura (il progetto vince, niente sorprese).
 * Legge/scrive lo store direttamente. Tutto si persiste col progetto (Salva).
 */
import { useState } from 'react'
import { useFlowStore } from '../store/flowStore'
import { CustomSelect } from './CustomSelect'
import { openFileDialog, saveFileDialog, readFile, writeFile, isTauri } from '../lib/tauri'

const inputStyle: React.CSSProperties = {
  flex: 1, background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: '5px 8px', outline: 'none',
}
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600,
}
const trashStyle: React.CSSProperties = {
  background: 'transparent', color: '#8a6a6a', border: '1px solid #4a2a2a', borderRadius: 6,
  padding: '5px 8px', fontSize: 12, cursor: 'pointer', flexShrink: 0, display: 'flex', alignItems: 'center',
}
const addBtnStyle: React.CSSProperties = {
  background: '#1d6d40', color: '#eafff2', border: '1px solid #2a3349', borderRadius: 6,
  padding: '5px 10px', fontSize: 11, cursor: 'pointer', flexShrink: 0,
}
const ghostBtnStyle: React.CSSProperties = {
  background: 'transparent', color: '#8aa4d0', border: '1px solid #3a4a6a', borderRadius: 6,
  padding: '5px 10px', fontSize: 11, cursor: 'pointer', flexShrink: 0,
}

const basename = (p: string) => p.split(/[\\/]/).pop() || p

export function EnvironmentsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pool             = useFlowStore((s) => s.pool)
  const environments     = useFlowStore((s) => s.environments)
  const setActiveProfile = useFlowStore((s) => s.setActiveProfile)
  const addProfile       = useFlowStore((s) => s.addProfile)
  const deleteProfile    = useFlowStore((s) => s.deleteProfile)
  const setProfileValue  = useFlowStore((s) => s.setProfileValue)
  const importProfile    = useFlowStore((s) => s.importProfile)
  const addVariable      = useFlowStore((s) => s.addVariable)
  const deleteVariable   = useFlowStore((s) => s.deleteVariable)
  const updateVariable   = useFlowStore((s) => s.updateVariable)

  const [editing, setEditing] = useState('')
  const [msg, setMsg]         = useState<string | null>(null)

  if (!open) return null

  const profileNames = Object.keys(environments.profiles)
  const editingProfile = editing && environments.profiles[editing] ? editing : (profileNames[0] ?? '')
  const poolVars = (pool.variables ?? []).filter((v) => v.type !== 'materialize')
  const profileVars = poolVars.filter((v) => v.type !== 'secret')
  const values = environments.profiles[editingProfile] ?? {}
  const ref = environments.profileRefs[editingProfile]

  const handleAddVar = () => {
    const base = 'nuova_var'; let name = base, i = 2
    const taken = new Set((pool.variables ?? []).map((v) => v.name))
    while (taken.has(name)) { name = `${base}_${i++}` }
    addVariable('pool', null, { name, type: 'string', value: '' })
  }
  const handleAddSecret = () => {
    const base = 'NUOVO_SEGRETO'; let name = base, i = 2
    const taken = new Set((pool.variables ?? []).map((v) => v.name))
    while (taken.has(name)) { name = `${base}_${i++}` }
    addVariable('pool', null, { name, type: 'secret', value: '' })
  }
  const handleAddProfile = () => {
    const name = window.prompt('Nome del nuovo profilo (es. prod):')?.trim()
    if (name) { addProfile(name); setEditing(name) }
  }
  const handleDeleteProfile = () => {
    if (editingProfile && confirm(`Eliminare il profilo «${editingProfile}»?`)) { deleteProfile(editingProfile); setEditing('') }
  }

  // ── file esterno ──────────────────────────────────────────────
  const parseValues = (raw: string): Record<string, string> | null => {
    try {
      const data = JSON.parse(raw)
      const v = (data && typeof data === 'object' && data.values && typeof data.values === 'object') ? data.values : data
      if (!v || typeof v !== 'object' || Array.isArray(v)) return null
      const out: Record<string, string> = {}
      for (const [k, val] of Object.entries(v)) out[k] = String(val)
      return out
    } catch { return null }
  }
  const handleImport = async () => {
    if (!isTauri()) { setMsg('Import disponibile solo nell\'app desktop.'); return }
    const res = await openFileDialog({ title: 'Importa profilo', filters: [{ name: 'Profilo', extensions: ['json'] }, { name: 'Tutti', extensions: ['*'] }] })
    const path = Array.isArray(res) ? res[0] : res
    if (!path) return
    const raw = await readFile(path).catch(() => null)
    const values = raw ? parseValues(raw) : null
    if (!values) { setMsg('File profilo non valido (atteso JSON di coppie nome/valore).'); return }
    let name = 'importato'
    try { const d = JSON.parse(raw as string); name = (d.profile || d.name || basename(path).replace(/\.[^.]+$/, '') || 'importato').trim() } catch { /* usa fallback */ }
    importProfile(name, values, path)
    setEditing(name)
    setMsg(`Profilo «${name}» importato da ${basename(path)}.`)
  }
  const handleExport = async () => {
    if (!isTauri()) { setMsg('Export disponibile solo nell\'app desktop.'); return }
    if (!editingProfile) return
    const path = await saveFileDialog({ title: 'Esporta profilo', defaultPath: `${editingProfile}.env.json`, filters: [{ name: 'Profilo', extensions: ['json'] }] })
    if (!path) return
    const payload = JSON.stringify({ profile: editingProfile, values }, null, 2)
    const ok = await writeFile(path, payload).then(() => true).catch(() => false)
    setMsg(ok ? `Profilo «${editingProfile}» esportato in ${basename(path)}.` : 'Impossibile scrivere il file.')
  }
  const handleReload = async () => {
    if (!ref) return
    const raw = await readFile(ref).catch(() => null)
    const vv = raw ? parseValues(raw) : null
    if (!vv) { setMsg(`Impossibile ricaricare da ${basename(ref)} (file mancante o non valido).`); return }
    importProfile(editingProfile, vv, ref)
    setMsg(`Profilo «${editingProfile}» ricaricato da ${basename(ref)}.`)
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 640, maxWidth: '94vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column', background: '#1e2535', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2a3349', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#c8d4f0' }}>Ambienti</div>
          <button onClick={onClose} title="Chiudi" style={{ background: 'transparent', border: 'none', color: '#9a9aaa', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '12px 16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* 1) Variabili di pool */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div style={labelStyle}>Variabili condivise (pool)</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <button onClick={handleAddVar} style={addBtnStyle}>+ variabile</button>
                <button onClick={handleAddSecret} style={{ ...addBtnStyle, background: '#5a3a10', border: '1px solid #7a5a20' }} title="Aggiungi un segreto (solo il nome; il valore arriva dal keychain a run-time)">+ segreto</button>
              </div>
            </div>
            {poolVars.length === 0 ? (
              <div style={{ fontSize: 11, color: '#4a5a7a', fontStyle: 'italic' }}>Nessuna variabile condivisa. Aggiungine una: sarà referenziabile con <code style={{ color: '#8aa' }}>{'${nome}'}</code> in ogni lane.</div>
            ) : (
              poolVars.map((v) => (
                <div key={v.id} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input value={v.name} onChange={(e) => updateVariable('pool', null, v.id, { name: e.target.value })} placeholder="nome" style={{ ...inputStyle, flex: '0 0 170px' }} />
                  {v.type === 'secret' ? (
                    <div style={{ flex: 1, fontSize: 10, color: '#c8a060', display: 'flex', gap: 6, alignItems: 'center' }}>
                      <i className="ti ti-lock" aria-hidden="true" /> segreto — valore dal keychain a run-time, mai salvato nel file
                    </div>
                  ) : (
                    <input value={v.value} onChange={(e) => updateVariable('pool', null, v.id, { value: e.target.value })} placeholder="valore di default" style={inputStyle} />
                  )}
                  <button onClick={() => deleteVariable('pool', null, v.id)} title="Elimina" style={trashStyle}><i className="ti ti-trash" aria-hidden="true" /></button>
                </div>
              ))
            )}
          </div>

          <div style={{ height: 1, background: '#2a3349' }} />

          {/* 2) Profilo attivo */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Profilo attivo (usato al Run)</div>
            <CustomSelect value={environments.active} onChange={(e) => setActiveProfile(e.target.value)} style={selectStyle}>
              <option value="">(nessuno — valori di default)</option>
              {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </CustomSelect>
          </div>

          {/* 3) Modifica profilo + file esterno */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={labelStyle}>Modifica profilo</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <CustomSelect value={editingProfile} onChange={(e) => setEditing(e.target.value)} style={selectStyle} disabled={profileNames.length === 0}>
                {profileNames.length === 0 && <option value="">— nessun profilo —</option>}
                {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </CustomSelect>
              <button onClick={handleAddProfile} title="Nuovo profilo" style={addBtnStyle}>+ nuovo</button>
              <button onClick={handleDeleteProfile} disabled={!editingProfile} title="Elimina profilo" style={{ ...trashStyle, opacity: editingProfile ? 1 : 0.5, cursor: editingProfile ? 'pointer' : 'default' }}><i className="ti ti-trash" aria-hidden="true" /></button>
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <button onClick={handleImport} style={ghostBtnStyle}><i className="ti ti-file-import" style={{ marginRight: 4 }} aria-hidden="true" />Importa da file…</button>
              <button onClick={handleExport} disabled={!editingProfile} style={{ ...ghostBtnStyle, opacity: editingProfile ? 1 : 0.5, cursor: editingProfile ? 'pointer' : 'default' }}><i className="ti ti-file-export" style={{ marginRight: 4 }} aria-hidden="true" />Esporta…</button>
            </div>
            {ref && (
              <div style={{ fontSize: 10, color: '#5a6a8a', display: 'flex', gap: 6, alignItems: 'center' }}>
                <i className="ti ti-link" aria-hidden="true" /> collegato a <span style={{ color: '#8aa4d0' }}>{basename(ref)}</span>
                <button onClick={handleReload} style={{ background: 'transparent', border: 'none', color: '#3ddc84', cursor: 'pointer', fontSize: 10, textDecoration: 'underline', padding: 0 }}>ricarica</button>
              </div>
            )}
          </div>

          {/* 4) Valori del profilo per variabile */}
          {profileNames.length > 0 && profileVars.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={labelStyle}>Valori per «{editingProfile}» — vuoto = usa il default</div>
              {profileVars.map((v) => (
                <div key={v.id} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ width: 170, fontSize: 11, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</div>
                  <input value={values[v.name] ?? ''} placeholder={v.value ? `default: ${v.value}` : '(default vuoto)'} onChange={(e) => setProfileValue(editingProfile, v.name, e.target.value)} style={inputStyle} />
                </div>
              ))}
            </div>
          )}

          {msg && <div style={{ fontSize: 10, color: '#8aa4d0', background: '#141c2c', border: '1px solid #2a3349', borderRadius: 6, padding: '6px 10px' }}>{msg}</div>}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid #2a3349', fontSize: 10, color: '#5a6a8a' }}>
          I valori stanno nel progetto (Salva). L'import/export su file è opzionale; all'apertura vale sempre il progetto — ricarichi dal file quando vuoi.
        </div>
      </div>
    </div>
  )
}
