/**
 * src/runner/activemqExecutor.ts
 * ───────────────────────────────
 * Executor per source_activemq (consumer) e sink_activemq (producer).
 *
 * Fase 1 — usa invoke('stomp_subscribe') e invoke('stomp_publish') via Rust.
 * STOMP è il protocollo più semplice di ActiveMQ, porta 61613.
 *
 * source_activemq:
 *   Schema output: { destination, payload, headers, message_id, received_at }
 *
 * sink_activemq:
 *   Serializza ogni riga e la pubblica sulla destinazione configurata.
 */

import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { invoke } from '@tauri-apps/api/core'

// ─── Tipi Rust ────────────────────────────────────────────────────

interface StompConnectionParams {
  host:       string
  port:       number
  username:   string
  password:   string
  vhost:      string
  use_tls:    boolean
}

interface StompSubscribeRequest {
  connection:   StompConnectionParams
  destination:  string
  dest_type:    string     // 'queue' | 'topic'
  ack_mode:     string     // 'auto' | 'client'
  selector?:    string
  timeout_ms:   number
  max_messages: number
}

interface StompMessage {
  destination: string
  payload:     string
  headers:     Record<string, string>
  message_id:  string
  received_at: string
}

interface StompPublishRequest {
  connection:   StompConnectionParams
  destination:  string
  dest_type:    string
  payload:      string
  persistent:   boolean
  priority:     number
  ttl:          number
  correlation_id?: string
  headers?:     Record<string, string>
}

// ─── Helper connessione ───────────────────────────────────────────

function buildConnection(
  node:    FlowNode<NodeData>,
  context: ExecutionContext,
): StompConnectionParams {
  const props = node.data.props ?? {}
  const p     = (k: string, d = '') => String(props[k] ?? d)

  const resourceId = node.data.config?.resourceId as string | undefined
  if (resourceId) {
    const lane     = context.lanes.find(l => l.id === node.data.laneId)
    const resource = lane?.resources.find(r => r.id === resourceId)
    if (resource?.config) {
      const rc = resource.config
      return {
        host:     rc.host     ?? 'localhost',
        port:     parseInt(rc.port ?? '61613', 10),
        username: rc.username ?? rc.user ?? 'admin',
        password: rc.password ?? '',
        vhost:    rc.vhost    ?? '/',
        use_tls:  (rc.tls ?? 'false') === 'true',
      }
    }
  }

  const protocol = p('protocol', 'stomp')
  const defaultPort = protocol === 'amqp' ? '5672' : protocol === 'stomp' ? '61613' : '61616'

  return {
    host:     p('host', 'localhost'),
    port:     parseInt(p('port', defaultPort), 10),
    username: p('username', 'admin'),
    password: p('password'),
    vhost:    p('vhost', '/'),
    use_tls:  p('tls', 'false') === 'true',
  }
}

// ─── Source ActiveMQ ──────────────────────────────────────────────

export const sourceActiveMQExecutor: NodeExecutor = {
  handles: ['source_activemq'],

  async execute(
    node:    FlowNode<NodeData>,
    _input:  Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props = node.data.props ?? {}
    const p     = (k: string, d = '') => String(props[k] ?? d)

    const destination  = p('destination', 'pipeline.input')
    const destType     = p('destType', 'queue')
    const ackMode      = p('ackMode', 'auto')
    const selector     = p('selector').trim() || undefined
    const timeoutMs    = parseInt(p('receiveTimeout', '5000'), 10)
    const maxMessages  = parseInt(p('maxMessages', '1000'), 10)
    const payloadFormat = p('payloadFormat', 'json')

    const connection = buildConnection(node, context)

    context.callbacks.onLog('info',
      `ActiveMQ Consumer — ${connection.host}:${connection.port} | ${destType}: ${destination}`,
      node.id,
    )

    let messages: StompMessage[]
    try {
      messages = await invoke<StompMessage[]>('stomp_subscribe', {
        request: {
          connection,
          destination,
          dest_type:    destType,
          ack_mode:     ackMode,
          selector,
          timeout_ms:   timeoutMs,
          max_messages: maxMessages,
        } satisfies StompSubscribeRequest,
      })
    } catch (err) {
      throw new Error(`ActiveMQ Consumer: ${err instanceof Error ? err.message : String(err)}`)
    }

    context.callbacks.onLog('info', `ActiveMQ Consumer: ricevuti ${messages.length} messaggi`, node.id)

    const rows: Row[] = messages.map(msg => {
      let payload: unknown = msg.payload
      if (payloadFormat === 'json') {
        try { payload = JSON.parse(msg.payload) } catch { payload = msg.payload }
      }
      return {
        destination: msg.destination,
        payload,
        headers:     msg.headers,
        message_id:  msg.message_id,
        received_at: msg.received_at,
      }
    })

    return new Map([['output', rows]])
  },
}

// ─── Sink ActiveMQ ────────────────────────────────────────────────

export const sinkActiveMQExecutor: NodeExecutor = {
  handles: ['sink_activemq'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props = node.data.props ?? {}
    const p     = (k: string, d = '') => String(props[k] ?? d)

    const destination      = p('destination', 'pipeline.output')
    const destType         = p('destType', 'queue')
    const serialization    = p('serialization', 'json')
    const persistent       = p('persistent', 'true') === 'true'
    const priority         = parseInt(p('priority', '4'), 10)
    const ttl              = parseInt(p('ttl', '0'), 10)
    const correlationField = p('correlationIdField', '').trim()

    if (input.length === 0) {
      context.callbacks.onLog('warn', 'ActiveMQ Producer: nessuna riga in ingresso', node.id)
      return new Map([['output', []]])
    }

    const connection = buildConnection(node, context)

    context.callbacks.onLog('info',
      `ActiveMQ Producer — ${connection.host}:${connection.port} | ${destType}: ${destination} | ${input.length} messaggi`,
      node.id,
    )

    let published = 0, errors = 0

    for (const row of input) {
      if (context.callbacks.isAborted()) break

      let payload: string
      switch (serialization) {
        case 'text':
          payload = String(Object.values(row)[0] ?? JSON.stringify(row))
          break
        case 'bytes':
          payload = btoa(JSON.stringify(row))
          break
        default: // json
          payload = JSON.stringify(row)
      }

      const correlationId = correlationField && row[correlationField]
        ? String(row[correlationField])
        : undefined

      try {
        await invoke('stomp_publish', {
          request: {
            connection,
            destination,
            dest_type:      destType,
            payload,
            persistent,
            priority,
            ttl,
            correlation_id: correlationId,
          } satisfies StompPublishRequest,
        })
        published++
      } catch (err) {
        errors++
        context.callbacks.onLog('error',
          `ActiveMQ Producer: errore su '${destination}' — ${err instanceof Error ? err.message : String(err)}`,
          node.id,
        )
        if (errors > 5) {
          throw new Error(`ActiveMQ Producer: troppi errori (${errors}), operazione interrotta`)
        }
      }
    }

    context.callbacks.onLog('info',
      `ActiveMQ Producer: ${published} messaggi pubblicati, ${errors} errori`,
      node.id,
    )

    return new Map([['output', [{
      _amq_published: published,
      _amq_errors:    errors,
      destination,
      completed_at:   new Date().toISOString(),
    }]]])
  },
}
