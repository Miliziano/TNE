/**
 * src/runner/index.ts
 *
 * Modifiche rispetto alla versione precedente:
 *
 * - runPipeline: inizializza context.laneVariables dalla configurazione
 *   delle lane (deserializzando i valori per tipo). Questa Map è lo
 *   stato live condiviso tra tutti i nodi durante il run.
 *
 * - callbacks.updateLaneVariable: aggiorna sia context.laneVariables
 *   (immediato, per i nodi successivi) che lo store Zustand (per UI
 *   e run successivi).
 *
 * - callbacks.getLaneVariable: legge sempre da context.laneVariables,
 *   mai dallo snapshot stale di context.lanes.
 */

import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData } from '../types'
import type { Row, RunnerCallbacks, ExecutionContext, AnyExecutor } from './types'
import { isStreamingExecutor, deserializeLaneValue } from './types'
import { getExecutor } from './executors'
import { bridgeBus } from './bridgeBus'
import type { Lane } from '../types'
import {
  findErrorHandler,
  buildErrorRow,
  evalErrorRules,
  hasOutgoingEdge,
  type RuleMatch,
} from './errorHandling'
import { cleanupAbandoned } from './transactionCoordinator'
import { clearLogCounters } from './executors'
import { clearTMapIndexCache } from './tmapExecutor'
import { flushLogViewer } from '../store/useLogViewerStore'

// ─── Topological sort ─────────────────────────────────────────────
function topologicalSort(
  nodes: FlowNode<NodeData>[],
  edges: Edge[],
): FlowNode<NodeData>[] {
  const inDegree = new Map<string, number>()
  const adj      = new Map<string, string[]>()

  for (const n of nodes) { inDegree.set(n.id, 0); adj.set(n.id, []) }
  for (const e of edges) {
    if (!inDegree.has(e.target)) continue
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
    adj.get(e.source)?.push(e.target)
  }

  const queue:  FlowNode<NodeData>[] = []
  const result: FlowNode<NodeData>[] = []

  for (const n of nodes) {
    if ((inDegree.get(n.id) ?? 0) === 0) queue.push(n)
  }

  const collectAncestors = (nodeId: string, visited = new Set<string>()): Set<string> => {
    if (visited.has(nodeId)) return visited
    visited.add(nodeId)
    edges.filter((e) => e.target === nodeId)
      .forEach((e) => collectAncestors(e.source, visited))
    return visited
  }

  const tmapMainChain = new Set<string>()
  nodes.filter((n) => n.data.type === 'tmap').forEach((tmapNode) => {
    const tmap = tmapNode.data.config?.tmap as any
    if (!tmap) return
    edges.filter((e) => e.target === tmapNode.id).forEach((e) => {
      const inp = tmap.inputs?.find((i: any) => i.id === e.targetHandle)
      if (inp?.isMain !== true) return
      collectAncestors(e.source).forEach((id) => tmapMainChain.add(id))
    })
  })

  queue.sort((a, b) => {
    if (a.data.type === 'lane_start') return -1
    if (b.data.type === 'lane_start') return 1
    const aIsMain = tmapMainChain.has(a.id)
    const bIsMain = tmapMainChain.has(b.id)
    if (aIsMain && !bIsMain) return 1
    if (!aIsMain && bIsMain) return -1
    return 0
  })

  while (queue.length > 0) {
    const node = queue.shift()!
    result.push(node)
    for (const neighborId of (adj.get(node.id) ?? [])) {
      const newDeg = (inDegree.get(neighborId) ?? 0) - 1
      inDegree.set(neighborId, newDeg)
      if (newDeg === 0) {
        const neighbor = nodes.find((n) => n.id === neighborId)
        if (neighbor) queue.push(neighbor)
      }
    }
  }
  return result
}

// ─── collectInput ─────────────────────────────────────────────────
function collectInput(
  nodeId:  string,
  edges:   Edge[],
  outputs: Map<string, Map<string, Row[]>>,
): Row[] {
  const inEdges = edges.filter((e) => e.target === nodeId)
  const rows: Row[] = []
  for (const edge of inEdges) {
    const sourceOutputs = outputs.get(edge.source)
    if (!sourceOutputs) continue
    const handle       = edge.sourceHandle ?? 'output'
    const edgeRows     = sourceOutputs.get(handle) ?? []
    const targetHandle = edge.targetHandle
    if (targetHandle && targetHandle !== 'input') {
      rows.push(...edgeRows.map((r) => ({ ...r, __sourceHandle: targetHandle })))
    } else {
      rows.push(...edgeRows)
    }
  }
  return rows
}

// ─── Verifica convergenza ─────────────────────────────────────────
function allPredecessorsDone(
  nodeId:  string,
  edges:   Edge[],
  outputs: Map<string, Map<string, Row[]>>,
): boolean {
  return edges
    .filter((e) => e.target === nodeId)
    .every((e) => outputs.has(e.source))
}

// ─── Nodi raggiungibili ───────────────────────────────────────────
function reachableFrom(
  sourceNodeId: string,
  nodes:        FlowNode<NodeData>[],
  edges:        Edge[],
  sourceHandle?: string,
): FlowNode<NodeData>[] {
  const visited = new Set<string>()
  const queue: string[] = []

  const directEdges = sourceHandle
    ? edges.filter((e) => e.source === sourceNodeId && e.sourceHandle === sourceHandle)
    : edges.filter((e) => e.source === sourceNodeId)

  directEdges.forEach((e) => queue.push(e.target))

  while (queue.length > 0) {
    const id = queue.shift()!
    if (visited.has(id)) continue
    visited.add(id)
    edges.filter((e) => e.source === id).forEach((e) => {
      if (!visited.has(e.target)) queue.push(e.target)
    })
  }

  return nodes.filter((n) => visited.has(n.id))
}

// ─── executeBranch ────────────────────────────────────────────────
async function executeBranch(
  branchNodes: FlowNode<NodeData>[],
  allEdges:    Edge[],
  outputs:     Map<string, Map<string, Row[]>>,
  context:     ExecutionContext,
): Promise<void> {
  const branchIds   = new Set(branchNodes.map((n) => n.id))
  const branchEdges = allEdges.filter((e) => branchIds.has(e.source) && branchIds.has(e.target))
  const sorted      = topologicalSort(branchNodes, branchEdges)

  for (const node of sorted) {
    if (context.callbacks.isAborted()) break
    if (!allPredecessorsDone(node.id, allEdges, outputs)) continue
    const ok = await executeNode(node, allEdges, outputs, context)
    if (!ok) return
  }
}

// ─── routeToErrorHandler ─────────────────────────────────────────
function routeToErrorHandler(
  node:           FlowNode<NodeData>,
  errorRow:       Row,
  excludeFromLog: boolean,
  isExplicit:     boolean,
  context:        ExecutionContext,
): boolean {
  const errorHandler = findErrorHandler(context, node.data.laneId)
  if (!errorHandler) return false

  let send = !excludeFromLog
  if (send && isExplicit) {
    send = (errorHandler.data.props?.['logAll'] ?? 'true') !== 'false'
  }
  if (!send) return false

  const bucket = context.errorRows.get(errorHandler.id) ?? []
  bucket.push(errorRow)
  context.errorRows.set(errorHandler.id, bucket)
  context.callbacks.onLog('warn',
    `→ Error Handler (${isExplicit ? 'copia — gestito da catch' : 'non gestito'})`,
    node.id)
  return true
}

// ─── executeNode ──────────────────────────────────────────────────
async function executeNode(
  node:    FlowNode<NodeData>,
  edges:   Edge[],
  outputs: Map<string, Map<string, Row[]>>,
  context: ExecutionContext,
): Promise<boolean> {
  const executor = getExecutor(node.data.type)

  if (!executor) {
    context.callbacks.onLog('warn', `Nodo '${node.data.type}' non supportato — saltato`, node.id)
    const input = collectInput(node.id, edges, outputs)
    outputs.set(node.id, new Map([['output', input]]))
    return true
  }

  if (isStreamingExecutor(executor)) {
    return executeStreamingNode(node, edges, outputs, context, executor)
  }

  const input = collectInput(node.id, edges, outputs)
  context.callbacks.onNodeStart(node.id)
  const startMs = Date.now()

  const adv          = node.data.config?.advanced
  const onError      = adv?.onError ?? 'stop'
  const baseRetries  = parseInt(adv?.retryCount ?? '0', 10)
  const retryDelayMs = parseInt(adv?.retryDelaySec ?? '0', 10) * 1000
  const errorHandler = findErrorHandler(context, node.data.laneId)

  let nodeOutputs: Map<string, Row[]> | undefined
  let lastMessage  = ''
  let lastRule: RuleMatch | null = null
  let attempt      = 0

  while (true) {
    try {
      nodeOutputs = await executor.execute(node, input, context)
      break
    } catch (err) {
      lastMessage = err instanceof Error ? err.message : String(err)
      lastRule    = evalErrorRules(errorHandler, node, lastMessage)

      const maxRetries = lastRule?.action === 'retry'
        ? (lastRule.retryCount ?? baseRetries)
        : onError === 'retry' ? baseRetries : 0

      if (attempt < maxRetries) {
        attempt++
        context.callbacks.onLog('warn',
          `${node.data.type}: tentativo ${attempt}/${maxRetries} — ${lastMessage}`, node.id)
        if (retryDelayMs > 0) await new Promise((r) => setTimeout(r, retryDelayMs))
        continue
      }
      break
    }
  }

  if (nodeOutputs) {
    const durationMs = Date.now() - startMs
    const outputRows = nodeOutputs.get('output') ?? []
    context.callbacks.onNodeDone({ nodeId: node.id, ok: true, rowsIn: input.length, rowsOut: outputRows.length })
    context.callbacks.onLog('debug', `${node.data.type} — ${input.length}→${outputRows.length} righe (${durationMs}ms)`, node.id)
    outputs.set(node.id, nodeOutputs)
    return true
  }

  context.callbacks.onLog('error', `❌ Errore in ${node.data.type}: ${lastMessage}`, node.id)
  context.callbacks.onNodeDone({ nodeId: node.id, ok: false, message: lastMessage, rowsIn: input.length, rowsOut: 0 })

  const excludeFromLog = adv?.excludeFromErrorLog === 'true'
  const critical       = adv?.critical === 'true'

  if (lastRule?.action === 'ignore') {
    outputs.set(node.id, new Map([['output', []]]))
    return !critical
  }

  const hasCatchEdge = onError === 'propagate' && hasOutgoingEdge(edges, node.id, 'catch')
  const errorRow     = buildErrorRow(lastMessage, node, input[0] ?? {}, hasCatchEdge ? 'explicit' : 'unhandled')
  routeToErrorHandler(node, errorRow, excludeFromLog, hasCatchEdge, context)

  if (onError === 'propagate') {
    const catchMap = new Map<string, Row[]>([['output', []]])
    if (hasCatchEdge) catchMap.set('catch', [errorRow])
    outputs.set(node.id, catchMap)
    return !critical
  }

  if (lastRule?.action === 'skip' || onError === 'skip') {
    outputs.set(node.id, new Map([['output', input]]))
    return !critical
  }

  outputs.set(node.id, new Map([['output', []]]))
  return false
}

// ─── executeStreamingNode ─────────────────────────────────────────
async function executeStreamingNode(
  node:     FlowNode<NodeData>,
  edges:    Edge[],
  outputs:  Map<string, Map<string, Row[]>>,
  context:  ExecutionContext,
  executor: import('./types').StreamingNodeExecutor,
): Promise<boolean> {
  const input    = collectInput(node.id, edges, outputs)
  const allNodes = context.nodes
  const allEdges = context.edges

  context.callbacks.onNodeStart(node.id)

  let downstreamNodes: FlowNode<NodeData>[]
  if (node.data.type === 'sequencer') {
    const seqHandleEdges = allEdges.filter(
      (e) => e.source === node.id && /^seq_\d+$/.test(e.sourceHandle ?? '')
    )
    const seqExcludedIds = new Set<string>()
    for (const e of seqHandleEdges) {
      seqExcludedIds.add(e.target)
      reachableFrom(e.target, allNodes, allEdges).forEach((n) => seqExcludedIds.add(n.id))
    }
    downstreamNodes = reachableFrom(node.id, allNodes, allEdges)
      .filter((n) => !seqExcludedIds.has(n.id))
  } else {
    downstreamNodes = reachableFrom(node.id, allNodes, allEdges)
  }

  const downstreamIds   = new Set(downstreamNodes.map((n) => n.id))
  const downstreamEdges = allEdges.filter(
    (e) => downstreamIds.has(e.source) && downstreamIds.has(e.target)
  )
  const sortedDownstream = topologicalSort(downstreamNodes, downstreamEdges)

  context.callbacks.onLog('debug',
    `Streaming: ${node.data.type} → [${sortedDownstream.map((n) => n.data.type).join(', ')}]`,
    node.id)

  let totalRows = 0

  const onRow = async (row: Row): Promise<void> => {
    if (context.callbacks.isAborted()) return
    totalRows++

    const outputHandle = (row as any).__tmapOutputHandle as string | undefined
    const cleanRow     = outputHandle ? { ...row } : row
    if (outputHandle) delete (cleanRow as any).__tmapOutputHandle

    const handle = outputHandle ?? 'output'
    outputs.set(node.id, new Map([[handle, [cleanRow]]]))

    const subOutputs = new Map(outputs)

    for (const downstream of sortedDownstream) {
      if (context.callbacks.isAborted()) break

      const inEdges  = allEdges.filter((e) => e.target === downstream.id)
      const allReady = inEdges.every((e) => {
        if (!subOutputs.has(e.source)) return false
        const srcHandle = e.sourceHandle ?? 'output'
        const srcOutput = subOutputs.get(e.source)
        return (srcOutput?.get(srcHandle)?.length ?? 0) > 0
      })
      if (!allReady) continue

      const downExec = getExecutor(downstream.data.type)
      if (downExec && isStreamingExecutor(downExec)) continue

      if (downExec && !isStreamingExecutor(downExec)) {
        const requiresComplete = (downExec as import('./types').NodeExecutor).requiresCompleteInput
        if (requiresComplete) {
          const edgeFromStream = allEdges.find(
            (e) => e.source === node.id && e.target === downstream.id
          )
          const targetHandle = edgeFromStream?.targetHandle ?? 'input'
          if (requiresComplete(downstream, targetHandle)) continue
        }
      }

      const downInput = collectInput(downstream.id, allEdges, subOutputs)
      if (downInput.length === 0) continue

      context.callbacks.onNodeStart(downstream.id)
      const startMs = Date.now()

      try {
        const downOutput = await (downExec as import('./types').NodeExecutor).execute(downstream, downInput, context)
        const durationMs = Date.now() - startMs
        const outCount   = Array.from(downOutput.values()).reduce((s, r) => s + r.length, 0)
        context.callbacks.onNodeDone({ nodeId: downstream.id, ok: true, rowsIn: downInput.length, rowsOut: outCount })
        context.callbacks.onLog('debug', `${downstream.data.type} — ${downInput.length}→${outCount} righe (${durationMs}ms)`, downstream.id)
        subOutputs.set(downstream.id, downOutput)
        outputs.set(downstream.id, downOutput)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error', `❌ Errore in ${downstream.data.type}: ${message}`, downstream.id)
        context.callbacks.onNodeDone({ nodeId: downstream.id, ok: false, message, rowsIn: downInput.length, rowsOut: 0 })
        const dAdv = downstream.data.config?.advanced
        const excludeFromLog = dAdv?.excludeFromErrorLog === 'true'
        const errorRow = buildErrorRow(message, downstream, downInput[0] ?? {}, 'unhandled')
        routeToErrorHandler(downstream, errorRow, excludeFromLog, false, context)
      }
    }
  }

  const onDone = (count: number) => {
    context.callbacks.onNodeDone({ nodeId: node.id, ok: true, rowsIn: input.length, rowsOut: count })
    outputs.set(node.id, new Map([['output', []]]))
  }

  try {
    await executor.execute(node, input, context, onRow, onDone)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    context.callbacks.onLog('error', `❌ Errore in ${node.data.type}: ${message}`, node.id)
    context.callbacks.onNodeDone({ nodeId: node.id, ok: false, message, rowsIn: input.length, rowsOut: totalRows })

    const adv            = node.data.config?.advanced
    const onError        = adv?.onError ?? 'stop'
    const excludeFromLog = adv?.excludeFromErrorLog === 'true'
    const critical       = adv?.critical === 'true'
    const errorHandler   = findErrorHandler(context, node.data.laneId)
    const rule           = evalErrorRules(errorHandler, node, message)

    if (rule?.action === 'ignore') { outputs.set(node.id, new Map([['output',[]]])); return !critical }

    const errorRow = buildErrorRow(message, node, input[0] ?? {}, 'unhandled')
    routeToErrorHandler(node, errorRow, excludeFromLog, false, context)
    outputs.set(node.id, new Map([['output', []]]))

    if (critical) return false
    if (rule?.action === 'skip' || onError === 'skip' || onError === 'propagate') return true
    return false
  }

  return true
}

// ─── runSubPipeline ───────────────────────────────────────────────
async function runSubPipeline(
  startNodeId: string,
  laneId:      string,
  context:     ExecutionContext,
): Promise<{ ok: boolean; error?: string }> {
  try {
    const laneNodes = context.nodes.filter((n) => n.data.laneId === laneId)
    const laneEdges = context.edges.filter((e) => {
      const src = context.nodes.find((n) => n.id === e.source)
      return src?.data.laneId === laneId
    })

    const reachable    = reachableFrom(startNodeId, laneNodes, laneEdges)
    const reachableIds = new Set(reachable.map((n) => n.id))
    reachableIds.add(startNodeId)

    const subNodes = laneNodes.filter((n) => reachableIds.has(n.id))
    const subEdges = laneEdges.filter(
      (e) => reachableIds.has(e.source) && reachableIds.has(e.target)
    )

    if (subNodes.length === 0)
      return { ok: false, error: `Sequencer: nessun nodo raggiungibile da ${startNodeId}` }

    context.callbacks.onLog('info',
      `Sequencer: avvio sub-pipeline da ${startNodeId} — ${subNodes.length} nodi`, startNodeId)

    await runLane(subNodes, subEdges, context)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ─── persistIdentityMaps ──────────────────────────────────────────
function persistIdentityMaps(context: ExecutionContext): void {
  const sinkNodes = context.nodes.filter((n) => n.data.type === 'sink_db')
  for (const node of sinkNodes) {
    const props       = node.data.props ?? {}
    const persistMode = props['identityMapPersist'] ?? 'none'
    if (persistMode === 'none') continue

    const varName = (props['identityMapVarName'] ?? '').trim()
    if (!varName) continue

    const map = context.identityMaps.get(node.id)
    if (!map) continue

    const laneId = node.data.laneId

    if (persistMode === 'lane_var_tx_reset') {
      const txGroupRaw = props['transactionGroup']
      if (txGroupRaw) {
        try {
          const txCfg    = JSON.parse(txGroupRaw)
          const txKey    = `${laneId}::${txCfg.id}`
          const txState  = context.transactions.get(txKey)
          const txStatus = (txState as any)?.status ?? (txState as any)?.phase ?? (txState as any)?.outcome
          if (txStatus === 'rolled_back' || txStatus === 'rollback' || txStatus === 'aborted') {
            const snapshot   = context.identityMapSnapshots.get(node.id) ?? new Map()
            const serialized = JSON.stringify(Object.fromEntries(snapshot))
            context.callbacks.updateLaneVariable(laneId, varName, serialized)
            context.callbacks.onLog('info', `SinkDB: identity map ripristinata da snapshot → '${varName}'`, node.id)
            continue
          }
        } catch {}
      }
    }

    const serialized = JSON.stringify(Object.fromEntries(map))
    context.callbacks.updateLaneVariable(laneId, varName, serialized)
    context.callbacks.onLog('info', `SinkDB: identity map persistita → '${varName}' (${map.size} entries)`, node.id)
  }
}

// ─── runPipeline ──────────────────────────────────────────────────
export async function runPipeline(
  nodes:     FlowNode<NodeData>[],
  edges:     Edge[],
  lanes:     Lane[],
  callbacks: Omit<RunnerCallbacks, 'runSubPipeline' | 'getLaneVariable'>,
): Promise<void> {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`

  clearLogCounters()
  clearTMapIndexCache()

  // ── Inizializza laneVariables — stato live condiviso ──────────
  // Legge i valori iniziali da tutte le lane e li deserializza per tipo.
  // Da questo momento in poi, tutti i nodi leggono/scrivono qui,
  // non in context.lanes.variables (che rimane snapshot immutabile).
  const laneVariables = new Map<string, unknown>()
  for (const lane of lanes) {
    for (const v of lane.variables ?? []) {
      const key = `${lane.id}::${v.name}`
      laneVariables.set(key, deserializeLaneValue(v.value, v.type))
    }
  }

  // ── Identity maps ──────────────────────────────────────────────
  const identityMaps:         Map<string, Map<string, unknown>> = new Map()
  const identityMapSnapshots: Map<string, Map<string, unknown>> = new Map()

  for (const node of nodes.filter((n) => n.data.type === 'sink_db')) {
    const props       = node.data.props ?? {}
    const persistMode = props['identityMapPersist'] ?? 'none'
    if (persistMode === 'none') continue
    const varName = (props['identityMapVarName'] ?? '').trim()
    if (!varName) continue
    const lane     = lanes.find((l) => l.id === node.data.laneId)
    const variable = lane?.variables.find((v) => v.name === varName)
    if (!variable?.value) continue
    try {
      const parsed = JSON.parse(variable.value)
      const map    = new Map<string, unknown>(Object.entries(parsed))
      identityMaps.set(node.id, map)
      identityMapSnapshots.set(node.id, new Map(map))
    } catch {}
  }

  // ── Costruisce i callbacks con getLaneVariable ─────────────────
  const context: ExecutionContext = {
    runId, nodes, edges,
    callbacks: {
      ...callbacks,
      runSubPipeline: async () => ({ ok: false, error: 'non inizializzato' }),

      // Aggiorna sia la Map live (per i nodi successivi nello stesso run)
      // che lo store Zustand (per UI e run successivi)
      updateLaneVariable: (laneId: string, varName: string, value: string) => {
        const key = `${laneId}::${varName}`
        // Deserializza il valore per mantenerlo nel tipo corretto nella Map
        // (es. '42' → 42 se la variabile è di tipo number)
        const lane     = lanes.find(l => l.id === laneId)
        const varDef   = lane?.variables.find(v => v.name === varName)
        const deserialized = deserializeLaneValue(value, varDef?.type)
        laneVariables.set(key, deserialized)
        // Aggiorna anche lo store Zustand
        callbacks.updateLaneVariable?.(laneId, varName, value)
      },

      // Legge sempre dalla Map live — mai dallo snapshot stale di lanes
      getLaneVariable: (laneId: string, varName: string): unknown => {
        return laneVariables.get(`${laneId}::${varName}`)
      },
    },
    materialize:          new Map(),
    errorRows:            new Map(),
    transactions:         new Map(),
    lanes,
    laneVariables,
    identityMaps,
    identityMapSnapshots,
  }

  context.callbacks.runSubPipeline = (startNodeId: string, laneId: string) =>
    runSubPipeline(startNodeId, laneId, context)

  const laneIds = [...new Set(nodes.map((n) => n.data.laneId))]
  callbacks.onLog('info', `▶ Avvio — runId: ${runId} | lane: ${laneIds.join(', ')}`)

  try {
    await Promise.all(
      laneIds.map((laneId) => {
        if (callbacks.isAborted()) return Promise.resolve()
        const laneNodes = nodes.filter((n) => n.data.laneId === laneId)
        const laneEdges = edges.filter((e) => {
          const src = nodes.find((n) => n.id === e.source)
          return src?.data.laneId === laneId
        })
        return runLane(laneNodes, laneEdges, context)
      })
    )
  } finally {
    await cleanupAbandoned(context)
    persistIdentityMaps(context)
    flushLogViewer()
    nodes.filter((n) => n.data.type === 'bridge_in').forEach((n) => {
      const ch = String(n.data.props?.channelName ?? '')
      if (ch) bridgeBus.abort(runId, ch)
    })
    bridgeBus.cleanup(runId)
  }

  if (callbacks.isAborted()) callbacks.onLog('warn', '⏹ Esecuzione interrotta.')
  else                        callbacks.onLog('ok',   '✓ Esecuzione completata.')
}

// ─── processErrorHandler ─────────────────────────────────────────
async function processErrorHandler(
  nodes:   FlowNode<NodeData>[],
  edges:   Edge[],
  outputs: Map<string, Map<string, Row[]>>,
  context: ExecutionContext,
): Promise<void> {
  const isTopLevelLane = nodes.some((n) => n.data.type === 'lane_start')
  if (!isTopLevelLane) return

  const errorHandlerNode = nodes.find((n) => n.data.type === 'error_handler')
  if (!errorHandlerNode) return

  const errorRows = context.errorRows.get(errorHandlerNode.id) ?? []
  outputs.set(errorHandlerNode.id, new Map([['error_out', errorRows]]))
  context.callbacks.onNodeDone({ nodeId: errorHandlerNode.id, ok: true, rowsIn: 0, rowsOut: errorRows.length })
  if (errorRows.length === 0) return

  context.callbacks.onLog('info', `Error Handler: ${errorRows.length} righe d'errore`, errorHandlerNode.id)

  const downstream      = reachableFrom(errorHandlerNode.id, nodes, edges, 'error_out')
  if (downstream.length === 0) return

  const downstreamIds   = new Set(downstream.map((n) => n.id))
  const downstreamEdges = edges.filter((e) => downstreamIds.has(e.source) && downstreamIds.has(e.target))
  const sorted          = topologicalSort(downstream, downstreamEdges)

  for (const node of sorted) {
    if (context.callbacks.isAborted()) break
    if (!allPredecessorsDone(node.id, edges, outputs)) continue
    const ok = await executeNode(node, edges, outputs, context)
    if (!ok) break
  }
}

// ─── releaseIfDone ────────────────────────────────────────────────
function releaseIfDone(
  nodeId:   string,
  edges:    Edge[],
  executed: Set<string>,
  outputs:  Map<string, Map<string, Row[]>>,
): void {
  const allSuccDone = edges
    .filter((e) => e.source === nodeId)
    .every((e) => executed.has(e.target))
  if (allSuccDone) outputs.delete(nodeId)
}

// ─── runLane ─────────────────────────────────────────────────────
async function runLane(
  nodes:   FlowNode<NodeData>[],
  edges:   Edge[],
  context: ExecutionContext,
): Promise<void> {
  const sorted   = topologicalSort(nodes, edges)
  const outputs  = new Map<string, Map<string, Row[]>>()
  const nodeById = new Map(nodes.map((n) => [n.id, n]))
  const executed = new Set<string>()
  let aborted    = false

  mainLoop:
  for (const node of sorted) {
    if (context.callbacks.isAborted()) { aborted = true; break }
    if (executed.has(node.id)) continue
    if (!allPredecessorsDone(node.id, edges, outputs)) continue

    if (node.data.type === 'filter') {
      const ok = await executeNode(node, edges, outputs, context)
      if (!ok) { aborted = true; break mainLoop }
      executed.add(node.id)

      const filterConfig = node.data.config?.filter as any
      const execMode     = filterConfig?.execMode ?? 'parallel'
      const conditions   = filterConfig?.conditions ?? []

      if (execMode !== 'parallel' && conditions.length > 0) {
        const handles = [
          ...conditions.map((c: any) => ({ id: c.id, label: c.label })),
          { id: 'reject', label: 'reject' },
        ]
        for (const handle of handles) {
          if (context.callbacks.isAborted()) break
          const branchNodes = reachableFrom(node.id, nodes, edges, handle.id)
          if (branchNodes.length === 0) continue
          if (execMode === 'ordered_wait') await executeBranch(branchNodes, edges, outputs, context)
          for (const bn of branchNodes) executed.add(bn.id)
        }
      }
      continue
    }

    const executor = getExecutor(node.data.type)
    if (executor && isStreamingExecutor(executor)) {
      const ok = await executeNode(node, edges, outputs, context)
      if (!ok) { aborted = true; break mainLoop }
      executed.add(node.id)
      reachableFrom(node.id, nodes, edges).forEach((n) => executed.add(n.id))
      edges.filter((e) => e.target === node.id)
        .forEach((e) => releaseIfDone(e.source, edges, executed, outputs))
      outputs.delete(node.id)
      continue
    }

    const ok = await executeNode(node, edges, outputs, context)
    if (!ok) { aborted = true; break mainLoop }
    executed.add(node.id)

    edges.filter((e) => e.target === node.id)
      .forEach((e) => releaseIfDone(e.source, edges, executed, outputs))

    const successors = edges
      .filter((e) => e.source === node.id)
      .map((e) => nodeById.get(e.target))
      .filter(Boolean) as FlowNode<NodeData>[]

    for (const succ of successors) {
      if (executed.has(succ.id)) continue
      const inEdges = edges.filter((e) => e.target === succ.id)
      if (inEdges.length > 1 && allPredecessorsDone(succ.id, edges, outputs)) {
        const ok2 = await executeNode(succ, edges, outputs, context)
        if (!ok2) { aborted = true; break mainLoop }
        executed.add(succ.id)
        edges.filter((e) => e.target === succ.id)
          .forEach((e) => releaseIfDone(e.source, edges, executed, outputs))
      }
    }
  }

  if (!aborted) {
    for (const node of sorted) {
      if (context.callbacks.isAborted()) { aborted = true; break }
      if (executed.has(node.id)) continue
      if (!allPredecessorsDone(node.id, edges, outputs)) continue
      const ok = await executeNode(node, edges, outputs, context)
      if (!ok) { aborted = true; break }
      executed.add(node.id)
      edges.filter((e) => e.target === node.id)
        .forEach((e) => releaseIfDone(e.source, edges, executed, outputs))
    }
  }

  await processErrorHandler(nodes, edges, outputs, context)
}