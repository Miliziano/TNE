/**
 * src/nodes/types/activemq/schema.ts
 *
 * Schema d'uscita del source_activemq + propagazione a valle.
 * Stesso pattern di dir_watcher/webhook: il pannello mostrerebbe i campi ma
 * senza scrivere `props.outputSchema` né propagare, a valle (tmap/log) si
 * vedono ZERO campi. `useActiveMQSourceSchemaSync` scrive lo schema e chiama
 * `propagateSchema`.
 *
 * Allineato al motore: la Row emessa da
 * src-tauri/src/engine/nodes/source_activemq.rs (5 campi fissi).
 *
 * NB: il pannello ActiveMQ è condiviso source/sink; l'hook agisce SOLO se il
 * nodo è `source_activemq` (va comunque chiamato incondizionato — regole
 * degli hook — e filtra dentro l'effect).
 */
import { useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { propagateSchema } from '../../../utils/schemaUtils'
import type { SchemaField } from '../../../ir/types'

export function activemqSourceFields(): SchemaField[] {
  return [
    { id: 'amq_destination', name: 'destination', type: 'string', physicalName: 'destination' },
    { id: 'amq_payload',     name: 'payload',     type: 'object', physicalName: 'payload'     },
    { id: 'amq_headers',     name: 'headers',     type: 'object', physicalName: 'headers'     },
    { id: 'amq_message_id',  name: 'message_id',  type: 'string', physicalName: 'message_id' },
    { id: 'amq_received_at', name: 'received_at', type: 'date',   physicalName: 'received_at' },
  ]
}

export function useActiveMQSourceSchemaSync(nodeId: string): void {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  useEffect(() => {
    // Solo per il consumer: il sink non ha uno schema d'uscita fisso.
    if (!node || node.data.type !== 'source_activemq') return
    const fields = activemqSourceFields()
    const next   = JSON.stringify(fields)
    if (node.data.props.outputSchema !== next) {
      updateProp(nodeId, 'outputSchema', next)
    }
    propagateSchema(nodeId, fields, useFlowStore.getState())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, node?.data.type])
}
