/**
 * src/runner/httpSourceExecutor.ts
 * ─────────────────────────────────
 * Executor per il nodo source_http.
 *
 * Funzionalità:
 *   - Una chiamata HTTP per ogni riga in ingresso (o una sola se input vuoto)
 *   - Interpolazione ${campo} in URL, query params, headers, body
 *   - Autenticazione: none, basic, bearer, api_key, digest, oauth2_cc, oauth2_ac
 *   - Body da riga: json, raw field, binary (base64 → ArrayBuffer)
 *   - Tipo risposta: json (estrai campi), json_raw, text, xml, csv, binary, pdf
 *   - Paginazione: page, cursor, offset, link header
 *   - Retry su codici configurabili con delay
 *   - Passthrough campi ingresso nello schema output
 *
 * Aggiungere in executors.ts:
 *   import { httpSourceExecutor } from './httpSourceExecutor'
 *   // in EXECUTORS[]: httpSourceExecutor
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

// ─── Interpolazione ${campo} ──────────────────────────────────────
function interpolate(template: string, row: Row): string {
  return template.replace(/\$\{([^}]+)\}/g, (_, key) => {
    const val = row[key.trim()]
    return val === null || val === undefined ? '' : String(val)
  })
}

// ─── Risolve JSON path tipo $.data.items ─────────────────────────
function resolveJsonPath(data: unknown, path: string): unknown {
  if (!path || path === '$') return data
  const parts = path.replace(/^\$\.?/, '').split('.')
  let cur: unknown = data
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

// ─── Costruisce Authorization header per authType ─────────────────
function buildAuthHeaders(props: Record<string, unknown>): Record<string, string> {
  const p = (k: string, d = '') => String(props[k] ?? d)
  switch (p('authType', 'none')) {
    case 'basic':
    case 'digest': {
      const creds = btoa(`${p('username')}:${p('password')}`)
      return { Authorization: `Basic ${creds}` }
    }
    case 'bearer':
      return { Authorization: `Bearer ${p('bearerToken')}` }
    case 'api_key':
      if (p('apiKeyIn', 'header') === 'header') {
        return { [p('apiKeyName', 'X-Api-Key')]: p('apiKeyValue') }
      }
      return {}
    case 'oauth2_ac':
      return { Authorization: `Bearer ${p('oauth2AccessToken')}` }
    default:
      return {}
  }
}

// ─── OAuth2 Client Credentials — ottiene token ────────────────────
const oauth2TokenCache = new Map<string, { token: string; expiresAt: number }>()

async function getOAuth2CCToken(props: Record<string, unknown>): Promise<string> {
  const p        = (k: string, d = '') => String(props[k] ?? d)
  const cacheKey = `${p('oauth2TokenUrl')}::${p('oauth2ClientId')}`
  const cached   = oauth2TokenCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 10000) return cached.token

  const clientAuth = p('oauth2ClientAuth', 'body')
  const headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' }
  if (clientAuth === 'basic') {
    headers['Authorization'] = `Basic ${btoa(`${p('oauth2ClientId')}:${p('oauth2ClientSecret')}`)}`
  }

  const body = new URLSearchParams({
    grant_type:    'client_credentials',
    ...(clientAuth !== 'basic' ? { client_id: p('oauth2ClientId'), client_secret: p('oauth2ClientSecret') } : {}),
    ...(p('oauth2Scope')    ? { scope:    p('oauth2Scope')    } : {}),
    ...(p('oauth2Audience') ? { audience: p('oauth2Audience') } : {}),
  })

  const res  = await fetch(p('oauth2TokenUrl'), { method: 'POST', headers, body: body.toString() })
  if (!res.ok) throw new Error(`OAuth2 CC: token request failed — HTTP ${res.status}`)
  const data = await res.json() as Record<string, unknown>
  const token      = String(data['access_token'] ?? '')
  const expiresIn  = Number(data['expires_in'] ?? 3600)
  oauth2TokenCache.set(cacheKey, { token, expiresAt: Date.now() + expiresIn * 1000 })
  return token
}

// ─── Costruisce il body della request ────────────────────────────
async function buildRequestBody(
  props:    Record<string, unknown>,
  row:      Row,
  headers:  Record<string, string>,
): Promise<BodyInit | null> {
  const p       = (k: string, d = '') => String(props[k] ?? d)
  const method  = p('method', 'GET')
  const hasInput = Object.keys(row).length > 0

  if (!['POST', 'PUT', 'PATCH'].includes(method)) return null

  const bodyMode = p('inputBodyMode', hasInput ? 'json' : 'none')

  switch (bodyMode) {
    case 'none': {
      const rawBody = p('body')
      if (!rawBody) return null
      headers['Content-Type'] = headers['Content-Type'] ?? p('contentType', 'application/json')
      return interpolate(rawBody, row)
    }
    case 'json': {
      const template = p('inputBodyTemplate', '')
      headers['Content-Type'] = 'application/json'
      if (template) {
        return interpolate(template, row)
      }
      // Tutti i campi della riga come JSON
      const bodyObj: Row = {}
      for (const [k, v] of Object.entries(row)) bodyObj[k] = v
      return JSON.stringify(bodyObj)
    }
    case 'raw': {
      const fieldName   = p('inputRawField', '')
      const contentType = p('inputRawContentType', 'text/plain')
      headers['Content-Type'] = contentType
      return String(row[fieldName] ?? '')
    }
    case 'binary': {
      const fieldName   = p('inputBinaryField', 'content')
      const contentType = p('inputBinaryContentType', 'application/octet-stream')
      headers['Content-Type'] = contentType
      const b64    = String(row[fieldName] ?? '')
      const binary = atob(b64)
      const bytes  = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      return bytes.buffer
    }
    default:
      return null
  }
}

// ─── Aggiunge API key alla query string ───────────────────────────
function appendApiKeyQuery(url: string, props: Record<string, unknown>): string {
  const p = (k: string, d = '') => String(props[k] ?? d)
  if (p('authType') === 'api_key' && p('apiKeyIn', 'header') === 'query') {
    const sep = url.includes('?') ? '&' : '?'
    return `${url}${sep}${encodeURIComponent(p('apiKeyName', 'api_key'))}=${encodeURIComponent(p('apiKeyValue'))}`
  }
  return url
}

// ─── Aggiunge query params ────────────────────────────────────────
function appendQueryParams(url: string, qpJson: string, row: Row): string {
  try {
    const qp  = JSON.parse(interpolate(qpJson, row)) as Record<string, unknown>
    const sep = url.includes('?') ? '&' : '?'
    const qs  = Object.entries(qp)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&')
    return qs ? url + sep + qs : url
  } catch { return url }
}

// ─── Aggiunge header dinamici da campi riga ───────────────────────
function buildDynamicHeaders(mappingJson: string, row: Row): Record<string, string> {
  try {
    const mapping = JSON.parse(mappingJson) as Record<string, string>
    const result: Record<string, string> = {}
    for (const [field, headerName] of Object.entries(mapping)) {
      const val = row[field]
      if (val !== undefined && val !== null) result[headerName] = String(val)
    }
    return result
  } catch { return {} }
}

// ─── Esegui singola chiamata HTTP con retry ───────────────────────
async function fetchWithRetry(
  url:        string,
  init:       RequestInit,
  retryCount: number,
  retryDelay: number,
  retryCodes: Set<number>,
  context:    ExecutionContext,
  nodeId:     string,
): Promise<Response> {
  let lastErr: unknown
  for (let attempt = 0; attempt <= retryCount; attempt++) {
    if (attempt > 0) {
      context.callbacks.onLog('warn',
        `HTTP retry ${attempt}/${retryCount} tra ${retryDelay}s...`, nodeId)
      await new Promise((r) => setTimeout(r, retryDelay * 1000))
    }
    try {
      const res = await fetch(url, init)
      if (attempt < retryCount && retryCodes.has(res.status)) {
        lastErr = new Error(`HTTP ${res.status}`)
        continue
      }
      return res
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

// ─── Processa una risposta HTTP → Row[] ──────────────────────────
async function processResponse(
  res:          Response,
  props:        Record<string, unknown>,
  t0:           number,
): Promise<Row[]> {
  const p           = (k: string, d = '') => String(props[k] ?? d)
  const responseType = p('responseType', 'json')
  const latencyMs   = Date.now() - t0
  const contentType = res.headers.get('content-type') ?? ''

  // Campi fissi sempre presenti
  const fixed: Row = {
    status_code:  res.status,
    content_type: contentType,
    latency_ms:   latencyMs,
    headers:      Object.fromEntries(res.headers.entries()),
  }

  switch (responseType) {
    case 'json': {
      const text    = await res.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = null }
      const jsonPath = p('jsonPath', '$')
      const target   = resolveJsonPath(parsed, jsonPath)
      const rows     = Array.isArray(target) ? target : (target ? [target] : [])
      // Estrai solo i campi custom dichiarati
      let customFields: Array<{ name: string }> = []
      try { customFields = JSON.parse(p('customFields', '[]')) } catch {}
      if (customFields.length === 0) {
        // Nessun campo dichiarato — passa tutto
        return rows.map((r) => ({ ...fixed, ...(typeof r === 'object' && r ? r as Row : { value: r }) }))
      }
      return rows.map((r) => {
        const src = (typeof r === 'object' && r ? r : {}) as Record<string, unknown>
        const out: Row = { ...fixed }
        for (const f of customFields) out[f.name] = src[f.name]
        return out
      })
    }

    case 'json_raw': {
      const text = await res.text()
      let parsed: unknown
      try { parsed = JSON.parse(text) } catch { parsed = null }
      return [{ ...fixed, body: text, body_parsed: parsed }]
    }

    case 'text':
    case 'xml':
    case 'csv': {
      const body = await res.text()
      return [{ ...fixed, body }]
    }

    case 'binary':
    case 'pdf': {
      const buf    = await res.arrayBuffer()
      const bytes  = new Uint8Array(buf)
      let b64 = ''
      const chunk  = 8192
      for (let i = 0; i < bytes.length; i += chunk) {
        b64 += String.fromCharCode(...bytes.subarray(i, i + chunk))
      }
      return [{ ...fixed, content: btoa(b64), content_length: bytes.length }]
    }

    default: {
      const body = await res.text()
      return [{ ...fixed, body }]
    }
  }
}

// ─── Esegui una singola pagina di richiesta ───────────────────────
async function executeSingleRequest(
  props:   Record<string, unknown>,
  row:     Row,
  context: ExecutionContext,
  nodeId:  string,
): Promise<Row[]> {
  const p = (k: string, d = '') => String(props[k] ?? d)

  const method       = p('method', 'GET')
  const retryCount   = parseInt(p('retryCount', '0'), 10)
  const retryDelay   = parseInt(p('retryDelay', '5'), 10)
  const timeoutMs    = parseInt(p('timeout', '30'), 10) * 1000
  const retryCodes   = new Set(
    p('retryCodes', '429,503,504').split(',').map((s) => parseInt(s.trim(), 10)).filter(Boolean)
  )

  // Auth headers
  let authHeaders: Record<string, string>
  if (p('authType') === 'oauth2_cc') {
    const token = await getOAuth2CCToken(props)
    authHeaders = { Authorization: `Bearer ${token}` }
  } else {
    authHeaders = buildAuthHeaders(props)
  }

  // Headers extra configurati + dinamici da riga
  let extraHeaders: Record<string, string> = {}
  try { extraHeaders = JSON.parse(interpolate(p('headers', '{}'), row)) } catch {}
  const dynamicHeaders = buildDynamicHeaders(p('inputHeaderMapping', '{}'), row)

  const allHeaders: Record<string, string> = {
    Accept: 'application/json, text/plain, */*',
    ...authHeaders,
    ...extraHeaders,
    ...dynamicHeaders,
  }

  // URL
  let url = interpolate(p('url'), row)
  url     = appendApiKeyQuery(url, props)
  url     = appendQueryParams(url, p('queryParams', '{}'), row)

  // Body
  const body = await buildRequestBody(props, row, allHeaders)

  const init: RequestInit = {
    method,
    headers: allHeaders,
    ...(body !== null ? { body } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  }

  const t0  = Date.now()
  const res = await fetchWithRetry(url, init, retryCount, retryDelay, retryCodes, context, nodeId)

  if (!res.ok) {
    context.callbacks.onLog('warn',
      `HTTP ${method} ${url} → ${res.status} ${res.statusText}`, nodeId)
  }

  return processResponse(res, props, t0)
}

// ─── Paginazione ─────────────────────────────────────────────────
async function executeWithPagination(
  props:   Record<string, unknown>,
  row:     Row,
  context: ExecutionContext,
  nodeId:  string,
): Promise<Row[]> {
  const p          = (k: string, d = '') => String(props[k] ?? d)
  const pagination = p('pagination', 'none')
  const maxPages   = parseInt(p('maxPages', '0'), 10)
  const pageSize   = parseInt(p('pageSize', '100'), 10)

  if (pagination === 'none') {
    return executeSingleRequest(props, row, context, nodeId)
  }

  const allRows: Row[] = []
  let page      = parseInt(p('pageStart', '1'), 10)
  let offset    = 0
  let cursor    = ''
  let pageNum   = 0
  let hasMore   = true

  while (hasMore && (maxPages === 0 || pageNum < maxPages)) {
    if (context.callbacks.isAborted()) break
    pageNum++

    // Costruisce i query params di paginazione
    const paginationParams: Record<string, unknown> = {}
    switch (pagination) {
      case 'page':
        paginationParams[p('pageParam', 'page')]     = page
        paginationParams[p('limitParam', 'limit') || 'page_size'] = pageSize
        break
      case 'offset':
        paginationParams[p('offsetParam', 'offset')] = offset
        paginationParams[p('limitParam', 'limit')]   = pageSize
        break
      case 'cursor':
        if (cursor) paginationParams[p('cursorParam', 'cursor')] = cursor
        paginationParams['limit'] = pageSize
        break
    }

    // Merge params di paginazione con quelli base
    let baseParams: Record<string, unknown> = {}
    try { baseParams = JSON.parse(interpolate(p('queryParams', '{}'), row)) } catch {}
    const mergedParams = { ...baseParams, ...paginationParams }

    const propsWithPagination = { ...props, queryParams: JSON.stringify(mergedParams) }
    const pageRows = await executeSingleRequest(propsWithPagination, row, context, nodeId)

    allRows.push(...pageRows)

    context.callbacks.onLog('info',
      `HTTP paginazione ${pagination} pagina ${pageNum}: ${pageRows.length} righe`, nodeId)

    // Determina se c'è un'altra pagina
    switch (pagination) {
      case 'page':
        hasMore = pageRows.length >= pageSize
        page++
        break
      case 'offset':
        hasMore = pageRows.length >= pageSize
        offset += pageSize
        break
      case 'cursor': {
        // Cerca il next cursor nella risposta (dal body_parsed o dal primo risultato)
        const cursorPath = p('cursorPath', '$.meta.next_cursor')
        // Il cursor è nel primo risultato come campo fisso o nel body
        const firstRow = pageRows[0]
        if (firstRow && firstRow['body_parsed']) {
          cursor = String(resolveJsonPath(firstRow['body_parsed'], cursorPath) ?? '')
        } else if (firstRow) {
          cursor = String(resolveJsonPath(firstRow, cursorPath) ?? '')
        }
        hasMore = !!cursor
        break
      }
      case 'link': {
        // Link header: cerca rel="next" nell'header
        const firstRow    = pageRows[0]
        const linkHeader  = firstRow?.['headers'] as Record<string, string> | undefined
        const linkValue   = linkHeader?.['link'] ?? ''
        const nextMatch   = linkValue.match(/<([^>]+)>;\s*rel="next"/)
        hasMore           = !!nextMatch
        // Aggiorna URL per la prossima pagina
        if (nextMatch) (props as Record<string, unknown>)['url'] = nextMatch[1]
        break
      }
      default:
        hasMore = false
    }
  }

  return allRows
}

// ─── Executor ─────────────────────────────────────────────────────
export const httpSourceExecutor: NodeExecutor = {
  handles: ['source_http'],

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props    = node.data.props ?? {}
    const p        = (k: string, d = '') => String(props[k] ?? d)
    const url      = p('url')
    const passthrough = p('passthroughInput', 'false') === 'true'

    if (!url) throw new Error('SourceHttp: URL non configurato')

    context.callbacks.onLog('info',
      `HTTP ${p('method', 'GET')} ${url}` +
      (input.length > 0 ? ` × ${input.length} righe in ingresso` : ''),
      node.id,
    )

    const allRows: Row[] = []

    // Se c'è input: una chiamata per ogni riga
    // Se non c'è input: una sola chiamata con riga vuota
    const rows = input.length > 0 ? input : [{}]

    for (const row of rows) {
      if (context.callbacks.isAborted()) break
      try {
        const responseRows = await executeWithPagination(props, row, context, node.id)

        // Passthrough: aggiunge i campi della riga originale a ogni riga di risposta
        if (passthrough && Object.keys(row).length > 0) {
          for (const rr of responseRows) {
            for (const [k, v] of Object.entries(row)) {
              if (!(k in rr)) rr[k] = v   // non sovrascrive campi risposta
            }
          }
        }

        allRows.push(...responseRows)

      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error',
          `HTTP errore per riga ${JSON.stringify(row)}: ${message}`, node.id)

        // Se c'è un solo input e fallisce, rilancia
        if (rows.length === 1) throw err
        // Altrimenti continua con le righe successive e aggiunge una riga di errore
        allRows.push({
          status_code:  0,
          content_type: '',
          latency_ms:   0,
          headers:      {},
          _error:       message,
          ...(passthrough ? row : {}),
        })
      }
    }

    context.callbacks.onLog('info',
      `HTTP completato: ${allRows.length} righe totali`, node.id)

    return new Map([['output', allRows]])
  },
}
