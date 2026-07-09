/**
 * src/transforms/templateCompiler.ts
 *
 * Compila un template del catalogo (o un'espressione libera) in ExprNode.
 *
 * Pipeline:
 *   TransformField (presetId + params + source)
 *     → espressione FPEL con segnaposto risolti
 *     → parseExpression()
 *     → ExprNode  (IR: eseguito dal motore, tradotto dal codegen)
 *
 * Sostituisce `catalogExprToJs` + `eval()`: niente più JavaScript.
 */

import { parseExpression, ExprParseError, type ExprNode } from '../ir/exprParser'
import { findPreset, type TransformTemplate, type TransformParam } from './presets'
import type { FieldType } from '../types/fieldTypes'

/** Un campo così come lo salva il pannello Transform. */
export interface TransformFieldSpec {
  source:     string                    // campo di input
  output:     string                    // campo di output
  type:       FieldType
  presetId:   string                    // id del template, o 'expr' / 'passthrough'
  params:     Record<string, string>
  expression: string                    // usata solo se presetId === 'expr'
  enabled:    boolean
}

export interface CompiledField {
  name: string
  expr: ExprNode
}

/** Errore con il contesto del campo, per mostrarlo nel pannello. */
export class TemplateCompileError extends Error {
  readonly field: string
  readonly detail: string
  constructor(field: string, detail: string) {
    super(`campo "${field}": ${detail}`)
    this.name = 'TemplateCompileError'
    this.field = field
    this.detail = detail
  }
}

// ─── Quoting dei letterali ──────────────────────────────────────────

/** Racchiude un testo in una stringa FPEL, con escape. */
function quoteString(v: string): string {
  return '"' + v.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"'
}

/**
 * Converte il valore di un parametro nel letterale FPEL corrispondente,
 * secondo il tipo dichiarato nel template.
 *
 * Senza questo, `char: "0"` finirebbe come numero 0 invece che stringa "0",
 * e un testo con virgolette romperebbe il parsing.
 */
function paramToLiteral(raw: string, param: TransformParam | undefined): string {
  const v = (raw ?? param?.default ?? '').trim()

  if (param?.type === 'number') {
    if (v === '') return '0'
    if (!/^-?\d+(\.\d+)?$/.test(v)) {
      throw new Error(`parametro "${param.key}" deve essere numerico (ricevuto "${v}")`)
    }
    return v
  }

  // 'select' e 'text' → sempre stringa quotata.
  // Eccezione: i booleani letterali, usati da alcuni template.
  if (v === 'true' || v === 'false' || v === 'null') return v

  return quoteString(v)
}

// ─── Risoluzione dei segnaposto ─────────────────────────────────────

/**
 * Sostituisce $value e $param_<key> nell'espressione del template.
 * $value diventa il NOME del campo sorgente (un identificatore, non una
 * stringa), quindi il parser lo compila in DirectFieldRef.
 */
export function resolveTemplate(
  template: TransformTemplate,
  sourceField: string,
  params: Record<string, string>,
): string {
  let expr = template.expression

  // I parametri PRIMA di $value: `$param_x` contiene `$param`, e una
  // sostituzione ingenua di `$value` non li tocca, ma l'ordine inverso
  // sarebbe fragile se un giorno esistesse `$value_x`.
  expr = expr.replace(/\$param_(\w+)/g, (_m, key: string) => {
    const def = template.params?.find(p => p.key === key)
    return paramToLiteral(params[key], def)
  })

  if (!sourceField.trim()) {
    throw new Error('nessun campo sorgente selezionato')
  }
  expr = expr.replace(/\$value/g, sourceField)

  return expr
}

// ─── Compilazione ───────────────────────────────────────────────────

/**
 * Compila un singolo campo in ExprNode.
 * Lancia TemplateCompileError se il template non esiste, un parametro è
 * malformato, o l'espressione non è valida FPEL.
 */
export function compileField(f: TransformFieldSpec): CompiledField {
  const out = f.output.trim()
  if (!out) throw new TemplateCompileError('(senza nome)', 'nome del campo di output mancante')

  let exprText: string

  try {
    if (f.presetId === 'expr') {
      // Espressione libera scritta dall'utente: già FPEL.
      if (!f.expression.trim()) throw new Error('espressione vuota')
      exprText = f.expression
    } else if (f.presetId === 'passthrough' || !f.presetId) {
      // Il campo passa invariato.
      if (!f.source.trim()) throw new Error('nessun campo sorgente selezionato')
      exprText = f.source
    } else {
      const tpl = findPreset(f.presetId)
      if (!tpl) throw new Error(`template sconosciuto: "${f.presetId}"`)
      exprText = resolveTemplate(tpl, f.source, f.params ?? {})
    }
  } catch (e) {
    throw new TemplateCompileError(out, (e as Error).message)
  }

  try {
    return { name: out, expr: parseExpression(exprText) }
  } catch (e) {
    const detail = e instanceof ExprParseError
      ? `${e.message}\n  ${exprText}\n  ${' '.repeat(Math.max(0, e.pos))}^`
      : (e as Error).message
    throw new TemplateCompileError(out, detail)
  }
}

/**
 * Compila tutti i campi abilitati di un nodo transform.
 * Raccoglie TUTTI gli errori invece di fermarsi al primo: l'utente vede
 * ogni campo problematico in una volta.
 */
export function compileTransformFields(fields: TransformFieldSpec[]): {
  compiled: CompiledField[]
  errors:   TemplateCompileError[]
} {
  const compiled: CompiledField[] = []
  const errors:   TemplateCompileError[] = []

  for (const f of fields) {
    if (!f.enabled) continue
    try { compiled.push(compileField(f)) }
    catch (e) {
      if (e instanceof TemplateCompileError) errors.push(e)
      else errors.push(new TemplateCompileError(f.output || '?', String(e)))
    }
  }

  return { compiled, errors }
}