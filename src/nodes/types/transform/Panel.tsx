/**
 * src/nodes/types/transform/Panel.tsx
 *
 * Modifiche rispetto alla versione precedente:
 * - incomingFields: usa useIncomingSchema(nodeId) invece di risalire
 *   manualmente al nodo sorgente. Questo risolve il bug per cui i
 *   pannelli mostravano i campi di ingresso del TMap invece dei campi
 *   dell'output specifico collegato al Transform.
 * - Dipendenze useMemo corrette — reagisce a incomingSchema del nodo.
 * - Placeholder espressione aggiornato con hint per lane.variabile.
 */

import { useMemo, useCallback } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'
import { propagateSchema } from '../../../utils/schemaUtils'
import {
  getPresetsForType, TYPE_META, FIELD_TYPES,
  type FieldType,
} from '../../../transforms/presets'

// ─── Tipi ─────────────────────────────────────────────────────────

export interface TransformField {
  id:         string
  source:     string
  output:     string
  type:       FieldType
  presetId:   string
  params:     Record<string, string>
  expression: string
  enabled:    boolean
}

// ─── Stili ────────────────────────────────────────────────────────

const S = {
  input: {
    background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
    color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, padding: '4px 7px', outline: 'none', width: '100%',
  } as React.CSSProperties,
  label: {
    fontSize: 9, color: '#9a9aaa', textTransform: 'uppercase' as const,
    letterSpacing: '.07em', fontWeight: 600, marginBottom: 3,
  } as React.CSSProperties,
}

function uid() { return `f_${Date.now()}_${Math.random().toString(36).slice(2, 6)}` }

function btnStyle(color: string): React.CSSProperties {
  return {
    background: 'none', border: `1px solid ${color}40`, borderRadius: 4,
    padding: '3px 8px', fontSize: 10, cursor: 'pointer', color,
    display: 'flex', alignItems: 'center', gap: 4,
  }
}

// ─── Componente principale ────────────────────────────────────────

export function TransformPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)

  // ── useIncomingSchema — pattern corretto ───────────────────────
  // Legge prima incomingSchema del nodo corrente (scritto dalla
  // propagazione reattiva), poi risale la catena come fallback.
  // Gestisce correttamente TMap (output per handle), passthrough, ecc.
  const incomingFields = useIncomingSchema(nodeId)

  if (!node) return null

  const fields: TransformField[] = useMemo(() => {
    try {
      const raw = node.data.props?.['transformFields']
      if (raw) {
        const parsed = JSON.parse(raw as string)
        return parsed.map((f: any) => ({
          ...f,
          presetId:   f.presetId ?? f.transform ?? 'passthrough',
          params:     f.params ?? {},
          expression: f.expression ?? '',
        }))
      }
      // Auto-popolamento iniziale dai campi in ingresso
      if (incomingFields.length > 0) {
        return incomingFields.map(f => ({
          id: uid(), source: f.name, output: f.name,
          type: (f.type as FieldType) ?? 'any',
          presetId: 'passthrough', params: {}, expression: '', enabled: true,
        }))
      }
    } catch {}
    return [{ id: uid(), source: '', output: '', type: 'any' as FieldType, presetId: 'passthrough', params: {}, expression: '', enabled: true }]
  }, [node.data.props?.['transformFields'], incomingFields])

  const saveFields = useCallback((next: TransformField[]) => {
    updateProp(nodeId, 'transformFields', JSON.stringify(next))
    const schema = next
      .filter(f => f.enabled && f.output.trim())
      .map(f => {
        const preset  = getPresetsForType(f.type).find(p => p.id === f.presetId)
        const outType = preset?.outputType ?? f.type
        return { id: f.id, name: f.output.trim(), type: outType }
      })
    updateProp(nodeId, 'outputSchema', JSON.stringify(schema))
    setTimeout(() => {
      const store = useFlowStore.getState()
      propagateSchema(nodeId, schema, store, [], new Set(), () => useFlowStore.getState())
    }, 0)
  }, [nodeId, updateProp])

  const updateField = useCallback((id: string, patch: Partial<TransformField>) => {
    saveFields(fields.map(f => f.id === id ? { ...f, ...patch } : f))
  }, [fields, saveFields])

  const unmappedFields = (node.data.props?.['unmappedFields'] as string) ?? 'drop'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 10, fontWeight: 600, color: '#ffb347', textTransform: 'uppercase', letterSpacing: '.07em', flex: 1 }}>
          Campi · {fields.filter(f => f.enabled).length} attivi
        </span>
        {incomingFields.length > 0 && (
          <button onClick={() => {
            const existing = new Set(fields.map(f => f.source))
            const toAdd = incomingFields
              .filter(f => !existing.has(f.name))
              .map(f => ({
                id: uid(), source: f.name, output: f.name,
                type: (f.type as FieldType) ?? 'any',
                presetId: 'passthrough', params: {}, expression: '', enabled: true,
              }))
            saveFields([...fields, ...toAdd])
          }} style={btnStyle('#3ddc84')}>
            <i className="ti ti-download" style={{ fontSize: 10 }} /> Importa schema
          </button>
        )}
        <button
          onClick={() => saveFields([...fields, {
            id: uid(), source: '', output: '', type: 'any', presetId: 'passthrough',
            params: {}, expression: '', enabled: true,
          }])}
          style={btnStyle('#4a9eff')}>
          <i className="ti ti-plus" style={{ fontSize: 10 }} /> Campo
        </button>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '18px 1fr 16px 1fr 82px 1fr 22px', gap: 4, padding: '3px 6px', background: '#161b27', borderRadius: 4 }}>
        {['', 'Sorgente', '', 'Output', 'Tipo', 'Trasformazione', ''].map((h, i) => (
          <div key={i} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{h}</div>
        ))}
      </div>

      {fields.map(f => (
        <FieldRow
          key={f.id} field={f} incomingFields={incomingFields}
          onChange={patch => updateField(f.id, patch)}
          onRemove={() => saveFields(fields.filter(x => x.id !== f.id))}
        />
      ))}

      {fields.length === 0 && (
        <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Nessun campo — clicca "+ Campo" o "Importa schema"
        </div>
      )}

      <div style={{ marginTop: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', display: 'flex', flexDirection: 'column', gap: 4 }}>
        <div style={S.label}>Campi non mappati</div>
        <CustomSelect
          style={S.input}
          value={unmappedFields}
          onChange={e => updateProp(nodeId, 'unmappedFields', e.target.value)}>
          <option value="drop">Elimina — solo i campi configurati sopra passano</option>
          <option value="passthrough">Passa invariati — aggiunge i campi non mappati</option>
        </CustomSelect>
      </div>

    </div>
  )
}

// ─── Riga singolo campo ───────────────────────────────────────────

function FieldRow({ field, incomingFields, onChange, onRemove }: {
  field:          TransformField
  incomingFields: Array<{ name: string; type: string }>
  onChange:       (patch: Partial<TransformField>) => void
  onRemove:       () => void
}) {
  const presets   = getPresetsForType(field.type)
  const isExpr    = field.presetId === 'expr'
  const selectedP = presets.find(p => p.id === field.presetId)
  const meta      = TYPE_META[field.type] ?? TYPE_META.any
  const outType   = selectedP?.outputType ?? field.type
  const outMeta   = TYPE_META[outType] ?? TYPE_META.any
  const hasParams = !isExpr && (selectedP?.params?.length ?? 0) > 0

  const S_input = {
    background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
    color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
    fontSize: 11, padding: '4px 7px', outline: 'none', width: '100%',
  } as React.CSSProperties

  return (
    <div style={{ background: '#1a2030', border: '0.5px solid #2a3349', borderRadius: 6, padding: '6px 8px', display: 'flex', flexDirection: 'column', gap: 5 }}>

      <div style={{ display: 'grid', gridTemplateColumns: '18px 1fr 16px 1fr 82px 1fr 22px', gap: 4, alignItems: 'center' }}>

        <input type="checkbox" checked={field.enabled}
          onChange={e => onChange({ enabled: e.target.checked })}
          style={{ accentColor: '#ffb347', cursor: 'pointer' }} />

        {incomingFields.length > 0 ? (
          <CustomSelect
            style={{ ...S_input, opacity: field.enabled ? 1 : 0.45 }}
            value={field.source}
            onChange={e => {
              const found = incomingFields.find(f => f.name === e.target.value)
              onChange({
                source:   e.target.value,
                output:   e.target.value,
                type:     (found?.type as FieldType) ?? field.type,
                presetId: 'passthrough',
                params:   {},
              })
            }}>
            <option value="">— campo —</option>
            {incomingFields.map(f => (
              <option key={f.name} value={f.name}>{f.name}</option>
            ))}
          </CustomSelect>
        ) : (
          <input
            style={{ ...S_input, opacity: field.enabled ? 1 : 0.45 }}
            value={field.source}
            onChange={e => onChange({ source: e.target.value })}
            placeholder="campo_input" />
        )}

        <i className="ti ti-arrow-right" style={{ fontSize: 10, color: '#4a5a7a', textAlign: 'center' as const }} />

        <input
          style={{ ...S_input, color: '#3ddc84', opacity: field.enabled ? 1 : 0.45 }}
          value={field.output}
          onChange={e => onChange({ output: e.target.value })}
          placeholder="output" />

        <CustomSelect
          style={{ ...S_input, color: meta.color, background: meta.bg, fontSize: 10, opacity: field.enabled ? 1 : 0.45 }}
          value={field.type}
          onChange={e => onChange({ type: e.target.value as FieldType, presetId: 'passthrough', params: {} })}>
          {FIELD_TYPES.map(t => <option key={t} value={t}>{TYPE_META[t].label}</option>)}
        </CustomSelect>

        <CustomSelect
          style={{ ...S_input, fontSize: 10, opacity: field.enabled ? 1 : 0.45 }}
          value={field.presetId}
          onChange={e => onChange({ presetId: e.target.value, params: {}, expression: '' })}>
          {presets.map(p => (
            <option key={p.id} value={p.id} title={p.description}>{p.label}</option>
          ))}
        </CustomSelect>

        <button onClick={onRemove}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-x" style={{ fontSize: 11 }} />
        </button>
      </div>

      {/* Parametri preset */}
      {hasParams && selectedP!.params!.map(param => (
        <div key={param.key} style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: 8, alignItems: 'center', paddingLeft: 24 }}>
          <span style={{ fontSize: 9, color: '#9a9aaa', whiteSpace: 'nowrap' }}>{param.label}</span>
          {param.type === 'select' ? (
            <CustomSelect
              style={{ ...S_input, fontSize: 10 }}
              value={field.params[param.key] ?? param.default ?? ''}
              onChange={e => onChange({ params: { ...field.params, [param.key]: e.target.value } })}>
              {(param.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
            </CustomSelect>
          ) : (
            <input
              type={param.type === 'number' ? 'number' : 'text'}
              style={{ ...S_input, fontSize: 10 }}
              value={field.params[param.key] ?? param.default ?? ''}
              onChange={e => onChange({ params: { ...field.params, [param.key]: e.target.value } })}
            />
          )}
        </div>
      ))}

      {/* Espressione custom */}
      {isExpr && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4, paddingLeft: 24 }}>
          <input
            style={{ ...S_input, fontFamily: 'monospace', color: '#ffb347' }}
            value={field.expression}
            onChange={e => onChange({ expression: e.target.value })}
            placeholder={`row.${field.source || 'campo'} — es: row.nome.trim(), lane.counter++`}
          />
          <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>
            Usa <code style={{ color: '#4a9eff' }}>row.campo</code> per i campi,{' '}
            <code style={{ color: '#a78bfa' }}>lane.variabile</code> per le variabili di lane,{' '}
            <code style={{ color: '#a78bfa' }}>context.lane.variabile</code> come alias.
            Il risultato diventa <code style={{ color: '#3ddc84' }}>{field.output || 'output'}</code>.
          </div>
        </div>
      )}

      {/* Preview tipo output */}
      {!isExpr && selectedP && selectedP.id !== 'passthrough' && (
        <div style={{ paddingLeft: 24, display: 'flex', alignItems: 'center', gap: 6 }}>
          <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 8, background: outMeta.bg, color: outMeta.color, fontWeight: 600 }}>
            → {outMeta.label}
          </span>
          <span style={{ fontSize: 9, color: '#4a5a7a' }}>{selectedP.description}</span>
        </div>
      )}

    </div>
  )
}