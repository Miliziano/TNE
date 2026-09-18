import { useEffect, useState, type CSSProperties } from 'react'
import { invoke } from '@tauri-apps/api/core'

// Finestra dedicata alla CHIAVE DI FIRMA (vault cifrato, HANDOFF-firma-artifact §7).
// Genera/importa la chiave, imposta la passphrase, sblocca/blocca per la sessione,
// ed esporta la chiave PUBBLICA (voce pronta per il trust store della runtime).
// La chiave privata resta cifrata su disco e, quando sbloccata, solo in memoria
// del backend: la webview non la vede mai.

type Status = { exists: boolean; unlocked: boolean; keyId: string | null; publicKey: string | null }
type Identity = { keyId: string; publicKey: string }

const overlay: CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
  display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000,
}
const panel: CSSProperties = {
  width: 560, maxWidth: '92vw', maxHeight: '88vh', overflowY: 'auto',
  background: '#0f1626', border: '1px solid #26324c', borderRadius: 12,
  padding: 20, color: '#dbe4f5', boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
}
const label: CSSProperties = { fontSize: 12, color: '#9fb0d4', fontWeight: 600 }
const input: CSSProperties = {
  background: '#0a1220', border: '1px solid #2a3550', borderRadius: 6,
  padding: '7px 9px', color: '#e6edfb', fontSize: 13, width: '100%', boxSizing: 'border-box',
}
const btn: CSSProperties = {
  background: '#1b294a', color: '#dbe4f5', border: '1px solid #33436a',
  borderRadius: 6, padding: '7px 12px', fontSize: 12, cursor: 'pointer', whiteSpace: 'nowrap',
}
const btnGhost: CSSProperties = { ...btn, background: 'transparent', color: '#9aa4c0' }
const mono: CSSProperties = { fontFamily: "'JetBrains Mono', monospace", fontSize: 11, wordBreak: 'break-all' }

export function SigningKeyModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [status, setStatus]         = useState<Status | null>(null)
  const [passphrase, setPassphrase] = useState('')
  const [seed, setSeed]             = useState('')
  const [showReplace, setShowReplace] = useState(false)
  const [busy, setBusy]             = useState(false)
  const [err, setErr]               = useState('')
  const [copied, setCopied]         = useState(false)

  const refresh = async () => {
    try { setStatus(await invoke<Status>('vault_status')) } catch (e) { setErr(msg(e)) }
  }
  useEffect(() => {
    if (!open) return
    setErr(''); setPassphrase(''); setSeed(''); setShowReplace(false)
    refresh()
  }, [open])

  if (!open) return null

  const msg = (e: unknown) => (typeof e === 'string' ? e : (e as Error)?.message ?? String(e))
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return
    setBusy(true); setErr('')
    try { await fn(); setPassphrase(''); setSeed(''); await refresh() }
    catch (e) { setErr(msg(e)) }
    finally { setBusy(false) }
  }

  const generate = () => run(() => invoke<Identity>('vault_generate', { passphrase }))
  const importSeed = () => run(() => invoke<Identity>('vault_import', { seed, passphrase }))
  const unlock = () => run(() => invoke<Identity>('vault_unlock', { passphrase }))
  const lock = () => run(() => invoke('vault_lock'))

  const trustEntry = status?.keyId
    ? JSON.stringify({ keyId: status.keyId, publicKey: status.publicKey, owner: '', status: 'active' }, null, 2)
    : ''
  const copiaTrust = async () => {
    try { await navigator.clipboard.writeText(trustEntry); setCopied(true); setTimeout(() => setCopied(false), 1800) } catch { /* selezionabile a mano */ }
  }

  const passField = (
    <input
      type="password" value={passphrase} placeholder="passphrase"
      onChange={(e) => setPassphrase(e.target.value)} style={input} autoFocus
    />
  )

  return (
    <div style={overlay} onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div style={panel}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
          <div style={{ fontSize: 15, fontWeight: 700 }}>Signing key</div>
          <button onClick={onClose} style={{ ...btnGhost, padding: '2px 8px' }}>✕</button>
        </div>

        {/* Stato */}
        <div style={{ marginBottom: 14, fontSize: 12, color: '#c8d4f0' }}>
          {status == null ? '…' : status.exists ? (
            <>
              <div>keyId: <span style={{ ...mono, color: '#8aa4d0' }}>{status.keyId}</span></div>
              <div style={{ marginTop: 4 }}>
                status: {status.unlocked
                  ? <span style={{ color: '#4ade80' }}>unlocked (this session)</span>
                  : <span style={{ color: '#f0b74a' }}>locked — passphrase required</span>}
              </div>
            </>
          ) : <span style={{ color: '#f0b74a' }}>No signing key on this computer.</span>}
        </div>

        {err && <div style={{ marginBottom: 12, color: '#ff8a8a', fontSize: 12 }}>{err}</div>}

        {/* Nessuna chiave → crea */}
        {status && !status.exists && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={label}>Create the signing key</div>
            {passField}
            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={generate} disabled={busy || !passphrase} style={btn}>Generate from system</button>
            </div>
            <div style={{ ...label, marginTop: 6 }}>or import a key (Ed25519 seed, base64 32 bytes)</div>
            <textarea value={seed} placeholder="seed base64" onChange={(e) => setSeed(e.target.value)} rows={2} style={{ ...input, ...mono, resize: 'vertical' }} />
            <div><button onClick={importSeed} disabled={busy || !passphrase || !seed} style={btn}>Import and encrypt</button></div>
            <div style={{ fontSize: 10, color: '#5a6a8a' }}>
              The passphrase encrypts the key at rest. <b>If you forget it the key is unrecoverable</b>: you will have to generate a new one and re-authorize it.
            </div>
          </div>
        )}

        {/* Chiave presente ma bloccata → sblocca */}
        {status?.exists && !status.unlocked && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={label}>Unlock for this session</div>
            {passField}
            <div><button onClick={unlock} disabled={busy || !passphrase} style={btn}>Unlock</button></div>
          </div>
        )}

        {/* Chiave sbloccata → blocca */}
        {status?.exists && status.unlocked && (
          <div style={{ marginBottom: 4 }}>
            <button onClick={lock} disabled={busy} style={btnGhost}>Lock now</button>
          </div>
        )}

        {/* Esporta pubblica (sempre disponibile se c'è una chiave) */}
        {status?.exists && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 16 }}>
            <div style={label}>Export the public key (for the runtime trust store)</div>
            <textarea readOnly value={trustEntry} rows={6} style={{ ...input, ...mono, resize: 'vertical', whiteSpace: 'pre' }} />
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button onClick={copiaTrust} style={{ ...btnGhost, color: copied ? '#4ade80' : '#9aa4c0' }}>{copied ? '✓ copied' : 'Copy trust store entry'}</button>
              <span style={{ fontSize: 10, color: '#5a6a8a' }}>Paste into the <code>keys</code> array of the runtime's trust-store.json.</span>
            </div>
          </div>
        )}

        {/* Sostituisci chiave (avanzato) */}
        {status?.exists && (
          <div style={{ marginTop: 18, borderTop: '1px solid #26324c', paddingTop: 12 }}>
            <button onClick={() => setShowReplace((v) => !v)} style={btnGhost}>{showReplace ? '▾' : '▸'} Replace the key</button>
            {showReplace && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
                <div style={{ fontSize: 10, color: '#f0b74a' }}>
                  Warning: overwrites the current key with a <b>new identity</b> (different keyId). Runtimes will have to re-authorize it; revoke the old one if compromised.
                </div>
                {passField}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={generate} disabled={busy || !passphrase} style={btn}>Generate new</button>
                </div>
                <textarea value={seed} placeholder="seed base64 (to import)" onChange={(e) => setSeed(e.target.value)} rows={2} style={{ ...input, ...mono, resize: 'vertical' }} />
                <div><button onClick={importSeed} disabled={busy || !passphrase || !seed} style={btn}>Import new</button></div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
