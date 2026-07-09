/**
 * src/transforms/presets.ts
 *
 * API dei preset per il pannello Transform.
 *
 * Dopo la migrazione a FPEL non esiste più il tipo `Preset` con `jsExpr`:
 * i preset SONO i TransformTemplate del catalogo, con espressioni FPEL
 * compilate in ExprNode da `templateCompiler.ts`.
 *
 * Rimossi (erano JavaScript, non traducibile dal codegen):
 *   - interface Preset (campo jsExpr)
 *   - catalogExprToJs()  — 30 regex mini-linguaggio → JS
 *   - templateToPreset() — adattatore verso jsExpr
 *   - evalPreset()       — costruiva ed eseguiva stringhe JS
 */

export type { FieldType, TMapFieldType, TransformCategory, TypeMeta } from '../types/fieldTypes'
export { FIELD_TYPES, TYPE_META, typeBadgeStyle, typeSelectStyle } from '../types/fieldTypes'
export { TRANSFORM_CATALOG, getTransformsForType, findTransform, getAllTransforms } from './catalog'
export type { TransformTemplate, TransformParam } from './catalog'

import { TRANSFORM_CATALOG, type TransformTemplate, type TransformCategory } from './catalog'
import type { FieldType } from '../types/fieldTypes'

// ─── Preset universali ─────────────────────────────────────────────
// Validi per ogni tipo di campo. `passthrough` ed `expr` hanno un
// significato speciale, riconosciuto da templateCompiler.compileField():
//   passthrough → il campo passa invariato (DirectFieldRef)
//   expr        → l'utente scrive l'espressione FPEL a mano

const UNIVERSAL_PRESETS: TransformTemplate[] = [
  {
    id: 'passthrough', label: 'Passthrough',
    description: 'Valore invariato',
    expression: '$value',
  },
  {
    id: 'null_if_empty', label: 'Null se vuoto',
    description: 'null se stringa vuota o null',
    expression: 'iif($value == "" or $value is null, null, $value)',
  },
  {
    id: 'coalesce_empty', label: 'Stringa vuota se null',
    description: 'Sostituisce null con la stringa vuota',
    outputType: 'string',
    expression: 'coalesce($value, "")',
  },
  {
    id: 'expr', label: '{ } Espressione personalizzata…',
    description: 'Scrivi un\'espressione FPEL (es. upper(trim($value)))',
    expression: '$value',   // segnaposto: compileField usa field.expression
  },
]

// ─── Preset specifici per datetime ─────────────────────────────────
// Non stanno nel catalogo `date` perché operano su data+ora.

const DATETIME_PRESETS: TransformTemplate[] = [
  {
    id: 'dt_locale_it', label: '→ Formato italiano',
    description: 'gg/mm/aaaa hh:mm:ss',
    outputType: 'string',
    expression: 'date_format($value, "DD/MM/YYYY HH:mm:ss")',
  },
  {
    id: 'dt_time_only', label: '→ Solo ora (HH:mm)',
    description: 'Estrae solo ora e minuti',
    outputType: 'string',
    expression: 'date_format($value, "HH:mm")',
  },
]

// ─── API pubblica ──────────────────────────────────────────────────

/**
 * Preset disponibili per un tipo di campo: universali in cima, poi quelli
 * del catalogo, poi gli specifici del tipo.
 * Unica fonte di verità: TRANSFORM_CATALOG.
 */
export function getPresetsForType(type: FieldType): TransformTemplate[] {
  const catalogType = (type === 'datetime' ? 'date' : type) as TransformCategory
  const fromCatalog = TRANSFORM_CATALOG[catalogType] ?? []
  const extra = type === 'datetime' ? DATETIME_PRESETS : []
  return [...UNIVERSAL_PRESETS, ...fromCatalog, ...extra]
}

/** Cerca un preset per id, inclusi gli universali e i datetime. */
export function findPreset(id: string): TransformTemplate | undefined {
  const universal = [...UNIVERSAL_PRESETS, ...DATETIME_PRESETS].find(p => p.id === id)
  if (universal) return universal
  for (const list of Object.values(TRANSFORM_CATALOG)) {
    const hit = list.find(t => t.id === id)
    if (hit) return hit
  }
  return undefined
}