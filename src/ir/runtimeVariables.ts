/**
 * src/ir/runtimeVariables.ts
 *
 * Variabili di pool CONFIGURABILI AL RUN (P381, fase 2 di
 * docs/ARCHITETTURA-coordinatore.md §4.4).
 *
 * Una variabile marcata `configurable` non resta congelata nell'artifact: il
 * manifesto firmato la dichiara (tipo, default, vincoli) e il runner accetta un
 * valore diverso da un file `--config`, solo se rispetta i vincoli. Questo modulo
 * è la fonte unica di come lo studio la dichiara; la validazione VERA la fa il
 * Rust (`runtime/config.rs`), anche al momento della firma.
 */
import type { Variable } from '../types'

/** Tipo del manifesto (contratto lato runner). */
export type ManifestVarType = 'string' | 'number' | 'boolean' | 'json'

export interface ManifestVariable {
  type:     ManifestVarType
  default:  string
  allowed?: string[]
  min?:     number
  max?:     number
  pattern?: string
}

const TYPE_MAP: Partial<Record<Variable['type'], ManifestVarType>> = {
  string: 'string', number: 'number', boolean: 'boolean', json: 'json', object: 'json',
}

/** Può diventare configurabile? Solo valori veri: niente segreti né dataset. */
export function canBeConfigurable(v: Pick<Variable, 'type'>): boolean {
  return TYPE_MAP[v.type] !== undefined
}

export function isConfigurable(v: Variable): boolean {
  return !!v.configurable && canBeConfigurable(v)
}

/** Dichiarazioni per il manifesto. `activeProfile` dà il default (il valore che
 *  l'artifact avrebbe congelato): senza file `--config` non cambia nulla. */
export function manifestVariables(
  poolVars: Variable[],
  activeProfile: Record<string, string>,
): Record<string, ManifestVariable> {
  const out: Record<string, ManifestVariable> = {}
  for (const v of poolVars) {
    if (!isConfigurable(v)) continue
    const c = v.configurable!
    const decl: ManifestVariable = { type: TYPE_MAP[v.type]!, default: activeProfile[v.name] ?? v.value }
    const allowed = (c.allowed ?? []).map((s) => s.trim()).filter((s) => s !== '')
    if (allowed.length) decl.allowed = allowed
    if (decl.type === 'number') {
      if (typeof c.min === 'number' && Number.isFinite(c.min)) decl.min = c.min
      if (typeof c.max === 'number' && Number.isFinite(c.max)) decl.max = c.max
    }
    if (decl.type === 'string' && c.pattern && c.pattern.trim() !== '') decl.pattern = c.pattern.trim()
    out[v.name] = decl
  }
  return out
}

/** Nomi delle variabili configurabili (per lasciare `${NOME}` nelle risorse). */
export function configurableNames(poolVars: Variable[]): Set<string> {
  return new Set(poolVars.filter(isConfigurable).map((v) => v.name))
}

/** Versione minima del runner per un artifact che dichiara variabili. */
export const ENGINE_RANGE_WITH_VARIABLES = '>=0.2.0'
