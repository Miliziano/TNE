/**
 * src/nodes/types/explode/schema.ts
 *
 * Schema d'uscita dell'Explode (P360) — una sola regola, la stessa del
 * motore (src-tauri/src/engine/nodes/explode.rs):
 *
 *   - con un mapping (`explodeMapping`): i campi inclusi, col nome logico
 *     e il tipo dichiarato (le vecchie trasformazioni to_* valgono come
 *     tipo); con "Propagate parent fields" (solo flow_field) prima i campi
 *     della riga padre, meno quello esploso — a parità di nome vince
 *     l'elemento esploso;
 *   - senza mapping, sorgente materialize: lo schema del dataset;
 *   - senza mapping, sorgente flow_field: lo schema dichiarato a mano coi
 *     pannelli precedenti, se c'è (il motore emette tutti i campi).
 */
import type { SchemaField } from '../../../utils/schemaUtils'
import { materializeDatasetSchemaRaw } from '../materialize/schema'

export type ExplodeMappingField = {
  sourceField: string
  outputName:  string
  type:        string
  transform:   string
  include:     boolean
}


/** Trasformazioni offerte (le conversioni le fa la colonna Type). */
export const EXPLODE_TRANSFORMS = [
  { value: '',              label: 'none'       },
  { value: 'trim',          label: 'trim'       },
  { value: 'uppercase',     label: 'UPPER'      },
  { value: 'lowercase',     label: 'lower'      },
  { value: 'nullify_empty', label: 'empty→null' },
]

/** Vecchie trasformazioni-conversione: il motore le applica come tipo. */
const LEGACY_TYPE: Record<string, string> = {
  to_int: 'integer', to_integer: 'integer', to_float: 'decimal', to_decimal: 'decimal',
  to_date: 'date', to_bool: 'boolean', to_boolean: 'boolean', to_string: 'string',
}

export function readExplodeMapping(raw: string | undefined): ExplodeMappingField[] {
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed : []
  } catch { return [] }
}

/** Schema del dataset letto dal Materialize indicato (senza i campi signal). */
export function materializeSchemaOf(matNode: { data: { props: Record<string, string> } } | null | undefined): SchemaField[] {
  if (!matNode) return []
  try {
    const raw = materializeDatasetSchemaRaw(matNode.data.props)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return (parsed as Array<Partial<SchemaField>>)
      .map((f, i) => ({
        id:           f.id   ?? `mat_field_${i}`,
        name:         f.name ?? `field_${i}`,
        type:         f.type ?? 'string',
        physicalName: f.physicalName ?? f.name,
      }))
  } catch { return [] }
}

export function explodeOutputSchema(args: {
  props:             Record<string, string>
  parentFields:      SchemaField[]
  materializeSchema: SchemaField[]
}): SchemaField[] {
  const { props, parentFields, materializeSchema } = args
  const source  = props['explodeSource'] ?? 'materialize'
  const mapping = readExplodeMapping(props['explodeMapping'])
  const included = mapping.filter((f) => f.include && (f.sourceField || f.outputName))

  if (included.length === 0) {
    if (source === 'materialize') return materializeSchema
    // flow_field senza mapping: resta lo schema dichiarato a mano, finché
    // il mapping non è mai stato toccato.
    if (props['explodeMapping'] === undefined) {
      try {
        const cur = JSON.parse(props['outputSchema'] ?? '[]')
        return Array.isArray(cur) ? cur : []
      } catch { return [] }
    }
  }

  const child: SchemaField[] = included.map((f) => {
    const key = f.sourceField || f.outputName
    return {
      id:           key,
      name:         f.outputName || f.sourceField,
      physicalName: key,
      type:         LEGACY_TYPE[f.transform] ?? (f.type || 'string'),
    }
  })

  if (source !== 'flow_field' || props['includeParent'] !== 'true') return child

  const childNames = new Set(child.map((f) => f.name))
  const parent = parentFields
    .filter((f) => f.name !== props['flowField'] && !childNames.has(f.name))
    .map((f) => ({ id: f.id ?? f.name, name: f.name, type: f.type ?? 'string', physicalName: f.physicalName ?? f.name }))
  return [...parent, ...child]
}
