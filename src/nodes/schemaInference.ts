import type { TMapInputField, TMapFieldType } from '../types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { FIXED_SCHEMA } from './fileSchema'

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
    // ── Sink File — pass-through, propaga schema in ingresso ──────
    case 'sink_file': {
      const passthrough = props.passthrough === 'true'
      const outputMode  = props.outputMode ?? 'passthrough'

      // Status è sempre presente
      const statusFields: TMapInputField[] = [
        { name: 'status.ok',             type: 'boolean' },
        { name: 'status.rows_processed', type: 'integer' },
        { name: 'status.rows_written',   type: 'integer' },
        { name: 'status.bytes_written',  type: 'integer' },
        { name: 'status.file_path',      type: 'string'  },
        { name: 'status.completed_at',   type: 'date'    },
        { name: 'status.error_message',  type: 'string'  },
        { name: 'status.duration_ms',    type: 'integer' },
      ]

      // Se pass-through attivo — aggiunge anche i campi row
     if (passthrough) {
        const rowFields: TMapInputField[] = (() => {
          // Prima prova da outputSchema del sink_file
          try {
            const raw = props.outputSchema
            if (raw) {
              const parsed = JSON.parse(raw)
              const mapped = parsed
                .filter((f: { include?: boolean }) => f.include !== false)
                .map((f: { outputName: string; type: string }) => ({
                  name: `row.${f.outputName}`,
                  type: f.type ?? 'string',
                }))
                .filter((f: TMapInputField) => f.name.length > 5)
              if (mapped.length > 0) return mapped
            }
          } catch {}

          // Fallback — propaga dal nodo precedente al sink_file
          const upstream = propagateSchema(node.id, allNodes, allEdges)
          return upstream.map((f) => ({
            name: `row.${f.name}`,
            type: f.type,
          }))
        })()

        return [...rowFields, ...statusFields]
      }

      // Senza pass-through — solo status
      return statusFields
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