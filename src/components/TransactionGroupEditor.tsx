/**
 * src/components/TransactionGroupEditor.tsx
 */
import { useMemo } from 'react'
import { useFlowStore } from '../store/flowStore'
import { CustomSelect } from '../components/CustomSelect'

const TX_NATIVE_COLOR = '#3ddc84'
const TX_XA_COLOR     = '#ffb347'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

export interface TransactionGroupConfig {
  id:      string
  mode:    'native' | 'xa'
  timeout: number
  onError: 'rollback_all' | 'rollback_self'
}

interface Props {
  nodeId:   string
  nodeType: 'sink_db' | 'sink_kafka'
}

export function TransactionGroupEditor({ nodeId }: Props) {
  // ── HOOK — tutti PRIMA di qualsiasi return condizionale ─────────
  // Rules of Hooks: il numero di hook eseguiti deve essere identico
  // a ogni render. L'early return `if (!node) return null` deve
  // quindi stare DOPO tutti gli useMemo, non prima — altrimenti,
  // quando il nodo viene eliminato con l'editor montato, React
  // lancia "Rendered fewer hooks than expected".
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const allNodes   = useFlowStore((s) => s.nodes)
  const pool       = useFlowStore((s) => s.pool)

  // Valori derivati null-safe — usati come dipendenze degli hook
  const rawTx      = node?.data.props?.['transactionGroup'] ?? ''
  const laneId     = node?.data.laneId ?? ''
  const resourceId = node?.data.config?.resourceId ?? ''

  const txConfig: TransactionGroupConfig | null = useMemo(() => {
    try {
      return rawTx ? JSON.parse(rawTx) : null
    } catch { return null }
  }, [rawTx])

  const txId      = txConfig?.id      ?? ''
  const txMode    = txConfig?.mode    ?? 'native'
  const txTimeout = txConfig?.timeout ?? 30
  const txOnError = txConfig?.onError ?? 'rollback_all'

  const groupMembers = useMemo(() => {
    if (!txId || !laneId) return []
    return allNodes.filter((n) => {
      if (n.id === nodeId) return false
      if (n.data.laneId !== laneId) return false
      if (!['sink_db', 'sink_kafka'].includes(n.data.type)) return false
      try {
        const tx = JSON.parse(n.data.props?.['transactionGroup'] ?? '')
        return tx?.id === txId
      } catch { return false }
    })
  }, [allNodes, txId, laneId, nodeId])

  const conflictingMembers = useMemo(() => {
    if (txMode !== 'native' || !txId) return []
    return groupMembers.filter((n) => {
      const resId = n.data.config?.resourceId ?? ''
      return resId !== resourceId
    })
  }, [groupMembers, txMode, resourceId, txId])

  const existingGroups = useMemo(() => {
    const groups = new Set<string>()
    if (!laneId) return []
    allNodes.forEach((n) => {
      if (n.data.laneId !== laneId) return
      if (!['sink_db', 'sink_kafka'].includes(n.data.type)) return
      try {
        const tx = JSON.parse(n.data.props?.['transactionGroup'] ?? '')
        if (tx?.id) groups.add(tx.id)
      } catch {}
    })
    return Array.from(groups)
  }, [allNodes, laneId])

  // ── Early return — SOLO ora che tutti gli hook sono passati ─────
  if (!node) return null

  const isEnabled = txConfig !== null
  const txColor   = txMode === 'xa' ? TX_XA_COLOR : TX_NATIVE_COLOR

  const saveTx = (patch: Partial<TransactionGroupConfig>) => {
    const current = txConfig ?? { id: '', mode: 'native' as const, timeout: 30, onError: 'rollback_all' as const }
    updateProp(nodeId, 'transactionGroup', JSON.stringify({ ...current, ...patch }))
  }

  const enable  = () => saveTx({ id: `tx_${Date.now().toString(36).slice(-4)}`, mode: 'native', timeout: 30, onError: 'rollback_all' })
  const disable = () => updateProp(nodeId, 'transactionGroup', '')

  const lane     = pool.lanes.find((l) => l.id === laneId)
  const resource = lane?.resources.find((r) => r.id === resourceId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Toggle */}
      <div
        style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: isEnabled ? `color-mix(in srgb, ${txColor} 8%, #0f1117)` : '#0f1117', borderRadius: 6, border: `1px solid ${isEnabled ? txColor + '40' : '#2a3349'}`, cursor: 'pointer' }}
        onClick={() => isEnabled ? disable() : enable()}>
        <div style={{ width: 36, height: 20, borderRadius: 10, background: isEnabled ? txColor : '#2a3349', position: 'relative', flexShrink: 0, transition: 'background .2s' }}>
          <div style={{ position: 'absolute', top: 2, left: isEnabled ? 18 : 2, width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'left .2s', boxShadow: '0 1px 3px rgba(0,0,0,.4)' }} />
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: isEnabled ? txColor : '#c8d4f0' }}>
            {isEnabled ? 'Transazione abilitata' : 'Partecipa a una transazione'}
          </div>
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>
            {isEnabled
              ? `Gruppo "${txId}" · ${txMode === 'xa' ? 'XA two-phase commit' : 'transazione nativa'}`
              : 'Il nodo scrive in modo indipendente — nessun coordinamento transazionale'}
          </div>
        </div>
      </div>

      {isEnabled && (
        <>
          {/* Modalità */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              { value: 'native' as const, label: '🔒 Nativa',  color: TX_NATIVE_COLOR, desc: 'Connessione condivisa — stessa risorsa obbligatoria',    detail: 'BEGIN / COMMIT / ROLLBACK su una singola connessione' },
              { value: 'xa'     as const, label: '⚡ XA',       color: TX_XA_COLOR,     desc: 'Two-phase commit — risorse diverse supportate',          detail: 'XA PREPARE → XA COMMIT / XA ROLLBACK su tutti i partecipanti' },
            ].map((m) => (
              <button key={m.value} onClick={() => saveTx({ mode: m.value })}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: txMode === m.value ? `color-mix(in srgb, ${m.color} 12%, #1a2030)` : '#1a2030', border: txMode === m.value ? `1.5px solid ${m.color}` : '1px solid #2a3349' }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: txMode === m.value ? m.color : '#c8d4f0' }}>{m.label}</div>
                <div style={{ fontSize: 9, color: txMode === m.value ? m.color : '#4a5a7a', fontWeight: 600 }}>{m.desc}</div>
                <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.detail}</div>
              </button>
            ))}
          </div>

          {/* Nome gruppo */}
          <Field label="Nome gruppo transazionale" hint="Tutti i sink con lo stesso nome partecipano alla stessa transazione">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <input style={{ ...inputStyle, color: txColor, fontWeight: 600 }}
                value={txId} onChange={(e) => saveTx({ id: e.target.value })}
                placeholder="tx_ordine" />
              {existingGroups.filter((g) => g !== txId).length > 0 && (
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                  <span style={{ fontSize: 9, color: '#4a5a7a', alignSelf: 'center' }}>Gruppi esistenti:</span>
                  {existingGroups.filter((g) => g !== txId).map((g) => (
                    <button key={g} onClick={() => saveTx({ id: g })}
                      style={{ padding: '1px 7px', fontSize: 10, borderRadius: 8, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '1px solid #2a3349', fontFamily: 'monospace' }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = txColor; (e.currentTarget as HTMLElement).style.borderColor = txColor }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a'; (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
                      {g}
                    </button>
                  ))}
                </div>
              )}
            </div>
          </Field>

          {/* Risorsa corrente */}
          {resource && (
            <div style={{ padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${txColor}20`, fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 6, alignItems: 'center' }}>
              <i className="ti ti-database" style={{ fontSize: 10, color: txColor, flexShrink: 0 }} />
              Risorsa: <code style={{ color: txColor }}>{resource.label}</code>
              <span style={{ color: '#2a3349' }}>({resource.kind})</span>
            </div>
          )}

          {/* Partecipanti */}
          {groupMembers.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <div style={{ fontSize: 10, color: txColor, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Partecipanti — {groupMembers.length + 1} nodi
              </div>
              <div style={{ border: `0.5px solid ${txColor}30`, borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: `color-mix(in srgb, ${txColor} 8%, #1a2030)` }}>
                  <div style={{ width: 6, height: 6, borderRadius: '50%', background: txColor, flexShrink: 0 }} />
                  <code style={{ fontFamily: 'monospace', fontSize: 10, color: txColor, flex: 1 }}>
                    {node.data.config?.displayName || node.data.label} <span style={{ color: '#4a5a7a' }}>(questo nodo)</span>
                  </code>
                  {resource && <span style={{ fontSize: 9, color: '#4a5a7a' }}>{resource.label}</span>}
                </div>
                {groupMembers.map((m, i) => {
                  const mResId       = m.data.config?.resourceId ?? ''
                  const mRes         = lane?.resources.find((r) => r.id === mResId)
                  const hasConflict  = txMode === 'native' && mResId !== resourceId
                  return (
                    <div key={m.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderTop: `0.5px solid ${txColor}20` }}>
                      <div style={{ width: 6, height: 6, borderRadius: '50%', background: hasConflict ? '#ff5f57' : txColor, flexShrink: 0 }} />
                      <code style={{ fontFamily: 'monospace', fontSize: 10, color: hasConflict ? '#ff5f57' : '#c8d4f0', flex: 1 }}>
                        {m.data.config?.displayName || m.data.label}
                      </code>
                      {mRes && <span style={{ fontSize: 9, color: hasConflict ? '#ff5f57' : '#4a5a7a' }}>{mRes.label}</span>}
                      {hasConflict && <i className="ti ti-alert-triangle" style={{ fontSize: 10, color: '#ff5f57' }} />}
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {/* Warning native con risorse diverse */}
          {txMode === 'native' && conflictingMembers.length > 0 && (
            <div style={{ padding: '8px 12px', background: '#1a0000', borderRadius: 6, border: '1px solid #ff5f5740', fontSize: 10, color: '#ff5f57', lineHeight: 1.5 }}>
              <i className="ti ti-alert-circle" style={{ fontSize: 11, marginRight: 6 }} />
              <strong>Conflitto risorsa</strong> — in modalità nativa tutti i partecipanti devono usare la stessa risorsa.
              {conflictingMembers.length === 1
                ? ` Il nodo "${conflictingMembers[0].data.config?.displayName || conflictingMembers[0].data.label}" usa una risorsa diversa.`
                : ` ${conflictingMembers.length} nodi usano risorse diverse.`}
              {' '}Cambia modalità in <strong>XA</strong> per supportare risorse eterogenee.
            </div>
          )}

          {/* Info XA */}
          {txMode === 'xa' && (
            <div style={{ padding: '8px 12px', background: '#1a1000', borderRadius: 6, border: `0.5px solid ${TX_XA_COLOR}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
              <div style={{ color: TX_XA_COLOR, fontWeight: 600, marginBottom: 4 }}>⚡ XA Two-Phase Commit</div>
              Supporto XA per dialetto:
              <div style={{ marginTop: 4, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {[
                  { db: 'PostgreSQL', ok: true  },
                  { db: 'MySQL',      ok: true  },
                  { db: 'Oracle',     ok: true  },
                  { db: 'SQL Server', ok: true  },
                  { db: 'SQLite',     ok: false },
                  { db: 'Kafka',      ok: true  },
                ].map((item) => (
                  <span key={item.db} style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: item.ok ? '#0d3d20' : '#1a0000', color: item.ok ? '#3ddc84' : '#ff5f57', border: `0.5px solid ${item.ok ? '#1d6d40' : '#3d1010'}` }}>
                    {item.ok ? '✓' : '✗'} {item.db}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* Opzioni */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Timeout (secondi)" hint="Rollback automatico se la transazione supera questo tempo">
              <input type="number" style={inputStyle} value={txTimeout} min={1} max={3600}
                onChange={(e) => saveTx({ timeout: parseInt(e.target.value) || 30 })} />
            </Field>
            <Field label="In caso di errore">
              <CustomSelect style={inputStyle} value={txOnError}
                onChange={(e) => saveTx({ onError: e.target.value as 'rollback_all' | 'rollback_self' })}>
                <option value="rollback_all">Rollback su tutti i partecipanti</option>
                <option value="rollback_self">Rollback solo su questo nodo</option>
              </CustomSelect>
            </Field>
          </div>

          {/* Riepilogo */}
          <div style={{ padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${txColor}20`, fontSize: 9, fontFamily: 'monospace', color: '#4a5a7a', lineHeight: 1.8 }}>
            {txMode === 'native' ? (
              <>
                <span style={{ color: txColor }}>BEGIN</span> — tutti i sink del gruppo <code style={{ color: txColor }}>{txId || '?'}</code> aprono una transazione condivisa<br />
                <span style={{ color: txColor }}>COMMIT</span> — se tutti completano con successo<br />
                <span style={{ color: '#ff5f57' }}>ROLLBACK</span> — se uno fallisce → {txOnError === 'rollback_all' ? 'rollback su tutti' : 'rollback solo su questo'}
              </>
            ) : (
              <>
                <span style={{ color: TX_XA_COLOR }}>XA START</span> '{txId || '?'}' — su tutte le risorse del gruppo<br />
                <span style={{ color: TX_XA_COLOR }}>XA PREPARE</span> — fase 1: tutte le risorse confermano la disponibilità<br />
                <span style={{ color: TX_XA_COLOR }}>XA COMMIT</span> / <span style={{ color: '#ff5f57' }}>XA ROLLBACK</span> — fase 2: commit o rollback coordinato
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}