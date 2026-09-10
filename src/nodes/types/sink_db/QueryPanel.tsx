/**
 * src/nodes/types/sink_db/QueryPanel.tsx
 *
 * Montato nel tab "Query" della NodeEditorModal via NODE_QUERY_PANELS.
 * Copre: modalità query custom (SQL parametrizzato / stored proc / bulk),
 *        template rapidi con CustomSelectBox, campi flusso cliccabili,
 *        SQL pre/post scrittura con snippet per dialetto,
 *        preview SQL generata dalla configurazione corrente.
 */

import { useState, useMemo, useRef, useCallback, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { ScriptEditor } from '../../../components/ScriptEditor'
import { DB_DIALECT_COLORS, DB_DIALECT_LABELS, type DbDialect } from '../../../nodes/resourceDefaults'
import type { SinkColumnMapping } from './MappingPanel'

// ─── Stili ────────────────────────────────────────────────────────

const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none', width: '100%',
}

function SectionTitle({ label, color = '#3ddc84' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 8 }}>
      {label}
    </div>
  )
}

// ─── Snippet pre/post per dialetto ────────────────────────────────

const PRE_POST_SNIPPETS: Record<string, Array<{ label: string; code: string; target: 'pre' | 'post' }>> = {
  postgresql: [
    { label: 'LOCK TABLE',      code: 'LOCK TABLE public.my_table IN EXCLUSIVE MODE;',                                           target: 'pre'  },
    { label: 'TRUNCATE',        code: 'TRUNCATE TABLE public.my_table;',                                                          target: 'pre'  },
    { label: 'DISABLE trigger', code: 'ALTER TABLE public.my_table DISABLE TRIGGER ALL;',                                         target: 'pre'  },
    { label: 'ENABLE trigger',  code: 'ALTER TABLE public.my_table ENABLE TRIGGER ALL;',                                          target: 'post' },
    { label: 'REFRESH view',    code: 'REFRESH MATERIALIZED VIEW public.my_view;',                                                 target: 'post' },
    { label: 'UPDATE stats',    code: "UPDATE public.stats SET last_sync = NOW(), rows = (SELECT COUNT(*) FROM public.my_table);", target: 'post' },
    { label: 'NOTIFY',          code: "NOTIFY pipeline_channel, 'sync_complete';",                                               target: 'post' },
    { label: 'ANALYZE',         code: 'ANALYZE public.my_table;',                                                                 target: 'post' },
    { label: 'JSONB update',    code: "UPDATE public.my_table SET meta = meta || '{\"synced\": true}'::jsonb;",                   target: 'post' },
  ],
  mysql: [
    { label: 'TRUNCATE',     code: 'TRUNCATE TABLE `my_table`;',                                                   target: 'pre'  },
    { label: 'DISABLE keys', code: 'ALTER TABLE `my_table` DISABLE KEYS;',                                         target: 'pre'  },
    { label: 'ENABLE keys',  code: 'ALTER TABLE `my_table` ENABLE KEYS;',                                          target: 'post' },
    { label: 'ANALYZE',      code: 'ANALYZE TABLE `my_table`;',                                                    target: 'post' },
    { label: 'UPDATE stats', code: "UPDATE `stats` SET last_sync = NOW() WHERE table_name = 'my_table';",              target: 'post' },
  ],
  sqlite: [
    { label: 'DELETE all', code: 'DELETE FROM my_table;', target: 'pre'  },
    { label: 'VACUUM',     code: 'VACUUM;',              target: 'post' },
    { label: 'REINDEX',    code: 'REINDEX my_table;',     target: 'post' },
  ],
  oracle: [
    { label: 'TRUNCATE',       code: 'TRUNCATE TABLE my_schema.my_table;',                                            target: 'pre'  },
    { label: 'DISABLE constr', code: 'ALTER TABLE my_schema.my_table DISABLE ALL CONSTRAINTS;',                       target: 'pre'  },
    { label: 'ENABLE constr',  code: 'ALTER TABLE my_schema.my_table ENABLE ALL CONSTRAINTS;',                        target: 'post' },
    { label: 'GATHER STATS',   code: "EXEC DBMS_STATS.GATHER_TABLE_STATS('MY_SCHEMA', 'MY_TABLE');",                  target: 'post' },
  ],
  informix: [
    { label: 'DELETE all',   code: 'DELETE FROM my_table;',                        target: 'pre'  },
    { label: 'UPDATE STATS', code: 'UPDATE STATISTICS FOR TABLE my_table;',        target: 'post' },
  ],
}

// ─── Template SQL ─────────────────────────────────────────────────

interface SqlTemplate {
  label: string
  description: string
  build: (schema: string, table: string, cols: string[], keys: string[], dialect: string) => string
}

const SQL_TEMPLATES: SqlTemplate[] = [
  {
    label: 'Basic INSERT',
    description: 'INSERT INTO my_table (col1, col2) VALUES ({col1}, {col2})',
    build: (schema, table, cols, _keys, dialect) => {
      const t = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
      return `INSERT INTO ${t}\n  (${cols.map(c => `"${c}"`).join(', ')})\nVALUES\n  (${cols.map(c => `{${c}}`).join(', ')});`
    },
  },
  {
    label: 'INSERT ON CONFLICT (upsert)',
    description: 'INSERT ... ON CONFLICT (key) DO UPDATE SET ...',
    build: (schema, table, cols, keys, dialect) => {
      const t = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
      const updateCols = cols.filter(c => !keys.includes(c))
      return `INSERT INTO ${t}\n  (${cols.map(c => `"${c}"`).join(', ')})\nVALUES\n  (${cols.map(c => `{${c}}`).join(', ')})\nON CONFLICT (${keys.map(k => `"${k}"`).join(', ')}) DO UPDATE SET\n  ${updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(',\n  ')};`
    },
  },
  {
    label: 'UPDATE WHERE key',
    description: 'UPDATE my_table SET col = {val} WHERE key = {key}',
    build: (schema, table, cols, keys, dialect) => {
      const t = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
      const updateCols = cols.filter(c => !keys.includes(c))
      return `UPDATE ${t}\nSET\n  ${updateCols.map(c => `"${c}" = {${c}}`).join(',\n  ')}\nWHERE ${keys.map(k => `"${k}" = {${k}}`).join(' AND ')};`
    },
  },
  {
    label: 'DELETE WHERE key',
    description: 'DELETE FROM my_table WHERE key = {key}',
    build: (schema, table, _cols, keys, dialect) => {
      const t = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
      return `DELETE FROM ${t}\nWHERE ${keys.map(k => `"${k}" = {${k}}`).join(' AND ')};`
    },
  },
  {
    label: 'Soft delete',
    description: 'UPDATE my_table SET deleted_at = NOW() WHERE key = {key}',
    build: (schema, table, _cols, keys, dialect) => {
      const t = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
      return `UPDATE ${t}\nSET deleted_at = NOW()\nWHERE ${keys.map(k => `"${k}" = {${k}}`).join(' AND ')};`
    },
  },
  {
    label: 'Audit log insert',
    description: 'INSERT INTO audit_log (entity, action, payload, ts)',
    build: (schema, table, _cols, keys, dialect) => {
      const auditT = dialect === 'sqlite' ? '"audit_log"' : `"${schema}"."audit_log"`
      const keyVals = keys.map(k => `"${k}": "{${k}}"`).join(', ')
      return `INSERT INTO ${auditT}\n  (entity, action, payload, created_at)\nVALUES\n  ('${table}', 'upsert', '{ ${keyVals} }'::jsonb, NOW());`
    },
  },
  {
    label: 'CALL stored procedure',
    description: 'CALL my_proc({id}::uuid, {amount}::numeric)',
    build: (_schema, table, cols, _keys, _dialect) => {
      const args = cols.slice(0, 3).map(c => `{${c}}`).join(', ')
      return `CALL ${table}_proc(${args});`
    },
  },
  {
    label: 'MERGE (SQL standard)',
    description: 'MERGE INTO target USING source ON ...',
    build: (schema, table, cols, keys, dialect) => {
      const t = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
      const onClause = keys.map(k => `target."${k}" = source."${k}"`).join(' AND ')
      const updateCols = cols.filter(c => !keys.includes(c))
      return `MERGE INTO ${t} AS target\nUSING (VALUES (${cols.map(c => `{${c}}`).join(', ')})) AS source (${cols.map(c => `"${c}"`).join(', ')})\nON ${onClause}\nWHEN MATCHED THEN\n  UPDATE SET\n    ${updateCols.map(c => `target."${c}" = source."${c}"`).join(',\n    ')}\nWHEN NOT MATCHED THEN\n  INSERT (${cols.map(c => `"${c}"`).join(', ')})\n  VALUES (${cols.map(c => `{${c}}`).join(', ')});`
    },
  },
]

// ─── TemplateSelectBox ────────────────────────────────────────────

function TemplateSelectBox({ templates, onApply, color, fields, schema, table, keys, dialect }: {
  templates: SqlTemplate[]
  onApply: (sql: string) => void
  color: string
  fields: string[]
  schema: string
  table: string
  keys: string[]
  dialect: string
}) {
  const [open, setOpen]           = useState(false)
  const [selected, setSelected]   = useState<SqlTemplate | null>(null)
  const ref                       = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  const preview = useMemo(() => {
    if (!selected) return ''
    const cols = fields.length > 0 ? fields : ['col1', 'col2']
    const ks   = keys.length > 0 ? keys : ['id']
    return selected.build(schema, table || 'my_table', cols, ks, dialect)
  }, [selected, schema, table, fields, keys, dialect])

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <div style={{ display: 'flex', gap: 6 }}>
        <div onClick={() => setOpen(o => !o)}
          style={{ flex: 1, height: 30, background: '#1e2535', border: `1px solid ${open ? color : '#3a4a6a'}`, borderRadius: 4, padding: '0 10px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer', fontSize: 11 }}>
          <span style={{ color: selected ? '#c8d4f0' : '#8593b5' }}>{selected ? selected.label : 'Select a template…'}</span>
          <i className={`ti ti-chevron-${open ? 'up' : 'down'}`} style={{ fontSize: 11, color: '#8593b5' }} />
        </div>
        <button onClick={() => { if (selected) { onApply(preview); setOpen(false) } }}
          disabled={!selected}
          style={{ padding: '0 12px', height: 30, borderRadius: 4, border: `1px solid ${selected ? color + '60' : '#2a3349'}`, background: selected ? `color-mix(in srgb, ${color} 12%, #1a2030)` : '#1a2030', color: selected ? color : '#8593b5', fontSize: 11, cursor: selected ? 'pointer' : 'not-allowed', display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
          <i className="ti ti-download" style={{ fontSize: 11 }} /> Apply
        </button>
      </div>

      {open && (
        <div style={{ position: 'absolute', top: 34, left: 0, right: 0, background: '#161b27', border: `1px solid ${color}40`, borderRadius: 6, zIndex: 9999, overflow: 'hidden', boxShadow: '0 8px 24px rgba(0,0,0,.6)' }}>
          {templates.map(tpl => (
            <div key={tpl.label} onClick={() => { setSelected(tpl); setOpen(false) }}
              style={{ padding: '7px 12px', cursor: 'pointer', borderBottom: '0.5px solid #2a3349', background: selected?.label === tpl.label ? `color-mix(in srgb, ${color} 12%, #1a2030)` : 'transparent' }}
              onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${color} 8%, #1a2030)` }}
              onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = selected?.label === tpl.label ? `color-mix(in srgb, ${color} 12%, #1a2030)` : 'transparent' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: selected?.label === tpl.label ? color : '#c8d4f0' }}>{tpl.label}</div>
              <div style={{ fontSize: 9, color: '#8593b5', fontFamily: 'monospace', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{tpl.description}</div>
            </div>
          ))}
          {selected && (
            <div style={{ padding: '8px 12px', background: '#0f1117', borderTop: `1px solid ${color}30` }}>
              <div style={{ fontSize: 9, color, marginBottom: 4, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>Preview</div>
              <pre style={{ margin: 0, fontSize: 9, color: '#9a9aaa', fontFamily: 'monospace', lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{preview}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Preview SQL ──────────────────────────────────────────────────

function buildPreviewSql(props: Record<string, any>, dialect: string) {
  const p  = (k: string, def = '') => String(props[k] ?? def)
  const schema     = p('querySchema', 'public')
  const table      = p('table', '?')
  const mode       = p('mode', 'insert')
  const customMode = p('customQueryMode', 'none')
   let mapping: SinkColumnMapping[] = []
  try { if (props.sinkColumns) mapping = JSON.parse(props.sinkColumns).filter((c: SinkColumnMapping) => c.enabled) } catch {}

  const keyCols   = mapping.filter(c => c.isKey)
  const keyFields = keyCols.map(c => c.dbColumn)

  const buildWhereClause = (cols: SinkColumnMapping[], paramFn: (c: SinkColumnMapping) => string): string => {
    return cols.map((c, i) => {
      const op = c.keyOperator ?? '='
      const prefix = i === 0 ? '' : `${c.keyLogic ?? 'AND'} `
      if (op === 'IS NULL' || op === 'IS NOT NULL') return `${prefix}"${c.dbColumn}" ${op}`
      return `${prefix}"${c.dbColumn}" ${op} ${paramFn(c)}`
    }).join(' ')
  }
  const cols  = mapping.map(c => c.dbColumn)
  const tRef  = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
  const params: Array<{ pos: string; source: string; type: string }> = []
  let pidx = 0

  const paramFor = (col: SinkColumnMapping): string => {
    if (col.dbFunction?.trim()) return col.dbFunction.replace(/\{v\}/g, `$${++pidx}`)
    pidx++
    params.push({ pos: `$${pidx}`, source: col.sourceField || col.dbColumn, type: col.dbType })
    return `$${pidx}`
  }

  let mainSql = ''
  if (customMode !== 'none') {
    mainSql = p('customSql', '-- no custom query configured')
  } else if (mode === 'insert' || mode === 'truncate_insert') {
    mainSql = `INSERT INTO ${tRef}\n  (${cols.map(c => `"${c}"`).join(', ')})\nVALUES\n  (${mapping.map(c => paramFor(c)).join(', ')});`
  } else if (mode === 'upsert') {
    const updateCols = cols.filter(c => !keyFields.includes(c))
    mainSql = `INSERT INTO ${tRef}\n  (${cols.map(c => `"${c}"`).join(', ')})\nVALUES\n  (${mapping.map(c => paramFor(c)).join(', ')})\nON CONFLICT (${keyFields.map(k => `"${k}"`).join(', ')}) DO UPDATE SET\n  ${updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(',\n  ')};`
  } else if (mode === 'update') {
    const updateCols = mapping.filter(c => !c.isKey)
    mainSql = `UPDATE ${tRef}\nSET\n  ${updateCols.map(c => `"${c.dbColumn}" = ${paramFor(c)}`).join(',\n  ')}\nWHERE ${keyCols.length > 0 ? buildWhereClause(keyCols, paramFor) : '/* no key in the Mapping tab */'};`
  } else if (mode === 'delete') {
    mainSql = `DELETE FROM ${tRef}\nWHERE ${keyCols.length > 0 ? buildWhereClause(keyCols, paramFor) : '/* no key in the Mapping tab */'};`
  } else {
    mainSql = '-- MERGE: configure the condition in the Advanced SQL tab'
  }

  const fnList = mapping.filter(c => c.dbFunction?.trim()).map(c => c.dbFunction.split('(')[0]).filter((v, i, a) => a.indexOf(v) === i)

  return {
    preSql:  p('preSql', '').trim(),
    mainSql,
    params,
    postSql: p('postSql', '').trim(),
    summary: {
      'Table':        `${schema}.${table}`,
      'Mode':       customMode !== 'none' ? `Custom SQL (${customMode})` : mode.toUpperCase(),
      'Active columns': `${cols.length}`,
      'Batch size':     p('batchSize', '1000'),
      'Keys':         keyFields.join(', ') || '—',
      'DB functions':    fnList.length > 0 ? fnList.join(', ') : '—',
    },
  }
}

// ─── Componente principale ────────────────────────────────────────

export function SinkDbQueryPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)
  const pool       = useFlowStore(s => s.pool)

  const [preSnippet,  setPreSnippet]  = useState<string | undefined>(undefined)
  const [postSnippet, setPostSnippet] = useState<string | undefined>(undefined)
  const [showPreview, setShowPreview] = useState(false)
  const [previewKey,  setPreviewKey]  = useState(0)

  if (!node) return null

  const p     = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const resId = (node.data.config?.resourceId as string | undefined) ?? ''

  const selectedResource = useMemo(
    () => resId ? pool.lanes.flatMap(l => l.resources).find(r => r.id === resId) as any : undefined,
    [pool, resId]
  )

  const dialect    = (selectedResource?.config?.dialect ?? selectedResource?.config?.driver ?? p('dialect', 'postgresql')) as DbDialect
  const color      = DB_DIALECT_COLORS[dialect] ?? '#3ddc84'
  const dbLabel    = DB_DIALECT_LABELS[dialect] ?? 'DB'
  const queryMode  = p('customQueryMode', 'none')
  const schema     = p('querySchema', 'public')
  const table      = p('table', 'my_table')
  const keyFields  = p('keyFields', 'id').split(',').map(s => s.trim()).filter(Boolean)

  const snippets     = PRE_POST_SNIPPETS[dialect] ?? PRE_POST_SNIPPETS.postgresql
  const preSnippets  = snippets.filter(s => s.target === 'pre')
  const postSnippets = snippets.filter(s => s.target === 'post')

  const incomingFields = useMemo((): string[] => {
    try {
      const raw = node.data.props?.['incomingSchema'] ?? node.data.props?.['outputSchema']
      if (!raw) return []
      const parsed = JSON.parse(raw as string)
      return Array.isArray(parsed) ? parsed.map((f: any) => f.name).filter(Boolean) : []
    } catch { return [] }
  }, [node.data.props?.['incomingSchema'], node.data.props?.['outputSchema']])

  const mappingCols = useMemo((): string[] => {
    try {
      const raw = node.data.props?.['sinkColumns']
      if (!raw) return incomingFields
      return (JSON.parse(raw as string) as SinkColumnMapping[]).filter(c => c.enabled).map(c => c.dbColumn)
    } catch { return incomingFields }
  }, [node.data.props?.['sinkColumns'], incomingFields])

  const QUERY_MODES = [
    { value: 'custom_sql',  label: 'Parametrized SQL',  desc: 'One query per row — use {field}',             icon: 'ti-code'    },
    { value: 'stored_proc', label: 'Stored procedure',    desc: 'CALL proc({id}, {val}) for each row',              icon: 'ti-package' },
    { value: 'bulk_sql',    label: 'SQL bulk',            desc: 'A single execution — DDL, view refresh',          icon: 'ti-bolt'    },
    { value: 'none',        label: 'Disabled',        desc: 'Uses the write mode from the Configuration tab',  icon: 'ti-ban'     },
  ]

  const handleQueryModeChange = (value: string) => {
    updateProp(nodeId, 'customQueryMode', value)
    // Quando si attiva SQL custom, reset della modalità scrittura a 'insert'
    // per evitare che due logiche di scrittura confliggano
    if (value !== 'none') {
      updateProp(nodeId, 'mode', 'insert')
    }
  }

  const preview = useMemo(
    () => showPreview ? buildPreviewSql(node.data.props ?? {}, dialect) : null,
    [showPreview, node.data.props, dialect, previewKey]
  )

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '190px 1fr', gap: 14 }}>

      {/* ── Colonna sinistra: modalità ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        <SectionTitle label="Query mode" color={color} />

        {/* Warning SQL custom attivo */}
        {queryMode !== 'none' && (
          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '7px 10px', background: '#1a1a0a', borderRadius: 6, border: '1px solid #ffb34760' }}>
            <i className="ti ti-alert-triangle" style={{ fontSize: 13, color: '#ffb347', flexShrink: 0, marginTop: 1 }} />
            <span style={{ fontSize: 10, color: '#ffb347', lineHeight: 1.5 }}>
              Custom SQL active — the write mode in the Configuration tab is disabled and reset to INSERT.
              Disable this mode to return to automatic writing.
            </span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {QUERY_MODES.map(m => (
            <button key={m.value} onClick={() => handleQueryModeChange(m.value)}
              style={{ padding: '8px 10px', borderRadius: 5, cursor: 'pointer', textAlign: 'left', background: queryMode === m.value ? `color-mix(in srgb, ${color} 14%, #1a2030)` : '#1a2030', border: queryMode === m.value ? `1px solid ${color}` : '1px solid #2a3349', display: 'flex', flexDirection: 'column', gap: 2 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <i className={`ti ${m.icon}`} style={{ fontSize: 12, color: queryMode === m.value ? color : '#8593b5' }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: queryMode === m.value ? color : '#c8d4f0' }}>{m.label}</span>
              </div>
              <span style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{m.desc}</span>
            </button>
          ))}
        </div>

        {queryMode === 'stored_proc' && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
            <div style={{ fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>Execution</div>
            <CustomSelect style={iStyle} value={p('storedProcMode', 'per_row')} onChange={e => updateProp(nodeId, 'storedProcMode', e.target.value)}>
              <option value="per_row">For each row</option>
              <option value="once">Once (JSON array)</option>
            </CustomSelect>
          </div>
        )}

        {/* Toggle preview */}
        <button onClick={() => { setShowPreview(v => !v); setPreviewKey(k => k + 1) }}
          style={{ marginTop: 'auto', padding: '7px 10px', borderRadius: 5, cursor: 'pointer', background: showPreview ? `color-mix(in srgb, ${color} 10%, #1a2030)` : '#1a2030', border: showPreview ? `1px solid ${color}50` : '1px solid #2a3349', color: showPreview ? color : '#9a9aaa', fontSize: 11, display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-eye" style={{ fontSize: 12 }} />
          {showPreview ? 'Hide preview' : 'Preview SQL'}
        </button>
      </div>

      {/* ── Colonna destra: editor + pre/post + preview ── */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

        {/* Campi flusso cliccabili */}
        {incomingFields.length > 0 && queryMode !== 'none' && (
          <div>
            <div style={{ fontSize: 9, color: '#8593b5', marginBottom: 4 }}>Fields from the flow — click to insert at the cursor:</div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {incomingFields.map(f => (
                <button key={f}
                  onClick={() => updateProp(nodeId, 'customSql', p('customSql') + `{${f}}`)}
                  style={{ padding: '2px 7px', fontSize: 9, borderRadius: 10, background: '#1a2030', border: '0.5px solid #3a4a6a', fontFamily: 'monospace', color: '#9a9aaa', cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = color; (e.currentTarget as HTMLElement).style.borderColor = color }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#9a9aaa'; (e.currentTarget as HTMLElement).style.borderColor = '#3a4a6a' }}>
                  {'{' + f + '}'}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Template rapidi */}
        {queryMode !== 'none' && (
          <div>
            <div style={{ fontSize: 9, color: '#8593b5', marginBottom: 4 }}>Quick templates — apply at the cursor:</div>
            <TemplateSelectBox
              templates={SQL_TEMPLATES}
              onApply={sql => updateProp(nodeId, 'customSql', sql)}
              color={color}
              fields={mappingCols}
              schema={schema}
              table={table}
              keys={keyFields}
              dialect={dialect}
            />
          </div>
        )}

        {/* Editor SQL custom */}
        {queryMode !== 'none' && (
          <>
            <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>
              {queryMode === 'custom_sql'  && 'Use {field} for the row values — e.g. INSERT INTO my_table VALUES ({id}, {name})'}
              {queryMode === 'stored_proc' && 'E.g. PostgreSQL: CALL my_proc({id}::uuid, {amount}::numeric)'}
              {queryMode === 'bulk_sql'    && 'Executed once — no row parameter.'}
            </div>
            <ScriptEditor value={p('customSql', '')} onChange={v => updateProp(nodeId, 'customSql', v)} language="sql" height={130} />
          </>
        )}

        <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 10 }} />

        {/* Pre-scrittura */}
        <SectionTitle label="Pre-write SQL" color={color} />
        <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>
          Executed <strong style={{ color: '#c8d4f0' }}>before</strong> — LOCK, TRUNCATE, disable triggers.
        </div>
        {preSnippets.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {preSnippets.map(s => (
              <button key={s.label} onClick={() => setPreSnippet(s.code)}
                style={{ padding: '2px 8px', fontSize: 9, borderRadius: 4, cursor: 'pointer', background: '#1a3a6a', color: '#4a9eff', border: '1px solid #2a5a9a', display: 'flex', alignItems: 'center', gap: 3 }}>
                <i className="ti ti-player-skip-back" style={{ fontSize: 9 }} /> {s.label}
              </button>
            ))}
          </div>
        )}
        <ScriptEditor value={p('preSql', '')} onChange={v => updateProp(nodeId, 'preSql', v)} language="sql" height={90} snippetToInsert={preSnippet} onSnippetInserted={() => setPreSnippet(undefined)} />

        {/* Post-scrittura */}
        <SectionTitle label="Post-write SQL" color={color} />
        <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>
          Executed <strong style={{ color: '#c8d4f0' }}>after</strong> — ANALYZE, NOTIFY, view refresh.
        </div>
        {postSnippets.length > 0 && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {postSnippets.map(s => (
              <button key={s.label} onClick={() => setPostSnippet(s.code)}
                style={{ padding: '2px 8px', fontSize: 9, borderRadius: 4, cursor: 'pointer', background: '#0d3d20', color: '#3ddc84', border: '1px solid #1d6d40', display: 'flex', alignItems: 'center', gap: 3 }}>
                <i className="ti ti-player-skip-forward" style={{ fontSize: 9 }} /> {s.label}
              </button>
            ))}
          </div>
        )}
        <ScriptEditor value={p('postSql', '')} onChange={v => updateProp(nodeId, 'postSql', v)} language="sql" height={90} snippetToInsert={postSnippet} onSnippetInserted={() => setPostSnippet(undefined)} />

        <div style={{ padding: '6px 10px', fontSize: 10, color: '#8593b5', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', gap: 5 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
          Pre and post run in the same connection and transaction. If one fails → ROLLBACK.
        </div>

        {/* Preview SQL */}
        {showPreview && preview && (
          <>
            <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 10 }} />
            <SectionTitle label="Generated SQL preview" color={color} />

            {preview.preSql && (
              <div>
                <div style={{ fontSize: 9, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 4 }}>Pre-write</div>
                <pre style={{ margin: 0, background: '#0a0e17', border: '1px solid #2a5a9a', borderRadius: 5, padding: '8px 12px', fontFamily: 'monospace', fontSize: 10, color: '#c8d4f0', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{preview.preSql}</pre>
              </div>
            )}

            <div>
              <div style={{ fontSize: 9, color, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 4 }}>Main query</div>
              <pre style={{ margin: 0, background: '#0a0e17', border: `1px solid ${color}60`, borderRadius: 5, padding: '8px 12px', fontFamily: 'monospace', fontSize: 10, color: '#c8d4f0', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{preview.mainSql}</pre>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {preview.params.length > 0 && (
                <div>
                  <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 4 }}>Parameters</div>
                  <div style={{ background: '#0f1117', border: '0.5px solid #2a3349', borderRadius: 5, overflow: 'hidden' }}>
                    {preview.params.map((param, i) => (
                      <div key={i} style={{ display: 'grid', gridTemplateColumns: '32px 1fr 60px', gap: 6, padding: '4px 8px', borderBottom: i < preview.params.length - 1 ? '0.5px solid #1a2030' : 'none', background: i % 2 === 0 ? '#1a2030' : 'transparent' }}>
                        <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#ffb347' }}>{param.pos}</span>
                        <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#9a9aaa' }}>{param.source}</span>
                        <span style={{ fontSize: 9, color: '#8593b5' }}>{param.type}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              <div>
                <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 4 }}>Summary</div>
                <div style={{ background: '#0f1117', border: '0.5px solid #2a3349', borderRadius: 5, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {Object.entries(preview.summary).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 9 }}>
                      <span style={{ color: '#8593b5' }}>{k}</span>
                      <span style={{ fontFamily: 'monospace', color: '#9a9aaa' }}>{v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {preview.postSql && (
              <div>
                <div style={{ fontSize: 9, color: '#3ddc84', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 4 }}>Post-write</div>
                <pre style={{ margin: 0, background: '#0a0e17', border: '1px solid #1d6d40', borderRadius: 5, padding: '8px 12px', fontFamily: 'monospace', fontSize: 10, color: '#c8d4f0', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{preview.postSql}</pre>
              </div>
            )}

            <div style={{ fontSize: 9, color: '#8593b5', padding: '5px 8px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', gap: 5 }}>
              <i className="ti ti-info-circle" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
              The SQL is built from the current configuration. Real values are substituted at runtime.
            </div>
          </>
        )}
      </div>
    </div>
  )
}