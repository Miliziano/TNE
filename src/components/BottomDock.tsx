/**
 * src/components/BottomDock.tsx
 *
 * Dock inferiore a TAB (Log | Problems), che rimpiazza il vecchio LogPanel fisso.
 * - ridimensionabile: si trascina il bordo superiore;
 * - chiudibile: collassa alla sola barra dei tab (canvas più grande);
 * - export del log (file .txt/.ndjson + copia in clipboard) sul tab Log.
 *
 * Il tab "Problems" per ora è uno stub — verrà riempito nel prossimo pezzo.
 * Il tab "Validation" è riservato al futuro cruscotto coverage/predizione.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { useFlowStore } from '../store/flowStore'
import { LogView, logsToText, logsToNdjson } from './LogPanel'
import { ProblemsView, collectProblems, problemsToText, problemsToNdjson } from './ProblemsPanel'

type DockTab = 'log' | 'problems'

const MIN_H = 90
const MAX_H = 520
const DEFAULT_H = 160

const ACCENT = '#4a9eff'

export function BottomDock() {
  const logs      = useFlowStore((s) => s.logs)
  const clearLogs = useFlowStore((s) => s.clearLogs)
  const nodes     = useFlowStore((s) => s.nodes)
  const pool      = useFlowStore((s) => s.pool)

  // ── Problemi aggregati (raccolta condivisa con ProblemsView) ────
  const problems = collectProblems(nodes, pool)

  const [tab, setTab]         = useState<DockTab>('log')
  const [collapsed, setColl]  = useState(false)
  const [height, setHeight]   = useState(DEFAULT_H)
  const [copied, setCopied]   = useState(false)

  // ── Resize: drag del bordo superiore ────────────────────────────
  const dragRef = useRef<{ startY: number; startH: number } | null>(null)
  const onDragStart = useCallback((e: React.MouseEvent) => {
    dragRef.current = { startY: e.clientY, startH: height }
    e.preventDefault()
  }, [height])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return
      // trascinare verso l'alto (clientY minore) ingrandisce
      const delta = dragRef.current.startY - e.clientY
      const next = Math.min(MAX_H, Math.max(MIN_H, dragRef.current.startH + delta))
      setHeight(next)
      if (collapsed) setColl(false)
    }
    const onUp = () => { dragRef.current = null }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [collapsed])

  // ── Export (log e problems) ─────────────────────────────────────
  const download = (content: string, name: string, ext: string) => {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' })
    const url  = URL.createObjectURL(blob)
    const a    = document.createElement('a')
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
    a.href = url
    a.download = `flowpilot-${name}-${stamp}.${ext}`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }
  const exportTxt    = () => download(logsToText(logs), 'log', 'txt')
  const exportNdjson = () => download(logsToNdjson(logs), 'log', 'ndjson')
  const copyText = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* clipboard non disponibile */ }
  }

  const tabBtn = (id: DockTab, label: string, count?: number) => (
    <button
      onClick={() => { setTab(id); if (collapsed) setColl(false) }}
      style={{
        background: 'none', border: 'none', cursor: 'pointer',
        padding: '0 10px', height: 26, display: 'flex', alignItems: 'center', gap: 6,
        fontSize: 10, fontWeight: 600, letterSpacing: '.06em', textTransform: 'uppercase',
        color: tab === id && !collapsed ? '#c8d4f0' : '#4a5a7a',
        borderBottom: tab === id && !collapsed ? `2px solid ${ACCENT}` : '2px solid transparent',
      }}>
      {label}
      {count != null && count > 0 && (
        <span style={{ fontWeight: 400, color: '#4a5a7a', textTransform: 'none', letterSpacing: 0 }}>
          {count.toLocaleString()}
        </span>
      )}
    </button>
  )

  const iconBtn = (icon: string, title: string, onClick: () => void, active = false) => (
    <button onClick={onClick} title={title}
      style={{
        background: 'none', border: '0.5px solid #2a3349', borderRadius: 4,
        padding: '2px 6px', cursor: 'pointer',
        color: active ? '#3ddc84' : '#4a5a7a', display: 'flex', alignItems: 'center',
      }}>
      <i className={`ti ${icon}`} style={{ fontSize: 12 }} />
    </button>
  )

  return (
    <div style={{
      height: collapsed ? 27 : height,
      background: '#161b27', borderTop: '1px solid #2a3349',
      display: 'flex', flexDirection: 'column', flexShrink: 0, position: 'relative',
    }}>
      {/* Maniglia di resize — bordo superiore */}
      {!collapsed && (
        <div onMouseDown={onDragStart}
          style={{
            position: 'absolute', top: -3, left: 0, right: 0, height: 6,
            cursor: 'ns-resize', zIndex: 5,
          }} />
      )}

      {/* Barra tab + azioni */}
      <div style={{
        display: 'flex', alignItems: 'center',
        borderBottom: collapsed ? 'none' : '1px solid #2a3349',
        paddingRight: 8, flexShrink: 0,
      }}>
        {tabBtn('log', 'Log', logs.length)}
        {tabBtn('problems', 'Validazione', problems.length)}
        {/* Validation: riservato al futuro cruscotto coverage/predizione */}

        <div style={{ flex: 1 }} />

        {/* Azioni contestuali al tab attivo */}
        {tab === 'log' && !collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
            {iconBtn('ti-file-text', 'Esporta log come .txt', exportTxt)}
            {iconBtn('ti-code', 'Esporta log come .ndjson', exportNdjson)}
            {iconBtn(copied ? 'ti-check' : 'ti-copy', copied ? 'Copiato!' : 'Copia log negli appunti', () => copyText(logsToText(logs)), copied)}
            <button onClick={clearLogs} title="Svuota il log"
              style={{ background: 'none', border: '0.5px solid #2a3349', borderRadius: 4, padding: '2px 8px', cursor: 'pointer', color: '#4a5a7a', fontSize: 10, fontFamily: 'inherit' }}>
              clear
            </button>
          </div>
        )}

        {/* Azioni Problems — export come per il log (i problemi sono
            derivati dalla validazione, quindi niente "clear") */}
        {tab === 'problems' && !collapsed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginRight: 8 }}>
            {iconBtn('ti-file-text', 'Esporta problemi come .txt', () => download(problemsToText(problems), 'problems', 'txt'))}
            {iconBtn('ti-code', 'Esporta problemi come .ndjson', () => download(problemsToNdjson(problems), 'problems', 'ndjson'))}
            {iconBtn(copied ? 'ti-check' : 'ti-copy', copied ? 'Copiato!' : 'Copia problemi negli appunti', () => copyText(problemsToText(problems)), copied)}
          </div>
        )}

        {/* Collassa / espandi */}
        {iconBtn(collapsed ? 'ti-chevron-up' : 'ti-chevron-down',
                 collapsed ? 'Espandi pannello' : 'Riduci a barra',
                 () => setColl((c) => !c))}
      </div>

      {/* Corpo del tab attivo */}
      {!collapsed && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
          {tab === 'log' && <LogView />}
          {tab === 'problems' && <ProblemsView />}
        </div>
      )}
    </div>
  )
}
