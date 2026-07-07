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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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
  { value: 'insert',          label: 'INSERT',    icon: 'ti-row-insert-bottom', desc: 'Inserisce nuove righe',          disclaimer: null,                                           passthroughOk: true  },
  { value: 'upsert',          label: 'UPSERT',    icon: 'ti-arrows-exchange',   desc: 'Insert o update su conflitto',   disclaimer: 'Non disponibile su Oracle e SQL Server',       passthroughOk: true  },
  { value: 'update',          label: 'UPDATE',    icon: 'ti-edit',              desc: 'Aggiorna righe esistenti',       disclaimer: null,                                           passthroughOk: false },
  { value: 'delete',          label: 'DELETE',    icon: 'ti-trash',             desc: 'Elimina righe',                  disclaimer: null,                                           passthroughOk: false },
  { value: 'truncate_insert', label: 'TRUNC+INS', icon: 'ti-refresh',           desc: 'Svuota e reinserisce',           disclaimer: null,                                           passthroughOk: false },
  { value: 'merge',           label: 'MERGE',     icon: 'ti-git-merge',         desc: 'Standard SQL — richiede PG 15+', disclaimer: 'Consigliato per Oracle e SQL Server',          passthroughOk: false },
]

function mergeConditionConfig(mode: string): { show: boolean } {
  return { show: mode === 'merge' }
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

  // In modalità pass-through filtra solo i modi compatibili
  const WRITE_MODES = passthroughActive
    ? WRITE_MODES_ALL.filter(m => m.passthroughOk)
    : WRITE_MODES_ALL

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

  const missingKeys     = needsKeys && mappingKeyCount === 0
  const needsDdlPk      = createIfNotExists || dropAndCreate
  const customQueryMode = p('customQueryMode', 'none')
  const sqlCustomActive = customQueryMode !== 'none'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ── Warning SQL custom attivo ── */}
      {sqlCustomActive && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 7, padding: '8px 10px', background: '#1a1a0a', borderRadius: 6, border: '1px solid #ffb34760' }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 13, color: '#ffb347', flexShrink: 0, marginTop: 1 }} />
          <div style={{ fontSize: 10, color: '#ffb347', lineHeight: 1.5, flex: 1 }}>
            <strong>SQL custom attivo</strong> nel tab Query — la modalità scrittura qui sotto è ignorata durante l'esecuzione.
            <button onClick={() => updateProp(nodeId, 'customQueryMode', 'none')}
              style={{ marginLeft: 8, padding: '1px 8px', fontSize: 9, borderRadius: 3, cursor: 'pointer', background: '#ffb34720', border: '1px solid #ffb34760', color: '#ffb347', fontWeight: 600 }}>
              Disabilita SQL custom
            </button>
          </div>
        </div>
      )}

      {/* ── Risorsa DB ── */}
      <SectionTitle label="Risorsa DB" color={color} />

      {dbRes.length === 0 ? (
        <div style={{ padding: 12, textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-database-off" style={{ fontSize: 18, display: 'block', marginBottom: 6 }} />
          Nessuna risorsa DB in questa lane. Aggiungila dalla resource strip.
        </div>
      ) : (
        <Field label="Risorsa DB" hint="I parametri di connessione si configurano nella risorsa">
          <CustomSelect style={iStyle} value={resId} onChange={e => handleResourceChange(e.target.value)}>
            <option value="">— seleziona risorsa —</option>
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
          {!isSqlite && <span><span style={{ color: '#4a5a7a' }}>host: </span><span style={{ color: '#c8d4f0' }}>{selectedResource.config?.host}:{selectedResource.config?.port}</span></span>}
          <span><span style={{ color: '#4a5a7a' }}>db: </span><span style={{ color: '#c8d4f0' }}>{selectedResource.config?.database}</span></span>
          <span style={{ marginLeft: 'auto', color, fontWeight: 600 }}>{dbLabel}</span>
        </div>
      )}

      {/* ── Destinazione ── */}
      <SectionTitle label="Destinazione" color={color} />

      <Row2>
        {!isSqlite && (
          <Field label="Schema">
            <input style={iStyle} value={p('querySchema', 'public')} onChange={u('querySchema')} placeholder="public" />
          </Field>
        )}
        <Field label="Tabella">
          <input style={iStyle} value={p('table')} onChange={u('table')} placeholder="nome_tabella" />
        </Field>
      </Row2>

      {/* ── Opzioni tabella ── */}
      <Field label="Opzioni tabella">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: '#c8d4f0' }}>
            <input type="checkbox" checked={createIfNotExists} onChange={e => updateProp(nodeId, 'createIfNotExists', e.target.checked ? 'true' : 'false')} style={{ accentColor: color }} />
            Crea tabella se non esiste
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 11, color: '#ff5f57' }}>
            <input type="checkbox" checked={dropAndCreate} onChange={e => updateProp(nodeId, 'dropAndCreate', e.target.checked ? 'true' : 'false')} style={{ accentColor: '#ff5f57' }} />
            DROP + CREATE ⚠ (pericoloso)
          </label>
          {needsDdlPk && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingTop: 4, borderTop: '0.5px solid #2a3349' }}>
              <div style={{ fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em', fontWeight: 600 }}>Colonna PRIMARY KEY</div>
              <input style={iStyle} value={p('ddlPrimaryKey', '')} onChange={u('ddlPrimaryKey')} placeholder="es: id" />
            </div>
          )}
        </div>
      </Field>

      {/* ── Modalità scrittura ── */}
      <SectionTitle label="Modalità scrittura" color={color} />

      {passthroughActive && (
        <div style={{ fontSize: 10, color: PT_COLOR, padding: '5px 8px', background: `${PT_COLOR}10`, borderRadius: 4, border: `0.5px solid ${PT_COLOR}30`, display: 'flex', gap: 5 }}>
          <i className="ti ti-bolt" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
          Modalità pass-through attiva — solo INSERT e UPSERT disponibili.
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
        <Warning text={`La modalità ${writeMode.toUpperCase()} richiede un vincolo UNIQUE o PRIMARY KEY sulla colonna chiave nel DB.`} />
      )}

      {needsKeys && (
        <Field label="Colonne chiave (WHERE)" hint="Configurate nel tab Mapping — colonna 'Chiave WHERE'">
          {mappingKeyCount > 0 ? (
            <div style={{ fontSize: 11, color: '#4a9eff', display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-key" style={{ fontSize: 12 }} />
              {mappingKeyCount} colonna{mappingKeyCount > 1 ? 'e' : ''} chiave configurat{mappingKeyCount > 1 ? 'e' : 'a'}
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#ff9f57', display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-alert-circle" style={{ fontSize: 12 }} />
              Nessuna colonna chiave — vai al tab Mapping
            </div>
          )}
        </Field>
      )}

      {mergeCfg.show && (
        <Field label="Condizione MERGE ON">
          <textarea style={{ ...iStyle, resize: 'vertical', minHeight: 48 }} value={p('mergeCondition', '')} onChange={u('mergeCondition')} placeholder="target.id = source.id" spellCheck={false} />
        </Field>
      )}

      {/* ── Modalità output — pass-through master-detail ── */}
      <SectionTitle label="Modalità output" color={PT_COLOR} />

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
              <i className="ti ti-bolt" style={{ fontSize: 13, color: passthroughActive ? PT_COLOR : '#4a5a7a' }} />
              <span style={{ fontSize: 12, fontWeight: 600, color: passthroughActive ? PT_COLOR : '#c8d4f0' }}>
                Pass-through master-detail
              </span>
            </div>
            <div style={{ fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
              Il nodo inserisce solo le colonne mappate, recupera la chiave generata dal DB
              e la inietta nel record. Il flusso continua verso il nodo successivo — ideale
              per pattern master → detail con più tabelle in cascata.
            </div>
            {passthroughActive && (
              <div style={{ marginTop: 8, padding: '6px 8px', background: `${PT_COLOR}10`, borderRadius: 4, border: `0.5px solid ${PT_COLOR}30`, fontSize: 10, color: PT_COLOR }}>
                <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
                Configura le colonne Hash e la riga chiave nel tab <strong>Mapping</strong>.
              </div>
            )}
          </div>
        </label>
      </div>

      {/* ── Performance ── */}
      <SectionTitle label="Performance" color={color} />
      <Row2>
        <Field label="Batch size">
          <input type="number" style={iStyle} value={p('batchSize', '1000')} onChange={u('batchSize')} min="1" />
        </Field>
        <Field label="Commit ogni N batch">
          <input type="number" style={iStyle} value={p('commitInterval', '0')} onChange={u('commitInterval')} min="0" />
        </Field>
      </Row2>
      <Row2>
        <Field label="Connessioni parallele">
          <input type="number" style={iStyle} value={p('parallelConnections', '1')} onChange={u('parallelConnections')} min="1" max="20" />
        </Field>
        <Field label="Timeout transazione (s)">
          <input type="number" style={iStyle} value={p('txTimeout', '60')} onChange={u('txTimeout')} min="1" />
        </Field>
      </Row2>

      {/* ── Gestione errori ── */}
      <SectionTitle label="Gestione errori" color={color} />
      <Field label="Su errore di vincolo">
        <CustomSelect style={iStyle} value={p('onConstraintError', 'stop')} onChange={u('onConstraintError')}>
          <option value="stop">Stop — interrompi</option>
          <option value="skip">Skip — salta la riga</option>
          <option value="log">Log — registra e continua</option>
          <option value="update">Update — aggiorna invece</option>
        </CustomSelect>
      </Field>
      <Field label="Dead letter table" hint="Tabella dove scrivere le righe in errore">
        <input style={iStyle} value={p('deadLetterTable', '')} onChange={u('deadLetterTable')} placeholder="errors.failed_rows" />
      </Field>

     {/* ── Partecipazione a una transazione (oggetto di lane) ── */}
      {(() => {
        const txId       = p('transactionId', '')
        const activeTx   = laneTransactions.find(t => t.id === txId)
        const isActive   = !!activeTx
        const TX_COLOR   = activeTx?.mode === 'xa' ? '#f59e0b' : '#34d399'
        const NEUTRAL    = '#34d399'  // colore sezione a riposo
        return (
          <>
            <SectionTitle label="Transazione" color={isActive ? TX_COLOR : NEUTRAL} />

            <div style={{ background: '#0f1117', borderRadius: 6,
                          border: `1px solid ${isActive ? TX_COLOR + '60' : '#2a3349'}`,
                          overflow: 'hidden', transition: 'border-color .15s' }}>
              <div style={{ padding: '12px 14px' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 8 }}>
                  <i className="ti ti-arrows-exchange"
                     style={{ fontSize: 14, color: isActive ? TX_COLOR : '#4a5a7a' }} />
                  <span style={{ fontSize: 12, fontWeight: 600,
                                 color: isActive ? TX_COLOR : '#c8d4f0' }}>
                    {isActive ? `In transazione: ${activeTx!.name}` : 'Autocommit (nessuna transazione)'}
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
                    ? 'Le scritture di questo nodo fanno parte della transazione: commit o rollback insieme agli altri membri.'
                    : 'Senza transazione il nodo scrive in autocommit (ogni batch committato indipendentemente). Associa una transazione per la scrittura atomica di gruppo.'}
                </div>

                <CustomSelect style={iStyle}
                  value={txId}
                  onChange={u('transactionId')}>
                  <option value="">— nessuna (autocommit) —</option>
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
                      {activeTx!.onError === 'rollback_all'
                        ? 'Su errore: rollback dell\u2019intero gruppo.'
                        : 'Su errore: rollback solo di questo nodo.'}
                      {' '}Timeout {activeTx!.timeout}s. Configura nel tab Transazioni.
                    </span>
                  </div>
                )}

                {laneTransactions.length === 0 && (
                  <div style={{ marginTop: 8, fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>
                    Nessuna transazione nella lane. Creane una dal tab "Transazioni" del pannello proprietà.
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