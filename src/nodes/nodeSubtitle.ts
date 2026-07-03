/**
 * src/nodes/nodeSubtitle.ts
 *
 * Genera una stringa di sintesi per il box del nodo sul canvas.
 * Viene usata come fallback quando config.shortLabel è vuoto.
 *
 * Regola: max ~35 caratteri, monospace, informazione più utile per
 * capire cosa fa quel nodo senza aprire l'editor.
 */
import type { NodeData } from '../types'

// ── Helper catch ──────────────────────────────────────────────────
// Aggiunge '⚡catch' al subtitle quando onError === 'propagate'
function withCatch(subtitle: string, data: NodeData): string {
  const onError = (data.config?.advanced?.onError) ?? 'stop'
  if (onError !== 'propagate') return subtitle
  const sep = subtitle ? ' · ' : ''
  return `${subtitle}${sep}⚡catch`
}

export function getNodeSubtitle(data: NodeData): string {
  const p = (key: string, def = '') => data.props?.[key] ?? def
  const c = (key: string, def = '') => (data.config as any)?.[key] ?? def

  switch (data.type) {

    // ── Input ────────────────────────────────────────────────────
    case 'source_file': {
      const path = p('filePath') || p('path')
      if (path) return withCatch(truncate(path.split('/').pop() ?? path, 35), data)
      const fmt = p('format')
      return withCatch(fmt ? `formato: ${fmt}` : 'nessun file', data)
    }

    case 'source_db': {
      const schema = p('schema', 'public')
      const table  = p('table')
      if (table) return withCatch(`${schema}.${table}`, data)
      const q = p('query')
      return withCatch(q ? 'query SQL' : 'nessuna tabella', data)
    }

    case 'source_http': {
      const method = p('method', 'GET')
      const url    = p('url')
      if (!url) return withCatch(`${method} —`, data)
      try {
        const u = new URL(url)
        return withCatch(`${method} ${truncate(u.hostname + u.pathname, 28)}`, data)
      } catch {
        return withCatch(`${method} ${truncate(url, 28)}`, data)
      }
    }

    case 'source_kafka': {
      const topics = p('topics')
      const mode   = p('fetchMode', 'streaming') === 'batch' ? 'batch' : 'stream'
      const offset = p('offsetMode', 'latest')
      if (topics) return withCatch(`≋ ${truncate(topics, 20)} [${offset}·${mode}]`, data)
      return withCatch(`≋ [${offset}·${mode}]`, data)
    }

    case 'dir_watcher': {
      const dir  = p('directory') || p('path')
      const mode = p('watchMode', 'watch')
      if (dir) return withCatch(`${mode}: ${truncate(dir.split('/').pop() ?? dir, 28)}`, data)
      return withCatch(mode, data)
    }

    case 'source_activemq': {
      const dest = p('destination') || p('queue') || p('topic')
      const role = p('role', 'consumer')
      return withCatch(dest ? `${role}: ${truncate(dest, 28)}` : role, data)
    }

    case 'source_mqtt': {
      const topic = p('topic')
      return withCatch(topic ? `sub: ${truncate(topic, 30)}` : 'subscriber', data)
    }

    case 'trigger': {
      const mode = p('triggerMode', 'http')
      const expr = p('cronExpr') || p('interval')
      return withCatch(expr ? `${mode}: ${truncate(expr, 28)}` : mode, data)
    }

    case 'bridge_in': {
      const channel = p('channel') || p('channelName')
      return withCatch(channel ? `⊂ ${truncate(channel, 30)}` : '⊂ canale non impostato', data)
    }

    case 'source_ftp': {
      const path    = p('remotePath')
      const pattern = p('filePattern')
      const mode    = p('fetchMode', 'list') === 'watch' ? '◎' : '▤'
      const proto   = p('protocol', 'sftp').toUpperCase()
      if (path) return withCatch(`${mode} ${proto} ${truncate(path, 24)}${pattern ? pattern : ''}`, data)
      return withCatch(`${mode} ${proto}`, data)
    }

    // ── Transform ────────────────────────────────────────────────
    case 'filter': {
      const rules = (() => {
        try { return JSON.parse(p('rules', '[]')) } catch { return [] }
      })()
      const n = Array.isArray(rules) ? rules.length : 0
      return withCatch(n > 0 ? `${n} regol${n === 1 ? 'a' : 'e'}` : 'nessuna regola', data)
    }

    case 'data_quality': {
      try {
        const cfg = JSON.parse(p('dqConfig', '{}'))
        const rules = cfg.rules ?? []
        const n = rules.filter((r: any) => r.enabled !== false).length
        const repairs = rules.filter((r: any) => r.repair && r.repair !== 'none').length
        if (n === 0) return withCatch('nessuna regola', data)
        return withCatch(`${n} regole · ${repairs} repair · DTS`, data)
      } catch { return withCatch('DTS', data) }
    }

    case 'union': {
      const mode  = p('unionMode', 'concat')
      const label = mode === 'concat' ? 'CONCAT'
                  : mode === 'mix'    ? 'MIX'
                  : 'ZIP'
      return withCatch(`⊕ ${label}`, data)
    }
    
    case 'log': {
      const level    = p('logLevel', 'info').toUpperCase()
      const prefix   = p('logPrefix')
      const sample   = p('sampleMode', 'all')
      const sampleN  = p('sampleN', '10')
      const enabled  = p('logEnabled', 'true') === 'true'
      if (!enabled) return `📋 ${level} [off]`
      const sampleTag = sample === 'every_n'  ? ` /${sampleN}`
                      : sample === 'first_n'  ? ` ×${sampleN}`
                      : sample === 'random'   ? ` ~${p('samplePct', '10')}%`
                      : ''
      if (prefix) return `📋 ${level} ${truncate(prefix, 20)}${sampleTag}`
      return `📋 ${level}${sampleTag}`
    }

    case 'map': {
      const schema = (() => {
        try { return JSON.parse(p('outputSchema', '[]')) } catch { return [] }
      })()
      const n = Array.isArray(schema) ? schema.length : 0
      return withCatch(n > 0 ? `${n} camp${n === 1 ? 'o' : 'i'}` : 'nessun mapping', data)
    }

    case 'join': {
      const type   = p('join_type', 'inner').toUpperCase()
      const left   = p('leftKey')
      const right  = p('rightKey')
      const src    = p('rightSource', 'stream')
      const mat    = p('materializeName')
      const keys   = left && right ? `${left}=${right}` : ''
      const lookup = src === 'materialize' && mat ? `◈${mat}` : src
      return withCatch(keys ? `${type} · ${keys} · ${lookup}` : `${type} · ${lookup}`, data)
    }

    case 'tmap': {
      const tmap = (data.config as any)?.tmap
      const ins  = tmap?.inputs?.length  ?? 0
      const outs = tmap?.outputs?.length ?? 0
      return `${ins} in · ${outs} out`  // tmap non usa FlowNode, nessun withCatch
    }

    case 'aggregate': {
      const groupBy = p('group_by')
      const aggs    = (() => {
        try { return JSON.parse(p('aggFunctions', '[]')) } catch { return [] }
      })()
      const n    = Array.isArray(aggs) ? aggs.length : 0
      const src  = p('dataSource', 'flow')
      const mat  = p('materializeName')
      const from = src === 'materialize' && mat ? `◈${mat}` : 'flusso'
      if (groupBy) return withCatch(`${truncate(groupBy, 18)} · ${n} fn · ${from}`, data)
      return withCatch(`${n} funzion${n === 1 ? 'e' : 'i'} · ${from}`, data)
    }

    case 'window': {
      const wins = (() => {
        try { return JSON.parse(p('windows', '[]')) } catch { return [] }
      })()
      const n         = Array.isArray(wins) ? wins.length : 0
      const partition = p('partitionBy')
      const src       = p('dataSource', 'flow')
      const mat       = p('materializeName')
      const from      = src === 'materialize' && mat ? `◈${mat}` : 'flusso'
      if (partition) return withCatch(`PART BY ${truncate(partition, 14)} · ${n}fn · ${from}`, data)
      return withCatch(`${n} funzion${n === 1 ? 'e' : 'i'} · ${from}`, data)
    }

    case 'script': {
      const lang      = p('lang', 'typescript')
      const hasReject = p('hasReject') === 'true'
      return withCatch(hasReject ? `${lang} · +reject` : lang, data)
    }

    case 'materialize': {
      const name  = p('matName')
      const mode  = p('matMode', 'passthrough')
      const label = mode === 'passthrough' ? 'pass' : 'buf→sig'
      return withCatch(name ? `◈ ${name} · ${label}` : `◈ ${label}`, data)
    }

    case 'explode': {
      const src = p('explodeSource', 'materialize')
      const mat = p('materializeName')
      if (src === 'materialize' && mat) return withCatch(`⊕ ◈${truncate(mat, 28)}`, data)
      if (src === 'lane_var') return withCatch('⊕ var lane', data)
      return withCatch('⊕ campo flusso', data)
    }

    case 'json_parser': {
      const config   = (data.config as any)?.jsonParser
      const nFlows   = config?.flows?.length ?? 0
      const srcField = config?.sourceField || p('sourceField')
      return withCatch(srcField
        ? `${truncate(srcField, 20)} · ${nFlows} flusso${nFlows !== 1 ? 'i' : ''}`
        : `${nFlows} flusso${nFlows !== 1 ? 'i' : ''}`, data)
    }

    case 'xml_parser': {
      const config   = (data.config as any)?.xmlParser
      const nFlows   = config?.flows?.length ?? 0
      const srcField = config?.sourceField || p('sourceField')
      return withCatch(srcField
        ? `${truncate(srcField, 20)} · ${nFlows} flusso${nFlows !== 1 ? 'i' : ''}`
        : `${nFlows} flusso${nFlows !== 1 ? 'i' : ''}`, data)
    }

    case 'report_generator': {
      const fmt   = p('format', 'pdf').toUpperCase()
      const title = p('reportTitle') || p('title')
      return withCatch(title ? `${fmt} · ${truncate(title, 28)}` : fmt, data)
    }

    case 'pivot': {
      const mode      = p('pivotMode', 'pivot')
      const pivotType = p('pivotType', 'static')
      const src       = p('dataSource', 'flow')
      const mat       = p('materializeName')
      const from      = src === 'materialize' && mat ? `◈${mat}` : 'flusso'

      if (mode === 'unpivot') {
        const cols = (() => {
          try { return JSON.parse(p('unpivotColumns', '[]')) } catch { return [] }
        })()
        const n = Array.isArray(cols) ? cols.length : 0
        return withCatch(`UNPIVOT · ${n} col${n !== 1 ? 's' : ''} · ${from}`, data)
      }

      const pivotField = p('pivotField')
      const aggFn      = p('aggFn', 'sum').toUpperCase()
      const tag        = pivotType === 'dynamic' ? 'dyn' : 'stat'
      if (pivotField) return withCatch(`PIVOT[${tag}] ${truncate(pivotField, 14)} ${aggFn} · ${from}`, data)
      return withCatch(`PIVOT[${tag}] · ${from}`, data)
    }

    // ── Output ───────────────────────────────────────────────────
    case 'sink_db': {
      const schema = p('schema', 'public')
      const table  = p('table')
      const mode   = p('mode', 'insert')
      const tx     = (() => { try { return JSON.parse(p('transactionGroup')) } catch { return null } })()
      const txBadge = tx ? ` · ${tx.mode === 'xa' ? '⚡' : '🔒'}${tx.id}` : ''
      if (table) return withCatch(`${mode} → ${schema}.${table}${txBadge}`, data)
      return withCatch(`${mode}${txBadge}`, data)
    }

    case 'sink_file': {
      const path = p('path') || p('filePath')
      const fmt  = p('format', 'csv')
      const mode = p('outputMode', 'signal') === 'signal' ? 'sig' : 'rep'
      if (path) return withCatch(`${fmt} → ${truncate(path.split('/').pop() ?? path, 24)} [${mode}]`, data)
      return withCatch(`${fmt} [${mode}]`, data)
    }

    case 'sink_kafka': {
      const topic = p('topic')
      const fmt   = p('valueFormat', 'json')
      const tx    = (() => { try { return JSON.parse(p('transactionGroup')) } catch { return null } })()
      const txBadge = tx ? ` · ${tx.mode === 'xa' ? '⚡' : '🔒'}${tx.id}` : ''
      return withCatch(topic ? `${fmt} → ${truncate(topic, 22)}${txBadge}` : `${fmt}${txBadge}`, data)
    }

    case 'sink_ftp': {
      const path     = p('remotePath')
      const fileName = p('fileName')
      const proto    = p('protocol', 'sftp').toUpperCase()
      const mode     = p('outputMode', 'signal') === 'signal' ? 'sig' : 'pass'
      if (fileName) return withCatch(`${proto} → ${truncate(fileName, 22)} [${mode}]`, data)
      if (path)     return withCatch(`${proto} → ${truncate(path, 26)} [${mode}]`, data)
      return withCatch(`${proto} [${mode}]`, data)
    }

    case 'json_serializer': {
      const outField = p('outputField', 'json_output')
      const pretty   = p('pretty', 'false') === 'true' ? 'pretty' : 'compact'
      try {
        const struct = JSON.parse(p('jsonStructure', '[]'))
        const n = Array.isArray(struct) ? struct.length : 0
        return withCatch(`{ } ${n} camp${n !== 1 ? 'i' : 'o'} → ${truncate(outField, 18)} [${pretty}]`, data)
      } catch {
        return withCatch(`{ } → ${truncate(outField, 22)} [${pretty}]`, data)
      }
    }

    case 'xml_serializer': {
      const root     = p('rootElement', 'record')
      const outField = p('outputField', 'xml_output')
      const pretty   = p('pretty', 'false') === 'true' ? 'pretty' : 'compact'
      try {
        const struct = JSON.parse(p('xmlStructure', '[]'))
        const n = Array.isArray(struct) ? struct.length : 0
        return withCatch(`<${root}> ${n} nod${n !== 1 ? 'i' : 'o'} → ${truncate(outField, 14)} [${pretty}]`, data)
      } catch {
        return withCatch(`<${truncate(root, 16)}> → ${truncate(outField, 14)}`, data)
      }
    }

    case 'sink_activemq': {
      const dest = p('destination') || p('queue') || p('topic')
      const role = p('role', 'producer')
      return withCatch(dest ? `${role}: ${truncate(dest, 28)}` : role, data)
    }

    case 'sink_mqtt': {
      const topic = p('topic')
      return withCatch(topic ? `pub: ${truncate(topic, 30)}` : 'publisher', data)
    }

    case 'mail_sink': {
      const to      = p('to')
      const subject = p('subject')
      if (to)      return withCatch(`→ ${truncate(to, 32)}`, data)
      if (subject) return withCatch(truncate(subject, 35), data)
      return withCatch('nessun destinatario', data)
    }

    case 'bridge_out': {
      const channel = p('channel') || p('channelName')
      return withCatch(channel ? `⊃ ${truncate(channel, 30)}` : '⊃ canale non impostato', data)
    }

    // ── Start / End ───────────────────────────────────────────────
    case 'lane_start': return 'inizio lane'
    case 'lane_end':   return 'fine lane'

    default: return withCatch('', data)
  }
}

function truncate(s: string, max: number): string {
  if (!s) return ''
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}