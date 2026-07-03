import { useState, useCallback, useRef, useEffect } from 'react'
import type { FieldTransform, PipelineStep, CastStep } from '../../transforms/types'
import type { TransformCategory } from '../../transforms/catalog'
import { getTransformsForType, TRANSFORM_CATALOG } from '../../transforms/catalog'
import { inferOutputType } from '../../transforms/utils'
import { CustomSelect } from '../CustomSelect'

interface Props {
  value:        FieldTransform
  inputType:    TransformCategory
  inputVars:    string[]
  expandedStep: string | null
  onExpandStep: (id: string | null) => void
  onChange:     (val: FieldTransform) => void
  iStyle:       React.CSSProperties
  typeBadge:    (type: string, prefix?: string) => React.ReactNode
}

export function PipelineMode({
  value, inputType, inputVars, expandedStep, onExpandStep, onChange, iStyle, typeBadge,
}: Props) {
  const [showCatalog, setShowCatalog]     = useState(false)
  const [catalogSearch, setCatalogSearch] = useState('')
  const catalogRef = useRef<HTMLDivElement>(null)

  const steps      = value.pipeline ?? []
  const cast       = value.cast
  const currentType = inferOutputType(inputType, cast, steps)
  const allFns     = Object.values(TRANSFORM_CATALOG).flat()
  const catalogFns = getTransformsForType(currentType)

  const filteredFns = catalogSearch.trim()
    ? catalogFns.filter(fn =>
        fn.label.toLowerCase().includes(catalogSearch.toLowerCase()) ||
        fn.description.toLowerCase().includes(catalogSearch.toLowerCase())
      )
    : catalogFns

  // Chiudi catalog al click esterno
  useEffect(() => {
    if (!showCatalog) return
    const handler = (e: MouseEvent) => {
      if (!catalogRef.current?.contains(e.target as Node)) {
        setShowCatalog(false)
        setCatalogSearch('')
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [showCatalog])

  const addStep = useCallback((fnId: string) => {
    const fn = allFns.find(f => f.id === fnId)
    if (!fn) return
    const defaultParams: Record<string, string> = {}
    fn.params?.forEach(p => { defaultParams[p.key] = p.default ?? '' })
    onChange({ ...value, pipeline: [...steps, { id: `step_${Date.now()}`, fnId, params: defaultParams }] })
    setShowCatalog(false)
    setCatalogSearch('')
  }, [value, steps, onChange, allFns])

  const removeStep = useCallback((stepId: string) => {
    onChange({ ...value, pipeline: steps.filter(s => s.id !== stepId) })
    if (expandedStep === stepId) onExpandStep(null)
  }, [value, steps, expandedStep, onChange, onExpandStep])

  const updateStep = useCallback((stepId: string, params: Record<string, string>) => {
    onChange({ ...value, pipeline: steps.map(s => s.id === stepId ? { ...s, params } : s) })
  }, [value, steps, onChange])

  const setCast = useCallback((c: CastStep | undefined) => {
    onChange({ ...value, cast: c })
  }, [value, onChange])

  // Espressione combinata — editabile quando ci sono 2+ inputVars
  const combinedExpr = value.expression ?? inputVars.join(' + ')
  const showCombined = inputVars.length > 1

  const updateExpression = useCallback((expr: string) => {
    onChange({ ...value, expression: expr })
  }, [value, onChange])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>

      {/* Espressione combinata — solo con 2+ campi input */}
      {showCombined && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {/* Token cliccabili */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>campi:</span>
            {inputVars.map((v, i) => (
              <button key={i} onClick={() => {
                const cur = value.expression ?? ''
                const cursorPos = (document.activeElement as HTMLInputElement)?.selectionStart ?? cur.length
                const next = cur.slice(0, cursorPos) + v + cur.slice(cursorPos)
                updateExpression(next)
              }}
                style={{
                  fontSize: 9, padding: '1px 6px', borderRadius: 8,
                  background: '#0f1117', border: '1px solid #2a3349',
                  color: '#4a9eff', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0,
                }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
                {v}
              </button>
            ))}
          </div>
          {/* Campo espressione combinata */}
          <input
            value={combinedExpr}
            onChange={e => updateExpression(e.target.value)}
            style={{ ...iStyle, fontSize: 9, color: '#22d3ee' }}
            placeholder={inputVars.join(" + '-' + ")}
          />
        </div>
      )}

      {/* Pills row — cast + steps + aggiungi */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap', minHeight: 20 }}>

        {/* Cast badge */}
        {cast && (
          <>
            <div
              onClick={() => setCast(undefined)}
              title="Rimuovi cast"
              style={{
                display: 'flex', alignItems: 'center', gap: 2,
                background: '#2a1f00', border: '1px solid #3a3000',
                borderRadius: 4, padding: '1px 5px', fontSize: 9,
                color: '#ffb347', cursor: 'pointer', flexShrink: 0,
              }}>
              {cast.fromType}→{cast.toType} ×
            </div>
            {steps.length > 0 && <span style={{ color: '#2a3349', fontSize: 9 }}>→</span>}
          </>
        )}

        {/* Steps */}
        {steps.map((step, i) => {
          const fn        = allFns.find(f => f.id === step.fnId)
          const isOpen    = expandedStep === step.id
          const hasParams = (fn?.params?.length ?? 0) > 0
          const paramSummary = fn?.params
            ?.map(p => step.params[p.key] ?? p.default ?? '')
            .filter(Boolean).join(',')

          return (
            <div key={step.id} style={{ display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
              <div
                onClick={() => hasParams ? onExpandStep(isOpen ? null : step.id) : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: 3,
                  background: isOpen ? '#1a0f2e' : '#0f1117',
                  border: `1px solid ${isOpen ? '#a78bfa' : '#3a4a6a'}`,
                  borderRadius: 10, padding: '1px 7px 1px 5px',
                  fontSize: 9, cursor: hasParams ? 'pointer' : 'default',
                  whiteSpace: 'nowrap', transition: 'border-color .1s',
                }}
                onMouseEnter={e => { if (!isOpen && hasParams) (e.currentTarget as HTMLElement).style.borderColor = '#a78bfa' }}
                onMouseLeave={e => { if (!isOpen) (e.currentTarget as HTMLElement).style.borderColor = '#3a4a6a' }}>
                <span style={{ color: '#a78bfa', fontWeight: 600, fontSize: 9 }}>
                  {fn?.label ?? step.fnId}
                </span>
                {paramSummary && (
                  <span style={{ color: '#4a5a7a', fontSize: 9, maxWidth: 48, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    ({paramSummary})
                  </span>
                )}
                {hasParams && (
                  <span style={{ color: isOpen ? '#a78bfa' : '#4a5a7a', fontSize: 9 }}>
                    {isOpen ? '▲' : '▼'}
                  </span>
                )}
                <span
                  onClick={e => { e.stopPropagation(); removeStep(step.id) }}
                  style={{ color: '#4a5a7a', fontSize: 9, marginLeft: 1, cursor: 'pointer' }}
                  onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                  onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                  ×
                </span>
              </div>
              {i < steps.length - 1 && <span style={{ color: '#2a3349', fontSize: 9 }}>→</span>}
            </div>
          )
        })}

        {/* Aggiungi step */}
        <div ref={catalogRef} style={{ position: 'relative', flexShrink: 0 }}>
          <button
            onClick={() => { setShowCatalog(v => !v); setCatalogSearch('') }}
            style={{
              display: 'flex', alignItems: 'center', gap: 2,
              background: 'none', border: '1px dashed #2a3349',
              borderRadius: 10, padding: '1px 7px',
              fontSize: 9, color: '#4a5a7a', cursor: 'pointer',
            }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#a78bfa'; (e.currentTarget as HTMLElement).style.color = '#a78bfa' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            <i className="ti ti-plus" style={{ fontSize: 9 }} /> fn
          </button>

          {showCatalog && (
            <div style={{
              position: 'absolute', top: '100%', left: 0, zIndex: 200,
              background: '#1a2030', border: '1px solid #3a4a6a',
              borderRadius: 6, marginTop: 2, width: 220,
              boxShadow: '0 8px 24px rgba(0,0,0,.6)',
              display: 'flex', flexDirection: 'column',
            }}>
              <div style={{ padding: '5px 7px', borderBottom: '0.5px solid #2a3349' }}>
                <input
                  autoFocus
                  value={catalogSearch}
                  onChange={e => setCatalogSearch(e.target.value)}
                  placeholder="cerca funzione..."
                  style={{
                    width: '100%', background: '#0f1117', border: '1px solid #2a3349',
                    borderRadius: 4, color: '#c8d4f0', fontSize: 9,
                    padding: '3px 6px', outline: 'none', fontFamily: 'monospace',
                  }}
                />
              </div>
              <div style={{ maxHeight: 180, overflowY: 'auto' }}>
                {filteredFns.length === 0 ? (
                  <div style={{ padding: '8px', fontSize: 9, color: '#4a5a7a', textAlign: 'center' }}>nessun risultato</div>
                ) : filteredFns.map(fn => (
                  <div
                    key={fn.id}
                    onClick={() => addStep(fn.id)}
                    style={{
                      padding: '4px 8px', fontSize: 9, cursor: 'pointer',
                      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6,
                    }}
                    onMouseEnter={e => { (e.currentTarget as HTMLElement).style.background = '#2a3349' }}
                    onMouseLeave={e => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                    <span style={{ color: '#a78bfa', fontWeight: 600, flexShrink: 0 }}>{fn.label}</span>
                    {fn.outputType && (
                      <span style={{ fontSize: 9, color: '#4a9eff', flexShrink: 0 }}>→{fn.outputType}</span>
                    )}
                    <span style={{ color: '#4a5a7a', fontSize: 9, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', textAlign: 'right' }}>
                      {fn.description}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Parametri step espanso — compatti in riga */}
      {expandedStep && (() => {
        const step = steps.find(s => s.id === expandedStep)
        if (!step) return null
        const fn = allFns.find(f => f.id === step.fnId)
        if (!fn?.params?.length) return null

        // Preview espressione con parametri attuali
        let previewExpr = fn.expression.replace(/\$value/g, inputVars[0] ?? '$value')
        fn.params.forEach(p => {
          previewExpr = previewExpr.replace(new RegExp(`\\$param_${p.key}`, 'g'), step.params[p.key] ?? p.default ?? '')
        })

        return (
          <div style={{
            background: '#0f1117', border: '0.5px solid #2a3349',
            borderRadius: 5, padding: '5px 8px',
            display: 'flex', flexWrap: 'wrap', gap: '4px 12px', alignItems: 'center',
          }}>
            {fn.params.map(p => (
              <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <span style={{ fontSize: 9, color: '#4a5a7a', whiteSpace: 'nowrap' }}>{p.label}</span>
                {p.type === 'select' ? (
                  <CustomSelect
                    value={step.params[p.key] ?? p.default ?? ''}
                    onChange={e => updateStep(step.id, { ...step.params, [p.key]: e.target.value })}
                    style={{ background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 3, color: '#c8d4f0', fontSize: 9, padding: '2px 4px', outline: 'none' }}>
                    {(p.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                  </CustomSelect>
                ) : (
                  <input
                    type={p.type === 'number' ? 'number' : 'text'}
                    value={step.params[p.key] ?? p.default ?? ''}
                    onChange={e => updateStep(step.id, { ...step.params, [p.key]: e.target.value })}
                    style={{
                      background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 3,
                      color: '#c8d4f0', fontFamily: 'monospace', fontSize: 9,
                      padding: '2px 5px', outline: 'none',
                      width: p.type === 'number' ? 52 : 90,
                    }}
                    placeholder={p.default}
                  />
                )}
              </div>
            ))}
            <code style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 160 }}>
              = {previewExpr}
            </code>
          </div>
        )
      })()}
    </div>
  )
}