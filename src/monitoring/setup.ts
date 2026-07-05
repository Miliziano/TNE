/**
 * src/monitoring/setup.ts
 *
 * Punto di inizializzazione unico del sistema di monitoring.
 * Da chiamare una sola volta all'avvio dell'applicazione.
 *
 * ── Uso nell'interfaccia Tauri (main.tsx o App.tsx) ──────────────
 *
 *   import { setupMonitoring } from './monitoring/setup'
 *   import { inputHandleRefs, outputHandleRefs } from './components/TMapModal'
 *
 *   setupMonitoring({
 *     mode: 'ui',
 *     watchObjects: [
 *       { id: 'inputHandleRefs',  label: 'TMap input handle refs',  type: 'Map', getSize: () => inputHandleRefs.size },
 *       { id: 'outputHandleRefs', label: 'TMap output handle refs', type: 'Map', getSize: () => outputHandleRefs.size },
 *     ]
 *   })
 *
 * ── Uso nell'artifact rilasciato (index.ts generato) ─────────────
 *
 *   // Basta impostare le env var — il setup avviene automaticamente:
 *   FLOWPILOT_MONITOR=true
 *   FLOWPILOT_MONITOR_LOG=/var/log/fp_monitor.ndjson
 *   FLOWPILOT_MONITOR_VERBOSITY=normal
 *
 *   // Oppure esplicitamente:
 *   import { setupMonitoring } from './monitoring/setup'
 *   setupMonitoring({ mode: 'silent', logPath: '/var/log/fp.ndjson' })
 *
 * ── Integrazione nel codice nodo generato ────────────────────────
 *
 *   // Il codegen inserisce automaticamente queste chiamate:
 *   import { monitor } from './monitoring/MonitoringBus'
 *
 *   const __timing = monitor.nodeStart('tmap_42', 'TMap clienti', 'tmap')
 *   const __connId = monitor.connectionOpen('DB Produzione', 'db', 'postgresql://...')
 *   // ... logica nodo ...
 *   monitor.connectionClose(__connId)
 *   monitor.nodeEnd(__timing, { rowsIn: 1000, rowsOut: 950, rowsRejected: 50 })
 */

import { monitor } from './MonitoringBus'
import { FileReporter, createFileReporterFromEnv } from './FileReporter'
import { flushPendingRegistrations } from './registry'

export interface WatchObjectDef {
  id:      string
  label:   string
  type:    'Map' | 'Array' | 'Set' | 'Object'
  getSize: () => number
}

export interface MonitoringSetupOptions {
  /** 'ui': pannello React attivo | 'silent': solo file log | 'both': entrambi */
  mode?: 'ui' | 'silent' | 'both'
  /** Path file di log per modalità silent/both */
  logPath?: string
  /** Intervallo campionamento memoria in ms (default: 2000) */
  intervalMs?: number
  /** Oggetti da sorvegliare per loitering */
  watchObjects?: WatchObjectDef[]
  /** Verbosità log file */
  verbosity?: 'minimal' | 'normal' | 'verbose'
}

let _initialized = false

export function setupMonitoring(options: MonitoringSetupOptions = {}) {
  if (_initialized) return
  _initialized = true

  const {
    mode        = 'ui',
    logPath,
    intervalMs  = 2000,
    watchObjects = [],
    verbosity   = 'normal',
  } = options

  // Abilita il bus
  monitor.enable(intervalMs)
  // In UI (Tauri) la memoria arriva dal sampler Rust: spegni il timer
  // JS interno. In modalità silent/both (artifact Node) resta il
  // campionamento locale via process.memoryUsage.
  if (mode === 'ui') monitor.useExternalMemory()
    
  // Registra gli oggetti messi in coda prima dell'abilitazione
  flushPendingRegistrations()

  // FileReporter: da env (artifact) o da opzioni esplicite
  if (mode === 'silent' || mode === 'both') {
    const path = logPath
      ?? (typeof process !== 'undefined' ? process.env['FLOWPILOT_MONITOR_LOG'] : undefined)
      ?? './flowpilot_monitor.ndjson'

    const fileReporter = new FileReporter({
      logPath:     path,
      verbosity,
      alsoConsole: mode === 'both',
    })
    monitor.addReporter(fileReporter)
  }

  // Auto-setup da env (per artifact Node.js)
  if (typeof process !== 'undefined' && process.env['FLOWPILOT_MONITOR'] === 'true') {
    const fromEnv = createFileReporterFromEnv()
    if (fromEnv) monitor.addReporter(fromEnv)
  }

  // Registra oggetti passati esplicitamente (compatibilità)
  // I moduli si auto-registrano via registerModuleObjects() in registry.ts
  for (const obj of watchObjects) {
    monitor.watchObject(obj.id, obj.label, obj.type, obj.getSize)
  }
}

/**
 * Helper da usare nel codice generato per wrappare l'esecuzione
 * di un intero job con il ciclo di vita run.
 *
 * @example
 * // Generato da codegen in index.ts:
 * import { withMonitoring } from './monitoring/setup'
 *
 * await withMonitoring('pipeline_abc', async () => {
 *   // ... esecuzione nodi ...
 * })
 */
export async function withMonitoring<T>(
  runId:  string,
  fn:     () => Promise<T>,
): Promise<T> {
  monitor.runStart(runId)
  try {
    const result = await fn()
    monitor.runEnd()
    return result
  } catch (err) {
    monitor.runEnd()
    throw err
  }
}

/**
 * Wrapper per connessioni DB — da usare nel codice generato.
 * Traccia automaticamente open/close/query/error.
 *
 * @example
 * // Nel codice generato per sink_db:
 * const conn = await createTrackedConnection('DB Produzione', 'db', createConnection, config)
 * await conn.execute(sql, params)
 * await conn.close()
 */
export function createTrackedConnection<T extends {
  execute(sql: string, params: unknown[]): Promise<{ rowsAffected: number }>
  close(): Promise<void>
}>(
  resource:  string,
  type:      'db' | 'ftp' | 'http' | 'kafka' | 'other',
  conn:      T,
  detail?:   string,
): T & { __monitorId: string } {
  const connId = monitor.connectionOpen(resource, type, detail)

  const proxy = new Proxy(conn, {
    get(target, prop) {
      if (prop === '__monitorId') return connId

      if (prop === 'execute') {
        return async (sql: string, params: unknown[]) => {
          const start = Date.now()
          try {
            const result = await target.execute(sql, params)
            monitor.connectionQuery(connId, Date.now() - start,
              sql.slice(0, 120))  // tronca a 120 chars
            return result
          } catch (err) {
            monitor.connectionError(connId, String(err))
            throw err
          }
        }
      }

      if (prop === 'close') {
        return async () => {
          const start = Date.now()
          try {
            await target.close()
            monitor.connectionClose(connId, Date.now() - start)
          } catch (err) {
            monitor.connectionError(connId, String(err))
            throw err
          }
        }
      }

      const val = (target as any)[prop]
      return typeof val === 'function' ? val.bind(target) : val
    },
  }) as T & { __monitorId: string }

  return proxy
}

export { monitor }