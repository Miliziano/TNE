/**
 * src/ir/lowering.ts
 */

import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData, TMapConfig } from '../types'
import type {
  LogicalPlan, LogicalNode, LogicalEdge,
  PortSpec, SchemaField, ExprNode, RawStringExpr,
} from './types'
import { getNodeSemantics } from './nodeSemantics'
import type { JsonParserConfig } from '../nodes/types/json_parser/jsonParserTypes'
import type { XmlParserConfig  } from '../nodes/types/xml_parser/xmlParserTypes'

export const IR_VERSION = '1.0.0'

interface LoweringContext {
  allNodes: FlowNode<NodeData>[]
  allEdges: Edge[]
}

interface NodeLowerer {
  uiType: string
  buildOutputPorts(node: FlowNode<NodeData>, ctx: LoweringContext): PortSpec[]
  buildExpressions(node: FlowNode<NodeData>): ExprNode[]
}

// ─── Lowerer TMap ─────────────────────────────────────────────────

const tmapLowerer: NodeLowerer = {
  uiType: 'tmap',
  buildOutputPorts(node) {
    const tmap = node.data.config?.tmap as TMapConfig | undefined
    if (!tmap) return [
      { id: 'output_main',     label: 'main_out', isReject: false },
      { id: 'output_rejected', label: 'rejected',  isReject: true  },
    ]
    return tmap.outputs.map((out) => ({
      id: out.id, label: out.label,
      isReject: out.id === 'output_rejected' || out.label === 'rejected',
    }))
  },
  buildExpressions(node) {
    const tmap = node.data.config?.tmap as TMapConfig | undefined
    if (!tmap?.transforms?.length) return []
    return tmap.transforms.map((t): RawStringExpr => ({
      kind: 'raw_string', value: t.expression, type: t.outputType as any ?? 'string',
    }))
  },
}

// ─── Lowerer JSON Parser ───────────────────────────────────────────

const jsonParserLowerer: NodeLowerer = {
  uiType: 'json_parser',
  buildOutputPorts(node) {
    const cfg = node.data.config?.jsonParser as JsonParserConfig | undefined
    if (!cfg?.flows?.length) return [{ id: 'output', label: 'output', isReject: false }]
    const ports: PortSpec[] = cfg.flows.map((flow) => ({
      id: flow.id, label: flow.label, isReject: false,
      schema: flow.fields.map((f): SchemaField => ({ id: f.id, name: f.name, type: f.type as any })),
    }))
    if (cfg.hasReject) ports.push({ id: 'reject', label: 'reject', isReject: true })
    return ports
  },
  buildExpressions() { return [] },
}

// ─── Lowerer XML Parser ────────────────────────────────────────────

const xmlParserLowerer: NodeLowerer = {
  uiType: 'xml_parser',
  buildOutputPorts(node) {
    const cfg = node.data.config?.xmlParser as XmlParserConfig | undefined
    if (!cfg?.flows?.length) return [{ id: 'output', label: 'output', isReject: false }]
    const ports: PortSpec[] = cfg.flows.map((flow) => ({
      id: flow.id, label: flow.label, isReject: false,
      schema: flow.fields.map((f): SchemaField => ({ id: f.id, name: f.name, type: f.type as any })),
    }))
    if (cfg.hasReject) ports.push({ id: 'reject', label: 'reject', isReject: true })
    return ports
  },
  buildExpressions() { return [] },
}

// ─── Lowerer Script ────────────────────────────────────────────────

const scriptLowerer: NodeLowerer = {
  uiType: 'script',
  buildOutputPorts() {
    return [
      { id: 'output', label: 'output', isReject: false },
      { id: 'reject', label: 'reject', isReject: true  },
    ]
  },
  buildExpressions(node) {
    const code = node.data.props['code']
    if (!code) return []
    return [{ kind: 'raw_string' as const, value: code, type: 'any' as const }]
  },
}

// ─── Lowerer Filter ────────────────────────────────────────────────

const filterLowerer: NodeLowerer = {
  uiType: 'filter',

  buildOutputPorts(node) {
    const cfg = node.data.config?.filter as { conditions?: Array<{ id: string; label: string }> } | undefined
    const conditions = cfg?.conditions ?? []

    if (conditions.length === 0) {
      // Nessuna condizione configurata — porte di default
      return [
        { id: 'output', label: 'output', isReject: false },
        { id: 'reject', label: 'reject', isReject: true  },
      ]
    }

    return [
      ...conditions.map((cond) => ({
        id:       cond.id,
        label:    cond.label,
        isReject: false,
      })),
      { id: 'reject', label: 'reject', isReject: true },
    ]
  },

  buildExpressions(node) {
    const cfg = node.data.config?.filter as { conditions?: Array<{ id: string; mode: string; code?: string }> } | undefined
    if (!cfg?.conditions?.length) return []
    // Ogni condizione diventa una RawStringExpr
    return cfg.conditions.map((cond): RawStringExpr => ({
      kind:  'raw_string',
      value: cond.code ?? 'true',
      type:  'boolean' as const,
    }))
  },
}

// ─── Lowerer Lane Boundary ────────────────────────────────────────
/**
 * Traduce lane_start e lane_end in nodi lane_boundary.
 * Non hanno schema, non producono dati — servono solo come
 * punti di ancoraggio per la validazione del DAG.
 * Il codegen li ignora completamente.
 */
const laneBoundaryLowerer: NodeLowerer = {
  uiType: 'lane_boundary',
  buildOutputPorts(node) {
    // Le porte le dichiara il contratto (nodeSemantics): lane_start ha
    // un'uscita di ruolo 'signal', lane_end non ne ha. Prima erano
    // ricopiate qui a mano — e la copia, muta sul ruolo, scavalcava in
    // silenzio la dichiarazione.
    return getNodeSemantics(node.data.type).staticOutputPorts.map((p) => ({ ...p }))
  },
  buildExpressions() { return [] },
}

// ─── Registro ─────────────────────────────────────────────────────

const NODE_LOWERERS: Record<string, NodeLowerer> = {
  tmap:        tmapLowerer,
  json_parser: jsonParserLowerer,
  xml_parser:  xmlParserLowerer,
  script:      scriptLowerer,
  filter:      filterLowerer,
  lane_start:  laneBoundaryLowerer,
  lane_end:    laneBoundaryLowerer,
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/**
 * Nodi che NON entrano nell'IR — nessuno per ora.
 * lane_start e lane_end sono stati promossi a lane_boundary.
 */
const UI_ONLY_NODE_TYPES = new Set<string>()

function buildInputPorts(
  node:     FlowNode<NodeData>,
  edges:    Edge[],
  allNodes: FlowNode<NodeData>[],
): PortSpec[] {
  const inEdges = edges.filter((e) => e.target === node.id)
  if (inEdges.length === 0) return []

  const semantics = getNodeSemantics(node.data.type)

  if (!semantics.acceptsMultipleInputs) {
    const handle = inEdges[0]?.targetHandle ?? 'input'
    return [{ id: handle, label: 'input', isReject: false }]
  }

  const tmap = node.data.config?.tmap as TMapConfig | undefined
  if (tmap?.inputs?.length) {
    return tmap.inputs.map((inp) => ({
      id: inp.id, label: inp.label, isReject: false,
    }))
  }

  return inEdges.map((e, idx) => ({
    id:    e.targetHandle ?? `input_${idx}`,
    label: `input_${idx}`,
    isReject: false,
  }))
}

function buildOutputPorts(node: FlowNode<NodeData>, ctx: LoweringContext): PortSpec[] {
  const lowerer = NODE_LOWERERS[node.data.type]
  if (lowerer) return lowerer.buildOutputPorts(node, ctx)
  const semantics = getNodeSemantics(node.data.type)
  return semantics.staticOutputPorts.map((p) => ({ ...p }))
}

function buildExpressions(node: FlowNode<NodeData>): ExprNode[] {
  const lowerer = NODE_LOWERERS[node.data.type]
  if (lowerer) return lowerer.buildExpressions(node)
  return []
}

function logicalNodeId(canvasNodeId: string): string {
  return `ln_${canvasNodeId}`
}

function logicalEdgeId(canvasEdgeId: string): string {
  return `le_${canvasEdgeId}`
}

// ─────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────

export function canvasToIR(
  nodes:    FlowNode<NodeData>[],
  edges:    Edge[],
  planId:   string,
  planName: string,
  pool?:    import('../types').Pool,
): LogicalPlan {

  const ctx: LoweringContext = { allNodes: nodes, allEdges: edges }

  // Tutti i nodi entrano nell'IR — UI_ONLY_NODE_TYPES è ora vuoto
  const dataNodes = nodes.filter((n) => !UI_ONLY_NODE_TYPES.has(n.data.type))

  // Tutti gli edge entrano nell'IR
  const dataEdges = edges

  const logicalNodes: LogicalNode[] = dataNodes.map((n) => {
    const semantics   = getNodeSemantics(n.data.type)
    const inputPorts  = buildInputPorts(n, dataEdges, nodes)
    const outputPorts = buildOutputPorts(n, ctx)
    const expressions = buildExpressions(n)
    
    const onError = (n.data.config?.advanced?.onError) ?? 'stop'
    if (onError === 'propagate') {
      outputPorts.push({
        id:       'catch',
        label:    'catch',
        isReject: true,
        schema: [
          { id: 'catch_error_message',   name: '_error_message',   type: 'string'  as const, physicalName: '_error_message'   },
          { id: 'catch_error_code',      name: '_error_code',      type: 'string'  as const, physicalName: '_error_code'      },
          { id: 'catch_error_node_id',   name: '_error_node_id',   type: 'string'  as const, physicalName: '_error_node_id'   },
          { id: 'catch_error_node_type', name: '_error_node_type', type: 'string'  as const, physicalName: '_error_node_type' },
          { id: 'catch_error_at',        name: '_error_at',        type: 'date'    as const, physicalName: '_error_at'        },
          { id: 'catch_error_row',       name: '_error_row',       type: 'object'  as const, physicalName: '_error_row'       },
        ],
      })
    }
    // lane_start e lane_end → operazione lane_boundary
    const operation = (
      n.data.type === 'lane_start' || n.data.type === 'lane_end'||
      n.data.type === 'bridge_out' || n.data.type === 'bridge_in'
    )
    ? 'lane_boundary' as const
    : semantics.operations[0]

    // lane_boundary → semantica 'row' (passthrough, nessun impatto sul planner)
    const execSemantics = (n.data.type === 'lane_start' || n.data.type === 'lane_end')
      ? 'row' as const
      : semantics.executionSemantics

   

    return {
      id:        logicalNodeId(n.id),
      operation,
      inputs:    inputPorts,
      outputs:   outputPorts,
      schema:    { input: [], output: [] },
      executionSemantics: execSemantics,
      expressions,
      _uiRef: {
        type:   n.data.type,
        label:  n.data.config?.displayName || n.data.label,
        laneId: n.data.laneId,
        config: {
          ...(n.data.config as object),
          channelName: n.data.props?.['channelName'],
        },
        props: n.data.props as Record<string, string> | undefined,
      },
    }
  })

  const logicalEdges: LogicalEdge[] = dataEdges.map((e) => ({
    id:         logicalEdgeId(e.id),
    source:     logicalNodeId(e.source),
    sourcePort: e.sourceHandle ?? 'output',
    target:     logicalNodeId(e.target),
    targetPort: e.targetHandle ?? 'input',
    schema:     [],
    lineage:    [],
  }))

  return {
    id: planId, name: planName, version: IR_VERSION,
    nodes: logicalNodes, edges: logicalEdges,
    metadata: { createdAt: new Date().toISOString(), description: '', tags: [] },
    pool,
  }
}

// ─────────────────────────────────────────────────────────────────
// REVERSE LOOKUP
// ─────────────────────────────────────────────────────────────────

export function canvasNodeId(logicalId: string): string {
  return logicalId.replace(/^ln_/, '')
}

export function canvasEdgeId(logicalEdgeId: string): string {
  return logicalEdgeId.replace(/^le_/, '')
}

// ─────────────────────────────────────────────────────────────────
// TOPOLOGICAL SORT
// ─────────────────────────────────────────────────────────────────

export function topologicalSort(plan: LogicalPlan): LogicalNode[] | null {
  const inDegree = new Map<string, number>()
  const adj      = new Map<string, string[]>()

  plan.nodes.forEach((n) => { inDegree.set(n.id, 0); adj.set(n.id, []) })
  plan.edges.forEach((e) => {
    inDegree.set(e.target, (inDegree.get(e.target) ?? 0) + 1)
    adj.get(e.source)?.push(e.target)
  })

  const queue:  string[]      = []
  const result: LogicalNode[] = []

  inDegree.forEach((deg, id) => { if (deg === 0) queue.push(id) })

  while (queue.length > 0) {
    const nodeId = queue.shift()!
    const node   = plan.nodes.find((n) => n.id === nodeId)
    if (node) result.push(node)
    adj.get(nodeId)?.forEach((neighbor) => {
      const newDeg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, newDeg)
      if (newDeg === 0) queue.push(neighbor)
    })
  }

  if (result.length !== plan.nodes.length) return null
  return result
}