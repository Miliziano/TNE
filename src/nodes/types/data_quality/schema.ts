/**
 * src/nodes/types/data_quality/schema.ts
 *
 * Config e schema d'uscita del Data Quality (P368) — una sola lettura per
 * pannello, mapping e propagazione.
 *
 * Il motore (src-tauri/src/engine/nodes/data_quality.rs) non filtra: ogni
 * riga esce con i campi d'ingresso (eventualmente riparati) più il campo
 * `outputField` (default `_dq`), un oggetto con score, valid, level,
 * repaired, dimensions, issues (+ score_original, original_row se attivi).
 * Prima lo schema d'uscita non lo diceva: a valle `_dq` non si vedeva.
 *
 * Funzioni pure (le usano anche useIncomingSchema e propagateSchema);
 * l'hook del pannello è in useDqSchemaSync.ts.
 */
import type { SchemaField } from '../../../utils/schemaUtils'
import type { DQConfig } from './dqTypes'
import { DEFAULT_DQ_CONFIG } from './dqTypes'

/** `props.dqConfig` coi default (stessi del builder in Toolbar). */
export function readDqConfig(raw: string | undefined): DQConfig {
  try {
    const c = JSON.parse(raw || '{}')
    return {
      ...DEFAULT_DQ_CONFIG, ...c,
      rules:      Array.isArray(c.rules) ? c.rules : [],
      weights:    { ...DEFAULT_DQ_CONFIG.weights,    ...(c.weights ?? {}) },
      thresholds: { ...DEFAULT_DQ_CONFIG.thresholds, ...(c.thresholds ?? {}) },
    }
  } catch { return DEFAULT_DQ_CONFIG }
}

/** Campo aggiunto dal nodo (nome effettivo: vuoto = `_dq`). */
export function dqOutputFieldName(config: DQConfig): string {
  return (config.outputField ?? '').trim() || '_dq'
}

/** Ingresso + il campo `_dq` (un campo d'ingresso con lo stesso nome viene sostituito). */
export function dqOutputSchema(incoming: SchemaField[], config: DQConfig): SchemaField[] {
  const name = dqOutputFieldName(config)
  return [
    ...incoming.filter((f) => f.name !== name),
    { id: `dq_${name}`, name, type: 'object', physicalName: name },
  ]
}
