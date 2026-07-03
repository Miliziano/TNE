import type { PipelineStep, CastStep } from '../../transforms/types'
import type { TransformCategory } from '../../transforms/catalog'
import { TRANSFORM_CATALOG } from '../../transforms/catalog'

interface Props {
  steps:     PipelineStep[]
  cast:      CastStep | undefined
  inputVars: string[]
  inputType: TransformCategory
}

// Valori mock per anteprima — uno per tipo
const MOCK_VALUES: Record<string, string> = {
  string:  'esempio',
  date:    '1985-03-22',
  integer: '42',
  decimal: '1234.567',
  number:  '99.9',
  boolean: 'true',
  object:  '{"id":1}',
  any:     'valore',
}

// Applica una funzione mock al valore per la preview
function applyMockStep(value: string, fnId: string, params: Record<string, string>): string {
  const allFns = Object.values(TRANSFORM_CATALOG).flat()
  const fn     = allFns.find((f) => f.id === fnId)
  if (!fn) return value

  // Simulazioni semplici per preview visiva
  switch (fnId) {
    case 'str_trim':       return value.trim()
    case 'str_upper':      return value.toUpperCase()
    case 'str_lower':      return value.toLowerCase()
    case 'str_capitalize': return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase()
    case 'str_slug':       return value.toLowerCase().replace(/\s+/g, '-')
    case 'str_null_empty': return value === '' ? 'null' : value
    case 'str_substr': {
      const start = parseInt(params.start ?? '0', 10)
      const len   = parseInt(params.length ?? '10', 10)
      return value.substring(start, start + len)
    }
    case 'date_iso':
    case 'date_it':
    case 'date_us': {
      try {
        const d   = new Date(value)
        const fmt = params.format ?? fn.params?.[0]?.default ?? 'YYYY-MM-DD'
        const y   = d.getFullYear()
        const m   = String(d.getMonth() + 1).padStart(2, '0')
        const dd  = String(d.getDate()).padStart(2, '0')
        if (fmt.startsWith('DD')) return `${dd}/${m}/${y}`
        if (fmt.startsWith('MM')) return `${m}/${dd}/${y}`
        return `${y}-${m}-${dd}`
      } catch { return value }
    }
    case 'date_ts':    return String(new Date(value).getTime() / 1000 | 0)
    case 'date_ts_ms': return String(new Date(value).getTime())
    case 'date_year':  return String(new Date(value).getFullYear())
    case 'date_month': return String(new Date(value).getMonth() + 1).padStart(2, '0')
    case 'date_day':   return String(new Date(value).getDate()).padStart(2, '0')
    case 'num_round':
    case 'dec_round2': return parseFloat(value).toFixed(2)
    case 'dec_round4': return parseFloat(value).toFixed(4)
    case 'num_floor':  return String(Math.floor(parseFloat(value)))
    case 'num_ceil':   return String(Math.ceil(parseFloat(value)))
    case 'num_abs':    return String(Math.abs(parseFloat(value)))
    case 'num_pct':    return String(parseFloat(value) * 100) + '%'
    case 'int_to_str': return String(parseInt(value, 10))
    case 'int_pad': {
      const len = parseInt(params.length ?? '3', 10)
      return String(parseInt(value, 10)).padStart(len, '0')
    }
    case 'bool_to_str': return value === 'true' ? 'true' : 'false'
    case 'bool_to_int': return value === 'true' ? '1' : '0'
    case 'bool_to_yn':  return value === 'true' ? 'Sì' : 'No'
    case 'bool_negate': return value === 'true' ? 'false' : 'true'
    case 'any_to_str':  return String(value)
    case 'any_to_int':  return String(parseInt(value, 10))
    default: return value
  }
}

export function PreviewBar({ steps, cast, inputVars, inputType }: Props) {
  // Calcola il valore mock iniziale
  const mockInput = MOCK_VALUES[inputType] ?? 'valore'

  // Applica cast
  let current = mockInput
  if (cast) {
    current = `[${cast.toType}] ${current}`
  }

  // Applica ogni step
  const stepResults: { label: string; value: string }[] = [{ label: 'input', value: mockInput }]
  for (const step of steps) {
    current = applyMockStep(current, step.fnId, step.params)
    const allFns = Object.values(TRANSFORM_CATALOG).flat()
    const fn     = allFns.find((f) => f.id === step.fnId)
    stepResults.push({ label: fn?.label ?? step.fnId, value: current })
  }

  if (stepResults.length <= 1) return null

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '4px 8px', background: '#0a0e18', borderRadius: 4, flexWrap: 'wrap' }}>
      {stepResults.map((sr, i) => (
        <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {i > 0 && <span style={{ color: '#2a3349', fontSize: 10 }}>→</span>}
          <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start' }}>
            {i > 0 && <span style={{ fontSize: 9, color: '#4a5a7a' }}>{sr.label}</span>}
            <code style={{ fontSize: 10, color: i === stepResults.length - 1 ? '#3ddc84' : '#4a5a7a', fontFamily: 'monospace' }}>
              {sr.value}
            </code>
          </div>
        </div>
      ))}
      <span style={{ fontSize: 9, color: '#2a3349', marginLeft: 'auto' }}>anteprima mock</span>
    </div>
  )
}
