/**
 * src/runner/bridgeBus.ts
 *
 * Bus in memoria condiviso tra tutti gli executor della stessa run.
 * Trasporto zero-copia tra BridgeOut e BridgeIn nello stesso processo.
 *
 * Interfaccia progettata per essere sostituibile con un trasporto remoto
 * (WebSocket, gRPC, broker) senza cambiare executor o nodi.
 *
 * Ciclo di vita:
 *   1. Il runner crea un runId univoco all'avvio di ogni esecuzione.
 *   2. BridgeOut pubblica envelope sul canale (runId + channelName).
 *   3. BridgeIn riceve envelope in ordine, si blocca se la coda è vuota.
 *   4. Il runner chiama bridgeBus.cleanup(runId) a fine esecuzione.
 */

import type { Row } from './types'

// ─── Tipi pubblici ────────────────────────────────────────────────

export type BridgeTransferMode = 'content' | 'stream'

export interface BridgeEnvelope {
  bridgeId:  string                              // channelName
  runId:     string                              // isola run concorrenti
  mode:      BridgeTransferMode
  seq:       number                              // numero sequenza (0-based)
  isLast:    boolean                             // ultimo envelope del flusso
  rows:      Row[]
  schema?:   Array<{ name: string; type: string }> // solo nel primo envelope
  sentAt:    number                              // Date.now() — per latency monitoring
}

export interface BridgeAck {
  bridgeId:  string
  runId:     string
  seq:       number
  receivedAt: number
  error?:    string
}

// ─── Statistiche per canale ───────────────────────────────────────

export interface BridgeChannelStats {
  channelId:    string
  runId:        string
  envelopesSent: number
  rowsSent:     number
  bytesEst:     number    // stima in byte (JSON.stringify approssimativo)
  firstSentAt:  number
  lastSentAt:   number
  avgLatencyMs: number
}

// ─── BridgeBus ───────────────────────────────────────────────────

class BridgeBus {
  // Coda messaggi per canale: key = runId::channelName
  private queues    = new Map<string, BridgeEnvelope[]>()
  // Resolver in attesa (BridgeIn in wait)
  private resolvers = new Map<string, Array<(env: BridgeEnvelope) => void>>()
  // Statistiche per canale
  private stats     = new Map<string, BridgeChannelStats>()

  private key(runId: string, bridgeId: string): string {
    return `${runId}::${bridgeId}`
  }

  // ── Pubblicazione (BridgeOut) ─────────────────────────────────

  /**
   * Pubblica un envelope sul canale.
   * Se BridgeIn è già in attesa → consegna diretta (zero-queue).
   * Altrimenti accoda per la successiva receive().
   */
  publish(env: BridgeEnvelope): void {
    const k       = this.key(env.runId, env.bridgeId)
    const waiting = this.resolvers.get(k)

    this.updateStats(env)

    if (waiting?.length) {
      // Consegna diretta — il resolver era già in attesa
      const resolve = waiting.shift()!
      resolve(env)
      return
    }

    // Accoda
    if (!this.queues.has(k)) this.queues.set(k, [])
    this.queues.get(k)!.push(env)
  }

  // ── Ricezione (BridgeIn) ──────────────────────────────────────

  /**
   * Riceve il prossimo envelope dal canale.
   * Si blocca (con promise) finché non arriva qualcosa o scade il timeout.
   * Il timeout è critico: evita che BridgeIn rimanga in attesa infinita
   * se BridgeOut crasha o non è configurato correttamente.
   */
  async receive(
    runId:     string,
    bridgeId:  string,
    timeoutMs: number = 30_000,
  ): Promise<BridgeEnvelope> {
    const k      = this.key(runId, bridgeId)
    const queued = this.queues.get(k)

    // Elemento già in coda — consegna immediata
    if (queued?.length) return queued.shift()!

    // Nessun elemento — aspetta con timeout
    return new Promise<BridgeEnvelope>((resolve, reject) => {
      let resolved = false

      const timer = setTimeout(() => {
        if (resolved) return
        resolved = true
        // Rimuovi il resolver dalla lista
        const rs = this.resolvers.get(k)
        if (rs) {
          const idx = rs.indexOf(cb)
          if (idx >= 0) rs.splice(idx, 1)
          if (rs.length === 0) this.resolvers.delete(k)
        }
        reject(new Error(
          `BridgeIn '${bridgeId}': timeout dopo ${timeoutMs}ms — ` +
          `BridgeOut non ha inviato dati. Verifica che il canale sia configurato ` +
          `con lo stesso nome su entrambi i nodi e che la Lane sorgente sia in esecuzione.`
        ))
      }, timeoutMs)

      const cb = (env: BridgeEnvelope) => {
        if (resolved) return
        resolved = true
        clearTimeout(timer)
        resolve(env)
      }

      if (!this.resolvers.has(k)) this.resolvers.set(k, [])
      this.resolvers.get(k)!.push(cb)
    })
  }

  // ── Statistiche ───────────────────────────────────────────────

  private updateStats(env: BridgeEnvelope): void {
    const k = this.key(env.runId, env.bridgeId)
    const existing = this.stats.get(k)
    const bytesEst = env.rows.length > 0
      ? JSON.stringify(env.rows[0]).length * env.rows.length
      : 0

    if (!existing) {
      this.stats.set(k, {
        channelId:     env.bridgeId,
        runId:         env.runId,
        envelopesSent: 1,
        rowsSent:      env.rows.length,
        bytesEst,
        firstSentAt:   env.sentAt,
        lastSentAt:    env.sentAt,
        avgLatencyMs:  0,
      })
    } else {
      existing.envelopesSent++
      existing.rowsSent    += env.rows.length
      existing.bytesEst    += bytesEst
      existing.lastSentAt   = env.sentAt
    }
  }

  getStats(runId: string, bridgeId: string): BridgeChannelStats | undefined {
    return this.stats.get(this.key(runId, bridgeId))
  }

  getAllStats(runId: string): BridgeChannelStats[] {
    return [...this.stats.entries()]
      .filter(([k]) => k.startsWith(`${runId}::`))
      .map(([, v]) => v)
  }

  // ── Segnale di interruzione ───────────────────────────────────

  /**
   * Invia un envelope vuoto con isLast=true per sbloccare BridgeIn
   * in caso di abort dell'esecuzione.
   */
  abort(runId: string, bridgeId: string): void {
    this.publish({
      bridgeId, runId, mode: 'content',
      seq: -1, isLast: true, rows: [],
      sentAt: Date.now(),
    })
  }

  // ── Pulizia ───────────────────────────────────────────────────

  /**
   * Rimuove tutte le code e i resolver per un dato runId.
   * Va chiamato dal runner al termine dell'esecuzione (successo o errore).
   */
  cleanup(runId: string): void {
    const prefix = `${runId}::`
    for (const k of [...this.queues.keys()]) {
      if (k.startsWith(prefix)) this.queues.delete(k)
    }
    for (const k of [...this.resolvers.keys()]) {
      if (k.startsWith(prefix)) {
        // Sblocca tutti i BridgeIn ancora in attesa con un errore
        const rs = this.resolvers.get(k)!
        rs.forEach((cb) => {
          // Non possiamo chiamare reject direttamente — i resolver
          // sono già stati wrappati con un timer. Li ignoriamo semplicemente.
          // Il timer scadrà comunque, ma la cleanup ha già rimosso la coda.
        })
        this.resolvers.delete(k)
      }
    }
    for (const k of [...this.stats.keys()]) {
      if (k.startsWith(prefix)) this.stats.delete(k)
    }
  }

  // ── Debug / diagnostica ───────────────────────────────────────

  /** Numero di canali attivi in questo momento (per debug) */
  activeChannels(): number {
    return this.queues.size + this.resolvers.size
  }

  /** Lunghezza coda per un canale specifico */
  queueLength(runId: string, bridgeId: string): number {
    return this.queues.get(this.key(runId, bridgeId))?.length ?? 0
  }
}

// Singleton condiviso tra tutti gli executor nello stesso processo
export const bridgeBus = new BridgeBus()
