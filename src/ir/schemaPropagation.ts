/**
 * src/ir/schemaPropagation.ts
 * ────────────────────────────
 * Motore unificato di propagazione schema — Step 7 della migrazione.
 *
 * Sostituisce progressivamente la propagazione attuale basata su
 * chiamate dirette nodo-nodo (schemaUtils.ts + onConnect + saveConfig).
 *
 * COME FUNZIONA:
 *   1. Riceve il LogicalPlan con nodi e edge
 *   2. Fa un traversal topologico (sorgenti → sink)
 *   3. Per ogni nodo, calcola lo schema output a partire dallo schema
 *      degli edge in ingresso e dalla config del nodo
 *   4. Scrive lo schema sugli edge in uscita
 *   5. Restituisce il piano annotato + eventuali errori di schema
 *
 * È una funzione pura: nessun side effect, nessun accesso allo store.
 * Lo store applica i risultati dopo.
 *
 * INTEGRAZIONE CON IL SISTEMA ATTUALE:
 *   Espone anche propagateSchemaFromCanvas() che opera sui nodi
 *   React Flow direttamente — retrocompatibile con schemaUtils.ts.
 *   Permette la migrazione graduale senza rompere nulla.
 */

import type { Node as FlowNode, Edge } from '@xyflow/react'
import { aggOutputType } from './aggFunctions'
import type { NodeData, TMapConfig } from '../types'
import type {
  LogicalPlan,
  LogicalNode,
  LogicalEdge,
  SchemaField,
  PortSpec,
  ValidationIssue,
} from './types'
import { topologicalSort, canvasNodeId } from './lowering'
import { getNodeSemantics } from './nodeSemantics'
import type { JsonParserConfig } from '../nodes/types/json_parser/jsonParserTypes'
import type { XmlParserConfig }  from '../nodes/types/xml_parser/xmlParserTypes'

// ─────────────────────────────────────────────────────────────────
// RISULTATO PROPAGAZIONE
// ─────────────────────────────────────────────────────────────────

export interface PropagationResult {
  /** Piano logico con schema popolato su nodi e edge */
  plan:   LogicalPlan
  /** Errori e warning rilevati durante la propagazione */
  issues: ValidationIssue[]
}

// ─────────────────────────────────────────────────────────────────
// INFERENZA SCHEMA PER OPERAZIONE LOGICA
// ─────────────────────────────────────────────────────────────────

/**
 * Calcola lo schema output di un nodo logico dato lo schema
 * degli edge in ingresso.
 *
 * Ogni operazione logica ha regole precise su come trasforma lo schema:
 * - scan:       schema definito dalla config sorgente
 * - filter:     schema identico all'input (non aggiunge/rimuove campi)
 * - projection: sottoinsieme + campi calcolati
 * - join:       unione dei due schemi
 * - aggregate:  campi group-by + campi aggregati
 * - parse:      schema definito nel parser config (per flusso)
 * - sink:       nessun output
 */
function inferOutputSchema(
  node:        LogicalNode,
  inputSchema: SchemaField[],
): SchemaField[] {

  const config = (node._uiRef?.config ?? {}) as any
  // I dati grezzi del pannello (incl. outputSchema) vivono in props, NON in
  // config: updateNodeProp scrive in node.data.props, e il lowering li porta
  // come _uiRef.props (fratello di _uiRef.config). Leggere outputSchema da
  // config dava sempre undefined → sorgenti "vuote" → cascata di falsi warning.
  const props  = (node._uiRef?.props ?? {}) as any
  const uiType = node._uiRef?.type

  switch (node.operation) {

     case 'scan': {
      // Lo schema di una sorgente vive in props.outputSchema (scritto dal
      // pannello via updateNodeProp). Fallback difensivo sui vecchi percorsi.
      try {
        const raw = props?.outputSchema
          ?? (config as any)?.props?.outputSchema
          ?? (config as any)?.outputSchema
        if (raw) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed) && parsed.length > 0) {
            return normalizeSchema(parsed)
          }
        }
      } catch {}
      // Fallback: schema vuoto (sarà popolato dall'utente o dal test connessione)
      return []
    }

    case 'filter': {
      // Il filtro non cambia lo schema — passa tutto
      return inputSchema
    }

    case 'projection': {
      // Costruisce lo schema dall'output della config del nodo
      // Per map: usa le mappings
      const mappings = config?.mappings
      if (Array.isArray(mappings) && mappings.length > 0) {
        return mappings
          .filter((m: any) => m.targetField)
          .map((m: any, i: number): SchemaField => ({
            id:           m.id ?? `proj_${i}`,
            name:         m.targetField,
            type:         'string', // tipo da inferire dall'espressione (futuro)
            physicalName: m.sourceField,
          }))
      }
      // TMap projection: usa i fields degli output
      const tmap = config?.tmap as TMapConfig | undefined
      if (tmap?.outputs?.length) {
        // Restituisce lo schema del primo output non-reject
        const mainOut = tmap.outputs.find((o) => !o.id.includes('rejected'))
        if (mainOut?.fields.length) {
          return mainOut.fields
            .filter((f) => f.name.length > 0)
            .map((f): SchemaField => ({
              id:   f.id,
              name: f.name,
              type: f.type as any,
            }))
        }
      }
      // Fallback: passa lo schema in ingresso
      return inputSchema
    }

    case 'join': {
      // Unione degli schemi di tutti gli input
      // I campi con lo stesso nome vengono mantenuti una volta sola
      const seen = new Set<string>()
      return inputSchema.filter((f) => {
        if (seen.has(f.name)) return false
        seen.add(f.name)
        return true
      })
    }

    case 'aggregate': {
      // Tre nodi UI diversi finiscono qui — materialize, pivot e aggregate
      // hanno tutti operations: ['aggregate'] — ma il loro schema di uscita
      // si deriva in tre modi diversi. Smistare per operazione era troppo
      // grosso: il vecchio placeholder tirava a indovinare sui NOMI dei
      // campi in ingresso (cercava 'sum', 'count', 'avg'…) e con campi
      // normali restituiva [], scatenando "non riceve campi" su tutta la
      // catena a valle. La derivazione vera esisteva già — nei pannelli.

      // materialize bufferizza e basta: lo schema esce com'è entrato.
      if (uiType === 'materialize') return inputSchema

      // pivot: lo schema lo calcola il suo pannello e lo persiste in
      // props.outputSchema. Il marcatore __pivot_dynamic__ significa
      // "colonne note solo a runtime": va propagato com'è, perché è una
      // risposta ("non conoscibile"), non un vuoto — se lo appiattissimo
      // a [] tornerebbe la cascata di falsi warning.
      if (uiType === 'pivot') {
        const raw = props['outputSchema']
        if (raw) {
          try {
            const parsed = JSON.parse(String(raw))
            if (Array.isArray(parsed) && parsed.length > 0) return parsed as SchemaField[]
          } catch { /* schema illeggibile → ricadi sull'ingresso */ }
        }
        return inputSchema
      }

      // aggregate: group_by + funzioni configurate. Stessa derivazione del
      // suo MappingPanel, che era l'unico posto dove fosse scritta giusta.
      const groupBy = String(props['group_by'] ?? '')
        .split(',').map((x: string) => x.trim()).filter(Boolean)

      let aggFns: Array<{ fn: string; field: string; alias: string }> = []
      try {
        const parsed = JSON.parse(String(props['aggFunctions'] ?? '[]'))
        if (Array.isArray(parsed)) aggFns = parsed
      } catch { /* config illeggibile */ }

      // Non ancora configurato: meglio l'ingresso che il vuoto. Sbagliato
      // per eccesso non genera allarmi; il vuoto sì, e a catena.
      if (groupBy.length === 0 && aggFns.length === 0) return inputSchema

      return [
        ...groupBy.map((name: string): SchemaField => {
          const incoming = inputSchema.find((f) => f.name === name)
          return {
            id:           incoming?.id ?? `agg_grp_${name}`,
            name,
            type:         incoming?.type ?? 'string',
            physicalName: incoming?.physicalName ?? name,
          }
        }),
        ...aggFns.map((a, i): SchemaField => {
          const alias = a.alias || `${a.fn}_result`
          return {
            id:           `agg_fn_${i}_${alias}`,
            name:         alias,
            type:         aggOutputType(a.fn),
            physicalName: alias,
          }
        }),
      ]
    }

    case 'transform': {
      // Script: schema dichiarato esplicitamente in props.outputSchema
      try {
        const raw = props?.outputSchema ?? config?.props?.outputSchema
        if (raw) {
          const parsed = JSON.parse(raw)
          if (Array.isArray(parsed)) return normalizeSchema(parsed)
        }
      } catch {}
      return inputSchema
    }

    case 'parse': {
      // json_parser / xml_parser: schema per flusso
      // Gestito dal buildOutputPortSchemas (multi-output)
      return inputSchema
    }

    case 'lane_boundary': {
      // Le lane comunicano SOLO via canale: un bridge_in non ha archi in
      // ingresso, quindi nel `default` (return inputSchema) restituiva
      // sempre il vuoto — e tutta la lane a valle risultava senza campi.
      // Nella sua lane il bridge_in è a tutti gli effetti una SORGENTE:
      // il suo schema è quello in props.outputSchema, che dallo Step 4
      // è DERIVATO dal BridgeOut del canale.
      if (uiType === 'bridge_in') {
        try {
          const raw = props['outputSchema']
          if (raw) {
            const parsed = JSON.parse(String(raw))
            if (Array.isArray(parsed)) return normalizeSchema(parsed)
          }
        } catch { /* schema illeggibile */ }
        return []
      }
      // bridge_out consuma il flusso e non emette verso la lane;
      // lane_start/lane_end sono marcatori. Per tutti, l'ingresso.
      return inputSchema
    }

    case 'sink': {
      // I sink non producono output (eccetto passthrough opzionale)
      return []
    }

    case 'branch': {
      // TMap: output diversi per ogni porta
      // Gestito da buildOutputPortSchemas
      return inputSchema
    }

    case 'union':
    case 'sort':
    case 'limit':
    case 'window':
    case 'merge':
    default:
      return inputSchema
  }
}

/**
 * Calcola lo schema per ogni porta di output di un nodo,
 * gestendo i nodi con output multipli (tmap, json_parser, xml_parser).
 *
 * Restituisce una mappa portId → SchemaField[]
 */
function buildOutputPortSchemas(
  node:        LogicalNode,
  inputSchema: SchemaField[],
): Map<string, SchemaField[]> {

  const result = new Map<string, SchemaField[]>()
  const config = (node._uiRef?.config ?? {}) as any

  // ── TMap: uno schema per output ──────────────────────────────
  const tmap = config?.tmap as TMapConfig | undefined
  if (tmap?.outputs?.length && node.outputs.length > 0) {
    node.outputs.forEach((port) => {
      if (port.isReject) {
        result.set(port.id, inputSchema)
        return
      }
      const tmapOut = tmap.outputs.find((o) => o.id === port.id)
      if (tmapOut?.fields.length) {
        result.set(port.id, tmapOut.fields
          .filter((f) => f.name.length > 0)
          .map((f): SchemaField => ({
            id:   f.id,
            name: f.name,
            type: f.type as any,
          }))
        )
      } else {
        result.set(port.id, inputSchema)
      }
    })
    return result
  }

  // ── JSON Parser: uno schema per flusso ───────────────────────
  const jsonCfg = config?.jsonParser as JsonParserConfig | undefined
  if (jsonCfg?.flows?.length) {
    jsonCfg.flows.forEach((flow) => {
      result.set(flow.id, flow.fields.map((f): SchemaField => ({
        id:   f.id,
        name: f.name,
        type: f.type as any,
      })))
    })
    if (jsonCfg.hasReject) {
      result.set('reject', inputSchema)
    }
    return result
  }

  // ── XML Parser: uno schema per flusso ────────────────────────
  const xmlCfg = config?.xmlParser as XmlParserConfig | undefined
  if (xmlCfg?.flows?.length) {
    xmlCfg.flows.forEach((flow) => {
      result.set(flow.id, flow.fields.map((f): SchemaField => ({
        id:   f.id,
        name: f.name,
        type: f.type as any,
      })))
    })
    if (xmlCfg.hasReject) {
      result.set('reject', inputSchema)
    }
    return result
  }

  // ── Nodo generico: schema unico su tutte le porte output ─────
  const defaultSchema = inferOutputSchema(node, inputSchema)
  node.outputs.forEach((port) => {
    result.set(port.id, port.isReject ? [] : defaultSchema)
  })

  return result
}

// ─────────────────────────────────────────────────────────────────
// NORMALIZZAZIONE SCHEMA
// ─────────────────────────────────────────────────────────────────

/**
 * Normalizza un array di campi grezzi (da JSON.parse o da props)
 * verso SchemaField[] con id stabile.
 */
function normalizeSchema(raw: any[]): SchemaField[] {
  return raw.map((f: any, i: number): SchemaField => ({
    id:           f.id ?? f.name ?? `field_${i}`,
    name:         f.name ?? f.sourceField ?? f.outputName ?? `campo_${i}`,
    type:         f.type ?? 'string',
    physicalName: f.physicalName ?? f.name,
    nullable:     f.nullable,
  })).filter((f) => f.name.length > 0)
}

/**
 * Unisce due schemi eliminando duplicati per nome.
 * Mantiene il campo esistente in caso di conflitto.
 */
function mergeSchemas(base: SchemaField[], incoming: SchemaField[]): SchemaField[] {
  const existingNames = new Set(base.map((f) => f.name))
  const newFields     = incoming.filter((f) => !existingNames.has(f.name))
  return [...base, ...newFields]
}

// ─────────────────────────────────────────────────────────────────
// PROPAGAZIONE PRINCIPALE
// ─────────────────────────────────────────────────────────────────

/**
 * Propaga lo schema attraverso il piano logico.
 *
 * Algoritmo: traversal topologico BFS
 *   per ogni nodo in ordine topologico:
 *     1. Raccoglie gli schema degli edge in ingresso
 *     2. Calcola lo schema output per ogni porta
 *     3. Scrive lo schema sugli edge in uscita
 *     4. Aggiorna il nodo con input/output schema calcolati
 *
 * @returns Piano logico con schema popolato + eventuali issue
 */
export function propagateSchema(plan: LogicalPlan): PropagationResult {
  const issues: ValidationIssue[] = []

  // Ordinamento topologico
  const sorted = topologicalSort(plan)
  if (!sorted) {
    return {
      plan,
      issues: [{
        code:     'CYCLE_DETECTED',
        message:  'Il DAG contiene un ciclo — impossibile propagare lo schema',
        severity: 'error',
      }],
    }
  }

  // Lavoriamo su copie mutabili di nodi e edge
  const nodeMap = new Map<string, LogicalNode>(
    plan.nodes.map((n) => [n.id, { ...n, schema: { input: [], output: [] } }])
  )
  const edgeMap = new Map<string, LogicalEdge>(
    plan.edges.map((e) => [e.id, { ...e, schema: [], lineage: [] }])
  )

  for (const node of sorted) {
    const current = nodeMap.get(node.id)!

    // ── 1. Raccoglie schema in ingresso ──────────────────────
    const inEdges = plan.edges.filter((e) => e.target === node.id)

    // Schema aggregato di tutti gli input
    let inputSchema: SchemaField[] = []
    inEdges.forEach((e) => {
      const edgeSchema = edgeMap.get(e.id)?.schema ?? []
      inputSchema = mergeSchemas(inputSchema, edgeSchema)
    })

    // Aggiorna schema input del nodo
    nodeMap.set(node.id, {
      ...current,
      schema: { ...current.schema, input: inputSchema },
    })

    // ── 2. Calcola schema output per ogni porta ───────────────
    const portSchemas = buildOutputPortSchemas(current, inputSchema)

    // Schema output aggregato (unione di tutte le porte non-reject)
    let outputSchema: SchemaField[] = []
    portSchemas.forEach((schema, portId) => {
      const port = current.outputs.find((p) => p.id === portId)
      if (!port?.isReject) {
        outputSchema = mergeSchemas(outputSchema, schema)
      }
    })

    // Aggiorna schema output del nodo
    nodeMap.set(node.id, {
      ...nodeMap.get(node.id)!,
      schema: { input: inputSchema, output: outputSchema },
      // Aggiorna anche le PortSpec con lo schema calcolato
      outputs: current.outputs.map((port) => ({
        ...port,
        schema: portSchemas.get(port.id) ?? [],
      })),
    })

    // ── 3. Propaga schema sugli edge in uscita ────────────────
    const outEdges = plan.edges.filter((e) => e.source === node.id)
    outEdges.forEach((e) => {
      const portSchema = portSchemas.get(e.sourcePort) ?? outputSchema
      edgeMap.set(e.id, {
        ...edgeMap.get(e.id)!,
        schema: portSchema,
      })
    })

    // ── 4. Validazione schema ─────────────────────────────────
    // Un arco può portare DATI o un SEGNALE di innesco (lane_start → …,
    // Script → sorgente). Su un arco di segnale i campi non ci devono
    // essere: pretenderli genera falsi allarmi su flussi corretti.
    const dataInEdges = inEdges.filter((e) => {
      const src = nodeMap.get(e.source) ?? plan.nodes.find((n) => n.id === e.source)
      const port = src?.outputs.find((p) => p.id === e.sourcePort)
      return (port?.role ?? 'data') !== 'signal'
    })
    validateNodeSchema(current, inputSchema, outputSchema, issues, dataInEdges.length)
  }

  // Ricostruisce il piano con nodi e edge aggiornati
  const updatedPlan: LogicalPlan = {
    ...plan,
    nodes: plan.nodes.map((n) => nodeMap.get(n.id) ?? n),
    edges: plan.edges.map((e) => edgeMap.get(e.id) ?? e),
  }

  return { plan: updatedPlan, issues }
}

// ─────────────────────────────────────────────────────────────────
// VALIDAZIONE SCHEMA
// ─────────────────────────────────────────────────────────────────

function validateNodeSchema(
  node:         LogicalNode,
  inputSchema:  SchemaField[],
  outputSchema: SchemaField[],
  issues:       ValidationIssue[],
  /** Quanti archi in ingresso portano DATI (non segnali di innesco). */
  dataInEdgeCount: number = node.inputs.length,
): void {

  const canvasId = canvasNodeId(node.id)

  // Sorgenti senza schema output → warning
  if (['scan'].includes(node.operation) && outputSchema.length === 0) {
    issues.push({
      nodeId:   canvasId,
      code:     'EMPTY_OUTPUT_SCHEMA',
      message:  `Il nodo "${node._uiRef?.label ?? canvasId}" non ha campi output definiti`,
      severity: 'warning',
      hint:     'Configura i campi nel pannello del nodo o usa "Test connessione" per rilevarli automaticamente',
    })
  }

  // Nodi con input DATI ma senza schema in ingresso → warning.
  // Qui c'era anche `node.operation !== 'scan'`: facevo tacere TUTTE le
  // sorgenti, sul presupposto che "i dati se li prendono da fuori".
  // Presupposto sbagliato: un source_file può ricevere da monte il path
  // del file, un source_db la query. Quell'eccezione zittiva un guasto
  // vero (la sorgente aspetta il path e non arriva) per curare un falso
  // positivo — cioè barattava un allarme di troppo con uno mancante, che
  // è il peggiore dei due. La distinzione giusta non è nella sorgente:
  // è nel PRODUTTORE, che ora dichiara se emette dati o un innesco.
  if (dataInEdgeCount > 0 && inputSchema.length === 0) {
    issues.push({
      nodeId:   canvasId,
      code:     'EMPTY_INPUT_SCHEMA',
      message:  `Il nodo "${node._uiRef?.label ?? canvasId}" non riceve campi in ingresso`,
      severity: 'warning',
      hint:     'Verifica che il nodo sorgente abbia lo schema definito',
    })
  }

  // Aggregazione senza input → errore
  if (node.operation === 'aggregate' && inputSchema.length === 0) {
    issues.push({
      nodeId:   canvasId,
      code:     'AGGREGATE_NO_INPUT',
      message:  `Aggregazione senza campi input`,
      severity: 'error',
    })
  }
  // ── Warning: schema mismatch dopo lock manuale ────────────────
  const uiProps = (node._uiRef as any)?.props ?? {}
  if (uiProps['_schemaLocked'] === 'true' && inputSchema.length > 0 && outputSchema.length > 0) {
    const outputNames = new Set(outputSchema.map((f) => f.name))
    const inputNames  = new Set(inputSchema.map((f) => f.name))
    const stale = outputSchema.filter((f) => f.physicalName && !inputNames.has(f.physicalName)).map((f) => f.name)
    const newIn = inputSchema.filter((f) => !outputNames.has(f.name)).map((f) => f.name)
    if (stale.length > 0) {
      issues.push({
        nodeId: canvasNodeId(node.id), code: 'SCHEMA_MISMATCH',
        message: `${stale.length} campo/i di output riferiscono sorgenti non più disponibili: ${stale.slice(0,3).join(', ')}${stale.length > 3 ? '…' : ''}`,
        severity: 'warning',
        hint: 'Lo schema sorgente è cambiato. Aggiorna il mapping di output.',
      })
    } else if (newIn.length > 0) {
      issues.push({
        nodeId: canvasNodeId(node.id), code: 'SCHEMA_NEW_FIELDS',
        message: `${newIn.length} nuovo/i campo/i in ingresso non mappato/i: ${newIn.slice(0,3).join(', ')}${newIn.length > 3 ? '…' : ''}`,
        severity: 'warning',
        hint: 'Nuovi campi disponibili dal sorgente. Valuta se aggiungerli.',
      })
    }
  }

  // ── Warning json_serializer senza mapping ─────────────────────
  if (node._uiRef?.type === 'json_serializer') {
    const serConfig = (node._uiRef?.config as any)?.jsonSerializer
    const hasMappings = serConfig?.mappings && Object.keys(serConfig.mappings).length > 0
    if (!hasMappings && inputSchema.length > 0) {
      issues.push({
        nodeId: canvasNodeId(node.id), code: 'SERIALIZER_NO_MAPPING',
        message: `JSON Serializer "${node._uiRef?.label ?? canvasNodeId(node.id)}": nessun campo mappato`,
        severity: 'warning',
        hint: 'Apri il configuratore e mappa i campi di ingresso.',
      })
    }
  }
}

// ─────────────────────────────────────────────────────────────────
// BRIDGE — retrocompatibilità con schemaUtils.ts
// ─────────────────────────────────────────────────────────────────

/**
 * Versione retrocompatibile che opera sui nodi React Flow.
 *
 * Usa la stessa logica del motore IR ma lavora direttamente
 * con i nodi e edge del canvas — senza richiedere che il Lowerer
 * sia già stato eseguito.
 *
 * Usato durante la migrazione graduale: le chiamate a
 * propagateSchema() in schemaUtils.ts e onConnect vengono
 * progressivamente sostituite da chiamate a questa funzione,
 * che a sua volta chiama il motore IR.
 *
 * Quando la migrazione è completa, questa funzione sparisce
 * e rimane solo propagateSchema() sull'IR.
 */
export function propagateSchemaFromCanvas(
  sourceNodeId: string,
  fields:       SchemaField[],
  nodes:        FlowNode<NodeData>[],
  edges:        Edge[],
  excludeHandles: string[] = ['reject'],
): CanvasPropagationResult {

  const results: CanvasPropagationResult = {
    tmapUpdates:    [],
    schemaUpdates:  [],
  }

  const outEdges = edges.filter((e) =>
    e.source === sourceNodeId &&
    !excludeHandles.includes(e.sourceHandle ?? '')
  )

  outEdges.forEach((edge) => {
    const tgt = nodes.find((n) => n.id === edge.target)
    if (!tgt) return

    if (tgt.data.type === 'tmap') {
      // Aggiornamento TMap — calcola merge e restituisce patch
      const tmap  = tgt.data.config?.tmap as TMapConfig | undefined
      if (!tmap) return

      let input = tmap.inputs.find((i) => i.id === edge.targetHandle)
      if (!input) input = tmap.inputs.find((i) => i.isMain)
      if (!input) input = tmap.inputs[0]
      if (!input) return

      // Merge intelligente mantenendo campi esistenti
      const existingNames = new Set(input.fields.map((f) => f.name))
      const newFields = fields.filter((f) => !existingNames.has(f.name))

      if (newFields.length > 0 || fields.some((f) => {
        const existing = input!.fields.find((ef) => ef.id === f.id)
        return existing && existing.type !== f.type
      })) {
        results.tmapUpdates.push({
          nodeId:  tgt.id,
          inputId: input.id,
          fields:  mergeSchemaFields(input.fields, fields),
        })
      }
    } else {
      // Per altri nodi: aggiorna outputSchema nei props
      results.schemaUpdates.push({
        nodeId: tgt.id,
        schema: JSON.stringify(fields),
      })
    }
  })

  return results
}

/** Risultato della propagazione sul canvas */
export interface CanvasPropagationResult {
  /** Aggiornamenti da applicare agli input TMap */
  tmapUpdates: Array<{
    nodeId:  string
    inputId: string
    fields:  any[]
  }>
  /** Aggiornamenti da applicare ai props dei nodi */
  schemaUpdates: Array<{
    nodeId: string
    schema: string
  }>
}

/** Merge di campi TMap — mantiene campi esistenti, aggiunge nuovi */
function mergeSchemaFields(
  existing: any[],
  incoming: SchemaField[],
): any[] {
  const existingById   = new Map(existing.map((f) => [f.id,   f]))
  const existingByName = new Map(existing.map((f) => [f.name, f]))

  // Aggiorna campi esistenti (per id o nome)
  const updated = existing.map((f) => {
    const byId   = incoming.find((nf) => nf.id === f.id)
    const byName = incoming.find((nf) => nf.name === f.name)
    const match  = byId ?? byName
    if (match) return { ...f, type: match.type, physicalName: match.physicalName ?? f.physicalName }
    return f
  })

  // Aggiungi nuovi campi
  const newFields = incoming.filter((f) =>
    !existingById.has(f.id) && !existingByName.has(f.name)
  ).map((f) => ({
    id:           f.id,
    name:         f.name,
    type:         f.type,
    physicalName: f.physicalName ?? f.name,
  }))

  return [...updated, ...newFields]
}