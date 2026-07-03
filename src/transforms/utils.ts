import type { TMapTransformNode, TMapConfig, FieldRenameEntry, PipelineStep, CastStep } from '../types'
import type { FieldType } from '../types/fieldTypes'
import { TRANSFORM_CATALOG } from './catalog'

type TransformCategory = FieldType

// Helper — mappa tipi senza preset propri al tipo più vicino
function catalogKey(type: FieldType): FieldType {
  if (type === 'number')   return 'decimal'
  if (type === 'datetime') return 'date'
  return type
}

// ─── Inferenza tipo output ────────────────────────────────────────
// Calcola il tipo finale dopo cast + sequenza di steps pipeline
export function inferOutputType(
  inputType: TransformCategory,
  cast:      CastStep | undefined,
  steps:     PipelineStep[]
): TransformCategory {
  let current = cast ? cast.toType : inputType
  for (const step of steps) {
    const fns = TRANSFORM_CATALOG[catalogKey(current)] ?? []
    const fn  = fns.find((f) => f.id === step.fnId)
    if (fn?.outputType) current = fn.outputType as TransformCategory
  }
  return current
}

// ─── Pipeline → espressione testuale ─────────────────────────────
// Genera l'espressione finale dalla pipeline per esecuzione/export
export function pipelineToExpression(
  inputVars: string[],
  cast:      CastStep | undefined,
  steps:     PipelineStep[]
): string {
  let expr = inputVars.length === 1 ? inputVars[0] : inputVars.join(' + ')

  if (cast) {
    expr = `to${capitalize(cast.toType)}(${expr})`
  }

  const allFns = Object.values(TRANSFORM_CATALOG).flat()
  for (const step of steps) {
    const fn = allFns.find((f) => f.id === step.fnId)
    if (!fn) continue

    let applied = fn.expression.replace('$value', expr)

    // Sostituisci parametri nominali ($param_key) e posizionali ($param0, $param1...)
    fn.params?.forEach((p, i) => {
      const val = step.params[p.key] ?? p.default ?? ''
      applied   = applied.replace(`$param_${p.key}`, val)
      applied   = applied.replace(`$param${i}`, val)
    })

    expr = applied
  }

  return expr
}

// ─── Rename tracking ─────────────────────────────────────────────
// Applica una lista di rename a tutti i transform del TMap.
// Aggiorna:
//   - inputs[].fieldName nei TMapTransformInput
//   - expression (variabili $label.oldName → $label.newName)
//   - pipeline steps: nessun cambiamento strutturale necessario
//     (i steps referenziano fnId dal catalogo, non i nomi dei campi)
//
// Ritorna i transform aggiornati — non muta il tmap originale.
export function applyRenameMap(
  transforms: TMapTransformNode[],
  renames:    FieldRenameEntry[],
  tmap:       TMapConfig
): TMapTransformNode[] {
  if (!renames.length || !transforms.length) return transforms

  return transforms.map((tr) => {
    let changed = false

    // ── 1. Aggiorna inputs ────────────────────────────────────────
    const updatedInputs = tr.inputs.map((inp) => {
      const rename = renames.find(
        (r) => r.inputId === inp.inputId && r.oldName === inp.fieldName
      )
      if (!rename) return inp
      changed = true
      return { ...inp, fieldName: rename.newName }
    })

    // ── 2. Aggiorna espressione inline/script ─────────────────────
    let newExpression = tr.expression
    renames.forEach((r) => {
      const inputLabel = tmap.inputs.find((i) => i.id === r.inputId)?.label ?? r.inputId
      const oldVar     = `$${inputLabel}.${r.oldName}`
      const newVar     = `$${inputLabel}.${r.newName}`
      if (newExpression.includes(oldVar)) {
        newExpression = newExpression.split(oldVar).join(newVar)
        changed       = true
      }
    })

    // ── 3. Pipeline steps ─────────────────────────────────────────
    // I steps referenziano fnId (stabile) e params (valori utente).
    // Le variabili $value nei template del catalogo sono placeholder
    // risolti a runtime — non contengono nomi di campo diretti.
    // Nessun aggiornamento necessario per la pipeline strutturata.
    //
    // Se l'utente ha scritto manualmente un nome di campo nei params
    // (es. in un param "chiave" di get()), non possiamo saperlo
    // automaticamente — lasciamo invariato e aggiungiamo un flag.
    const updatedPipeline = tr.pipeline  // invariato

    if (!changed) return tr

    return {
      ...tr,
      inputs:     updatedInputs,
      expression: newExpression,
      pipeline:   updatedPipeline,
    }
  })
}

// ─── Rimuovi campo dai transform ─────────────────────────────────
// Quando un campo viene cancellato dal nodo sorgente, rimuovilo
// da tutti i transform che lo referenziano, aggiornando l'espressione.
export function removeFieldFromTransforms(
  transforms: TMapTransformNode[],
  inputId:    string,
  fieldName:  string,
  tmap:       TMapConfig
): TMapTransformNode[] {
  if (!transforms.length) return transforms

  const inputLabel = tmap.inputs.find((i) => i.id === inputId)?.label ?? inputId
  const removedVar = `$${inputLabel}.${fieldName}`

  return transforms.map((tr) => {
    const hasField = tr.inputs.some(
      (i) => i.inputId === inputId && i.fieldName === fieldName
    )
    if (!hasField) return tr

    const newInputs = tr.inputs.filter(
      (i) => !(i.inputId === inputId && i.fieldName === fieldName)
    )

    const sep = tr.mode === 'script' ? '\n' : ' + '
    let newExpression = tr.expression
      .split(sep)
      .map((p) => p.trim())
      .filter((p) => p !== removedVar)
      .join(sep)
      .trim()

    if (newExpression === '' && newInputs.length > 0) {
      newExpression = newInputs
        .map((i) => {
          const lbl = tmap.inputs.find((ti) => ti.id === i.inputId)?.label ?? i.inputId
          return `$${lbl}.${i.fieldName}`
        })
        .join(sep)
    }

    // Rimuovi anche dalla pipeline gli step che referenziavano questo campo
    // tramite i params (best-effort — solo corrispondenze esatte)
    const newPipeline = tr.pipeline?.map((step) => ({
      ...step,
      params: Object.fromEntries(
        Object.entries(step.params).map(([k, v]) => [
          k,
          v === removedVar ? '' : v,
        ])
      ),
    }))

    return {
      ...tr,
      inputs:     newInputs,
      expression: newExpression,
      pipeline:   newPipeline,
    }
  })
}

// ─── Helpers ─────────────────────────────────────────────────────
function capitalize(s: string) {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

// Genera le variabili $label.campo per un transform dato il tmap corrente
export function buildInputVars(
  tr:   TMapTransformNode,
  tmap: TMapConfig
): string[] {
  return tr.inputs.map((inp) => {
    const label = tmap.inputs.find((i) => i.id === inp.inputId)?.label ?? inp.inputId
    return `$${label}.${inp.fieldName}`
  })
}