/**
 * src/ir/dagValidation.ts
 */

import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { isLegacyRuleAction } from '../types'
import { parseScript, istruzioniUsate, variabiliDiLaneUsate, ScriptParseError } from './scriptParser'
import type {
  LogicalPlan, LogicalNode, ValidationIssue, ValidationResult, ExecutionSemantics,
} from './types'
import { topologicalSort, canvasNodeId } from './lowering'
import { queryParamNames, quotedParamNames } from './queryParams'
import { getNodeSemantics } from './nodeSemantics'
import { propagateSchema } from './schemaPropagation'

const XA_COMPATIBLE_DIALECTS = new Set([
  'postgresql', 'mysql', 'oracle', 'sqlserver', 'kafka',
])

export function validateDAG(plan: LogicalPlan): ValidationResult {
  const issues: ValidationIssue[] = []

  const cycleIssues = checkCycles(plan)
  issues.push(...cycleIssues)
  if (cycleIssues.some((i) => i.severity === 'error')) return buildResult(issues)

  issues.push(...checkDisconnectedNodes(plan))
  issues.push(...checkOrphanEdges(plan))
  issues.push(...checkBridgePairs(plan))
  issues.push(...checkBridgeLaneCycles(plan))
  issues.push(...checkBridgeJoinPattern(plan))
  issues.push(...checkMissingSinks(plan))
  issues.push(...checkNotImplemented(plan))
  issues.push(...checkOrdineTrasformazioni(plan))
  issues.push(...checkFiltroSuCampoDiUscita(plan))
  issues.push(...checkSchemaDedotto(plan))
  issues.push(...checkTipiIncompatibili(plan))
  issues.push(...checkNodiDisabilitati(plan))
  issues.push(...checkScriptGeneratoreConIngresso(plan))
  issues.push(...checkAutoJoin(plan))

  // NB: lo schema si assume GIÀ propagato dal chiamante (runValidation /
  // runCompilation lo fanno prima di chiamare validateDAG). NON ri-propaghiamo
  // qui: farlo raddoppierebbe ogni schema-issue (venivano emessi una volta dal
  // chiamante e una seconda da questa funzione → tutti gli avvisi doppi).
  issues.push(...checkExecutionSemantics(plan))
  issues.push(...checkUnresolvedHandles(plan))
  issues.push(...checkDataContracts(plan))
  issues.push(...validateTransactionGroups(plan))
  issues.push(...checkCatchHandles(plan))

  return buildResult(issues)
}
function checkCatchHandles(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  plan.nodes.forEach((node) => {
    if (node.operation === 'lane_boundary') return

    // Nodo con porta catch dichiarata
    const hasCatchPort = node.outputs.some((p) => p.id === 'catch')
    if (!hasCatchPort) return

    // Verifica se catch è collegato
    const catchConnected = plan.edges.some(
      (e) => e.source === node.id && e.sourcePort === 'catch'
    )
    if (!catchConnected) {
      issues.push({
        nodeId:   canvasNodeId(node.id),
        code:     'CATCH_NOT_CONNECTED',
        message:  `Node "${node._uiRef?.label ?? node.id}" captures errors on the node but the catch handle is not connected — rows in error would be lost`,
        severity: 'warning',
        hint:     'Connect the catch handle downstream, or choose "Error handler" as the error-handling mode',
      })
    }
  })

  return issues
}
function buildResult(issues: ValidationIssue[]): ValidationResult {
  const errors   = issues.filter((i) => i.severity === 'error')
  const warnings = issues.filter((i) => i.severity === 'warning')
  return { valid: errors.length === 0, issues, errors, warnings }
}

// ─── CHECK 1 — CICLI ──────────────────────────────────────────────

function checkCycles(plan: LogicalPlan): ValidationIssue[] {
  const sorted = topologicalSort(plan)
  if (sorted !== null) return []

  const cycleNodes = findCycleNodes(plan)
  return [
    { code: 'CYCLE_DETECTED', message: 'The DAG contains a cycle — the pipeline cannot run', severity: 'error', hint: 'Remove one of the connections that create the cycle' },
    ...cycleNodes.map((nodeId): ValidationIssue => ({
      nodeId, code: 'NODE_IN_CYCLE', message: 'This node is part of a cycle', severity: 'error',
    })),
  ]
}

function findCycleNodes(plan: LogicalPlan): string[] {
  const visited  = new Set<string>()
  const inStack  = new Set<string>()
  const cycleIds = new Set<string>()

  const adj = new Map<string, string[]>()
  plan.nodes.forEach((n) => adj.set(n.id, []))
  plan.edges.forEach((e) => adj.get(e.source)?.push(e.target))

  function dfs(nodeId: string): boolean {
    visited.add(nodeId); inStack.add(nodeId)
    for (const neighbor of adj.get(nodeId) ?? []) {
      if (!visited.has(neighbor)) {
        if (dfs(neighbor)) { cycleIds.add(nodeId); return true }
      } else if (inStack.has(neighbor)) {
        cycleIds.add(nodeId); cycleIds.add(neighbor); return true
      }
    }
    inStack.delete(nodeId); return false
  }

  plan.nodes.forEach((n) => { if (!visited.has(n.id)) dfs(n.id) })
  return Array.from(cycleIds).map(canvasNodeId)
}

// ─── CHECK 2 — NODI ISOLATI ───────────────────────────────────────

function checkDisconnectedNodes(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const connectedIds = new Set<string>()
  plan.edges.forEach((e) => { connectedIds.add(e.source); connectedIds.add(e.target) })

  plan.nodes.forEach((node) => {
    if (node.operation === 'lane_boundary') return
    if (!connectedIds.has(node.id)) {
      issues.push({
        nodeId:   canvasNodeId(node.id),
        code:     'ISOLATED_NODE',
        message:  `Node "${node._uiRef?.label ?? node.id}" is not connected to any other node`,
        severity: 'warning',
        hint:     'Connect the node to the pipeline or remove it',
      })
    }
  })

  return issues
}

// ─── CHECK 3 — SORGENTI SENZA SINK ────────────────────────────────

function checkMissingSinks(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const sinkIds = new Set(
    plan.nodes.filter((n) => n.operation === 'sink').map((n) => n.id)
  )

  if (sinkIds.size === 0) {
    issues.push({
      code: 'NO_SINK', message: 'The pipeline has no destination (sink) nodes',
      severity: 'warning', hint: 'Add a DB Sink, File Output or Kafka node',
    })
    return issues
  }

  const sourceNodes = plan.nodes.filter(
    (n) => n.inputs.length === 0 && n.operation === 'scan'
  )

  const adj = new Map<string, string[]>()
  plan.nodes.forEach((n) => adj.set(n.id, []))
  plan.edges.forEach((e) => adj.get(e.source)?.push(e.target))

  sourceNodes.forEach((src) => {
    const reachable = new Set<string>()
    const queue = [src.id]
    while (queue.length > 0) {
      const id = queue.shift()!
      reachable.add(id)
      adj.get(id)?.forEach((n) => { if (!reachable.has(n)) queue.push(n) })
    }
    if (!Array.from(sinkIds).some((id) => reachable.has(id))) {
      issues.push({
        nodeId:   canvasNodeId(src.id),
        code:     'SOURCE_NO_SINK',
        message:  `Source node "${src._uiRef?.label ?? src.id}" does not reach any sink`,
        severity: 'warning',
        hint:     'Connect this node to a destination node',
      })
    }
  })

  return issues
}

// ─── CHECK 4 — BRIDGE PAIRS ───────────────────────────────────────

function checkBridgePairs(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const outNodes = plan.nodes.filter((n) => n._uiRef?.type === 'bridge_out')
  const inNodes  = plan.nodes.filter((n) => n._uiRef?.type === 'bridge_in')

  outNodes.forEach((outNode) => {
    const channelName = (outNode._uiRef?.config as Record<string, unknown>)?.channelName as string
    if (!channelName) {
      issues.push({
        nodeId: canvasNodeId(outNode.id), code: 'BRIDGE_NO_CHANNEL',
        message: 'BridgeOut with no channel name configured', severity: 'error',
        hint: 'Configure the channel name in the node panel',
      })
      return
    }
    const hasCounterpart = inNodes.some((n) => {
      const cfg = n._uiRef?.config as Record<string, unknown>
      return cfg?.channelName === channelName
    })
    if (!hasCounterpart) {
      issues.push({
        nodeId: canvasNodeId(outNode.id), code: 'BRIDGE_MISSING_IN',
        message: `BridgeOut "${channelName}" has no matching BridgeIn in any other lane`,
        severity: 'error',
        hint: `Add a BridgeIn node with channel "${channelName}" in the destination lane`,
      })
    }
  })

  inNodes.forEach((inNode) => {
    const channelName = (inNode._uiRef?.config as Record<string, unknown>)?.channelName as string
    if (!channelName) {
      issues.push({
        nodeId: canvasNodeId(inNode.id), code: 'BRIDGE_NO_CHANNEL',
        message: 'BridgeIn with no channel name configured', severity: 'error',
        hint: 'Configure the channel name in the node panel',
      })
      return
    }
    const hasCounterpart = outNodes.some((n) => {
      const cfg = n._uiRef?.config as Record<string, unknown>
      return cfg?.channelName === channelName
    })
    if (!hasCounterpart) {
      issues.push({
        nodeId: canvasNodeId(inNode.id), code: 'BRIDGE_MISSING_OUT',
        message: `BridgeIn "${channelName}" has no matching BridgeOut in any other lane`,
        severity: 'error',
        hint: `Add a BridgeOut node with channel "${channelName}" in the source lane`,
      })
    }
  })

  // ── Cardinalità del canale (1 OUT ↔ 1 IN) ──────────────────────
  // Il motore crea UN canale per bridge_id (= nome canale) con UN
  // sender e UN receiver, prelevati con take(): la seconda richiesta
  // torna None. Oggi un canale duplicato esplode a runtime con
  // "bridge_id non trovato", che indica la causa sbagliata. Lo diciamo
  // qui, prima del Run.
  const byChannel = (list: typeof outNodes) => {
    const m = new Map<string, typeof outNodes>()
    list.forEach((n) => {
      const ch = (n._uiRef?.config as Record<string, unknown>)?.channelName as string
      if (!ch) return
      const arr = m.get(ch) ?? []
      arr.push(n)
      m.set(ch, arr)
    })
    return m
  }

  byChannel(outNodes).forEach((list, ch) => {
    if (list.length < 2) return
    list.forEach((n) => issues.push({
      nodeId: canvasNodeId(n.id), code: 'BRIDGE_AMBIGUOUS_OUT',
      message: `Channel "${ch}" has ${list.length} BridgeOut: the producer is ambiguous`,
      severity: 'error',
      hint: 'Each channel must have a single BridgeOut — use distinct channel names',
    }))
  })

  byChannel(inNodes).forEach((list, ch) => {
    if (list.length < 2) return
    list.forEach((n) => issues.push({
      nodeId: canvasNodeId(n.id), code: 'BRIDGE_DUPLICATE_IN',
      message: `Channel "${ch}" has ${list.length} BridgeIn: the engine supports only one`,
      severity: 'error',
      hint: 'A channel feeds a single BridgeIn. For multiple destinations you need distinct channels, one per OUT/IN pair',
    }))
  })

  return issues
}

// ─── CHECK — ARCHI CHE PARTONO DA PORTE INESISTENTI ─────────────
// Il canvas (FlowNode) disegna l'handle di uscita su OGNI nodo, sempre:
// `{ id: 'output', show: true }`, senza chiedere a nessuno quali porte
// esistano davvero. Così si possono collegare a valle anche i nodi che
// un'uscita non ce l'hanno — un bridge_out, un sink — e l'arco sembra
// buono: il pannello a valle mostra pure i campi, perché li risale a
// monte per conto suo. A runtime però non arriva niente, in silenzio.
//
// Qui confrontiamo gli archi con le porte DICHIARATE (node.outputs, che
// il lowering costruisce dal contratto in nodeSemantics, catch incluso).
//
// Era 'warning' finché il canvas disegnava handle fantasma: bloccare un
// flusso allora sarebbe stato punirlo per un difetto nostro. Ora FlowNode
// legge le porte dal contratto e un arco così non si può più creare — se
// esiste, viene da un file salvato prima e a runtime non porta niente.
// Dirlo prima del Run è il minimo: 'error'.
function checkOrphanEdges(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const byId = new Map(plan.nodes.map((n) => [n.id, n]))

  plan.edges.forEach((edge) => {
    const src = byId.get(edge.source)
    if (!src) return

    const ports = src.outputs.map((p) => p.id)
    if (ports.includes(edge.sourcePort)) return

    const label = src._uiRef?.label ?? canvasNodeId(src.id)
    const tgt   = byId.get(edge.target)
    const tgtLabel = tgt?._uiRef?.label ?? edge.target

    issues.push({
      nodeId:   canvasNodeId(src.id),
      code:     'EDGE_FROM_UNDECLARED_PORT',
      message:  ports.length === 0
        ? `"${label}" has no output ports, but an edge connects it to "${tgtLabel}"`
        : `"${label}": the edge to "${tgtLabel}" starts from port "${edge.sourcePort}", which the node does not declare`,
      severity: 'error',
      hint:     ports.length === 0
        ? `${src._uiRef?.type ?? 'The node'} consumes the flow and emits nothing to the lane: at runtime "${tgtLabel}" receives no rows. Disconnect the edge.`
        : `Declared ports: ${ports.join(', ')}. The edge stayed attached to a port that no longer exists.`,
    })
  })

  // ── Lo stesso, dal lato che ARRIVA ────────────────────────────────
  //
  // Il gemello mancava: si controllava da dove l'arco PARTE e non dove
  // ATTERRA. Un arco che punta a una porta d'ingresso non dichiarata è
  // esattamente lo stesso difetto — e a runtime è peggio, perché il motore
  // consegna i canali PER NOME di handle: un nome che il nodo non conosce
  // vuol dire righe che non arrivano a nessuno, in silenzio.
  //
  // Il caso vivo: `bridge_in` ed `error_handler` non hanno ingressi, ma il
  // vecchio FlowNode disegnava un handle cablato su tutto e
  // connectionResolver non obiettava (NO_INPUT si dimenticava entrambi) —
  // quindi archi così si potevano creare davvero. V. contratto-porte.md §9.5.
  plan.edges.forEach((edge) => {
    const tgt = byId.get(edge.target)
    if (!tgt) return

    // Le porte LOGICHE (R9) sono dichiarate ma non collegabili: il `catch`
    // dell'error_handler non è un filo, è una proprietà della lane. Un arco
    // che ci puntasse è comunque un errore, quindi NON vanno tra le valide.
    const ports = tgt.inputs.filter((p) => p.connectable !== false).map((p) => p.id)
    if (ports.includes(edge.targetPort)) return

    const label    = tgt._uiRef?.label ?? canvasNodeId(tgt.id)
    const src      = byId.get(edge.source)
    const srcLabel = src?._uiRef?.label ?? edge.source

    issues.push({
      nodeId:   canvasNodeId(tgt.id),
      code:     'EDGE_TO_UNDECLARED_PORT',
      message:  ports.length === 0
        ? `"${label}" has no input ports, but an edge connects it from "${srcLabel}"`
        : `"${label}": the edge from "${srcLabel}" arrives at port "${edge.targetPort}", which the node does not declare`,
      severity: 'error',
      hint:     ports.length === 0
        ? `${tgt._uiRef?.type ?? 'The node'} does not receive data from the lane: at runtime the rows of "${srcLabel}" reach no one. Disconnect the edge.`
        : `Declared ports: ${ports.join(', ')}. The edge stayed attached to a port that no longer exists.`,
    })
  })

  return issues
}

// ─── CHECK 4a-bis — CICLI FRA LANE VIA BRIDGE ───────────────────
// I canali creano archi lane→lane invisibili al DAG del canvas (i
// bridge non hanno edge). Il modello deciso: da A si entra in B per
// elaborazioni collaterali, da B NON si rientra in A. Senza questo
// check un anello resterebbe muto qui e darebbe uno stallo o un
// comportamento incomprensibile a runtime.
function checkBridgeLaneCycles(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  type Arc = { to: string; channel: string; outId: string }
  const arcs = new Map<string, Arc[]>()

  const outNodes = plan.nodes.filter((n) => n._uiRef?.type === 'bridge_out')
  const inNodes  = plan.nodes.filter((n) => n._uiRef?.type === 'bridge_in')

  outNodes.forEach((out) => {
    const ch = (out._uiRef?.config as Record<string, unknown>)?.channelName as string
    const fromLane = out._uiRef?.laneId
    if (!ch || !fromLane) return
    inNodes.forEach((inn) => {
      const inCh   = (inn._uiRef?.config as Record<string, unknown>)?.channelName as string
      const toLane = inn._uiRef?.laneId
      if (inCh !== ch || !toLane || toLane === fromLane) return
      const arr = arcs.get(fromLane) ?? []
      arr.push({ to: toLane, channel: ch, outId: out.id })
      arcs.set(fromLane, arr)
    })
  })

  // DFS con stack esplicito dei canali attraversati
  const state = new Map<string, 'visiting' | 'done'>()
  const path:  Arc[] = []
  const flagged = new Set<string>()

  const visit = (lane: string): void => {
    state.set(lane, 'visiting')
    for (const arc of arcs.get(lane) ?? []) {
      if (state.get(arc.to) === 'visiting') {
        // Anello: nomina i canali del percorso, non solo l'ultimo
        const loop = [...path, arc]
        const names = loop.map((a) => `"${a.channel}"`).join(' → ')
        loop.forEach((a) => {
          if (flagged.has(a.outId)) return
          flagged.add(a.outId)
          issues.push({
            nodeId: canvasNodeId(a.outId), code: 'BRIDGE_LANE_CYCLE',
            message: `Cycle between lanes through channels ${names}`,
            severity: 'error',
            hint: 'Lanes connected by bridges cannot form a ring: from a side lane you cannot return to the starting one',
          })
        })
        continue
      }
      if (state.get(arc.to) === 'done') continue
      path.push(arc)
      visit(arc.to)
      path.pop()
    }
    state.set(lane, 'done')
  }

  Array.from(arcs.keys()).forEach((lane) => {
    if (!state.has(lane)) visit(lane)
  })

  return issues
}

// ─── CHECK 4b — BRIDGE IN SECONDARIO SENZA MATERIALIZE ──────────
//
// Rileva il pattern pericoloso:
//   source_db → ... → TMap/Join  (flusso principale)
//   BridgeIn  → ... → TMap/Join  (flusso secondario)
//
// In questo pattern il flusso principale arriva al punto di join
// prima che BridgeIn abbia finito di ricevere dal canale.
// Se la sorgente principale è costosa (DB, HTTP) la connessione
// rimane aperta mentre si aspetta BridgeIn — rischio di timeout
// o esaurimento connessioni.
//
// La soluzione corretta è inserire un Materialize sul percorso
// principale prima del punto di join, seguito da Explode dopo.
//
// Severity: warning (funziona ma è un anti-pattern in produzione)

function checkBridgeJoinPattern(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // Tipi di nodo che rappresentano "punti di join"
  const JOIN_NODE_TYPES = new Set(['tmap', 'join'])

  // Tipi di nodo che bufferizzano intrinsecamente il flusso
  const BUFFER_NODE_TYPES = new Set(['materialize', 'aggregate', 'sort', 'window'])

  // Sorgenti costose — quelle che tengono risorse aperte
  const COSTLY_SOURCE_TYPES = new Set([
    'source_db', 'source_http', 'source_file', 'source_ftp',
    'source_kafka', 'source_mqtt', 'source_activemq', 'dir_watcher',
  ])

  // Predecessori per ogni nodo
  const predecessorsMap = new Map<string, string[]>()
  plan.nodes.forEach((n) => predecessorsMap.set(n.id, []))
  plan.edges.forEach((e) => {
    const preds = predecessorsMap.get(e.target) ?? []
    preds.push(e.source)
    predecessorsMap.set(e.target, preds)
  })

  // Edge in ingresso per ogni nodo
  const inEdgesMap = new Map<string, typeof plan.edges>()
  plan.nodes.forEach((n) => inEdgesMap.set(n.id, []))
  plan.edges.forEach((e) => {
    const arr = inEdgesMap.get(e.target) ?? []
    arr.push(e)
    inEdgesMap.set(e.target, arr)
  })

  // BFS: verifica se targetId è raggiungibile da startId
  function canReach(startId: string, targetId: string, visited = new Set<string>()): boolean {
    if (startId === targetId) return true
    if (visited.has(startId)) return false
    visited.add(startId)
    return plan.edges
      .filter((e) => e.source === startId)
      .some((e) => canReach(e.target, targetId, visited))
  }

  // BFS sugli antenati: raccoglie tutti i tipi di nodo che precedono nodeId
  function ancestorTypes(nodeId: string): Set<string> {
    const types   = new Set<string>()
    const visited = new Set<string>()
    const queue   = [nodeId]
    while (queue.length > 0) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      const node = plan.nodes.find((n) => n.id === id)
      if (node) types.add(node._uiRef?.type ?? node.operation)
      for (const predId of predecessorsMap.get(id) ?? []) queue.push(predId)
    }
    return types
  }

  // Verifica se esiste un nodo buffer sul percorso da startId a joinId
  function hasBufferOnPath(
    startId:  string,
    joinId:   string,
    visited = new Set<string>(),
  ): boolean {
    if (startId === joinId || visited.has(startId)) return false
    visited.add(startId)
    const node = plan.nodes.find((n) => n.id === startId)
    const type = node?._uiRef?.type ?? node?.operation ?? ''
    if (BUFFER_NODE_TYPES.has(type)) return true
    return plan.edges
      .filter((e) => e.source === startId && canReach(e.target, joinId))
      .some((e) => hasBufferOnPath(e.target, joinId, new Set(visited)))
  }

  // Analizza ogni nodo join
  plan.nodes.forEach((joinNode) => {
    const uiType = joinNode._uiRef?.type ?? ''
    if (!JOIN_NODE_TYPES.has(uiType) || joinNode.operation === 'lane_boundary') return

    const inEdges = inEdgesMap.get(joinNode.id) ?? []
    if (inEdges.length < 2) return

    // Partiziona i percorsi in ingresso: quelli che passano per BridgeIn e quelli no
    const bridgeInIds:    string[] = []  // canali bridge trovati
    const mainSourceIds:  string[] = []  // sorgenti sul percorso principale

    inEdges.forEach((edge) => {
      const types = ancestorTypes(edge.source)
      if (types.has('bridge_in')) {
        // Raccoglie i nomi dei canali bridge sul percorso
        plan.nodes
          .filter((n) => n._uiRef?.type === 'bridge_in' && canReach(n.id, joinNode.id))
          .forEach((n) => {
            const cfg = n._uiRef?.config as Record<string, unknown> | undefined
            const ch  = String(cfg?.channelName ?? '?')
            if (!bridgeInIds.includes(ch)) bridgeInIds.push(ch)
          })
      } else {
        // Raccoglie sorgenti costose sul percorso principale
        plan.nodes
          .filter((n) => {
            const t = n._uiRef?.type ?? n.operation
            return COSTLY_SOURCE_TYPES.has(t) && canReach(n.id, joinNode.id)
          })
          .forEach((n) => {
            if (!mainSourceIds.includes(n.id)) mainSourceIds.push(n.id)
          })
      }
    })

    // Nessun bridge secondario o nessuna sorgente principale costosa → ok
    if (bridgeInIds.length === 0 || mainSourceIds.length === 0) return

    // Verifica se c'è un buffer sul percorso principale
    const hasBuffer = mainSourceIds.some((srcId) =>
      hasBufferOnPath(srcId, joinNode.id)
    )

    if (!hasBuffer) {
      issues.push({
        nodeId:   canvasNodeId(joinNode.id),
        code:     'BRIDGE_JOIN_NO_BUFFER',
        severity: 'warning',
        message:  `"${joinNode._uiRef?.label ?? joinNode.id}" receives secondary flow from BridgeIn(${bridgeInIds.join(', ')}) but the main flow is not buffered. The source connection stays open while waiting for BridgeIn.`,
        hint:     'Insert a Materialize on the main path before the join, followed by an Explode after. The Materialize buffers the main flow and releases the connection before BridgeIn completes.',
      })
    }
  })

  return issues
}

// ─── CHECK 5 — SEMANTICA ──────────────────────────────────────────

/**
 * Tipi UI che senza righe non possono fare niente. Elencati per **tipo**,
 * non per operazione: `operations` è come il nodo viene abbassato nell'IR,
 * e più tipi condividono la stessa operazione (aggregate, pivot, materialize
 * e report_generator si abbassano tutti a 'aggregate').
 */
const NEEDS_ROWS = new Set([
  'window', 'aggregate', 'pivot', 'materialize', 'report_generator',
])

/**
 * I tipi per cui il MOTORE pretende un arco in ingresso e fallisce senza
 * («X richiede un input collegato», v. gli arm in executor.rs). Erano
 * un'altra lista rispetto a NEEDS_ROWS, e le due non si parlavano: il
 * controllo a design-time copriva cinque tipi che non sono nessuno di
 * questi, quindi un transform o un sink scollegato passava la validazione
 * e falliva al Run. Chi aggiunge un `take_single_input(...).ok_or_else(…)`
 * nel motore aggiunge il tipo QUI.
 */
const NEEDS_EDGE_INPUT = new Set([
  'transform', 'filter', 'data_quality', 'script',
  'sink_file', 'sink_db', 'bridge_out',
])

/**
 * Di quelli, i tre che possono prendere le righe da un dataset di lane
 * invece che da un arco (prop `dataSource`: 'flow' | 'materialize').
 * Le chiavi sono identiche nei pannelli e nel motore (spec.str_or).
 */
const DATASET_SOURCED = new Set(['window', 'aggregate', 'pivot'])

/**
 * I nodi che il MOTORE non implementa: sono gli stub dichiarati in
 * `NOT_IMPLEMENTED` (src-tauri/src/engine/executor.rs). Al Run inoltrano le
 * righe intatte e "fingono di funzionare" — il flusso completa ma quel passo
 * non fa niente. Finora lo studio non lo diceva: lo si scopriva solo a valle,
 * con dati che passavano immutati (o, per dir_watcher prima di essere messo
 * qui, con un crash). Questa lista rende visibile il principio di copertura.
 * 🔗 DEVE restare allineata a NOT_IMPLEMENTED nel motore: chi PORTA un nodo
 * lo TOGLIE di là E di qui; chi ne dichiara uno nuovo stub lo aggiunge a
 * ENTRAMBE.
 */
const MOTORE_NON_IMPLEMENTA = new Set<string>([
  // vuota: tutti i nodi hanno un'implementazione nel motore Rust.
])

/**
 * Avvisa, a design-time, per ogni nodo in flusso che il motore non esegue
 * davvero (v. MOTORE_NON_IMPLEMENTA). Severità `warning` e non `error`:
 * il flusso tecnicamente gira, e mentre si porta un nodo alla volta un
 * blocco duro darebbe più fastidio che aiuto. Ma lo dice, invece di
 * lasciarlo scoprire dai dati.
 */
/**
 * Tipi dedotti da un file con valori ETEROGENEI (o non deducibili).
 * Perche' e' un avviso e non un dettaglio: il motore converte in base al tipo
 * DICHIARATO e, se la conversione fallisce, non solleva un errore — scrive
 * **NULL** al posto del valore (`coerce()` in source_file.rs). Un tipo dedotto
 * male quindi non fa rumore: cancella dati in silenzio. Meglio dirlo sul nodo.
 * L'elenco lo scrive il pannello di mapping quando legge il file campione.
 */
function checkSchemaDedotto(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of plan.nodes) {
    const raw = node._uiRef?.props?.['schemaAvvisi']
    if (typeof raw !== 'string' || raw.trim() === '') continue
    let colonne: string[] = []
    try { colonne = JSON.parse(raw) } catch { continue }
    if (!Array.isArray(colonne) || colonne.length === 0) continue
    const label = node._uiRef?.label ?? node.id
    issues.push({
      nodeId:   canvasNodeId(node.id),
      code:     'SCHEMA_TIPO_AMBIGUO',
      message:  `"${label}": type inferred from non-homogeneous values — ${colonne.join(' · ')}`,
      severity: 'warning',
      hint:     'Check the type in the mapping panel. If the declared type does not hold all values, at Run the non-convertible ones become NULL without error.',
    })
  }
  return issues
}

/**
 * ERRORE: il tipo DICHIARATO per un campo non regge i valori letti dal file.
 * Non e' una pignoleria: `coerce()` (source_file.rs) converte in base al tipo
 * dichiarato e, se fallisce, mette **NULL** senza sollevare nulla. Un `integer`
 * su una colonna scritta "1200.00" quindi non fa rumore: azzera gli importi.
 * Confronta il tipo in uso (`outputSchema`) con i tipi dedotti dall'ultimo
 * campione letto (`tipiDedotti`, scritti dal pannello di mapping) — cosi'
 * l'avviso resta valido anche se il tipo viene rimesso a mano piu' tardi.
 */
function checkTipiIncompatibili(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  // `string` regge tutto; `decimal` regge anche gli interi. Il resto, se diverso, perde.
  const perde = (dichiarato: string, dedotto: string): boolean => {
    if (dichiarato === dedotto) return false
    if (dichiarato === 'string') return false
    if (dichiarato === 'decimal' && dedotto === 'integer') return false
    return true
  }
  for (const node of plan.nodes) {
    const props = node._uiRef?.props
    const rawDedotti = props?.['tipiDedotti']
    const rawSchema  = props?.['outputSchema']
    if (typeof rawDedotti !== 'string' || typeof rawSchema !== 'string') continue
    if (!rawDedotti.trim() || !rawSchema.trim()) continue
    let dedotti: Record<string, string>
    let campi: Array<{ name?: string; type?: string }>
    try {
      dedotti = JSON.parse(rawDedotti)
      campi   = JSON.parse(rawSchema)
    } catch { continue }
    if (!Array.isArray(campi)) continue

    const rotti: string[] = []
    for (const c of campi) {
      if (!c?.name || !c?.type) continue
      const dedotto = dedotti[c.name]
      if (dedotto && perde(c.type, dedotto)) {
        rotti.push(`${c.name}: declared ${c.type}, in the file it is ${dedotto}`)
      }
    }
    if (rotti.length === 0) continue
    const label = node._uiRef?.label ?? node.id
    issues.push({
      nodeId:   canvasNodeId(node.id),
      code:     'SCHEMA_TIPO_INCOMPATIBILE',
      message:  `"${label}": the declared type does not hold the file values — ${rotti.join(' · ')}. At Run those fields become NULL, without error.`,
      severity: 'error',
      hint:     'Fix the type in the mapping panel (or reload the sample from the file: the type is realigned to the data). The engine converts based on the declared type and, if the conversion fails, writes NULL instead of stopping.',
    })
  }
  return issues
}

/**
 * Nodo DISABILITATO che non si può togliere dal flusso senza scegliere al posto
 * dell'utente. Il bypass ricuce monte→valle solo con UN ingresso: con più
 * ingressi (join, tmap, union) quale dei due dovrebbe proseguire? Nel dubbio il
 * nodo resta ATTIVO — e va detto, altrimenti si crede di averlo escluso.
 */
function checkNodiDisabilitati(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of plan.nodes) {
    const cfg = node._uiRef?.config as { enabled?: string } | undefined
    if (String(cfg?.enabled ?? 'true') !== 'false') continue
    const id = canvasNodeId(node.id)
    const entranti = plan.edges.filter((e) => canvasNodeId(e.target) === id).length
    if (entranti <= 1) continue
    const label = node._uiRef?.label ?? node.id
    issues.push({
      nodeId:   id,
      code:     'NODO_DISABILITATO_NON_ESCLUDIBILE',
      message:  `"${label}" is marked as disabled but has ${entranti} inputs: it stays ACTIVE and processes anyway.`,
      severity: 'warning',
      hint:     'A node is excluded by stitching upstream to downstream: with multiple inputs the choice would be arbitrary. Disconnect the extra inputs, or delete the node.',
    })
  }
  return issues
}

/**
 * ERRORE: Script dichiarato **generatore** ma con un arco in ingresso collegato.
 * Il motore distingue le due nature dalla PRESENZA del canale d'ingresso, non
 * dalla proprietà: con l'arco attaccato lavora riga-per-riga anche se lo studio
 * dice "genera". Dichiarazione e comportamento divergerebbero in silenzio.
 */
function checkScriptGeneratoreConIngresso(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of plan.nodes) {
    if (node._uiRef?.type !== 'script') continue
    if (String(node._uiRef?.props?.['sourceMode'] ?? 'flusso') !== 'genera') continue
    const id = canvasNodeId(node.id)
    const entranti = plan.edges.filter((e) => canvasNodeId(e.target) === id).length
    if (entranti === 0) continue
    const label = node._uiRef?.label ?? node.id
    issues.push({
      nodeId:   id,
      code:     'SCRIPT_GENERATORE_CON_INGRESSO',
      message:  `"${label}" is configured as a generator, but still has an incoming connection: at Run it will behave as a transformer (one pass per row), not as a generator.`,
      severity: 'error',
      hint:     'Turning off "Generate" mode hides the port but does NOT delete the edge already drawn: disconnect it, or set the node back to "From the flow" mode.',
    })
  }
  return issues
}

/**
 * AUTO-JOIN: la stessa sorgente alimenta ENTRAMBI gli ingressi di un join.
 * Non è vietato — unire un flusso con sé stesso è un'operazione legittima
 * (il classico "dipendente → suo responsabile" preso dalla stessa tabella).
 * Ma nella maggior parte dei casi è un collegamento sbagliato, e fallisce in
 * modo silenzioso: nessun errore, solo righe moltiplicate se la chiave non è
 * univoca — e il lato destro viene **materializzato interamente in memoria**
 * (v. join.rs), quindi l'errore costa anche RAM.
 */
function checkAutoJoin(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of plan.nodes) {
    if (node._uiRef?.type !== 'join') continue
    const entranti = plan.edges.filter((e) => e.target === node.id)
    const sinistra = entranti.find((e) => e.targetPort === 'input_left')?.source
    const destra   = entranti.find((e) => e.targetPort === 'input_right')?.source
    if (!sinistra || !destra || sinistra !== destra) continue

    const label     = node._uiRef?.label ?? node.id
    const sorgente  = plan.nodes.find((n) => n.id === sinistra)?._uiRef?.label ?? sinistra
    issues.push({
      nodeId:   canvasNodeId(node.id),
      code:     'AUTO_JOIN',
      message:  `"${label}": "${sorgente}" feeds BOTH inputs (auto-join). If unintended, one of the two connections is superfluous.`,
      severity: 'warning',
      hint:     'Joining a flow with itself is legitimate (e.g. relating rows of the same set), but if it is a connection mistake no one notices: the join succeeds anyway and returns multiplied rows. Remember that the right side is kept ENTIRELY in memory.',
    })
  }
  return issues
}

/**
 * TMap: filtro di un'uscita che nomina un CAMPO DI QUELL'USCITA.
 *
 * Il filtro decide se la riga compete a quell'uscita, e viene valutato PRIMA che
 * la riga d'uscita sia costruita: legge quindi i campi degli ingressi e le
 * trasformazioni, non le colonne calcolate lì. Scrivere `nome_completo > ""`
 * dove `nome_completo` è un campo dell'uscita non dà errore: dà un valore vuoto,
 * e il filtro si comporta in modo inatteso — in silenzio.
 * (È lo stesso confine della tabella Var di Talend: se un valore serve per
 * filtrare, è una variabile intermedia, non una colonna d'uscita.)
 */
function checkFiltroSuCampoDiUscita(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of plan.nodes) {
    if (node._uiRef?.type !== 'tmap') continue
    const cfg = (node._uiRef?.config as { tmap?: {
      transforms?: Array<{ outputName?: string }>
      outputs?: Array<{ label?: string; filter?: string; fields?: Array<{ name?: string }> }>
    } } | undefined)?.tmap
    if (!cfg?.outputs) continue

    const nomiTransform = new Set((cfg.transforms ?? []).map((t) => t.outputName).filter(Boolean))
    for (const out of cfg.outputs) {
      const filtro = out.filter?.trim()
      if (!filtro) continue
      const colpevoli = (out.fields ?? [])
        .map((f) => f.name)
        .filter((n): n is string => !!n && !nomiTransform.has(n))
        .filter((n) => new RegExp(`(^|[^\\w."'])${n}\\b(?!\\s*\\.)`).test(filtro))
      if (colpevoli.length === 0) continue
      const label = node._uiRef?.label ?? node.id
      issues.push({
        nodeId:   canvasNodeId(node.id),
        code:     'TMAP_FILTRO_SU_CAMPO_USCITA',
        message:  `"${label}" — the output filter "${out.label ?? '?'}" usa ${colpevoli.map((c) => `"${c}"`).join(', ')}, which ${colpevoli.length > 1 ? 'are fields' : 'is a field'} of that same output: at Run it will be empty.`,
        severity: 'warning',
        hint:     'The filter is evaluated before the output row is built, so it reads only inputs and transformations. Move that value among the transformations (on the left): from there it is readable both by the filter and by the output fields.',
      })
    }
  }
  return issues
}

/**
 * TMap: una trasformazione che ne usa un'altra definita DOPO di lei.
 *
 * Il motore calcola le trasformazioni nell'ordine dell'elenco e passa a ciascuna
 * solo quelle già calcolate (`compute_transforms`). Citarne una che viene dopo
 * non dà errore: dà **vuoto**, in silenzio. È la trappola tipica quando si
 * collega una trasformazione a un'altra.
 */
function checkOrdineTrasformazioni(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of plan.nodes) {
    if (node._uiRef?.type !== 'tmap') continue
    const trs = ((node._uiRef?.config as { tmap?: {
      transforms?: Array<{ outputName?: string; expression?: string }>
    } } | undefined)?.tmap?.transforms) ?? []
    if (trs.length < 2) continue

    const problemi: string[] = []
    trs.forEach((tr, i) => {
      const espr = tr.expression ?? ''
      trs.slice(i + 1).forEach((dopo) => {
        const nome = dopo.outputName
        if (!nome) return
        if (new RegExp(`(^|[^\\w."'])${nome}\\b(?!\\s*\\.)`).test(espr)) {
          problemi.push(`"${tr.outputName}" uses "${nome}", which is defined later`)
        }
      })
    })
    if (problemi.length === 0) continue
    const label = node._uiRef?.label ?? node.id
    issues.push({
      nodeId:   canvasNodeId(node.id),
      code:     'TMAP_ORDINE_TRASFORMAZIONI',
      message:  `"${label}": ${problemi.join('; ')} — at Run that value will be empty.`,
      severity: 'warning',
      hint:     'Transformations are computed in the order they are listed: one can only use those that come BEFORE. Move the cited one higher up.',
    })
  }
  return issues
}

function checkNotImplemented(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  for (const node of plan.nodes) {
    if (node.operation === 'lane_boundary') continue
    const type = node._uiRef?.type ?? ''
    if (!MOTORE_NON_IMPLEMENTA.has(type)) continue
    const label = node._uiRef?.label ?? node.id
    issues.push({
      nodeId:   canvasNodeId(node.id),
      code:     'NODE_NOT_IMPLEMENTED',
      message:  `"${label}" is not yet implemented in the engine: at Run the rows pass through it intact and its work is not done`,
      severity: 'warning',
      hint:     'The node is in the palette but the engine treats it as transparent until it is ported: for a source it means no rows produced, for a sink no writes.',
    })
  }
  return issues
}

function checkExecutionSemantics(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  const semanticsMap = new Map<string, ExecutionSemantics>()
  plan.nodes.forEach((n) => semanticsMap.set(n.id, n.executionSemantics))

  const predecessors = new Map<string, string[]>()
  plan.nodes.forEach((n) => predecessors.set(n.id, []))
  plan.edges.forEach((e) => predecessors.get(e.target)?.push(e.source))

  plan.nodes.forEach((node) => {
    if (node.operation === 'lane_boundary') return

    const canvasId = canvasNodeId(node.id)
    const preds    = predecessors.get(node.id) ?? []

    // ── Nodi che hanno bisogno di righe da qualche parte ───────────
    //
    // Smistava su `node.operation` con la lista ['aggregate','sort','window'].
    // Tre difetti, tutti dovuti al fatto che l'operazione NON è il tipo:
    //   · 'aggregate' è prodotta da aggregate, pivot, materialize E
    //     report_generator → il messaggio diceva «L'operazione "aggregate"
    //     richiede dati in ingresso» anche stando su un pivot;
    //   · 'sort' non la produce NESSUN tipo: stringa morta;
    //   · non guardava `dataSource`, quindi accusava un window che legge
    //     legittimamente da un materialize senza essere collegato.
    // È lo stesso errore del `case 'aggregate'` in schemaPropagation: si
    // smista per TIPO, non per operazione.
    const uiType = node._uiRef?.type ?? ''
    const label  = node._uiRef?.label ?? node.id

    // Lo Script in modalità "genera" NON ha porta d'ingresso (v. il `when`
    // in nodeSemantics): pretendere un arco sarebbe pretendere di
    // collegare qualcosa che non esiste.
    const generatore = uiType === 'script' &&
      String(node._uiRef?.props?.['sourceMode'] ?? 'flusso') === 'genera'

    if (NEEDS_EDGE_INPUT.has(uiType) && !generatore && preds.length === 0) {
      issues.push({
        nodeId: canvasId, code: 'NODE_INPUT_NOT_CONNECTED',
        message: `"${label}" (${uiType}) has nothing incoming`,
        severity: 'error',
        hint: 'The engine stops on this node: without a connected flow it has no rows to work on. Connect an input or remove the node.',
      })
    }

    if (NEEDS_ROWS.has(uiType)) {
      // dataSource='materialize' → le righe NON arrivano dall'arco: il nodo
      // legge un dataset pubblicato da un materialize della lane. L'arco, se
      // c'è, è solo un innesco e la sua riga viene scartata; se non c'è, il
      // motore attende la pubblicazione (window.rs: `rx: Option<RowReceiver>`,
      // "caso 2 — materialize senza trigger"). Vale per window/aggregate/pivot,
      // le uniche tre che espongono la prop. V. contratto-porte.md R7.
      const fromDataset = node._uiRef?.props?.['dataSource'] === 'materialize'

      if (!fromDataset && preds.length === 0) {
        issues.push({
          nodeId: canvasId, code: 'DATASET_OP_NO_INPUT',
          message: `Node "${label}" (${uiType}) requires input data`,
          severity: 'error',
          hint: DATASET_SOURCED.has(uiType)
            ? 'Connect a flow, or set the source to "Materialize" in the panel'
            : 'Connect an incoming flow',
        })
      }

      // Sorgente dichiarata ma dataset non scelto: il motore fallirebbe a
      // runtime («sorgente 'Materialize' senza nome del dataset»). Lo diciamo
      // prima di eseguire — è il mestiere del pre-compilatore.
      if (fromDataset && !(node._uiRef?.props?.['materializeName'] ?? '').trim()) {
        issues.push({
          nodeId: canvasId, code: 'DATASET_OP_NO_SOURCE',
          message: `Node "${label}" reads from Materialize but has not chosen which dataset`,
          severity: 'error',
          hint: 'Select the dataset in the panel, under Source',
        })
      }
    }

    // ── R8, seconda metà — i parametri di query ────────────────────
    //
    // Una query può citare un campo che arriva dall'ingresso: `${campo}`.
    // Lo studio lo compila (src/ir/queryParams.ts) e lo lega TIPIZZATO;
    // qui si controlla, PRIMA di eseguire, che quel campo esista davvero.
    // È l'intero motivo per cui la sintassi è `${campo}` e non `:param`
    // nativo di sqlx: se la legge lo studio, lo studio può dirlo.
    // ── Script: il corpo si legge PRIMA di premere Run ────────────
    // Finora un errore di sintassi si scopriva solo al Run, perché a
    // rilanciarlo è `buildRustPlan`. Ma il corpo è compilabile a
    // design-time — lo fa già la propagazione dello schema — quindi
    // l'errore si può dire subito, con la riga.
    if (uiType === 'script') {
      const codice = String(node._uiRef?.props?.['code'] ?? '')
      try {
        const corpo = parseScript(codice)
        const usate = istruzioniUsate(corpo)
        const genera = String(node._uiRef?.props?.['sourceMode'] ?? 'flusso') === 'genera'

        // Un generatore senza `emit` non produce NIENTE: il corpo gira una
        // volta sola e la riga di lavoro non esce da sé (è la differenza
        // fra le due modalità). Il nodo concluderebbe verde con 0 righe.
        if (genera && !usate.has('Emit') && codice.trim() !== '') {
          issues.push({
            nodeId: canvasId, code: 'SCRIPT_GENERATOR_NO_EMIT',
            message: `"${label}" generates rows but has no "emit": it will produce none`,
            severity: 'error',
            hint: 'In "Generate" mode the working row does not come out on its own: rows come out only from "emit" instructions.',
          })
        }

        // `reject` scritto mentre la porta è chiusa: il motore non ha dove
        // mandare le righe e le PERDE senza dire niente (stessa scelta
        // degli altri nodi con reject condizionale — ma qui la si è
        // chiesta esplicitamente scrivendola nel corpo).
        if (usate.has('Reject') && String(node._uiRef?.props?.['hasReject'] ?? 'false') !== 'true') {
          issues.push({
            nodeId: canvasId, code: 'SCRIPT_REJECT_PORT_OFF',
            message: `"${label}" uses "reject" but the reject port is not active: discarded rows disappear`,
            severity: 'warning',
            hint: 'Activate the reject port in the node panel and connect it, or use "skip" if the rows should simply be discarded.',
          })
        }

        // var("x") LETTA ma mai dichiarata nella lane né assegnata prima:
        // nel motore darebbe sempre `null` in silenzio. È il refuso
        // classico (var("totaal") per var("totale")) — stessa onestà di
        // P60/P69: dirlo a design-time invece di lasciarlo sparire. Non si
        // avvisa se è scritta da qualche parte nello script (accumulatore
        // che parte da null è legittimo).
        const { lette, scritte } = variabiliDiLaneUsate(corpo)
        if (lette.size > 0) {
          const laneId = node._uiRef?.laneId ?? ''
          const lane = plan.pool?.lanes?.find((l) => l.id === laneId)
          const dichiarate = new Set((lane?.variables ?? []).map((v) => v.name))
          for (const nome of lette) {
            if (!dichiarate.has(nome) && !scritte.has(nome)) {
              issues.push({
                nodeId: canvasId, code: 'SCRIPT_LANE_VAR_UNDECLARED',
                message: `"${label}": var("${nome}") is read but not declared in the lane nor assigned before — it will always be null`,
                severity: 'warning',
                hint: `Declare "${nome}" in the lane variables, or write it with var("${nome}") = … before reading it. If it is a typo, fix the name.`,
              })
            }
          }
        }
      } catch (e) {
        const dettaglio = e instanceof ScriptParseError ? e.pretty() : String(e)
        issues.push({
          nodeId: canvasId, code: 'SCRIPT_PARSE_ERROR',
          message: `"${label}": ${dettaglio}`,
          severity: 'error',
          hint: 'The Run does not start until the body compiles. Instructions: let, assignment, if/else, repeat, for, emit, skip, reject, log, error.',
        })
      }
    }

    // ── Error handler: regole col vocabolario vecchio ─────────────
    // `retry` e `skip` erano azioni dell'handler prima di P34. Oggi
    // appartengono al NODO (retry = prima operazione prima dell'impegno;
    // skip = onError 'catch'), e l'handler non può eseguirle: quando
    // l'errore gli arriva il nodo è concluso. Il pannello le mostra già
    // tradotte, ma finché il file non viene risalvato il valore vecchio
    // resta lì: meglio dirlo che lasciar credere che la regola faccia
    // ancora quello che promette il suo nome.
    if (uiType === 'error_handler') {
      let regole: unknown[] = []
      try {
        const parsed = JSON.parse(String(node._uiRef?.props?.['rules'] ?? '[]'))
        if (Array.isArray(parsed)) regole = parsed
      } catch { regole = [] }

      regole.forEach((r, i) => {
        const azione = (r as { action?: unknown })?.action
        if (isLegacyRuleAction(azione)) {
          issues.push({
            nodeId: canvasId, code: 'ERROR_RULE_LEGACY_ACTION',
            message: `"${label}": rule #${i + 1} uses action "${String(azione)}", no longer executable by the handler`,
            severity: 'warning',
            hint: String(azione) === 'retry'
              ? 'Retry is configured on the node (Advanced → Error: "Retry"), because it applies only before the operation is committed. Here the rule behaves like "Emit".'
              : 'To let the node itself handle the error, set on the node Advanced → Error: "Catch on node". Here the rule behaves like "Emit".',
          })
        }
        const match = (r as { matchType?: unknown })?.matchType
        if (String(match ?? '') === 'error_code') {
          issues.push({
            nodeId: canvasId, code: 'ERROR_RULE_CODE_UNAVAILABLE',
            message: `"${label}": rule #${i + 1} filters on the error code, which the engine does not populate yet`,
            severity: 'warning',
            hint: 'Node errors arrive as a message, not as a code: the rule will never match. Use "Node type is" or "Always".',
          })
        }
      })
    }

    // ── «Escludi dal log» + «Critico» sullo stesso nodo ───────────
    // Combinazione contraddittoria ma legittima: silenziare il rumore di
    // un nodo che però non può fallire. Il motore la risolve a favore
    // della sicurezza (la lane si ferma e l'errore viene comunque
    // registrato, v. error_handler.rs), ma chi ha spuntato «escludi»
    // crede di aver silenziato quel nodo: meglio dirgli cosa succederà
    // davvero, prima del run.
    // `_uiRef.config` è la config del nodo (non `.data.config`: qui il
    // riferimento è già appiattito — v. gli altri usi in questo file).
    const cfgNodo = node._uiRef?.config as Record<string, unknown> | undefined
    const adv     = cfgNodo?.['advanced'] as Record<string, unknown> | undefined
    if (String(adv?.['excludeFromErrorLog'] ?? '') === 'true' &&
        String(adv?.['critical'] ?? '') === 'true') {
      issues.push({
        nodeId: canvasId, code: 'EXCLUDE_LOG_VS_CRITICAL',
        message: `"${label}": marked both as "exclude from log" and "Critical"`,
        severity: 'warning',
        hint: 'Safety wins: an error here interrupts the lane anyway and is logged in the panel (but it is not sent to error_out). Remove "Critical" to truly silence it.',
      })
    }

    if (uiType === 'source_db') {
      const query = String(node._uiRef?.props?.['query'] ?? '')

      // Configurazione ambigua: query personalizzata E tabella. Il motore
      // esegue la query e ignora la tabella (source_db.rs, "custom verbatim
      // se presente"), ma il canvas mostrava la tabella: si finiva per
      // modificare un campo inerte credendo di cambiare la sorgente, e la
      // conferma arrivava solo dal log del run. Qui lo si dice prima.
      const tabella = String(node._uiRef?.props?.['table'] ?? '').trim()
      if (query.trim() && tabella) {
        issues.push({
          nodeId: canvasId, code: 'QUERY_OVERRIDES_TABLE',
          message: `"${label}": table "${tabella}" is ignored, the custom SQL query runs`,
          severity: 'warning',
          hint: 'The engine runs the custom query and ignores schema, table, limit and ordering. Clear the query to go back to reading from the table.',
        })
      }

      // Il parametro fra apici: `WHERE s = '${nome}'`. Diventerebbe
      // `s = '?'` — il confronto con la stringa "?" — e lascerebbe un bind
      // senza posto. È l'errore di chi arriva dall'interpolazione, dove gli
      // apici servono; qui li mette il driver.
      for (const name of quotedParamNames(query)) {
        issues.push({
          nodeId: canvasId, code: 'QUERY_PARAM_QUOTED',
          message: `"${label}": parameter \`\${${name}}\` is inside quotes`,
          severity: 'error',
          hint: `Write \`= \${${name}}\` without quotes: the value is bound, and the driver adds the quotes. With quotes the query would look for the string "?".`,
        })
      }

      const cited = queryParamNames(query)
      if (cited.length) {
        // Da dove arrivano i campi: dall'unico arco entrante. Zero archi e
        // parametri citati = la query non potrà mai riempirli.
        // `preds` sono ID, non nodi: lo schema va cercato nel piano.
        const byNodeId = new Map(plan.nodes.map((n) => [n.id, n]))
        const known    = new Set(
          preds.flatMap((pid) => byNodeId.get(pid)?.schema?.output ?? []).map((f) => f.name)
        )

        for (const name of cited) {
          if (known.has(name)) continue
          issues.push({
            nodeId: canvasId, code: 'QUERY_PARAM_UNKNOWN',
            message: preds.length === 0
              ? `"${label}": the query uses parameter \`\${${name}}\` but no flow reaches the node`
              : `"${label}": the query uses parameter \`\${${name}}\`, which is not among the incoming fields`,
            severity: 'error',
            hint: preds.length === 0
              ? 'Connect upstream the node that computes the parameter: its row configures the query'
              : `Incoming fields: ${[...known].join(', ') || '(none)'}`,
          })
        }
      }
    }

    if (node.operation === 'join' && preds.length < 2) {
      issues.push({
        nodeId: canvasId, code: 'JOIN_MISSING_INPUT',
        message: 'The join requires at least 2 inputs — connect the second source',
        severity: 'error', hint: "Connect a second source to the lookup handle",
      })
    }

    if (node.executionSemantics === 'dataset') {
      const hasStreamPred = preds.some((predId) => semanticsMap.get(predId) === 'stream')
      if (hasStreamPred) {
        issues.push({
          nodeId: canvasId, code: 'DATASET_AFTER_STREAM',
          message: `A batch operation (${node.operation}) after a streaming input requires materialization`,
          severity: 'warning', hint: 'The planner will automatically insert a materialization point',
        })
      }
    }
  })

  return issues
}

// ─── CHECK 6 — HANDLE NON RISOLTI ─────────────────────────────────

function checkUnresolvedHandles(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []
  const nodeMap = new Map(plan.nodes.map((n) => [n.id, n]))

  plan.edges.forEach((edge) => {
    const src = nodeMap.get(edge.source)
    const tgt = nodeMap.get(edge.target)
    if (!src || !tgt) return
    if (src.operation === 'lane_boundary' || tgt.operation === 'lane_boundary') return

    const srcSemantics = getNodeSemantics(src._uiRef?.type ?? '')
    if (srcSemantics.staticOutputPorts.length > 0) {
      const portExists = src.outputs.some((p) => p.id === edge.sourcePort)
      if (!portExists && edge.sourcePort !== 'output') {
        issues.push({
          nodeId: canvasNodeId(edge.source), edgeId: edge.id,
          code: 'UNRESOLVED_SOURCE_HANDLE',
          message: `Output handle "${edge.sourcePort}" not found on "${src._uiRef?.label ?? edge.source}"`,
          severity: 'warning', hint: 'The handle may have been removed — reconnect the node',
        })
      }
    }

    const tgtHasMultipleInputs = getNodeSemantics(tgt._uiRef?.type ?? '').acceptsMultipleInputs
    if (!tgtHasMultipleInputs) {
      const portExists = tgt.inputs.some((p) => p.id === edge.targetPort)
      if (!portExists && edge.targetPort !== 'input') {
        issues.push({
          nodeId: canvasNodeId(edge.target), edgeId: edge.id,
          code: 'UNRESOLVED_TARGET_HANDLE',
          message: `Input handle "${edge.targetPort}" not found on "${tgt._uiRef?.label ?? edge.target}"`,
          severity: 'warning',
        })
      }
    }
  })

  return issues
}

// ─── CHECK 7 — DATA CONTRACTS ─────────────────────────────────────

function checkDataContracts(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  plan.nodes.forEach((node) => {
    if (!node.dataContract || node.operation === 'lane_boundary') return

    const canvasId     = canvasNodeId(node.id)
    const contract     = node.dataContract
    const outputSchema = node.schema.output

    contract.fields.forEach((contractField) => {
      const schemaField = outputSchema.find((f) => f.name === contractField.name)
      if (!schemaField) {
        issues.push({
          nodeId: canvasId, code: 'CONTRACT_FIELD_MISSING',
          message: `Field "${contractField.name}" required by the contract but not present in the output schema`,
          severity: 'error',
          hint: `Add field "${contractField.name}" (type: ${contractField.type}) to the node output`,
        })
        return
      }
      if (schemaField.type !== contractField.type && contractField.type !== 'any') {
        issues.push({
          nodeId: canvasId, fieldId: schemaField.id, code: 'CONTRACT_TYPE_MISMATCH',
          message: `Field "${contractField.name}": type "${schemaField.type}" not compatible with the contract (expected "${contractField.type}")`,
          severity: 'warning', hint: 'Add a cast transformation or update the contract',
        })
      }
      if (!contractField.nullable && schemaField.nullable === true) {
        issues.push({
          nodeId: canvasId, fieldId: schemaField.id, code: 'CONTRACT_NULLABLE_VIOLATION',
          message: `Field "${contractField.name}" is nullable but the contract requires NOT NULL`,
          severity: 'warning',
        })
      }
    })
  })

  return issues
}

// ─── CHECK 8 — GRUPPI TRANSAZIONALI ──────────────────────────────

function validateTransactionGroups(plan: LogicalPlan): ValidationIssue[] {
  const issues: ValidationIssue[] = []

  // Raggruppa per laneId::groupId
  const groupMap = new Map<string, Array<{
    node:            LogicalNode
    txConfig:        { id: string; mode: string; timeout: number; onError: string }
    resourceId:      string
    resourceDialect: string
  }>>()

  plan.nodes.forEach((node) => {
    const uiType = node._uiRef?.type ?? ''
    if (!['sink_db', 'sink_kafka'].includes(uiType)) return

    try {
      // props è ora disponibile in _uiRef
      const props = node._uiRef?.props
      const raw   = props?.['transactionGroup']
      if (!raw) return
      const tx = JSON.parse(raw)
      if (!tx?.id) return

      const laneId     = node._uiRef?.laneId ?? ''
      const config     = node._uiRef?.config as Record<string, unknown> | undefined
      const resourceId = (config?.resourceId ?? '') as string

      // Risorsa dal pool (disponibile in plan.pool dopo la patch al lowering)
      const lane = plan.pool?.lanes?.find((l) => l.id === laneId)
      const res  = lane?.resources?.find((r) => r.id === resourceId)
      const resourceDialect: string = (res?.config as any)?.dialect ?? res?.kind ?? ''

      const key = `${laneId}::${tx.id}`
      if (!groupMap.has(key)) groupMap.set(key, [])
      groupMap.get(key)!.push({ node, txConfig: tx, resourceId, resourceDialect })
    } catch {}
  })

  groupMap.forEach((members, key) => {
    const groupId = key.split('::')[1]

    // Regola: gruppo con un solo partecipante
    if (members.length < 2) {
      issues.push({
        severity: 'warning',
        nodeId:   canvasNodeId(members[0].node.id),
        message:  `Transactional group "${groupId}" has only one participant — the transaction has no effect`,
        code:     'TX_SINGLE_PARTICIPANT',
        hint:     'Add more sinks to the same group or remove the transactional configuration',
      })
    }

    members.forEach(({ node, txConfig, resourceId, resourceDialect }) => {

      // Regola: nodo senza risorsa
      if (!resourceId) {
        issues.push({
          severity: 'error',
          nodeId:   canvasNodeId(node.id),
          message:  `Node in transactional group "${groupId}" without a configured resource`,
          code:     'TX_NO_RESOURCE',
          hint:     'Configure a resource in the Configuration tab',
        })
        return
      }

      // Regola native: stessa risorsa per tutti
      if (txConfig.mode === 'native') {
        const firstResourceId = members[0].resourceId
        if (node.id !== members[0].node.id && resourceId !== firstResourceId) {
          issues.push({
            severity: 'error',
            nodeId:   canvasNodeId(node.id),
            message:  `Native transactional group "${groupId}": all nodes must use the same resource. Switch to XA mode for heterogeneous resources.`,
            code:     'TX_NATIVE_RESOURCE_MISMATCH',
            hint:     'Set XA mode in the TransactionGroupEditor',
          })
        }
      }

      // Regola xa: dialetto XA-compatibile
      if (txConfig.mode === 'xa' && resourceDialect && !XA_COMPATIBLE_DIALECTS.has(resourceDialect)) {
        issues.push({
          severity: 'warning',
          nodeId:   canvasNodeId(node.id),
          message:  `Resource with dialect "${resourceDialect}" may not support XA transactions`,
          code:     'TX_XA_UNSUPPORTED_DIALECT',
          hint:     'Check that the resource JDBC driver supports the XA protocol',
        })
      }
    })
  })

  return issues
}

// ─────────────────────────────────────────────────────────────────
// APPLICAZIONE AL CANVAS
// ─────────────────────────────────────────────────────────────────

export function applyIssuesToCanvas(
  issues: ValidationIssue[],
  nodes:  FlowNode<NodeData>[],
): FlowNode<NodeData>[] {
  const issuesByNode = new Map<string, ValidationIssue[]>()
  issues.forEach((issue) => {
    if (!issue.nodeId) return
    const existing = issuesByNode.get(issue.nodeId) ?? []
    issuesByNode.set(issue.nodeId, [...existing, issue])
  })

  return nodes.map((node) => {
    const nodeIssues = issuesByNode.get(node.id) ?? []
    const errors     = nodeIssues.filter((i) => i.severity === 'error')
    const warnings   = nodeIssues.filter((i) => i.severity === 'warning')
    return {
      ...node,
      data: {
        ...node.data,
        uiState: {
          hasErrors:    errors.length > 0,
          errorCount:   errors.length,
          hasWarnings:  warnings.length > 0,
          warningCount: warnings.length,
          issues:       nodeIssues.map((i) => ({
            severity: i.severity, message: i.message, code: i.code, hint: i.hint,
          })),
        },
      },
    }
  })
}

export function scheduleValidation(
  getPlan:   () => LogicalPlan,
  getNodes:  () => FlowNode<NodeData>[],
  setNodes:  (nodes: FlowNode<NodeData>[]) => void,
  delayMs:   number = 300,
): () => void {
  const timer = setTimeout(() => {
    try {
      const plan    = getPlan()
      // validateDAG richiede un piano già annotato con lo schema.
      const { plan: withSchema, issues: schemaIssues } = propagateSchema(plan)
      const result  = validateDAG(withSchema)
      const nodes   = getNodes()
      const updated = applyIssuesToCanvas([...schemaIssues, ...result.issues], nodes)
      setNodes(updated)
    } catch (e) {
      console.warn('[FlowPilot] DAG validation error:', e)
    }
  }, delayMs)
  return () => clearTimeout(timer)
}