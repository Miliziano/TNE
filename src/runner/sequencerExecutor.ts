/**
 * src/runner/sequencerExecutor.ts
 *
 * Executor del nodo Sequencer.
 *
 * Logica:
 *   1. Riceve una riga opzionale in ingresso (trigger)
 *   2. Per ogni sequenza seq_1..seq_N:
 *      a. Verifica la condizione (onOk / onError / always) rispetto all'esito della precedente
 *      b. Se soddisfatta: trova il nodo collegato all'handle seq_N e avvia la sua pipeline
 *      c. Aspetta il completamento della pipeline
 *      d. Registra esito (ok/error/skipped)
 *   3. Emette una riga con i metadati aggregati
 *
 * NOTA ARCHITETTURALE:
 * Il Sequencer deve poter avviare sub-pipeline indipendenti nella stessa lane.
 * Per farlo usa il runner stesso tramite un callback `runSubPipeline` passato
 * nel ExecutionContext — esattamente come un Tauri command chiama un altro command.
 *
 * Il runner deve esporre `context.callbacks.runSubPipeline(startNodeId, laneId)`.
 * Se non è disponibile, l'executor lancia un errore chiaro.
 *
 * Registrare in executors.ts:
 *   import { sequencerExecutor } from './sequencerExecutor'
 *   EXECUTORS: [..., sequencerExecutor]
 */

import type { Row, ExecutionContext, StreamingNodeExecutor } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Tipi ────────────────────────────────────────────────────────

interface SeqResult {
  seq:        number
  label:      string
  condition:  string
  status:     'ok' | 'error' | 'skipped' | 'timeout'
  elapsed_ms: number
  error?:     string
}

// ─── Helper ───────────────────────────────────────────────────────

function p(node: FlowNode<NodeData>, key: string, def = ''): string {
  return String(node.data.props?.[key] ?? def)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Verifica se la condizione è soddisfatta dato l'esito della sequenza precedente */
function conditionMet(condition: string, prevStatus: 'ok' | 'error' | 'skipped' | 'timeout' | null): boolean {
  if (condition === 'always') return true
  if (prevStatus === null) return true  // prima sequenza — parte sempre
  if (condition === 'onOk')    return prevStatus === 'ok'
  if (condition === 'onError') return prevStatus === 'error' || prevStatus === 'timeout'
  return true
}

// ─── Executor ─────────────────────────────────────────────────────

export const sequencerExecutor: StreamingNodeExecutor = {
  handles:   ['sequencer'],
  streaming: true,

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
    onRow:   (row: Row) => Promise<void>,
    onDone:  (total: number) => void,
  ): Promise<void> {

    // Verifica che il runner esponga runSubPipeline
    if (typeof context.callbacks.runSubPipeline !== 'function') {
      throw new Error(
        'Sequencer: il runner non supporta runSubPipeline. ' +
        'Aggiorna ExecutionContext per esporre context.callbacks.runSubPipeline(startNodeId, laneId).'
      )
    }

    const seqCount        = Math.max(1, parseInt(p(node, 'seqCount', '2'), 10))
    const defaultCond     = p(node, 'defaultCondition', 'onOk')
    const onBlockedError  = p(node, 'onBlockedError', 'stop')
    const laneId          = node.data.laneId as string

    context.callbacks.onLog('info',
      `Sequencer: avvio — ${seqCount} sequenze configurate`, node.id)

    const results: SeqResult[] = []
    let prevStatus: 'ok' | 'error' | 'skipped' | 'timeout' | null = null
    const globalStart = Date.now()

    // Trova gli edge uscenti dal Sequencer per ogni handle seq_N
    // Gli edge sono disponibili via context.edges (da aggiungere all'ExecutionContext)
    // oppure tramite il runner che passa i dati del grafo
    const edges = context.edges ?? []

    for (let i = 1; i <= seqCount; i++) {
      if (context.callbacks.isAborted()) {
        context.callbacks.onLog('warn', `Sequencer: abortito prima di seq_${i}`, node.id)
        break
      }

      const condition = p(node, `seq_${i}_condition`, defaultCond)
      const label     = p(node, `seq_${i}_label`, `Pipeline ${i}`)
      const timeoutSec = parseInt(p(node, `seq_${i}_timeout`, '0'), 10)

      // Verifica condizione
      if (!conditionMet(condition, prevStatus)) {
        context.callbacks.onLog('info',
          `Sequencer: seq_${i} (${label}) — saltata (condizione ${condition}, precedente: ${prevStatus})`,
          node.id)
        results.push({ seq: i, label, condition, status: 'skipped', elapsed_ms: 0 })
        prevStatus = 'skipped'

        // Se la condizione non è soddisfatta e la policy è "stop", interrompi
        if (onBlockedError === 'stop' && prevStatus === 'skipped') {
          // 'skipped' non è un errore — continua sempre
        }
        continue
      }

      // Trova il nodo target collegato all'handle seq_N
      const edge = edges.find(e =>
        e.source === node.id && e.sourceHandle === `seq_${i}`
      )

      if (!edge) {
        context.callbacks.onLog('warn',
          `Sequencer: seq_${i} (${label}) — handle seq_${i} non collegato, salto`, node.id)
        results.push({ seq: i, label, condition, status: 'skipped', elapsed_ms: 0 })
        prevStatus = 'skipped'
        continue
      }

      const targetNodeId = edge.target
      context.callbacks.onLog('info',
        `Sequencer: avvio seq_${i} (${label}) → nodo ${targetNodeId}`, node.id)

      const seqStart = Date.now()

      try {
        // Avvia la sub-pipeline e aspetta il completamento
        // runSubPipeline(startNodeId, laneId) → Promise<{ ok: boolean; error?: string }>
        const runPromise = context.callbacks.runSubPipeline(targetNodeId, laneId)

        let seqResult: { ok: boolean; error?: string }
        if (timeoutSec > 0) {
          const timeoutPromise = new Promise<{ ok: boolean; error: string }>((resolve) =>
            setTimeout(() => resolve({ ok: false, error: `Timeout ${timeoutSec}s` }), timeoutSec * 1000)
          )
          seqResult = await Promise.race([runPromise, timeoutPromise])
        } else {
          seqResult = await runPromise
        }

        const elapsed = Date.now() - seqStart

        if (seqResult.ok) {
          context.callbacks.onLog('ok',
            `Sequencer: seq_${i} (${label}) completata ✓ in ${elapsed}ms`, node.id)
          results.push({ seq: i, label, condition, status: 'ok', elapsed_ms: elapsed })
          prevStatus = 'ok'
        } else {
          const errMsg = seqResult.error ?? 'errore sconosciuto'
          context.callbacks.onLog('error',
            `Sequencer: seq_${i} (${label}) fallita — ${errMsg} (${elapsed}ms)`, node.id)
          results.push({ seq: i, label, condition, status: 'error', elapsed_ms: elapsed, error: errMsg })
          prevStatus = seqResult.error?.includes('Timeout') ? 'timeout' : 'error'

          // Gestione errore bloccante
          if (onBlockedError === 'stop') {
            context.callbacks.onLog('error',
              `Sequencer: interruzione — seq_${i} fallita e onBlockedError=stop`, node.id)
            break
          }
        }

      } catch (err) {
        const elapsed = Date.now() - seqStart
        const errMsg  = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error',
          `Sequencer: seq_${i} (${label}) — eccezione: ${errMsg}`, node.id)
        results.push({ seq: i, label, condition, status: 'error', elapsed_ms: elapsed, error: errMsg })
        prevStatus = 'error'

        if (onBlockedError === 'stop') break
      }
    }

    // Calcola statistiche aggregate
    const completed  = results.filter(r => r.status === 'ok').length
    const failed     = results.filter(r => r.status === 'error' || r.status === 'timeout').length
    const skipped    = results.filter(r => r.status === 'skipped').length
    const elapsed_ms = Date.now() - globalStart

    context.callbacks.onLog(
      failed > 0 ? 'warn' : 'ok',
      `Sequencer: completato — ${completed}/${seqCount} OK, ${failed} errori, ${skipped} saltate — ${elapsed_ms}ms`,
      node.id
    )

    // Emette una riga con i metadati
    const meta: Row = {
      seq_completed:  completed,
      seq_failed:     failed,
      seq_skipped:    skipped,
      seq_total:      seqCount,
      seq_elapsed_ms: elapsed_ms,
      seq_results:    results,
    }

    // Se ha ricevuto una riga in ingresso, la arricchisce; altrimenti emette solo meta
    if (input.length > 0) {
      for (const row of input) await onRow({ ...row, ...meta })
      onDone(input.length)
    } else {
      await onRow(meta)
      onDone(1)
    }
  },
}
