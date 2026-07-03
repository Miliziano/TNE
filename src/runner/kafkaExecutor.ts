/**
 * src/runner/kafkaExecutor.ts
 * ────────────────────────────
 * Executor per source_kafka e sink_kafka.
 *
 * FASE 1 (test locale Tauri):
 *   Kafka usa un protocollo binario TCP proprietario che richiede
 *   la libreria nativa librdkafka (crate rdkafka) — dipendenza C pesante
 *   non inclusa in fase 1.
 *
 *   In fase 1 l'executor logga un avviso e restituisce le righe
 *   in ingresso invariate (passthrough), così la pipeline non si blocca
 *   e può essere testata con altri nodi.
 *
 * FASE 2 (generazione codice Java/Python):
 *   Verrà generato codice nativo con librerie Kafka ufficiali.
 *
 * ALTERNATIVA FASE 1:
 *   Se il cluster Kafka espone una REST Proxy (Confluent REST Proxy),
 *   è possibile attivare la modalità HTTP che non richiede rdkafka.
 *   Configura l'URL della REST Proxy nel panel del nodo.
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Source Kafka ─────────────────────────────────────────────────

export const sourceKafkaExecutor: NodeExecutor = {
  handles: ['source_kafka'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props = node.data.props ?? {}
    const p     = (k: string, d = '') => String(props[k] ?? d)

    const topics    = p('topics', '').trim()
    const groupId   = p('groupId', 'flowpilot-consumer')
    const fetchMode = p('fetchMode', 'batch')

    // ── Modalità REST Proxy (opzionale in fase 1) ────────────────
    const restProxyUrl = p('restProxyUrl', '').trim()
    if (restProxyUrl) {
      return sourceKafkaRest(node, input, context, restProxyUrl, topics, groupId)
    }

    // ── Protocollo nativo — non disponibile in fase 1 ────────────
    context.callbacks.onLog('warn',
      `Kafka Source [${topics || 'topic non configurato'}]: ` +
      `il protocollo nativo Kafka non è disponibile in fase 1 (richiede librdkafka). ` +
      `Configura una REST Proxy URL nel panel per testare, ` +
      `oppure testa la pipeline con un nodo File/Script come sorgente. ` +
      `In fase 2 verrà generato codice Java/Python nativo.`,
      node.id,
    )

    // Passthrough — non blocca la pipeline
    return new Map([['output', input]])
  },
}

// ─── Source Kafka via REST Proxy ─────────────────────────────────

async function sourceKafkaRest(
  node:         FlowNode<NodeData>,
  _input:       Row[],
  context:      ExecutionContext,
  restProxyUrl: string,
  topics:       string,
  groupId:      string,
): Promise<Map<string, Row[]>> {

  const props = node.data.props ?? {}
  const p     = (k: string, d = '') => String(props[k] ?? d)

  const maxMessages  = parseInt(p('maxMessages', '100'), 10)
  const timeoutMs    = parseInt(p('pollTimeout', '5000'), 10)
  const valueFormat  = p('valueFormat', 'json')
  const topicList    = topics.split(',').map(t => t.trim()).filter(Boolean)

  if (topicList.length === 0) throw new Error('Kafka Source: nessun topic configurato')

  context.callbacks.onLog('info',
    `Kafka Source REST — ${restProxyUrl} | topics: ${topics} | group: ${groupId}`,
    node.id,
  )

  // Crea consumer group
  const consumerBase = `${restProxyUrl}/consumers/${encodeURIComponent(groupId)}`
  const instanceRes = await fetch(consumerBase, {
    method: 'POST',
    headers: { 'Content-Type': 'application/vnd.kafka.v2+json', 'Accept': 'application/vnd.kafka.v2+json' },
    body: JSON.stringify({
      name:           `flowpilot_${Date.now()}`,
      'auto.offset.reset': p('offsetMode', 'latest') === 'earliest' ? 'earliest' : 'latest',
      'auto.commit.enable': 'true',
    }),
  })
  if (!instanceRes.ok) throw new Error(`Kafka REST: errore creazione consumer — ${await instanceRes.text()}`)
  const instance = await instanceRes.json()
  const instanceUrl = instance.base_uri

  try {
    // Sottoscrivi ai topic
    await fetch(`${instanceUrl}/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/vnd.kafka.v2+json' },
      body: JSON.stringify({ topics: topicList }),
    })

    // Attendi brevemente per la riassegnazione delle partizioni
    await new Promise(r => setTimeout(r, 500))

    // Fetch messaggi
    const acceptHeader = valueFormat === 'json'
      ? 'application/vnd.kafka.json.v2+json'
      : 'application/vnd.kafka.binary.v2+json'

    const recordsRes = await fetch(
      `${instanceUrl}/records?timeout=${timeoutMs}&max_bytes=1048576`,
      { headers: { 'Accept': acceptHeader } }
    )
    if (!recordsRes.ok) throw new Error(`Kafka REST: errore fetch — ${await recordsRes.text()}`)

    const records = await recordsRes.json() as Array<{
      topic: string; partition: number; offset: number;
      key: unknown; value: unknown; timestamp?: number
    }>

    const rows: Row[] = records.slice(0, maxMessages).map(r => {
      const base: Row = {
        payload:   r.value,
        topic:     r.topic,
        partition: r.partition,
        offset:    r.offset,
      }
      if (p('includeMetadata') === 'true') {
        base._kafka_topic     = r.topic
        base._kafka_partition = r.partition
        base._kafka_offset    = r.offset
        base._kafka_key       = r.key
        if (r.timestamp) base._kafka_timestamp = new Date(r.timestamp).toISOString()
      }
      // Se il value è un oggetto JSON, espandi i campi a livello root
      if (r.value && typeof r.value === 'object') {
        return { ...base, ...r.value as Row }
      }
      return base
    })

    context.callbacks.onLog('info', `Kafka Source REST: ${rows.length} record letti`, node.id)
    return new Map([['output', rows]])

  } finally {
    // Pulisci il consumer instance
    fetch(instanceUrl, { method: 'DELETE' }).catch(() => {})
  }
}

// ─── Sink Kafka ───────────────────────────────────────────────────

export const sinkKafkaExecutor: NodeExecutor = {
  handles: ['sink_kafka'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props = node.data.props ?? {}
    const p     = (k: string, d = '') => String(props[k] ?? d)

    const topic       = p('topic', 'pipeline-output')
    const valueFormat = p('valueFormat', 'json')

    if (input.length === 0) {
      context.callbacks.onLog('warn', 'Kafka Sink: nessuna riga in ingresso', node.id)
      return new Map([['output', []]])
    }

    // ── Modalità REST Proxy ──────────────────────────────────────
    const restProxyUrl = p('restProxyUrl', '').trim()
    if (restProxyUrl) {
      return sinkKafkaRest(node, input, context, restProxyUrl, topic, valueFormat)
    }

    // ── Protocollo nativo — non disponibile in fase 1 ────────────
    context.callbacks.onLog('warn',
      `Kafka Sink [${topic}]: ` +
      `il protocollo nativo Kafka non è disponibile in fase 1 (richiede librdkafka). ` +
      `Configura una REST Proxy URL nel panel per testare. ` +
      `In fase 2 verrà generato codice Java/Python nativo.`,
      node.id,
    )

    return new Map([['output', [{
      _kafka_skipped: input.length,
      topic,
      reason:         'native_protocol_unavailable_phase1',
      completed_at:   new Date().toISOString(),
    }]]])
  },
}

// ─── Sink Kafka via REST Proxy ────────────────────────────────────

async function sinkKafkaRest(
  node:         FlowNode<NodeData>,
  input:        Row[],
  context:      ExecutionContext,
  restProxyUrl: string,
  topic:        string,
  valueFormat:  string,
): Promise<Map<string, Row[]>> {

  const props = node.data.props ?? {}
  const p     = (k: string, d = '') => String(props[k] ?? d)

  const keyField    = p('key_field', 'id')
  const keyType     = p('keyType', 'field')
  const contentType = valueFormat === 'json'
    ? 'application/vnd.kafka.json.v2+json'
    : 'application/vnd.kafka.binary.v2+json'

  context.callbacks.onLog('info',
    `Kafka Sink REST — ${restProxyUrl} | topic: ${topic} | ${input.length} record`,
    node.id,
  )

  // Prepara i record
  const records = input.map(row => {
    let key: unknown = null
    if (keyType === 'field' && keyField && row[keyField] !== undefined) {
      key = String(row[keyField])
    } else if (keyType === 'uuid') {
      key = crypto.randomUUID()
    }
    return { key, value: row }
  })

  // Invia in batch da 100
  const batchSize = 100
  let published = 0

  for (let i = 0; i < records.length; i += batchSize) {
    const batch = records.slice(i, i + batchSize)
    const res = await fetch(`${restProxyUrl}/topics/${encodeURIComponent(topic)}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType, 'Accept': 'application/vnd.kafka.v2+json' },
      body: JSON.stringify({ records: batch }),
    })
    if (!res.ok) throw new Error(`Kafka REST Sink: errore invio batch — ${await res.text()}`)
    const result = await res.json()
    published += result.offsets?.length ?? batch.length
  }

  context.callbacks.onLog('info', `Kafka Sink REST: ${published} record pubblicati`, node.id)

  return new Map([['output', [{
    _kafka_published: published,
    topic,
    completed_at:     new Date().toISOString(),
  }]]])
}
