/**
 * src/ir/pipeline.ts
 *
 * Modifiche rispetto alla versione precedente:
 * - Aggiunta fase analyzeTMapNodes dopo optimize(), prima di generateTypeScript().
 *   Calcola il column usage map per ogni nodo TMap e lo attacca al piano IR
 *   come proprietà columnUsage sul nodo — disponibile al codegen senza ricalcolo.
 */

import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData, Pool, TMapConfig } from '../types'
import type { LogicalPlan, LogicalNode, ValidationIssue } from './types'
import type { OptimizationLog } from '../codegen/typescript/optimizer_types'
import type { CodegenOutput } from '../codegen/typescript/index'

import { canvasToIR }                        from './lowering'
import { propagateSchema }                   from './schemaPropagation'
import { validateDAG, applyIssuesToCanvas }  from './dagValidation'
import { optimize }                          from '../codegen/typescript/../../ir/optimizer'
import { generateTypeScript }                from '../codegen/typescript/index'
import {
  analyzeTMapColumnUsage,
  type ColumnUsageResult,
} from './analyzeTMapColumnUsage'

// ─────────────────────────────────────────────────────────────────
// TIPI RISULTATO
// ─────────────────────────────────────────────────────────────────

export interface ValidationRun {
  issues:       ValidationIssue[]
  valid:        boolean
  updatedNodes: FlowNode<NodeData>[]
}

export interface CompilationRun {
  plan:             LogicalPlan
  schemaIssues:     ValidationIssue[]
  optimizationLogs: OptimizationLog[]
  valid:            boolean
}

export interface CodegenRun extends CompilationRun {
  output: CodegenOutput
}

// ─────────────────────────────────────────────────────────────────
// HELPER — ricava planId e planName dal pool
// ─────────────────────────────────────────────────────────────────

function getPlanMeta(pool: Pool): { planId: string; planName: string } {
  return {
    planId:   pool.id    ?? 'plan_main',
    planName: pool.label ?? 'FlowPilot Pipeline',
  }
}

// ─────────────────────────────────────────────────────────────────
// FASE: analisi column usage per tutti i nodi TMap
// Chiamata dopo optimize(), prima di generateTypeScript().
// Attacca columnUsage al nodo IR come proprietà extra —
// il codegen la legge con node.columnUsage senza ricalcolare.
// ─────────────────────────────────────────────────────────────────

function analyzeTMapNodes(plan: LogicalPlan): LogicalPlan {
  const updatedNodes = plan.nodes.map((node: LogicalNode) => {
    // Rileva nodi TMap — vengono abbassati a 'branch' nel lowering
    const isTMap = node._uiRef?.type === 'tmap'
    if (!isTMap) return node

    const tmap = ((node._uiRef?.config ?? {}) as any)?.tmap as TMapConfig | undefined
    if (!tmap) return node

    const columnUsage = analyzeTMapColumnUsage(tmap)

    // Log di debug in sviluppo
    if (process.env.NODE_ENV === 'development') {
      const savings = Object.entries(columnUsage.stats)
        .filter(([, s]) => s.pruned > 0)
        .map(([id, s]) => `${id}: ${s.used}/${s.total} cols`)
        .join(', ')
      if (savings) {
        console.debug(`[TMap column pruning] node ${node.id}: ${savings}`)
      }
    }

    return { ...node, columnUsage } as LogicalNode & { columnUsage: ColumnUsageResult }
  })

  return { ...plan, nodes: updatedNodes }
}

// ─────────────────────────────────────────────────────────────────
// VALIDAZIONE
// ─────────────────────────────────────────────────────────────────

export function runValidation(
  nodes: FlowNode<NodeData>[],
  edges: Edge[],
  pool:  Pool,
): ValidationRun {
  const { planId, planName } = getPlanMeta(pool)
  const plan = canvasToIR(nodes, edges, planId, planName, pool)

  const { plan: withSchema, issues: schemaIssues } = propagateSchema(plan)
  const { issues, valid } = validateDAG(withSchema)
  const allIssues = [...schemaIssues, ...issues]

  const updatedNodes = applyIssuesToCanvas(allIssues, nodes)
  return { issues: allIssues, valid, updatedNodes }
}

// ─────────────────────────────────────────────────────────────────
// COMPILAZIONE
// ─────────────────────────────────────────────────────────────────

export function runCompilation(
  nodes: FlowNode<NodeData>[],
  edges: Edge[],
  pool:  Pool,
): CompilationRun {
  const { planId, planName } = getPlanMeta(pool)
  const plan = canvasToIR(nodes, edges, planId, planName, pool)

  const { plan: withSchema, issues: schemaIssues } = propagateSchema(plan)
  const { valid, issues: validationIssues } = validateDAG(withSchema)

  if (!valid) {
    return {
      plan:             withSchema,
      schemaIssues:     [...schemaIssues, ...validationIssues],
      optimizationLogs: [],
      valid:            false,
    }
  }

  const { plan: optimized, logs } = optimize(withSchema)

  // ── Fase column usage analysis ────────────────────────────────
  // Dopo l'ottimizzazione, il piano è stabile — calcoliamo il
  // column usage per ogni nodo TMap e lo attacchiamo all'IR.
  const withColumnUsage = analyzeTMapNodes(optimized)

  return {
    plan:             withColumnUsage,
    schemaIssues:     [...schemaIssues, ...validationIssues],
    optimizationLogs: logs,
    valid:            true,
  }
}

// ─────────────────────────────────────────────────────────────────
// CODE GENERATION
// ─────────────────────────────────────────────────────────────────

export function runCodegen(
  nodes: FlowNode<NodeData>[],
  edges: Edge[],
  pool:  Pool,
): CodegenRun {
  const compilation = runCompilation(nodes, edges, pool)

  if (!compilation.valid) {
    return {
      ...compilation,
      output: {
        files:      new Map(),
        entryPoint: '',
        warnings:   compilation.schemaIssues
          .filter((i) => i.severity === 'error')
          .map((i) => i.message),
      },
    }
  }

  const output = generateTypeScript(compilation.plan)
  return { ...compilation, output }
}

// ─────────────────────────────────────────────────────────────────
// SCHEDULER
// ─────────────────────────────────────────────────────────────────

let _validationTimer: ReturnType<typeof setTimeout> | null = null

export function scheduleCanvasValidation(
  getState: () => { nodes: FlowNode<NodeData>[]; edges: Edge[]; pool: Pool },
  setNodes: (nodes: FlowNode<NodeData>[]) => void,
  delayMs  = 400,
): void {
  if (_validationTimer) clearTimeout(_validationTimer)

  _validationTimer = setTimeout(() => {
    try {
      const { nodes, edges, pool } = getState()
      const { updatedNodes } = runValidation(nodes, edges, pool)
      setNodes(updatedNodes)
    } catch (e) {
      console.warn('[FlowPilot IR] Validation error:', e)
    }
    _validationTimer = null
  }, delayMs)
}