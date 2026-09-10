/**
 * src/nodes/types/error_handler/MappingPanel.tsx
 *
 * Griglia "Nodi della lane" — sostituisce il tab Mapping per il nodo
 * Error Handler. Vista centralizzata per assegnare a ogni nodo della
 * lane la policy di errore (onError/retry) e due flag specifici
 * dell'Error Handler:
 *
 *  - excludeFromErrorLog: 'true'|'false' — se 'true', gli errori di
 *    questo nodo NON vengono inviati in copia a error_out anche se
 *    'Log centralizzato' è attivo (utile per nodi di puro logging,
 *    il cui fallimento non deve intasare l'audit trail).
 *
 *  - critical: 'true'|'false' — se 'true', un errore di questo nodo
 *    forza l'interruzione della lane indipendentemente dalla policy
 *    onError globale (override puntuale "questo nodo non può fallire
 *    silenziosamente").
 *
 * Entrambi i flag vivono in node.data.config.advanced — stessa fonte
 * di dati di onError/retryCount, quindi nessuna duplicazione.
 */

import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { normalizeOnError, onErrorEmitsCatch } from '../../../types'
import { NODE_DEFS } from '../../registry'

const ERR_COLOR = '#ff5f57'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '4px 6px', outline: 'none',
}

const HEADER_COLS = '24px 1fr 150px 64px 110px 90px 32px'

function InfoBox({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: '7px 10px', background: `color-mix(in srgb, ${ERR_COLOR} 6%, #0f1117)`, borderRadius: 4, border: `0.5px solid ${ERR_COLOR}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

export function ErrorHandlerNodesPanel({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const nodes          = useFlowStore((s) => s.nodes)
  const updateAdvanced = useFlowStore((s) => s.updateNodeAdvanced)

  if (!node) return null
  const laneId = node.data.laneId

  const laneNodes = nodes.filter((n) =>
    n.data.laneId === laneId &&
    n.data.type !== 'error_handler' &&
    n.data.type !== 'lane_start' &&
    n.data.type !== 'lane_end'
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${ERR_COLOR} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${ERR_COLOR}30` }}>
        <i className="ti ti-list-details" style={{ fontSize: 16, color: ERR_COLOR }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: ERR_COLOR }}>Lane nodes — error policy</div>
          <div style={{ fontSize: 9, color: '#8593b5' }}>Configure error handling for each node without opening the individual editors</div>
        </div>
      </div>

      <InfoBox>
        <strong style={{ color: '#c8d4f0' }}>Exclude from log</strong>: the error of this node is not copied to{' '}
        <code style={{ color: ERR_COLOR }}>error_out</code> even if "Centralized log" is active.{' '}
        <strong style={{ color: '#c8d4f0' }}>Critical</strong>: an error here always forces the lane to stop,
        regardless of the <code style={{ color: ERR_COLOR }}>onError</code> policy set.
      </InfoBox>

      {laneNodes.length === 0 && (
        <div style={{ padding: '20px', textAlign: 'center', color: '#8593b5', fontSize: 12, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          No node in this lane.
        </div>
      )}

      {laneNodes.length > 0 && (
        <div style={{ border: '1px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: HEADER_COLS, gap: 8, padding: '6px 10px', background: '#1a2030', borderBottom: '1px solid #3a4a6a', alignItems: 'center' }}>
            <div />
            <div style={{ fontSize: 10, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Node</div>
            <div style={{ fontSize: 10, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>On error</div>
            <div style={{ fontSize: 10, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>Retry</div>
            <div style={{ fontSize: 10, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, textAlign: 'center' }}>Exclude from log</div>
            <div style={{ fontSize: 10, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, textAlign: 'center' }}>Critical</div>
            <div />
          </div>

          {/* Righe */}
          {laneNodes.map((n, idx) => {
            const def      = NODE_DEFS[n.data.type]
            const adv      = n.data.config.advanced
            const onError  = normalizeOnError(adv?.onError)
            const exclude  = (adv as any)?.excludeFromErrorLog ?? 'false'
            const critical = (adv as any)?.critical ?? 'false'
            const displayName = n.data.config.displayName || def?.label || n.data.label

            return (
              <div key={n.id} style={{
                display: 'grid', gridTemplateColumns: HEADER_COLS, gap: 8, alignItems: 'center',
                padding: '6px 10px',
                background: idx % 2 === 0 ? '#1a2030' : '#1e2535',
                borderBottom: idx < laneNodes.length - 1 ? '0.5px solid #2a3349' : 'none',
              }}>
                {/* Icona */}
                <span style={{ fontSize: 13, color: def?.color ?? '#9a9aaa', textAlign: 'center' }}>{def?.icon ?? '⬡'}</span>

                {/* Nome + tipo */}
                <div style={{ overflow: 'hidden' }}>
                  <div style={{ fontSize: 11, color: '#c8d4f0', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {displayName}
                  </div>
                  <div style={{ fontSize: 9, color: '#8593b5', fontFamily: 'monospace' }}>{n.data.type}</div>
                </div>

                {/* onError */}
                <CustomSelect style={inputStyle} value={onError}
                  onChange={(e) => updateAdvanced(n.id, 'onError', e.target.value)}>
                  <option value="handler">Error handler</option>
                  <option value="catch">Catch</option>
                  <option value="retry_handler">Retry → handler</option>
                  <option value="retry_catch">Retry → catch</option>
                </CustomSelect>

                {/* Retry count */}
                {(onError === 'retry_handler' || onError === 'retry_catch') ? (
                  <input type="number" min="1" style={inputStyle}
                    value={adv?.retryCount ?? '0'}
                    onChange={(e) => updateAdvanced(n.id, 'retryCount', e.target.value)} />
                ) : (
                  <div style={{ fontSize: 10, color: '#3a4a6a', textAlign: 'center' }}>—</div>
                )}

                {/* Escludi dal log */}
                <div style={{ textAlign: 'center' }}>
                  <input type="checkbox" checked={exclude === 'true'}
                    style={{ accentColor: ERR_COLOR, width: 14, height: 14, cursor: 'pointer' }}
                    onChange={(e) => updateAdvanced(n.id, 'excludeFromErrorLog' as any, e.target.checked ? 'true' : 'false')} />
                </div>

                {/* Critico — ha senso solo se l'errore va all'handler.
                    In modalità cattura (catch/retry_catch) l'errore non passa
                    dall'handler → disabilitato. */}
                <div style={{ textAlign: 'center' }}>
                  <input type="checkbox"
                    checked={critical === 'true' && !onErrorEmitsCatch(onError)}
                    disabled={onErrorEmitsCatch(onError)}
                    title={onErrorEmitsCatch(onError)
                      ? 'Not applicable: the node catches errors itself, they do not pass through the error handler'
                      : 'An error from this node, after the handler completes, stops the pipeline'}
                    style={{ accentColor: ERR_COLOR, width: 14, height: 14,
                      cursor: onErrorEmitsCatch(onError) ? 'not-allowed' : 'pointer',
                      opacity: onErrorEmitsCatch(onError) ? 0.35 : 1 }}
                    onChange={(e) => updateAdvanced(n.id, 'critical' as any, e.target.checked ? 'true' : 'false')} />
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
