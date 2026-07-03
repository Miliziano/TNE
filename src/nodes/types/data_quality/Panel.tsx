/**
 * src/nodes/types/data_quality/Panel.tsx
 * ────────────────────────────────────────
 * Nuovo Data Quality con remediation e Data Trust Score.
 */
import { useState, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'

import type {
  DQRule, DQConfig, DQDimension, DQCheckType, DQRepairStrategy,
} from './dqTypes'
import {
  DEFAULT_DQ_CONFIG, DQ_CHECK_DEFS, DQ_REPAIR_DEFS,
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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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
  completeness: 'Completezza',
  conformity:   'Conformità',
  consistency:  'Coerenza',
  accuracy:     'Accuratezza',
}

// ─── Riga singola regola ─────────────────────────────────────────
function RuleRow({ rule, index, fields, matVars, onChange, onDelete, onMove, isFirst, isLast }: {
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
            style={{ background: 'none', border: 'none', cursor: isFirst ? 'not-allowed' : 'pointer', color: isFirst ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
            <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
          </button>
          <button onClick={() => onMove(rule.id, 'down')} disabled={isLast}
            style={{ background: 'none', border: 'none', cursor: isLast ? 'not-allowed' : 'pointer', color: isLast ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
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
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0 }}>
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize: 10 }} />
        </button>

        <button onClick={() => onDelete(rule.id)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-x" style={{ fontSize: 10 }} />
        </button>
      </div>

      {/* Body espanso */}
      {expanded && (
        <div style={{ padding: '10px', background: '#161b27', display: 'flex', flexDirection: 'column', gap: 8 }}>

          {/* Riga 1: campo + etichetta */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <div style={labelStyle}>Campo</div>
              {fields.length > 0 ? (
                <CustomSelect style={inputStyle} value={rule.field}
                  onChange={(e) => onChange(rule.id, { field: e.target.value })}>
                  <option value="">— seleziona —</option>
                  {fields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={rule.field}
                  onChange={(e) => onChange(rule.id, { field: e.target.value })} placeholder="nome_campo" />
              )}
            </div>
            <div>
              <div style={labelStyle}>Etichetta</div>
              <input style={inputStyle} value={rule.label}
                onChange={(e) => onChange(rule.id, { label: e.target.value })} placeholder="descrizione regola" />
            </div>
          </div>

          {/* Riga 2: dimensione + severity */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <div>
              <div style={labelStyle}>Dimensione DTS</div>
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
                <option value="error">error — penalizza score</option>
                <option value="warn">warn — segnala solo</option>
              </CustomSelect>
            </div>
          </div>

          {/* Riga 3: tipo check */}
          <div>
            <div style={labelStyle}>Tipo controllo</div>
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
            {checkDef && <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 3, fontStyle: 'italic' }}>{checkDef.desc}</div>}
          </div>

          {/* Parametri check */}
          {checkDef?.params.includes('pattern') && (
            <Field label={rule.checkType === 'is_date' ? 'Formato data (opzionale)' : 'Regex pattern'}>
              <input style={{ ...inputStyle, color: '#a78bfa' }} value={rule.pattern ?? ''}
                onChange={(e) => onChange(rule.id, { pattern: e.target.value })}
                placeholder={rule.checkType === 'is_date' ? 'yyyy-MM-dd' : '^[A-Z]{2}\\d+$'} />
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
            <Field label="Lista valori (virgola)" hint="Es: A, B, C, D">
              <input style={inputStyle} value={rule.list ?? ''} onChange={(e) => onChange(rule.id, { list: e.target.value })} placeholder="val1, val2, val3" />
            </Field>
          )}
          {checkDef?.params.includes('compareField') && (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 8 }}>
              <Field label="Campo da confrontare">
                {fields.length > 0 ? (
                  <CustomSelect style={inputStyle} value={rule.compareField ?? ''}
                    onChange={(e) => onChange(rule.id, { compareField: e.target.value })}>
                    <option value="">— seleziona —</option>
                    {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                  </CustomSelect>
                ) : (
                  <input style={inputStyle} value={rule.compareField ?? ''} onChange={(e) => onChange(rule.id, { compareField: e.target.value })} placeholder="altro_campo" />
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
            <Field label="Materialize di riferimento">
              {matVars.length > 0 ? (
                <CustomSelect style={inputStyle} value={rule.matName ?? ''}
                  onChange={(e) => onChange(rule.id, { matName: e.target.value })}>
                  <option value="">— seleziona —</option>
                  {matVars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={rule.matName ?? ''} onChange={(e) => onChange(rule.id, { matName: e.target.value })} placeholder="nome_materialize" />
              )}
            </Field>
          )}
          {checkDef?.params.includes('refField') && (
            <Field label="Campo chiave nel Materialize">
              <input style={inputStyle} value={rule.refField ?? ''} onChange={(e) => onChange(rule.id, { refField: e.target.value })} placeholder="id" />
            </Field>
          )}
          {checkDef?.params.includes('expression') && (
            <Field label="Espressione JS" hint="Deve restituire true/false. Usa row.campo per accedere ai valori.">
              <input style={{ ...inputStyle, color: '#f97316' }} value={rule.expression ?? ''}
                onChange={(e) => onChange(rule.id, { expression: e.target.value })}
                placeholder="row.eta >= 18 && row.eta <= 120" />
            </Field>
          )}

          {/* Repair */}
          <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 8 }}>
            <div style={labelStyle}>Strategia di repair</div>
            <CustomSelect style={inputStyle} value={rule.repair}
              onChange={(e) => onChange(rule.id, { repair: e.target.value as DQRepairStrategy })}>
              {DQ_REPAIR_DEFS.map((d) => <option key={d.strategy} value={d.strategy}>{d.label} — {d.desc.slice(0, 40)}…</option>)}
            </CustomSelect>
          </div>

          {/* Parametri repair */}
          {rule.repair === 'set_default' && (
            <Field label="Valore di default">
              <input style={{ ...inputStyle, color: '#ffb347' }} value={rule.repairDefault ?? ''}
                onChange={(e) => onChange(rule.id, { repairDefault: e.target.value })} placeholder="N/D" />
            </Field>
          )}
          {rule.repair === 'copy_from_field' && (
            <Field label="Campo sorgente">
              {fields.length > 0 ? (
                <CustomSelect style={inputStyle} value={rule.repairField ?? ''}
                  onChange={(e) => onChange(rule.id, { repairField: e.target.value })}>
                  <option value="">— seleziona —</option>
                  {fields.map((f) => <option key={f.name} value={f.name}>{f.name}</option>)}
                </CustomSelect>
              ) : (
                <input style={inputStyle} value={rule.repairField ?? ''} onChange={(e) => onChange(rule.id, { repairField: e.target.value })} placeholder="altro_campo" />
              )}
            </Field>
          )}
          {rule.repair === 'concat_fields' && (
            <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 8 }}>
              <Field label="Campi da concatenare (virgola)">
                <input style={inputStyle} value={rule.repairFields ?? ''} onChange={(e) => onChange(rule.id, { repairFields: e.target.value })} placeholder="nome, cognome" />
              </Field>
              <Field label="Separatore">
                <input style={inputStyle} value={rule.repairSeparator ?? ' '} onChange={(e) => onChange(rule.id, { repairSeparator: e.target.value })} placeholder=" " />
              </Field>
            </div>
          )}
          {rule.repair === 'lookup_from_file' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Field label="Path file CSV" hint="File con colonna chiave e colonna valore">
                <input style={inputStyle} value={rule.repairFile ?? ''} onChange={(e) => onChange(rule.id, { repairFile: e.target.value })} placeholder="/data/lookup.csv" />
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Field label="Colonna chiave">
                  <input style={inputStyle} value={rule.repairFileKey ?? ''} onChange={(e) => onChange(rule.id, { repairFileKey: e.target.value })} placeholder="codice" />
                </Field>
                <Field label="Colonna valore">
                  <input style={inputStyle} value={rule.repairFileValue ?? ''} onChange={(e) => onChange(rule.id, { repairFileValue: e.target.value })} placeholder="descrizione" />
                </Field>
              </div>
            </div>
          )}
          {rule.repair === 'lookup_from_materialize' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <Field label="Materialize">
                {matVars.length > 0 ? (
                  <CustomSelect style={inputStyle} value={rule.matName ?? ''} onChange={(e) => onChange(rule.id, { matName: e.target.value })}>
                    <option value="">— seleziona —</option>
                    {matVars.map((v) => <option key={v.name} value={v.name}>{v.name}</option>)}
                  </CustomSelect>
                ) : (
                  <input style={inputStyle} value={rule.matName ?? ''} onChange={(e) => onChange(rule.id, { matName: e.target.value })} placeholder="nome_materialize" />
                )}
              </Field>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Field label="Campo chiave">
                  <input style={inputStyle} value={rule.repairFileKey ?? ''} onChange={(e) => onChange(rule.id, { repairFileKey: e.target.value })} placeholder="codice" />
                </Field>
                <Field label="Campo valore">
                  <input style={inputStyle} value={rule.repairFileValue ?? ''} onChange={(e) => onChange(rule.id, { repairFileValue: e.target.value })} placeholder="descrizione" />
                </Field>
              </div>
            </div>
          )}
          {rule.repair === 'expression' && (
            <Field label="Espressione JS" hint="Deve restituire il nuovo valore. Usa row.campo e prev.campo.">
              <input style={{ ...inputStyle, color: '#f97316' }} value={rule.repairExpression ?? ''}
                onChange={(e) => onChange(rule.id, { repairExpression: e.target.value })}
                placeholder="row.nome + ' ' + row.cognome" />
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

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def

  const config: DQConfig = useMemo(() => {
    try {
      const raw = JSON.parse(p('dqConfig', '{}'))
      return { ...DEFAULT_DQ_CONFIG, ...raw, weights: { ...DEFAULT_DQ_CONFIG.weights, ...raw.weights }, thresholds: { ...DEFAULT_DQ_CONFIG.thresholds, ...raw.thresholds } }
    } catch { return DEFAULT_DQ_CONFIG }
  }, [p('dqConfig')])

  const saveConfig = (c: DQConfig) => updateProp(nodeId, 'dqConfig', JSON.stringify(c))

  const laneId  = node.data.laneId
  const matVars = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'materialize')
  }, [pool, laneId])

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

  const rulesByDim = useMemo(() => {
    const m = new Map<DQDimension, number>()
    for (const r of config.rules) m.set(r.dimension, (m.get(r.dimension) ?? 0) + 1)
    return m
  }, [config.rules])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.6 }}>
        <div style={{ fontWeight: 600, color: ACCENT, marginBottom: 2 }}>◈ Data Trust Score</div>
        Ogni riga riceve un punteggio di affidabilità 0–1 nel campo <code style={{ color: ACCENT }}>{config.outputField}</code>.
        I campi problematici vengono <strong style={{ color: '#ffb347' }}>riparati automaticamente</strong> dove possibile.
        Le righe passano <strong style={{ color: '#3ddc84' }}>sempre tutte</strong> — usa un Filter dopo per separarle per score.
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
            {config.rules.filter((r) => r.repair !== 'none').length} con repair
          </div>
        </div>
      )}

      {/* Regole */}
      <SectionTitle label={`Regole — ${config.rules.length}`} />

      {config.rules.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-shield-star" style={{ fontSize: 24, display: 'block', marginBottom: 8, color: `${ACCENT}40` }} />
          Aggiungi regole per valutare la qualità dei dati e, se necessario, ripararli automaticamente.
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
        <i className="ti ti-plus" style={{ fontSize: 12 }} /> Aggiungi regola
      </button>

      {/* Dimensioni e pesi */}
      <SectionTitle label="Pesi dimensioni DTS" color="#4a5a7a" />
      <div style={{ fontSize: 10, color: '#4a5a7a', marginBottom: 4 }}>
        La somma dei pesi determina l'importanza relativa di ogni dimensione nel calcolo del score finale.
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
      <SectionTitle label="Soglie di qualità" color="#4a5a7a" />
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Soglia valido (≥)" hint="_dq.valid = true">
          <input type="number" style={{ ...inputStyle, color: '#3ddc84' }} min="0" max="1" step="0.05"
            value={config.thresholds.valid}
            onChange={(e) => saveConfig({ ...config, thresholds: { ...config.thresholds, valid: parseFloat(e.target.value) } })} />
        </Field>
        <Field label="Soglia warning (≥)" hint="_dq.level = warn">
          <input type="number" style={{ ...inputStyle, color: '#ffb347' }} min="0" max="1" step="0.05"
            value={config.thresholds.warning}
            onChange={(e) => saveConfig({ ...config, thresholds: { ...config.thresholds, warning: parseFloat(e.target.value) } })} />
        </Field>
      </div>

      {/* Opzioni output */}
      <SectionTitle label="Output" color="#4a5a7a" />
      <Field label="Nome campo output" hint="Campo aggiunto a ogni riga con il risultato DTS">
        <input style={{ ...inputStyle, color: ACCENT }} value={config.outputField}
          onChange={(e) => saveConfig({ ...config, outputField: e.target.value })} placeholder="_dq" />
      </Field>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
        <Field label="Includi valori originali" hint="Prima della repair">
          <CustomSelect style={inputStyle} value={config.showOriginal ? 'true' : 'false'}
            onChange={(e) => saveConfig({ ...config, showOriginal: e.target.value === 'true' })}>
            <option value="false">No</option>
            <option value="true">Sì — in _dq.issues[].original</option>
          </CustomSelect>
        </Field>
        <Field label="Score pre-repair" hint="Calcola score prima e dopo">
          <CustomSelect style={inputStyle} value={config.scoreBeforeRepair ? 'true' : 'false'}
            onChange={(e) => saveConfig({ ...config, scoreBeforeRepair: e.target.value === 'true' })}>
            <option value="false">No — solo score finale</option>
            <option value="true">Sì — anche _dq.scoreOriginal</option>
          </CustomSelect>
        </Field>
      </div>

      {/* Preview struttura _dq */}
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: `0.5px solid ${ACCENT}20`, fontSize: 9, fontFamily: 'monospace', color: '#4a5a7a', lineHeight: 1.8 }}>
        <div style={{ color: ACCENT, marginBottom: 4 }}>// struttura {config.outputField} aggiunta a ogni riga</div>
        <div><span style={{ color: '#a78bfa' }}>{config.outputField}</span>: {'{'}</div>
        <div style={{ paddingLeft: 12 }}>
          <div><span style={{ color: '#3ddc84' }}>score</span>: <span style={{ color: '#ffb347' }}>0.87</span>,</div>
          {config.scoreBeforeRepair && <div><span style={{ color: '#3ddc84' }}>scoreOriginal</span>: <span style={{ color: '#ffb347' }}>0.72</span>,</div>}
          <div><span style={{ color: '#3ddc84' }}>valid</span>: <span style={{ color: '#4a9eff' }}>true</span>,  <span style={{ color: '#2a3349' }}>// score ≥ {config.thresholds.valid}</span></div>
          <div><span style={{ color: '#3ddc84' }}>level</span>: <span style={{ color: '#c8d4f0' }}>"ok"</span>,  <span style={{ color: '#2a3349' }}>// ok | warn | error</span></div>
          <div><span style={{ color: '#3ddc84' }}>repaired</span>: <span style={{ color: '#4a9eff' }}>false</span>,</div>
          <div><span style={{ color: '#3ddc84' }}>dimensions</span>: {'{ completeness:1, conformity:0.8, consistency:1, accuracy:0.7 }'},</div>
          <div><span style={{ color: '#3ddc84' }}>issues</span>: [...]</div>
        </div>
        <div>{'}'}</div>
      </div>
    </div>
  )
}
