/**
 * src/nodes/types/data_quality/useDqSchemaSync.ts
 *
 * P368: scrive `outputSchema` del Data Quality (ingresso + `_dq`) e lo porta
 * a valle quando cambia (ingresso o nome del campo).
 */
import { useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import { propagateSchema } from '../../../utils/schemaUtils'
import type { SchemaField } from '../../../utils/schemaUtils'
import { readDqConfig, dqOutputSchema } from './schema'

/** Scrive `outputSchema` e lo porta a valle quando cambia. Va chiamato
 *  prima di ogni return anticipato (regole degli hook). */
export function useDqSchemaSync(nodeId: string): SchemaField[] {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const incoming   = useIncomingSchema(nodeId)
  const config     = readDqConfig(node?.data.props['dqConfig'])
  const fields     = dqOutputSchema(incoming, config)
  const json       = JSON.stringify(fields)

  useEffect(() => {
    if (!node || node.data.props['outputSchema'] === json) return
    updateProp(nodeId, 'outputSchema', json)
    propagateSchema(nodeId, fields, useFlowStore.getState())
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, json, !!node])

  return fields
}
