/**
 * src/ir/tmapExprConverter.ts
 *
 * Converte le TMapConfig in TMapPlan — la struttura tipizzata
 * che viene serializzata nel Plan JSON e mandata al Engine Rust.
 *
 * Responsabilità:
 * 1. Converte le expression string dei campi output in ExprNode
 * 2. Inferisce il tipo output da ogni ExprNode (risolve il problema
 *    di propagazione dei tipi: il tipo non è più impostato a mano
 *    ma derivato automaticamente dall'espressione)
 * 3. Costruisce la struttura lookup con join_pairs risolta
 * 4. Converte le transforms in ExprNode
 *
 * Output: TMapPlan — JSON-serializzabile, direttamente usabile
 * dal nodo Rust `tmap` tramite serde_json::from_value.
 */

import type { TMapConfig, TMapInput, TMapOutput, TMapOutputField } from '../types'
import type { JoinPair, JoinFieldExpr } from '../nodes/types/tmap/TMapModal'
import { ExprParseError, riferimentoInput } from './exprParser'
import { compileFpel, type UserFunction } from './userFunctions'
import { findPreset } from '../transforms/presets'
import { resolveTemplate } from '../transforms/templateCompiler'
import { inferExprType as inferTipoCondiviso, type InferCtx } from './exprTypes'
import type { FieldType } from '../types/fieldTypes'

// ─── Tipi del Plan ────────────────────────────────────────────────
// Questi tipi vengono serializzati in JSON e letti da Rust.
// Devono corrispondere esattamente alle struct Rust in engine/nodes/tmap.rs

export interface TMapPlan {
  /** Id dell'input isMain */
  main_input_id: string

  /** Lookup in ordine topologico di materializzazione */
  lookups: TMapLookupPlan[]

  /** Output del TMap */
  outputs: TMapOutputPlan[]

  /** Transforms (variabili intermedie) in ordine di dipendenza */
  transforms: TMapTransformPlan[]

  /** Variabili di lane accessibili a tutti i nodi */
  lane_variables: string[]
}

export interface TMapLookupPlan {
  /** Id dell'input nel TMapConfig */
  input_id: string
  label: string
  join_type: 'inner' | 'left' | 'first'

  /**
   * Coppie di join risolte — come costruire la chiave di lookup.
   * Una coppia = una condizione di match.
   * Se più coppie → AND logico (tutte devono matchare).
   */
  join_pairs: TMapJoinPairPlan[]
}

export interface TMapJoinPairPlan {
  /** Espressione che produce la chiave lato sorgente */
  src_key_expr: ExprNode
  /** Campo del lookup su cui fare il match */
  dst_field: string
  /** Espressione opzionale per trasformare il campo del lookup */
  dst_key_expr?: ExprNode
}

export interface TMapOutputPlan {
  output_id: string
  label: string
  /** null = default (tutte le righe con match) */
  filter_expr: ExprNode | null
  fields: TMapOutputFieldPlan[]
}

export interface TMapOutputFieldPlan {
  name: string
  type: string
  /** ExprNode che produce il valore del campo */
  expr: ExprNode
}

export interface TMapTransformPlan {
  id: string
  output_name: string
  output_type: string
  /** ExprNode che produce il valore della transform */
  expr: ExprNode
}

// ─── ExprNode (speculare a engine/expr.rs) ───────────────────────
// Importato da types o ridefinito qui per chiarezza
export type ExprNode =
  | { kind: 'Literal'; value: string | number | boolean | null }
  | { kind: 'FieldRef'; input: string; field: string }
  | { kind: 'DirectFieldRef'; field: string }
  | { kind: 'BinaryOp'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'UnaryOp'; op: string; expr: ExprNode }
  | { kind: 'FunctionCall'; name: string; args: ExprNode[] }
  | { kind: 'CaseWhen'; branches: Array<{ condition: ExprNode; value: ExprNode }>; default: ExprNode | null }
  | { kind: 'Cast'; expr: ExprNode; target_type: string }
  | { kind: 'IsNull'; expr: ExprNode }
  | { kind: 'IsNotNull'; expr: ExprNode }
  | { kind: 'Coalesce'; args: ExprNode[] }

// ─── Entry point ──────────────────────────────────────────────────

// Funzioni utente FPEL in scope durante la conversione (impostate all'ingresso
// di buildTMapPlan). Un solo chiamante, esecuzione sincrona ⇒ sicuro.
let userFnScope: UserFunction[] = []

export function buildTMapPlan(tmap: TMapConfig, userFunctions: UserFunction[] = []): TMapPlan {
  userFnScope = userFunctions
  const mainInput = tmap.inputs.find(i => i.isMain)
  if (!mainInput) throw new Error('TMap: nessun input main trovato')

  // Mappa label → inputId (per parsing delle expression)
  const labelToInputId = new Map<string, string>()
  for (const inp of tmap.inputs) {
    labelToInputId.set(inp.label, inp.id)
  }

  // Mappa inputId → campi (per inferenza dei tipi)
  const inputFields = new Map<string, Map<string, string>>()
  for (const inp of tmap.inputs) {
    const fieldMap = new Map<string, string>()
    for (const f of inp.fields) {
      fieldMap.set(f.name, f.type)
    }
    inputFields.set(inp.id, fieldMap)
  }

  // Mappa transformId → outputName e outputType (per referenze da output)
  const transformByOutputName = new Map<string, { id: string; outputType: string }>()
  for (const tr of tmap.transforms ?? []) {
    if (tr.outputName) {
      transformByOutputName.set(tr.outputName, { id: tr.id, outputType: tr.outputType })
    }
  }

  // ── 1. Ordine topologico dei lookup ───────────────────────────
  const lookups = buildLookupOrder(tmap, mainInput.id, labelToInputId, inputFields)

  // ── 2. Transforms ─────────────────────────────────────────────
  const transforms = buildTransforms(tmap, labelToInputId, inputFields)

  // ── 3. Output ─────────────────────────────────────────────────
  const outputs = buildOutputs(
    tmap, labelToInputId, inputFields, transformByOutputName
  )

  return {
    main_input_id:  mainInput.id,
    lookups,
    outputs,
    transforms,
    lane_variables: [],
  }
}

// ─── Lookup in ordine topologico ──────────────────────────────────

function buildLookupOrder(
  tmap:           TMapConfig,
  mainInputId:    string,
  labelToInputId: Map<string, string>,
  inputFields:    Map<string, Map<string, string>>,
): TMapLookupPlan[] {
  const lookupInputs = tmap.inputs.filter(i => !i.isMain)

  // Ordine topologico: se lookup B dipende da lookup A (join A→B),
  // A deve essere materializzato prima di B
  const deps = new Map<string, Set<string>>()
  for (const inp of lookupInputs) {
    deps.set(inp.id, new Set())
    const pairs: JoinPair[] = (inp as any).joinPairs ?? []
    for (const pair of pairs) {
      if (pair.srcInputId !== mainInputId) {
        deps.get(inp.id)!.add(pair.srcInputId)
      }
    }
  }

  // Kahn's algorithm
  const result: string[] = []
  const visited = new Set<string>()
  const queue = lookupInputs
    .filter(i => (deps.get(i.id)?.size ?? 0) === 0)
    .map(i => i.id)

  while (queue.length > 0) {
    const id = queue.shift()!
    result.push(id)
    visited.add(id)
    for (const [lid, ldeps] of deps) {
      if (ldeps.has(id)) {
        ldeps.delete(id)
        if (ldeps.size === 0 && !visited.has(lid)) {
          queue.push(lid)
        }
      }
    }
  }

  return result.map(inputId => {
    const inp = tmap.inputs.find(i => i.id === inputId)!
    const pairs: JoinPair[] = (inp as any).joinPairs ?? []

    const joinPairs: TMapJoinPairPlan[] = pairs.flatMap(pair => {
      // Ogni JoinPair può avere N srcFields e M dstFields
      // Per semplicità: combina con combineExpr se N>1
      const srcExpr = buildJoinKeyExpr(
        pair.srcFields, pair.combineExpr, pair.srcInputId,
        labelToInputId, inputFields
      )
      const dstExpr = buildJoinKeyExpr(
        pair.dstFields, pair.dstCombineExpr ?? '', inputId,
        labelToInputId, inputFields
      )

      // Il dst_field è il primo campo del dst — usato come chiave
      // per l'HashMap di materializzazione
      const primaryDstField = pair.dstFields?.[0]?.field ?? ''

      return [{
        src_key_expr: srcExpr,
        dst_field:    primaryDstField,
        dst_key_expr: dstExpr,
      }]
    })

    return {
      input_id:   inputId,
      label:      inp.label,
      join_type:  (inp.joinType as 'inner' | 'left' | 'first') ?? 'left',
      join_pairs: joinPairs,
    }
  })
}

// ─── Costruisce l'ExprNode per una chiave join ────────────────────

function buildJoinKeyExpr(
  fields:         JoinFieldExpr[],
  combineExpr:    string,
  inputId:        string,
  labelToInputId: Map<string, string>,
  inputFields:    Map<string, Map<string, string>>,
): ExprNode {
  if (!fields || fields.length === 0) {
    return { kind: 'Literal', value: null }
  }

  if (fields.length === 1) {
    return buildJoinFieldExpr(fields[0], inputId, labelToInputId)
  }

  // Chiave composta: usa combineExpr se presente, altrimenti concatenazione
  if (combineExpr) {
    return parseExpressionString(combineExpr, labelToInputId, inputFields)
  }

  // Concatenazione automatica con separatore "-"
  let result: ExprNode = buildJoinFieldExpr(fields[0], inputId, labelToInputId)
  for (let i = 1; i < fields.length; i++) {
    result = {
      kind: 'BinaryOp',
      op: 'CONCAT',
      left: { kind: 'BinaryOp', op: 'CONCAT', left: result, right: { kind: 'Literal', value: '-' } },
      right: buildJoinFieldExpr(fields[i], inputId, labelToInputId),
    }
  }
  return result
}

function buildJoinFieldExpr(
  jf:             JoinFieldExpr,
  inputId:        string,
  labelToInputId: Map<string, string>,
): ExprNode {
  if (jf.fn === 'free' && jf.arg1) {
    // Espressione libera — parsala come stringa
    return parseJoinTransformExpr(jf.arg1, inputId, labelToInputId)
  }

  const baseExpr: ExprNode = { kind: 'DirectFieldRef', field: jf.field }

  switch (jf.fn) {
    case 'none':   return baseExpr
    case 'trim':   return { kind: 'FunctionCall', name: 'trim',  args: [baseExpr] }
    case 'lower':  return { kind: 'FunctionCall', name: 'lower', args: [baseExpr] }
    case 'upper':  return { kind: 'FunctionCall', name: 'upper', args: [baseExpr] }
    case 'year':   return { kind: 'FunctionCall', name: 'year',  args: [baseExpr] }
    case 'month':  return { kind: 'FunctionCall', name: 'month', args: [baseExpr] }
    case 'day':    return { kind: 'FunctionCall', name: 'day',   args: [baseExpr] }
    case 'date':   return { kind: 'FunctionCall', name: 'substring', args: [baseExpr, { kind: 'Literal', value: 0 }, { kind: 'Literal', value: 10 }] }
    case 'substr': return { kind: 'FunctionCall', name: 'substring', args: [
      baseExpr,
      { kind: 'Literal', value: parseInt(jf.arg1 || '0') },
      { kind: 'Literal', value: parseInt(jf.arg2 || '8') },
    ]}
    case 'regex':  return { kind: 'FunctionCall', name: 'regex_match', args: [baseExpr, { kind: 'Literal', value: jf.arg1 || '(.+)' }] }
    default:       return baseExpr
  }
}

function parseJoinTransformExpr(
  expr:           string,
  inputId:        string,
  labelToInputId: Map<string, string>,
): ExprNode {
  // Trasforma "row.campo" → DirectFieldRef
  const rowMatch = expr.match(/^row\.(\w+)$/)
  if (rowMatch) return { kind: 'DirectFieldRef', field: rowMatch[1] }
  // Trasforma "$label.campo" → FieldRef
  const dollarMatch = expr.match(/^\$(\w+)\.(\w+)$/)
  if (dollarMatch) {
    const id = labelToInputId.get(dollarMatch[1])
    if (id) return { kind: 'FieldRef', input: id, field: dollarMatch[2] }
  }
  // Fallback: literal stringa (espressione non parsabile)
  return { kind: 'Literal', value: expr }
}

// ─── Transforms ───────────────────────────────────────────────────

/**
 * 🔴 L'ULTIMO PASSO ("funzione finale") va applicato all'espressione PRIMA di
 * compilarla. Il piano usa solo `expression`; `finalFn`/`finalParams` sono campi
 * dell'interfaccia che il motore non vede mai. Finora quindi la funzione finale
 * compariva nell'anteprima ma **non veniva eseguita**: si sceglieva "MAIUSCOLO"
 * e al Run il valore restava minuscolo, senza alcun errore.
 *
 * Si compone QUI (e non nell'editor) per non rischiare di annidarla più volte a
 * ogni modifica: `expression` resta l'espressione dei passi, la funzione finale
 * si applica una volta sola, al momento di costruire il piano.
 */
function espressioneConUltimoPasso(tr: {
  expression?: string; finalFn?: string; finalParams?: Record<string, string>
}): string {
  const base = (tr.expression ?? '').trim()
  if (!tr.finalFn || tr.finalFn === 'none' || !base) return base
  const template = findPreset(tr.finalFn)
  if (!template) return base
  // Parentesi solo se servono (una chiamata o un riferimento non ne ha bisogno).
  const semplice = /^[A-Za-z_][\w.]*\s*\(.*\)$/.test(base)
                   || /^"[^"]*"\.[\w]+$/.test(base)
                   || /^[\w.]+$/.test(base)
  return resolveTemplate(template, semplice ? base : `(${base})`, tr.finalParams ?? {})
}

function buildTransforms(
  tmap:           TMapConfig,
  labelToInputId: Map<string, string>,
  inputFields:    Map<string, Map<string, string>>,
): TMapTransformPlan[] {
  const nomiTransform = new Set((tmap.transforms ?? []).map(t => t.outputName).filter(Boolean))
  return (tmap.transforms ?? []).map(tr => ({
    id:          tr.id,
    output_name: tr.outputName,
    output_type: tr.outputType,
    expr:        parseTransformExpression(
      espressioneConUltimoPasso(tr), labelToInputId, inputFields, nomiTransform),
  }))
}

// ─── Output ───────────────────────────────────────────────────────

function buildOutputs(
  tmap:                  TMapConfig,
  labelToInputId:        Map<string, string>,
  inputFields:           Map<string, Map<string, string>>,
  transformByOutputName: Map<string, { id: string; outputType: string }>,
): TMapOutputPlan[] {
  return tmap.outputs.map(out => {
    const nomiTransform = new Set([...transformByOutputName.keys()])
    const idToLabel = inverti(labelToInputId)

    const filterExpr = out.filter?.trim()
      ? (() => {
          const e = parseExpressionString(out.filter!, labelToInputId, inputFields)
          verificaRiferimentiQualificati(e, out.filter!, nomiTransform, inputFields, idToLabel)
          return e
        })()
      : null

    const fields: TMapOutputFieldPlan[] = out.fields.map(f => {
      const expr = parseOutputFieldExpression(f, tmap, labelToInputId, inputFields, transformByOutputName)
      // Stessa regola dei transform: i campi degli ingressi vanno qualificati.
      // (Le scorciatoie di `parseOutputFieldExpression` producono già FieldRef
      // quando il campo ha un input esplicito: passano indenni.)
      verificaRiferimentiQualificati(expr, f.expression ?? f.name, nomiTransform, inputFields, idToLabel)
      // Inferenza CONDIVISA (la stessa dello Script e degli altri nodi).
      // `'any'` → null, così resta valida la regola di prima: tipo dedotto se
      // c'è, altrimenti quello scelto a mano nel pannello.
      const dedotto = inferTipoCondiviso(expr, contestoInferenza(inputFields, transformByOutputName))
      const inferredType: string | null = dedotto === 'any' ? null : dedotto
      return {
        name: f.name,
        // Usa il tipo inferito se disponibile, altrimenti quello manuale
        type: inferredType ?? f.type ?? 'string',
        expr,
      }
    })

    return {
      output_id:   out.id,
      label:       out.label,
      filter_expr: filterExpr,
      fields,
    }
  })
}

// ─── Parser expression string → ExprNode ─────────────────────────
//
// Gestisce i formati che vediamo nel JSON reale:
//   "main.film_id"         → FieldRef { input: mainInputId, field: "film_id" }
//   "DBCategory.name"      → FieldRef { input: lookupInputId, field: "name" }
//   "first_name"           → DirectFieldRef { field: "first_name" } (da transform)
//   "counter"              → DirectFieldRef { field: "counter" }
//   "$DBActor.first_name"  → FieldRef con $ prefix

function parseOutputFieldExpression(
  field:                 TMapOutputField & { sourceInputId?: string; sourceFieldName?: string },
  tmap:                  TMapConfig,
  labelToInputId:        Map<string, string>,
  inputFields:           Map<string, Map<string, string>>,
  transformByOutputName: Map<string, { id: string; outputType: string }>,
): ExprNode {
  const expr = field.expression?.trim() ?? ''

  if (!expr) return { kind: 'Literal', value: null }

 // Caso 1: "label.campo" — il label può contenere spazi, quindi invece
  // di una regex rigida (\w+) cerchiamo il nome sorgente noto prendendo
  // tutto ciò che precede l'ULTIMO punto, e verificando che sia un input
  // conosciuto in labelToInputId.
  if (expr.includes('.')) {
    const lastDot = expr.lastIndexOf('.')
    const label = expr.slice(0, lastDot)
    const fieldName = expr.slice(lastDot + 1)
    const inputId = labelToInputId.get(label)
    if (inputId && /^\w+$/.test(fieldName)) {
      return { kind: 'FieldRef', input: inputId, field: fieldName }
    }
  }

  // Caso 2: "$label.campo" (dalle transforms)
  const dollarMatch = expr.match(/^\$(\w+)\.(\w+)$/)
  if (dollarMatch) {
    const inputId = labelToInputId.get(dollarMatch[1])
    if (inputId) return { kind: 'FieldRef', input: inputId, field: dollarMatch[2] }
  }

  // Caso 3: nome semplice senza punto — potrebbe essere
  //   a) outputName di una transform ("first_name", "counter")
  //   b) un campo di un lookup (se sourceFieldName è impostato)
  if (/^\w+$/.test(expr)) {
    // È il nome di una transform?
    if (transformByOutputName.has(expr)) {
      // Referenza a una transform — DirectFieldRef che Rust risolverà
      // cercando nel contesto delle transform già calcolate
      return { kind: 'DirectFieldRef', field: expr }
    }
    // È un campo con sourceInputId esplicito?
    if (field.sourceInputId) {
      const inp = tmap.inputs.find(i => i.id === field.sourceInputId)
      if (inp) {
        return { kind: 'FieldRef', input: field.sourceInputId, field: field.sourceFieldName ?? expr }
      }
    }
    // Fallback: DirectFieldRef (Rust cercherà in tutti gli input disponibili)
    return { kind: 'DirectFieldRef', field: expr }
  }

  // Caso 4: espressione complessa — usa il parser generico
  return parseExpressionString(expr, labelToInputId, inputFields)
}

// ─── Parser per transform expressions ────────────────────────────
// Gestisce: "$DBActor.first_name + \"-\" + $DBActor.last_name"
//           "lane.counter++"
//           espressioni più complesse

/**
 * Espressione di una TRASFORMAZIONE del TMap → `ExprNode`.
 *
 * 🔴 Prima qui c'era un tokenizzatore casalingo (`tokenizeExpr`) che riconosceva
 * solo `$etichetta.campo`, stringhe, numeri e identificatori, **saltando ogni
 * altro carattere**. Due conseguenze silenziose:
 *   - le funzioni non esistevano: `cast(importo as decimal)` diventava la somma
 *     dei quattro "campi" `cast`, `importo`, `as`, `decimal` → sempre null;
 *   - gli operatori venivano ignorati ("usiamo ADD come default"): `prezzo *
 *     1.22` SOMMAVA.
 * Cioè il TMap aveva un linguaggio proprio, diverso da quello che l'utente
 * legge nel manuale e usa nel nodo Script — e l'editor gli proponeva perfino
 * snippet FPEL che poi nessuno interpretava.
 *
 * Ora la strada è UNA sola: `parseExpression` (FPEL), la stessa dei campi in
 * uscita, dei filtri, del nodo Transform e del nodo Script. Stesso testo →
 * stesso albero → stesso risultato, ovunque lo si scriva.
 */
function parseTransformExpression(
  expr:            string,
  labelToInputId:  Map<string, string>,
  inputFields:     Map<string, Map<string, string>>,
  nomiTransform:   Set<string> = new Set(),
): ExprNode {
  const testo = (expr ?? '').trim()
  if (!testo) return { kind: 'Literal', value: null }

  // "lane.variabile++" NON è un'espressione: è un effetto collaterale (incrementa
  // un contatore). Resta riconosciuto PRIMA del parser e fuori dal linguaggio —
  // FPEL descrive valori, non azioni.
  const laneMatch = testo.match(/^lane\.(\w+)\+\+$/)
  if (laneMatch) {
    return { kind: 'DirectFieldRef', field: `lane.${laneMatch[1]}` }
  }

  segnalaSintassiNonFpel(testo)
  const albero = compileFpel(testo, { labelToInputId, userFunctions: userFnScope })
  verificaRiferimentiQualificati(albero, testo, nomiTransform, inputFields,
                                 inverti(labelToInputId))
  return albero
}

/** id-ingresso → etichetta (per comporre il suggerimento nei messaggi). */
function inverti(labelToInputId: Map<string, string>): Map<string, string> {
  const m = new Map<string, string>()
  for (const [label, id] of labelToInputId) m.set(id, label)
  return m
}

/**
 * Vecchie forme del dialetto TMap: invece di lasciarle fallire con un messaggio
 * oscuro del parser ("input sconosciuto: $Anagrafica"), si dice subito qual è la
 * forma giusta. Il modo di leggere un campo è UNO, ovunque:
 *   campo · Etichetta.campo · "Con spazi".campo · var("nome")
 */
/**
 * REGOLA DEL TMAP: un campo che viene da un INGRESSO va sempre scritto per
 * esteso — `Anagrafica.nome`, oppure `"Anagrafica clienti".nome` se l'etichetta
 * ha spazi. Restano nudi solo i nomi che NON appartengono a un ingresso: le
 * TRASFORMAZIONI (calcolate qui) e i contatori `lane.x`.
 *
 * Perché è un errore e non un avviso: un nome nudo oggi funziona perché quel
 * campo esiste in una sola sorgente; il giorno in cui se ne aggiunge un'altra
 * con lo stesso nome, la STESSA espressione cambia significato senza che nessuno
 * l'abbia toccata. E la scelta non è nemmeno prevedibile: il motore cerca in
 * tutti gli ingressi iterando una HashMap, il cui ordine in Rust è randomizzato.
 *
 * Nudo = calcolato qui. Qualificato = viene da fuori. Si legge il flusso senza
 * doverlo indovinare.
 */
function verificaRiferimentiQualificati(
  expr:         ExprNode,
  testo:        string,
  nomiTransform: Set<string>,
  inputFields:  Map<string, Map<string, string>>,
  idToLabel:    Map<string, string>,
): void {
  const visita = (n: ExprNode): void => {
    switch (n.kind) {
      case 'DirectFieldRef': {
        const nome = n.field
        if (nomiTransform.has(nome)) return               // trasformazione: ok nudo
        if (nome.startsWith('lane.')) return              // contatore di lane
        // In quali ingressi esiste questo campo?
        const dove: string[] = []
        for (const [inputId, campi] of inputFields) {
          if (campi.has(nome)) dove.push(idToLabel.get(inputId) ?? inputId)
        }
        const comeScriverlo = dove.length
          ? dove.map((l) => `${riferimentoInput(l)}.${nome}`).join('  oppure  ')
          : null
        throw new ExprParseError(
          comeScriverlo
            ? `"${nome}" è un campo in ingresso: indica la sorgente — ${comeScriverlo}`
            : `"${nome}" non è né una trasformazione né un campo di un ingresso`,
          Math.max(0, testo.indexOf(nome)), testo,
        )
      }
      case 'BinaryOp':   visita(n.left); visita(n.right); return
      case 'UnaryOp':    visita(n.expr); return
      case 'Cast':       visita(n.expr); return
      case 'IsNull':     visita(n.expr); return
      case 'IsNotNull':  visita(n.expr); return
      case 'FunctionCall': n.args.forEach(visita); return
      case 'Coalesce':     n.args.forEach(visita); return
      case 'CaseWhen':
        n.branches.forEach((b) => { visita(b.condition); visita(b.value) })
        if (n.default) visita(n.default)
        return
      default: return                                     // Literal, FieldRef: ok
    }
  }
  visita(expr)
}

function segnalaSintassiNonFpel(expr: string): void {
  // I controlli valgono solo FUORI dalle stringhe: "$5,00" è testo, non un campo.
  const fuoriDaStringhe = expr.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, (m) => ' '.repeat(m.length))

  const dollaroCampo = fuoriDaStringhe.match(/\$(\w+)\.(\w+)/)
  if (dollaroCampo) {
    throw new ExprParseError(
      `"$${dollaroCampo[1]}.${dollaroCampo[2]}" non è valido: scrivi "${dollaroCampo[1]}.${dollaroCampo[2]}" (senza il $)`,
      fuoriDaStringhe.indexOf(dollaroCampo[0]), expr,
    )
  }
  const segnaposto = fuoriDaStringhe.match(/\$value\b/)
  if (segnaposto) {
    throw new ExprParseError(
      '"$value" è un segnaposto degli snippet: sostituiscilo col nome del campo (es. "importo" oppure "Anagrafica.importo")',
      fuoriDaStringhe.indexOf('$value'), expr,
    )
  }
  const riga = fuoriDaStringhe.match(/\browt?\.(\w+)/) ?? fuoriDaStringhe.match(/\brow\.(\w+)/)
  if (riga) {
    throw new ExprParseError(
      `"row.${riga[1]}" non è valido: il campo della riga si scrive "${riga[1]}"`,
      fuoriDaStringhe.indexOf(riga[0]), expr,
    )
  }
}


// ─── Parser generico per espressioni JavaScript-like ─────────────
// Tokenizer minimale che gestisce i pattern comuni del TMap.
// Non è un parser JS completo — copre i casi reali che vediamo.

// Sostituisci la funzione parseExpressionString con questa versione

function parseExpressionString(
  expr:           string,
  labelToInputId: Map<string, string>,
  _inputFields:   Map<string, Map<string, string>>,
  ): ExprNode {
    return compileFpel(expr, { labelToInputId, userFunctions: userFnScope })
}
/*
// ← FIX: restituisce oggetto o null invece di tuple
function splitByOperator(
  expr: string,
): { left: string; op: string; right: string } | null {
  const ops = [' + ', ' - ', ' * ', ' / ', ' == ', ' != ', ' >= ', ' <= ', ' > ', ' < ', ' && ', ' || ']
  for (const op of ops) {
    const idx = findOperatorOutsideQuotes(expr, op)
    if (idx !== -1) {
      return {
        left:  expr.slice(0, idx),
        op:    op.trim(),
        right: expr.slice(idx + op.length),
      }
    }
  }
  return null
}
*/
/*
// E sostituisci anche findOperatorOutsideQuotes con questa versione
// che gestisce correttamente sia ' che ":
function findOperatorOutsideQuotes(s: string, op: string): number {
  let inStr  = false
  let strChar = ''
  let i = 0

  while (i < s.length) {
    const c = s[i]

    // Inizio/fine stringa
    if (!inStr && (c === '"' || c === "'")) {
      inStr = true
      strChar = c
      i++
      continue
    }
    if (inStr && c === '\\') {
      // Escape — salta il carattere successivo
      i += 2
      continue
    }
    if (inStr && c === strChar) {
      inStr = false
      i++
      continue
    }

    // Se non siamo in una stringa, cerca l'operatore
    if (!inStr && s.slice(i, i + op.length) === op) {
      return i
    }
    i++
  }
  return -1
}
*/
/*
function jsOpToRustOp(op: string): string {
  const MAP: Record<string, string> = {
    '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV',
    '==': 'EQ', '!=': 'NE', '>': 'GT', '<': 'LT', '>=': 'GTE', '<=': 'LTE',
    '&&': 'AND', '||': 'OR',
  }
  return MAP[op] ?? 'CONCAT'
}
*/
// ─── Inferenza dei tipi ───────────────────────────────────────────
// Risolve il problema di propagazione: il tipo del campo output
// non è più impostato a mano ma derivato dall'espressione.

/**
 * Adattatore fra il mondo del TMap e l'inferenza CONDIVISA (`exprTypes.ts`).
 *
 * Prima qui viveva un'inferenza propria, con una tabella di **16** funzioni
 * scritte a mano: le altre 69 del catalogo restavano senza tipo (`substring`,
 * `replace`, `concat_ws`, gli hash, quasi tutte le funzioni di data…), e il
 * tipo mancante si propagava a valle impoverendo lo schema. In più trattava gli
 * operatori a modo suo: `a == b` fra due stringhe deduceva `string` invece di
 * `boolean`, perché il controllo sulla stringa veniva prima di quello sugli
 * operatori di confronto.
 *
 * Ora il TMap usa la stessa inferenza di tutti — catalogo completo, stesse
 * regole sugli operatori (compreso `+` che concatena se un lato è stringa) —
 * e quel che serve è solo tradurre il modo in cui il TMap risolve i campi:
 *  - `qualified` → campo di un input specifico ("Etichetta".campo);
 *  - `field`     → campo non qualificato: si cerca in TUTTI gli input e poi
 *                  fra le transforms (variabili intermedie), come faceva prima.
 */
function contestoInferenza(
  inputFields:           Map<string, Map<string, string>>,
  transformByOutputName: Map<string, { id: string; outputType: string }>,
): InferCtx {
  return {
    field: (nome) => {
      for (const [, campi] of inputFields) {
        const t = campi.get(nome)
        if (t) return t as FieldType
      }
      const tr = transformByOutputName.get(nome)
      return tr ? (tr.outputType as FieldType) : undefined
    },
    qualified: (input, campo) => inputFields.get(input)?.get(campo) as FieldType | undefined,
  }
}
