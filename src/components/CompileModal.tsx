/**
 * src/components/CompileModal.tsx
 *
 * Scheda di COMPILAZIONE / generazione dell'artifact per il runner.
 *   • profilo da CONGELARE (un ambiente per artifact) — imposta il profilo attivo;
 *   • endpoint del MONITOR (URL letterale o riferimento ${MONITOR_URL} risolto a
 *     destinazione) → finisce nel manifesto dell'artifact;
 *   • piattaforma di destinazione (Windows/Linux) — informativa nel manifesto
 *     (la compilazione cross-platform vera avviene in CI);
 *   • MANIFESTO in anteprima: profilo congelato, segreti richiesti, monitor.
 * Il "Genera" costruisce il piano col profilo attivo congelato (buildRustPlan) e
 * salva il `.ffart`. La logica di export sta in Toolbar (onGenerate).
 */
import { useState } from 'react'
import { useFlowStore } from '../store/flowStore'
import { CustomSelect } from './CustomSelect'

const inputStyle: React.CSSProperties = {
  flex: 1, background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace", fontSize: 11, padding: '5px 8px', outline: 'none',
}
const selectStyle: React.CSSProperties = { ...inputStyle, cursor: 'pointer' }
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600,
}

export function CompileModal({ open, onClose, onGenerate }: {
  open: boolean
  onClose: () => void
  onGenerate: (monitorUrl: string, platform: string) => void
}) {
  const environments     = useFlowStore((s) => s.environments)
  const setActiveProfile = useFlowStore((s) => s.setActiveProfile)
  const pool             = useFlowStore((s) => s.pool)

  const [monitorUrl, setMonitorUrl] = useState('')
  const [platform, setPlatform]     = useState('linux')

  if (!open) return null

  const profileNames = Object.keys(environments.profiles)
  const requiredSecrets = (pool.variables ?? []).filter((v) => v.type === 'secret').map((v) => v.name)
  const frozenProfile = environments.active || '(default)'

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column', background: '#1e2535', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2a3349', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#c8d4f0' }}>Compila artifact</div>
          <button onClick={onClose} title="Chiudi" style={{ background: 'transparent', border: 'none', color: '#9a9aaa', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '12px 16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Profilo da congelare */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Profilo da congelare (un ambiente per artifact)</div>
            <CustomSelect value={environments.active} onChange={(e) => setActiveProfile(e.target.value)} style={selectStyle}>
              <option value="">(nessuno — valori di default)</option>
              {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </CustomSelect>
          </div>

          {/* Endpoint monitor */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Monitor — dove pushare i log (opzionale)</div>
            <input value={monitorUrl} onChange={(e) => setMonitorUrl(e.target.value)} placeholder="https://host:porta/ingest  oppure  ${MONITOR_URL}" style={inputStyle} />
            <div style={{ fontSize: 10, color: '#5a6a8a' }}>URL letterale, oppure <code style={{ color: '#8aa' }}>{'${MONITOR_URL}'}</code> risolto sulla macchina di destinazione (come i segreti).</div>
          </div>

          {/* Piattaforma */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Piattaforma di destinazione</div>
            <CustomSelect value={platform} onChange={(e) => setPlatform(e.target.value)} style={selectStyle}>
              <option value="linux">Linux</option>
              <option value="windows">Windows</option>
            </CustomSelect>
          </div>

          <div style={{ height: 1, background: '#2a3349' }} />

          {/* Manifesto in anteprima */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={labelStyle}>Manifesto dell'artifact</div>
            <div style={{ fontSize: 11, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace", background: '#141c2c', border: '1px solid #2a3349', borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div>profilo congelato: <span style={{ color: '#8aa4d0' }}>{frozenProfile}</span></div>
              <div>piattaforma: <span style={{ color: '#8aa4d0' }}>{platform}</span></div>
              <div>monitor: <span style={{ color: '#8aa4d0' }}>{monitorUrl.trim() || '— nessuno —'}</span></div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <span>segreti richiesti:</span>
                {requiredSecrets.length === 0
                  ? <span style={{ color: '#5a6a8a' }}>nessuno</span>
                  : requiredSecrets.map((s) => <span key={s} style={{ color: '#c8a060' }}>🔒 {s}</span>)}
              </div>
            </div>
            {requiredSecrets.length > 0 && (
              <div style={{ fontSize: 10, color: '#c8a060' }}>I valori dei segreti NON sono nell'artifact: vanno forniti sulla macchina di destinazione (keychain o variabili d'ambiente).</div>
            )}
          </div>
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid #2a3349', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ background: 'transparent', color: '#9aa4c0', border: '1px solid #3a4a6a', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer' }}>Annulla</button>
          <button onClick={() => onGenerate(monitorUrl.trim(), platform)} style={{ background: '#1d6d40', color: '#eafff2', border: '1px solid #2a3349', borderRadius: 6, padding: '6px 16px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>Genera →</button>
        </div>
      </div>
    </div>
  )
}
