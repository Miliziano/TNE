/**
 * src/nodes/types/json_parser/schema.ts
 *
 * Schema di uscita di un flusso del JSON Parser — fonte unica per
 * registry, propagazione, connessioni e lowering.
 *
 * Con "campi del padre" (mergeParent) il motore aggiunge a ogni riga del
 * flusso i campi della riga in ingresso scelti in parentFields; i campi del
 * flusso hanno la precedenza a parità di nome (json_parser.rs, or_insert).
 * Lo studio li dichiara solo quando la scelta è esplicita: con parentFields
 * vuoto il motore copia TUTTO l'ingresso, che qui non è noto.
 */
import type { JsonParserFlow } from './jsonParserTypes'

export interface JsonParserFlowField { id: string; name: string; type: string }

export function jsonParserFlowFields(flow: Pick<JsonParserFlow, 'id' | 'fields' | 'mergeParent' | 'parentFields' | 'parentSchema'>): JsonParserFlowField[] {
  const own: JsonParserFlowField[] = (flow.fields ?? [])
    .filter((f) => f.name)
    .map((f) => ({ id: f.id, name: f.name, type: f.type ?? 'string' }))
  if (!flow.mergeParent || !flow.parentFields?.length) return own
  const taken = new Set(own.map((f) => f.name))
  const typeOf = new Map((flow.parentSchema ?? []).map((p) => [p.name, p.type]))
  const parent = flow.parentFields
    .filter((name) => name && !taken.has(name))
    .map((name) => ({ id: `${flow.id}__parent_${name}`, name, type: typeOf.get(name) ?? 'any' }))
  return [...own, ...parent]
}
