/**
 * src/nodes/types/aggregate/Panel.tsx
 */
import { useState, useEffect, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { useMaterializeSchema } from '../../../nodes/useMaterializeSchema'
import { CustomSelect } from '../../../components/CustomSelect'

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
function SectionTitle({ label, color = '#4a9eff' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

interface AggFunction {
  id:         string
  field:      string
  fn:         string
  alias:      string
  filter:     string
  separator?: string
}

const AGG_FUNCTIONS: Array<{ value: string; label: string; needsField: boolean; outputType: string; desc: string }> = [
  { value: 'count',          label: 'COUNT',          needsField: false, outputType: 'integer', desc: 'Conta le righe del gruppo'              },
  { value: 'count_distinct', label: 'COUNT DISTINCT', needsField: true,  outputType: 'integer', desc: 'Conta i valori unici del campo'         },
  { value: 'sum',            label: 'SUM',            needsField: true,  outputType: 'decimal', desc: 'Somma i valori del campo'               },
  { value: 'avg',            label: 'AVG',            needsField: true,  outputType: 'decimal', desc: 'Calcola la media del campo'             },
  { value: 'min',            label: 'MIN',            needsField: true,  outputType: 'any',     desc: 'Valore minimo del campo'                },
  { value: 'max',            label: 'MAX',            needsField: true,  outputType: 'any',     desc: 'Valore massimo del campo'               },
  { value: 'first',          label: 'FIRST',          needsField: true,  outputType: 'any',     desc: 'Primo valore incontrato'                },
  { value: 'last',           label: 'LAST',           needsField: true,  outputType: 'any',     desc: 'Ultimo valore incontrato'               },
  { value: 'std_dev',        label: 'STD DEV',        needsField: true,  outputType: 'decimal', desc: 'Deviazione standard'                   },
  { value: 'variance',       label: 'VARIANCE',       needsField: true,  outputType: 'decimal', desc: 'Varianza del campo'                    },
  { value: 'median',         label: 'MEDIAN',         needsField: true,  outputType: 'decimal', desc: 'Valore mediano'                        },
  { value: 'array_agg',      label: 'ARRAY AGG',      needsField: true,  outputType: 'object',  desc: 'Raccoglie tutti i valori in un array'  },
  { value: 'string_agg',     label: 'STRING AGG',     needsField: true,  outputType: 'string',  desc: 'Concatena i valori con separatore'     },
  { value: 'json_agg',       label: 'JSON AGG',       needsField: true,  outputType: 'object',  desc: 'Raccoglie i valori in un array JSON'   },
]

const FN_COLOR: Record<string, string> = {
  count: '#4a9eff', count_distinct: '#4a9eff',
  sum: '#3ddc84', avg: '#3ddc84', median: '#3ddc84', std_dev: '#3ddc84', variance: '#3ddc84',
  min: '#ffb347', max: '#ffb347',
  first: '#a78bfa', last: '#a78bfa',
  array_agg: '#f97316', string_agg: '#f97316', json_agg: '#f97316',
}

// Opzioni accessMode per Aggregate — dataset è il default e il consigliato
const ACCESS_OPTIONS = [
  { value: 'dataset',  label: 'Dataset — .toDataset() (consigliato — List completa, zero buffering aggiuntivo)' },
  { value: 'iterator', label: 'Iterator — .values() (riga per riga con buffering interno)' },
]

function AggRow({ agg, index, total, fields, onChange, onDelete }: {
  agg:      AggFunction
  index:    number
  total:    number
  fields:   Array<{ name: string; type: string }>
  onChange: (id: string, key: keyof AggFunction, value: string) => void
  onDelete: (id: string) => void
}) {
  const meta       = AGG_FUNCTIONS.find((f) => f.value === agg.fn)
  const needsField = meta?.needsField ?? true
  const color      = FN_COLOR[agg.fn] ?? '#4a9eff'

  return (
    <div style={{ background: index % 2 === 0 ? '#1a2030' : '#1e2535', border: `1px solid ${color}30`, borderLeft: `3px solid ${color}`, borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 28px', gap: 6, alignItems: 'end' }}>
        <div>
          <div style={labelStyle}>Funzione</div>
          <CustomSelect style={{ ...inputStyle, color }} value={agg.fn}
            onChange={(e) => onChange(agg.id, 'fn', e.target.value)}>
            {AGG_FUNCTIONS.map((f) => (
              <option key={f.value} value={f.value}>{f.label} — {f.desc}</option>
            ))}
          </CustomSelect>
        </div>
        <div>
          <div style={labelStyle}>Alias output</div>
          <input type="text" style={{ ...inputStyle, color }} value={agg.alias}
            onChange={(e) => onChange(agg.id, 'alias', e.target.value)}
            placeholder={`${agg.fn}_result`} />
        </div>
        <button onClick={() => onDelete(agg.id)} disabled={total === 1}
          style={{ background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '4px 6px', cursor: total === 1 ? 'not-allowed' : 'pointer', color: total === 1 ? '#2a3349' : '#ff5f57', opacity: total === 1 ? 0.4 : 1, alignSelf: 'flex-end' }}>
          <i className="ti ti-x" style={{ fontSize: 11 }} />
        </button>
      </div>
      {meta && (
        <div style={{ fontSize: 9, color: `${color}80`, fontStyle: 'italic' }}>
          {meta.desc} → tipo output: <span style={{ color }}>{meta.outputType}</span>
        </div>
      )}
      {needsField && (
        <div>
          <div style={labelStyle}>Campo su cui applicare</div>
          {fields.length > 0 ? (
            <CustomSelect style={inputStyle} value={agg.field}
              onChange={(e) => onChange(agg.id, 'field', e.target.value)}>
              <option value="">— seleziona campo —</option>
              {fields.map((f) => (
                <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
              ))}
            </CustomSelect>
          ) : (
            <input type="text" style={inputStyle} value={agg.field}
              onChange={(e) => onChange(agg.id, 'field', e.target.value)}
              placeholder="nome_campo" />
          )}
        </div>
      )}
      {agg.fn === 'string_agg' && (
        <div>
          <div style={labelStyle}>Separatore <span style={{ color: '#2a3349', fontWeight: 400 }}>(LISTAGG)</span></div>
          <input type="text" style={{ ...inputStyle, color: '#f97316' }}
            value={(agg as any).separator ?? ', '}
            onChange={(e) => onChange(agg.id, 'separator' as any, e.target.value)}
            placeholder=", " />
        </div>
      )}
      <div>
        <div style={labelStyle}>Filtro FILTER WHERE <span style={{ color: '#2a3349', fontWeight: 400 }}>(opzionale)</span></div>
        <input type="text" style={{ ...inputStyle, color: '#9a9aaa' }} value={agg.filter}
          onChange={(e) => onChange(agg.id, 'filter', e.target.value)}
          placeholder="status = 'active'" />
      </div>
    </div>
  )
}

export function AggregatePanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  const [aggFunctions, setAggFunctions] = useState<AggFunction[]>(() => {
    try {
      const raw = node?.data.props['aggFunctions']
      return raw ? JSON.parse(raw) : [{ id: '1', field: '', fn: 'count', alias: 'count', filter: '' }]
    } catch {
      return [{ id: '1', field: '', fn: 'count', alias: 'count', filter: '' }]
    }
  })

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const dataSource = p('dataSource', 'flow')
  const matName    = p('materializeName', '')
  const accessMode = p('accessMode', 'dataset')   // ← definito qui
  const laneId     = node.data.laneId

  const materializeVars = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'materialize')
  }, [pool, laneId])

  const flowFields        = useIncomingSchema(nodeId)
  const materializeFields = useMaterializeSchema(nodeId, matName)
  const activeFields      = dataSource === 'materialize' ? materializeFields : flowFields

  const groupByFields = p('group_by').split(',').map((s) => s.trim()).filter(Boolean)

  const saveAgg = (aggs: AggFunction[]) => {
    setAggFunctions(aggs)
    updateProp(nodeId, 'aggFunctions', JSON.stringify(aggs))
    const textFns = aggs.map((a) => {
      if (a.fn === 'string_agg') return `STRING_AGG(${a.field || '*'}, '${a.separator ?? ', '}') AS ${a.alias || a.fn}`
      return `${a.fn}(${a.field || '*'}) AS ${a.alias || a.fn}`
    }).join(', ')
    updateProp(nodeId, 'functions', textFns)
    const schemaFields = [
      ...groupByFields.map((name) => {
        const incoming = activeFields.find((f) => f.name === name)
        return { id: `agg_gb_${name}`, name, type: incoming?.type ?? 'string', physicalName: name }
      }),
      ...aggs.map((a) => {
        const meta  = AGG_FUNCTIONS.find((f) => f.value === a.fn)
        const alias = a.alias || `${a.fn}_result`
        return { id: `agg_fn_${a.id}`, name: alias, type: meta?.outputType ?? 'string', physicalName: alias }
      }),
    ]
    updateProp(nodeId, 'outputSchema', JSON.stringify(schemaFields))
  }

  useEffect(() => { saveAgg(aggFunctions) }, [p('group_by'), activeFields.map((f) => f.name).join(',')])

  const addAgg    = () => saveAgg([...aggFunctions, { id: Date.now().toString(), field: '', fn: 'sum', alias: '', filter: '' }])
  const updateAgg = (id: string, key: keyof AggFunction, value: string) =>
    saveAgg(aggFunctions.map((a) => a.id === id ? { ...a, [key]: value } : a))
  const deleteAgg = (id: string) => {
    if (aggFunctions.length === 1) return
    saveAgg(aggFunctions.filter((a) => a.id !== id))
  }

  const outputPreview = [
    ...groupByFields.map((name) => {
      const incoming = activeFields.find((f) => f.name === name)
      return { name, type: incoming?.type ?? 'string', role: 'group' as const }
    }),
    ...aggFunctions.map((a) => {
      const meta  = AGG_FUNCTIONS.find((f) => f.value === a.fn)
      const color = FN_COLOR[a.fn] ?? '#4a9eff'
      return { name: a.alias || `${a.fn}_result`, type: meta?.outputType ?? 'string', role: 'agg' as const, color, fn: a.fn }
    }),
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', display: 'flex', gap: 8 }}>
        <span style={{ fontSize: 16, color: '#4a9eff' }}>Σ</span>
        <div style={{ lineHeight: 1.5 }}>
          Raggruppa le righe per uno o più campi e calcola funzioni per ogni gruppo.
          <strong style={{ color: '#c8d4f0' }}> Emette una riga per gruppo</strong>.
        </div>
      </div>

      {/* Sorgente dati */}
      <SectionTitle label="Sorgente dati" color="#22d3ee" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          { value: 'flow',        label: '→ Da flusso',       desc: 'Riceve righe via edge — bufferizza internamente finché il flusso non è esaurito, poi calcola.', disabled: false },
          { value: 'materialize', label: '◈ Da Materialize',  desc: 'La riga in ingresso è solo trigger. I dati vengono letti dal Materialize selezionato.',         disabled: materializeVars.length === 0, hint: materializeVars.length === 0 ? 'Nessun Materialize pubblicato in questa lane' : undefined },
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
              <div style={{ fontSize: 9, color: '#4a5a7a' }}>{s.hint ?? s.desc}</div>
            </div>
          </button>
        ))}
      </div>

      {/* Selettore Materialize + accessMode */}
      {dataSource === 'materialize' && (
        <>
          <Field label="Materialize sorgente" hint="Deve essere già popolato quando questo nodo viene attivato">
            {materializeVars.length > 0 ? (
              <CustomSelect style={inputStyle} value={matName} onChange={u('materializeName')}>
                <option value="">— seleziona —</option>
                {materializeVars.map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={matName} onChange={u('materializeName')} placeholder="nome_materialize" />
            )}
          </Field>
          {matName && materializeFields.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
              Il Materialize "{matName}" non ha ancora ricevuto campi.
            </div>
          )}
          {matName && materializeFields.length > 0 && (
            <div style={{ padding: '5px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #22d3ee20', fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 5, alignItems: 'center' }}>
              <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
              <code style={{ color: '#22d3ee' }}>context.lane.{matName}</code> — {materializeFields.length} campi disponibili
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
                {accessMode === 'dataset'  && '→ context.lane.' + matName + '.toDataset() — List<Row> completa, zero buffering aggiuntivo nel nodo'}
                {accessMode === 'iterator' && '→ context.lane.' + matName + '.values() — riga per riga, Aggregate bufferizza internamente per gruppo'}
              </div>
            </Field>
          )}

          <div style={{ padding: '6px 10px', fontSize: 9, color: '#4a5a7a', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', lineHeight: 1.5 }}>
            <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4, color: '#22d3ee' }} />
            Pattern tipico: <code style={{ color: '#22d3ee' }}>Materialize(buffer_signal) → Bridge Out → Bridge In → Aggregate</code>
          </div>
        </>
      )}

      {/* GROUP BY */}
      <SectionTitle label="Raggruppa per (GROUP BY)" color="#4a9eff" />
      <Field label="Campi di raggruppamento" hint="Virgola separati — es: region, category, year">
        {activeFields.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <input type="text" style={inputStyle} value={p('group_by')} onChange={u('group_by')} placeholder="region, category" />
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 2 }}>
              {activeFields.map((f) => {
                const isSelected = groupByFields.includes(f.name)
                return (
                  <button key={f.name}
                    onClick={() => {
                      const next = isSelected ? groupByFields.filter((n) => n !== f.name) : [...groupByFields, f.name]
                      updateProp(nodeId, 'group_by', next.join(', '))
                    }}
                    style={{ padding: '2px 8px', fontSize: 10, borderRadius: 10, cursor: 'pointer', background: isSelected ? '#0d3d20' : '#1a2030', color: isSelected ? '#3ddc84' : '#4a5a7a', border: isSelected ? '1px solid #1d6d40' : '1px solid #2a3349', fontFamily: 'monospace', transition: 'all .1s' }}>
                    {f.name}
                  </button>
                )
              })}
            </div>
          </div>
        ) : (
          <input type="text" style={inputStyle} value={p('group_by')} onChange={u('group_by')} placeholder="region, category" />
        )}
      </Field>

      {/* Finestre temporali — solo in modalità flusso */}
      {dataSource === 'flow' && (
        <Field label="Finestra temporale" hint="Utile solo in modalità streaming">
          <CustomSelect style={inputStyle} value={p('window', 'none')} onChange={u('window')}>
            <option value="none">Nessuna — aggrega tutto il dataset</option>
            <option value="tumbling">Tumbling — finestre fisse (es. ogni ora)</option>
            <option value="sliding">Sliding — finestre scorrevoli</option>
            <option value="session">Session — basata su inattività</option>
          </CustomSelect>
        </Field>
      )}
      {dataSource === 'flow' && p('window') !== 'none' && p('window') && (
        <Row>
          <Field label="Dimensione finestra">
            <input type="text" style={inputStyle} value={p('windowSize', '1h')} onChange={u('windowSize')} placeholder="1h, 30m, 5s" />
          </Field>
          <Field label="Campo timestamp">
            {activeFields.length > 0 ? (
              <CustomSelect style={inputStyle} value={p('timestampField')} onChange={u('timestampField')}>
                <option value="">— seleziona —</option>
                {activeFields.filter((f) => f.type === 'date').map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                {activeFields.filter((f) => f.type !== 'date').map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
              </CustomSelect>
            ) : (
              <input type="text" style={inputStyle} value={p('timestampField', 'created_at')} onChange={u('timestampField')} placeholder="created_at" />
            )}
          </Field>
        </Row>
      )}

      {/* Funzioni */}
      <SectionTitle label="Funzioni di aggregazione" color="#ffb347" />
      <div style={{ fontSize: 10, color: '#4a5a7a', marginBottom: 2 }}>
        Ogni funzione produce un campo in output. Dai un alias significativo a ciascuna.
      </div>
      {aggFunctions.map((agg, idx) => (
        <AggRow key={agg.id} agg={agg} index={idx} total={aggFunctions.length}
          fields={activeFields} onChange={updateAgg} onDelete={deleteAgg} />
      ))}
      <button onClick={addAgg}
        style={{ background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 6, padding: '7px', fontSize: 11, color: '#4a9eff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}>
        <i className="ti ti-plus" style={{ fontSize: 12 }} /> Aggiungi funzione
      </button>

      {/* HAVING */}
      <SectionTitle label="Filtro post-aggregazione (HAVING)" color="#a78bfa" />
      <div style={{ padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #a78bfa20', fontSize: 10, color: '#4a5a7a', marginBottom: 4 }}>
        <strong style={{ color: '#a78bfa' }}>HAVING</strong> filtra i <strong style={{ color: '#c8d4f0' }}>gruppi</strong> dopo l'aggregazione.
        Usa i nomi alias: <code style={{ color: '#a78bfa' }}>count &gt; 10</code>
      </div>
      <Field label="Condizione HAVING">
        <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 54, fontFamily: 'monospace' }}
          value={p('having')} onChange={u('having')}
          placeholder="count > 10 AND sum_amount > 1000" spellCheck={false} />
      </Field>

      {/* Ordinamento */}
      <SectionTitle label="Ordinamento e limite" color="#3ddc84" />
      <Row>
        <Field label="Ordina per">
          <input type="text" style={inputStyle} value={p('orderBy')} onChange={u('orderBy')} placeholder="count DESC, region ASC" />
        </Field>
        <Field label="Limite risultati" hint="0 = nessun limite">
          <input type="number" style={inputStyle} value={p('limit', '0')} onChange={u('limit')} min="0" />
        </Field>
      </Row>

      {/* Opzioni */}
      <SectionTitle label="Opzioni" />
      <Row>
        <Field label="Null nel GROUP BY">
          <CustomSelect style={inputStyle} value={p('nullGroups', 'include')} onChange={u('nullGroups')}>
            <option value="include">Includi come gruppo separato</option>
            <option value="exclude">Escludi righe con null</option>
          </CustomSelect>
        </Field>
        <Field label="Modalità esecuzione">
          <CustomSelect style={inputStyle} value={p('execMode', 'batch')} onChange={u('execMode')}>
            <option value="batch">Batch — attende tutti i dati</option>
            <option value="streaming">Streaming — risultati incrementali</option>
          </CustomSelect>
        </Field>
      </Row>

      {/* Schema output */}
      {outputPreview.length > 0 && (
        <>
          <SectionTitle label="Schema output derivato" color="#22d3ee" />
          <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px', gap: 8, padding: '4px 10px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
              {['Campo', 'Tipo', 'Origine'].map((h) => (
                <div key={h} style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
              ))}
            </div>
            {outputPreview.map((f, i, arr) => (
              <div key={f.name}
                style={{ display: 'grid', gridTemplateColumns: '1fr 80px 100px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                <code style={{ fontFamily: 'monospace', fontSize: 11, color: f.role === 'agg' ? (f as any).color : '#3ddc84' }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                {f.role === 'group' ? (
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: '#0d3d20', color: '#3ddc84', border: '0.5px solid #1d6d4080', display: 'inline-block' }}>GROUP BY</span>
                ) : (
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, ${(f as any).color} 15%, #0f1117)`, color: (f as any).color, border: `0.5px solid ${(f as any).color}40`, display: 'inline-block' }}>
                    {(f as any).fn?.toUpperCase()}
                  </span>
                )}
              </div>
            ))}
          </div>
          <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', display: 'flex', gap: 5 }}>
            <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
            Schema propagato automaticamente ai nodi a valle.
          </div>
        </>
      )}
    </div>
  )
}