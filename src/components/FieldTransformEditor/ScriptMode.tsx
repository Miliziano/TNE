import type { FieldTransform } from '../../transforms/types'
import type { TransformCategory } from '../../transforms/catalog'

interface Props {
  value:      FieldTransform
  outputType: TransformCategory   // tipo inferito dall'editor padre
  onChange:   (val: FieldTransform) => void
  iStyle:     React.CSSProperties
}

const SCRIPT_TEMPLATES: Partial<Record<string, string>> = {
  string:   '// Restituisci una stringa\nreturn String($value ?? "").trim()',
  integer:  '// Restituisci un intero\nreturn parseInt(String($value ?? "0").replace(",",""), 10)',
  decimal:  '// Restituisci un decimale\nreturn parseFloat(String($value ?? "0").replace(",","."))',
  boolean:  '// Restituisci true/false\nreturn ["true","1","yes","si","sì"].includes(String($value ?? "").toLowerCase())',
  date:     '// Restituisci una data ISO (YYYY-MM-DD)\nconst d = new Date($value)\nreturn isNaN(d.getTime()) ? null : d.toISOString().split("T")[0]',
  datetime: '// Restituisci un datetime ISO 8601\nconst d = new Date($value)\nreturn isNaN(d.getTime()) ? null : d.toISOString()',
  object:   '// Restituisci un oggetto\ntry { return JSON.parse(String($value)) } catch { return null }',
  any:      '// Trasformazione libera\n// $value = valore input, usa variabili $label.campo per input multipli\nreturn $value',
}

export function ScriptMode({ value, outputType, onChange, iStyle }: Props) {
  const template = SCRIPT_TEMPLATES[outputType] ?? SCRIPT_TEMPLATES.any!
  const lines    = (value.expression ?? '').split('\n')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>

      {/* Editor con numeri riga */}
      <div style={{ display: 'flex', background: '#0a0e18', border: '1px solid #3a4a6a', borderRadius: 4, overflow: 'hidden' }}>
        {/* Numeri riga */}
        <div style={{
          padding: '4px 6px', minWidth: 24, textAlign: 'right',
          fontFamily: 'monospace', fontSize: 9, lineHeight: '15px',
          color: '#2a3349', background: '#0a0e18',
          borderRight: '1px solid #2a3349', userSelect: 'none', flexShrink: 0,
        }}>
          {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          {Array.from({ length: Math.max(0, 4 - lines.length) }).map((_, i) => (
            <div key={`e${i}`} style={{ opacity: 0 }}>0</div>
          ))}
        </div>

        {/* Textarea */}
        <textarea
          value={value.expression ?? ''}
          onChange={(e) => onChange({ ...value, expression: e.target.value })}
          style={{
            flex: 1, minHeight: 64, resize: 'vertical',
            background: 'transparent', border: 'none', outline: 'none',
            color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
            fontSize: 10, lineHeight: '15px', padding: '4px 6px',
          }}
          placeholder={template}
          spellCheck={false}
        />
      </div>

      {/* Template + hint */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button
          onClick={() => onChange({ ...value, expression: template })}
          style={{
            fontSize: 9, padding: '2px 8px', borderRadius: 4,
            background: 'none', border: '1px solid #2a3349',
            color: '#4a5a7a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3,
          }}
          onMouseEnter={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = '#a78bfa'
            ;(e.currentTarget as HTMLElement).style.color = '#a78bfa'
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'
            ;(e.currentTarget as HTMLElement).style.color = '#4a5a7a'
          }}>
          <i className="ti ti-template" style={{ fontSize: 9 }} /> template {outputType}
        </button>
        <span style={{ fontSize: 9, color: '#2a3349' }}>
          usa <code style={{ color: '#4a9eff', fontFamily: 'monospace' }}>$value</code> · variabili <code style={{ color: '#4a9eff' }}>$label.campo</code>
        </span>
      </div>
    </div>
  )
}