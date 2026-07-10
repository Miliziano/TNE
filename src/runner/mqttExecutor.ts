/**
 * src/runner/mqttExecutor.ts
 * ───────────────────────────
 * Executor per source_mqtt (subscriber) e sink_mqtt (publisher).
 *
 * Fase 1 — usa invoke('mqtt_subscribe') e invoke('mqtt_publish') via Rust/rumqttc.
 *
 * source_mqtt:
 *   - Si connette al broker, sottoscrive il topic, raccoglie messaggi
 *     fino al timeout configurato, poi restituisce le righe
 *   - Schema output: { topic, payload, qos, retain, received_at }
 *
 * sink_mqtt:
 *   - Per ogni riga in ingresso pubblica un messaggio sul topic configurato
 *   - Il topic può essere statico o da un campo della riga (topicField)
 *   - Payload: JSON, testo o bytes (base64)
 */

import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { invoke } from '@tauri-apps/api/core'

// ─── Tipi Rust ────────────────────────────────────────────────────

interface MqttConnectionParams {
  host:        string
  port:        number
  client_id:   string
  username?:   string
  password?:   string
  keep_alive:  number
  clean_session: boolean
  use_tls:     boolean
}

interface MqttSubscribeRequest {
  connection:   MqttConnectionParams
  topic:        string
  qos:          number
  timeout_ms:   number
  max_messages: number
}

interface MqttMessage {
  topic:       string
  payload:     string   // JSON string, testo, o base64
  qos:         number
  retain:      boolean
  received_at: string
}

interface MqttPublishRequest {
  connection: MqttConnectionParams
  topic:      string
  payload:    string
  qos:        number
  retain:     boolean
}

// ─── Helper connessione ───────────────────────────────────────────

function buildConnection(
  node:    FlowNode<NodeData>,
  context: ExecutionContext,
): MqttConnectionParams {
  const props = node.data.props ?? {}
  const p     = (k: string, d = '') => String(props[k] ?? d)

  const resourceId = node.data.config?.resourceId as string | undefined
  if (resourceId) {
    const lane     = context.lanes.find(l => l.id === node.data.laneId)
    const resource = lane?.resources.find(r => r.id === resourceId)
    if (resource?.config) {
      const rc = resource.config
      return {
        host:          rc.host    ?? 'localhost',
        port:          parseInt(rc.port ?? '1883', 10),
        client_id:     rc.clientId || `flowpilot_${Date.now()}`,
        username:      rc.username || rc.user || undefined,
        password:      rc.password || undefined,
        keep_alive:    parseInt(rc.keepAlive ?? '60', 10),
        clean_session: (rc.cleanSession ?? 'true') === 'true',
        use_tls:       rc.scheme === 'mqtts' || rc.scheme === 'wss',
      }
    }
  }

  return {
    host:          p('host', 'localhost'),
    port:          parseInt(p('port', '1883'), 10),
    client_id:     p('clientId') || `flowpilot_${Date.now()}`,
    username:      p('username') || undefined,
    password:      p('password') || undefined,
    keep_alive:    parseInt(p('keepAlive', '60'), 10),
    clean_session: p('cleanSession', 'true') === 'true',
    use_tls:       p('scheme', 'mqtt') === 'mqtts',
  }
}

// ─── Source MQTT ──────────────────────────────────────────────────

export const sourceMqttExecutor: NodeExecutor = {
  handles: ['source_mqtt'],

  async execute(
    node:    FlowNode<NodeData>,
    _input:  Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props = node.data.props ?? {}
    const p     = (k: string, d = '') => String(props[k] ?? d)

    const topic         = p('topic', 'sensor/+/data')
    const qos           = parseInt(p('qos', '1'), 10)
    const timeoutMs     = parseInt(p('subscribeTimeout', '5000'), 10)
    const maxMessages   = parseInt(p('maxQueue', '1000'), 10)
    const payloadFormat = p('payloadFormat', 'json')

    const connection = buildConnection(node, context)

    context.callbacks.onLog('info',
      `MQTT Source — ${connection.host}:${connection.port} | topic: ${topic} | timeout: ${timeoutMs}ms`,
      node.id,
    )

    let messages: MqttMessage[]
    try {
      messages = await invoke<MqttMessage[]>('mqtt_subscribe', {
        request: {
          connection,
          topic,
          qos,
          timeout_ms:   timeoutMs,
          max_messages: maxMessages,
        } satisfies MqttSubscribeRequest,
      })
    } catch (err) {
      throw new Error(`MQTT Source: ${err instanceof Error ? err.message : String(err)}`)
    }

    context.callbacks.onLog('info', `MQTT Source: ricevuti ${messages.length} messaggi`, node.id)

    // Converte i messaggi in righe
    const rows: Row[] = messages.map(msg => {
      let payload: unknown = msg.payload
      if (payloadFormat === 'json') {
        try { payload = JSON.parse(msg.payload) } catch { payload = msg.payload }
      }
      return {
        topic:       msg.topic,
        payload,
        qos:         msg.qos,
        retain:      msg.retain,
        received_at: msg.received_at,
      }
    })

    return new Map([['output', rows]])
  },
}

// ─── Sink MQTT ────────────────────────────────────────────────────

export const sinkMqttExecutor: NodeExecutor = {
  handles: ['sink_mqtt'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props = node.data.props ?? {}
    const p     = (k: string, d = '') => String(props[k] ?? d)

    const topicStatic    = p('topic', 'pipeline/output')
    const topicField     = p('topicField', '')
    const qos            = parseInt(p('qos', '1'), 10)
    const retain         = p('retain', 'false') === 'true'
    const serialization  = p('serialization', 'json')

    if (input.length === 0) {
      context.callbacks.onLog('warn', 'MQTT Sink: nessuna riga in ingresso', node.id)
      return new Map([['output', []]])
    }

    const connection = buildConnection(node, context)

    context.callbacks.onLog('info',
      `MQTT Sink — ${connection.host}:${connection.port} | ${input.length} messaggi`,
      node.id,
    )

    let published = 0, errors = 0

    for (const row of input) {
      if (context.callbacks.isAborted()) break

      const topic = (topicField && row[topicField])
        ? String(row[topicField])
        : topicStatic

      let payload: string
      switch (serialization) {
        case 'text':
          payload = String(Object.values(row)[0] ?? JSON.stringify(row))
          break
        case 'bytes':
          // base64 del JSON
          payload = btoa(JSON.stringify(row))
          break
        default: // json
          payload = JSON.stringify(row)
      }

      try {
        await invoke('mqtt_publish', {
          request: {
            connection,
            topic,
            payload,
            qos,
            retain,
          } satisfies MqttPublishRequest,
        })
        published++
      } catch (err) {
        errors++
        context.callbacks.onLog('error',
          `MQTT Sink: errore pubblicazione su '${topic}' — ${err instanceof Error ? err.message : String(err)}`,
          node.id,
        )
        if (errors > 5) {
          throw new Error(`MQTT Sink: troppi errori (${errors}), operazione interrotta`)
        }
      }
    }

    context.callbacks.onLog('info',
      `MQTT Sink: ${published} messaggi pubblicati, ${errors} errori`,
      node.id,
    )

    return new Map([['output', [{
      _mqtt_published: published,
      _mqtt_errors:    errors,
      topic:           topicStatic,
      completed_at:    new Date().toISOString(),
    }]]])
  },
}
