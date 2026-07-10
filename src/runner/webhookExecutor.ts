/**
 * src/runner/webhookExecutor.ts  (v2 — Responder con modalità flow e monitor)
 *
 * Receiver:   webhook_server_start → webhook_subscribe → webhook_pop loop → webhook_unsubscribe
 * Responder:  webhook_responder_start → aggiorna header (da riga o da variabili) → webhook_responder_stop
 * Watchdog:   watchdog_check loop
 *
 * Nuovo comando Rust: webhook_responder_update_headers(node_id, headers)
 */

import type { Row, ExecutionContext, StreamingNodeExecutor } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { invoke } from '@tauri-apps/api/core'

// ─── Tipi Rust ────────────────────────────────────────────────────

interface WebhookEvent {
  event_id:        string
  event_type:      string
  source_ip:       string
  path:            string
  headers:         Record<string, string>
  payload:         unknown
  received_at:     string
  signature_valid: boolean | null
}

interface WebhookPopResult {
  event:  WebhookEvent | null
  queued: number
}

interface WatchdogCheckResult {
  matched:      boolean
  header_found: string | null
  status_code:  number
  elapsed_ms:   number
}

// ─── Helper ───────────────────────────────────────────────────────

function p(node: FlowNode<NodeData>, key: string, def = ''): string {
  return String(node.data.props?.[key] ?? def)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/**
 * Risolve un template di header sostituendo $variabile con il valore
 * corrispondente dal dizionario values.
 * Usato sia in modalità flow (values = campi riga) che monitor (values = variabili lane).
 */
function resolveHeaderTemplate(template: string, values: Record<string, string>): Record<string, string> {
  let parsed: Record<string, string> = {}
  try { parsed = JSON.parse(template) } catch { return {} }
  const result: Record<string, string> = {}
  for (const [key, tpl] of Object.entries(parsed)) {
    result[key] = tpl.replace(/\$([a-zA-Z0-9_]+)/g, (_, name) => values[name] ?? '')
  }
  return result
}

/** Legge le variabili di lane dallo store Zustand (dal contesto di esecuzione). */
function readLaneVariables(context: ExecutionContext, laneId: string): Record<string, string> {
  const lane = context.lanes.find(l => l.id === laneId)
  const result: Record<string, string> = {}
  for (const v of lane?.variables ?? []) {
    result[v.name] = String(v.value ?? '')
  }
  return result
}

function resolveReceiverConfig(node: FlowNode<NodeData>, context: ExecutionContext) {
  const resourceId = node.data.config?.resourceId as string | undefined
  if (resourceId) {
    const lane     = context.lanes.find(l => l.id === node.data.laneId)
    const resource = lane?.resources.find(r => r.id === resourceId)
    if (resource?.config) {
      const rc = resource.config
      return {
        resourceId,
        port:         parseInt(rc.port ?? '9110', 10),
        ipWhitelist:  (rc.ipWhitelist as string ?? '').split('\n').map((s: string) => s.trim()).filter(Boolean),
        path:         p(node, 'path', '/webhook'),
        secret:       p(node, 'hmacSecret', rc.hmacSecret ?? ''),
        sigHeader:    p(node, 'sigHeader',  rc.sigHeader  ?? 'X-Hub-Signature-256'),
        sigAlgo:      p(node, 'sigAlgo',    rc.sigAlgo    ?? 'sha256'),
        dedupTtlSec:  parseInt(p(node, 'dedupTtlSec', '3600'), 10),
        maxBuffer:    parseInt(p(node, 'maxBuffer',   '1000'), 10),
        overflow:     p(node, 'overflow', 'drop_oldest'),
      }
    }
  }
  return {
    resourceId:   node.id,
    port:         parseInt(p(node, 'port', '9110'), 10),
    ipWhitelist:  [] as string[],
    path:         p(node, 'path', '/webhook'),
    secret:       p(node, 'hmacSecret', ''),
    sigHeader:    p(node, 'sigHeader', 'X-Hub-Signature-256'),
    sigAlgo:      p(node, 'sigAlgo', 'sha256'),
    dedupTtlSec:  parseInt(p(node, 'dedupTtlSec', '3600'), 10),
    maxBuffer:    parseInt(p(node, 'maxBuffer', '1000'), 10),
    overflow:     p(node, 'overflow', 'drop_oldest'),
  }
}

// ─── 1 — Webhook Receiver ─────────────────────────────────────────

export const webhookReceiverExecutor: StreamingNodeExecutor = {
  handles:   ['webhook_receiver'],
  streaming: true,

  async execute(node, _input, context, onRow, onDone) {
    const cfg        = resolveReceiverConfig(node, context)
    const pollMs     = parseInt(p(node, 'pollIntervalMs', '200'), 10)
    const runSec     = parseInt(p(node, 'listenSec', '0'), 10)
    const debounceMs = parseInt(p(node, 'debounceMs', '0'), 10)

    context.callbacks.onLog('info',
      `Webhook Receiver — server: ${cfg.resourceId} | path: ${cfg.path} | porta: ${cfg.port}`,
      node.id)

    try {
      await invoke('webhook_server_start', {
        request: { resource_id: cfg.resourceId, port: cfg.port, ip_whitelist: cfg.ipWhitelist },
      })
    } catch (err) {
      throw new Error(`Webhook Receiver: avvio server — ${err instanceof Error ? err.message : String(err)}`)
    }

    try {
      await invoke('webhook_subscribe', {
        request: {
          resource_id: cfg.resourceId, node_id: node.id, path: cfg.path,
          secret: cfg.secret, sig_header: cfg.sigHeader, sig_algo: cfg.sigAlgo,
          dedup_ttl_sec: cfg.dedupTtlSec, max_buffer: cfg.maxBuffer, overflow: cfg.overflow,
        },
      })
    } catch (err) {
      throw new Error(`Webhook Receiver: subscribe — ${err instanceof Error ? err.message : String(err)}`)
    }

    context.callbacks.onLog('info', `Webhook Receiver: in ascolto su http://0.0.0.0:${cfg.port}${cfg.path}`, node.id)

    const deadline  = runSec > 0 ? Date.now() + runSec * 1000 : Infinity
    let total       = 0
    let lastEventTs = 0

    while (true) {
      if (context.callbacks.isAborted()) break
      if (Date.now() > deadline) break

      let result: WebhookPopResult
      try {
        result = await invoke<WebhookPopResult>('webhook_pop', {
          resourceId: cfg.resourceId, nodeId: node.id,
        })
      } catch { await sleep(pollMs); continue }

      if (!result.event) { await sleep(pollMs); continue }

      const evt = result.event

      if (debounceMs > 0) {
        const now = Date.now()
        if (now - lastEventTs < debounceMs) { await sleep(pollMs); continue }
        lastEventTs = now
      }

      const row: Row = {
        event_id:        evt.event_id,
        event_type:      evt.event_type,
        source_ip:       evt.source_ip,
        webhook_path:    evt.path,
        payload:         evt.payload,
        headers:         evt.headers,
        received_at:     evt.received_at,
        signature_valid: evt.signature_valid,
        ...(typeof evt.payload === 'object' && evt.payload !== null && !Array.isArray(evt.payload)
          ? evt.payload as Record<string, unknown>
          : {}),
      }

      context.callbacks.onLog('info',
        `Webhook Receiver [${cfg.path}]: evento ${evt.event_id} | buffer: ${result.queued}`, node.id)

      await onRow(row)
      total++
    }

    try { await invoke('webhook_unsubscribe', { resourceId: cfg.resourceId, nodeId: node.id }) } catch {}

    context.callbacks.onLog('ok', `Webhook Receiver: terminato — ${total} eventi`, node.id)
    onDone(total)
  },
}

// ─── 2 — Webhook Responder ────────────────────────────────────────
//
// Modalità flow:    riceve righe → costruisce header dai campi → aggiorna server
// Modalità monitor: nessun input → legge variabili di lane ogni varPollMs → aggiorna server

export const webhookResponderExecutor: StreamingNodeExecutor = {
  handles:   ['webhook_responder'],
  streaming: true,

  async execute(node, input, context, onRow, onDone) {
    const mode       = p(node, 'mode', 'flow')
    const port       = parseInt(p(node, 'port', '9111'), 10)
    const path       = p(node, 'path', '/status')
    const methodsRaw = p(node, 'methods', 'HEAD,GET')
    const methods    = methodsRaw.split(',').map(m => m.trim().toUpperCase())
    const runSec     = parseInt(p(node, 'listenSec', '0'), 10)
    const tplRaw     = p(node, 'headerTemplate', '{"X-Data-Ready":"true","X-Status":"ok"}')
    const laneId     = node.data.laneId as string

    context.callbacks.onLog('info',
      `Webhook Responder [${mode}] — porta: ${port}${path}`, node.id)

    // Avvia il server con header iniziali vuoti — verranno aggiornati subito dopo
    try {
      await invoke('webhook_responder_start', {
        request: { node_id: node.id, port, path, methods, headers: {} },
      })
    } catch (err) {
      throw new Error(`Webhook Responder: avvio — ${err instanceof Error ? err.message : String(err)}`)
    }

    context.callbacks.onLog('info', `Webhook Responder: attivo su http://0.0.0.0:${port}${path}`, node.id)

    const deadline = runSec > 0 ? Date.now() + runSec * 1000 : Infinity

    // ── Modalità FLOW ─────────────────────────────────────────────
    if (mode === 'flow') {
      let total = 0
      for (const row of input) {
        if (context.callbacks.isAborted()) break
        if (Date.now() > deadline) break

        // Costruisce gli header dai campi della riga corrente
        const values: Record<string, string> = {}
        for (const [k, v] of Object.entries(row)) {
          if (v !== null && v !== undefined) values[k] = String(v)
        }
        const headers = resolveHeaderTemplate(tplRaw, values)

        try {
          await invoke('webhook_responder_update_headers', { nodeId: node.id, headers })
          context.callbacks.onLog('debug',
            `Webhook Responder: header aggiornati — ${JSON.stringify(headers)}`, node.id)
        } catch (err) {
          context.callbacks.onLog('warn',
            `Webhook Responder: aggiornamento header fallito — ${err instanceof Error ? err.message : String(err)}`, node.id)
        }

        // Pass-through — la riga scorre invariata
        await onRow(row)
        total++
      }

      // Mantiene il server attivo finché non scade il timeout (o abort)
      while (Date.now() < deadline && !context.callbacks.isAborted()) {
        await sleep(500)
      }

      try { await invoke('webhook_responder_stop', { nodeId: node.id }) } catch {}
      context.callbacks.onLog('ok', `Webhook Responder [flow]: terminato — ${total} righe`, node.id)
      onDone(total)
      return
    }

    // ── Modalità MONITOR ──────────────────────────────────────────
    // Nessun input di righe — legge variabili di lane periodicamente
    const varPollMs = parseInt(p(node, 'varPollMs', '1000'), 10)
    let lastHeadersJson = ''

    // Prima lettura immediata
    const initialValues = readLaneVariables(context, laneId)
    const initialHeaders = resolveHeaderTemplate(tplRaw, initialValues)
    try {
      await invoke('webhook_responder_update_headers', { nodeId: node.id, headers: initialHeaders })
    } catch {}

    context.callbacks.onLog('info',
      `Webhook Responder [monitor]: polling variabili ogni ${varPollMs}ms`, node.id)

    while (true) {
      if (context.callbacks.isAborted()) break
      if (Date.now() > deadline) break

      await sleep(varPollMs)

      // Rilegge le variabili di lane aggiornate
      const values = readLaneVariables(context, laneId)
      const headers = resolveHeaderTemplate(tplRaw, values)
      const headersJson = JSON.stringify(headers)

      // Aggiorna il server solo se qualcosa è cambiato
      if (headersJson !== lastHeadersJson) {
        try {
          await invoke('webhook_responder_update_headers', { nodeId: node.id, headers })
          context.callbacks.onLog('debug',
            `Webhook Responder [monitor]: header aggiornati — ${headersJson}`, node.id)
          lastHeadersJson = headersJson
        } catch (err) {
          context.callbacks.onLog('warn',
            `Webhook Responder [monitor]: aggiornamento fallito — ${err instanceof Error ? err.message : String(err)}`, node.id)
        }
      }
    }

    try { await invoke('webhook_responder_stop', { nodeId: node.id }) } catch {}
    context.callbacks.onLog('ok', 'Webhook Responder [monitor]: terminato', node.id)
    onDone(0)
  },
}

// ─── 3 — Watchdog ────────────────────────────────────────────────
//
// Modalità gate:   blocca finché condizione vera → sblocca una volta → termina
// Modalità stream: emette una riga ad ogni rilevazione positiva → rimane attivo
// Modalità edge:   emette solo al cambio di stato (rising/falling) → rimane attivo

export const watchdogExecutor: StreamingNodeExecutor = {
  handles:   ['watchdog'],
  streaming: true,

  async execute(node, input, context, onRow, onDone) {
    const watchMode    = p(node, 'watchMode', 'gate')
    const url          = p(node, 'url', '')
    const method       = p(node, 'method', 'HEAD')
    const headerName   = p(node, 'headerName', 'X-Data-Ready')
    const headerValue  = p(node, 'headerValue', 'true')
    const matchMode    = p(node, 'matchMode', 'exact')
    const intervalSec  = parseInt(p(node, 'intervalSec', '30'), 10)
    const timeoutSec   = parseInt(p(node, 'timeoutSec', '10'), 10)
    const authType     = p(node, 'authType', 'none')
    const authValue    = p(node, 'authValue', '')
    const globalTtlMin = parseInt(p(node, 'globalTtlMin', '0'), 10)
    // gate only
    const maxAttempts  = parseInt(p(node, 'maxAttempts', '0'), 10)
    const onTimeout    = p(node, 'onTimeout', 'error')
    // edge only
    const edgeTrigger  = p(node, 'edgeTrigger', 'both')

    if (!url) throw new Error('Watchdog: URL non configurato')

    const globalDeadline = globalTtlMin > 0
      ? Date.now() + globalTtlMin * 60 * 1000
      : Infinity

    context.callbacks.onLog('info',
      `Watchdog [${watchMode}] — ${method} ${url} | ${headerName}: "${headerValue}" | ogni ${intervalSec}s`,
      node.id)

    // ── Helper: esegue un singolo check ───────────────────────────
    const doCheck = async (): Promise<WatchdogCheckResult | null> => {
      try {
        return await invoke<WatchdogCheckResult>('watchdog_check', {
          request: {
            url, method,
            header_name:  headerName,
            header_value: headerValue,
            match_mode:   matchMode,
            auth_type:    authType,
            auth_value:   authValue,
            timeout_sec:  timeoutSec,
          },
        })
      } catch (err) {
        context.callbacks.onLog('warn',
          `Watchdog: check fallito — ${err instanceof Error ? err.message : String(err)}`, node.id)
        return null
      }
    }

    // ── Helper: costruisce la riga metadati ───────────────────────
    const buildMeta = (
      result: WatchdogCheckResult,
      attempt: number,
      extra?: Record<string, unknown>
    ): Row => ({
      watchdog_matched:     result.matched,
      watchdog_attempts:    attempt,
      watchdog_url:         url,
      watchdog_header:      headerName,
      watchdog_value_found: result.header_found,
      watchdog_elapsed_ms:  result.elapsed_ms,
      matched_at:           new Date().toISOString(),
      ...extra,
    })

    // ════════════════════════════════════════════════════════════
    // MODALITÀ GATE — comportamento originale
    // ════════════════════════════════════════════════════════════
    if (watchMode === 'gate') {
      let attempt = 0
      while (true) {
        if (context.callbacks.isAborted()) {
          context.callbacks.onLog('warn', 'Watchdog [gate]: abortito', node.id); break
        }
        if (Date.now() > globalDeadline) {
          const msg = `Watchdog [gate]: timeout globale (${globalTtlMin} min) dopo ${attempt} tentativi`
          if (onTimeout === 'error') throw new Error(msg)
          context.callbacks.onLog('warn', msg, node.id); break
        }
        if (maxAttempts > 0 && attempt >= maxAttempts) {
          const msg = `Watchdog [gate]: limite tentativi (${maxAttempts})`
          if (onTimeout === 'error') throw new Error(msg)
          context.callbacks.onLog('warn', msg, node.id); break
        }

        attempt++
        const result = await doCheck()

        if (result) {
          context.callbacks.onLog('info',
            `Watchdog [gate]: tentativo ${attempt} — HTTP ${result.status_code} | ${headerName}: ${result.header_found ?? '(assente)'} | ${result.elapsed_ms}ms`,
            node.id)

          if (result.matched) {
            context.callbacks.onLog('ok',
              `Watchdog [gate]: condizione soddisfatta dopo ${attempt} tentativo/i`, node.id)
            const meta = buildMeta(result, attempt)
            if (input.length > 0) {
              for (const row of input) await onRow({ ...row, ...meta })
            } else {
              await onRow(meta)
            }
            onDone(Math.max(1, input.length))
            return
          }
        }

        await sleep(intervalSec * 1000)
      }

      // Uscita senza match
      if (onTimeout === 'proceed') {
        const meta = { watchdog_matched: false, watchdog_attempts: attempt }
        if (input.length > 0) {
          for (const row of input) await onRow({ ...row, ...meta })
        } else {
          await onRow(meta)
        }
        onDone(Math.max(1, input.length))
      } else {
        onDone(0)
      }
      return
    }

    // ════════════════════════════════════════════════════════════
    // MODALITÀ STREAM — emette ad ogni rilevazione positiva
    // ════════════════════════════════════════════════════════════
    if (watchMode === 'stream') {
      let attempt = 0
      let total   = 0

      while (true) {
        if (context.callbacks.isAborted()) break
        if (Date.now() > globalDeadline) break

        attempt++
        const result = await doCheck()

        if (result) {
          context.callbacks.onLog('debug',
            `Watchdog [stream]: check ${attempt} — matched: ${result.matched} | ${headerName}: ${result.header_found ?? '(assente)'}`,
            node.id)

          if (result.matched) {
            await onRow(buildMeta(result, attempt))
            total++
            context.callbacks.onLog('info',
              `Watchdog [stream]: emessa riga #${total} | ${headerName}: ${result.header_found}`,
              node.id)
          }
        }

        await sleep(intervalSec * 1000)
      }

      context.callbacks.onLog('ok',
        `Watchdog [stream]: terminato — ${total} rilevazioni positive in ${attempt} check`, node.id)
      onDone(total)
      return
    }

    // ════════════════════════════════════════════════════════════
    // MODALITÀ EDGE — emette solo al cambio di stato
    // ════════════════════════════════════════════════════════════
    if (watchMode === 'edge') {
      let attempt      = 0
      let total        = 0
      let prevMatched: boolean | null = null  // null = primo check, stato ignoto

      while (true) {
        if (context.callbacks.isAborted()) break
        if (Date.now() > globalDeadline) break

        attempt++
        const result = await doCheck()

        if (result) {
          const currMatched = result.matched

          // Determina il tipo di transizione
          if (prevMatched !== null && currMatched !== prevMatched) {
            const edge = currMatched ? 'rising' : 'falling'
            const shouldEmit = edgeTrigger === 'both' || edgeTrigger === edge

            context.callbacks.onLog('info',
              `Watchdog [edge]: transizione ${edge} — ${headerName}: ${prevMatched} → ${currMatched}`,
              node.id)

            if (shouldEmit) {
              await onRow(buildMeta(result, attempt, {
                watchdog_edge: edge,
                watchdog_prev: prevMatched,
              }))
              total++
            }
          } else if (prevMatched === null) {
            // Primo check — non è una transizione, non emettere
            context.callbacks.onLog('debug',
              `Watchdog [edge]: stato iniziale — matched: ${currMatched}`, node.id)
          }

          prevMatched = currMatched
        }

        await sleep(intervalSec * 1000)
      }

      context.callbacks.onLog('ok',
        `Watchdog [edge]: terminato — ${total} transizioni rilevate in ${attempt} check`, node.id)
      onDone(total)
      return
    }

    // Fallback — modalità non riconosciuta
    throw new Error(`Watchdog: modalità '${watchMode}' non riconosciuta`)
  },
}