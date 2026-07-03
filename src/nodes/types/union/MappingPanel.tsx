/**
 * src/nodes/types/union/MappingPanel.tsx
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { getHandleSchema } from '../../../utils/schemaRegistry'
import type { SchemaFieldDef as SchemaField } from '../../../utils/schemaRegistry'

const ACCENT = '#a78bfa'

const HANDLE_COLORS: Record<string, string> = {
  input_1:    '#4a9eff',
  input_2:    '#3ddc84',
  input_main: '#4a9eff',
}
const EXTRA_COLORS = ['#a78bfa','#ffb347','#22d3ee','#f97316','#ff5f57','#84cc16']

function handleColor(handle: string, idx: number): string {
  return HANDLE_COLORS[handle] ?? EXTRA_COLORS[idx % EXTRA_COLORS.length]
}
function handleLabel(idx: number): string {
  return `flusso ${idx + 1}`
}

export function UnionMappingPanel({ nodeId }: { nodeId: string }) {
  const edges = useFlowStore((s) => s.edges)
  const nodes = useFlowStore((s) => s.nodes)

  const { fields, sources, fieldCount } = useMemo(() => {
    const inEdges   = edges.filter((e) => e.target === nodeId)
    const seenKeys  = new Set<string>()
    const seenNames = new Set<string>()
    const allFields: (SchemaField & { fromHandle: string; fromIdx: number })[] = []
    const sources:   Array<{ label: string; count: number; color: string }> = []

    for (const [idx, edge] of inEdges.entries()) {
      const srcNode = nodes.find((n) => n.id === edge.source)
      if (!srcNode) continue
      const schema = getHandleSchema(srcNode, edge.sourceHandle ?? 'output', false)
      const handle = edge.targetHandle ?? 'input_1'
      const color  = handleColor(handle, idx)
      const handleSuffix = handle === 'input_1' ? '_1' : handle === 'input_2' ? '_2' : `_${idx + 1}`
      let count    = 0
      for (const f of schema) {
        if (!f.name) continue
        const key = `${f.name}::${f.type ?? 'string'}`
        if (!seenKeys.has(key)) {
          let finalName = f.name
          if (seenNames.has(f.name)) {
            finalName = `${f.name}${handleSuffix}`
            let i = 2
            while (seenNames.has(finalName)) finalName = `${f.name}${handleSuffix}_${i++}`
          }
          seenKeys.add(key)
          seenNames.add(finalName)
          allFields.push({ ...f, name: finalName, fromHandle: handle, fromIdx: idx })
        }
        count++
      }
      sources.push({ label: handleLabel(idx), count, color })
    }
    // Conta quanti flussi hanno ogni campo (per nome+tipo)
    const fieldCount = new Map<string, number>()
    for (const [, edge] of inEdges.entries()) {
      const srcNode = nodes.find((n) => n.id === edge.source)
      if (!srcNode) continue
      const schema = getHandleSchema(srcNode, edge.sourceHandle ?? 'output', false)
      const seen = new Set<string>()
      for (const f of schema) {
        const key = `${f.name}::${f.type ?? 'string'}`
        if (!seen.has(key)) { seen.add(key); fieldCount.set(key, (fieldCount.get(key) ?? 0) + 1) }
      }
    }

    return { fields: allFields, sources, fieldCount }
  }, [edges, nodes, nodeId])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`, borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>⊕ Union</span> — schema unificato.
        I campi mostrati sono l'unione di tutti i flussi collegati. I duplicati vengono mantenuti una sola volta.
      </div>

      {sources.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {sources.map((s, i) => (
            <div key={i} style={{ fontSize: 10, padding: '2px 10px', borderRadius: 8, background: `color-mix(in srgb, ${s.color} 10%, #0f1117)`, color: s.color, border: `0.5px solid ${s.color}40` }}>
              {s.label} — {s.count} campi
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Campi in uscita — {fields.length}
      </div>

      {fields.length === 0 ? (
        <div style={{ padding: '20px', textAlign: 'center', color: '#4a5a7a', fontSize: 11, background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          Collega almeno un flusso agli handle sul lato sinistro del nodo.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {fields.map((f) => {
            const key      = `${f.name}::${f.type ?? 'string'}`
            const shared   = (fieldCount.get(key) ?? 1) > 1
            const color    = shared ? '#3ddc84' : handleColor(f.fromHandle, f.fromIdx)
            return (
              <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px', background: '#1a2030', borderRadius: 4, border: `0.5px solid ${shared ? '#3ddc8430' : '#2a3349'}` }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <code style={{ fontFamily: 'monospace', fontSize: 11, color, flex: 1 }}>{f.name}</code>
                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: '#0f1117', color: '#4a5a7a', flexShrink: 0 }}>{f.type}</span>
                {shared && (
                  <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: '#0d3d20', color: '#3ddc84', border: '0.5px solid #1d6d40', flexShrink: 0 }}>
                    in comune
                  </span>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8, background: `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`, color: ACCENT, border: `0.5px solid ${ACCENT}40` }}>output</span>
          <span style={{ fontSize: 9 }}>Flusso unificato — {fields.length} campi</span>
        </div>
      </div>

    </div>
  )
}