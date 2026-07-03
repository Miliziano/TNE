import type { PipelineStep } from '../../transforms/types'
import type { TransformTemplate } from '../../transforms/catalog'
import { CustomSelect } from '../CustomSelect'
interface Props {
  fn:        TransformTemplate
  step:      PipelineStep
  inputVars: string[]
  onUpdate:  (params: Record<string, string>) => void
}

export function ParamPanel({ fn, step, inputVars, onUpdate }: Props) {
  if (!fn.params?.length) return null

  const iStyle: React.CSSProperties = {
    background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
    color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
    fontSize: 10, padding: '3px 6px', outline: 'none', width: '100%',
  }

  const updateParam = (key: string, val: string) => {
    onUpdate({ ...step.params, [key]: val })
  }

  // Preview espressione con i parametri attuali
  const previewExpr = (() => {
    let expr = fn.expression.replace('$value', inputVars[0] ?? '$value')
    fn.params?.forEach((p) => {
      const val = step.params[p.key] ?? p.default ?? ''
      expr = expr.replace(`$param_${p.key}`, val)
    })
    // Fallback replace sequenziale per $param0, $param1...
    let i = 0
    fn.params?.forEach((p) => {
      const val = step.params[p.key] ?? p.default ?? ''
      expr = expr.replace(`$param${i}`, val)
      i++
    })
    return expr
  })()

  return (
    <div style={{ background: '#0f1117', border: '1px solid #2a3349', borderRadius: 6, padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Header */}
      <div style={{ fontSize: 9, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '.08em', display: 'flex', alignItems: 'center', gap: 5 }}>
        <i className="ti ti-adjustments" style={{ fontSize: 10 }} aria-hidden="true" />
        {fn.label} — parametri
      </div>

      {/* Parametri */}
      <div style={{ display: 'grid', gridTemplateColumns: '80px 1fr', gap: '5px 10px', alignItems: 'center' }}>
        {fn.params.map((p) => (
          <>
            <span key={`label-${p.key}`} style={{ fontSize: 10, color: '#4a5a7a' }}>{p.label}</span>
            <div key={`input-${p.key}`}>
              {p.type === 'select' ? (
                <CustomSelect
                  value={step.params[p.key] ?? p.default ?? ''}
                  onChange={(e) => updateParam(p.key, e.target.value)}
                  style={iStyle}>
                  {p.options?.map((o) => <option key={o} value={o}>{o}</option>)}
                </CustomSelect>
              ) : p.type === 'number' ? (
                <input
                  type="number"
                  value={step.params[p.key] ?? p.default ?? ''}
                  onChange={(e) => updateParam(p.key, e.target.value)}
                  style={{ ...iStyle, width: 80 }} />
              ) : (
                <input
                  type="text"
                  value={step.params[p.key] ?? p.default ?? ''}
                  onChange={(e) => updateParam(p.key, e.target.value)}
                  style={iStyle}
                  placeholder={p.default} />
              )}
            </div>
          </>
        ))}
      </div>

      {/* Anteprima espressione generata */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', background: '#0a0e18', borderRadius: 4, fontSize: 10 }}>
        <span style={{ color: '#4a5a7a', flexShrink: 0 }}>expr:</span>
        <code style={{ color: '#c8d4f0', fontFamily: 'monospace', fontSize: 10, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {previewExpr}
        </code>
      </div>
    </div>
  )
}
