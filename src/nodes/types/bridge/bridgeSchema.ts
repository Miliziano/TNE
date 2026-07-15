/**
 * src/nodes/types/bridge/bridgeSchema.ts
 *
 * Derivazione dello schema BridgeOut → BridgeIn.
 *
 * Modello: il BridgeOut è DOMINANTE. Lo schema del BridgeIn non si
 * dichiara più a mano: è il riflesso di ciò che il suo BridgeOut manda
 * sul canale. Quindi il disallineamento non può esistere per
 * costruzione, e non serve nessun avviso di mismatch.
 *
 * Perché PERSISTIAMO il derivato in props.outputSchema invece di
 * calcolarlo al volo: getHandleSchema() non ha accesso al grafo (riceve
 * solo il nodo), e tutto ciò che sta a valle — tmap, incomingSchema,
 * propagazione — legge già outputSchema. Persistendo, il resto dello
 * studio continua a funzionare senza modifiche.
 *
 * L'accoppiamento è per NOME CANALE, come nel piano Rust
 * (bridge_id = channelName, vedi Toolbar.tsx e engine/bridge.rs).
 */
import type { Edge } from '@xyflow/react'
import { getHandleSchema } from '../../../utils/schemaRegistry'
import type { TMapConfig } from '../../../types'

export interface BridgeSchemaField {
  id:           string
  name:         string
  physicalName: string
  type:         string
}

type AnyNode = { id: string; data: any }

const channelOf = (node: AnyNode): string =>
  String(node.data?.props?.['channelName'] ?? '')

/**
 * Campi che un BridgeOut trasferisce sul canale: schema LIVE del nodo a
 * monte (getHandleSchema copre anche tmap/parser/serializer), con
 * fallback sull'incomingSchema persistito dalla propagazione.
 *
 * Stessa logica del pannello del BridgeOut (Panel.tsx, useMemo
 * transferFields): è QUI perché serve a due posti, e due copie
 * divergono sempre.
 */
export function getBridgeOutFields(
  outNode: AnyNode,
  nodes:   AnyNode[],
  edges:   Edge[],
): BridgeSchemaField[] {
  const norm = (f: { id?: string; name: string; type?: string; physicalName?: string }, i: number): BridgeSchemaField => ({
    id:           f.id ?? `bf_${i}`,
    name:         f.name,
    physicalName: f.physicalName ?? f.name,
    type:         f.type ?? 'string',
  })

  const inEdge = edges.find((e) => e.target === outNode.id)
  if (inEdge) {
    const src = nodes.find((n) => n.id === inEdge.source)
    if (src) {
      const live = getHandleSchema(src, inEdge.sourceHandle ?? 'output', false)
      if (live.length > 0) return live.map(norm)
    }
  }

  try {
    const raw = outNode.data?.props?.['incomingSchema']
    if (raw) {
      const parsed = JSON.parse(String(raw))
      if (Array.isArray(parsed)) {
        return parsed.filter((f) => f?.name).map(norm)
      }
    }
  } catch { /* schema illeggibile → lista vuota */ }

  return []
}

/**
 * Il BridgeOut che alimenta un dato BridgeIn, o null.
 * Se ce n'è più d'uno il canale è ambiguo: NON scegliamo noi — lo
 * segnala la validazione (BRIDGE_AMBIGUOUS_OUT) e qui non deriviamo,
 * perché derivare da un produttore scelto a caso sarebbe peggio del
 * non derivare affatto.
 */
export function findBridgeOutFor(inNode: AnyNode, nodes: AnyNode[]): AnyNode | null {
  const ch = channelOf(inNode)
  if (!ch) return null
  const outs = nodes.filter(
    (n) => n.data?.type === 'bridge_out' && channelOf(n) === ch,
  )
  return outs.length === 1 ? outs[0] : null
}

/** Schema derivato per un BridgeIn: i campi del suo BridgeOut. */
export function deriveBridgeInFields(
  inNode: AnyNode,
  nodes:  AnyNode[],
  edges:  Edge[],
): BridgeSchemaField[] {
  const out = findBridgeOutFor(inNode, nodes)
  if (!out) return []
  return getBridgeOutFields(out, nodes, edges)
}

/**
 * Firma di ciò che può cambiare il derivato: canali dei bridge e campi
 * di ogni BridgeOut. Serve a far scattare il sync solo quando serve —
 * senza, ogni trascinamento di nodo lo rieseguirebbe.
 */
export function bridgeSyncSignature(nodes: AnyNode[], edges: Edge[]): string {
  const parts: string[] = []
  nodes.forEach((n) => {
    const t = n.data?.type
    if (t === 'bridge_out') {
      const fields = getBridgeOutFields(n, nodes, edges)
      parts.push(`O:${channelOf(n)}:${fields.map((f) => `${f.name}/${f.type}`).join(',')}`)
    } else if (t === 'bridge_in') {
      parts.push(`I:${n.id}:${channelOf(n)}`)
    }
  })
  return parts.sort().join('|')
}

/**
 * Propaga lo schema di un BridgeIn ai nodi a valle.
 * Estratta da BridgeInMappingPanel.saveSchema: ora che i campi li
 * scrive il sync e non più l'utente, la propagazione deve partire da lì.
 */
export function propagateBridgeInSchema(
  nodeId: string,
  fields: BridgeSchemaField[],
  store:  any,
): void {
  const outEdges = store.edges.filter((e: Edge) => e.source === nodeId)

  outEdges.forEach((edge: Edge) => {
    const tgt = store.nodes.find((n: AnyNode) => n.id === edge.target)
    if (!tgt) return

    if (tgt.data.type === 'tmap') {
      const tmap = tgt.data.config?.tmap as TMapConfig | undefined
      if (!tmap) return
      const input = tmap.inputs.find((i: any) => i.id === edge.targetHandle)
      if (!input) return
      const existingNames = new Set(
        input.fields.filter((f: any) => !f.name.startsWith('status.')).map((f: any) => f.name),
      )
      const merged = [
        ...input.fields,
        ...fields
          .filter((f) => !existingNames.has(f.name))
          .map((f) => ({ id: f.id, name: f.name, type: f.type as any, physicalName: f.physicalName })),
      ]
      store.updateTMapInput(tgt.id, input.id, { fields: merged })
    } else {
      store.updateNodeProp(tgt.id, 'incomingSchema', JSON.stringify(fields))
    }
  })
}

/**
 * Riallinea TUTTI i BridgeIn ai rispettivi BridgeOut.
 * Scrive solo se il JSON cambia davvero: senza quel confronto il sync
 * si riattiverebbe da solo all'infinito (scrive props → cambia lo store
 * → riscatta il sync).
 * Ritorna il numero di BridgeIn aggiornati.
 */
export function syncBridgeInSchemas(store: any): number {
  const { nodes, edges } = store
  let updated = 0

  nodes
    .filter((n: AnyNode) => n.data?.type === 'bridge_in')
    .forEach((inNode: AnyNode) => {
      const out = findBridgeOutFor(inNode, nodes)
      // Nessun produttore (o produttore ambiguo): non tocchiamo nulla.
      // Ci pensa la validazione a dirlo — azzerare lo schema qui
      // farebbe sparire i campi dai nodi a valle mentre l'utente sta
      // ancora costruendo il canale.
      if (!out) return

      const fields  = getBridgeOutFields(out, nodes, edges)
      const nextRaw = JSON.stringify(fields)
      const currRaw = String(inNode.data?.props?.['outputSchema'] ?? '')

      if (nextRaw === currRaw) return

      store.updateNodeProp(inNode.id, 'outputSchema', nextRaw)
      propagateBridgeInSchema(inNode.id, fields, store)
      updated += 1
    })

  return updated
}
