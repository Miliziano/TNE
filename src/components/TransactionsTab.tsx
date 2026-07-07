/**
 * src/components/TransactionsTab.tsx
 *
 * Tab "Transazioni" nel PropertyPanel — la transazione è un oggetto di
 * lane (design-transazioni-v2). Mostra le transazioni di ogni lane, con
 * configurazione centralizzata (mode/timeout/onError) e i nodi membri
 * DERIVATI (i sink con props.transactionId = quella transazione).
 * Sostituisce il tab "Pool".
 */
import { useMemo } from 'react'
import { useFlowStore } from '../store/flowStore'
import type { LaneTransaction } from '../types'
import { CustomSelect } from './CustomSelect'

const NATIVE_COLOR = '#34d399'
const XA_COLOR     = '#f59e0b'

export function TransactionsTab() {
  const nodes             = useFlowStore((s) => s.nodes)
  const pool              = useFlowStore((s) => s.pool)
  const selectNode        = useFlowStore((s) => s.selectNode)
  const selectLane        = useFlowStore((s) => s.selectLane)
  const addTransaction    = useFlowStore((s) => s.addTransaction)
  const deleteTransaction = useFlowStore((s) => s.deleteTransaction)
  const updateTransaction = useFlowStore((s) => s.updateTransaction)

  // Membri derivati: per ogni transazione, i nodi con transactionId = id.
  const membersByTx = useMemo(() => {
    const map: Record<string, { id: string; label: string; laneId: string }[]> = {}
    for (const n of nodes) {
      const txId = n.data.props?.['transactionId']
      if (txId) {
        (map[txId] ??= []).push({
          id: n.id,
          label: n.data.config?.displayName || n.data.label || n.data.type,
          laneId: n.data.laneId,
        })
      }
    }
    return map
  }, [nodes])

  const navigateTo = (nodeId: string, laneId: string) => {
    selectLane(laneId)
    selectNode(nodeId)
  }

  const inp: React.CSSProperties = {
    background: '#0f1117', border: '1px solid #2a3349', borderRadius: 4,
    color: '#c8d4f0', fontSize: 11, padding: '4px 6px', width: '100%',
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14, padding: 12, overflow: 'auto' }}>
      {pool.lanes.map((lane) => {
        const txs = lane.transactions ?? []
        return (
          <div key={lane.id}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: lane.color }}>
                {lane.label}
              </span>
              <button
                onClick={() => addTransaction(lane.id, {
                  name: `Transazione ${txs.length + 1}`,
                  mode: 'native', timeout: 30, onError: 'rollback_all',
                })}
                style={{ fontSize: 10, color: NATIVE_COLOR, background: 'transparent',
                         border: `1px solid ${NATIVE_COLOR}40`, borderRadius: 4,
                         padding: '3px 8px', cursor: 'pointer' }}>
                + Transazione
              </button>
            </div>

            {txs.length === 0 && (
              <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', padding: '4px 0' }}>
                Nessuna transazione in questa lane.
              </div>
            )}

            {txs.map((tx: LaneTransaction) => {
              const color   = tx.mode === 'xa' ? XA_COLOR : NATIVE_COLOR
              const members = membersByTx[tx.id] ?? []
              return (
                <div key={tx.id} style={{ background: '#0f1117', border: `1px solid ${color}40`,
                                          borderRadius: 6, padding: 10, marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                    <input
                      value={tx.name}
                      onChange={(e) => updateTransaction(lane.id, tx.id, { name: e.target.value })}
                      style={{ ...inp, fontWeight: 600, color, flex: 1 }} />
                    <button
                      onClick={() => deleteTransaction(lane.id, tx.id)}
                      style={{ fontSize: 10, color: '#f87171', background: 'transparent',
                               border: 'none', cursor: 'pointer' }}>
                      elimina
                    </button>
                  </div>

                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6, marginBottom: 8 }}>
                    <label style={{ fontSize: 9, color: '#9a9aaa' }}>
                      Modalità
                      <CustomSelect value={tx.mode}
                        onChange={(e) => updateTransaction(lane.id, tx.id, { mode: e.target.value as 'native' | 'xa' })}
                        style={inp}>
                        <option value="native">Native (una risorsa)</option>
                        <option value="xa">XA (più risorse)</option>
                      </CustomSelect>
                    </label>
                    <label style={{ fontSize: 9, color: '#9a9aaa' }}>
                      Timeout (s)
                      <input type="number" value={tx.timeout} min={1}
                        onChange={(e) => updateTransaction(lane.id, tx.id, { timeout: parseInt(e.target.value) || 30 })}
                        style={inp} />
                    </label>
                  </div>

                  <label style={{ fontSize: 9, color: '#9a9aaa', display: 'block', marginBottom: 8 }}>
                    Su errore
                    <CustomSelect value={tx.onError}
                      onChange={(e) => updateTransaction(lane.id, tx.id, { onError: e.target.value as 'rollback_all' | 'rollback_self' })}
                      style={inp}>
                      <option value="rollback_all">Rollback dell'intero gruppo</option>
                      <option value="rollback_self">Rollback solo del nodo in errore</option>
                    </CustomSelect>
                  </label>

                  <div style={{ fontSize: 9, color: '#9a9aaa', marginBottom: 4 }}>
                    Nodi membri ({members.length})
                  </div>
                  {members.length === 0 ? (
                    <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>
                      Nessun nodo. Associa un DB sink a questa transazione dal suo pannello.
                    </div>
                  ) : (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                      {members.map((m) => (
                        <button key={m.id}
                          onClick={() => navigateTo(m.id, m.laneId)}
                          style={{ textAlign: 'left', fontSize: 10, color: '#c8d4f0',
                                   background: '#161b27', border: '1px solid #2a3349',
                                   borderRadius: 4, padding: '4px 6px', cursor: 'pointer' }}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
