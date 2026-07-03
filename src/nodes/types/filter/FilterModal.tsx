import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useFlowStore } from '../../../store/flowStore'
import { ScriptEditor } from '../../../components/ScriptEditor'
import { useIncomingSchema } from '../../useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'

import type {
  FilterConfig, FilterCondition, VisualClause,
  ConditionMode, ConditionOperator,
} from './filterTypes'
import {
  FILTER_TEMPLATES, getTemplatesByCategory, conditionToCode,
} from './filterTypes'

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

const CONDITION_COLORS = [
  '#4a9eff', '#3ddc84', '#ffb347', '#a78bfa', '#22d3ee',
  '#f472b6', '#84cc16', '#fb923c', '#e879f9', '#ff5f57',
]

const OPERATORS: Array<{ value: ConditionOperator; label: string }> = [
  { value: '==',       label: '= uguale'           },
  { value: '!=',       label: '≠ diverso'           },
  { value: '>',        label: '> maggiore'          },
  { value: '>=',       label: '≥ maggiore o uguale' },
  { value: '<',        label: '< minore'            },
  { value: '<=',       label: '≤ minore o uguale'   },
  { value: 'contains', label: '∋ contiene'          },
  { value: 'starts',   label: '⊏ inizia con'        },
  { value: 'ends',     label: '⊐ finisce con'       },
  { value: 'is_null',  label: '∅ è null'            },
  { value: 'not_null', label: '≠∅ non è null'       },
  { value: 'in',       label: '∈ è in lista'        },
  { value: 'not_in',   label: '∉ non è in lista'    },
  { value: 'regex',    label: '~ regex'             },
]

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

// ─── VisualBuilder ────────────────────────────────────────────────
function VisualBuilder({ clauses, onChange, incomingFields }: {
  clauses: VisualClause[]
  onChange: (clauses: VisualClause[]) => void
  incomingFields: Array<{ name: string; type: string }>
}) {
  const add = () => onChange([...clauses, {
    id: `c_${Date.now()}`, field: '', operator: '==' as ConditionOperator,
    value: '', logic: 'AND',
  }])

  const update = (id: string, key: keyof VisualClause, value: string) =>
    onChange(clauses.map((c) => c.id === id ? { ...c, [key]: value } : c))

  const remove = (id: string) => onChange(clauses.filter((c) => c.id !== id))

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
                      color: clause.logic === op ? '#4a9eff' : '#4a5a7a',
                      border: clause.logic === op ? '1px solid #2a5a9a' : '1px solid #2a3349' }}>
                    {op}
                  </button>
                ))}
              </div>
            )}
            <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'flex-end' }}>
                <div style={{ flex: 1 }}>
                  <div style={labelStyle}>Campo</div>
                  {incomingFields.length > 0 ? (
                    <CustomSelect style={inputStyle} value={clause.field}
                      onChange={(e) => update(clause.id, 'field', e.target.value)}>
                      <option value="">— seleziona campo —</option>
                      {incomingFields.map((f) => (
                        <option key={f.name} value={f.name}>{f.name} ({f.type})</option>
                      ))}
                    </CustomSelect>
                  ) : (
                    <input style={inputStyle} value={clause.field}
                      onChange={(e) => update(clause.id, 'field', e.target.value)}
                      placeholder="nome_campo" />
                  )}
                </div>
                <button onClick={() => remove(clause.id)} disabled={clauses.length === 1}
                  style={{ background: 'none', border: '1px solid #3d1010', borderRadius: 4, padding: '4px 7px',
                    cursor: clauses.length === 1 ? 'not-allowed' : 'pointer',
                    color: clauses.length === 1 ? '#2a3349' : '#ff5f57',
                    opacity: clauses.length === 1 ? 0.4 : 1, marginBottom: 0 }}>
                  <i className="ti ti-x" style={{ fontSize: 11 }} />
                </button>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: noValue ? '1fr' : '1fr 1fr', gap: 6 }}>
                <div>
                  <div style={labelStyle}>Operatore</div>
                  <CustomSelect style={inputStyle} value={clause.operator}
                    onChange={(e) => update(clause.id, 'operator', e.target.value as ConditionOperator)}>
                    {OPERATORS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </CustomSelect>
                </div>
                {!noValue && (
                  <div>
                    <div style={labelStyle}>
                      {['in', 'not_in'].includes(clause.operator) ? 'Valori (virgola)' : 'Valore'}
                    </div>
                    <input style={inputStyle} value={clause.value}
                      onChange={(e) => update(clause.id, 'value', e.target.value)}
                      placeholder={['in', 'not_in'].includes(clause.operator) ? 'val1, val2' : 'valore'} />
                  </div>
                )}
              </div>
            </div>
          </div>
        )
      })}
      <button onClick={add}
        style={{ background: '#1a2030', border: '1px dashed #2a3349', borderRadius: 6, padding: '6px',
          fontSize: 11, color: '#4a9eff', cursor: 'pointer',
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}>
        <i className="ti ti-plus" style={{ fontSize: 11 }} /> Aggiungi clausola
      </button>
    </div>
  )
}

// ─── TemplateBuilder ──────────────────────────────────────────────
function TemplateBuilder({ templateId, params, onChange }: {
  templateId: string
  params: Record<string, string>
  onChange: (templateId: string, params: Record<string, string>) => void
}) {
  const byCategory = getTemplatesByCategory()
  const selected   = FILTER_TEMPLATES.find((t) => t.id === templateId)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div>
        <div style={labelStyle}>Template</div>
        <CustomSelect style={inputStyle} value={templateId}
          onChange={(e) => onChange(e.target.value, {})}>
          <option value="">— seleziona template —</option>
          {Object.entries(byCategory).map(([cat, templates]) => (
            <optgroup key={cat} label={cat}>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </optgroup>
          ))}
        </CustomSelect>
      </div>

      {selected && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>
            {selected.description}
          </div>
          {selected.params.map((param) => (
            <Field key={param.key} label={param.label}>
              <input style={inputStyle} value={params[param.key] ?? ''}
                onChange={(e) => onChange(templateId, { ...params, [param.key]: e.target.value })}
                placeholder={param.placeholder} />
            </Field>
          ))}
         {/* Anteprima codice generato */}
          <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
            <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '.06em' }}>Codice generato</div>
            <code style={{ fontSize: 10, color: '#3ddc84', fontFamily: 'monospace', wordBreak: 'break-all' }}>
              {(() => {
                try {
                  const safeParams = Object.fromEntries(
                    selected.params.map((p) => [p.key, params[p.key] ?? p.placeholder ?? ''])
                  )
                  return selected.toCode(safeParams)
                } catch {
                  return '/* compila i parametri sopra */'
                }
              })()}
            </code>
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ConditionEditor ──────────────────────────────────────────────
function ConditionEditor({ cond, incomingFields, onUpdate, onDelete, onMoveUp, onMoveDown, isFirst, isLast }: {
  cond: FilterCondition
  incomingFields: Array<{ name: string; type: string }>
  onUpdate: (patch: Partial<FilterCondition>) => void
  onDelete: () => void
  onMoveUp: () => void
  onMoveDown: () => void
  isFirst: boolean
  isLast: boolean
}) {
  const [expanded, setExpanded] = useState(true)

  const schema = incomingFields.map((f) => ({ name: f.name, type: f.type }))

  return (
    <div style={{ border: `1px solid ${cond.color}40`, borderRadius: 8, overflow: 'hidden', marginBottom: 8 }}>
      {/* Header condizione */}
      <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${cond.color} 10%, #1a2030)`, display: 'flex', alignItems: 'center', gap: 8 }}>
        {/* Drag handle / riordino */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flexShrink: 0 }}>
          <button onClick={onMoveUp} disabled={isFirst}
            style={{ background: 'none', border: 'none', cursor: isFirst ? 'not-allowed' : 'pointer', color: isFirst ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
            <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
          </button>
          <button onClick={onMoveDown} disabled={isLast}
            style={{ background: 'none', border: 'none', cursor: isLast ? 'not-allowed' : 'pointer', color: isLast ? '#2a3349' : '#4a5a7a', padding: 0, lineHeight: 1 }}>
            <i className="ti ti-chevron-down" style={{ fontSize: 9 }} />
          </button>
        </div>

        {/* Colore */}
        <input type="color" value={cond.color} onChange={(e) => onUpdate({ color: e.target.value })}
          style={{ width: 18, height: 18, border: 'none', borderRadius: 3, padding: 0, cursor: 'pointer', background: 'none', flexShrink: 0 }} />

        {/* Label */}
        <input value={cond.label} onChange={(e) => onUpdate({ label: e.target.value })}
          style={{ background: 'none', border: 'none', outline: 'none', fontSize: 11, fontWeight: 600, color: cond.color, fontFamily: 'monospace', flex: 1, minWidth: 0 }}
          placeholder="nome uscita" />

        {/* Modalità */}
        <div style={{ display: 'flex', gap: 3, flexShrink: 0 }}>
          {([
            { value: 'visual',   label: '⊞', title: 'Builder visuale' },
            { value: 'template', label: '⚡', title: 'Template'        },
            { value: 'code',     label: 'λ',  title: 'Codice inline'  },
          ] as Array<{ value: ConditionMode; label: string; title: string }>).map((m) => (
            <button key={m.value} onClick={() => onUpdate({ mode: m.value })} title={m.title}
              style={{ padding: '2px 6px', fontSize: 10, borderRadius: 3, cursor: 'pointer', fontFamily: 'monospace',
                background: cond.mode === m.value ? `color-mix(in srgb, ${cond.color} 25%, #161b27)` : '#1e2535',
                color: cond.mode === m.value ? cond.color : '#4a5a7a',
                border: cond.mode === m.value ? `1px solid ${cond.color}60` : '1px solid #2a3349' }}>
              {m.label}
            </button>
          ))}
        </div>

        <button onClick={() => setExpanded((v) => !v)}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}>
          <i className={`ti ${expanded ? 'ti-chevron-up' : 'ti-chevron-down'}`} style={{ fontSize: 10 }} />
        </button>
        <button onClick={onDelete}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-x" style={{ fontSize: 11 }} />
        </button>
      </div>

      {/* Body condizione */}
      {expanded && (
        <div style={{ padding: '10px', background: '#161b27' }}>
          {cond.mode === 'visual' && (
            <VisualBuilder
              clauses={cond.clauses ?? [{ id: 'c1', field: '', operator: '==' as ConditionOperator, value: '', logic: 'AND' }]}
              onChange={(clauses) => onUpdate({ clauses })}
              incomingFields={incomingFields}
            />
          )}

          {cond.mode === 'template' && (
            <TemplateBuilder
              templateId={cond.templateId ?? ''}
              params={cond.templateParams ?? {}}
              onChange={(templateId, templateParams) => onUpdate({ templateId, templateParams })}
            />
          )}

          {cond.mode === 'code' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <div>
                <div style={labelStyle}>Linguaggio</div>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['typescript', 'python', 'java'] as const).map((lang) => (
                    <button key={lang} onClick={() => onUpdate({ lang })}
                      style={{ padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                        background: cond.lang === lang ? '#1a3a6a' : '#1e2535',
                        color: cond.lang === lang ? '#4a9eff' : '#4a5a7a',
                        border: cond.lang === lang ? '1px solid #2a5a9a' : '1px solid #2a3349',
                        fontWeight: cond.lang === lang ? 600 : 400 }}>
                      {lang}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>
                Scrivi una funzione che riceve <code style={{ color: cond.color }}>row</code> e restituisce <code style={{ color: '#3ddc84' }}>boolean</code>
              </div>
              <ScriptEditor
                value={cond.code ?? `(row) => {\n  // scrivi qui la condizione\n  return true\n}`}
                onChange={(code) => onUpdate({ code })}
                language={cond.lang ?? 'typescript'}
                schema={schema}
                height={180}
              />
            </div>
          )}

          {/* Anteprima codice generato (per visual e template) */}
          {cond.mode !== 'code' && (
            <div style={{ marginTop: 8, padding: '6px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
              <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.06em' }}>Codice generato</div>
              <code style={{ fontSize: 10, color: '#3ddc84', fontFamily: 'monospace', wordBreak: 'break-all' }}>
                {conditionToCode(cond)}
              </code>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

// ─── useDraggable ─────────────────────────────────────────────────
function useDraggable() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragging = useRef(false)
  const offset   = useRef({ x: 0, y: 0 })
  const ref      = useRef<HTMLDivElement>(null)
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,input,select,textarea')) return
    dragging.current = true
    const rect = ref.current?.getBoundingClientRect()
    if (!rect) return
    offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    e.preventDefault()
  }, [])
  const reset = useCallback(() => setPos(null), [])
  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (!dragging.current) return; setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }) }
    const onUp   = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])
  return { ref, pos, onMouseDown, reset }
}

// ─── FilterModal ──────────────────────────────────────────────────
export function FilterModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const node           = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const incomingFields = useIncomingSchema(nodeId)

  const { ref: dragRef, pos, onMouseDown, reset: resetDrag } = useDraggable()
  const [isMaximized, setIsMaximized] = useState(false)

  if (!node) return null

  const config: FilterConfig = useMemo(() => {
    try {
      const raw = node.data.config?.filter
      if (raw) return raw as FilterConfig
    } catch {}
    return {
      conditions: [],
      nullBehavior: 'exclude',
      caseSensitive: true,
    }
  }, [node.data.config?.filter])



  const saveConfig = useCallback((newConfig: FilterConfig) => {
    useFlowStore.setState((s) => ({
      nodes: s.nodes.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, config: { ...n.data.config, filter: newConfig } } }
          : n
      ),
    }))
  }, [nodeId])

  const addCondition = useCallback(() => {
    const idx   = config.conditions.length
    const color = ['#4a9eff', '#3ddc84', '#ffb347', '#a78bfa', '#22d3ee', '#f472b6'][idx % 6]
    const newCond: FilterCondition = {
      id:      `cond_${Date.now()}`,
      label:   `uscita_${idx + 1}`,
      color,
      mode:    'visual',
      clauses: [{ id: `c_${Date.now()}`, field: '', operator: '==' as ConditionOperator, value: '', logic: 'AND' }],
      lang:    'typescript',
      code:    `(row) => {\n  return true\n}`,
    }
    saveConfig({ ...config, conditions: [...config.conditions, newCond] })
  }, [config, saveConfig])

  const updateCondition = useCallback((id: string, patch: Partial<FilterCondition>) => {
    saveConfig({
      ...config,
      conditions: config.conditions.map((c) => c.id === id ? { ...c, ...patch } : c),
    })
  }, [config, saveConfig])

  const deleteCondition = useCallback((id: string) => {
    saveConfig({ ...config, conditions: config.conditions.filter((c) => c.id !== id) })
  }, [config, saveConfig])

  const moveCondition = useCallback((id: string, dir: 'up' | 'down') => {
    const idx = config.conditions.findIndex((c) => c.id === id)
    if (idx < 0) return
    const newArr = [...config.conditions]
    const swapIdx = dir === 'up' ? idx - 1 : idx + 1
    if (swapIdx < 0 || swapIdx >= newArr.length) return
    ;[newArr[idx], newArr[swapIdx]] = [newArr[swapIdx], newArr[idx]]
    saveConfig({ ...config, conditions: newArr })
  }, [config, saveConfig])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [onClose])

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: pos ? 'flex-start' : 'center', justifyContent: 'center', zIndex: 20000, padding: 24, pointerEvents: 'none', overflow: 'hidden' }}>
      <div
        ref={dragRef as React.RefObject<HTMLDivElement>}
        onClick={(e) => e.stopPropagation()}
        style={{
          pointerEvents: 'all', background: '#161b27',
          border: `1px solid ${ACCENT}40`, borderRadius: isMaximized ? 0 : 10,
          width: isMaximized ? '100vw' : 700,
          maxWidth: isMaximized ? '100vw' : '96vw',
          height: isMaximized ? '100vh' : '90vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.8), 0 0 0 1px #2a3349',
          position: 'relative',
          ...(pos && !isMaximized ? { position: 'fixed' as const, left: pos.x, top: pos.y } : {}),
          ...(isMaximized ? { position: 'fixed' as const, inset: 0 } : {}),
        }}>

        {/* Header */}
        <div onMouseDown={onMouseDown}
          style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #2a3349', background: '#1a2030', flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
          <span style={{ fontSize: 18, color: ACCENT }}>⊻</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8d4f0' }}>
              {node.data.config?.displayName || 'Filter'}
            </div>
            <div style={{ fontSize: 11, color: '#4a5a7a', fontFamily: 'monospace' }}>{nodeId}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => setIsMaximized((m) => { if (!m) resetDrag(); return !m })}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', color: '#9a9aaa' }}>
              <i className={`ti ${isMaximized ? 'ti-arrows-minimize' : 'ti-arrows-maximize'}`} style={{ fontSize: 13 }} />
            </button>
            <button onClick={onClose}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', color: '#9a9aaa', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}>
              <i className="ti ti-x" style={{ fontSize: 12 }} /> chiudi
            </button>
          </div>
        </div>

        {/* Body */}
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ flex: 1, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
            {/* Info schema */}
            {incomingFields.length > 0 && (
              <div style={{ padding: '6px 10px', background: '#0d3d20', borderRadius: 4, border: '0.5px solid #1d6d40', fontSize: 10, color: '#3ddc84', display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <span style={{ color: '#4a5a7a', marginRight: 4 }}>Campi disponibili:</span>
                {incomingFields.map((f) => (
                  <code key={f.name} style={{ background: '#1d6d4040', padding: '1px 6px', borderRadius: 3 }}>{f.name}</code>
                ))}
              </div>
            )}

            {/* Info logica */}
            <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#9a9aaa', display: 'flex', alignItems: 'center', gap: 6 }}>
              <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0 }} />
              Le condizioni sono valutate in ordine — ogni riga va sulla <strong style={{ color: ACCENT }}>prima condizione</strong> che corrisponde.
              Le righe che non soddisfano nessuna condizione vanno al <strong style={{ color: '#ff5f57' }}>reject</strong>.
            </div>

            {/* Condizioni */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: -4 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', flex: 1 }}>
                Condizioni — {config.conditions.length}
              </span>
              <button onClick={addCondition}
                style={{ padding: '3px 12px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 15%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}60`, display: 'flex', alignItems: 'center', gap: 4 }}>
                <i className="ti ti-plus" style={{ fontSize: 11 }} /> Condizione
              </button>
            </div>

              <div style={{
                  overflowY: 'auto',
                  maxHeight: 420,
                  paddingRight: 4,
                  border: '0.5px solid #2a3349',
                  borderRadius: 8,
                  padding: '8px',
                  background: '#0f1117',
                }}>
                  {config.conditions.length === 0 ? (
                    <div style={{ padding: '32px', textAlign: 'center', color: '#2a3349', fontSize: 11 }}>
                        <i className="ti ti-filter" style={{ fontSize: 32, display: 'block', marginBottom: 10, color: `${ACCENT}20` }} />
                        Nessuna condizione — aggiungi una condizione per creare un'uscita.<br />
                        Le righe vanno sempre al <span style={{ color: '#ff5f57' }}>reject</span> se nessuna condizione corrisponde.
                      </div>
                    ) : (
                      config.conditions.map((cond, idx) => (
                        <ConditionEditor
                          key={cond.id}
                          cond={cond}
                          incomingFields={incomingFields}
                          onUpdate={(patch) => updateCondition(cond.id, patch)}
                          onDelete={() => deleteCondition(cond.id)}
                          onMoveUp={() => moveCondition(cond.id, 'up')}
                          onMoveDown={() => moveCondition(cond.id, 'down')}
                          isFirst={idx === 0}
                          isLast={idx === config.conditions.length - 1}
                        />
                      ))
                    )}
              </div>
            {/* Reject fisso */}
            <div style={{ padding: '8px 12px', background: '#1a0a0a', border: '1px solid #3a1a1a', borderRadius: 8, display: 'flex', alignItems: 'center', gap: 8 }}>
              <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#ff5f57', flexShrink: 0 }} />
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#ff5f57' }}>reject</div>
                <div style={{ fontSize: 10, color: '#4a5a7a' }}>Righe che non soddisfano nessuna condizione — sempre presente</div>
              </div>
            </div>

            {/* Opzioni globali */}
            <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <span style={{ fontSize: 10, fontWeight: 600, color: '#9a9aaa', textTransform: 'uppercase', letterSpacing: '.08em' }}>Opzioni globali</span>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <Field label="Comportamento su null">
                  <CustomSelect style={inputStyle} value={config.nullBehavior}
                    onChange={(e) => saveConfig({ ...config, nullBehavior: e.target.value as FilterConfig['nullBehavior'] })}>
                    <option value="exclude">Escludi (→ reject)</option>
                    <option value="include">Includi nella valutazione</option>
                    <option value="error">Errore su null</option>
                  </CustomSelect>
                </Field>
                <Field label="Case sensitive">
                  <CustomSelect style={inputStyle} value={config.caseSensitive ? 'true' : 'false'}
                    onChange={(e) => saveConfig({ ...config, caseSensitive: e.target.value === 'true' })}>
                    <option value="true">Sì</option>
                    <option value="false">No</option>
                  </CustomSelect>
                </Field>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '1px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#4a5a7a', marginRight: 'auto' }}>Le modifiche sono salvate automaticamente</span>
          <button onClick={onClose}
            style={{ padding: '6px 20px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 20%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}60`, fontWeight: 600 }}>
            Fatto
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
