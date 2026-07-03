import { useCallback, useMemo, useState } from 'react'
import { invoke } from '@tauri-apps/api/core'
import { useFlowStore } from '../../../store/flowStore'
import { propagateSchema } from '../../../utils/schemaUtils'
import type { SchemaField } from '../../../utils/schemaUtils'
import { DB_DIALECT_LABELS, DB_DIALECT_COLORS, type DbDialect } from '../../../nodes/resourceDefaults'
import { CustomSelect } from '../../../components/CustomSelect'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}

// ─── Tipi disponibili ─────────────────────────────────────────────

import { FIELD_TYPES, TYPE_META } from '../../../types/fieldTypes'
import type { FieldType } from '../../../types/fieldTypes'

const TYPE_HINTS: Record<string, string> = {
  object: 'Usato anche per JSON / JSONB',
}

interface OutputField {
  id:        string
  name:      string
  type:      string
  dbType?:   string
  nullable?: boolean
}

// ─── Mappa db_type nativo → tipo logico ──────────────────────────
// Copre PostgreSQL, MySQL, SQLite. Case-insensitive sul prefisso.
function dbTypeToLogical(dbType: string): string {
  const t = dbType.toLowerCase().trim()

  // Integer
  if (['int2','int4','int8','int','integer','tinyint','smallint',
       'mediumint','bigint','serial','bigserial','smallserial',
       'number'].some((k) => t === k || t.startsWith(k + '(')))
    return 'integer'

  // Decimal
  if (['float4','float8','float','double','real','numeric','decimal',
       'money','double precision'].some((k) => t === k || t.startsWith(k + '(')))
    return 'decimal'

  // Boolean
  if (['bool','boolean','bit'].some((k) => t === k || t.startsWith(k + '(')))
    return 'boolean'

  // Date/time → string (ISO) per semplicità di gestione downstream
  if (['date','time','timestamp','timestamptz','datetime',
       'interval','year'].some((k) => t === k || t.startsWith(k)))
    return 'date'

  // JSON / JSONB / object
  if (['json','jsonb','hstore','xml'].some((k) => t === k || t.startsWith(k)))
    return 'object'

  // UUID → string
  if (t === 'uuid') return 'string'

  // Array PostgreSQL
  if (t.endsWith('[]') || t.startsWith('_')) return 'object'

  // Tutto il resto: varchar, text, char, enum, bytea ecc → string
  return 'string'
}

// ─── Tipi DbColumnInfo dal backend Rust ──────────────────────────
interface DbColumnInfo {
  name:     string
  db_type:  string
  nullable: boolean
  position: number
}

export function DbMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  const resId = (node?.data.config?.resourceId as string | undefined)

  const selectedResource = useMemo(
    () => resId
      ? pool.lanes.flatMap((l) => l.resources).find((r) => r.id === resId)
      : undefined,
    [pool, resId]
  )

  const [inferring, setInferring]   = useState(false)
  const [inferError, setInferError] = useState<string | null>(null)

  if (!node) return null

  const p       = (key: string, def = '') => node.data.props[key] ?? def
  const dialect = p('dialect', 'postgresql') as DbDialect
  const color   = DB_DIALECT_COLORS[dialect] ?? '#4a9eff'
  const label   = DB_DIALECT_LABELS[dialect] ?? 'DB'

  // ── Campi dichiarati ─────────────────────────────────────────
  const fields: OutputField[] = useMemo(() => {
    try { return JSON.parse(p('outputFields')) } catch { return [] }
  }, [p('outputFields')])

  // ── Salva e propaga ───────────────────────────────────────────
  const saveAndPropagate = useCallback((newFields: OutputField[]) => {
    updateProp(nodeId, 'outputFields', JSON.stringify(newFields))
    const schema: SchemaField[] = newFields.map((f) => ({
      id:           f.id,
      name:         f.name,
      type:         f.type,
      physicalName: f.name,
    }))
    updateProp(nodeId, 'outputSchema', JSON.stringify(schema))
    propagateSchema(nodeId, schema, useFlowStore.getState())
  }, [nodeId, updateProp])

  const addField = useCallback(() => {
    const n = fields.length + 1
    saveAndPropagate([...fields, { id: `df_${Date.now()}`, name: `campo_${n}`, type: 'string', dbType: '', nullable: true }])
  }, [fields, saveAndPropagate])

  const updateField = useCallback((id: string, key: string, value: unknown) => {
    saveAndPropagate(fields.map((f) => f.id === id ? { ...f, [key]: value } : f))
  }, [fields, saveAndPropagate])

  const deleteField = useCallback((id: string) => {
    saveAndPropagate(fields.filter((f) => f.id !== id))
  }, [fields, saveAndPropagate])

  const moveField = useCallback((idx: number, dir: 'up' | 'down') => {
    const arr     = [...fields]
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= arr.length) return
    ;[arr[idx], arr[swapIdx]] = [arr[swapIdx], arr[idx]]
    saveAndPropagate(arr)
  }, [fields, saveAndPropagate])

  // ── Rileva schema dalla query o dalla tabella ─────────────────
  const handleInferSchema = useCallback(async () => {
    setInferring(true)
    setInferError(null)

    try {
      // Recupera la risorsa DB selezionata (già reattiva)
      const resCfg = (selectedResource?.config ?? {}) as Record<string, string>

      // Costruisce i parametri di connessione dalla risorsa
      const connection = {
        dialect:        resCfg.dialect     ?? dialect,
        host:           resCfg.host        ?? 'localhost',
        port:           parseInt(resCfg.port ?? '5432', 10),
        database:       resCfg.database    ?? '',
        user:           resCfg.user        ?? '',
        password:       resCfg.password    ?? '',
        schema:         resCfg.schema,
        serviceName:    resCfg.serviceName,
        dbServerName:   resCfg.dbServerName,
        charset:        resCfg.charset,
        ssl:            resCfg.ssl         ?? 'false',
        connectTimeout: parseInt(resCfg.connectTimeout ?? '10', 10),
      }

      // Usa la query personalizzata se presente, altrimenti SELECT * FROM tabella
      const customQuery = p('query').trim()
      const schema      = p('querySchema', resCfg.schema ?? 'public')
      const table       = p('table')

      let query: string
      if (customQuery) {
        query = customQuery.replace(/;\s*$/, '')
      } else if (table) {
        query = dialect === 'sqlite'
          ? `SELECT * FROM ${table}`
          : `SELECT * FROM ${schema}.${table}`
      } else {
        setInferError('Configura una tabella o una query personalizzata prima di rilevare lo schema.')
        setInferring(false)
        return
      }

      // Chiama il backend Rust
      const columns = await invoke<DbColumnInfo[]>('db_infer_schema', {
        request: { connection, query },
      })

      if (columns.length === 0) {
        setInferError('Nessuna colonna rilevata — verifica la query e la connessione.')
        setInferring(false)
        return
      }

      // Converte le colonne in OutputField
      const newFields: OutputField[] = columns.map((col) => ({
        id:       `df_${Date.now()}_${col.position}`,
        name:     col.name,
        type:     dbTypeToLogical(col.db_type),
        dbType:   col.db_type,
        nullable: col.nullable,
      }))

      saveAndPropagate(newFields)

    } catch (err) {
      setInferError(err instanceof Error ? err.message : String(err))
    } finally {
      setInferring(false)
    }
  }, [node, selectedResource, dialect, p, saveAndPropagate])

  const jsonbFields = fields.filter((f) => f.type === 'object' || f.dbType?.toLowerCase().includes('json'))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ── Info dialetto + query attiva ─────────────────────── */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${color} 10%, #161b27)`, borderRadius: 6, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`, display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0 }} />
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 11, color, fontWeight: 600 }}>
            Schema output — {label}
          </div>
          <div style={{ fontSize: 10, color: '#4a5a7a' }}>
            {p('query')
              ? <><span style={{ color: '#a78bfa' }}>Query personalizzata</span> · {p('query').slice(0, 60)}{p('query').length > 60 ? '…' : ''}</>
              : <>Tabella: <code style={{ color: '#c8d4f0' }}>{p('querySchema', 'public')}.{p('table', '—')}</code></>
            }
          </div>
        </div>
      </div>

      {/* ── Bottone Rileva schema ─────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={handleInferSchema}
          disabled={inferring}
          style={{
            flex: 1, padding: '7px 14px', fontSize: 11, borderRadius: 6,
            cursor: inferring ? 'wait' : 'pointer', fontWeight: 600,
            background: inferring
              ? '#1a2030'
              : `color-mix(in srgb, ${color} 20%, #161b27)`,
            color:  inferring ? '#4a5a7a' : color,
            border: `1px solid color-mix(in srgb, ${color} ${inferring ? '20%' : '50%'}, transparent)`,
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            transition: 'all .15s',
          }}
          onMouseEnter={(e) => { if (!inferring) (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${color} 30%, #161b27)` }}
          onMouseLeave={(e) => { if (!inferring) (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${color} 20%, #161b27)` }}>
          {inferring
            ? <><i className="ti ti-loader" style={{ fontSize: 13, animation: 'spin 1s linear infinite' }} /> Rilevamento in corso…</>
            : <><i className="ti ti-database-search" style={{ fontSize: 13 }} /> Rileva schema dalla query</>
          }
        </button>

        {fields.length > 0 && (
          <button
            onClick={() => saveAndPropagate([])}
            title="Azzera tutti i campi"
            style={{ padding: '7px 10px', borderRadius: 6, cursor: 'pointer', background: 'none', border: '1px solid #2a3349', color: '#4a5a7a', fontSize: 11 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57'; (e.currentTarget as HTMLElement).style.borderColor = '#ff5f57' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a'; (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
            <i className="ti ti-trash" style={{ fontSize: 12 }} />
          </button>
        )}
      </div>

      {/* ── Errore rilevamento ───────────────────────────────── */}
      {inferError && (
        <div style={{ padding: '8px 12px', background: '#2a0a0a', border: '1px solid #ff5f5740', borderRadius: 6, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <i className="ti ti-alert-circle" style={{ fontSize: 13, color: '#ff5f57', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 11, color: '#ff5f57', flex: 1 }}>{inferError}</div>
          <button onClick={() => setInferError(null)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#ff5f57', padding: 0 }}>
            <i className="ti ti-x" style={{ fontSize: 11 }} />
          </button>
        </div>
      )}

      {/* ── Schema colonne ───────────────────────────────────── */}
      <div style={{ background: '#161b27', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>
        <div style={{ padding: '8px 12px', background: '#1a2030', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0' }}>
              Colonne — {fields.length} dichiarate
            </div>
            <div style={{ fontSize: 9, color: '#4a5a7a' }}>
              Rilevate automaticamente o aggiunte manualmente · propagate ai nodi successivi
            </div>
          </div>
          <button onClick={addField}
            style={{ background: 'none', border: '0.5px dashed #2a3349', borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', color }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = color }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
            <i className="ti ti-plus" style={{ fontSize: 9 }} /> colonna
          </button>
        </div>

        {fields.length === 0 ? (
          <div style={{ padding: '24px 20px', textAlign: 'center', color: '#2a3349', fontSize: 11 }}>
            <i className="ti ti-database-search" style={{ fontSize: 28, display: 'block', marginBottom: 8, color: '#2a3349' }} />
            Clicca <strong style={{ color: '#4a5a7a' }}>Rileva schema dalla query</strong> per importare automaticamente le colonne,
            oppure aggiungile manualmente.
          </div>
        ) : (
          <>
            {/* Intestazione */}
            <div style={{ display: 'grid', gridTemplateColumns: '24px 1fr 80px 100px 28px 24px', gap: 4, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
              {['', 'Nome colonna', 'Tipo', 'Tipo DB nativo', '∅', ''].map((h, i) => (
                <div key={i} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{h}</div>
              ))}
            </div>

            {fields.map((f, idx) => {
              const isJsonb = f.type === 'object' || f.dbType?.toLowerCase().includes('json')
              return (
                <div key={f.id}
                  style={{ display: 'grid', gridTemplateColumns: '24px 1fr 80px 100px 28px 24px', gap: 4, alignItems: 'center', padding: '4px 10px', background: idx % 2 === 0 ? '#1a2030' : 'transparent', borderBottom: idx < fields.length - 1 ? '0.5px solid #2a3349' : 'none' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = idx % 2 === 0 ? '#1a2030' : 'transparent' }}>

                  {/* Riordina */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                    <button onClick={() => moveField(idx, 'up')} disabled={idx === 0}
                      style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'default' : 'pointer', color: idx === 0 ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
                      <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
                    </button>
                    <button onClick={() => moveField(idx, 'down')} disabled={idx === fields.length - 1}
                      style={{ background: 'none', border: 'none', cursor: idx === fields.length - 1 ? 'default' : 'pointer', color: idx === fields.length - 1 ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
                      <i className="ti ti-chevron-down" style={{ fontSize: 9 }} />
                    </button>
                  </div>

                  {/* Nome colonna */}
                  <input value={f.name}
                    onChange={(e) => updateField(f.id, 'name', e.target.value)}
                    style={{ ...inputStyle, fontSize: 10, padding: '3px 6px', color: isJsonb ? '#a78bfa' : '#c8d4f0' }}
                    placeholder="nome_colonna" />

                  {/* Tipo logico */}
                  <div title={TYPE_HINTS[f.type] ?? ''}>
                    <CustomSelect value={f.type}
                      onChange={(e) => updateField(f.id, 'type', e.target.value)}
                      style={{
                        ...inputStyle, fontSize: 10, padding: '3px 4px',
                        color:      TYPE_META[f.type as FieldType]?.color ?? '#c8d4f0',
                        background: TYPE_META[f.type as FieldType]?.bg    ?? '#1e2535',
                        border:     `1px solid ${TYPE_META[f.type as FieldType]?.color ?? '#3a4a6a'}40`,
                      }}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </CustomSelect>
                  </div>

                  {/* Tipo DB nativo — sola lettura se rilevato, editabile se manuale */}
                  <input value={f.dbType ?? ''}
                    onChange={(e) => updateField(f.id, 'dbType', e.target.value)}
                    style={{ ...inputStyle, fontSize: 9, padding: '3px 4px', color: isJsonb ? '#a78bfa' : '#9a9aaa' }}
                    placeholder={dialect === 'postgresql' ? 'jsonb, text…' : 'varchar, int…'} />

                  {/* Nullable */}
                  <div
                    onClick={() => updateField(f.id, 'nullable', !f.nullable)}
                    title={f.nullable ? 'Nullable — clicca per NOT NULL' : 'NOT NULL — clicca per nullable'}
                    style={{ width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${f.nullable ? '#2a3349' : color}`, background: f.nullable ? 'transparent' : `color-mix(in srgb, ${color} 20%, #161b27)`, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    {!f.nullable && <i className="ti ti-check" style={{ fontSize: 9, color }} />}
                  </div>

                  {/* Elimina */}
                  <button onClick={() => deleteField(f.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                    <i className="ti ti-x" style={{ fontSize: 10 }} />
                  </button>
                </div>
              )
            })}
          </>
        )}
      </div>

      {/* ── Info JSONB ───────────────────────────────────────── */}
      {jsonbFields.length > 0 && (
        <div style={{ padding: '8px 12px', background: '#1a1030', border: '1px solid #3a1a6a', borderRadius: 6, display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <i className="ti ti-braces" style={{ fontSize: 13, color: '#a78bfa', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 10, color: '#a78bfa' }}>
            {jsonbFields.length} campo{jsonbFields.length > 1 ? 'i' : ''} di tipo <strong>object / JSON</strong> ({jsonbFields.map((f) => f.name).join(', ')}).
            Vengono propagati as-is. Usa un nodo <strong>JSON Parser</strong> per spacchettarli.
          </div>
        </div>
      )}

      {/* ── Info propagazione ────────────────────────────────── */}
      <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
        Lo schema viene propagato automaticamente ai nodi collegati.
        La colonna <strong style={{ color: '#9a9aaa' }}>∅</strong> indica se il campo è NOT NULL.
      </div>

      <style>{`@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }`}</style>
    </div>
  )
}