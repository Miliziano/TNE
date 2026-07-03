/**
 * src/ir/analyzeTMapColumnUsage.ts
 *
 * Analisi statica delle colonne utilizzate in un TMap.
 * Produce per ogni inputId il set minimo di colonne necessarie
 * al processo — usato dal codegen per il column pruning dei lookup
 * e per la pre-materializzazione degli input secondari.
 *
 * Viene chiamata durante la fase di compilazione IR, dopo la
 * validazione e prima del codegen, su ogni nodo di tipo 'tmap'.
 *
 * Output: ColumnUsageMap — Record<inputId, Set<columnName>>
 *
 * Casi speciali:
 * - Se un'espressione referenzia l'intero oggetto riga senza
 *   specificare un campo (es. spread, JSON.stringify, Object.keys),
 *   il pruning per quell'input viene disabilitato → Set contiene
 *   il simbolo speciale WILDCARD ('*').
 * - Se un campo non è mai referenziato, non appare nel Set →
 *   il codegen può ometterlo dal caricamento.
 */

import type { TMapConfig, TMapInput, TMapOutput, TMapOutputField, TMapTransformNode, TMapConnection } from '../types'
import type { JoinPair } from '../nodes/types/tmap/TMapModal'

// ─── Tipi pubblici ────────────────────────────────────────────────

/** '*' significa "tutte le colonne" — pruning disabilitato per quell'input */
export const WILDCARD = '*' as const

export type ColumnSet = Set<string>  // Set<fieldName> oppure Set<'*'>

/** inputId → colonne necessarie */
export type ColumnUsageMap = Record<string, ColumnSet>

export interface ColumnUsageResult {
  /** Colonne necessarie per ogni input handle */
  usage: ColumnUsageMap

  /** Input per cui il pruning è disabilitato (espressioni non analizzabili) */
  wildcardInputs: Set<string>

  /** Input secondari (non-main) in ordine topologico di caricamento */
  lookupLoadOrder: string[]

  /** Stime debug: quanti campi totali vs quanti usati */
  stats: Record<string, { total: number; used: number; pruned: number }>
}

// ─── Entry point ──────────────────────────────────────────────────

export function analyzeTMapColumnUsage(tmap: TMapConfig): ColumnUsageResult {
  const usage:          ColumnUsageMap = {}
  const wildcardInputs: Set<string>   = new Set()

  // Inizializza set vuoto per ogni input
  for (const inp of tmap.inputs) {
    usage[inp.id] = new Set()
  }

  // ── 1. Colonne usate nelle espressioni dei campi di output ────
  for (const out of tmap.outputs) {
    for (const field of out.fields) {
      if (!field.expression) continue
      extractFieldRefs(field.expression, tmap, usage, wildcardInputs)
    }
  }

  // ── 2. Colonne usate nelle trasformazioni ─────────────────────
  for (const tr of tmap.transforms ?? []) {
    // Campi sorgente delle trasformazioni
    for (const inp of tr.inputs ?? []) {
      addColumn(usage, wildcardInputs, inp.inputId, inp.fieldName)
    }
    // L'espressione della trasformazione può referenziare altri campi
    if (tr.expression) {
      extractFieldRefs(tr.expression, tmap, usage, wildcardInputs)
    }
    // Pipeline di trasformazioni
    if (tr.pipeline) {
      for (const step of tr.pipeline as any[]) {
        const stepExpr = step.expression ?? step.expr ?? step.code
        if (stepExpr && typeof stepExpr === 'string') {
          extractFieldRefs(stepExpr, tmap, usage, wildcardInputs)
        }
      }
    }
  }

  // ── 3. Colonne usate nelle condizioni di join ─────────────────
  for (const inp of tmap.inputs) {
    const joinPairs: JoinPair[] = (inp as any).joinPairs ?? []
    for (const pair of joinPairs) {
      // Campi sorgente (flusso che fornisce la chiave)
      for (const sf of pair.srcFields ?? []) {
        if (sf.field) addColumn(usage, wildcardInputs, pair.srcInputId, sf.field)
        // Se la trasformazione è libera, analizza l'espressione
        if (sf.fn === 'free' && sf.arg1) {
          extractFieldRefs(sf.arg1, tmap, usage, wildcardInputs)
        }
        // combineExpr per chiavi composite
        if (pair.combineExpr) {
          extractFieldRefs(pair.combineExpr, tmap, usage, wildcardInputs)
        }
      }
      // Campi destinatari (questo lookup)
      for (const df of pair.dstFields ?? []) {
        if (df.field) addColumn(usage, wildcardInputs, inp.id, df.field)
        if (df.fn === 'free' && df.arg1) {
          extractFieldRefs(df.arg1, tmap, usage, wildcardInputs)
        }
        if (pair.dstCombineExpr) {
          extractFieldRefs(pair.dstCombineExpr, tmap, usage, wildcardInputs)
        }
      }
    }
  }

  // ── 4. Colonne usate nei filtri di routing degli output ───────
  for (const out of tmap.outputs) {
    if (out.filter) {
      extractFieldRefs(out.filter, tmap, usage, wildcardInputs)
    }
  }

  // ── 5. Connessioni esplicite (drag & drop) ────────────────────
  for (const conn of tmap.connections ?? []) {
    if (!conn.inputId.startsWith('transform__')) {
      addColumn(usage, wildcardInputs, conn.inputId, conn.fieldName)
    }
  }

  // ── 6. Promuovi wildcard se l'input è già tutto referenziato ──
  // Se tutte le colonne dello schema sono già nel set, è inutile
  // tenere il set esplicito — promuovi a wildcard per semplicità.
  for (const inp of tmap.inputs) {
    if (wildcardInputs.has(inp.id)) continue
    const totalFields = inp.fields.filter(f => !f.name.startsWith('status.')).length
    if (totalFields > 0 && usage[inp.id].size >= totalFields) {
      wildcardInputs.add(inp.id)
      usage[inp.id] = new Set([WILDCARD])
    }
  }

  // ── 7. Ordine topologico dei lookup ───────────────────────────
  // I lookup vanno caricati in ordine: se lookup2 ha una join
  // che dipende da lookup1, lookup1 deve essere caricato prima.
  const lookupLoadOrder = computeLookupLoadOrder(tmap)

  // ── 8. Statistiche debug ──────────────────────────────────────
  const stats: ColumnUsageResult['stats'] = {}
  for (const inp of tmap.inputs) {
    const total  = inp.fields.filter(f => !f.name.startsWith('status.')).length
    const isWild = wildcardInputs.has(inp.id)
    const used   = isWild ? total : usage[inp.id].size
    stats[inp.id] = { total, used, pruned: total - used }
  }

  return { usage, wildcardInputs, lookupLoadOrder, stats }
}

// ─── Helpers ──────────────────────────────────────────────────────

/**
 * Aggiunge una colonna al set dell'input specificato.
 * Se l'input ha già wildcard, non fa nulla.
 */
function addColumn(
  usage:          ColumnUsageMap,
  wildcardInputs: Set<string>,
  inputId:        string,
  fieldName:      string,
): void {
  if (!inputId || !fieldName) return
  if (wildcardInputs.has(inputId)) return
  if (!usage[inputId]) usage[inputId] = new Set()
  usage[inputId].add(fieldName)
}

/**
 * Promuove un input a wildcard — pruning disabilitato.
 */
function setWildcard(
  usage:          ColumnUsageMap,
  wildcardInputs: Set<string>,
  inputId:        string,
): void {
  wildcardInputs.add(inputId)
  usage[inputId] = new Set([WILDCARD])
}

/**
 * Estrae riferimenti a campi da un'espressione JavaScript.
 *
 * Pattern riconosciuti:
 *   inputLabel.fieldName          → es: main.nome, lookup.id
 *   $inputLabel.fieldName         → es: $main.data (nelle trasformazioni)
 *   row.fieldName                 → es: row.status (espressioni inline)
 *
 * Pattern che disabilitano il pruning:
 *   JSON.stringify(inputLabel)    → usa tutto l'oggetto
 *   Object.keys(inputLabel)       → usa tutto l'oggetto
 *   ...inputLabel                 → spread operator
 *   inputLabel (senza .campo)     → referenza all'intero oggetto
 */
function extractFieldRefs(
  expression:     string,
  tmap:           TMapConfig,
  usage:          ColumnUsageMap,
  wildcardInputs: Set<string>,
): void {
  if (!expression) return

  // Mappa label → inputId per accesso rapido
  const labelToId = new Map<string, string>()
  for (const inp of tmap.inputs) {
    labelToId.set(inp.label, inp.id)
    // Anche senza $ — es: main.campo
    labelToId.set(inp.label, inp.id)
  }

  // ── Pattern che disabilitano il pruning ───────────────────────

  // JSON.stringify(label) o Object.keys(label) o Object.values(label)
  const objectWildcardRe = /(?:JSON\.stringify|Object\.keys|Object\.values|Object\.entries)\s*\(\s*(\w+)/g
  let m: RegExpExecArray | null
  while ((m = objectWildcardRe.exec(expression)) !== null) {
    const label = m[1]
    const inputId = labelToId.get(label)
    if (inputId) setWildcard(usage, wildcardInputs, inputId)
  }

  // Spread operator: ...label o { ...label }
  const spreadRe = /\.\.\.\s*(\w+)/g
  while ((m = spreadRe.exec(expression)) !== null) {
    const label = m[1]
    const inputId = labelToId.get(label)
    if (inputId) setWildcard(usage, wildcardInputs, inputId)
  }

  // ── Pattern che estraggono colonne specifiche ─────────────────

  // $label.field (nelle trasformazioni)
  const dollarRe = /\$(\w+)\.(\w+)/g
  while ((m = dollarRe.exec(expression)) !== null) {
    const [, label, field] = m
    const inputId = labelToId.get(label)
    if (inputId) addColumn(usage, wildcardInputs, inputId, field)
  }

  // label.field (nelle espressioni di output e filtri)
  // Esclude: console.log, Math.floor, String.trim ecc. — solo le label degli input
  const dotRe = /\b(\w+)\.(\w+)/g
  while ((m = dotRe.exec(expression)) !== null) {
    const [, label, field] = m
    const inputId = labelToId.get(label)
    if (inputId) {
      addColumn(usage, wildcardInputs, inputId, field)
    }
  }

  // row.field (espressioni nei JOIN_TRANSFORMS)
  const rowRe = /\brow\.(\w+)/g
  while ((m = rowRe.exec(expression)) !== null) {
    const field = m[1]
    // "row" è ambiguo — può riferirsi a qualsiasi input.
    // Nel contesto dei JOIN_TRANSFORMS sappiamo già l'inputId
    // dal campo padre (srcInputId o inp.id), ma qui non lo abbiamo.
    // Strategia conservativa: aggiungi il campo a tutti gli input
    // che ce l'hanno nello schema.
    for (const inp of tmap.inputs) {
      if (inp.fields.some(f => f.name === field)) {
        addColumn(usage, wildcardInputs, inp.id, field)
      }
    }
  }

  // ── Referenza all'intero oggetto senza campo ──────────────────
  // Es: "main" da solo in un'espressione — disabilita pruning
  // Cerca label non seguita da . (non è label.campo)
  for (const [label, inputId] of labelToId) {
    if (wildcardInputs.has(inputId)) continue
    // Regex: label seguita da qualcosa che non è un punto
    // (non è label.campo) — es: "return main" o "fn(main)"
    const wholeObjectRe = new RegExp(`\\b${label}\\b(?!\\s*\\.)`, 'g')
    // Esclude pattern già gestiti ($label.x e label.x)
    const testExpr = expression
      .replace(/\$\w+\.\w+/g, '')   // rimuovi $label.campo
      .replace(/\b\w+\.\w+/g, '')   // rimuovi label.campo
    if (wholeObjectRe.test(testExpr)) {
      setWildcard(usage, wildcardInputs, inputId)
    }
  }
}

/**
 * Calcola l'ordine di caricamento dei lookup in base alle dipendenze
 * di join tra di loro (ordinamento topologico).
 *
 * Esempio:
 *   lookup_b ha una join che dipende da lookup_a
 *   → ordine: [lookup_a, lookup_b]
 *
 * Se ci sono dipendenze circolari (non dovrebbe succedere ma per sicurezza),
 * restituisce l'ordine originale con un warning.
 */
function computeLookupLoadOrder(tmap: TMapConfig): string[] {
  const lookups = tmap.inputs.filter(i => !i.isMain)
  if (lookups.length <= 1) return lookups.map(i => i.id)

  // Costruisce il grafo delle dipendenze
  // dipendenze[A] = Set di lookup che devono essere caricati prima di A
  const dependencies = new Map<string, Set<string>>()
  for (const inp of lookups) {
    dependencies.set(inp.id, new Set())
  }

  for (const inp of lookups) {
    const joinPairs: JoinPair[] = (inp as any).joinPairs ?? []
    for (const pair of joinPairs) {
      // Se srcInputId è un lookup (non il main), allora inp dipende da srcInputId
      const srcInp = tmap.inputs.find(i => i.id === pair.srcInputId)
      if (srcInp && !srcInp.isMain) {
        dependencies.get(inp.id)?.add(pair.srcInputId)
      }
    }
  }

  // Kahn's algorithm per ordinamento topologico
  const inDegree = new Map<string, number>()
  for (const inp of lookups) {
    inDegree.set(inp.id, dependencies.get(inp.id)?.size ?? 0)
  }

  const queue = lookups
    .filter(i => (inDegree.get(i.id) ?? 0) === 0)
    .map(i => i.id)

  const result: string[] = []
  const visited = new Set<string>()

  while (queue.length > 0) {
    const current = queue.shift()!
    result.push(current)
    visited.add(current)

    // Rimuovi current dalle dipendenze degli altri lookup
    for (const [id, deps] of dependencies) {
      if (deps.has(current)) {
        deps.delete(current)
        const newDegree = deps.size
        inDegree.set(id, newDegree)
        if (newDegree === 0 && !visited.has(id)) {
          queue.push(id)
        }
      }
    }
  }

  // Se non tutti i lookup sono stati visitati → dipendenza circolare
  // Fallback: ordine originale
  if (result.length < lookups.length) {
    console.warn('[analyzeTMapColumnUsage] Circular dependency detected in lookup joins — using original order')
    return lookups.map(i => i.id)
  }

  return result
}

// ─── Utilità per il codegen ───────────────────────────────────────

/**
 * Restituisce le colonne da caricare per un dato input,
 * tenendo conto del wildcard.
 * Se wildcard → undefined (carica tutto, nessun filtro)
 * Se set vuoto → [] (non caricare nulla — caso raro, es. lookup usato solo per esistenza)
 * Altrimenti → Array<string> delle colonne da caricare
 */
export function getColumnsToLoad(
  result:  ColumnUsageResult,
  inputId: string,
): string[] | undefined {
  if (result.wildcardInputs.has(inputId)) return undefined  // carica tutto
  const cols = result.usage[inputId]
  if (!cols || cols.size === 0) return []
  return Array.from(cols)
}

/**
 * Genera un commento human-readable per il codegen
 * che spiega il pruning applicato.
 */
export function formatPruningComment(
  result:  ColumnUsageResult,
  inputId: string,
  label:   string,
): string {
  const s = result.stats[inputId]
  if (!s) return ''
  if (result.wildcardInputs.has(inputId)) {
    return `// ${label}: pruning disabled — expression references entire object (${s.total} cols)`
  }
  if (s.pruned === 0) {
    return `// ${label}: all ${s.total} columns used — no pruning`
  }
  const cols = Array.from(result.usage[inputId]).join(', ')
  return `// ${label}: column pruning — loading ${s.used}/${s.total} cols: [${cols}]`
}