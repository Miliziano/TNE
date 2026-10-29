/**
 * src/nodes/types/pivot/Panel.tsx
 */
import { useMemo, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { useMaterializeSchema } from '../../../nodes/useMaterializeSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#f97316'


const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}
function SectionTitle({ label, color = ACCENT }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

const AGG_FUNCTIONS = [
  { value: 'sum',   label: 'SUM — sum'         },
  { value: 'count', label: 'COUNT — count'    },
  { value: 'avg',   label: 'AVG — average'          },
  { value: 'max',   label: 'MAX — maximum'        },
  { value: 'min',   label: 'MIN — minimo'         },
  { value: 'first', label: 'FIRST — first value' },
  { value: 'last',  label: 'LAST — last value' },
]

interface PivotColumn { id: string; value: string; alias: string }

function PivotColumnEditor({ columns, onChange }: {
  columns:  PivotColumn[]
  onChange: (cols: PivotColumn[]) => void
}) {
  const add    = () => onChange([...columns, { id: `pc_${Date.now()}`, value: '', alias: '' }])
  const update = (id: string, key: keyof PivotColumn, val: string) =>
    onChange(columns.map((c) => c.id === id ? { ...c, [key]: val } : c))
  const remove = (id: string) => onChange(columns.filter((c) => c.id !== id))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {columns.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 24px', gap: 6, padding: '3px 6px' }}>
          {['Value in pivot field', 'Output column name', ''].map((h) => (
            <div key={h} style={{ fontSize: 9, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
          ))}
        </div>
      )}
      {columns.map((col) => (
        <div key={col.id} style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 24px', gap: 6, alignItems: 'center' }}>
          <input style={{ ...inputStyle, fontSize: 10, padding: '3px 6px', color: '#ffb347' }}
            value={col.value} onChange={(e) => update(col.id, 'value', e.target.value)}
            placeholder="gen" />
          <input style={{ ...inputStyle, fontSize: 10, padding: '3px 6px', color: ACCENT }}
            value={col.alias} onChange={(e) => update(col.id, 'alias', e.target.value)}
            placeholder="January (empty = use value)" />
          <button onClick={() => remove(col.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
            <i className="ti ti-x" style={{ fontSize: 10 }} />
          </button>
        </div>
      ))}
      <button onClick={add}
        style={{ padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`, color: ACCENT, border: `0.5px dashed ${ACCENT}60`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = ACCENT }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${ACCENT}60` }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Add pivot value
      </button>
    </div>
  )
}

export function PivotPanel({ nodeId }: { nodeId: string }) {
  // Guscio: il corpo chiama i suoi hook dopo aver letto il nodo, e con
  // un `return null` in mezzo il loro numero cambierebbe quando il nodo
  // viene eliminato (rules-of-hooks). Qui si decide se c'è, là si
  // chiamano sempre tutti.
  const exists = useFlowStore((s) => s.nodes.some((n) => n.id === nodeId))
  return exists ? <PivotPanelBody nodeId={nodeId} /> : null
}

function PivotPanelBody({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))!
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)


  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const mode       = p('pivotMode',  'pivot')   // 'pivot' | 'unpivot'
  const pivotType  = p('pivotType',  'static')  // 'static' | 'dynamic'
  const dataSource = p('dataSource', 'flow')    // 'flow' | 'materialize'
  const matName    = p('materializeName', '')
  const laneId     = node.data.laneId

  // Variabili Materialize disponibili nella lane
  const materializeVars = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'materialize')
  }, [pool, laneId])

  // Schema — da flusso o da Materialize
  const flowFields = useIncomingSchema(nodeId)
  const matFields  = useMaterializeSchema(nodeId, matName)
  const activeFields = dataSource === 'materialize' ? matFields : flowFields

  // Colonne pivot statiche
  const pivotColumns: PivotColumn[] = useMemo(() => {
    try { return JSON.parse(p('pivotColumns', '[]')) }
    catch { return [] }
  }, [p('pivotColumns')])
  const savePivotColumns = (cols: PivotColumn[]) =>
    updateProp(nodeId, 'pivotColumns', JSON.stringify(cols))

  // Colonne unpivot selezionate
  const unpivotSelected: string[] = useMemo(() => {
    try { return JSON.parse(p('unpivotColumns', '[]')) }
    catch { return [] }
  }, [p('unpivotColumns')])
  const toggleUnpivotColumn = (name: string) => {
    const next = unpivotSelected.includes(name)
      ? unpivotSelected.filter((n) => n !== name)
      : [...unpivotSelected, name]
    updateProp(nodeId, 'unpivotColumns', JSON.stringify(next))
  }

  // ── outputSchema ──────────────────────────────────────────────
  useEffect(() => {
    if (mode === 'pivot') {
      if (pivotType === 'dynamic') {
        updateProp(nodeId, 'outputSchema', JSON.stringify([
          { id: 'pivot_dynamic_warning', name: '__pivot_dynamic__', type: 'any', physicalName: '__pivot_dynamic__' }
        ]))
        return
      }
      const identityFields = p('identityField')
        .split(',').map((s: string) => s.trim()).filter(Boolean)
        .map((name: string) => {
          const f = activeFields.find((f) => f.name === name)
          return { id: `pv_id_${name}`, name, type: f?.type ?? 'string', physicalName: name }
        })
      const colFields = pivotColumns.map((col) => {
        const colName = col.alias || col.value
        return { id: `pv_col_${col.id}`, name: colName, type: 'decimal', physicalName: colName }
      })
      updateProp(nodeId, 'outputSchema', JSON.stringify([...identityFields, ...colFields]))
    }

    if (mode === 'unpivot') {
      const keyField   = p('unpivotKeyField',   'chiave')
      const valueField = p('unpivotValueField', 'valore')
      const fixedFields = activeFields
        .filter((f) => !unpivotSelected.includes(f.name))
        .map((f) => ({ id: `upv_fix_${f.name}`, name: f.name, type: f.type, physicalName: f.name }))
      const valueType = unpivotSelected.length > 0
        ? (activeFields.find((f) => f.name === unpivotSelected[0])?.type ?? 'any')
        : 'any'
      updateProp(nodeId, 'outputSchema', JSON.stringify([
        ...fixedFields,
        { id: 'upv_key',   name: keyField,   type: 'string',    physicalName: keyField   },
        { id: 'upv_value', name: valueField,  type: valueType,   physicalName: valueField },
      ]))
    }
  }, [
    mode, pivotType, dataSource, p('identityField'), p('valueField'), p('aggFn'),
    pivotColumns.map((c) => c.id + c.alias).join(','),
    unpivotSelected.join(','),
    p('unpivotKeyField'), p('unpivotValueField'),
    activeFields.map((f) => f.name).join(','),
  ])

  // ── Field selector helper ─────────────────────────────────────
  // Funzione di render, non un componente: un componente dichiarato qui
  // dentro cambia identità a ogni render e il campo perderebbe il fuoco
  // a ogni tasto (react-hooks/static-components).
  const fieldSelect = (propKey: string, placeholder: string) =>
    activeFields.length > 0 ? (
      <CustomSelect style={inputStyle} value={p(propKey)} onChange={u(propKey)}>
        <option value="">— select —</option>
        {activeFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
      </CustomSelect>
    ) : (
      <input style={inputStyle} value={p(propKey)} onChange={u(propKey)} placeholder={placeholder} />
    )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Modalità Pivot / Unpivot */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {[
          { value: 'pivot',   label: '⊞ Pivot',   desc: 'Rows → Columns', detail: 'Distinct values of a field become columns' },
          { value: 'unpivot', label: '⊟ Unpivot', desc: 'Columns → Rows',  detail: 'Multiple columns collapsed into key/value pairs' },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'pivotMode', m.value)}
            style={{ padding: '10px 12px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: mode === m.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030', border: mode === m.value ? `1.5px solid ${ACCENT}` : '1px solid #2a3349' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: mode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</div>
            <div style={{ fontSize: 10, color: mode === m.value ? ACCENT : '#4a9eff', fontWeight: 600 }}>{m.desc}</div>
            <div style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{m.detail}</div>
          </button>
        ))}
      </div>

      {/* ── Sorgente dati ── */}
      <SectionTitle label="Data source" color="#22d3ee" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value:    'flow',
            label:    '→ From flow',
            desc:     'Receives rows via edge — buffers internally, then computes.',
            disabled: false,
          },
          {
            value:    'materialize',
            label:    '◈ Da Materialize',
            desc:     'The incoming row is a trigger. Data is read from the selected Materialize.',
            disabled: materializeVars.length === 0,
            hint:     materializeVars.length === 0 ? 'No Materialize published in this lane' : undefined,
          },
        ].map((s) => (
          <button key={s.value}
            onClick={() => { if (!s.disabled) updateProp(nodeId, 'dataSource', s.value) }}
            style={{
              padding: '8px 12px', borderRadius: 6, cursor: s.disabled ? 'not-allowed' : 'pointer',
              opacity: s.disabled ? 0.4 : 1, textAlign: 'left',
              background: dataSource === s.value ? 'color-mix(in srgb, #22d3ee 10%, #1a2030)' : '#1a2030',
              border: dataSource === s.value ? '1px solid #22d3ee60' : '1px solid #2a3349',
              display: 'flex', alignItems: 'center', gap: 10,
            }}>
            <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, background: dataSource === s.value ? '#22d3ee' : 'transparent', border: `1.5px solid ${dataSource === s.value ? '#22d3ee' : '#2a3349'}` }} />
            <div>
              <div style={{ fontSize: 11, fontWeight: 600, color: dataSource === s.value ? '#22d3ee' : '#c8d4f0' }}>{s.label}</div>
              <div style={{ fontSize: 9, color: '#8593b5' }}>{(s as any).hint ?? s.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Selettore Materialize */}
      {dataSource === 'materialize' && (
        <>
          <Field label="Source Materialize" hint="Must already be populated when this node is activated">
            <CustomSelect style={inputStyle} value={matName} onChange={u('materializeName')}>
              <option value="">— select —</option>
              {materializeVars.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
            </CustomSelect>
          </Field>
          {matName && matFields.length > 0 && (
            <div style={{ padding: '5px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #22d3ee20', fontSize: 9, color: '#8593b5', display: 'flex', gap: 5, alignItems: 'center' }}>
              <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
              dataset <code style={{ color: '#22d3ee' }}>{matName}</code>
              — {matFields.length} campi disponibili
            </div>
          )}
          {matName && matFields.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
              Il Materialize "{matName}" has not received any fields yet.
            </div>
          )}

        </>
      )}

      {/* ══ PIVOT ══════════════════════════════════════════════════ */}
      {mode === 'pivot' && (
        <>
          {/* Esempio visivo */}
          <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 9, fontFamily: 'monospace', color: '#8593b5', lineHeight: 1.8 }}>
            <div style={{ color: '#4a9eff', marginBottom: 4, fontFamily: 'sans-serif', fontSize: 10, fontWeight: 600 }}>Example</div>
            <div>{'{ year:2023, month:"jan", amount:100 }'}</div>
            <div>{'{ year:2023, month:"feb", amount:150 }'}</div>
            <div style={{ color: ACCENT, margin: '4px 0' }}>↓ PIVOT on month · SUM(amount)</div>
            <div style={{ color: '#3ddc84' }}>{'{ year:2023, jan:100, feb:150 }'}</div>
          </div>

          <SectionTitle label="Pivot type" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              { value: 'static',  label: 'Static',  desc: 'Columns defined manually — schema known at design time' },
              { value: 'dynamic', label: 'Dynamic', desc: 'Columns from distinct values at runtime — schema not propagable' },
            ].map((t) => (
              <button key={t.value} onClick={() => updateProp(nodeId, 'pivotType', t.value)}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: pivotType === t.value ? `color-mix(in srgb, ${ACCENT} 10%, #1a2030)` : '#1a2030', border: pivotType === t.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: pivotType === t.value ? ACCENT : '#c8d4f0' }}>{t.label}</div>
                <div style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.4 }}>{t.desc}</div>
              </button>
            ))}
          </div>

          {pivotType === 'dynamic' && (
            <div style={{ padding: '8px 12px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34740', fontSize: 10, color: '#ffb347', lineHeight: 1.5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 11, marginRight: 6 }} />
              Dynamic Pivot requires an <strong>upstream Materialize</strong> containing all the distinct values of the pivot field.
              The output schema <strong>is not propagable at design time</strong>.
            </div>
          )}

          <SectionTitle label="Fields" />

          <Field label="Identity field (GROUP BY)" hint="Fields that remain as fixed columns — comma-separated">
            {activeFields.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input style={inputStyle} value={p('identityField')} onChange={u('identityField')} placeholder="year, region" />
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 3 }}>
                  {activeFields.map((f) => {
                    const selected = p('identityField').split(',').map((s: string) => s.trim()).includes(f.name)
                    return (
                      <button key={f.name}
                        onClick={() => {
                          const cur  = p('identityField').split(',').map((s: string) => s.trim()).filter(Boolean)
                          const next = selected ? cur.filter((n: string) => n !== f.name) : [...cur, f.name]
                          updateProp(nodeId, 'identityField', next.join(', '))
                        }}
                        style={{ padding: '1px 7px', fontSize: 10, borderRadius: 8, cursor: 'pointer', background: selected ? `color-mix(in srgb, ${ACCENT} 15%, #0f1117)` : '#1a2030', color: selected ? ACCENT : '#8593b5', border: selected ? `1px solid ${ACCENT}40` : '1px solid #2a3349', fontFamily: 'monospace' }}>
                        {f.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <input style={inputStyle} value={p('identityField')} onChange={u('identityField')} placeholder="year, region" />
            )}
          </Field>

          <Row>
            <Field label="Pivot field" hint="The distinct values become columns">
              {fieldSelect('pivotField', 'month')}
            </Field>
            <Field label="Value field" hint="The data that goes into the cell">
              {fieldSelect('valueField', 'amount')}
            </Field>
          </Row>

          <Row>
            <Field label="Cell aggregation function">
              <CustomSelect style={inputStyle} value={p('aggFn', 'sum')} onChange={u('aggFn')}>
                {AGG_FUNCTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </CustomSelect>
            </Field>
            <Field label="Null cell value" hint="Default value if the cell has no data">
              <input style={inputStyle} value={p('nullValue', '0')} onChange={u('nullValue')} placeholder="0" />
            </Field>
          </Row>

          {/* Colonne pivot statiche */}
          {pivotType === 'static' && (
            <>
              <SectionTitle label="Output columns" />
              {pivotColumns.length === 0 && (
                <div style={{ padding: '8px 10px', fontSize: 10, color: '#8593b5', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
                  Add the distinct values of the pivot field to use as columns.
                </div>
              )}
              <PivotColumnEditor columns={pivotColumns} onChange={savePivotColumns} />
            </>
          )}

          {/* Pivot dinamico — colonne dai valori distinti dei dati (P367) */}
          {pivotType === 'dynamic' && (
            <>
              <div style={{ padding: '6px 10px', fontSize: 9, color: '#8593b5', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', lineHeight: 1.5 }}>
                Dynamic pivot: the columns are the distinct values of the pivot field,
                collected from the data itself (non-null values, ordered by "Pivot columns order").
              </div>
            </>
          )}

          <SectionTitle label="Options" color="#4a9eff" />
          <Row>
            <Field label="Pivot columns order">
              <CustomSelect style={inputStyle} value={p('pivotSort', 'asc')} onChange={u('pivotSort')}>
                <option value="asc">Ascending (A→Z, 1→9)</option>
                <option value="desc">Descending (Z→A, 9→1)</option>
                <option value="natural">Natural (data order)</option>
              </CustomSelect>
            </Field>
            <Field label="Row total">
              <CustomSelect style={inputStyle} value={p('addRowTotal', 'false')} onChange={u('addRowTotal')}>
                <option value="false">No</option>
                <option value="true">Yes — add total column</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {/* ══ UNPIVOT ════════════════════════════════════════════════ */}
      {mode === 'unpivot' && (
        <>
          <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 9, fontFamily: 'monospace', color: '#8593b5', lineHeight: 1.8 }}>
            <div style={{ color: '#4a9eff', marginBottom: 4, fontFamily: 'sans-serif', fontSize: 10, fontWeight: 600 }}>Example</div>
            <div>{'{ product:"A", north:100, south:80, west:60 }'}</div>
            <div style={{ color: ACCENT, margin: '4px 0' }}>↓ UNPIVOT columns north, south, west</div>
            <div style={{ color: '#3ddc84' }}>{'{ product:"A", region:"north", value:100 }'}</div>
            <div style={{ color: '#3ddc84' }}>{'{ product:"A", region:"south", value:80  }'}</div>
          </div>

          <SectionTitle label="Output fields" />
          <Row>
            <Field label="Key field name" hint="Will contain the name of the original column">
              <input style={{ ...inputStyle, color: '#4a9eff' }} value={p('unpivotKeyField', 'chiave')} onChange={u('unpivotKeyField')} placeholder="key" />
            </Field>
            <Field label="Value field name" hint="Will contain the value of the original column">
              <input style={{ ...inputStyle, color: '#3ddc84' }} value={p('unpivotValueField', 'valore')} onChange={u('unpivotValueField')} placeholder="value" />
            </Field>
          </Row>

          <SectionTitle label="Columns to rotate into rows" />
          {activeFields.length === 0 ? (
            <div style={{ padding: '16px', textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
              <i className="ti ti-plug-connected-x" style={{ fontSize: 20, display: 'block', marginBottom: 6 }} />
              {dataSource === 'materialize' ? `The Materialize "${matName || '—'}" has not received any fields yet.` : 'Connect an input node.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <button onClick={() => updateProp(nodeId, 'unpivotColumns', JSON.stringify(activeFields.map((f) => f.name)))}
                  style={{ flex: 1, padding: '4px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`, color: ACCENT, border: `0.5px solid ${ACCENT}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <i className="ti ti-checks" style={{ fontSize: 10 }} /> Select all
                </button>
                <button onClick={() => updateProp(nodeId, 'unpivotColumns', '[]')}
                  style={{ flex: 1, padding: '4px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#8593b5', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <i className="ti ti-square" style={{ fontSize: 10 }} /> Deselect all
                </button>
              </div>
              <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 70px 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
                  {['✓', 'Field', 'Type', 'Role'].map((h) => (
                    <div key={h} style={{ fontSize: 9, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
                  ))}
                </div>
                {activeFields.map((f, i, arr) => {
                  const isSelected = unpivotSelected.includes(f.name)
                  return (
                    <div key={f.name}
                      style={{ display: 'grid', gridTemplateColumns: '28px 1fr 70px 80px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center', cursor: 'pointer', opacity: isSelected ? 1 : 0.6 }}
                      onClick={() => toggleUnpivotColumn(f.name)}>
                      <div style={{ width: 16, height: 16, borderRadius: 3, border: `1.5px solid ${isSelected ? ACCENT : '#2a3349'}`, background: isSelected ? `color-mix(in srgb, ${ACCENT} 20%, #0f1117)` : 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        {isSelected && <i className="ti ti-check" style={{ fontSize: 9, color: ACCENT }} />}
                      </div>
                      <code style={{ fontFamily: 'monospace', fontSize: 11, color: isSelected ? ACCENT : '#c8d4f0' }}>{f.name}</code>
                      <span style={{ fontSize: 9, color: '#8593b5' }}>{f.type}</span>
                      <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, textAlign: 'center', background: isSelected ? `color-mix(in srgb, ${ACCENT} 12%, #0f1117)` : '#0d3d20', color: isSelected ? ACCENT : '#3ddc84', border: `0.5px solid ${isSelected ? ACCENT : '#1d6d40'}30` }}>
                        {isSelected ? '→ rows' : 'fixed'}
                      </span>
                    </div>
                  )
                })}
              </div>
              {unpivotSelected.length > 0 && (
                <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic', padding: '4px 6px' }}>
                  {unpivotSelected.length} colonne → righe · {activeFields.length - unpivotSelected.length} fisse
                </div>
              )}
            </>
          )}

          <SectionTitle label="Options" color="#4a9eff" />
          <Row>
            <Field label="Null values">
              <CustomSelect style={inputStyle} value={p('unpivotNullMode', 'exclude')} onChange={u('unpivotNullMode')}>
                <option value="exclude">Exclude rows with null</option>
                <option value="include">Include rows with null</option>
                <option value="zero">Replace null with 0</option>
              </CustomSelect>
            </Field>
            <Field label="Output rows order">
              <CustomSelect style={inputStyle} value={p('unpivotOrder', 'identity_first')} onChange={u('unpivotOrder')}>
                <option value="identity_first">By identity, then key</option>
                <option value="key_first">By key, then identity</option>
                <option value="natural">Natural (column by column)</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {/* Schema output */}
      {(() => {
        // Il parse sta fuori dal JSX: un try attorno al JSX non cattura gli
        // errori di render (react-hooks/error-boundaries).
        let schema: any[] = []
        try { const parsed = JSON.parse(p('outputSchema', '[]')); if (Array.isArray(parsed)) schema = parsed } catch { /* schema illeggibile */ }
          if (schema.length === 0) return null
          if (schema[0]?.name === '__pivot_dynamic__') {
            return (
              <div style={{ padding: '8px 12px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34740', fontSize: 10, color: '#ffb347' }}>
                <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 6 }} />
                Output schema determined at runtime — not propagated at design time.
              </div>
            )
          }
          return (
            <>
              <SectionTitle label="Schema output" color="#22d3ee" />
              <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
                  {['Field', 'Type', 'Origin'].map((h) => (
                    <div key={h} style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
                  ))}
                </div>
                {schema.map((f: any, i: number, arr: any[]) => {
                  const isPivotCol  = mode === 'pivot'   && pivotColumns.some((c) => (c.alias || c.value) === f.name)
                  const isKeyOrVal  = mode === 'unpivot' && (f.id === 'upv_key' || f.id === 'upv_value')
                  const color       = isPivotCol ? ACCENT : isKeyOrVal ? '#4a9eff' : '#9a9aaa'
                  const badge       = isPivotCol ? 'pivot' : isKeyOrVal ? (f.id === 'upv_key' ? 'key' : 'value') : 'fixed'
                  const badgeColor  = isPivotCol ? ACCENT : isKeyOrVal ? '#4a9eff' : '#8593b5'
                  return (
                    <div key={f.id ?? f.name}
                      style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                      <code style={{ fontFamily: 'monospace', fontSize: 11, color }}>{f.name}</code>
                      <span style={{ fontSize: 9, color: '#8593b5' }}>{f.type}</span>
                      <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, ${badgeColor} 12%, #0f1117)`, color: badgeColor, border: `0.5px solid ${badgeColor}30`, textAlign: 'center' }}>
                        {badge}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div style={{ fontSize: 9, color: '#8593b5', fontStyle: 'italic', display: 'flex', gap: 5 }}>
                <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
                Schema propagated automatically to downstream nodes.
              </div>
            </>
          )
      })()}

    </div>
  )
}
