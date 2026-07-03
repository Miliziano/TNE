/**
 * src/runner/dbSourceExecutor.ts
 *
 * NodeExecutor BATCH — carica tutto il result set in memoria.
 *
 * Questo è intenzionale e corretto per l'architettura ETL scelta:
 * il source_db è sempre batch. Lo streaming row-by-row avviene nel
 * TMap (StreamingNodeExecutor) che emette onRow per ogni riga output.
 *
 * La versione streaming via Tauri events (db_query_stream) è disponibile
 * ma non usata qui — potrebbe essere usata in futuro se si implementa
 * una pipeline con coroutine (non possibile in JS single-thread standard).
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { invoke } from '@tauri-apps/api/core'

interface DbConnectionParams {
  dialect:        string
  host:           string
  port:           number
  database:       string
  user:           string
  password:       string
  schema?:        string
  serviceName?:   string
  dbServerName?:  string
  charset?:       string
  ssl:            string
  connectTimeout: number
}

function getDefaultPort(dialect: string): string {
  const ports: Record<string, string> = {
    postgresql: '5432', mysql: '3306', oracle: '1521',
    informix: '9088', sqlite: '0',
  }
  return ports[dialect] ?? '5432'
}

function buildConnectionParams(node: FlowNode<NodeData>, context: ExecutionContext): DbConnectionParams {
  const props   = node.data.props ?? {}
  const p       = (k: string, d = '') => String(props[k] ?? d)
  const dialect = p('dialect', 'postgresql')

  const resourceId = node.data.config?.resourceId as string | undefined
  if (resourceId) {
    const lane     = context.lanes.find(l => l.id === node.data.laneId)
    const resource = lane?.resources.find(r => r.id === resourceId)
    if (resource?.config) {
      const rc = resource.config
      return {
        dialect:        rc.dialect      ?? dialect,
        host:           rc.host         ?? 'localhost',
        port:           parseInt(rc.port ?? getDefaultPort(dialect), 10),
        database:       rc.database     ?? '',
        user:           rc.user         ?? '',
        password:       rc.password     ?? '',
        schema:         rc.schema,
        serviceName:    rc.serviceName,
        dbServerName:   rc.dbServerName,
        charset:        rc.charset,
        ssl:            rc.ssl          ?? 'false',
        connectTimeout: parseInt(rc.connectTimeout ?? '10', 10),
      }
    }
  }

  return {
    dialect,
    host:           p('host', 'localhost'),
    port:           parseInt(p('port', getDefaultPort(dialect)), 10),
    database:       p('database'),
    user:           p('user'),
    password:       p('password'),
    schema:         p('schema') || undefined,
    serviceName:    p('serviceName') || undefined,
    dbServerName:   p('dbServerName') || undefined,
    charset:        p('charset') || undefined,
    ssl:            p('ssl', 'false'),
    connectTimeout: parseInt(p('connectTimeout', '10'), 10),
  }
}

function buildQuery(props: Record<string, unknown>): string {
  const p       = (k: string, d = '') => String(props[k] ?? d)
  const custom  = p('query').trim()
  if (custom) return applyQueryOptions(custom, props)

  const dialect = p('dialect', 'postgresql')
  const table   = p('table')
  const schema  = p('querySchema', p('schema', 'public'))
  if (!table) throw new Error('SourceDB: tabella non configurata')

  let from: string
  switch (dialect) {
    case 'sqlite':   from = table; break
    case 'mysql':    from = schema ? `\`${schema}\`.\`${table}\`` : `\`${table}\``; break
    case 'oracle':   from = schema ? `${schema}.${table}` : table; break
    case 'informix': from = table; break
    default:         from = schema ? `${schema}.${table}` : table
  }
  return applyQueryOptions(`SELECT * FROM ${from}`, props)
}

function applyQueryOptions(query: string, props: Record<string, unknown>): string {
  const p       = (k: string, d = '') => String(props[k] ?? d)
  const dialect = p('dialect', 'postgresql')
  const orderBy = p('orderBy').trim()
  const limit   = parseInt(p('limit', '0'), 10)
  const offset  = parseInt(p('offset', '0'), 10)

  let q = query.replace(/;\s*$/, '').trim()
  if (orderBy && !/ORDER\s+BY/i.test(q)) q += `\nORDER BY ${orderBy}`

  if (limit > 0) {
    switch (dialect) {
      case 'oracle':
        q = offset > 0
          ? `SELECT * FROM (\n  SELECT a.*, ROWNUM rn FROM (\n    ${q}\n  ) a WHERE ROWNUM <= ${offset + limit}\n) WHERE rn > ${offset}`
          : `SELECT * FROM (\n  ${q}\n) WHERE ROWNUM <= ${limit}`
        break
      case 'informix':
        q = offset > 0
          ? q.replace(/^SELECT/i, `SELECT SKIP ${offset} FIRST ${limit}`)
          : q.replace(/^SELECT/i, `SELECT FIRST ${limit}`)
        break
      default:
        q += `\nLIMIT ${limit}`
        if (offset > 0) q += ` OFFSET ${offset}`
    }
  } else if (offset > 0 && !['oracle','informix'].includes(dialect)) {
    q += `\nOFFSET ${offset}`
  }
  return q
}

function castValue(val: unknown, type: string): unknown {
  if (val === null || val === undefined) return null
  switch (type) {
    case 'integer':
    case 'number': { const n = Number(val); return isNaN(n) ? null : Math.trunc(n) }
    case 'decimal': { const n = Number(val); return isNaN(n) ? null : n }
    case 'boolean':
      if (typeof val === 'boolean') return val
      return ['true','1','yes','t','si','sì','on'].includes(String(val).toLowerCase())
    case 'date': {
      if (val instanceof Date) return val.toISOString().split('T')[0]
      const d = new Date(String(val))
      return isNaN(d.getTime()) ? String(val) : d.toISOString().split('T')[0]
    }
    case 'object':
      if (typeof val === 'object') return val
      try { return JSON.parse(String(val)) } catch { return val }
    default: return String(val)
  }
}

export const dbSourceExecutor: NodeExecutor = {
  handles: ['source_db'],

  async execute(node, _input, context): Promise<Map<string, Row[]>> {
    const props   = node.data.props ?? {}
    const p       = (k: string, d = '') => String(props[k] ?? d)
    const timeout = parseInt(p('queryTimeout', '30'), 10)

    const query = buildQuery(props)
    const connection = buildConnectionParams(node, context)

    context.callbacks.onLog('info',
      `SourceDB [${p('dialect','postgresql')}] — ${query.slice(0,120)}${query.length>120?'…':''}`,
      node.id)

    let rows: Row[]
    try {
      rows = await invoke<Row[]>('db_query', {
        request: { connection, query, timeout: timeout > 0 ? timeout : undefined },
      })
    } catch (err) {
      throw new Error(`SourceDB: ${err instanceof Error ? err.message : String(err)}`)
    }

    context.callbacks.onLog('info', `SourceDB: ${rows.length} righe lette`, node.id)

    // Applica schema output se configurato
    try {
      const raw = props['outputFields'] as string | undefined
      if (raw) {
        const fields: Array<{name: string; type: string}> = JSON.parse(raw)
        if (fields.length > 0) {
          rows = rows.map(row => {
            const out: Row = {}
            for (const f of fields) out[f.name] = castValue(row[f.name], f.type)
            return out
          })
        }
      }
    } catch {}

    return new Map([['output', rows]])
  },
}