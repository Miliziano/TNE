/**
 * src/components/LineageModal.tsx
 *
 * PROVENIENZA DEI CAMPI (P393): scelto un nodo e un suo campo, da dove viene
 * (all'indietro fino alle sorgenti, con l'espressione di ogni passo) e dove va
 * (in avanti fino ai sink: cosa tocco se cambio questo campo). Il calcolo è
 * in src/ir/lineage.ts; qui solo la vista e l'export CSV.
 */
import { useMemo, useState } from 'react'
import { useFlowStore } from '../store/flowStore'
import {
  creaProvenienza, riepilogoProvenienza, provenienzaCsv,
  type PassoIndietro, type UsoAvanti, type Derivazione, type Come,
} from '../ir/lineage'
import { isTauri, saveFileDialog, writeFile } from '../lib/tauri'

const ACCENT = '#f0abfc'
const overlay: React.CSSProperties = {
  position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)', zIndex: 1000,
  display: 'flex', alignItems: 'center', justifyContent: 'center',
}
const panel: React.CSSProperties = {
  width: 1040, maxWidth: '96vw', height: '84vh', display: 'flex', flexDirection: 'column',
  background: '#161b26', border: '1px solid #2a3349', borderRadius: 10, overflow: 'hidden',
  boxShadow: '0 20px 60px rgba(0,0,0,0.5)',
}
const inputStyle: React.CSSProperties = {
  background: '#0f1117', border: '1px solid #2a3349', borderRadius: 5, color: '#e8ecf4',
  padding: '5px 8px', fontSize: 12,
}

const COME: Record<Come, { label: string; color: string }> = {
  origin:     { label: 'source',     color: '#3ddc84' },
  pass:       { label: 'passed',     color: '#8593b5' },
  expr:       { label: 'computed',   color: '#a78bfa' },
  agg:        { label: 'aggregated', color: '#38bdf8' },
  parsed:     { label: 'extracted',  color: '#fbbf24' },
  serialized: { label: 'document',   color: '#fbbf24' },
  generated:  { label: 'by the node', color: '#f472b6' },
  dynamic:    { label: 'runtime',    color: '#fb923c' },
  assumed:    { label: 'assumed',    color: '#fb923c' },
}
const TITOLO_COME: Record<Come, string> = {
  origin:     'The field is born here: a column of a file, of a query, a field of the source',
  pass:       'Passed through unchanged',
  expr:       'Computed by an expression',
  agg:        'Aggregate or window function',
  parsed:     'Extracted from another field (JSON/XML, elements of a list)',
  serialized: 'A document built from several fields',
  generated:  'Written by the node itself (reject reason, status row, quality result)',
  dynamic:    'Known only at runtime (pivoted columns)',
  assumed:    'This node type does not declare what it does with fields: it is assumed to pass them',
}

function Badge({ come }: { come: Come }) {
  const c = COME[come]
  return (
    <span title={TITOLO_COME[come]} style={{ fontSize: 9, fontWeight: 600, padding: '1px 6px', borderRadius: 8,
      color: c.color, border: `0.5px solid ${c.color}60`, background: `color-mix(in srgb, ${c.color} 10%, #0f1117)`,
      whiteSpace: 'nowrap' }}>
      {c.label}
    </span>
  )
}

function Dettagli({ der }: { der: Derivazione }) {
  return (
    <>
      {der.passi?.map((s, i) => (
        <div key={i} style={{ fontSize: 10, color: '#8a94a8', fontFamily: 'monospace', marginLeft: 4 }}>
          via <span style={{ color: '#c8d4f0' }}>{s.nome}</span> = {s.testo}
        </div>
      ))}
      {der.variabili && der.variabili.length > 0 && (
        <div style={{ fontSize: 10, color: '#8a94a8', marginLeft: 4 }}>
          reads lane variable{der.variabili.length > 1 ? 's' : ''} <span style={{ fontFamily: 'monospace', color: '#c8d4f0' }}>{der.variabili.join(', ')}</span>
        </div>
      )}
      {der.condizionale && (
        <div style={{ fontSize: 10, color: '#fbbf24', marginLeft: 4 }}>
          assigned only in some branches: otherwise it keeps the previous value
        </div>
      )}
      {der.errore && (
        <div style={{ fontSize: 10, color: '#ff9a94', fontFamily: 'monospace', marginLeft: 4, whiteSpace: 'pre-wrap' }}>
          the configuration does not compile: {der.errore}
        </div>
      )}
    </>
  )
}

interface Vai { (nodeId: string, handle: string, field: string): void }
type NomePorta = (nodeId: string, handle: string) => string

function Riga({ label, type, field, handle, der, extra, onVai, onSeleziona, nodeId, porta }: {
  label: string; type: string; field: string; handle: string; der?: Derivazione | null; extra?: React.ReactNode
  porta: string
  onVai?: () => void; onSeleziona: (id: string) => void; nodeId: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, flexWrap: 'wrap', padding: '3px 0' }}>
      <button onClick={onVai} disabled={!onVai} title={onVai ? 'Show the lineage of this field' : undefined}
        style={{ background: 'none', border: 'none', padding: 0, cursor: onVai ? 'pointer' : 'default',
                 color: '#e8ecf4', fontSize: 12, fontWeight: 600 }}>
        {label}
      </button>
      <span style={{ fontSize: 9, color: '#6a7690' }}>{type}{handle !== 'output' && handle !== 'input' ? ` · ${porta}` : ''}</span>
      <span style={{ fontFamily: 'monospace', fontSize: 12, color: ACCENT }}>{field}</span>
      {der ? <Badge come={der.come} /> : null}
      {der?.testo && <span style={{ fontFamily: 'monospace', fontSize: 11, color: '#c8d4f0', wordBreak: 'break-all' }}>{der.come === 'origin' || der.come === 'generated' || der.come === 'dynamic' ? der.testo : `= ${der.testo}`}</span>}
      {extra}
      <button onClick={() => onSeleziona(nodeId)} title="Select the node on the canvas"
        style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer', fontSize: 11, padding: 0 }}>
        <i className="ti ti-focus-2" />
      </button>
    </div>
  )
}

function Indietro({ p, livello, onVai, onSeleziona, np }: { p: PassoIndietro; livello: number; onVai: Vai; onSeleziona: (id: string) => void; np: NomePorta }) {
  // Catene di semplici passaggi (filter, log…) si mostrano lo stesso: dicono
  // da dove passa il campo. Il primo passo è il campo scelto.
  return (
    <div style={{ marginLeft: livello ? 14 : 0, borderLeft: livello ? '1px solid #2a3349' : 'none', paddingLeft: livello ? 8 : 0 }}>
      <Riga label={p.label} type={p.type} field={p.field} handle={p.handle} der={p.der} nodeId={p.nodeId} porta={np(p.nodeId, p.handle)}
        onVai={livello ? () => onVai(p.nodeId, p.handle, p.field) : undefined} onSeleziona={onSeleziona}
        extra={p.ciclo ? <span style={{ fontSize: 10, color: '#fb923c' }}>cycle</span>
          : !p.der ? <span style={{ fontSize: 10, color: '#ff9a94' }}>not produced by this node</span> : null} />
      {p.der && <Dettagli der={p.der} />}
      {p.sorgenti.map((s, i) => <Indietro key={i} p={s} livello={livello + 1} onVai={onVai} onSeleziona={onSeleziona} np={np} />)}
    </div>
  )
}

function Avanti({ u, livello, onVai, onSeleziona, np }: { u: UsoAvanti; livello: number; onVai: Vai; onSeleziona: (id: string) => void; np: NomePorta }) {
  return (
    <div style={{ marginLeft: livello ? 14 : 0, borderLeft: livello ? '1px solid #2a3349' : 'none', paddingLeft: livello ? 8 : 0 }}>
      <Riga label={u.label} type={u.type} field={u.field} handle={u.handle} der={u.der} nodeId={u.nodeId} porta={np(u.nodeId, u.handle)}
        onVai={u.scritto || u.handle === '__channel' ? undefined : () => onVai(u.nodeId, u.handle, u.field)} onSeleziona={onSeleziona}
        extra={u.scritto ? <span style={{ fontSize: 11, color: '#3ddc84' }}><i className="ti ti-database-export" /> written to {u.scritto}</span> : null} />
      {u.der && u.der.come !== 'pass' && <Dettagli der={u.der} />}
      {u.usi.map((x, i) => <Avanti key={i} u={x} livello={livello + 1} onVai={onVai} onSeleziona={onSeleziona} np={np} />)}
    </div>
  )
}

export function LineageModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  // Montato solo da aperto: a ogni apertura riparte dal nodo selezionato.
  return open ? <Contenuto onClose={onClose} /> : null
}

function Contenuto({ onClose }: { onClose: () => void }) {
  const nodes      = useFlowStore((s) => s.nodes)
  const edges      = useFlowStore((s) => s.edges)
  const lanes      = useFlowStore((s) => s.pool.lanes)
  const userFns    = useFlowStore((s) => s.pool.userFunctions)
  const selected   = useFlowStore((s) => s.selectedNodeId)
  const selectNode = useFlowStore((s) => s.selectNode)

  const prov = useMemo(
    () => creaProvenienza(nodes, edges, { userFunctions: userFns ?? [] }),
    [nodes, edges, userFns],
  )
  const elencoNodi = useMemo(
    () => nodes.filter((n) => n.data.type !== 'lane_start' && n.data.type !== 'lane_end'),
    [nodes],
  )

  const [nodeId, setNodeId] = useState<string>(() => elencoNodi.find((n) => n.id === selected)?.id ?? elencoNodi[0]?.id ?? '')
  const [handle, setHandle] = useState<string>('')
  const [field,  setField]  = useState<string>('')
  const [cerca,  setCerca]  = useState('')

  // Porte del nodo: le uscite con campi; per un sink (nessuna uscita), gli ingressi.
  const uscite = nodeId ? prov.porteUscita(nodeId).filter((h) => prov.campi(nodeId, h).length > 0) : []
  // Porte come "in:h" / "out:h". Di un sink interessa ciò che gli arriva:
  // si parte dagli ingressi (la sua uscita, se c'è, è una riga di stato).
  const tipoNodo = nodeId ? prov.tipo(nodeId) : ''
  const terminale = tipoNodo.startsWith('sink_') || tipoNodo === 'mail_sink' || tipoNodo === 'report_generator'
  const ingressi = nodeId ? prov.porteIngresso(nodeId).map((h) => `in:${h}`) : []
  const porte = terminale || uscite.length === 0
    ? [...ingressi, ...uscite.map((h) => `out:${h}`)]
    : [...uscite.map((h) => `out:${h}`), ...ingressi]
  const scelta = porte.includes(handle) ? handle : porte[0] ?? ''
  const modoIngresso = scelta.startsWith('in:')
  const porta = scelta.slice(scelta.indexOf(':') + 1)
  const campi = porta ? (modoIngresso ? prov.campiIngresso(nodeId, porta) : prov.campi(nodeId, porta)) : []
  const filtrati = cerca ? campi.filter((c) => c.toLowerCase().includes(cerca.toLowerCase())) : campi
  const campo = campi.includes(field) ? field : ''

  const indietro: PassoIndietro[] = campo
    ? (modoIngresso ? prov.daIngresso(nodeId, porta, campo) : [prov.indietro(nodeId, porta, campo)])
    : []
  const avanti: UsoAvanti[] = campo && !modoIngresso ? prov.avanti(nodeId, porta, campo) : []

  const vai: Vai = (n, h, f) => { setNodeId(n); setHandle(`out:${h}`); setField(f); setCerca('') }

  const esporta = async () => {
    const csv = provenienzaCsv(riepilogoProvenienza(nodes, edges, { userFunctions: userFns ?? [] }))
    if (isTauri()) {
      const path = await saveFileDialog({ title: 'Export field lineage',
        filters: [{ name: 'CSV', extensions: ['csv'] }], defaultPath: 'lineage.csv' })
      if (!path) return
      try { await writeFile(path, csv) }
      catch (e) { alert(`Save failed: ${e instanceof Error ? e.message : String(e)}`) }
      return
    }
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' })
    const url = URL.createObjectURL(blob); const a = document.createElement('a')
    a.href = url; a.download = 'lineage.csv'; document.body.appendChild(a); a.click()
    document.body.removeChild(a); URL.revokeObjectURL(url)
  }

  const perLane = lanes.map((l) => ({ lane: l, nodi: elencoNodi.filter((n) => n.data.laneId === l.id) }))
    .filter((g) => g.nodi.length > 0)
  const senzaLane = elencoNodi.filter((n) => !lanes.some((l) => l.id === n.data.laneId))

  return (
    <div style={overlay} onClick={onClose}>
      <div style={panel} onClick={(e) => e.stopPropagation()}>

        <div style={{ padding: '14px 18px', borderBottom: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 10 }}>
          <i className="ti ti-route" style={{ fontSize: 18, color: ACCENT }} />
          <div style={{ fontSize: 14, fontWeight: 600, color: '#e8ecf4' }}>Field lineage</div>
          <div style={{ fontSize: 11, color: '#8a94a8' }}>where a field comes from, and what it feeds</div>
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={{ background: 'none', border: 'none', color: '#6a7690', cursor: 'pointer', fontSize: 18 }}>
            <i className="ti ti-x" />
          </button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          {/* scelta del nodo, della porta, del campo */}
          <div style={{ width: 270, borderRight: '1px solid #2a3349', display: 'flex', flexDirection: 'column', padding: 12, gap: 8 }}>
            <select value={nodeId} onChange={(e) => { setNodeId(e.target.value); setHandle(''); setField('') }} style={inputStyle}>
              {perLane.map(({ lane, nodi }) => (
                <optgroup key={lane.id} label={lane.label}>
                  {nodi.map((n) => <option key={n.id} value={n.id}>{prov.etichetta(n.id)} ({n.data.type})</option>)}
                </optgroup>
              ))}
              {senzaLane.map((n) => <option key={n.id} value={n.id}>{prov.etichetta(n.id)} ({n.data.type})</option>)}
            </select>
            {porte.length > 1 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {porte.map((h) => (
                  <button key={h} onClick={() => { setHandle(h); setField('') }}
                    title={h.startsWith('in:') ? 'Fields arriving on this input' : 'Fields leaving on this output'}
                    style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, cursor: 'pointer',
                             background: h === scelta ? `color-mix(in srgb, ${ACCENT} 18%, #0f1117)` : 'none',
                             color: h === scelta ? ACCENT : '#8a94a8', border: `0.5px solid ${h === scelta ? ACCENT : '#2a3349'}` }}>
                    {h.startsWith('in:') ? '→ ' : ''}{prov.etichettaPorta(nodeId, h.slice(h.indexOf(':') + 1))}{h.startsWith('out:') ? ' →' : ''}
                  </button>
                ))}
              </div>
            )}
            <div style={{ fontSize: 10, color: '#6a7690' }}>
              {modoIngresso ? 'Fields arriving at this node' : 'Fields leaving this node'} · {campi.length}
            </div>
            <input value={cerca} onChange={(e) => setCerca(e.target.value)} placeholder="Filter fields…" style={inputStyle} spellCheck={false} />
            <div style={{ flex: 1, overflowY: 'auto' }}>
              {filtrati.length === 0 && (
                <div style={{ fontSize: 11, color: '#6a7690', padding: 6 }}>
                  {campi.length === 0 ? 'No known fields: configure the node or connect it.' : 'No field matches.'}
                </div>
              )}
              {filtrati.map((c) => {
                const der = modoIngresso ? null : prov.deriva(nodeId, porta, c)
                return (
                  <div key={c} onClick={() => setField(c)}
                    style={{ padding: '4px 8px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
                             background: c === campo ? `color-mix(in srgb, ${ACCENT} 12%, #161b26)` : 'none',
                             borderLeft: `2px solid ${c === campo ? ACCENT : 'transparent'}` }}>
                    <span style={{ flex: 1, fontFamily: 'monospace', fontSize: 12, color: '#e8ecf4', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c}</span>
                    {der && der.come !== 'pass' && <Badge come={der.come} />}
                  </div>
                )
              })}
            </div>
          </div>

          {/* provenienza del campo scelto */}
          <div style={{ flex: 1, overflowY: 'auto', padding: '12px 18px', minWidth: 0 }}>
            {!campo ? (
              <div style={{ fontSize: 12, color: '#6a7690', margin: '40px auto', textAlign: 'center', maxWidth: 420, lineHeight: 1.6 }}>
                Pick a field on the left. You will see where its value comes from, step by step back to the
                sources, and everything it feeds downstream, up to the targets.
              </div>
            ) : (
              <>
                <div style={{ fontSize: 11, fontWeight: 600, color: '#8a94a8', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 6 }}>
                  <i className="ti ti-arrow-back-up" /> Where it comes from
                </div>
                {indietro.length === 0
                  ? <div style={{ fontSize: 11, color: '#6a7690' }}>Nothing is connected upstream.</div>
                  : indietro.map((p, i) => <Indietro key={i} p={p} livello={modoIngresso ? 1 : 0} onVai={vai} onSeleziona={selectNode} np={prov.etichettaPorta} />)}

                {!modoIngresso && (
                  <>
                    <div style={{ fontSize: 11, fontWeight: 600, color: '#8a94a8', textTransform: 'uppercase', letterSpacing: 0.5, margin: '18px 0 6px' }}>
                      <i className="ti ti-arrow-forward-up" /> What it feeds
                    </div>
                    {avanti.length === 0
                      ? <div style={{ fontSize: 11, color: '#6a7690' }}>Nothing downstream uses this field.</div>
                      : avanti.map((u, i) => <Avanti key={i} u={u} livello={0} onVai={vai} onSeleziona={selectNode} np={prov.etichettaPorta} />)}
                  </>
                )}
              </>
            )}
          </div>
        </div>

        <div style={{ padding: '10px 18px', borderTop: '1px solid #2a3349', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ fontSize: 10, color: '#6a7690', flex: 1 }}>
            Computed from the same compilation used by Run. Only value dependencies are shown: conditions that decide
            whether a row passes (filters, join keys) are not.
          </div>
          <button onClick={esporta} title="For every field written by a target: its source fields and the path (CSV)"
            style={{ padding: '6px 12px', fontSize: 11, borderRadius: 6, cursor: 'pointer',
                     background: 'none', border: `1px solid ${ACCENT}55`, color: ACCENT }}>
            <i className="ti ti-file-export" style={{ fontSize: 11 }} /> Export CSV
          </button>
          <button onClick={onClose}
            style={{ padding: '6px 14px', fontSize: 12, borderRadius: 6, cursor: 'pointer',
                     background: 'none', border: '1px solid #2a3349', color: '#9aa4b8' }}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
