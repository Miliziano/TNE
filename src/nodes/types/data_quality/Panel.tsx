/**
 * src/nodes/types/data_quality/Panel.tsx
 * ────────────────────────────────────────
 * Nuovo Data Quality con remediation e Data Trust Score.
 * P368: opzioni allineate al motore (data_quality.rs) — vedi schema.ts.
 */
import { useState, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'
import { readDqConfig } from './schema'
import { useDqSchemaSync } from './useDqSchemaSync'

import type {
  DQRule, DQConfig, DQDimension, DQCheckType, DQRepairStrategy,
} from './dqTypes'
import {
  DQ_CHECK_DEFS, DQ_REPAIR_DEFS,
} from './dqTypes'

const ACCENT = '#22d3ee'

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
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '6px 0 4px', borderBottom: `0.5px solid ${color}30`, marginBottom: 8 }}>
      {label}
    </div>
  )
}

// ─── Colori per dimensione ────────────────────────────────────────
const DIM_COLOR: Record<DQDimension, string> = {
  completeness: '#3ddc84',
  conformity:   '#4a9eff',
  consistency:  '#ffb347',
  accuracy:     '#a78bfa',
}

const DIM_LABEL: Record<DQDimension, string> = {
  completeness: 'Completeness',
  conformity:   'Conformity',
  consistency:  'Consistency',
  accuracy:     'Accuracy',
}

// ─── Riga singola regola ─────────────────────────────────────────
function RuleRow({ rule, fields, matVars, onChange, onDelete, onMove, isFirst, isLast }: {
  rule:     DQRule
  index:    number
  fields:   Array<{ name: string; type: string }>
  matVars:  Array<{ name: string }>
  onChange: (id: string, patch: Partial<DQRule>) => void
  onDelete: (id: string) => void
  onMove:   (id: string, dir: 'up' | 'down') => void
  isFirst:  boolean
  isLast:   boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const checkDef  = DQ_CHECK_DEFS.find((d) => d.type === rule.checkType)
  const repairDef = DQ_REPAIR_DEFS.find((d) => d.strategy === rule.repair)
  const dimColor  = DIM_COLOR[rule.dimension]

  return (
    <div style={{ border: `1px solid ${dimColor}30`, borderLeft: `3px solid ${dimColor}`, borderRadius: 6, overflow: 'hidden', opacity: rule.enabled ? 1 : 0.5 }}>

      {/* Header riga */}
      <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${dimColor} 6%, #1a2030)`, display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Riordina */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, flexShrink: 0 }}>
          <button onClick={() => onMove(rule.id, 'up')} disabled={isFirst}
            style={{ background: 'none', border: 'none', cursor: isFirst ? 'not-allowed' : 'pointer', color: isFirst ? '#2a3349' : '#8593b5', padding: 0, lineHeight: 1 }}>
            <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
          </button>
          <button onClick={() => onMove(rule.id, 'down')} disabled={isLast}
            style={{ background: 'none', border: 'none', cursor: isLast ? 'not-allowed' : 'pointer', color: isLast ? '#2a3349' : '#8593b5', padding: 0, lineHeight: 1 }}>
            <i className="ti ti-chevron-down" style={{ fontSize: 9 }} />
          </button>
        </div>

        {/* Badge dimensione */}
        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: `color-mix(in srgb, ${dimColor} 15%, #0f1117)`, color: dimColor, border: `0.5px solid ${dimColor}40`, flexShrink: 0 }}>
          {DIM_LABEL[rule.dimension].slice(0, 5).toUpperCase()}
        </span>

        {/* Campo + check */}
        <span style={{ fontFamily: 'monospace', fontSize: 10, color: dimColor, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {rule.field || '—'} · {checkDef?.label ?? rule.checkType}
        </span>

        {/* Repair badge */}
        {rule.repair !== 'none' && (
          <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: '#1a1000', color: '#ffb347', border: '0.5px solid #ffb34730', flexShrink: 0 }}>
            ✦ {repairDef?.label ?? rule.repair}
          </span>
        )}

        {/* Severity */}
        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: rule.severity === 'error' ? '#1a0000' : '#1a1000', color: rule.severity === 'error' ? '#ff5f57' : '#ffb347', flexShrink: 0 }}>
          {rule.severity}
        </span>

        {/* Enabled toggle */}
        <button onClick={() => onChange(rule.id, { enabled: !rule.enabled })}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: rule.enabled ? dimColor : '#2a3349', padding: 0, flexShrink: 0 }}>
          <i className={`ti ${rule.enabled ? 'ti-toggle-right' : 'ti-toggle-left'}`} style={{ fontSize: 14 }} />
        </button>

        <button onClick={() => setExpanded((v) => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0 }}>
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize: 10 }} />
        </button>

        <button onClick={() => onDelete(rule.id)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
          <i className="ti ti-x" style={{ fontSize: 10 }} />
        </button>
      </div>

      {/* Body espanso */}
      {expanded && (
        <div style={{ padding: '10px', background: '#161b27', display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Riga 1: campo + etichetta */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <div style={labelStyle}>Field</div>
              {fields.length > 0 ? (
                <CustomSelect style={inputStyle} value={rule.field}
                  onChange={(e) => onChange(rule.id, { field: e.target.value })}>
                  <option value="">— select —</option>
                  {fields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={rule.field}
                  onChange={(e) => onChange(rule.id, { field: e.target.value })} placeholder="field_name" />
              )}
            </div>
            <div>
              <div style={labelStyle}>Label</div>
              <input style={inputStyle} value={rule.label}
                onChange={(e) => onChange(rule.id, { label: e.target.value })} placeholder="rule description" />
            </div>
          </div>

          {/* Riga 2: dimensione + severity */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <div style={labelStyle}>DTS dimension</div>
              <CustomSelect style={{ ...inputStyle, color: dimColor }} value={rule.dimension}
                onChange={(e) => onChange(rule.id, { dimension: e.target.value as DQDimension })}>
                {(Object.keys(DIM_COLOR) as DQDimension[]).map((d) => (
                  <option key={d} value={d}>{DIM_LABEL[d]}</option>
                ))}
              </CustomSelect>
            </div>
            <div>
              <div style={labelStyle}>Severity</div>
              <CustomSelect style={{ ...inputStyle, color: rule.severity === 'error' ? '#ff5f57' : '#ffb347' }}
                value={rule.severity}
                onChange={(e) => onChange(rule.id, { severity: e.target.value as 'error' | 'warn' })}>
                <option value="error">error — if not repaired, level = error</option>
                <option value="warn">warn — lowers the score only</option>
              </CustomSelect>
            </div>
          </div>

          {/* Riga 3: tipo check */}
          <div>
            <div style={labelStyle}>Check type</div>
            <CustomSelect style={inputStyle} value={rule.checkType}
              onChange={(e) => onChange(rule.id, { checkType: e.target.value as DQCheckType })}>
              {Object.entries(
                DQ_CHECK_DEFS.reduce((acc, d) => {
                  acc[d.dimension] = acc[d.dimension] ?? []
                  acc[d.dimension].push(d)
                  return acc
                }, {} as Record<string, typeof DQ_CHECK_DEFS>)
              ).map(([dim, defs]) => (
                <optgroup key={dim} label={DIM_LABEL[dim as DQDimension]}>
                  {defs.map((d) => <option key={d.type} value={d.type}>{d.label}</option>)}
                </optgroup>
              ))}
            </CustomSelect>
            {checkDef && <div style={{ fontSize: 9, color: '#8593b5', marginTop: 3, fontStyle: 'italic' }}>{checkDef.desc}</div>}
          </div>

          {/* Parametri check */}
          {checkDef?.params.includes('pattern') && (
            <Field label="Regex pattern">
              <input style={{ ...inputStyle, color: '#a78bfa' }} value={rule.pattern ?? ''}
                onChange={(e) => onChange(rule.id, { pattern: e.target.value })}
                placeholder={'^[A-Z]{2}\\d+$'} />
            </Field>
          )}
          {(checkDef?.params.includes('min') || checkDef?.params.includes('max')) && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              {checkDef.params.includes('min') && (
                <Field label="Min">
                  <input style={inputStyle} value={rule.min ?? ''} onChange={(e) => onChange(rule.id, { min: e.target.value })} placeholder="0" />
                </Field>
              )}
              {checkDef.params.includes('max') && (
                <Field label="Max">
                  <input style={inputStyle} value={rule.max ?? ''} onChange={(e) => onChange(rule.id, { max: e.target.value })} placeholder="100" />
                </Field>
              )}
            </div>
          )}
          {checkDef?.params.includes('list') && (
            <Field label="Value list (comma)" hint="E.g. A, B, C, D">
              <input style={inputStyle} value={rule.list ?? ''} onChange={(e) => onChange(rule.id, { list: e.target.value })} placeholder="val1, val2, val3" />
            </Field>
          )}
          {checkDef?.params.includes('compareField') && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8 }}>
              <Field label="Field to compare">
                {fields.length > 0 ? (
                  <CustomSelect style={inputStyle} value={rule.compareField ?? ''}
                    onChange={(e) => onChange(rule.id, { compareField: e.target.value })}>
                    <option value="">— select —</option>
                    {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                  </CustomSelect>
                ) : (
                  <input style={inputStyle} value={rule.compareField ?? ''} onChange={(e) => onChange(rule.id, { compareField: e.target.value })} placeholder="other_field" />
                )}
              </Field>
              <Field label="Op.">
                <CustomSelect style={inputStyle} value={rule.compareOp ?? '>'}
                  onChange={(e) => onChange(rule.id, { compareOp: e.target.value })}>
                  {['>', '>=', '<', '<=', '==', '!='].map((op) => <option key={op} value={op}>{op}</option>)}
                </CustomSelect>
              </Field>
            </div>
          )}
          {checkDef?.params.includes('matName') && (
            <Field label="Reference Materialize">
              {matVars.length > 0 ? (
                <CustomSelect style={inputStyle} value={rule.matName ?? ''}
                  onChange={(e) => onChange(rule.id, { matName: e.target.value })}>
                  <option value="">— select —</option>
                  {matVars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={rule.matName ?? ''} onChange={(e) => onChange(rule.id, { matName: e.target.value })} placeholder="materialize_name" />
              )}
            </Field>
          )}
          {checkDef?.params.includes('refField') && (
            <Field label="Column of the Materialize" hint="The value must appear in this column">
              <input style={inputStyle} value={rule.refField ?? ''} onChange={(e) => onChange(rule.id, { refField: e.target.value })} placeholder="id" />
            </Field>
          )}
          {checkDef?.params.includes('expression') && (
            <Field label="FPEL expression"
              hint="Must return true (the row passes) or false. Use the field names: age > 18 && email is not null">
              <input style={{ ...inputStyle, color: '#f97316' }} value={rule.expression ?? ''}
                onChange={(e) => onChange(rule.id, { expression: e.target.value })}
                placeholder="age >= 18 && age <= 120" />
            </Field>
          )}

          {/* Repair */}
          <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 8 }}>
            <div style={labelStyle}>Repair strategy</div>
            <CustomSelect style={inputStyle} value={rule.repair}
              onChange={(e) => onChange(rule.id, { repair: e.target.value as DQRepairStrategy })}>
              {DQ_REPAIR_DEFS.map((d) => <option key={d.strategy} value={d.strategy}>{d.label}</option>)}
              {!repairDef && <option value={rule.repair}>{rule.repair} (not supported)</option>}
            </CustomSelect>
            {repairDef && <div style={{ fontSize: 9, color: '#8593b5', marginTop: 3, fontStyle: 'italic' }}>{repairDef.desc}</div>}
            {rule.repair === 'lookup_from_file' && (
              <div style={{ fontSize: 9, color: '#ffb347', marginTop: 3 }}>
                File lookup is not supported: load the file with File Source → Materialize and use "Lookup in Materialize".
              </div>
            )}
          </div>

          {/* Parametri repair */}
          {rule.repair === 'set_default' && (
            <Field label="Default value">
              <input style={{ ...inputStyle, color: '#ffb347' }} value={rule.repairDefault ?? ''}
                onChange={(e) => onChange(rule.id, { repairDefault: e.target.value })} placeholder="N/D" />
            </Field>
          )}
          {rule.repair === 'copy_from_field' && (
            <Field label="Source field">
              {fields.length > 0 ? (
                <CustomSelect style={inputStyle} value={rule.repairField ?? ''}
                  onChange={(e) => onChange(rule.id, { repairField: e.target.value })}>
                  <option value="">— select —</option>
                  {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={rule.repairField ?? ''} onChange={(e) => onChange(rule.id, { repairField: e.target.value })} placeholder="other_field" />
              )}
            </Field>
          )}
          {rule.repair === 'concat_fields' && (
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
              <Field label="Fields to concatenate (comma)">
                <input style={inputStyle} value={rule.repairFields ?? ''} onChange={(e) => onChange(rule.id, { repairFields: e.target.value })} placeholder="name, surname" />
              </Field>
              <Field label="Delimiter">
                <input style={inputStyle} value={rule.repairSeparator ?? ' '} onChange={(e) => onChange(rule.id, { repairSeparator: e.target.value })} placeholder=" " />
              </Field>
            </div>
          )}
          {rule.repair === 'lookup_from_materialize' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Field label="Materialize">
                {matVars.length > 0 ? (
                  <CustomSelect style={inputStyle} value={rule.matName ?? ''} onChange={(e) => onChange(rule.id, { matName: e.target.value })}>
                    <option value="">— select —</option>
                    {matVars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                  </CustomSelect>
                ) : (
                  <input style={inputStyle} value={rule.matName ?? ''} onChange={(e) => onChange(rule.id, { matName: e.target.value })} placeholder="materialize_name" />
                )}
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Field label="Key field" hint="Field of this row with the key; without a dataset key, the Materialize column of the same name">
                  {fields.length > 0 ? (
                    <CustomSelect style={inputStyle} value={rule.repairFileKey ?? ''}
                      onChange={(e) => onChange(rule.id, { repairFileKey: e.target.value })}>
                      <option value="">— select —</option>
                      {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                    </CustomSelect>
                  ) : (
                    <input style={inputStyle} value={rule.repairFileKey ?? ''} onChange={(e) => onChange(rule.id, { repairFileKey: e.target.value })} placeholder="code" />
                  )}
                </Field>
                <Field label="Value column" hint="Column of the Materialize copied into the field">
                  <input style={inputStyle} value={rule.repairFileValue ?? ''} onChange={(e) => onChange(rule.id, { repairFileValue: e.target.value })} placeholder="description" />
                </Field>
              </div>
            </div>
          )}
          {rule.repair === 'expression' && (
            <Field label="FPEL expression"
              hint="Must return the new value. Use the field names: coalesce(email, name + '@company.com')">
              <input style={{ ...inputStyle, color: '#f97316' }} value={rule.repairExpression ?? ''}
                onChange={(e) => onChange(rule.id, { repairExpression: e.target.value })}
                placeholder="name + ' ' + surname" />
            </Field>
          )}
        </div>
      )}
    </div>
  )
}

// ─── Panel principale ────────────────────────────────────────────
export function DataQualityPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const pool       = useFlowStore((s) => s.pool)
  const inFields   = useIncomingSchema(nodeId)
  // P368: lo schema d'uscita (ingresso + _dq) va a valle anche da qui.
  useDqSchemaSync(nodeId)

  // P368: tutti gli hook prima del return anticipato (prima useMemo veniva dopo).
  const rawConfig = node?.data.props['dqConfig']
  const config: DQConfig = useMemo(() => readDqConfig(rawConfig), [rawConfig])
  const laneId  = node?.data.laneId
  const matVars = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'materialize')
  }, [pool, laneId])
  const rulesByDim = useMemo(() => {
    const m = new Map<DQDimension, number>()
    for (const r of config.rules) m.set(r.dimension, (m.get(r.dimension) ?? 0) + 1)
    return m
  }, [config.rules])

  if (!node) return null

  const saveConfig = (c: DQConfig) => updateProp(nodeId, 'dqConfig', JSON.stringify(c))

  const addRule = () => {
    const newRule: DQRule = {
      id: `dq_${Date.now()}`, field: '', label: '', dimension: 'completeness',
      severity: 'error', enabled: true, checkType: 'not_null', repair: 'none',
    }
    saveConfig({ ...config, rules: [...config.rules, newRule] })
  }

  const updateRule = (id: string, patch: Partial<DQRule>) =>
    saveConfig({ ...config, rules: config.rules.map((r) => r.id === id ? { ...r, ...patch } : r) })

  const deleteRule = (id: string) =>
    saveConfig({ ...config, rules: config.rules.filter((r) => r.id !== id) })

  const moveRule = (id: string, dir: 'up' | 'down') => {
    const idx = config.rules.findIndex((r) => r.id === id)
    if (idx < 0) return
    const arr = [...config.rules]
    const swap = dir === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= arr.length) return
    ;[arr[idx], arr[swap]] = [arr[swap], arr[idx]]
    saveConfig({ ...config, rules: arr })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, color: ACCENT, marginBottom: 2 }}>◈ Data Trust Score</div>
        Each row receives a trust score 0–1 in the <code style={{ color: ACCENT }}>{config.outputField}</code> field.
        Problematic fields are <strong style={{ color: '#ffb347' }}>repaired automatically</strong> where possible.
        The rows <strong style={{ color: '#3ddc84' }}>always all pass</strong> — use a Filter afterwards to separate them by score.
      </div>

      {/* Stats dimensioni */}
      {config.rules.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(Object.keys(DIM_COLOR) as DQDimension[]).map((dim) => {
            const count = rulesByDim.get(dim) ?? 0
            if (count === 0) return null
            return (
              <div key={dim} style={{ fontSize: 9, padding: '2px 8px', borderRadius: 8, background: `color-mix(in srgb, ${DIM_COLOR[dim]} 10%, #0f1117)`, color: DIM_COLOR[dim], border: `0.5px solid ${DIM_COLOR[dim]}30` }}>
                {DIM_LABEL[dim]}: {count}
              </div>
            )
          })}
          <div style={{ fontSize: 9, padding: '2px 8px', borderRadius: 8, background: '#1a1000', color: '#ffb347', border: '0.5px solid #ffb34730' }}>
            {config.rules.filter((r) => r.repair !== 'none').length} with repair
          </div>
        </div>
      )}

      {/* Regole */}
      <SectionTitle label={`Rules — ${config.rules.length}`} />

      {config.rules.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-shield-star" style={{ fontSize: 24, display: 'block', marginBottom: 8, color: `${ACCENT}40` }} />
          Add rules to assess data quality and, if needed, repair them automatically.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {config.rules.map((rule, idx) => (
            <RuleRow key={rule.id} rule={rule} index={idx}
              fields={inFields} matVars={matVars}
              onChange={updateRule} onDelete={deleteRule} onMove={moveRule}
              isFirst={idx === 0} isLast={idx === config.rules.length - 1} />
          ))}
        </div>
      )}

      <button onClick={addRule}
        style={{ background: '#1a2030', border: `1px dashed ${ACCENT}40`, borderRadius: 6, padding: '7px', fontSize: 11, color: ACCENT, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}>
        <i className="ti ti-plus" style={{ fontSize: 12 }} /> Add rule
      </button>

      {/* Dimensioni e pesi */}
      <SectionTitle label="DTS dimension weights" color="#8593b5" />
      <div style={{ fontSize: 10, color: '#8593b5', marginBottom: 4 }}>
        Relative weight of each dimension in the final score. Dimensions without rules are left out and the other weights are rescaled.
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
        {(Object.keys(DIM_COLOR) as DQDimension[]).map((dim) => (
          <div key={dim} style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 6, border: `0.5px solid ${DIM_COLOR[dim]}30` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
              <span style={{ fontSize: 10, color: DIM_COLOR[dim], fontWeight: 600 }}>{DIM_LABEL[dim]}</span>
              <span style={{ fontSize: 10, color: DIM_COLOR[dim], fontFamily: 'monospace' }}>
                {Math.round(config.weights[dim] * 100)}%
              </span>
            </div>
            <input type="range" min="0" max="1" step="0.05"
              value={config.weights[dim]}
              onChange={(e) => saveConfig({ ...config, weights: { ...config.weights, [dim]: parseFloat(e.target.value) } })}
              style={{ width: '100%', accentColor: DIM_COLOR[dim] }} />
          </div>
        ))}
      </div>

      {/* Soglie */}
      <SectionTitle label="Quality thresholds" color="#8593b5" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Valid threshold (≥)" hint="score ≥ threshold → valid = true">
          <input type="number" style={{ ...inputStyle, color: '#3ddc84' }} min="0" max="1" step="0.05"
            value={config.thresholds.valid}
            onChange={(e) => saveConfig({ ...config, thresholds: { ...config.thresholds, valid: parseFloat(e.target.value) } })} />
        </Field>
        <Field label="Warning threshold (≥)" hint="below it → level = error">
          <input type="number" style={{ ...inputStyle, color: '#ffb347' }} min="0" max="1" step="0.05"
            value={config.thresholds.warning}
            onChange={(e) => saveConfig({ ...config, thresholds: { ...config.thresholds, warning: parseFloat(e.target.value) } })} />
        </Field>
      </div>

      {/* Opzioni output */}
      <SectionTitle label="Output" color="#8593b5" />
      <Field label="Output field name" hint="Field added to each row with the DTS result">
        <input style={{ ...inputStyle, color: ACCENT }} value={config.outputField}
          onChange={(e) => saveConfig({ ...config, outputField: e.target.value })} placeholder="_dq" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Include the original row" hint="The row as it arrived, before the repairs">
          <CustomSelect style={inputStyle} value={config.showOriginal ? 'true' : 'false'}
            onChange={(e) => saveConfig({ ...config, showOriginal: e.target.value === 'true' })}>
            <option value="false">No</option>
            <option value="true">Yes — in original_row</option>
          </CustomSelect>
        </Field>
        <Field label="Score pre-repair" hint="Compute score before and after">
          <CustomSelect style={inputStyle} value={config.scoreBeforeRepair ? 'true' : 'false'}
            onChange={(e) => saveConfig({ ...config, scoreBeforeRepair: e.target.value === 'true' })}>
            <option value="false">No — final score only</option>
            <option value="true">Yes — also score_original</option>
          </CustomSelect>
        </Field>
      </div>

      {/* Preview struttura _dq */}
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 9, fontFamily: 'monospace', color: '#8593b5', lineHeight: 1.8 }}>
        <div style={{ color: ACCENT, marginBottom: 4 }}>// {config.outputField || '_dq'} added to every row</div>
        <div><span style={{ color: '#a78bfa' }}>{config.outputField}</span>: {'{'}</div>
        <div style={{ paddingLeft: 12 }}>
          <div><span style={{ color: '#3ddc84' }}>score</span>: <span style={{ color: '#ffb347' }}>0.87</span>,</div>
          {config.scoreBeforeRepair && <div><span style={{ color: '#3ddc84' }}>score_original</span>: <span style={{ color: '#ffb347' }}>0.72</span>,</div>}
          <div><span style={{ color: '#3ddc84' }}>valid</span>: <span style={{ color: '#4a9eff' }}>true</span>,  <span style={{ color: '#2a3349' }}>// score ≥ {config.thresholds.valid}</span></div>
          <div><span style={{ color: '#3ddc84' }}>level</span>: <span style={{ color: '#c8d4f0' }}>"ok"</span>,  <span style={{ color: '#2a3349' }}>// ok | warn (score &lt; {config.thresholds.valid}) | error</span></div>
          <div><span style={{ color: '#3ddc84' }}>repaired</span>: <span style={{ color: '#4a9eff' }}>false</span>,</div>
          <div><span style={{ color: '#3ddc84' }}>dimensions</span>: {'{ completeness:1, conformity:0.8 }'},  <span style={{ color: '#2a3349' }}>// only those with rules</span></div>
          <div><span style={{ color: '#3ddc84' }}>issues</span>: [{'{ rule, field, dimension, severity, message, repaired, action, original, new_value }'}]{config.showOriginal ? ',' : ''}</div>
          {config.showOriginal && <div><span style={{ color: '#3ddc84' }}>original_row</span>: {'{ ... }'}</div>}
        </div>
        <div>{'}'}</div>
      </div>
    </div>
  )
}
