/**
 * src/nodes/types/sink_db/Panel.tsx
 *
 * Modifiche rispetto alla versione precedente:
 *
 * - Sezione "Modalità output" aggiunta dopo "Modalità scrittura".
 *   Contiene il toggle pass-through master-detail.
 * - Quando pass-through è attivo, le modalità scrittura vengono
 *   filtrate: solo INSERT e UPSERT sono disponibili (le altre non
 *   hanno senso con il recupero della chiave generata).
 * - Il toggle salva la prop 'passthroughMasterDetail' = 'true'|'false'.
 */

import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'

import { DB_DIALECT_COLORS, DB_DIALECT_LABELS, type DbDialect } from '../../../nodes/resourceDefaults'

// ─── Stili ────────────────────────────────────────────────────────

const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none', width: '100%',
}

const labelSt: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelSt}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function SectionTitle({ label, color = '#3ddc84' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 8 }}>
      {label}
    </div>
  )
}

function Row2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

function Warning({ text }: { text: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '7px 10px', background: '#2a1e10', borderRadius: 6, border: '1px solid #ff9f5760' }}>
      <i className="ti ti-alert-triangle" style={{ fontSize: 13, color: '#ff9f57', flexShrink: 0, marginTop: 1 }} />
      <span style={{ fontSize: 10, color: '#ff9f57', lineHeight: 1.5 }}>{text}</span>
    </div>
  )
}

// Colore pass-through — viola coerente con MappingPanel
const PT_COLOR = '#a855f7'

// ─── Modalità scrittura ───────────────────────────────────────────

const WRITE_MODES_ALL = [
  { value: 'insert',          label: 'INSERT',    icon: 'ti-row-insert-bottom', desc: 'Inserts new rows',          disclaimer: null,                                           passthroughOk: true  },
  { value: 'upsert',          label: 'UPSERT',    icon: 'ti-arrows-exchange',   desc: 'Insert or update on conflict',   disclaimer: null,                                           passthroughOk: true  },
  { value: 'update',          label: 'UPDATE',    icon: 'ti-edit',              desc: 'Updates existing rows',       disclaimer: null,                                           passthroughOk: false },
  { value: 'delete',          label: 'DELETE',    icon: 'ti-trash',             desc: 'Deletes rows',                  disclaimer: null,                                           passthroughOk: false },
  { value: 'truncate_insert', label: 'TRUNC+INS', icon: 'ti-refresh',           desc: 'Empties and reinserts',           disclaimer: null,                                           passthroughOk: false },
  { value: 'merge',           label: 'MERGE',     icon: 'ti-git-merge',         desc: 'Standard SQL MERGE',             disclaimer: null,                                           passthroughOk: false },
]

// P345: cosa fa davvero ogni modalità sul dialetto scelto (motore: check_write_mode,
// odbc::WriteJob). MERGE non esiste su MySQL e SQLite: lì si usa UPSERT.
const NO_MERGE_DIALECTS = ['mysql', 'sqlite']
function modeNote(mode: string, dialect: string): string | null {
  const odbc = ['oracle', 'informix', 'odbc'].includes(dialect)
  if (mode === 'upsert' && odbc) return 'Via ODBC: UPDATE on the key columns, INSERT when no row matches'
  if (mode === 'merge') {
    if (dialect === 'postgresql') return 'Requires PostgreSQL 15+'
    if (dialect === 'oracle') return 'Native Oracle MERGE (via ODBC)'
    if (odbc) return 'Via ODBC: same as UPSERT on the key columns'
    if (NO_MERGE_DIALECTS.includes(dialect)) return 'Not available on this database: use UPSERT'
  }
  return null
}

function mergeConditionConfig(mode: string): { show: boolean } {
  return { show: mode === 'merge' }
}

// P347: cosa fa il motore con una transazione su questo dialetto
// (sink_db write_all_tx / write_all_tx_odbc, txregistry).
function txDialectNote(dialect: string, txMode: string, hasDdl: boolean): string | null {
  const odbc = ['oracle', 'informix', 'odbc'].includes(dialect)
  if (dialect === 'mysql' || dialect === 'sqlite') return 'Transactions are not available on this database yet: the run stops with an error.'
  if (odbc && txMode === 'xa') return 'XA (two-phase commit) is not available on Oracle, Informix and ODBC: use a native transaction with a single resource.'
  if (odbc && hasDdl) return 'On Oracle, Informix and ODBC the table is created before and outside the transaction: a rollback does not remove it.'
  return null
}

// ─── Componente principale ────────────────────────────────────────

export function SinkDbPanel({ nodeId }: { nodeId: string }) {
  const node         = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp   = useFlowStore(s => s.updateNodeProp)
  const updateConfig = useFlowStore(s => s.updateNodeConfig)
  const pool         = useFlowStore(s => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const laneId              = node.data.laneId
  const resId               = (node.data.config?.resourceId as string | undefined) ?? ''
  const writeMode           = p('mode', 'insert')
  const createIfNotExists   = p('createIfNotExists', 'false') === 'true'
  const dropAndCreate       = p('dropAndCreate', 'false') === 'true'
  const passthroughActive   = p('passthroughMasterDetail', 'false') === 'true'

  const dbRes = useMemo(
    () => pool.lanes.find(l => l.id === laneId)?.resources.filter(r => r.kind === 'db') ?? [],
    [pool, laneId]
  )
  const laneTransactions = useMemo(
    () => pool.lanes.find(l => l.id === laneId)?.transactions ?? [],
    [pool, laneId]
  )
  const selectedResource = useMemo(
    () => resId ? pool.lanes.flatMap(l => l.resources).find(r => r.id === resId) as any : undefined,
    [pool, resId]
  )

  const dialect  = (selectedResource?.config?.dialect ?? selectedResource?.config?.driver ?? p('dialect', 'postgresql')) as DbDialect
  const color    = DB_DIALECT_COLORS[dialect] ?? '#3ddc84'
  const dbLabel  = DB_DIALECT_LABELS[dialect] ?? 'DB'
  const isSqlite = dialect === 'sqlite'

  // In modalità pass-through filtra solo i modi compatibili; MERGE solo dove esiste
  const WRITE_MODES = WRITE_MODES_ALL
    .filter(m => !passthroughActive || m.passthroughOk)
    .filter(m => m.value !== 'merge' || !NO_MERGE_DIALECTS.includes(dialect) || writeMode === 'merge')
    .map(m => ({ ...m, disclaimer: modeNote(m.value, dialect) }))
  const mergeConditionAllowed = dialect === 'postgresql' || dialect === 'oracle'

  const handleResourceChange = (newResId: string) => {
    updateConfig(nodeId, { resourceId: newResId })
    const res = dbRes.find((r: any) => r.id === newResId)
    const newDialect = res?.config?.dialect ?? res?.config?.driver
    if (newDialect) updateProp(nodeId, 'dialect', newDialect)
  }

  // Quando si attiva pass-through, forza INSERT se la modalità attuale non è compatibile
  const handlePassthroughToggle = (active: boolean) => {
    updateProp(nodeId, 'passthroughMasterDetail', active ? 'true' : 'false')
    if (active && !WRITE_MODES_ALL.find(m => m.value === writeMode)?.passthroughOk) {
      updateProp(nodeId, 'mode', 'insert')
    }
  }

  const mergeCfg        = mergeConditionConfig(writeMode)
  const needsKeys       = ['upsert', 'update', 'delete'].includes(writeMode)
  const mappingKeyCount = useMemo(() => {
    try {
      const raw = node.data.props?.['sinkColumns']
      if (!raw) return 0
      const cols = JSON.parse(raw as string) as Array<{ enabled: boolean; isKey?: boolean }>
      return cols.filter(c => c.enabled && c.isKey).length
    } catch { return 0 }
  }, [node.data.props?.['sinkColumns']])

  const needsDdlPk      = createIfNotExists || dropAndCreate
  // P349: la PRIMARY KEY della tabella creata viene dai badge PK del mapping
  // (l'unica fonte che il motore usa); il vecchio campo ddlPrimaryKey non c'e' piu'.
  const mappingPkCols = useMemo(() => {
    try {
      const raw = node.data.props?.['sinkColumns']
      if (!raw) return [] as string[]
      const cols = JSON.parse(raw as string) as Array<{ enabled: boolean; isPk?: boolean; dbColumn: string }>
      return cols.filter(c => c.enabled && c.isPk).map(c => c.dbColumn)
    } catch { return [] as string[] }
  }, [node.data.props?.['sinkColumns']])
  const customQueryMode = p('customQueryMode', 'none')
  const sqlCustomActive = customQueryMode !== 'none'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Warning SQL custom attivo ── */}
      {sqlCustomActive && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '8px 10px', background: '#1a1a0a', borderRadius: 6, border: '1px solid #ffb34760' }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 13, color: '#ffb347', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 10, color: '#ffb347', lineHeight: 1.5, flex: 1 }}>
            <strong>Custom SQL active</strong> in the Query tab — the write mode below and the Mapping tab are not used: the statement runs with the fields of the incoming row.
            <button onClick={() => updateProp(nodeId, 'customQueryMode', 'none')}
              style={{ marginLeft: 8, padding: '1px 8px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: '#ffb34720', border: '1px solid #ffb34760', color: '#ffb347', fontWeight: 600 }}>
              Disable custom SQL
            </button>
          </div>
        </div>
      )}

      {/* ── Risorsa DB ── */}
      <SectionTitle label="DB resource" color={color} />

      {dbRes.length === 0 ? (
        <div style={{ padding: 12, textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-database-off" style={{ fontSize: 18, display: 'block', marginBottom: 6 }} />
          No DB resource in this lane. Add it from the resource strip.
        </div>
      ) : (
        <Field label="DB resource" hint="Connection parameters are configured in the resource">
          <CustomSelect style={iStyle} value={resId} onChange={e => handleResourceChange(e.target.value)}>
            <option value="">— select resource —</option>
            {dbRes.map((r: any) => (
              <option key={r.id} value={r.id}>
                {r.label} {r.status === 'ok' ? '✓' : r.status === 'error' ? '✗' : '○'}
              </option>
            ))}
          </CustomSelect>
        </Field>
      )}

      {selectedResource && (
        <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${color} 5%, #161b27)`, borderRadius: 5, border: `1px solid ${color}20`, fontSize: 10, fontFamily: 'monospace', color: '#9a9aaa', display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {!isSqlite && <span><span style={{ color: '#8593b5' }}>host: </span><span style={{ color: '#c8d4f0' }}>{selectedResource.config?.host}:{selectedResource.config?.port}</span></span>}
          <span><span style={{ color: '#8593b5' }}>db: </span><span style={{ color: '#c8d4f0' }}>{selectedResource.config?.database}</span></span>
          <span style={{ marginLeft: 'auto', color, fontWeight: 600 }}>{dbLabel}</span>
        </div>
      )}

      {/* ── Destinazione ── */}
      <SectionTitle label="Destination" color={color} />

      <Row2>
        {!isSqlite && (
          <Field label="Schema">
            <input style={iStyle} value={p('querySchema', 'public')} onChange={u('querySchema')} placeholder="public" />
          </Field>
        )}
        <Field label="Table">
          <input style={iStyle} value={p('table')} onChange={u('table')} placeholder="my_table" />
        </Field>
      </Row2>

      {/* ── Opzioni tabella ── */}
      <Field label="Table options">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: '#c8d4f0' }}>
            <input type="checkbox" checked={createIfNotExists} onChange={e => updateProp(nodeId, 'createIfNotExists', e.target.checked ? 'true' : 'false')} style={{ accentColor: color }} />
            Create table if it doesn't exist
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: '#ff5f57' }}>
            <input type="checkbox" checked={dropAndCreate} onChange={e => updateProp(nodeId, 'dropAndCreate', e.target.checked ? 'true' : 'false')} style={{ accentColor: '#ff5f57' }} />
            DROP + CREATE ⚠ (dangerous)
          </label>
          {needsDdlPk && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4, borderTop: '0.5px solid #2a3349' }}>
              <div style={{ fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>PRIMARY KEY</div>
              {mappingPkCols.length > 0 ? (
                <div style={{ fontSize: 11, color: '#ffb347', fontFamily: "'JetBrains Mono', monospace" }}>
                  {mappingPkCols.join(', ')} <span style={{ color: '#8593b5', fontFamily: 'inherit', fontSize: 10 }}>— from the PK badges in the Mapping tab</span>
                </div>
              ) : (
                <div style={{ fontSize: 10, color: '#ff9f57' }}>
                  No PK column: the table is created without a primary key. Mark the PK columns in the Mapping tab.
                </div>
              )}
            </div>
          )}
        </div>
      </Field>

      {/* ── Modalità scrittura ── */}
      <SectionTitle label="Write mode" color={color} />

      {passthroughActive && (
        <div style={{ fontSize: 10, color: PT_COLOR, padding: '5px 8px', background: `${PT_COLOR}10`, borderRadius: 4, border: `0.5px solid ${PT_COLOR}30`, display: 'flex', gap: 5 }}>
          <i className="ti ti-bolt" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
          Pass-through mode active — only INSERT and UPSERT available.
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
        {WRITE_MODES.map(m => {
          const isActive = writeMode === m.value
          return (
            <button key={m.value} onClick={() => {
              updateProp(nodeId, 'mode', m.value)
              // Passando a UPSERT le condizioni WHERE non hanno senso (il match
              // avviene via vincolo ON CONFLICT): azzera isKey su tutte le colonne
              // così non restano selezioni fantasma né vengono lette dal motore.
              if (m.value === 'upsert') {
                try {
                  const raw = node.data.props?.['sinkColumns']
                  if (raw) {
                    const cols = JSON.parse(raw as string)
                    const cleared = cols.map((c: any) => ({
                      ...c, isKey: false, keyOperator: undefined, keyLogic: undefined,
                    }))
                    updateProp(nodeId, 'sinkColumns', JSON.stringify(cleared))
                  }
                } catch {}
              }
            }}
              title={m.disclaimer ?? undefined}
              style={{
                padding: '9px 6px', fontSize: 10, borderRadius: 6, cursor: 'pointer',
                textAlign: 'center', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4,
                background: isActive ? `color-mix(in srgb, ${color} 35%, #0a1a0e)` : '#1e2535',
                color: isActive ? '#ffffff' : '#8a9abd',
                border: isActive ? `2px solid ${color}` : '1px solid #3a4a6a',
                fontWeight: isActive ? 700 : 400,
                boxShadow: isActive ? `0 0 12px ${color}50, inset 0 0 8px ${color}15` : 'none',
                transition: 'all .15s', position: 'relative',
              }}>
              {m.disclaimer && (
                <div style={{ position: 'absolute', top: 3, right: 3, width: 6, height: 6, borderRadius: '50%', background: '#ffb347' }} title={m.disclaimer} />
              )}
              <i className={`ti ${m.icon}`} style={{ fontSize: 16 }} />
              <span style={{ fontSize: 10, fontWeight: isActive ? 700 : 500 }}>{m.label}</span>
              <span style={{ fontSize: 9, opacity: isActive ? 0.9 : 0.6, lineHeight: 1.3 }}>{m.desc}</span>
              {isActive && m.disclaimer && (
                <span style={{ fontSize: 7, color: '#ffb347', lineHeight: 1.3, marginTop: 1 }}>{m.disclaimer}</span>
              )}
            </button>
          )
        })}
      </div>

      {needsKeys && (
        <Warning text={`The ${writeMode.toUpperCase()} mode requires a UNIQUE or PRIMARY KEY constraint on the key column in the DB.`} />
      )}

      {needsKeys && (
        <Field label="Key columns (WHERE)" hint="Configured in the Mapping tab — 'WHERE key' column">
          {mappingKeyCount > 0 ? (
            <div style={{ fontSize: 11, color: '#4a9eff', display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-key" style={{ fontSize: 12 }} />
              {mappingKeyCount} key column{mappingKeyCount > 1 ? 's' : ''} configured
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#ff9f57', display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-alert-circle" style={{ fontSize: 12 }} />
              No key column — go to the Mapping tab
            </div>
          )}
        </Field>
      )}

      {mergeCfg.show && (
        <Field label="MERGE ON condition">
          <textarea style={{ ...iStyle, resize: 'vertical', minHeight: 48 }} value={p('mergeCondition', '')} onChange={u('mergeCondition')} placeholder="target.id = source.id" spellCheck={false} />
          {!mergeConditionAllowed && (
            <div style={{ fontSize: 10, color: '#ffb347', marginTop: 4 }}>
              A custom condition is supported on PostgreSQL and Oracle only: here MERGE matches on the key columns, leave it empty.
            </div>
          )}
        </Field>
      )}

      {/* ── Modalità output — pass-through master-detail ── */}
      <SectionTitle label="Output mode" color={PT_COLOR} />

      <div style={{ background: '#0f1117', borderRadius: 6, border: `1px solid ${passthroughActive ? PT_COLOR + '50' : '#2a3349'}`, overflow: 'hidden', transition: 'border-color .15s' }}>
        <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, padding: '12px 14px', cursor: 'pointer' }}>
          <div style={{ paddingTop: 2 }}>
            <input
              type="checkbox"
              checked={passthroughActive}
              onChange={e => handlePassthroughToggle(e.target.checked)}
              style={{ accentColor: PT_COLOR, width: 14, height: 14 }}
            />
          </div>
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <i className="ti ti-bolt" style={{ fontSize: 13, color: passthroughActive ? PT_COLOR : '#8593b5' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: passthroughActive ? PT_COLOR : '#c8d4f0' }}>
                Pass-through master-detail
              </span>
            </div>
            <div style={{ fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
              The node inserts only the mapped columns, retrieves the key generated by the DB
              and injects it into the record. The flow continues to the next node — ideal
              for master → detail patterns with multiple cascading tables.
            </div>
            {passthroughActive && (
              <div style={{ marginTop: 8, padding: '6px 8px', background: `${PT_COLOR}10`, borderRadius: 4, border: `0.5px solid ${PT_COLOR}30`, fontSize: 10, color: PT_COLOR }}>
                <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
                Configure the Hash columns and the key row in the <strong>Mapping</strong> tab.
              </div>
            )}
          </div>
        </label>
      </div>

      {/* ── Performance ── */}
      <SectionTitle label="Performance" color={color} />
      {/* P348: tolti "Commit every N batches", "Parallel connections" e
          "Transaction timeout": il motore non li ha mai letti. */}
      <Field label="Batch size">
        <input type="number" style={iStyle} value={p('batchSize', '1000')} onChange={u('batchSize')} min="1" />
      </Field>

      {/* ── Gestione errori ── */}
      <SectionTitle label="Error handling" color={color} />
      <Field label="On constraint error">
        <CustomSelect style={iStyle} value={p('onConstraintError', 'stop')} onChange={u('onConstraintError')}>
          <option value="stop">Stop — abort</option>
          <option value="skip">Skip — skip the row</option>
        </CustomSelect>
      </Field>
      {/* P348: tolti "Log", "Update" e la "Dead letter table": non esistevano nel
          motore (le righe finivano contate come errori e il run riusciva). */}
      {!['stop', 'skip'].includes(p('onConstraintError', 'stop')) && (
        <Warning text={`"${p('onConstraintError')}" is no longer available: choose Stop or Skip (the run stops with an error until you do).`} />
      )}

     {/* ── Partecipazione a una transazione (oggetto di lane) ── */}
      {(() => {
        const txId       = p('transactionId', '')
        const activeTx   = laneTransactions.find(t => t.id === txId)
        const isActive   = !!activeTx
        const TX_COLOR   = activeTx?.mode === 'xa' ? '#f59e0b' : '#34d399'
        const NEUTRAL    = '#34d399'  // colore sezione a riposo
        return (
          <>
            <SectionTitle label="Transaction" color={isActive ? TX_COLOR : NEUTRAL} />

            <div style={{ background: '#0f1117', borderRadius: 6,
                          border: `1px solid ${isActive ? TX_COLOR + '60' : '#2a3349'}`,
                          overflow: 'hidden', transition: 'border-color .15s' }}>
              <div style={{ padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <i className="ti ti-arrows-exchange"
                     style={{ fontSize: 14, color: isActive ? TX_COLOR : '#8593b5' }} />
                  <span style={{ fontSize: 12, fontWeight: 600,
                                 color: isActive ? TX_COLOR : '#c8d4f0' }}>
                    {isActive ? `In transaction: ${activeTx!.name}` : 'Autocommit (no transaction)'}
                  </span>
                  {isActive && (
                    <span style={{ marginLeft: 'auto', fontSize: 9, fontWeight: 700,
                                   letterSpacing: 0.5, padding: '2px 7px', borderRadius: 4,
                                   background: `${TX_COLOR}20`, color: TX_COLOR,
                                   border: `0.5px solid ${TX_COLOR}50` }}>
                      {activeTx!.mode.toUpperCase()}
                    </span>
                  )}
                </div>

                <div style={{ fontSize: 10, color: '#9a9aaa', lineHeight: 1.5, marginBottom: 10 }}>
                  {isActive
                    ? 'The writes of this node are part of the transaction: commit or rollback together with the other members.'
                    : 'Without a transaction the node writes in autocommit (each batch committed independently). Associate a transaction for atomic group writing.'}
                </div>

                <CustomSelect style={iStyle}
                  value={txId}
                  onChange={u('transactionId')}>
                  <option value="">— none (autocommit) —</option>
                  {laneTransactions.map(tx => (
                    <option key={tx.id} value={tx.id}>
                      {tx.name} ({tx.mode})
                    </option>
                  ))}
                </CustomSelect>

                {isActive && (
                  <div style={{ marginTop: 8, padding: '6px 8px', background: `${TX_COLOR}10`,
                                borderRadius: 4, border: `0.5px solid ${TX_COLOR}30`,
                                fontSize: 10, color: TX_COLOR, display: 'flex', gap: 5, alignItems: 'center' }}>
                    <i className="ti ti-info-circle" style={{ fontSize: 10 }} />
                    <span>
                      If any member fails, the whole group is rolled back. Configure in the Transactions tab.
                    </span>
                  </div>
                )}

                {isActive && txDialectNote(dialect, activeTx!.mode, dropAndCreate || createIfNotExists) && (
                  <div style={{ marginTop: 8, fontSize: 10, color: '#ffb347', display: 'flex', gap: 5, alignItems: 'flex-start', lineHeight: 1.4 }}>
                    <i className="ti ti-alert-triangle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
                    <span>{txDialectNote(dialect, activeTx!.mode, dropAndCreate || createIfNotExists)}</span>
                  </div>
                )}

                {laneTransactions.length === 0 && (
                  <div style={{ marginTop: 8, fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>
                    No transaction in this lane. Create one from the "Transactions" tab of the properties panel.
                  </div>
                )}
              </div>
            </div>
          </>
        )
      })()}

    </div>
  )
}