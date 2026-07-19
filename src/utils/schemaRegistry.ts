/**
 * src/utils/schemaRegistry.ts
 *
 * Modifiche rispetto alla versione precedente:
 *
 * 1. mergeIncomingSchema — nuova funzione che sostituisce writeIncomingSchema
 *    ovunque la propagazione scrive nei nodi figlio.
 *    Logica merge per id:
 *      - campo figlio con id presente nella propagazione → aggiorna nome e tipo
 *      - campo figlio con id NON presente nella propagazione → campo locale, mai toccato
 *      - campo propagazione con id non trovato nel figlio → campo nuovo, aggiunto
 *      - campo figlio con id che era propagato ma ora scompare → cancellato a monte, rimosso
 *    Un campo è "propagato" se il suo id esiste nell'output del padre (presente in
 *    incomingFields). Un campo è "locale" se il suo id non è mai stato nel padre.
 *
 * 2. propagateHandle — usa mergeIncomingSchema invece di writeIncomingSchema
 *    per tutti i nodi target (non solo TMap).
 *
 * 3. propagatedIds tracking — ogni nodo che riceve propagazione mantiene in
 *    props['_propagatedIds'] la lista degli id propagati dall'ultima propagazione.
 *    Questo permette di distinguere "id rimosso a monte" da "id mai stato a monte".
 */

import type { Edge } from '@xyflow/react'
import { resolveStaticPorts } from '../ir/nodeSemantics'
import type { PortSpec } from '../ir/types'
import type { TMapConfig, TMapInputField, TMapOutputField, FieldRenameEntry } from '../types'
import { onErrorEmitsCatch } from '../types'
import type { StoreSnapshot } from './schemaUtils'

// ─── dbTypeToLogical ─────────────────────────────────────────────
// Usata in getHandleSchema per normalizzare i tipi DB del sink_db
// in tipi logici canonici (string, integer, decimal...).
// Esportata anche per uso in SinkDbMappingPanel.
export function dbTypeToLogical(dbType: string): string {
  if (!dbType) return 'string'
  const t = dbType.toLowerCase()
  if (/int|serial|number\(19\)/i.test(t))                      return 'integer'
  if (/numeric|decimal|float|double|real|number\(18/i.test(t))  return 'decimal'
  if (/bool/i.test(t))                                           return 'boolean'
  if (/^date$/i.test(t))                                         return 'date'
  if (/timestamp|datetime/i.test(t))                             return 'datetime'
  if (/json|clob|object/i.test(t))                              return 'object'
  return 'string'
}

export interface SchemaFieldDef {
  id:            string
  name:          string
  type:          string
  physicalName?: string
}

export interface NodeHandleDefs {
  inputs:  string[]
  outputs: string[]
}

export interface SchemaMergeResult<T = SchemaFieldDef> {
  merged:  T[]
  added:   string[]
  removed: string[]
}

export interface RegistryStoreSnapshot extends StoreSnapshot {
  updateTMapOutput: (nodeId: string, outputId: string, patch: any) => void
}

let _shortIdCounter = 0

function generateShortId(): string {
  _shortIdCounter += 1
  return `${Date.now().toString(36)}${_shortIdCounter.toString(36)}`
}

export function createField(
  handleId: string,
  name:     string,
  type:     string,
  physicalName?: string,
): SchemaFieldDef {
  return {
    id:   `${handleId}__${generateShortId()}`,
    name,
    type,
    physicalName: physicalName ?? name,
  }
}

export function renameField(field: SchemaFieldDef, newName: string): SchemaFieldDef {
  return { ...field, name: newName }
}


/**
 * Porte di un nodo, complete: id, etichetta, ruolo, isReject.
 * FONTE UNICA per il canvas (FlowNode), per la propagazione e per chi
 * deve sapere quali handle esistono davvero.
 *
 * Tre pezzi, in quest'ordine:
 *   1. le porte STATICHE dal contratto, con le condizioni `when` applicate
 *   2. le porte DINAMICHE, per i 4 tipi che il contratto dichiara tali
 *      (producesMultipleOutputs): tmap, filter, json_parser, xml_parser
 *   3. il `catch`, che è universale e condizionato da onError
 */
export function getNodePorts(node: { data: any }): { inputs: PortSpec[]; outputs: PortSpec[] } {
  const type  = node.data.type
  const props = node.data.props as Record<string, unknown> | undefined
  const base  = resolveStaticPorts(type, props)

  const dyn = (id: string, label?: string, isReject = false): PortSpec =>
    ({ id, label: label ?? id, role: isReject ? 'reject' : 'data' })

  let ports: { inputs: PortSpec[]; outputs: PortSpec[] } = base

  switch (type) {
    case 'tmap': {
      const tmap = node.data.config?.tmap as TMapConfig | undefined
      if (tmap) {
        // `?? []` non è pignoleria: `if (tmap)` proteggeva solo l'esistenza di
        // config.tmap, non delle due liste. Un tmap con `inputs` ma senza
        // `outputs` faceva LANCIARE getNodePorts — e questa funzione la chiama
        // chi DISEGNA: un throw qui svuota il canvas.
        //
        // E leggeva `i.name` / `o.name`: TMapInput e TMapOutput hanno **label**,
        // non name (src/types/index.ts:285 e :306). Quei campi non sono mai
        // esistiti, e `dyn()` ripiegava in silenzio sull'id — così le etichette
        // delle porte tmap sono sempre state gli id invece dei nomi scelti
        // dall'utente. Il cast `(i: any)` teneva il refuso fuori dal typecheck.
        ports = {
          inputs:  (tmap.inputs  ?? []).map((i) => dyn(i.id, i.label)),
          outputs: (tmap.outputs ?? []).map((o) => dyn(o.id, o.label, o.id === 'rejected')),
        }
      }
      break
    }
    case 'filter': {
      // Leggeva `config.filterRules` ed emetteva una porta `default`.
      // Nessuna delle due cose esiste: in tutto il repo `filterRules`
      // compariva SOLO nella riga che lo leggeva, e il pannello salva
      // `config.filter.conditions`; l'uscita di scarto si chiama `reject`
      // (così la disegna FilterNode, così la costruisce il lowerer).
      // Il resolver rispondeva quindi ZERO uscite per ogni filter vero:
      // latente finché i componenti dedicati disegnano da soli, mina a P20.
      // V. contratto-porte.md §9.
      const cfg = node.data.config?.filter as { conditions?: Array<{ id: string; label?: string }> } | undefined
      if (cfg?.conditions?.length) {
        ports = {
          inputs:  [dyn('input')],
          outputs: [...cfg.conditions.map((c) => dyn(c.id, c.label)), dyn('reject', 'reject', true)],
        }
      }
      break
    }

    case 'json_serializer':
    case 'xml_serializer': {
      // Prima qui non c'era NIENTE: il contratto dichiarava un ingresso solo
      // e il componente ne disegnava N, uno per arco. Il resolver non poteva
      // dire il vero perché riceve il nodo e non gli archi — ed è esattamente
      // per questo che le porte derivate dagli archi stanno fuori dal modello.
      // Ora gli ingressi sono dichiarati in config.serializerInputs (li scrive
      // connectionResolver, come per la union) e da qui si leggono.
      const ser = (node.data.config as any)?.serializerInputs as Array<{ id: string; label?: string }> | undefined
      if (ser?.length) ports = { ...ports, inputs: ser.map((i) => dyn(i.id, i.label)) }
      break
    }

    case 'union': {
      // main + N flussi dinamici, come li crea connectionResolver e come li
      // salva config.unionInputs. Il contratto dichiara la sola porta statica
      // (`input_main`) e marca acceptsDynamicInputs: qui si completano.
      const extra = (node.data.config as any)?.unionInputs as Array<{ id: string; label?: string }> | undefined
      ports = {
        ...ports,
        // 'flusso_1' con l'underscore: è la convenzione vera: MAIN_INPUT in
        // UnionNode e le etichette dei dinamici in config (`flusso_2`, …).
        // P19b aveva scritto 'flusso 1' con lo spazio — mia svista.
        inputs: [dyn('input_main', 'flusso_1'), ...(extra ?? []).map((i) => dyn(i.id, i.label))],
      }
      break
    }
    case 'json_parser':
    case 'xml_parser': {
      const cfgKey = type === 'json_parser' ? 'jsonParser' : 'xmlParser'
      const flows  = (node.data.config as any)?.[cfgKey]?.flows as Array<{ id: string; name?: string }> | undefined
      if (flows?.length) {
        ports = {
          inputs:  [dyn('input')],
          outputs: [...flows.map((f) => dyn(f.id, f.name)), dyn('reject', 'reject', true)],
        }
      }
      break
    }
  }

  // Il catch non appartiene a un tipo: appartiene alla gestione errori, e
  // vale per qualunque nodo le cui modalità onError lo attivano (catch /
  // retry_catch). Fonte unica: onErrorEmitsCatch.
  if (onErrorEmitsCatch(node.data.config?.advanced?.onError)) {
    ports = {
      ...ports,
      outputs: [...ports.outputs, { id: 'catch', label: '⚡ catch', role: 'catch' }],
    }
  }

  return ports
}

/** Vista per id — comodità per chi non ha bisogno di etichette e ruoli. */
export function getNodeHandles(node: { data: any }): NodeHandleDefs {
  const p = getNodePorts(node)
  return { inputs: p.inputs.map((x) => x.id), outputs: p.outputs.map((x) => x.id) }
}


export function getHandleSchema(
  node:     { id: string; data: any },
  handleId: string,
  isInput:  boolean,
): SchemaFieldDef[] {
  if (node.data.type === 'tmap') {
    const tmap = node.data.config?.tmap as TMapConfig | undefined
    if (!tmap) return []
    if (isInput) {
      const input = tmap.inputs.find((i) => i.id === handleId)
      if (!input) return []
      return input.fields
        .filter((f) => f.name)
        .map((f) => toSchemaFieldDef(f, handleId))
    } else {
      const output = tmap.outputs.find((o) => o.id === handleId)
      if (!output) return []
      return output.fields
        .filter((f) => f.name)
        .map((f) => toSchemaFieldDef(f, handleId))
    }
  }

  // ── sink_db: schema dichiarato in sinkColumns, non in incomingSchema ──
  // incomingSchema nel sink_db contiene SOLO campi propagati dal TMap.
  // Le colonne DB vivono in sinkColumns — le leggiamo direttamente
  // con traduzione dbType → tipo logico canonico.
  if (node.data.type === 'sink_db' && isInput) {
    try {
      const raw = node.data.props?.['sinkColumns']
      if (raw) {
        const cols = JSON.parse(raw) as Array<{
          dbColumn: string; dbType: string; enabled?: boolean
        }>
        return cols
          .filter((c) => c.dbColumn)
          .map((c) => ({
            id:           `sinkdb__${c.dbColumn}`,
            name:         c.dbColumn,
            type:         dbTypeToLogical(c.dbType),
            physicalName: c.dbColumn,
          }))
      }
    } catch {}
    return []
  }

  if (!isInput && (node.data.type === 'json_parser' || node.data.type === 'xml_parser')) {
    const cfgKey = node.data.type === 'json_parser' ? 'jsonParser' : 'xmlParser'
    const cfg = node.data.config?.[cfgKey]
    const flow = cfg?.flows?.find((f: any) => f.id === handleId)
    if (!flow?.fields?.length) return []
    return flow.fields
      .filter((f: any) => f.name)
      .map((f: any) => ({
        id:           f.id ?? `${handleId}__${generateShortId()}`,
        name:         f.name,
        type:         f.type ?? 'string',
        physicalName: f.physicalName ?? f.name,
      }))
  }

  if (!isInput && (node.data.type === 'json_serializer' || node.data.type === 'xml_serializer')) {
    const outputField = String(node.data.props?.outputField ?? 'content')
    return [{ id: `${handleId}__fixed`, name: outputField, type: 'string', physicalName: outputField }]
  }

  const propsKey = isInput ? 'incomingSchema' : 'outputSchema'
  return readSchemaFromProps(node.data.props, propsKey, handleId)
}

function toSchemaFieldDef(
  f: TMapInputField | TMapOutputField,
  handleId: string,
): SchemaFieldDef {
  const id = (f as any).id ?? `${handleId}__${generateShortId()}`
  return {
    id,
    name: f.name,
    type: f.type,
    physicalName: (f as any).physicalName ?? f.name,
  }
}

function readSchemaFromProps(
  props: Record<string, string> | undefined,
  key:   string,
  handleId: string,
): SchemaFieldDef[] {
  try {
    const raw = props?.[key]
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed
      .filter((f: any) => f?.name)
      .map((f: any) => ({
        id:           f.id ?? `${handleId}__${generateShortId()}`,
        name:         f.name,
        type:         f.type ?? 'string',
        physicalName: f.physicalName ?? f.name,
      }))
  } catch {
    return []
  }
}

export function mergeSchemaNonDestructive<T extends { id?: string; name: string }>(
  existingTargetFields: T[],
  incomingFields:       SchemaFieldDef[],
  createNewTargetField: (f: SchemaFieldDef) => T,
): SchemaMergeResult<T> {
  const incomingById = new Map(incomingFields.map((f) => [f.id, f]))
  const existingIds   = new Set(existingTargetFields.map((f) => f.id).filter(Boolean))

  const kept = existingTargetFields.filter((f) => f.id && incomingById.has(f.id))
  const newOnes = incomingFields
    .filter((f) => !existingIds.has(f.id))
    .map((f) => createNewTargetField(f))
  const removed = existingTargetFields
    .filter((f) => f.id && !incomingById.has(f.id))
    .map((f) => f.name)
  const added = incomingFields
    .filter((f) => !existingIds.has(f.id))
    .map((f) => f.name)

  return { merged: [...kept, ...newOnes], added, removed }
}

export function buildFieldPath(
  laneId:   string,
  nodeId:   string,
  handleId: string,
  fieldName: string,
): string {
  return `${laneId}.${nodeId}.${handleId}.${fieldName}`
}

export interface ParsedFieldPath {
  laneId:    string
  nodeId:    string
  handleId:  string
  fieldName: string
}

export function parseFieldPath(path: string): ParsedFieldPath | null {
  const parts = path.split('.')
  if (parts.length !== 4) return null
  const [laneId, nodeId, handleId, fieldName] = parts
  return { laneId, nodeId, handleId, fieldName }
}

export function resolveFieldPath(
  path:  string,
  store: RegistryStoreSnapshot,
): SchemaFieldDef | null {
  const parsed = parseFieldPath(path)
  if (!parsed) return null
  const node = store.nodes.find((n) => n.id === parsed.nodeId && n.data.laneId === parsed.laneId)
  if (!node) return null
  const asOutput = getHandleSchema(node, parsed.handleId, false)
  const foundOut = asOutput.find((f) => f.name === parsed.fieldName)
  if (foundOut) return foundOut
  const asInput = getHandleSchema(node, parsed.handleId, true)
  return asInput.find((f) => f.name === parsed.fieldName) ?? null
}

const PASSTHROUGH_TYPES = new Set(['log', 'materialize', 'filter'])
const SCHEMA_TERMINATORS = new Set(['json_serializer', 'xml_serializer'])

// ─── mergeIncomingSchema ──────────────────────────────────────────
// Sostituisce writeIncomingSchema ovunque.
// Logica merge basata su id:
//
//   1. Legge l'incomingSchema attuale del nodo figlio
//   2. Legge _propagatedIds — gli id propagati nell'ultima propagazione
//   3. Per ogni campo del figlio:
//      - id presente in incomingFields → campo propagato → aggiorna nome e tipo
//      - id NON in incomingFields ma NON in _propagatedIds → campo locale → preserva
//      - id NON in incomingFields ma in _propagatedIds → cancellato a monte → rimuove
//   4. Aggiunge i campi nuovi da incomingFields non ancora presenti nel figlio
//   5. Aggiorna _propagatedIds con gli id della propagazione corrente
//
// Questo garantisce che:
//   - i campi aggiunti manualmente nel figlio non vengano mai rimossi
//     dalla propagazione automatica (finché non passano per "importa")
//   - rinominare a monte aggiorna il nome nel figlio
//   - cancellare a monte rimuove solo i campi che erano stati propagati
//
function mergeIncomingSchema(
  nodeId:         string,
  incomingFields: SchemaFieldDef[],
  store:          RegistryStoreSnapshot,
): void {
  const node = store.nodes.find((n) => n.id === nodeId)
  if (!node) return

  // Legge lo schema attuale del figlio
  const existingRaw = node.data.props?.['incomingSchema']
  let existingFields: SchemaFieldDef[] = []
  try {
    if (existingRaw) existingFields = JSON.parse(existingRaw)
  } catch {}

  // Legge gli id propagati nell'ultima propagazione
  const prevPropagatedRaw = node.data.props?.['_propagatedIds']
  let prevPropagatedIds = new Set<string>()
  try {
    if (prevPropagatedRaw) prevPropagatedIds = new Set(JSON.parse(prevPropagatedRaw))
  } catch {}

  // Map degli id in arrivo per accesso rapido
  const incomingById = new Map(incomingFields.map((f) => [f.id, f]))

  // Processa i campi esistenti nel figlio
  const kept: SchemaFieldDef[] = []
  for (const existing of existingFields) {
    const incoming = incomingById.get(existing.id)
    if (incoming) {
      // Campo propagato presente → aggiorna nome e tipo (rinomina a monte)
      kept.push({ ...existing, name: incoming.name, type: incoming.type })
    } else if (prevPropagatedIds.has(existing.id)) {
      // Era propagato ma ora non arriva più → cancellato a monte → rimuovi
      // (non aggiungere a kept = eliminazione)
    } else {
      // Id non trovato e non era propagato → campo locale → preserva intatto
      kept.push(existing)
    }
  }

  // Aggiunge i campi nuovi da incomingFields non ancora presenti nel figlio
  const existingIds = new Set(existingFields.map((f) => f.id))
  for (const inc of incomingFields) {
    if (!existingIds.has(inc.id)) {
      kept.push(inc)
    }
  }

  // Aggiorna incomingSchema e _propagatedIds
  store.updateNodeProp(nodeId, 'incomingSchema', JSON.stringify(kept))
  store.updateNodeProp(nodeId, '_propagatedIds', JSON.stringify(incomingFields.map((f) => f.id)))
}

let _propagating = false
export function propagateHandle(
  nodeId:   string,
  handleId: string,
  store:    RegistryStoreSnapshot,
  visited:  Set<string> = new Set(),
): void {

   if (_propagating) return
  _propagating = true
  try {
    const visitKey = `${nodeId}::${handleId}`
    if (visited.has(visitKey)) return
    visited.add(visitKey)

    const srcNode = store.nodes.find((n) => n.id === nodeId)
    if (!srcNode) return

    const fields = getHandleSchema(srcNode, handleId, false)
    if (fields.length === 0) return

    const outEdges = store.edges.filter(
      (e) => e.source === nodeId && (e.sourceHandle ?? 'output') === handleId,
    )

    for (const edge of outEdges) {
      const tgt = store.nodes.find((n) => n.id === edge.target)
      if (!tgt) continue

      const targetHandleId = edge.targetHandle ?? 'input'

      if (SCHEMA_TERMINATORS.has(tgt.data.type)) {
        // I terminatori ricevono sempre il merge completo
        mergeIncomingSchema(tgt.id, fields, store)
        continue
      }

      if (tgt.data.props?.['_schemaLocked'] === 'true') {
        mergeIncomingSchema(tgt.id, fields, store)
        continue
      }

      if (tgt.data.type === 'join') {
        if (targetHandleId === 'input_right') {
          store.updateNodeProp(tgt.id, 'rightSchema', JSON.stringify(fields))
        } else {
          mergeIncomingSchema(tgt.id, fields, store)
        }
        continue
      }

      if (tgt.data.type === 'union') {
        mergeIncomingSchema(tgt.id, fields, store)
        continue
      }

      if (tgt.data.type === 'tmap') {
        mergeIntoTMapInput(tgt, targetHandleId, fields, store)
        continue
      }

      // Tutti gli altri nodi: merge
      mergeIncomingSchema(tgt.id, fields, store)

      if (PASSTHROUGH_TYPES.has(tgt.data.type)) {
        const shouldPropagate =
          tgt.data.type === 'filter' ||
          tgt.data.type === 'log' ||
          (tgt.data.type === 'materialize' &&
            (tgt.data.props?.['matMode'] ?? 'passthrough') === 'passthrough')
        if (shouldPropagate) {
          store.updateNodeProp(tgt.id, 'outputSchema', JSON.stringify(fields))
          const downstreamHandles = getNodeHandles(tgt).outputs
          for (const outHandle of downstreamHandles) {
            propagateHandle(tgt.id, outHandle, store, visited)
          }
        }
      }
    }
  } finally {
    _propagating = false
  }
}

function mergeIntoTMapInput(
  tgt:      { id: string; data: any },
  inputId:  string,
  fields:   SchemaFieldDef[],
  store:    RegistryStoreSnapshot,
): void {
  const tmap = tgt.data.config?.tmap as TMapConfig | undefined
  if (!tmap) return

  const input = tmap.inputs.find((i) => i.id === inputId)
  if (!input) return

  // Legge gli id propagati precedentemente per questo input TMap
  // Chiave: _propagatedIds_{inputId} per distinguere i vari input
  const prevKey = `_propagatedIds_${inputId}`
  const prevRaw = tgt.data.props?.[prevKey]
  let prevPropagatedIds = new Set<string>()
  try {
    if (prevRaw) prevPropagatedIds = new Set(JSON.parse(prevRaw))
  } catch {}

  const incomingById  = new Map(fields.map((f) => [f.id, f]))
  const statusFields  = input.fields.filter((f) => f.name.startsWith('status.'))
  const regularFields = input.fields.filter((f) => !f.name.startsWith('status.'))

  const kept: TMapInputField[] = []
  for (const existing of regularFields) {
    const existingId = (existing as any).id
    const incoming   = existingId ? incomingById.get(existingId) : undefined
    if (incoming) {
      // Aggiorna nome e tipo
      kept.push({ ...existing, name: incoming.name, type: incoming.type as any })
    } else if (existingId && prevPropagatedIds.has(existingId)) {
      // Era propagato, ora non arriva più → cancellato a monte → rimuovi
    } else {
      // Campo locale → preserva
      kept.push(existing)
    }
  }

  // Aggiunge campi nuovi
  const existingIds = new Set(regularFields.map((f) => (f as any).id).filter(Boolean))
  for (const inc of fields) {
    if (!existingIds.has(inc.id)) {
      kept.push({
        id:           inc.id,
        name:         inc.name,
        type:         inc.type as any,
        physicalName: inc.physicalName ?? inc.name,
      } as any)
    }
  }

  store.updateTMapInput(tgt.id, input.id, { fields: [...statusFields, ...kept] })
  store.updateNodeProp(tgt.id, prevKey, JSON.stringify(fields.map((f) => f.id)))
}

// ─── propagateFromConnection ──────────────────────────────────────
export function propagateFromConnection(
  sourceNodeId:   string,
  sourceHandleId: string,
  targetNodeId:   string,
  store:          RegistryStoreSnapshot,
  unionPropagator?: (unionNodeId: string, store: RegistryStoreSnapshot) => void,
): void {
  const tgt = store.nodes.find((n) => n.id === targetNodeId)

  if (tgt?.data.type === 'union' && unionPropagator) {
    unionPropagator(targetNodeId, store)
    return
  }

  propagateHandle(sourceNodeId, sourceHandleId, store)
}