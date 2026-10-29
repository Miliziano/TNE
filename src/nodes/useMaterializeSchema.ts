/**
 * src/nodes/useMaterializeSchema.ts
 *
 * Hook comune per Window e Aggregate — legge lo schema del Materialize
 * selezionato dalla lane e lo restituisce come array di SchemaField.
 *
 * Usato quando dataSource === 'materialize'.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../store/flowStore'
import type { SchemaField } from '../utils/schemaUtils'
import { materializeDatasetSchemaRaw } from './types/materialize/schema'

export function useMaterializeSchema(
  nodeId:        string,
  materializeName: string,
): SchemaField[] {
  const nodes = useFlowStore((s) => s.nodes)
  const pool  = useFlowStore((s) => s.pool)
  const node  = nodes.find((n) => n.id === nodeId)

  return useMemo((): SchemaField[] => {
    if (!node || !materializeName) return []

    const laneId   = node.data.laneId
    const laneVars = pool.lanes.find((l) => l.id === laneId)?.variables ?? []
    const matVar   = laneVars.find((v) => v.type === 'materialize' && v.name === materializeName)
    if (!matVar) return []

    const matNode = nodes.find((n) => n.id === matVar.value)
    if (!matNode) return []

    try {
      // P366: lo schema del DATASET (le righe in ingresso), non la riga di
      // stato. Prima si toglievano per nome i campi del segnale, e un campo
      // dati chiamato `name` o `status` spariva.
      const raw = materializeDatasetSchemaRaw(matNode.data.props)
      if (!raw) return []
      const parsed = JSON.parse(raw)
      if (!Array.isArray(parsed)) return []

      return parsed
        .map((f: any, i: number) => ({
          id:           f.id   ?? `mf_${i}`,
          name:         f.name ?? `field_${i}`,
          type:         f.type ?? 'string',
          physicalName: f.physicalName ?? f.name,
        }))
    } catch {
      return []
    }
  }, [node?.data.laneId, materializeName, nodes, pool])
}

