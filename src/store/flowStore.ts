import { scheduleCanvasValidation, runCompilation, runCodegen } from '../ir/pipeline'
import type { ValidationIssue } from '../ir/types'
import { propagateHandle, getNodeHandles } from '../utils/schemaRegistry'
import { ERROR_HANDLER_SCHEMA } from '../types'
import { create } from 'zustand'
import {
  addEdge,
  applyNodeChanges,
  applyEdgeChanges,
  type Node as FlowNode,
  type Edge,
  type Connection,
  type NodeChange,
  type EdgeChange,
} from '@xyflow/react'
import type {
  NodeData, LogEntry, NodeStatus,
  Pool, Lane, LaneResource, Variable,
  ResourceStatus, NodeConfig, NodeMapping,
  TMapInput, TMapOutput, TMapOutputField, TMapInputField, TMapConfig,
  TMapConnection,
  TMapTransformNode,
  FieldRenameEntry,
} from '../types'
import { NODE_DEFS } from '../nodes/registry'
import {
  applyRenameMap,
  removeFieldFromTransforms as removeFieldFromTransformsFn,
} from '../transforms/utils'


// ─── helpers ─────────────────────────────────────────────────────
let _nodeCounter = 0
const uid     = () => `node_${++_nodeCounter}`
const laneUid = () => `lane_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
/**
 * Risincronizza _nodeCounter al valore più alto tra gli id "node_N"
 * già presenti — DA CHIAMARE sempre dopo aver caricato un progetto
 * (apertura file, import, ecc.), prima che qualunque nuovo nodo possa
 * essere creato con addNode(). Altrimenti il contatore riparte da un
 * valore basso e collide con id già esistenti nel progetto caricato,
 * causando la sovrascrittura silenziosa di un nodo esistente.
 */
export function resyncNodeCounter(nodes: FlowNode<NodeData>[]): void {
  let maxN = 0
  for (const n of nodes) {
    const m = /^node_(\d+)$/.exec(n.id)
    if (m) {
      const num = parseInt(m[1], 10)
      if (num > maxN) maxN = num
    }
  }
  if (maxN > _nodeCounter) _nodeCounter = maxN
}
// ─── helper schedule validation ───────────────────────────────────
function triggerValidation() {
  scheduleCanvasValidation(
    () => {
      const s = useFlowStore.getState()
      return { nodes: s.nodes, edges: s.edges, pool: s.pool }
    },
    (updatedNodes) => useFlowStore.setState({ nodes: updatedNodes }),
  )
}
const resUid  = () => `res_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const varUid  = () => `var_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
const logId   = () => `log_${Date.now()}_${Math.random()}`
const mapUid  = () => `map_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`


// ── Fase 8: statistiche runtime nodi ──────────────────────────
export interface NodeRunStats {
  status:        NodeStatus
  rowsIn:        number
  rowsOut:       number
  rowsRejected?: number
  throughputRps?: number
  elapsedMs?:    number
  perOutput?:    Record<string, number>   // handle → righe (nodi multi-uscita)
}




// ─── config nodo di default ───────────────────────────────────────
const defaultConfig = (): Partial<NodeConfig> => ({
  displayName:  '',
  shortLabel:   '',
  description:  '',
  notes:        '',
  enabled:      'true',
  resourceId:   '',
  mappings:     [],
  advanced: {
    timeoutSec:    '30',
    retryCount:    '0',
    retryDelaySec: '5',
    onError:       'stop',
    batchSize:     '1000',
    parallel:      'false',
    excludeFromErrorLog: 'false',   // ← aggiungere
    critical:            'false',   // ← aggiungere
  },
})

// ─── helper per aggiornare un nodo ───────────────────────────────
export const updateNode = (
  nodes: FlowNode<NodeData>[],
  id: string,
  fn: (n: FlowNode<NodeData>) => FlowNode<NodeData>
) => nodes.map((n) => n.id === id ? fn(n) : n)

// ─── nodi Start/End ───────────────────────────────────────────────
const makeStartEnd = (laneId: string, startId: string, endId: string): FlowNode<NodeData>[] => [
  {
    id: startId,
    type: 'startNode',
    position: { x: 40, y: 60 },
    data: {
      type: 'lane_start', label: 'Start',
      props: { label: 'Start' },
      config: defaultConfig(),
      status: 'idle', laneId,
    },
    deletable: false,
  },
  {
    id: endId,
    type: 'endNode',
    position: { x: 500, y: 60 },
    data: {
      type: 'lane_end', label: 'End',
      props: { label: 'End' },
      config: defaultConfig(),
      status: 'idle', laneId,
    },
    deletable: false,
  },
]

// ─── lane e pool di default ───────────────────────────────────────
const DEFAULT_LANE_A: Lane = {
  id: 'lane_a', label: 'Lane A', color: '#185FA5',
  order: 0, collapsed: false, height: 200,
  variables: [], resources: [],
}
const DEFAULT_LANE_B: Lane = {
  id: 'lane_b', label: 'Lane B', color: '#993C1D',
  order: 1, collapsed: false, height: 200,
  variables: [], resources: [],
}
const DEFAULT_POOL: Pool = {
  id: 'pool_main', label: 'Main Pool',
  variables: [],
  lanes: [DEFAULT_LANE_A, DEFAULT_LANE_B],
}
// ─── Nodo Error Handler — uno per lane, fisso ─────────────────────
const makeErrorHandler = (laneId: string, errorHandlerId: string): FlowNode<NodeData> => ({
  id: errorHandlerId,
  type: 'errorHandlerNode',
  position: { x: 760, y: 60 },
  data: {
    type: 'error_handler',
    label: 'Error Handler',
    props: {
      defaultOnError: 'stop',
      logAll: 'true',
      rules: '[]',
       outputSchema: JSON.stringify(ERROR_HANDLER_SCHEMA.map((f) => ({ id: f.id, name: f.name, type: f.type, physicalName: f.name }))),
    },
    config: defaultConfig(),
    status: 'idle',
    laneId,
  },
  deletable: false,
})

const DEFAULT_NODES: FlowNode<NodeData>[] = [
  ...makeStartEnd('lane_a', 'start_lane_a', 'end_lane_a'),
  makeErrorHandler('lane_a', 'error_handler_lane_a'),     // ← aggiungere
  ...makeStartEnd('lane_b', 'start_lane_b', 'end_lane_b'),
  makeErrorHandler('lane_b', 'error_handler_lane_b'),     // ← aggiungere
]

// ─── interfaccia store ────────────────────────────────────────────
interface FlowState {
  nodes:              FlowNode<NodeData>[]
  edges:              Edge[]
  selectedNodeId:     string | null
  pool:               Pool
  selectedLaneId:     string | null
  selectedResourceId: string | null
  editingNodeId:      string | null
  logs:               LogEntry[]
  running:            boolean

  // Fase 8 — statistiche runtime dal Rust engine (chiave = node id)
  nodeStats:          Record<string, NodeRunStats>

  irState: IRState
  compileIR:   () => void
  generateCode: () => void

 

  // React Flow
  onNodesChange: (changes: NodeChange[]) => void
  onEdgesChange: (changes: EdgeChange[]) => void
  onConnect:     (connection: Connection) => void

  // Nodi
  addNode:            (type: string, laneId: string, x: number, y: number) => void
  deleteNode:         (id: string) => void
  updateNodeProp:     (id: string, key: string, value: string) => void
  updateNodeConfig:   (id: string, patch: Partial<NodeConfig>) => void
  updateNodeAdvanced: (id: string, key: string, value: string) => void
  addNodeMapping:     (id: string) => void
  updateNodeMapping:  (id: string, mappingId: string, key: keyof NodeMapping, value: string) => void
  deleteNodeMapping:  (id: string, mappingId: string) => void
  setNodeStatus:      (id: string, status: NodeStatus, message?: string) => void
  selectNode:         (id: string | null) => void
  openNodeEditor:     (id: string) => void
  closeNodeEditor:    () => void

  // TMap
  initTMapConfig:        (nodeId: string) => void
  updateTMapInput:       (nodeId: string, inputId: string, patch: Partial<TMapInput>) => void
  addTMapInput:          (nodeId: string, isMain?: boolean) => void
  deleteTMapInput:       (nodeId: string, inputId: string) => void
  addTMapInputField:     (nodeId: string, inputId: string, field: TMapInputField) => void
  updateTMapInputField:  (nodeId: string, inputId: string, fieldName: string, patch: Partial<TMapInputField>) => void
  deleteTMapInputField:  (nodeId: string, inputId: string, fieldName: string) => void
  updateTMapOutput:      (nodeId: string, outputId: string, patch: Partial<TMapOutput>) => void
  addTMapOutput:         (nodeId: string) => void
  deleteTMapOutput:      (nodeId: string, outputId: string) => void
  addTMapOutputField:    (nodeId: string, outputId: string) => void
  updateTMapOutputField: (nodeId: string, outputId: string, fieldId: string, patch: Partial<TMapOutputField>) => void
  deleteTMapOutputField: (nodeId: string, outputId: string, fieldId: string) => void
  setTMapConnections: (nodeId: string, connections: TMapConnection[]) => void

  // TMap transforms
  addTMapTransform:    (nodeId: string, transform: TMapTransformNode) => void
  updateTMapTransform: (nodeId: string, transformId: string, patch: Partial<TMapTransformNode>) => void
  deleteTMapTransform: (nodeId: string, transformId: string) => void
  removeFieldFromTransforms: (nodeId: string, inputId: string, fieldName: string) => void 
  applyTMapRenames: (nodeId: string, renames: FieldRenameEntry[]) => void

  // Lane
  addLane:    () => void
  deleteLane: (id: string) => void
  updateLane: (id: string, patch: Partial<Pick<Lane, 'label' | 'color' | 'collapsed' | 'height'>>) => void
  selectLane: (id: string | null) => void
  moveLane:   (id: string, direction: 'up' | 'down') => void
  

  // Risorse
  addResource:          (laneId: string, resource: Omit<LaneResource, 'id' | 'status'>) => void
  deleteResource:       (laneId: string, resourceId: string) => void
  updateResource:       (laneId: string, resourceId: string, patch: Partial<LaneResource>) => void
  updateResourceConfig: (laneId: string, resourceId: string, key: string, value: string) => void
  setResourceStatus:    (laneId: string, resourceId: string, status: ResourceStatus) => void
  selectResource:       (resourceId: string | null) => void
  testResource:         (laneId: string, resourceId: string) => Promise<void>

  // Variabili
  addVariable:    (scope: 'pool' | 'lane', laneId: string | null, variable: Omit<Variable, 'id' | 'scope'>) => void
  deleteVariable: (scope: 'pool' | 'lane', laneId: string | null, variableId: string) => void
  updateVariable: (scope: 'pool' | 'lane', laneId: string | null, variableId: string, patch: Partial<Variable>) => void
  updateLaneVariable: (laneId: string, varName: string, value: string) => void

  // Pools

  // Pool
  updatePool: (patch: Partial<Pick<Pool, 'label'>>) => void

  // Log
  addLog:    (level: LogEntry['level'], message: string, nodeId?: string, laneId?: string) => void
  clearLogs: () => void

  // Esecuzione
  setRunning:  (v: boolean) => void
  clearCanvas: () => void

  // Fase 8 — statistiche runtime
  setNodeStats:   (id: string, patch: Partial<NodeRunStats>) => void
  resetNodeStats: () => void

  // Interno
  _addLaneStartEnd: (laneId: string) => void 

  _addLaneErrorHandler: (laneId: string) => void
  
}

export interface IRState {
  lastValidation?: {
    valid:     boolean
    issues:    ValidationIssue[]
    timestamp: number
  }
  compiling: boolean
  lastCodegen?: {
    files:     Map<string, string>
    timestamp: number
    warnings:  string[]
  }
  compilationErrors: string[]
}

const defaultIRState: IRState = {
  compiling:         false,
  compilationErrors: [],
}

// ─── Pulisce connessioni orfane ───────────────────────────────────
const cleanTMapConnections = (tmap: TMapConfig): TMapConfig => {
  if (!tmap.connections?.length) return tmap

  const validInputFields = new Set(
    tmap.inputs.flatMap((inp) =>
      inp.fields.map((f) => `${inp.id}__${f.name}`)
    )
  )

  const validOutputFields = new Set(
    tmap.outputs.flatMap((out) =>
      out.fields.map((f) => `${out.id}__${f.id}`)
    )
  )

  const cleaned = tmap.connections.filter((conn) =>
    validInputFields.has(`${conn.inputId}__${conn.fieldName}`) &&
    validOutputFields.has(`${conn.outputId}__${conn.fieldId}`)
  )

  return { ...tmap, connections: cleaned }
}



// ─── store ────────────────────────────────────────────────────────
export const useFlowStore = create<FlowState>((set, get) => ({
  nodes:              DEFAULT_NODES,
  edges:              [],
  selectedNodeId:     null,
  pool:               DEFAULT_POOL,
  selectedLaneId:     null,
  selectedResourceId: null,
  editingNodeId:      null,
  logs:               [],
  running:            false,
  nodeStats:          {},
  irState:            defaultIRState,


  updateLaneVariable: (laneId, varName, value) => {
       set(s => {
         const lane = s.pool.lanes.find(l => l.id === laneId)
         if (!lane) return s
         const existing = lane.variables.find(v => v.name === varName)
         if (existing) {
           return {
             pool: {
               ...s.pool,
               lanes: s.pool.lanes.map(l =>
                 l.id !== laneId ? l : {
                   ...l,
                   variables: l.variables.map(v =>
                     v.name !== varName ? v : { ...v, value }
                   ),
                 }
               ),
             },
           }
         }
         // Crea la variabile se non esiste
         return {
           pool: {
             ...s.pool,
             lanes: s.pool.lanes.map(l =>
               l.id !== laneId ? l : {
                 ...l,
                 variables: [
                   ...l.variables,
                   {
                     id:    `__runtime_${varName}_${Date.now()}`,
                     name:  varName,
                     type:  'object' as const,
                     value,
                     scope: 'lane' as const,
                   },
                 ],
               }
             ),
           },
         }
       })
     },
  // ── IR / Codegen ──────────────────────────────────────────────

  compileIR: () => {
    const { nodes, edges, pool } = get()
    set((s) => ({ irState: { ...s.irState, compiling: true } }))
    try {
      const result = runCompilation(nodes, edges, pool)
      set((s) => ({
        irState: {
          ...s.irState,
          compiling: false,
          compilationErrors: result.valid
            ? []
            : result.schemaIssues
                .filter((i) => i.severity === 'error')
                .map((i) => i.message),
        },
      }))
    } catch (e) {
      set((s) => ({
        irState: {
          ...s.irState,
          compiling: false,
          compilationErrors: [`Errore di compilazione: ${e}`],
        },
      }))
    }
  },

  generateCode: () => {
    const { nodes, edges, pool } = get()
    set((s) => ({ irState: { ...s.irState, compiling: true } }))
    try {
      const result = runCodegen(nodes, edges, pool)
      set((s) => ({
        irState: {
          ...s.irState,
          compiling: false,
          compilationErrors: [],
          lastCodegen: {
            files:     result.output.files,
            timestamp: Date.now(),
            warnings:  result.output.warnings,
          },
        },
      }))
    } catch (e) {
      set((s) => ({
        irState: {
          ...s.irState,
          compiling: false,
          compilationErrors: [`Errore codegen: ${e}`],
        },
      }))
    }
  },

  // ── React Flow ──
  onNodesChange: (changes) =>
    set((s) => ({
      nodes: applyNodeChanges(changes, s.nodes) as FlowNode<NodeData>[],
    })),

  onEdgesChange: (changes) =>
    set((s) => ({ edges: applyEdgeChanges(changes, s.edges) })),

  onConnect: (connection) => {
      const { nodes } = get()
      const src = nodes.find((n) => n.id === connection.source)
      const tgt = nodes.find((n) => n.id === connection.target)

      if (!src || !tgt) return
      if (src.data.laneId !== tgt.data.laneId) {
        get().addLog('warn', 'Connessioni cross-lane non permesse.')
        return
      }
      const normalizedConnection = {
        ...connection,
        sourceHandle: connection.sourceHandle ?? 'output',
      }
      set((s) => ({ edges: addEdge(normalizedConnection, s.edges) }))
  },


  // ── Nodi ──
  addNode: (type, laneId, x, y) => {
    const def = NODE_DEFS[type]
    if (!def) return
    const id = uid()
    const props: Record<string, string> = {}
    def.fields.forEach((f) => { props[f.key] = f.default })

    const rfType =  type === 'tmap'        ? 'tmapNode'       :
                    type === 'json_parser' ? 'jsonParserNode' :
                    type === 'xml_parser'  ? 'xmlParserNode'  :
                    type === 'filter'      ? 'filterNode'     :
                    type === 'union'       ? 'union'          :
                    type === 'join'        ? 'joinNode'       :
                    type === 'json_serializer'  ? 'jsonSerializerNode'  :
                    type === 'xml_serializer' ? 'xmlSerializerNode' :
                    type === 'sequencer'        ? 'sequencerNode'        :
                    type === 'error_handler'    ? 'errorHandlerNode'     :  // ← aggiungere
               'flowNode'

    const baseConfig = { ...defaultConfig(), displayName: def.label }
    if (type === 'tmap') {
    baseConfig.tmap = {
        inputs: [
          { id: 'input_main', label: 'main', isMain: true, joinType: 'none' as const, fields: [] },
        ],
        outputs: [
          { id: 'output_main',     label: 'main_out', color: '#3ddc84', filter: '', fields: [] },
          { id: 'output_rejected', label: 'rejected',  color: '#ff5f57', filter: '', fields: [] },
        ],
        connections: [],   // ← aggiunto
      } as TMapConfig
    }

    const node: FlowNode<NodeData> = {
      id,
      type: rfType,
      position: { x, y },
      data: {
        type, label: def.label,
        props,
        config: baseConfig,
        status: 'idle',
        laneId,
      },
    }
    set((s) => ({ nodes: [...s.nodes, node] }))
    get().addLog('info', `Aggiunto ${def.label}`, id, laneId)
  },

  deleteNode: (id) => {
    const node = get().nodes.find((n) => n.id === id)
    if (node?.data.type === 'error_handler') {
      get().addLog('warn', 'Il nodo Error Handler non può essere eliminato.', id, node.data.laneId)
      return
    }
    set((s) => ({
      nodes: s.nodes.filter((n) => n.id !== id),
      edges: s.edges.filter((e) => e.source !== id && e.target !== id),
      selectedNodeId: s.selectedNodeId === id ? null : s.selectedNodeId,
      editingNodeId:  s.editingNodeId  === id ? null : s.editingNodeId,
    }))
  },

  updateNodeProp: (id, key, value) => {
    set((s) => ({
      nodes: updateNode(s.nodes, id, (n) => ({
        ...n,
        data: { ...n.data, props: { ...n.data.props, [key]: value } },
      })),
    }))
    // Propagazione automatica a cascata quando outputSchema cambia
   if (key === 'outputSchema' && value && value !== '[]') {
      setTimeout(() => {
        const store = useFlowStore.getState()
        const node  = store.nodes.find((n) => n.id === id)
        if (!node) return
        const handles = getNodeHandles(node).outputs
        const handleId = handles[0] ?? 'output'
        propagateHandle(id, handleId, store)
      }, 0)
    }
    // Propagazione automatica per edge da JSON/XML parser
    // Scatta su qualsiasi cambio di prop — copre anche il caso del primo collegamento
    const currentNode = useFlowStore.getState().nodes.find((n) => n.id === id)
    const isParser = currentNode?.data.type === 'json_parser'
                  || currentNode?.data.type === 'xml_parser'
    if (isParser) {
      setTimeout(() => {
        const store = useFlowStore.getState()
        const node  = store.nodes.find((n) => n.id === id)
        if (!node) return
        const parserKey = node.data.type === 'json_parser' ? 'jsonParser'
                        : node.data.type === 'xml_parser'  ? 'xmlParser'
                        : null
        if (!parserKey) return
        const config = node.data.config?.[parserKey] as any
        if (!config?.flows) return
        config.flows.forEach((flow: any) => {
          if (!flow.fields?.length) return
          const schema = flow.fields.map((f: any) => ({
            id: f.id, name: f.name, type: f.type, physicalName: f.name,
          }))
          store.edges
            .filter((e) => e.source === id && e.sourceHandle === flow.id)
            .forEach((edge) => {
              const tgtNode = store.nodes.find((n) => n.id === edge.target)
              if (!tgtNode) return
              if (tgtNode.data.type === 'tmap') {
                const tmap = tgtNode.data.config?.tmap as TMapConfig | undefined
                if (!tmap) return
                const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
                if (!input) return
                const existingNames = new Set(
                  input.fields.filter((f) => !f.name.startsWith('status.')).map((f) => f.name)
                )
                const merged = [
                  ...input.fields,
                  ...schema.filter((s: any) => !existingNames.has(s.name))
                    .map((s: any) => ({ id: s.id, name: s.name, type: s.type as any, physicalName: s.name })),
                ]
                store.updateTMapInput(tgtNode.id, input.id, { fields: merged })
              } else {
                store.updateNodeProp(tgtNode.id, 'incomingSchema', JSON.stringify(schema))
              }
            })
        })
      }, 0)
    }
  },

  updateNodeConfig: (id, patch) => {
    set((s) => {
      // Aggiorna il nodo
      const updatedNodes = updateNode(s.nodes, id, (n) => ({
        ...n,
        data: {
          ...n.data,
          config: { ...n.data.config, ...patch },
          label: patch.shortLabel ?? patch.displayName ?? n.data.label,
        },
      }))

      // ── Propagazione schema json_parser → nodi a valle ─────────
      // Ogni volta che la config del json_parser cambia,
      // propaga lo schema di ogni flusso sugli edge con sourceHandle === flow.id
      const srcNode = s.nodes.find((n) => n.id === id)
      if (srcNode?.data.type === 'json_parser' && (patch as any).jsonParser) {
        const jpConfig = (patch as any).jsonParser as {
          flows: Array<{ id: string; fields: Array<{ id: string; name: string; type: string }> }>
        }

        // Rimuovi edge orfani — handle non più esistenti nei nuovi flussi
        const newFlowIds = new Set((patch as any).jsonParser.flows?.map((f: any) => f.id) ?? [])
        const orphanEdges = s.edges.filter(
          (e) => e.source === id && !newFlowIds.has(e.sourceHandle ?? '')
            && e.sourceHandle !== 'reject'
            && e.sourceHandle !== 'output'
        )
        if (orphanEdges.length > 0) {
          useFlowStore.setState((s2) => ({
            edges: s2.edges.filter((e) => !orphanEdges.some((o) => o.id === e.id))
          }))
        }
        setTimeout(() => {
          const store = useFlowStore.getState()
          jpConfig.flows?.forEach((flow) => {
            if (!flow.fields?.length) return
            const schema = flow.fields.map((f) => ({
              id: f.id, name: f.name, type: f.type, physicalName: f.name,
            }))
            const outEdges = store.edges.filter(
              (e) => e.source === id && e.sourceHandle === flow.id
            )
            outEdges.forEach((edge) => {
              const tgtNode = store.nodes.find((n) => n.id === edge.target)
              if (!tgtNode) return
              if (tgtNode.data.type === 'tmap') {
                const tmap = tgtNode.data.config?.tmap as TMapConfig | undefined
                if (!tmap) return
                const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
                if (!input) return
                const existingNames = new Set(
                  input.fields.filter((f) => !f.name.startsWith('status.')).map((f) => f.name)
                )
                const merged = [
                  ...input.fields.map((f) => {
                    const inc = schema.find((s) => s.name === f.name)
                    return inc ? { ...f, type: inc.type as any } : f
                  }),
                  ...schema
                    .filter((s) => !existingNames.has(s.name))
                    .map((s) => ({ id: s.id, name: s.name, type: s.type as any, physicalName: s.name })),
                ]
                store.updateTMapInput(tgtNode.id, input.id, { fields: merged })
              } else {
                store.updateNodeProp(tgtNode.id, 'outputSchema', JSON.stringify(schema))
              }
            })
          })
        }, 0)
      }
      // Se cambia displayName o shortLabel, propaga ai TMap collegati
      if (patch.displayName !== undefined || patch.shortLabel !== undefined) {
        const srcNode   = s.nodes.find((n) => n.id === id)
        const newLabel  = patch.shortLabel || patch.displayName || srcNode?.data.label || id
        const outEdges  = s.edges.filter((e) => e.source === id)

        outEdges.forEach((edge) => {
          const tgt  = updatedNodes.find((n) => n.id === edge.target)
          if (!tgt || tgt.data.type !== 'tmap') return
          const tmap = tgt.data.config?.tmap as TMapConfig | undefined
          if (!tmap) return
          const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
          if (!input) return

          const oldLabel = input.label

          // Aggiorna label dell'input
          const updatedInputs = tmap.inputs.map((inp) =>
            inp.id === edge.targetHandle ? { ...inp, label: newLabel } : inp
          )

          // Aggiorna variabili nei transforms ($oldLabel.campo → $newLabel.campo)
          const updatedTransforms = (tmap.transforms ?? []).map((tr) => {
            let newExpression = tr.expression
            tr.inputs.forEach((ti) => {
              if (ti.inputId !== edge.targetHandle) return
              const oldVar = `$${oldLabel}.${ti.fieldName}`
              const newVar = `$${newLabel}.${ti.fieldName}`
              newExpression = newExpression.split(oldVar).join(newVar)
            })
            return { ...tr, expression: newExpression }
          })

          // Aggiorna expression dei campi di output (oldLabel.campo → newLabel.campo)
          const updatedOutputs = tmap.outputs.map((out) => ({
            ...out,
            fields: out.fields.map((f) => {
              if (!f.expression) return f
              const updated = f.expression
                .split(`${oldLabel}.`).join(`${newLabel}.`)
              return updated !== f.expression ? { ...f, expression: updated } : f
            }),
          }))

          // Applica al nodo TMap
          const tmapNodeIdx = updatedNodes.findIndex((n) => n.id === edge.target)
          if (tmapNodeIdx === -1) return
          updatedNodes[tmapNodeIdx] = {
            ...updatedNodes[tmapNodeIdx],
            data: {
              ...updatedNodes[tmapNodeIdx].data,
              config: {
                ...updatedNodes[tmapNodeIdx].data.config,
                tmap: { ...tmap, inputs: updatedInputs, transforms: updatedTransforms, outputs: updatedOutputs },
              },
            },
          }
        })
      }

      return { nodes: updatedNodes }
    })
  },

  updateNodeAdvanced: (id, key, value) => {
    set((s) => ({
      nodes: updateNode(s.nodes, id, (n) => ({
        ...n,
        data: {
          ...n.data,
          config: {
            ...n.data.config,
            advanced: { ...n.data.config.advanced, [key]: value } as NodeConfig['advanced'],
          },
        },
      })),
    }))
  },

  addNodeMapping: (id) => {
    const newMapping: NodeMapping = {
      id: mapUid(), sourceField: '', targetField: '', transform: '',
    }
    set((s) => ({
      nodes: updateNode(s.nodes, id, (n) => ({
        ...n,
        data: {
          ...n.data,
          config: {
            ...n.data.config,
            mappings: [...(n.data.config.mappings ?? []), newMapping],
          },
        },
      })),
    }))
  },

  updateNodeMapping: (id, mappingId, key, value) => {
    set((s) => ({
      nodes: updateNode(s.nodes, id, (n) => ({
        ...n,
        data: {
          ...n.data,
          config: {
            ...n.data.config,
            mappings: (n.data.config.mappings ?? []).map((m) =>
              m.id === mappingId ? { ...m, [key]: value } : m
            ),
          },
        },
      })),
    }))
  },

  deleteNodeMapping: (id, mappingId) => {
    set((s) => ({
      nodes: updateNode(s.nodes, id, (n) => ({
        ...n,
        data: {
          ...n.data,
          config: {
            ...n.data.config,
            mappings: (n.data.config.mappings ?? []).filter((m) => m.id !== mappingId),
          },
        },
      })),
    }))
  },

  setNodeStatus: (id, status, message) => {
    set((s) => ({
      nodes: updateNode(s.nodes, id, (n) => ({
        ...n,
        data: { ...n.data, status, statusMessage: message },
      })),
    }))
  },

  selectNode: (id) => set({ selectedNodeId: id }),
  openNodeEditor:  (id) => set({ editingNodeId: id }),
  closeNodeEditor: ()  => set({ editingNodeId: null }),

  // ── TMap ──
  initTMapConfig: (nodeId) => {
    const node = get().nodes.find((n) => n.id === nodeId)
    if (!node) return
    if (node.data.config.tmap) return

    const tmapDefault: TMapConfig = {
      inputs: [
        { id: 'input_main', label: 'main', isMain: true, joinType: 'none', fields: [] },
      ],
      outputs: [
        { id: 'output_main',     label: 'main_out', color: '#3ddc84', filter: '', fields: [] },
        { id: 'output_rejected', label: 'rejected',  color: '#ff5f57', filter: '', fields: [] },
      ],
      connections: [],   // ← aggiunto
    }
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => ({
        ...n,
        data: { ...n.data, config: { ...n.data.config, tmap: tmapDefault } },
      })),
    }))
  },

  updateTMapInput: (nodeId, inputId, patch) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: {
                ...tmap,
                inputs: tmap.inputs.map((inp) =>
                  inp.id === inputId ? { ...inp, ...patch } : inp
                ),
              },
            },
          },
        }
      }),
    }))
  },

  addTMapInput: (nodeId, isMain = false) => {
    const newInput: TMapInput = {
      id: `input_${Date.now()}`,
      label: isMain ? 'main' : `lookup_${Date.now().toString().slice(-4)}`,
      isMain,
      joinType: isMain ? 'none' : 'left',
      joinKey: '',
      sourceJoinKey: '',
      fields: [],
    }
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: { ...tmap, inputs: [...tmap.inputs, newInput] },
            },
          },
        }
      }),
    }))
  },

  deleteTMapInput: (nodeId, inputId) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n

        // Rimuove l'input
        const filteredInputs = tmap.inputs.filter((inp) => inp.id !== inputId)

        // Pulisce le joinPairs orfane negli input rimanenti:
        // - pairs dove srcInputId === inputId (questo input era la sorgente)
        // - pairs dove dstInputId === inputId (questo input era la destinazione)
        //   → le pairs vivono NELL'input destinatario, quindi se l'input
        //     destinatario è stato eliminato, le sue pairs spariscono con lui.
        //     Dobbiamo pulire solo le pairs negli input RIMANENTI che
        //     referenziano inputId come srcInputId.
        const cleanedInputs = filteredInputs.map((inp) => {
          const pairs = (inp as any).joinPairs as Array<{ srcInputId: string }> | undefined
          if (!pairs?.length) return inp
          const filteredPairs = pairs.filter((p) => p.srcInputId !== inputId)
          if (filteredPairs.length === pairs.length) return inp  // nessuna modifica
          return { ...inp, joinPairs: filteredPairs }
        })

        const updated = {
          ...tmap,
          inputs: cleanedInputs,
        }
        return {
          ...n,
          data: {
            ...n.data,
            config: { ...n.data.config, tmap: cleanTMapConnections(updated) },
          },
        }
      }),
    }))
  },

  addTMapInputField: (nodeId, inputId, field) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: {
                ...tmap,
                inputs: tmap.inputs.map((inp) =>
                  inp.id === inputId
                    ? { ...inp, fields: [...inp.fields, field] }
                    : inp
                ),
              },
            },
          },
        }
      }),
    }))
  },

  updateTMapInputField: (nodeId, inputId, fieldName, patch) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        const updated = {
          ...tmap,
          inputs: tmap.inputs.map((inp) =>
            inp.id === inputId
              ? {
                  ...inp,
                  fields: inp.fields.map((f) =>
                    f.name === fieldName ? { ...f, ...patch } : f
                  ),
                }
              : inp
          ),
        }
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: cleanTMapConnections(updated),
            },
          },
        }
      }),
    }))
  },

  deleteTMapInputField: (nodeId, inputId, fieldName) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        const updated = {
          ...tmap,
          inputs: tmap.inputs.map((inp) =>
            inp.id === inputId
              ? { ...inp, fields: inp.fields.filter((f) => f.name !== fieldName) }
              : inp
          ),
        }
        return {
          ...n,
          data: {
            ...n.data,
            config: { ...n.data.config, tmap: cleanTMapConnections(updated) },
          },
        }
      }),
    }))
  },

  addTMapOutput: (nodeId) => {
    const colors = ['#4a9eff', '#ffb347', '#a78bfa', '#22d3ee']
    const newOutput: TMapOutput = {
      id: `output_${Date.now()}`,
      label: `out_${Date.now().toString().slice(-4)}`,
      color: colors[Math.floor(Math.random() * colors.length)],
      filter: '',
      fields: [],
    }
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: { ...tmap, outputs: [...tmap.outputs, newOutput] },
            },
          },
        }
      }),
    }))
  },

  deleteTMapOutput: (nodeId, outputId) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        const updated = {
          ...tmap,
          outputs: tmap.outputs.filter((o) => o.id !== outputId),
        }
        return {
          ...n,
          data: {
            ...n.data,
            config: { ...n.data.config, tmap: cleanTMapConnections(updated) },
          },
        }
      }),
    }))
  },

  updateTMapOutput: (nodeId, outputId, patch) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: {
                ...tmap,
                outputs: tmap.outputs.map((o) =>
                  o.id === outputId ? { ...o, ...patch } : o
                ),
              },
            },
          },
        }
      }),
    }))
  },

  addTMapOutputField: (nodeId, outputId) => {
    const newField: TMapOutputField = {
      id: `field_${Date.now()}`,
      name: '',
      type: 'string',
      expression: '',
    }
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: {
                ...tmap,
                outputs: tmap.outputs.map((o) =>
                  o.id === outputId
                    ? { ...o, fields: [...o.fields, newField] }
                    : o
                ),
              },
            },
          },
        }
      }),
    }))
    // Propaga schema ai nodi a valle
    setTimeout(() => {
      propagateHandle(nodeId, outputId, useFlowStore.getState())
    }, 0)
  },

  updateTMapOutputField: (nodeId, outputId, fieldId, patch) => {

      // Propaga schema ai nodi collegati a questo output — delegato
    // al registro centralizzato (gestisce id stabili, merge non
    // distruttivo sui target TMap, terminatori, join, passthrough)
    
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        const updated = {
          ...tmap,
          outputs: tmap.outputs.map((o) =>
            o.id === outputId
              ? {
                  ...o,
                  fields: o.fields.map((f) =>
                    f.id === fieldId ? { ...f, ...patch } : f
                  ),
                }
              : o
          ),
        }


        return {
          ...n,
          data: {
            ...n.data,
            config: { ...n.data.config, tmap: updated },
          },
        }
      }),
    }))
    setTimeout(() => {
      propagateHandle(nodeId, outputId, useFlowStore.getState())
    }, 0)
  },

  deleteTMapOutputField: (nodeId, outputId, fieldId) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        const updated = {
          ...tmap,
          outputs: tmap.outputs.map((o) =>
            o.id === outputId
              ? { ...o, fields: o.fields.filter((f) => f.id !== fieldId) }
              : o
          ),
        }
        return {
          ...n,
          data: {
            ...n.data,
            config: { ...n.data.config, tmap: cleanTMapConnections(updated) },
          },
        }
      }),
    }))
  },

  

  setTMapConnections: (nodeId, connections) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: { ...tmap, connections },
            },
          },
        }
      }),
    }))
  },

  addTMapTransform: (nodeId, transform) => {
    const withDefaults: TMapTransformNode = {
      ...transform,
      mode: transform.mode ?? 'inline',
    }
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: {
                ...tmap,
                transforms: [...(tmap.transforms ?? []), withDefaults],
              },
            },
          },
        }
      }),
    }))
  },

  updateTMapTransform: (nodeId, transformId, patch) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: {
                ...tmap,
                transforms: (tmap.transforms ?? []).map((t) =>
                  t.id === transformId ? { ...t, ...patch } : t
                ),
              },
            },
          },
        }
      }),
    }))
  },

  deleteTMapTransform: (nodeId, transformId) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap) return n
        return {
          ...n,
          data: {
            ...n.data,
            config: {
              ...n.data.config,
              tmap: {
                ...tmap,
                transforms: (tmap.transforms ?? []).filter((t) => t.id !== transformId),
              },
            },
          },
        }
      }),
    }))
  },


  removeFieldFromTransforms: (nodeId, inputId, fieldName) => {
    set((s) => ({
      nodes: updateNode(s.nodes, nodeId, (n) => {
        const tmap = n.data.config.tmap as TMapConfig | undefined
        if (!tmap?.transforms?.length) return n
        const updatedTransforms = removeFieldFromTransformsFn(
          tmap.transforms, inputId, fieldName, tmap
        )
        return {
          ...n,
          data: {
            ...n.data,
            config: { ...n.data.config, tmap: { ...tmap, transforms: updatedTransforms } },
          },
        }
      }),
    }))
  },
  applyTMapRenames: (nodeId: string, renames: FieldRenameEntry[]) => {
  set((s) => ({
    nodes: updateNode(s.nodes, nodeId, (n) => {
      const tmap = n.data.config.tmap as TMapConfig | undefined
      if (!tmap?.transforms?.length || !renames.length) return n
      const updatedTransforms = applyRenameMap(tmap.transforms, renames, tmap)
      return {
        ...n,
        data: {
          ...n.data,
          config: { ...n.data.config, tmap: { ...tmap, transforms: updatedTransforms } },
        },
      }
    }),
  }))
},
  // ── Lane ──
  addLane: () => {
    const { pool } = get()
    const laneId = laneUid()
    const newLane: Lane = {
      id: laneId,
      label: `Lane ${pool.lanes.length + 1}`,
      color: '#3B6D11',
      order: pool.lanes.length,
      collapsed: false,
      height: 200,
      variables: [],
      resources: [],
    }
    set((s) => ({ pool: { ...s.pool, lanes: [...s.pool.lanes, newLane] } }))
    setTimeout(() => {
      get()._addLaneStartEnd(laneId)
      get()._addLaneErrorHandler(laneId)          // ← aggiungere
      get().addLog('info', `Lane "${newLane.label}" aggiunta.`)
    }, 0)
  },

  deleteLane: (id) => {
    set((s) => ({
      nodes: s.nodes.filter((n) => n.data.laneId !== id),
      edges: s.edges.filter((e) => {
        const src = s.nodes.find((n) => n.id === e.source)
        const tgt = s.nodes.find((n) => n.id === e.target)
        return src?.data.laneId !== id && tgt?.data.laneId !== id
      }),
      pool: {
        ...s.pool,
        lanes: s.pool.lanes
          .filter((l) => l.id !== id)
          .map((l, i) => ({ ...l, order: i })),
      },
      selectedLaneId:     s.selectedLaneId     === id ? null : s.selectedLaneId,
      selectedResourceId: null,
    }))
    get().addLog('warn', 'Lane eliminata.')
  },

  updateLane: (id, patch) => {
    set((s) => ({
      pool: {
        ...s.pool,
        lanes: s.pool.lanes.map((l) => l.id === id ? { ...l, ...patch } : l),
      },
    }))
  },

  selectLane: (id) => set({ selectedLaneId: id, selectedResourceId: null }),

  moveLane: (id, direction) => {
    set((s) => {
      const lanes   = [...s.pool.lanes].sort((a, b) => a.order - b.order)
      const idx     = lanes.findIndex((l) => l.id === id)
      const swapIdx = direction === 'up' ? idx - 1 : idx + 1
      if (swapIdx < 0 || swapIdx >= lanes.length) return s
      const reordered = [...lanes]
      ;[reordered[idx], reordered[swapIdx]] = [reordered[swapIdx], reordered[idx]]
      return {
        pool: {
          ...s.pool,
          lanes: reordered.map((l, i) => ({ ...l, order: i })),
        },
      }
    })
  },

  // ── Risorse ──
  addResource: (laneId, resource) => {
    const full: LaneResource = { ...resource, id: resUid(), status: 'untested' }
    set((s) => ({
      pool: {
        ...s.pool,
        lanes: s.pool.lanes.map((l) =>
          l.id === laneId ? { ...l, resources: [...l.resources, full] } : l
        ),
      },
    }))
    get().addLog('info', `Risorsa "${full.label}" aggiunta.`, undefined, laneId)
  },

  deleteResource: (laneId, resourceId) => {
    set((s) => ({
      pool: {
        ...s.pool,
        lanes: s.pool.lanes.map((l) =>
          l.id === laneId
            ? { ...l, resources: l.resources.filter((r) => r.id !== resourceId) }
            : l
        ),
      },
      selectedResourceId: s.selectedResourceId === resourceId ? null : s.selectedResourceId,
    }))
  },

  updateResource: (laneId, resourceId, patch) => {
    set((s) => ({
      pool: {
        ...s.pool,
        lanes: s.pool.lanes.map((l) =>
          l.id === laneId
            ? { ...l, resources: l.resources.map((r) => r.id === resourceId ? { ...r, ...patch } : r) }
            : l
        ),
      },
    }))
  },

  updateResourceConfig: (laneId, resourceId, key, value) => {
    set((s) => ({
      pool: {
        ...s.pool,
        lanes: s.pool.lanes.map((l) =>
          l.id === laneId
            ? {
                ...l,
                resources: l.resources.map((r) =>
                  r.id === resourceId
                    ? { ...r, status: 'untested' as ResourceStatus, config: { ...r.config, [key]: value } }
                    : r
                ),
              }
            : l
        ),
      },
    }))
  },

  setResourceStatus: (laneId, resourceId, status) => {
    set((s) => ({
      pool: {
        ...s.pool,
        lanes: s.pool.lanes.map((l) =>
          l.id === laneId
            ? { ...l, resources: l.resources.map((r) => r.id === resourceId ? { ...r, status } : r) }
            : l
        ),
      },
    }))
  },

  selectResource: (resourceId) => set({ selectedResourceId: resourceId }),

  testResource: async (laneId, resourceId) => {
    const { setResourceStatus, addLog } = get()
    const lane = get().pool.lanes.find((l) => l.id === laneId)
    const res  = lane?.resources.find((r) => r.id === resourceId)
    if (!res) return

    setResourceStatus(laneId, resourceId, 'testing')
    addLog('info', `Test connessione "${res.label}"…`, undefined, laneId)

    // FTP/SFTP — usa ftpClient invece di invoke direttamente
    if (res.kind === 'ftp') {
      setResourceStatus(laneId, resourceId, 'testing')
      addLog('info', `Test connessione "${res.label}"…`, undefined, laneId)
      try {
        const { ftpTest, buildFtpConnection } = await import('../lib/ftpClient')
        const result = await ftpTest(buildFtpConnection(res))
        if (result.ok) {
          setResourceStatus(laneId, resourceId, 'ok')
          addLog('ok', `"${res.label}" — ${result.message} (${result.elapsed_ms}ms)`, undefined, laneId)
        } else {
          setResourceStatus(laneId, resourceId, 'error')
          addLog('error', `"${res.label}" — ${result.message}`, undefined, laneId)
        }
      } catch (err) {
        setResourceStatus(laneId, resourceId, 'error')
        addLog('error', `"${res.label}" — ${err instanceof Error ? err.message : String(err)}`, undefined, laneId)
      }
      return
    }

    try {
      const { invoke } = await import('@tauri-apps/api/core')
      const cfg = res.config ?? {}

      // Query probe minima per dialetto
      const dialect = cfg.dialect ?? cfg.driver ?? 'postgresql'
      const probeQuery = dialect === 'oracle'   ? 'SELECT 1 FROM DUAL'
                       : dialect === 'informix' ? 'SELECT 1 FROM systables WHERE tabid=1'
                       : 'SELECT 1'

      // Porta default per dialetto
      const defaultPort: Record<string, string> = {
        postgresql: '5432', mysql: '3306', sqlite: '0',
        oracle: '1521', informix: '9088',
      }

      const connection = {
        dialect:        dialect,
        host:           cfg.host           ?? 'localhost',
        port:           parseInt(cfg.port  ?? defaultPort[dialect] ?? '5432', 10),
        database:       cfg.database       ?? '',
        user:           cfg.user ?? cfg.username ?? '',
        password:       cfg.password       ?? '',
        schema:         cfg.schema,
        serviceName:    cfg.serviceName,
        dbServerName:   cfg.dbServerName,
        charset:        cfg.charset,
        ssl:            cfg.ssl            ?? 'false',
        connectTimeout: parseInt(cfg.connectTimeout ?? cfg.timeoutSec ?? '10', 10),
      }

      await invoke('db_query', {
        request: { connection, query: probeQuery, timeout: 10 },
      })

      setResourceStatus(laneId, resourceId, 'ok')
      addLog('ok', `"${res.label}" — connessione riuscita (${dialect})`, undefined, laneId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      setResourceStatus(laneId, resourceId, 'error')
      addLog('error', `"${res.label}" — ${msg}`, undefined, laneId)
    }
  },

  // ── Variabili ──
  addVariable: (scope, laneId, variable) => {
    const full: Variable = { ...variable, id: varUid(), scope }
    if (scope === 'pool') {
      set((s) => ({ pool: { ...s.pool, variables: [...s.pool.variables, full] } }))
    } else if (laneId) {
      set((s) => ({
        pool: {
          ...s.pool,
          lanes: s.pool.lanes.map((l) =>
            l.id === laneId ? { ...l, variables: [...l.variables, full] } : l
          ),
        },
      }))
    }
  },

  deleteVariable: (scope, laneId, variableId) => {
    if (scope === 'pool') {
      set((s) => ({
        pool: { ...s.pool, variables: s.pool.variables.filter((v) => v.id !== variableId) },
      }))
    } else if (laneId) {
      set((s) => ({
        pool: {
          ...s.pool,
          lanes: s.pool.lanes.map((l) =>
            l.id === laneId
              ? { ...l, variables: l.variables.filter((v) => v.id !== variableId) }
              : l
          ),
        },
      }))
    }
  },

  updateVariable: (scope, laneId, variableId, patch) => {
    if (scope === 'pool') {
      set((s) => ({
        pool: {
          ...s.pool,
          variables: s.pool.variables.map((v) =>
            v.id === variableId ? { ...v, ...patch } : v
          ),
        },
      }))
    } else if (laneId) {
      set((s) => ({
        pool: {
          ...s.pool,
          lanes: s.pool.lanes.map((l) =>
            l.id === laneId
              ? { ...l, variables: l.variables.map((v) => v.id === variableId ? { ...v, ...patch } : v) }
              : l
          ),
        },
      }))
    }
  },

  // ── Pool ──
  updatePool: (patch) => set((s) => ({ pool: { ...s.pool, ...patch } })),

  // ── Log ──
  addLog: (level, message, nodeId, laneId) => {
    const entry: LogEntry = { id: logId(), timestamp: new Date(), level, message, nodeId, laneId }
    set((s) => ({ logs: [...s.logs.slice(-200), entry] }))
  },

  clearLogs: () => set({ logs: [] }),

  // ── Esecuzione ──
  setRunning: (v) => set({ running: v }),

  // ── Fase 8: statistiche runtime nodi ──────────────────────────
  // Patch parziale con merge: la entry viene creata al primo evento
  // e aggiornata in modo incrementale dal polling di Toolbar.tsx.
  // Viene sostituita SOLO la entry del nodo interessato, così i
  // FlowNode memo-izzati degli altri nodi non ri-renderizzano.
  setNodeStats: (id, patch) =>
    set((s) => {
      const prev: NodeRunStats =
        s.nodeStats[id] ?? { status: 'idle', rowsIn: 0, rowsOut: 0 }
      return {
        nodeStats: {
          ...s.nodeStats,
          [id]: { ...prev, ...patch },
        },
      }
    }),

  // Da chiamare all'avvio di ogni run, prima di lanciare il piano Rust
  resetNodeStats: () => set({ nodeStats: {} }),

  clearCanvas: () => {
    set({ nodes: DEFAULT_NODES, edges: [], selectedNodeId: null, editingNodeId: null, selectedResourceId: null, nodeStats: {} })
    get().addLog('info', 'Canvas pulito.')
  },

  // ── Interno ──
  _addLaneStartEnd: (laneId) => {
    const newNodes = makeStartEnd(laneId, uid(), uid())
    set((s) => ({ nodes: [...s.nodes, ...newNodes] }))
  },
  _addLaneErrorHandler: (laneId) => {
    const errorHandlerId = `error_handler_${laneId}`
    set((s) => ({ nodes: [...s.nodes, makeErrorHandler(laneId, errorHandlerId)] }))
  },
}))