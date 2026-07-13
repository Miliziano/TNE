import { useState } from 'react'
import { useFlowStore } from '../store/flowStore'
import { NODE_DEFS } from '../nodes/registry'
import { ResourcePanel } from './ResourcePanel'
import type { Variable, VariableType } from '../types'
import { BridgeTab } from './BridgeTab'
import { NODE_SIDEBAR_PANELS } from '../nodes/registry'
import { CustomSelect } from '../components/CustomSelect'
import { TransactionsTab } from './TransactionsTab'

type Tab = 'props' | 'lane-vars' | 'transactions' | 'bridge'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
const getPanelStyle = (expanded: boolean): React.CSSProperties => ({
  width: expanded ? 360 : 240, background: '#161b27',border: '0.5px solid #2a3349', borderRadius: 8,
  display: 'flex',
  flexDirection: 'column', flexShrink: 0, transition: 'width 0.2s ease',
})
const headerStyle: React.CSSProperties = {
  padding: '8px 12px', borderTop: '1px solid #2a3349', borderRadius: 8,
  fontSize: 10, fontWeight: 600, color: '#4a9eff',
  textTransform: 'uppercase', letterSpacing: '0.1em',
  flexShrink: 0, background: '#1a2030',
}
const emptyMsgStyle: React.CSSProperties = {
  padding: '24px 16px', color: '#4a5a7a', fontSize: 12,
  lineHeight: 1.6, textAlign: 'center',
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
    </div>
  )
}

function TabBar({ active, onChange }: { active: Tab; onChange: (t: Tab) => void }) {
  const tabs: { id: Tab; label: string; icon: string }[] = [
    { id: 'props',     label: 'Nodo',  icon: 'ti-settings' },
    { id: 'lane-vars', label: 'Lane',  icon: 'ti-variable' },
    { id: 'transactions', label: 'Transazioni', icon: 'ti-arrows-exchange' },
    { id: 'bridge',    label: 'Bridge', icon: 'ti-arrows-transfer-up' },
  ]
  return (
    <div style={{ display: 'flex', border: '1px solid #2a3349', flexShrink: 0, background: '#161b27' }}>
      {tabs.map((t) => (
        <button key={t.id} onClick={() => onChange(t.id)}
          style={{
            flex: 1, background: active === t.id ? '#1e2535' : 'transparent',
            border: 'none', borderBottom: active === t.id ? '2px solid #4a9eff' : '2px solid transparent',
            padding: '7px 4px', fontSize: 11,
            color: active === t.id ? '#c8d4f0' : '#4a5a7a',
            cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4,
            transition: 'all .15s',
          }}>
          <i className={`ti ${t.icon}`} style={{ fontSize: 12 }} aria-hidden="true" />
          {t.label}
        </button>
      ))}
    </div>
  )
}

// ─── Materialize variable chip ────────────────────────────────────
function MatVarChip({ variable, onDelete, onNavigate }: {
  variable: Variable
  onDelete: (id: string) => void
  onNavigate: (nodeId: string) => void
}) {
  const ACCENT = '#22d3ee'
  return (
    <div style={{
      margin: '4px 8px', padding: '8px 10px',
      background: `color-mix(in srgb, ${ACCENT} 6%, #1a2030)`,
      borderRadius: 6, border: `0.5px solid ${ACCENT}30`,
      display: 'flex', alignItems: 'center', gap: 8,
    }}>
      <span style={{ fontSize: 14, color: ACCENT, flexShrink: 0 }}>◈</span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: ACCENT, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {variable.name}
        </div>
        <div style={{ fontSize: 9, color: '#4a5a7a' }}>
          materialize · in-memory per esecuzione
        </div>
      </div>
      <button
        onClick={() => onNavigate(variable.value)}
        title="Vai al nodo"
        style={{ background: 'none', border: `1px solid ${ACCENT}40`, borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: ACCENT, fontSize: 10, flexShrink: 0 }}>
        <i className="ti ti-arrow-right" style={{ fontSize: 10 }} />
      </button>
      <button
        onClick={() => onDelete(variable.id)}
        title="Rimuovi dalla lane"
        style={{ background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '2px 6px', cursor: 'pointer', color: '#ff5f57', fontSize: 10, flexShrink: 0 }}>
        <i className="ti ti-x" style={{ fontSize: 10 }} />
      </button>
    </div>
  )
}

// ─── Variable editor ──────────────────────────────────────────────
function VariableEditor({
  variables, materializeVars = [], onAdd, onDelete, onUpdate,
  onDeleteMat, onNavigateMat, emptyMessage,
}: {
  variables:        Variable[]
  materializeVars?: Variable[]
  onAdd:            () => void
  onDelete:         (id: string) => void
  onUpdate:         (id: string, key: keyof Variable, value: string) => void
  onDeleteMat?:     (id: string) => void
  onNavigateMat?:   (nodeId: string) => void
  emptyMessage:     string
}) {
  const types: VariableType[] = ['string', 'number', 'boolean', 'json', 'object']

  // ── Live durante il run ──────────────────────────────────────────
  // Quando running === true, i valori delle variabili vengono
  // aggiornati in tempo reale da updateLaneVariable (chiamata dal
  // Proxy lane). Mostriamo badge read-only con indicatore pulsante
  // invece degli input editabili.
  const running = useFlowStore((s) => s.running)

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>

      {/* CSS animazione pulse — iniettato solo durante il run */}
      {running && (
        <style>{`
          @keyframes liveVarPulse {
            0%, 100% { opacity: 1; box-shadow: 0 0 6px #3ddc84; }
            50%       { opacity: 0.4; box-shadow: 0 0 2px #3ddc84; }
          }
          @keyframes liveValFlash {
            0%   { background: color-mix(in srgb, #3ddc84 20%, #0d1f0d); }
            100% { background: #0d1f0d; }
          }
        `}</style>
      )}

      {/* Banner live — visibile solo durante il run */}
      {running && variables.length > 0 && (
        <div style={{
          margin: '0 8px 8px', padding: '5px 10px',
          background: '#0d1f0d', borderRadius: 6,
          border: '1px solid #1d6d2060',
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 10, color: '#3ddc84',
        }}>
          <div style={{
            width: 7, height: 7, borderRadius: '50%',
            background: '#3ddc84', flexShrink: 0,
            animation: 'liveVarPulse 1.5s ease-in-out infinite',
          }} />
          Valori live — aggiornati in tempo reale dal runner
        </div>
      )}

      {/* Variabili materialize — sezione speciale */}
      {materializeVars.length > 0 && (
        <>
          <div style={{ padding: '4px 10px', fontSize: 9, fontWeight: 600, color: '#22d3ee', textTransform: 'uppercase', letterSpacing: '.08em', opacity: 0.7 }}>
            ◈ Materialize
          </div>
          {materializeVars.map((v) => (
            <MatVarChip
              key={v.id}
              variable={v}
              onDelete={(id) => onDeleteMat?.(id)}
              onNavigate={(nodeId) => onNavigateMat?.(nodeId)}
            />
          ))}
          {variables.length > 0 && (
            <div style={{ margin: '6px 8px 2px', borderTop: '0.5px solid #2a3349' }} />
          )}
        </>
      )}

      {/* Variabili normali */}
      {variables.length === 0 && materializeVars.length === 0 && (
        <div style={{ margin: '8px 12px', padding: '12px', fontSize: 11, color: '#4a5a7a', textAlign: 'center', background: '#1a2030', borderRadius: 6, border: '0.5px dashed #2a3349' }}>
          {emptyMessage}
        </div>
      )}
      {variables.length === 0 && materializeVars.length > 0 && (
        <div style={{ margin: '4px 12px', padding: '8px', fontSize: 10, color: '#2a3349', textAlign: 'center', fontStyle: 'italic' }}>
          Nessuna variabile normale
        </div>
      )}

      {variables.map((v) => (
        <div key={v.id} style={{
          margin: '4px 8px', padding: '8px',
          background: running ? 'color-mix(in srgb, #3ddc84 4%, #1a2030)' : '#1a2030',
          borderRadius: 6,
          border: running ? '0.5px solid #1d6d2060' : '0.5px solid #2a3349',
          transition: 'border-color .3s, background .3s',
        }}>

          {/* Riga nome + dot live + delete */}
          <div style={{ display: 'flex', gap: 4, marginBottom: 6, alignItems: 'center' }}>
            {/* Dot pulsante — solo durante il run */}
            {running && (
              <div style={{
                width: 6, height: 6, borderRadius: '50%',
                background: '#3ddc84', flexShrink: 0,
                animation: 'liveVarPulse 1.5s ease-in-out infinite',
              }} />
            )}
            <input
              value={v.name}
              onChange={(e) => onUpdate(v.id, 'name', e.target.value)}
              placeholder="nome"
              readOnly={running}
              style={{
                ...inputStyle, flex: 1,
                // Durante il run: aspetto read-only
                ...(running ? {
                  color: '#3ddc84',
                  background: 'transparent',
                  border: 'none',
                  fontWeight: 600,
                  cursor: 'default',
                  padding: '5px 0',
                } : {}),
              }}
            />
            {/* Delete — disabilitato durante il run */}
            {!running && (
              <button onClick={() => onDelete(v.id)}
                style={{ background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '0 6px', cursor: 'pointer', color: '#ff5f57', fontSize: 12 }}>
                <i className="ti ti-x" style={{ fontSize: 11 }} aria-hidden="true" />
              </button>
            )}
          </div>

          {/* Riga tipo + valore */}
          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>

            {/* Tipo — read-only durante il run */}
            {running ? (
              <div style={{
                width: 90, flexShrink: 0,
                fontSize: 9, padding: '4px 6px', borderRadius: 4,
                background: '#161b27', color: '#4a5a7a',
                border: '0.5px solid #2a3349',
                fontFamily: "'JetBrains Mono', monospace",
              }}>
                {v.type}
              </div>
            ) : (
              <CustomSelect value={v.type} onChange={(e) => onUpdate(v.id, 'type', e.target.value)}
                style={{ ...inputStyle, width: 90 }}>
                {types.map((t) => <option key={t} value={t}>{t}</option>)}
              </CustomSelect>
            )}

            {/* Valore — badge live durante il run, input editabile a riposo */}
            {running ? (
              <div style={{
                flex: 1, fontFamily: 'monospace', fontSize: 11,
                padding: '4px 8px', borderRadius: 4,
                background: '#0d1f0d',
                border: '1px solid #1d6d2060',
                color: '#3ddc84',
                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                minHeight: 28, display: 'flex', alignItems: 'center',
              }}>
                {v.value !== '' && v.value !== undefined
                  ? v.value
                  : <span style={{ color: '#2a3349', fontStyle: 'italic', fontSize: 10 }}>—</span>
                }
              </div>
            ) : (
              <input value={v.value} onChange={(e) => onUpdate(v.id, 'value', e.target.value)}
                placeholder="valore" style={{ ...inputStyle, flex: 1 }} />
            )}
          </div>
        </div>
      ))}

      {/* Aggiungi variabile — nascosto durante il run */}
      {!running && (
        <div style={{ padding: '6px 8px' }}>
          <button onClick={onAdd}
            style={{ width: '100%', background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 4, padding: '6px', fontSize: 11, color: '#4a9eff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}>
            <i className="ti ti-plus" style={{ fontSize: 12 }} aria-hidden="true" />
            Aggiungi variabile
          </button>
        </div>
      )}
    </div>
  )
}

// ─── PropertyPanel ────────────────────────────────────────────────
export function PropertyPanel() {
  const [activeTab, setActiveTab] = useState<Tab>('props')

  const nodes              = useFlowStore((s) => s.nodes)
  const selectedNodeId     = useFlowStore((s) => s.selectedNodeId)
  const selectedLaneId     = useFlowStore((s) => s.selectedLaneId)
  const selectedResourceId = useFlowStore((s) => s.selectedResourceId)
  const pool               = useFlowStore((s) => s.pool)
  const updateNodeProp     = useFlowStore((s) => s.updateNodeProp)
  const deleteNode         = useFlowStore((s) => s.deleteNode)
  const addVariable        = useFlowStore((s) => s.addVariable)
  const deleteVariable     = useFlowStore((s) => s.deleteVariable)
  const updateVariable     = useFlowStore((s) => s.updateVariable)
  const openNodeEditor     = useFlowStore((s) => s.openNodeEditor)
  const selectNode         = useFlowStore((s) => s.selectNode)
  const selectLane         = useFlowStore((s) => s.selectLane)

  const node        = nodes.find((n) => n.id === selectedNodeId)
  const def         = node ? NODE_DEFS[node.data.type] : null
  const currentLane = pool.lanes.find((l) => l.id === (node?.data.laneId ?? selectedLaneId))
  const isSpecial   = node?.data.type === 'lane_start' || node?.data.type === 'lane_end'
  const expanded    = !!node && !selectedResourceId

  const selectedResource = (() => {
    if (!selectedResourceId) return null
    for (const lane of pool.lanes) {
      const found = lane.resources.find((r) => r.id === selectedResourceId)
      if (found) return found
    }
    return null
  })()

  const resourceLaneId = (() => {
    if (!selectedResourceId) return null
    for (const lane of pool.lanes) {
      if (lane.resources.some((r) => r.id === selectedResourceId)) return lane.id
    }
    return null
  })()

  const navigateToMatNode = (nodeId: string) => {
    const matNode = nodes.find((n) => n.id === nodeId)
    if (!matNode) return
    selectNode(nodeId)
    selectLane(matNode.data.laneId)
    setActiveTab('props')
  }

  if (selectedResource && resourceLaneId) {
    return (
      <aside style={getPanelStyle(true)}>
        <div style={headerStyle}>Proprietà</div>
        <ResourcePanel resource={selectedResource} laneId={resourceLaneId} />
      </aside>
    )
  }

  return (
    <aside style={getPanelStyle(expanded)}>
      <div style={headerStyle}>Proprietà</div>
      <TabBar active={activeTab} onChange={setActiveTab} />

      {/* ── TAB: Nodo ── */}
      {activeTab === 'props' && (
        <>
          {!node || !def ? (
            <div style={emptyMsgStyle}>
              <i className="ti ti-cursor-text" style={{ fontSize: 28, display: 'block', marginBottom: 10, color: '#2a3349' }} aria-hidden="true" />
              Seleziona un nodo sul canvas per modificarne le proprietà.
            </div>
          ) : (
            <>
              <div style={{ padding: '10px 12px', borderBottom: '1px solid #2a3349', background: '#1a2030' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span style={{ fontSize: 16, color: def.color }}>{def.icon}</span>
                  <span style={{ fontSize: 13, fontWeight: 600, color: '#c8d4f0', flex: 1 }}>
                    {node.data.config?.displayName || def.label}
                  </span>
                  {!isSpecial && (
                    <button onClick={() => openNodeEditor(node.id)}
                      style={{ background: '#1a3a6a', border: '1px solid #2a5a9a', borderRadius: 4, padding: '3px 8px', cursor: 'pointer', fontSize: 11, color: '#4a9eff', display: 'flex', alignItems: 'center', gap: 4 }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a4a7a' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a3a6a' }}>
                      <i className="ti ti-edit" style={{ fontSize: 11 }} aria-hidden="true" />
                      Editor
                    </button>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#4a5a7a', fontFamily: 'monospace', marginBottom: 2 }}>{node.id}</div>
                <div style={{ fontSize: 10, color: '#4a5a7a', marginBottom: 4 }}>lane: {currentLane?.label ?? node.data.laneId}</div>
                <div style={{ fontSize: 11, color: '#9a9aaa', padding: '4px 8px', background: '#161b27', borderRadius: 4, border: '0.5px solid #2a3349' }}>
                  {def.description}
                </div>
                {node.data.config?.description && (
                  <div style={{ fontSize: 11, color: '#9a9aaa', marginTop: 4, fontStyle: 'italic', padding: '4px 8px', background: '#161b27', borderRadius: 4, border: '0.5px solid #2a3349' }}>
                    {node.data.config.description}
                  </div>
                )}
                {isSpecial && (
                  <div style={{ marginTop: 6, padding: '4px 8px', background: '#3d2a0a', color: '#ffb347', border: '0.5px solid #854f0b', borderRadius: 4, fontSize: 10, display: 'flex', alignItems: 'center', gap: 4 }}>
                    <i className="ti ti-lock" style={{ fontSize: 11 }} aria-hidden="true" />
                    Nodo obbligatorio — non eliminabile
                  </div>
                )}
              </div>

              <div style={{ overflowY: 'auto', flex: 1, padding: '8px 0' }}>
                {(() => {
                  const SidebarPanel = NODE_SIDEBAR_PANELS[node.data.type]
                  if (SidebarPanel) {
                    return (
                      <div style={{ padding: '8px' }}>
                        <SidebarPanel nodeId={node.id} />
                      </div>
                    )
                  }
                  return (
                    <>
                      {def.fields.map((field) => (
                        <div key={field.key} style={{ margin: '4px 8px' }}>
                          <Field label={field.label}>
                            {field.type === 'select' ? (
                              <CustomSelect value={node.data.props[field.key] ?? field.default}
                                onChange={(e) => updateNodeProp(node.id, field.key, e.target.value)}
                                style={inputStyle}>
                                {field.options?.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
                              </CustomSelect>
                            ) : field.type === 'code' ? (
                              <textarea value={node.data.props[field.key] ?? field.default}
                                onChange={(e) => updateNodeProp(node.id, field.key, e.target.value)}
                                rows={3} style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }} />
                            ) : field.type === 'password' ? (
                              <input type="password" value={node.data.props[field.key] ?? field.default}
                                onChange={(e) => updateNodeProp(node.id, field.key, e.target.value)}
                                style={inputStyle} />
                            ) : (
                              <input type={field.type === 'number' ? 'number' : 'text'}
                                value={node.data.props[field.key] ?? field.default}
                                onChange={(e) => updateNodeProp(node.id, field.key, e.target.value)}
                                style={inputStyle} />
                            )}
                          </Field>
                        </div>
                      ))}
                      {!isSpecial && (
                        <div style={{ margin: '8px', padding: '6px 10px', background: '#1a2030', borderRadius: 4, fontSize: 10, color: '#4a5a7a', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 5 }}>
                          <i className="ti ti-mouse" style={{ fontSize: 11 }} aria-hidden="true" />
                          Doppio click sul nodo per l'editor completo
                        </div>
                      )}
                    </>
                  )
                })()}
              </div>

              {!isSpecial && (
                <div style={{ padding: '8px', borderTop: '1px solid #2a3349', flexShrink: 0, background: '#1a2030' }}>
                  <button onClick={() => deleteNode(node.id)}
                    style={{ width: '100%', padding: '6px', background: 'rgba(255,95,87,0.08)', border: '1px solid rgba(255,95,87,0.22)', color: '#ff5f57', borderRadius: 4, cursor: 'pointer', fontSize: 12, fontFamily: 'inherit', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,95,87,0.16)' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'rgba(255,95,87,0.08)' }}>
                    <i className="ti ti-trash" style={{ fontSize: 12 }} aria-hidden="true" />
                    Elimina nodo
                  </button>
                </div>
              )}
            </>
          )}
        </>
      )}

      {/* ── TAB: Variabili Lane ── */}
      {activeTab === 'lane-vars' && (
        <>
          {!currentLane ? (
            <div style={emptyMsgStyle}>
              <i className="ti ti-hand-click" style={{ fontSize: 28, display: 'block', marginBottom: 10, color: '#2a3349' }} aria-hidden="true" />
              Clicca sul canvas di una lane per selezionarla.
            </div>
          ) : (
            <>
              <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 8, background: '#1a2030' }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: currentLane.color, flexShrink: 0 }} />
                <span style={{ fontSize: 12, fontWeight: 600, color: '#c8d4f0' }}>{currentLane.label}</span>
                <span style={{ fontSize: 10, marginLeft: 'auto', padding: '1px 8px', borderRadius: 8, background: '#1e2535', color: '#4a5a7a', border: '0.5px solid #2a3349' }}>
                  {currentLane.variables.length} var
                </span>
              </div>
              <VariableEditor
                variables={currentLane.variables.filter((v) => v.type !== 'materialize')}
                materializeVars={currentLane.variables.filter((v) => v.type === 'materialize')}
                emptyMessage="Nessuna variabile locale in questa lane."
                onAdd={() => addVariable('lane', currentLane.id, { name: 'nuova_var', type: 'string', value: '' })}
                onDelete={(id) => deleteVariable('lane', currentLane.id, id)}
                onUpdate={(id, key, value) => updateVariable('lane', currentLane.id, id, { [key]: value } as Partial<Variable>)}
                onDeleteMat={(id) => deleteVariable('lane', currentLane.id, id)}
                onNavigateMat={navigateToMatNode}
              />
            </>
          )}
        </>
      )}

     {/* ── TAB: Transazioni ── */}
      {activeTab === 'transactions' && <TransactionsTab />}

      {activeTab === 'bridge' && <BridgeTab />}
    </aside>
  )
}