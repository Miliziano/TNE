/**
 * src/nodes/types/sink_db/MappingPanel.tsx
 *
 * Modifiche rispetto alla versione precedente:
 *
 * - SinkColumnMapping: aggiunto campo isHashKey (partecipa all'hash
 *   della identity map master-detail).
 * - Griglia: aggiunta colonna "Hash" tra "Chiave WHERE" e "Logic",
 *   visibile solo quando pass-through master-detail è attivo.
 * - GeneratedKeyRow: riga speciale non eliminabile in fondo alla griglia,
 *   appare automaticamente quando almeno una colonna ha isHashKey=true.
 *   Configura: nome campo in uscita, colonna DB da leggere, funzione DB
 *   opzionale (es. nextval('seq')), tipo.
 * - Sezione persistenza identity map: tre opzioni (anonima, variabile
 *   di Lane, variabile di Lane con reset su rollback TX).
 */

/**
 * src/nodes/types/sink_db/MappingPanel.tsx
 *
 * Modifiche rispetto alla versione precedente:
 * - saveMapping ora sincronizza incomingSchema nel formato canonico
 *   { id, name, type, physicalName } dopo ogni scrittura in sinkColumns.
 *   Questo permette a ImportSchemaButton e getHandleSchema di leggere
 *   lo schema dichiarato dall'utente senza casi speciali per sink_db.
 */

/**
 * src/nodes/types/sink_db/MappingPanel.tsx
 *
 * Fix rispetto alla versione precedente:
 *
 * 1. dbTypeToLogical() — traduzione tipo DB nativo → tipo logico canonico.
 *    saveMapping usa dbTypeToLogical(c.dbType) nel campo `type` di
 *    incomingSchema, così ImportSchemaButton e TMap vedono tipi coerenti
 *    (string, integer, decimal…) invece di tipi DB (text, int8, numeric…).
 *
 * 2. incomingFields (dropdown "Campo sorgente") ora legge SOLO i campi
 *    propagati dal TMap — cioè quelli il cui id NON inizia con "sinkdb__".
 *    I campi dichiarati localmente (colonne DB) non appaiono nel dropdown
 *    perché non sono campi sorgente del flusso, sono destinazioni.
 *    Questo risolve il problema del campo sorgente non assegnato.
 *
 * 3. incomingFieldTypes legge dalla stessa fonte filtrata.
 */
/**
 * src/nodes/types/sink_db/MappingPanel.tsx
 *
 * Fix architetturale rispetto alla versione precedente:
 *
 * - saveMapping NON scrive più incomingSchema.
 *   incomingSchema è riservato alla propagazione dal TMap a monte
 *   e non deve essere contaminato con le colonne DB locali.
 *
 * - incomingFields (dropdown "Campo sorgente") legge incomingSchema
 *   direttamente — contiene solo i campi propagati dal TMap.
 *
 * - Per rendere getHandleSchema e ImportSchemaButton funzionanti,
 *   la normalizzazione sinkColumns → formato canonico viene fatta
 *   in getHandleSchema (schemaRegistry.ts) tramite un caso speciale
 *   per sink_db che legge sinkColumns invece di incomingSchema.
 *   Vedi note in fondo al file su come aggiornare schemaRegistry.ts.
 */

import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { SchemaDriftBanner } from '../../../components/SchemaDriftBanner'
import { detectSchemaDrift, type SchemaField } from '../../../utils/schemaUtils'

// ─── Traduzione tipo DB nativo → tipo logico ──────────────────────
export function dbTypeToLogical(dbType: string): string {
  if (!dbType) return 'string'
  const t = dbType.toLowerCase()
  if (/int|serial|number\(19\)/i.test(t))                     return 'integer'
  if (/numeric|decimal|float|double|real|number\(18/i.test(t)) return 'decimal'
  if (/bool/i.test(t))                                         return 'boolean'
  if (/^date$/i.test(t))                                       return 'date'
  if (/timestamp|datetime/i.test(t))                           return 'datetime'
  if (/json|clob|object/i.test(t))                            return 'object'
  return 'string'
}

function logicalToDbType(logicalType: string, dialect: string): string {
  const map: Record<string, Record<string, string>> = {
    postgresql: {
      string: 'text', integer: 'int8', decimal: 'numeric', boolean: 'boolean',
      date: 'date', datetime: 'timestamptz', object: 'jsonb', any: 'text',
    },
    mysql: {
      string: 'varchar(255)', integer: 'bigint', decimal: 'decimal(18,4)',
      boolean: 'tinyint(1)', date: 'date', datetime: 'datetime', object: 'json', any: 'varchar(255)',
    },
    sqlite: {
      string: 'TEXT', integer: 'INTEGER', decimal: 'REAL', boolean: 'INTEGER',
      date: 'TEXT', datetime: 'TEXT', object: 'TEXT', any: 'TEXT',
    },
    oracle: {
      string: 'VARCHAR2(255)', integer: 'NUMBER(19)', decimal: 'NUMBER(18,4)',
      boolean: 'NUMBER(1)', date: 'DATE', datetime: 'TIMESTAMP', object: 'CLOB', any: 'VARCHAR2(255)',
    },
  }
  return map[dialect]?.[logicalType] ?? map.postgresql[logicalType] ?? 'text'
}

import { invoke } from '@tauri-apps/api/core'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { DB_DIALECT_COLORS, type DbDialect } from '../../../nodes/resourceDefaults'

interface DbColumnInfo {
  name: string; db_type: string; nullable: boolean; position: number; is_pk?: boolean
}

interface DbConstraintInfo {
  name: string; constraint_type: 'primary_key' | 'unique'; columns: string[]
}

export type WhereOperator = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'IS NULL' | 'IS NOT NULL'

export interface SinkColumnMapping {
  dbColumn: string; dbType: string; nullable: boolean; isPk: boolean
  enabled: boolean; sourceField: string; dbFunction: string
  isKey?: boolean; keyOperator?: WhereOperator; keyLogic?: 'AND' | 'OR'
  isHashKey?: boolean
}

export interface GeneratedKeyConfig {
  outputFieldName: string; sourceDbColumn: string; dbFunction: string; dbType: string
}

const DB_TYPES: Record<string, string[]> = {
  postgresql: ['text','varchar(255)','int2','int4','int8','numeric','float4','float8','boolean','date','timestamptz','timestamp','jsonb','json','uuid','bytea','serial','bigserial','smallserial'],
  mysql:      ['varchar(255)','text','tinyint(1)','int','bigint','decimal(18,4)','float','double','date','datetime','timestamp','json','blob'],
  sqlite:     ['TEXT','INTEGER','REAL','NUMERIC','BLOB'],
  oracle:     ['VARCHAR2(255)','CLOB','NUMBER','NUMBER(19)','NUMBER(18,4)','DATE','TIMESTAMP','BLOB'],
  informix:   ['VARCHAR(255)','LVARCHAR','INTEGER','BIGINT','DECIMAL','FLOAT','DATE','DATETIME YEAR TO SECOND'],
}

const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10, padding: '2px 5px', outline: 'none', width: '100%',
}

const HASH_COLOR = '#a855f7'

export function SinkDbMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)
  const pool       = useFlowStore(s => s.pool)

  const prevVarNameRef = useRef<string>('')

  useEffect(() => {
    const { pool: currentPool, addVariable: add, updateVariable: upd, deleteVariable: del } =
      useFlowStore.getState()
    const freshNode = useFlowStore.getState().nodes.find(n => n.id === nodeId)
    if (!freshNode) return
    const laneId  = freshNode.data.laneId
    const lane    = currentPool.lanes.find(l => l.id === laneId)
    if (!lane) return
    const persistMode = String(freshNode.data.props?.['identityMapPersist'] ?? 'none')
    const varName     = String(freshNode.data.props?.['identityMapVarName'] ?? '').trim()
    const prevName    = prevVarNameRef.current
    if (persistMode === 'none') {
      const nameToRemove = prevName || varName
      if (nameToRemove) {
        const existing = lane.variables.find(v => v.name === nameToRemove && v.type === 'object')
        if (existing) { del('lane', laneId, existing.id); prevVarNameRef.current = '' }
      }
      return
    }
    if (!varName) return
    if (prevName && prevName !== varName) {
      const prevVar = lane.variables.find(v => v.name === prevName && v.type === 'object')
      if (prevVar) { upd('lane', laneId, prevVar.id, { name: varName }); prevVarNameRef.current = varName; return }
    }
    const existing = lane.variables.find(v => v.name === varName && v.type === 'object')
    if (!existing) add('lane', laneId, { name: varName, type: 'object', value: '{}' })
    prevVarNameRef.current = varName
  }, [
    node?.data.props?.['identityMapPersist'],
    node?.data.props?.['identityMapVarName'],
    node?.data.laneId,
    nodeId,
  ])

  const [inferring,          setInferring]          = useState(false)
  const [inferError,         setInferError]          = useState<string | null>(null)
  const [preview,            setPreview]             = useState<DbColumnInfo[] | null>(null)
  const [constraints,        setConstraints]         = useState<DbConstraintInfo[] | null>(null)
  const [loadingConstraints, setLoadingConstraints]  = useState(false)
  const [constraintsError,   setConstraintsError]    = useState<string | null>(null)

  if (!node) return null

  const p     = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const resId = (node.data.config?.resourceId as string | undefined) ?? ''

  const selectedResource = useMemo(
    () => resId ? pool.lanes.flatMap(l => l.resources).find(r => r.id === resId) as any : undefined,
    [pool, resId]
  )

  const dialect           = (selectedResource?.config?.dialect ?? selectedResource?.config?.driver ?? p('dialect', 'postgresql')) as DbDialect
  const color             = DB_DIALECT_COLORS[dialect] ?? '#3ddc84'
  const passthroughActive = p('passthroughMasterDetail', 'false') === 'true'

  // ─── saveMapping — scrive SOLO sinkColumns ────────────────────
  // NON tocca incomingSchema: quel campo è riservato alla propagazione
  // dal TMap a monte e non deve essere contaminato con le colonne DB.
  // ImportSchemaButton legge le colonne DB tramite getHandleSchema che
  // ha un caso speciale per sink_db (vedi schemaRegistry.ts).
  const saveMapping = (cols: SinkColumnMapping[]) => {
    updateProp(nodeId, 'sinkColumns', JSON.stringify(cols))
  }

  const getMapping = (): SinkColumnMapping[] => {
    try { const raw = node.data.props?.['sinkColumns']; if (raw) return JSON.parse(raw as string) } catch {}
    return []
  }

  const mapping = getMapping()

  const getGeneratedKeyConfig = (): GeneratedKeyConfig => {
    try {
      const raw = node.data.props?.['generatedKeyConfig']
      if (raw) return JSON.parse(raw as string)
    } catch {}
    const table = p('table', 'table')
    return { outputFieldName: `__${table}_id`, sourceDbColumn: 'id', dbFunction: '', dbType: logicalToDbType('integer', dialect) }
  }
  const saveGeneratedKeyConfig = (cfg: GeneratedKeyConfig) =>
    updateProp(nodeId, 'generatedKeyConfig', JSON.stringify(cfg))
  const generatedKeyCfg = getGeneratedKeyConfig()

  // ─── incomingFields — campi propagati dal TMap a monte ────────
  // Legge incomingSchema che contiene SOLO campi propagati dal TMap.
  // Non ha bisogno di filtrare per prefisso perché saveMapping
  // non scrive più in incomingSchema.
  const incomingFields = useMemo((): string[] => {
    try {
      const raw = node.data.props?.['incomingSchema']
      if (!raw) return []
      const parsed = JSON.parse(raw as string)
      if (!Array.isArray(parsed)) return []
      return parsed.filter((f: any) => f?.name).map((f: any) => f.name)
    } catch { return [] }
  }, [node.data.props?.['incomingSchema']])

  const incomingFieldTypes = useMemo((): Record<string, string> => {
    try {
      const raw = node.data.props?.['incomingSchema']
      if (!raw) return {}
      const parsed = JSON.parse(raw as string)
      if (!Array.isArray(parsed)) return {}
      return Object.fromEntries(
        parsed.filter((f: any) => f?.name).map((f: any) => [f.name, f.type ?? 'string'])
      )
    } catch { return {} }
  }, [node.data.props?.['incomingSchema']])

  // liveSchema per SchemaDriftBanner — campi propagati dal TMap
  const liveSchema = useMemo((): SchemaField[] => {
    try {
      const raw = node.data.props?.['incomingSchema']
      if (!raw) return []
      const parsed = JSON.parse(raw as string)
      return Array.isArray(parsed)
        ? parsed.filter((f: any) => f?.name).map((f: any) => ({
            id: f.id ?? f.name, name: f.name, type: f.type ?? 'string',
          }))
        : []
    } catch { return [] }
  }, [node.data.props?.['incomingSchema']])

  const mappingSnapshot = useMemo((): SchemaField[] => {
    try {
      const raw = node.data.props?.['sinkColumnsSnapshot']
      if (!raw) return []
      return JSON.parse(raw as string)
    } catch { return [] }
  }, [node.data.props?.['sinkColumnsSnapshot']])

  const drift        = useMemo(() => detectSchemaDrift(mappingSnapshot, liveSchema), [mappingSnapshot, liveSchema])
  const hashKeyCount = mapping.filter(c => c.isHashKey).length
  const hasHashKeys  = hashKeyCount > 0

  const loadConstraints = useCallback(async () => {
    setLoadingConstraints(true); setConstraintsError(null)
    try {
      const resCfg = (selectedResource?.config ?? {}) as Record<string, string>
      const dial   = resCfg.dialect ?? resCfg.driver ?? 'postgresql'
      const connection = {
        dialect: dial, host: resCfg.host ?? 'localhost',
        port: parseInt(resCfg.port ?? '5432', 10), database: resCfg.database ?? '',
        user: resCfg.user ?? '', password: resCfg.password ?? '',
        schema: resCfg.schema, ssl: resCfg.ssl ?? 'false',
        connectTimeout: parseInt(resCfg.connectTimeout ?? '10', 10),
      }
      const schema = p('querySchema', resCfg.schema ?? 'public')
      const table  = p('table')
      if (!table) { setConstraintsError('Configura la tabella nel tab Configurazione.'); setLoadingConstraints(false); return }
      const result = await invoke<DbConstraintInfo[]>('db_list_constraints', { request: { connection, schema, table } })
      if (result.length === 0) setConstraintsError('Nessun vincolo UNIQUE o PRIMARY KEY trovato su questa tabella.')
      setConstraints(result)
    } catch (err) { setConstraintsError(String(err)) }
    finally { setLoadingConstraints(false) }
  }, [selectedResource, p])

  const applyConstraint = (constraint: DbConstraintInfo) => {
    const colSet = new Set(constraint.columns)
    saveMapping(mapping.map(c => ({
      ...c,
      isKey:       colSet.has(c.dbColumn),
      keyOperator: colSet.has(c.dbColumn) ? ('=' as const) : c.keyOperator,
      keyLogic:    colSet.has(c.dbColumn) ? ('AND' as const) : c.keyLogic,
    })))
    updateProp(nodeId, 'selectedConstraintName', constraint.name)
  }

  const selectedConstraintName = p('selectedConstraintName', '')

  const handleInferSchema = useCallback(async () => {
    setInferring(true); setInferError(null); setPreview(null)
    try {
      const resCfg = (selectedResource?.config ?? {}) as Record<string, string>
      const dial   = resCfg.dialect ?? resCfg.driver ?? 'postgresql'
      const connection = {
        dialect: dial, host: resCfg.host ?? 'localhost',
        port: parseInt(resCfg.port ?? '5432', 10), database: resCfg.database ?? '',
        user: resCfg.user ?? '', password: resCfg.password ?? '',
        schema: resCfg.schema, ssl: resCfg.ssl ?? 'false',
        connectTimeout: parseInt(resCfg.connectTimeout ?? '10', 10),
      }
      const schema = p('querySchema', resCfg.schema ?? 'public')
      const table  = p('table')
      if (!table) { setInferError('Configura la tabella nel tab Configurazione.'); setInferring(false); return }
      const query  = dial === 'sqlite' ? `SELECT * FROM "${table}" LIMIT 0` : `SELECT * FROM "${schema}"."${table}" LIMIT 0`
      const columns = await invoke<DbColumnInfo[]>('db_infer_schema', { request: { connection, query } })
      if (columns.length === 0) { setInferError('Nessuna colonna rilevata.'); setInferring(false); return }
      setPreview(columns)
    } catch (err) { setInferError(String(err)) }
    finally { setInferring(false) }
  }, [selectedResource, p])

  const importFromDb = () => {
    if (!preview) return
    const existingMap = new Map(mapping.map(m => [m.dbColumn, m]))
    saveMapping(preview.map(col => {
      const ex = existingMap.get(col.name)
      return ex
        ? { ...ex, dbType: col.db_type, nullable: col.nullable, isPk: col.is_pk ?? false }
        : {
            dbColumn: col.name, dbType: col.db_type,
            nullable: col.nullable, isPk: col.is_pk ?? false,
            enabled: true,
            sourceField: incomingFields.includes(col.name) ? col.name : '',
            dbFunction: '',
          }
    }))
    updateProp(nodeId, 'sinkColumnsSnapshot', JSON.stringify(liveSchema))
    setPreview(null)
  }

  const importFromFlow = () => {
  if (incomingFields.length === 0) return
  const existingMap = new Map(mapping.map(m => [m.dbColumn, m]))
  
  // Campi già presenti nel mapping — aggiorna tipo DB e assegna
  // sourceField se ancora vuoto e il nome coincide con un campo del flusso
  const updated = mapping.map(col => {
    const logicalType    = incomingFieldTypes[col.dbColumn]
    const expectedDbType = logicalType ? logicalToDbType(logicalType, dialect) : col.dbType
    return {
      ...col,
      dbType:      expectedDbType,
      // Assegna sourceField se vuoto e il nome della colonna DB
      // corrisponde a un campo del flusso in arrivo
      sourceField: col.sourceField || (incomingFields.includes(col.dbColumn) ? col.dbColumn : ''),
    }
  })

  // Campi del flusso non ancora presenti nel mapping — aggiunge righe nuove
  const existingDbCols = new Set(mapping.map(m => m.dbColumn))
  const newRows = incomingFields
    .filter(f => !existingDbCols.has(f))
    .map(f => ({
      dbColumn:    f,
      dbType:      logicalToDbType(incomingFieldTypes[f] ?? 'string', dialect),
      nullable:    true,
      isPk:        false,
      enabled:     true,
      sourceField: f,
      dbFunction:  '',
    }))

  saveMapping([...updated, ...newRows])
  updateProp(nodeId, 'sinkColumnsSnapshot', JSON.stringify(liveSchema))
}

  const addManual = () =>
    saveMapping([...mapping, {
      dbColumn: '', dbType: logicalToDbType('string', dialect),
      nullable: true, isPk: false, enabled: true, sourceField: '', dbFunction: '',
    }])

  const updateCol = (idx: number, key: keyof SinkColumnMapping, value: any) =>
    saveMapping(mapping.map((c, i) => i === idx ? { ...c, [key]: value } : c))

  const removeCol = (idx: number) => saveMapping(mapping.filter((_, i) => i !== idx))

  const enabledCount = mapping.filter(c => c.enabled).length
  const writeMode    = p('mode', 'insert')
  const isUpsert     = writeMode === 'upsert'

  const identityMapPersist = p('identityMapPersist', 'none')
  const identityMapVarName = p('identityMapVarName', '')
  const identityMapTxGroup = p('identityMapTxGroup', '')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={handleInferSchema} disabled={inferring || !resId}
          style={{ padding: '6px 12px', fontSize: 11, borderRadius: 4, cursor: (!resId || inferring) ? 'not-allowed' : 'pointer', background: `color-mix(in srgb, ${color} 10%, #1a2030)`, color: !resId ? '#4a5a7a' : color, border: `1px solid ${!resId ? '#2a3349' : color + '50'}`, display: 'flex', alignItems: 'center', gap: 5, fontWeight: 600 }}>
          <i className={`ti ${inferring ? 'ti-loader' : 'ti-database-search'}`} style={{ fontSize: 13 }} />
          {inferring ? 'Recupero…' : 'Importa da DB'}
        </button>

        <button onClick={importFromFlow} disabled={incomingFields.length === 0}
          style={{ padding: '6px 12px', fontSize: 11, borderRadius: 4, cursor: incomingFields.length === 0 ? 'not-allowed' : 'pointer', background: '#1a2030', color: incomingFields.length === 0 ? '#4a5a7a' : '#c8d4f0', border: '1px solid #3a4a6a', display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-arrows-exchange" style={{ fontSize: 13 }} />
          Importa da flusso{incomingFields.length > 0 && <span style={{ fontSize: 9, color: '#4a5a7a' }}>({incomingFields.length})</span>}
        </button>

        <button onClick={addManual}
          style={{ padding: '6px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#c8d4f0', border: '1px solid #3a4a6a', display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-plus" style={{ fontSize: 13 }} />
          Aggiungi riga
        </button>

        {mapping.length > 0 && (
          <span style={{ marginLeft: 'auto', fontSize: 10, color: '#4a5a7a' }}>{enabledCount} / {mapping.length} abilitate</span>
        )}
      </div>

      <SchemaDriftBanner drift={drift} onResync={importFromFlow} color={color} />

      {isUpsert && (
        <div style={{ background: '#0f1117', borderRadius: 6, border: `1px solid ${color}40`, overflow: 'hidden' }}>
          <div style={{ padding: '7px 12px', background: `color-mix(in srgb, ${color} 10%, #1a2030)`, display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-key" style={{ fontSize: 12, color }} />
            <span style={{ fontSize: 11, fontWeight: 600, color, flex: 1 }}>Vincolo per ON CONFLICT</span>
            <button onClick={loadConstraints} disabled={loadingConstraints || !resId}
              style={{ padding: '4px 12px', fontSize: 10, borderRadius: 4, cursor: (!resId || loadingConstraints) ? 'not-allowed' : 'pointer', background: `color-mix(in srgb, ${color} 12%, #1a2030)`, color: !resId ? '#4a5a7a' : color, border: `1px solid ${color}50`, display: 'flex', alignItems: 'center', gap: 4, fontWeight: 600 }}>
              <i className={`ti ${loadingConstraints ? 'ti-loader' : 'ti-refresh'}`} style={{ fontSize: 11 }} />
              {loadingConstraints ? 'Carico…' : 'Carica vincoli'}
            </button>
          </div>
          {constraintsError && (
            <div style={{ fontSize: 10, color: '#ff9f57', padding: '7px 12px', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-circle" style={{ fontSize: 11, flexShrink: 0 }} /> {constraintsError}
            </div>
          )}
          {constraints && constraints.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column' }}>
              {constraints.map(c => {
                const isSelected = selectedConstraintName === c.name
                return (
                  <div key={c.name} onClick={() => applyConstraint(c)}
                    style={{ padding: '7px 12px', cursor: 'pointer', borderTop: '0.5px solid #1e2840', background: isSelected ? `color-mix(in srgb, ${color} 14%, #1a2030)` : 'transparent', display: 'flex', alignItems: 'center', gap: 8 }}>
                    <i className={`ti ${isSelected ? 'ti-circle-check-filled' : 'ti-circle'}`} style={{ fontSize: 13, color: isSelected ? color : '#3a4a6a', flexShrink: 0 }} />
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 11, color: isSelected ? color : '#c8d4f0', fontWeight: isSelected ? 700 : 500, display: 'flex', alignItems: 'center', gap: 6 }}>
                        {c.columns.join(', ')}
                        <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 3, background: c.constraint_type === 'primary_key' ? '#ffb34720' : '#4a9eff20', color: c.constraint_type === 'primary_key' ? '#ffb347' : '#4a9eff', fontWeight: 600 }}>
                          {c.constraint_type === 'primary_key' ? 'PK' : 'UNIQUE'}
                        </span>
                      </div>
                      <div style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace', marginTop: 1 }}>{c.name}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {!resId && (
        <div style={{ fontSize: 10, color: '#ff9f57', padding: '5px 8px', background: '#2a1e10', borderRadius: 4, border: '0.5px solid #3d2a10' }}>
          Seleziona prima una risorsa DB nel tab Configurazione per importare lo schema.
        </div>
      )}

      {inferError && (
        <div style={{ fontSize: 10, color: '#ff5f57', padding: '6px 10px', background: '#2a1010', borderRadius: 4, border: '0.5px solid #3d1010', display: 'flex', gap: 5 }}>
          <i className="ti ti-alert-circle" style={{ fontSize: 11, flexShrink: 0 }} /> {inferError}
        </div>
      )}

      {preview && (
        <div style={{ background: '#0f1117', borderRadius: 6, border: `1px solid ${color}40`, overflow: 'hidden' }}>
          <div style={{ padding: '7px 12px', background: `color-mix(in srgb, ${color} 10%, #1a2030)`, display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-table" style={{ fontSize: 12, color }} />
            <span style={{ fontSize: 11, fontWeight: 600, color, flex: 1 }}>Anteprima — {preview.length} colonne</span>
            <button onClick={importFromDb}
              style={{ padding: '4px 14px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: color, color: '#0f1117', border: 'none', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-download" style={{ fontSize: 11 }} /> Importa
            </button>
            <button onClick={() => setPreview(null)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '4px 6px' }}>
              <i className="ti ti-x" style={{ fontSize: 12 }} />
            </button>
          </div>
          <div style={{ maxHeight: 160, overflowY: 'auto' }}>
            {preview.map((col, i) => (
              <div key={col.name} style={{ display: 'grid', gridTemplateColumns: '1fr 90px 70px', gap: 8, padding: '4px 12px', alignItems: 'center', background: i % 2 === 0 ? '#1a2030' : 'transparent' }}>
                <span style={{ fontSize: 10, color: col.is_pk ? '#ffb347' : '#c8d4f0', fontFamily: 'monospace' }}>
                  {col.is_pk && <i className="ti ti-key" style={{ fontSize: 9, color: '#ffb347', marginRight: 4 }} />}
                  {col.name}
                  {incomingFields.includes(col.name) && <span style={{ fontSize: 9, color, background: `${color}20`, padding: '1px 4px', borderRadius: 3, marginLeft: 4 }}>✓ match</span>}
                </span>
                <span style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace' }}>{col.db_type}</span>
                <span style={{ fontSize: 9, color: col.nullable ? '#3ddc84' : '#ff5f57' }}>{col.nullable ? 'null ok' : 'NOT NULL'}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {mapping.length === 0 && !preview && (
        <div style={{ padding: '28px 12px', textAlign: 'center', color: '#2a3349', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-table-off" style={{ fontSize: 26, display: 'block', marginBottom: 8 }} />
          Nessuna colonna configurata.<br />
          Usa <strong style={{ color }}>Importa da DB</strong> o <strong style={{ color }}>Importa da flusso</strong>.
        </div>
      )}

      {mapping.length > 0 && (
        <>
          <div style={{ background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', overflow: 'hidden' }}>
            <div style={{
              display: 'grid',
              gridTemplateColumns: passthroughActive
                ? '24px minmax(0,1fr) minmax(0,110px) minmax(0,120px) 56px 110px 36px 50px 50px 24px'
                : '24px minmax(0,1fr) minmax(0,110px) minmax(0,120px) 56px 110px 50px 50px 24px',
              gap: 4, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #2a3349'
            }}>
              {['✓', 'Colonna DB', 'Campo sorgente', 'Funzione DB', 'Tipo DB', 'Chiave WHERE',
                ...(passthroughActive ? ['Hash'] : []),
                'Logic', 'Flag', ''].map((h, i) => (
                <div key={i} style={{ fontSize: 9, color: h === 'Hash' ? HASH_COLOR : color, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{h}</div>
              ))}
            </div>

            {mapping.map((col, idx) => (
              <div key={idx} style={{
                display: 'grid',
                gridTemplateColumns: passthroughActive
                  ? '24px minmax(0,1fr) minmax(0,110px) minmax(0,120px) 56px 110px 36px 50px 50px 24px'
                  : '24px minmax(0,1fr) minmax(0,110px) minmax(0,120px) 56px 110px 50px 50px 24px',
                gap: 4, alignItems: 'center', padding: '4px 8px',
                background: !col.enabled ? '#0a0e17' : idx % 2 === 0 ? '#1a2030' : 'transparent',
                borderBottom: idx < mapping.length - 1 ? '0.5px solid #1e2840' : 'none',
                opacity: col.enabled ? 1 : 0.45
              }}>
                <div onClick={() => updateCol(idx, 'enabled', !col.enabled)}
                  style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${col.enabled ? color : '#2a3349'}`, background: col.enabled ? `color-mix(in srgb, ${color} 20%, #0f1117)` : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
                  {col.enabled && <i className="ti ti-check" style={{ fontSize: 9, color }} />}
                </div>
                <input value={col.dbColumn} onChange={e => updateCol(idx, 'dbColumn', e.target.value)}
                  style={{ ...iStyle, color: col.isPk ? '#ffb347' : '#c8d4f0' }} placeholder="nome_colonna" />
                {incomingFields.length > 0 ? (
                  <CustomSelect value={col.sourceField} onChange={e => updateCol(idx, 'sourceField', e.target.value)} style={iStyle}>
                    <option value="">— nessuno —</option>
                    {incomingFields.map(f => <option key={f} value={f}>{f}</option>)}
                  </CustomSelect>
                ) : (
                  <input value={col.sourceField} onChange={e => updateCol(idx, 'sourceField', e.target.value)} style={iStyle} placeholder="campo_sorgente" />
                )}
                <input value={col.dbFunction ?? ''} onChange={e => updateCol(idx, 'dbFunction', e.target.value)}
                  disabled={!col.enabled}
                  style={{ ...iStyle, color: (col.dbFunction ?? '') ? '#ffb347' : '#4a5a7a' }} placeholder="es: NOW()" />
                <CustomSelect value={col.dbType} onChange={e => updateCol(idx, 'dbType', e.target.value)}
                  style={{ ...iStyle, color: '#9a9aaa', fontSize: 9, padding: '2px 4px' }}>
                  {DB_TYPES[dialect]?.map(t => <option key={t} value={t}>{t}</option>)}
                  {!DB_TYPES[dialect]?.includes(col.dbType) && col.dbType && <option value={col.dbType}>{col.dbType}</option>}
                </CustomSelect>
                <div style={{ display: 'flex', gap: 3, alignItems: 'center', opacity: isUpsert ? 0.6 : 1 }}>
                  <span onClick={() => { if (!isUpsert) updateCol(idx, 'isKey', !col.isKey) }}
                    style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, cursor: 'pointer', flexShrink: 0, background: col.isKey ? '#4a9eff20' : '#1a2030', color: col.isKey ? '#4a9eff' : '#2a3349', border: `0.5px solid ${col.isKey ? '#4a9eff50' : '#2a3349'}`, display: 'flex', alignItems: 'center', gap: 2 }}>
                    <i className="ti ti-key" style={{ fontSize: 9 }} />
                  </span>
                  {col.isKey && (
                    <CustomSelect value={col.keyOperator ?? '='} onChange={e => updateCol(idx, 'keyOperator', e.target.value)}
                      style={{ ...iStyle, fontSize: 9, padding: '2px 3px', color: '#4a9eff', minWidth: 0 }}>
                      {['=','!=','>','<','>=','<=','LIKE','IS NULL','IS NOT NULL'].map(op => <option key={op} value={op}>{op}</option>)}
                    </CustomSelect>
                  )}
                </div>
                {passthroughActive && (
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span onClick={() => updateCol(idx, 'isHashKey', !col.isHashKey)}
                      style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, cursor: 'pointer', background: col.isHashKey ? `${HASH_COLOR}20` : '#1a2030', color: col.isHashKey ? HASH_COLOR : '#2a3349', border: `0.5px solid ${col.isHashKey ? `${HASH_COLOR}50` : '#2a3349'}`, display: 'flex', alignItems: 'center', gap: 2, fontWeight: col.isHashKey ? 700 : 400 }}>
                      <i className="ti ti-hash" style={{ fontSize: 9 }} />
                    </span>
                  </div>
                )}
                <div>
                  {col.isKey && (() => {
                    const priorKeyExists = mapping.slice(0, idx).some(c => c.isKey)
                    if (!priorKeyExists) return <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, background: '#1a2030', color: '#9a9aaa', border: '0.5px solid #3a4a6a', display: 'inline-block', fontWeight: 600 }}>1ª chiave</span>
                    return (
                      <CustomSelect value={col.keyLogic ?? 'AND'} onChange={e => updateCol(idx, 'keyLogic', e.target.value)}
                        disabled={isUpsert}
                        style={{ ...iStyle, fontSize: 9, padding: '2px 3px', fontWeight: 700, opacity: isUpsert ? 0.5 : 1, color: (col.keyLogic ?? 'AND') === 'OR' ? '#ffb347' : '#4a9eff', borderColor: (col.keyLogic ?? 'AND') === 'OR' ? '#ffb34760' : '#4a9eff60' }}>
                        <option value="AND">AND</option>
                        <option value="OR">OR</option>
                      </CustomSelect>
                    )
                  })()}
                </div>
                <div style={{ display: 'flex', gap: 3, alignItems: 'center' }}>
                  <span onClick={() => updateCol(idx, 'isPk', !col.isPk)}
                    style={{ fontSize: 9, padding: '1px 4px', borderRadius: 3, cursor: 'pointer', background: col.isPk ? '#ffb34720' : '#1a2030', color: col.isPk ? '#ffb347' : '#2a3349', border: `0.5px solid ${col.isPk ? '#ffb34750' : '#2a3349'}` }}>PK</span>
                  <span onClick={() => updateCol(idx, 'nullable', !col.nullable)}
                    style={{ fontSize: 9, cursor: 'pointer', color: col.nullable ? '#3ddc84' : '#ff5f57' }}>
                    {col.nullable ? 'null' : 'req'}
                  </span>
                </div>
                <button onClick={() => removeCol(idx)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 2, display: 'flex', alignItems: 'center' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                  <i className="ti ti-trash" style={{ fontSize: 11 }} />
                </button>
              </div>
            ))}

            {passthroughActive && hasHashKeys && (
              <div style={{ display: 'grid', gridTemplateColumns: '24px minmax(0,1fr) minmax(0,1fr) minmax(0,120px) 56px auto', gap: 4, alignItems: 'center', padding: '6px 8px', background: `color-mix(in srgb, ${HASH_COLOR} 8%, #0f1117)`, borderTop: `1px solid ${HASH_COLOR}40` }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <i className="ti ti-bolt" style={{ fontSize: 12, color: HASH_COLOR }} />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 9, color: HASH_COLOR, textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Campo in uscita</div>
                  <input value={generatedKeyCfg.outputFieldName} onChange={e => saveGeneratedKeyConfig({ ...generatedKeyCfg, outputFieldName: e.target.value })} style={{ ...iStyle, color: HASH_COLOR, borderColor: `${HASH_COLOR}50` }} placeholder="__table_id" />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Colonna PK nel DB</div>
                  <input value={generatedKeyCfg.sourceDbColumn} onChange={e => saveGeneratedKeyConfig({ ...generatedKeyCfg, sourceDbColumn: e.target.value })} style={iStyle} placeholder="id" />
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div style={{ fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>Sequenza (opz.)</div>
                  <input value={generatedKeyCfg.dbFunction} onChange={e => saveGeneratedKeyConfig({ ...generatedKeyCfg, dbFunction: e.target.value })} style={{ ...iStyle, color: generatedKeyCfg.dbFunction ? '#ffb347' : '#4a5a7a' }} placeholder="nextval('seq')" />
                </div>
                <CustomSelect value={generatedKeyCfg.dbType} onChange={e => saveGeneratedKeyConfig({ ...generatedKeyCfg, dbType: e.target.value })} style={{ ...iStyle, color: '#9a9aaa', fontSize: 9, padding: '2px 4px', alignSelf: 'flex-end' }}>
                  {DB_TYPES[dialect]?.map(t => <option key={t} value={t}>{t}</option>)}
                </CustomSelect>
                <div style={{ fontSize: 9, color: HASH_COLOR, padding: '2px 6px', borderRadius: 3, background: `${HASH_COLOR}15`, border: `0.5px solid ${HASH_COLOR}40`, whiteSpace: 'nowrap', alignSelf: 'flex-end' }}>generato dal DB</div>
              </div>
            )}
          </div>

          {passthroughActive && hasHashKeys && (
            <div style={{ background: '#0f1117', borderRadius: 6, border: `1px solid ${HASH_COLOR}30`, overflow: 'hidden' }}>
              <div style={{ padding: '7px 12px', background: `color-mix(in srgb, ${HASH_COLOR} 8%, #1a2030)`, display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className="ti ti-database-export" style={{ fontSize: 12, color: HASH_COLOR }} />
                <span style={{ fontSize: 11, fontWeight: 600, color: HASH_COLOR }}>Persistenza identity map</span>
              </div>
              <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {[
                  { value: 'none',             label: 'Anonima',                                 desc: 'La map vive solo durante questo run.' },
                  { value: 'lane_var',          label: 'Variabile di Lane',                       desc: 'Persiste tra run successivi. Utile per ETL incrementali.' },
                  { value: 'lane_var_tx_reset', label: 'Variabile di Lane + reset su rollback TX', desc: 'Come sopra, ma se la transazione va in rollback la map viene ripristinata.' },
                ].map(opt => (
                  <label key={opt.value} style={{ display: 'flex', alignItems: 'flex-start', gap: 8, cursor: 'pointer' }}>
                    <input type="radio" name={`idmap-persist-${nodeId}`}
                      checked={identityMapPersist === opt.value}
                      onChange={() => updateProp(nodeId, 'identityMapPersist', opt.value)}
                      style={{ marginTop: 2, accentColor: HASH_COLOR }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 11, color: '#c8d4f0', fontWeight: 600 }}>{opt.label}</div>
                      <div style={{ fontSize: 10, color: '#4a5a7a', marginTop: 2 }}>{opt.desc}</div>
                      {identityMapPersist === opt.value && opt.value !== 'none' && (
                        <div style={{ marginTop: 6 }}>
                          <div style={{ fontSize: 9, color: '#9a9aaa', marginBottom: 3 }}>Nome variabile</div>
                          <input value={identityMapVarName} onChange={e => updateProp(nodeId, 'identityMapVarName', e.target.value)}
                            style={{ ...iStyle, borderColor: `${HASH_COLOR}50`, color: HASH_COLOR }} placeholder={`__${p('table', 'table')}_identity_map`} />
                          {opt.value === 'lane_var_tx_reset' && (
                            <div style={{ marginTop: 6 }}>
                              <div style={{ fontSize: 9, color: '#9a9aaa', marginBottom: 3 }}>Gruppo transazionale</div>
                              <input value={identityMapTxGroup} onChange={e => updateProp(nodeId, 'identityMapTxGroup', e.target.value)} style={iStyle} placeholder="nome_gruppo_tx" />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap' }}>
            {[
              { icon: 'ti-checks', label: 'Abilita tutte',       action: () => saveMapping(mapping.map(c => ({ ...c, enabled: true }))) },
              { icon: 'ti-square', label: 'Disabilita tutte',    action: () => saveMapping(mapping.map(c => ({ ...c, enabled: false }))) },
              { icon: 'ti-wand',   label: 'Auto-match per nome', action: () => saveMapping(mapping.map(c => ({ ...c, sourceField: incomingFields.includes(c.dbColumn) ? c.dbColumn : c.sourceField }))) },
            ].map(btn => (
              <button key={btn.label} onClick={btn.action}
                style={{ flex: 1, minWidth: 90, padding: '5px 6px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#9a9aaa', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                <i className={`ti ${btn.icon}`} style={{ fontSize: 10 }} /> {btn.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  )
}