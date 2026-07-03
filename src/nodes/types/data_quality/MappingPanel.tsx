/**
 * src/nodes/types/data_quality/MappingPanel.tsx
 *
 * Mostra i campi in ingresso con le regole DQ associate a ciascuno.
 * Sola lettura — il DQ non trasforma i campi, li valida.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const ACCENT = '#3ddc84'

interface DQRule {
  id: string; field: string; ruleType: string
  severity: 'error' | 'warn'; label: string
  min?: string; max?: string; pattern?: string; list?: string
}

const RULE_COLOR: Record<string, string> = {
  error: '#ff5f57',
  warn:  '#ffb347',
}

const RULE_LABEL: Record<string, string> = {
  not_null:    'not null',
  not_empty:   'not empty',
  min_length:  'min len',
  max_length:  'max len',
  range:       'range',
  pattern:     'regex',
  in_list:     'in list',
  not_in_list: '!in list',
  is_numeric:  'numeric',
  is_date:     'date',
  is_email:    'email',
  is_url:      'url',
  unique:      'unique',
  referential: 'ref',
  custom:      'custom',
}

function ruleParam(rule: DQRule): string {
  switch (rule.ruleType) {
    case 'range':      return `[${rule.min??'*'}, ${rule.max??'*'}]`
    case 'min_length': return `≥ ${rule.min}`
    case 'max_length': return `≤ ${rule.max}`
    case 'pattern':    return rule.pattern ? `/${rule.pattern}/` : ''
    case 'in_list':
    case 'not_in_list': {
      const items = (rule.list ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      return items.length > 3
        ? `{${items.slice(0,3).join(', ')}…}`
        : `{${items.join(', ')}}`
    }
    default: return ''
  }
}

export function DataQualityMappingPanel({ nodeId }: { nodeId: string }) {
  const node   = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const fields = useIncomingSchema(nodeId)

  if (!node) return null

  const rules: DQRule[] = useMemo(() => {
    try { return JSON.parse(node.data.props['dqRules'] ?? '[]') }
    catch { return [] }
  }, [node.data.props['dqRules']])

  const errorField = node.data.props['errorField'] ?? '_dq_errors'

  // Raggruppa regole per campo
  const rulesByField = useMemo(() => {
    const map = new Map<string, DQRule[]>()
    for (const rule of rules) {
      if (!map.has(rule.field)) map.set(rule.field, [])
      map.get(rule.field)!.push(rule)
    }
    return map
  }, [rules])

  // Campi con regole ma non nello schema in ingresso
  const orphanFields = useMemo(() => {
    const inFieldNames = new Set(fields.map((f) => f.name))
    return [...rulesByField.keys()].filter((f) => f && !inFieldNames.has(f))
  }, [fields, rulesByField])

  const totalErrors = rules.filter((r) => r.severity === 'error').length
  const totalWarns  = rules.filter((r) => r.severity === 'warn').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>✓ Data Quality</span> — passthrough.
        I campi transitano invariati. Le righe invalide escono dall'handle <code style={{ color: '#ff5f57' }}>reject</code> con il campo <code style={{ color: '#ff5f57' }}>{errorField}</code>.
      </div>

      {/* Stats regole */}
      {rules.length > 0 && (
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ fontSize: 10, padding: '2px 10px', borderRadius: 8, background: '#1a0000', color: '#ff5f57', border: '0.5px solid #3d1010' }}>
            {totalErrors} error
          </div>
          <div style={{ fontSize: 10, padding: '2px 10px', borderRadius: 8, background: '#1a1000', color: '#ffb347', border: '0.5px solid #3a2a0a' }}>
            {totalWarns} warn
          </div>
          <div style={{ fontSize: 10, padding: '2px 10px', borderRadius: 8, background: '#1a2030', color: '#4a5a7a', border: '0.5px solid #2a3349' }}>
            {rules.length} regole su {rulesByField.size} campi
          </div>
        </div>
      )}

      {/* Campi in ingresso */}
      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Campi in transito — {fields.length}
      </div>

      {fields.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          Collega un nodo in ingresso per vedere i campi disponibili.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {fields.map((field) => {
            const fieldRules = rulesByField.get(field.name) ?? []
            const hasError   = fieldRules.some((r) => r.severity === 'error')
            const hasWarn    = fieldRules.some((r) => r.severity === 'warn')
            const accent     = hasError ? '#ff5f57' : hasWarn ? '#ffb347' : '#2a3349'

            return (
              <div key={field.name} style={{
                padding: '7px 10px', background: '#1a2030', borderRadius: 6,
                border: `0.5px solid ${accent}`,
                borderLeft: `3px solid ${fieldRules.length > 0 ? accent : '#2a3349'}`,
              }}>
                {/* Nome campo + tipo */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: fieldRules.length > 0 ? 6 : 0 }}>
                  <code style={{ fontFamily: 'monospace', fontSize: 11, color: fieldRules.length > 0 ? accent : ACCENT, flex: 1 }}>
                    {field.name}
                  </code>
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: '#0f1117', color: '#4a5a7a' }}>
                    {field.type}
                  </span>
                  <span style={{ fontSize: 9, color: '#2a3349', fontFamily: 'monospace' }}>→ invariato</span>
                  {fieldRules.length > 0 && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: `color-mix(in srgb, ${accent} 10%, #0f1117)`, color: accent, border: `0.5px solid ${accent}30` }}>
                      {fieldRules.length} regl{fieldRules.length !== 1 ? 'a' : 'e'}
                    </span>
                  )}
                </div>

                {/* Badge regole */}
                {fieldRules.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {fieldRules.map((rule) => {
                      const color  = RULE_COLOR[rule.severity]
                      const label  = RULE_LABEL[rule.ruleType] ?? rule.ruleType
                      const param  = ruleParam(rule)
                      return (
                        <div key={rule.id} title={rule.label || `${rule.field}_${rule.ruleType}`}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 8, background: `color-mix(in srgb, ${color} 10%, #0f1117)`, border: `0.5px solid ${color}30`, fontSize: 9, color }}>
                          <i className={`ti ${rule.severity === 'error' ? 'ti-alert-circle' : 'ti-alert-triangle'}`} style={{ fontSize: 9 }} />
                          <span style={{ fontFamily: 'monospace' }}>{label}</span>
                          {param && <span style={{ opacity: 0.7 }}>{param}</span>}
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {/* Campo _dq_errors aggiunto alle righe reject */}
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', lineHeight: 1.8 }}>
        <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Output del nodo</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: '#0d3d20', color: ACCENT, border: `0.5px solid #1d6d40`, flexShrink: 0 }}>output</span>
          <span style={{ fontSize: 9 }}>Righe valide — schema identico all'ingresso</span>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: '#1a0000', color: '#ff5f57', border: '0.5px solid #3d1010', flexShrink: 0 }}>reject</span>
          <span style={{ fontSize: 9 }}>Righe invalide + campo <code style={{ color: '#ff5f57' }}>{errorField}</code> con dettaglio errori</span>
        </div>
      </div>

      {/* Warning campi orfani */}
      {orphanFields.length > 0 && (
        <div style={{ padding: '8px 10px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34730', fontSize: 10, color: '#ffb347', display: 'flex', gap: 6 }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Campi con regole non trovati nello schema</div>
            <div style={{ fontFamily: 'monospace', fontSize: 9 }}>
              {orphanFields.join(', ')}
            </div>
            <div style={{ fontSize: 9, color: '#4a5a7a', marginTop: 3 }}>
              Le regole su questi campi potrebbero non funzionare. Verifica il nodo sorgente.
            </div>
          </div>
        </div>
      )}

      {rules.length === 0 && (
        <div style={{ padding: '8px 10px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34730', fontSize: 10, color: '#ffb347', display: 'flex', gap: 6 }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 11, flexShrink: 0 }} />
          Nessuna regola configurata — tutti i dati passano come validi.
          Configura le regole nel tab <strong>Configurazione</strong>.
        </div>
      )}
    </div>
  )
}
