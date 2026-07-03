/**
 * src/codegen/typescript/generators/filter.ts
 */

import type { LogicalNode } from '../../../ir/types'
import type { CodegenContext } from '../index'
import type { NodeGenerator } from './index'
import { canvasNodeId } from '../../../ir/lowering'
import { printExpr } from '../../../ir/expr'

export const filterGenerator: NodeGenerator = {
  operation: 'filter',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName  = ctx.nodeVarMap.get(node.id)!
    const label    = node._uiRef?.label ?? canvasNodeId(node.id)
    const config   = (node._uiRef?.config ?? {}) as any
    const props    = config?.props ?? {}
    const condition = props.condition ?? 'true'

    // Usa l'ExprNode se disponibile, altrimenti la stringa raw
    const conditionCode = node.expressions.length > 0
      ? printExpr(node.expressions[0])
      : condition

    return `/**
 * Filtro: ${label}
 * Condizione: ${conditionCode}
 */

import { filterStream } from '../runtime/stream'

export interface ${varName}Result {
  rows:          Record<string, unknown>[]
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  const accepted: Record<string, unknown>[] = []
  const rejected: Record<string, unknown>[] = []

  for (const row of inputRows) {
    try {
      // Condizione generata dall'ExprAST
      const passes = evalCondition(row)
      if (passes) accepted.push(row)
      else        rejected.push(row)
    } catch {
      rejected.push(row)
    }
  }

  return {
    rows:          accepted,
    rowsProcessed: accepted.length,
    rowsRejected:  rejected.length,
  }
}

function evalCondition(row: Record<string, unknown>): boolean {
  // TODO: sostituire con codice generato dall'ExprAST
  // Condizione originale: ${conditionCode}
  try {
    return Boolean(${generateConditionCode(conditionCode)})
  } catch {
    return false
  }
}
`
  },
}

function generateConditionCode(condition: string): string {
  // Traduce riferimenti a campi: campo → row['campo']
  return condition.replace(/\b([a-zA-Z_][a-zA-Z0-9_.]*)\b(?!\s*\()/g, (match) => {
    if (['true', 'false', 'null', 'undefined', 'AND', 'OR', 'NOT'].includes(match)) {
      return match.toLowerCase()
    }
    return `row[${JSON.stringify(match)}]`
  })
}

// ─────────────────────────────────────────────────────────────────

/**
 * src/codegen/typescript/generators/projection.ts
 */
export const projectionGenerator: NodeGenerator = {
  operation: 'projection',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName = ctx.nodeVarMap.get(node.id)!
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)
    const config  = (node._uiRef?.config ?? {}) as any
    const mappings: Array<{ sourceField: string; targetField: string; transform?: string }> =
      config?.mappings ?? []

    const outputSchema = node.schema.output

    return `/**
 * Proiezione: ${label}
 * Campi output: ${outputSchema.map((f) => f.name).join(', ')}
 */

export interface ${varName}Result {
  rows:          Record<string, unknown>[]
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  const rows = inputRows.map(projectRow)
  return { rows, rowsProcessed: rows.length, rowsRejected: 0 }
}

function projectRow(row: Record<string, unknown>): Record<string, unknown> {
  return {
${mappings.length > 0
  ? mappings.map((m) =>
      `    ${JSON.stringify(m.targetField)}: row[${JSON.stringify(m.sourceField)}],`
    ).join('\n')
  : outputSchema.map((f) =>
      `    ${JSON.stringify(f.name)}: row[${JSON.stringify(f.physicalName ?? f.name)}],`
    ).join('\n')
}
  }
}
`
  },
}

// ─────────────────────────────────────────────────────────────────

/**
 * src/codegen/typescript/generators/sink.ts
 */
export const sinkGenerator: NodeGenerator = {
  operation: 'sink',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const uiType  = node._uiRef?.type ?? 'sink_file'
    const config  = (node._uiRef?.config ?? {}) as any
    const varName = ctx.nodeVarMap.get(node.id)!
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)

    switch (uiType) {
      case 'sink_file': return generateFileSink(node, config, varName, label)
      case 'sink_db':   return generateDbSink(node, config, varName, label)
      default:          return generateGenericSink(varName, label)
    }
  },
}

function generateFileSink(node: LogicalNode, config: any, varName: string, label: string): string {
  const props  = config?.props ?? {}
  const path   = props.path   ?? '/data/output.csv'
  const format = props.format ?? 'csv'
  const mode   = props.mode   ?? 'overwrite'

  return `/**
 * Sink: ${label}
 * Tipo: File ${format.toUpperCase()}
 * Path: ${path}
 * Modalità: ${mode}
 */

import * as fs   from 'fs'
import * as path from 'path'

export interface ${varName}Result {
  rowsProcessed: number
  rowsRejected:  number
  bytesWritten:  number
  filePath:      string
}

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  const outputPath = ${JSON.stringify(path)}

  // Crea directory se non esiste
  fs.mkdirSync(path.dirname(outputPath), { recursive: true })

${format === 'json' || format === 'jsonl'
  ? generateJsonSinkBody(format)
  : generateCsvSinkBody()
}

  const stats = fs.statSync(outputPath)
  return {
    rowsProcessed: inputRows.length,
    rowsRejected:  0,
    bytesWritten:  stats.size,
    filePath:      outputPath,
  }
}
`
}

function generateCsvSinkBody(): string {
  return `  if (inputRows.length === 0) {
    fs.writeFileSync(outputPath, '')
    return { rowsProcessed: 0, rowsRejected: 0, bytesWritten: 0, filePath: outputPath }
  }

  const headers = Object.keys(inputRows[0])
  const lines   = [
    headers.join(','),
    ...inputRows.map((row) =>
      headers.map((h) => {
        const val = row[h]
        if (val === null || val === undefined) return ''
        const s = String(val)
        return s.includes(',') || s.includes('"') || s.includes('\\n')
          ? \`"\${s.replace(/"/g, '""')}"\`
          : s
      }).join(',')
    ),
  ]
  fs.writeFileSync(outputPath, lines.join('\\n'), 'utf-8')`
}

function generateJsonSinkBody(format: string): string {
  if (format === 'jsonl') {
    return `  const lines = inputRows.map((row) => JSON.stringify(row)).join('\\n')
  fs.writeFileSync(outputPath, lines, 'utf-8')`
  }
  return `  fs.writeFileSync(outputPath, JSON.stringify(inputRows, null, 2), 'utf-8')`
}

function generateDbSink(node: LogicalNode, config: any, varName: string, label: string): string {
  const props     = config?.props ?? {}
  const table     = props.table ?? 'tabella'
  const mode      = props.mode  ?? 'insert'
  const keyFields = props.keyFields?.split(',').map((k: string) => k.trim()) ?? ['id']

  return `/**
 * Sink: ${label}
 * Tipo: Database
 * Tabella: ${table}
 * Modalità: ${mode}
 */

interface DbConnection {
  execute(sql: string, params: unknown[]): Promise<{ rowsAffected: number }>
  close(): Promise<void>
}

declare function createConnection(config: Record<string, string>): Promise<DbConnection>

export interface ${varName}Result {
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  if (inputRows.length === 0) return { rowsProcessed: 0, rowsRejected: 0 }

  const conn = await createConnection({})
  let rowsRejected = 0

  try {
    const columns = Object.keys(inputRows[0])
${mode === 'insert' ? generateInsertBody(table) : generateUpsertBody(table, keyFields)}
  } finally {
    await conn.close()
  }

  return { rowsProcessed: inputRows.length - rowsRejected, rowsRejected }
}
`
}

function generateInsertBody(table: string): string {
  return `    for (const row of inputRows) {
      const cols   = Object.keys(row)
      const values = Object.values(row)
      const placeholders = cols.map((_, i) => \`$\${i + 1}\`).join(', ')
      const sql = \`INSERT INTO ${table} (\${cols.join(', ')}) VALUES (\${placeholders})\`
      await conn.execute(sql, values)
    }`
}

function generateUpsertBody(table: string, keyFields: string[]): string {
  return `    for (const row of inputRows) {
      const cols    = Object.keys(row)
      const values  = Object.values(row)
      const setCols = cols.filter((c) => !${JSON.stringify(keyFields)}.includes(c))
      const setStr  = setCols.map((c, i) => \`\${c} = $\${i + 1}\`).join(', ')
      const keyStr  = ${JSON.stringify(keyFields)}.map((k, i) => \`\${k} = $\${setCols.length + i + 1}\`).join(' AND ')
      const sql = \`UPDATE ${table} SET \${setStr} WHERE \${keyStr}\`
      const result = await conn.execute(sql, [...setCols.map((c) => row[c]), ...${JSON.stringify(keyFields)}.map((k) => row[k])])
      if (result.rowsAffected === 0) {
        const placeholders = cols.map((_, i) => \`$\${i + 1}\`).join(', ')
        await conn.execute(\`INSERT INTO ${table} (\${cols.join(', ')}) VALUES (\${placeholders})\`, values)
      }
    }`
}

function generateGenericSink(varName: string, label: string): string {
  return `/**
 * Sink: ${label}
 */

export interface ${varName}Result {
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  // TODO: implementare la logica di scrittura
  console.log(\`[${label}] \${inputRows.length} righe\`)
  return { rowsProcessed: inputRows.length, rowsRejected: 0 }
}
`
}

// ─────────────────────────────────────────────────────────────────

/**
 * src/codegen/typescript/generators/transform.ts
 */
export const transformGenerator: NodeGenerator = {
  operation: 'transform',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const varName  = ctx.nodeVarMap.get(node.id)!
    const label    = node._uiRef?.label ?? canvasNodeId(node.id)
    const config   = (node._uiRef?.config ?? {}) as any
    const props    = config?.props ?? {}
    const lang     = props.lang ?? 'typescript'
    const code     = props.code ?? '// row è disponibile come input\nreturn row'

    return `/**
 * Script: ${label}
 * Linguaggio: ${lang}
 */

export interface ${varName}Result {
  rows:          Record<string, unknown>[]
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  const rows: Record<string, unknown>[] = []
  const rejected: Record<string, unknown>[] = []

  for (const row of inputRows) {
    try {
      const result = await transform(row)
      if (result !== null && result !== undefined) {
        rows.push(result)
      }
    } catch (err) {
      rejected.push({ ...row, _error: String(err) })
    }
  }

  return { rows, rowsProcessed: rows.length, rowsRejected: rejected.length }
}

/** Logica dello script — originale dall'editor */
async function transform(
  row: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  // Script originale:
  // ${code.split('\n').join('\n  // ')}

  // TODO: il codice dello script viene iniettato qui
  // Per sicurezza viene eseguito in un worker separato in produzione
  return row
}
`
  },
}

// ─────────────────────────────────────────────────────────────────

/**
 * src/codegen/typescript/generators/parse.ts
 * Gestisce json_parser e xml_parser
 */
export const parseGenerator: NodeGenerator = {
  operation: 'parse',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const uiType  = node._uiRef?.type ?? 'json_parser'
    const varName = ctx.nodeVarMap.get(node.id)!
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)
    const config  = (node._uiRef?.config ?? {}) as any

    if (uiType === 'json_parser') return generateJsonParser(node, config, varName, label, ctx)
    if (uiType === 'xml_parser')  return generateXmlParser(node, config, varName, label, ctx)
    return generateGenericParser(varName, label)
  },
}

function generateJsonParser(
  node: LogicalNode, config: any, varName: string, label: string, ctx: CodegenContext
): string {
  const jsonCfg     = config?.jsonParser
  const sourceField = jsonCfg?.sourceField ?? 'body'
  const flows       = jsonCfg?.flows ?? []

  const flowInterfaces = flows.map((flow: any) => {
    const fields = (flow.fields ?? [])
      .map((f: any) => `  ${JSON.stringify(f.name)}: unknown`)
      .join('\n')
    return `interface ${varName}_${flow.label.replace(/[^a-zA-Z0-9]/g, '_')}Row {\n${fields}\n}`
  }).join('\n\n')

  const flowExtractors = flows.map((flow: any) => `
  // Flusso: ${flow.label} (${flow.contextXPath ?? flow.jsonPath ?? '$'})
  const ${flow.label.replace(/[^a-zA-Z0-9]/g, '_')}_rows = extractFlow_${flow.id.replace(/[^a-zA-Z0-9]/g, '_')}(parsed)
  result.${flow.label.replace(/[^a-zA-Z0-9]/g, '_')} = ${flow.label.replace(/[^a-zA-Z0-9]/g, '_')}_rows`).join('\n')

  return `/**
 * JSON Parser: ${label}
 * Campo sorgente: ${sourceField}
 * Flussi: ${flows.map((f: any) => f.label).join(', ')}
 */

${flowInterfaces}

export interface ${varName}Result {
${flows.map((f: any) => `  ${f.label.replace(/[^a-zA-Z0-9]/g, '_')}: unknown[]`).join('\n')}
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  let rowsProcessed = 0
  let rowsRejected  = 0
  const result: any = {}

  for (const inputRow of inputRows) {
    const rawJson = inputRow[${JSON.stringify(sourceField)}]
    if (!rawJson) { rowsRejected++; continue }

    try {
      const parsed = typeof rawJson === 'string' ? JSON.parse(rawJson) : rawJson
${flowExtractors}
      rowsProcessed++
    } catch {
      rowsRejected++
    }
  }

  return { ...result, rowsProcessed, rowsRejected }
}

${flows.map((flow: any) => generateFlowExtractor(flow)).join('\n\n')}
`
}

function generateFlowExtractor(flow: any): string {
  const jsonPath    = flow.jsonPath ?? '$'
  const isArray     = flow.isArray ?? false
  const fields      = flow.fields ?? []
  const fnId        = flow.id.replace(/[^a-zA-Z0-9]/g, '_')
  const pathCode    = jsonPath === '$'
    ? 'data'
    : `data?.${jsonPath.replace(/^\$\.?/, '').split('.').join('?.')}`

  return `function extractFlow_${fnId}(data: unknown): unknown[] {
  const target = ${pathCode}
  const items  = ${isArray ? 'Array.isArray(target) ? target : [target]' : '[target]'}
  return items.map((item: any) => ({
${fields.map((f: any) => {
  const xpath = f.xpath ?? f.jsonPath ?? f.name
  const code  = xpath === '.' ? 'item' : `item?.[${JSON.stringify(f.name)}]`
  return `    ${JSON.stringify(f.name)}: ${code},`
}).join('\n')}
  }))
}`
}

function generateXmlParser(
  node: LogicalNode, config: any, varName: string, label: string, ctx: CodegenContext
): string {
  const xmlCfg      = config?.xmlParser
  const sourceField = xmlCfg?.sourceField ?? 'body'
  const flows       = xmlCfg?.flows ?? []

  return `/**
 * XML Parser: ${label}
 * Campo sorgente: ${sourceField}
 * Flussi: ${flows.map((f: any) => f.label).join(', ')}
 *
 * Dipendenza richiesta: npm install fast-xml-parser
 */

import { XMLParser } from 'fast-xml-parser'

export interface ${varName}Result {
${flows.map((f: any) => `  ${f.label.replace(/[^a-zA-Z0-9]/g, '_')}: unknown[]`).join('\n')}
  rowsProcessed: number
  rowsRejected:  number
}

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' })

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  let rowsProcessed = 0
  let rowsRejected  = 0
  const result: any = { ${flows.map((f: any) => `${f.label.replace(/[^a-zA-Z0-9]/g, '_')}: []`).join(', ')} }

  for (const inputRow of inputRows) {
    const rawXml = inputRow[${JSON.stringify(sourceField)}]
    if (!rawXml) { rowsRejected++; continue }

    try {
      const parsed = xmlParser.parse(String(rawXml))
${flows.map((flow: any) => {
  const path = flow.contextXPath?.replace(/^\//, '').split('/').join('?.') ?? flow.label
  const isArr = flow.isArray ?? false
  const fnName = flow.label.replace(/[^a-zA-Z0-9]/g, '_')
  return `      const ${fnName}_data = parsed?.${path}
      result.${fnName}.push(...${isArr ? `(Array.isArray(${fnName}_data) ? ${fnName}_data : [${fnName}_data]).map((item: any) => extractFields_${fnName}(item))` : `[extractFields_${fnName}(${fnName}_data)]`})`
}).join('\n')}
      rowsProcessed++
    } catch {
      rowsRejected++
    }
  }

  return { ...result, rowsProcessed, rowsRejected }
}

${flows.map((flow: any) => {
  const fnName = flow.label.replace(/[^a-zA-Z0-9]/g, '_')
  const fields = flow.fields ?? []
  return `function extractFields_${fnName}(item: any): Record<string, unknown> {
  if (!item) return {}
  return {
${fields.map((f: any) => {
  const xpath = f.xpath ?? f.name
  const isAttr = f.fromAttr || f.name.startsWith('@')
  const key = isAttr ? `@_${f.name.replace(/^@/, '')}` : xpath
  return `    ${JSON.stringify(f.name)}: item?.[${JSON.stringify(key)}] ?? null,`
}).join('\n')}
  }
}`
}).join('\n\n')}
`
}

function generateGenericParser(varName: string, label: string): string {
  return `/**
 * Parser: ${label}
 */

export interface ${varName}Result {
  rows:          Record<string, unknown>[]
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(
  inputRows: Record<string, unknown>[]
): Promise<${varName}Result> {
  return { rows: inputRows, rowsProcessed: inputRows.length, rowsRejected: 0 }
}
`
}
