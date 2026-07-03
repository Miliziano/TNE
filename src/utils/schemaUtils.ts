/**
 * schemaUtils.ts
 *
 * FIX APPLICATO:
 * - propagateToTMap: rimossi i fallback isMain/inputs[0] quando
 *   edge.targetHandle non corrisponde a nessun input esistente.
 *   Stesso bug di mergeIntoTMapInput in schemaRegistry.ts:
 *   con 4-5 input il fallback silente sovrascriveva il main
 *   o il primo lookup con i campi del source sbagliato.
 */

import type { Edge } from '@xyflow/react'
import type { TMapConfig, FieldRenameEntry, TMapInputField } from '../types'


const PASSTHROUGH_TYPES = new Set(['log', 'materialize', 'filter'])

const SCHEMA_TERMINATORS = new Set([
  'json_serializer',
  'xml_serializer',
])

export interface SchemaField {
  id:            string
  name:          string
  type:          string
  physicalName?: string
}

export interface StoreSnapshot {
  edges:                     Edge[]
  nodes:                     Array<{ id: string; data: any }>
  updateNodeProp:            (id: string, key: string, value: string) => void
  updateTMapInput:           (nodeId: string, inputId: string, patch: any) => void
  setTMapConnections:        (nodeId: string, connections: any[]) => void
  applyTMapRenames:          (nodeId: string, renames: FieldRenameEntry[]) => void
  removeFieldFromTransforms: (nodeId: string, inputId: string, fieldName: string) => void
}

export function propagateSchema(
  sourceNodeId:   string,
  fields:         SchemaField[],
  store:          StoreSnapshot,
  excludeHandles: string[] = ['reject'],
  visited:        Set<string> = new Set(),
  getStore?:      () => StoreSnapshot,
): void {
  if (visited.has(sourceNodeId)) return
  visited.add(sourceNodeId)

  const s = getStore ? getStore() : store

  const outEdges = s.edges.filter((e) =>
    e.source === sourceNodeId &&
    !excludeHandles.includes(e.sourceHandle ?? '')
  )

  for (const edge of outEdges) {
    const current = getStore ? getStore() : s
    const tgt = current.nodes.find((n) => n.id === edge.target)
    if (!tgt) continue

    if (SCHEMA_TERMINATORS.has(tgt.data.type)) {
      current.updateNodeProp(tgt.id, 'incomingSchema', JSON.stringify(fields))
      continue
    }

    if (tgt.data.props?.['_schemaLocked'] === 'true') {
      current.updateNodeProp(tgt.id, 'incomingSchema', JSON.stringify(fields))
      continue
    }

    if (tgt.data.type === 'tmap') {
      propagateToTMap(edge, fields, current)
      continue
    }

    if (tgt.data.type === 'union') {
      propagateUnionSchema(tgt.id, getStore ? getStore() : current, getStore)
      continue
    }

    const schemaJson = JSON.stringify(fields)
    current.updateNodeProp(tgt.id, 'incomingSchema', schemaJson)

    if (tgt.data.type === 'json_parser' || tgt.data.type === 'xml_parser') {
      propagateToParser(tgt, fields, current)
    }

    if (PASSTHROUGH_TYPES.has(tgt.data.type)) {
      const shouldPropagate =
        tgt.data.type === 'filter' ||
        tgt.data.type === 'log' ||
        (tgt.data.type === 'materialize' &&
          (tgt.data.props?.['matMode'] ?? 'passthrough') === 'passthrough')
      if (shouldPropagate) {
        current.updateNodeProp(tgt.id, 'outputSchema', schemaJson)
        propagateSchema(tgt.id, fields, current, excludeHandles, visited, getStore)
      }
    }
  }
}

function propagateToParser(
  tgt:    { id: string; data: any },
  fields: SchemaField[],
  store:  StoreSnapshot,
): void {
  const fieldNames = new Set(fields.map((f) => f.name))
  const cfg = tgt.data.type === 'json_parser'
    ? tgt.data.config?.jsonParser
    : tgt.data.config?.xmlParser
  if (!cfg) return
  const currentSourceField = cfg.sourceField ?? ''
  store.updateNodeProp(tgt.id, 'sourceFieldStale',
    currentSourceField && !fieldNames.has(currentSourceField) ? 'true' : 'false'
  )
}

function propagateToTMap(
  edge:   Edge,
  fields: SchemaField[],
  store:  StoreSnapshot,
): void {
  const tgt = store.nodes.find((n) => n.id === edge.target)
  if (!tgt) return
  const tmap = tgt.data.config?.tmap as TMapConfig | undefined
  if (!tmap) return

  // ── FIX CRITICO ──────────────────────────────────────────────────
  // PRIMA (codice originale):
  //   let input = tmap.inputs.find((i) => i.id === edge.targetHandle)
  //   if (!input) input = tmap.inputs.find((i) => i.isMain)   ← PERICOLOSO
  //   if (!input) input = tmap.inputs[0]                       ← PERICOLOSO
  //
  // Con 4-5 input, quando edge.targetHandle non veniva trovato
  // (race condition o handle stale), il codice sovrascriveva
  // silenziosamente il main o il primo lookup con i campi sbagliati.
  //
  // DOPO: se targetHandle non corrisponde, esci senza fare nulla.
  // È preferibile non aggiornare piuttosto che corrompere l'input
  // sbagliato. La propagazione corretta avverrà al prossimo evento
  // pulito (es. riconnessione, ricaricamento editor).
  // ─────────────────────────────────────────────────────────────────
  const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
  if (!input) return

  const inputId   = input.id
  const oldFields = input.fields.filter((f) => !f.name.startsWith('status.'))

  const renames: FieldRenameEntry[] = []
  oldFields.forEach((oldField) => {
    if (!oldField.id) return
    const newField = fields.find((f) => f.id === oldField.id)
    if (newField && newField.name !== oldField.name) {
      renames.push({ fieldId: oldField.id, inputId, oldName: oldField.name, newName: newField.name })
    }
  })
  const deletedFields = oldFields.filter((f) => f.id && !fields.find((nf) => nf.id === f.id))
  const newNames      = new Set(fields.map((f) => f.name))

  const handledNames = new Set(
    input.fields
      .filter((f) =>
        f.name.startsWith('status.') ||
        newNames.has(f.name) ||
        renames.some((r) => r.oldName === f.name)
      )
      .map((f) => {
        const rename = renames.find((r) => r.oldName === f.name)
        return rename ? rename.newName : f.name
      })
  )

  const merged: TMapInputField[] = [
    ...input.fields
      .filter((f) =>
        f.name.startsWith('status.') ||
        newNames.has(f.name) ||
        renames.some((r) => r.oldName === f.name)
      )
      .map((f) => {
        const rename  = renames.find((r) => r.oldName === f.name)
        if (rename) return { ...f, name: rename.newName }
        const updated = fields.find((nf) => nf.name === f.name && nf.type === f.type)
                     ?? fields.find((nf) => nf.name === f.name)
        return updated ? { ...f, type: updated.type as any } : f
      }),
    ...fields
      .filter((f) => !handledNames.has(f.name))
      .map((f) => ({ id: f.id, name: f.name, type: f.type as any, physicalName: f.physicalName ?? f.name })),
  ]

  if (renames.length > 0 && tmap.connections?.length) {
    const updatedConns = tmap.connections.map((conn) => {
      if (conn.inputId !== inputId) return conn
      const rename = renames.find((r) => r.oldName === conn.fieldName)
      if (!rename) return conn
      return { ...conn, fieldName: rename.newName, id: conn.id.replace(`__${rename.oldName}__`, `__${rename.newName}__`) }
    })
    store.setTMapConnections(tgt.id, updatedConns)
  }

  if (renames.length > 0) store.applyTMapRenames(tgt.id, renames)
  deletedFields.forEach((f) => store.removeFieldFromTransforms(tgt.id, inputId, f.name))
  store.updateTMapInput(tgt.id, inputId, { fields: merged })
}

export function propagateUnionSchema(
  unionNodeId: string,
  store:       StoreSnapshot,
  getStore?:   () => StoreSnapshot,
): void {
  const s = getStore ? getStore() : store
  const unionNode = s.nodes.find((n) => n.id === unionNodeId)
  if (!unionNode) return

  const seenNames = new Set<string>()
  const seenKeys  = new Set<string>()
  const merged:   SchemaField[] = []

  const inEdges = s.edges.filter((e) => e.target === unionNodeId)

  for (const [edgeIdx, edge] of inEdges.entries()) {
    const srcNode = s.nodes.find((n) => n.id === edge.source)
    if (!srcNode) continue
    let rawSchema = srcNode.data.props?.['outputSchema'] as string | undefined
    if (!rawSchema || rawSchema === '[]' || rawSchema === 'null') {
      rawSchema = srcNode.data.props?.['outputFields'] as string | undefined
    }
    if (!rawSchema) continue

    const handleSuffix = edge.targetHandle === 'input_1' ? '_1'
                       : edge.targetHandle === 'input_2' ? '_2'
                       : `_${edgeIdx + 1}`

    try {
      const fields = JSON.parse(rawSchema) as Array<{ id?: string; name: string; type?: string; physicalName?: string }>
      for (const f of fields) {
        if (!f.name) continue
        const key = `${f.name}::${f.type ?? 'string'}`
        if (seenKeys.has(key)) continue

        let finalName = f.name
        if (seenNames.has(f.name)) {
          finalName = `${f.name}${handleSuffix}`
          let i = 2
          while (seenNames.has(finalName)) finalName = `${f.name}${handleSuffix}_${i++}`
        }

        seenKeys.add(key)
        seenNames.add(finalName)
        merged.push({
          id:           f.id ?? `uf_${finalName}`,
          name:         finalName,
          type:         f.type ?? 'string',
          physicalName: f.physicalName ?? f.name,
        })
      }
    } catch {}
  }

  if (merged.length === 0) return

  const mergedJson = JSON.stringify(merged)
  s.updateNodeProp(unionNodeId, 'outputSchema',   mergedJson)
  s.updateNodeProp(unionNodeId, 'incomingSchema', mergedJson)

  propagateSchema(unionNodeId, merged, getStore ? getStore() : s, ['reject'], new Set(), getStore)
}

export function readOutputSchema(nodeProps: Record<string, string>): SchemaField[] {
  try {
    const raw = nodeProps['outputSchema']
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((f: any, i: number) => ({
      id:           f.id   ?? `field_auto_${i}`,
      name:         f.name ?? `campo_${i}`,
      type:         f.type ?? 'string',
      physicalName: f.physicalName ?? f.name ?? `campo_${i}`,
    }))
  } catch { return [] }
}

export function readIncomingSchema(nodeProps: Record<string, string>): SchemaField[] {
  try {
    const raw = nodeProps['incomingSchema']
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.map((f: any, i: number) => ({
      id:           f.id   ?? `field_auto_${i}`,
      name:         f.name ?? `campo_${i}`,
      type:         f.type ?? 'string',
      physicalName: f.physicalName ?? f.name ?? `campo_${i}`,
    }))
  } catch { return [] }
}

export function scriptFieldsToSchema(
  fields: Array<{ id: string; name: string; type: string }>
): SchemaField[] {
  return fields.map((f) => ({ id: f.id, name: f.name, type: f.type, physicalName: f.name }))
}

export function lockSchemaAndPropagate(
  nodeId:    string,
  newSchema: SchemaField[],
  store:     StoreSnapshot,
  getStore?: () => StoreSnapshot,
): void {
  const s = getStore ? getStore() : store
  s.updateNodeProp(nodeId, '_schemaLocked', 'true')
  s.updateNodeProp(nodeId, 'outputSchema', JSON.stringify(newSchema))
  propagateSchema(nodeId, newSchema, getStore ? getStore() : s, ['reject'], new Set(), getStore)
}

export function unlockSchema(
  nodeId: string,
  store:  StoreSnapshot,
): void {
  store.updateNodeProp(nodeId, '_schemaLocked', 'false')
}

export function resolvePassthroughSchema(
  nodeId:  string,
  store:   StoreSnapshot,
  visited: Set<string> = new Set(),
): SchemaField[] {
  if (visited.has(nodeId)) return []
  visited.add(nodeId)

  const node = store.nodes.find((n) => n.id === nodeId)
  if (!node) return []

  const ownOutput = readOutputSchema(node.data.props)
  if (ownOutput.length > 0) return ownOutput

  if (!PASSTHROUGH_TYPES.has(node.data.type)) return []

  const inEdge = store.edges.find((e) => e.target === nodeId)
  if (!inEdge) return []

  return resolvePassthroughSchema(inEdge.source, store, visited)
}

export interface SchemaDriftResult {
  hasDrift: boolean
  added:    string[]
  removed:  string[]
  retyped:  Array<{ name: string; from: string; to: string }>
}

export function detectSchemaDrift(
  snapshot: SchemaField[] | null | undefined,
  live:     SchemaField[],
): SchemaDriftResult {
  if (!snapshot || snapshot.length === 0) {
    return { hasDrift: false, added: [], removed: [], retyped: [] }
  }

  const snapByName = new Map(snapshot.map(f => [f.name, f.type]))
  const liveByName  = new Map(live.map(f => [f.name, f.type]))

  const added   = live.filter(f => !snapByName.has(f.name)).map(f => f.name)
  const removed = snapshot.filter(f => !liveByName.has(f.name)).map(f => f.name)
  const retyped: Array<{ name: string; from: string; to: string }> = []

  for (const f of live) {
    const prevType = snapByName.get(f.name)
    if (prevType !== undefined && prevType !== f.type) {
      retyped.push({ name: f.name, from: prevType, to: f.type })
    }
  }

  return {
    hasDrift: added.length > 0 || removed.length > 0 || retyped.length > 0,
    added, removed, retyped,
  }
}