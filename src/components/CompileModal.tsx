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
import { useState, useEffect } from 'react'
import { invoke } from '@tauri-apps/api/core'
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
  onGenerate: (monitorUrl: string, platform: string, logLevel: string) => void
}) {
  const environments     = useFlowStore((s) => s.environments)
  const setActiveProfile = useFlowStore((s) => s.setActiveProfile)
  const pool             = useFlowStore((s) => s.pool)

  const [monitorUrl, setMonitorUrl] = useState('')
  const [platform, setPlatform]     = useState('linux')
  // Quanto dettaglio esce dalla macchina che esegue (stdout + push al monitor).
  // NON tocca il log completo salvato in locale dal reporter (~/.flowpilot/runs).
  const [logLevel, setLogLevel]     = useState('normale')

  // Identita' dello STUDIO (provenienza): id fisso + etichetta modificabile.
  // Vive in ~/.flowpilot/studio.json, condivisa da tutti i progetti di questa
  // installazione. Caricata all'apertura della scheda.
  const [studioId, setStudioId]       = useState('')
  const [studioLabel, setStudioLabel] = useState('')
  const [labelSaved, setLabelSaved]   = useState(false)

  useEffect(() => {
    if (!open) return
    let vivo = true
    invoke<{ id: string; label: string }>('studio_identity')
      .then((idn) => { if (vivo) { setStudioId(idn.id); setStudioLabel(idn.label); setLabelSaved(false) } })
      .catch(() => { if (vivo) { setStudioId(''); setStudioLabel('') } })
    return () => { vivo = false }
  }, [open])

  const salvaEtichetta = async () => {
    try {
      const idn = await invoke<{ id: string; label: string }>('studio_identity_set_label', { label: studioLabel })
      setStudioId(idn.id); setStudioLabel(idn.label); setLabelSaved(true)
      setTimeout(() => setLabelSaved(false), 1800)
    } catch { /* best-effort: l'export usa comunque il valore su file */ }
  }

  if (!open) return null

  const profileNames = Object.keys(environments.profiles)
  const requiredSecrets = (pool.variables ?? []).filter((v) => v.type === 'secret').map((v) => v.name)
  const frozenProfile = environments.active || '(default)'

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 560, maxWidth: '92vw', maxHeight: '84vh', display: 'flex', flexDirection: 'column', background: '#1e2535', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2a3349', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#c8d4f0' }}>Compila artifact</div>
          <button onClick={onClose} title="Close" style={{ background: 'transparent', border: 'none', color: '#9a9aaa', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '12px 16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 14 }}>

          {/* Profilo da congelare */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Profile to freeze (one environment per artifact)</div>
            <CustomSelect value={environments.active} onChange={(e) => setActiveProfile(e.target.value)} style={selectStyle}>
              <option value="">(none — default values)</option>
              {profileNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </CustomSelect>
          </div>

          {/* Identita' dello studio (provenienza) */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Compilato da — etichetta di questo studio</div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <input
                value={studioLabel}
                onChange={(e) => setStudioLabel(e.target.value)}
                onBlur={salvaEtichetta}
                placeholder="e.g. mark-laptop"
                style={inputStyle}
              />
              <button
                onClick={salvaEtichetta}
                style={{ background: 'transparent', color: labelSaved ? '#4ade80' : '#9aa4c0', border: '1px solid #3a4a6a', borderRadius: 6, padding: '5px 10px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap' }}
              >{labelSaved ? '✓ salvata' : 'Salva'}</button>
            </div>
            <div style={{ fontSize: 10, color: '#5a6a8a' }}>
              Identifica questa <b>installazione</b> nel monitor (id <code style={{ color: '#8aa' }}>{studioId ? studioId.slice(0, 8) + '…' : '—'}</code>).
              Vale per tutti i progetti di questo computer. Non è autenticazione: è un'etichetta di provenienza.
            </div>
          </div>

          {/* Endpoint monitor */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Monitor — where to push logs (optional)</div>
            <input value={monitorUrl} onChange={(e) => setMonitorUrl(e.target.value)} placeholder="https://host:porta/ingest  oppure  ${MONITOR_URL}" style={inputStyle} />
            <div style={{ fontSize: 10, color: '#5a6a8a' }}>URL letterale, oppure <code style={{ color: '#8aa' }}>{'${MONITOR_URL}'}</code> resolved on the target machine (like secrets).</div>
          </div>

          {/* Platform */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Target platform</div>
            <CustomSelect value={platform} onChange={(e) => setPlatform(e.target.value)} style={selectStyle}>
              <option value="linux">Linux</option>
              <option value="windows">Windows</option>
            </CustomSelect>
          </div>

          {/* Livello di dettaglio del log che ESCE dalla macchina */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            <div style={labelStyle}>Detail of the sent log</div>
            <CustomSelect value={logLevel} onChange={(e) => setLogLevel(e.target.value)} style={selectStyle}>
              <option value="essenziale">Essential — ciclo di vita, errori, statistiche</option>
              <option value="normale">Normal — + progress and node messages</option>
              <option value="diagnostico">Diagnostico — tutto, incluse righe e memoria</option>
            </CustomSelect>
            <div style={{ fontSize: 10, color: '#5a6a8a' }}>
              Filter what the runner prints and sends to the monitor. <b>Essential</b> e <b>Normal</b> non
              trasmettono il <b>contenuto delle righe</b> (dati) né i campioni di memoria: usali in produzione.
              Il log completo resta comunque sulla macchina che esegue, in <code style={{ color: '#8aa' }}>~/.flowpilot/runs</code>.
            </div>
          </div>

          <div style={{ height: 1, background: '#2a3349' }} />

          {/* Manifesto in anteprima */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={labelStyle}>Manifesto dell'artifact</div>
            <div style={{ fontSize: 11, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace", background: '#141c2c', border: '1px solid #2a3349', borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div>frozen profile: <span style={{ color: '#8aa4d0' }}>{frozenProfile}</span></div>
              <div>compilato da: <span style={{ color: '#8aa4d0' }}>{studioLabel || '—'}</span></div>
              <div>platform: <span style={{ color: '#8aa4d0' }}>{platform}</span></div>
              <div>dettaglio log: <span style={{ color: '#8aa4d0' }}>{logLevel}</span></div>
              <div>monitor: <span style={{ color: '#8aa4d0' }}>{monitorUrl.trim() || '— nessuno —'}</span></div>
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'baseline' }}>
                <span>required secrets:</span>
                {requiredSecrets.length === 0
                  ? <span style={{ color: '#5a6a8a' }}>nessuno</span>
                  : requiredSecrets.map((s) => <span key={s} style={{ color: '#c8a060' }}>🔒 {s}</span>)}
              </div>
            </div>
            {requiredSecrets.length > 0 && (
              <div style={{ fontSize: 10, color: '#c8a060' }}>Secret values are NOT in the artifact: they must be provided on the target machine (keychain or environment variables).</div>
            )}
          </div>
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid #2a3349', display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button onClick={onClose} style={{ background: 'transparent', color: '#9aa4c0', border: '1px solid #3a4a6a', borderRadius: 6, padding: '6px 14px', fontSize: 12, cursor: 'pointer' }}>Cancel</button>
          <button onClick={() => onGenerate(monitorUrl.trim(), platform, logLevel)} style={{ background: '#1d6d40', color: '#eafff2', border: '1px solid #2a3349', borderRadius: 6, padding: '6px 16px', fontSize: 12, cursor: 'pointer', fontWeight: 600 }}>Generate →</button>
        </div>
      </div>
    </div>
  )
}
