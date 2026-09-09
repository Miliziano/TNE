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
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
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
  { id: 'table',      label: '⊞ Data table',    desc: 'Rows and columns with totals'           },
  { id: 'summary',    label: '◉ Summary KPI',      desc: 'Cards with key metrics'             },
  { id: 'bar_chart',  label: '▦ Bar Chart',        desc: 'Compare values by category'       },
  { id: 'line_chart', label: '↗ Line Chart',       desc: 'Trend over time'                  },
  { id: 'pie_chart',  label: '◔ Pie / Donut',      desc: 'Percentage distribution'            },
  { id: 'mixed',      label: '⊕ Full report',  desc: 'Summary + chart + table'          },
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
  { value: 'lt',       label: '< less than'         },
  { value: 'lte',      label: '≤ less than or equal'   },
  { value: 'gt',       label: '> greater than'        },
  { value: 'gte',      label: '≥ greater than or equal' },
  { value: 'eq',       label: '= equal to'           },
  { value: 'neq',      label: '≠ not equal to'         },
  { value: 'contains', label: '∋ contains'           },
  { value: 'is_null',  label: '∅ is empty/null'       },
  { value: 'not_null', label: '≠∅ is not empty'       },
  { value: 'custom',   label: 'λ JS expression'     },
]
const STYLE_OPTS = [
  { value: 'danger',  label: '🔴 Danger — red'    },
  { value: 'warning', label: '🟡 Warning — orange'},
  { value: 'success', label: '🟢 Success — green'    },
  { value: 'info',    label: '🔵 Info — blue'          },
  { value: 'custom',  label: '🎨 Custom'      },
]
const ICON_OPTS = [
  { value: '',          label: 'None'    },
  { value: 'arrow_up',  label: '↑ Up'       },
  { value: 'arrow_down',label: '↓ Down'      },
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
                <div style={labelStyle}>Condition</div>
                <CustomSelect style={inputStyle} value={rule.condition}
                  onChange={(e) => updateRule(rule.id, { condition: e.target.value })}>
                  {CONDITION_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              {needsValue(rule.condition) && rule.condition !== 'custom' ? (
                <div>
                  <div style={labelStyle}>Value</div>
                  <input style={inputStyle} value={rule.value}
                    onChange={(e) => updateRule(rule.id, { value: e.target.value })} placeholder="0" />
                </div>
              ) : <div />}
              <div>
                <div style={labelStyle}>Apply to</div>
                <CustomSelect style={inputStyle} value={rule.target}
                  onChange={(e) => updateRule(rule.id, { target: e.target.value as 'cell' | 'row' })}>
                  <option value="cell">Cell</option>
                  <option value="row">Whole row</option>
                </CustomSelect>
              </div>
              <button onClick={() => deleteRule(rule.id)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0, alignSelf: 'flex-end', marginBottom: 2 }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
                <i className="ti ti-x" style={{ fontSize: 11 }} />
              </button>
            </div>

            {/* Espressione custom */}
            {rule.condition === 'custom' && (
              <div>
                <div style={labelStyle}>JS expression</div>
                <input style={{ ...inputStyle, color: '#a78bfa' }} value={rule.expression ?? ''}
                  onChange={(e) => updateRule(rule.id, { expression: e.target.value })}
                  placeholder={`row.${col.field} < row.minimum`} />
                <div style={{ fontSize: 9, color: '#8593b5', marginTop: 2 }}>Use <code style={{ color: '#a78bfa' }}>row.field</code> — must return true/false</div>
              </div>
            )}

            {/* Riga 2: stile + icona */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <div>
                <div style={labelStyle}>Style</div>
                <CustomSelect style={{ ...inputStyle, color: styleColor }} value={rule.style}
                  onChange={(e) => updateRule(rule.id, { style: e.target.value })}>
                  {STYLE_OPTS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </CustomSelect>
              </div>
              <div>
                <div style={labelStyle}>Icon</div>
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
                  <div style={labelStyle}>Background</div>
                  <div style={{ display: 'flex', gap: 4 }}>
                    <input type="color" value={rule.bgColor ?? '#fff0f0'}
                      onChange={(e) => updateRule(rule.id, { bgColor: e.target.value })}
                      style={{ width: 32, height: 28, border: 'none', borderRadius: 4, padding: 2, cursor: 'pointer', background: 'none' }} />
                    <input style={{ ...inputStyle, flex: 1 }} value={rule.bgColor ?? ''}
                      onChange={(e) => updateRule(rule.id, { bgColor: e.target.value })} placeholder="#fff0f0" />
                  </div>
                </div>
                <div>
                  <div style={labelStyle}>Text</div>
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
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Add rule
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
            <div style={labelStyle}>Field</div>
            {incomingFields.length > 0 ? (
              <CustomSelect style={inputStyle} value={col.field}
                onChange={(e) => onChange({ ...col, field: e.target.value })}>
                <option value="">— select —</option>
                {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
              </CustomSelect>
            ) : (
              <input style={inputStyle} value={col.field}
                onChange={(e) => onChange({ ...col, field: e.target.value })} placeholder="nome_campo" />
            )}
          </div>
          <div>
            <div style={labelStyle}>Label</div>
            <input style={inputStyle} value={col.label}
              onChange={(e) => onChange({ ...col, label: e.target.value })} placeholder="Header" />
          </div>
          <button onClick={onDelete}
            style={{ marginTop: 16, background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '0 8px', cursor: 'pointer', color: '#ff5f57', alignSelf: 'flex-end', height: 28 }}>
            <i className="ti ti-x" style={{ fontSize: 10 }} />
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          <div>
            <div style={labelStyle}>Type</div>
            <CustomSelect style={inputStyle} value={col.type}
              onChange={(e) => onChange({ ...col, type: e.target.value as ColumnConfig['type'] })}>
              <option value="text">Text</option>
              <option value="number">Number</option>
              <option value="currency">Currency</option>
              <option value="date">Date</option>
            </CustomSelect>
          </div>
          <div>
            <div style={labelStyle}>Row total</div>
            <CustomSelect style={inputStyle} value={col.total ?? 'none'}
              onChange={(e) => onChange({ ...col, total: e.target.value })}>
              <option value="none">None</option>
              <option value="sum">Sum</option>
              <option value="avg">Average</option>
              <option value="count">Count</option>
            </CustomSelect>
          </div>
        </div>

        {/* Toggle regole */}
        <button onClick={() => setShowRules((v) => !v)}
          style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: ruleCount > 0 ? `color-mix(in srgb, ${ACCENT} 10%, #0f1117)` : '#1e2535', color: ruleCount > 0 ? ACCENT : '#8593b5', border: `0.5px solid ${ruleCount > 0 ? ACCENT + '40' : '#2a3349'}`, display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className={`ti ${showRules ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize: 10 }} />
          Formatting rules
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
      <SectionTitle label="Report template" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {REPORT_TEMPLATES.map((tmpl) => (
          <button key={tmpl.id} onClick={() => updateProp(nodeId, 'templateId', tmpl.id)}
            style={{ padding: '8px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              background: templateId === tmpl.id ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: templateId === tmpl.id ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: templateId === tmpl.id ? ACCENT : '#c8d4f0' }}>{tmpl.label}</span>
            <span style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.3 }}>{tmpl.desc}</span>
          </button>
        ))}
      </div>

      {/* Formato */}
      <SectionTitle label="Output format" />
      <div style={{ display: 'flex', gap: 6 }}>
        {(['html', 'excel'] as const).map((fmt) => (
          <button key={fmt} onClick={() => updateProp(nodeId, 'outputFormat', fmt)}
            style={{ flex: 1, padding: '6px', borderRadius: 4, cursor: 'pointer',
              background: outputFmt === fmt ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: outputFmt === fmt ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              color: outputFmt === fmt ? ACCENT : '#8593b5', fontSize: 11, fontWeight: outputFmt === fmt ? 600 : 400 }}>
            {fmt.toUpperCase()}
          </button>
        ))}
      </div>

      {/* Intestazione */}
      <SectionTitle label="Header" />
      <Field label="Report title">
        <input style={inputStyle} value={p('reportTitle')} onChange={u('reportTitle')} placeholder="Monthly sales report" />
      </Field>
      <Row>
        <Field label="Subtitle">
          <input style={inputStyle} value={p('reportSubtitle')} onChange={u('reportSubtitle')} placeholder="Period: {month}" />
        </Field>
        <Field label="Output file name">
          <input style={inputStyle} value={p('filename')} onChange={u('filename')} placeholder="report_{date}" />
        </Field>
      </Row>

      {/* Colonne */}
      {(templateId === 'table' || templateId === 'mixed') && (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <SectionTitle label={`Columns — ${columns.length}`} />
            <button onClick={addColumn}
              style={{ marginLeft: 'auto', padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT,
                border: `1px solid ${ACCENT}60`, display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
              <i className="ti ti-plus" style={{ fontSize: 10 }} /> Column
            </button>
          </div>

          {columns.length === 0 ? (
            <div style={{ padding: '12px', textAlign: 'center', color: '#2a3349', fontSize: 11, background: '#0f1117', borderRadius: 6, border: '1px dashed #2a3349' }}>
              No columns — all incoming fields will be used (without conditional formatting).
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

          {/* Info DQ — legenda di come il report tratta i campi del Data Quality */}
          <div style={{ padding: '10px 12px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #ffb34730', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, fontWeight: 600, color: '#ffb347' }}>
              <i className="ti ti-shield-check" style={{ fontSize: 12 }} />
              If there is a Data Quality node upstream
            </div>
            <div style={{ fontSize: 9, color: '#8a8a9a', lineHeight: 1.5 }}>
              Flagged cells are highlighted and marked automatically — you don't need to configure anything:
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5, fontSize: 9, color: '#c8d4f0' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ minWidth: 26, textAlign: 'center', padding: '1px 5px', borderRadius: 3, background: '#f39c12', color: '#fff', fontWeight: 700 }}>✦</span>
                value <strong>repaired</strong> by Data Quality — hover to see the original
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ minWidth: 26, textAlign: 'center', padding: '1px 5px', borderRadius: 3, background: '#e74c3c', color: '#fff', fontWeight: 700 }}>!</span>
                unresolved quality <strong>error</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ minWidth: 26, textAlign: 'center', padding: '1px 5px', borderRadius: 3, background: '#f39c12', color: '#fff', fontWeight: 700 }}>⚠</span>
                quality <strong>warning</strong>
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                <span style={{ minWidth: 26, textAlign: 'center', padding: '1px 5px', borderRadius: 3, background: '#1a3a6a', color: '#fff', fontWeight: 700, fontSize: 8 }}>DTS</span>
                column with the quality <strong>score</strong> per row — green ≥80%, orange ≥60%, red below
              </div>
            </div>
            <div style={{ fontSize: 9, color: '#8593b5' }}>
              The field to read is set below (default <code style={{ color: '#8a8a9a' }}>_dq</code>).
            </div>
          </div>
        </>
      )}

      {/* Configurazione grafico */}
      {['bar_chart','line_chart','pie_chart','mixed','summary'].includes(templateId) && (
        <>
          <SectionTitle label="Chart/KPI configuration" />
          <Row>
            <Field label="X-axis / category field">
              {incomingFields.length > 0 ? (
                <CustomSelect style={inputStyle} value={p('chartXField')} onChange={u('chartXField')}>
                  <option value="">— select —</option>
                  {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={p('chartXField')} onChange={u('chartXField')} placeholder="category" />
              )}
            </Field>
            <Field label="Value field (Y-axis)">
              {incomingFields.length > 0 ? (
                <CustomSelect style={inputStyle} value={p('chartYField')} onChange={u('chartYField')}>
                  <option value="">— select —</option>
                  {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={p('chartYField')} onChange={u('chartYField')} placeholder="value" />
              )}
            </Field>
          </Row>
          <Field label="Chart title">
            <input style={inputStyle} value={p('chartTitle')} onChange={u('chartTitle')} placeholder="Salaries by city" />
          </Field>
          {templateId === 'summary' && (
            <Field label="KPI fields" hint="Fields to show as cards (comma-separated) — empty = all">
              <input style={inputStyle} value={p('kpiFields')} onChange={u('kpiFields')} placeholder="total, average, count" />
            </Field>
          )}
        </>
      )}

      {/* Stile */}
      <SectionTitle label="Style" />
      <Row>
        <Field label="Color theme">
          <CustomSelect style={inputStyle} value={p('colorTheme', 'blue')} onChange={u('colorTheme')}>
            <option value="blue">Blue — professional</option>
            <option value="green">Green — nature/finance</option>
            <option value="dark">Dark — modern</option>
            <option value="orange">Orange — energy</option>
            <option value="custom">Custom</option>
          </CustomSelect>
        </Field>
        <Field label="Language">
          <CustomSelect style={inputStyle} value={p('locale', 'it')} onChange={u('locale')}>
            <option value="it">Italiano</option>
            <option value="en">English</option>
          </CustomSelect>
        </Field>
      </Row>
      {p('colorTheme') === 'custom' && (
        <Row>
          <Field label="Primary color">
            <input type="color" style={{ ...inputStyle, padding: 2, height: 28 }} value={p('primaryColor', '#1a3a6a')} onChange={u('primaryColor')} />
          </Field>
          <Field label="Accent color">
            <input type="color" style={{ ...inputStyle, padding: 2, height: 28 }} value={p('accentColor', '#4a9eff')} onChange={u('accentColor')} />
          </Field>
        </Row>
      )}

      {/* Campo DQ */}
      <Field label="Data Quality field" hint="Name of the _dq field added by the Data Quality node — default: _dq">
        <input style={inputStyle} value={p('dqField', '_dq')} onChange={u('dqField')} placeholder="_dq" />
      </Field>

    </div>
  )
}