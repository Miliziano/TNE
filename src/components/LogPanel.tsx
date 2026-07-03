/**
 * src/components/LogPanel.tsx
 *
 * Modifiche rispetto alla versione precedente:
 * - Virtualizzazione: renderizza solo le righe visibili nello viewport
 * - Selector specifico su useFlowStore — evita re-render non correlati
 * - Click-to-expand: messaggi lunghi (>80 caratteri) si aprono in overlay
 *   con testo completo, mantenendo la riga in lista troncata e a
 *   altezza fissa (necessaria per la virtualizzazione)
 */
import { useEffect, useRef, useState } from 'react'
import { useFlowStore } from '../store/flowStore'
import type { LogEntry } from '../types'
import { useVirtualList } from '../hooks/useVirtualList'

const ICONS: Record<LogEntry['level'], string> = {
  info:  '●',
  ok:    '✓',
  warn:  '⚠',
  debug:    '||',
  error: '✗',
  done: '✓',
}

const COLORS: Record<LogEntry['level'], string> = {
  info:  '#4a9eff',
  ok:    '#3ddc84',
  warn:  '#ffb347',
  debug: '#9a62b6',
  error: '#ff5f57',
  done:  '#3ddc84',
}

const ROW_HEIGHT = 20  // px — deve corrispondere all'altezza reale renderizzata

export function LogPanel() {
  // Selector specifico — evita re-render su cambi non correlati ai log
  const logs      = useFlowStore((s) => s.logs)
  const clearLogs = useFlowStore((s) => s.clearLogs)

  const { containerRef, visibleRange, totalHeight, offsetY, scrollToBottom, isNearBottom } =
    useVirtualList({ itemCount: logs.length, itemHeight: ROW_HEIGHT, overscan: 10 })

  const wasNearBottomRef = useRef(true)
  // Entry espansa per messaggi lunghi — mostra il testo completo in overlay
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Auto-scroll solo se l'utente era già vicino al fondo —
  // se ha scrollato indietro per leggere, non lo strappiamo via
  useEffect(() => {
    if (wasNearBottomRef.current) scrollToBottom()
  }, [logs.length, scrollToBottom])

  useEffect(() => {
    wasNearBottomRef.current = isNearBottom
  }, [isNearBottom])

  const fmt = (d: Date) => d.toTimeString().slice(0, 8)
  const visibleLogs = logs.slice(visibleRange.start, visibleRange.end)
  const expandedEntry = expandedId ? logs.find((e) => e.id === expandedId) : null

  return (
    <div
      style={{
        height: 130,
        background: '#161b27',
        borderTop: '1px solid #2a3349',
        display: 'flex',
        flexDirection: 'column',
        flexShrink: 0,
        position: 'relative',
      }}
    >
      {/* Header */}
      <div
        style={{
          padding: '4px 12px',
          borderBottom: '1px solid #2a3349',
          fontSize: 10,
          fontWeight: 600,
          color: '#4a5a7a',
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        Execution log
        <span style={{ marginLeft: 8, fontWeight: 400, textTransform: 'none', letterSpacing: 0, color: '#2a3349' }}>
          {logs.length.toLocaleString()} righe
        </span>
        <button
          onClick={clearLogs}
          style={{
            marginLeft: 'auto',
            background: 'none',
            border: 'none',
            color: '#4a5a7a',
            cursor: 'pointer',
            fontSize: 10,
            fontFamily: 'inherit',
          }}
        >
          clear
        </button>
      </div>

      {/* Righe di log — virtualizzate */}
      <div
        ref={containerRef}
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '6px 12px',
          fontFamily: 'monospace',
          fontSize: 11,
          lineHeight: 1.7,
        }}
      >
        <div style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
            {visibleLogs.map((entry) => {
              const isLong = entry.message.length > 80
              return (
                <div key={entry.id} style={{ display: 'flex', gap: 8, height: ROW_HEIGHT, alignItems: 'center' }}>
                  <span style={{ color: '#4a5a7a', flexShrink: 0 }}>
                    {fmt(entry.timestamp)}
                  </span>
                  <span style={{ color: COLORS[entry.level], flexShrink: 0 }}>
                    {ICONS[entry.level]}
                  </span>
                  <span
                    onClick={() => isLong && setExpandedId(entry.id)}
                    title={isLong ? 'Click per vedere il messaggio completo' : undefined}
                    style={{
                      color: entry.level === 'error' ? '#ff5f57'
                           : entry.level === 'warn'  ? '#ffb347'
                           : '#c8d4f0',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      cursor: isLong ? 'pointer' : 'default',
                      display: 'flex', alignItems: 'center', gap: 4, flex: 1, minWidth: 0,
                    }}>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {entry.message}
                    </span>
                    {isLong && (
                      <i className="ti ti-arrows-diagonal" style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }} />
                    )}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Overlay messaggio espanso */}
      {expandedEntry && (
        <div
          onClick={() => setExpandedId(null)}
          style={{
            position: 'fixed', inset: 0, zIndex: 20100,
            background: 'rgba(0,0,0,.6)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 24,
          }}>
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: '#161b27', border: '1px solid #4a5a7a60', borderRadius: 8,
              maxWidth: 720, width: '100%', maxHeight: '70vh',
              display: 'flex', flexDirection: 'column', overflow: 'hidden',
              boxShadow: '0 24px 64px rgba(0,0,0,.8)',
            }}>
            <div style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '10px 14px', background: '#1a2030', borderBottom: '1px solid #2a3349',
            }}>
              <span style={{ color: COLORS[expandedEntry.level], fontSize: 12 }}>
                {ICONS[expandedEntry.level]}
              </span>
              <span style={{ fontSize: 9, color: '#4a5a7a' }}>
                {fmt(expandedEntry.timestamp)}
              </span>
              <span style={{ flex: 1 }} />
              <button onClick={() => setExpandedId(null)}
                style={{ background: 'none', border: '0.5px solid #2a3349', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#4a5a7a', display: 'flex', alignItems: 'center' }}>
                <i className="ti ti-x" style={{ fontSize: 11 }} />
              </button>
            </div>
            <div style={{
              padding: '14px', overflowY: 'auto',
              fontFamily: 'monospace', fontSize: 11,
              color: expandedEntry.level === 'error' ? '#ff5f57'
                   : expandedEntry.level === 'warn'  ? '#ffb347'
                   : '#c8d4f0',
              whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6,
            }}>
              {expandedEntry.message}
            </div>
            <div style={{
              padding: '6px 14px', background: '#1a2030', borderTop: '0.5px solid #2a3349',
              fontSize: 9, color: '#4a5a7a', display: 'flex', alignItems: 'center', gap: 6,
            }}>
              <i className="ti ti-info-circle" style={{ fontSize: 9 }} />
              {expandedEntry.message.length.toLocaleString()} caratteri · click fuori per chiudere
            </div>
          </div>
        </div>
      )}
    </div>
  )
}