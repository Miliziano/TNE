/**
 * src/nodes/useIncomingSchema.ts
 *
 * Hook React che legge lo schema in ingresso di un nodo.
 *
 * Strategia a tre livelli:
 * 1. Prima prova a leggere props['incomingSchema'] — scritto dalla
 *    propagazione reattiva quando il nodo sorgente cambia outputSchema
 * 2. Fallback: risale l'edge e legge outputSchema dal nodo sorgente
 * 3. Se il nodo sorgente è passthrough (log, materialize passthrough),
 *    risale ulteriormente la catena fino a trovare uno schema reale
 *
 * Modifiche rispetto alla versione precedente:
 * - resolveSourceSchema: aggiunto caso TMap — legge i campi dall'output
 *   specifico (identificato da sourceHandle) invece di readOutputSchema
 *   che non funziona per nodi con output multipli per handle.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../store/flowStore'
import type { SchemaField } from './../utils/schemaUtils'
import { readOutputSchema, readIncomingSchema } from './../utils/schemaUtils'

// Nodi passthrough — non producono schema proprio, lo ereditano.
// NB lo `script` NON è qui, ed è giusto: aggiunge campi propri. Il suo
// schema arriva da `props.outputSchema`, che il pannello ricava dal corpo
// (v. l'effetto in script/Panel.tsx) — la stessa via delle sorgenti.
const PASSTHROUGH_TYPES = new Set(['log', 'materialize'])

/**
 * Legge i campi di un output specifico del TMap.
 * Usato quando il nodo sorgente è un TMap — ha output multipli per handle
 * e readOutputSchema restituirebbe uno schema errato o vuoto.
 */
function readTMapOutputSchema(
  srcNode:      { data: any },
  sourceHandle: string | null | undefined,
): SchemaField[] {
  const tmap = srcNode.data.config?.tmap
  if (!tmap) return []

  // Cerca l'output corrispondente all'handle sorgente
  const output = tmap.outputs?.find((o: any) => o.id === sourceHandle)
  if (!output?.fields?.length) {
    // Fallback: primo output se l'handle non corrisponde
    const firstOut = tmap.outputs?.[0]
    if (!firstOut?.fields?.length) return []
    return firstOut.fields
      .filter((f: any) => f.name)
      .map((f: any) => ({
        id:   f.id ?? f.name,
        name: f.name,
        type: f.type ?? 'string',
      }))
  }

  return output.fields
    .filter((f: any) => f.name)
    .map((f: any) => ({
      id:   f.id ?? f.name,
      name: f.name,
      type: f.type ?? 'string',
    }))
}

/**
 * Risale la catena di edge saltando i nodi passthrough
 * fino a trovare un nodo con outputSchema reale.
 * Protetto da guard anti-ciclo con visited set.
 */
function resolveSourceSchema(
  nodeId:  string,
  edges:   Array<{ source: string; target: string; sourceHandle?: string | null; targetHandle?: string | null }>,
  nodes:   Array<{ id: string; data: any }>,
  visited: Set<string> = new Set(),
): SchemaField[] {
  if (visited.has(nodeId)) return []
  visited.add(nodeId)

  const inEdge = edges.find((e) => e.target === nodeId)
  if (!inEdge) return []

  const srcNode = nodes.find((n) => n.id === inEdge.source)
  if (!srcNode) return []

  // Se il sorgente è passthrough, risali ancora
  if (PASSTHROUGH_TYPES.has(srcNode.data.type)) {
    const fromIncoming = readIncomingSchema(srcNode.data.props)
    if (fromIncoming.length > 0) return fromIncoming
    return resolveSourceSchema(srcNode.id, edges, nodes, visited)
  }

  // ── Caso TMap: output multipli per handle ─────────────────────
  // readOutputSchema non funziona per il TMap perché non ha un
  // outputSchema unico — ogni handle ha il proprio set di campi.
  // Leggiamo direttamente dall'output corrispondente all'handle.
  if (srcNode.data.type === 'tmap') {
    const fromTMap = readTMapOutputSchema(srcNode, inEdge.sourceHandle)
    if (fromTMap.length > 0) return fromTMap
    // Se l'output è vuoto (nessun campo configurato), ritorna vuoto
    // senza risalire ulteriormente — il TMap è il produttore reale
    return []
  }

  // Nodo sorgente reale — leggi outputSchema
  const fromOutput = readOutputSchema(srcNode.data.props)
  if (fromOutput.length > 0) return fromOutput

  // Ultimo fallback — incomingSchema del sorgente
  return readIncomingSchema(srcNode.data.props)
}

export function useIncomingSchema(nodeId: string): SchemaField[] {
  const node  = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const edges = useFlowStore((s) => s.edges)
  const nodes = useFlowStore((s) => s.nodes)

  return useMemo(() => {
    if (!node) return []

    // Livello 1 — incomingSchema scritto dalla propagazione reattiva
    const fromProp = readIncomingSchema(node.data.props)
    if (fromProp.length > 0) return fromProp

    // Livello 2 — fallback: risale la catena saltando passthrough
    return resolveSourceSchema(nodeId, edges, nodes)
  }, [
    // Reagisce ai cambiamenti di schema sul nodo corrente
    node?.data.props?.['incomingSchema'],
    node?.data.props?.['outputSchema'],
    edges,
    nodes,
    nodeId,
  ])
}

/**
 * Versione per nodi con handle source specifico (es. output TMap).
 * Preferisce sempre leggere dall'output specifico del nodo sorgente.
 */
export function useIncomingSchemaFromHandle(
  nodeId:       string,
  targetHandle: string,
): SchemaField[] {
  const edges = useFlowStore((s) => s.edges)
  const nodes = useFlowStore((s) => s.nodes)

  return useMemo(() => {
    const inEdge = edges.find(
      (e) => e.target === nodeId && e.targetHandle === targetHandle
    )
    if (!inEdge) return []

    const srcNode = nodes.find((n) => n.id === inEdge.source)
    if (!srcNode) return []

    // Per TMap — leggi schema dall'output specifico
    if (srcNode.data.type === 'tmap') {
      const fromTMap = readTMapOutputSchema(srcNode, inEdge.sourceHandle)
      if (fromTMap.length > 0) return fromTMap
    }

    // Se il sorgente è passthrough risali la catena
    if (PASSTHROUGH_TYPES.has(srcNode.data.type)) {
      const fromIncoming = readIncomingSchema(srcNode.data.props)
      if (fromIncoming.length > 0) return fromIncoming
      return resolveSourceSchema(srcNode.id, edges, nodes)
    }

    return readOutputSchema(srcNode.data.props)
  }, [edges, nodes, nodeId, targetHandle])
}