/**
 * src/nodes/types/explode/MappingPanel.tsx
 *
 * Mapping dei campi dell'Explode: quali campi escono, con che nome, tipo e
 * trasformazione. Il motore lo applica (P360, explode.rs); lo schema
 * d'uscita si ricava SOLO da qui, con la regola di ./schema.ts.
 */
import { useEffect, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import { useIncomingSchema } from '../../useIncomingSchema'
import type { TMapConfig } from '../../../types'
import { FIELD_TYPES, type FieldType } from '../../../types/fieldTypes'
import {
  EXPLODE_TRANSFORMS, explodeOutputSchema, materializeSchemaOf, readExplodeMapping,
  type ExplodeMappingField,
} from './schema'

const ACCENT = '#a78bfa'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}

type MappingField = ExplodeMappingField

/** Porta lo schema d'uscita ai nodi collegati a valle. */
function propagate(nodeId: string, outputSchema: Array<{ id: string; name: string; type: string; physicalName?: string }>) {
  const store    = useFlowStore.getState()
  const outEdges = store.edges.filter((e) => e.source === nodeId)
  outEdges.forEach((edge) => {
    const tgt = store.nodes.find((n) => n.id === edge.target)
    if (!tgt) return
    if (tgt.data.type === 'tmap') {
      const tmap  = tgt.data.config?.tmap as TMapConfig | undefined
      if (!tmap) return
      const input = tmap.inputs.find((i) => i.id === edge.targetHandle)
      if (!input) return
      const existingNames = new Set(
        input.fields.map((f) => f.name)
      )
      const merged = [
        ...input.fields,
        ...outputSchema
          .filter((f) => !existingNames.has(f.name))
          .map((f) => ({ id: f.id, name: f.name, type: f.type as FieldType, physicalName: f.physicalName })),
      ]
      store.updateTMapInput(tgt.id, input.id, { fields: merged })
    } else {
      store.updateNodeProp(tgt.id, 'incomingSchema', JSON.stringify(outputSchema))
    }
  })
}

export function ExplodeMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const nodes      = useFlowStore((s) => s.nodes)
  const pool       = useFlowStore((s) => s.pool)
  const parentFields = useIncomingSchema(nodeId)

  const props   = node?.data.props ?? {}
  const source  = props['explodeSource'] ?? 'materialize'
  const laneId  = node?.data.laneId
  const matName = props['materializeName'] ?? ''

  const laneVars = pool.lanes.find((l) => l.id === laneId)?.variables ?? []
  const matVar   = laneVars.find((v) => v.type === 'materialize' && v.name === matName)
  const matNode  = matVar ? nodes.find((n) => n.id === matVar.value) : null
  const matMode  = matNode?.data.props['matMode'] ?? 'passthrough'

  const materializeSchema = useMemo(
    () => source === 'materialize' ? materializeSchemaOf(matNode) : [],
    [source, matNode],
  )
  // Campi proposti dal "Sync": quelli del dataset (materialize).
  const sourceSchema = materializeSchema

  const mapping: MappingField[] = readExplodeMapping(props['explodeMapping'])

  // Schema d'uscita: ricalcolato da mapping, sorgente e campi del padre;
  // scritto (e propagato) solo quando cambia.
  const outputSchema = explodeOutputSchema({ props, parentFields, materializeSchema })
  const outputJson   = JSON.stringify(outputSchema)
  useEffect(() => {
    if (!node || outputJson === (props['outputSchema'] ?? '[]')) return
    if (outputSchema.length === 0 && !props['outputSchema']) return
    updateProp(nodeId, 'outputSchema', outputJson)
    propagate(nodeId, outputSchema)
  }, [outputJson])

  const saveMapping = (fields: MappingField[]) =>
    updateProp(nodeId, 'explodeMapping', JSON.stringify(fields))

  // Primo accesso con un dataset noto: il mapping parte da tutti i suoi campi.
  useEffect(() => {
    if (node && sourceSchema.length > 0 && mapping.length === 0) {
      saveMapping(sourceSchema.map((f) => ({
        sourceField: f.name,
        outputName:  f.name,
        type:        f.type,
        transform:   '',
        include:     true,
      })))
    }
  }, [sourceSchema.map((f) => f.name).join(',')])

  if (!node) return null

  const syncFromSource = () => {
    const existing = new Set(mapping.map((f) => f.sourceField))
    const newFields = sourceSchema
      .filter((f) => !existing.has(f.name))
      .map((f) => ({ sourceField: f.name, outputName: f.name, type: f.type, transform: '', include: true }))
    if (newFields.length > 0) saveMapping([...mapping, ...newFields])
  }

  const toggleInclude = (idx: number) =>
    saveMapping(mapping.map((f, i) => i === idx ? { ...f, include: !f.include } : f))

  const updateField = (idx: number, key: keyof MappingField, value: string | boolean) =>
    saveMapping(mapping.map((f, i) => i === idx ? { ...f, [key]: value } : f))

  const moveField = (idx: number, dir: 'up' | 'down') => {
    const arr = [...mapping]
    const swap = dir === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= arr.length) return
    ;[arr[idx], arr[swap]] = [arr[swap], arr[idx]]
    saveMapping(arr)
  }

  const addManual = () => {
    const n = mapping.length + 1
    saveMapping([...mapping, { sourceField: '', outputName: `field_${n}`, type: 'string', transform: '', include: true }])
  }

  const includedCount = mapping.filter((f) => f.include).length

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      <div style={{ padding: '6px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', display: 'flex', gap: 8, alignItems: 'center' }}>
        <span style={{ fontSize: 14, color: ACCENT }}>⊕</span>
        <div>
          Source: <strong style={{ color: '#c8d4f0' }}>
            {source === 'materialize' ? `Materialize "${matName || '—'}"` : 'Flow Field'}
          </strong>
          {matNode && (
            <span style={{ marginLeft: 8, color: '#8593b5' }}>
              mode: {matMode === 'passthrough' ? 'passthrough' : matMode === 'buffer_signal' ? 'buffer→signal' : 'buffer→replay'}
            </span>
          )}
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: '#c8d4f0', flex: 1 }}>
          Field mapping
          <span style={{ fontSize: 10, color: '#8593b5', fontWeight: 400, marginLeft: 8 }}>
            — {includedCount} of {mapping.length} selected
          </span>
        </div>
        {sourceSchema.length > 0 && (
          <button onClick={syncFromSource}
            style={{ padding: '4px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 12%, #161b27)`, color: ACCENT, border: `1px solid ${ACCENT}40`, display: 'flex', alignItems: 'center', gap: 4 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 20%, #161b27)` }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${ACCENT} 12%, #161b27)` }}>
            <i className="ti ti-refresh" style={{ fontSize: 10 }} />
            Sync
          </button>
        )}
      </div>

      <div style={{ borderBottom: '0.5px solid #2a3349' }} />

      {mapping.length === 0 && (
        <div style={{ padding: '20px', textAlign: 'center', color: '#8593b5', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-table-off" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          {source === 'materialize' && !matName
            ? 'Select a Materialize in the Configuration tab.'
            : source === 'materialize' && sourceSchema.length === 0
            ? `The Materialize "${matName}" has not received fields yet. Without a mapping every field is emitted as it is.`
            : 'No mapping: every field of the exploded element is emitted as it is. Add the fields to choose, rename and convert them.'}
        </div>
      )}

      {mapping.length > 0 && (
        <div style={{ border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '24px 28px minmax(80px,1fr) minmax(80px,1fr) 80px minmax(80px,1fr) 24px', gap: 6, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #3a4a6a' }}>
            {['', '✓', 'Physical col.', 'Logical name', 'Type', 'Transformation', ''].map((h, i) => (
              <div key={i} style={{ fontSize: 10, color: ACCENT, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</div>
            ))}
          </div>

          {mapping.map((field, idx) => (
            <div key={idx}
              style={{ display: 'grid', gridTemplateColumns: '24px 28px minmax(80px,1fr) minmax(80px,1fr) 80px minmax(80px,1fr) 24px', gap: 6, alignItems: 'center', padding: '4px 8px', background: !field.include ? '#0f1117' : idx % 2 === 0 ? '#1a2030' : '#1e2535', borderBottom: idx < mapping.length - 1 ? '0.5px solid #2a3349' : 'none', opacity: field.include ? 1 : 0.4 }}>

              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <button onClick={() => moveField(idx, 'up')} disabled={idx === 0}
                  style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'not-allowed' : 'pointer', color: idx === 0 ? '#2a3349' : '#8593b5', padding: 0, lineHeight: 1 }}>
                  <i className="ti ti-chevron-up" style={{ fontSize: 9 }} />
                </button>
                <button onClick={() => moveField(idx, 'down')} disabled={idx === mapping.length - 1}
                  style={{ background: 'none', border: 'none', cursor: idx === mapping.length - 1 ? 'not-allowed' : 'pointer', color: idx === mapping.length - 1 ? '#2a3349' : '#8593b5', padding: 0, lineHeight: 1 }}>
                  <i className="ti ti-chevron-down" style={{ fontSize: 9 }} />
                </button>
              </div>

              <div onClick={() => toggleInclude(idx)}
                style={{ width: 18, height: 18, borderRadius: 4, border: `1.5px solid ${field.include ? ACCENT : '#2a3349'}`, background: field.include ? `color-mix(in srgb, ${ACCENT} 20%, #0f1117)` : 'transparent', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                {field.include && <i className="ti ti-check" style={{ fontSize: 10, color: ACCENT }} />}
              </div>

              {source === 'materialize' ? (
                <div title={field.sourceField}
                  style={{ fontFamily: 'monospace', fontSize: 10, color: '#8593b5', padding: '3px 6px', background: '#161b27', borderRadius: 4, border: '0.5px solid #2a3349', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {field.sourceField}
                </div>
              ) : (
                <input value={field.sourceField}
                  onChange={(e) => updateField(idx, 'sourceField', e.target.value)}
                  style={{ ...inputStyle, fontSize: 10, padding: '3px 6px', color: '#8593b5' }}
                  placeholder="source_col" />
              )}

              <input value={field.outputName}
                onChange={(e) => updateField(idx, 'outputName', e.target.value)}
                disabled={!field.include}
                style={{ ...inputStyle, fontSize: 10, padding: '3px 6px', color: ACCENT }}
                placeholder="logical_name" />

              <CustomSelect value={field.type}
                onChange={(e) => updateField(idx, 'type', e.target.value)}
                disabled={!field.include}
                style={{ ...inputStyle, fontSize: 10, padding: '3px 4px' }}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </CustomSelect>

              <CustomSelect value={field.transform ?? ''}
                onChange={(e) => updateField(idx, 'transform', e.target.value)}
                disabled={!field.include}
                style={{ ...inputStyle, fontSize: 10, padding: '3px 2px' }}>
                {/* Le conversioni le fa la colonna Type: qui solo il testo.
                    Valori vecchi (to_int, to_float…) il motore li applica come tipo. */}
                {EXPLODE_TRANSFORMS.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                {field.transform && !EXPLODE_TRANSFORMS.some((t) => t.value === field.transform) && (
                  <option value={field.transform}>{field.transform} (legacy)</option>
                )}
              </CustomSelect>

              <button onClick={() => saveMapping(mapping.filter((_, i) => i !== idx))}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#8593b5', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
                <i className="ti ti-x" style={{ fontSize: 10 }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {mapping.length > 0 && (
        <div style={{ display: 'flex', gap: 6 }}>
          <button onClick={() => saveMapping(mapping.map((f) => ({ ...f, include: true })))}
            style={{ flex: 1, padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`, color: ACCENT, border: `0.5px solid ${ACCENT}40`, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <i className="ti ti-checks" style={{ fontSize: 10 }} /> Select all
          </button>
          <button onClick={() => saveMapping(mapping.map((f) => ({ ...f, include: false })))}
            style={{ flex: 1, padding: '5px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#8593b5', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}>
            <i className="ti ti-square" style={{ fontSize: 10 }} /> Deselect all
          </button>
        </div>
      )}

      <button onClick={addManual}
        style={{ padding: '6px', fontSize: 10, borderRadius: 4, cursor: 'pointer', background: '#1a2030', color: '#8593b5', border: '0.5px dashed #2a3349', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 4 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = ACCENT; (e.currentTarget as HTMLElement).style.color = ACCENT }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.color = '#8593b5' }}>
        <i className="ti ti-plus" style={{ fontSize: 10 }} /> Add field manually
      </button>

      <div style={{ padding: '6px 10px', fontSize: 10, color: '#8593b5', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
        <strong style={{ color: '#9a9aaa' }}>Physical col.</strong> is the field name in the exploded element.
        Only the selected fields are emitted, with the logical name and the chosen type.
        {source === 'flow_field' && props['includeParent'] === 'true' && ' The parent row\'s fields are added as they are.'}
        {' '}The schema is propagated automatically to downstream nodes.
      </div>
    </div>
  )
}