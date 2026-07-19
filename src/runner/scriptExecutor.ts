/**
 * src/runner/scriptExecutor.ts
 *
 * Modifiche rispetto alla versione precedente:
 * - context.lane usa buildLaneProxy da types.ts — identico al TMap.
 *   Le scritture su context.lane.* aggiornano immediatamente
 *   context.laneVariables, visibili ai nodi successivi.
 * - Rimossa la copia locale laneVars — si legge sempre dalla Map live.
 */

import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import { buildLaneProxy } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Context esposto allo script utente ──────────────────────────

interface ScriptContext {
  log:    (msg: string) => void
  emit:   (row: Row) => void
  skip:   () => void
  reject: (row: Row) => void
  error:  (msg: string) => never
  lane:   Record<string, unknown>
  pool:   Record<string, unknown>
}

// ─── Segnali di controllo ─────────────────────────────────────────

const SKIP_SIGNAL   = Symbol('skip')
const REJECT_SIGNAL = Symbol('reject')

// ─── Compila ed esegue il codice TypeScript ───────────────────────

function compileScript(code: string): (row: Row, ctx: ScriptContext) => unknown {
  const wrapped = `
"use strict";
${code}
if (typeof transform === 'function') return transform;
throw new Error('Script: funzione transform non trovata. Dichiara: function transform(row, context) { ... }');
  `
  try {
    const factory = new Function(wrapped) as () => (row: Row, ctx: ScriptContext) => unknown
    const fn = factory()
    if (typeof fn !== 'function') {
      throw new Error('Script: transform non è una funzione')
    }
    return fn
  } catch (e) {
    throw new Error(`Script: errore di compilazione — ${e instanceof Error ? e.message : String(e)}`)
  }
}

// ─── Executor ─────────────────────────────────────────────────────

export const scriptExecutor: NodeExecutor = {
  handles: ['script'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props     = node.data.props ?? {}
    const p         = (k: string, d = '') => String(props[k] ?? d)
    const lang      = p('lang', 'typescript')
    const code      = p('code', '').trim()
    const execMode  = p('execMode', 'transform')
    const hasReject = p('hasReject') === 'true'

    // ── Linguaggi non supportati in fase 1 ──────────────────────
    if (lang === 'python' || lang === 'java' || lang === 'groovy') {
      context.callbacks.onLog('warn',
        `Script [${lang}]: non eseguibile in fase 1 (test locale). ` +
        `Verrà generato come artifact nella fase 2. ` +
        `Usa TypeScript per il test.`,
        node.id,
      )
      return new Map([['output', input], ['reject', []]])
    }

    if (!code) {
      context.callbacks.onLog('warn', 'Script: nessun codice — righe passate invariate', node.id)
      return new Map([['output', input], ['reject', []]])
    }

    // ── Compila lo script ────────────────────────────────────────
    let transformFn: (row: Row, ctx: ScriptContext) => unknown
    try {
      transformFn = compileScript(code)
    } catch (err) {
      throw new Error(`Script: ${err instanceof Error ? err.message : String(err)}`)
    }

    // ── Proxy lane — identico al TMap ────────────────────────────
    // Usa buildLaneProxy da types.ts: legge/scrive su context.laneVariables.
    // Le scritture sono immediatamente visibili ai nodi successivi.
    // Sintassi: context.lane.counter = 0, context.lane.counter++, ecc.
    const laneProxy = buildLaneProxy(node.data.laneId, context)

    // ── Variabili pool ────────────────────────────────────────────
    const poolVars: Record<string, unknown> = {}
    try {
      const allPoolVars = (context as any).poolVariables ?? []
      for (const v of allPoolVars) poolVars[v.name] = v.value ?? null
    } catch {}

    // ── Esecuzione ────────────────────────────────────────────────
    const output:   Row[] = []
    const rejected: Row[] = []
    let errors = 0

    const rows = input.length > 0 ? input : [{}]

    for (const row of rows) {
      if (context.callbacks.isAborted()) break

      const extraEmitted: Row[] = []
      let skipped = false
      let rejectedRows: Row[] = []

      const ctx: ScriptContext = {
        log:    (msg: string) => context.callbacks.onLog('info', `Script: ${msg}`, node.id),
        emit:   (r: Row)      => extraEmitted.push(r),
        skip:   ()            => { skipped = true; throw SKIP_SIGNAL },
        reject: (r: Row)      => { rejectedRows.push(r); throw REJECT_SIGNAL },
        error:  (msg: string) => { throw new Error(msg) },
        lane:   laneProxy,
        pool:   poolVars,
      }

      try {
        const result = transformFn(row, ctx)

        if (skipped) continue

        if (result === null || result === undefined) {
          // riga scartata
        } else if (Array.isArray(result)) {
          output.push(...result)
        } else {
          output.push(result as Row)
        }

        if (extraEmitted.length > 0) output.push(...extraEmitted)

      } catch (err) {
        if (err === SKIP_SIGNAL) continue
        if (err === REJECT_SIGNAL) {
          rejected.push(...rejectedRows)
          continue
        }
        errors++
        const msg = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error', `Script errore riga: ${msg}`, node.id)

        const onError: string = node.data.config?.advanced?.onError ?? 'stop'
        if (onError === 'stop') {
          throw new Error(`Script: errore fatale — ${msg}`)
        }
        if (onError === 'propagate') {
          rejected.push({ ...row, _error: msg })
        }
        // 'skip' → continua
      }
    }

    context.callbacks.onLog('info',
      `Script [${lang}]: ${output.length} righe output` +
      (rejected.length > 0 ? `, ${rejected.length} reject` : '') +
      (errors > 0 ? `, ${errors} errori` : ''),
      node.id,
    )

    const result = new Map<string, Row[]>([['output', output]])
    if (hasReject || rejected.length > 0) result.set('reject', rejected)
    return result
  },
}