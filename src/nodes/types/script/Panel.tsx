import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { SCRIPT_LANGUAGES, getTemplates, getDefaultTemplate } from './templates'
import { ScriptEditor, type SchemaField, type ContextVar } from '../../../components/ScriptEditor'
import { getTransformsForType, type TransformCategory } from '../../../transforms/catalog'
import { scriptFieldsToSchema, propagateSchema } from '../../../utils/schemaUtils'
import { CustomSelect } from '../../../components/CustomSelect'
import { getHandleSchema } from '../../../utils/schemaRegistry'

const PANEL_LANGUAGES = ['typescript', 'python', 'java']

// ─── Pattern inserimento per linguaggio ──────────────────────────
function inputPattern(lang: string, fieldName: string): string {
  switch (lang) {
    case 'python': return `row['${fieldName}']`
    case 'java':
    case 'groovy': return `row.get("${fieldName}")`
    default:       return `row.${fieldName}`
  }
}

function laneVarPattern(lang: string, varName: string): string {
  switch (lang) {
    case 'python': return `context['lane']['${varName}']`
    case 'java':
    case 'groovy': return `context.get("lane").get("${varName}")`
    default:       return `context.lane.${varName}`
  }
}

function poolVarPattern(lang: string, varName: string): string {
  switch (lang) {
    case 'python': return `context['pool']['${varName}']`
    case 'java':
    case 'groovy': return `context.get("pool").get("${varName}")`
    default:       return `context.pool.${varName}`
  }
}

// ─── Pattern output — usa out.campo e reject.campo ───────────────
function outVarPattern(lang: string, fieldName: string): string {
  switch (lang) {
    case 'python': return `out['${fieldName}']`
    case 'java':
    case 'groovy': return `out.get("${fieldName}")`
    default:       return `out.${fieldName}`
  }
}

function rejectVarPattern(lang: string, fieldName: string): string {
  switch (lang) {
    case 'python': return `reject['${fieldName}']`
    case 'java':
    case 'groovy': return `reject.get("${fieldName}")`
    default:       return `reject.${fieldName}`
  }
}

function applyTransformExpression(expression: string, varName: string): string {
  return expression
    .replace(/\$value/g, varName)
    .replace(/\$param_\w+/g, '""')
}

// ─── Stili ────────────────────────────────────────────────────────
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

function GridRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

// ─── SmartPill ────────────────────────────────────────────────────
function SmartPill({ label, color, type, varName, onInsert, onWrap }: {
  label:    string
  color:    string
  type:     string
  varName:  string
  onInsert: (text: string) => void
  onWrap:   (expr: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref             = useRef<HTMLDivElement>(null)
  const transforms      = useMemo(() => getTransformsForType(type as TransformCategory).slice(0, 12), [type])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', borderRadius: 10, overflow: 'hidden', border: `1px solid ${open ? color : '#2a3349'}`, transition: 'border-color .1s' }}>
        <button
          onClick={() => { onInsert(varName); setOpen(false) }}
          title={`Inserisci ${varName} (${type})`}
          style={{ padding: '2px 6px 2px 8px', background: open ? `color-mix(in srgb, ${color} 15%, #161b27)` : '#0f1117', border: 'none', color: open ? color : '#9a9aaa', cursor: 'pointer', fontFamily: 'monospace', fontSize: 9, transition: 'all .1s' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color; (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${color} 10%, #161b27)` }}
          onMouseLeave={(e) => { if (!open) { (e.currentTarget as HTMLElement).style.color = '#9a9aaa'; (e.currentTarget as HTMLElement).style.background = '#0f1117' } }}>
          {label}
        </button>
        {transforms.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            title="Trasformazioni disponibili"
            style={{ padding: '2px 5px 2px 3px', background: open ? `color-mix(in srgb, ${color} 20%, #161b27)` : '#161b27', border: 'none', borderLeft: '1px solid #2a3349', color: open ? color : '#4a5a7a', cursor: 'pointer', fontSize: 9, transition: 'all .1s' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
            onMouseLeave={(e) => { if (!open) (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            ▾
          </button>
        )}
      </div>

      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 200, background: '#1a2030', border: `1px solid ${color}`, borderRadius: 6, marginTop: 3, minWidth: 220, maxWidth: 300, boxShadow: '0 8px 24px rgba(0,0,0,.6)', overflow: 'hidden' }}>
          <div style={{ padding: '5px 10px', background: `color-mix(in srgb, ${color} 10%, #161b27)`, borderBottom: '1px solid #2a3349' }}>
            <span style={{ fontSize: 9, color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>trasformazioni · {type}</span>
          </div>
          <div onClick={() => { onInsert(varName); setOpen(false) }}
            style={{ padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid #2a3349' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a3349' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
            <span style={{ fontSize: 9, color: '#4a5a7a' }}>📋</span>
            <code style={{ fontSize: 9, color }}>{varName}</code>
            <span style={{ fontSize: 9, color: '#4a5a7a', marginLeft: 'auto' }}>inserisci</span>
          </div>
          <div onClick={() => { onWrap(varName); setOpen(false) }}
            style={{ padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid #2a3349' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a3349' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
            <span style={{ fontSize: 9, color: '#4a5a7a' }}>⬡</span>
            <span style={{ fontSize: 9, color: '#9a9aaa' }}>wrap selezione nell'editor</span>
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {transforms.map((t) => {
              const expr = applyTransformExpression(t.expression, varName)
              return (
                <div key={t.id} onClick={() => { onInsert(expr); setOpen(false) }}
                  style={{ padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 6 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a3349' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                  <span style={{ fontSize: 9, color: '#a78bfa', flexShrink: 0 }}>⚡</span>
                  <span style={{ fontSize: 10, color: '#c8d4f0', flexShrink: 0, minWidth: 80 }}>{t.label}</span>
                  <code style={{ fontSize: 9, color: '#4a5a7a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{expr}</code>
                  {t.outputType && t.outputType !== type && (
                    <span style={{ fontSize: 9, color: '#ffb347', flexShrink: 0, marginLeft: 4 }}>→ {t.outputType}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ScriptPanel ─────────────────────────────────────────────────
export function ScriptPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const edges      = useFlowStore((s) => s.edges)
  const nodes      = useFlowStore((s) => s.nodes)
  const pool       = useFlowStore((s) => s.pool)

  const [showDeps,     setShowDeps]     = useState(false)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [snippet,      setSnippet]      = useState<string | undefined>(undefined)
  const [wrap,         setWrap]         = useState<string | undefined>(undefined)

  if (!node) return null

  const p = (key: string) => node.data.props[key] ?? ''
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const lang      = p('lang')      || 'typescript'
  const execMode  = p('execMode')  || 'transform'
  const hasReject = p('hasReject') === 'true'

  // ── Schema input ─────────────────────────────────────────────
  const schema: SchemaField[] = useMemo(() => {
    const inEdge  = edges.find((e) => e.target === nodeId)
    if (!inEdge) return []
    const srcNode = nodes.find((n) => n.id === inEdge.source)
    if (!srcNode) return []
    const fields = getHandleSchema(srcNode, inEdge.sourceHandle ?? 'output', false)
    return fields.map((f) => ({ id: f.id, name: f.name, type: f.type }))
  }, [edges, nodes, nodeId])

  // ── Campi output (per le pill) ────────────────────────────────
  const outputFields = useMemo(() => {
    try { return JSON.parse(p('outputFields')) as Array<{ id: string; name: string; type: string }> }
    catch { return [] }
  }, [p('outputFields')])

  // ── Variabili lane e pool ─────────────────────────────────────
  const laneVars: ContextVar[] = useMemo(() =>
    (pool.lanes.find((l) => l.id === node.data.laneId)?.variables ?? [])
      .map((v) => ({ name: v.name, type: v.type })),
    [pool, node.data.laneId]
  )

  const poolVars: ContextVar[] = useMemo(() =>
    pool.variables.map((v) => ({ name: v.name, type: v.type })),
    [pool]
  )

  // ── Propaga quando cambiano le edge in uscita ─────────────────
  const outputFieldsRef = useRef(outputFields)
  outputFieldsRef.current = outputFields

  const outEdgeKey = edges
    .filter((e) => e.source === nodeId && e.sourceHandle !== 'reject')
    .map((e) => `${e.target}:${e.targetHandle ?? 'null'}`)
    .sort()
    .join('|')

  useEffect(() => {
    const fields = outputFieldsRef.current
    if (fields.length === 0 || !outEdgeKey) return
    const schemaFields = scriptFieldsToSchema(fields)
    propagateSchema(nodeId, schemaFields, useFlowStore.getState())
  }, [outEdgeKey, nodeId])

  // ── Propaga rename campi input nel codice ─────────────────────
  const prevSchemaRef = useRef<SchemaField[]>([])
  useEffect(() => {
    const prev = prevSchemaRef.current
    const curr = schema
    if (prev.length > 0 && curr.length > 0) {
      const code = node.data.props['code'] ?? ''
      if (code) {
        let newCode = code
        prev.forEach((oldField) => {
          if (!oldField.id) return
          const newField = curr.find((f) => f.id === oldField.id)
          if (!newField || newField.name === oldField.name) return
          newCode = newCode
            .split(`row.${oldField.name}`).join(`row.${newField.name}`)
            .split(`row['${oldField.name}']`).join(`row['${newField.name}']`)
            .split(`row["${oldField.name}"]`).join(`row["${newField.name}"]`)
            .split(`row.get('${oldField.name}')`).join(`row.get('${newField.name}')`)
            .split(`row.get("${oldField.name}")`).join(`row.get("${newField.name}")`)
        })
        prev.forEach((oldField) => {
          if (!oldField.id) return
          if (curr.some((f) => f.id === oldField.id)) return
          const marker = ` /* ⚠ '${oldField.name}' rimosso */`
          newCode = newCode
            .split(`row.${oldField.name}`).join(`row.${oldField.name}${marker}`)
            .split(`row['${oldField.name}']`).join(`row['${oldField.name}']${marker}`)
        })
        if (newCode !== code) updateProp(nodeId, 'code', newCode)
      }
    }
    prevSchemaRef.current = curr
  }, [schema])

  const handleCodeChange = useCallback((newCode: string) => {
    updateProp(nodeId, 'code', newCode)
  }, [nodeId, updateProp])

  const visibleLangs = SCRIPT_LANGUAGES.filter((l) => PANEL_LANGUAGES.includes(l.value))

  const handleLangChange = useCallback((newLang: string) => {
    updateProp(nodeId, 'lang', newLang)
    if (!p('code')) updateProp(nodeId, 'code', getDefaultTemplate(newLang))
  }, [nodeId, updateProp])

  const insertSnippet = useCallback((text: string) => setSnippet(text), [])
  const wrapSelection = useCallback((expr: string) => setWrap(expr), [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ══ SEZ 1 — MODALITÀ + LINGUAGGIO ══════════════════════ */}
      <div style={{ background: '#161b27', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>

        <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a3349' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Modalità</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { value: 'transform', label: 'Transform', icon: 'ti-arrow-right',  desc: '1 riga → 1 riga'  },
              { value: 'emit',      label: 'Emit',       icon: 'ti-arrows-split', desc: '1 riga → N righe' },
            ].map((m) => (
              <button key={m.value} onClick={() => updateProp(nodeId, 'execMode', m.value)}
                style={{
                  flex: 1, padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                  background: execMode === m.value ? '#1a3a6a' : '#1a2030',
                  border:     execMode === m.value ? '1px solid #2a5a9a' : '1px solid #2a3349',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className={`ti ${m.icon}`} style={{ fontSize: 13, color: execMode === m.value ? '#4a9eff' : '#4a5a7a' }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: execMode === m.value ? '#4a9eff' : '#4a5a7a' }}>{m.label}</span>
                </div>
                <span style={{ fontSize: 9, color: execMode === m.value ? '#7a9aaa' : '#2a3349' }}>{m.desc}</span>
              </button>
            ))}
          </div>
        </div>

        <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a3349' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Linguaggio</div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', alignItems: 'center' }}>
            {visibleLangs.map((l) => (
              <button key={l.value} onClick={() => handleLangChange(l.value)}
                style={{
                  padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
                  background: lang === l.value ? '#1a3a6a' : '#1e2535',
                  color:      lang === l.value ? '#4a9eff' : '#4a5a7a',
                  border:     lang === l.value ? '1px solid #2a5a9a' : '1px solid #2a3349',
                  fontWeight: lang === l.value ? 600 : 400,
                  display: 'flex', alignItems: 'center', gap: 5,
                }}>
                <i className={`ti ${l.icon}`} style={{ fontSize: 11 }} />
                {l.label}
              </button>
            ))}
            {schema.length > 0 && lang === 'typescript' && (
              <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 4, padding: '2px 8px', background: '#1a2a1a', border: '1px solid #2a5a2a', borderRadius: 4 }}>
                <i className="ti ti-check" style={{ fontSize: 9, color: '#3ddc84' }} />
                <span style={{ fontSize: 9, color: '#3ddc84' }}>autocomplete attivo</span>
              </div>
            )}
          </div>
        </div>

        <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <CustomSelect style={{ ...inputStyle, width: 'auto', fontSize: 10, padding: '2px 6px', color: '#a78bfa' }}
            value="" onChange={(e) => { if (e.target.value) { insertSnippet(e.target.value); e.target.value = '' } }}>
            <option value="">⚡ template</option>
            {Object.entries(
              getTemplates(lang).reduce((acc, t) => {
                acc[t.category] = acc[t.category] ?? []
                acc[t.category].push(t)
                return acc
              }, {} as Record<string, any[]>)
            ).map(([cat, templates]) => (
              <optgroup key={cat} label={cat}>
                {templates.map((t: any) => (
                  <option key={t.id} value={t.code} title={t.description}>{t.label}</option>
                ))}
              </optgroup>
            ))}
          </CustomSelect>
          <button onClick={() => updateProp(nodeId, 'code', '')}
            style={{ background: 'none', border: '0.5px solid #2a3349', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer', color: '#4a5a7a' }}
            title="Svuota editor">
            <i className="ti ti-eraser" style={{ fontSize: 10 }} />
          </button>
          <span style={{ fontSize: 9, color: '#2a3349', marginLeft: 'auto' }}>
            Alt+T suggerimenti · Ctrl+Shift+F formatta
          </span>
        </div>
      </div>

      {/* ══ SEZ 2 — VARIABILI DISPONIBILI ══════════════════════ */}
      <div style={{ background: '#161b27', border: '1px solid #2a3349', borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Variabili disponibili — clicca per inserire · ▾ per trasformazioni
        </div>

        {/* Input */}
        {schema.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#3ddc84', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-arrow-right" style={{ fontSize: 9 }} /> input · {schema.length} campi
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {schema.map((f) => (
                <SmartPill key={f.name}
                  label={inputPattern(lang, f.name)} color="#3ddc84"
                  type={f.type} varName={inputPattern(lang, f.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Output — out.campo */}
        {outputFields.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#4a9eff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-arrow-right" style={{ fontSize: 9 }} /> out · {outputFields.length} campi
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {outputFields.map((f) => (
                <SmartPill key={f.id}
                  label={outVarPattern(lang, f.name)} color="#4a9eff"
                  type={f.type} varName={outVarPattern(lang, f.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Reject — reject.campo */}
        {hasReject && outputFields.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#ff5f57', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-x" style={{ fontSize: 9 }} /> reject · {outputFields.length} campi
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {outputFields.map((f) => (
                <SmartPill key={f.id}
                  label={rejectVarPattern(lang, f.name)} color="#ff5f57"
                  type={f.type} varName={rejectVarPattern(lang, f.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Lane */}
        {laneVars.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#ffb347', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-box" style={{ fontSize: 9 }} /> lane · {laneVars.length} variabili
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {laneVars.map((v) => (
                <SmartPill key={v.name}
                  label={laneVarPattern(lang, v.name)} color="#ffb347"
                  type={v.type} varName={laneVarPattern(lang, v.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Pool */}
        {poolVars.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#a78bfa', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-database" style={{ fontSize: 9 }} /> pool · {poolVars.length} variabili
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {poolVars.map((v) => (
                <SmartPill key={v.name}
                  label={poolVarPattern(lang, v.name)} color="#a78bfa"
                  type={v.type} varName={poolVarPattern(lang, v.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Context */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
            <i className="ti ti-function" style={{ fontSize: 9 }} /> context
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[
              { label: 'context.log("")',     snippet: 'context.log("")',     title: 'scrivi nel log'   },
              { label: 'context.emit(row)',    snippet: 'context.emit(row)',    title: 'emetti riga extra' },
              { label: 'context.skip()',      snippet: 'context.skip()',      title: 'scarta riga'      },
              { label: 'context.reject(row)', snippet: 'context.reject(row)', title: 'invia al reject', color: '#ff5f57' },
              { label: 'context.error("")',   snippet: 'context.error("")',   title: 'lancia errore'    },
            ].map((fn) => (
              <button key={fn.label} onClick={() => insertSnippet(fn.snippet)} title={fn.title}
                style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, background: '#0f1117', border: '1px solid #2a3349', color: '#9a9aaa', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0 }}
                onMouseEnter={(e) => { const c = (fn as any).color ?? '#22d3ee'; (e.currentTarget as HTMLElement).style.borderColor = c; (e.currentTarget as HTMLElement).style.color = c }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.color = '#9a9aaa' }}>
                {fn.label}
              </button>
            ))}
          </div>
        </div>

        {schema.length === 0 && laneVars.length === 0 && poolVars.length === 0 && outputFields.length === 0 && (
          <div style={{ fontSize: 10, color: '#2a3349', fontStyle: 'italic' }}>
            Collega un nodo sorgente e definisci i campi output nel tab Mapping
          </div>
        )}
      </div>

      {/* ══ SEZ 3 — EDITOR ══════════════════════════════════════ */}
      <ScriptEditor
        value={p('code')}
        onChange={handleCodeChange}
        language={lang}
        schema={schema}
        laneVars={laneVars}
        poolVars={poolVars}
        height={320}
        snippetToInsert={snippet}
        onSnippetInserted={() => setSnippet(undefined)}
        wrapToInsert={wrap}
        onWrapInserted={() => setWrap(undefined)}
      />

      {/* ══ SEZ 4 — BADGE REJECT ════════════════════════════════ */}
      {hasReject && (
        <div style={{ padding: '6px 10px', background: '#1a0a0a', border: '1px solid #3a1a1a', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#ff5f57', flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: '#ff5f57' }}>
            Flusso reject attivo — handle visibile sul nodo · configura lo schema nel tab Mapping
          </span>
        </div>
      )}

      {/* ══ SEZ 5 — DIPENDENZE ══════════════════════════════════ */}
      <div style={{ background: '#1a2030', border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
        <button onClick={() => setShowDeps((v) => !v)}
          style={{ width: '100%', background: 'none', border: 'none', padding: '7px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#9a9aaa', fontSize: 10 }}>
          <i className={`ti ${showDeps ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 10 }} />
          <i className="ti ti-package" style={{ fontSize: 11, color: '#a78bfa' }} />
          Dipendenze
        </button>
        {showDeps && (
          <div style={{ padding: '8px 10px', borderTop: '0.5px solid #2a3349', display: 'flex', flexDirection: 'column', gap: 8 }}>
            {lang === 'typescript' && (
              <Field label="Import NPM (JSON)" hint='Es: {"lodash": "4.17.21"}'>
                <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 48, fontFamily: 'monospace' }}
                  value={p('dependencies') || '{}'} onChange={u('dependencies')} spellCheck={false} />
              </Field>
            )}
            {lang === 'python' && (
              <Field label="Moduli Python (uno per riga)" hint="Installati con pip prima dell'esecuzione">
                <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 48, fontFamily: 'monospace' }}
                  value={p('pipRequirements') || ''} onChange={u('pipRequirements')}
                  placeholder={'pandas==2.0.0\nnumpy'} spellCheck={false} />
              </Field>
            )}
            {lang === 'java' && (
              <Field label="Dipendenze Maven" hint="groupId:artifactId:version — una per riga">
                <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 48, fontFamily: 'monospace' }}
                  value={p('mavenDeps') || ''} onChange={u('mavenDeps')}
                  placeholder={'com.google.guava:guava:31.0'} spellCheck={false} />
              </Field>
            )}
          </div>
          
        )}
      </div>

      {/* ══ SEZ 6 — OPZIONI AVANZATE ════════════════════════════ */}
      <div style={{ background: '#1a2030', border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ padding: '5px 10px', fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
  <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
  I thread non sono permessi in nessuna modalità sandbox. Per il parallelismo usa più lane o più nodi script in pipeline.
</div>
        <button onClick={() => setShowAdvanced((v) => !v)}
          style={{ width: '100%', background: 'none', border: 'none', padding: '7px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#9a9aaa', fontSize: 10 }}>
          <i className={`ti ${showAdvanced ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 10 }} />
          <i className="ti ti-settings-2" style={{ fontSize: 11, color: '#4a5a7a' }} />
          Opzioni avanzate
        </button>
        {showAdvanced && (
          <div style={{ padding: '8px 10px', borderTop: '0.5px solid #2a3349', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <GridRow>
              <Field label="Timeout (s)">
                <input type="number" style={inputStyle} value={p('scriptTimeout') || '30'} onChange={u('scriptTimeout')} min="1" />
              </Field>
              <Field label="Memoria max (MB)">
                <input type="number" style={inputStyle} value={p('maxMemory') || '256'} onChange={u('maxMemory')} min="64" />
              </Field>
            </GridRow>
            <Field label="Sandbox">
              <CustomSelect style={inputStyle} value={p('sandbox') || 'strict'} onChange={u('sandbox')}>
              <option value="strict">Strict — no filesystem / rete / thread</option>
              <option value="network">Network — HTTP permesso, no thread</option>
              <option value="full">Full — accesso completo, no thread</option>
              </CustomSelect>
            </Field>
          </div>
        )}
      </div>

    </div>
  )
}