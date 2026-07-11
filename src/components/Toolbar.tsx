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
import { monitor, snapshotFromAppMemory } from '../monitoring/MonitoringBus'
import { compileTransformFields, type TransformFieldSpec } from '../transforms/templateCompiler'
 import { parseExpression, ExprParseError } from '../ir/exprParser'

let abortFlag = false

// ─── Polling ──────────────────────────────────────────────────────
// Stato persistente fuori dal componente — sopravvive ai re-render
let _pollCursor   = 0
let _currentRunId = ''
let _pollInterval: ReturnType<typeof setInterval> | null = null
// Fase 9: ponte tra NodeStarted e NodeCompleted per il MonitoringBus.
// nodeStart() restituisce un NodeTiming che nodeEnd() completa per
// riferimento; lo teniamo qui in attesa del completamento del nodo.
const _nodeTimings = new Map<string, ReturnType<typeof monitor.nodeStart>>()

// Fase 10: ponte tra ConnectionOpened e Closed/Error per il MonitoringBus.
// connectionOpen() restituisce un id interno che serve a close/error.
const _connIds = new Map<string, string>()   // node_id → id connessione nel bus

// Risolve il nome leggibile della risorsa dall'id; se l'id è vuoto
// (es. nodo con risorsa non configurata) ripiega sull'etichetta del nodo.
function resourceLabel(
  store: ReturnType<typeof useFlowStore.getState>,
  resourceId: string, nodeId: string,
): string {
  if (resourceId) {
    for (const lane of store.pool.lanes) {
      const r = lane.resources.find(r => r.id === resourceId)
      if (r) return r.label
    }
    return resourceId
  }
  return store.nodes.find(n => n.id === nodeId)?.data.label ?? nodeId
}

// Mappa conn_type Rust ("db_postgresql", "ftp", …) → tipo del bus.
function connType(ct: string | undefined): 'db' | 'ftp' | 'http' | 'kafka' | 'mqtt' | 'other' {
  const t = ct ?? ''
  if (t.startsWith('db'))    return 'db'
  if (t.startsWith('ftp'))   return 'ftp'
  if (t.startsWith('http'))  return 'http'
  if (t.startsWith('kafka')) return 'kafka'
  if (t.startsWith('mqtt'))  return 'mqtt'
  return 'other'
}

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
        if (ev.event.type === 'MemorySample')
+    console.log('[mem]', new Date().toISOString().slice(11, 23), 'rss', ev.event.payload?.rss)
console.log('[evt]', ev.event.type)
        // Ignora eventi di run precedenti: il bus è append-only e
        // può contenere code di run passati — processarli riaccende
        // pallini a caso e, peggio, un vecchio RunCompleted ferma
        // il polling a metà del run corrente.
        if (p.run_id && _currentRunId && p.run_id !== _currentRunId) continue

        if (ev.event.type === 'NodeFailed') {
          console.log('[NodeFailed DOPO filtro] node_id:', JSON.stringify(p.node_id), 'run_id match:', p.run_id, '===', _currentRunId)
        }

        switch (ev.event.type) {

          case 'RunStarted':
            _nodeTimings.clear()
            monitor.runStart(p.run_id)
            break
          case 'MemorySample':
            monitor.memorySample(
              p.detail
                ? snapshotFromAppMemory(p.detail)
                : { heapUsed: p.rss, heapTotal: 0, totalRss: p.rss, timestamp: p.timestamp },
            )
            break
          case 'ConnectionOpened': {
            const id = monitor.connectionOpen(
              resourceLabel(store, p.resource_id ?? '', p.node_id),
              connType(p.conn_type),
              store.nodes.find(n => n.id === p.node_id)?.data.label ?? p.node_id,
              p.node_id,   // ← nodeId, per il raggruppamento onesto nel monitor
            )
            _connIds.set(p.node_id, id)
            break
          }
          case 'ConnectionClosed': {
            const id = _connIds.get(p.node_id)
            if (id) { monitor.connectionClose(id, p.elapsed_ms); _connIds.delete(p.node_id) }
            break
          }
          case 'ConnectionError': {
            const id = _connIds.get(p.node_id)
            if (id) { monitor.connectionError(id, p.error); _connIds.delete(p.node_id) }
            break
          }     
          case 'NodeStarted':
            store.setNodeStatus(p.node_id, 'running')
            // Fase 8: inizializza le stats — pulse giallo + contatori a 0
            store.setNodeStats(p.node_id, { status: 'running', rowsIn: 0, rowsOut: 0 })
            // Fase 9: apre il timing del nodo sul MonitoringBus (tab Nodi).
            _nodeTimings.set(
              p.node_id,
              monitor.nodeStart(
                p.node_id,
                p.label ?? p.node_id,
                store.nodes.find(n => n.id === p.node_id)?.data.type ?? 'unknown',
              ),
            )
            break
          case 'NodeCompleted':
            store.setNodeStatus(p.node_id, 'done')
            // Fase 8: congela le stats finali (verde, o rosso se error valorizzato)
            store.setNodeStats(p.node_id, {
              status:    p.stats?.error ? 'error' : 'done',
              rowsIn:    p.stats?.rows_in  ?? 0,
              rowsOut:   p.stats?.rows_out ?? 0,
              rowsRejected: p.stats?.rows_rejected ?? 0,
              throughputRps: 0,
              elapsedMs: p.stats?.elapsed_ms,
            })
            store.addLog('ok',
            `${p.node_id} — ${p.stats?.rows_in ?? 0} in → ${p.stats?.rows_out ?? 0} out, ${p.stats?.elapsed_ms ?? 0}ms`,
            p.node_id)
            {
              const timing = _nodeTimings.get(p.node_id)
              if (timing) {
                monitor.nodeEnd(timing, {
                  rowsIn:       p.stats?.rows_in,
                  rowsOut:      p.stats?.rows_out,
                  rowsRejected: p.stats?.rows_rejected,
                  error:        p.stats?.error ?? undefined,
                })
                if (p.stats?.elapsed_ms != null) timing.durationMs = p.stats.elapsed_ms
                _nodeTimings.delete(p.node_id)
              }
            }
            break
            
          case 'NodeFailed': {
            store.setNodeStatus(p.node_id, 'error', p.error)
            store.setNodeStats(p.node_id, { status: 'error' })
            store.addLog('error', `${p.node_id}: ${p.error}`, p.node_id)
            // Chiude il timing nel MonitoringBus anche su errore: senza
            // questo il nodo resta 'running' (giallo) nel pannello Monitor,
            // che si alimenta dal bus e non dallo store.
            const timing = _nodeTimings.get(p.node_id)
            if (timing) {
              monitor.nodeEnd(timing, { error: p.error })
              _nodeTimings.delete(p.node_id)
            }
            break
          }

          case 'NodeProgress':
            // Fase 8: aggiorna i badge contatori in tempo reale.
            // Il payload arriva da emit_progress: rows_in, rows_out,
            // rows_rejected, throughput_rps (snake_case da serde).
            store.setNodeStats(p.node_id, {
              status:  'running',
              rowsIn:  p.rows_in  ?? 0,
              rowsOut: p.rows_out ?? 0,
              rowsRejected:  p.rows_rejected  ?? 0,
              throughputRps: p.throughput_rps ?? 0,
            })
            break

          case 'NodeLog': {
            // Riga di log dal nodo Rust (contratto: EngineEvent::NodeLog).
            // target instrada verso LogPanel in-app e/o finestra viewer.
            // p.lane_id disponibile per future viste per-lane.
            const prefixNum = p.row_num > 0 ? `[${p.row_num}] ` : ''
            if (p.target !== 'window') {
              store.addLog(p.level, `${prefixNum}${p.message}`, p.node_id, p.lane_id)
            }
            if (p.target === 'window' || p.target === 'both_window') {
              const { useLogViewerStore } = await import('../store/useLogViewerStore')
              useLogViewerStore.getState().addRow({
                timestamp: new Date(),
                nodeId:    p.node_id,
                nodeLabel: p.node_label,
                rowNum:    p.row_num,
                message:   p.message,
                level:     p.level,
              })
            }
            break
          }

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
            monitor.runEnd()
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
            monitor.runEnd()
            stopPolling()
            break
          }
          case 'NodeOutputStats':
            store.setNodeStats(p.node_id, { perOutput: p.counts })
            break
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

// ─── Sanitizzazione log ───────────────────────────────────────────
// Il plan ora contiene le risorse risolte (password incluse): mai
// stamparle in chiaro in console.
const SECRET_KEY_RE = /password|passwd|secret|token|api[_-]?key/i

function sanitizeForLog(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeForLog)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEY_RE.test(k) && typeof v === 'string' && v !== ''
        ? '***'
        : sanitizeForLog(v)
    }
    return out
  }
  return value
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

    // Variabili della lane — solo scalari.
    // Le variabili di tipo 'materialize' NON sono valori: dichiarano che
    // un nodo pubblica un dataset con quel nome. Vanno in `datasets`, così
    // il motore può precalcolare gli slot del registro.
    const variables: Record<string, unknown> = {}
    const datasets: Array<{ name: string; node_id: string }> = []

    for (const v of laneConfig?.variables ?? []) {
      if (v.type === 'materialize') {
        datasets.push({ name: v.name, node_id: v.value })
      } else {
        variables[v.name] = v.value
      }
    }

    // Transazioni della lane (oggetti dichiarati — design v2)
    const transactions = (laneConfig?.transactions ?? []).map(tx => ({
      id:       tx.id,
      name:     tx.name,
      mode:     tx.mode,
      timeout:  tx.timeout,
      on_error: tx.onError,
    }))

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

      // Busta spec.config: parte dalla config strutturata del nodo e,
      // per i nodi con compilazione genuina (aggregate, tmap…), riceve
      // l'IR compilato sotto chiave dedicata (contratto node-spec §2,
      // docs/expr-ir-schema.md). Chi non compila la lascia invariata.
      const specConfig: Record<string, unknown> = { ...(node.data.config ?? {}) }

      // Legge la config dai props (come fanno i test manuali)
      const props = node.data.props ?? {}

      // ── Spec (fondazione §6.0): risorsa risolta genericamente ──
      // Qualunque nodo che referenzia una risorsa di lane tramite
      // config.resourceId la riceve INTERA nella spec — vale anche
      // per i connettori futuri, senza selezione di campi.
      const specResourceId = node.data.config?.resourceId as string | undefined
      const specResource   = specResourceId
        ? (laneConfig?.resources.find(r => r.id === specResourceId)?.config ?? null)
        : null
      switch (node.data.type) {

        case 'source_file': {
          // I tipi dichiarati nel mapping servono al motore per convertire
          // i valori: un CSV è tutto testo, ma `età: integer` deve produrre
          // Value::Int(45), non Value::String("45") — altrimenti `età * 5`
          // dà null (numeric_op non fa conversioni implicite).
          //
          // La chiave è il physicalName (il nome nell'header del CSV), non
          // il nome logico: source_file legge l'header e non rinomina.
          let fields: Array<{ name: string; type: string }> = []
          try {
            const raw = props['outputSchema']
            if (raw) {
              fields = (JSON.parse(raw) as Array<{ name: string; type: string; physicalName?: string }>)
                .map(f => ({ name: f.physicalName ?? f.name, type: f.type }))
            }
          } catch { /* schema assente o illeggibile: nessuna conversione */ }

          config = {
            path:       props['path']       ?? '',
            delimiter:  props['delimiter']  ?? ',',
            has_header: props['has_header'] !== 'false',
            fields,
          }
          break
        }

        case 'sink_file': {
          config = {
            path:           props['path']       ?? '/tmp/output.csv',
            format:         props['format']     ?? 'csv',
            mode:           props['mode']       ?? 'overwrite',
            write_mode:     props['writeMode2'] ?? 'rows',
            raw_field:      props['rawField']   ?? 'content',
            raw_encoding:   props['rawEncoding'] ?? 'text',
            output_mode:    props['outputMode'] ?? 'signal',
            delimiter:      props['delimiter']  ?? (props['format'] === 'tsv' ? '\\t' : ','),
            quote_char:     props['quoteChar']  ?? '"',
            write_header:   props['writeHeader'] !== 'false',
            line_ending:    props['lineEnding'] ?? 'lf',
            json_indent:    props['jsonIndent'] ?? 'none',
            json_structure: props['jsonStructure'] ?? 'array',
            encoding:       props['encoding']   ?? 'utf-8',
            partition:      props['partition']  ?? 'none',
            post_command:   props['postCommand'] ?? '',
            webhook_url:    props['webhookUrl'] ?? '',
          }
          break
        }

        case 'json_serializer': {
          const ser = (node.data.config as any)?.jsonSerializer ?? {}
          config = {
            output_field: props['outputField'] ?? 'content',
            pretty:       props['pretty'] === 'true',
            envelope:     props['envelope'] ?? '',
            null_default: props['nullDefault'] ?? 'null',
            on_error:     props['onError'] ?? 'reject',
            tree:     (() => { try { return JSON.parse(props['_treeNodes'] ?? '[]') } catch { return [] } })(),
            mappings: ser.mappings ?? {},
            inputs:   ser.inputs ?? {},
          }
          break
        }

        case 'xml_serializer': {
          const ser = (node.data.config as any)?.xmlSerializer ?? {}
          config = {
            output_field:    props['outputField']    ?? 'xml_output',
            pretty:          props['pretty'] === 'true',
            root_element:    props['rootElement']    ?? 'record',
            root_ns_prefix:  props['rootNsPrefix']   ?? '',
            root_namespace:  props['rootNamespace']  ?? '',
            namespaces:      props['namespaces']     ?? '',   // ← STRINGA "prefix=uri" per riga, NON JSON.parse
            xml_declaration: (props['xmlDeclaration'] ?? 'true') === 'true',
            encoding:        props['encoding']       ?? 'UTF-8',
            on_error:        props['onError']        ?? 'reject',
            tree:   (() => { try { return JSON.parse(props['_treeNodes']   ?? '[]') } catch { return [] } })(),
            legacy: (() => { try { return JSON.parse(props['xmlStructure'] ?? '[]') } catch { return [] } })(),
            mappings: ser.mappings ?? {},
          }
          break
        }

        
        

        case 'filter': {
          const f = (node.data.config as any)?.filter ?? {}
          config = {
            conditions:    f.conditions ?? [],
            null_behavior: f.nullBehavior ?? 'exclude',
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
        case 'transform': {
          // Compila i template/espressioni in ExprNode (FPEL → IR).
          // A differenza del tmap, un errore NON degrada a config vuota:
          // il nodo produrrebbe dati sbagliati in silenzio. Blocca il run.
          const raw = node.data.props?.['transformFields']
          if (raw) {
            let fields: TransformFieldSpec[]
            try { fields = JSON.parse(raw as string) }
            catch { throw new Error(`Transform "${node.data.label}": configurazione campi illeggibile`) }

            const { compiled, errors } = compileTransformFields(fields)
            if (errors.length > 0) {
              const dettagli = errors.map(e => `  • ${e.message}`).join('\n')
              throw new Error(`Transform "${node.data.label}" — ${errors.length} errore/i:\n${dettagli}`)
            }

            // Traduzione della scelta utente nel `mode` del motore.
            // Il pannello dice `unmappedFields` (default 'drop'), il motore
            // dice `mode` (default 'add'): DEFAULT OPPOSTI, va esplicitato.
            //   drop        → 'select'  (solo i campi configurati)
            //   passthrough → 'add'     (campi calcolati + quelli originali)
            const unmapped = (node.data.props?.['unmappedFields'] as string) ?? 'drop'
            config = {
              mode:   unmapped === 'passthrough' ? 'add' : 'select',
              fields: compiled,
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

        case 'union': {
          // Lo schema di uscita è deciso a design-time dal MappingPanel,
          // che salva la mappatura in props['unionMapping'].
          // Il motore la applica: nessuna inferenza a runtime.
          let fields: unknown[] = []
          try {
            const raw = props['unionMapping']
            if (raw) fields = JSON.parse(raw as string)
          } catch {
            throw new Error(`Union "${node.data.label}": mappatura campi illeggibile`)
          }

          // Etichette leggibili degli handle, per il campo _union_source
          const unionInputs = (node.data.config as any)?.unionInputs ?? []
          const handleLabels: Record<string, string> = { input_main: 'flusso 1' }
          for (const inp of unionInputs) {
            handleLabels[inp.id] = inp.label ?? inp.id
          }

          config = {
            mode:              props['unionMode']       ?? 'concat',
            fields,
            missing_field:     props['missingField']    ?? 'null',
            add_source_field:  props['addSourceField']  === 'true',
            source_field_name: props['sourceFieldName'] ?? '_union_source',
            zip_mismatch:      props['zipMismatch']     ?? 'truncate',
            handle_labels:     handleLabels,
            // serve all'executor per ordinare gli input (concat)
            union_inputs:      unionInputs,
          }
          break
        }
        case 'materialize': {
          // `matName` non vuoto ⇒ il dataset è pubblicato nella lane
          // (l'utente ha premuto "Pubblica nella lane" nel tab Configurazione).
          // Vuoto ⇒ il nodo è solo un buffer/barriera.
          config = {
            mode:        props['matMode']  ?? 'passthrough',
            name:        props['matName']  ?? '',
            key_field:   props['keyField'] ?? '',
            max_rows:    Number(props['maxRows'] ?? 0),
            on_overflow: props['onOverflow'] ?? 'error',
          }
          break
        }

        case 'pivot': {
          // Migrato alla spec (node-spec §10): tutte le props vanno alla
          // busta spec verbatim (incluse pivotColumns/unpivotColumns, già
          // JSON-string) e le legge il motore. `nullValue` non si tipizza
          // più qui: lo fa il motore. Qui restano SOLO le validazioni a
          // design-time (doppio strato — v. docs/design-validazione.md):
          // il motore le ri-valida come errori parlanti a runtime.
          const mode = props['pivotMode'] ?? 'pivot'

          if (mode === 'pivot' && (!props['pivotField'] || !props['valueField'])) {
            throw new Error(
              `Pivot "${node.data.label}": campo pivot e campo valore sono obbligatori.`)
          }
          if (mode === 'unpivot') {
            let cols: unknown[] = []
            try { cols = JSON.parse(props['unpivotColumns'] ?? '[]') } catch { /* vuoto */ }
            if (cols.length === 0) {
              throw new Error(
                `Pivot "${node.data.label}": seleziona almeno una colonna da ruotare (unpivot).`)
            }
          }

          // Warning non bloccante: nullValue testuale che finirà in celle
          // di una colonna probabilmente numerica. Legale (il motore lo
          // terrà come stringa), ma spesso non è ciò che l'utente intende.
          // TODO(validazione-live): emettere come ValidationIssue severity
          // 'warning' quando il canale live sarà attivo (Fase 13). Per ora
          // solo console, non blocca.
          const rawNull = String(props['nullValue'] ?? '').trim()
          if (mode === 'pivot' && rawNull !== '' &&
              !/^-?\d+(\.\d+)?$/.test(rawNull) && rawNull !== 'true' && rawNull !== 'false') {
            console.warn(
              `[pivot "${node.data.label}"] valore celle vuote "${rawNull}" è testuale: ` +
              `se le colonne pivot sono numeriche, le operazioni a valle potrebbero fallire.`)
          }
          break
        }

        // Il pannello salva tutto in props['dqConfig'] (camelCase).
// Il motore legge snake_case, e vuole le espressioni già compilate in ExprNode.

        case 'data_quality': {
          interface DQRuleRaw {
            id: string; field: string; label?: string
            dimension: string; severity?: string; enabled?: boolean
            checkType: string
            pattern?: string; min?: string; max?: string; list?: string
            matName?: string; refField?: string
            compareField?: string; compareOp?: string
            expression?: string
            repair?: string
            repairDefault?: string; repairField?: string
            repairFields?: string; repairSeparator?: string
            repairExpression?: string
          }

          let raw: {
            rules?: DQRuleRaw[]
            weights?: Record<string, number>
            thresholds?: Record<string, number>
            outputField?: string
            showOriginal?: boolean
            scoreBeforeRepair?: boolean
          } = {}

          try {
            const s = props['dqConfig']
            if (s) raw = JSON.parse(s as string)
          } catch {
            throw new Error(`Data Quality "${node.data.label}": configurazione illeggibile`)
          }

          const rules = (raw.rules ?? []).map((r) => {
            const out: Record<string, unknown> = {
              id:         r.id,
              field:      r.field,
              label:      r.label ?? '',
              dimension:  r.dimension,
              severity:   r.severity ?? 'error',
              enabled:    r.enabled !== false,
              check_type: r.checkType,
              pattern:       r.pattern       ?? '',
              min:           r.min           ?? '',
              max:           r.max           ?? '',
              list:          r.list          ?? '',
              mat_name:      r.matName       ?? '',
              ref_field:     r.refField      ?? '',
              compare_field: r.compareField  ?? '',
              compare_op:    r.compareOp     ?? '',
              repair:           r.repair          ?? 'none',
              repair_default:   r.repairDefault   ?? '',
              repair_field:     r.repairField     ?? '',
              repair_fields:    r.repairFields    ?? '',
              repair_separator: r.repairSeparator ?? ' ',
            }

            // `custom` e il repair `expression` sono FPEL, non JavaScript:
            // il motore non esegue JS, e il codegen deve poterli tradurre.
            const compile = (src: string | undefined, what: string) => {
              if (!src?.trim()) {
                throw new Error(
                  `Data Quality "${node.data.label}", regola "${r.label || r.id}": ` +
                  `${what} richiede un'espressione.`)
              }
              try { return parseExpression(src) }
              catch (e) {
                const detail = e instanceof ExprParseError ? e.pretty() : String(e)
                throw new Error(
                  `Data Quality "${node.data.label}", regola "${r.label || r.id}":\n${detail}`)
              }
            }

            if (r.checkType === 'custom') out.expression = compile(r.expression, "il check 'custom'")
            if (r.repair === 'expression') out.repair_expression = compile(r.repairExpression, "il repair 'expression'")

            if (r.repair === 'lookup_from_file') {
              throw new Error(
                `Data Quality "${node.data.label}", regola "${r.label || r.id}": ` +
                `il lookup da file non è supportato. Carica il file con ` +
                `source_file → materialize("tabella") e usa "lookup_from_materialize".`)
            }

            return out
          })

          const w = raw.weights ?? {}
          const t = raw.thresholds ?? {}

          // Approccio A: l'intero DqConfig (rules con IR + pesi/soglie +
          // scalari) va in spec.config come unità — data_quality non ha
          // props scalari verbatim, la sua config è un blob elaborato dal
          // builder. Il motore legge tutto da spec.config().
          specConfig.rules = rules
          specConfig.weights = {
            completeness: w.completeness ?? 0.30,
            conformity:   w.conformity   ?? 0.30,
            consistency:  w.consistency  ?? 0.20,
            accuracy:     w.accuracy     ?? 0.20,
          }
          specConfig.thresholds = {
            valid:   t.valid   ?? 0.80,
            warning: t.warning ?? 0.60,
          }
          specConfig.output_field        = raw.outputField ?? '_dq'
          specConfig.show_original       = raw.showOriginal === true
          specConfig.score_before_repair = raw.scoreBeforeRepair === true
          break
        }
        
  
       // Il nodo girava con config vuota: group_by e aggregations assenti.

        case 'aggregate': {
          interface AggFnRaw {
            id: string; field: string; fn: string; alias: string
            filter?: string; separator?: string
          }

          let fns: AggFnRaw[] = []
          try {
            const raw = props['aggFunctions']
            if (raw) fns = JSON.parse(raw as string)
          } catch {
            throw new Error(`Aggregate "${node.data.label}": configurazione funzioni illeggibile`)
          }

          if (fns.length === 0) {
            throw new Error(
              `Aggregate "${node.data.label}": nessuna funzione di aggregazione. ` +
              `Apri il tab Mapping e aggiungine almeno una.`)
          }

          // Le finestre temporali hanno un modello di esecuzione opposto
          // (streaming, emettono a finestra chiusa). Non stanno in aggregate.
          const win = props['window'] ?? 'none'
          if (win !== 'none' && win !== '') {
            throw new Error(
              `Aggregate "${node.data.label}": le finestre temporali non sono ` +
              `supportate da questo nodo. Aggregate collassa le righe in gruppi ` +
              `(GROUP BY) e materializza. Per le finestre serve un nodo dedicato.`)
          }

          // `having` e i `filter` sono FPEL: lo studio li compila in IR
          // (ExprNode). Il motore non compila FPEL — esegue l'IR.
          const compile = (src: string, what: string) => {
            try { return parseExpression(src) }
            catch (e) {
              const detail = e instanceof ExprParseError ? e.pretty() : String(e)
              throw new Error(`Aggregate "${node.data.label}", ${what}:\n${detail}`)
            }
          }

          const functions = fns.map((f) => {
            const out: Record<string, unknown> = {
              field:     f.field ?? '',
              fn:        f.fn,
              alias:     f.alias || `${f.fn}_${f.field || 'all'}`,
              separator: f.separator ?? ', ',
            }
            if (f.filter?.trim()) {
              out.filter = compile(f.filter, `il filtro di "${f.alias || f.fn}"`)
            }
            return out
          })

          const havingSrc = String(props['having'] ?? '').trim()

          // Opzione 1 (node-spec §2): l'IR compilato va in spec.config,
          // sotto chiave dedicata. Gli scalari (dataSource, group_by,
          // orderBy, limit, nullGroups) restano props verbatim e li legge
          // il motore via Spec. Niente più `config` legacy per aggregate.
          specConfig.functions = functions
          if (havingSrc) {
            specConfig.having = compile(havingSrc, 'la clausola HAVING')
          }
          break
        }
 
// Il nodo window non riceveva NESSUNA config: girava con i default e
// produceva risultati sbagliati in silenzio.

        case 'window': {
          interface WindowDefRaw {
            id: string; fn: string; field?: string
            offset?: number; n?: number; expr?: string
            outputField: string; nullDefault?: string
          }

          let defs: WindowDefRaw[] = []
          try {
            const raw = props['windows']
            if (raw) defs = JSON.parse(raw as string)
          } catch {
            throw new Error(`Window "${node.data.label}": configurazione funzioni illeggibile`)
          }

          if (defs.length === 0) {
            throw new Error(
              `Window "${node.data.label}": nessuna funzione configurata. ` +
              `Apri il tab Mapping e aggiungine almeno una.`)
          }

          // `streak` prende una condizione, che l'utente scrive in FPEL
          // (es. "amount > 0"). Va compilata in ExprNode: il motore non
          // esegue JavaScript, e il codegen deve poterla tradurre.
          const windows = defs.map((d) => {
            const out: Record<string, unknown> = {
              fn:           d.fn,
              field:        d.field ?? '',
              output_field: d.outputField || `win_${d.fn}`,
            }
            if (d.offset      !== undefined) out.offset       = d.offset
            if (d.n           !== undefined) out.n            = d.n
            if (d.nullDefault !== undefined && d.nullDefault !== '') {
              out.null_default = d.nullDefault
            }

            if (d.fn === 'streak') {
              if (!d.expr?.trim()) {
                throw new Error(
                  `Window "${node.data.label}", campo "${d.outputField}": ` +
                  `la funzione streak richiede una condizione (es. amount > 0)`)
              }
              try {
                out.expr = parseExpression(d.expr)
              } catch (e) {
                const detail = e instanceof ExprParseError ? e.pretty() : String(e)
                throw new Error(
                  `Window "${node.data.label}", condizione di "${d.outputField}":\n${detail}`)
              }
            }
            return out
          })

             // Il pannello salva partitionBy come stringa "campo1, campo2".
          // Va nelle props (scalare), non qui. `windows` (con l'IR di
          // streak) va in spec.config — Opzione 1, come aggregate.
          // Scalari (dataSource, partitionBy, orderBy, orderDir) restano
          // props verbatim e li legge il motore via Spec.
          specConfig.windows = windows
          break
        }




        default:
          config = {}
      }

      return {
        node_id:   node.id,
        node_type: node.data.type,
        label:     node.data.config?.displayName || node.data.label || node.data.type,
        config,    // LEGACY: selezione per-tipo — sarà rimossa a fine migrazione
        // ── Spec completa (contratto: docs/node-spec.md) ──────────
        //Il motore Rust attuale la ignora… Passo 2" 
        spec: {
          version:    1,
          props:      { ...props },
          config:     specConfig,
          resource:   specResource,
          resourceId: specResourceId ?? '',
        },
      }
    })

    return {
      lane_id:   laneId,
      label:     laneConfig?.label ?? laneId,
      nodes:     rustNodes,
      edges:     laneEdges,   // v6: il wiring dell'executor segue gli edges
      variables,
      transactions,   // ← aggiungi
      datasets,      // ← aggiungi
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

    // Costruisce il Plan JSON per Rust. Un errore di compilazione
    // (espressione invalida, template sconosciuto…) blocca il run:
    // meglio non partire che produrre dati sbagliati.
    let plan
    try {
      plan = buildRustPlan(nodes, edges, pool, runId)
    } catch (e) {
      addLog('error', `Compilazione del flusso fallita:\n${(e as Error).message}`)
      setRunning(false)   // ← adatta al nome reale dello stato "in corso"
      return
    }
    // ← AGGIUNGI QUI
    console.log('[buildRustPlan] plan:', JSON.stringify(sanitizeForLog(plan), null, 2))
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