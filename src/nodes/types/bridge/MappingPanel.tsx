/**
 * src/nodes/types/bridge/MappingPanel.tsx
 *
 * Mapping panel per bridge_in — permette di dichiarare i campi
 * che BridgeIn emetterà e li propaga come outputSchema ai nodi successivi.
 */
import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'
import type { TMapConfig } from '../../../types'
import { getHandleSchema } from '../../../utils/schemaRegistry'
import {  useMemo } from 'react'

import { FIELD_TYPES } from '../../../types/fieldTypes'

const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '3px 6px', outline: 'none', width: '100%',
}

interface SchemaField {
  id: string; name: string; physicalName: string; type: string
}

export function BridgeInMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)

  if (!node) return null

  const channelColor = String(node.data.props?.['channelColor'] ?? '#a78bfa')
  const color        = channelColor

  const getSchema = (): SchemaField[] => {
    try {
      const raw = node.data.props?.['outputSchema']
      if (raw) return JSON.parse(raw as string)
    } catch {}
    return []
  }

  const saveSchema = (fields: SchemaField[]) => {
    updateProp(nodeId, 'outputSchema', JSON.stringify(fields))

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
          input.fields.filter((f) => !f.name.startsWith('status.')).map((f) => f.name)
        )
        const merged = [
          ...input.fields,
          ...fields
            .filter((f) => !existingNames.has(f.name))
            .map((f) => ({ id: f.id, name: f.name, type: f.type as any, physicalName: f.physicalName })),
        ]
        store.updateTMapInput(tgt.id, input.id, { fields: merged })
      } else {
        store.updateNodeProp(tgt.id, 'incomingSchema', JSON.stringify(fields))
      }
    })
  }

  const schema = getSchema()

  const addField = () => {
    const n    = schema.length + 1
    const name = `campo_${n}`
    saveSchema([...schema, { id: `f_${Date.now()}`, name, physicalName: name, type: 'string' }])
  }

  const updateField = (idx: number, key: string, value: string) =>
    saveSchema(schema.map((f, i) => i === idx ? { ...f, [key]: value } : f))

  const deleteField = (idx: number) =>
    saveSchema(schema.filter((_, i) => i !== idx))

  const moveField = (idx: number, dir: 'up' | 'down') => {
    const next = [...schema]
    const swap = dir === 'up' ? idx - 1 : idx + 1
    if (swap < 0 || swap >= next.length) return
    ;[next[idx], next[swap]] = [next[swap], next[idx]]
    saveSchema(next)
  }
  const allNodes = useFlowStore((s) => s.nodes)
  const channelName = String(node.data.props?.['channelName'] ?? '')
  const laneId = node.data.laneId

  const counterpart = useMemo(() => {
    if (!channelName) return null
    return allNodes.find((n) =>
      n.data.type === 'bridge_out' &&
      n.data.props?.['channelName'] === channelName &&
      n.data.laneId !== laneId
    ) ?? null
  }, [allNodes, channelName, laneId])

  const proposedSchema = useMemo(() => {
    if (!counterpart) return []
    return getHandleSchema(counterpart, 'input', true)
  }, [counterpart])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* Info */}
      <div style={{ padding: '7px 10px', background: `color-mix(in srgb, ${color} 8%, #0f1117)`,
        border: `0.5px solid ${color}30`, borderRadius: 6, fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
        Dichiara i campi che BridgeIn emetterà verso i nodi successivi.
        I campi vengono propagati automaticamente ai TMap e agli altri nodi collegati.
      </div>

      {/* Proposta automatica dal BridgeOut collegato */}
      {counterpart && proposedSchema.length > 0 && (
        <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${color} 10%, #0f1117)`,
          border: `0.5px solid ${color}40`, borderRadius: 6, fontSize: 10, color: '#9a9aaa',
          display: 'flex', alignItems: 'center', gap: 8 }}>
          <i className="ti ti-wand" style={{ fontSize: 12, color }} />
          <span style={{ flex: 1 }}>
            Il BridgeOut collegato riceve <strong style={{ color }}>{proposedSchema.length}</strong> campi reali dalla sua lane.
          </span>
          <button onClick={() => saveSchema(proposedSchema.map((f) => ({
              id: f.id, name: f.name, physicalName: f.physicalName ?? f.name, type: f.type,
            })))}
            style={{ padding: '3px 10px', fontSize: 10, borderRadius: 4, cursor: 'pointer',
              background: `${color}20`, border: `1px solid ${color}60`, color, fontWeight: 600 }}>
            Usa questi campi
          </button>
        </div>
      )}
      {counterpart && proposedSchema.length === 0 && (
        <div style={{ padding: '6px 10px', fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>
          Il BridgeOut collegato non ha ancora uno schema in ingresso — collega una sorgente nella sua lane,
          oppure dichiara i campi manualmente qui sotto.
        </div>
      )}
      
      {/* Toolbar */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <button onClick={addField}
          style={{ padding: '4px 12px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
            background: `color-mix(in srgb, ${color} 15%, #1a2030)`,
            color, border: `1px solid ${color}60`, fontWeight: 600,
            display: 'flex', alignItems: 'center', gap: 4 }}>
          <i className="ti ti-plus" style={{ fontSize: 11 }} /> Aggiungi campo
        </button>
        {schema.length > 0 && (
          <button onClick={() => { if (confirm('Svuotare lo schema?')) saveSchema([]) }}
            style={{ padding: '4px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer',
              background: 'none', color: '#4a5a7a', border: '0.5px solid #2a3349' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            <i className="ti ti-trash" style={{ fontSize: 11 }} />
          </button>
        )}
        <span style={{ fontSize: 10, color: '#4a5a7a', marginLeft: 'auto' }}>
          {schema.length} {schema.length === 1 ? 'campo' : 'campi'}
        </span>
      </div>

      {/* Tabella */}
      {schema.length === 0 ? (
        <div style={{ padding: '32px 12px', textAlign: 'center', color: '#2a3349', fontSize: 11,
          background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          Nessun campo — aggiungi i campi che BridgeIn emetterà
        </div>
      ) : (
        <div style={{ background: '#0f1117', borderRadius: 6, border: '0.5px solid #2a3349', overflow: 'hidden' }}>
          {/* Header */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 20px 20px 20px',
            gap: 4, padding: '5px 8px', background: '#1a2030', borderBottom: '0.5px solid #2a3349' }}>
            {['Nome campo', 'Nome fisico', 'Tipo', '', '', ''].map((h, i) => (
              <div key={i} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.05em', fontWeight: 600 }}>{h}</div>
            ))}
          </div>
          {/* Righe */}
          {schema.map((field, idx) => (
            <div key={field.id}
              style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 90px 20px 20px 20px',
                gap: 4, alignItems: 'center', padding: '3px 8px',
                background: idx % 2 === 0 ? '#1a2030' : 'transparent',
                borderBottom: idx < schema.length - 1 ? '0.5px solid #1e2840' : 'none' }}>
              <input value={field.name}
                onChange={(e) => updateField(idx, 'name', e.target.value)}
                style={{ ...iStyle, fontSize: 10, color }}
                placeholder="nome_campo" />
              <input value={field.physicalName}
                onChange={(e) => updateField(idx, 'physicalName', e.target.value)}
                style={{ ...iStyle, fontSize: 10, color: '#9a9aaa' }}
                placeholder={field.name || 'alias'} />
              <CustomSelect value={field.type}
                onChange={(e) => updateField(idx, 'type', e.target.value)}
                style={{ ...iStyle, fontSize: 10, padding: '3px 4px' }}>
                {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </CustomSelect>
              <button onClick={() => moveField(idx, 'up')} disabled={idx === 0}
                style={{ background: 'none', border: 'none', cursor: idx === 0 ? 'not-allowed' : 'pointer',
                  color: idx === 0 ? '#2a3349' : '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { if (idx !== 0) (e.currentTarget as HTMLElement).style.color = color }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = idx === 0 ? '#2a3349' : '#4a5a7a' }}>
                <i className="ti ti-chevron-up" style={{ fontSize: 10 }} />
              </button>
              <button onClick={() => moveField(idx, 'down')} disabled={idx === schema.length - 1}
                style={{ background: 'none', border: 'none', cursor: idx === schema.length - 1 ? 'not-allowed' : 'pointer',
                  color: idx === schema.length - 1 ? '#2a3349' : '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { if (idx !== schema.length - 1) (e.currentTarget as HTMLElement).style.color = color }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = idx === schema.length - 1 ? '#2a3349' : '#4a5a7a' }}>
                <i className="ti ti-chevron-down" style={{ fontSize: 10 }} />
              </button>
              <button onClick={() => deleteField(idx)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                <i className="ti ti-x" style={{ fontSize: 10 }} />
              </button>
            </div>
          ))}
        </div>
      )}

      {schema.length > 0 && (
        <div style={{ padding: '5px 8px', background: '#1a2030', borderRadius: 4,
          border: '0.5px solid #2a3349', fontSize: 9, color: '#4a5a7a', display: 'flex', gap: 5 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 10, color, flexShrink: 0 }} />
          Propagato automaticamente ai TMap e agli altri nodi collegati all'output.
        </div>
      )}
    </div>
  )
}
