/**
 * Generatore TypeScript per operazione 'scan'
 * Gestisce: source_file, source_db, source_http
 */

import type { LogicalNode } from '../../../ir/types'
import type { CodegenContext } from '../index'
import type { NodeGenerator } from './types'
import { canvasNodeId } from '../../../ir/lowering'
import { printExpr } from '../../../ir/expr'

export const scanGenerator: NodeGenerator = {
  operation: 'scan',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const uiType  = node._uiRef?.type ?? 'source_file'
    const config  = (node._uiRef?.config ?? {}) as any
    const varName = ctx.nodeVarMap.get(node.id)!
    const label   = node._uiRef?.label ?? canvasNodeId(node.id)

    // Genera il codice appropriato per il tipo di sorgente
    switch (uiType) {
      case 'source_file': return generateFileSource(node, config, varName, label)
      case 'source_db':   return generateDbSource(node, config, varName, label)
      case 'source_http': return generateHttpSource(node, config, varName, label)
      default:            return generateGenericSource(node, varName, label)
    }
  },
}

// ─── File source ──────────────────────────────────────────────────

function generateFileSource(
  node:    LogicalNode,
  config:  any,
  varName: string,
  label:   string,
): string {
  const props      = config?.props ?? {}
  const path       = props.path       ?? '/data/input.csv'
  const format     = props.format     ?? 'csv'
  const delimiter  = props.delimiter  ?? ','
  const limit      = parseInt(props.limit ?? '0')
  const outputType = schemaToTypeName(node, varName)

  return `/**
 * Sorgente: ${label}
 * Tipo: File ${format.toUpperCase()}
 * Path: ${path}
 */

import * as fs   from 'fs'
import * as path from 'path'
import type { ${outputType} } from '../types'

export interface ${varName}Result {
  rows:          ${outputType}[]
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(): Promise<${varName}Result> {
  const rows: ${outputType}[] = []
  let rowsRejected = 0

  try {
    const content = fs.readFileSync(${JSON.stringify(path)}, 'utf-8')
${format === 'csv' || format === 'tsv' ? generateCsvParsing(delimiter, limit) : generateJsonParsing(limit)}
  } catch (err) {
    throw new Error(\`[${label}] Errore lettura file: \${err}\`)
  }

  return { rows, rowsProcessed: rows.length, rowsRejected }
}
`
}

function generateCsvParsing(delimiter: string, limit: number): string {
  return `    const lines = content.split('\\n').filter(Boolean)
    const headers = lines[0].split(${JSON.stringify(delimiter)}).map((h: string) => h.trim())
    const dataLines = lines.slice(1)${limit > 0 ? `.slice(0, ${limit})` : ''}

    for (const line of dataLines) {
      const values = line.split(${JSON.stringify(delimiter)})
      const row: Record<string, unknown> = {}
      headers.forEach((h: string, i: number) => { row[h] = values[i]?.trim() ?? null })
      rows.push(row as any)
    }`
}

function generateJsonParsing(limit: number): string {
  return `    const parsed = JSON.parse(content)
    const data = Array.isArray(parsed) ? parsed : [parsed]
    const slice = ${limit > 0 ? `data.slice(0, ${limit})` : 'data'}
    for (const item of slice) {
      rows.push(item as any)
    }`
}

// ─── DB source ────────────────────────────────────────────────────

function generateDbSource(
  node:    LogicalNode,
  config:  any,
  varName: string,
  label:   string,
): string {
  const props      = config?.props     ?? {}
  const resConfig  = {}                   // config dalla risorsa (popolata a runtime)
  const query      = props.query         ?? `SELECT * FROM ${props.table ?? 'tabella'}`
  const limit      = parseInt(props.limit ?? '0')
  const outputType = schemaToTypeName(node, varName)

  // Predicati pushdown (annotati dall'optimizer)
  const pushdownPreds = (node._uiRef as any)?.pushdownPredicates ?? []
  const whereClause   = pushdownPreds.length > 0
    ? `\n    // WHERE aggiunto dall'optimizer (predicate pushdown)\n    // ${pushdownPreds.map(printExpr).join(' AND ')}`
    : ''

  return `/**
 * Sorgente: ${label}
 * Tipo: Database
 * Query: ${query.replace(/\n/g, ' ').substring(0, 80)}...
 */

import type { ${outputType} } from '../types'

// Configura qui la connessione al database
// FlowPilot userà le credenziali dalla config della risorsa
interface DbConnection {
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  close(): Promise<void>
}

// TODO: sostituire con il driver appropriato (pg, mysql2, better-sqlite3...)
declare function createConnection(config: Record<string, string>): Promise<DbConnection>

export interface ${varName}Result {
  rows:          ${outputType}[]
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(): Promise<${varName}Result> {
  // TODO: iniettare la config di connessione dalla risorsa
  const conn = await createConnection({
    // host, port, database, user, password dalla config risorsa
  })

  try {
    const sql = \`${query}${limit > 0 ? ` LIMIT ${limit}` : ''}${whereClause}\`
    const rows = await conn.query<${outputType}>(sql)
    return { rows, rowsProcessed: rows.length, rowsRejected: 0 }
  } finally {
    await conn.close()
  }
}
`
}

// ─── HTTP source ──────────────────────────────────────────────────

function generateHttpSource(
  node:    LogicalNode,
  config:  any,
  varName: string,
  label:   string,
): string {
  const props      = config?.props ?? {}
  const url        = props.url        ?? 'https://api.example.com/data'
  const method     = props.method     ?? 'GET'
  const authType   = props.authType   ?? 'none'
  const outputType = schemaToTypeName(node, varName)

  return `/**
 * Sorgente: ${label}
 * Tipo: HTTP ${method}
 * URL: ${url}
 */

import type { ${outputType} } from '../types'

export interface ${varName}Result {
  rows:          ${outputType}[]
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(): Promise<${varName}Result> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept':       'application/json',
${generateAuthHeaders(authType)}
  }

  const response = await fetch(${JSON.stringify(url)}, {
    method:  ${JSON.stringify(method)},
    headers,
  })

  if (!response.ok) {
    throw new Error(\`[${label}] HTTP \${response.status}: \${response.statusText}\`)
  }

  const data = await response.json()
  const rows = Array.isArray(data) ? data : [data]

  return {
    rows:          rows as ${outputType}[],
    rowsProcessed: rows.length,
    rowsRejected:  0,
  }
}
`
}

function generateAuthHeaders(authType: string): string {
  switch (authType) {
    case 'bearer':
      return `    // TODO: sostituire con il token reale\n    'Authorization': \`Bearer \${process.env.API_TOKEN ?? ''}\`,`
    case 'basic':
      return `    // TODO: sostituire con le credenziali reali\n    'Authorization': \`Basic \${Buffer.from(\`\${process.env.API_USER}:\${process.env.API_PASS}\`).toString('base64')}\`,`
    case 'api_key':
      return `    // TODO: sostituire con la chiave API reale\n    'X-API-Key': process.env.API_KEY ?? '',`
    default:
      return ''
  }
}

// ─── Generic source ───────────────────────────────────────────────

function generateGenericSource(
  node:    LogicalNode,
  varName: string,
  label:   string,
): string {
  return `/**
 * Sorgente: ${label}
 * Tipo: generico
 */

export interface ${varName}Result {
  rows:          Record<string, unknown>[]
  rowsProcessed: number
  rowsRejected:  number
}

export async function run(): Promise<${varName}Result> {
  // TODO: implementare la logica di lettura
  return { rows: [], rowsProcessed: 0, rowsRejected: 0 }
}
`
}

// ─── Helpers ──────────────────────────────────────────────────────

function schemaToTypeName(node: LogicalNode, varName: string): string {
  const label = node._uiRef?.label ?? varName
  return label
    .split(/[^a-zA-Z0-9]/)
    .filter(Boolean)
    .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join('') + 'Row'
}
