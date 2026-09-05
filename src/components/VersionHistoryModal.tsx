/**
 * src/components/VersionHistoryModal.tsx
 *
 * UI del versionamento in-file (vedi P143): legge il ramo `history` dal .ffplan
 * corrente e mostra le versioni con data/etichetta + "Ripristina". In fondo,
 * un campo per salvare un CHECKPOINT con nome (label sulla versione corrente).
 * Il modale non tocca il disco per scrivere: emette le azioni via callback
 * (onRestore / onSaveCheckpoint), la Toolbar le esegue.
 */
import { useEffect, useState } from 'react'
import { readFile, isTauri } from '../lib/tauri'

export interface PlanSnapshot { pool: unknown; nodes: unknown; edges: unknown }
interface VersionStamp { id?: string; savedAt?: string; label?: string }
interface HistoryEntry { version?: VersionStamp; plan: PlanSnapshot }

export function VersionHistoryModal({
  open, onClose, currentPath, onRestore, onSaveCheckpoint, onLabelCurrent, onDeleteVersion,
}: {
  open: boolean
  onClose: () => void
  currentPath: string | null
  onRestore: (plan: PlanSnapshot) => void
  onSaveCheckpoint: (label: string) => Promise<void>
  onLabelCurrent: (label: string) => Promise<void>
  onDeleteVersion: (index: number) => Promise<void>
}) {
  const [current, setCurrent] = useState<VersionStamp | null>(null)
  const [history, setHistory] = useState<HistoryEntry[]>([])
  const [error, setError]     = useState<string | null>(null)
  const [label, setLabel]     = useState('')
  const [currentLabel, setCurrentLabel] = useState('')

  async function refresh() {
    setError(null)
    if (!currentPath || !isTauri()) {
      setCurrent(null); setHistory([])
      if (!currentPath) setError('Salva prima il progetto per avere una cronologia.')
      return
    }
    try {
      const data = JSON.parse(await readFile(currentPath))
      setCurrent(data.version ?? { savedAt: data.savedAt, label: '' })
      setCurrentLabel((data.version?.label ?? '') as string)
      setHistory(Array.isArray(data.history) ? data.history : [])
    } catch {
      setError('Impossibile leggere la cronologia dal file.')
    }
  }

  useEffect(() => {
    if (open) void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, currentPath])

  if (!open) return null

  const fmt = (s?: string) => {
    if (!s) return '—'
    const d = new Date(s)
    return isNaN(d.getTime()) ? s : d.toLocaleString()
  }

  return (
    <div onClick={onClose} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: 520, maxWidth: '92vw', maxHeight: '78vh', display: 'flex', flexDirection: 'column', background: '#1e2535', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>

        <div style={{ padding: '12px 16px', borderBottom: '1px solid #2a3349', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div style={{ fontSize: 13, fontWeight: 600, color: '#c8d4f0' }}>Cronologia versioni</div>
          <button onClick={onClose} title="Chiudi" style={{ background: 'transparent', border: 'none', color: '#9a9aaa', cursor: 'pointer', fontSize: 18, lineHeight: 1 }}>×</button>
        </div>

        <div style={{ padding: '12px 16px', overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {error && (
            <div style={{ fontSize: 11, color: '#c8a060', background: '#2a1a0a', border: '1px solid #855', borderRadius: 6, padding: '8px 10px' }}>{error}</div>
          )}

          {current && (
            <div style={{ background: '#12331f', border: '1px solid #1d6d40', borderRadius: 6, padding: '8px 10px' }}>
              <div style={{ fontSize: 11, color: '#3ddc84', fontWeight: 600, marginBottom: 6 }}>● Corrente</div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input
                  value={currentLabel}
                  onChange={(e) => setCurrentLabel(e.target.value)}
                  placeholder="commento della versione corrente…"
                  style={{ flex: 1, background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4, color: '#c8d4f0', fontSize: 11, padding: '4px 7px', outline: 'none' }}
                />
                <button
                  onClick={async () => { await onLabelCurrent(currentLabel.trim()); await refresh() }}
                  disabled={!currentPath}
                  title="Aggiorna il commento della versione corrente (non crea una nuova versione)"
                  style={{ background: '#1d6d40', color: '#eafff2', border: '1px solid #2a3349', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: currentPath ? 'pointer' : 'default', opacity: currentPath ? 1 : 0.5, flexShrink: 0 }}
                >Salva commento</button>
              </div>
              <div style={{ fontSize: 10, color: '#5a6a8a', marginTop: 4 }}>{fmt(current.savedAt)}</div>
            </div>
          )}

          {!error && history.length === 0 && (
            <div style={{ fontSize: 11, color: '#8593b5', fontStyle: 'italic', padding: '6px 2px' }}>
              Nessuna versione precedente. Ogni salvataggio ne aggiunge una qui.
            </div>
          )}

          {history.map((h, i) => (
            <div key={i} style={{ background: '#1a2030', border: '1px solid #2a3349', borderRadius: 6, padding: '8px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <div style={{ fontSize: 11, color: '#c8d4f0', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {h.version?.label ? h.version.label : `Versione ${history.length - i}`}
                </div>
                <div style={{ fontSize: 10, color: '#5a6a8a' }}>{fmt(h.version?.savedAt)}</div>
              </div>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                <button
                  onClick={() => { if (confirm('Ripristinare questa versione? Le modifiche non salvate andranno perse.')) onRestore(h.plan) }}
                  style={{ background: '#1d6d40', color: '#eafff2', border: '1px solid #2a3349', borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}
                >Ripristina</button>
                <button
                  onClick={async () => { if (confirm('Eliminare questa versione dalla cronologia? L\'operazione non è annullabile.')) { await onDeleteVersion(i); await refresh() } }}
                  title="Elimina questa versione"
                  style={{ background: 'transparent', color: '#8a6a6a', border: '1px solid #4a2a2a', borderRadius: 6, padding: '4px 7px', fontSize: 12, cursor: 'pointer', display: 'flex', alignItems: 'center' }}
                >
                  <i className="ti ti-trash" aria-hidden="true" />
                </button>
              </div>
            </div>
          ))}
        </div>

        <div style={{ padding: '10px 16px', borderTop: '1px solid #2a3349', display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="nome nuovo checkpoint…"
            style={{ flex: 1, background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4, color: '#c8d4f0', fontSize: 11, padding: '5px 8px', outline: 'none' }}
          />
          <button
            onClick={async () => { await onSaveCheckpoint(label.trim()); setLabel(''); await refresh() }}
            disabled={!currentPath}
            title={currentPath ? 'Salva lo stato attuale come versione con nome' : 'Salva prima il progetto'}
            style={{ background: '#1d6d40', color: '#eafff2', border: '1px solid #2a3349', borderRadius: 6, padding: '5px 12px', fontSize: 11, cursor: currentPath ? 'pointer' : 'default', opacity: currentPath ? 1 : 0.5, flexShrink: 0 }}
          >Salva nuovo checkpoint</button>
        </div>
      </div>
    </div>
  )
}
