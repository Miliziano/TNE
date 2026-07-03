import { useCallback, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { propagateSchema, scriptFieldsToSchema } from '../../../utils/schemaUtils'
import { CustomSelect } from '../../../components/CustomSelect'



// ─── Stili ────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}

import { FIELD_TYPES } from '../../../types/fieldTypes'

// ─── Tipi ─────────────────────────────────────────────────────────
interface OutputField {
  id:   string
  name: string
  type: string
}

// ─── ScriptMappingPanel ───────────────────────────────────────────
export function ScriptMappingPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const edges      = useFlowStore((s) => s.edges)

  if (!node) return null

  const p = (key: string) => node.data.props[key] ?? ''
  const hasReject = p('hasReject') === 'true'

  // ── Campi output (flusso main) ────────────────────────────────
  const outputFields: OutputField[] = useMemo(() => {
    try { return JSON.parse(p('outputFields')) } catch { return [] }
  }, [p('outputFields')])

  // ── Campi reject — stessi nomi, id distinti ───────────────────
  const rejectFields: OutputField[] = useMemo(() => {
    try { return JSON.parse(p('rejectFields')) } catch { return [] }
  }, [p('rejectFields')])

  // ── Salva entrambi i flussi in sync ──────────────────────────
  // Quando aggiungo/rimuovo un campo, agisce su entrambi
  // i flussi simultaneamente con id separati
  const saveFields = useCallback((mainFields: OutputField[]) => {
    // Calcola i campi reject corrispondenti
    // Mantieni i campi reject esistenti per nome, aggiungi/rimuovi in sync
    const newRejectFields: OutputField[] = mainFields.map((mf) => {
      // Cerca campo reject esistente con stesso nome
      const existing = rejectFields.find((rf) => rf.name === mf.name)
      return existing ?? { id: `rf_${mf.id}`, name: mf.name, type: mf.type }
    })

    // Aggiorna props
    updateProp(nodeId, 'outputFields', JSON.stringify(mainFields))
    updateProp(nodeId, 'rejectFields', JSON.stringify(newRejectFields))

    // Aggiorna outputSchema (flusso main) e propaga
    const schemaFields = scriptFieldsToSchema(mainFields)
    updateProp(nodeId, 'outputSchema', JSON.stringify(schemaFields))
    propagateSchema(nodeId, schemaFields, useFlowStore.getState())

    // Aggiorna rejectSchema e propaga sul flusso reject
    const rejectSchemaFields = scriptFieldsToSchema(newRejectFields)
    updateProp(nodeId, 'rejectSchema', JSON.stringify(rejectSchemaFields))
    propagateSchema(nodeId, rejectSchemaFields, useFlowStore.getState(), ['main'])
  }, [nodeId, updateProp, rejectFields])

  // Quando cambia solo il tipo di un campo, aggiorna anche il reject
  const updateFieldType = useCallback((id: string, newType: string) => {
    const updated = outputFields.map((f) => f.id === id ? { ...f, type: newType } : f)
    saveFields(updated)
  }, [outputFields, saveFields])

  const updateFieldName = useCallback((id: string, newName: string) => {
    const updated = outputFields.map((f) => f.id === id ? { ...f, name: newName } : f)
    // Per il rename aggiorniamo solo main — reject mantiene il vecchio nome finché non si salva
    const updatedReject = rejectFields.map((rf) => {
      const main = updated.find((mf) => mf.id === id || `rf_${mf.id}` === rf.id)
      return main ? { ...rf, name: main.name } : rf
    })
    updateProp(nodeId, 'outputFields', JSON.stringify(updated))
    updateProp(nodeId, 'rejectFields', JSON.stringify(updatedReject))
    const schemaFields = scriptFieldsToSchema(updated)
    updateProp(nodeId, 'outputSchema', JSON.stringify(schemaFields))
    propagateSchema(nodeId, schemaFields, useFlowStore.getState())
    const rejectSchemaFields = scriptFieldsToSchema(updatedReject)
    updateProp(nodeId, 'rejectSchema', JSON.stringify(rejectSchemaFields))
    propagateSchema(nodeId, rejectSchemaFields, useFlowStore.getState(), ['main'])
  }, [nodeId, updateProp, outputFields, rejectFields])

  const addField = useCallback(() => {
    const n    = outputFields.length + 1
    const name = `campo_${n}`
    saveFields([...outputFields, { id: `of_${n}`, name, type: 'string' }])
  }, [outputFields, saveFields])

  const deleteField = useCallback((id: string) => {
    saveFields(outputFields.filter((f) => f.id !== id))
  }, [outputFields, saveFields])

  // ── Edge in uscita per info ───────────────────────────────────
  const mainEdges   = edges.filter((e) => e.source === nodeId && e.sourceHandle !== 'reject')
  const rejectEdges = edges.filter((e) => e.source === nodeId && e.sourceHandle === 'reject')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      {/* ══ SCHEMA OUTPUT (flusso main) ════════════════════════ */}
      <div style={{ background: '#161b27', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>

        {/* Header */}
        <div style={{ padding: '8px 12px', background: '#1a2030', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: '#4a9eff', flexShrink: 0 }} />
          <div style={{ fontSize: 11, fontWeight: 600, color: '#4a9eff', flex: 1 }}>
            Flusso principale — out
          </div>
          <div style={{ fontSize: 10, color: '#4a5a7a' }}>
            {mainEdges.length > 0
              ? `→ ${mainEdges.map((e) => e.target).join(', ')}`
              : 'nessun collegamento'}
          </div>
          <button onClick={addField}
            style={{ background: 'none', border: '0.5px dashed #2a3349', borderRadius: 4, padding: '2px 8px', fontSize: 9, cursor: 'pointer', color: '#4a9eff' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
            <i className="ti ti-plus" style={{ fontSize: 9 }} /> campo
          </button>
        </div>

        {/* Lista campi */}
        {outputFields.length === 0 ? (
          <div style={{ padding: '16px 12px', fontSize: 10, color: '#2a3349', fontStyle: 'italic', textAlign: 'center' }}>
            Nessun campo definito — clicca + campo per aggiungere
          </div>
        ) : (
          <div style={{ padding: '6px 0' }}>
            {/* Intestazione colonne */}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 80px 24px', gap: 6, padding: '3px 12px 5px', borderBottom: '0.5px solid #2a3349' }}>
              {['Nome', 'Tipo', ''].map((h, i) => (
                <div key={i} style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', fontWeight: 600 }}>{h}</div>
              ))}
            </div>
            {outputFields.map((f) => (
              <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px 24px', gap: 6, alignItems: 'center', padding: '4px 12px', background: 'transparent' }}
                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030' }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                <input value={f.name}
                  onChange={(e) => updateFieldName(f.id, e.target.value)}
                  style={{ ...inputStyle, fontSize: 10, padding: '3px 6px' }}
                  placeholder="nome campo" />
                <CustomSelect value={f.type}
                  onChange={(e) => updateFieldType(f.id, e.target.value)}
                  style={{ ...inputStyle, fontSize: 10, padding: '3px 4px' }}>
                  {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                </CustomSelect>
                <button onClick={() => deleteField(f.id)}
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                  <i className="ti ti-x" style={{ fontSize: 10 }} />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* ══ FLUSSO REJECT ══════════════════════════════════════ */}
      <div style={{ background: '#161b27', border: `1px solid ${hasReject ? '#3a1a1a' : '#2a3349'}`, borderRadius: 8, overflow: 'hidden', transition: 'border-color .2s' }}>

        {/* Header con toggle */}
        <div style={{ padding: '8px 12px', background: hasReject ? '#1a0a0a' : '#1a2030', borderBottom: `1px solid ${hasReject ? '#3a1a1a' : '#2a3349'}`, display: 'flex', alignItems: 'center', gap: 8, transition: 'all .2s' }}>
          {/* Toggle */}
          <button
            onClick={() => updateProp(nodeId, 'hasReject', hasReject ? 'false' : 'true')}
            style={{ width: 32, height: 16, borderRadius: 8, border: 'none', cursor: 'pointer', background: hasReject ? '#ff5f57' : '#2a3349', position: 'relative', flexShrink: 0, transition: 'background .2s' }}>
            <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: hasReject ? 16 : 2, transition: 'left .2s' }} />
          </button>
          <div style={{ width: 8, height: 8, borderRadius: '50%', background: hasReject ? '#ff5f57' : '#2a3349', flexShrink: 0, transition: 'background .2s' }} />
          <div style={{ fontSize: 11, fontWeight: 600, color: hasReject ? '#ff5f57' : '#4a5a7a', flex: 1, transition: 'color .2s' }}>
            Flusso reject — reject
          </div>
          <div style={{ fontSize: 10, color: '#4a5a7a' }}>
            {rejectEdges.length > 0
              ? `→ ${rejectEdges.map((e) => e.target).join(', ')}`
              : hasReject ? 'handle attivo, nessun collegamento' : 'disabilitato'}
          </div>
        </div>

        {/* Campi reject (sola lettura — in sync con main) */}
        {hasReject && (
          rejectFields.length === 0 ? (
            <div style={{ padding: '16px 12px', fontSize: 10, color: '#2a3349', fontStyle: 'italic', textAlign: 'center' }}>
              Aggiungi campi al flusso principale — il reject usa gli stessi nomi
            </div>
          ) : (
            <div style={{ padding: '6px 0' }}>
              <div style={{ padding: '4px 12px 5px', fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', borderBottom: '0.5px solid #2a3349' }}>
                Stessi campi del flusso principale — istanze indipendenti con valori distinti
              </div>
              {rejectFields.map((f) => (
                <div key={f.id} style={{ display: 'grid', gridTemplateColumns: '1fr 80px', gap: 6, alignItems: 'center', padding: '4px 12px' }}>
                  <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#ff5f57', padding: '3px 6px', background: '#1a0a0a', borderRadius: 4, border: '0.5px solid #3a1a1a' }}>
                    reject.{f.name}
                  </div>
                  <div style={{ fontSize: 9, color: '#4a5a7a', padding: '3px 4px', background: '#1a0a0a', borderRadius: 4, border: '0.5px solid #3a1a1a', textAlign: 'center' }}>
                    {f.type}
                  </div>
                </div>
              ))}
            </div>
          )
        )}

        {!hasReject && (
          <div style={{ padding: '12px', fontSize: 10, color: '#2a3349', fontStyle: 'italic', textAlign: 'center' }}>
            Attiva il toggle per abilitare il flusso reject e mostrare l'handle sul nodo
          </div>
        )}
      </div>

      {/* ══ INFO PROPAGAZIONE ══════════════════════════════════ */}
      {outputFields.length > 0 && (
        <div style={{ padding: '6px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', display: 'flex', alignItems: 'flex-start', gap: 5 }}>
          <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
          I campi vengono propagati automaticamente ai nodi collegati.
          Flusso <strong style={{ color: '#4a9eff' }}>out</strong> sull'handle principale,
          flusso <strong style={{ color: '#ff5f57' }}>reject</strong> sull'handle reject.
          I due flussi condividono i nomi dei campi ma hanno valori indipendenti.
        </div>
      )}

    </div>
  )
}