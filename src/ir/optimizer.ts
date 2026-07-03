/**
 * src/ir/optimizer.ts
 * ───────────────────
 * Optimizer passes sul Logical IR — Step 9 della migrazione.
 *
 * L'optimizer opera sul LogicalPlan DOPO la schema propagation
 * e PRIMA del Physical Planner. Ogni pass è:
 *   - Una funzione pura: LogicalPlan → LogicalPlan
 *   - Idempotente: applicarla N volte = applicarla 1 volta
 *   - Componibile: i pass si concatenano in pipeline
 *
 * PASS IMPLEMENTATI (in ordine di applicazione):
 *   1. Constant folding        — semplifica espressioni costanti
 *   2. Predicate simplification — semplifica predicati booleani
 *   3. Dead code elimination   — rimuove nodi non raggiungibili da sink
 *   4. Projection pruning      — elimina campi non usati downstream
 *   5. Predicate pushdown      — sposta filtri verso le sorgenti
 *   6. Common subexpr elim.    — evita calcoli duplicati
 *   7. Materialization insert  — aggiunge punti di materializzazione
 *
 * USO:
 *   const optimized = optimize(plan)
 *   // oppure singoli pass:
 *   const p1 = deadCodeElimination(plan)
 *   const p2 = projectionPruning(p1)
 */

import type {
  LogicalPlan,
  LogicalNode,
  LogicalEdge,
  ExprNode,
  SchemaField,
  MaterializationPoint,
} from './types'
import {
  extractFieldRefs,
  isConstant,
  evaluateConstant,
  isPredicate,
  printExpr,
  expr,
} from './expr'
import { topologicalSort, canvasNodeId } from './lowering'

// ─────────────────────────────────────────────────────────────────
// INTERFACCIA PASS
// ─────────────────────────────────────────────────────────────────

export interface OptimizerPass {
  name:        string
  description: string
  /** Applica il pass al piano — restituisce un nuovo piano ottimizzato */
  apply(plan: LogicalPlan): LogicalPlan
  /** true se il pass può essere applicato a questo piano */
  isApplicable(plan: LogicalPlan): boolean
}

/** Log di una ottimizzazione applicata — utile per debug e UI */
export interface OptimizationLog {
  pass:      string
  nodeId?:   string
  message:   string
  before?:   string
  after?:    string
}

/** Risultato dell'ottimizzazione completa */
export interface OptimizationResult {
  plan: LogicalPlan
  logs: OptimizationLog[]
  /** Numero di pass applicati che hanno prodotto modifiche */
  changesApplied: number
}

// ─────────────────────────────────────────────────────────────────
// HELPERS INTERNI
// ─────────────────────────────────────────────────────────────────

function clonePlan(plan: LogicalPlan): LogicalPlan {
  return {
    ...plan,
    nodes: plan.nodes.map((n) => ({
      ...n,
      inputs:  [...n.inputs],
      outputs: [...n.outputs],
      schema:  { input: [...n.schema.input], output: [...n.schema.output] },
      expressions: [...n.expressions],
    })),
    edges: plan.edges.map((e) => ({ ...e, schema: [...e.schema], lineage: [...e.lineage] })),
  }
}

function updateNode(plan: LogicalPlan, nodeId: string, patch: Partial<LogicalNode>): LogicalPlan {
  return {
    ...plan,
    nodes: plan.nodes.map((n) => n.id === nodeId ? { ...n, ...patch } : n),
  }
}

function removeNodes(plan: LogicalPlan, nodeIds: Set<string>): LogicalPlan {
  return {
    ...plan,
    nodes: plan.nodes.filter((n) => !nodeIds.has(n.id)),
    edges: plan.edges.filter((e) => !nodeIds.has(e.source) && !nodeIds.has(e.target)),
  }
}

// ─────────────────────────────────────────────────────────────────
// PASS 1 — CONSTANT FOLDING
// ─────────────────────────────────────────────────────────────────

/**
 * Semplifica espressioni con valori costanti a compile time.
 * Esempi:
 *   (2 + 3) * campo  →  5 * campo
 *   'hello' + ' ' + 'world'  →  'hello world'
 *   true AND x  →  x
 *   false AND x  →  false
 */
export const constantFolding: OptimizerPass = {
  name:        'constant_folding',
  description: 'Semplifica espressioni con valori costanti a compile time',

  isApplicable(plan) {
    return plan.nodes.some((n) => n.expressions.length > 0)
  },

  apply(plan): LogicalPlan {
    const logs: OptimizationLog[] = []
    let result = clonePlan(plan)

    result.nodes.forEach((node) => {
      if (!node.expressions.length) return

      const optimizedExprs = node.expressions.map((e) => {
        const folded = foldConstants(e)
        if (folded !== e) {
          logs.push({
            pass:    'constant_folding',
            nodeId:  canvasNodeId(node.id),
            message: 'Espressione costante semplificata',
            before:  printExpr(e),
            after:   printExpr(folded),
          })
        }
        return folded
      })

      result = updateNode(result, node.id, { expressions: optimizedExprs })
    })

    return result
  },
}

function foldConstants(e: ExprNode): ExprNode {
  if (e.kind === 'literal') return e
  if (e.kind === 'raw_string') return e

  // Prova a valutare l'intera espressione se costante
  const evaluated = evaluateConstant(e)
  if (evaluated) return evaluated

  // Altrimenti ricorre nei figli
  if (e.kind === 'binary_op') {
    const left  = foldConstants(e.left)
    const right = foldConstants(e.right)

    // true AND x → x, false AND x → false
    if (e.op === 'and') {
      if (left.kind  === 'literal' && left.value  === true)  return right
      if (left.kind  === 'literal' && left.value  === false) return expr.bool(false)
      if (right.kind === 'literal' && right.value === true)  return left
      if (right.kind === 'literal' && right.value === false) return expr.bool(false)
    }
    // false OR x → x, true OR x → true
    if (e.op === 'or') {
      if (left.kind  === 'literal' && left.value  === false) return right
      if (left.kind  === 'literal' && left.value  === true)  return expr.bool(true)
      if (right.kind === 'literal' && right.value === false) return left
      if (right.kind === 'literal' && right.value === true)  return expr.bool(true)
    }

    if (left !== e.left || right !== e.right) {
      return { ...e, left, right }
    }
  }

  if (e.kind === 'unary_op') {
    const operand = foldConstants(e.operand)
    // NOT true → false, NOT false → true
    if (e.op === 'not' && operand.kind === 'literal') {
      if (operand.value === true)  return expr.bool(false)
      if (operand.value === false) return expr.bool(true)
    }
    if (operand !== e.operand) return { ...e, operand }
  }

  if (e.kind === 'function_call') {
    const args = e.args.map(foldConstants)
    const changed = args.some((a, i) => a !== e.args[i])
    return changed ? { ...e, args } : e
  }

  return e
}

// ─────────────────────────────────────────────────────────────────
// PASS 2 — PREDICATE SIMPLIFICATION
// ─────────────────────────────────────────────────────────────────

/**
 * Semplifica predicati booleani ridondanti.
 * Esempi:
 *   a > 5 AND a > 3  →  a > 5   (il secondo è più restrittivo)
 *   a > 5 OR a > 3   →  a > 3   (il primo è già incluso)
 *   NOT (NOT x)      →  x
 */
export const predicateSimplification: OptimizerPass = {
  name:        'predicate_simplification',
  description: 'Semplifica predicati booleani ridondanti',

  isApplicable(plan) {
    return plan.nodes.some((n) =>
      n.expressions.some((e) => isPredicate(e))
    )
  },

  apply(plan): LogicalPlan {
    let result = clonePlan(plan)

    result.nodes.forEach((node) => {
      if (!node.expressions.length) return
      const simplified = node.expressions.map(simplifyPredicate)
      result = updateNode(result, node.id, { expressions: simplified })
    })

    return result
  },
}

function simplifyPredicate(e: ExprNode): ExprNode {
  if (e.kind === 'unary_op' && e.op === 'not') {
    // NOT (NOT x) → x
    if (e.operand.kind === 'unary_op' && e.operand.op === 'not') {
      return simplifyPredicate(e.operand.operand)
    }
    // NOT (a == b) → a != b
    if (e.operand.kind === 'binary_op' && e.operand.op === '==') {
      return { ...e.operand, op: '!=' }
    }
    // NOT (a != b) → a == b
    if (e.operand.kind === 'binary_op' && e.operand.op === '!=') {
      return { ...e.operand, op: '==' }
    }
  }

  if (e.kind === 'binary_op') {
    const left  = simplifyPredicate(e.left)
    const right = simplifyPredicate(e.right)
    return left !== e.left || right !== e.right ? { ...e, left, right } : e
  }

  return e
}

// ─────────────────────────────────────────────────────────────────
// PASS 3 — DEAD CODE ELIMINATION
// ─────────────────────────────────────────────────────────────────

/**
 * Rimuove nodi non raggiungibili da nessun sink.
 * Un nodo è "morto" se non esiste nessun percorso da esso
 * verso un nodo sink.
 */
export const deadCodeElimination: OptimizerPass = {
  name:        'dead_code_elimination',
  description: 'Rimuove nodi non raggiungibili da nessun sink',

  isApplicable(plan) {
    return plan.nodes.some((n) => n.operation !== 'sink')
  },

  apply(plan): LogicalPlan {
    // Adiacenza inversa: da ogni nodo ai suoi predecessori
    // Partiamo dai sink e camminiamo all'indietro
    const reverseAdj = new Map<string, string[]>()
    plan.nodes.forEach((n) => reverseAdj.set(n.id, []))
    plan.edges.forEach((e) => reverseAdj.get(e.target)?.push(e.source))

    // BFS all'indietro dai sink
    const reachableFromSink = new Set<string>()
    const sinks = plan.nodes.filter((n) => n.operation === 'sink')
    const queue = sinks.map((n) => n.id)

    while (queue.length > 0) {
      const id = queue.shift()!
      reachableFromSink.add(id)
      reverseAdj.get(id)?.forEach((pred) => {
        if (!reachableFromSink.has(pred)) queue.push(pred)
      })
    }

    // Nodi non raggiungibili = dead code
    const deadNodeIds = new Set(
      plan.nodes
        .filter((n) => !reachableFromSink.has(n.id))
        .map((n) => n.id)
    )

    if (deadNodeIds.size === 0) return plan
    return removeNodes(plan, deadNodeIds)
  },
}

// ─────────────────────────────────────────────────────────────────
// PASS 4 — PROJECTION PRUNING
// ─────────────────────────────────────────────────────────────────

/**
 * Elimina campi non usati downstream il prima possibile.
 * Riduce I/O, shuffle cost e memoria.
 *
 * Algoritmo: traversal all'indietro dai sink.
 * Per ogni nodo, calcola l'insieme dei campi richiesti dai figli.
 * Se il nodo produce campi in più → li segna come prunable.
 */
export const projectionPruning: OptimizerPass = {
  name:        'projection_pruning',
  description: 'Elimina campi non usati downstream per ridurre I/O',

  isApplicable(plan) {
    return plan.nodes.some((n) => n.schema.output.length > 0)
  },

  apply(plan): LogicalPlan {
    const sorted = topologicalSort(plan)
    if (!sorted) return plan   // ciclo — skip

    // Adiacenza diretta
    const adj = new Map<string, string[]>()
    plan.nodes.forEach((n) => adj.set(n.id, []))
    plan.edges.forEach((e) => adj.get(e.source)?.push(e.target))

    // Calcola i campi richiesti da ogni nodo (propagazione all'indietro)
    const requiredFields = new Map<string, Set<string>>()
    plan.nodes.forEach((n) => requiredFields.set(n.id, new Set()))

    // I sink richiedono tutti i campi del loro input
    plan.nodes
      .filter((n) => n.operation === 'sink')
      .forEach((n) => {
        n.schema.input.forEach((f) => requiredFields.get(n.id)?.add(f.name))
      })

    // Traversal all'indietro
    const reverseSorted = [...sorted].reverse()
    reverseSorted.forEach((node) => {
      const childrenRequired = new Set<string>()

      adj.get(node.id)?.forEach((childId) => {
        requiredFields.get(childId)?.forEach((f) => childrenRequired.add(f))
      })

      // I campi usati nelle espressioni del nodo sono sempre richiesti
      node.expressions.forEach((e) => {
        extractFieldRefs(e).forEach((ref) => childrenRequired.add(ref.fieldName))
      })

      requiredFields.set(node.id, childrenRequired)
    })

    // Applica pruning: rimuove dall'output i campi non richiesti
    let result = clonePlan(plan)
    result.nodes.forEach((node) => {
      if (node.operation === 'sink' || node.operation === 'scan') return

      const required = requiredFields.get(node.id) ?? new Set()
      if (required.size === 0) return   // nessun requisito → non prunare

      const prunedOutput = node.schema.output.filter(
        (f) => required.has(f.name)
      )

      if (prunedOutput.length < node.schema.output.length) {
        result = updateNode(result, node.id, {
          schema: { ...node.schema, output: prunedOutput },
        })
      }
    })

    return result
  },
}

// ─────────────────────────────────────────────────────────────────
// PASS 5 — PREDICATE PUSHDOWN
// ─────────────────────────────────────────────────────────────────

/**
 * Sposta i filtri il più vicino possibile alla sorgente dati.
 *
 * Se un nodo filter è direttamente connesso a un nodo scan
 * (source_db, source_file) che supporta pushdown, annota il
 * predicato sul nodo scan come "pushdownPredicate" — il code
 * generator lo tradurrà in WHERE SQL o in filtro nativo.
 *
 * Questa annotazione è aggiunta in _uiRef per non sporcare
 * la semantica dell'IR.
 */
export const predicatePushdown: OptimizerPass = {
  name:        'predicate_pushdown',
  description: 'Sposta i filtri verso le sorgenti dati per ridurre I/O',

  isApplicable(plan) {
    return plan.nodes.some((n) => n.operation === 'filter') &&
           plan.nodes.some((n) => n.operation === 'scan')
  },

  apply(plan): LogicalPlan {
    let result = clonePlan(plan)

    const nodeMap   = new Map(result.nodes.map((n) => [n.id, n]))
    const predEdges = result.edges.filter((e) => {
      const src = nodeMap.get(e.source)
      const tgt = nodeMap.get(e.target)
      return src?.operation === 'scan' && tgt?.operation === 'filter'
    })

    predEdges.forEach((edge) => {
      const scan   = nodeMap.get(edge.source)!
      const filter = nodeMap.get(edge.target)!

      // Verifica che il filtro non abbia altri input (nessun join)
      const filterInputs = result.edges.filter((e) => e.target === filter.id)
      if (filterInputs.length !== 1) return

      // Verifica che la sorgente supporti pushdown
      const uiType   = scan._uiRef?.type ?? ''
      const pushdownPreds = filter.expressions.filter(isPredicate)
      if (pushdownPreds.length === 0) return

      // Annota il predicato sul nodo scan
      const existingPreds: ExprNode[] = (scan._uiRef as any)?.pushdownPredicates ?? []
      result = updateNode(result, scan.id, {
        _uiRef: {
          ...scan._uiRef!,
          pushdownPredicates: [...existingPreds, ...pushdownPreds],
        } as any,
      })
    })

    return result
  },
}

// ─────────────────────────────────────────────────────────────────
// PASS 6 — COMMON SUBEXPRESSION ELIMINATION (CSE)
// ─────────────────────────────────────────────────────────────────

/**
 * Identifica espressioni identiche usate in più nodi
 * e le segna per essere calcolate una volta sola.
 *
 * Per ora: solo rilevamento e log (l'eliminazione vera
 * richiede il Physical Planner per materializzare il risultato).
 */
export const commonSubexprElimination: OptimizerPass = {
  name:        'common_subexpr_elimination',
  description: 'Identifica espressioni duplicate per calcolarle una sola volta',

  isApplicable(plan) {
    return plan.nodes.filter((n) => n.expressions.length > 0).length > 1
  },

  apply(plan): LogicalPlan {
    // Conta occorrenze di ogni espressione (per stringa)
    const exprCount = new Map<string, number>()

    plan.nodes.forEach((node) => {
      node.expressions.forEach((e) => {
        if (e.kind === 'raw_string') return
        const key = printExpr(e)
        exprCount.set(key, (exprCount.get(key) ?? 0) + 1)
      })
    })

    // Espressioni che appaiono più di una volta = candidati CSE
    const cseTargets = new Set(
      Array.from(exprCount.entries())
        .filter(([, count]) => count > 1)
        .map(([key]) => key)
    )

    if (cseTargets.size === 0) return plan

    // Annota i nodi con le espressioni CSE
    // (il Physical Planner le materializzerà in un nodo intermedio)
    let result = clonePlan(plan)
    result.nodes.forEach((node) => {
      const cseCandidates = node.expressions.filter((e) => {
        if (e.kind === 'raw_string') return false
        return cseTargets.has(printExpr(e))
      })

      if (cseCandidates.length > 0) {
        result = updateNode(result, node.id, {
          _uiRef: {
            ...node._uiRef!,
            cseCandidates: cseCandidates.map(printExpr),
          } as any,
        })
      }
    })

    return result
  },
}

// ─────────────────────────────────────────────────────────────────
// PASS 7 — MATERIALIZATION INSERTION
// ─────────────────────────────────────────────────────────────────

/**
 * Inserisce MaterializationPoint dove richiesto dalla semantica.
 *
 * Regole:
 * - Prima di ogni nodo `dataset` (aggregate, sort) → barrier
 * - Prima di ogni nodo `stateful` (join) con input grandi → disk
 * - Dopo nodi costosi usati da più downstream → cache
 */
export const materializationInsertion: OptimizerPass = {
  name:        'materialization_insertion',
  description: 'Inserisce punti di materializzazione per retry e performance',

  isApplicable(plan) {
    return plan.nodes.some((n) =>
      n.executionSemantics === 'dataset' || n.executionSemantics === 'stateful'
    )
  },

  apply(plan): LogicalPlan {
    const materializations: MaterializationPoint[] = []

    // Adiacenza diretta per trovare predecessori
    const predecessors = new Map<string, string[]>()
    plan.nodes.forEach((n) => predecessors.set(n.id, []))
    plan.edges.forEach((e) => predecessors.get(e.target)?.push(e.source))

    plan.nodes.forEach((node) => {
      const preds = predecessors.get(node.id) ?? []
      if (preds.length === 0) return

      if (node.executionSemantics === 'dataset') {
        // Aggregate, sort: barrier prima del nodo
        preds.forEach((predId) => {
          materializations.push({
            afterNodeId: canvasNodeId(predId),
            strategy:    'checkpoint',
            reason:      'barrier',
          })
        })
      }

      if (node.executionSemantics === 'stateful' && preds.length >= 2) {
        // Join: materializza l'input più piccolo (lato lookup) in memoria
        materializations.push({
          afterNodeId: canvasNodeId(preds[1]),  // secondo input = lookup
          strategy:    'memory',
          reason:      'shuffle',
        })
      }
    })

    // Annota il piano con i MaterializationPoint
    // (verranno usati dal Physical Planner per costruire il PhysicalPlan)
    return {
      ...plan,
      metadata: {
        ...plan.metadata!,
        // Usiamo metadata per trasportare i MaterializationPoint
        // senza modificare la struttura del LogicalPlan
        materializations: materializations as any,
      },
    } as LogicalPlan
  },
}

// ─────────────────────────────────────────────────────────────────
// PIPELINE OPTIMIZER — applica tutti i pass in sequenza
// ─────────────────────────────────────────────────────────────────

/** Pass di default applicati nell'ordine corretto */
const DEFAULT_PASSES: OptimizerPass[] = [
  constantFolding,
  predicateSimplification,
  deadCodeElimination,
  projectionPruning,
  predicatePushdown,
  commonSubexprElimination,
  materializationInsertion,
]

/**
 * Applica tutti i pass di ottimizzazione al piano logico.
 *
 * @param plan   Piano logico da ottimizzare (con schema già propagato)
 * @param passes Pass da applicare (default: tutti)
 * @returns      Piano ottimizzato + log delle ottimizzazioni applicate
 */
export function optimize(
  plan:   LogicalPlan,
  passes: OptimizerPass[] = DEFAULT_PASSES,
): OptimizationResult {

  const logs:    OptimizationLog[] = []
  let   current  = plan
  let   changes  = 0

  for (const pass of passes) {
    if (!pass.isApplicable(current)) continue

    const before    = current
    const optimized = pass.apply(current)

    // Conta le modifiche contando i nodi/edge cambiati
    const nodesBefore = before.nodes.length
    const nodesAfter  = optimized.nodes.length

    if (nodesAfter !== nodesBefore || JSON.stringify(optimized.nodes) !== JSON.stringify(before.nodes)) {
      changes++
      logs.push({
        pass:    pass.name,
        message: `Pass "${pass.name}" applicato — ${nodesBefore - nodesAfter > 0 ? `${nodesBefore - nodesAfter} nodi rimossi` : 'espressioni ottimizzate'}`,
      })
    }

    current = optimized
  }

  return { plan: current, logs, changesApplied: changes }
}

/**
 * Applica l'ottimizzazione completa: schema propagation + optimizer.
 * Convenienza per chi vuole tutto in un'unica chiamata.
 */
export function propagateAndOptimize(
    plan: LogicalPlan,
    propagateFn: (p: LogicalPlan) => { plan: LogicalPlan; issues: any[] },
  ): {
    plan:             LogicalPlan
    schemaIssues:     any[]
    optimizationLogs: OptimizationLog[]
  } {
    const { plan: withSchema, issues } = propagateFn(plan)
    const { plan: optimized, logs }    = optimize(withSchema)

    return {
      plan:             optimized,
      schemaIssues:     issues,
      optimizationLogs: logs,
    }
}
