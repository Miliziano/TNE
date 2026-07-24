/**
 * src/nodes/types/window/Panel.tsx
 */
import { useState, useMemo, useEffect } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { useMaterializeSchema } from '../../../nodes/useMaterializeSchema'
import { CustomSelect } from '../../../components/CustomSelect'


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
function SectionTitle({ label, color = '#a78bfa' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

const ACCENT = '#a78bfa'

// ─── Categorie e funzioni ─────────────────────────────────────────
interface FnDef {
  value:      string
  label:      string
  desc:       string
  category:   'ranking' | 'navigation' | 'cumulative' | 'analytical' | 'etl'
  hasField:   boolean
  hasOffset:  boolean
  hasN:       boolean
  hasExpr:    boolean
  outputType: string
}

const WINDOW_FUNCTIONS: FnDef[] = [
  { value: 'row_number',     label: 'ROW_NUMBER',      category: 'ranking',    hasField: false, hasOffset: false, hasN: false, hasExpr: false, outputType: 'integer', desc: 'Numero progressivo di riga nella partizione — unico per ogni riga' },
  { value: 'rank',           label: 'RANK',             category: 'ranking',    hasField: false, hasOffset: false, hasN: false, hasExpr: false, outputType: 'integer', desc: 'Rank con salti per parità (1,1,3...) — stile gara olimpica' },
  { value: 'dense_rank',     label: 'DENSE_RANK',       category: 'ranking',    hasField: false, hasOffset: false, hasN: false, hasExpr: false, outputType: 'integer', desc: 'Rank senza salti (1,1,2...) — preferibile per top-N' },
  { value: 'percent_rank',   label: 'PERCENT_RANK',     category: 'ranking',    hasField: false, hasOffset: false, hasN: false, hasExpr: false, outputType: 'decimal', desc: 'Rank percentuale 0.0→1.0 — posizione relativa nel gruppo' },
  { value: 'cume_dist',      label: 'CUME_DIST',        category: 'ranking',    hasField: false, hasOffset: false, hasN: false, hasExpr: false, outputType: 'decimal', desc: 'Distribuzione cumulativa — frazione di righe ≤ valore corrente' },
  { value: 'ntile',          label: 'NTILE',             category: 'ranking',    hasField: false, hasOffset: false, hasN: true,  hasExpr: false, outputType: 'integer', desc: 'Suddivide in N bucket — es. quartili (N=4), decili (N=10)' },
  { value: 'topn_flag',      label: 'TOP-N FLAG',        category: 'ranking',    hasField: false, hasOffset: false, hasN: true,  hasExpr: false, outputType: 'boolean', desc: 'true se la riga è tra le prime N della partizione' },
  { value: 'lag',            label: 'LAG',               category: 'navigation', hasField: true,  hasOffset: true,  hasN: false, hasExpr: false, outputType: 'any',     desc: 'Valore della riga N posizioni prima — confronto con periodo precedente' },
  { value: 'lead',           label: 'LEAD',              category: 'navigation', hasField: true,  hasOffset: true,  hasN: false, hasExpr: false, outputType: 'any',     desc: 'Valore della riga N posizioni dopo — anticipazione periodo successivo' },
  { value: 'first_value',    label: 'FIRST_VALUE',       category: 'navigation', hasField: true,  hasOffset: false, hasN: false, hasExpr: false, outputType: 'any',     desc: 'Primo valore nella partizione — baseline di confronto' },
  { value: 'last_value',     label: 'LAST_VALUE',        category: 'navigation', hasField: true,  hasOffset: false, hasN: false, hasExpr: false, outputType: 'any',     desc: 'Ultimo valore nella partizione' },
  { value: 'nth_value',      label: 'NTH_VALUE',         category: 'navigation', hasField: true,  hasOffset: false, hasN: true,  hasExpr: false, outputType: 'any',     desc: 'N-esimo valore nella partizione — generalizzazione di FIRST/LAST' },
  { value: 'cumsum',         label: 'CUMSUM',            category: 'cumulative', hasField: true,  hasOffset: false, hasN: false, hasExpr: false, outputType: 'decimal', desc: 'Somma cumulativa crescente — vendite YTD, totale progressivo' },
  { value: 'cumcount',       label: 'CUMCOUNT',          category: 'cumulative', hasField: false, hasOffset: false, hasN: false, hasExpr: false, outputType: 'integer', desc: 'Conteggio cumulativo — numero di eventi fino a questa riga' },
  { value: 'cumprod',        label: 'CUMPROD',           category: 'cumulative', hasField: true,  hasOffset: false, hasN: false, hasExpr: false, outputType: 'decimal', desc: 'Prodotto cumulativo — rendimento composto, crescita moltiplicativa' },
  { value: 'moving_avg',     label: 'MOVING AVG',        category: 'analytical', hasField: true,  hasOffset: false, hasN: true,  hasExpr: false, outputType: 'decimal', desc: 'Media mobile su N righe — smoothing serie temporale, SMA' },
  { value: 'moving_sum',     label: 'MOVING SUM',        category: 'analytical', hasField: true,  hasOffset: false, hasN: true,  hasExpr: false, outputType: 'decimal', desc: 'Somma mobile su N righe — totale scorrevole' },
  { value: 'moving_min',     label: 'MOVING MIN',        category: 'analytical', hasField: true,  hasOffset: false, hasN: true,  hasExpr: false, outputType: 'any',     desc: 'Minimo mobile su N righe — supporto tecnico in analisi prezzi' },
  { value: 'moving_max',     label: 'MOVING MAX',        category: 'analytical', hasField: true,  hasOffset: false, hasN: true,  hasExpr: false, outputType: 'any',     desc: 'Massimo mobile su N righe — resistenza tecnica in analisi prezzi' },
  { value: 'moving_stddev',  label: 'MOVING STDDEV',     category: 'analytical', hasField: true,  hasOffset: false, hasN: true,  hasExpr: false, outputType: 'decimal', desc: 'Deviazione standard mobile — volatilità, Bollinger Bands' },
  { value: 'ratio_to_report',label: 'RATIO TO REPORT',   category: 'analytical', hasField: true,  hasOffset: false, hasN: false, hasExpr: false, outputType: 'decimal', desc: 'Percentuale sul totale della partizione — quota di mercato' },
  { value: 'delta',          label: 'DELTA',             category: 'analytical', hasField: true,  hasOffset: false, hasN: false, hasExpr: false, outputType: 'decimal', desc: 'Differenza rispetto alla riga precedente — variazione assoluta giornaliera' },
  { value: 'change_detect',  label: 'CHANGE DETECT',     category: 'etl',        hasField: true,  hasOffset: false, hasN: false, hasExpr: false, outputType: 'boolean', desc: 'true quando il valore cambia rispetto alla riga precedente — CDC light' },
  { value: 'sessionize',     label: 'SESSIONIZE',        category: 'etl',        hasField: true,  hasOffset: false, hasN: true,  hasExpr: false, outputType: 'string',  desc: 'Assegna ID sessione quando il gap temporale supera N secondi' },
  { value: 'streak',         label: 'STREAK',            category: 'etl',        hasField: false, hasOffset: false, hasN: false, hasExpr: true,  outputType: 'integer', desc: 'Conta righe consecutive che soddisfano una condizione' },
  { value: 'interpolate',    label: 'INTERPOLATE',       category: 'etl',        hasField: true,  hasOffset: false, hasN: false, hasExpr: false, outputType: 'decimal', desc: 'Riempie null interpolando linearmente tra valore precedente e successivo' },
]

const CATEGORY_META: Record<string, { label: string; color: string; icon: string }> = {
  ranking:    { label: 'Ranking',            color: '#4a9eff', icon: 'ti-trophy'       },
  navigation: { label: 'Navigazione',        color: '#ffb347', icon: 'ti-arrows-move'  },
  cumulative: { label: 'Cumulativo',         color: '#3ddc84', icon: 'ti-trending-up'  },
  analytical: { label: 'Analitico / Moving', color: ACCENT,    icon: 'ti-chart-line'   },
  etl:        { label: 'ETL / Avanzato',     color: '#f97316', icon: 'ti-circuit-cell' },
}

interface WindowDef {
  id:          string
  fn:          string
  field?:      string
  offset?:     number
  n?:          number
  expr?:       string
  outputField: string
  nullDefault: string
}

export function WindowPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const dataSource     = p('dataSource', 'flow')       // 'flow' | 'materialize'
  const matName        = p('materializeName', '')
  const accessMode = p('accessMode', 'dataset')   // ← definito qui
  const laneId         = node.data.laneId

  // Variabili Materialize disponibili nella lane
  const materializeVars = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'materialize')
  }, [pool, laneId])

  // Schema — da flusso o da Materialize
  const flowFields        = useIncomingSchema(nodeId)
  const materializeFields = useMaterializeSchema(nodeId, matName)
  const activeFields      = dataSource === 'materialize' ? materializeFields : flowFields

  // Partition by — multi-campo
  const partitionFields: string[] = useMemo(() => {
    const raw = p('partitionBy', '')
    return raw ? raw.split(',').map((s) => s.trim()).filter(Boolean) : []
  }, [p('partitionBy')])

  const togglePartition = (name: string) => {
    const next = partitionFields.includes(name)
      ? partitionFields.filter((f) => f !== name)
      : [...partitionFields, name]
    updateProp(nodeId, 'partitionBy', next.join(', '))
  }

  // Funzioni window
  const windows: WindowDef[] = useMemo(() => {
    try { return JSON.parse(p('windows', '[]')) }
    catch { return [] }
  }, [p('windows')])

  const saveWindows = (w: WindowDef[]) => {
    updateProp(nodeId, 'windows', JSON.stringify(w))
    const addedFields = w.map((win) => {
      const fnDef = WINDOW_FUNCTIONS.find((f) => f.value === win.fn)
      return { id: `win_${win.id}`, name: win.outputField || `win_${win.fn}`, type: fnDef?.outputType ?? 'any', physicalName: win.outputField || `win_${win.fn}` }
    })
    const baseFields = activeFields.map((f) => ({ id: f.id, name: f.name, type: f.type, physicalName: f.name }))
    updateProp(nodeId, 'outputSchema', JSON.stringify([...baseFields, ...addedFields]))
  }

  useEffect(() => {
    if (windows.length > 0) saveWindows(windows)
  }, [activeFields.map((f) => f.name).join(',')])

  const addWindow = () => saveWindows([...windows, {
    id: `w_${Date.now()}`, fn: 'row_number',
    outputField: `row_num_${windows.length + 1}`, nullDefault: '', n: 3, offset: 1,
  }])
  const updateWindow = (id: string, patch: Partial<WindowDef>) =>
    saveWindows(windows.map((w) => w.id === id ? { ...w, ...patch } : w))
  const deleteWindow = (id: string) =>
    saveWindows(windows.filter((w) => w.id !== id))

  const orderBy  = p('orderBy', '')
  const orderDir = p('orderDir', 'asc')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#4a5a7a', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>W</span> Calcola valori usando righe vicine nella stessa partizione.
        Le righe originali passano invariate con i <strong style={{ color: '#c8d4f0' }}>campi calcolati aggiunti</strong>.
      </div>

      {/* ── Sorgente dati ── */}
      <SectionTitle label="Sorgente dati" color="#22d3ee" />
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {[
          {
            value: 'flow',
            label: '→ Da flusso',
            desc:  'Riceve righe via edge — la riga in ingresso è il dato da elaborare. Il nodo bufferizza internamente.',
          },
          {
            value:    'materialize',
            label:    '◈ Da Materialize',
            desc:     'La riga in ingresso è solo un trigger di attivazione. I dati vengono letti dal Materialize selezionato.',
            disabled: materializeVars.length === 0,
            hint:     materializeVars.length === 0 ? 'Nessun Materialize pubblicato in questa lane' : undefined,
          },
        ].map((s) => (
          <button key={s.value}
            onClick={() => { if (!(s as any).disabled) updateProp(nodeId, 'dataSource', s.value) }}
            style={{
              padding: '8px 12px', borderRadius: 6, cursor: (s as any).disabled ? 'not-allowed' : 'pointer',
              opacity: (s as any).disabled ? 0.4 : 1, textAlign: 'left',
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
            {materializeVars.length > 0 ? (
              <CustomSelect style={inputStyle} value={matName} onChange={u('materializeName')}>
                <option value="">— seleziona —</option>
                {materializeVars.map((v) => (
                  <option key={v.id} value={v.name}>{v.name}</option>
                ))}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={matName} onChange={u('materializeName')} placeholder="nome_materialize" />
            )}
          </Field>
          {matName && materializeFields.length === 0 && (
            <div style={{ padding: '6px 10px', fontSize: 9, color: '#ffb347', background: '#1a1000', borderRadius: 4, border: '0.5px solid #3a2a0a', display: 'flex', gap: 5 }}>
              <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
              Il Materialize "{matName}" non ha ancora ricevuto campi. Collegalo a un nodo sorgente.
            </div>
          )}
          {matName && materializeFields.length > 0 && (
            <div style={{ padding: '5px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #22d3ee20', fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 5, alignItems: 'center' }}>
              <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
              dataset <code style={{ color: '#22d3ee' }}>{matName}</code>
              — {materializeFields.length} campi disponibili
            </div>
          )}
          <div style={{ padding: '6px 10px', fontSize: 9, color: '#4a5a7a', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', lineHeight: 1.5 }}>
            <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4, color: '#22d3ee' }} />
            Pattern tipico: <code style={{ color: '#22d3ee' }}>Materialize(buffer_signal) → Bridge Out → Bridge In → Window</code>.
            Il signal del Materialize arriva come trigger, Window legge i dati dalla lane.
          </div>
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

      {/* Partizione e ordinamento */}
      <SectionTitle label="Partizione e ordinamento" color="#4a9eff" />

      <Field label="Partition by — campi di partizione" hint="La finestra viene calcolata indipendentemente per ogni combinazione di valori">
        {activeFields.length > 0 ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {activeFields.map((f) => {
                const isSelected = partitionFields.includes(f.name)
                return (
                  <button key={f.name} onClick={() => togglePartition(f.name)}
                    style={{ padding: '2px 8px', fontSize: 10, borderRadius: 10, cursor: 'pointer', background: isSelected ? '#0d2a4a' : '#1a2030', color: isSelected ? '#4a9eff' : '#4a5a7a', border: isSelected ? '1px solid #1a5a9a' : '1px solid #2a3349', fontFamily: 'monospace', transition: 'all .1s' }}>
                    {f.name}
                  </button>
                )
              })}
            </div>
            {partitionFields.length > 0 && (
              <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>
                PARTITION BY {partitionFields.map((f) => <code key={f} style={{ color: '#4a9eff', marginRight: 4 }}>{f}</code>)}
              </div>
            )}
            {partitionFields.length === 0 && (
              <div style={{ fontSize: 9, color: '#2a3349', fontStyle: 'italic' }}>Nessuna partizione — finestra globale su tutti i dati</div>
            )}
          </div>
        ) : (
          <input style={inputStyle} value={p('partitionBy')} onChange={u('partitionBy')} placeholder="categoria, regione" />
        )}
      </Field>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 110px', gap: 8 }}>
        <Field label="Order by">
          {activeFields.length > 0 ? (
            <CustomSelect style={inputStyle} value={orderBy} onChange={u('orderBy')}>
              <option value="">— seleziona campo —</option>
              {activeFields.map((f) => (
                <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
              ))}
            </CustomSelect>
          ) : (
            <input style={inputStyle} value={orderBy} onChange={u('orderBy')} placeholder="data, id" />
          )}
        </Field>
        <Field label="Direzione">
          <CustomSelect style={inputStyle} value={orderDir} onChange={u('orderDir')}>
            <option value="asc">ASC ↑</option>
            <option value="desc">DESC ↓</option>
          </CustomSelect>
        </Field>
      </div>

      {/* Funzioni */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
        <SectionTitle label={`Funzioni window — ${windows.length}`} />
        <button onClick={addWindow}
          style={{ marginLeft: 'auto', padding: '3px 12px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}60`, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <i className="ti ti-plus" style={{ fontSize: 11 }} /> Funzione
        </button>
      </div>

      {/* Legenda categorie */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginBottom: 2 }}>
        {Object.entries(CATEGORY_META).map(([key, meta]) => (
          <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '1px 7px', borderRadius: 8, background: `color-mix(in srgb, ${meta.color} 10%, #0f1117)`, border: `0.5px solid ${meta.color}30` }}>
            <i className={`ti ${meta.icon}`} style={{ fontSize: 9, color: meta.color }} />
            <span style={{ fontSize: 9, color: meta.color }}>{meta.label}</span>
          </div>
        ))}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {windows.length === 0 ? (
          <div style={{ padding: '28px', textAlign: 'center', color: '#2a3349', fontSize: 11, border: `0.5px dashed ${ACCENT}30`, borderRadius: 8, background: '#0f1117' }}>
            <i className="ti ti-chart-bar" style={{ fontSize: 28, display: 'block', marginBottom: 8, color: `${ACCENT}20` }} />
            Aggiungi una funzione window per calcolare metriche sulla partizione
          </div>
        ) : windows.map((w) => {
          const fnDef   = WINDOW_FUNCTIONS.find((f) => f.value === w.fn)
          const catMeta = fnDef ? CATEGORY_META[fnDef.category] : CATEGORY_META.ranking
          const color   = catMeta.color

          return (
            <div key={w.id} style={{ background: '#1a2030', border: `0.5px solid ${color}40`, borderLeft: `3px solid ${color}`, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${color} 8%, #1a2030)`, display: 'flex', alignItems: 'center', gap: 8 }}>
                <i className={`ti ${catMeta.icon}`} style={{ fontSize: 11, color, flexShrink: 0 }} />
                <code style={{ fontSize: 11, color, fontWeight: 600 }}>{fnDef?.label ?? w.fn}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a', flex: 1 }}>{fnDef?.desc}</span>
                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: `color-mix(in srgb, ${color} 15%, #0f1117)`, color, border: `0.5px solid ${color}30` }}>
                  → {fnDef?.outputType ?? 'any'}
                </span>
                <button onClick={() => deleteWindow(w.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                  <i className="ti ti-x" style={{ fontSize: 11 }} />
                </button>
              </div>

              <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                  <div>
                    <div style={labelStyle}>Funzione</div>
                    <CustomSelect style={inputStyle} value={w.fn}
                      onChange={(e) => updateWindow(w.id, { fn: e.target.value })}>
                      {Object.entries(CATEGORY_META).map(([catKey, cat]) => (
                        <optgroup key={catKey} label={`── ${cat.label}`}>
                          {WINDOW_FUNCTIONS.filter((f) => f.category === catKey).map((f) => (
                            <option key={f.value} value={f.value}>{f.label}</option>
                          ))}
                        </optgroup>
                      ))}
                    </CustomSelect>
                  </div>
                  <div>
                    <div style={labelStyle}>Campo output</div>
                    <input style={{ ...inputStyle, color }} value={w.outputField}
                      onChange={(e) => updateWindow(w.id, { outputField: e.target.value })}
                      placeholder="nome_campo_output" />
                  </div>
                </div>

                {fnDef?.hasField && (
                  <div>
                    <div style={labelStyle}>Campo sorgente</div>
                    {activeFields.length > 0 ? (
                      <CustomSelect style={inputStyle} value={w.field ?? ''}
                        onChange={(e) => updateWindow(w.id, { field: e.target.value })}>
                        <option value="">— seleziona campo —</option>
                        {activeFields.map((f) => (
                          <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                        ))}
                      </CustomSelect>
                    ) : (
                      <input style={inputStyle} value={w.field ?? ''}
                        onChange={(e) => updateWindow(w.id, { field: e.target.value })}
                        placeholder="nome_campo" />
                    )}
                  </div>
                )}

                {fnDef?.hasOffset && (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                    <div>
                      <div style={labelStyle}>Offset (posizioni)</div>
                      <input type="number" style={inputStyle} value={w.offset ?? 1} min="1"
                        onChange={(e) => updateWindow(w.id, { offset: parseInt(e.target.value) })} />
                    </div>
                    {(w.fn === 'lag' || w.fn === 'lead') && (
                      <div>
                        <div style={labelStyle}>Valore se null</div>
                        <input style={inputStyle} value={w.nullDefault}
                          onChange={(e) => updateWindow(w.id, { nullDefault: e.target.value })}
                          placeholder="null" />
                      </div>
                    )}
                  </div>
                )}

                {fnDef?.hasN && (
                  <div>
                    <div style={labelStyle}>
                      {w.fn === 'ntile'      ? 'N bucket (es. 4 = quartili)'  :
                       w.fn === 'topn_flag'  ? 'N (top N righe = true)'       :
                       w.fn === 'sessionize' ? 'Gap massimo in secondi'       :
                       w.fn === 'nth_value'  ? 'N-esimo valore'               :
                       'Dimensione finestra (righe)'}
                    </div>
                    <input type="number" style={inputStyle} value={w.n ?? 3} min="1"
                      onChange={(e) => updateWindow(w.id, { n: parseInt(e.target.value) })} />
                    {w.fn === 'moving_avg'  && <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 3, fontStyle: 'italic' }}>SMA({w.n ?? 3}) — media delle ultime {w.n ?? 3} righe</div>}
                    {w.fn === 'sessionize' && <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 3, fontStyle: 'italic' }}>Se gap &gt; {w.n ?? 3}s dalla riga precedente → nuova sessione</div>}
                    {w.fn === 'ntile'      && <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 3, fontStyle: 'italic' }}>N=4 quartili · N=5 quintili · N=10 decili · N=100 percentili</div>}
                  </div>
                )}

                {fnDef?.hasExpr && (
                  <div>
                    <div style={labelStyle}>Condizione streak</div>
                    <input style={{ ...inputStyle, color: '#f97316' }} value={w.expr ?? ''}
                      onChange={(e) => updateWindow(w.id, { expr: e.target.value })}
                      placeholder="amount > 0" />
                    <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 3, fontStyle: 'italic' }}>
                      Conta le righe consecutive dove la condizione è vera. Reset a 0 quando è falsa.
                    </div>
                  </div>
                )}

                {/* Anteprima pseudo-codice */}
                <div style={{ fontSize: 9, color: '#2a3349', fontFamily: 'monospace', padding: '3px 6px', background: '#0f1117', borderRadius: 3, marginTop: 2 }}>
                  {w.fn === 'row_number'     && `ROW_NUMBER() OVER (${partitionFields.length ? `PARTITION BY ${partitionFields.join(', ')} ` : ''}ORDER BY ${orderBy || '?'}) AS ${w.outputField || '?'}`}
                  {w.fn === 'lag'            && `LAG(${w.field || '?'}, ${w.offset ?? 1}) OVER (...ORDER BY ${orderBy || '?'}) AS ${w.outputField || '?'}`}
                  {w.fn === 'lead'           && `LEAD(${w.field || '?'}, ${w.offset ?? 1}) OVER (...ORDER BY ${orderBy || '?'}) AS ${w.outputField || '?'}`}
                  {w.fn === 'cumsum'         && `SUM(${w.field || '?'}) OVER (...ORDER BY ${orderBy || '?'} ROWS UNBOUNDED PRECEDING) AS ${w.outputField || '?'}`}
                  {w.fn === 'moving_avg'     && `AVG(${w.field || '?'}) OVER (...ROWS ${(w.n ?? 3) - 1} PRECEDING) AS ${w.outputField || '?'}`}
                  {w.fn === 'ratio_to_report'&& `${w.field || '?'} / SUM(${w.field || '?'}) OVER (PARTITION BY ...) AS ${w.outputField || '?'}`}
                  {w.fn === 'delta'          && `${w.field || '?'} - LAG(${w.field || '?'}, 1) OVER (...) AS ${w.outputField || '?'}`}
                  {w.fn === 'change_detect'  && `${w.field || '?'} != LAG(${w.field || '?'}, 1) OVER (...) AS ${w.outputField || '?'}`}
                  {!['row_number','lag','lead','cumsum','moving_avg','ratio_to_report','delta','change_detect'].includes(w.fn) &&
                    `${w.fn.toUpperCase()}(${w.field || w.n || '*'}) OVER (...ORDER BY ${orderBy || '?'}) AS ${w.outputField || '?'}`}
                </div>
              </div>
            </div>
          )
        })}
      </div>

      {/* Schema output */}
      {windows.length > 0 && activeFields.length > 0 && (
        <>
          <SectionTitle label="Schema output" color="#22d3ee" />
          <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            {[
              ...activeFields.map((f) => ({ name: f.name, type: f.type, badge: 'originale', badgeColor: '#4a5a7a' })),
              ...windows.map((w) => {
                const fnDef   = WINDOW_FUNCTIONS.find((f) => f.value === w.fn)
                const catMeta = fnDef ? CATEGORY_META[fnDef.category] : CATEGORY_META.ranking
                return { name: w.outputField || `win_${w.fn}`, type: fnDef?.outputType ?? 'any', badge: fnDef?.label ?? w.fn, badgeColor: catMeta.color }
              }),
            ].map((f, i, arr) => (
              <div key={f.name} style={{ display: 'grid', gridTemplateColumns: '1fr 70px 100px', gap: 8, padding: '5px 10px', background: i % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: i < arr.length - 1 ? '0.5px solid #2a3349' : 'none', alignItems: 'center' }}>
                <code style={{ fontFamily: 'monospace', fontSize: 11, color: f.badge === 'originale' ? '#9a9aaa' : f.badgeColor }}>{f.name}</code>
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: `color-mix(in srgb, ${f.badgeColor} 12%, #0f1117)`, color: f.badgeColor, border: `0.5px solid ${f.badgeColor}30`, textAlign: 'center' }}>
                  {f.badge}
                </span>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', display: 'flex', gap: 5 }}>
            <i className="ti ti-check" style={{ fontSize: 9, color: '#22d3ee' }} />
            {activeFields.length} campi originali + {windows.length} calcolati → {activeFields.length + windows.length} totali propagati a valle.
          </div>
        </>
      )}

      {windows.length > 0 && (
        <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: `0.5px solid ${ACCENT}20`, fontSize: 10, color: '#4a5a7a', display: 'flex', gap: 6 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0, marginTop: 1 }} />
          {dataSource === 'materialize'
            ? 'Legge tutti i dati dal Materialize in una volta — nessun buffering interno necessario.'
            : 'Le righe passano invariate con i campi calcolati aggiunti. Richiede visibilità sull\'intera partizione.'}
        </div>
      )}
    </div>
  )
}
