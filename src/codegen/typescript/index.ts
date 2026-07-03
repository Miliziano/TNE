/**
 * src/codegen/typescript/index.ts
 * ────────────────────────────────
 * Code generator TypeScript — Step 10 della migrazione.
 *
 * Primo target di code generation. Genera codice Node.js/TypeScript
 * eseguibile a partire dal Physical Plan ottimizzato.
 *
 * Il codice generato è:
 *   - Leggibile e modificabile manualmente
 *   - Auto-contenuto (nessuna dipendenza da FlowPilot a runtime)
 *   - Tipato (interfacce generate per ogni schema)
 *   - Streamable (usa async generator per pipeline row-at-a-time)
 *
 * STRUTTURA OUTPUT:
 *   pipeline-<id>/
 *     index.ts          ← entry point, orchestrazione
 *     types.ts          ← interfacce TypeScript per ogni schema
 *     nodes/
 *       <nodeId>.ts     ← implementazione per ogni nodo
 *     runtime/
 *       stream.ts       ← utilities streaming
 *       errors.ts       ← gestione errori e reject
 *
 * USO:
 *   const output = generateTypeScript(plan)
 *   // output.files: Map<filename, content>
 */

import type { LogicalPlan, LogicalNode, SchemaField } from '../../ir/types'
import { topologicalSort, canvasNodeId } from '../../ir/lowering'
import { getNodeSemantics } from '../../ir/nodeSemantics'
import { generators } from './generators'

// ─────────────────────────────────────────────────────────────────
// TIPI OUTPUT
// ─────────────────────────────────────────────────────────────────

export interface GeneratedFile {
  path:    string
  content: string
}

export interface CodegenOutput {
  /** Mappa path → contenuto di tutti i file generati */
  files:    Map<string, string>
  /** Entry point principale */
  entryPoint: string
  /** Eventuali warning durante la generazione */
  warnings: string[]
}

// ─────────────────────────────────────────────────────────────────
// CONTEXT DI GENERAZIONE
// ─────────────────────────────────────────────────────────────────

export interface CodegenContext {
  plan:       LogicalPlan
  /** Mappa nodeId → nome variabile TypeScript del nodo */
  nodeVarMap: Map<string, string>
  /** Tutti i file generati finora */
  files:      Map<string, string>
  warnings:   string[]
}

// ─────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────

/**
 * Genera il codice TypeScript per un piano logico ottimizzato.
 *
 * @param plan  LogicalPlan con schema propagato e ottimizzato
 * @returns     Mappa di file generati pronti per essere scritti su disco
 */
export function generateTypeScript(plan: LogicalPlan): CodegenOutput {
  const sorted = topologicalSort(plan)
  if (!sorted) {
    return {
      files:      new Map(),
      entryPoint: '',
      warnings:   ['Impossibile generare codice: il DAG contiene cicli'],
    }
  }

  const ctx: CodegenContext = {
    plan,
    nodeVarMap: buildNodeVarMap(plan),
    files:      new Map(),
    warnings:   [],
  }

  // ── 1. Genera types.ts ──────────────────────────────────────
  ctx.files.set('types.ts', generateTypes(plan))

  // ── 2. Genera runtime utilities ─────────────────────────────
  ctx.files.set('runtime/stream.ts', RUNTIME_STREAM)
  ctx.files.set('runtime/errors.ts', RUNTIME_ERRORS)

  // ── 3. Genera un file per ogni nodo ─────────────────────────
  sorted.forEach((node) => {
    const generator = generators[node.operation]
    if (!generator) {
      ctx.warnings.push(`Nessun generatore per operazione "${node.operation}" (nodo ${canvasNodeId(node.id)})`)
      return
    }
    const code = generator.generate(node, ctx)
    ctx.files.set(`nodes/${nodeFileName(node)}.ts`, code)
  })

  // ── 4. Genera index.ts (orchestratore) ──────────────────────
  ctx.files.set('index.ts', generateIndex(plan, sorted, ctx))

  return {
    files:      ctx.files,
    entryPoint: 'index.ts',
    warnings:   ctx.warnings,
  }
}

// ─────────────────────────────────────────────────────────────────
// GENERAZIONE TIPI TypeScript
// ─────────────────────────────────────────────────────────────────

function generateTypes(plan: LogicalPlan): string {
  const lines: string[] = [
    `/**`,
    ` * Tipi generati automaticamente da FlowPilot`,
    ` * Piano: ${plan.name} v${plan.version}`,
    ` * Data: ${new Date().toISOString()}`,
    ` */`,
    '',
  ]

  // Genera un'interfaccia per ogni schema di output unico
  const seenSchemas = new Set<string>()

  plan.nodes.forEach((node) => {
    const schema = node.schema.output
    if (!schema.length) return

    const schemaKey = schema.map((f) => `${f.name}:${f.type}`).join(',')
    if (seenSchemas.has(schemaKey)) return
    seenSchemas.add(schemaKey)

    const interfaceName = nodeInterfaceName(node)
    lines.push(`/** Schema output di ${node._uiRef?.label ?? node.id} */`)
    lines.push(`export interface ${interfaceName} {`)
    schema.forEach((field) => {
      const tsType  = toTsType(field.type)
      const comment = field.physicalName && field.physicalName !== field.name
        ? `  // campo fisico: ${field.physicalName}`
        : ''
      const nullable = field.nullable ? ' | null' : ''
      lines.push(`  ${sanitizeFieldName(field.name)}: ${tsType}${nullable}${comment}`)
    })
    lines.push(`}`)
    lines.push('')
  })

  // Tipo generico per una riga
  lines.push(`/** Riga generica — usata quando il tipo esatto non è noto */`)
  lines.push(`export type AnyRow = Record<string, unknown>`)
  lines.push('')

  // Tipo risultato pipeline
  lines.push(`export interface PipelineResult {`)
  lines.push(`  rowsProcessed: number`)
  lines.push(`  rowsRejected:  number`)
  lines.push(`  durationMs:    number`)
  lines.push(`  errors:        string[]`)
  lines.push(`}`)

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────
// GENERAZIONE INDEX.TS (orchestratore)
// ─────────────────────────────────────────────────────────────────

function generateIndex(
  plan:   LogicalPlan,
  sorted: LogicalNode[],
  ctx:    CodegenContext,
): string {
  const lines: string[] = [
    `/**`,
    ` * Pipeline: ${plan.name}`,
    ` * Generata da FlowPilot il ${new Date().toISOString()}`,
    ` * `,
    ` * Per eseguire: npx ts-node index.ts`,
    ` */`,
    '',
    `import type { PipelineResult } from './types'`,
    `import { createRejectSink } from './runtime/errors'`,
    '',
  ]

  // Import dei nodi
  sorted.forEach((node) => {
    const varName  = ctx.nodeVarMap.get(node.id)!
    const fileName = nodeFileName(node)
    lines.push(`import { run as run_${varName} } from './nodes/${fileName}'`)
  })

  lines.push('')
  lines.push(`async function main(): Promise<PipelineResult> {`)
  lines.push(`  const startTime  = Date.now()`)
  lines.push(`  let rowsProcessed = 0`)
  lines.push(`  let rowsRejected  = 0`)
  lines.push(`  const errors: string[] = []`)
  lines.push('')

  // Genera la logica di esecuzione in ordine topologico
  // Per ora: esecuzione sequenziale semplice
  // Il Physical Planner aggiungerà parallelismo per le partition
  sorted.forEach((node) => {
    const varName = ctx.nodeVarMap.get(node.id)!
    lines.push(`  // ${node._uiRef?.label ?? canvasNodeId(node.id)}`)
    lines.push(`  try {`)
    lines.push(`    const result_${varName} = await run_${varName}()`)
    lines.push(`    rowsProcessed += result_${varName}.rowsProcessed ?? 0`)
    lines.push(`    rowsRejected  += result_${varName}.rowsRejected  ?? 0`)
    lines.push(`  } catch (err) {`)
    lines.push(`    errors.push(\`Errore in ${node._uiRef?.label ?? varName}: \${err}\`)`)

    // Se il nodo ha onError: 'stop' → blocca l'esecuzione
    const onError = (node._uiRef?.config as any)?.advanced?.onError ?? 'stop'
    if (onError === 'stop') {
      lines.push(`    throw err`)
    }

    lines.push(`  }`)
    lines.push('')
  })

  lines.push(`  return {`)
  lines.push(`    rowsProcessed,`)
  lines.push(`    rowsRejected,`)
  lines.push(`    durationMs: Date.now() - startTime,`)
  lines.push(`    errors,`)
  lines.push(`  }`)
  lines.push(`}`)
  lines.push('')
  lines.push(`main()`)
  lines.push(`  .then((result) => {`)
  lines.push(`    console.log('[FlowPilot] Pipeline completata:', result)`)
  lines.push(`    process.exit(0)`)
  lines.push(`  })`)
  lines.push(`  .catch((err) => {`)
  lines.push(`    console.error('[FlowPilot] Pipeline fallita:', err)`)
  lines.push(`    process.exit(1)`)
  lines.push(`  })`)

  return lines.join('\n')
}

// ─────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────

/** Mappa ogni LogicalNode.id a un nome variabile TypeScript valido */
function buildNodeVarMap(plan: LogicalPlan): Map<string, string> {
  const map     = new Map<string, string>()
  const usedNames = new Set<string>()

  plan.nodes.forEach((node) => {
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)
    let   varName = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      || `node_${canvasNodeId(node.id)}`

    // Deduplicazione se due nodi hanno la stessa label
    if (usedNames.has(varName)) {
      let i = 2
      while (usedNames.has(`${varName}_${i}`)) i++
      varName = `${varName}_${i}`
    }

    usedNames.add(varName)
    map.set(node.id, varName)
  })

  return map
}

/** Nome del file per un nodo */
function nodeFileName(node: LogicalNode): string {
  const label = node._uiRef?.label ?? canvasNodeId(node.id)
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    || `node_${canvasNodeId(node.id)}`
}

/** Nome dell'interfaccia TypeScript per lo schema output di un nodo */
function nodeInterfaceName(node: LogicalNode): string {
  const label = node._uiRef?.label ?? canvasNodeId(node.id)
  return label
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('') + 'Row'
}

/** Converte FieldType → tipo TypeScript */
function toTsType(type: string): string {
  const map: Record<string, string> = {
    string:    'string',
    integer:   'number',
    decimal:   'number',
    boolean:   'boolean',
    date:      'Date',
    datetime:  'Date',
    timestamp: 'Date',
    binary:    'Buffer',
    json:      'unknown',
    xml:       'string',
    object:    'Record<string, unknown>',
    array:     'unknown[]',
    any:       'unknown',
  }
  return map[type] ?? 'unknown'
}

/** Sanitizza il nome di un campo per usarlo come identifier TypeScript */
function sanitizeFieldName(name: string): string {
  // Se contiene punti (es. status.ok) → usa la notazione stringa
  if (name.includes('.') || name.includes('-') || /^\d/.test(name)) {
    return `'${name}'`
  }
  return name
}

// ─────────────────────────────────────────────────────────────────
// RUNTIME UTILITIES (embedded nel bundle generato)
// ─────────────────────────────────────────────────────────────────

const RUNTIME_STREAM = `/**
 * Runtime utilities per pipeline streaming
 * Generato da FlowPilot — non modificare
 */

export type Row = Record<string, unknown>

/** Trasforma un async generator applicando una funzione a ogni riga */
export async function* mapStream<T extends Row, U extends Row>(
  source: AsyncIterable<T>,
  fn:     (row: T) => U | Promise<U>
): AsyncGenerator<U> {
  for await (const row of source) {
    yield await fn(row)
  }
}

/** Filtra un async generator mantenendo solo le righe che passano il predicato */
export async function* filterStream<T extends Row>(
  source:    AsyncIterable<T>,
  predicate: (row: T) => boolean | Promise<boolean>
): AsyncGenerator<T> {
  for await (const row of source) {
    if (await predicate(row)) yield row
  }
}

/** Raccoglie tutte le righe di un async generator in un array */
export async function collectStream<T>(source: AsyncIterable<T>): Promise<T[]> {
  const rows: T[] = []
  for await (const row of source) rows.push(row)
  return rows
}

/** Divide un async generator in due in base a un predicato */
export async function partitionStream<T extends Row>(
  source:    AsyncIterable<T>,
  predicate: (row: T) => boolean | Promise<boolean>
): Promise<{ accepted: T[]; rejected: T[] }> {
  const accepted: T[] = []
  const rejected: T[] = []
  for await (const row of source) {
    if (await predicate(row)) accepted.push(row)
    else                      rejected.push(row)
  }
  return { accepted, rejected }
}

/** Conta le righe processate mentre passa il generator */
export async function* countStream<T>(
  source:  AsyncIterable<T>,
  counter: { count: number }
): AsyncGenerator<T> {
  for await (const row of source) {
    counter.count++
    yield row
  }
}
`

const RUNTIME_ERRORS = `/**
 * Gestione errori e flusso reject
 * Generato da FlowPilot — non modificare
 */

export interface RejectRecord {
  originalRow: Record<string, unknown>
  error:       string
  nodeId:      string
  timestamp:   string
}

/** Accumula i record rigettati per scrittura su sink reject */
export function createRejectSink() {
  const rejected: RejectRecord[] = []

  return {
    push(row: Record<string, unknown>, error: string, nodeId: string) {
      rejected.push({
        originalRow: row,
        error,
        nodeId,
        timestamp: new Date().toISOString(),
      })
    },
    getAll() { return rejected },
    count()  { return rejected.length },
  }
}

/** Retry con backoff esponenziale */
export async function withRetry<T>(
  fn:         () => Promise<T>,
  maxRetries: number = 3,
  delayMs:    number = 1000,
): Promise<T> {
  let lastError: Error | undefined
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastError = err as Error
      if (attempt < maxRetries) {
        await new Promise((r) => setTimeout(r, delayMs * Math.pow(2, attempt)))
      }
    }
  }
  throw lastError
}
`
