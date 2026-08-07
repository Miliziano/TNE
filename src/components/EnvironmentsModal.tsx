/**
 * src/components/EnvironmentsModal.tsx
 *
 * UI dei profili ambiente (vedi P149 per il motore). Un profilo = value-set
 * (test/dev/prod) che rimpiazza i VALORI delle variabili di POOL al run.
 *   • selettore del profilo ATTIVO (o nessuno → valori di default);
 *   • crea / elimina profili;
 *   • per il profilo in modifica, un valore per ogni variabile di pool
 *     (placeholder = valore di default della variabile).
 * Legge/scrive lo store direttamente. I profili si persistono col progetto (Salva).
 */
import { useState } from 'react'
import { useFlowStore } from '../store/flowStore'

const inputStyle: React.CSSProperties = {
  flex: 1, background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: '5px 8px', outline: 'none',
}
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600,
}

export function EnvironmentsModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const pool             = useFlowStore((s) => s.pool)
  const environments     = useFlowStore((s) => s.environments)
  const setActiveProfile = useFlowStore((s) => s.setActiveProfile)
  const addProfile       = useFlowStore((s) => s.addProfile)
  const deleteProfile    = useFlowStore((s) => s.deleteProfile)
  const setProfileValue  = useFlowStore((s) => s.setProfileValue)

  const [editing, setEditing] = useState('')

  if (!open) return null

  const profileNames = Object.keys(environments.profiles)
  const editingProfile = editing && environments.profiles[editing] ? editing : (profileNames[0] ?? '')
  const vars = (pool.variables ?? []).filter((v) => v.type !== 'materialize')
  const values = environments.profiles[editingProfile] ?? {}

  const handleAdd = () => {
    const name = window.prompt('Nome del nuovo profilo (es. prod):')?.trim()
    if (name) { addProfile(name); setEditing(name) }
  }
  const handleDelete = () => {
    if (editingProfile && confirm(`Eliminare il profilo «${editingProfile}»?`)) {
      deleteProfile(editingProfile); setEditing('')
    }
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', maxHeight: '80vh', display: 'flex', flexDirection: 'column', background: '#1e2535', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2a3349', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#c8d4f0' }}>Ambienti / Profili</div>
          <button onClick={onClose} title="Chiudi" style={{ background: 'transparent', border: 'none', color: '#9a9aaa', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '12px 16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 12 }}>

          {/* Profilo attivo */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Profilo attivo (usato al Run)</div>
            <select value={environments.active} onChange={(e) => setActiveProfile(e.target.value)} style={selectStyle}>
              <option value="">(nessuno — valori di default)</option>
              {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </div>

          <div style={{ height: 1, background: '#2a3349' }} />

          {/* Profilo in modifica */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Modifica profilo</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <select value={editingProfile} onChange={(e) => setEditing(e.target.value)} style={selectStyle} disabled={profileNames.length === 0}>
                {profileNames.length === 0 && <option value="">— nessun profilo —</option>}
                {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
              </select>
              <button onClick={handleAdd} title="Nuovo profilo" style={{ background: '#1d6d40', color: '#eafff2', border: '1px solid #2a3349', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', flexShrink: 0 }}>+ nuovo</button>
              <button onClick={handleDelete} disabled={!editingProfile} title="Elimina profilo" style={{ background: 'transparent', color: '#8a6a6a', border: '1px solid #4a2a2a', borderRadius: 6, padding: '5px 8px', fontSize: 12, cursor: editingProfile ? 'pointer' : 'default', opacity: editingProfile ? 1 : 0.5, flexShrink: 0, display: 'flex', alignItems: 'center' }}>
                <i className="ti ti-trash" aria-hidden="true" />
              </button>
            </div>
          </div>

          {/* Valori del profilo per variabile di pool */}
          {profileNames.length === 0 ? (
            <div style={{ fontSize: 11, color: '#4a5a7a', fontStyle: 'italic' }}>Nessun profilo. Creane uno con «+ nuovo» (es. test, dev, prod).</div>
          ) : vars.length === 0 ? (
            <div style={{ fontSize: 11, color: '#c8a060', background: '#2a1a0a', border: '1px solid #855', borderRadius: 6, padding: '8px 10px' }}>
              Nessuna variabile di pool. Definisci prima le variabili condivise a livello di pool: sono quelle che i profili sovrascrivono.
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div style={labelStyle}>Valori per «{editingProfile}» — vuoto = usa il default</div>
              {vars.map((v) => (
                <div key={v.name} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <div style={{ width: 150, fontSize: 11, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace", overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.name}</div>
                  <input
                    value={values[v.name] ?? ''}
                    placeholder={v.value ? `default: ${v.value}` : '(default vuoto)'}
                    onChange={(e) => setProfileValue(editingProfile, v.name, e.target.value)}
                    style={inputStyle}
                  />
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid #2a3349', fontSize: 10, color: '#5a6a8a' }}>
          I profili si salvano col progetto. Il profilo attivo determina i valori usati al Run.
        </div>
      </div>
    </div>
  )
}
