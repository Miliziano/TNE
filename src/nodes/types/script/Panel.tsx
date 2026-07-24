import { useState, useCallback, useMemo, useEffect, useRef } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { getTemplates } from './templates'
import { parseScript, campiAssegnati } from '../../../ir/scriptParser'
import { ScriptEditor, type SchemaField, type ContextVar } from '../../../components/ScriptEditor'
import { getTransformsForType, type TransformCategory } from '../../../transforms/catalog'
import { scriptFieldsToSchema, propagateSchema } from '../../../utils/schemaUtils'
import { CustomSelect } from '../../../components/CustomSelect'
import { getHandleSchema } from '../../../utils/schemaRegistry'

// ─── Come si scrive un riferimento nel linguaggio di FlowPilot ────
// Erano cinque funzioni con dentro uno `switch (lang)` su quattro
// linguaggi. Ora il linguaggio è uno solo e i riferimenti sono nudi: un
// campo si chiama col suo nome, sia in lettura sia in scrittura. Restano
// funzioni (invece di sparire) perché i pannelli le usano per costruire
// i chip cliccabili che inseriscono testo nell'editor.

/**
 * Chiave in `MONACO_LANG` (ScriptEditor): il linguaggio dello Script usa
 * la grammatica di Rust per l'evidenziazione, senza analisi semantica.
 */
const EDITOR_LANG = 'flowpilot'

/** Campo della riga in ingresso: si legge col suo nome. */
function inputPattern(fieldName: string): string { return fieldName }

/** Campo in uscita: si scrive col suo nome — l'assegnazione lo crea. */
function outVarPattern(fieldName: string): string { return fieldName }

/** Campo sulla riga scartata: è la stessa riga, stessi nomi. */
function rejectVarPattern(fieldName: string): string { return fieldName }

/** Variabile di lane: unica forma che richiede una chiamata. */
function laneVarPattern(varName: string): string { return `var("${varName}")` }


function applyTransformExpression(expression: string, varName: string): string {
  return expression
    .replace(/\$value/g, varName)
    .replace(/\$param_\w+/g, '""')
}

// ─── Stili ────────────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function GridRow({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

// ─── SmartPill ────────────────────────────────────────────────────
function SmartPill({ label, color, type, varName, onInsert, onWrap }: {
  label:    string
  color:    string
  type:     string
  varName:  string
  onInsert: (text: string) => void
  onWrap:   (expr: string) => void
}) {
  const [open, setOpen] = useState(false)
  const ref             = useRef<HTMLDivElement>(null)
  const transforms      = useMemo(() => getTransformsForType(type as TransformCategory).slice(0, 12), [type])

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  return (
    <div ref={ref} style={{ position: 'relative', flexShrink: 0 }}>
      <div style={{ display: 'flex', alignItems: 'center', borderRadius: 10, overflow: 'hidden', border: `1px solid ${open ? color : '#2a3349'}`, transition: 'border-color .1s' }}>
        <button
          onClick={() => { onInsert(varName); setOpen(false) }}
          title={`Inserisci ${varName} (${type})`}
          style={{ padding: '2px 6px 2px 8px', background: open ? `color-mix(in srgb, ${color} 15%, #161b27)` : '#0f1117', border: 'none', color: open ? color : '#9a9aaa', cursor: 'pointer', fontFamily: 'monospace', fontSize: 9, transition: 'all .1s' }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color; (e.currentTarget as HTMLElement).style.background = `color-mix(in srgb, ${color} 10%, #161b27)` }}
          onMouseLeave={(e) => { if (!open) { (e.currentTarget as HTMLElement).style.color = '#9a9aaa'; (e.currentTarget as HTMLElement).style.background = '#0f1117' } }}>
          {label}
        </button>
        {transforms.length > 0 && (
          <button
            onClick={() => setOpen((v) => !v)}
            title="Trasformazioni disponibili"
            style={{ padding: '2px 5px 2px 3px', background: open ? `color-mix(in srgb, ${color} 20%, #161b27)` : '#161b27', border: 'none', borderLeft: '1px solid #2a3349', color: open ? color : '#4a5a7a', cursor: 'pointer', fontSize: 9, transition: 'all .1s' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
            onMouseLeave={(e) => { if (!open) (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            ▾
          </button>
        )}
      </div>

      {open && (
        <div style={{ position: 'absolute', top: '100%', left: 0, zIndex: 200, background: '#1a2030', border: `1px solid ${color}`, borderRadius: 6, marginTop: 3, minWidth: 220, maxWidth: 300, boxShadow: '0 8px 24px rgba(0,0,0,.6)', overflow: 'hidden' }}>
          <div style={{ padding: '5px 10px', background: `color-mix(in srgb, ${color} 10%, #161b27)`, borderBottom: '1px solid #2a3349' }}>
            <span style={{ fontSize: 9, color, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em' }}>trasformazioni · {type}</span>
          </div>
          <div onClick={() => { onInsert(varName); setOpen(false) }}
            style={{ padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid #2a3349' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a3349' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
            <span style={{ fontSize: 9, color: '#4a5a7a' }}>📋</span>
            <code style={{ fontSize: 9, color }}>{varName}</code>
            <span style={{ fontSize: 9, color: '#4a5a7a', marginLeft: 'auto' }}>inserisci</span>
          </div>
          <div onClick={() => { onWrap(varName); setOpen(false) }}
            style={{ padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, borderBottom: '1px solid #2a3349' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a3349' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
            <span style={{ fontSize: 9, color: '#4a5a7a' }}>⬡</span>
            <span style={{ fontSize: 9, color: '#9a9aaa' }}>wrap selezione nell'editor</span>
          </div>
          <div style={{ maxHeight: 200, overflowY: 'auto' }}>
            {transforms.map((t) => {
              const expr = applyTransformExpression(t.expression, varName)
              return (
                <div key={t.id} onClick={() => { onInsert(expr); setOpen(false) }}
                  style={{ padding: '5px 10px', cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 6 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a3349' }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                  <span style={{ fontSize: 9, color: '#a78bfa', flexShrink: 0 }}>⚡</span>
                  <span style={{ fontSize: 10, color: '#c8d4f0', flexShrink: 0, minWidth: 80 }}>{t.label}</span>
                  <code style={{ fontSize: 9, color: '#4a5a7a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>{expr}</code>
                  {t.outputType && t.outputType !== type && (
                    <span style={{ fontSize: 9, color: '#ffb347', flexShrink: 0, marginLeft: 4 }}>→ {t.outputType}</span>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

// ─── ScriptPanel ─────────────────────────────────────────────────
export function ScriptPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const edges      = useFlowStore((s) => s.edges)
  const nodes      = useFlowStore((s) => s.nodes)
  const pool       = useFlowStore((s) => s.pool)

  const [showAdvanced, setShowAdvanced] = useState(false)
  const [snippet,      setSnippet]      = useState<string | undefined>(undefined)
  const [wrap,         setWrap]         = useState<string | undefined>(undefined)

  if (!node) return null

  const p = (key: string) => node.data.props[key] ?? ''
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  // `sourceMode` decide la NATURA del nodo: trasforma righe che riceve,
  // oppure le genera lui. In "genera" la porta d'ingresso non esiste
  // proprio (contratto porte), quindi la differenza si vede sul canvas.
  const sourceMode = p('sourceMode') || 'flusso'
  const hasReject  = p('hasReject') === 'true'
  // Cosa esce verso il nodo a valle. Stesso vocabolario dei sink.
  // Default 'passthrough' = il comportamento di sempre: dallo script
  // escono righe. Va DICHIARATO perché chi sta a valle deve sapere se
  // aspettarsi campi o solo il "via": prima lo studio tirava a indovinare
  // e segnalava campi mancanti su flussi corretti.
  const outputMode = p('outputMode') || 'passthrough'

  // ── Schema input ─────────────────────────────────────────────
  const schema: SchemaField[] = useMemo(() => {
    const inEdge  = edges.find((e) => e.target === nodeId)
    if (!inEdge) return []
    const srcNode = nodes.find((n) => n.id === inEdge.source)
    if (!srcNode) return []
    const fields = getHandleSchema(srcNode, inEdge.sourceHandle ?? 'output', false)
    return fields.map((f) => ({ id: f.id, name: f.name, type: f.type }))
  }, [edges, nodes, nodeId])

  // ── Campi output (per le pill) ────────────────────────────────
  const outputFields = useMemo(() => {
    try { return JSON.parse(p('outputFields')) as Array<{ id: string; name: string; type: string }> }
    catch { return [] }
  }, [p('outputFields')])

  // ── Variabili lane e pool ─────────────────────────────────────
  const laneVars: ContextVar[] = useMemo(() =>
    (pool.lanes.find((l) => l.id === node.data.laneId)?.variables ?? [])
      .map((v) => ({ name: v.name, type: v.type })),
    [pool, node.data.laneId]
  )

  const poolVars: ContextVar[] = useMemo(() =>
    pool.variables.map((v) => ({ name: v.name, type: v.type })),
    [pool]
  )

  // ── Propaga quando cambiano le edge in uscita ─────────────────
  const outputFieldsRef = useRef(outputFields)
  outputFieldsRef.current = outputFields

  const outEdgeKey = edges
    .filter((e) => e.source === nodeId && e.sourceHandle !== 'reject')
    .map((e) => `${e.target}:${e.targetHandle ?? 'null'}`)
    .sort()
    .join('|')

  useEffect(() => {
    const fields = outputFieldsRef.current
    if (fields.length === 0 || !outEdgeKey) return
    const schemaFields = scriptFieldsToSchema(fields)
    propagateSchema(nodeId, schemaFields, useFlowStore.getState())
  }, [outEdgeKey, nodeId])

  // ── I campi in uscita si DERIVANO dal codice ──────────────────
  // Prima andavano dichiarati a mano nel pannello di mapping: un elenco
  // che diceva "questo Script produce X, Y, Z" senza che nessuno lo
  // verificasse contro il codice. Due verità sullo stesso fatto, e quella
  // scritta a mano è la prima a invecchiare — chi aggiunge un campo nel
  // corpo e non aggiorna l'elenco vede il campo nel JSON del log ma non
  // nel mapping a valle.
  // Ora l'elenco lo produce il corpo: `campiAssegnati` legge le
  // assegnazioni (anche dentro if, repeat e for; i `let` no, non sono
  // campi). In modalità "flusso" la riga passa con i suoi campi più
  // quelli nuovi; da "genera" ci sono solo i nuovi.
  const schemaKey = JSON.stringify(schema)
  useEffect(() => {
    let campi: string[]
    try {
      campi = campiAssegnati(parseScript(p('code') ?? ''))
    } catch {
      // Codice incompleto mentre si scrive: non si tocca niente. Meglio
      // un elenco vecchio di un elenco che sfarfalla a ogni carattere.
      return
    }

    const attuali = outputFieldsRef.current
    const base    = (p('sourceMode') || 'flusso') === 'genera' ? [] : schema
    const nomi    = [...base.map((f) => f.name), ...campi.filter((c) => !base.some((f) => f.name === c))]

    // Il tipo scelto a mano nel pannello di mapping si conserva: il codice
    // dice QUALI campi escono, non di che tipo sono (v. il commento in
    // schemaPropagation: i tipi di ritorno delle funzioni non esistono
    // ancora nel catalogo FPEL).
    const nuovi = nomi.map((nome) => {
      const esistente = attuali.find((f) => f.name === nome)
      if (esistente) return esistente
      const daMonte = base.find((f) => f.name === nome)
      return { id: `sf_${nome}`, name: nome, type: daMonte?.type ?? 'any' }
    })

    const invariato = nuovi.length === attuali.length &&
      nuovi.every((f, i) => f.name === attuali[i].name && f.type === attuali[i].type)
    if (invariato) return

    updateProp(nodeId, 'outputFields', JSON.stringify(nuovi))
    updateProp(nodeId, 'rejectFields', JSON.stringify(
      nuovi.map((f) => ({ ...f, id: `rf_${f.id}` }))))
    propagateSchema(nodeId, scriptFieldsToSchema(nuovi), useFlowStore.getState())
  }, [p('code'), p('sourceMode'), schemaKey, nodeId, updateProp])

  // ── Propaga rename campi input nel codice ─────────────────────
  const prevSchemaRef = useRef<SchemaField[]>([])
  useEffect(() => {
    const prev = prevSchemaRef.current
    const curr = schema
    if (prev.length > 0 && curr.length > 0) {
      const code = node.data.props['code'] ?? ''
      if (code) {
        let newCode = code
        prev.forEach((oldField) => {
          if (!oldField.id) return
          const newField = curr.find((f) => f.id === oldField.id)
          if (!newField || newField.name === oldField.name) return
          newCode = newCode
            .split(`row.${oldField.name}`).join(`row.${newField.name}`)
            .split(`row['${oldField.name}']`).join(`row['${newField.name}']`)
            .split(`row["${oldField.name}"]`).join(`row["${newField.name}"]`)
            .split(`row.get('${oldField.name}')`).join(`row.get('${newField.name}')`)
            .split(`row.get("${oldField.name}")`).join(`row.get("${newField.name}")`)
        })
        prev.forEach((oldField) => {
          if (!oldField.id) return
          if (curr.some((f) => f.id === oldField.id)) return
          const marker = ` /* ⚠ '${oldField.name}' rimosso */`
          newCode = newCode
            .split(`row.${oldField.name}`).join(`row.${oldField.name}${marker}`)
            .split(`row['${oldField.name}']`).join(`row['${oldField.name}']${marker}`)
        })
        if (newCode !== code) updateProp(nodeId, 'code', newCode)
      }
    }
    prevSchemaRef.current = curr
  }, [schema])

  const handleCodeChange = useCallback((newCode: string) => {
    updateProp(nodeId, 'code', newCode)
  }, [nodeId, updateProp])

  const insertSnippet = useCallback((text: string) => setSnippet(text), [])
  const wrapSelection = useCallback((expr: string) => setWrap(expr), [])

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ══ SEZ 1 — NATURA DEL NODO E USCITA ═══════════════════ */}
      {/* Qui c'era anche un selettore "Modalità: Transform | Emit" che
          NESSUNO leggeva — né il motore, né il builder, né il contratto
          porte: due bottoni che scrivevano una prop inerte. Con questo
          linguaggio non serve più nemmeno come idea: `emit` è
          un'istruzione, quindi 1→N si ottiene scrivendolo, non
          dichiarandolo. E c'era una barra "Linguaggio" con TypeScript,
          Python e Java: nessuno dei tre è mai stato eseguito. */}
      <div style={{ background: '#161b27', border: '1px solid #2a3349', borderRadius: 8, overflow: 'hidden' }}>

        <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a3349' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Sorgente delle righe</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { value: 'flusso', label: 'Dal flusso', icon: 'ti-arrow-right',
                desc: 'una passata per riga' },
              { value: 'genera', label: 'Genera',     icon: 'ti-sparkles',
                desc: 'nessun ingresso, una passata sola' },
            ].map((m) => (
              <button key={m.value} onClick={() => updateProp(nodeId, 'sourceMode', m.value)}
                style={{
                  flex: 1, padding: '7px 10px', borderRadius: 6, cursor: 'pointer',
                  background: sourceMode === m.value ? '#1a3a6a' : '#1a2030',
                  border:     sourceMode === m.value ? '1px solid #2a5a9a' : '1px solid #2a3349',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className={`ti ${m.icon}`} style={{ fontSize: 13, color: sourceMode === m.value ? '#4a9eff' : '#4a5a7a' }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: sourceMode === m.value ? '#4a9eff' : '#4a5a7a' }}>{m.label}</span>
                </div>
                <span style={{ fontSize: 9, color: sourceMode === m.value ? '#7a9aaa' : '#2a3349' }}>{m.desc}</span>
              </button>
            ))}
          </div>
          <div style={{ marginTop: 6, fontSize: 9, lineHeight: 1.5, color: '#6a7a9a' }}>
            {sourceMode === 'genera'
              ? <>La porta d'ingresso <b>sparisce dal canvas</b>: il corpo gira una volta sola e le righe escono <b>solo</b> dalle <code>emit</code>. Senza <code>emit</code> non esce niente.</>
              : <>Il corpo gira <b>una volta per ogni riga</b> in arrivo. A fine corpo la riga esce anche senza <code>emit</code>; <code>skip</code> la trattiene, <code>emit</code> ne aggiunge altre.</>}
          </div>
        </div>

        <div style={{ padding: '8px 12px', borderBottom: '1px solid #2a3349' }}>
          <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.08em', marginBottom: 6 }}>Uscita verso valle</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {[
              { value: 'passthrough', label: 'Dati',    icon: 'ti-table-row',    desc: 'righe elaborate', pronto: true  },
              // «Innesco» cambia la porta sul canvas ma il motore continua
              // a mandare righe: lo Script non sa ancora emettere un
              // segnale né scrivere variabili di lane (è la fetta 3 del
              // disegno). Offrirlo funzionante sarebbe una promessa non
              // mantenuta — meglio dichiararlo indisponibile, come si è
              // fatto per il match sul codice errore nell'error handler.
              { value: 'signal',      label: 'Innesco', icon: 'ti-bolt',         desc: 'non ancora disponibile', pronto: false },
              { value: 'none',        label: 'Niente',  icon: 'ti-player-stop',  desc: 'nessuna uscita',  pronto: true  },
            ].map((m) => (
              <button key={m.value} disabled={!m.pronto}
                title={m.pronto ? undefined : 'Lo Script non emette ancora segnali: arriva con una fetta successiva'}
                onClick={() => { if (m.pronto) updateProp(nodeId, 'outputMode', m.value) }}
                style={{
                  flex: 1, padding: '7px 10px', borderRadius: 6,
                  cursor: m.pronto ? 'pointer' : 'not-allowed',
                  opacity: m.pronto ? 1 : 0.45,
                  background: outputMode === m.value ? '#1a3a6a' : '#1a2030',
                  border:     outputMode === m.value ? '1px solid #2a5a9a' : '1px solid #2a3349',
                  display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3,
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <i className={`ti ${m.icon}`} style={{ fontSize: 13, color: outputMode === m.value ? '#4a9eff' : '#4a5a7a' }} />
                  <span style={{ fontSize: 11, fontWeight: 600, color: outputMode === m.value ? '#4a9eff' : '#4a5a7a' }}>{m.label}</span>
                </div>
                <span style={{ fontSize: 9, color: outputMode === m.value ? '#7a9aaa' : '#2a3349' }}>{m.desc}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Qui c'era "autocomplete attivo": era vero solo per TypeScript,
            perché le definizioni di tipo si caricano in Monaco unicamente
            per quel linguaggio. Tenerlo ora sarebbe una spia che mente. */}
        {schema.length > 0 && (
          <div style={{ padding: '6px 12px', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 5 }}>
            <i className="ti ti-forms" style={{ fontSize: 9, color: '#3ddc84' }} />
            <span style={{ fontSize: 9, color: '#3ddc84' }}>
              {schema.length} campi in ingresso — cliccali qui sotto per inserirli
            </span>
          </div>
        )}

        <div style={{ padding: '6px 12px', display: 'flex', alignItems: 'center', gap: 6 }}>
          <CustomSelect style={{ ...inputStyle, width: 'auto', fontSize: 10, padding: '2px 6px', color: '#a78bfa' }}
            value="" onChange={(e) => { if (e.target.value) { insertSnippet(e.target.value); e.target.value = '' } }}>
            <option value="">⚡ template</option>
            {Object.entries(
              getTemplates().reduce((acc, t) => {
                acc[t.category] = acc[t.category] ?? []
                acc[t.category].push(t)
                return acc
              }, {} as Record<string, any[]>)
            ).map(([cat, templates]) => (
              <optgroup key={cat} label={cat}>
                {templates.map((t: any) => (
                  <option key={t.id} value={t.code} title={t.description}>{t.label}</option>
                ))}
              </optgroup>
            ))}
          </CustomSelect>
          <button onClick={() => updateProp(nodeId, 'code', '')}
            style={{ background: 'none', border: '0.5px solid #2a3349', borderRadius: 4, padding: '2px 8px', fontSize: 10, cursor: 'pointer', color: '#4a5a7a' }}
            title="Svuota editor">
            <i className="ti ti-eraser" style={{ fontSize: 10 }} />
          </button>
          <span style={{ fontSize: 9, color: '#2a3349', marginLeft: 'auto' }}>
            Alt+T suggerimenti · Ctrl+Shift+F formatta
          </span>
        </div>
      </div>

      {/* ══ SEZ 2 — VARIABILI DISPONIBILI ══════════════════════ */}
      <div style={{ background: '#161b27', border: '1px solid #2a3349', borderRadius: 8, padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.08em' }}>
          Variabili disponibili — clicca per inserire · ▾ per trasformazioni
        </div>

        {/* Input */}
        {schema.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#3ddc84', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-arrow-right" style={{ fontSize: 9 }} /> input · {schema.length} campi
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {schema.map((f) => (
                <SmartPill key={f.name}
                  label={inputPattern(f.name)} color="#3ddc84"
                  type={f.type} varName={inputPattern(f.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Output — out.campo */}
        {outputFields.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#4a9eff', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-arrow-right" style={{ fontSize: 9 }} /> out · {outputFields.length} campi
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {outputFields.map((f) => (
                <SmartPill key={f.id}
                  label={outVarPattern(f.name)} color="#4a9eff"
                  type={f.type} varName={outVarPattern(f.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Reject — reject.campo */}
        {hasReject && outputFields.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#ff5f57', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-x" style={{ fontSize: 9 }} /> reject · {outputFields.length} campi
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {outputFields.map((f) => (
                <SmartPill key={f.id}
                  label={rejectVarPattern(f.name)} color="#ff5f57"
                  type={f.type} varName={rejectVarPattern(f.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Lane */}
        {laneVars.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div style={{ fontSize: 9, color: '#ffb347', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-box" style={{ fontSize: 9 }} /> lane · {laneVars.length} variabili
            </div>
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {laneVars.map((v) => (
                <SmartPill key={v.name}
                  label={laneVarPattern(v.name)} color="#ffb347"
                  type={v.type} varName={laneVarPattern(v.name)}
                  onInsert={insertSnippet} onWrap={wrapSelection} />
              ))}
            </div>
          </div>
        )}

        {/* Le variabili di POOL non compaiono: non sono raggiungibili dalle
            espressioni, ed è voluto. Il piano che arriva al motore porta
            solo `laneConfig.variables` (buildRustPlan) e nel `LanePlan` non
            esiste un campo per quelle di pool — quindi `var("nome")` su una
            variabile di pool restituirebbe null in silenzio. Qui c'erano le
            pill che la inserivano: suggerivano di scrivere una cosa che
            sarebbe sempre stata vuota.
            La riga sotto compare solo se il pool ne ha, per rispondere alla
            domanda "e le mie variabili di pool?" prima che venga posta. */}
        {poolVars.length > 0 && (
          <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.5, fontStyle: 'italic' }}>
            Le {poolVars.length} variabili di pool non sono leggibili dalle espressioni:
            usa quelle di lane.
          </div>
        )}

        {/* Istruzioni del linguaggio.
            Qui c'erano cinque chip che inserivano `context.log("")`,
            `context.emit(row)`, `context.skip()` e compagnia: l'API
            dell'esecutore JavaScript, che con questo linguaggio non
            compila nemmeno. Erano l'ultimo posto in cui il vecchio
            `context` sopravviveva — e il più insidioso, perché non si
            legge: si CLICCA, e finisce dritto nell'editor. */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <div style={{ fontSize: 9, color: '#22d3ee', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.06em', display: 'flex', alignItems: 'center', gap: 4 }}>
            <i className="ti ti-function" style={{ fontSize: 9 }} /> istruzioni
          </div>
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
            {[
              { label: 'let',    snippet: 'let nome = ',             title: 'valore intermedio: non finisce nella riga' },
              { label: 'if',     snippet: 'if condizione {\n  \n}',  title: 'ramificazione' },
              { label: 'repeat', snippet: 'repeat 3 as i {\n  \n}',  title: 'ripete N volte' },
              { label: 'for',    snippet: 'for x in campo {\n  \n}', title: 'ripete su ogni elemento di un array' },
              { label: 'emit',   snippet: 'emit',                    title: 'manda a valle una copia della riga' },
              { label: 'skip',   snippet: 'skip',                    title: 'la riga non esce da nessuna porta' },
              { label: 'reject', snippet: 'reject "motivo"',         title: 'manda la riga alla porta reject', color: '#ff5f57' },
              { label: 'log',    snippet: 'log "messaggio"',         title: 'scrive nel pannello di log' },
              { label: 'error',  snippet: 'error "messaggio"',       title: 'fa fallire il nodo', color: '#ff5f57' },
            ].map((fn) => (
              <button key={fn.label} onClick={() => insertSnippet(fn.snippet)} title={fn.title}
                style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, background: '#0f1117', border: '1px solid #2a3349', color: '#9a9aaa', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0 }}
                onMouseEnter={(e) => { const c = (fn as any).color ?? '#22d3ee'; (e.currentTarget as HTMLElement).style.borderColor = c; (e.currentTarget as HTMLElement).style.color = c }}
                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.color = '#9a9aaa' }}>
                {fn.label}
              </button>
            ))}
          </div>
        </div>

        {schema.length === 0 && laneVars.length === 0 && poolVars.length === 0 && outputFields.length === 0 && (
          <div style={{ fontSize: 10, color: '#2a3349', fontStyle: 'italic' }}>
            Collega un nodo sorgente e definisci i campi output nel tab Mapping
          </div>
        )}
      </div>

      {/* ══ SEZ 3 — EDITOR ══════════════════════════════════════ */}
      <ScriptEditor
        value={p('code')}
        onChange={handleCodeChange}
        language={EDITOR_LANG}
        schema={schema}
        laneVars={laneVars}
        poolVars={poolVars}
        height={320}
        snippetToInsert={snippet}
        onSnippetInserted={() => setSnippet(undefined)}
        wrapToInsert={wrap}
        onWrapInserted={() => setWrap(undefined)}
      />

      {/* ══ SEZ 4 — BADGE REJECT ════════════════════════════════ */}
      {hasReject && (
        <div style={{ padding: '6px 10px', background: '#1a0a0a', border: '1px solid #3a1a1a', borderRadius: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 7, height: 7, borderRadius: '50%', background: '#ff5f57', flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: '#ff5f57' }}>
            Flusso reject attivo — handle visibile sul nodo · configura lo schema nel tab Mapping
          </span>
        </div>
      )}

      {/* La sezione DIPENDENZE è stata rimossa: prometteva import NPM,
          moduli pip e artefatti Maven per tre linguaggi che il motore non
          ha mai eseguito. Il linguaggio di FlowPilot non ha librerie
          esterne per disegno (v. design-nodo-script.md §6): tutto quello
          che si può chiamare è nelle ~80 funzioni di FPEL. */}

      {/* ══ SEZ 6 — OPZIONI AVANZATE ════════════════════════════ */}
      <div style={{ background: '#1a2030', border: '0.5px solid #2a3349', borderRadius: 6, overflow: 'hidden' }}>
      <div style={{ padding: '5px 10px', fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
  <i className="ti ti-info-circle" style={{ fontSize: 10, marginRight: 4 }} />
  I thread non sono permessi in nessuna modalità sandbox. Per il parallelismo usa più lane o più nodi script in pipeline.
</div>
        <button onClick={() => setShowAdvanced((v) => !v)}
          style={{ width: '100%', background: 'none', border: 'none', padding: '7px 10px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6, color: '#9a9aaa', fontSize: 10 }}>
          <i className={`ti ${showAdvanced ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 10 }} />
          <i className="ti ti-settings-2" style={{ fontSize: 11, color: '#4a5a7a' }} />
          Opzioni avanzate
        </button>
        {showAdvanced && (
          <div style={{ padding: '8px 10px', borderTop: '0.5px solid #2a3349', display: 'flex', flexDirection: 'column', gap: 8 }}>
            <GridRow>
              <Field label="Timeout (s)">
                <input type="number" style={inputStyle} value={p('scriptTimeout') || '30'} onChange={u('scriptTimeout')} min="1" />
              </Field>
              <Field label="Memoria max (MB)">
                <input type="number" style={inputStyle} value={p('maxMemory') || '256'} onChange={u('maxMemory')} min="64" />
              </Field>
            </GridRow>
            <Field label="Sandbox">
              <CustomSelect style={inputStyle} value={p('sandbox') || 'strict'} onChange={u('sandbox')}>
              <option value="strict">Strict — no filesystem / rete / thread</option>
              <option value="network">Network — HTTP permesso, no thread</option>
              <option value="full">Full — accesso completo, no thread</option>
              </CustomSelect>
            </Field>
          </div>
        )}
      </div>

    </div>
  )
}