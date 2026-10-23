import type { TMapInputField } from '../types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { FIXED_SCHEMA } from './fileSchema'
import { SINK_FTP_SIGNAL_SCHEMA } from './types/sink_ftp/schema'
import { SINK_FILE_SIGNAL_SCHEMA } from './types/sink_file/schema'

// ─── Schema inferito dai props del nodo ──────────────────────────
export function inferSchema(
  node: FlowNode<NodeData>,
  allNodes: FlowNode<NodeData>[],
  allEdges: { source: string; target: string; targetHandle?: string | null }[]
): TMapInputField[] {

  const props = node.data.props

  switch (node.data.type) {

    // ── DB Source ──────────────────────────────────────────────
    case 'source_db': {
      // Se c'è una query personalizzata non possiamo inferire
      if (props.query && props.query.trim() !== '' && !props.query.startsWith('SELECT *')) {
        return []
      }
      // Se c'è una tabella, generiamo campi placeholder comuni
      if (props.table) {
        return [
          { name: 'id',         type: 'integer' },
          { name: props.table + '_data', type: 'string' },
          { name: 'created_at', type: 'date' },
          { name: 'updated_at', type: 'date' },
        ]
      }
      return []
    }

    // ── File Input ─────────────────────────────────────────────
    case 'source_file': {
      // Usa outputSchema se l'utente lo ha già configurato
      if (props.outputSchema) {
        try {
          return JSON.parse(props.outputSchema)
        } catch {}
      }
      // Schema fisso per formati non strutturati
      const fmt = props.format ?? 'csv'
      if (FIXED_SCHEMA[fmt]) return FIXED_SCHEMA[fmt]
      // Formati strutturati senza schema dichiarato
      return []
    }
    // ── File Output (P361): una riga di stato per file, o le righe ri-emesse ──
    case 'sink_file': {
      if ((props.outputMode ?? 'signal') === 'replay') return propagateSchema(node.id, allNodes, allEdges)
      return SINK_FILE_SIGNAL_SCHEMA.map(({ name, type }) => ({ name, type: type as TMapInputField['type'] }))
    }

    // ── SFTP Output (P356): riga di stato o righe ri-emesse ─────
    case 'sink_ftp': {
      if ((props.outputMode ?? 'signal') === 'passthrough') return propagateSchema(node.id, allNodes, allEdges)
      return SINK_FTP_SIGNAL_SCHEMA.map(({ name, type }) => ({ name, type: type as TMapInputField['type'] }))
    }

    // ── HTTP Source ────────────────────────────────────────────
    case 'source_http': {
      if (props.outputSchema) {
        try {
          return JSON.parse(props.outputSchema)
        } catch {}
      }
      // fallback campi fissi
      return [
        { name: 'status_code',  type: 'integer' },
        { name: 'content_type', type: 'string'  },
        { name: 'latency_ms',   type: 'integer' },
        { name: 'headers',      type: 'object'  },
        { name: 'body',         type: 'string'  },
      ]
    }

    case 'json_parser': {
  // Lo schema dipende dal flusso — letto dall'outputSchema del nodo
      if (props.outputSchema) {
        try { return JSON.parse(props.outputSchema) } catch {}
      }
      return []
    }

    // ── Filter — propaga schema del nodo precedente ────────────
    case 'filter':
    case 'map':
    case 'aggregate':
    case 'join': {
      return propagateSchema(node.id, allNodes, allEdges)
    }

    // ── Script — non inferibile ────────────────────────────────
   case 'script': {
      if (props.outputSchema) {
        try {
          const parsed = JSON.parse(props.outputSchema)
          if (Array.isArray(parsed) && parsed.length > 0) {
            return parsed.map((f: any) => ({
              name: f.name,
              type: f.type ?? 'string',
              id:   f.id,
            }))
          }
        } catch {}
      }
      return []
    }

    // ── TMap — propaga schema del main input ───────────────────
    case 'tmap': {
      return propagateSchema(node.id, allNodes, allEdges)
    }

    default:
      return []
    }
}

// ─── Propaga lo schema dal nodo connesso in ingresso ─────────────
function propagateSchema(
  nodeId: string,
  allNodes: FlowNode<NodeData>[],
  allEdges: { source: string; target: string; targetHandle?: string | null }[]
): TMapInputField[] {
  // Trova il nodo che si connette in ingresso
  const incomingEdge = allEdges.find((e) => e.target === nodeId)
  if (!incomingEdge) return []

  const sourceNode = allNodes.find((n) => n.id === incomingEdge.source)
  if (!sourceNode) return []

  // Ricorsivo — inferisce lo schema del nodo sorgente
  return inferSchema(sourceNode, allNodes, allEdges)
}

// ─── Merge schema inferito con campi esistenti ───────────────────
// Non sovrascrive i campi già dichiarati dall'utente
export function mergeSchema(
  existing: TMapInputField[],
  inferred: TMapInputField[]
): TMapInputField[] {
  const existingNames = new Set(existing.map((f) => f.name))

  // Aggiungi solo i campi inferiti che non esistono già
  const newFields = inferred.filter((f) => !existingNames.has(f.name))

  return [...existing, ...newFields]
}