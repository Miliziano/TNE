/**
 * src/nodes/types/data_quality/MappingPanel.tsx
 *
 * I campi in ingresso con le regole DQ di ciascuno, e il campo `_dq`
 * aggiunto in uscita. Sola lettura: le regole si configurano nella scheda
 * Configuration.
 *
 * P368: leggeva `props.dqRules`, che nessuno scrive (il pannello salva in
 * `dqConfig`), quindi diceva sempre "nessuna regola". Ora legge la stessa
 * config del pannello e del builder (schema.ts) e mostra lo schema d'uscita
 * vero (ingresso + `_dq`), che propaga anche a valle.
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../useIncomingSchema'
import type { DQRule } from './dqTypes'
import { DQ_CHECK_DEFS, DQ_REPAIR_DEFS } from './dqTypes'
import { readDqConfig, dqOutputFieldName } from './schema'
import { useDqSchemaSync } from './useDqSchemaSync'

const ACCENT = '#22d3ee'

const SEVERITY_COLOR: Record<string, string> = {
  error: '#ff5f57',
  warn:  '#ffb347',
}

function ruleParam(rule: DQRule): string {
  switch (rule.checkType) {
    case 'range':          return `[${rule.min || '*'}, ${rule.max || '*'}]`
    case 'min_length':     return `≥ ${rule.min ?? ''}`
    case 'max_length':     return `≤ ${rule.max ?? ''}`
    case 'pattern':        return rule.pattern ? `/${rule.pattern}/` : ''
    case 'compare_fields': return `${rule.compareOp ?? '>'} ${rule.compareField ?? ''}`
    case 'referential':    return rule.matName ? `in ${rule.matName}.${rule.refField ?? ''}` : ''
    case 'in_list':
    case 'not_in_list': {
      const items = (rule.list ?? '').split(',').map((s) => s.trim()).filter(Boolean)
      return items.length > 3 ? `{${items.slice(0, 3).join(', ')}…}` : `{${items.join(', ')}}`
    }
    default: return ''
  }
}

export function DataQualityMappingPanel({ nodeId }: { nodeId: string }) {
  const node   = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const fields = useIncomingSchema(nodeId)
  useDqSchemaSync(nodeId)

  const rawConfig = node?.data.props['dqConfig']
  const config    = useMemo(() => readDqConfig(rawConfig), [rawConfig])
  const rules     = useMemo(() => config.rules.filter((r) => r.enabled !== false), [config])
  const disabled  = config.rules.length - rules.length

  // Regole per campo
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
    const names = new Set(fields.map((f) => f.name))
    return [...rulesByField.keys()].filter((f) => f && !names.has(f))
  }, [fields, rulesByField])

  if (!node) return null

  const outName     = dqOutputFieldName(config)
  const totalErrors = rules.filter((r) => r.severity === 'error').length
  const totalWarns  = rules.filter((r) => r.severity === 'warn').length
  const repairs     = rules.filter((r) => r.repair && r.repair !== 'none').length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* Info */}
      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>◈ Data Quality</span> — every row goes out, with the
        fields repaired where a rule says so and the result in <code style={{ color: ACCENT }}>{outName}</code>.
        Use a Filter downstream to separate the rows by <code style={{ color: ACCENT }}>{outName}.valid</code> or score.
      </div>

      {/* Conteggi */}
      {rules.length > 0 && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <div style={{ fontSize: 10, padding: '2px 10px', borderRadius: 8, background: '#1a0000', color: '#ff5f57', border: '0.5px solid #3d1010' }}>
            {totalErrors} error
          </div>
          <div style={{ fontSize: 10, padding: '2px 10px', borderRadius: 8, background: '#1a1000', color: '#ffb347', border: '0.5px solid #3a2a0a' }}>
            {totalWarns} warn
          </div>
          <div style={{ fontSize: 10, padding: '2px 10px', borderRadius: 8, background: '#1a2030', color: '#8593b5', border: '0.5px solid #2a3349' }}>
            {rules.length} rule{rules.length !== 1 ? 's' : ''} on {rulesByField.size} field{rulesByField.size !== 1 ? 's' : ''} · {repairs} with repair
            {disabled > 0 && ` · ${disabled} disabled`}
          </div>
        </div>
      )}

      {/* Campi in ingresso */}
      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Input fields — {fields.length}
      </div>

      {fields.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          Connect an input node to see the available fields.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          {fields.map((field) => {
            const fieldRules = rulesByField.get(field.name) ?? []
            const hasError   = fieldRules.some((r) => r.severity === 'error')
            const hasWarn    = fieldRules.some((r) => r.severity === 'warn')
            const accent     = hasError ? '#ff5f57' : hasWarn ? '#ffb347' : '#2a3349'
            const repaired   = fieldRules.some((r) => r.repair && r.repair !== 'none')

            return (
              <div key={field.name} style={{
                padding: '7px 10px', background: '#1a2030', borderRadius: 6,
                border: `0.5px solid ${accent}`,
                borderLeft: `3px solid ${fieldRules.length > 0 ? accent : '#2a3349'}`,
              }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: fieldRules.length > 0 ? 6 : 0 }}>
                  <code style={{ fontFamily: 'monospace', fontSize: 11, color: fieldRules.length > 0 ? accent : '#3ddc84', flex: 1 }}>
                    {field.name}
                  </code>
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: '#0f1117', color: '#8593b5' }}>
                    {field.type}
                  </span>
                  <span style={{ fontSize: 9, color: '#8593b5', fontFamily: 'monospace' }}>
                    {repaired ? '→ may be repaired' : '→ unchanged'}
                  </span>
                </div>

                {fieldRules.length > 0 && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                    {fieldRules.map((rule) => {
                      const color  = SEVERITY_COLOR[rule.severity] ?? '#8593b5'
                      const label  = DQ_CHECK_DEFS.find((d) => d.type === rule.checkType)?.label ?? rule.checkType
                      const repair = rule.repair && rule.repair !== 'none'
                        ? (DQ_REPAIR_DEFS.find((d) => d.strategy === rule.repair)?.label ?? `${rule.repair} (not supported)`)
                        : ''
                      const param  = ruleParam(rule)
                      return (
                        <div key={rule.id} title={rule.label || `${rule.field} · ${rule.checkType}`}
                          style={{ display: 'flex', alignItems: 'center', gap: 3, padding: '2px 7px', borderRadius: 8, background: `color-mix(in srgb, ${color} 10%, #0f1117)`, border: `0.5px solid ${color}30`, fontSize: 9, color }}>
                          <i className={`ti ${rule.severity === 'error' ? 'ti-alert-circle' : 'ti-alert-triangle'}`} style={{ fontSize: 9 }} />
                          <span style={{ fontFamily: 'monospace' }}>{label}</span>
                          {param && <span style={{ opacity: 0.7 }}>{param}</span>}
                          {repair && <span style={{ color: '#ffb347' }}>✦ {repair}</span>}
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

      {/* Uscita */}
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', lineHeight: 1.8 }}>
        <div style={{ fontSize: 9, color: '#8593b5', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 6 }}>Node output</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 4 }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: '#0d3d20', color: '#3ddc84', border: '0.5px solid #1d6d40', flexShrink: 0 }}>output</span>
          <span style={{ fontSize: 9 }}>All the rows: the input fields plus <code style={{ color: ACCENT }}>{outName}</code> (object)</span>
        </div>
        <div style={{ fontSize: 9, fontFamily: 'monospace', paddingLeft: 4 }}>
          {outName}: score, valid, level, repaired, dimensions, issues
          {config.scoreBeforeRepair && ', score_original'}
          {config.showOriginal && ', original_row'}
        </div>
      </div>

      {/* Campi orfani */}
      {orphanFields.length > 0 && (
        <div style={{ padding: '8px 10px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34730', fontSize: 10, color: '#ffb347', display: 'flex', gap: 6 }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
          <div>
            <div style={{ fontWeight: 600, marginBottom: 2 }}>Fields with rules not found in the input</div>
            <div style={{ fontFamily: 'monospace', fontSize: 9 }}>{orphanFields.join(', ')}</div>
            <div style={{ fontSize: 9, color: '#8593b5', marginTop: 3 }}>
              At run time a missing field is null: not_null and not_empty fail, most other checks let a null pass.
            </div>
          </div>
        </div>
      )}

      {rules.length === 0 && (
        <div style={{ padding: '8px 10px', background: '#1a1000', borderRadius: 6, border: '0.5px solid #ffb34730', fontSize: 10, color: '#ffb347', display: 'flex', gap: 6 }}>
          <i className="ti ti-alert-triangle" style={{ fontSize: 11, flexShrink: 0 }} />
          <span>No active rule — every row goes out with score 1. Configure the rules in the <strong>Configuration</strong> tab.</span>
        </div>
      )}
    </div>
  )
}
