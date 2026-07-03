/**
 * src/runner/dbSinkExecutor.ts
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { invoke } from '@tauri-apps/api/core'

import {
  readTransactionGroup, ensureGroup, isAborted,
  beginTransaction, reportSuccess, reportFailure, reportSkipped,
  prepareXa,
} from './transactionCoordinator'
import type { GeneratedKeyConfig } from '../nodes/types/sink_db/MappingPanel'

// ─── Tipi ─────────────────────────────────────────────────────────

interface DbConnectionParams {
  dialect:        string
  host:           string
  port:           number
  database:       string
  user:           string
  password:       string
  schema?:        string
  ssl:            string
  connectTimeout: number
  serviceName?:   string
  dbServerName?:  string
  charset?:       string
}

interface DbColumnFunction {
  column: string
  expr:   string
}

interface DbWriteRequest {
  connection:         DbConnectionParams
  table:              string
  schema?:            string
  mode:               string
  rows:               Row[]
  keyFields?:         string[]
  whereConditions?:   WhereCondition[]
  columns?:           string[]
  excludeColumns?:    string[]
  columnFunctions?:   DbColumnFunction[]
  columnTypes?:       Record<string, string>
  mergeCondition?:    string
  preSql?:            string
  postSql?:           string
  batchSize:          number
  onConstraintError:  string
  deadLetterTable?:   string
  returningColumn?:   string
}

interface DbWriteResult {
  rows_written:   number
  rows_skipped:   number
  rows_errors:    number
  batches:        number
  elapsed_ms:     number
  generated_keys: unknown[]
}

type WhereOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IS NULL' | 'IS NOT NULL'

interface SinkColMapping {
  dbColumn:    string
  sourceField: string
  enabled:     boolean
  dbFunction?: string
  dbType?:     string
  isPk?:       boolean
  nullable?:   boolean
  isKey?:       boolean
  keyOperator?: WhereOperator
  keyLogic?:    'AND' | 'OR'
  isHashKey?:   boolean
}

interface WhereCondition {
  column:      string
  operator:    WhereOperator
  sourceField?: string
  logic?:      'AND' | 'OR'
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Tipi che indicano autoincrement — esclusi da INSERT, trattati come SERIAL in DDL */
const SERIAL_TYPES = new Set(['serial', 'bigserial', 'smallserial'])

function isSerialType(dbType?: string): boolean {
  return SERIAL_TYPES.has((dbType ?? '').toLowerCase().trim())
}

// ─── buildConnection ──────────────────────────────────────────────

function buildConnection(
  node:    FlowNode<NodeData>,
  context: ExecutionContext,
): DbConnectionParams {
  const props = node.data.props ?? {}
  const p     = (k: string, d = '') => String(props[k] ?? d)
  const dialect = p('dialect', 'postgresql')

  const resourceId = node.data.config?.resourceId as string | undefined
  if (resourceId) {
    const laneId   = node.data.laneId
    const lane     = context.lanes.find(l => l.id === laneId)
    const resource = lane?.resources.find(r => r.id === resourceId)
    if (resource?.config) {
      const rc = resource.config
      return {
        dialect:        rc.dialect       ?? rc.driver ?? 'postgresql',
        host:           rc.host          ?? 'localhost',
        port:           parseInt(rc.port ?? defaultPort(dialect), 10),
        database:       rc.database      ?? '',
        user:           rc.user          ?? rc.username ?? '',
        password:       rc.password      ?? '',
        schema:         rc.schema,
        ssl:            rc.ssl           ?? 'false',
        connectTimeout: parseInt(rc.connectTimeout ?? '10', 10),
        serviceName:    rc.serviceName,
        dbServerName:   rc.dbServerName,
        charset:        rc.charset,
      }
    }
  }

  return {
    dialect,
    host:           p('host', 'localhost'),
    port:           parseInt(p('port', defaultPort(dialect)), 10),
    database:       p('database'),
    user:           p('user'),
    password:       p('password'),
    schema:         p('schema') || undefined,
    ssl:            p('ssl', 'false'),
    connectTimeout: parseInt(p('connectTimeout', '10'), 10),
  }
}

function defaultPort(dialect: string): string {
  return { postgresql: '5432', mysql: '3306', oracle: '1521', informix: '9088' }[dialect] ?? '5432'
}

async function execSql(connection: DbConnectionParams, sql: string): Promise<void> {
  const statements = sql.split(';').map(s => s.trim()).filter(Boolean)
  for (const stmt of statements) {
    await invoke<unknown>('db_query', { request: { connection, query: stmt, timeout: 30 } })
  }
}

function filterColumns(rows: Row[], include: string[], exclude: string[]): Row[] {
  if (include.length === 0 && exclude.length === 0) return rows
  return rows.map(row => {
    const out: Row = {}
    const keys = include.length > 0 ? include : Object.keys(row)
    for (const k of keys) {
      if (exclude.includes(k)) continue
      if (k in row) out[k] = row[k]
    }
    return out
  })
}

function buildWhereConditions(mapping: SinkColMapping[]): WhereCondition[] {
  const keyCols = mapping.filter(c => c.enabled && c.isKey)
  return keyCols.map((col, i) => ({
    column:      col.dbColumn,
    operator:    col.keyOperator ?? '=',
    sourceField: (col.keyOperator === 'IS NULL' || col.keyOperator === 'IS NOT NULL')
                   ? undefined
                   : (col.sourceField || col.dbColumn),
    logic:       i === 0 ? undefined : (col.keyLogic ?? 'AND'),
  }))
}

function buildColumnFunctions(mapping: SinkColMapping[]): DbColumnFunction[] {
  return mapping
    .filter(col => col.dbFunction?.trim() && !isSerialType(col.dbType))
    .map(col => ({ column: col.dbColumn, expr: col.dbFunction!.replace(/\{v\}/g, '$VALUE') }))
}

function buildProcessedRows(input: Row[], mapping: SinkColMapping[]): Row[] {
  // Colonne SERIAL/BIGSERIAL/SMALLSERIAL — escluse dall'INSERT (il DB le genera)
  const serialCols = new Set(
    mapping
      .filter(c => isSerialType(c.dbType))
      .map(c => c.dbColumn)
  )

  return input.map(row => {
    const out: Row = {}
    for (const col of mapping) {
      // Salta colonne autoincrement
      if (serialCols.has(col.dbColumn)) continue

      const src    = col.sourceField || col.dbColumn
      const rawVal = src in row ? row[src] : null
      let val: unknown = rawVal
      if (col.dbType && rawVal !== null && rawVal !== undefined && rawVal !== '') {
        const t = col.dbType.toLowerCase()
        const isNumeric = ['int2','int4','int8','int','integer','bigint','smallint',
          'serial','bigserial','numeric','decimal','float4','float8','float',
          'double','real','money','number'].some(k => t === k || t.startsWith(k + '('))
        const isBoolean = ['boolean','bool','bit','tinyint(1)'].some(k => t === k || t.startsWith(k + '('))
        if (isNumeric) { const n = Number(rawVal); if (!isNaN(n)) val = n }
        else if (isBoolean) { val = rawVal === true || rawVal === 'true' || rawVal === '1' || rawVal === 1 }
      }
      out[col.dbColumn] = val
    }
    return out
  })
}

function buildWriteRequest(
  node:       FlowNode<NodeData>,
  input:      Row[],
  connection: DbConnectionParams,
  returningColumn?: string,
): DbWriteRequest {
  const props = node.data.props ?? {}
  const p     = (k: string, d = '') => String(props[k] ?? d)

  const table      = p('table')
  const schema     = p('querySchema', p('schema', connection.schema ?? 'public'))
  const mode       = p('mode', 'insert')
  const batchSize  = Math.max(1, parseInt(p('batchSize', '1000'), 10))
  const preSql     = p('preSql').trim()
  const postSql    = p('postSql').trim()
  const onConstr   = p('onConstraintError', 'stop')
  const deadLetter = p('deadLetterTable').trim()

  if (!table) throw new Error('SinkDB: tabella non configurata')

  const includeCols = p('columns').split(',').map(s => s.trim()).filter(Boolean)
  const excludeCols = p('excludeColumns').split(',').map(s => s.trim()).filter(Boolean)

  let sinkColsMapping: SinkColMapping[] = []
  try {
    const rawCols = p('sinkColumns')
    if (rawCols) sinkColsMapping = JSON.parse(rawCols).filter((c: SinkColMapping) => c.enabled)
  } catch {}

  const whereConditions = buildWhereConditions(sinkColsMapping)
  const keyFields = whereConditions.map(c => c.column)

  let processedRows: Row[]
  let columnFunctions: DbColumnFunction[] | undefined
  let columnTypes: Record<string, string> | undefined

  if (sinkColsMapping.length > 0) {
    processedRows   = buildProcessedRows(input, sinkColsMapping)
    const fns       = buildColumnFunctions(sinkColsMapping)
    columnFunctions = fns.length > 0 ? fns : undefined
    columnTypes = Object.fromEntries(
      sinkColsMapping
        .filter(c => c.dbType && !isSerialType(c.dbType))
        .map(c => [c.dbColumn, c.dbType!])
    )
  } else {
    processedRows = filterColumns(input, includeCols, excludeCols)
  }

  // Colonne da passare al backend — escluse le SERIAL
  const nonSerialCols = sinkColsMapping.length > 0
    ? sinkColsMapping
        .filter(c => !isSerialType(c.dbType))
        .map(c => c.dbColumn)
    : includeCols.length > 0 ? includeCols : undefined

  return {
    connection,
    table,
    schema:           schema || undefined,
    mode,
    rows:             processedRows,
    keyFields:        keyFields.length > 0 ? keyFields : undefined,
    whereConditions:  whereConditions.length > 0 ? whereConditions : undefined,
    columns:          nonSerialCols,
    excludeColumns:   sinkColsMapping.length > 0
                        ? undefined
                        : excludeCols.length > 0 ? excludeCols : undefined,
    columnFunctions,
    columnTypes,
    mergeCondition:   p('mergeCondition') || undefined,
    preSql:           preSql  || undefined,
    postSql:          postSql || undefined,
    batchSize,
    onConstraintError: onConstr,
    deadLetterTable:   deadLetter || undefined,
    returningColumn,
  }
}

// ─── Logica pass-through master-detail ────────────────────────────

function computeHash(row: Row, hashKeyCols: string[]): string {
  return hashKeyCols
    .map(col => {
      const val = row[col]
      return val === null || val === undefined ? '__null__' : String(val)
    })
    .join('\x00')
}

async function executePassthrough(
  node:              FlowNode<NodeData>,
  input:             Row[],
  context:           ExecutionContext,
  connection:        DbConnectionParams,
  sinkColsMapping:   SinkColMapping[],
  hashKeyCols:       string[],
  generatedKeyCfg:   GeneratedKeyConfig,
): Promise<Row[]> {
  const props   = node.data.props ?? {}
  const p       = (k: string, d = '') => String(props[k] ?? d)
  const table   = p('table')
  const schema  = p('querySchema', p('schema', connection.schema ?? 'public'))
  const mode    = p('mode', 'insert')
  const onConstr = p('onConstraintError', 'stop')

  if (!context.identityMaps.has(node.id)) {
    context.identityMaps.set(node.id, new Map())
  }
  const identityMap = context.identityMaps.get(node.id)!

  const outputFieldName = generatedKeyCfg.outputFieldName || `__${table}_id`
  const sourceDbColumn  = generatedKeyCfg.sourceDbColumn  || 'id'

  const enabledCols = sinkColsMapping.filter(c => c.enabled && !isSerialType(c.dbType))

  const enrichedRows: Row[] = []

  for (const row of input) {
    const hash = computeHash(row, hashKeyCols)

    if (identityMap.has(hash)) {
      const cachedKey = identityMap.get(hash)
      enrichedRows.push({ ...row, [outputFieldName]: cachedKey })
      continue
    }

    const masterRow: Row = {}
    for (const col of enabledCols) {
      const src = col.sourceField || col.dbColumn
      masterRow[col.dbColumn] = src in row ? row[src] : null
    }

    const columnFunctions: DbColumnFunction[] = buildColumnFunctions(enabledCols)
    if (generatedKeyCfg.dbFunction?.trim()) {
      columnFunctions.push({
        column: sourceDbColumn,
        expr:   generatedKeyCfg.dbFunction.replace(/\{v\}/g, '$VALUE'),
      })
    }

    let generatedKey: unknown = null

    try {
      const singleRowRequest: DbWriteRequest = {
        connection,
        table,
        schema:           schema || undefined,
        mode,
        rows:             [masterRow],
        columns:          enabledCols.map(c => c.dbColumn),
        columnFunctions:  columnFunctions.length > 0 ? columnFunctions : undefined,
        batchSize:        1,
        onConstraintError: onConstr,
        returningColumn:  sourceDbColumn,
      }

      const result = await invoke<DbWriteResult>('db_write', { request: singleRowRequest })

      if (result.generated_keys.length > 0) {
        generatedKey = result.generated_keys[0]
      }
    } catch (err) {
      if (onConstr === 'stop') {
        throw new Error(`SinkDB pass-through: errore INSERT master — ${err instanceof Error ? err.message : String(err)}`)
      }
    }

    identityMap.set(hash, generatedKey)
    enrichedRows.push({ ...row, [outputFieldName]: generatedKey })
  }

  return enrichedRows
}

// ─── DDL builder ──────────────────────────────────────────────────

function buildColDefs(
  sinkColsMapping: any[],
  input:           Row[],
  ddlPk:           string,
): string {
  if (sinkColsMapping.length > 0) {
    return sinkColsMapping.map((col) => {
      const sqlType  = col.dbType || 'TEXT'
      const isSerial = isSerialType(sqlType)
      const isPk     = ddlPk ? ddlPk === col.dbColumn : !!col.isPk
      const nullable = col.nullable === false ? ' NOT NULL' : ''

      if (isSerial) {
        // SERIAL/BIGSERIAL/SMALLSERIAL — sempre PRIMARY KEY, nessun altro modificatore
        return `  "${col.dbColumn}" ${sqlType.toUpperCase()} PRIMARY KEY`
      }
      return `  "${col.dbColumn}" ${sqlType}${isPk ? ' PRIMARY KEY' : ''}${nullable}`
    }).join(',\n')
  }

  if (input.length > 0) {
    const sampleRow = input[0]
    return Object.entries(sampleRow).map(([col, val]) => {
      const sqlType = typeof val === 'number' ? 'NUMERIC' : typeof val === 'boolean' ? 'BOOLEAN' : 'TEXT'
      const isPk    = ddlPk === col
      return `  "${col}" ${sqlType}${isPk ? ' PRIMARY KEY' : ''}`
    }).join(',\n')
  }

  return ''
}

// ─── Executor ─────────────────────────────────────────────────────

export const dbSinkExecutor: NodeExecutor = {
  handles: ['sink_db'],
  requiresCompleteInput: () => true,

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props = node.data.props ?? {}
    const p     = (k: string, d = '') => String(props[k] ?? d)

    if (input.length === 0) {
      context.callbacks.onLog('warn', 'SinkDB: nessuna riga in ingresso', node.id)
      return new Map([['output', []]])
    }

    const connection = buildConnection(node, context)
    const dialect    = connection.dialect
    const table      = p('table')
    const schema     = p('querySchema', p('schema', connection.schema ?? 'public'))
    const mode       = p('mode', 'insert')

    // ── Modalità pass-through master-detail ───────────────────────
    const passthroughActive = p('passthroughMasterDetail', 'false') === 'true'

    if (passthroughActive) {
      let sinkColsMapping: SinkColMapping[] = []
      try {
        const rawCols = p('sinkColumns')
        if (rawCols) sinkColsMapping = JSON.parse(rawCols).filter((c: SinkColMapping) => c.enabled)
      } catch {}

      const hashKeyCols = sinkColsMapping
        .filter(c => c.isHashKey)
        .map(c => c.sourceField || c.dbColumn)

      if (hashKeyCols.length === 0) {
        context.callbacks.onLog('warn',
          'SinkDB pass-through: nessuna colonna Hash configurata — operazione saltata.',
          node.id)
        return new Map([['output', input]])
      }

      let generatedKeyCfg: GeneratedKeyConfig = {
        outputFieldName: `__${table}_id`,
        sourceDbColumn:  'id',
        dbFunction:      '',
        dbType:          'int8',
      }
      try {
        const raw = p('generatedKeyConfig')
        if (raw) generatedKeyCfg = JSON.parse(raw)
      } catch {}

      context.callbacks.onLog('info',
        `SinkDB [${dialect}] pass-through — ${schema}.${table} · ${mode} · ${input.length} righe · hash su [${hashKeyCols.join(', ')}] · chiave → '${generatedKeyCfg.outputFieldName}'`,
        node.id)

      const enrichedRows = await executePassthrough(
        node, input, context, connection,
        sinkColsMapping, hashKeyCols, generatedKeyCfg
      )

      const mapSize = context.identityMaps.get(node.id)?.size ?? 0
      context.callbacks.onLog('info',
        `SinkDB pass-through: ${enrichedRows.length} righe arricchite · ${mapSize} master unici in identity map`,
        node.id)

      return new Map([['output', enrichedRows]])
    }

    // ── Gruppo transazionale native ───────────────────────────────
    const tx = readTransactionGroup(node)

    if (tx && tx.mode === 'native') {
      const laneId = node.data.laneId
      ensureGroup(context, laneId, tx)

      if (isAborted(context, laneId, tx.id)) {
        context.callbacks.onLog('warn',
          `SinkDB: gruppo transazionale '${tx.id}' già abortito — nodo saltato`, node.id)
        await reportSkipped(context, laneId, tx.id)
        return new Map([['output', []]])
      }

      const customQueryMode = p('customQueryMode', 'none')
      const incompatible = customQueryMode !== 'none'
        || p('createIfNotExists', 'false') === 'true'
        || p('dropAndCreate', 'false') === 'true'

      if (incompatible) {
        const msg = 'SinkDB: query custom / DDL non sono supportati all\'interno di un gruppo transazionale'
        context.callbacks.onLog('error', msg, node.id)
        await reportFailure(context, laneId, tx.id, node.id, node.data.type, msg)
        return new Map([['output', []]])
      }

      const beginResult = await beginTransaction(context, laneId, tx.id, node.id, node.data.type, connection)
      if (!beginResult.ok) {
        context.callbacks.onLog('error', `SinkDB: ${beginResult.error}`, node.id)
        return new Map([['output', []]])
      }

      let request: DbWriteRequest
      try {
        request = buildWriteRequest(node, input, connection)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error', `SinkDB: ${message}`, node.id)
        await reportFailure(context, laneId, tx.id, node.id, node.data.type, message)
        return new Map([['output', []]])
      }

      context.callbacks.onLog('info',
        `SinkDB [${dialect}] — ${schema}.${table} · ${mode} · ${request.rows.length} righe · tx='${tx.id}'`,
        node.id)

      let result: DbWriteResult
      try {
        result = await invoke<DbWriteResult>('db_tx_write', { request: { txId: tx.id, ...request } })
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error', `SinkDB (tx '${tx.id}'): ${message}`, node.id)
        await reportFailure(context, laneId, tx.id, node.id, node.data.type, message)
        return new Map([['output', []]])
      }

      context.callbacks.onLog('info',
        `SinkDB: ${result.rows_written} scritte, ${result.rows_skipped} saltate, ${result.rows_errors} errori · tx='${tx.id}'`,
        node.id)

      if (result.rows_errors > 0 && request.onConstraintError === 'stop') {
        const message = `${result.rows_errors} righe in errore — operazione interrotta`
        await reportFailure(context, laneId, tx.id, node.id, node.data.type, message)
        return new Map([['output', []]])
      }

      await reportSuccess(context, laneId, tx.id)

      return new Map([['output', [{
        _sink:                 `${schema}.${table}`,
        rows_written:          result.rows_written,
        rows_skipped:          result.rows_skipped,
        rows_errors:           result.rows_errors,
        mode,
        completed_at:          new Date().toISOString(),
        _transaction_group_id: tx.id,
      }]]])
    }

    // ── Gruppo transazionale xa ───────────────────────────────────
    if (tx && tx.mode === 'xa') {
      const laneId = node.data.laneId
      ensureGroup(context, laneId, tx)

      if (isAborted(context, laneId, tx.id)) {
        context.callbacks.onLog('warn',
          `SinkDB: gruppo transazionale '${tx.id}' (xa) già abortito — nodo saltato`, node.id)
        await reportSkipped(context, laneId, tx.id)
        return new Map([['output', []]])
      }

      const customQueryMode = p('customQueryMode', 'none')
      const incompatible = customQueryMode !== 'none'
        || p('createIfNotExists', 'false') === 'true'
        || p('dropAndCreate', 'false') === 'true'

      if (incompatible) {
        const msg = 'SinkDB: query custom / DDL non supportati in gruppo transazionale'
        context.callbacks.onLog('error', msg, node.id)
        await reportFailure(context, laneId, tx.id, node.id, node.data.type, msg)
        return new Map([['output', []]])
      }

      let request: DbWriteRequest
      try {
        request = buildWriteRequest(node, input, connection)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error', `SinkDB: ${message}`, node.id)
        await reportFailure(context, laneId, tx.id, node.id, node.data.type, message)
        return new Map([['output', []]])
      }

      context.callbacks.onLog('info',
        `SinkDB [${dialect}] — ${schema}.${table} · ${mode} · ${request.rows.length} righe · xa-prepare '${tx.id}'`,
        node.id)

      const prep = await prepareXa(context, laneId, tx.id, node.id, node.data.type, connection, request as any)

      if (!prep.ok) {
        context.callbacks.onLog('error', `SinkDB (xa '${tx.id}'): ${prep.error}`, node.id)
        return new Map([['output', []]])
      }

      const result = prep.result as DbWriteResult
      context.callbacks.onLog('info',
        `SinkDB: prepare ok — ${result.rows_written} scritte · xa '${tx.id}' (in attesa di commit)`,
        node.id)

      return new Map([['output', [{
        _sink:                 `${schema}.${table}`,
        rows_written:          result.rows_written,
        rows_skipped:          result.rows_skipped,
        rows_errors:           result.rows_errors,
        mode,
        completed_at:          new Date().toISOString(),
        _transaction_group_id: tx.id,
      }]]])
    }

    if (tx && tx.mode !== 'native' && tx.mode !== 'xa') {
      context.callbacks.onLog('warn',
        `SinkDB: modalità transazionale '${tx.mode}' non riconosciuta — eseguito come scrittura indipendente`,
        node.id)
    }

    // ── Percorso standalone ────────────────────────────────────────
    const batchSize         = Math.max(1, parseInt(p('batchSize', '1000'), 10))
    const preSql            = p('preSql').trim()
    const postSql           = p('postSql').trim()
    const createIfNotExists = p('createIfNotExists', 'false') === 'true'
    const dropAndCreate     = p('dropAndCreate', 'false') === 'true'
    const onConstr          = p('onConstraintError', 'stop')
    const deadLetter        = p('deadLetterTable').trim()

    if (!table) throw new Error('SinkDB: tabella non configurata')

    const customQueryMode = p('customQueryMode', 'none')
    const customSql       = p('customSql', '').trim()

    if (customQueryMode !== 'none' && customSql) {
      context.callbacks.onLog('info',
        `SinkDB [${dialect}] — query custom (${customQueryMode}) · ${input.length} righe`, node.id)

      if (customQueryMode === 'bulk_sql') {
        try {
          await execSql(connection, customSql)
          context.callbacks.onLog('info', 'SinkDB: bulk SQL eseguito', node.id)
        } catch (err) {
          throw new Error(`SinkDB bulk SQL: ${err instanceof Error ? err.message : String(err)}`)
        }
        return new Map([['output', [{ _sink: `${schema}.${table}`, mode: 'bulk_sql', completed_at: new Date().toISOString() }]]])
      }

      let executed = 0, errors = 0
      for (const row of input) {
        if (context.callbacks.isAborted()) break
        const sql = customSql.replace(/\{(\w+)\}/g, (_, field) => {
          const val = row[field]
          if (val === null || val === undefined) return 'NULL'
          if (typeof val === 'string') return `'${val.replace(/'/g, "''")}'`
          return String(val)
        })
        try { await execSql(connection, sql); executed++ }
        catch (err) {
          errors++
          if (onConstr === 'stop') throw new Error(`SinkDB custom query riga ${executed + errors}: ${err}`)
          context.callbacks.onLog('warn', `SinkDB custom query errore riga ${executed + errors}: ${err}`, node.id)
        }
      }
      context.callbacks.onLog('info', `SinkDB custom: ${executed} eseguite, ${errors} errori`, node.id)
      return new Map([['output', [{ _sink: `${schema}.${table}`, mode: customQueryMode, rows_executed: executed, rows_errors: errors, completed_at: new Date().toISOString() }]]])
    }

    // ── DDL: CREATE / DROP+CREATE ──────────────────────────────────
    if (dropAndCreate || createIfNotExists) {
      const ddlPk = p('ddlPrimaryKey', '').trim()
      let sinkColsMapping: any[] = []
      try {
        const rawCols = p('sinkColumns')
        if (rawCols) sinkColsMapping = JSON.parse(rawCols).filter((c: any) => c.enabled)
      } catch {}

      const colDefs = buildColDefs(sinkColsMapping, input, ddlPk)

      if (!colDefs) {
        context.callbacks.onLog('warn', 'SinkDB: impossibile creare tabella — nessun mapping configurato', node.id)
      } else {
        const fullTable = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
        if (dropAndCreate) {
          try {
            await execSql(connection, `DROP TABLE IF EXISTS ${fullTable}`)
            await execSql(connection, `CREATE TABLE ${fullTable} (\n${colDefs}\n)`)
            context.callbacks.onLog('info', `SinkDB: DROP + CREATE eseguito`, node.id)
          } catch (err) { throw new Error(`SinkDB DROP+CREATE: ${String(err)}`) }
        } else {
          try {
            await execSql(connection, `CREATE TABLE IF NOT EXISTS ${fullTable} (\n${colDefs}\n)`)
            context.callbacks.onLog('info', `SinkDB: CREATE IF NOT EXISTS eseguito`, node.id)
          } catch (err) { context.callbacks.onLog('warn', `SinkDB CREATE IF NOT EXISTS: ${String(err)}`, node.id) }
        }
      }
    }

    const request = buildWriteRequest(node, input, connection)

    context.callbacks.onLog('info',
      `SinkDB [${dialect}] — ${schema}.${table} · ${mode} · ${request.rows.length} righe · batch=${batchSize}`,
      node.id)

    let result: DbWriteResult
    try {
      result = await invoke<DbWriteResult>('db_write', { request })
    } catch (err) {
      throw new Error(`SinkDB: errore scrittura — ${err instanceof Error ? err.message : String(err)}`)
    }

    context.callbacks.onLog('info',
      `SinkDB: ${result.rows_written} scritte, ${result.rows_skipped} saltate, ${result.rows_errors} errori · ${result.batches} batch · ${result.elapsed_ms}ms`,
      node.id)

    if (result.rows_errors > 0 && onConstr === 'stop') {
      throw new Error(`SinkDB: ${result.rows_errors} righe in errore — operazione interrotta`)
    }

    return new Map([['output', [{
      _sink:        `${schema}.${table}`,
      rows_written:  result.rows_written,
      rows_skipped:  result.rows_skipped,
      rows_errors:   result.rows_errors,
      mode,
      completed_at:  new Date().toISOString(),
    }]]])
  },
}