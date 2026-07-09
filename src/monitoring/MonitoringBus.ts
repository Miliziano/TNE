/**
 * src/monitoring/MonitoringBus.ts
 *
 * Singleton centrale del sistema di monitoring.
 * Raccoglie eventi da tutti i collector e li distribuisce ai reporter.
 *
 * Funziona sia in ambiente browser (Tauri UI) che Node.js (artifact rilasciato).
 * In browser: usa performance.memory se disponibile
 * In Node.js: usa process.memoryUsage()
 *
 * Attivazione silent mode (artifact):
 *   FLOWPILOT_MONITOR=true
 *   FLOWPILOT_MONITOR_LOG=/path/to/logfile.json
 *   FLOWPILOT_MONITOR_INTERVAL_MS=1000   (default 2000)
 */

// ─── Tipi pubblici ────────────────────────────────────────────────

export interface ProcessMemoryDetail {
  pid:     number
  name:    string
  role:    'Main' | 'WebKitWeb' | 'WebKitNetwork' | 'WebKitGpu' | 'Other'
  rss:     number   // bytes
  pss:     number   // bytes — 0 se non disponibile
  private: number   // bytes — memoria esclusiva del processo
  shared:  number   // bytes — pagine condivise (librerie, mmap condivisi)
}

export interface MemorySnapshot {
  heapUsed:     number   // bytes — RSS processo principale (retrocompatibilità)
  heapTotal:    number   // bytes
  external?:    number   // bytes (solo Node.js)
  rss?:         number   // bytes — RSS processo principale
  rssWebkit?:   number   // bytes — RSS somma processi WebKit
  totalRss?:     number   // bytes — somma RSS di tutta l'app
  totalPss?:     number   // bytes — somma PSS di tutta l'app (più accurata, evita doppio conteggio)
  totalPrivate?: number   // bytes — memoria esclusiva dell'app (la metrica migliore per i leak)
  totalShared?:  number   // bytes — pagine condivise con altri processi (librerie ecc.)
  pssAvailable?: boolean  // true se PSS/Private/Shared sono stati letti correttamente
  processes?:   ProcessMemoryDetail[]  // dettaglio per processo
  totalRam?:    number   // bytes — RAM totale sistema
  usedRam?:     number   // bytes — RAM usata sistema
  timestamp:    number   // Date.now()
}

export interface NodeTiming {
  nodeId:      string
  nodeLabel:   string
  nodeType:    string
  startAt:     number
  endAt?:      number
  durationMs?: number
  rowsIn:      number
  rowsOut:     number
  rowsRejected: number
  bytesEstimated?: number
  error?:      string
}

export interface ConnectionEvent {
  id:          string   // uuid generato
  nodeId?:     string   // ← id del nodo che ha usato la risorsa (per raggruppare)
  resource:    string   // label della risorsa
  type:        'db' | 'ftp' | 'http' | 'kafka' | 'mqtt' | 'other'
  action:      'open' | 'close' | 'error' | 'query'
  timestamp:   number
  durationMs?: number   // per 'query' e 'close'
  detail?:     string   // es. query SQL (troncata), host:port
}

export interface LoiteringObject {
  id:          string
  label:       string   // es. "inputHandleRefs (TMapModal)"
  type:        'Map' | 'Array' | 'Set' | 'Object'
  sizeAtStart: number
  sizeCurrent: number
  growthRate:  number   // entries per secondo
  firstSeenAt: number
  lastSeenAt:  number
}

export interface ExecutionSummary {
  runId:         string
  startAt:       number
  endAt?:        number
  totalDurationMs?: number
  peakHeapMb:    number
  avgHeapMb:     number
  totalRowsIn:   number
  totalRowsOut:  number
  totalRejected: number
  nodeTimings:   NodeTiming[]
  connections:   ConnectionEvent[]
  loitering:     LoiteringObject[]
  memoryTimeline: MemorySnapshot[]
}

export interface MonitorEvent {
  type:    'memory' | 'node_start' | 'node_end' | 'connection' | 'loitering' | 'run_start' | 'run_end'
  payload: MemorySnapshot | NodeTiming | ConnectionEvent | LoiteringObject | ExecutionSummary
  runId:   string
}

export interface Reporter {
  onEvent(event: MonitorEvent): void
  onRunEnd(summary: ExecutionSummary): void
  flush?(): Promise<void>
}

// ─── Rilevamento ambiente ─────────────────────────────────────────

const IS_NODE    = typeof process !== 'undefined' && typeof process.memoryUsage === 'function'
const IS_BROWSER = typeof window !== 'undefined'
const IS_TAURI   = typeof window !== 'undefined' && '__TAURI__' in window

// Invoke Tauri — tenta import indipendentemente da __TAURI__
// In Tauri 2.x __TAURI__ potrebbe non essere nel window anche se l'app è Tauri
let _tauriInvoke: ((cmd: string) => Promise<any>) | null = null
import('@tauri-apps/api/core')
  .then(m => { _tauriInvoke = m.invoke })
  .catch(() => { /* non siamo in Tauri */ })

// Ultimo snapshot Tauri — aggiornato async, usato sync nel polling
let _lastTauriSnapshot: MemorySnapshot | null = null

/** Mappa il payload memoria del Rust (AppMemoryInfo — il `detail` di
 *  MemorySample, stessa forma di get_memory_info) in MemorySnapshot.
 *  Usato sia dal fetch Tauri interno sia dall'instradamento del
 *  sampler Rust nel polling (Toolbar). */
export function snapshotFromAppMemory(m: any): MemorySnapshot {
  return {
    heapUsed:     m.main_rss,
    heapTotal:    m.total_ram,
    rss:          m.main_rss,
    rssWebkit:    m.webkit_rss,
    totalRss:     m.total_rss,
    totalPss:     m.total_pss,
    totalPrivate: m.total_private,
    totalShared:  m.total_shared,
    pssAvailable: m.pss_available,
    processes:    (m.processes ?? []).map((p: any) => ({
      pid: p.pid, name: p.name, role: p.role, rss: p.rss, pss: p.pss,
      private: p.private, shared: p.shared,
    })),
    totalRam:     m.total_ram,
    usedRam:      m.used_ram,
    timestamp:    m.timestamp,
  }
}

async function fetchTauriMemory(): Promise<MemorySnapshot | null> {
  if (!_tauriInvoke) return null
  try {
    const m = await _tauriInvoke('get_memory_info') as any
    const snap = snapshotFromAppMemory(m)
    _lastTauriSnapshot = snap
    return snap
  } catch {
    return null
  }
}

function getMemorySnapshot(): MemorySnapshot {
  const ts = Date.now()

  // Node.js (artifact rilasciato)
  if (IS_NODE) {
    const m = process.memoryUsage()
    return { heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, rss: m.rss, timestamp: ts }
  }

  // Tauri: usa l'ultimo snapshot Rust se disponibile (aggiornato async)
  if (_lastTauriSnapshot) {
    return { ..._lastTauriSnapshot, timestamp: ts }
    // rssTotal è già incluso nello spread
  }

  // Browser standard (Chrome con flag --enable-precise-memory-info)
  if (IS_BROWSER && (performance as any).memory) {
    const m = (performance as any).memory
    return { heapUsed: m.usedJSHeapSize, heapTotal: m.totalJSHeapSize, timestamp: ts }
  }

  return { heapUsed: 0, heapTotal: 0, timestamp: ts }
}

function generateId(): string {
  return `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`
}

// ─── MonitoringBus ────────────────────────────────────────────────

class MonitoringBusClass {
  private reporters:      Reporter[]        = []
  private activeRun:      ExecutionSummary | null = null
  private memoryTimer:    ReturnType<typeof setInterval> | null = null
  private loiteringRefs:  Map<string, { label: string; type: string; getSize: () => number; firstSeen: number; lastSize: number; lastSeen: number }> = new Map()
  private openConnections: Map<string, ConnectionEvent> = new Map()
  private _enabled:       boolean           = false
  private intervalMs:     number            = 2000
  /** Quando true, la memoria arriva dall'esterno (sampler Rust) e il
   *  timer JS interno NON parte. Impostato da useExternalMemory(). */
  private externalMemory: boolean           = false

  // ── Configurazione ──────────────────────────────────────────────

  enable(intervalMs = 2000) {
    this._enabled = true
    this.intervalMs = intervalMs
  }

  disable() {
    this._enabled = false
    this.stopMemoryPolling()
  }

  /** Passa la sorgente memoria all'esterno (sampler Rust). Spegne il
   *  timer JS interno WebKit-bound: da qui in poi i campioni arrivano
   *  solo via memorySample(). Chiamato in UI Tauri (vedi setup.ts). */
  useExternalMemory() {
    this.externalMemory = true
    this.stopMemoryPolling()
  }

  /** Riceve un campione di memoria dall'esterno (sampler Rust) e lo
   *  tratta come farebbe il timer interno: lo aggiunge alla timeline
   *  del run e lo emette ai reporter. */
  memorySample(snap: MemorySnapshot) {
    if (this.activeRun) {
      this.activeRun.memoryTimeline.push(snap)
    }
    this.emit({
      type:    'memory',
      payload: snap,
      runId:   this.activeRun?.runId ?? 'idle',
    })
  }

  get enabled() { return this._enabled }

  addReporter(reporter: Reporter) {
    this.reporters.push(reporter)
  }

  removeReporter(reporter: Reporter) {
    this.reporters = this.reporters.filter(r => r !== reporter)
  }

  // ── Polling standalone (UI mode senza run attivo) ───────────────
  // Permette al pannello di vedere la memoria anche quando
  // nessun job è in esecuzione.
  startIdlePolling() {
    if (!this._enabled) return
    this.startMemoryPolling()
  }

  stopIdlePolling() {
    if (!this.activeRun) this.stopMemoryPolling()
  }

  // ── Ciclo di vita run ───────────────────────────────────────────

  runStart(runId?: string): string {
    if (!this._enabled) return ''
    const id = runId ?? generateId()
    this.activeRun = {
      runId:          id,
      startAt:        Date.now(),
      peakHeapMb:     0,
      avgHeapMb:      0,
      totalRowsIn:    0,
      totalRowsOut:   0,
      totalRejected:  0,
      nodeTimings:    [],
      connections:    [],
      loitering:      [],
      memoryTimeline: [],
    }
    this.startMemoryPolling()
    this.emit({ type: 'run_start', payload: this.activeRun, runId: id })
    return id
  }

  runEnd(): ExecutionSummary | null {
    if (!this._enabled || !this.activeRun) return null
    this.stopMemoryPolling()

    const run = this.activeRun
    run.endAt           = Date.now()
    run.totalDurationMs = run.endAt - run.startAt
    run.loitering       = this.getLoiteringSnapshot()

    // Calcola stats memoria
    if (run.memoryTimeline.length > 0) {
      const heapMbs    = run.memoryTimeline.map(s => s.heapUsed / 1024 / 1024)
      run.peakHeapMb   = Math.max(...heapMbs)
      run.avgHeapMb    = heapMbs.reduce((a, b) => a + b, 0) / heapMbs.length
    }

    // Totali
    run.totalRowsIn    = run.nodeTimings.reduce((s, n) => s + n.rowsIn,   0)
    run.totalRowsOut   = run.nodeTimings.reduce((s, n) => s + n.rowsOut,  0)
    run.totalRejected  = run.nodeTimings.reduce((s, n) => s + n.rowsRejected, 0)

    this.emit({ type: 'run_end', payload: run, runId: run.runId })
    this.reporters.forEach(r => r.onRunEnd(run))

    this.activeRun = null
    return run
  }

  // ── Nodi ───────────────────────────────────────────────────────

  nodeStart(nodeId: string, nodeLabel: string, nodeType = 'unknown'): NodeTiming {
    const timing: NodeTiming = {
      nodeId, nodeLabel, nodeType,
      startAt:      Date.now(),
      rowsIn:       0,
      rowsOut:      0,
      rowsRejected: 0,
    }
    if (this._enabled) {
      this.activeRun?.nodeTimings.push(timing)
      this.emit({ type: 'node_start', payload: timing, runId: this.activeRun?.runId ?? '' })
    }
    return timing
  }

  nodeEnd(timing: NodeTiming, stats: { rowsIn?: number; rowsOut?: number; rowsRejected?: number; error?: string } = {}) {
    if (!this._enabled) return
    timing.endAt        = Date.now()
    timing.durationMs   = timing.endAt - timing.startAt
    timing.rowsIn       = stats.rowsIn       ?? timing.rowsIn
    timing.rowsOut      = stats.rowsOut      ?? timing.rowsOut
    timing.rowsRejected = stats.rowsRejected ?? timing.rowsRejected
    timing.error        = stats.error

    // Stima bytes: ~256 bytes per riga come euristica base
    timing.bytesEstimated = timing.rowsIn * 256

    this.emit({ type: 'node_end', payload: timing, runId: this.activeRun?.runId ?? '' })
  }

  // ── Connessioni ─────────────────────────────────────────────────

  connectionOpen(resource: string, type: ConnectionEvent['type'], detail?: string, nodeId?: string): string {
    if (!this._enabled) return ''
    const id = generateId()
    const event: ConnectionEvent = {
      id, nodeId, resource, type, action: 'open',
      timestamp: Date.now(), detail,
    }
    this.openConnections.set(id, event)
    this.activeRun?.connections.push(event)
    this.emit({ type: 'connection', payload: event, runId: this.activeRun?.runId ?? '' })
    return id
  }

  connectionClose(id: string, durationMs?: number) {
    if (!this._enabled) return
    const open = this.openConnections.get(id)
    if (!open) return
    const event: ConnectionEvent = {
      ...open,
      action:     'close',
      timestamp:  Date.now(),
      durationMs: durationMs ?? (Date.now() - open.timestamp),
    }
    this.openConnections.delete(id)
    this.activeRun?.connections.push(event)
    this.emit({ type: 'connection', payload: event, runId: this.activeRun?.runId ?? '' })
  }

  connectionQuery(id: string, durationMs: number, detail?: string) {
    if (!this._enabled) return
    const open = this.openConnections.get(id)
    if (!open) return
    const event: ConnectionEvent = {
      ...open, id: generateId(),
      action: 'query', timestamp: Date.now(), durationMs, detail,
    }
    this.activeRun?.connections.push(event)
    this.emit({ type: 'connection', payload: event, runId: this.activeRun?.runId ?? '' })
  }

  connectionError(id: string, detail: string) {
    if (!this._enabled) return
    const open = this.openConnections.get(id)
    const event: ConnectionEvent = {
      ...(open ?? { id, resource: '?', type: 'other' }),
      action: 'error', timestamp: Date.now(), detail,
    }
    this.openConnections.delete(id)
    this.activeRun?.connections.push(event)
    this.emit({ type: 'connection', payload: event, runId: this.activeRun?.runId ?? '' })
  }

  /** Restituisce le connessioni ancora aperte (potenziali leak) */
  getOpenConnections(): ConnectionEvent[] {
    return Array.from(this.openConnections.values())
  }

  // ── Loitering objects ───────────────────────────────────────────

  /**
   * Registra un oggetto da monitorare per crescita anomala.
   * Chiamato una volta sola per ogni oggetto da sorvegliare.
   *
   * @param id      Identificatore univoco (es. 'inputHandleRefs')
   * @param label   Nome human-readable
   * @param type    Tipo struttura
   * @param getSize Funzione che restituisce la dimensione corrente
   */
  watchObject(
    id:      string,
    label:   string,
    type:    'Map' | 'Array' | 'Set' | 'Object',
    getSize: () => number,
  ) {
    if (this.loiteringRefs.has(id)) return  // già registrato
    this.loiteringRefs.set(id, {
      label, type, getSize,
      firstSeen: Date.now(),
      lastSize:  getSize(),
      lastSeen:  Date.now(),
    })
  }

  unwatchObject(id: string) {
    this.loiteringRefs.delete(id)
  }

  private getLoiteringSnapshot(): LoiteringObject[] {
    const result: LoiteringObject[] = []
    const now = Date.now()

    for (const [id, ref] of this.loiteringRefs) {
      const currentSize  = ref.getSize()
      const elapsedSec   = Math.max(1, (now - ref.firstSeen) / 1000)
      const growthRate   = (currentSize - ref.lastSize) / elapsedSec

      // Solo oggetti che sono cresciuti rispetto all'inizio del run
      if (currentSize > ref.lastSize || growthRate > 0) {
        result.push({
          id, label: ref.label, type: ref.type as any,
          sizeAtStart: ref.lastSize,
          sizeCurrent: currentSize,
          growthRate:  Math.round(growthRate * 100) / 100,
          firstSeenAt: ref.firstSeen,
          lastSeenAt:  now,
        })
      }

      // Aggiorna lastSize per il prossimo controllo
      ref.lastSize = currentSize
      ref.lastSeen = now
    }

    return result
  }

  // ── Polling memoria ─────────────────────────────────────────────

  private startMemoryPolling() {
    if (this.externalMemory) return   // memoria dal sampler Rust: niente timer JS
    if (this.memoryTimer) return
    this.memoryTimer = setInterval(async () => {
      // Fetch Tauri prima di emettere — aspetta il risultato
      // così il campione è sempre aggiornato
      const tauriSnap = await fetchTauriMemory()
      const snap = tauriSnap ?? getMemorySnapshot()

      if (this.activeRun) {
        this.activeRun.memoryTimeline.push(snap)
      }
      this.emit({
        type:    'memory',
        payload: snap,
        runId:   this.activeRun?.runId ?? 'idle',
      })
    }, this.intervalMs)
  }

  private stopMemoryPolling() {
    if (this.memoryTimer) {
      clearInterval(this.memoryTimer)
      this.memoryTimer = null
    }
  }

  // ── Emit ────────────────────────────────────────────────────────

  private emit(event: MonitorEvent) {
    for (const reporter of this.reporters) {
      try { reporter.onEvent(event) } catch {}
    }
  }

  // ── Snapshot istantaneo (per debug manuale) ──────────────────────

  snapshot(): {
    memory:          MemorySnapshot
    openConnections: ConnectionEvent[]
    loitering:       LoiteringObject[]
    activeRun:       ExecutionSummary | null
  } {
    return {
      memory:          getMemorySnapshot(),
      openConnections: this.getOpenConnections(),
      loitering:       this.getLoiteringSnapshot(),
      activeRun:       this.activeRun,
    }
  }
}

// ─── Singleton ────────────────────────────────────────────────────

export const monitor = new MonitoringBusClass()

// Auto-configurazione da environment (Node.js / artifact)
if (IS_NODE && process.env['FLOWPILOT_MONITOR'] === 'true') {
  const intervalMs = parseInt(process.env['FLOWPILOT_MONITOR_INTERVAL_MS'] ?? '2000', 10)
  monitor.enable(intervalMs)
}

export default monitor