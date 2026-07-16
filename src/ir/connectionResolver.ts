/**
 * src/ir/connectionResolver.ts
 */

import type { Node as FlowNode, Edge, Connection } from '@xyflow/react'
import type { NodeData, TMapConfig, TMapInput, TMapInputField } from '../types'
import { inferSchema, mergeSchema } from '../nodes/schemaInference'

/** Ingresso dinamico dichiarato: id + etichetta + colore. NIENTE schema
 *  qui dentro — lo schema si deriva, non si copia (era la trappola di
 *  `SerInput`, che portava anche i `fields`). */
export interface SerializerInput { id: string; label: string; color: string }

const SERIALIZER_FLOW_COLORS = ['#4ec9b0', '#569cd6', '#c586c0', '#dcdcaa', '#ce9178', '#9cdcfe']

const UNION_FLOW_COLORS = [
  '#a78bfa', '#4a9eff', '#3ddc84', '#ffb347',
  '#22d3ee', '#f97316', '#ff5f57', '#84cc16',
]

export interface ConnectionResolution {
  valid:                boolean
  rejectionReason?:     string
  resolvedTargetHandle: string
  edgeLabel?:           string
  tmapUpdate?: {
    targetNodeId: string
    newInput?:    TMapInput
    updateInput?: { inputId: string; fields: TMapInputField[] }
  }
  unionUpdate?: {
    targetNodeId: string
    newInputId:   string
    newInputs:    Array<{ id: string; label: string; color: string }>
  }
  /**
   * Stessa forma di unionUpdate, e non per pigrizia: union e serializer sono
   * gli unici due nodi con ingressi dinamici dichiarati (acceptsDynamicInputs),
   * e finora avevano due meccaniche diverse — la union scriveva la propria
   * config, il serializer contava gli archi. Un pattern, non due.
   */
  serializerUpdate?: {
    targetNodeId: string
    newInputId:   string
    newInputs:    Array<{ id: string; label: string; color: string }>
  }
}

const NO_OUTPUT    = new Set<string>()
const NO_INPUT     = new Set(['lane_start'])
const JOIN_HANDLES = new Set(['input_left', 'input_right'])

function buildStatusFields(srcType: string): TMapInputField[] {
  const base: TMapInputField[] = [
    { id: 'status_ok',             name: 'status.ok',             type: 'boolean' },
    { id: 'status_rows_processed', name: 'status.rows_processed', type: 'integer' },
    { id: 'status_duration_ms',    name: 'status.duration_ms',    type: 'integer' },
    { id: 'status_error_message',  name: 'status.error_message',  type: 'string'  },
    { id: 'status_node_id',        name: 'status.node_id',        type: 'string'  },
    { id: 'status_node_type',      name: 'status.node_type',      type: 'string'  },
    { id: 'status_timestamp',      name: 'status.timestamp',      type: 'date'    },
  ]
  if (['source_file', 'source_db', 'source_http', 'lane_start'].includes(srcType))
    base.push({ id: 'status_rows_read', name: 'status.rows_read', type: 'integer' })
  if (srcType === 'sink_file')
    base.push(
      { id: 'status_rows_written',  name: 'status.rows_written',  type: 'integer' },
      { id: 'status_bytes_written', name: 'status.bytes_written', type: 'integer' },
      { id: 'status_file_path',     name: 'status.file_path',     type: 'string'  },
    )
  if (srcType === 'sink_db')
    base.push(
      { id: 'status_rows_inserted', name: 'status.rows_inserted', type: 'integer' },
      { id: 'status_rows_updated',  name: 'status.rows_updated',  type: 'integer' },
      { id: 'status_rows_rejected', name: 'status.rows_rejected', type: 'integer' },
    )
  return base
}

export function resolveConnection(
  connection: Connection,
  nodes:      FlowNode<NodeData>[],
  edges:      Edge[],
): ConnectionResolution {

  const src = nodes.find((n) => n.id === connection.source)
  const tgt = nodes.find((n) => n.id === connection.target)

  if (!src || !tgt)
    return { valid: false, rejectionReason: 'Nodo non trovato', resolvedTargetHandle: '' }
  if (src.data.laneId !== tgt.data.laneId)
    return { valid: false, rejectionReason: 'Connessioni cross-lane non permesse', resolvedTargetHandle: '' }
  if (connection.source === connection.target)
    return { valid: false, rejectionReason: 'Auto-connessione non permessa', resolvedTargetHandle: '' }
  if (NO_OUTPUT.has(src.data.type))
    return { valid: false, rejectionReason: `${src.data.type} non ha uscite dati`, resolvedTargetHandle: '' }
  if (NO_INPUT.has(tgt.data.type))
    return { valid: false, rejectionReason: `${tgt.data.type} non accetta connessioni in ingresso`, resolvedTargetHandle: '' }

  if (src.data.type === 'filter' && connection.sourceHandle) {
    const handleAlreadyUsed = edges.some(
      (e) => e.source === src.id && e.sourceHandle === connection.sourceHandle
    )
    if (handleAlreadyUsed) {
      const handleLabel = connection.sourceHandle === 'reject'
        ? 'reject'
        : (src.data.config?.filter as any)?.conditions?.find((c: any) => c.id === connection.sourceHandle)?.label
          ?? connection.sourceHandle
      return {
        valid: false,
        rejectionReason: `Handle '${handleLabel}' già collegato — ogni uscita del Filter accetta un solo flusso. Rimuovi prima la connessione esistente.`,
        resolvedTargetHandle: '',
      }
    }
  }

  if (tgt.data.type === 'join')  return resolveJoinConnection(connection, tgt, edges)
  if (tgt.data.type === 'tmap')  return resolveTMapConnection(connection, src, tgt, nodes, edges)
  if (tgt.data.type === 'union') return resolveUnionConnection(connection, tgt, edges)
  if (tgt.data.type === 'json_serializer') return resolveSerializerConnection(connection, tgt, edges,)
  if (tgt.data.type === 'xml_serializer')  return resolveSerializerConnection(connection, tgt, edges)

  const hasIncoming = edges.some((e) => e.target === connection.target)
  if (hasIncoming)
    return { valid: false, rejectionReason: 'Nodo già collegato', resolvedTargetHandle: 'input' }

  return { valid: true, resolvedTargetHandle: 'input' }
}

// ─── Union ────────────────────────────────────────────────────────
function resolveUnionConnection(
  connection: Connection,
  tgt:        FlowNode<NodeData>,
  edges:      Edge[],
): ConnectionResolution {
  const th             = connection.targetHandle
  const existingInputs = (tgt.data.config as any)?.unionInputs ?? []

  // input_new o nessun handle → prima libero tra main e dinamici
  if (th === 'input_new' || !th) {
    const mainOccupied = edges.some(e => e.target === tgt.id && e.targetHandle === 'input_main')
    if (!mainOccupied) {
      return {
        valid: true,
        resolvedTargetHandle: 'input_main',
        edgeLabel: 'flusso 1',
        unionUpdate: {
          targetNodeId: tgt.id,
          newInputId:   'input_main',
          newInputs:    existingInputs,
        },
      }
    }
    // Crea nuovo handle dinamico
    const newId     = `union_input_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`
    const idx       = existingInputs.length + 2
    const color     = UNION_FLOW_COLORS[existingInputs.length % UNION_FLOW_COLORS.length]
    const newInputs = [...existingInputs, { id: newId, label: `flusso_${idx}`, color }]
    return {
      valid: true,
      resolvedTargetHandle: newId,
      edgeLabel: `flusso ${idx}`,
      unionUpdate: { targetNodeId: tgt.id, newInputId: newId, newInputs },
    }
  }

  // input_main esplicito
  if (th === 'input_main') {
    const occupied = edges.some(e => e.target === tgt.id && e.targetHandle === 'input_main')
    if (occupied)
      return { valid: false, rejectionReason: 'Handle input_main già collegato', resolvedTargetHandle: th }
    return { valid: true, resolvedTargetHandle: th, edgeLabel: 'flusso 1' }
  }

  // Handle dinamico union_input_XXX
  if (th.startsWith('union_input_')) {
    const occupied = edges.some(e => e.target === tgt.id && e.targetHandle === th)
    if (occupied)
      return { valid: false, rejectionReason: `Handle ${th} già collegato`, resolvedTargetHandle: th }
    const inp = existingInputs.find((i: any) => i.id === th)
    return { valid: true, resolvedTargetHandle: th, edgeLabel: inp?.label ?? th }
  }

  return { valid: false, rejectionReason: 'Handle Union non riconosciuto', resolvedTargetHandle: '' }
}

// ─── Join ─────────────────────────────────────────────────────────
function resolveJoinConnection(
  connection: Connection,
  tgt:        FlowNode<NodeData>,
  edges:      Edge[],
): ConnectionResolution {
  const targetHandle = connection.targetHandle
  if (!targetHandle || !JOIN_HANDLES.has(targetHandle))
    return { valid: false, rejectionReason: 'Collega sull\'handle blu (principale) o ciano (lookup)', resolvedTargetHandle: '' }
  const handleOccupied = edges.some((e) => e.target === tgt.id && e.targetHandle === targetHandle)
  if (handleOccupied) {
    const label = targetHandle === 'input_left' ? 'principale' : 'lookup'
    return { valid: false, rejectionReason: `Handle ${label} già connesso`, resolvedTargetHandle: targetHandle }
  }
  return { valid: true, resolvedTargetHandle: targetHandle, edgeLabel: targetHandle === 'input_left' ? 'principale' : 'lookup' }
}

// ─── TMap ─────────────────────────────────────────────────────────
function resolveTMapConnection(
  connection: Connection,
  src:        FlowNode<NodeData>,
  tgt:        FlowNode<NodeData>,
  nodes:      FlowNode<NodeData>[],
  edges:      Edge[],
): ConnectionResolution {
  const tmap = tgt.data.config?.tmap as TMapConfig | undefined

// realSchema dichiarata qui — fuori dall'if/else — così è in scope
  // anche nella creazione di newInput più sotto.
  const realSchema = (() => {
    if (src.data.type === 'json_parser' || src.data.type === 'xml_parser') return null
    try {
      const raw = src.data.props?.['outputSchema']
      if (!raw) return null
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed) && parsed.length > 0) return parsed as TMapInputField[]
    } catch {}
    return null
  })()

  // Per JSON/XML parser legge i campi dal flusso specifico (sourceHandle = flow.id)
  let inferredFields: TMapInputField[] = []
  if (src.data.type === 'json_parser' || src.data.type === 'xml_parser') {
    const parserKey = src.data.type === 'json_parser' ? 'jsonParser' : 'xmlParser'
    const config    = src.data.config?.[parserKey] as any
    const flow      = config?.flows?.find((f: any) => f.id === connection.sourceHandle)
    if (flow?.fields?.length) {
      inferredFields = flow.fields.map((f: any) => ({
        id:           f.id,
        name:         f.name,
        type:         f.type as TMapInputField['type'],
        physicalName: f.name,
      }))
    }
  } else {
    inferredFields = realSchema ?? inferSchema(src, nodes, edges)
  }
  const statusFields   = buildStatusFields(src.data.type)
  const allFields: TMapInputField[] = [
    ...inferredFields.map((f) => ({ id: f.id, name: f.name, type: f.type as TMapInputField['type'], physicalName: f.physicalName })),
    ...statusFields,
  ]
  const alreadyConnected = edges.some((e) =>
    e.source === connection.source && e.target === connection.target &&
    e.sourceHandle === (connection.sourceHandle ?? 'output')
  )
  if (alreadyConnected)
    return { valid: false, rejectionReason: 'Questo flusso è già collegato al TMap', resolvedTargetHandle: '' }

  if (connection.targetHandle && connection.targetHandle !== 'input_new') {
    const existingInput = tmap?.inputs.find((i) => i.id === connection.targetHandle)
    if (existingInput) {
      const occupied = edges.some((e) =>
        e.target === tgt.id && e.targetHandle === existingInput.id && e.source !== connection.source
      )
      if (occupied)
        return { valid: false, rejectionReason: `Input '${existingInput.label}' già connesso`, resolvedTargetHandle: existingInput.id }
      const mergedFields = mergeSchema(existingInput.fields, allFields) as TMapInputField[]
      return { valid: true, resolvedTargetHandle: existingInput.id, edgeLabel: existingInput.label, tmapUpdate: { targetNodeId: tgt.id, updateInput: { inputId: existingInput.id, fields: mergedFields } } }
    }
  }

  const hasOnlyEmptyMain = tmap?.inputs.length === 1 && tmap.inputs[0].isMain && tmap.inputs[0].fields.length === 0
  if (hasOnlyEmptyMain) {
    const mainInput = tmap!.inputs[0]
    return { valid: true, resolvedTargetHandle: mainInput.id, edgeLabel: mainInput.label, tmapUpdate: { targetNodeId: tgt.id, updateInput: { inputId: mainInput.id, fields: allFields } } }
  }

  const newInputId = `input_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
  const srcLabel   = (src.data.config?.shortLabel as string | undefined) || src.data.label || 'input'
  const newInput: TMapInput = {
    id: newInputId, label: srcLabel, isMain: false, joinType: 'left',
    joinKey: '', sourceJoinKey: '',
    // allFields contiene ora i campi reali da outputSchema (Fix 1).
    // Se outputSchema era vuoto e inferSchema ha generato placeholder,
    // scriviamo comunque statusFields ma non i placeholder — così il
    // merge successivo non accumula campi spuri.
    fields: realSchema !== null ? allFields : statusFields,
  }
  return { valid: true, resolvedTargetHandle: newInputId, edgeLabel: srcLabel, tmapUpdate: { targetNodeId: tgt.id, newInput } }
}

export function isConnectionValid(
  connection: Connection | Edge,
  nodes:      FlowNode<NodeData>[],
  edges:      Edge[],
): boolean {
  const src = nodes.find((n) => n.id === connection.source)
  const tgt = nodes.find((n) => n.id === connection.target)
  if (!src || !tgt) return false
  if (src.data.laneId !== tgt.data.laneId) return false
  if (connection.source === connection.target) return false
  if (NO_OUTPUT.has(src.data.type)) return false
  if (NO_INPUT.has(tgt.data.type)) return false

  if (src.data.type === 'filter' && connection.sourceHandle) {
    return !edges.some((e) => e.source === src.id && e.sourceHandle === connection.sourceHandle)
  }
  if (tgt.data.type === 'tmap') {
    return !edges.some((e) =>
      e.source === connection.source && e.target === connection.target &&
      e.sourceHandle === (connection.sourceHandle ?? 'output')
    )
  }
  if (tgt.data.type === 'join') {
    const targetHandle = connection.targetHandle
    if (!targetHandle || !JOIN_HANDLES.has(targetHandle)) return false
    return !edges.some((e) => e.target === tgt.id && e.targetHandle === targetHandle)
  }
  if (tgt.data.type === 'union') {
    const th = connection.targetHandle
    if (!th || th === 'input_new') {
      // Accetta sempre — input_new crea un nuovo handle
      return true
    }
    if (th === 'input_main') {
      return !edges.some(e => e.target === tgt.id && e.targetHandle === 'input_main')
    }
    if (th.startsWith('union_input_')) {
      return !edges.some(e => e.target === tgt.id && e.targetHandle === th)
    }
    return false
  }
  if (tgt.data.type === 'json_serializer' || tgt.data.type === 'xml_serializer') {
     return !edges.some((e) => e.source === connection.source && e.target === connection.target)
  }
  return !edges.some((e) => e.target === connection.target)
}

export function buildEdge(
  connection:   Connection,
  targetHandle: string,
  laneColor:    string,
  label?:       string,
): Edge {
  const srcHandle = connection.sourceHandle ?? 'output'
  return {
    id:           `e_${connection.source}_${srcHandle}_${connection.target}_${targetHandle}_${Date.now()}`,
    source:       connection.source,
    target:       connection.target,
    sourceHandle: srcHandle,
    targetHandle,
    style:        { stroke: laneColor, strokeWidth: 2, opacity: 0.7 },
    markerEnd:    { type: 'arrowclosed' as const, color: laneColor },
    label,
    labelStyle:   { fontSize: 10, fill: '#9a9aaa', fontFamily: 'monospace' },
    labelBgStyle: { fill: '#161b27', fillOpacity: 0.8 },
  }
}

export function resolveSerializerConnection(
  connection: Connection,
  tgt:        FlowNode<NodeData>,
  edges:      Edge[],
  
): ConnectionResolution {

  // Verifica duplicato stesso source → stesso target
  const alreadyConnected = edges.some((e) =>
    e.source === connection.source && e.target === connection.target
  )
  if (alreadyConnected)
    return { valid: false, rejectionReason: 'Questo flusso è già collegato al serializer', resolvedTargetHandle: '' }

  // Le porte NASCEVANO qui, contando gli archi: `existingInputs.length + 1`.
  // Era la dipendenza invertita — l'arco creava la porta invece di attaccarsi
  // a una porta. La prova meccanica: `getNodePorts(node)` riceve solo il nodo,
  // NON gli archi, quindi il resolver delle porte non poteva nemmeno esprimere
  // questo comportamento. Ora la porta si DICHIARA in config, come per la
  // union, e l'arco ci si attacca. V. contratto-porte.md §1 e §9.3.
  const declared = (tgt.data.config as any)?.serializerInputs as SerializerInput[] | undefined ?? []

  // Primo id libero della serie storica ('input', 'input_2', 'input_3'…).
  // Contare gli archi collideva dopo una cancellazione: tolto `input_2`, il
  // successivo tornava `input_2` e si sovrapponeva a un `input_3` vivo.
  // Qui si guarda cosa è DICHIARATO, quindi i buchi si riempiono e basta.
  const taken = new Set(declared.map((i) => i.id))
  let idx = 1
  let handle = 'input'
  while (taken.has(handle)) { idx += 1; handle = `input_${idx}` }

  const color     = SERIALIZER_FLOW_COLORS[(idx - 1) % SERIALIZER_FLOW_COLORS.length]
  const label     = `flusso ${idx}`
  const newInputs = [...declared, { id: handle, label, color }]

  return {
    valid:                true,
    resolvedTargetHandle: handle,
    edgeLabel:            idx === 1 ? undefined : label,
    serializerUpdate: { targetNodeId: tgt.id, newInputId: handle, newInputs },
  }
}

