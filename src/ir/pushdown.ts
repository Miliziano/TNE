/**
 * src/ir/pushdown.ts
 *
 * P394 — quando il Filter dopo un DB Input si può SPINGERE nella query.
 *
 * Il motore traduce le condizioni del Filter in un WHERE (engine/pushdown.rs)
 * se il DB Input le riceve nella sua busta (`spec.config.pushdown`). Qui si
 * decide se passargliele, guardando solo la forma del grafo:
 *
 *  · il DB Input manda le sue righe a UN solo nodo, ed è un Filter (se le
 *    mandasse anche altrove, quegli altri nodi vorrebbero tutte le righe);
 *  · il Filter riceve solo da lì;
 *  · lo scarto del Filter non è collegato (le righe scartate sparirebbero
 *    dal database invece di arrivare sulla porta reject);
 *  · l'opzione del DB Input non è spenta (`pushdown: 'off'`).
 *
 * Il Filter resta nel piano e lavora come prima: il WHERE tiene almeno le
 * sue righe, mai di meno. Se il motore non sa tradurre una condizione con lo
 * stesso significato, non spinge niente e lo dice nel log.
 */
import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData } from '../types'

/** Il Filter da spingere nella query del DB Input `nodo`, o null. */
export function filtroDaSpingere(
  nodo: FlowNode<NodeData>,
  nodes: FlowNode<NodeData>[],
  edges: Edge[],
): FlowNode<NodeData> | null {
  if (nodo.data.type !== 'source_db') return null
  if ((nodo.data.props?.['pushdown'] ?? 'auto') === 'off') return null
  // Le righe d'errore (catch) non contano: solo i dati.
  const uscite = edges.filter((e) => e.source === nodo.id && (e.sourceHandle ?? 'output') !== 'catch')
  if (uscite.length !== 1) return null
  const filtro = nodes.find((n) => n.id === uscite[0].target)
  if (!filtro || filtro.data.type !== 'filter') return null
  if (edges.filter((e) => e.target === filtro.id).length !== 1) return null
  if (edges.some((e) => e.source === filtro.id && e.sourceHandle === 'reject')) return null
  const conds = (filtro.data.config as { filter?: { conditions?: unknown[] } } | undefined)?.filter?.conditions
  if (!conds?.length) return null
  return filtro
}
