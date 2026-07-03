import { useState } from 'react'
import { useFlowStore, resyncNodeCounter } from '../store/flowStore'
import { invoke } from '@tauri-apps/api/core'
import {
  isTauri,
  openPlanDialog,
  savePlanDialog,
  readFile,
  writeFile,
} from '../lib/tauri'
import { buildTMapPlan } from '../ir/tmapExprConverter'
import type { TMapConfig } from '../types'
import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData } from '../types'

let abortFlag = false

// ─── Polling ──────────────────────────────────────────────────────
// Stato persistente fuori dal componente — sopravvive ai re-render
let _pollCursor   = 0
let _currentRunId = ''
let _pollInterval: ReturnType<typeof setInterval> | null = null

function startPolling() {
  if (_pollInterval !== null) return
  _pollInterval = setInterval(async () => {
    try {
      const result = await invoke('engine_poll_events', { cursor: _pollCursor }) as any
      _pollCursor  = result.cursor
      if (result.events.length === 0) return

      const store = useFlowStore.getState()
      for (const ev of result.events) {
        const p = ev.event.payload ?? {}
        // Ignora eventi di run precedenti: il bus è append-only e
        // può contenere code di run passati — processarli riaccende
        // pallini a caso e, peggio, un vecchio RunCompleted ferma
        // il polling a metà del run corrente.
        if (p.run_id && _currentRunId && p.run_id !== _currentRunId) continue
        switch (ev.event.type) {
          case 'NodeStarted':
            store.setNodeStatus(p.node_id, 'running')
            // Fase 8: inizializza le stats — pulse giallo + contatori a 0
            store.setNodeStats(p.node_id, { status: 'running', rowsIn: 0, rowsOut: 0 })
            break
          case 'NodeCompleted':
            store.setNodeStatus(p.node_id, 'done')
            // Fase 8: congela le stats finali (verde, o rosso se error valorizzato)
            store.setNodeStats(p.node_id, {
              status:    p.stats?.error ? 'error' : 'done',
              rowsIn:    p.stats?.rows_in  ?? 0,
              rowsOut:   p.stats?.rows_out ?? 0,
              elapsedMs: p.stats?.elapsed_ms,
            })
            store.addLog('ok',
            `${p.node_id} — ${p.stats?.rows_in ?? 0} in → ${p.stats?.rows_out ?? 0} out, ${p.stats?.elapsed_ms ?? 0}ms`,
            p.node_id)
            break
          case 'NodeFailed':
            store.setNodeStatus(p.node_id, 'error', p.error)
            // Fase 8: pallino e badge rossi — i contatori restano
            // all'ultimo valore di progress, utile per capire dove si è fermato
            store.setNodeStats(p.node_id, { status: 'error' })
            store.addLog('error', `${p.node_id}: ${p.error}`, p.node_id)
            break
          case 'NodeProgress':
            // Fase 8: aggiorna i badge contatori in tempo reale.
            // Il payload arriva da emit_progress: rows_in, rows_out,
            // rows_rejected, throughput_rps (snake_case da serde).
            store.setNodeStats(p.node_id, {
              status:  'running',
              rowsIn:  p.rows_in  ?? 0,
              rowsOut: p.rows_out ?? 0,
            })
            break
          case 'RunCompleted': {
            // Scopa: chiude i nodi rimasti 'running' e logga chi era —
            // se compare il warn, c'è un emettitore mancante lato Rust
            const pending = useFlowStore.getState().nodeStats
            const stuck: string[] = []
            Object.entries(pending).forEach(([id, st]) => {
              if (st.status === 'running') {
                stuck.push(id)
                store.setNodeStats(id, { status: 'done' })
              }
            })
            if (stuck.length > 0) {
              console.warn('[bus] nodi senza NodeCompleted a fine run:', stuck)
            }
            store.setRunning(false)
            store.addLog('ok', `✓ Run completato in ${p.elapsed_ms}ms`)
            stopPolling()
            break
          }
          case 'RunFailed': {
            // Stessa scopa in caso di fallimento — ferma il pulse ovunque
            const pending = useFlowStore.getState().nodeStats
            Object.entries(pending).forEach(([id, st]) => {
              if (st.status === 'running') store.setNodeStats(id, { status: 'idle' })
            })
            store.setRunning(false)
            store.addLog('error', `❌ Run fallito: ${p.error}`)
            stopPolling()
            break
          }
        }
      }
    } catch (err) {
      console.error('[bus] polling error:', err)
    }
  }, 200)
}

function stopPolling() {
  if (_pollInterval) { clearInterval(_pollInterval); _pollInterval = null }
  // NON azzerare _pollCursor: il bus Rust è append-only e conserva
  // gli eventi dei run precedenti. Ripartire da 0 al run successivo
  // rileggerebbe tutta la storia — vecchi NodeStarted che riaccendono
  // i nodi e un vecchio RunCompleted che ferma il polling subito.
  // Il cursore resta monotono per l'intera vita dell'app.
}

// ─── buildRustPlan ────────────────────────────────────────────────
// Converte il canvas (nodes + edges + pool) nel Plan JSON per Rust.
//
// Logica per ogni lane:
//   1. Prende i nodi della lane in ordine topologico
//   2. Per i nodi TMap: converte la TMapConfig in TMapPlan con ExprNode
//   3. Popola lanes[].edges (EdgePlan) — l'executor v6 costruisce
//      il wiring dagli edges, lookup TMap inclusi (niente più hack
//      _tmap_lookup_for né riordino dei lookup in fondo all'array)
//   4. Costruisce i bridge tra lane

function topologicalOrder(
  laneNodes: FlowNode<NodeData>[],
  allEdges:  Edge[],
): FlowNode<NodeData>[] {
  const ids    = new Set(laneNodes.map(n => n.id))
  const edges  = allEdges.filter(e => ids.has(e.source) && ids.has(e.target))
  const inDeg  = new Map<string, number>()
  const adj    = new Map<string, string[]>()

  for (const n of laneNodes) { inDeg.set(n.id, 0); adj.set(n.id, []) }
  for (const e of edges) {
    inDeg.set(e.target, (inDeg.get(e.target) ?? 0) + 1)
    adj.get(e.source)?.push(e.target)
  }

  const queue  = laneNodes.filter(n => (inDeg.get(n.id) ?? 0) === 0)
  const result: FlowNode<NodeData>[] = []

  while (queue.length > 0) {
    const node = queue.shift()!
    result.push(node)
    for (const nid of (adj.get(node.id) ?? [])) {
      const d = (inDeg.get(nid) ?? 1) - 1
      inDeg.set(nid, d)
      if (d === 0) {
        const n = laneNodes.find(x => x.id === nid)
        if (n) queue.push(n)
      }
    }
  }

  // Aggiungi eventuali nodi non raggiunti (nodi isolati)
  for (const n of laneNodes) {
    if (!result.find(r => r.id === n.id)) result.push(n)
  }

  return result
}

function buildRustPlan(
  nodes: FlowNode<NodeData>[],
  edges: Edge[],
  pool:  ReturnType<typeof useFlowStore.getState>['pool'],
  runId: string,
): object {

  // ── Bridge tra lane
  const bridges: object[] = []
  const bridgeEdges = edges.filter(e => {
    const src = nodes.find(n => n.id === e.source)
    const tgt = nodes.find(n => n.id === e.target)
    return src?.data.type === 'bridge_out' || tgt?.data.type === 'bridge_in'
  })
  // I bridge vengono estratti dai nodi bridge_out/bridge_in
  // già presenti nel plan — Rust li collega tramite bridge_id

  // ── Lane
  const laneIds = [...new Set(nodes.map(n => n.data.laneId).filter(Boolean))]

  const lanes = laneIds.map(laneId => {
    const laneConfig = pool.lanes.find(l => l.id === laneId)

    // Variabili della lane
    const variables: Record<string, unknown> = {}
    for (const v of laneConfig?.variables ?? []) {
      variables[v.name] = v.value
    }

    // Nodi della lane — skip lane_start, lane_end, error_handler
    const SKIP_TYPES = new Set(['lane_start', 'lane_end', 'error_handler'])
    const laneNodes  = nodes.filter(n =>
      n.data.laneId === laneId && !SKIP_TYPES.has(n.data.type)
    )

    // Ordine topologico — con l'executor edge-based (v6) l'ordine
    // non determina più il wiring (lo fanno gli edges), ma lo
    // manteniamo per leggibilità dei log e determinismo dello spawn.
    const finalOrder = topologicalOrder(laneNodes, edges)

    // ── EdgePlan per l'executor edge-based ─────────────────────
    // Solo edges interni alla lane e tra nodi non-skip. Il wiring
    // Rust crea un canale per (target_node, target_handle), con
    // fan-out quando un handle sorgente ha più edges.
    const laneNodeIds = new Set(laneNodes.map(n => n.id))
    const laneEdges = edges
      .filter(e => laneNodeIds.has(e.source) && laneNodeIds.has(e.target))
      .map(e => ({
        edge_id:       e.id,
        source_node:   e.source,
        source_handle: e.sourceHandle ?? 'output',
        target_node:   e.target,
        target_handle: e.targetHandle ?? 'input',
      }))

    const rustNodes = finalOrder.map(node => {
      // Config base del nodo — viene da node.data.props
      let config: Record<string, unknown> = {}

      // Legge la config dai props (come fanno i test manuali)
      const props = node.data.props ?? {}

      switch (node.data.type) {

        case 'source_db': {
         
          console.log('[source_db debug_JSON]', node.id, node.data.label, 
            JSON.stringify({ props, config: node.data.config }, null, 2))
          // Trova la risorsa DB collegata
          const resourceId = node.data.config?.resourceId as string | undefined
          const resource   = laneConfig?.resources.find(r => r.id === resourceId)
          const rc = resource?.config ?? {}

  // query: usa custom query se non vuota, altrimenti SELECT * FROM table
          // limit: se > 0 aggiunge LIMIT
          const customQuery = (props['query'] ?? '').trim()
          const table       = (props['table'] ?? '').trim()
          const limit       = parseInt(props['limit'] ?? '0', 10)
          const schema      = (props['schema'] ?? 'public').trim()
          const tableFull   = schema && schema !== 'public' ? `${schema}.${table}` : table

          let query: string
          if (customQuery) {
            query = customQuery
          } else if (tableFull) {
            query = `SELECT * FROM ${tableFull}`
            if (limit > 0) query += ` LIMIT ${limit}`
          } else {
            query = 'SELECT 1'
          }

          config = {
            dialect:  rc['dialect']  ?? 'postgresql',
            host:     rc['host']     ?? 'localhost',
            port:     parseInt(rc['port'] ?? '5432', 10),
            database: rc['database'] ?? '',
            user:     rc['user'] ?? rc['username'] ?? '',
            password: rc['password'] ?? '',
            ssl:      rc['ssl']      ?? 'false',
            query,
          }
          break
        }

        case 'source_file': {
          config = {
            path:       props['path']       ?? '',
            delimiter:  props['delimiter']  ?? ',',
            has_header: props['has_header'] !== 'false',
          }
          break
        }

        case 'sink_file': {
          config = {
            path:         props['path']      ?? '/tmp/output.csv',
            delimiter:    props['delimiter'] ?? ',',
            write_header: props['write_header'] !== 'false',
            mode:         props['mode']      ?? 'overwrite',
          }
          break
        }

        case 'sink_db': {
          const resourceId = node.data.config?.resourceId as string | undefined
          const resource   = laneConfig?.resources.find(r => r.id === resourceId)
          const rc = resource?.config ?? {}
          config = {
            dialect:  rc['dialect']  ?? 'postgresql',
            host:     rc['host']     ?? 'localhost',
            port:     parseInt(rc['port'] ?? '5432', 10),
            database: rc['database'] ?? '',
            user:     rc['user'] ?? rc['username'] ?? '',
            password: rc['password'] ?? '',
            ssl:      rc['ssl']      ?? 'false',
            table:    props['table'] ?? '',
            mode:     props['mode']  ?? 'insert',
          }
          break
        }

        case 'filter': {
          // Usa ExprNode se presente, altrimenti FilterCondition legacy
          const filterCfg = node.data.config?.filter as any
          if (filterCfg?.expr) {
            config = { expr: filterCfg.expr }
          } else if (filterCfg?.conditions?.length > 0) {
            // Prima condizione come expr (supporto base)
            config = { expr: filterCfg.conditions[0].expr ?? null }
          } else {
            config = {}
          }
          break
        }

        case 'tmap': {
          // ← PUNTO CHIAVE: converti TMapConfig in TMapPlan con ExprNode
          const tmapConfig = node.data.config?.tmap as TMapConfig | undefined
          if (tmapConfig) {
            try {
              const tmapPlan = buildTMapPlan(tmapConfig)
              config = tmapPlan as unknown as Record<string, unknown>
            } catch (e) {
              console.warn('[buildRustPlan] buildTMapPlan fallito:', e)
              config = {}
            }
          }
          break
        }

        case 'bridge_out': {
          const bridgeId = props['channelName'] ?? node.data.config?.['channelName'] ?? ''
          config = { bridge_id: bridgeId }
          // Registra il bridge
          const tgtEdge = edges.find(e => e.source === node.id)
          if (tgtEdge) {
            const tgtNode = nodes.find(n => n.id === tgtEdge.target)
            if (tgtNode?.data.type === 'bridge_in') {
              bridges.push({
                bridge_id:   bridgeId,
                source_lane: laneId,
                source_node: node.id,
                target_lane: tgtNode.data.laneId,
                target_node: tgtNode.id,
              })
            }
          }
          break
        }

        case 'bridge_in': {
          const bridgeId = props['channelName'] ?? node.data.config?.['channelName'] ?? ''
          config = { bridge_id: bridgeId }
          break
        }

        default:
          config = {}
      }

      return {
        node_id:   node.id,
        node_type: node.data.type,
        label:     node.data.config?.displayName || node.data.label || node.data.type,
        config,
      }
    })

    return {
      lane_id:   laneId,
      label:     laneConfig?.label ?? laneId,
      nodes:     rustNodes,
      edges:     laneEdges,   // v6: il wiring dell'executor segue gli edges
      variables,
    }
  })

  return { run_id: runId, lanes, bridges }
}

// ─── Componenti UI ────────────────────────────────────────────────

function TbBtn({
  children, onClick, disabled, color, border, title,
}: {
  children: React.ReactNode
  onClick?: () => void
  disabled?: boolean
  color?: string
  border?: string
  title?: string
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        background:   'transparent',
        border:       `1px solid ${border ?? 'var(--color-border-secondary)'}`,
        color:        color ?? 'var(--color-text-secondary)',
        padding:      '4px 10px',
        borderRadius: 4,
        cursor:       disabled ? 'not-allowed' : 'pointer',
        fontSize:     12,
        fontFamily:   'inherit',
        opacity:      disabled ? 0.4 : 1,
        transition:   'background 0.15s',
        display:      'flex',
        alignItems:   'center',
        gap:          5,
      }}
    >
      {children}
    </button>
  )
}

function TbDivider() {
  return <div style={{ width: 1, height: 20, background: 'var(--color-border-tertiary)' }} />
}

// ─── Toolbar ──────────────────────────────────────────────────────

export function Toolbar() {
  const {
    nodes, edges, running,
    setRunning, setNodeStatus, addLog,
    clearCanvas, pool, addLane,
    resetNodeStats, setNodeStats,
  } = useFlowStore()

  const [saving,  setSaving]  = useState(false)
  const [opening, setOpening] = useState(false)

  // ── Run — usa Rust Engine ─────────────────────────────────────
  const handleRun = async () => {
    if (running) return
    abortFlag = false
    setRunning(true)

    const { useLogViewerStore } = await import('../store/useLogViewerStore')
    useLogViewerStore.getState().newSession()

    // Reset stati nodi
    nodes.forEach(n => setNodeStatus(n.id, 'idle'))
    // Fase 8: azzera le stats runtime — spariscono badge e pallini
    // del run precedente prima che parta il nuovo
    resetNodeStats()

    const runId = `run_${Date.now()}`
    // Registra il run corrente: il polling scarterà eventi di run passati
    _currentRunId = runId

    // Costruisce il Plan JSON per Rust
    const plan = buildRustPlan(nodes, edges, pool, runId)
 // ← AGGIUNGI QUI
    console.log('[buildRustPlan] plan:', JSON.stringify(plan, null, 2))
    // Avvia il polling degli eventi Rust → aggiorna UI
    startPolling()

    try {
      await invoke('engine_run', { planJson: JSON.stringify(plan) })
      addLog('info', `▶ Run avviato — runId: ${runId}`)
    } catch (e) {
      addLog('error', `❌ Errore avvio run: ${e}`)
      setRunning(false)
      stopPolling()
    }
    // setRunning(false) verrà chiamato dal polling quando arriva RunCompleted/RunFailed
  }

  // ── Stop ──────────────────────────────────────────────────────
  const handleStop = () => {
    abortFlag = true
    stopPolling()
    nodes.forEach(n => {
      if (n.data.status === 'running') setNodeStatus(n.id, 'idle')
    })
    // Fase 8: riporta a idle anche le stats dei nodi rimasti 'running',
    // così il pulse giallo si ferma — i contatori restano visibili
    const stats = useFlowStore.getState().nodeStats
    Object.entries(stats).forEach(([id, st]) => {
      if (st.status === 'running') setNodeStats(id, { status: 'idle' })
    })
    addLog('warn', "Pipeline interrotta dall'utente.")
    setRunning(false)
  }

  // ── Salva ─────────────────────────────────────────────────────
  const handleSave = async () => {
    if (!isTauri()) {
      addLog('warn', 'Salvataggio file disponibile solo nell\'app desktop.')
      return
    }
    setSaving(true)
    try {
      const path = await savePlanDialog()
      if (!path) return
      const state   = useFlowStore.getState()
      const payload = JSON.stringify({
        version: '1.0', savedAt: new Date().toISOString(),
        pool: state.pool, nodes: state.nodes, edges: state.edges,
      }, null, 2)
      await writeFile(path, payload)
      addLog('ok', `Progetto salvato: ${path}`)
    } catch (e) {
      addLog('error', `Errore salvataggio: ${e}`)
    } finally {
      setSaving(false)
    }
  }

  // ── Apri ──────────────────────────────────────────────────────
  const handleOpen = async () => {
    if (!isTauri()) {
      addLog('warn', 'Apertura file disponibile solo nell\'app desktop.')
      return
    }
    setOpening(true)
    try {
      const path = await openPlanDialog()
      if (!path) return
      const content = await readFile(path)
      const data    = JSON.parse(content)
      if (!data.pool || !data.nodes || !data.edges) {
        addLog('error', 'File non valido — mancano pool, nodes o edges.')
        return
      }
      useFlowStore.setState({
        pool: data.pool, nodes: data.nodes, edges: data.edges,
        selectedNodeId: null, editingNodeId: null, selectedResourceId: null,
      })
      resyncNodeCounter(data.nodes)
      addLog('ok', `Progetto aperto: ${path}`)
    } catch (e) {
      addLog('error', `Errore apertura: ${e}`)
    } finally {
      setOpening(false)
    }
  }

  // ── Esempio ───────────────────────────────────────────────────
  const loadExample = () => {
    clearCanvas()
    const store = useFlowStore.getState()
    const lanes = store.pool.lanes
    if (lanes.length < 2) store.addLane()
    const updatedLanes = useFlowStore.getState().pool.lanes
    const laneA = updatedLanes[0]
    const laneB = updatedLanes[1]
    store.addNode('source_db', laneA.id, 40,  40)
    store.addNode('filter',    laneA.id, 220, 40)
    store.addNode('sink_file', laneA.id, 400, 40)
    store.addNode('source_db', laneB.id, 40,  40)
    store.addNode('sink_file', laneB.id, 220, 40)
    setTimeout(() => {
      const ns     = useFlowStore.getState().nodes
      const nodesA = ns.filter(n => n.data.laneId === laneA.id && !['lane_start','lane_end','error_handler'].includes(n.data.type))
      const nodesB = ns.filter(n => n.data.laneId === laneB.id && !['lane_start','lane_end','error_handler'].includes(n.data.type))
      const mkEdge = (src: string, tgt: string, color: string) => ({
        id: `e_${src}_${tgt}`, source: src, target: tgt,
        style: { stroke: color, strokeWidth: 2, opacity: 0.7 },
        markerEnd: { type: 'arrowclosed' as const, color },
      })
      useFlowStore.setState(s => ({
        edges: [
          ...(nodesA.length >= 2 ? [mkEdge(nodesA[0].id, nodesA[1].id, laneA.color)] : []),
          ...(nodesA.length >= 3 ? [mkEdge(nodesA[1].id, nodesA[2].id, laneA.color)] : []),
          ...(nodesB.length >= 2 ? [mkEdge(nodesB[0].id, nodesB[1].id, laneB.color)] : []),
          ...s.edges,
        ],
      }))
      addLog('info', 'Esempio caricato. Premi Run per eseguire.')
    }, 80)
  }

  const nodeCount = nodes.filter(
    n => n.data.type !== 'lane_start' && n.data.type !== 'lane_end'
  ).length

  return (
    <div style={{
      height: 40,
      background: 'var(--color-background-primary)',
      borderBottom: '0.5px solid var(--color-border-tertiary)',
      display: 'flex', alignItems: 'center',
      padding: '0 12px', gap: 8, flexShrink: 0,
    }}>

      {/* Logo */}
      <span style={{
        fontSize: 13, fontWeight: 600, color: 'var(--color-text-info)',
        letterSpacing: '0.05em', marginRight: 8,
        display: 'flex', alignItems: 'center', gap: 5,
      }}>
        <i className="ti ti-hexagon" style={{ fontSize: 16 }} aria-hidden="true" />
        FlowPilot
      </span>

      <TbDivider />

      {/* File */}
      <TbBtn onClick={handleOpen} disabled={opening} title="Apri progetto">
        <i className="ti ti-folder-open" style={{ fontSize: 13 }} aria-hidden="true" />
        {opening ? 'Apertura…' : 'Apri'}
      </TbBtn>
      <TbBtn onClick={handleSave} disabled={saving} title="Salva progetto">
        <i className="ti ti-device-floppy" style={{ fontSize: 13 }} aria-hidden="true" />
        {saving ? 'Salvataggio…' : 'Salva'}
      </TbBtn>

      <TbDivider />

      {/* Esecuzione */}
      <TbBtn
        color="var(--color-text-success)"
        border="var(--color-border-success)"
        onClick={handleRun}
        disabled={running}
        title="Esegui pipeline su Rust Engine"
      >
        <i className="ti ti-player-play" style={{ fontSize: 13 }} aria-hidden="true" />
        Run
      </TbBtn>

      <TbBtn
        color="var(--color-text-danger)"
        border="var(--color-border-danger)"
        onClick={handleStop}
        disabled={!running}
        title="Ferma pipeline"
      >
        <i className="ti ti-player-stop" style={{ fontSize: 13 }} aria-hidden="true" />
        Stop
      </TbBtn>

      <TbDivider />

      {/* Canvas */}
      <TbBtn onClick={addLane} title="Aggiungi lane">
        <i className="ti ti-plus" style={{ fontSize: 13 }} aria-hidden="true" />
        Lane
      </TbBtn>
      <TbBtn onClick={clearCanvas} title="Svuota canvas">
        <i className="ti ti-trash" style={{ fontSize: 13 }} aria-hidden="true" />
        Clear
      </TbBtn>
      <TbBtn onClick={loadExample} title="Carica esempio">
        <i className="ti ti-layout-rows" style={{ fontSize: 13 }} aria-hidden="true" />
        Esempio
      </TbBtn>

      {/* Info */}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
        <span style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
          {pool.lanes.length} lane · {nodeCount} nodi
        </span>
        <TbDivider />
        <span style={{
          fontSize: 11, fontFamily: 'var(--font-mono)',
          color: running ? 'var(--color-text-success)' : 'var(--color-text-tertiary)',
        }}>
          {running ? '● running…' : '○ idle'}
        </span>
        {isTauri() && (
          <>
            <TbDivider />
            <span style={{ fontSize: 10, color: 'var(--color-text-tertiary)', opacity: 0.5 }}>
              desktop
            </span>
          </>
        )}
      </div>

    </div>
  )
}