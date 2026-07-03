/**
 * src/monitoring/FileReporter.ts
 *
 * Reporter silente per artifact rilasciati.
 * Scrive su file JSON newline-delimited (NDJSON) — un evento per riga,
 * facile da parsare con jq, grep, o qualsiasi tool di analisi log.
 *
 * Attivazione automatica se FLOWPILOT_MONITOR_LOG è impostato:
 *   FLOWPILOT_MONITOR=true
 *   FLOWPILOT_MONITOR_LOG=/var/log/flowpilot/monitor.ndjson
 *
 * Formato log:
 *   {"ts":1234567890,"runId":"abc","type":"memory","heapUsedMb":45.2,...}
 *   {"ts":1234567890,"runId":"abc","type":"node_end","nodeId":"tmap_42",...}
 *   {"ts":1234567890,"runId":"abc","type":"run_end","summary":{...}}
 *
 * Rotazione: se il file supera maxSizeMb, viene rinominato .1, .2 ecc.
 */

import type { Reporter, MonitorEvent, ExecutionSummary } from './MonitoringBus'

// ─── Tipi ─────────────────────────────────────────────────────────

export interface FileReporterOptions {
  /** Path del file di log — default: ./flowpilot_monitor.ndjson */
  logPath:    string
  /** Dimensione massima prima della rotazione — default: 50 MB */
  maxSizeMb?: number
  /** Quante versioni ruotate conservare — default: 5 */
  maxFiles?:  number
  /** Se true, scrive anche su console.log in aggiunta al file */
  alsoConsole?: boolean
  /** Livello minimo di dettaglio: 'minimal' | 'normal' | 'verbose' */
  verbosity?: 'minimal' | 'normal' | 'verbose'
}

// ─── FileReporter ─────────────────────────────────────────────────

export class FileReporter implements Reporter {
  private logPath:     string
  private maxSizeBytes: number
  private maxFiles:    number
  private alsoConsole: boolean
  private verbosity:   'minimal' | 'normal' | 'verbose'
  private buffer:      string[] = []
  private flushTimer:  ReturnType<typeof setInterval> | null = null
  private fs:          any = null   // importato dinamicamente — solo Node.js

  constructor(options: FileReporterOptions) {
    this.logPath      = options.logPath
    this.maxSizeBytes = (options.maxSizeMb   ?? 50) * 1024 * 1024
    this.maxFiles     = options.maxFiles     ?? 5
    this.alsoConsole  = options.alsoConsole  ?? false
    this.verbosity    = options.verbosity    ?? 'normal'

    this.initFs()
    this.startFlushTimer()
  }

  private async initFs() {
    try {
      // Importazione dinamica — non disponibile nel browser
      this.fs = await import('node:fs')
      // Crea directory se non esiste
      const dir = this.logPath.substring(0, this.logPath.lastIndexOf('/'))
      if (dir) this.fs.mkdirSync(dir, { recursive: true })
    } catch {
      console.warn('[FileReporter] fs non disponibile — logging su file disabilitato')
    }
  }

  onEvent(event: MonitorEvent) {
    const line = this.formatEvent(event)
    if (!line) return

    this.buffer.push(line)
    if (this.alsoConsole) console.log(`[MONITOR] ${line}`)

    // Flush immediato per eventi critici
    if (event.type === 'run_end' || event.type === 'run_start') {
      this.flushSync()
    }
  }

  onRunEnd(summary: ExecutionSummary) {
    // Il summary completo viene scritto come record finale
    const line = JSON.stringify({
      ts:      Date.now(),
      runId:   summary.runId,
      type:    'run_summary',
      summary: {
        runId:          summary.runId,
        startAt:        summary.startAt,
        endAt:          summary.endAt,
        totalDurationMs: summary.totalDurationMs,
        peakHeapMb:     Math.round(summary.peakHeapMb * 100) / 100,
        avgHeapMb:      Math.round(summary.avgHeapMb  * 100) / 100,
        totalRowsIn:    summary.totalRowsIn,
        totalRowsOut:   summary.totalRowsOut,
        totalRejected:  summary.totalRejected,
        nodeCount:      summary.nodeTimings.length,
        connectionCount: summary.connections.length,
        loiteringCount:  summary.loitering.length,
        loitering:       summary.loitering,
        // Top 5 nodi più lenti
        slowestNodes: [...summary.nodeTimings]
          .sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0))
          .slice(0, 5)
          .map(n => ({
            nodeId:     n.nodeId,
            nodeLabel:  n.nodeLabel,
            durationMs: n.durationMs,
            rowsIn:     n.rowsIn,
            rowsOut:    n.rowsOut,
          })),
        // Connessioni ancora aperte alla fine (leak)
        leakedConnections: summary.connections.filter(c => c.action === 'open'),
      },
    })
    this.buffer.push(line)
    this.flushSync()

    if (this.alsoConsole) {
      console.log(`[MONITOR] Run ${summary.runId} completato in ${summary.totalDurationMs}ms`)
      console.log(`[MONITOR] Peak heap: ${Math.round(summary.peakHeapMb)}MB`)
      if (summary.loitering.length > 0) {
        console.warn(`[MONITOR] ⚠ Loitering objects rilevati:`)
        summary.loitering.forEach(l =>
          console.warn(`  ${l.label}: ${l.sizeAtStart} → ${l.sizeCurrent} (+${l.growthRate}/s)`)
        )
      }
      const leaked = summary.connections.filter(c => c.action === 'open')
      if (leaked.length > 0) {
        console.warn(`[MONITOR] ⚠ ${leaked.length} connessioni non chiuse:`)
        leaked.forEach(c => console.warn(`  ${c.resource} (${c.type}) aperta alle ${new Date(c.timestamp).toISOString()}`))
      }
    }
  }

  async flush(): Promise<void> {
    this.flushSync()
  }

  private formatEvent(event: MonitorEvent): string | null {
    const base = { ts: Date.now(), runId: event.runId, type: event.type }

    switch (event.type) {
      case 'memory': {
        if (this.verbosity === 'minimal') return null  // skip in minimal
        const m = event.payload as any
        return JSON.stringify({
          ...base,
          heapUsedMb:  Math.round(m.heapUsed  / 1024 / 1024 * 100) / 100,
          heapTotalMb: Math.round(m.heapTotal / 1024 / 1024 * 100) / 100,
          rssMb:       m.rss ? Math.round(m.rss / 1024 / 1024 * 100) / 100 : undefined,
        })
      }

      case 'node_start': {
        if (this.verbosity !== 'verbose') return null  // solo in verbose
        const n = event.payload as any
        return JSON.stringify({ ...base, nodeId: n.nodeId, nodeLabel: n.nodeLabel })
      }

      case 'node_end': {
        const n = event.payload as any
        return JSON.stringify({
          ...base,
          nodeId:      n.nodeId,
          nodeLabel:   n.nodeLabel,
          nodeType:    n.nodeType,
          durationMs:  n.durationMs,
          rowsIn:      n.rowsIn,
          rowsOut:     n.rowsOut,
          rowsRejected: n.rowsRejected,
          error:       n.error,
          ...(this.verbosity === 'verbose' ? { bytesEstimated: n.bytesEstimated } : {}),
        })
      }

      case 'connection': {
        const c = event.payload as any
        return JSON.stringify({
          ...base,
          connId:    c.id,
          resource:  c.resource,
          connType:  c.type,
          action:    c.action,
          durationMs: c.durationMs,
          detail:    this.verbosity === 'verbose' ? c.detail : undefined,
        })
      }

      case 'loitering': {
        const l = event.payload as any
        return JSON.stringify({
          ...base,
          objectId:   l.id,
          label:      l.label,
          sizeAtStart: l.sizeAtStart,
          sizeCurrent: l.sizeCurrent,
          growthRate:  l.growthRate,
        })
      }

      case 'run_start': {
        const r = event.payload as any
        return JSON.stringify({ ...base, startAt: r.startAt })
      }

      default:
        return null
    }
  }

  private flushSync() {
    if (!this.fs || this.buffer.length === 0) return
    const content = this.buffer.join('\n') + '\n'
    this.buffer = []

    try {
      // Rotazione se necessario
      try {
        const stat = this.fs.statSync(this.logPath)
        if (stat.size > this.maxSizeBytes) {
          this.rotate()
        }
      } catch { /* file non esiste ancora */ }

      this.fs.appendFileSync(this.logPath, content, 'utf-8')
    } catch (err) {
      console.error('[FileReporter] Errore scrittura log:', err)
    }
  }

  private rotate() {
    if (!this.fs) return
    // Ruota i file: .ndjson → .1.ndjson → .2.ndjson ecc.
    for (let i = this.maxFiles - 1; i >= 1; i--) {
      const from = i === 1 ? this.logPath : `${this.logPath}.${i - 1}`
      const to   = `${this.logPath}.${i}`
      try {
        if (this.fs.existsSync(from)) this.fs.renameSync(from, to)
      } catch { /* ignora */ }
    }
    // Svuota il file principale
    try { this.fs.writeFileSync(this.logPath, '', 'utf-8') } catch { /* ignora */ }
  }

  private startFlushTimer() {
    // Flush ogni 5 secondi per non perdere dati in caso di crash
    this.flushTimer = setInterval(() => this.flushSync(), 5000)
  }

  destroy() {
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null }
    this.flushSync()
  }
}

// ─── Auto-inizializzazione da environment ─────────────────────────

export function createFileReporterFromEnv(): FileReporter | null {
  const logPath = (typeof process !== 'undefined')
    ? process.env['FLOWPILOT_MONITOR_LOG']
    : undefined
  if (!logPath) return null

  return new FileReporter({
    logPath,
    maxSizeMb:    parseInt(process.env['FLOWPILOT_MONITOR_MAX_SIZE_MB'] ?? '50', 10),
    maxFiles:     parseInt(process.env['FLOWPILOT_MONITOR_MAX_FILES']   ?? '5',  10),
    alsoConsole:  process.env['FLOWPILOT_MONITOR_CONSOLE'] === 'true',
    verbosity:    (process.env['FLOWPILOT_MONITOR_VERBOSITY'] ?? 'normal') as any,
  })
}
