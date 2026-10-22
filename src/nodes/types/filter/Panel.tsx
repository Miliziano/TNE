/**
 * src/nodes/types/filter/Panel.tsx
 * Fix: cambio modalità (visual/template/code) preserva il campo selezionato.
 * P354: la modalità code è un'espressione FPEL (prima JS/TS/Python, mai
 * eseguita dal motore); case sensitive e modalità dei rami sono applicati.
 */
import { useCallback, useMemo, useState } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { ScriptEditor } from '../../../components/ScriptEditor'
import { CustomSelect } from '../../../components/CustomSelect'

import type {
  FilterConfig, FilterCondition, VisualClause,
  ConditionMode, ConditionOperator,
} from './filterTypes'
import {
  FILTER_TEMPLATES, getTemplatesByCategory, conditionToFpel, fpelField,
  isCaseSensitive, effectiveExecMode,
} from './filterTypes'
import { compileFpel } from '../../../ir/userFunctions'
import { ExprParseError } from '../../../ir/exprParser'

/** Sorgente della vecchia modalità code (JS/TS/Python, ≤ P353). */
function isLegacyCode(code: string | undefined): boolean {
  // => (JS/TS), -> (Java), def/lambda (Python): FPEL non ha nessuno dei tre
  return /=>|->|\bdef\s+\w+\s*\(|\blambda\b/.test(code ?? '')
}

/** Esito della compilazione FPEL di una condizione code (null = ok). */
function fpelError(code: string): string | null {
  if (!code.trim()) return 'The expression is empty'
  try { compileFpel(code); return null }
  catch (e) { return e instanceof ExprParseError ? e.pretty() : String(e) }
}

const ACCENT = '#ffb347'

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

// ─── Estrai campo da modalità corrente ───────────────────────────
// Tenta di capire su quale campo sta lavorando la condizione corrente
// per portarlo nella nuova modalità.
function extractPrimaryField(cond: FilterCondition): string {
  switch (cond.mode) {
    case 'visual': {
      // Primo campo delle clausole visive non vuoto
      const first = cond.clauses?.find((c) => c.field)
      return first?.field ?? ''
    }
    case 'template': {
      // Parametro 'field' del template corrente
      return cond.templateParams?.['field'] ?? ''
    }
    case 'code': {
      // Primo campo referenziato dall'espressione FPEL (se compila)
      try {
        const ir = JSON.stringify(compileFpel(cond.code ?? ''))
        return ir.match(/"kind":"DirectFieldRef","field":"((?:[^"\\]|\\.)*)"/)?.[1] ?? ''
      } catch { return '' }
    }
    default: return ''
  }
}

// ─── Costruisce patch per cambio modalità ────────────────────────
function buildModePatch(
  cond:     FilterCondition,
  newMode:  ConditionMode,
  caseSensitive: boolean,
  nullBehavior:  FilterConfig['nullBehavior'],
): Partial<FilterCondition> {
  const field = extractPrimaryField(cond)

  switch (newMode) {
    case 'visual': {
      // Porta il campo nelle clausole visive
      const existingClauses = cond.clauses ?? []
      const clauses: VisualClause[] = existingClauses.length > 0
        ? existingClauses.map((c, i) => i === 0 && field ? { ...c, field } : c)
        : [{ id: `c_${Date.now()}`, field, operator: '==' as ConditionOperator, value: '', logic: 'AND' }]
      return { mode: 'visual', clauses }
    }

    case 'template': {
      // Cerca un template con parametro 'field' e precompila
      const currentTemplate = FILTER_TEMPLATES.find((t) => t.id === cond.templateId)
      const templateId = cond.templateId ?? ''
      const baseParams = cond.templateParams ?? {}

      // Se il template corrente ha un parametro 'field', aggiorna
      const hasFieldParam = currentTemplate?.params.some((p) => p.key === 'field')
      const newParams = field
        ? { ...baseParams, ...(hasFieldParam || !templateId ? { field } : {}) }
        : baseParams

      // Se non c'è template selezionato, cerca uno adatto al campo
      // (per ora lasciamo la scelta all'utente, ma precompiliamo il parametro field)
      return { mode: 'template', templateId, templateParams: newParams }
    }

    case 'code': {
      // Punto di partenza: l'FPEL equivalente della modalità corrente;
      // un'espressione già scritta (FPEL valido) si tiene.
      const existing = (cond.code ?? '').trim()
      let code = existing
      if (!existing || existing === 'true' || isLegacyCode(existing)) {
        if (cond.mode === 'visual' && cond.clauses?.some((c) => c.field)) {
          code = conditionToFpel(cond, caseSensitive, nullBehavior)
        } else if (cond.mode === 'template' && cond.templateId) {
          code = conditionToFpel(cond, caseSensitive, nullBehavior)
        } else if (field) {
          code = `${fpelField(field)} is not null`
        } else {
          code = 'true'
        }
      }
      return { mode: 'code', code, lang: undefined }
    }

    default:
      return { mode: newMode }
  }
}

// ─── VisualBuilder ────────────────────────────────────────────────
function VisualBuilder({ clauses, onChange, incomingFields }: {
  clauses: VisualClause[]
  onChange: (clauses: VisualClause[]) => void
  incomingFields: Array<{ name: string; type: string }>
}) {
  const add = () => onChange([...clauses, {
    id: `c_${Date.now()}`, field: '', operator: '==' as ConditionOperator, value: '', logic: 'AND',
  }])
  const update = (id: string, key: keyof VisualClause, value: string) =>
    onChange(clauses.map((c) => c.id === id ? { ...c, [key]: value } : c))
  const remove = (id: string) => onChange(clauses.filter((c) => c.id !== id))

  const OPERATORS: Array<{ value: ConditionOperator; label: string }> = [
    { value: '==',       label: '= equals'            },
    { value: '!=',       label: '≠ not equal'         },
    { value: '>',        label: '> greater than'      },
    { value: '>=',       label: '≥ greater or equal'  },
    { value: '<',        label: '< less than'         },
    { value: '<=',       label: '≤ less or equal'     },
    { value: 'contains', label: '∋ contains'          },
    { value: 'starts',   label: '⊏ starts with'       },
    { value: 'ends',     label: '⊐ ends with'         },
    { value: 'is_null',  label: '∅ is null'            },
    { value: 'not_null', label: '≠∅ is not null'       },
    { value: 'in',       label: '∈ is in list'        },
    { value: 'not_in',   label: '∉ is not in list'    },
    { value: 'regex',    label: '~ regex'             },
  ]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {clauses.map((clause, idx) => {
        const noValue = ['is_null', 'not_null'].includes(clause.operator)
        return (
          <div key={clause.id} style={{ background: '#1e2535', border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
            {idx > 0 && (
              <div style={{ padding: '4px 10px', background: '#161b27', borderBottom: '0.5px solid #2a3349', display: 'flex', gap: 6 }}>
                {(['AND', 'OR'] as const).map((op) => (
                  <button key={op} onClick={() => update(clause.id, 'logic', op)}
                    style={{ padding: '2px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                      background: clause.logic === op ? '#1a3a6a' : 'transparent',
                      color: clause.logic === op ? '#4a9eff' : '#8593b5',
                      border: clause.logic === op ? '1px solid #2a5a9a' : '1px solid #2a3349' }}>
                    {op}
                  </button>
                ))}
              </div>
            )}
            <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>Field</div>
                  {incomingFields.length > 0 ? (
                    <CustomSelect style={inputStyle} value={clause.field}
                      onChange={(e) => update(clause.id, 'field', e.target.value)}>
                      <option value="">— select —</option>
                      {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                    </CustomSelect>
                  ) : (
                    <input style={inputStyle} value={clause.field}
                      onChange={(e) => update(clause.id, 'field', e.target.value)} placeholder="field_name" />
                  )}
                </div>
                <button onClick={() => remove(clause.id)} disabled={clauses.length === 1}
                  style={{ background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '4px 7px',
                    cursor: clauses.length === 1 ? 'not-allowed' : 'pointer',
                    color: clauses.length === 1 ? '#2a3349' : '#ff5f57', opacity: clauses.length === 1 ? 0.4 : 1 }}>
                  <i className="ti ti-x" style={{ fontSize: 11 }} />
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: noValue ? '1fr' : '1fr 1fr', gap: 6 }}>
                <div>
                  <div style={labelStyle}>Operator</div>
                  <CustomSelect style={inputStyle} value={clause.operator}
                    onChange={(e) => update(clause.id, 'operator', e.target.value as ConditionOperator)}>
                    {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>
                {!noValue && (
                  <div>
                    <div style={labelStyle}>{['in', 'not_in'].includes(clause.operator) ? 'Values (comma-separated)' : 'Value'}</div>
                    <input style={inputStyle} value={clause.value}
                      onChange={(e) => update(clause.id, 'value', e.target.value)}
                      placeholder={['in', 'not_in'].includes(clause.operator) ? 'val1, val2' : 'value'} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
      <button onClick={add}
        style={{ background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 6, padding: '6px', fontSize: 11, color: '#4a9eff', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}>
        <i className="ti ti-plus" style={{ fontSize: 11 }} /> Add clause
      </button>
    </div>
  )
}

// ─── TemplateBuilder ──────────────────────────────────────────────
function TemplateBuilder({ templateId, params, onChange }: {
  templateId: string; params: Record<string, string>
  onChange: (tid: string, p: Record<string, string>) => void
}) {
  const byCategory = getTemplatesByCategory()
  const selected   = FILTER_TEMPLATES.find((t) => t.id === templateId)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={labelStyle}>Template</div>
        <CustomSelect style={inputStyle} value={templateId} onChange={(e) => onChange(e.target.value, { ...params })}>
          <option value="">— select —</option>
          {Object.entries(byCategory).map(([cat, tpls]) => (
            <optgroup key={cat} label={cat}>
              {tpls.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
            </optgroup>
          ))}
        </CustomSelect>
      </div>
      {selected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{selected.description}</div>
          {selected.params.map((param) => (
            <Field key={param.key} label={param.label}>
              <input style={inputStyle} value={params[param.key] ?? ''}
                onChange={(e) => onChange(templateId, { ...params, [param.key]: e.target.value })}
                placeholder={param.placeholder} />
            </Field>
          ))}
        </div>
      )}
    </div>
  )
}

// ─── ConditionEditor ──────────────────────────────────────────────
function ConditionEditor({ cond, index, total, caseSensitive, nullBehavior, incomingFields, onUpdate, onDelete, onMoveUp, onMoveDown }: {
  cond: FilterCondition; index: number; total: number; caseSensitive: boolean
  nullBehavior: FilterConfig['nullBehavior']
  incomingFields: Array<{ name: string; type: string }>
  onUpdate: (patch: Partial<FilterCondition>) => void
  onDelete: () => void; onMoveUp: () => void; onMoveDown: () => void
}) {
  const [expanded, setExpanded] = useState(true)
  const schema = incomingFields.map((f) => ({ name: f.name, type: f.type }))

  // Campo attualmente selezionato — mostrato come hint quando si cambia modalità
  const currentField = extractPrimaryField(cond)

  const handleModeChange = useCallback((newMode: ConditionMode) => {
    if (newMode === cond.mode) return
    const patch = buildModePatch(cond, newMode, caseSensitive, nullBehavior)
    onUpdate(patch)
  }, [cond, onUpdate, caseSensitive, nullBehavior])

  const codeError = cond.mode === 'code' ? fpelError(cond.code ?? '') : null
  const legacy    = cond.mode === 'code' && isLegacyCode(cond.code)

  return (
    <div style={{ border: `1px solid ${cond.color}40`, borderRadius: 8, overflow: 'hidden' }}>
      <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${cond.color} 10%, #1a2030)`, display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Priorità + riordina */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexShrink: 0 }}>
          <span style={{ fontSize: 9, color: `${cond.color}80`, fontFamily: 'monospace', minWidth: 20, textAlign: 'center',
            background: `color-mix(in srgb, ${cond.color} 12%, #0f1117)`, borderRadius: 4, padding: '0 4px', lineHeight: '14px' }}>
            #{index + 1}
          </span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <button onClick={onMoveUp} disabled={index === 0}
              style={{ background: 'none', border: 'none', cursor: index === 0 ? 'not-allowed' : 'pointer', color: index === 0 ? '#2a3349' : '#8593b5', padding: 0, lineHeight: 1 }}>
              <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
            </button>
            <button onClick={onMoveDown} disabled={index === total - 1}
              style={{ background: 'none', border: 'none', cursor: index === total - 1 ? 'not-allowed' : 'pointer', color: index === total - 1 ? '#2a3349' : '#8593b5', padding: 0, lineHeight: 1 }}>
              <i className="ti ti-chevron-down" style={{ fontSize: 9 }} />
            </button>
          </div>
        </div>

        <input type="color" value={cond.color} onChange={(e) => onUpdate({ color: e.target.value })}
          style={{ width: 18, height: 18, border: 'none', borderRadius: 3, padding: 0, cursor: 'pointer', background: 'none', flexShrink: 0 }} />
        <input value={cond.label} onChange={(e) => onUpdate({ label: e.target.value })}
          style={{ background: 'none', border: 'none', outline: 'none', fontSize: 11, fontWeight: 600, color: cond.color, fontFamily: 'monospace', flex: 1, minWidth: 0 }}
          placeholder="output name" />

        {/* Selettori modalità — con tooltip che mostra il campo che verrà portato */}
        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
          {([
            { value: 'visual',   label: '⊞', title: 'Visual builder'  },
            { value: 'template', label: '⚡', title: 'Template'         },
            { value: 'code',     label: 'λ',  title: 'FPEL expression' },
          ] as Array<{ value: ConditionMode; label: string; title: string }>).map((m) => {
            const isActive = cond.mode === m.value
            const tip = isActive
              ? m.title
              : currentField
                ? `${m.title} — keeps the field "${currentField}"`
                : m.title
            return (
              <button key={m.value} onClick={() => handleModeChange(m.value)} title={tip}
                style={{ padding: '2px 6px', fontSize: 10, borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace',
                  background: isActive ? `color-mix(in srgb, ${cond.color} 25%, #161b27)` : '#1e2535',
                  color: isActive ? cond.color : '#8593b5',
                  border: isActive ? `1px solid ${cond.color}60` : '1px solid #2a3349' }}>
                {m.label}
              </button>
            )
          })}
        </div>

        <button onClick={() => setExpanded((v) => !v)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: '0 2px' }}>
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize: 10 }} />
        </button>
        <button onClick={onDelete} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: '0 2px' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
          <i className="ti ti-x" style={{ fontSize: 11 }} />
        </button>
      </div>

      {expanded && (
        <div style={{ padding: '10px', background: '#161b27' }}>
          {/* Badge campo attivo — visibile quando c'è un campo selezionato */}
          {currentField && (
            <div style={{ marginBottom: 8, display: 'flex', alignItems: 'center', gap: 6, padding: '3px 8px',
              background: `color-mix(in srgb, ${cond.color} 8%, #0f1117)`,
              borderRadius: 4, border: `0.5px solid ${cond.color}30` }}>
              <i className="ti ti-arrow-right" style={{ fontSize: 9, color: cond.color }} />
              <span style={{ fontSize: 9, color: '#8593b5' }}>Field: </span>
              <code style={{ fontSize: 10, color: cond.color }}>{currentField}</code>
              <span style={{ fontSize: 9, color: '#2a3349', marginLeft: 4 }}>— will be carried over if you change mode</span>
            </div>
          )}

          {cond.mode === 'visual' && (
            <VisualBuilder
              clauses={cond.clauses ?? [{ id: 'c1', field: '', operator: '==' as ConditionOperator, value: '', logic: 'AND' }]}
              onChange={(clauses) => onUpdate({ clauses })} incomingFields={incomingFields} />
          )}
          {cond.mode === 'template' && (
            <TemplateBuilder templateId={cond.templateId ?? ''} params={cond.templateParams ?? {}}
              onChange={(tid, p) => onUpdate({ templateId: tid, templateParams: p })} />
          )}
          {cond.mode === 'code' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 10, color: '#8593b5', lineHeight: 1.5 }}>
                A boolean <strong style={{ color: '#c8d4f0' }}>FPEL</strong> expression on the row's fields — e.g.{' '}
                <code style={{ color: '#a78bfa' }}>{'amount > 100 && lower(country) == "it"'}</code>.
                The row matches when the result is true. Case sensitive does not apply here: use lower() / upper().
              </div>
              <ScriptEditor value={cond.code ?? ''}
                onChange={(code) => onUpdate({ code })}
                language="flowpilot" schema={schema} height={110} />
              {legacy ? (
                <div style={{ padding: '6px 10px', background: '#2a1a0a', borderRadius: 4, border: '0.5px solid #6a4a1a', fontSize: 10, color: '#ffb347' }}>
                  <i className="ti ti-alert-triangle" style={{ fontSize: 11, marginRight: 4 }} />
                  This condition was written for the old JavaScript code mode, which never ran in the engine. Rewrite it as an FPEL expression.
                </div>
              ) : codeError ? (
                <pre style={{ margin: 0, padding: '6px 10px', background: '#2a0a0a', borderRadius: 4, border: '0.5px solid #5a1a1a', fontSize: 10, color: '#ff8a80', whiteSpace: 'pre-wrap', fontFamily: 'monospace' }}>
                  {codeError}
                </pre>
              ) : (
                <div style={{ fontSize: 10, color: '#3ddc84' }}>
                  <i className="ti ti-check" style={{ fontSize: 11, marginRight: 4 }} />Valid FPEL expression
                </div>
              )}
            </div>
          )}
          {cond.mode !== 'code' && (
            <div style={{ marginTop: 8, padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
              <div style={{ fontSize: 9, color: '#8593b5', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.06em' }}>Equivalent FPEL</div>
              <code style={{ fontSize: 10, color: '#3ddc84', fontFamily: 'monospace', wordBreak: 'break-all' }}>{conditionToFpel(cond, caseSensitive, nullBehavior) || '(select a template)'}</code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── FilterPanel ──────────────────────────────────────────────────
export function FilterPanel({ nodeId }: { nodeId: string }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const incomingFields = useIncomingSchema(nodeId)

  if (!node) return null

  const config: FilterConfig & { execMode?: string } = useMemo(() => {
    try {
      const raw = node.data.config?.filter
      if (raw) return raw as any
    } catch {}
    return { conditions: [], nullBehavior: 'exclude', caseSensitive: true, execMode: 'parallel' }
  }, [node.data.config?.filter])

  const saveConfig = useCallback((newConfig: any) => {
    useFlowStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId ? { ...n, data: { ...n.data, config: { ...n.data.config, filter: newConfig } } } : n
      ),
    }))
  }, [nodeId])

  const addCondition = useCallback(() => {
    const idx    = config.conditions.length
    const colors = ['#4a9eff', '#3ddc84', '#ffb347', '#a78bfa', '#22d3ee', '#f472b6']
    saveConfig({
      ...config,
      conditions: [...config.conditions, {
        id: `cond_${Date.now()}`, label: `output_${idx + 1}`,
        color: colors[idx % colors.length], mode: 'visual',
        clauses: [{ id: `c_${Date.now()}`, field: '', operator: '==' as ConditionOperator, value: '', logic: 'AND' }],
      }],
    })
  }, [config, saveConfig])

  const updateCondition = useCallback((id: string, patch: Partial<FilterCondition>) =>
    saveConfig({ ...config, conditions: config.conditions.map((c) => c.id === id ? { ...c, ...patch } : c) })
  , [config, saveConfig])

  const deleteCondition = useCallback((id: string) =>
    saveConfig({ ...config, conditions: config.conditions.filter((c) => c.id !== id) })
  , [config, saveConfig])

  const moveCondition = useCallback((id: string, dir: 'up' | 'down') => {
    const idx = config.conditions.findIndex((c) => c.id === id)
    if (idx < 0) return
    const arr  = [...config.conditions]
    const swap = dir === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= arr.length) return
    ;[arr[idx], arr[swap]] = [arr[swap], arr[idx]]
    saveConfig({ ...config, conditions: arr })
  }, [config, saveConfig])

  // 'sequential' (legacy) si mostra come parallel: è ciò che il motore fa.
  const execMode      = effectiveExecMode(config)
  const caseSensitive = isCaseSensitive(config)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {incomingFields.length > 0 && (
        <div style={{ padding: '6px 10px', background: '#0d3d20', borderRadius: 4, border: '0.5px solid #1d6d40', fontSize: 10, color: '#3ddc84', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ color: '#8593b5', marginRight: 4 }}>Available fields:</span>
          {incomingFields.map((f) => <code key={f.name} style={{ background: '#1d6d4040', padding: '1px 6px', borderRadius: 3 }}>{f.name}</code>)}
        </div>
      )}

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0 }} />
        Conditions are evaluated in order — each row goes to the <strong style={{ color: ACCENT }}>first that matches</strong> (first-match).
        Rows that satisfy no condition go to <strong style={{ color: '#ff5f57' }}>reject</strong>.
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', flex: 1 }}>
          Conditions — {config.conditions.length}
        </span>
        <button onClick={addCondition}
          style={{ padding: '3px 12px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
            background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT,
            border: `1px solid ${ACCENT}60`, display: 'flex', alignItems: 'center', gap: 4 }}>
          <i className="ti ti-plus" style={{ fontSize: 11 }} /> Condition
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {config.conditions.length === 0 ? (
          <div style={{ padding: '24px', textAlign: 'center', color: '#2a3349', fontSize: 11, background: '#0f1117', borderRadius: 8, border: '1px dashed #2a3349' }}>
            <i className="ti ti-filter" style={{ fontSize: 28, display: 'block', marginBottom: 8, color: `${ACCENT}20` }} />
            No condition. All rows go to <span style={{ color: '#ff5f57' }}>reject</span>.
          </div>
        ) : (
          config.conditions.map((cond, idx) => (
            <ConditionEditor key={cond.id} cond={cond} index={idx} total={config.conditions.length}
              caseSensitive={caseSensitive} nullBehavior={config.nullBehavior ?? 'exclude'}
              incomingFields={incomingFields}
              onUpdate={(patch) => updateCondition(cond.id, patch)}
              onDelete={() => deleteCondition(cond.id)}
              onMoveUp={() => moveCondition(cond.id, 'up')}
              onMoveDown={() => moveCondition(cond.id, 'down')} />
          ))
        )}
      </div>

      <div style={{ padding: '8px 12px', background: '#1a0a0a', border: '1px solid #3a1a1a', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 9, color: '#ff5f5750', fontFamily: 'monospace', background: '#2a000020', borderRadius: 4, padding: '0 4px', lineHeight: '14px' }}>
          #{config.conditions.length + 1}
        </span>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff5f57' }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#ff5f57' }}>reject</div>
          <div style={{ fontSize: 9, color: '#8593b5' }}>Rows that satisfy no condition — always present</div>
        </div>
      </div>

      {/* Opzioni globali */}
      <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em' }}>Global options</span>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Null behavior" hint="Visual clauses only">
            <CustomSelect style={inputStyle} value={config.nullBehavior}
              onChange={(e) => saveConfig({ ...config, nullBehavior: e.target.value as FilterConfig['nullBehavior'] })}>
              <option value="exclude">Exclude (→ reject)</option>
              <option value="include">Include in evaluation</option>
              <option value="error">Error on null</option>
            </CustomSelect>
          </Field>
          <Field label="Case sensitive" hint="Visual and template text comparisons">
            <CustomSelect style={inputStyle} value={caseSensitive ? 'true' : 'false'}
              onChange={(e) => saveConfig({ ...config, caseSensitive: e.target.value === 'true' })}>
              <option value="true">Yes</option>
              <option value="false">No</option>
            </CustomSelect>
          </Field>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 10, fontWeight: 600, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em' }}>
            Branch execution mode
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {[
              { value: 'parallel',     icon: '⇉', label: 'All in parallel',     desc: 'Rows flow to every branch as soon as they are routed.', color: '#4a9eff' },
              { value: 'ordered_wait', icon: '⏱', label: 'Ordered with wait', desc: 'Branch #1 flows immediately; branch #N is held in memory and released only when everything downstream of branch #N-1 has finished (e.g. master rows before detail rows). If that part fails, the later branches are not emitted. Nodes reached by more than one branch cannot be waited for.', color: '#3ddc84' },
            ].map((m) => (
              <button key={m.value} onClick={() => saveConfig({ ...config, execMode: m.value })}
                style={{ padding: '8px 12px', borderRadius: 6, cursor: 'pointer', textAlign: 'left',
                  background: execMode === m.value ? `color-mix(in srgb, ${m.color} 10%, #1a2030)` : '#1a2030',
                  border: execMode === m.value ? `1px solid ${m.color}50` : '1px solid #2a3349',
                  display: 'flex', alignItems: 'flex-start', gap: 10 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, marginTop: 3,
                  background: execMode === m.value ? m.color : 'transparent',
                  border: `1.5px solid ${execMode === m.value ? m.color : '#2a3349'}` }} />
                <div style={{ flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 2 }}>
                    <span style={{ fontSize: 12, color: m.color }}>{m.icon}</span>
                    <span style={{ fontSize: 11, fontWeight: 600, color: execMode === m.value ? m.color : '#c8d4f0' }}>{m.label}</span>
                  </div>
                  <div style={{ fontSize: 9, color: '#8593b5', lineHeight: 1.5 }}>{m.desc}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}