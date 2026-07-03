/**
 * src/store/useLogViewerStore.ts
 *
 * STREAMING FIX:
 * addRow non chiama set() ad ogni riga — accoda in un buffer locale
 * e fa flush ogni FLUSH_INTERVAL_MS o ogni FLUSH_BATCH_SIZE righe.
 * Questo riduce i re-render di React da N (una per riga) a N/batchSize.
 *
 * Con 1M righe e batch 200: ~5000 re-render invece di 1.000.000.
 *
 * Il flush è schedulato con setTimeout(0) — non blocca l'event loop
 * e lascia spazio al runner per continuare lo streaming.
 */
import { create } from 'zustand'

export interface LogViewerRow {
  id:        string
  timestamp: Date
  nodeId:    string
  nodeLabel: string
  rowNum:    number
  message:   string
  level:     'info' | 'ok' | 'warn' | 'error' | 'debug'
  sessionId: string
}

interface LogViewerState {
  rows:        LogViewerRow[]
  sessionId:   string
  open:        boolean
  addRow:     (row: Omit<LogViewerRow, 'id' | 'sessionId'>) => void
  newSession: () => void
  openViewer:  () => void
  closeViewer: () => void
  clearRows:   () => void
}

// ─── Configurazione buffer ─────────────────────────────────────────
// Flush ogni 200 righe OPPURE ogni 80ms — il primo che scatta vince.
// Con streaming da DB a ~10k righe/sec: flush ~125 volte/sec → fluido.
// Aumentare FLUSH_BATCH_SIZE se la UI è ancora lenta.
const FLUSH_BATCH_SIZE   = 200
const FLUSH_INTERVAL_MS  = 80
// Numero massimo di righe mantenute in memoria nel viewer
// Le righe più vecchie vengono scartate (FIFO) — evita OOM su run lunghi
const MAX_ROWS_IN_VIEWER = 50_000

const makeSessionId = () => `s_${Date.now()}`
const makeRowId     = () => `lv_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

// ─── Buffer locale — fuori dallo store Zustand ────────────────────
// Non è stato Zustand perché non deve scatenare re-render.
let _buffer:        Omit<LogViewerRow, 'id' | 'sessionId'>[] = []
let _flushTimer:    ReturnType<typeof setTimeout> | null = null
let _currentSession = makeSessionId()

function scheduleFlush(flushFn: () => void): void {
  if (_flushTimer !== null) return   // già schedulato
  _flushTimer = setTimeout(() => {
    _flushTimer = null
    flushFn()
  }, FLUSH_INTERVAL_MS)
}

function cancelFlush(): void {
  if (_flushTimer !== null) {
    clearTimeout(_flushTimer)
    _flushTimer = null
  }
}

export const useLogViewerStore = create<LogViewerState>((set, get) => {

  // Funzione di flush — legge il buffer e aggiorna lo store
  function flush(): void {
    if (_buffer.length === 0) return
    const batch    = _buffer.splice(0, _buffer.length)  // svuota il buffer
    const session  = _currentSession

    set((s) => {
      const newRows = batch.map((row) => ({
        ...row,
        id:        makeRowId(),
        sessionId: session,
      }))

      // Mantieni al massimo MAX_ROWS_IN_VIEWER — taglia le più vecchie
      const combined = [...s.rows, ...newRows]
      const trimmed  = combined.length > MAX_ROWS_IN_VIEWER
        ? combined.slice(combined.length - MAX_ROWS_IN_VIEWER)
        : combined

      return {
        rows:         trimmed,
        open:         true,   // apre la finestra alla prima riga del run
      }
    })
  }

  return {
    rows:         [],
    sessionId:    _currentSession,
    open:         false,

    addRow: (row) => {
      // Accoda nel buffer locale — nessun re-render qui
      _buffer.push(row)

      // Alla prima riga: apre subito la finestra senza aspettare il flush
      // (set leggero — solo open: true, nessuna modifica a rows)
      if (_buffer.length === 1) {
        set({ open: true })
      }

      // Flush immediato se raggiungiamo la soglia batch
      if (_buffer.length >= FLUSH_BATCH_SIZE) {
        cancelFlush()
        flush()
      } else {
        // Altrimenti schedula un flush differito
        scheduleFlush(flush)
      }
    },

    newSession: () => {
      // Nuova sessione: svuota il buffer e resetta il contatore
      cancelFlush()
      _buffer = []
      _currentSession = makeSessionId()
      set({ sessionId: _currentSession })
      // NON cancella le righe precedenti — le sessioni rimangono visibili
      // con sessionId diverso per distinguerle
    },

    openViewer:  () => set({ open: true }),
    closeViewer: () => set({ open: false }),

    clearRows: () => {
      cancelFlush()
      _buffer = []
      _currentSession = makeSessionId()
      set({ rows: [], sessionId: _currentSession })
    },
  }
})

/**
 * Forza un flush finale — chiamare al termine del run per assicurarsi
 * che le ultime righe nel buffer vengano scritte nel viewer
 * anche se non hanno raggiunto la soglia batch.
 *
 * Usare in runPipeline() nel blocco finally:
 *   import { flushLogViewer } from '../store/useLogViewerStore'
 *   finally { flushLogViewer() }
 */
export function flushLogViewer(): void {
  cancelFlush()
  const batch   = _buffer.splice(0, _buffer.length)
  if (batch.length === 0) return
  const session = _currentSession

  useLogViewerStore.setState((s) => {
    const newRows = batch.map((row) => ({
      ...row,
      id:        makeRowId(),
      sessionId: session,
    }))
    const combined = [...s.rows, ...newRows]
    const trimmed  = combined.length > MAX_ROWS_IN_VIEWER
      ? combined.slice(combined.length - MAX_ROWS_IN_VIEWER)
      : combined
    return { rows: trimmed }
  })
}