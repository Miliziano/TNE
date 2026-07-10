/**
 * src/nodes/types/union/MappingPanel.tsx
 *
 * Schema di uscita di Union — deciso a DESIGN-TIME.
 *
 * Il pannello calcola l'unione degli schemi in ingresso e salva una
 * MAPPATURA ESPLICITA in props['unionMapping']:
 *
 *   [{ name: "id", type: "integer",
 *      from: { input_main: "id", union_input_x: "id" } }, …]
 *
 * `from` dice, per ogni handle, da quale campo di QUEL flusso prendere il
 * valore. Un handle assente → null nella riga di uscita.
 *
 * Il motore applica la mappatura meccanicamente: nessuna inferenza sui
 * tipi, nessun campionamento dei valori. Deterministico, e traducibile
 * dal codegen.
 *
 * Regole di fusione:
 *   stesso nome + stesso tipo   → un'unica colonna (fusi)
 *   stesso nome + tipo diverso  → il secondo rinominato (`codice_2`)
 *   nome in un solo flusso      → colonna propria, null negli altri
 *
 * L'utente può SEPARARE due campi fusi rinominandone uno.
 */
import { useMemo, useEffect, useState, useCallback } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { getHandleSchema } from '../../../utils/schemaRegistry'

const ACCENT = '#a78bfa'

const HANDLE_COLORS: Record<string, string> = { input_main: '#4a9eff' }
const EXTRA_COLORS = ['#3ddc84','#a78bfa','#ffb347','#22d3ee','#f97316','#ff5f57','#84cc16']

function handleColor(handle: string, idx: number): string {
  return HANDLE_COLORS[handle] ?? EXTRA_COLORS[idx % EXTRA_COLORS.length]
}

/** Un campo dello schema unificato, con la sua provenienza. */
interface UnionField {
  name: string
  type: string
  /** handle → nome del campo in quel flusso */
  from: Record<string, string>
}

/** Rinomine decise dall'utente: "handle::campoOriginale" → nuovoNome */
type Overrides = Record<string, string>

export function UnionMappingPanel({ nodeId }: { nodeId: string }) {
  const edges      = useFlowStore((s) => s.edges)
  const nodes      = useFlowStore((s) => s.nodes)
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))

  // Rinomine persistite
  const overrides: Overrides = useMemo(() => {
    try { return JSON.parse((node?.data.props?.['unionOverrides'] as string) ?? '{}') }
    catch { return {} }
  }, [node?.data.props?.['unionOverrides']])

  const [editing, setEditing] = useState<string | null>(null)
  const [draft,   setDraft]   = useState('')

  // ── Ordine degli handle: input_main, poi i dinamici nell'ordine
  //    dichiarato in config.unionInputs (lo stesso che usa l'executor).
  const orderedHandles = useMemo(() => {
    const extra = ((node?.data.config as any)?.unionInputs ?? []) as Array<{ id: string; label: string }>
    const connected = new Set(edges.filter((e) => e.target === nodeId).map((e) => e.targetHandle))
    const out: Array<{ handle: string; label: string }> = []
    if (connected.has('input_main')) out.push({ handle: 'input_main', label: 'flusso 1' })
    for (const inp of extra) {
      if (connected.has(inp.id)) out.push({ handle: inp.id, label: inp.label })
    }
    // handle collegati ma non dichiarati (robustezza)
    for (const e of edges.filter((e) => e.target === nodeId)) {
      const h = e.targetHandle
      if (h && !out.some((o) => o.handle === h)) out.push({ handle: h, label: h })
    }
    return out
  }, [edges, nodes, nodeId, node?.data.config])

  // ── Schema unificato + mappatura ─────────────────────────────────
  const { fields, sources } = useMemo(() => {
    const sources: Array<{ handle: string; label: string; count: number; color: string }> = []
    const fields:  UnionField[] = []

    // "nome::tipo" → indice del campo già creato (per fondere)
    const byKey     = new Map<string, number>()
    // nomi finali già usati (per evitare collisioni nella rinomina)
    const usedNames = new Set<string>()

    for (const [idx, { handle, label }] of orderedHandles.entries()) {
      const edge = edges.find((e) => e.target === nodeId && e.targetHandle === handle)
      const src  = edge && nodes.find((n) => n.id === edge.source)
      if (!edge || !src) continue

      const schema = getHandleSchema(src, edge.sourceHandle ?? 'output', false)
      sources.push({ handle, label, count: schema.length, color: handleColor(handle, idx) })

      for (const f of schema) {
        if (!f.name) continue
        const type = f.type ?? 'string'
        const key  = `${f.name}::${type}`

        // Rinomina esplicita dell'utente → campo separato
        const override = overrides[`${handle}::${f.name}`]
        if (override) {
          fields.push({ name: override, type, from: { [handle]: f.name } })
          usedNames.add(override)
          continue
        }

        // Fusione: stesso nome E stesso tipo
        const existing = byKey.get(key)
        if (existing !== undefined) {
          fields[existing].from[handle] = f.name
          continue
        }

        // Nome già usato con tipo diverso → suffisso automatico
        let finalName = f.name
        if (usedNames.has(finalName)) {
          finalName = `${f.name}_${idx + 1}`
          let i = 2
          while (usedNames.has(finalName)) finalName = `${f.name}_${idx + 1}_${i++}`
        }

        byKey.set(key, fields.length)
        usedNames.add(finalName)
        fields.push({ name: finalName, type, from: { [handle]: f.name } })
      }
    }

    return { fields, sources }
  }, [edges, nodes, nodeId, orderedHandles, overrides])

  // ── Salva la mappatura per il motore ─────────────────────────────
  // Il nodo Rust legge props['unionMapping']. Senza, passa le righe
  // invariate con un warning (lo schema non sarebbe unificato).
  useEffect(() => {
    const serialized = JSON.stringify(fields)
    if ((node?.data.props?.['unionMapping'] as string) !== serialized) {
      updateProp(nodeId, 'unionMapping', serialized)
    }
  }, [fields, nodeId, updateProp, node?.data.props?.['unionMapping']])

  // ── Rinomina ─────────────────────────────────────────────────────
  const startRename = useCallback((f: UnionField) => {
    // Si rinomina la provenienza: se il campo è fuso da più flussi,
    // separa l'ULTIMO (gli altri restano fusi sul nome originale).
    const handles = Object.keys(f.from)
    const target  = handles[handles.length - 1]
    setEditing(`${target}::${f.from[target]}`)
    setDraft(f.name)
  }, [])

  const commitRename = useCallback(() => {
    if (!editing) return
    const next = { ...overrides }
    const name = draft.trim()
    if (!name) delete next[editing]
    else       next[editing] = name
    updateProp(nodeId, 'unionOverrides', JSON.stringify(next))
    setEditing(null)
  }, [editing, draft, overrides, nodeId, updateProp])

  const clearRename = useCallback((f: UnionField) => {
    const next = { ...overrides }
    for (const h of Object.keys(f.from)) delete next[`${h}::${f.from[h]}`]
    updateProp(nodeId, 'unionOverrides', JSON.stringify(next))
  }, [overrides, nodeId, updateProp])

  const box: React.CSSProperties = {
    display: 'flex', alignItems: 'center', gap: 8, padding: '5px 10px',
    background: '#1a2030', borderRadius: 4,
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>

      <div style={{ padding: '8px 12px', background: `color-mix(in srgb, ${ACCENT} 8%, #0f1117)`,
                    borderRadius: 6, border: `0.5px solid ${ACCENT}30`, fontSize: 10,
                    color: '#9a9aaa', lineHeight: 1.5 }}>
        <span style={{ color: ACCENT, fontWeight: 600 }}>⊕ Union</span> — schema unificato.
        I campi con <b>stesso nome e stesso tipo</b> si fondono in una colonna sola.
        Un campo presente in un solo flusso avrà <code>null</code> nelle righe degli altri.
        Clicca il nome per <b>rinominarlo</b> e tenerlo separato.
      </div>

      {sources.length > 0 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {sources.map((s) => (
            <div key={s.handle} style={{ fontSize: 10, padding: '2px 10px', borderRadius: 8,
                  background: `color-mix(in srgb, ${s.color} 10%, #0f1117)`,
                  color: s.color, border: `0.5px solid ${s.color}40` }}>
              {s.label} — {s.count} campi
            </div>
          ))}
        </div>
      )}

      <div style={{ fontSize: 10, fontWeight: 600, color: ACCENT, textTransform: 'uppercase',
                    letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${ACCENT}30` }}>
        Campi in uscita — {fields.length}
      </div>

      {fields.length === 0 ? (
        <div style={{ padding: 20, textAlign: 'center', color: '#4a5a7a', fontSize: 11,
                      background: '#1a2030', borderRadius: 6, border: '1px dashed #2a3349' }}>
          <i className="ti ti-plug-connected-x" style={{ fontSize: 24, display: 'block', marginBottom: 8 }} />
          Collega almeno un flusso agli handle sul lato sinistro del nodo.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          {fields.map((f) => {
            const handles  = Object.keys(f.from)
            const shared   = handles.length > 1
            const idx      = orderedHandles.findIndex((o) => o.handle === handles[0])
            const color    = shared ? '#3ddc84' : handleColor(handles[0], Math.max(0, idx))
            const renamed  = handles.some((h) => overrides[`${h}::${f.from[h]}`])
            const editKey  = `${handles[handles.length - 1]}::${f.from[handles[handles.length - 1]]}`
            const isEditing = editing === editKey

            return (
              <div key={f.name} style={{ ...box, border: `0.5px solid ${shared ? '#3ddc8430' : '#2a3349'}` }}>
                <div style={{ width: 6, height: 6, borderRadius: '50%', background: color, flexShrink: 0 }} />

                {isEditing ? (
                  <input
                    autoFocus
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    onBlur={commitRename}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename()
                      if (e.key === 'Escape') setEditing(null)
                    }}
                    style={{ flex: 1, fontFamily: 'monospace', fontSize: 11, color: '#c8d4f0',
                             background: '#0f1117', border: `1px solid ${ACCENT}`,
                             borderRadius: 3, padding: '2px 6px' }} />
                ) : (
                  <code onClick={() => startRename(f)}
                        title="Clicca per rinominare (separa il campo dai fusi)"
                        style={{ fontFamily: 'monospace', fontSize: 11, color, flex: 1, cursor: 'pointer' }}>
                    {f.name}
                  </code>
                )}

                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6,
                               background: '#0f1117', color: '#4a5a7a', flexShrink: 0 }}>{f.type}</span>

                {shared && (
                  <span title={handles.map((h) => `${h} → ${f.from[h]}`).join('\n')}
                        style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, background: '#0d3d20',
                                 color: '#3ddc84', border: '0.5px solid #1d6d40', flexShrink: 0 }}>
                    fusi ({handles.length})
                  </span>
                )}

                {renamed && (
                  <button onClick={() => clearRename(f)} title="Annulla rinomina"
                          style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, cursor: 'pointer',
                                   background: `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`,
                                   color: ACCENT, border: `0.5px solid ${ACCENT}40`, flexShrink: 0 }}>
                    rinominato ✕
                  </button>
                )}
              </div>
            )
          })}
        </div>
      )}

      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 6,
                    border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a' }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span style={{ fontSize: 9, padding: '1px 8px', borderRadius: 8,
                         background: `color-mix(in srgb, ${ACCENT} 15%, #0f1117)`,
                         color: ACCENT, border: `0.5px solid ${ACCENT}40` }}>output</span>
          <span style={{ fontSize: 9 }}>Flusso unificato — {fields.length} campi</span>
        </div>
      </div>

    </div>
  )
}