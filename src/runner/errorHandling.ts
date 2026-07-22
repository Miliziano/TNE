/**
 * src/runner/errorHandling.ts
 *
 * Helper condivisi per il routing degli errori verso il nodo
 * Error Handler della lane (src/nodes/ErrorHandlerNode.tsx +
 * src/nodes/types/error_handler/*).
 *
 * Schema riga d'errore prodotta da buildErrorRow() — corrisponde a
 * ERROR_HANDLER_SCHEMA in src/types/index.ts:
 *   _error_message, _error_code, _error_node_id, _error_node_type,
 *   _error_at, _error_row, _error_lane_id, _error_source
 */

import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData, ErrorRule } from '../types'
import type { Row, ExecutionContext } from '../io/types'

// ─── Trova l'Error Handler della lane ─────────────────────────────
export function findErrorHandler(
  context: ExecutionContext,
  laneId:  string,
): FlowNode<NodeData> | undefined {
  return context.nodes.find(
    (n) => n.data.type === 'error_handler' && n.data.laneId === laneId,
  )
}

// ─── Costruisce la riga enriched per error_out / catch ────────────
export function buildErrorRow(
  message:     string,
  node:        FlowNode<NodeData>,
  sourceRow:   Row,
  errorSource: 'unhandled' | 'explicit',
): Row {
  return {
    ...sourceRow,
    _error_message:   message,
    _error_code:      'EXECUTION_ERROR',
    _error_node_id:   node.id,
    _error_node_type: node.data.type,
    _error_at:        new Date().toISOString(),
    _error_row:       sourceRow,
    _error_lane_id:   node.data.laneId,
    _error_source:    errorSource,
  }
}

export interface RuleMatch {
  // CODICE MORTO: `string` invece di ErrorRule['action'], che ora non
  // contempla più retry/skip. Isolato, non aggiornato (HANDOFF §7).
  action:      string
  retryCount?: number
}

/**
 * Valuta in ordine le regole del tab "Configurazione" dell'Error Handler.
 * Restituisce la prima corrispondenza, o null se nessuna regola matcha
 * (in tal caso si applica la policy onError del singolo nodo).
 */
export function evalErrorRules(
  errorHandler: FlowNode<NodeData> | undefined,
  node:         FlowNode<NodeData>,
  message:      string,
): RuleMatch | null {
  if (!errorHandler) return null

  let rules: ErrorRule[] = []
  try {
    const parsed = JSON.parse(errorHandler.data.props?.['rules'] ?? '[]')
    if (Array.isArray(parsed)) rules = parsed
  } catch { /* rules malformate — ignora */ }

  for (const rule of rules) {
    let matches = false
    switch (rule.matchType) {
      case 'always':
        matches = true
        break
      case 'node_type':
        matches = node.data.type === rule.matchValue
        break
      case 'error_code':
        matches = !!rule.matchValue &&
          message.toLowerCase().includes(rule.matchValue.toLowerCase())
        break
    }
    if (matches) {
      // CODICE MORTO — vedi intestazione del modulo. `retryCount` non
      // esiste più su ErrorRule (il retry appartiene al nodo): letto qui
      // in modo destrutturato solo per non tipizzare il file morto.
      const legacy = rule as unknown as { action: string; retryCount?: string }
      return {
        action:     legacy.action,
        retryCount: legacy.retryCount ? parseInt(legacy.retryCount, 10) : undefined,
      }
    }
  }
  return null
}

/** true se il nodo ha un edge uscente sull'handle indicato */
export function hasOutgoingEdge(edges: Edge[], nodeId: string, handle: string): boolean {
  return edges.some((e) => e.source === nodeId && (e.sourceHandle ?? 'output') === handle)
}
