/**
 * src/nodes/types/report_generator/Panel.tsx
 * Aggiunge configurazione regole conditional formatting per colonna.
 */
import { useMemo, useState } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
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
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}
function SectionTitle({ label, color = '#f472b6' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

const ACCENT = '#f472b6'

const REPORT_TEMPLATES = [
  { id: 'table',      label: '⊞ Tabella dati',    desc: 'Righe e colonne con totali'           },
  { id: 'summary',    label: '◉ Summary KPI',      desc: 'Card con metriche chiave'             },
  { id: 'bar_chart',  label: '▦ Bar Chart',        desc: 'Confronto valori per categoria'       },
  { id: 'line_chart', label: '↗ Line Chart',       desc: 'Andamento temporale'                  },
  { id: 'pie_chart',  label: '◔ Pie / Donut',      desc: 'Distribuzione percentuale'            },
  { id: 'mixed',      label: '⊕ Report completo',  desc: 'Summary + grafico + tabella'          },
]

interface CellRule {
  id: string; condition: string; value: string
  target: 'cell' | 'row'; style: string
  bgColor?: string; textColor?: string; icon?: string; expression?: string
}

interface ColumnConfig {
  id: string; field: string; label: string
  type: 'text' | 'number' | 'currency' | 'date'
  total?: string; rules?: CellRule[]
}

const CONDITION_OPTS = [
  { value: 'lt',       label: '< minore di'         },
  { value: 'lte',      label: '≤ minore o uguale'   },
  { value: 'gt',       label: '> maggiore di'        },
  { value: 'gte',      label: '≥ maggiore o uguale' },
  { value: 'eq',       label: '= uguale a'           },
  { value: 'neq',      label: '≠ diverso da'         },
  { value: 'contains', label: '∋ contiene'           },
  { value: 'is_null',  label: '∅ è vuoto/null'       },
  { value: 'not_null', label: '≠∅ non è vuoto'       },
  { value: 'custom',   label: 'λ espressione JS'     },
]
const STYLE_OPTS = [
  { value: 'danger',  label: '🔴 Danger — rosso'    },
  { value: 'warning', label: '🟡 Warning — arancione'},
  { value: 'success', label: '🟢 Success — verde'    },
  { value: 'info',    label: '🔵 Info — blu'          },
  { value: 'custom',  label: '🎨 Personalizzato'      },
]
const ICON_OPTS = [
  { value: '',          label: 'Nessuna'    },
  { value: 'arrow_up',  label: '↑ Su'       },
  { value: 'arrow_down',label: '↓ Giù'      },
  { value: 'warning',   label: '⚠ Warning'  },
  { value: 'check',     label: '✓ Check'    },
  { value: 'dot',       label: '● Dot'      },
  { value: 'star',      label: '★ Star'     },
]

// ─── Editor regole per una colonna ───────────────────────────────
function RulesEditor({ col, fields, onChange }: {
  col:      ColumnConfig
  fields:   Array<{ name: string; type: string }>
  onChange: (rules: CellRule[]) => void
}) {
  const rules = col.rules ?? []

  const addRule = () => onChange([...rules, {
    id: `r_${Date.now()}`, condition: 'lt', value: '0',
    target: 'cell', style: 'danger', icon: '',
  }])

  const updateRule = (id: string, patch: Partial<CellRule>) =>
    onChange(rules.map((r) => r.id === id ? { ...r, ...patch } : r))

  const deleteRule = (id: string) =>
    onChange(rules.filter((r) => r.id !== id))

  const needsValue = (cond: string) => !['is_null', 'not_null'].includes(cond)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
      {rules.map((rule, idx) => {
        const styleColor = { danger: '#ff5f57', warning: '#ffb347', success: '#3ddc84', info: '#4a9eff', custom: '#a78bfa' }[rule.style] ?? '#4a9eff'
        return (
          <div key={rule.id} style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: `1px solid ${styleColor}30`, borderLeft: `3px solid ${styleColor}`, display: 'flex', flexDirection: 'column', gap: 6 }}>
            {/* Riga 1: condizione + valore + target + elimina */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 90px 24px', gap: 6, alignItems: 'end' }}>
              <div>
                <div style={labelStyle}>Condizione</div>
                <CustomSelect style={inputStyle} value={rule.condition}
                  onChange={(e) => updateRule(rule.id, { condition: e.target.value })}>
                  {CONDITION_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              {needsValue(rule.condition) && rule.condition !== 'custom' ? (
                <div>
                  <div style={labelStyle}>Valore</div>
                  <input style={inputStyle} value={rule.value}
                    onChange={(e) => updateRule(rule.id, { value: e.target.value })} placeholder="0" />
                </div>
              ) : <div />}
              <div>
                <div style={labelStyle}>Applica a</div>
                <CustomSelect style={inputStyle} value={rule.target}
                  onChange={(e) => updateRule(rule.id, { target: e.target.value as 'cell' | 'row' })}>
                  <option value="cell">Cella</option>
                  <option value="row">Riga intera</option>
                </CustomSelect>
              </div>
              <button onClick={() => deleteRule(rule.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, alignSelf: 'flex-end', marginBottom: 2 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                <i className="ti ti-x" style={{ fontSize: 11 }} />
              </button>
            </div>

            {/* Espressione custom */}
            {rule.condition === 'custom' && (
              <div>
                <div style={labelStyle}>Espressione JS</div>
                <input style={{ ...inputStyle, color: '#a78bfa' }} value={rule.expression ?? ''}
                  onChange={(e) => updateRule(rule.id, { expression: e.target.value })}
                  placeholder={`row.${col.field} < row.minimo`} />
                <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 2 }}>Usa <code style={{ color: '#a78bfa' }}>row.campo</code> — deve restituire true/false</div>
              </div>
            )}

            {/* Riga 2: stile + icona */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <div>
                <div style={labelStyle}>Stile</div>
                <CustomSelect style={{ ...inputStyle, color: styleColor }} value={rule.style}
                  onChange={(e) => updateRule(rule.id, { style: e.target.value })}>
                  {STYLE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <div style={labelStyle}>Icona</div>
                <CustomSelect style={inputStyle} value={rule.icon ?? ''}
                  onChange={(e) => updateRule(rule.id, { icon: e.target.value })}>
                  {ICON_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
            </div>

            {/* Colori custom */}
            {rule.style === 'custom' && (
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
                <div>
                  <div style={labelStyle}>Sfondo</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type="color" value={rule.bgColor ?? '#fff0f0'}
                      onChange={(e) => updateRule(rule.id, { bgColor: e.target.value })}
                      style={{ width: 32, height: 28, border: 'none', borderRadius: 4, padding: 2, cursor: 'pointer', background: 'none' }} />
                    <input style={{ ...inputStyle, flex: 1 }} value={rule.bgColor ?? ''}
                      onChange={(e) => updateRule(rule.id, { bgColor: e.target.value })} placeholder="#fff0f0" />
                  </div>
                </div>
                <div>
                  <div style={labelStyle}>Testo</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type="color" value={rule.textColor ?? '#c0392b'}
                      onChange={(e) => updateRule(rule.id, { textColor: e.target.value })}
                      style={{ width: 32, height: 28, border: 'none', borderRadius: 4, padding: 2, cursor: 'pointer', background: 'none' }} />
                    <input style={{ ...inputStyle, flex: 1 }} value={rule.textColor ?? ''}
                      onChange={(e) => updateRule(rule.id, { textColor: e.target.value })} placeholder="#c0392b" />
                  </div>
                </div>
              </div>
            )}
          </div>
        )
      })}
      <button onClick={addRule}
        style={{ padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#f472b6', border: '0.5px dashed #f472b630', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Aggiungi regola
      </button>
    </div>
  )
}

// ─── Colonna con regole ───────────────────────────────────────────
function ColumnRow({ col, incomingFields, onChange, onDelete }: {
  col:            ColumnConfig
  incomingFields: Array<{ name: string; type: string }>
  onChange:       (col: ColumnConfig) => void
  onDelete:       () => void
}) {
  const [showRules, setShowRules] = useState(false)
  const ruleCount = col.rules?.length ?? 0

  return (
    <div style={{ background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', overflow: 'hidden' }}>
      {/* Header colonna */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: 6 }}>
          <div>
            <div style={labelStyle}>Campo</div>
            {incomingFields.length > 0 ? (
              <CustomSelect style={inputStyle} value={col.field}
                onChange={(e) => onChange({ ...col, field: e.target.value })}>
                <option value="">— seleziona —</option>
                {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={col.field}
                onChange={(e) => onChange({ ...col, field: e.target.value })} placeholder="nome_campo" />
            )}
          </div>
          <div>
            <div style={labelStyle}>Etichetta</div>
            <input style={inputStyle} value={col.label}
              onChange={(e) => onChange({ ...col, label: e.target.value })} placeholder="Intestazione" />
          </div>
          <button onClick={onDelete}
            style={{ marginTop: 16, background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '0 8px', cursor: 'pointer', color: '#ff5f57', alignSelf: 'flex-end', height: 28 }}>
            <i className="ti ti-x" style={{ fontSize: 10 }} />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <div>
            <div style={labelStyle}>Tipo</div>
            <CustomSelect style={inputStyle} value={col.type}
              onChange={(e) => onChange({ ...col, type: e.target.value as ColumnConfig['type'] })}>
              <option value="text">Testo</option>
              <option value="number">Numero</option>
              <option value="currency">Valuta</option>
              <option value="date">Data</option>
            </CustomSelect>
          </div>
          <div>
            <div style={labelStyle}>Totale riga</div>
            <CustomSelect style={inputStyle} value={col.total ?? 'none'}
              onChange={(e) => onChange({ ...col, total: e.target.value })}>
              <option value="none">Nessuno</option>
              <option value="sum">Somma</option>
              <option value="avg">Media</option>
              <option value="count">Conteggio</option>
            </CustomSelect>
          </div>
        </div>

        {/* Toggle regole */}
        <button onClick={() => setShowRules((v) => !v)}
          style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: ruleCount > 0 ? `color-mix(in srgb, ${ACCENT} 10%, #0f1117)` : '#1e2535', color: ruleCount > 0 ? ACCENT : '#4a5a7a', border: `0.5px solid ${ruleCount > 0 ? ACCENT + '40' : '#2a3349'}`, display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className={`ti ${showRules ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize: 10 }} />
          Regole formattazione
          {ruleCount > 0 && <span style={{ fontSize: 9, padding: '0 5px', borderRadius: 8, background: ACCENT, color: '#0f1117', fontWeight: 700 }}>{ruleCount}</span>}
        </button>
      </div>

      {/* Editor regole */}
      {showRules && (
        <div style={{ padding: '0 10px 10px', borderTop: '0.5px solid #2a3349' }}>
          <RulesEditor col={col} fields={incomingFields}
            onChange={(rules) => onChange({ ...col, rules })} />
        </div>
      )}
    </div>
  )
}

// ─── Panel principale ────────────────────────────────────────────
export function ReportGeneratorPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const incomingFields = useIncomingSchema(nodeId)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const templateId = p('templateId', 'table')
  const outputFmt  = p('outputFormat', 'html')

  const columns: ColumnConfig[] = useMemo(() => {
    try { return JSON.parse(p('columns', '[]')) } catch { return [] }
  }, [p('columns')])

  const saveColumns = (cols: ColumnConfig[]) =>
    updateProp(nodeId, 'columns', JSON.stringify(cols))

  const addColumn = () => saveColumns([...columns, {
    id: `col_${Date.now()}`, field: '', label: '', type: 'text', total: 'none', rules: [],
  }])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Template */}
      <SectionTitle label="Template report" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {REPORT_TEMPLATES.map((tmpl) => (
          <button key={tmpl.id} onClick={() => updateProp(nodeId, 'templateId', tmpl.id)}
            style={{ padding: '8px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              background: templateId === tmpl.id ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: templateId === tmpl.id ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: templateId === tmpl.id ? ACCENT : '#c8d4f0' }}>{tmpl.label}</span>
            <span style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.3 }}>{tmpl.desc}</span>
          </button>
        ))}
      </div>

      {/* Formato */}
      <SectionTitle label="Formato output" />
      <div style={{ display: 'flex', gap: 6 }}>
        {(['html', 'excel'] as const).map((fmt) => (
          <button key={fmt} onClick={() => updateProp(nodeId, 'outputFormat', fmt)}
            style={{ flex: 1, padding: '6px', borderRadius: 4, cursor: 'pointer',
              background: outputFmt === fmt ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: outputFmt === fmt ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              color: outputFmt === fmt ? ACCENT : '#4a5a7a', fontSize: 11, fontWeight: outputFmt === fmt ? 600 : 400 }}>
            {fmt.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Intestazione */}
      <SectionTitle label="Intestazione" />
      <Field label="Titolo report">
        <input style={inputStyle} value={p('reportTitle')} onChange={u('reportTitle')} placeholder="Report mensile vendite" />
      </Field>
      <Row>
        <Field label="Sottotitolo">
          <input style={inputStyle} value={p('reportSubtitle')} onChange={u('reportSubtitle')} placeholder="Periodo: {month}" />
        </Field>
        <Field label="Nome file output">
          <input style={inputStyle} value={p('filename')} onChange={u('filename')} placeholder="report_{date}" />
        </Field>
      </Row>

      {/* Colonne */}
      {(templateId === 'table' || templateId === 'mixed') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SectionTitle label={`Colonne — ${columns.length}`} />
            <button onClick={addColumn}
              style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT,
                border: `1px solid ${ACCENT}60`, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <i className="ti ti-plus" style={{ fontSize: 10 }} /> Colonna
            </button>
          </div>

          {columns.length === 0 ? (
            <div style={{ padding: '12px', textAlign: 'center', color: '#2a3349', fontSize: 11, background: '#0f1117', borderRadius: 6, border: '1px dashed #2a3349' }}>
              Nessuna colonna — verranno usati tutti i campi in ingresso (senza formattazione condizionale).
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {columns.map((col) => (
                <ColumnRow key={col.id} col={col} incomingFields={incomingFields}
                  onChange={(updated) => saveColumns(columns.map((c) => c.id === col.id ? updated : c))}
                  onDelete={() => saveColumns(columns.filter((c) => c.id !== col.id))} />
              ))}
            </div>
          )}

          {/* Info DQ */}
          <div style={{ padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #ffb34730', fontSize: 9, color: '#ffb347', display: 'flex', gap: 5 }}>
            <i className="ti ti-shield-check" style={{ fontSize: 10, flexShrink: 0, marginTop: 1 }} />
            Se le righe provengono da un nodo <strong>Data Quality</strong>, le celle riparate vengono evidenziate
            automaticamente con <strong>✦</strong> e la colonna <strong>DTS</strong> mostra lo score di qualità.
            Non serve configurare nulla.
          </div>
        </>
      )}

      {/* Configurazione grafico */}
      {['bar_chart','line_chart','pie_chart','mixed','summary'].includes(templateId) && (
        <>
          <SectionTitle label="Configurazione grafico/KPI" />
          <Row>
            <Field label="Campo asse X / categoria">
              {incomingFields.length > 0 ? (
                <CustomSelect style={inputStyle} value={p('chartXField')} onChange={u('chartXField')}>
                  <option value="">— seleziona —</option>
                  {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={p('chartXField')} onChange={u('chartXField')} placeholder="categoria" />
              )}
            </Field>
            <Field label="Campo valore (asse Y)">
              {incomingFields.length > 0 ? (
                <CustomSelect style={inputStyle} value={p('chartYField')} onChange={u('chartYField')}>
                  <option value="">— seleziona —</option>
                  {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={p('chartYField')} onChange={u('chartYField')} placeholder="valore" />
              )}
            </Field>
          </Row>
          <Field label="Titolo grafico">
            <input style={inputStyle} value={p('chartTitle')} onChange={u('chartTitle')} placeholder="Stipendi per città" />
          </Field>
          {templateId === 'summary' && (
            <Field label="Campi KPI" hint="Campi da mostrare come card (separati da virgola) — vuoto = tutti">
              <input style={inputStyle} value={p('kpiFields')} onChange={u('kpiFields')} placeholder="totale, media, conteggio" />
            </Field>
          )}
        </>
      )}

      {/* Stile */}
      <SectionTitle label="Stile" />
      <Row>
        <Field label="Tema colori">
          <CustomSelect style={inputStyle} value={p('colorTheme', 'blue')} onChange={u('colorTheme')}>
            <option value="blue">Blue — professionale</option>
            <option value="green">Green — natura/finance</option>
            <option value="dark">Dark — moderno</option>
            <option value="orange">Orange — energia</option>
            <option value="custom">Custom</option>
          </CustomSelect>
        </Field>
        <Field label="Lingua">
          <CustomSelect style={inputStyle} value={p('locale', 'it')} onChange={u('locale')}>
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </CustomSelect>
        </Field>
      </Row>
      {p('colorTheme') === 'custom' && (
        <Row>
          <Field label="Colore primario">
            <input type="color" style={{ ...inputStyle, padding: 2, height: 28 }} value={p('primaryColor', '#1a3a6a')} onChange={u('primaryColor')} />
          </Field>
          <Field label="Colore accento">
            <input type="color" style={{ ...inputStyle, padding: 2, height: 28 }} value={p('accentColor', '#4a9eff')} onChange={u('accentColor')} />
          </Field>
        </Row>
      )}

      {/* Campo DQ */}
      <Field label="Campo Data Quality" hint="Nome del campo _dq aggiunto dal nodo Data Quality — default: _dq">
        <input style={inputStyle} value={p('dqField', '_dq')} onChange={u('dqField')} placeholder="_dq" />
      </Field>

    </div>
  )
}