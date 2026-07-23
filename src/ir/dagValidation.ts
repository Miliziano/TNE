/**
 * src/ir/dagValidation.ts
 */

import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { isLegacyRuleAction } from '../types'
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
        message:  `Il nodo "${node._uiRef?.label ?? node.id}" cattura gli errori sul nodo ma l'handle catch non è collegato — le righe in errore andrebbero perse`,
        severity: 'warning',
        hint:     'Collega l\'handle catch a valle, oppure scegli "Error handler" come modalità di gestione errori',
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
    { code: 'CYCLE_DETECTED', message: 'Il DAG contiene un ciclo — la pipeline non può essere eseguita', severity: 'error', hint: 'Rimuovi una delle connessioni che creano il ciclo' },
    ...cycleNodes.map((nodeId): ValidationIssue => ({
      nodeId, code: 'NODE_IN_CYCLE', message: 'Questo nodo fa parte di un ciclo', severity: 'error',
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
        message:  `Il nodo "${node._uiRef?.label ?? node.id}" non è collegato a nessun altro nodo`,
        severity: 'warning',
        hint:     'Collega il nodo alla pipeline o rimuovilo',
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
      code: 'NO_SINK', message: 'La pipeline non ha nodi di destinazione (sink)',
      severity: 'warning', hint: 'Aggiungi un nodo DB Sink, File Output o Kafka',
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
        message:  `Il nodo sorgente "${src._uiRef?.label ?? src.id}" non raggiunge nessun sink`,
        severity: 'warning',
        hint:     'Connetti questo nodo a un nodo di destinazione',
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
        message: 'BridgeOut senza nome canale configurato', severity: 'error',
        hint: 'Configura il nome del canale nel pannello del nodo',
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
        message: `BridgeOut "${channelName}" non ha un BridgeIn corrispondente in nessuna altra lane`,
        severity: 'error',
        hint: `Aggiungi un nodo BridgeIn con canale "${channelName}" nella lane di destinazione`,
      })
    }
  })

  inNodes.forEach((inNode) => {
    const channelName = (inNode._uiRef?.config as Record<string, unknown>)?.channelName as string
    if (!channelName) {
      issues.push({
        nodeId: canvasNodeId(inNode.id), code: 'BRIDGE_NO_CHANNEL',
        message: 'BridgeIn senza nome canale configurato', severity: 'error',
        hint: 'Configura il nome del canale nel pannello del nodo',
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
        message: `BridgeIn "${channelName}" non ha un BridgeOut corrispondente in nessuna altra lane`,
        severity: 'error',
        hint: `Aggiungi un nodo BridgeOut con canale "${channelName}" nella lane sorgente`,
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
      message: `Il canale "${ch}" ha ${list.length} BridgeOut: il produttore è ambiguo`,
      severity: 'error',
      hint: 'Ogni canale deve avere un solo BridgeOut — usa nomi di canale distinti',
    }))
  })

  byChannel(inNodes).forEach((list, ch) => {
    if (list.length < 2) return
    list.forEach((n) => issues.push({
      nodeId: canvasNodeId(n.id), code: 'BRIDGE_DUPLICATE_IN',
      message: `Il canale "${ch}" ha ${list.length} BridgeIn: il motore ne supporta uno solo`,
      severity: 'error',
      hint: 'Un canale alimenta un solo BridgeIn. Per più destinazioni servono canali distinti, uno per ogni coppia OUT/IN',
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
        ? `"${label}" non ha porte di uscita, ma un arco lo collega a "${tgtLabel}"`
        : `"${label}": l'arco verso "${tgtLabel}" parte dalla porta "${edge.sourcePort}", che il nodo non dichiara`,
      severity: 'error',
      hint:     ports.length === 0
        ? `${src._uiRef?.type ?? 'Il nodo'} consuma il flusso e non emette nulla verso la lane: a runtime "${tgtLabel}" non riceve righe. Scollega l'arco.`
        : `Porte dichiarate: ${ports.join(', ')}. L'arco è rimasto attaccato a una porta che non esiste più.`,
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
        ? `"${label}" non ha porte di ingresso, ma un arco lo collega da "${srcLabel}"`
        : `"${label}": l'arco da "${srcLabel}" arriva sulla porta "${edge.targetPort}", che il nodo non dichiara`,
      severity: 'error',
      hint:     ports.length === 0
        ? `${tgt._uiRef?.type ?? 'Il nodo'} non riceve dati dalla lane: a runtime le righe di "${srcLabel}" non arrivano a nessuno. Scollega l'arco.`
        : `Porte dichiarate: ${ports.join(', ')}. L'arco è rimasto attaccato a una porta che non esiste più.`,
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
            message: `Ciclo fra lane attraverso i canali ${names}`,
            severity: 'error',
            hint: 'Le lane collegate dai bridge non possono formare un anello: da una lane collaterale non si rientra in quella di partenza',
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
        message:  `"${joinNode._uiRef?.label ?? joinNode.id}" riceve flusso secondario da BridgeIn(${bridgeInIds.join(', ')}) ma il flusso principale non è bufferizzato. La connessione sorgente rimane aperta mentre si attende BridgeIn.`,
        hint:     'Inserisci un Materialize sul percorso principale prima del join, seguito da un Explode dopo. Il Materialize bufferizza il flusso principale e rilascia la connessione prima che BridgeIn completi.',
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

    if (NEEDS_EDGE_INPUT.has(uiType) && preds.length === 0) {
      issues.push({
        nodeId: canvasId, code: 'NODE_INPUT_NOT_CONNECTED',
        message: `"${label}" (${uiType}) non ha niente in ingresso`,
        severity: 'error',
        hint: 'Il motore si ferma su questo nodo: senza un flusso collegato non ha righe su cui lavorare. Collega un ingresso o togli il nodo.',
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
          message: `Il nodo "${label}" (${uiType}) richiede dati in ingresso`,
          severity: 'error',
          hint: DATASET_SOURCED.has(uiType)
            ? 'Collega un flusso, oppure imposta la sorgente su "Materialize" nel pannello'
            : 'Collega un flusso in ingresso',
        })
      }

      // Sorgente dichiarata ma dataset non scelto: il motore fallirebbe a
      // runtime («sorgente 'Materialize' senza nome del dataset»). Lo diciamo
      // prima di eseguire — è il mestiere del pre-compilatore.
      if (fromDataset && !(node._uiRef?.props?.['materializeName'] ?? '').trim()) {
        issues.push({
          nodeId: canvasId, code: 'DATASET_OP_NO_SOURCE',
          message: `Il nodo "${label}" legge da Materialize ma non ha scelto quale dataset`,
          severity: 'error',
          hint: 'Seleziona il dataset nel pannello, alla voce Sorgente',
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
            message: `"${label}": la regola #${i + 1} usa l'azione "${String(azione)}", non più eseguibile dall'handler`,
            severity: 'warning',
            hint: String(azione) === 'retry'
              ? 'Il retry si configura sul nodo (Avanzate → Errore: "Riprova"), perché vale solo prima che l\'operazione sia impegnata. Qui la regola si comporta come "Emetti".'
              : 'Per far gestire l\'errore al nodo stesso, imposta sul nodo Avanzate → Errore: "Cattura sul nodo". Qui la regola si comporta come "Emetti".',
          })
        }
        const match = (r as { matchType?: unknown })?.matchType
        if (String(match ?? '') === 'error_code') {
          issues.push({
            nodeId: canvasId, code: 'ERROR_RULE_CODE_UNAVAILABLE',
            message: `"${label}": la regola #${i + 1} filtra sul codice errore, che il motore non popola ancora`,
            severity: 'warning',
            hint: 'Gli errori di nodo arrivano come messaggio, non come codice: la regola non corrisponderà mai. Usa "Tipo nodo è" oppure "Sempre".',
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
        message: `"${label}": è marcato sia «escludi dal log» sia «critico»`,
        severity: 'warning',
        hint: 'Prevale la sicurezza: un errore qui interrompe comunque la lane e viene registrato nel pannello (non viene però inviato a error_out). Togli «critico» per silenziarlo davvero.',
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
          message: `"${label}": la tabella "${tabella}" è ignorata, viene eseguita la query SQL personalizzata`,
          severity: 'warning',
          hint: 'Il motore esegue la query personalizzata e ignora schema, tabella, limite e ordinamento. Svuota la query per tornare a leggere dalla tabella.',
        })
      }

      // Il parametro fra apici: `WHERE s = '${nome}'`. Diventerebbe
      // `s = '?'` — il confronto con la stringa "?" — e lascerebbe un bind
      // senza posto. È l'errore di chi arriva dall'interpolazione, dove gli
      // apici servono; qui li mette il driver.
      for (const name of quotedParamNames(query)) {
        issues.push({
          nodeId: canvasId, code: 'QUERY_PARAM_QUOTED',
          message: `"${label}": il parametro \`\${${name}}\` è fra apici`,
          severity: 'error',
          hint: `Scrivi \`= \${${name}}\` senza apici: il valore viene legato, e gli apici li mette il driver. Con gli apici la query cercherebbe la stringa "?".`,
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
              ? `"${label}": la query usa il parametro \`\${${name}}\` ma al nodo non arriva nessun flusso`
              : `"${label}": la query usa il parametro \`\${${name}}\`, che non è fra i campi in arrivo`,
            severity: 'error',
            hint: preds.length === 0
              ? 'Collega a monte il nodo che calcola il parametro: la sua riga configura la query'
              : `Campi in arrivo: ${[...known].join(', ') || '(nessuno)'}`,
          })
        }
      }
    }

    if (node.operation === 'join' && preds.length < 2) {
      issues.push({
        nodeId: canvasId, code: 'JOIN_MISSING_INPUT',
        message: 'Il join richiede almeno 2 input — collegare la seconda sorgente',
        severity: 'error', hint: "Connetti una seconda sorgente all'handle di lookup",
      })
    }

    if (node.executionSemantics === 'dataset') {
      const hasStreamPred = preds.some((predId) => semanticsMap.get(predId) === 'stream')
      if (hasStreamPred) {
        issues.push({
          nodeId: canvasId, code: 'DATASET_AFTER_STREAM',
          message: `Un'operazione batch (${node.operation}) dopo un input streaming richiede materializzazione`,
          severity: 'warning', hint: 'Il planner inserirà automaticamente un punto di materializzazione',
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
          message: `Handle di output "${edge.sourcePort}" non trovato su "${src._uiRef?.label ?? edge.source}"`,
          severity: 'warning', hint: 'Il handle potrebbe essere stato rimosso — riconnetti il nodo',
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
          message: `Handle di input "${edge.targetPort}" non trovato su "${tgt._uiRef?.label ?? edge.target}"`,
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
          message: `Campo "${contractField.name}" richiesto dal contratto ma non presente nello schema output`,
          severity: 'error',
          hint: `Aggiungi il campo "${contractField.name}" (tipo: ${contractField.type}) all'output del nodo`,
        })
        return
      }
      if (schemaField.type !== contractField.type && contractField.type !== 'any') {
        issues.push({
          nodeId: canvasId, fieldId: schemaField.id, code: 'CONTRACT_TYPE_MISMATCH',
          message: `Campo "${contractField.name}": tipo "${schemaField.type}" non compatibile con il contratto (atteso "${contractField.type}")`,
          severity: 'warning', hint: 'Aggiungi una trasformazione di cast o aggiorna il contratto',
        })
      }
      if (!contractField.nullable && schemaField.nullable === true) {
        issues.push({
          nodeId: canvasId, fieldId: schemaField.id, code: 'CONTRACT_NULLABLE_VIOLATION',
          message: `Campo "${contractField.name}" è nullable ma il contratto richiede NOT NULL`,
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
        message:  `Gruppo transazionale "${groupId}" ha un solo partecipante — la transazione non ha effetto`,
        code:     'TX_SINGLE_PARTICIPANT',
        hint:     'Aggiungi altri sink allo stesso gruppo o rimuovi la configurazione transazionale',
      })
    }

    members.forEach(({ node, txConfig, resourceId, resourceDialect }) => {

      // Regola: nodo senza risorsa
      if (!resourceId) {
        issues.push({
          severity: 'error',
          nodeId:   canvasNodeId(node.id),
          message:  `Nodo in gruppo transazionale "${groupId}" senza risorsa configurata`,
          code:     'TX_NO_RESOURCE',
          hint:     'Configura una risorsa nel tab Configurazione',
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
            message:  `Gruppo transazionale nativo "${groupId}": tutti i nodi devono usare la stessa risorsa. Cambia modalità in XA per risorse eterogenee.`,
            code:     'TX_NATIVE_RESOURCE_MISMATCH',
            hint:     'Imposta modalità XA nel TransactionGroupEditor',
          })
        }
      }

      // Regola xa: dialetto XA-compatibile
      if (txConfig.mode === 'xa' && resourceDialect && !XA_COMPATIBLE_DIALECTS.has(resourceDialect)) {
        issues.push({
          severity: 'warning',
          nodeId:   canvasNodeId(node.id),
          message:  `Risorsa con dialetto "${resourceDialect}" potrebbe non supportare XA transactions`,
          code:     'TX_XA_UNSUPPORTED_DIALECT',
          hint:     'Verifica che il driver JDBC della risorsa supporti il protocollo XA',
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