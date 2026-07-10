/**
 * src/runner/bridgeExecutor.ts
 *
 * Executor per bridge_out e bridge_in.
 *
 * Modalità di trasferimento:
 *   content — tutto il flusso in un solo envelope (isLast=true al primo)
 *   stream  — envelope progressivi da batchSize righe ciascuno
 *
 * Modalità di sincronismo (syncMode sul nodo):
 *   fire_and_forget — BridgeOut non aspetta nulla, prosegue subito
 *   wait_for_ack    — BridgeOut cede il controllo tra un batch e l'altro
 *                     (in processo singolo equivale a uno yield asincrono;
 *                      in multi-process sarà un vero ACK via canale inverso)
 *   gate            — BridgeIn si blocca finché non arriva l'intero flusso
 *                     (comportamento default — BridgeIn aspetta sempre isLast)
 *
 * Il runId viene iniettato dal runner nel context e isola le esecuzioni
 * concorrenti sullo stesso canale.
 */

import type { Row, NodeExecutor } from '../io/types'
import { bridgeBus, type BridgeEnvelope } from './bridgeBus'

// ─── Helper ───────────────────────────────────────────────────────

function p(node: { data: { props?: Record<string, unknown> } }, key: string, def = ''): string {
  return String(node.data.props?.[key] ?? def)
}

function extractSchema(rows: Row[]): Array<{ name: string; type: string }> | undefined {
  if (rows.length === 0) return undefined
  return Object.keys(rows[0]).map((name) => ({
    name,
    type: typeof rows[0][name] === 'number' ? 'number'
        : typeof rows[0][name] === 'boolean' ? 'boolean'
        : 'string',
  }))
}

// ─── BridgeOut ────────────────────────────────────────────────────

export const bridgeOutExecutor: NodeExecutor = {
  handles: ['bridge_out'],

  async execute(node, input, context) {
    const channelName  = p(node, 'channelName')
    const syncMode     = p(node, 'syncMode', 'fire_and_forget')
    const transferMode = p(node, 'transferMode', 'content') as 'content' | 'stream'
    const batchSize    = Math.max(1, parseInt(p(node, 'batchSize', '100'), 10))
    const runId        = (context as any).runId as string ?? 'default'

    if (!channelName) throw new Error('BridgeOut: channelName non configurato')

    context.callbacks.onLog('info',
      `BridgeOut '${channelName}': ${input.length} righe → ${transferMode} (${syncMode})`,
      node.id)

    const schema = extractSchema(input)

    if (transferMode === 'content') {
      // ── Content: un solo envelope con tutto ──────────────────
      bridgeBus.publish({
        bridgeId: channelName, runId,
        mode: 'content', seq: 0, isLast: true,
        rows: input, schema, sentAt: Date.now(),
      })

    } else {
      // ── Stream: envelope progressivi ─────────────────────────
      if (input.length === 0) {
        // Flusso vuoto — manda subito il sentinel
        bridgeBus.publish({
          bridgeId: channelName, runId,
          mode: 'stream', seq: 0, isLast: true,
          rows: [], schema, sentAt: Date.now(),
        })
      } else {
        let seq = 0
        for (let i = 0; i < input.length; i += batchSize) {
          if (context.callbacks.isAborted()) {
            // Abort: segnala BridgeIn con envelope vuoto finale
            bridgeBus.abort(runId, channelName)
            break
          }

          const batch   = input.slice(i, i + batchSize)
          const isLast  = i + batchSize >= input.length
          const isFirst = seq === 0

          bridgeBus.publish({
            bridgeId: channelName, runId,
            mode: 'stream', seq, isLast,
            rows: batch,
            schema: isFirst ? schema : undefined,
            sentAt: Date.now(),
          })

          seq++

          // wait_for_ack: cede il controllo all'event loop
          // In futuro questo diventerà un vero ACK asincrono dal BridgeIn remoto
          if (syncMode === 'wait_for_ack') {
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
          }
        }
      }
    }

    const stats = bridgeBus.getStats(runId, channelName)
    if (stats) {
      context.callbacks.onLog('info',
        `BridgeOut '${channelName}': ${stats.envelopesSent} envelope, ` +
        `${stats.rowsSent} righe, ~${Math.round(stats.bytesEst / 1024)}KB`,
        node.id)
    }

    // Output verso la lane corrente in base a outputMode
    const outputMode = p(node, 'outputMode', 'none')

    if (outputMode === 'passthrough') {
      // Stesse righe inviate al canale
      return new Map([['output', input]])
    }

    if (outputMode === 'signal') {
      // Una riga di segnale con metadati dell'invio
      return new Map([['output', [{
        _bridge_channel: channelName,
        _bridge_mode:    transferMode,
        _rows_sent:      input.length,
        _status:         'sent',
        _sent_at:        new Date().toISOString(),
      }]]])
    }

    // none — terminatore, nessun output
    return new Map([['output', []]])
  },
}

// ─── BridgeIn ─────────────────────────────────────────────────────

export const bridgeInExecutor: NodeExecutor = {
  handles: ['bridge_in'],
 requiresCompleteInput: () => true,
  async execute(node, input, context) {
    const channelName = p(node, 'channelName')
    const timeoutSec  = Math.max(1, parseInt(p(node, 'timeoutSec', '30'), 10))
    const runId       = (context as any).runId as string ?? 'default'

    if (!channelName) throw new Error('BridgeIn: channelName non configurato')

    context.callbacks.onLog('info',
      `BridgeIn '${channelName}': in attesa (timeout ${timeoutSec}s)…`,
      node.id)

    const collected: Row[]     = []
    const latencies: number[]  = []
    let   seq                  = 0
    let   receivedSchema: Array<{ name: string; type: string }> | undefined

    // Riceve envelope finché isLast === true
    while (true) {
      if (context.callbacks.isAborted()) break

      let env: BridgeEnvelope
      try {
        env = await bridgeBus.receive(runId, channelName, timeoutSec * 1000)
      } catch (err) {
        // Timeout — propaga come errore esplicito
        throw err
      }

      // Abort ricevuto da BridgeOut (seq === -1)
      if (env.seq === -1) {
        context.callbacks.onLog('warn',
          `BridgeIn '${channelName}': abort ricevuto da BridgeOut`, node.id)
        break
      }

      // Verifica ordine sequenziale (best-effort in single-process)
      if (env.seq !== seq) {
        context.callbacks.onLog('warn',
          `BridgeIn '${channelName}': seq atteso ${seq}, ricevuto ${env.seq} — ` +
          `possibile riordino out-of-order`, node.id)
      }

      if (env.schema && !receivedSchema) receivedSchema = env.schema

      latencies.push(Date.now() - env.sentAt)
      collected.push(...env.rows)
      seq++

      if (env.isLast) break
    }

    const avgLat = latencies.length > 0
      ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
      : 0

    context.callbacks.onLog('info',
      `BridgeIn '${channelName}': ${collected.length} righe ricevute ` +
      `in ${seq} envelope, latenza media ${avgLat}ms`,
      node.id)

    return new Map([['output', collected]])
  },
}