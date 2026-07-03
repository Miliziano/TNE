import { useState, useCallback } from 'react'
import type { FieldTransform } from '../../transforms/types'
import type { TransformCategory } from '../../transforms/catalog'
import { TRANSFORM_CATALOG } from '../../transforms/catalog'

interface Props {
  value:     FieldTransform
  inputType: TransformCategory
  inputVars: string[]
  onChange:  (val: FieldTransform) => void
  iStyle:    React.CSSProperties
}

export function InlineMode({ value, inputType, inputVars, onChange, iStyle }: Props) {
  const [showAll, setShowAll] = useState(false)

  // Prende le funzioni dal catalogo per il tipo corrente
  const catalogFns = TRANSFORM_CATALOG[inputType] ?? TRANSFORM_CATALOG.any ?? []
  // Mostra max 6 suggerimenti rapidi, poi "altri..."
  const quickFns   = showAll ? catalogFns : catalogFns.slice(0, 6)

  const applyFn = useCallback((expr: string, params?: Array<{ key: string; default?: string }>) => {
    // Sostituisce $value con la prima variabile reale
    const firstVar = inputVars[0] ?? '$value'
    let applied = expr.replace(/\$value/g, firstVar)
    // Sostituisce parametri con i default
    if (params) {
      params.forEach((p) => {
        applied = applied.replace(new RegExp(`\\$param_${p.key}`, 'g'), p.default ?? '')
      })
    }
    onChange({ ...value, expression: applied })
  }, [value, inputVars, onChange])

  const defaultPlaceholder = inputVars.join(' + ') || '$input.campo'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>

      {/* Campo espressione */}
      <input
        value={value.expression ?? ''}
        onChange={(e) => onChange({ ...value, expression: e.target.value })}
        style={{ ...iStyle, width: '100%' }}
        placeholder={defaultPlaceholder}
      />

      {/* Suggerimenti dal catalogo */}
      {catalogFns.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0, marginTop: 2 }}>⚡</span>
          {quickFns.map((fn) => (
            <button
              key={fn.id}
              onClick={() => applyFn(fn.expression, fn.params)}
              title={fn.description}
              style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 10,
                background: '#1a2030', border: '1px solid #2a3349',
                color: '#ffb347', cursor: 'pointer', flexShrink: 0,
                transition: 'all .12s',
              }}
              onMouseEnter={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = '#a78bfa'
                ;(e.currentTarget as HTMLElement).style.color = '#a78bfa'
              }}
              onMouseLeave={(e) => {
                (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'
                ;(e.currentTarget as HTMLElement).style.color = '#ffb347'
              }}>
              {fn.label}
            </button>
          ))}
          {catalogFns.length > 6 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 10,
                background: 'none', border: '1px dashed #2a3349',
                color: '#4a5a7a', cursor: 'pointer', flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#a78bfa' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
              {showAll ? '↑ meno' : `+${catalogFns.length - 6} altri`}
            </button>
          )}
        </div>
      )}

      {/* Variabili disponibili */}
      {inputVars.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
          <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>vars:</span>
          {inputVars.map((v) => (
            <button
              key={v}
              onClick={() => {
                const cur = value.expression ?? ''
                onChange({ ...value, expression: cur ? cur + ' + ' + v : v })
              }}
              style={{
                fontSize: 9, padding: '2px 7px', borderRadius: 10,
                background: '#0f1117', border: '1px solid #2a3349',
                color: '#4a9eff', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0,
              }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              {v}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}