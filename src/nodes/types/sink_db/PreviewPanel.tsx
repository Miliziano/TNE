/**
 * src/nodes/types/sink_db/PreviewPanel.tsx
 *
 * Modifiche rispetto alla versione precedente:
 *
 * - buildPreviewSql: quando passthroughMasterDetail è 'true' e la
 *   modalità è insert/upsert, la query principale mostra:
 *   · La clausola RETURNING per PostgreSQL
 *   · Un commento -- → LAST_INSERT_ID() per MySQL
 *   · Un commento -- → last_insert_rowid() per SQLite
 * - Nella query pass-through le sole colonne abilitate nel mapping
 *   vengono mostrate (le colonne hash key sono evidenziate).
 * - Il riepilogo aggiunge le voci "Pass-through", "Hash key" e
 *   "Chiave generata" quando la modalità è attiva.
 * - La sezione "Query arricchimento" mostra come il campo generato
 *   verrà aggiunto al record in uscita (solo in modalità pass-through).
 */

import { useState, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { DB_DIALECT_COLORS, DB_DIALECT_LABELS, type DbDialect } from '../../resourceDefaults'
import type { SinkColumnMapping, GeneratedKeyConfig } from './MappingPanel'

// Colore coerente con Panel.tsx e MappingPanel.tsx
const PT_COLOR = '#a855f7'

// ─── buildPreviewSql ──────────────────────────────────────────────

interface PreviewParam { pos: string; source: string; type: string }

interface PreviewResult {
  preSql:        string
  mainSql:       string
  passthroughSql: string | null  // SQL pass-through separato, null se non attivo
  params:        PreviewParam[]
  postSql:       string
  summary:       Record<string, string>
}

function buildPreviewSql(props: Record<string, any>, dialect: string): PreviewResult {
  const p  = (k: string, def = '') => String(props[k] ?? def)
  const schema     = p('querySchema', 'public')
  const table      = p('table', '?')
  const mode       = p('mode', 'insert')
  const customMode = p('customQueryMode', 'none')

  const passthroughActive = p('passthroughMasterDetail', 'false') === 'true'

  let mapping: SinkColumnMapping[] = []
  try {
    if (props.sinkColumns)
      mapping = JSON.parse(props.sinkColumns).filter((c: SinkColumnMapping) => c.enabled)
  } catch {}

  let generatedKeyCfg: GeneratedKeyConfig = {
    outputFieldName: `__${table}_id`,
    sourceDbColumn:  'id',
    dbFunction:      '',
    dbType:          'int8',
  }
  try {
    if (props.generatedKeyConfig) generatedKeyCfg = JSON.parse(props.generatedKeyConfig)
  } catch {}

  const keyCols   = mapping.filter(c => c.isKey)
  const keyFields = keyCols.map(c => c.dbColumn)
  const hashCols  = mapping.filter(c => c.isHashKey)

  const buildWhereClause = (cols: SinkColumnMapping[], paramFn: (c: SinkColumnMapping) => string): string => {
    return cols.map((c, i) => {
      const op     = c.keyOperator ?? '='
      const prefix = i === 0 ? '' : `${c.keyLogic ?? 'AND'} `
      if (op === 'IS NULL' || op === 'IS NOT NULL') return `${prefix}"${c.dbColumn}" ${op}`
      return `${prefix}"${c.dbColumn}" ${op} ${paramFn(c)}`
    }).join(' ')
  }

  const cols  = mapping.map(c => c.dbColumn)
  const tRef  = dialect === 'sqlite' ? `"${table}"` : `"${schema}"."${table}"`
  const params: PreviewParam[] = []
  let pidx = 0

  const paramFor = (col: SinkColumnMapping): string => {
    if (col.dbFunction?.trim()) {
      if (col.dbFunction.includes('{v}')) {
        const expr = col.dbFunction.replace(/\{v\}/g, `$${++pidx}`)
        params.push({ pos: `$${pidx}`, source: col.sourceField || col.dbColumn, type: col.dbType ?? '' })
        return expr
      }
      return col.dbFunction.trim()
    }
    pidx++
    params.push({ pos: `$${pidx}`, source: col.sourceField || col.dbColumn, type: col.dbType ?? '' })
    return `$${pidx}`
  }

  let mainSql        = ''
  let passthroughSql: string | null = null

  // ── Modalità pass-through ─────────────────────────────────────
  if (passthroughActive && customMode === 'none') {
    const hashKeyLabels = hashCols.map(c => `"${c.dbColumn}"`).join(', ')
    const retCol = generatedKeyCfg.sourceDbColumn || 'id'

    if (cols.length === 0) {
      mainSql = `-- Configura le colonne nel tab Mapping`
    } else {
      const colList  = mapping.map(c => `"${c.dbColumn}"`).join(', ')
      const valList  = mapping.map(c => paramFor(c)).join(', ')

      if (mode === 'upsert') {
        const updateCols = mapping.filter(c => !c.isKey)
        const conflictOn = keyFields.length > 0
          ? keyFields.map(k => `"${k}"`).join(', ')
          : `-- configura chiavi WHERE`

        // Suffisso RETURNING per dialetto
        const returning = dialect === 'postgresql'
          ? `\nRETURNING "${retCol}"`
          : dialect === 'mysql'
          ? `;\n-- → SELECT LAST_INSERT_ID()  -- chiave generata`
          : dialect === 'sqlite'
          ? `;\n-- → SELECT last_insert_rowid()  -- chiave generata`
          : `\nRETURNING "${retCol}"`

        mainSql = `INSERT INTO ${tRef}\n  (${colList})\nVALUES\n  (${valList})\nON CONFLICT (${conflictOn}) DO UPDATE SET\n  ${updateCols.map(c => `"${c.dbColumn}" = EXCLUDED."${c.dbColumn}"`).join(',\n  ')}${returning};`
      } else {
        // insert / truncate_insert
        const returning = dialect === 'postgresql'
          ? `\nRETURNING "${retCol}"`
          : dialect === 'mysql'
          ? `;\n-- → SELECT LAST_INSERT_ID()  -- chiave generata`
          : dialect === 'sqlite'
          ? `;\n-- → SELECT last_insert_rowid()  -- chiave generata`
          : `\nRETURNING "${retCol}"`

        mainSql = `INSERT INTO ${tRef}\n  (${colList})\nVALUES\n  (${valList})${returning};`
      }

      // Sezione separata: come viene arricchito il record in uscita
      const hashComment = hashCols.length > 0
        ? `-- Hash key: ${hashKeyLabels}\n-- Hash calcolato sui valori correnti → identity map\n\n`
        : `-- ⚠ Nessuna colonna Hash configurata — deduplicazione disabilitata\n\n`

      passthroughSql =
        `${hashComment}` +
        `-- Dopo l'INSERT, il record viene arricchito:\n` +
        `-- { ...riga_originale, "${generatedKeyCfg.outputFieldName}": <valore di "${retCol}"> }\n\n` +
        `-- Il record arricchito viene passato al nodo successivo.`
    }

    const fnList = mapping
      .filter(c => c.dbFunction?.trim())
      .map(c => c.dbFunction!.split('(')[0].trim())
      .filter((v, i, a) => a.indexOf(v) === i)

    return {
      preSql:  p('preSql', '').trim(),
      mainSql,
      passthroughSql,
      params,
      postSql: p('postSql', '').trim(),
      summary: {
        'Tabella':          dialect === 'sqlite' ? table : `${schema}.${table}`,
        'Modalità':         `${mode.toUpperCase()} (pass-through)`,
        'Colonne master':   cols.length > 0 ? String(cols.length) : '—',
        'Hash key':         hashCols.length > 0 ? hashCols.map(c => c.dbColumn).join(', ') : '— non configurate',
        'Chiave generata':  `"${generatedKeyCfg.outputFieldName}" ← ${retCol}`,
        'Batch size':       '1 (per riga — identity map)',
        'Funzioni DB':      fnList.length > 0 ? fnList.join(', ') : '—',
        ...(generatedKeyCfg.dbFunction ? { 'Sequenza DB': generatedKeyCfg.dbFunction } : {}),
      },
    }
  }

  // ── Modalità classica (invariata) ────────────────────────────
  if (customMode !== 'none') {
    mainSql = p('customSql', '').trim() || '-- nessuna query custom configurata'
  } else if (mode === 'insert' || mode === 'truncate_insert') {
    if (cols.length === 0) {
      mainSql = `INSERT INTO ${tRef}\n  (/* configura le colonne nel tab Mapping */)\nVALUES\n  (...);`
    } else {
      mainSql = `INSERT INTO ${tRef}\n  (${cols.map(c => `"${c}"`).join(', ')})\nVALUES\n  (${mapping.map(c => paramFor(c)).join(', ')});`
    }
  } else if (mode === 'upsert') {
    const updateCols = cols.filter(c => !keyFields.includes(c))
    mainSql = cols.length === 0
      ? `INSERT INTO ${tRef} (...)\nVALUES (...)\nON CONFLICT (${keyFields.map(k => `"${k}"`).join(', ')}) DO UPDATE SET ...;`
      : `INSERT INTO ${tRef}\n  (${cols.map(c => `"${c}"`).join(', ')})\nVALUES\n  (${mapping.map(c => paramFor(c)).join(', ')})\nON CONFLICT (${keyFields.map(k => `"${k}"`).join(', ')}) DO UPDATE SET\n  ${updateCols.map(c => `"${c}" = EXCLUDED."${c}"`).join(',\n  ')};`
  } else if (mode === 'update') {
    const updateMappingCols = mapping.filter(c => !c.isKey)
    mainSql = cols.length === 0
      ? `UPDATE ${tRef}\nSET ...\nWHERE ${keyCols.length > 0 ? '/* configura chiavi nel tab Mapping */' : '...'};`
      : `UPDATE ${tRef}\nSET\n  ${updateMappingCols.map(c => `"${c.dbColumn}" = ${paramFor(c)}`).join(',\n  ')}\nWHERE ${keyCols.length > 0 ? buildWhereClause(keyCols, paramFor) : '/* nessuna chiave configurata nel tab Mapping */'};`
  } else if (mode === 'delete') {
    mainSql = `DELETE FROM ${tRef}\nWHERE ${keyCols.length > 0 ? buildWhereClause(keyCols, paramFor) : '/* nessuna chiave configurata nel tab Mapping */'};`
  } else if (mode === 'merge') {
    mainSql = `-- MERGE: la condizione è configurata nel tab Query (SQL avanzato)`
  } else {
    mainSql = `-- modalità "${mode}" non riconosciuta`
  }

  const fnList = mapping
    .filter(c => c.dbFunction?.trim())
    .map(c => c.dbFunction!.split('(')[0].trim())
    .filter((v, i, a) => a.indexOf(v) === i)

  return {
    preSql:        p('preSql', '').trim(),
    mainSql,
    passthroughSql: null,
    params,
    postSql:       p('postSql', '').trim(),
    summary: {
      'Tabella':        dialect === 'sqlite' ? table : `${schema}.${table}`,
      'Modalità':       customMode !== 'none' ? `SQL custom (${customMode})` : mode.toUpperCase(),
      'Colonne attive': cols.length > 0 ? String(cols.length) : '— configura il mapping',
      'Batch size':     p('batchSize', '1000'),
      'Chiavi':         keyCols.length > 0
                          ? keyCols.map((c, i) => `${i > 0 ? `${c.keyLogic ?? 'AND'} ` : ''}${c.dbColumn} ${c.keyOperator ?? '='}`).join(' ')
                          : '—',
      'Funzioni DB':    fnList.length > 0 ? fnList.join(', ') : '—',
    },
  }
}

// ─── CodeBlock ────────────────────────────────────────────────────

function CodeBlock({ sql, accent }: { sql: string; accent?: string }) {
  return (
    <pre style={{
      margin: 0,
      background: '#0a0e17',
      border: `1px solid ${accent ?? '#2a3349'}`,
      borderRadius: 5,
      padding: '8px 12px',
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 10,
      color: '#c8d4f0',
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      {sql || <span style={{ color: '#2a3349', fontStyle: 'italic' }}>-- nessun contenuto</span>}
    </pre>
  )
}

// ─── Componente principale ────────────────────────────────────────

export function SinkDbPreviewPanel({ nodeId }: { nodeId: string }) {
  const node = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const pool = useFlowStore(s => s.pool)
  const [key, setKey] = useState(0)

  if (!node) return null

  const p     = (k: string, def = '') => String(node.data.props?.[k] ?? def)
  const resId = (node.data.config?.resourceId as string | undefined) ?? ''

  const selectedResource = useMemo(
    () => resId ? pool.lanes.flatMap(l => l.resources).find(r => r.id === resId) as any : undefined,
    [pool, resId]
  )

  const dialect = (selectedResource?.config?.dialect ?? selectedResource?.config?.driver ?? p('dialect', 'postgresql')) as DbDialect
  const color   = DB_DIALECT_COLORS[dialect] ?? '#3ddc84'
  const dbLabel = DB_DIALECT_LABELS[dialect] ?? 'DB'

  const passthroughActive = p('passthroughMasterDetail', 'false') === 'true'

  const preview = useMemo(
    () => buildPreviewSql(node.data.props ?? {}, dialect),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [node.data.props, dialect, key]
  )

  const secLabel = (label: string, accent: string) => (
    <div style={{ fontSize: 9, color: accent, textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600, marginBottom: 4 }}>
      {label}
    </div>
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Header ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button onClick={() => setKey(k => k + 1)}
          style={{ padding: '5px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${color} 10%, #1a2030)`, color, border: `1px solid ${color}50`, display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-refresh" style={{ fontSize: 12 }} /> Rigenera
        </button>
        <span style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>
          Anteprima dell'SQL generato dalla configurazione attuale — sola lettura
        </span>
        <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 8 }}>
          {passthroughActive && (
            <span style={{ fontSize: 9, color: PT_COLOR, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: `${PT_COLOR}15`, borderRadius: 10, border: `1px solid ${PT_COLOR}40` }}>
              <i className="ti ti-bolt" style={{ fontSize: 9 }} />
              pass-through
            </span>
          )}
          <span style={{ fontSize: 9, color, fontFamily: 'monospace', fontWeight: 600 }}>{dbLabel}</span>
        </div>
      </div>

      {/* ── Banner pass-through ── */}
      {passthroughActive && (
        <div style={{ padding: '8px 12px', background: `${PT_COLOR}0d`, borderRadius: 6, border: `1px solid ${PT_COLOR}35`, fontSize: 10, color: PT_COLOR, lineHeight: 1.5, display: 'flex', gap: 8 }}>
          <i className="ti ti-bolt" style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }} />
          <span>
            Modalità <strong>pass-through master-detail</strong> attiva.
            La query master qui sotto viene eseguita <strong>una sola volta per ogni hash univoco</strong>.
            I record già visti vengono recuperati dalla identity map senza toccare il DB.
            Il campo chiave generato viene iniettato nel record prima di passare al nodo successivo.
          </span>
        </div>
      )}

      {/* ── Pre-scrittura ── */}
      {preview.preSql ? (
        <div>
          {secLabel('Pre-scrittura', '#4a9eff')}
          <CodeBlock sql={preview.preSql} accent="#2a5a9a" />
        </div>
      ) : (
        <div>
          {secLabel('Pre-scrittura', '#2a3349')}
          <div style={{ fontSize: 10, color: '#2a3349', fontStyle: 'italic', padding: '5px 8px', background: '#0f1117', borderRadius: 4 }}>
            — nessuna query pre-scrittura configurata
          </div>
        </div>
      )}

      {/* ── Query principale (INSERT master) ── */}
      <div>
        {secLabel(
          passthroughActive ? 'Insert master (eseguito per hash univoci)' : 'Query principale',
          passthroughActive ? PT_COLOR : color
        )}
        <CodeBlock sql={preview.mainSql} accent={passthroughActive ? `${PT_COLOR}60` : `${color}60`} />
      </div>

      {/* ── Sezione arricchimento — solo pass-through ── */}
      {passthroughActive && preview.passthroughSql && (
        <div>
          {secLabel('Arricchimento record in uscita', PT_COLOR)}
          <CodeBlock sql={preview.passthroughSql} accent={`${PT_COLOR}35`} />
        </div>
      )}

      {/* ── Parametri + Riepilogo ── */}
      <div style={{ display: 'grid', gridTemplateColumns: preview.params.length > 0 ? '1fr 1fr' : '1fr', gap: 10 }}>

        {preview.params.length > 0 && (
          <div>
            {secLabel('Parametri bind', '#4a5a7a')}
            <div style={{ background: '#0f1117', border: '0.5px solid #2a3349', borderRadius: 5, overflow: 'hidden' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '32px 1fr 70px', gap: 6, padding: '4px 8px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
                {['#', 'Sorgente', 'Tipo DB'].map(h => (
                  <div key={h} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{h}</div>
                ))}
              </div>
              {preview.params.map((param, i) => (
                <div key={i} style={{ display: 'grid', gridTemplateColumns: '32px 1fr 70px', gap: 6, padding: '4px 8px', borderBottom: i < preview.params.length - 1 ? '0.5px solid #1a2030' : 'none', background: i % 2 === 0 ? '#161b27' : 'transparent' }}>
                  <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#ffb347' }}>{param.pos}</span>
                  <span style={{ fontFamily: 'monospace', fontSize: 9, color: '#9a9aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{param.source}</span>
                  <span style={{ fontSize: 9, color: '#4a5a7a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{param.type}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        <div>
          {secLabel('Riepilogo', '#4a5a7a')}
          <div style={{ background: '#0f1117', border: '0.5px solid #2a3349', borderRadius: 5, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
            {Object.entries(preview.summary).map(([k, v]) => {
              const isPassthroughRow = passthroughActive && (
                k === 'Hash key' || k === 'Chiave generata' || k === 'Sequenza DB'
              )
              return (
                <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 10 }}>
                  <span style={{ color: isPassthroughRow ? PT_COLOR : '#4a5a7a', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {isPassthroughRow && <i className="ti ti-bolt" style={{ fontSize: 9 }} />}
                    {k}
                  </span>
                  <span style={{ fontFamily: 'monospace', color: isPassthroughRow ? PT_COLOR : '#9a9aaa', textAlign: 'right', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {v}
                  </span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ── Post-scrittura ── */}
      {preview.postSql ? (
        <div>
          {secLabel('Post-scrittura', '#3ddc84')}
          <CodeBlock sql={preview.postSql} accent="#1d6d40" />
        </div>
      ) : (
        <div>
          {secLabel('Post-scrittura', '#2a3349')}
          <div style={{ fontSize: 10, color: '#2a3349', fontStyle: 'italic', padding: '5px 8px', background: '#0f1117', borderRadius: 4 }}>
            — nessuna query post-scrittura configurata
          </div>
        </div>
      )}

      {/* ── Nota ── */}
      <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', gap: 5 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
        {passthroughActive
          ? `L'SQL è costruito dalla configurazione corrente. In modalità pass-through, RETURNING / LAST_INSERT_ID / last_insert_rowid vengono usati automaticamente in base al dialetto (${dialect}).`
          : 'L\'SQL è costruito dalla configurazione corrente. I valori reali vengono sostituiti a runtime. Le funzioni DB (NOW, ROUND…) vengono emesse come SQL letterale, non come parametri bind.'
        }
      </div>
    </div>
  )
}