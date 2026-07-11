import { useCallback, useEffect, useMemo, useState, useRef } from 'react'
import { createPortal } from 'react-dom'
import { HTTP_DEFAULTS } from '../nodes/resourceDefaults'
import { DB_DEFAULTS } from '../nodes/resourceDefaults'
import { JsonParserNode } from '../nodes/JsonParserNode'
import { XmlParserNode } from '../nodes/XmlParserNode'
import { FilterNode } from '../nodes/FilterNode'
import { JsonSerializerNode } from '../nodes/JsonSerializerNode'
import { XmlSerializerNode } from '../nodes/XmlSerializerNode'
import { propagateUnionSchema, type SchemaField } from '../utils/schemaUtils'
import { propagateFromConnection, getHandleSchema } from '../utils/schemaRegistry'
import { JoinNode } from '../nodes/types/join/JoinNode'
import { UnionNode } from '../nodes/types/union/UnionNode'
import { flushSync } from 'react-dom'
import { WebhookReceiverNode, WebhookResponderNode, WatchdogNode } from '../nodes/WebhookNode'

import { ErrorHandlerNode } from '../nodes/ErrorHandlerNode'

import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  applyNodeChanges,
  applyEdgeChanges,
  addEdge,
  type NodeMouseHandler,
  type NodeChange,
  type EdgeChange,
  type Connection,
  type Node as FlowNode_,
  type Edge,
} from '@xyflow/react'
import { useFlowStore, updateNode } from '../store/flowStore'
import { FlowNode } from '../nodes/FlowNode'
import { StartNode, EndNode } from '../nodes/StartEndNode'
import { dragState } from '../dragState'
import type { Lane, LaneResource, NodeData, ResourceKind , TMapConfig, TMapInput } from '../types'
import { TMapNode } from '../nodes/TMapNode'
import '@xyflow/react/dist/style.css'
import { BridgeOutNode, BridgeInNode } from '../nodes/BridgeNode'
import {
         resolveConnection,
         isConnectionValid,
        buildEdge,
       } from '../ir/connectionResolver'

// ─── Schema campo _catch ──────────────────────────────────────────
// Campo singolo di tipo object — stesso pattern di status.*
// I sottocampi sono documentati nel mapping panel e in TabAdvanced
const CATCH_FIELD = {
  id:          'catch_obj',
  name:        '_catch',
  type:        'object',
  physicalName: '_catch',
  description: 'Eccezione catturata — contiene message, code, node_id, node_type, at',
}

const nodeTypes = {
  flowNode:  FlowNode,
  filterNode: FilterNode,
  startNode: StartNode,
  endNode:   EndNode,
  tmapNode:  TMapNode,
  joinNode: JoinNode,
  jsonParserNode: JsonParserNode,
  xmlParserNode: XmlParserNode,
  bridgeOutNode:  BridgeOutNode,
  bridgeInNode:   BridgeInNode,
  jsonSerializerNode: JsonSerializerNode,
  xmlSerializerNode: XmlSerializerNode,
  union: UnionNode,
  webhookReceiverNode:  WebhookReceiverNode,
  webhookResponderNode: WebhookResponderNode,
  watchdogNode:         WatchdogNode,

  errorHandlerNode: ErrorHandlerNode,   // ← aggiungere
}

const RESOURCE_ICONS: Record<string, string> = {
  db:    'ti-database',
  http:  'ti-api',
  kafka: 'ti-topology-star',
  file:  'ti-file',
  mqtt:  'ti-antenna',
  ftp:   'ti-server',
  webhook: 'ti-webhook',
}

// ─── Hook posizione dropdown via portal ───────────────────────────
function useDropdownPosition(
  triggerRef: React.RefObject<HTMLElement | null>,
  open: boolean
) {
  const [pos, setPos] = useState({ top: 0, left: 0 })
  useEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setPos({ top: r.bottom + window.scrollY + 4, left: r.left + window.scrollX })
  }, [open, triggerRef])
  return pos
}

// ─── Resource chip ────────────────────────────────────────────────
function ResourceChip({ resource, laneId }: { resource: LaneResource; laneId: string }) {
  const selectResource = useFlowStore((s) => s.selectResource)
  const selectLane     = useFlowStore((s) => s.selectLane)
  const addNode        = useFlowStore((s) => s.addNode)
  const [menuOpen, setMenuOpen] = useState(false)
  const triggerRef = useRef<HTMLDivElement>(null)
  const portalRef  = useRef<HTMLDivElement>(null)
  const pos        = useDropdownPosition(triggerRef, menuOpen)

  useEffect(() => {
    if (!menuOpen) return
    const handler = (e: MouseEvent) => {
      const inTrigger = triggerRef.current?.contains(e.target as globalThis.Node)
      const inPortal  = portalRef.current?.contains(e.target as globalThis.Node)
      if (!inTrigger && !inPortal) setMenuOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [menuOpen])

  const handleAction = (action: { nodeType: string; propsOverride: Record<string, string> }) => {
    setMenuOpen(false)
    addNode(action.nodeType, laneId, 80 + Math.random() * 200, 60)
    const nodes   = useFlowStore.getState().nodes
    const newNode = nodes[nodes.length - 1]
    if (newNode) {
      if (resource.config) {
        Object.entries(resource.config).forEach(([k, v]) => {
          if (v) useFlowStore.getState().updateNodeProp(newNode.id, k, String(v))
        })
      }
      Object.entries(action.propsOverride).forEach(([k, v]) =>
        useFlowStore.getState().updateNodeProp(newNode.id, k, v)
      )
      useFlowStore.getState().updateNodeConfig(newNode.id, { resourceId: resource.id })
    }
  }

  const STATUS_DOT: Record<string, { color: string; icon: string }> = {
    untested: { color: 'var(--color-text-tertiary)', icon: 'ti-circle-dashed' },
    testing:  { color: 'var(--color-text-warning)',  icon: 'ti-loader' },
    ok:       { color: 'var(--color-text-success)',  icon: 'ti-circle-check' },
    error:    { color: 'var(--color-text-danger)',   icon: 'ti-circle-x' },
  }
  const dot = STATUS_DOT[resource.status] ?? STATUS_DOT.untested

  return (
    <div style={{ position: 'relative', display: 'flex' }} ref={triggerRef}>
      <div
        onClick={() => { selectLane(laneId); selectResource(resource.id) }}
        title={`Configura ${resource.label}`}
        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '3px 7px', borderRadius: '20px 0 0 20px', border: '0.5px solid var(--color-border-secondary)', borderRight: 'none', background: 'var(--color-background-secondary)', fontSize: 11, cursor: 'pointer', userSelect: 'none', color: 'var(--color-text-secondary)', transition: 'background .12s' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-background-tertiary)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-background-secondary)' }}
      >
        <i className={`ti ${RESOURCE_ICONS[resource.kind] ?? 'ti-plug'}`} style={{ fontSize: 13 }} aria-hidden="true" />
        <span>{resource.label}</span>
        <i className={`ti ${dot.icon}`} style={{ fontSize: 11, color: dot.color }} aria-hidden="true" />
      </div>
      <div style={{ width: '0.5px', background: 'var(--color-border-secondary)', flexShrink: 0 }} />
      <div
        onClick={() => setMenuOpen((o) => !o)}
        title="Aggiungi nodo al canvas"
        style={{ display: 'flex', alignItems: 'center', padding: '3px 7px', borderRadius: '0 20px 20px 0', border: '0.5px solid var(--color-border-secondary)', borderLeft: 'none', background: 'var(--color-background-secondary)', cursor: 'pointer', transition: 'background .12s' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-background-tertiary)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-background-secondary)' }}
      >
        <i className="ti ti-plus" style={{ fontSize: 12, color: 'var(--color-text-info)' }} aria-hidden="true" />
      </div>
      {menuOpen && resource.actions.length > 0 && createPortal(
        <div ref={portalRef} style={{ position: 'absolute', top: pos.top, left: pos.left, minWidth: 220, zIndex: 9999, background: 'color-mix(in srgb, var(--color-background-primary) 98%, transparent)', backdropFilter: 'blur(8px)', border: '0.5px solid var(--color-border-secondary)', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,.4)', overflow: 'hidden' }}>
          <div style={{ padding: '6px 12px 4px', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '.07em', borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)' }}>
            {resource.label}
          </div>
          {resource.actions.map((action) => (
            <div key={action.id} onClick={() => handleAction(action)}
              style={{ padding: '9px 14px', fontSize: 12, color: 'var(--color-text-secondary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8, borderBottom: '0.5px solid var(--color-border-tertiary)' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-background-secondary)' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
              <i className="ti ti-plus" style={{ fontSize: 12 }} aria-hidden="true" />
              {action.label}
            </div>
          ))}
        </div>,
        document.body
      )}
    </div>
  )
}

// ─── Resource strip ───────────────────────────────────────────────
function ResourceStrip({ lane }: { lane: Lane }) {
  const addResource = useFlowStore((s) => s.addResource)
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const portalRef  = useRef<HTMLDivElement>(null)
  const pos        = useDropdownPosition(triggerRef, open)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const inTrigger = triggerRef.current?.contains(e.target as globalThis.Node)
      const inPortal  = portalRef.current?.contains(e.target as globalThis.Node)
      if (!inTrigger && !inPortal) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const RESOURCE_TEMPLATES: Array<{ kind: ResourceKind; label: string; build: () => Omit<LaneResource, 'id' | 'status'> }> = [
    { kind: 'db', label: '⬡ Database (DB)', build: () => ({ kind: 'db' as const, label: 'Nuovo DB', config: { dialect: 'postgresql', host: DB_DEFAULTS.postgresql.host, port: DB_DEFAULTS.postgresql.port, database: DB_DEFAULTS.postgresql.database, user: DB_DEFAULTS.postgresql.user }, actions: [ { id: 'in', label: 'Aggiungi come input', nodeType: 'source_db', propsOverride: {} as Record<string, string> }, { id: 'out', label: 'Aggiungi come output', nodeType: 'sink_db', propsOverride: {} as Record<string, string> } ] }) },
    { kind: 'http', label: '⇄ HTTP / REST API', build: () => ({ kind: 'http' as const, label: 'Nuova API', config: { url: HTTP_DEFAULTS.url, method: HTTP_DEFAULTS.method, authType: HTTP_DEFAULTS.authType, headers: HTTP_DEFAULTS.headers }, actions: [ { id: 'in', label: 'Aggiungi come source HTTP', nodeType: 'source_http', propsOverride: {} as Record<string, string> } ] }) },
    { kind: 'kafka', label: '≋ Kafka', build: () => ({ kind: 'kafka' as const, label: 'Nuovo Kafka', config: { broker: 'localhost:9092' }, actions: [ 
      { id: 'in', label: 'Aggiungi come source Kafka', nodeType: 'source_kafka', propsOverride: { broker: 'localhost:9092' } as Record<string, string> }, 
      { id: 'out', label: 'Aggiungi come sink Kafka', nodeType: 'sink_kafka', propsOverride: { broker: 'localhost:9092', topic: 'output' } as Record<string, string> } ] }) },
    { kind: 'mqtt', label: '⊛ MQTT', build: () => ({ kind: 'mqtt' as const, label: 'Nuovo MQTT', config: { broker: 'localhost', port: '1883' }, actions: [ 
      { id: 'in', label: 'Aggiungi come source MQTT', nodeType: 'source_mqtt', propsOverride: { url: 'mqtt://localhost:1883' } as Record<string, string> } ,
      { id: 'out',  label: 'Aggiungi come publisher (sink)',  nodeType: 'sink_mqtt',  propsOverride: { url: 'mqtt://localhost:1883', topic: 'pipeline/output' } as Record<string, string>}] } ) },
    { kind: 'ftp', label: '⇄ FTP / SFTP', build: () => ({ kind: 'ftp' as const, label: 'Nuovo FTP', config: { protocol: 'sftp', host: 'ftp.esempio.com', port: '22', user: '', authType: 'password', keyPath: '' }, actions: [ { id: 'in', label: 'Aggiungi come FTP Source', nodeType: 'source_ftp', propsOverride: {} as Record<string, string> }, { id: 'out', label: 'Aggiungi come FTP Sink', nodeType: 'sink_ftp', propsOverride: {} as Record<string, string> } ] }) },
    {
      kind: 'webhook' as const,
      label: '⤵ Webhook',
      build: () => ({
        kind: 'webhook' as const,
        label: 'Webhook Server',
        config: {
          port:        '9110',
          ipWhitelist: '',
          hmacSecret:  '',
          sigHeader:   'X-Hub-Signature-256',
          sigAlgo:     'sha256',
        },
        actions: [
          {
            id:            'receiver',
            label:         'Aggiungi Receiver',
            nodeType:      'webhook_receiver',
            propsOverride: { port: '9110', path: '/webhook' } as Record<string, string>,
          },
        ],
      }),
    },
    {
      kind: 'ssh',
      label: '⌁ SSH',
      build: () => ({
        kind: 'ssh',
        label: 'Server SSH',
        config: { host: '', port: '22', user: '', authType: 'password' },
        actions: [
          { id: 'exec', label: 'Aggiungi SSH Executor', nodeType: 'ssh_exec', propsOverride: {} }
          ]
      })
    } 
  ]

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', background: 'var(--color-background-secondary)', borderBottom: '0.5px solid var(--color-border-tertiary)', flexWrap: 'wrap' }}>
      <span style={{ fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '.07em', marginRight: 2, flexShrink: 0 }}>Risorse</span>
      {lane.resources.map((res) => <ResourceChip key={res.id} resource={res} laneId={lane.id} />)}
      <div style={{ marginLeft: 'auto' }}>
        <button ref={triggerRef} onClick={() => setOpen((o) => !o)}
          style={{ background: 'none', border: '0.5px dashed var(--color-border-secondary)', borderRadius: 20, padding: '3px 10px', fontSize: 11, color: 'var(--color-text-tertiary)', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-plus" style={{ fontSize: 12 }} aria-hidden="true" />
          Aggiungi risorsa
          <i className="ti ti-chevron-down" style={{ fontSize: 11 }} aria-hidden="true" />
        </button>
        {open && createPortal(
          <div ref={portalRef} style={{ position: 'absolute', top: pos.top, left: pos.left, minWidth: 220, zIndex: 9999, background: 'color-mix(in srgb, var(--color-background-primary) 98%, transparent)', backdropFilter: 'blur(8px)', border: '0.5px solid var(--color-border-secondary)', borderRadius: 8, boxShadow: '0 8px 32px rgba(0,0,0,.5)', overflow: 'hidden' }}>
            <div style={{ padding: '6px 12px 4px', fontSize: 10, fontWeight: 600, color: 'var(--color-text-tertiary)', textTransform: 'uppercase', letterSpacing: '.07em', borderBottom: '0.5px solid var(--color-border-tertiary)', background: 'var(--color-background-secondary)' }}>Tipo di risorsa</div>
            {RESOURCE_TEMPLATES.map((tmpl) => (
              <div key={tmpl.kind} onClick={() => { addResource(lane.id, tmpl.build()); setOpen(false) }}
                style={{ padding: '9px 14px', fontSize: 12, color: 'var(--color-text-secondary)', cursor: 'pointer', borderBottom: '0.5px solid var(--color-border-tertiary)', display: 'flex', alignItems: 'center', gap: 8 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--color-background-secondary)' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                {tmpl.label}
              </div>
            ))}
          </div>,
          document.body
        )}
      </div>
    </div>
  )
}

// ─── LaneFlow ─────────────────────────────────────────────────────
function LaneFlow({ lane }: { lane: Lane }) {
  const allNodes   = useFlowStore((s) => s.nodes)
  const allEdges   = useFlowStore((s) => s.edges)
  const selectNode = useFlowStore((s) => s.selectNode)
  const selectLane = useFlowStore((s) => s.selectLane)
  const addLog     = useFlowStore((s) => s.addLog)
  const addNode    = useFlowStore((s) => s.addNode)

  const laneNodesRef = useRef<FlowNode_<NodeData>[]>([])
  const laneEdgesRef = useRef<Edge[]>([])

  const [nodes, setNodes] = useState<FlowNode_<NodeData>[]>(() =>
    allNodes.filter((n) => n.data.laneId === lane.id)
  )
  const [edges, setEdges] = useState<Edge[]>(() =>
    allEdges.filter((e) => {
      const src = allNodes.find((n) => n.id === e.source)
      return src?.data.laneId === lane.id
    })
  )
  const [isOver, setIsOver] = useState(false)

  // ── Fase 8: edges animati sui nodi in esecuzione ────────────────
  // Deriva a render-time da nodeStats: un edge è animato se il suo
  // nodo sorgente è 'running'. Non tocca lo stato locale `edges`,
  // quindi non interferisce con la sync per id degli useEffect sotto.
  const nodeStats = useFlowStore((s) => s.nodeStats)
  const liveEdges = useMemo(
    () => edges.map((e) => {
      const running = nodeStats[e.source]?.status === 'running'
      if (running === Boolean(e.animated)) return e
      return { ...e, animated: running }
    }),
    [edges, nodeStats],
  )

  useEffect(() => {
    const filtered = allNodes.filter((n) => n.data.laneId === lane.id)
    const prevKey  = laneNodesRef.current.map((n) => n.id + n.data.status + JSON.stringify(n.data.props) + JSON.stringify(n.data.config)).join()
    const nextKey  = filtered.map((n) => n.id + n.data.status + JSON.stringify(n.data.props) + JSON.stringify(n.data.config)).join()
    if (prevKey !== nextKey) { laneNodesRef.current = filtered; setNodes(filtered) }
  }, [allNodes, lane.id])

  useEffect(() => {
    const filtered = allEdges.filter((e) => {
      const src = allNodes.find((n) => n.id === e.source)
      return src?.data.laneId === lane.id
    })
    const prevKey = laneEdgesRef.current.map((e) => e.id).join()
    const nextKey = filtered.map((e) => e.id).join()
    if (prevKey !== nextKey) { laneEdgesRef.current = filtered; setEdges(filtered) }
  }, [allEdges, allNodes, lane.id])

  const onNodesChange = useCallback((changes: NodeChange<FlowNode_<NodeData>>[]) => {
    const filtered = changes.filter((c) => {
      if (c.type !== 'remove') return true
      const node = useFlowStore.getState().nodes.find((n) => n.id === c.id)
      return node?.data.type !== 'lane_start' && node?.data.type !== 'lane_end'
    })
    setNodes((nds) => applyNodeChanges(filtered, nds))
    const posChanges = filtered.filter((c) => c.type === 'position')
    if (posChanges.length > 0) {
      useFlowStore.setState((s) => ({ nodes: applyNodeChanges(posChanges, s.nodes) as FlowNode_<NodeData>[] }))
    }
    const removeIds = filtered.filter((c) => c.type === 'remove').map((c) => c.id)
    if (removeIds.length > 0) {
      useFlowStore.setState((s) => ({
        nodes: s.nodes.filter((n) => !removeIds.includes(n.id)),
        edges: s.edges.filter((e) => !removeIds.includes(e.source) && !removeIds.includes(e.target)),
      }))
    }
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
    const removeIds = changes.filter((c) => c.type === 'remove').map((c) => c.id)
    if (removeIds.length > 0) {
      const currentEdges = useFlowStore.getState().edges
      const currentNodes = useFlowStore.getState().nodes
      removeIds.forEach((edgeId) => {
        const edge = currentEdges.find((e) => e.id === edgeId)
        if (!edge) return
        const tgt = currentNodes.find((n) => n.id === edge.target)
        if (!tgt) return
        if (tgt.data.type === 'tmap' && edge.targetHandle) {
          const tmap  = tgt.data.config?.tmap as TMapConfig | undefined
          const input = tmap?.inputs.find((i) => i.id === edge.targetHandle)
          if (input && !input.isMain) useFlowStore.getState().deleteTMapInput(tgt.id, edge.targetHandle)
          if (input && input.isMain)  useFlowStore.getState().updateTMapInput(tgt.id, edge.targetHandle, { fields: [] })
        }
        if (tgt.data.type === 'union') {
          if (edge.targetHandle === 'input_main') {
            // main disconnesso — niente da fare sul config
          } else if (edge.targetHandle?.startsWith('union_input_')) {
            const config   = (tgt.data.config as any) ?? {}
            const existing = (config.unionInputs ?? [])
            useFlowStore.getState().updateNodeConfig(tgt.id, {
              ...config,
              unionInputs: existing.filter((inp: any) => inp.id !== edge.targetHandle)
            })
          }
          setTimeout(() => propagateUnionSchema(tgt.id, useFlowStore.getState()), 50)
        }
        if (tgt.data.type === 'source_file' || tgt.data.type === 'sink_file') {
          useFlowStore.getState().updateNodeProp(tgt.id, 'outputSchema', '')
        }
      })
      useFlowStore.setState((s) => ({ edges: s.edges.filter((e) => !removeIds.includes(e.id)) }))
    }
  }, [])

  const onConnect = useCallback((connection: Connection) => {
    const store = useFlowStore.getState()
    const src   = store.nodes.find((n) => n.id === connection.source)
    const tgt   = store.nodes.find((n) => n.id === connection.target)

    if (!src || !tgt) return

    // ── Catch: handle sorgente speciale — schema = campi originali
    //    del nodo sorgente + campo _catch (object). Deve precedere
    //    resolveConnection perché 'catch' non è un handle normale.
    if (connection.sourceHandle === 'catch') {
      const resolution = resolveConnection(connection, store.nodes, store.edges)
      if (!resolution.valid) {
        if (resolution.rejectionReason) addLog('warn', resolution.rejectionReason)
        return
      }
      const newEdge = buildEdge(connection, resolution.resolvedTargetHandle, lane.color, '⚡ catch')
      setEdges((eds) => addEdge(newEdge, eds))
      useFlowStore.setState((s) => ({ edges: addEdge(newEdge, s.edges) }))

      setTimeout(() => {
        const store2  = useFlowStore.getState()
        const srcNode = store2.nodes.find((n) => n.id === connection.source)
        const tgtNode = store2.nodes.find((n) => n.id === connection.target)
        if (!srcNode || !tgtNode) return
        const srcSchema = getHandleSchema(srcNode, 'output', false)
        const catchSchema = [...srcSchema, CATCH_FIELD]
        store2.updateNodeProp(tgtNode.id, 'incomingSchema', JSON.stringify(catchSchema))
      }, 0)
      return
    }

    // ── Risolve la connessione (validazione standard) ──────────────
    const resolution = resolveConnection(connection, store.nodes, store.edges)
    if (!resolution.valid) {
      if (resolution.rejectionReason) addLog('warn', resolution.rejectionReason)
      return
    }

    // ── Aggiornamenti strutturali Union — aggiunge handle, non schema
    if (resolution.unionUpdate) {
      const { targetNodeId, newInputs } = resolution.unionUpdate
      flushSync(() => {
        useFlowStore.setState((s) => ({
          nodes: updateNode(s.nodes, targetNodeId, (n) => ({
            ...n,
            data: { ...n.data, config: { ...n.data.config, unionInputs: newInputs } },
          })),
        }))
        setNodes((nds) => nds.map((n) =>
          n.id === targetNodeId
            ? { ...n, data: { ...n.data, config: { ...n.data.config, unionInputs: newInputs } } }
            : n
        ))
      })
    }

    // ── Aggiornamenti strutturali TMap — aggiunge/aggiorna input, non schema
    if (resolution.tmapUpdate) {
      const { targetNodeId, newInput, updateInput } = resolution.tmapUpdate
      if (newInput) {
        useFlowStore.setState((s) => ({
          nodes: updateNode(s.nodes, targetNodeId, (n) => {
            const t = n.data.config.tmap as TMapConfig | undefined
            if (!t) return n
            return { ...n, data: { ...n.data, config: { ...n.data.config, tmap: { ...t, inputs: [...t.inputs, newInput] } } } }
          }),
        }))
      }
      if (updateInput) {
        store.updateTMapInput(targetNodeId, updateInput.inputId, { fields: updateInput.fields })
      }
    }

    // ── Crea l'edge ───────────────────────────────────────────────
    const newEdge = buildEdge(connection, resolution.resolvedTargetHandle, lane.color, resolution.edgeLabel)
    setEdges((eds) => addEdge(newEdge, eds))
    useFlowStore.setState((s) => ({ edges: addEdge(newEdge, s.edges) }))

    // ── Propagazione schema — UNICO punto, delegato al registro ────
    // Gestisce internamente: nodi semplici, TMap (sorgente E target,
    // con merge non distruttivo), json_parser/xml_parser (sorgente),
    // json_serializer/xml_serializer (target, terminatori), join
    // (input_left/input_right), passthrough (log/materialize/filter
    // con cascata a valle). Union è delegato a propagateUnionSchema
    // tramite il parametro unionPropagator.
    setTimeout(() => {
      const store2 = useFlowStore.getState()
      const sourceHandleId = connection.sourceHandle ?? 'output'
      propagateFromConnection(
        connection.source!,
        sourceHandleId,
        connection.target!,
        store2,
        (unionNodeId, s) => propagateUnionSchema(unionNodeId, s, () => useFlowStore.getState()),
      )
    }, 0)
  }, [lane.color, addLog])

  const onNodeClick: NodeMouseHandler = useCallback((_e, node) => {
    selectNode(node.id); selectLane(lane.id)
  }, [selectNode, selectLane, lane.id])

  const onPaneClick = useCallback(() => {
    selectNode(null); selectLane(lane.id)
  }, [selectNode, selectLane, lane.id])

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; setIsOver(true)
  }, [])

  const onDragLeave = useCallback(() => setIsOver(false), [])

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault(); setIsOver(false)
    const type = e.dataTransfer.getData('application/flowpilot-node') || dragState.type
    if (!type) return
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
    addNode(type, lane.id, Math.max(0, e.clientX - rect.left - 65), Math.max(0, e.clientY - rect.top - 30))
    dragState.type = null
  }, [addNode, lane.id])

  const isValidConnection = useCallback((connection: Connection | Edge): boolean => {
    const { nodes, edges } = useFlowStore.getState()
    return isConnectionValid(connection, nodes, edges)
  }, [])

  return (
    <div onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      style={{ height: lane.height, outline: isOver ? `2px dashed ${lane.color}` : undefined, outlineOffset: -3 }}>
      <ReactFlow
        nodes={nodes} edges={liveEdges} nodeTypes={nodeTypes}
        onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        onConnect={onConnect} onNodeClick={onNodeClick} onPaneClick={onPaneClick}
        isValidConnection={isValidConnection}
        deleteKeyCode="Delete" fitView fitViewOptions={{ padding: 0.3 }}
        style={{ background: '#0f1117' }}>
        <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="#2a3349" />
      </ReactFlow>
    </div>
  )
}

// ─── LaneCanvas ───────────────────────────────────────────────────
export function LaneCanvas({ lane }: { lane: Lane }) {
  const updateLane  = useFlowStore((s) => s.updateLane)
  const deleteLane  = useFlowStore((s) => s.deleteLane)
  const moveLane    = useFlowStore((s) => s.moveLane)
  const laneCount   = useFlowStore((s) => s.pool.lanes.length)
  const allLanes    = useFlowStore((s) => s.pool.lanes)
  const nodeCount   = useFlowStore((s) => s.nodes.filter((n) => n.data.laneId === lane.id).length)
  const isFirst     = lane.order === 0
  const isLast      = lane.order === laneCount - 1
  const isMaximized = lane.height >= 600

  const resizingRef    = useRef(false)
  const startYRef      = useRef(0)
  const startHeightRef = useRef(lane.height)

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    resizingRef.current = true; startYRef.current = e.clientY; startHeightRef.current = lane.height
    const onMove = (ev: MouseEvent) => {
      if (!resizingRef.current) return
      updateLane(lane.id, { height: Math.round(Math.max(120, Math.min(900, startHeightRef.current + ev.clientY - startYRef.current))) })
    }
    const onUp = () => { resizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [lane.height, lane.id, updateLane])

  const toggleMaximize = useCallback(() => updateLane(lane.id, { height: isMaximized ? 200 : 700 }), [lane.id, isMaximized, updateLane])

  const fitAll = useCallback(() => {
    const visibleLanes = allLanes.filter((l) => !l.collapsed)
    const available = Math.max(120, Math.floor((window.innerHeight - 120 - 130 - 60) / visibleLanes.length))
    visibleLanes.forEach((l) => updateLane(l.id, { height: available }))
  }, [allLanes, updateLane])

  return (
    <div style={{ border: `2px solid ${lane.color}`, borderRadius: 8, overflow: 'visible', background: 'var(--color-background-primary)', boxShadow: `0 0 0 1px color-mix(in srgb, ${lane.color} 20%, transparent)` }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', background: `color-mix(in srgb, ${lane.color} 8%, var(--color-background-primary))`, borderBottom: `1px solid color-mix(in srgb, ${lane.color} 30%, transparent)`, borderRadius: '6px 6px 0 0' }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: lane.color, flexShrink: 0 }} />
        <input value={lane.label} onChange={(e) => updateLane(lane.id, { label: e.target.value })}
          style={{ background: 'none', border: 'none', outline: 'none', fontWeight: 600, fontSize: 13, color: 'var(--color-text-primary)', cursor: 'text', padding: 0, width: 120 }} />
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)', marginLeft: 4 }}>
          {nodeCount} nodi · {lane.resources.length} risorse · {lane.height}px
        </span>
        <input type="color" value={lane.color} onChange={(e) => updateLane(lane.id, { color: e.target.value })} title="Colore lane"
          style={{ width: 20, height: 20, border: 'none', borderRadius: 4, padding: 0, cursor: 'pointer', background: 'none' }} />
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 4 }}>
          {([
            { icon: 'ti-chevron-up',   title: 'Sposta su',  disabled: isFirst, fn: () => moveLane(lane.id, 'up') },
            { icon: 'ti-chevron-down', title: 'Sposta giù', disabled: isLast,  fn: () => moveLane(lane.id, 'down') },
          ] as const).map(({ icon, title, disabled, fn }) => (
            <button key={icon} onClick={fn} disabled={disabled} title={title} style={iconBtn(disabled)}>
              <i className={`ti ${icon}`} style={{ fontSize: 13 }} aria-hidden="true" />
            </button>
          ))}
          <button onClick={fitAll} title="Distribuisci altezza equamente" style={iconBtn(false)}>
            <i className="ti ti-layout-distribute-vertical" style={{ fontSize: 13 }} aria-hidden="true" />
          </button>
          <button onClick={toggleMaximize} title={isMaximized ? 'Riduci' : 'Massimizza'} style={iconBtn(false)}>
            <i className={`ti ${isMaximized ? 'ti-arrows-minimize' : 'ti-arrows-maximize'}`} style={{ fontSize: 13 }} aria-hidden="true" />
          </button>
          <button onClick={() => updateLane(lane.id, { collapsed: !lane.collapsed })} title={lane.collapsed ? 'Espandi' : 'Collassa'} style={iconBtn(false)}>
            <i className={`ti ${lane.collapsed ? 'ti-layout-rows' : 'ti-layout-bottombar'}`} style={{ fontSize: 13 }} aria-hidden="true" />
          </button>
          <button onClick={() => { if (confirm(`Eliminare "${lane.label}"?`)) deleteLane(lane.id) }} title="Elimina lane" style={{ ...iconBtn(false), color: 'var(--color-text-danger)' }}>
            <i className="ti ti-trash" style={{ fontSize: 13 }} aria-hidden="true" />
          </button>
        </div>
      </div>
      {!lane.collapsed && (
        <div style={{ overflow: 'hidden', borderRadius: '0 0 6px 6px' }}>
          <ResourceStrip lane={lane} />
          <ReactFlowProvider><LaneFlow lane={lane} /></ReactFlowProvider>
          <div onMouseDown={onResizeStart} title="Trascina per ridimensionare"
            style={{ height: 6, cursor: 'ns-resize', background: `color-mix(in srgb, ${lane.color} 15%, var(--color-background-secondary))`, display: 'flex', alignItems: 'center', justifyContent: 'center', transition: 'background .15s' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${lane.color} 40%, var(--color-background-secondary))` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${lane.color} 15%, var(--color-background-secondary))` }}>
            <div style={{ width: 32, height: 2, borderRadius: 1, background: `color-mix(in srgb, ${lane.color} 60%, transparent)` }} />
          </div>
        </div>
      )}
    </div>
  )
}

function iconBtn(disabled: boolean): React.CSSProperties {
  return {
    background: 'none', border: '0.5px solid var(--color-border-tertiary)', borderRadius: 4, padding: '2px 5px',
    cursor: disabled ? 'not-allowed' : 'pointer', color: disabled ? 'var(--color-text-tertiary)' : 'var(--color-text-secondary)',
    opacity: disabled ? 0.4 : 1, display: 'flex', alignItems: 'center',
  }
}