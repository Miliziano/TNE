/**
 * src/components/LogViewerWindow.tsx
 *
 * Modifiche rispetto alla versione precedente:
 * - Virtualizzazione: renderizza solo le righe visibili nello viewport
 * - Il separatore "nuova sessione" viene gestito come riga virtuale
 *   aggiuntiva nel calcolo dell'altezza totale, non come elemento extra
 *   nel DOM al di fuori del sistema di virtualizzazione
 * - Altezza riga fissa per permettere il calcolo virtuale
 */
import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import { useLogViewerStore } from '../store/useLogViewerStore'
import { useVirtualList } from '../hooks/useVirtualList'

const ACCENT = '#a78bfa'
const BG     = '#0f1117'
const BG2    = '#161b27'
const BG3    = '#1a2030'
const BORDER = '#2a3349'

const LEVEL_COLORS = {
  info:  '#c8d4f0',
  ok:    '#3ddc84',
  warn:  '#ffb347',
  error: '#ff5f57',
  debug: '#4a5a7a',
}

const ROW_HEIGHT = 22       // px — altezza riga normale
const SEPARATOR_HEIGHT = 24 // px — altezza riga "nuova sessione"

const SCROLLBAR_CSS = `
  .log-viewer-body::-webkit-scrollbar {
    width: 10px;
  }
  .log-viewer-body::-webkit-scrollbar-track {
    background: #0f1117;
  }
  .log-viewer-body::-webkit-scrollbar-thumb {
    background: #2a3349;
    border-radius: 4px;
    border: 2px solid #0f1117;
  }
  .log-viewer-body::-webkit-scrollbar-thumb:hover {
    background: #3a4a6a;
  }
`

let scrollbarStyleInjected = false
function ensureScrollbarStyle() {
  if (scrollbarStyleInjected) return
  const style = document.createElement('style')
  style.textContent = SCROLLBAR_CSS
  document.head.appendChild(style)
  scrollbarStyleInjected = true
}

export function LogViewerWindow() {
  const rows        = useLogViewerStore((s) => s.rows)
  const sessionId   = useLogViewerStore((s) => s.sessionId)
  const open        = useLogViewerStore((s) => s.open)
  const closeViewer = useLogViewerStore((s) => s.closeViewer)
  const clearRows   = useLogViewerStore((s) => s.clearRows)

  const [pos,  setPos]  = useState({ x: window.innerWidth - 560, y: 60 })
  const [size, setSize] = useState({ w: 520, h: 400 })
  const [autoScroll, setAutoScroll] = useState(true)
  // Riga espansa per messaggi lunghi — mostra il testo completo in overlay
  const [expandedRowId, setExpandedRowId] = useState<string | null>(null)

  const dragging   = useRef(false)
  const resizing   = useRef<string | null>(null)
  const dragOff    = useRef({ x: 0, y: 0 })
  const startPos   = useRef({ x: 0, y: 0 })
  const startSize  = useRef({ w: 0, h: 0 })
  const startMouse = useRef({ x: 0, y: 0 })

  useEffect(() => { ensureScrollbarStyle() }, [])

  // Indice della prima riga della sessione corrente — usato per il separatore
  const firstCurrentIdx = useMemo(
    () => rows.findIndex((r) => r.sessionId === sessionId),
    [rows, sessionId]
  )
  const hasPrev = firstCurrentIdx > 0

  // Altezza effettiva: ogni riga ha ROW_HEIGHT, più SEPARATOR_HEIGHT
  // se c'è un separatore di sessione da mostrare prima di firstCurrentIdx
  const itemHeights = useMemo(() => {
    if (!hasPrev) return rows.map(() => ROW_HEIGHT)
    return rows.map((_, i) => i === firstCurrentIdx ? ROW_HEIGHT + SEPARATOR_HEIGHT : ROW_HEIGHT)
  }, [rows, firstCurrentIdx, hasPrev])

  // Per la virtualizzazione usiamo l'altezza media come stima —
  // dato che il separatore è un singolo elemento raro, l'imprecisione
  // è trascurabile su migliaia di righe
  const avgItemHeight = ROW_HEIGHT

  const { containerRef, visibleRange, totalHeight, offsetY, scrollToBottom, isNearBottom, containerEl } =
    useVirtualList({ itemCount: rows.length, itemHeight: avgItemHeight, overscan: 12 })

  // Auto-scroll solo se il toggle è attivo E l'utente è davvero in fondo —
  // così uno scroll manuale verso l'alto (isNearBottom=false) blocca
  // l'autoscroll anche se il toggle è ancora "true", evitando che il
  // job in corso ti riporti giù ad ogni nuova riga mentre stai leggendo
  useEffect(() => {
    if (autoScroll && isNearBottom) scrollToBottom()
  }, [rows.length, autoScroll, isNearBottom, scrollToBottom])

  const onHeaderMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragging.current = true
    dragOff.current  = { x: e.clientX - pos.x, y: e.clientY - pos.y }
    e.preventDefault()
  }, [pos])

  const onResizeMouseDown = useCallback((e: React.MouseEvent, dir: string) => {
    resizing.current   = dir
    startPos.current   = { ...pos }
    startSize.current  = { ...size }
    startMouse.current = { x: e.clientX, y: e.clientY }
    e.preventDefault()
    e.stopPropagation()
  }, [pos, size])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (dragging.current) {
        setPos({
          x: Math.max(0, Math.min(window.innerWidth  - size.w, e.clientX - dragOff.current.x)),
          y: Math.max(0, Math.min(window.innerHeight - size.h, e.clientY - dragOff.current.y)),
        })
      }
      if (resizing.current) {
        const dx  = e.clientX - startMouse.current.x
        const dy  = e.clientY - startMouse.current.y
        const dir = resizing.current
        let { w, h } = startSize.current
        let { x, y } = startPos.current
        if (dir.includes('e'))  w = Math.max(320, w + dx)
        if (dir.includes('s'))  h = Math.max(200, h + dy)
        if (dir.includes('w')) { w = Math.max(320, w - dx); x = startPos.current.x + dx }
        if (dir.includes('n')) { h = Math.max(200, h - dy); y = startPos.current.y + dy }
        setSize({ w, h })
        setPos({ x, y })
      }
    }
    const onUp = () => { dragging.current = false; resizing.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup',   onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup',   onUp)
    }
  }, [size, pos])

  // onScroll locale: sincronizza il toggle "auto" con la posizione reale.
  // Distingue scroll causato dall'utente da scroll causato da scrollToBottom()
  // tramite isNearBottom dell'hook, che viene aggiornato in entrambi i casi.
  const onScroll = useCallback(() => {
    if (!containerEl) return
    const { scrollTop, scrollHeight, clientHeight } = containerEl
    const nearBottom = scrollHeight - scrollTop - clientHeight < 40
    setAutoScroll(nearBottom)
  }, [containerEl])

  useEffect(() => {
    if (!containerEl) return
    containerEl.addEventListener('scroll', onScroll, { passive: true })
    return () => containerEl.removeEventListener('scroll', onScroll)
  }, [onScroll, containerEl])

  if (!open) return null

  const formatTime = (d: Date) =>
    `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}.${String(d.getMilliseconds()).padStart(3,'0')}`

  const resizeHandles = [
    { dir: 'n',  style: { top: 0,    left: 4,  right: 4, height: 4, cursor: 'n-resize'  } },
    { dir: 's',  style: { bottom: 0, left: 4,  right: 4, height: 4, cursor: 's-resize'  } },
    { dir: 'e',  style: { right: 0,  top: 4, bottom: 4,  width:  4, cursor: 'e-resize'  } },
    { dir: 'w',  style: { left: 0,   top: 4, bottom: 4,  width:  4, cursor: 'w-resize'  } },
    { dir: 'se', style: { bottom: 0, right: 0, width: 10, height: 10, cursor: 'se-resize' } },
    { dir: 'sw', style: { bottom: 0, left: 0,  width: 10, height: 10, cursor: 'sw-resize' } },
    { dir: 'ne', style: { top: 0,    right: 0, width: 10, height: 10, cursor: 'ne-resize' } },
    { dir: 'nw', style: { top: 0,    left: 0,  width: 10, height: 10, cursor: 'nw-resize' } },
  ]

  const visibleRows = rows.slice(visibleRange.start, visibleRange.end)

  return createPortal(
    <div style={{
      position:      'fixed',
      left:          pos.x,
      top:           pos.y,
      width:         size.w,
      height:        size.h,
      zIndex:        19000,
      display:       'flex',
      flexDirection: 'column',
      background:    BG,
      border:        `1px solid ${ACCENT}60`,
      borderRadius:  8,
      boxShadow:     `0 8px 32px rgba(0,0,0,.7), 0 0 0 1px ${BORDER}`,
      overflow:      'hidden',
      userSelect:    'none',
    }}>

      {resizeHandles.map(({ dir, style }) => (
        <div key={dir}
          style={{ position: 'absolute', zIndex: 10, ...style }}
          onMouseDown={(e) => onResizeMouseDown(e, dir)} />
      ))}

      {/* Header */}
      <div
        onMouseDown={onHeaderMouseDown}
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '7px 10px',
          background: BG3,
          borderBottom: `1px solid ${BORDER}`,
          cursor: 'grab', flexShrink: 0,
        }}>
        <i className="ti ti-terminal-2" style={{ fontSize: 13, color: ACCENT }} />
        <span style={{ fontSize: 11, fontWeight: 600, color: ACCENT, flex: 1 }}>Log Viewer</span>
        <span style={{ fontSize: 10, color: '#4a5a7a' }}>{rows.length.toLocaleString()} righe</span>

        <button onClick={() => setAutoScroll((v) => !v)}
          title={autoScroll ? 'Auto-scroll attivo' : 'Auto-scroll disattivato'}
          style={{
            background: autoScroll ? `color-mix(in srgb, ${ACCENT} 20%, ${BG3})` : BG3,
            border: `0.5px solid ${autoScroll ? ACCENT : BORDER}`,
            borderRadius: 4, padding: '2px 6px', cursor: 'pointer',
            color: autoScroll ? ACCENT : '#4a5a7a', fontSize: 9,
            display: 'flex', alignItems: 'center', gap: 3,
          }}>
          <i className="ti ti-arrow-down" style={{ fontSize: 9 }} /> auto
        </button>

        <button onClick={clearRows} title="Pulisci log"
          style={{ background: 'none', border: `0.5px solid ${BORDER}`, borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#4a5a7a', fontSize: 9, display: 'flex', alignItems: 'center', gap: 3 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57'; (e.currentTarget as HTMLElement).style.borderColor = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a'; (e.currentTarget as HTMLElement).style.borderColor = BORDER }}>
          <i className="ti ti-trash" style={{ fontSize: 9 }} /> pulisci
        </button>

        <button onClick={closeViewer}
          style={{ background: 'none', border: `0.5px solid ${BORDER}`, borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#4a5a7a', display: 'flex', alignItems: 'center' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#c8d4f0'; (e.currentTarget as HTMLElement).style.borderColor = '#c8d4f0' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a'; (e.currentTarget as HTMLElement).style.borderColor = BORDER }}>
          <i className="ti ti-x" style={{ fontSize: 11 }} />
        </button>
      </div>

      {/* Intestazione colonne */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: '80px 90px 1fr',
        padding: '3px 10px',
        background: BG2,
        borderBottom: `0.5px solid ${BORDER}`,
        flexShrink: 0,
      }}>
        {['Ora', 'Nodo', 'Messaggio'].map((h) => (
          <div key={h} style={{ fontSize: 9, color: '#4a5a7a', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
        ))}
      </div>

      {/* Corpo — virtualizzato */}
      <div
        ref={containerRef}
        className="log-viewer-body"
        style={{ flex: 1, overflowY: 'auto', fontFamily: "'JetBrains Mono', monospace" }}>
        {rows.length === 0 ? (
          <div style={{ padding: '30px', textAlign: 'center', color: '#2a3349', fontSize: 11 }}>
            <i className="ti ti-terminal-2" style={{ fontSize: 28, display: 'block', marginBottom: 8, color: `${ACCENT}30` }} />
            In attesa di righe dal nodo Log…
          </div>
        ) : (
          <div style={{ height: totalHeight, position: 'relative' }}>
            <div style={{ position: 'absolute', top: offsetY, left: 0, right: 0 }}>
              {visibleRows.map((row, localI) => {
                const i               = visibleRange.start + localI
                const isCurrent       = row.sessionId === sessionId
                const isFirstCurrent  = i === firstCurrentIdx

                return (
                  <div key={row.id}>
                    {isFirstCurrent && hasPrev && (
                      <div style={{
                        display: 'flex', alignItems: 'center', gap: 8,
                        padding: '4px 10px', background: '#1a2030',
                        borderTop: '1px solid #3a4a6a', borderBottom: '1px solid #3a4a6a',
                        height: SEPARATOR_HEIGHT, boxSizing: 'border-box',
                      }}>
                        <div style={{ flex: 1, height: '0.5px', background: '#22d3ee40' }} />
                        <span style={{ fontSize: 9, color: '#22d3ee', fontFamily: 'monospace', whiteSpace: 'nowrap' }}>
                          ▶ nuova sessione
                        </span>
                        <div style={{ flex: 1, height: '0.5px', background: '#22d3ee40' }} />
                      </div>
                    )}
                    <div style={{
                      display: 'grid',
                      gridTemplateColumns: '80px 90px 1fr',
                      padding: '3px 10px',
                      background: isCurrent
                        ? (i % 2 === 0 ? BG : BG2)
                        : (i % 2 === 0 ? '#0a0d14' : '#0c1019'),
                      borderBottom: `0.5px solid ${BORDER}20`,
                      alignItems: 'start',
                      height: ROW_HEIGHT,
                      boxSizing: 'border-box',
                      opacity: isCurrent ? 1 : 0.8,
                    }}>
                      <span style={{ fontSize: 9, color: isCurrent ? (LEVEL_COLORS[row.level] ?? '#c8d4f0') : '#a79c97', paddingTop: 1 }}>
                        {formatTime(row.timestamp)}
                      </span>
                      <span style={{ fontSize: 9, color: isCurrent ? ACCENT : '#5a4a7a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingTop: 1 }}
                        title={row.nodeLabel}>
                        {row.nodeLabel}
                      </span>
                      <span
                        onClick={() => row.message.length > 80 && setExpandedRowId(row.id)}
                        title={row.message.length > 80 ? 'Click per vedere il messaggio completo' : undefined}
                        style={{
                          fontSize: 10, color: isCurrent ? (LEVEL_COLORS[row.level] ?? '#c8d4f0') : '#a79c97',
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', lineHeight: 1.4,
                          cursor: row.message.length > 80 ? 'pointer' : 'default',
                          display: 'flex', alignItems: 'center', gap: 4,
                        }}>
                        {row.rowNum > 0 && <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>#{row.rowNum}</span>}
                        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.message}</span>
                        {row.message.length > 80 && (
                          <i className="ti ti-arrows-diagonal" style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }} />
                        )}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Footer */}
      <div style={{
        padding: '4px 10px', background: BG3,
        borderTop: `0.5px solid ${BORDER}`,
        fontSize: 9, color: '#4a5a7a', flexShrink: 0,
        display: 'flex', alignItems: 'center', gap: 8,
      }}>
        <i className="ti ti-info-circle" style={{ fontSize: 9 }} />
        <span>{rows.length.toLocaleString()} righe · trascina l'intestazione per spostare · bordi per ridimensionare</span>
      </div>

      {/* Overlay messaggio espanso — testo completo per righe lunghe */}
      {expandedRowId && (() => {
        const row = rows.find((r) => r.id === expandedRowId)
        if (!row) return null
        return (
          <div
            onClick={() => setExpandedRowId(null)}
            style={{
              position: 'fixed', inset: 0, zIndex: 20100,
              background: 'rgba(0,0,0,.6)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 24,
            }}>
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                background: BG2, border: `1px solid ${ACCENT}60`, borderRadius: 8,
                maxWidth: 720, width: '100%', maxHeight: '70vh',
                display: 'flex', flexDirection: 'column', overflow: 'hidden',
                boxShadow: '0 24px 64px rgba(0,0,0,.8)',
              }}>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '10px 14px', background: BG3, borderBottom: `1px solid ${BORDER}`,
              }}>
                <span style={{ fontSize: 9, color: LEVEL_COLORS[row.level] ?? '#c8d4f0' }}>
                  {formatTime(row.timestamp)}
                </span>
                <span style={{ fontSize: 9, color: ACCENT, fontFamily: 'monospace' }}>{row.nodeLabel}</span>
                {row.rowNum > 0 && <span style={{ fontSize: 9, color: '#4a5a7a' }}>#{row.rowNum}</span>}
                <span style={{ flex: 1 }} />
                <button onClick={() => setExpandedRowId(null)}
                  style={{ background: 'none', border: `0.5px solid ${BORDER}`, borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#4a5a7a', display: 'flex', alignItems: 'center' }}>
                  <i className="ti ti-x" style={{ fontSize: 11 }} />
                </button>
              </div>
              <div style={{
                padding: '14px', overflowY: 'auto',
                fontFamily: "'JetBrains Mono', monospace", fontSize: 11,
                color: LEVEL_COLORS[row.level] ?? '#c8d4f0',
                whiteSpace: 'pre-wrap', wordBreak: 'break-all', lineHeight: 1.6,
              }}>
                {row.message}
              </div>
              <div style={{
                padding: '6px 14px', background: BG3, borderTop: `0.5px solid ${BORDER}`,
                fontSize: 9, color: '#4a5a7a', display: 'flex', alignItems: 'center', gap: 6,
              }}>
                <i className="ti ti-info-circle" style={{ fontSize: 9 }} />
                {row.message.length.toLocaleString()} caratteri · click fuori per chiudere
              </div>
            </div>
          </div>
        )
      })()}
    </div>,
    document.body
  )
}