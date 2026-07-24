/**
 * src/nodes/types/pivot/Panel.tsx
 */
import { useMemo, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { useMaterializeSchema } from '../../../nodes/useMaterializeSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#f97316'

const ACCESS_OPTIONS = [
  { value: 'dataset',  label: 'Dataset — .toDataset() (consigliato — List completa, zero buffering aggiuntivo)' },
  { value: 'iterator', label: 'Iterator — .values() (riga per riga con buffering interno)' },
]

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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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
  { value: 'sum',   label: 'SUM — somma'         },
  { value: 'count', label: 'COUNT — conteggio'    },
  { value: 'avg',   label: 'AVG — media'          },
  { value: 'max',   label: 'MAX — massimo'        },
  { value: 'min',   label: 'MIN — minimo'         },
  { value: 'first', label: 'FIRST — primo valore' },
  { value: 'last',  label: 'LAST — ultimo valore' },
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
          {['Valore nel campo pivot', 'Nome colonna output', ''].map((h) => (
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
            placeholder="Gennaio (vuoto = usa valore)" />
          <button onClick={() => remove(col.id)}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            <i className="ti ti-x" style={{ fontSize: 10 }} />
          </button>
        </div>
      ))}
      <button onClick={add}
        style={{ padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`, color: ACCENT, border: `0.5px dashed ${ACCENT}60`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = ACCENT }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = `${ACCENT}60` }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Aggiungi valore pivot
      </button>
    </div>
  )
}

export function PivotPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const mode       = p('pivotMode',  'pivot')   // 'pivot' | 'unpivot'
  const pivotType  = p('pivotType',  'static')  // 'static' | 'dynamic'
  const dataSource = p('dataSource', 'flow')    // 'flow' | 'materialize'
  const matName    = p('materializeName', '')
  const accessMode = p('accessMode', 'dataset')   // ← definito qui
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
  const FieldSelect = ({ propKey, placeholder }: { propKey: string; placeholder: string }) =>
    activeFields.length > 0 ? (
      <CustomSelect style={inputStyle} value={p(propKey)} onChange={u(propKey)}>
        <option value="">— seleziona —</option>
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
          { value: 'pivot',   label: '⊞ Pivot',   desc: 'Righe → Colonne', detail: 'Valori distinti di un campo diventano colonne' },
          { value: 'unpivot', label: '⊟ Unpivot', desc: 'Colonne → Righe',  detail: 'Più colonne collassate in coppie chiave/valore' },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'pivotMode', m.value)}
            style={{ padding: '10px 12px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: mode === m.value ? `color-mix(in srgb, ${ACCENT} 12%, #1a2030)` : '#1a2030', border: mode === m.value ? `1.5px solid ${ACCENT}` : '1px solid #2a3349' }}>
            <div style={{ fontSize: 12, fontWeight: 700, color: mode === m.value ? ACCENT : '#c8d4f0' }}>{m.label}</div>
            <div style={{ fontSize: 10, color: mode === m.value ? ACCENT : '#4a9eff', fontWeight: 600 }}>{m.desc}</div>
            <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{m.detail}</div>
          </button>
        ))}
      </div>

      {/* ── Sorgente dati ── */}
      <SectionTitle label="Sorgente dati" color="#22d3ee" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value:    'flow',
            label:    '→ Da flusso',
            desc:     'Riceve righe via edge — bufferizza internamente, poi calcola.',
            disabled: false,
          },
          {
            value:    'materialize',
            label:    '◈ Da Materialize',
            desc:     'La riga in ingresso è trigger. I dati vengono letti dal Materialize selezionato.',
            disabled: materializeVars.length === 0,
            hint:     materializeVars.length === 0 ? 'Nessun Materialize pubblicato in questa lane' : undefined,
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
              <div style={{ fontSize: 9, color: '#4a5a7a' }}>{(s as any).hint ?? s.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Selettore Materialize */}
      {dataSource === 'materialize' && (
        <>
          <Field label="Materialize sorgente" hint="Deve essere già popolato quando questo nodo viene attivato">
            <CustomSelect style={inputStyle} value={matName} onChange={u('materializeName')}>
              <option value="">— seleziona —</option>
              {materializeVars.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
            </CustomSelect>
          </Field>
          {matName && matFields.length > 0 && (
            <div style={{ padding: '5px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #22d3ee20', fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 5, alignItems: 'center' }}>
              <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
              dataset <code style={{ color: '#22d3ee' }}>{matName}</code>
              — {matFields.length} campi disponibili
            </div>
          )}
          {matName && matFields.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
              Il Materialize "{matName}" non ha ancora ricevuto campi.
            </div>
          )}
          {/* accessMode — come Aggregate accede al Materialize */}
          {matName && (
            <Field label="Modalità accesso al Materialize" hint="Determina come il codegen legge i dati dal Materialize">
              <CustomSelect style={inputStyle} value={accessMode} onChange={u('accessMode')}>
                {ACCESS_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </CustomSelect>
              <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 4, fontStyle: 'italic' }}>
                {accessMode === 'dataset'  && '→ legge in blocco il dataset ' + matName + ' — nessun buffering aggiuntivo nel nodo'}
                {accessMode === 'iterator' && '→ legge il dataset ' + matName + ' riga per riga, bufferizzando internamente per gruppo'}
              </div>
            </Field>
          )}

        </>
      )}

      {/* ══ PIVOT ══════════════════════════════════════════════════ */}
      {mode === 'pivot' && (
        <>
          {/* Esempio visivo */}
          <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 9, fontFamily: 'monospace', color: '#4a5a7a', lineHeight: 1.8 }}>
            <div style={{ color: '#4a9eff', marginBottom: 4, fontFamily: 'sans-serif', fontSize: 10, fontWeight: 600 }}>Esempio</div>
            <div>{'{ anno:2023, mese:"gen", importo:100 }'}</div>
            <div>{'{ anno:2023, mese:"feb", importo:150 }'}</div>
            <div style={{ color: ACCENT, margin: '4px 0' }}>↓ PIVOT su mese · SUM(importo)</div>
            <div style={{ color: '#3ddc84' }}>{'{ anno:2023, gen:100, feb:150 }'}</div>
          </div>

          <SectionTitle label="Tipo di pivot" />
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
            {[
              { value: 'static',  label: 'Statico',  desc: 'Colonne definite manualmente — schema noto a design time' },
              { value: 'dynamic', label: 'Dinamico', desc: 'Colonne dai valori distinti a runtime — schema non propagabile' },
            ].map((t) => (
              <button key={t.value} onClick={() => updateProp(nodeId, 'pivotType', t.value)}
                style={{ padding: '8px 10px', borderRadius: 6, cursor: 'pointer', textAlign: 'left', display: 'flex', flexDirection: 'column', gap: 3, background: pivotType === t.value ? `color-mix(in srgb, ${ACCENT} 10%, #1a2030)` : '#1a2030', border: pivotType === t.value ? `1px solid ${ACCENT}60` : '1px solid #2a3349' }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: pivotType === t.value ? ACCENT : '#c8d4f0' }}>{t.label}</div>
                <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.4 }}>{t.desc}</div>
              </button>
            ))}
          </div>

          {pivotType === 'dynamic' && (
            <div style={{ padding: '8px 12px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34740', fontSize: 10, color: '#ffb347', lineHeight: 1.5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 11, marginRight: 6 }} />
              Il Pivot dinamico richiede un <strong>Materialize a monte</strong> che contenga tutti i valori distinti del campo pivot.
              Lo schema in uscita <strong>non è propagabile a design time</strong>.
            </div>
          )}

          <SectionTitle label="Campi" />

          <Field label="Campo identità (GROUP BY)" hint="Campi che rimangono come colonne fisse — virgola separati">
            {activeFields.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                <input style={inputStyle} value={p('identityField')} onChange={u('identityField')} placeholder="anno, regione" />
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
                        style={{ padding: '1px 7px', fontSize: 10, borderRadius: 8, cursor: 'pointer', background: selected ? `color-mix(in srgb, ${ACCENT} 15%, #0f1117)` : '#1a2030', color: selected ? ACCENT : '#4a5a7a', border: selected ? `1px solid ${ACCENT}40` : '1px solid #2a3349', fontFamily: 'monospace' }}>
                        {f.name}
                      </button>
                    )
                  })}
                </div>
              </div>
            ) : (
              <input style={inputStyle} value={p('identityField')} onChange={u('identityField')} placeholder="anno, regione" />
            )}
          </Field>

          <Row>
            <Field label="Campo pivot" hint="I valori distinti diventano colonne">
              <FieldSelect propKey="pivotField" placeholder="mese" />
            </Field>
            <Field label="Campo valore" hint="Il dato che va nella cella">
              <FieldSelect propKey="valueField" placeholder="importo" />
            </Field>
          </Row>

          <Row>
            <Field label="Funzione aggregazione cella">
              <CustomSelect style={inputStyle} value={p('aggFn', 'sum')} onChange={u('aggFn')}>
                {AGG_FUNCTIONS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
              </CustomSelect>
            </Field>
            <Field label="Valore celle null" hint="Valore default se la cella non ha dati">
              <input style={inputStyle} value={p('nullValue', '0')} onChange={u('nullValue')} placeholder="0" />
            </Field>
          </Row>

          {/* Colonne pivot statiche */}
          {pivotType === 'static' && (
            <>
              <SectionTitle label="Colonne output" />
              {pivotColumns.length === 0 && (
                <div style={{ padding: '8px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
                  Aggiungi i valori distinti del campo pivot da usare come colonne.
                </div>
              )}
              <PivotColumnEditor columns={pivotColumns} onChange={savePivotColumns} />
            </>
          )}

          {/* Pivot dinamico — Materialize per i valori distinti */}
          {pivotType === 'dynamic' && dataSource === 'flow' && (
            <>
              <SectionTitle label="Materialize valori distinti" />
              <div style={{ padding: '6px 10px', fontSize: 9, color: '#4a5a7a', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', lineHeight: 1.5 }}>
                Per il pivot dinamico servono due Materialize:
                <br />1. <code style={{ color: '#22d3ee' }}>DISTINCT_VALUES</code> — raccoglie i valori distinti del campo pivot
                <br />2. <code style={{ color: '#22d3ee' }}>DATA</code> — contiene i dati da pivotare
                <br />Pattern: <code style={{ color: ACCENT }}>Source → Mat(pass) → [signal] → Pivot(da Mat)</code>
              </div>
              <Field label="Materialize valori distinti del campo pivot">
                {materializeVars.length > 0 ? (
                  <CustomSelect style={inputStyle} value={p('distinctValuesMat')} onChange={u('distinctValuesMat')}>
                    <option value="">— seleziona —</option>
                    {materializeVars.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
                  </CustomSelect>
                ) : (
                  <input style={inputStyle} value={p('distinctValuesMat')} onChange={u('distinctValuesMat')} placeholder="nome_materialize_distinct" />
                )}
              </Field>
            </>
          )}

          <SectionTitle label="Opzioni" color="#4a9eff" />
          <Row>
            <Field label="Ordinamento colonne pivot">
              <CustomSelect style={inputStyle} value={p('pivotSort', 'asc')} onChange={u('pivotSort')}>
                <option value="asc">Ascendente (A→Z, 1→9)</option>
                <option value="desc">Discendente (Z→A, 9→1)</option>
                <option value="natural">Naturale (ordine dati)</option>
              </CustomSelect>
            </Field>
            <Field label="Totale riga">
              <CustomSelect style={inputStyle} value={p('addRowTotal', 'false')} onChange={u('addRowTotal')}>
                <option value="false">No</option>
                <option value="true">Sì — aggiungi colonna totale</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {/* ══ UNPIVOT ════════════════════════════════════════════════ */}
      {mode === 'unpivot' && (
        <>
          <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 9, fontFamily: 'monospace', color: '#4a5a7a', lineHeight: 1.8 }}>
            <div style={{ color: '#4a9eff', marginBottom: 4, fontFamily: 'sans-serif', fontSize: 10, fontWeight: 600 }}>Esempio</div>
            <div>{'{ prodotto:"A", nord:100, sud:80, ovest:60 }'}</div>
            <div style={{ color: ACCENT, margin: '4px 0' }}>↓ UNPIVOT colonne nord, sud, ovest</div>
            <div style={{ color: '#3ddc84' }}>{'{ prodotto:"A", regione:"nord", valore:100 }'}</div>
            <div style={{ color: '#3ddc84' }}>{'{ prodotto:"A", regione:"sud",  valore:80  }'}</div>
          </div>

          <SectionTitle label="Campi output" />
          <Row>
            <Field label="Nome campo chiave" hint="Conterrà il nome della colonna originale">
              <input style={{ ...inputStyle, color: '#4a9eff' }} value={p('unpivotKeyField', 'chiave')} onChange={u('unpivotKeyField')} placeholder="chiave" />
            </Field>
            <Field label="Nome campo valore" hint="Conterrà il valore della colonna originale">
              <input style={{ ...inputStyle, color: '#3ddc84' }} value={p('unpivotValueField', 'valore')} onChange={u('unpivotValueField')} placeholder="valore" />
            </Field>
          </Row>

          <SectionTitle label="Colonne da ruotare in righe" />
          {activeFields.length === 0 ? (
            <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
              <i className="ti ti-plug-connected-x" style={{ fontSize: 20, display: 'block', marginBottom: 6 }} />
              {dataSource === 'materialize' ? `Il Materialize "${matName || '—'}" non ha ancora ricevuto campi.` : 'Collega un nodo in ingresso.'}
            </div>
          ) : (
            <>
              <div style={{ display: 'flex', gap: 6, marginBottom: 4 }}>
                <button onClick={() => updateProp(nodeId, 'unpivotColumns', JSON.stringify(activeFields.map((f) => f.name)))}
                  style={{ flex: 1, padding: '4px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`, color: ACCENT, border: `0.5px solid ${ACCENT}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <i className="ti ti-checks" style={{ fontSize: 10 }} /> Seleziona tutti
                </button>
                <button onClick={() => updateProp(nodeId, 'unpivotColumns', '[]')}
                  style={{ flex: 1, padding: '4px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#4a5a7a', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
                  <i className="ti ti-square" style={{ fontSize: 10 }} /> Deseleziona tutti
                </button>
              </div>
              <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '28px 1fr 70px 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
                  {['✓', 'Campo', 'Tipo', 'Ruolo'].map((h) => (
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
                      <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                      <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, textAlign: 'center', background: isSelected ? `color-mix(in srgb, ${ACCENT} 12%, #0f1117)` : '#0d3d20', color: isSelected ? ACCENT : '#3ddc84', border: `0.5px solid ${isSelected ? ACCENT : '#1d6d40'}30` }}>
                        {isSelected ? '→ righe' : 'fissa'}
                      </span>
                    </div>
                  )
                })}
              </div>
              {unpivotSelected.length > 0 && (
                <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', padding: '4px 6px' }}>
                  {unpivotSelected.length} colonne → righe · {activeFields.length - unpivotSelected.length} fisse
                </div>
              )}
            </>
          )}

          <SectionTitle label="Opzioni" color="#4a9eff" />
          <Row>
            <Field label="Valori null">
              <CustomSelect style={inputStyle} value={p('unpivotNullMode', 'exclude')} onChange={u('unpivotNullMode')}>
                <option value="exclude">Escludi righe con null</option>
                <option value="include">Includi righe con null</option>
                <option value="zero">Sostituisci null con 0</option>
              </CustomSelect>
            </Field>
            <Field label="Ordine righe output">
              <CustomSelect style={inputStyle} value={p('unpivotOrder', 'identity_first')} onChange={u('unpivotOrder')}>
                <option value="identity_first">Per identità, poi chiave</option>
                <option value="key_first">Per chiave, poi identità</option>
                <option value="natural">Naturale (colonna per colonna)</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}

      {/* Schema output */}
      {(() => {
        try {
          const schema = JSON.parse(p('outputSchema', '[]'))
          if (!Array.isArray(schema) || schema.length === 0) return null
          if (schema[0]?.name === '__pivot_dynamic__') {
            return (
              <div style={{ padding: '8px 12px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34740', fontSize: 10, color: '#ffb347' }}>
                <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 6 }} />
                Schema output determinato a runtime — non propagabile a design time.
              </div>
            )
          }
          return (
            <>
              <SectionTitle label="Schema output" color="#22d3ee" />
              <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
                  {['Campo', 'Tipo', 'Origine'].map((h) => (
                    <div key={h} style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
                  ))}
                </div>
                {schema.map((f: any, i: number, arr: any[]) => {
                  const isPivotCol  = mode === 'pivot'   && pivotColumns.some((c) => (c.alias || c.value) === f.name)
                  const isKeyOrVal  = mode === 'unpivot' && (f.id === 'upv_key' || f.id === 'upv_value')
                  const color       = isPivotCol ? ACCENT : isKeyOrVal ? '#4a9eff' : '#9a9aaa'
                  const badge       = isPivotCol ? 'pivot' : isKeyOrVal ? (f.id === 'upv_key' ? 'chiave' : 'valore') : 'fisso'
                  const badgeColor  = isPivotCol ? ACCENT : isKeyOrVal ? '#4a9eff' : '#4a5a7a'
                  return (
                    <div key={f.id ?? f.name}
                      style={{ display: 'grid', gridTemplateColumns: '1fr 70px 80px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                      <code style={{ fontFamily: 'monospace', fontSize: 11, color }}>{f.name}</code>
                      <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                      <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, ${badgeColor} 12%, #0f1117)`, color: badgeColor, border: `0.5px solid ${badgeColor}30`, textAlign: 'center' }}>
                        {badge}
                      </span>
                    </div>
                  )
                })}
              </div>
              <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', display: 'flex', gap: 5 }}>
                <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
                Schema propagato automaticamente ai nodi a valle.
              </div>
            </>
          )
        } catch { return null }
      })()}

    </div>
  )
}
