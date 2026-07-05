import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { TabGeneral }  from '../../../components/tabs/TabGeneral'
import { TabAdvanced } from '../../../components/tabs/TabAdvanced'
import '@xyflow/react/dist/style.css'
import { updateNode, useFlowStore } from '../../../store/flowStore'
import type { TMapConfig, TMapInputField, TMapFieldType, TMapConnection, TMapTransformNode } from '../../../types'
import { getTransformsForType, type TransformCategory } from '../../../transforms/catalog'
import { FieldTransformEditor } from '../../../components/FieldTransformEditor'
import { CustomSelect } from '../../../components/CustomSelect'
import { TYPE_META } from '../../../types/fieldTypes'
import type { FieldType } from '../../../types/fieldTypes'
import { getHandleSchema } from '../../../utils/schemaRegistry'
import { registerModuleObjects } from '../../../monitoring/registry'


// ─── Mappe handle ─────────────────────────────────────────────────
const transformInputHandleRefs  = new Map<string, { x: number; y: number }>()
const transformOutputHandleRefs = new Map<string, { x: number; y: number }>()
export const inputHandleRefs           = new Map<string, { x: number; y: number }>()
export const outputHandleRefs          = new Map<string, { x: number; y: number }>()
export const joinHandleRefs            = new Map<string, { x: number; y: number }>()

// ─── Stili ────────────────────────────────────────────────────────
const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10, padding: '3px 6px', outline: 'none', width: '100%',
}
import { FIELD_TYPES } from '../../../types/fieldTypes'
const JOIN_TYPE_COLORS: Record<string, string> = { inner: '#4a9eff', left: '#3ddc84', first: '#ffb347' }

// ─── Tipi ─────────────────────────────────────────────────────────
// Un singolo campo con trasformazione opzionale
export interface JoinFieldExpr {
  id:    string
  field: string
  fn:    string   // id da JOIN_TRANSFORMS
  arg1:  string
  arg2:  string
}

// Una coppia join = una condizione di match
// srcInputId: flusso sorgente (tutti i campi src devono venire da qui)
// srcFields:  uno o più campi del flusso sorgente (chiave composta se N>1)
// combineExpr: se N>1, come combinarli — es "$0 + '-' + $1"
// dstField:   campo del flusso destinatario (il lookup che possiede questa coppia)
export interface JoinPair {
  id:          string
  srcColor:    string   // colore del flusso sorgente
  srcInputId:  string   // id del flusso sorgente
  srcFields:   JoinFieldExpr[]
  combineExpr: string
  dstFields:    JoinFieldExpr[]   // uno o più campi del flusso destinatario
  dstCombineExpr: string          // se N>1: come combinarli
}

// ─── Trasformazioni guidate ───────────────────────────────────────
export const JOIN_TRANSFORMS = [
  { id: 'none',   label: 'nessuna',            fn: (f: string) => `row.${f}` },
  { id: 'trim',   label: 'trim',               fn: (f: string) => `String(row.${f}??'').trim()` },
  { id: 'lower',  label: 'lowercase',          fn: (f: string) => `String(row.${f}??'').toLowerCase()` },
  { id: 'upper',  label: 'uppercase',          fn: (f: string) => `String(row.${f}??'').toUpperCase()` },
  { id: 'year',   label: 'estrai anno',        fn: (f: string) => `new Date(row.${f}).getFullYear()` },
  { id: 'month',  label: 'estrai mese',        fn: (f: string) => `new Date(row.${f}).getMonth()+1` },
  { id: 'day',    label: 'estrai giorno',      fn: (f: string) => `new Date(row.${f}).getDate()` },
  { id: 'date',   label: 'estrai data',        fn: (f: string) => `String(row.${f}??'').split('T')[0]` },
  { id: 'substr', label: 'substring(n,m)',     fn: (f: string, a='0', b='8') => `String(row.${f}??'').substring(${a},${b})` },
  { id: 'regex',  label: 'regex extract',      fn: (f: string, p='(.+)') => `(String(row.${f}??'').match(/${p}/)||[])[1]??''` },
  { id: 'free',   label: 'espressione libera', fn: (f: string) => `row.${f}` },
]

export function buildExpr(field: string, fnId: string, arg1: string, arg2: string): string {
  if (!field) return ''
  if (fnId === 'substr') return `String(row.${field}??'').substring(${arg1||'0'},${arg2||'8'})`
  if (fnId === 'regex')  return `(String(row.${field}??'').match(/${arg1||'(.+)'}/)||[])[1]??''`
  if (fnId === 'free')   return arg1 || `row.${field}`
  return JOIN_TRANSFORMS.find((t) => t.id === fnId)?.fn(field) ?? `row.${field}`
}

// ─── Colore flusso ────────────────────────────────────────────────
function inputColor(inp: TMapConfig['inputs'][0]): string {
  if (inp.isMain) return '#4a9eff'
  // Assegna colori progressivi ai lookup
  const LOOKUP_COLORS = ['#ffb347', '#a78bfa', '#22d3ee', '#f87171', '#34d399']
  const idx = 0 // verrà calcolato dal chiamante
  return '#ffb347'
}

const INPUT_COLORS = ['#4a9eff', '#ffb347', '#a78bfa', '#22d3ee', '#f87171', '#34d399']

function getInputColor(tmap: TMapConfig, inputId: string): string {
  const idx = tmap.inputs.findIndex((i) => i.id === inputId)
  return INPUT_COLORS[idx % INPUT_COLORS.length] ?? '#4a5a7a'
}

// ─── FnEditor — editor trasformazione inline ──────────────────────
function FnEditor({ value, arg1, arg2, onChange, accentColor }: {
  value:       string
  arg1:        string
  arg2:        string
  accentColor: string
  onChange:    (patch: { fn?: string; arg1?: string; arg2?: string }) => void
}) {
  return (
    <div style={{ marginTop: 4, padding: '6px 8px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${accentColor}20`, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <CustomSelect style={{ ...iStyle, fontSize: 9 }} value={value}
        onChange={(e) => onChange({ fn: e.target.value, arg1: '', arg2: '' })}>
        {JOIN_TRANSFORMS.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
      </CustomSelect>
      {value === 'substr' && (
        <div style={{ display: 'flex', gap: 4 }}>
          <input style={{ ...iStyle, width: 60, fontSize: 9 }} value={arg1} onChange={(e) => onChange({ arg1: e.target.value })} placeholder="inizio" />
          <input style={{ ...iStyle, width: 60, fontSize: 9 }} value={arg2} onChange={(e) => onChange({ arg2: e.target.value })} placeholder="fine" />
        </div>
      )}
      {value === 'regex' && <input style={{ ...iStyle, fontSize: 9 }} value={arg1} onChange={(e) => onChange({ arg1: e.target.value })} placeholder="pattern es: (\d{4})" />}
      {value === 'free'  && <input style={{ ...iStyle, fontSize: 9 }} value={arg1} onChange={(e) => onChange({ arg1: e.target.value })} placeholder="es: row.campo.split('-')[0]" />}
    </div>
  )
}

// ─── JoinConfigModal ─────────────────────────────────────────────
// Modal globale per configurare tutte le coppie join di un flusso lookup.
// Supporta join arbitrari (qualsiasi flusso → qualsiasi lookup).
function JoinConfigModal({ inp, tmap, nodeId, onClose, onPairsChange }: {
  inp:            TMapConfig['inputs'][0]
  tmap:           TMapConfig
  nodeId:         string
  onClose:        () => void
  onPairsChange:  (pairs: JoinPair[]) => void
}) {
  const updateTMapInput = useFlowStore((s) => s.updateTMapInput)
  const dstColor        = getInputColor(tmap, inp.id)

  const [pairs, setPairsRaw] = useState<JoinPair[]>(() => (inp as any).joinPairs ?? [])
  const [showFn, setShowFn]  = useState<string | null>(null)

  const setPairs = useCallback((updater: JoinPair[] | ((ps: JoinPair[]) => JoinPair[])) => {
    setPairsRaw((prev) => {
      const next = typeof updater === 'function' ? updater(prev) : updater
      onPairsChange(next)
      return next
    })
  }, [onPairsChange])

  // Drag della finestra
  const [winPos, setWinPos]   = useState<{ x: number; y: number } | null>(null)
  const draggingWin = useRef(false)
  const winOffset   = useRef({ x: 0, y: 0 })
  const winRef      = useRef<HTMLDivElement>(null)

  const onWinMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button,select,input')) return
    draggingWin.current = true
    const rect = winRef.current?.getBoundingClientRect()
    if (!rect) return
    winOffset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }
    e.preventDefault()
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (!draggingWin.current) return; setWinPos({ x: e.clientX - winOffset.current.x, y: e.clientY - winOffset.current.y }) }
    const onUp   = () => { draggingWin.current = false }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const save = () => {
    updateTMapInput(nodeId, inp.id, { joinPairs: pairs } as any)
    onClose()
  }

  const addPair = () => setPairs((ps) => [...ps, {
    id: `jp_${Date.now()}`,
    srcColor: '#4a9eff', srcInputId: '',
    srcFields: [{ id: `jf_${Date.now()}`, field: '', fn: 'none', arg1: '', arg2: '' }],
    combineExpr: '',
    dstFields: [{ id: `jf_${Date.now() + 1}`, field: '', fn: 'none', arg1: '', arg2: '' }],
    dstCombineExpr: '',
  }])

  const removePair  = (id: string) => setPairs((ps) => ps.filter((p) => p.id !== id))
  const updatePair  = (id: string, patch: Partial<JoinPair>) => setPairs((ps) => ps.map((p) => p.id === id ? { ...p, ...patch } : p))

  const addSrcField = (pairId: string) => setPairs((ps) => ps.map((p) => {
    if (p.id !== pairId) return p
    const newFields = [...p.srcFields, { id: `jf_${Date.now()}`, field: '', fn: 'none', arg1: '', arg2: '' }]
    const oldAuto   = autoExpr(p.srcFields)
    const isAuto    = !p.combineExpr || p.combineExpr === oldAuto
    return { ...p, srcFields: newFields, combineExpr: isAuto ? autoExpr(p.srcFields) : p.combineExpr }
  }))
  const removeSrcField = (pairId: string, idx: number) => setPairs((ps) => ps.map((p) => p.id !== pairId ? p : {
    ...p, srcFields: p.srcFields.filter((_, i) => i !== idx),
  }))
  // Costruisce l'espressione automatica da una lista di campi
  function autoExpr(fields: JoinFieldExpr[]): string {
    return fields.map((f) => f.field ? buildExpr(f.field, f.fn, f.arg1, f.arg2) : '').filter(Boolean).join(" + '-' + ")
  }

  // Aggiorna un campo sorgente e ricalcola combineExpr se non è in modalità manuale
  const updateSrcField = (pairId: string, idx: number, patch: Partial<JoinFieldExpr>) =>
    setPairs((ps) => ps.map((p) => {
      if (p.id !== pairId) return p
      const newFields = p.srcFields.map((f, i) => i === idx ? { ...f, ...patch } : f)
      // Ricalcola combineExpr se il vecchio valore era auto o vuoto
      const oldAuto   = autoExpr(p.srcFields)
      const isAuto    = !p.combineExpr || p.combineExpr === oldAuto
      const newExpr   = isAuto && newFields.length > 1 ? autoExpr(newFields) : p.combineExpr
      return { ...p, srcFields: newFields, combineExpr: newExpr }
    }))

  // Aggiorna un campo destinatario e ricalcola dstCombineExpr se non è in modalità manuale
  const updateDstField = (pairId: string, idx: number, patch: Partial<JoinFieldExpr>) =>
    setPairs((ps) => ps.map((p) => {
      if (p.id !== pairId) return p
      const dstArr    = p.dstFields ?? []
      const newFields = dstArr.map((f, i) => i === idx ? { ...f, ...patch } : f)
      const oldAuto   = autoExpr(dstArr)
      const isAuto    = !p.dstCombineExpr || p.dstCombineExpr === oldAuto
      const newExpr   = isAuto && newFields.length > 1 ? autoExpr(newFields) : (p.dstCombineExpr ?? '')
      return { ...p, dstFields: newFields, dstCombineExpr: newExpr }
    }))

  const addDstField = (pairId: string) => setPairs((ps) => ps.map((p) => {
    if (p.id !== pairId) return p
    // Se dstFields è vuoto/undefined ma esiste il campo legacy, lo recupera prima di aggiungere
    const existing: JoinFieldExpr[] = (p.dstFields && p.dstFields.length > 0)
      ? p.dstFields
      : (p as any).dstField
        ? [{ id: `jf_legacy_${Date.now()}`, field: (p as any).dstField, fn: (p as any).dstFn ?? 'none', arg1: (p as any).dstArg1 ?? '', arg2: (p as any).dstArg2 ?? '' }]
        : []
    return { ...p, dstFields: [...existing, { id: `jf_${Date.now()}`, field: '', fn: 'none', arg1: '', arg2: '' }] }
  }))
  const removeDstField = (pairId: string, idx: number) => setPairs((ps) => ps.map((p) => p.id !== pairId ? p : {
    ...p, dstFields: (p.dstFields ?? []).filter((_, i) => i !== idx),
  }))

  // Campi del flusso destinatario (questo lookup)
  const dstFields = inp.fields.filter((f) => !f.name.startsWith('status.'))

  // Altri flussi disponibili come sorgente (tutto tranne questo lookup)
  const srcInputs = tmap.inputs.filter((i) => i.id !== inp.id)

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, zIndex: 30000, pointerEvents: 'none' }}>
      <div
        ref={winRef}
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'absolute', pointerEvents: 'all',
          ...(winPos ? { left: winPos.x, top: winPos.y } : { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' }),
          background: '#161b27', border: `1px solid ${dstColor}40`, borderRadius: 10,
          width: 660, maxWidth: 'calc(100vw - 48px)', maxHeight: '85vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.9), 0 0 0 1px #2a3349',
        }}>

        {/* ── Header — draggabile ── */}
        <div onMouseDown={onWinMouseDown}
          style={{ padding: '12px 16px', borderBottom: '1px solid #2a3349', background: '#1a2030', display: 'flex', alignItems: 'center', gap: 10, flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
          <div style={{ width: 10, height: 10, borderRadius: '50%', background: dstColor, flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600, color: '#c8d4f0' }}>
              Join — <span style={{ color: dstColor }}>{inp.label}</span>
              <span style={{ fontSize: 10, color: '#4a5a7a', fontWeight: 400, marginLeft: 8 }}>
                {pairs.length} {pairs.length === 1 ? 'condizione' : 'condizioni'}
              </span>
            </div>
          </div>
          <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 4 }}>
            <i className="ti ti-x" style={{ fontSize: 14 }} />
          </button>
        </div>

        {/* Tipo join — sopra lo scroll */}
        <div style={{ padding: '8px 16px', borderBottom: '1px solid #2a3349', background: '#161b27', display: 'flex', gap: 4, alignItems: 'center', flexShrink: 0 }}>
          <span style={{ fontSize: 9, color: '#4a5a7a', marginRight: 4, textTransform: 'uppercase', letterSpacing: '.06em' }}>Tipo join</span>
          {(['inner', 'left', 'first'] as const).map((jt) => {
            const jc = JOIN_TYPE_COLORS[jt]
            return (
              <button key={jt} onClick={() => updateTMapInput(nodeId, inp.id, { joinType: jt })}
                style={{ flex: 1, padding: '4px', fontSize: 10, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                  background: inp.joinType === jt ? `color-mix(in srgb, ${jc} 20%, #161b27)` : '#1e2535',
                  color: inp.joinType === jt ? jc : '#4a5a7a',
                  border: inp.joinType === jt ? `1px solid ${jc}60` : '1px solid #2a3349' }}>
                {jt}
              </button>
            )
          })}
        </div>

        {/* ── Corpo scrollabile ── */}
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>

          {pairs.length === 0 && (
            <div style={{ padding: '32px 0', textAlign: 'center', color: '#2a3349', fontSize: 11, flexShrink: 0 }}>
              <i className="ti ti-link" style={{ fontSize: 28, display: 'block', marginBottom: 8 }} />
              Nessuna condizione — aggiungine una o trascina un campo join
            </div>
          )}

          {pairs.map((pair, pairIdx) => {
            const srcInp    = tmap.inputs.find((i) => i.id === pair.srcInputId)
            const srcColor  = pair.srcInputId ? getInputColor(tmap, pair.srcInputId) : '#4a5a7a'
            const srcFields = srcInp?.fields.filter((f) => !f.name.startsWith('status.')) ?? []

            return (
              <div key={pair.id} style={{ background: '#1a2030', borderRadius: 8, border: `1px solid ${srcColor}30`, overflow: 'hidden', flexShrink: 0 }}>

                {/* Header coppia — mostra flusso sorgente → flusso destinatario */}
                <div style={{ padding: '7px 12px', background: `color-mix(in srgb, ${srcColor} 8%, #161b27)`, borderBottom: `0.5px solid ${srcColor}20`, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontSize: 9, color: `${srcColor}70`, fontFamily: 'monospace', minWidth: 18 }}>#{pairIdx + 1}</span>
                  {/* Flusso sorgente */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: srcColor }} />
                    <span style={{ fontSize: 10, fontWeight: 600, color: srcColor, fontFamily: 'monospace' }}>
                      {srcInp?.label ?? '—'}
                    </span>
                  </div>
                  <span style={{ fontSize: 11, color: '#4a5a7a' }}>→</span>
                  {/* Flusso destinatario */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ width: 7, height: 7, borderRadius: '50%', background: dstColor }} />
                    <span style={{ fontSize: 10, fontWeight: 600, color: dstColor, fontFamily: 'monospace' }}>
                      {inp.label}
                    </span>
                  </div>
                  <span style={{ flex: 1 }} />
                  <button onClick={() => removePair(pair.id)}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0 }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                    <i className="ti ti-x" style={{ fontSize: 10 }} />
                  </button>
                </div>

                <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>

                  {/* Selettore flusso sorgente */}
                  <div>
                    <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 4 }}>Flusso sorgente</div>
                    <CustomSelect style={{ ...iStyle, fontSize: 10 }} value={pair.srcInputId}
                      onChange={(e) => {
                        const newColor = getInputColor(tmap, e.target.value)
                        updatePair(pair.id, {
                          srcInputId: e.target.value,
                          srcColor:   newColor,
                          srcFields:  [{ id: `jf_${Date.now()}`, field: '', fn: 'none', arg1: '', arg2: '' }],
                        })
                      }}>
                      <option value="">— seleziona flusso —</option>
                      {srcInputs.map((i) => (
                        <option key={i.id} value={i.id}>{i.isMain ? '▶ MAIN' : '◆ LOOKUP'} — {i.label}</option>
                      ))}
                    </CustomSelect>
                  </div>

                  {/* Campi sorgente — uno o più (chiave composta) */}
                  <div>
                    <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ color: srcColor }}>Campi — {srcInp?.label ?? '?'}</span>
                      <button onClick={() => addSrcField(pair.id)}
                        title="Aggiungi campo per chiave composta (più campi combinati = una sola condizione)"
                        style={{ background: 'none', border: `0.5px dashed ${srcColor}50`, borderRadius: 3, padding: '1px 5px', fontSize: 9, color: srcColor, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2 }}>
                        <i className="ti ti-plus" style={{ fontSize: 9 }} /> campo composto
                      </button>
                    </div>

                    {pair.srcFields.map((sf, idx) => {
                      const fnKey = `${pair.id}__src__${idx}`
                      return (
                        <div key={sf.id} style={{ marginBottom: idx < pair.srcFields.length - 1 ? 8 : 0 }}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            {pair.srcFields.length > 1 && (
                              <span style={{ fontSize: 9, color: `${srcColor}70`, minWidth: 16, fontFamily: 'monospace' }}>${idx}</span>
                            )}
                            {srcFields.length > 0 ? (
                              <CustomSelect style={{ ...iStyle, flex: 1, fontSize: 9, borderColor: `${srcColor}40` }} value={sf.field}
                                onChange={(e) => updateSrcField(pair.id, idx, { field: e.target.value })}>
                                <option value="">— campo —</option>
                                {srcFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                              </CustomSelect>
                            ) : (
                              <input style={{ ...iStyle, flex: 1, fontSize: 9 }} value={sf.field}
                                onChange={(e) => updateSrcField(pair.id, idx, { field: e.target.value })} placeholder="nome campo" />
                            )}
                            <button onClick={() => setShowFn(showFn === fnKey ? null : fnKey)}
                              style={{ padding: '2px 5px', borderRadius: 3, cursor: 'pointer', fontSize: 9, fontFamily: 'monospace',
                                border: sf.fn !== 'none' ? `1px solid ${srcColor}60` : '1px solid #2a3349',
                                background: sf.fn !== 'none' ? `color-mix(in srgb, ${srcColor} 15%, #161b27)` : '#1e2535',
                                color: sf.fn !== 'none' ? srcColor : '#4a5a7a' }}>
                              ƒ
                            </button>
                            {pair.srcFields.length > 1 && (
                              <button onClick={() => removeSrcField(pair.id, idx)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0 }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                                <i className="ti ti-x" style={{ fontSize: 9 }} />
                              </button>
                            )}
                          </div>
                          {showFn === fnKey && (
                            <FnEditor value={sf.fn} arg1={sf.arg1} arg2={sf.arg2} accentColor={srcColor}
                              onChange={(p) => updateSrcField(pair.id, idx, { fn: p.fn ?? sf.fn, arg1: p.arg1 ?? sf.arg1, arg2: p.arg2 ?? sf.arg2 })} />
                          )}
                          {sf.fn !== 'none' && sf.field && (
                            <code style={{ display: 'block', marginTop: 2, marginLeft: pair.srcFields.length > 1 ? 20 : 0, fontSize: 9, color: `${srcColor}80`, padding: '1px 5px', background: `color-mix(in srgb, ${srcColor} 5%, #0f1117)`, borderRadius: 3, wordBreak: 'break-all' }}>
                              {buildExpr(sf.field, sf.fn, sf.arg1, sf.arg2)}
                            </code>
                          )}
                        </div>
                      )
                    })}

                    {/* Espressione combinazione se N>1 */}
                    {pair.srcFields.length > 1 && (() => {
                      const auto    = autoExpr(pair.srcFields)
                      const isAuto  = !pair.combineExpr || pair.combineExpr === auto
                      return (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>Combinazione</span>
                            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, fontWeight: 600,
                              background: isAuto ? 'color-mix(in srgb, #3ddc84 15%, #0f1117)' : 'color-mix(in srgb, #ffb347 15%, #0f1117)',
                              color: isAuto ? '#3ddc84' : '#ffb347',
                              border: isAuto ? '1px solid #3ddc8440' : '1px solid #ffb34740' }}>
                              {isAuto ? '⟳ auto' : '✎ manuale'}
                            </span>
                            {!isAuto && (
                              <button onClick={() => updatePair(pair.id, { combineExpr: auto })}
                                title="Ripristina espressione automatica"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#3ddc84', fontSize: 9, padding: 0 }}>
                                ripristina auto
                              </button>
                            )}
                          </div>
                          <input style={{ ...iStyle, borderColor: isAuto ? '#3ddc8430' : `${srcColor}40` }}
                            value={pair.combineExpr || auto}
                            onChange={(e) => updatePair(pair.id, { combineExpr: e.target.value })}
                            placeholder={auto || "es: $0 + '-' + $1"} />
                          {pair.combineExpr && (
                            <code style={{ display: 'block', marginTop: 3, fontSize: 9, color: '#3ddc84', padding: '2px 6px', background: '#0d1a10', borderRadius: 3, wordBreak: 'break-all' }}>
                              → {pair.srcFields.reduce((acc, sf, i) => acc.replace(new RegExp(`\\$${i}`, 'g'), buildExpr(sf.field, sf.fn, sf.arg1, sf.arg2) || `$${i}`), pair.combineExpr || auto)}
                            </code>
                          )}
                        </div>
                      )
                    })()}
                  </div>

                  {/* Separatore freccia */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <div style={{ flex: 1, height: '0.5px', background: `${dstColor}20` }} />
                    <span style={{ fontSize: 9, color: dstColor, fontFamily: 'monospace' }}>↓ {inp.label}</span>
                    <div style={{ flex: 1, height: '0.5px', background: `${dstColor}20` }} />
                  </div>

                  {/* Campo/i destinatario — supporta chiave composta */}
                  <div>
                    <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6, color: dstColor }}>
                      <span>Campi — {inp.label}</span>
                      <button onClick={() => addDstField(pair.id)}
                        title="Aggiungi campo per chiave composta lato destinatario"
                        style={{ background: 'none', border: `0.5px dashed ${dstColor}50`, borderRadius: 3, padding: '1px 5px', fontSize: 9, color: dstColor, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 2 }}>
                        <i className="ti ti-plus" style={{ fontSize: 9 }} /> campo composto
                      </button>
                    </div>
                    {(pair.dstFields ?? [{ id: 'legacy', field: (pair as any).dstField ?? '', fn: (pair as any).dstFn ?? 'none', arg1: (pair as any).dstArg1 ?? '', arg2: (pair as any).dstArg2 ?? '' }]).map((df, idx) => {
                      const dstArr = pair.dstFields ?? []
                      const fnKey  = `${pair.id}__dst__${idx}`
                      return (
                        <div key={df.id} style={{ marginBottom: idx < dstArr.length - 1 ? 8 : 0 }}>
                          <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            {dstArr.length > 1 && (
                              <span style={{ fontSize: 9, color: `${dstColor}70`, minWidth: 16, fontFamily: 'monospace' }}>${idx}</span>
                            )}
                            {dstFields.length > 0 ? (
                              <CustomSelect style={{ ...iStyle, flex: 1, borderColor: `${dstColor}40` }} value={df.field}
                                onChange={(e) => updateDstField(pair.id, idx, { field: e.target.value })}>
                                <option value="">— seleziona —</option>
                                {dstFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
                              </CustomSelect>
                            ) : (
                              <input style={{ ...iStyle, flex: 1 }} value={df.field}
                                onChange={(e) => updateDstField(pair.id, idx, { field: e.target.value })} placeholder="campo" />
                            )}
                            <button onClick={() => setShowFn(showFn === fnKey ? null : fnKey)}
                              style={{ padding: '2px 5px', borderRadius: 3, cursor: 'pointer', fontSize: 9, fontFamily: 'monospace',
                                border: df.fn !== 'none' ? `1px solid ${dstColor}60` : '1px solid #2a3349',
                                background: df.fn !== 'none' ? `color-mix(in srgb, ${dstColor} 15%, #161b27)` : '#1e2535',
                                color: df.fn !== 'none' ? dstColor : '#4a5a7a' }}>
                              ƒ
                            </button>
                            {dstArr.length > 1 && (
                              <button onClick={() => removeDstField(pair.id, idx)}
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0 }}
                                onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                                onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                                <i className="ti ti-x" style={{ fontSize: 9 }} />
                              </button>
                            )}
                          </div>
                          {showFn === fnKey && (
                            <FnEditor value={df.fn} arg1={df.arg1} arg2={df.arg2} accentColor={dstColor}
                              onChange={(p) => updateDstField(pair.id, idx, { fn: p.fn ?? df.fn, arg1: p.arg1 ?? df.arg1, arg2: p.arg2 ?? df.arg2 })} />
                          )}
                          {df.fn !== 'none' && df.field && (
                            <code style={{ display: 'block', marginTop: 2, marginLeft: dstArr.length > 1 ? 20 : 0, fontSize: 9, color: `${dstColor}80`, padding: '1px 5px', background: `color-mix(in srgb, ${dstColor} 5%, #0f1117)`, borderRadius: 3, wordBreak: 'break-all' }}>
                              {buildExpr(df.field, df.fn, df.arg1, df.arg2)}
                            </code>
                          )}
                        </div>
                      )
                    })}
                    {(pair.dstFields ?? []).length > 1 && (() => {
                      const dstArr  = pair.dstFields ?? []
                      const auto    = autoExpr(dstArr)
                      const isAuto  = !pair.dstCombineExpr || pair.dstCombineExpr === auto
                      return (
                        <div style={{ marginTop: 8 }}>
                          <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 4, display: 'flex', alignItems: 'center', gap: 6 }}>
                            <span>Combinazione</span>
                            <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 4, fontWeight: 600,
                              background: isAuto ? 'color-mix(in srgb, #3ddc84 15%, #0f1117)' : 'color-mix(in srgb, #ffb347 15%, #0f1117)',
                              color: isAuto ? '#3ddc84' : '#ffb347',
                              border: isAuto ? '1px solid #3ddc8440' : '1px solid #ffb34740' }}>
                              {isAuto ? '⟳ auto' : '✎ manuale'}
                            </span>
                            {!isAuto && (
                              <button onClick={() => updatePair(pair.id, { dstCombineExpr: auto })}
                                title="Ripristina espressione automatica"
                                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#3ddc84', fontSize: 9, padding: 0 }}>
                                ripristina auto
                              </button>
                            )}
                          </div>
                          <input style={{ ...iStyle, borderColor: isAuto ? '#3ddc8430' : `${dstColor}40` }}
                            value={pair.dstCombineExpr || auto}
                            onChange={(e) => updatePair(pair.id, { dstCombineExpr: e.target.value })}
                            placeholder={auto || "es: $0 + '-' + $1"} />
                          {(pair.dstCombineExpr || auto) && (
                            <code style={{ display: 'block', marginTop: 3, fontSize: 9, color: '#3ddc84', padding: '2px 6px', background: '#0d1a10', borderRadius: 3, wordBreak: 'break-all' }}>
                              → {dstArr.reduce((acc, df, i) => acc.replace(new RegExp(`\\$${i}`, 'g'), buildExpr(df.field, df.fn, df.arg1, df.arg2) || `$${i}`), pair.dstCombineExpr || auto)}
                            </code>
                          )}
                        </div>
                      )
                    })()}
                  </div>
                </div>
              </div>
            )
          })}

          <button onClick={addPair}
            style={{ alignSelf: 'flex-start', flexShrink: 0, background: 'none', border: `0.5px dashed ${dstColor}40`, borderRadius: 6, padding: '5px 14px', fontSize: 10, color: dstColor, cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4 }}>
            <i className="ti ti-plus" style={{ fontSize: 10 }} /> Aggiungi condizione join
          </button>
        </div>

        {/* Footer */}
        <div style={{ padding: '10px 16px', borderTop: '1px solid #2a3349', background: '#1a2030', display: 'flex', gap: 8, justifyContent: 'flex-end', flexShrink: 0 }}>
          <button onClick={onClose}
            style={{ padding: '5px 14px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: 'none', border: '1px solid #2a3349', color: '#9a9aaa' }}>
            Annulla
          </button>
          <button onClick={save}
            style={{ padding: '5px 18px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: `color-mix(in srgb, ${dstColor} 20%, #161b27)`, border: `1px solid ${dstColor}60`, color: dstColor, fontWeight: 600 }}>
            Applica
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

// ─── FlowCard ─────────────────────────────────────────────────────
function FlowCard({ color, header, children, onMouseUp }: {
  color: string; header: React.ReactNode; children: React.ReactNode; onMouseUp?: React.MouseEventHandler
}) {
  return (
    <div onMouseUp={onMouseUp} style={{ borderRadius: 8, border: `1px solid ${color}40`, background: `color-mix(in srgb, ${color} 4%, #161b27)`, overflow: 'hidden', marginBottom: 8, flexShrink: 0 }}>
      <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${color} 12%, #1a2030)`, borderBottom: `1px solid ${color}30`, display: 'flex', alignItems: 'center', gap: 6 }}>
        {header}
      </div>
      <div>{children}</div>
    </div>
  )
}

// ─── FieldRow ─────────────────────────────────────────────────────
function FieldRow({ children, fieldKey, onHover }: { children: React.ReactNode; fieldKey?: string; onHover?: (key: string | null) => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div onMouseEnter={() => { setHovered(true); onHover?.(fieldKey ?? null) }}
      onMouseLeave={() => { setHovered(false); onHover?.(null) }}
      style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 8px 4px 6px', borderBottom: '0.5px solid #1a2030', background: hovered ? '#1e2535' : '#161b27', transition: 'background .1s' }}>
      {children}
    </div>
  )
}

function AddFieldRow({ color, label, onClick }: { color: string; label: string; onClick: () => void }) {
  const [hovered, setHovered] = useState(false)
  return (
    <div onClick={onClick} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)}
      style={{ padding: '5px 12px', fontSize: 10, color: hovered ? color : '#4a5a7a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 4, transition: 'color .1s' }}>
      <i className="ti ti-plus" style={{ fontSize: 10 }} /> {label}
    </div>
  )
}

// ─── StatusFieldsSection ──────────────────────────────────────────
function StatusFieldsSection({ fields, inputId, containerRef, onDragStart, onHover, color, onJoinDragStart }: {
  fields: TMapInputField[]; inputId: string; containerRef: React.RefObject<HTMLDivElement | null>
  onDragStart: (key: string, inputId: string, fieldName: string, color: string) => void
  onHover: (key: string | null) => void; color: string
  onJoinDragStart: (key: string, inputId: string, fieldName: string, color: string) => void
}) {
  const [open, setOpen] = useState(false)
  const registerHandle = useCallback((el: HTMLDivElement | null, key: string) => {
    if (!el || !containerRef.current) return
    const cr = containerRef.current.getBoundingClientRect(); const er = el.getBoundingClientRect()
    inputHandleRefs.set(key, { x: er.right - cr.left, y: er.top + er.height / 2 - cr.top })
  }, [containerRef])
  const registerJoinHandle = useCallback((el: HTMLDivElement | null, key: string) => {
    if (!el || !containerRef.current) return
    const cr = containerRef.current.getBoundingClientRect(); const er = el.getBoundingClientRect()
    joinHandleRefs.set(key, { x: er.left + er.width / 2 - cr.left, y: er.top + er.height / 2 - cr.top })
  }, [containerRef])

  return (
    <>
      <div onClick={() => setOpen((o) => !o)}
        style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '4px 12px', background: '#0f1117', borderBottom: '0.5px solid #1a2030', cursor: 'pointer', userSelect: 'none' }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#141920' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#0f1117' }}>
        <i className={`ti ${open ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 9, color: '#4a5a7a' }} />
        <i className="ti ti-activity" style={{ fontSize: 10, color: '#4a5a7a' }} />
        <span style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>status ({fields.length} campi)</span>
      </div>
      {open && fields.map((field) => {
        const key = `${inputId}__${field.name}`; const joinKey = `${inputId}__${field.name}__join`
        return (
          <FieldRow key={field.name} fieldKey={key} onHover={onHover}>
            <div ref={(el) => { if (el) registerJoinHandle(el as HTMLDivElement, joinKey) }}
              data-join-handle={joinKey} data-join-input-id={inputId} data-join-field={field.name}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onJoinDragStart(joinKey, inputId, field.name, color) }}
              style={{ width: 10, height: 10, borderRadius: '50%', background: '#4a5a7a', flexShrink: 0, cursor: 'crosshair', border: '2px solid #0f1117', opacity: 0.6 }} />
            <span style={{ fontSize: 10, fontFamily: 'monospace', color: '#4a5a7a', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{field.name}</span>
            <span style={{ fontSize: 9, color: '#2a3349', padding: '1px 4px', background: '#1a2030', borderRadius: 3 }}>{field.type}</span>
            <div ref={(el) => { if (el) registerHandle(el as HTMLDivElement, key) }}
              onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onDragStart(key, inputId, field.name, '#4a5a7a') }}
              style={{ width: 10, height: 10, borderRadius: '50%', background: '#2a3349', flexShrink: 0, cursor: 'crosshair', border: '2px solid #0f1117', marginRight: 2 }} />
          </FieldRow>
        )
      })}
    </>
  )
}

// ─── removeFieldFromTransforms ────────────────────────────────────
function removeFieldFromTransforms(nodeId: string, inputId: string, fieldName: string, tmap: TMapConfig) {
  if (!tmap.transforms?.length) return
  const inputLabel = tmap.inputs.find((i) => i.id === inputId)?.label ?? inputId
  const removedVar = `$${inputLabel}.${fieldName}`
  const updatedTransforms = tmap.transforms.map((tr) => {
    if (!tr.inputs.some((i) => i.inputId === inputId && i.fieldName === fieldName)) return tr
    const newInputs = tr.inputs.filter((i) => !(i.inputId === inputId && i.fieldName === fieldName))
    const sep = tr.mode === 'script' ? '\n' : ' + '
    let newExpression = tr.expression.split(sep).map((p) => p.trim()).filter((p) => p !== removedVar).join(sep).trim()
    if (newExpression === '' && newInputs.length > 0) newExpression = newInputs.map((i) => { const lbl = tmap.inputs.find((ti) => ti.id === i.inputId)?.label ?? i.inputId; return `$${lbl}.${i.fieldName}` }).join(sep)
    return { ...tr, inputs: newInputs, expression: newExpression }
  })
  useFlowStore.setState((s) => ({
    nodes: updateNode(s.nodes, nodeId, (n) => {
      const t = n.data.config.tmap as TMapConfig | undefined; if (!t) return n
      return { ...n, data: { ...n.data, config: { ...n.data.config, tmap: { ...t, transforms: updatedTransforms } } } }
    }),
  }))
}

// ─── JoinLinksOverlay ─────────────────────────────────────────────
// Disegna i link join dentro la InputColumn.
// - Un link per ogni srcField (ventaglio se chiave composta)
// - Un link per ogni dstField se N>1
// - Click sul pallino centrale → elimina la coppia
// - previewPairs: coppie in anteprima dalla modal aperta (non ancora salvate)
function JoinLinksOverlay({ tmap, draggingJoin, tick, onEditLookup, onDeletePair, previewPairs }: {
  tmap:          TMapConfig
  draggingJoin:  { fromKey: string; x: number; y: number; color: string } | null
  tick:          number
  onEditLookup:  (inp: TMapConfig['inputs'][0]) => void
  onDeletePair:  (dstInputId: string, pairId: string) => void
  previewPairs?: { dstInputId: string; pairs: JoinPair[] } | null
}) {
  const [hoveredLink, setHoveredLink] = useState<string | null>(null)  // `pairId__srcIdx` o `pairId__dst__dstIdx`

  const makePath = (x1: number, y1: number, x2: number, y2: number, offset = 0) => {
    const leftX = Math.min(x1, x2) - 18 - offset
    return `M ${x1} ${y1} C ${leftX} ${y1} ${leftX} ${y2} ${x2} ${y2}`
  }

  // Usa previewPairs per il lookup in modifica, dati store per gli altri
  function getPairsForLookup(dstInp: TMapConfig['inputs'][0]): JoinPair[] {
    if (previewPairs && previewPairs.dstInputId === dstInp.id) return previewPairs.pairs
    return (dstInp as any).joinPairs ?? []
  }

  // Raccoglie tutti i segmenti da disegnare
  interface LinkSegment {
    key:       string    // identificatore univoco del segmento
    pairId:    string
    from:      { x: number; y: number }
    to:        { x: number; y: number }
    color:     string
    hasFn:     boolean
    isFirst:   boolean   // primo segmento della coppia — porta il pallino
    dstInp:    TMapConfig['inputs'][0]
    label:     string    // testo nel pallino
    totalSegs: number    // totale segmenti della coppia
  }

  const allSegments: LinkSegment[] = []

  tmap.inputs.forEach((dstInp) => {
    const pairs = getPairsForLookup(dstInp)
    pairs.forEach((p) => {
      const lineColor = p.srcColor || getInputColor(tmap, p.srcInputId)
      const srcFields = p.srcFields ?? []
      const dstFields = p.dstFields ?? ((p as any).dstField ? [{ id: 'legacy', field: (p as any).dstField, fn: (p as any).dstFn ?? 'none', arg1: '', arg2: '' }] : [])

      // Quanti link totali per questa coppia
      const totalSegs = srcFields.length + Math.max(0, dstFields.length - 1)

      let segIdx = 0

      // Link per ogni campo sorgente → dstFields[0]
      const dstField0 = dstFields[0]?.field
      if (dstField0) {
        srcFields.forEach((sf, sfIdx) => {
          if (!sf.field) return
          const srcKey = `${p.srcInputId}__${sf.field}__join`
          const dstKey = `${dstInp.id}__${dstField0}__join`
          const from = joinHandleRefs.get(srcKey)
          const to   = joinHandleRefs.get(dstKey)
          if (!from || !to) { segIdx++; return }
          const hasFn = sf.fn !== 'none' || (dstFields[0]?.fn ?? 'none') !== 'none'
          allSegments.push({
            key: `${p.id}__src__${sfIdx}`, pairId: p.id,
            from, to, color: lineColor, hasFn,
            isFirst: segIdx === 0, dstInp,
            label: totalSegs > 1 ? `${sfIdx + 1}` : hasFn ? 'ƒ' : '=',
            totalSegs,
          })
          segIdx++
        })
      }

      // Link aggiuntivi per dstFields[1..N] → srcFields[0]
      const srcField0 = srcFields[0]?.field
      if (srcField0) {
        dstFields.slice(1).forEach((df, dfIdx) => {
          if (!df.field) return
          const srcKey = `${p.srcInputId}__${srcField0}__join`
          const dstKey = `${dstInp.id}__${df.field}__join`
          const from = joinHandleRefs.get(srcKey)
          const to   = joinHandleRefs.get(dstKey)
          if (!from || !to) { segIdx++; return }
          const hasFn = (srcFields[0]?.fn ?? 'none') !== 'none' || df.fn !== 'none'
          allSegments.push({
            key: `${p.id}__dst__${dfIdx + 1}`, pairId: p.id,
            from, to, color: lineColor, hasFn,
            isFirst: false, dstInp,
            label: `d${dfIdx + 2}`,
            totalSegs,
          })
          segIdx++
        })
      }
    })
  })

  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: draggingJoin ? 25 : 5, overflow: 'visible' }} width="100%" height="100%">

      {allSegments.map((seg, i) => {
        const hovKey   = seg.key
        const isHov    = hoveredLink === hovKey || hoveredLink?.startsWith(seg.pairId + '__') === true && hoveredLink === hovKey
        const isAnyHov = hoveredLink?.startsWith(seg.pairId + '__') ?? false
        // Sfasa leggermente le curve parallele
        const offset   = (i % 3) * 4
        const d        = makePath(seg.from.x, seg.from.y, seg.to.x, seg.to.y, offset)
        const stroke   = isAnyHov ? '#3ddc84' : seg.color
        const mx       = (seg.from.x + seg.to.x) / 2 - 18 - offset
        const my       = (seg.from.y + seg.to.y) / 2

        return (
          <g key={seg.key} style={{ pointerEvents: 'all' }}>
            {/* Area hover larga */}
            <path d={d} fill="none" stroke="transparent" strokeWidth={12}
              style={{ cursor: 'pointer' }}
              onMouseEnter={() => setHoveredLink(seg.key)}
              onMouseLeave={() => setHoveredLink(null)}
              onDoubleClick={() => onEditLookup(seg.dstInp)} />
            {/* Linea visibile */}
            <path d={d} fill="none"
              stroke={stroke}
              strokeWidth={isAnyHov ? 2 : 1.5}
              strokeOpacity={isAnyHov ? 0.9 : 0.6}
              strokeDasharray={seg.hasFn ? '5 3' : '3 2'}
              style={{ pointerEvents: 'none' }} />
            {/* Pallino centrale — solo sul primo segmento della coppia */}
            {seg.isFirst && (
              <>
                <circle cx={mx} cy={my} r={isAnyHov ? 9 : 6}
                  fill={isAnyHov ? '#ff5f57' : `color-mix(in srgb, ${seg.color} 25%, #0f1117)`}
                  stroke={isAnyHov ? '#ff5f57' : seg.color}
                  strokeWidth={1} strokeOpacity={0.9}
                  style={{ cursor: 'pointer', pointerEvents: 'all' }}
                  onMouseEnter={() => setHoveredLink(seg.key)}
                  onMouseLeave={() => setHoveredLink(null)}
                  onClick={() => onDeletePair(seg.dstInp.id, seg.pairId)}
                  onDoubleClick={() => onEditLookup(seg.dstInp)} />
                <text x={mx} y={my + 3} textAnchor="middle" fontSize={isAnyHov ? 9 : 7}
                  fill={isAnyHov ? '#fff' : seg.color}
                  fontFamily="monospace" fontWeight="bold"
                  style={{ pointerEvents: 'none' }}>
                  {isAnyHov ? '×' : seg.label}
                </text>
                {isAnyHov && (
                  <text x={mx} y={my - 14} textAnchor="middle" fontSize={8} fill="#ff5f57"
                    style={{ pointerEvents: 'none' }}>
                    click elimina · doppio click edita
                  </text>
                )}
              </>
            )}
          </g>
        )
      })}

      {/* Drag join in corso */}
      {draggingJoin && (() => {
        const from = joinHandleRefs.get(draggingJoin.fromKey); if (!from) return null
        const leftX = Math.min(from.x, draggingJoin.x) - 18
        const d = `M ${from.x} ${from.y} C ${leftX} ${from.y} ${leftX} ${draggingJoin.y} ${draggingJoin.x} ${draggingJoin.y}`
        return <path d={d} fill="none" stroke={draggingJoin.color} strokeWidth={1.5} strokeOpacity={0.6} strokeDasharray="4 3" />
      })()}
    </svg>
  )
}

// ─── InputColumn ──────────────────────────────────────────────────
function InputColumn({ nodeId, tmap, containerRef, onDragStart, onHover, scrollRef,
  onJoinDragStart, draggingJoin, tick, width, onEditLookup, onDeletePair, previewPairs }: {
  nodeId: string; tmap: TMapConfig; containerRef: React.RefObject<HTMLDivElement | null>
  onDragStart: (key: string, inputId: string, fieldName: string, color: string) => void
  onHover: (key: string | null) => void; scrollRef: React.RefObject<HTMLDivElement | null>
  onJoinDragStart: (key: string, inputId: string, fieldName: string, color: string) => void
  draggingJoin: { fromKey: string; x: number; y: number; color: string } | null
  tick: number; width: number; onEditLookup: (inp: TMapConfig['inputs'][0]) => void
  onDeletePair: (dstInputId: string, pairId: string) => void
  previewPairs: { dstInputId: string; pairs: JoinPair[] } | null
}) {
  const addTMapInput         = useFlowStore((s) => s.addTMapInput)
  const deleteTMapInput      = useFlowStore((s) => s.deleteTMapInput)
  const updateTMapInput      = useFlowStore((s) => s.updateTMapInput)
  const addTMapInputField    = useFlowStore((s) => s.addTMapInputField)
  const deleteTMapInputField = useFlowStore((s) => s.deleteTMapInputField)
  const edges                = useFlowStore((s) => s.edges)

  const [expanded, setExpanded] = useState<Record<string, boolean>>(Object.fromEntries(tmap.inputs.map((i) => [i.id, true])))
  const toggle = (id: string) => setExpanded((p) => ({ ...p, [id]: !p[id] }))

  const registerHandle = useCallback((el: HTMLDivElement | null, key: string) => {
    if (!el || !containerRef.current) return
    const cr = containerRef.current.getBoundingClientRect(); const er = el.getBoundingClientRect()
    inputHandleRefs.set(key, { x: er.right - cr.left, y: er.top + er.height / 2 - cr.top })
  }, [containerRef])

  const registerJoinHandle = useCallback((el: HTMLDivElement | null, key: string) => {
    if (!el || !containerRef.current) return
    const cr = containerRef.current.getBoundingClientRect(); const er = el.getBoundingClientRect()
    joinHandleRefs.set(key, { x: er.left + er.width / 2 - cr.left, y: er.top + er.height / 2 - cr.top })
  }, [containerRef])

  return (
    <div style={{ width, flexShrink: 0, background: '#0f1117', borderRight: '1px solid #2a3349', display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
      <JoinLinksOverlay tmap={tmap} draggingJoin={draggingJoin} tick={tick}
        onEditLookup={onEditLookup} onDeletePair={onDeletePair} previewPairs={previewPairs} />

      <div style={{ padding: '8px 12px', fontSize: 9, fontWeight: 600, color: '#4a9eff', textTransform: 'uppercase', letterSpacing: '.08em', borderBottom: '1px solid #2a3349', background: '#0f1117', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>Input</span>
        <button onClick={() => addTMapInput(nodeId, false)}
          style={{ background: 'none', border: '0.5px dashed #2a3349', borderRadius: 4, padding: '2px 7px', fontSize: 9, color: '#4a5a7a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ffb347' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-plus" style={{ fontSize: 10 }} /> lookup
        </button>
      </div>

      <div ref={scrollRef as React.RefObject<HTMLDivElement>} style={{ flex: 1, overflowY: 'auto', padding: '8px 8px 8px 14px' }}>
        {tmap.inputs.map((inp) => {
          const color        = getInputColor(tmap, inp.id)
          const rowFields    = inp.fields.filter((f) => !f.name.startsWith('status.'))
          const statusFields = inp.fields.filter((f) => f.name.startsWith('status.'))
          const isConnected  = edges.some((e) => e.target === nodeId && e.targetHandle === inp.id)
          const joinPairs: JoinPair[] = (inp as any).joinPairs ?? []

          return (
            <FlowCard key={inp.id} color={color} header={
              <>
                <i className={`ti ${expanded[inp.id] ? 'ti-chevron-down' : 'ti-chevron-right'}`}
                  style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0, cursor: 'pointer' }} onClick={() => toggle(inp.id)} />
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                <input value={inp.label} readOnly={isConnected} onClick={(e) => e.stopPropagation()}
                  onChange={(e) => {
                    if (isConnected) return
                    const oldLabel = inp.label
                    const newLabel = e.target.value
                    updateTMapInput(nodeId, inp.id, { label: newLabel })
                    const store = useFlowStore.getState()
                    const t = store.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined
                    if (!t) return

                    // Aggiorna transforms ($oldLabel.campo → $newLabel.campo)
                    const updatedTransforms = (t.transforms ?? []).map((tr) => {
                      let expr = tr.expression
                      tr.inputs.forEach((ti) => {
                        expr = expr.split(`$${oldLabel}.${ti.fieldName}`).join(`$${newLabel}.${ti.fieldName}`)
                      })
                      return { ...tr, expression: expr }
                    })

                    // Aggiorna expression dei campi di output (oldLabel.campo → newLabel.campo)
                    const updatedOutputs = t.outputs.map((out) => ({
                      ...out,
                      fields: out.fields.map((f) => {
                        if (!f.expression) return f
                        const updated = f.expression.split(`${oldLabel}.`).join(`${newLabel}.`)
                        return updated !== f.expression ? { ...f, expression: updated } : f
                      }),
                    }))

                    useFlowStore.setState((s) => ({
                      nodes: updateNode(s.nodes, nodeId, (n) => {
                        const tt = n.data.config.tmap as TMapConfig | undefined
                        if (!tt) return n
                        return { ...n, data: { ...n.data, config: { ...n.data.config, tmap: { ...tt, transforms: updatedTransforms, outputs: updatedOutputs } } } }
                      }),
                  }))
                }}
                  style={{ background: 'none', border: 'none', outline: 'none', fontSize: 11, fontWeight: 600, flex: 1, color, fontFamily: 'monospace', cursor: isConnected ? 'default' : 'text', minWidth: 0, opacity: isConnected ? 0.7 : 1 }}
                />
                <span style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: inp.isMain ? '#1a3a6a' : '#3d2a0a', color, fontWeight: 700, flexShrink: 0 }}>
                  {inp.isMain ? 'MAIN' : 'LOOKUP'}
                </span>
                <button onClick={(e) => {
                    e.stopPropagation()
                    const rFields = inp.fields.filter((f) => !f.name.startsWith('status.')); if (rFields.length === 0) return
                    const store = useFlowStore.getState(); const t = store.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined
                    const OUTPUT_COLORS = ['#3ddc84', '#ff5f57', '#4a9eff', '#ffb347', '#a78bfa', '#22d3ee']
                    const outColor = OUTPUT_COLORS[(t?.outputs.length ?? 0) % OUTPUT_COLORS.length]
                    const newOutputId = `output_${Date.now()}`
                    const newFields = rFields.map((f) => ({ id: `field_${Date.now()}_${f.name}`, name: f.name, type: f.type, expression: `${inp.label}.${f.name}` }))
                    useFlowStore.setState((s) => ({ nodes: updateNode(s.nodes, nodeId, (n) => { const tt = n.data.config.tmap as TMapConfig | undefined; if (!tt) return n; return { ...n, data: { ...n.data, config: { ...n.data.config, tmap: { ...tt, outputs: [...tt.outputs, { id: newOutputId, label: inp.label, color: outColor, filter: '', fields: newFields }] } } } } }) }))
                    setTimeout(() => { const s2 = useFlowStore.getState(); const cur = (s2.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined)?.connections ?? []; s2.setTMapConnections(nodeId, [...cur, ...newFields.map((f) => ({ id: `${inp.id}__${f.name}__${newOutputId}__${f.id}`, inputId: inp.id, fieldName: f.name, outputId: newOutputId, fieldId: f.id, color: inp.isMain ? '#4a9eff' : '#ffb347' }))]) }, 50)
                  }}
                  title="Trasferisci tutti i campi in un nuovo output"
                  style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px', flexShrink: 0 }}
                  onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
                  onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                  <i className="ti ti-arrow-bar-right" style={{ fontSize: 11 }} />
                </button>
                {!inp.isMain && (
                  <button onClick={(e) => { e.stopPropagation(); onEditLookup(inp) }} title="Configura join"
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: joinPairs.length > 0 ? color : '#4a5a7a', padding: '0 2px', flexShrink: 0 }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = color }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = joinPairs.length > 0 ? color : '#4a5a7a' }}>
                    <i className="ti ti-settings" style={{ fontSize: 11 }} />
                  </button>
                )}
                {!inp.isMain && (
                  <button onClick={(e) => { e.stopPropagation(); deleteTMapInput(nodeId, inp.id) }}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, flexShrink: 0 }}
                    onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                    onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                    <i className="ti ti-x" style={{ fontSize: 10 }} />
                  </button>
                )}
              </>
            }>
              {/* Tipo join + badge coppie */}
              {!inp.isMain && (
                <div style={{ display: 'flex', gap: 3, padding: '5px 8px', background: `color-mix(in srgb, ${color} 5%, #0f1117)`, borderBottom: `0.5px solid ${color}20` }}>
                  {(['inner', 'left', 'first'] as const).map((jt) => {
                    const jc = JOIN_TYPE_COLORS[jt]
                    return (
                      <button key={jt} onClick={() => updateTMapInput(nodeId, inp.id, { joinType: jt })}
                        style={{ flex: 1, padding: '3px 4px', fontSize: 9, borderRadius: 4, cursor: 'pointer', fontWeight: 600,
                          background: inp.joinType === jt ? `color-mix(in srgb, ${jc} 20%, #161b27)` : '#1e2535',
                          color: inp.joinType === jt ? jc : '#4a5a7a',
                          border: inp.joinType === jt ? `1px solid ${jc}60` : '1px solid #2a3349' }}>
                        {jt}
                      </button>
                    )
                  })}
                  {joinPairs.length > 0 && (
                    <div style={{ padding: '2px 6px', borderRadius: 4, background: `color-mix(in srgb, ${color} 15%, #0f1117)`, border: `1px solid ${color}40`, fontSize: 9, color, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 3 }}>
                      <i className="ti ti-link" style={{ fontSize: 9 }} /> {joinPairs.length}
                    </div>
                  )}
                </div>
              )}

              {expanded[inp.id] && (
                <>
                  {rowFields.map((field) => {
                    const key = `${inp.id}__${field.name}`; const joinKey = `${inp.id}__${field.name}__join`
                    return (
                      <FieldRow key={field.name} fieldKey={key} onHover={onHover}>
                        <div ref={(el) => { if (el) registerJoinHandle(el as HTMLDivElement, joinKey) }}
                          data-join-handle={joinKey} data-join-input-id={inp.id} data-join-field={field.name}
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onJoinDragStart(joinKey, inp.id, field.name, color) }}
                          style={{ width: 10, height: 10, borderRadius: '50%', flexShrink: 0, background: color, border: '2px solid #0f1117', cursor: 'crosshair', opacity: 0.6, transition: 'opacity .1s' }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.opacity = '1' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.opacity = '0.6' }}
                          title="Trascina per join" />
                        <span style={{ fontSize: 11, flex: 1, color: isConnected ? '#4a5a7a' : '#c8d4f0', fontFamily: 'monospace', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {field.name}
                        </span>
                        <span style={{ fontSize: 9, color: '#4a5a7a', padding: '1px 4px', background: '#1a2030', borderRadius: 3, flexShrink: 0 }}>{field.type}</span>
                        <button onClick={() => {
                            deleteTMapInputField(nodeId, inp.id, field.name)
                            const store = useFlowStore.getState(); const t = store.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined
                            if (t) removeFieldFromTransforms(nodeId, inp.id, field.name, t)
                          }}
                          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px', flexShrink: 0 }}
                          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                          <i className="ti ti-x" style={{ fontSize: 10 }} />
                        </button>
                        <div ref={(el) => { if (el) registerHandle(el, key) }}
                          onMouseDown={(e) => { e.preventDefault(); e.stopPropagation(); onDragStart(key, inp.id, field.name, color) }}
                          style={{ width: 10, height: 10, borderRadius: '50%', background: color, flexShrink: 0, cursor: 'crosshair', border: '2px solid #0f1117', marginRight: 2 }} />
                      </FieldRow>
                    )
                  })}
                  {statusFields.length > 0 && (
                    <StatusFieldsSection fields={statusFields} inputId={inp.id} containerRef={containerRef}
                      onDragStart={onDragStart} onHover={onHover} color={color} onJoinDragStart={onJoinDragStart} />
                  )}
                  <AddFieldRow color={color} label="aggiungi campo"
                    onClick={() => addTMapInputField(nodeId, inp.id, { name: `campo_${Date.now().toString().slice(-3)}`, type: 'string' })} />
                </>
              )}
            </FlowCard>
          )
        })}
      </div>
    </div>
  )
}


function ImportSchemaButton({ nodeId, outputId, outputFields, color, onImport }: {
  nodeId:       string
  outputId:     string
  outputFields: Array<{ id?: string; name: string; type: string }>
  color:        string
  onImport:     (newFields: Array<{ id: string; name: string; type: string; expression?: string }>) => void
}) {
  const [open, setOpen]  = useState(false)
  const triggerRef       = useRef<HTMLButtonElement>(null)
  const dropdownRef      = useRef<HTMLDivElement>(null)
  const [dropPos, setDropPos] = useState({ top: 0, left: 0 })
  const allNodes         = useFlowStore((s) => s.nodes)
  const allEdges         = useFlowStore((s) => s.edges)

  // Nodi a valle collegati a questo handle di output
  const downstreamTargets = allEdges
    .filter((e) => e.source === nodeId && e.sourceHandle === outputId)
    .map((e) => {
      const tgt = allNodes.find((n) => n.id === e.target)
      if (!tgt) return null
      return { edge: e, node: tgt }
    })
    .filter(Boolean) as Array<{ edge: typeof allEdges[0]; node: typeof allNodes[0] }>

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const inTrigger  = triggerRef.current?.contains(e.target as globalThis.Node)
      const inDropdown = dropdownRef.current?.contains(e.target as globalThis.Node)
      if (!inTrigger && !inDropdown) setOpen(false)
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [open])

  useEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    setDropPos({ top: r.bottom + 4, left: r.left })
  }, [open])

  // Importa lo schema dal nodo a valle.
  // IMPORTANTE: preserva gli id originali dei campi del figlio —
  // così quando l'utente poi cancella un campo nel TMap output,
  // mergeIncomingSchema lo rimuove correttamente anche dal figlio
  // (perché l'id era in _propagatedIds).
  const importFromNode = (tgtNode: typeof allNodes[0], targetHandle: string) => {
    setOpen(false)
    const schema = getHandleSchema(tgtNode, targetHandle, true)
    if (!schema.length) return

    // Merge non distruttivo — chiave id (preferito) o nome+tipo come fallback
    const existingIds   = new Set(outputFields.map((f) => f.id).filter(Boolean))
    const existingKeys  = new Set(outputFields.map((f) => `${f.name}::${f.type}`))

    const toAdd = schema
      .filter((f) => {
        if (!f.name) return false
        // Già presente per id → skip
        if (f.id && existingIds.has(f.id)) return false
        // Già presente per nome+tipo → skip
        if (existingKeys.has(`${f.name}::${f.type}`)) return false
        return true
      })
      .map((f) => ({
        // Preserva l'id originale del campo nel figlio —
        // questo è il punto chiave che permette al merge di funzionare:
        // quando il padre cancella questo campo, il figlio lo rimuove
        // perché l'id era in _propagatedIds.
        id:         f.id,
        name:       f.name,
        type:       f.type ?? 'string',
        expression: '',
      }))

    if (toAdd.length === 0) return
    onImport(toAdd)
  }

  const nodeTypeLabel = (type: string): string => {
    const MAP: Record<string, string> = {
      sink_db:         'DB Sink',
      sink_file:       'File Sink',
      sink_kafka:      'Kafka Sink',
      sink_ftp:        'FTP Sink',
      sink_mqtt:       'MQTT Sink',
      sink_activemq:   'ActiveMQ Sink',
      json_serializer: 'JSON Serializer',
      xml_serializer:  'XML Serializer',
      tmap:            'TMap',
      filter:          'Filter',
      log:             'Log',
      materialize:     'Materialize',
      bridge_out:      'Bridge Out',
      script:          'Script',
      aggregate:       'Aggregate',
      pivot:           'Pivot',
      window:          'Window',
      explode:         'Explode',
    }
    return MAP[type] ?? type
  }

  const hasTargets = downstreamTargets.length > 0

  return (
    <div style={{ position: 'relative', flexShrink: 0 }}>
      <button
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        title="Importa schema da nodo a valle"
        style={{
          background:   open ? `color-mix(in srgb, ${color} 20%, #161b27)` : 'none',
          border:       `0.5px solid ${open ? color : '#2a3349'}`,
          borderRadius: 3, padding: '1px 6px', cursor: 'pointer',
          color:        open ? color : '#4a5a7a', fontSize: 9,
          display: 'flex', alignItems: 'center', gap: 3,
          transition: 'all .12s',
        }}
        onMouseEnter={(e) => {
          if (!open) {
            ;(e.currentTarget as HTMLElement).style.color = color
            ;(e.currentTarget as HTMLElement).style.borderColor = color
          }
        }}
        onMouseLeave={(e) => {
          if (!open) {
            ;(e.currentTarget as HTMLElement).style.color = '#4a5a7a'
            ;(e.currentTarget as HTMLElement).style.borderColor = '#2a3349'
          }
        }}>
        <i className="ti ti-arrow-bar-to-left" style={{ fontSize: 9 }} />
        importa
        <i className="ti ti-chevron-down" style={{ fontSize: 8 }} />
      </button>

      {open && createPortal(
        <div
          ref={dropdownRef}
          style={{
            position:       'fixed',
            top:            dropPos.top,
            left:           dropPos.left,
            zIndex:         99999,
            minWidth:       210,
            background:     'color-mix(in srgb, #161b27 98%, transparent)',
            backdropFilter: 'blur(8px)',
            border:         `0.5px solid ${color}40`,
            borderRadius:   6,
            boxShadow:      '0 8px 32px rgba(0,0,0,.7)',
            overflow:       'hidden',
          }}>

          {/* Header */}
          <div style={{
            padding: '5px 10px 4px', fontSize: 9, fontWeight: 600,
            color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.07em',
            borderBottom: `0.5px solid ${color}20`, background: '#1a2030',
          }}>
            Importa schema da
          </div>

          {/* Nodi a valle */}
          {hasTargets ? (
            downstreamTargets.map(({ edge, node }) => {
              const tgtHandle = edge.targetHandle ?? 'input'
              const schema    = getHandleSchema(node, tgtHandle, true)
              const count     = schema.length
              const existingIds  = new Set(outputFields.map((f) => f.id).filter(Boolean))
              const existingKeys = new Set(outputFields.map((f) => `${f.name}::${f.type}`))
              const newCount  = schema.filter((f) =>
                f.name &&
                !(f.id && existingIds.has(f.id)) &&
                !existingKeys.has(`${f.name}::${f.type}`)
              ).length

              return (
                <div
                  key={edge.id}
                  onClick={() => count > 0 ? importFromNode(node, tgtHandle) : undefined}
                  style={{
                    padding:      '7px 10px',
                    fontSize:     11,
                    color:        count > 0 ? '#c8d4f0' : '#4a5a7a',
                    cursor:       count > 0 ? 'pointer' : 'not-allowed',
                    display:      'flex', alignItems: 'center', gap: 8,
                    borderBottom: '0.5px solid #1a2030',
                  }}
                  onMouseEnter={(e) => {
                    if (count > 0) (e.currentTarget as HTMLElement).style.background = '#1e2535'
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.background = 'transparent'
                  }}>
                  <i className="ti ti-arrow-bar-to-left" style={{ fontSize: 10, color, flexShrink: 0 }} />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{
                      fontSize: 10, fontWeight: 600, color,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}>
                      {(node.data.config as any)?.displayName || nodeTypeLabel(node.data.type)}
                    </div>
                    <div style={{ fontSize: 9, color: '#4a5a7a', fontFamily: 'monospace' }}>
                      {node.id.length > 20 ? node.id.slice(0, 20) + '…' : node.id}
                    </div>
                  </div>
                  {count > 0 ? (
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 1, flexShrink: 0 }}>
                      <span style={{ fontSize: 9, color: '#4a5a7a' }}>{count} campi</span>
                      {newCount > 0 && (
                        <span style={{ fontSize: 9, color: '#3ddc84' }}>+{newCount} nuovi</span>
                      )}
                      {newCount === 0 && (
                        <span style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>già presenti</span>
                      )}
                    </div>
                  ) : (
                    <span style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', flexShrink: 0 }}>
                      nessuno schema
                    </span>
                  )}
                </div>
              )
            })
          ) : (
            <div style={{ padding: '8px 10px', fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>
              Nessun nodo collegato a questo output
            </div>
          )}

          {/* Separatore */}
          <div style={{ height: '0.5px', background: `${color}20` }} />

          {/* Da file esterno — placeholder */}
          <div
            onClick={() => {
              setOpen(false)
              alert('Importazione da file esterno — disponibile prossimamente.')
            }}
            style={{
              padding: '7px 10px', fontSize: 11, color: '#9a9aaa',
              cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 8,
            }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
            <i className="ti ti-file-import" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
            da file esterno…
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
// ─── OutputColumn ─────────────────────────────────────────────────
function OutputColumn({ nodeId, tmap, containerRef, onDrop, onDropOnOutput, onDropFromTransform,
  onDropFromTransformOnOutput, transformDragging, onHover, scrollRef, width }: {
  nodeId: string; tmap: TMapConfig; containerRef: React.RefObject<HTMLDivElement | null>
  onDrop: (outputId: string, fieldId: string) => void; onDropOnOutput: (outputId: string) => void
  onDropFromTransform: (outputId: string, fieldId: string) => void; onDropFromTransformOnOutput: (outputId: string) => void
  transformDragging: { transformId: string; x: number; y: number } | null
  onHover: (key: string | null) => void; scrollRef: React.RefObject<HTMLDivElement | null>; width: number
}) {
  const addTMapOutput         = useFlowStore((s) => s.addTMapOutput)
  const deleteTMapOutput      = useFlowStore((s) => s.deleteTMapOutput)
  const updateTMapOutput      = useFlowStore((s) => s.updateTMapOutput)
  const addTMapOutputField    = useFlowStore((s) => s.addTMapOutputField)
  const deleteTMapOutputField = useFlowStore((s) => s.deleteTMapOutputField)
  const updateTMapOutputField = useFlowStore((s) => s.updateTMapOutputField)
  const OUTPUT_COLORS = ['#3ddc84', '#ff5f57', '#4a9eff', '#ffb347', '#a78bfa', '#22d3ee']
  const [hoveredHandle, setHoveredHandle] = useState<string | null>(null)

  const registerHandle = useCallback((el: HTMLDivElement | null, key: string) => {
    if (!el || !containerRef.current) return
    const cr = containerRef.current.getBoundingClientRect(); const er = el.getBoundingClientRect()
    outputHandleRefs.set(key, { x: er.left - cr.left, y: er.top + er.height / 2 - cr.top })
  }, [containerRef])

  return (
    <div style={{ width, flexShrink: 0, background: '#0f1117', borderLeft: '1px solid #2a3349', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{ padding: '8px 12px', fontSize: 9, fontWeight: 600, color: '#3ddc84', textTransform: 'uppercase', letterSpacing: '.08em', borderBottom: '1px solid #2a3349', background: '#0f1117', flexShrink: 0, display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>Output</span>
        <button onClick={() => addTMapOutput(nodeId)}
          style={{ background: 'none', border: '0.5px dashed #2a3349', borderRadius: 4, padding: '2px 7px', fontSize: 9, color: '#4a5a7a', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3 }}
          onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#3ddc84' }}
          onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-plus" style={{ fontSize: 10 }} /> flusso
        </button>
      </div>
      <div ref={scrollRef as React.RefObject<HTMLDivElement>} style={{ flex: 1, overflowY: 'auto', padding: '8px 8px' }}>
        {tmap.outputs.map((out, idx) => {
          const color = out.color ?? OUTPUT_COLORS[idx % OUTPUT_COLORS.length]

          // ── Nomi duplicati per questo output ─────────────────
          const duplicateNames = new Set(
            out.fields
              .map((f) => f.name)
              .filter((name, i, arr) => name && arr.indexOf(name) !== i)
          )

          return (
            <FlowCard key={out.id} color={color}
              onMouseUp={(e) => {
                if (!(e.target as HTMLElement).closest('[data-handle]')) {
                  if (transformDragging) onDropFromTransformOnOutput(out.id); else onDropOnOutput(out.id)
                }
              }}
              header={
                <>
                  <div style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }} />
                  <input value={out.label} onChange={(e) => updateTMapOutput(nodeId, out.id, { label: e.target.value })}
                    style={{ background: 'none', border: 'none', outline: 'none', fontSize: 11, fontWeight: 600, flex: 1, color, fontFamily: 'monospace', minWidth: 0 }} />
                  <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>{out.fields.length} campi</span>
                  {duplicateNames.size > 0 && (
                    <span title={`${duplicateNames.size} nome/i duplicato/i — verranno rinominati automaticamente in esecuzione`}
                      style={{ fontSize: 9, color: '#ffb347', display: 'flex', alignItems: 'center', gap: 2, flexShrink: 0 }}>
                      <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
                      {duplicateNames.size}
                    </span>
                  )}
                  <ImportSchemaButton
                      nodeId={nodeId}
                      outputId={out.id}
                      outputFields={out.fields}
                      color={color}
                      onImport={(newFields) => {
                        useFlowStore.setState((s) => ({
                          nodes: updateNode(s.nodes, nodeId, (n) => {
                            const t = n.data.config.tmap as TMapConfig | undefined
                            if (!t) return n
                           return { ...n, data: { ...n.data, config: { ...n.data.config, tmap: {
                            ...t, outputs: t.outputs.map((o) =>
                              o.id === out.id ? { ...o, fields: [...o.fields, ...newFields.map((f) => ({
                                ...f, type: f.type as TMapFieldType , expression: f.expression ?? '',   // ← stringa garantita 
                              }))] } : o
                            )
                            }}}}
                          }),
                        }))
                        setTimeout(() => {
                          const store = useFlowStore.getState()
                          const updatedTmap = store.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined
                          const updatedOut  = updatedTmap?.outputs.find((o) => o.id === out.id)
                          if (!updatedOut) return
                          store.updateNodeProp(nodeId, '_schemaLocked', 'true')
                          store.edges.filter((ed) => ed.source === nodeId && ed.sourceHandle === out.id)
                            .forEach((edge) => {
                              store.updateNodeProp(edge.target, 'incomingSchema', JSON.stringify(
                                updatedOut.fields.filter((f) => f.name.length > 0)
                                  .map((f) => ({ id: f.id, name: f.name, type: f.type as TMapFieldType, physicalName: f.name }))
                              ))
                            })
                        }, 0)
                      }}
                    />
                                      {idx > 0 && (
                    <button onClick={() => deleteTMapOutput(nodeId, out.id)}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: 0, flexShrink: 0 }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                      <i className="ti ti-x" style={{ fontSize: 10 }} />
                    </button>
                  )}
                </>
              }>
              <div style={{ padding: '6px 10px', background: `color-mix(in srgb, ${color} 3%, #0f1117)`, borderBottom: `0.5px solid ${color}20` }}>
                <div style={{ fontSize: 9, color: '#4a5a7a', marginBottom: 3, textTransform: 'uppercase', letterSpacing: '.06em' }}>Filtro routing</div>
                {idx > 1 ? (
                  <input type="text" value={out.filter ?? ''} onChange={(e) => updateTMapOutput(nodeId, out.id, { filter: e.target.value })}
                    style={{ ...iStyle, fontSize: 10 }}
                    placeholder={idx === 0 ? 'default — tutte le righe' : 'es: main.status == "error"'} />
                ) : (
                  <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', padding: '3px 6px', background: '#161b27', borderRadius: 4, border: '0.5px solid #2a3349' }}>
                    {idx === 0 ? 'default — tutte le righe con match' : 'righe senza match dalla join'}
                  </div>
                )}
              </div>
              {out.fields.map((field) => {
                const key       = `${out.id}__${field.id}`
                const isHovered = hoveredHandle === key
                const isDup     = duplicateNames.has(field.name)
                return (
                  <FieldRow key={field.id} fieldKey={key} onHover={onHover}>
                    <div data-handle="true"
                      ref={(el) => { if (el) registerHandle(el as HTMLDivElement, key) }}
                      onMouseEnter={() => setHoveredHandle(key)} onMouseLeave={() => setHoveredHandle(null)}
                      onMouseUp={(e) => { e.stopPropagation(); if (transformDragging) onDropFromTransform(out.id, field.id); else onDrop(out.id, field.id); setHoveredHandle(null) }}
                      style={{ width: 10, height: 10, borderRadius: '50%', background: isHovered ? '#fff' : color, flexShrink: 0, cursor: 'crosshair', border: `2px solid ${isHovered ? color : '#0f1117'}`, transition: 'all .1s' }} />
                    <input value={field.name}
                      onChange={(e) => {
                        updateTMapOutputField(nodeId, out.id, field.id, { name: e.target.value })
                        setTimeout(() => {
                          const store = useFlowStore.getState()
                          const updatedTmap = store.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined
                          const updatedOut  = updatedTmap?.outputs.find((o) => o.id === out.id)
                          if (!updatedOut) return
                          // ← AGGIUNGERE QUESTA RIGA
                          store.updateNodeProp(nodeId, '_schemaLocked', 'true')
                          store.edges.filter((ed) => ed.source === nodeId && ed.sourceHandle === out.id).forEach((edge) => {
                            store.updateNodeProp(edge.target, 'incomingSchema', JSON.stringify(
                              updatedOut.fields.filter((f) => f.name.length > 0).map((f) => ({
                                id: f.id, name: f.name, type: f.type, physicalName: f.name,
                              }))
                            ))
                          })
                        }, 0)
                      }}
                      style={{ background: 'none', border: 'none', outline: 'none', fontSize: 11, flex: 1, fontFamily: 'monospace', minWidth: 0, color: isDup ? '#ff5f57' : color }} />
                    {isDup && (
                      <div title="Nome duplicato — verrà rinominato automaticamente in esecuzione (es: label__Nome)"
                        style={{ color: '#ff5f57', flexShrink: 0, lineHeight: 1 }}>
                        <i className="ti ti-alert-triangle" style={{ fontSize: 10 }} />
                      </div>
                    )}
                    <CustomSelect value={field.type}
                      onChange={(e) => {
                        updateTMapOutputField(nodeId, out.id, field.id, { type: e.target.value as TMapFieldType })
                        setTimeout(() => {
                          const store = useFlowStore.getState()
                          const updatedTmap = store.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined
                          const updatedOut  = updatedTmap?.outputs.find((o) => o.id === out.id)
                          if (!updatedOut) return
                          // ← AGGIUNGERE QUESTA RIGA
                          store.updateNodeProp(nodeId, '_schemaLocked', 'true')
                          store.edges.filter((ed) => ed.source === nodeId && ed.sourceHandle === out.id).forEach((edge) => {
                            store.updateNodeProp(edge.target, 'incomingSchema', JSON.stringify(
                              updatedOut.fields.filter((f) => f.name.length > 0).map((f) => ({
                                id: f.id, name: f.name, type: f.type, physicalName: f.name,
                              }))
                            ))
                          })
                        }, 0)
                      }}
                      style={{
                        ...iStyle,
                        width: 72, padding: '2px 2px', fontSize: 9, flexShrink: 0,
                        color:      TYPE_META[field.type as FieldType]?.color ?? '#9a9aaa',
                        background: TYPE_META[field.type as FieldType]?.bg    ?? '#1e2535',
                        border:     `1px solid ${TYPE_META[field.type as FieldType]?.color ?? '#3a4a6a'}40`,
                      }}>
                      {FIELD_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
                    </CustomSelect>
                    <button onClick={() => {
                        deleteTMapOutputField(nodeId, out.id, field.id)
                        setTimeout(() => {
                          const store = useFlowStore.getState()
                          const updatedTmap = store.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined
                          const updatedOut  = updatedTmap?.outputs.find((o) => o.id === out.id)
                          if (!updatedOut) return

                          // ← AGGIUNGERE QUESTA RIGA
                          store.updateNodeProp(nodeId, '_schemaLocked', 'true')
                          store.edges.filter((ed) => ed.source === nodeId && ed.sourceHandle === out.id).forEach((edge) => {
                            store.updateNodeProp(edge.target, 'incomingSchema', JSON.stringify(
                              updatedOut.fields.filter((f) => f.name.length > 0).map((f) => ({
                                id: f.id, name: f.name, type: f.type, physicalName: f.name,
                              }))
                            ))
                          })
                        }, 0)
                      }}
                      style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px', flexShrink: 0 }}
                      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
                      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
                      <i className="ti ti-x" style={{ fontSize: 10 }} />
                    </button>
                  </FieldRow>
                )
              })}
              {out.fields.length === 0 && (
                <div style={{ padding: '10px 12px', fontSize: 10, color: '#2a3349', fontStyle: 'italic', textAlign: 'center' }}>Nessun campo — trascina un campo qui</div>
              )}
              <AddFieldRow color={color} label="aggiungi campo" onClick={() => addTMapOutputField(nodeId, out.id)} />
            </FlowCard>
          )
        })}
      </div>
    </div>
  )
}

// ─── ConnectionsOverlay ───────────────────────────────────────────
function ConnectionsOverlay({ connections, dragging, onRemove, tick, transforms, tmap, transformDragging, hoveredFieldKey }: {
  connections: TMapConnection[]; dragging: { fromKey: string; x: number; y: number; color: string } | null
  onRemove: (connId: string) => void; tick: number; transforms: TMapTransformNode[]
  tmap: TMapConfig | undefined; transformDragging: { transformId: string; x: number; y: number } | null
  hoveredFieldKey: string | null
}) {
  const [hoveredId, setHoveredId] = useState<string | null>(null)
  const makePath = (x1: number, y1: number, x2: number, y2: number) => { const cx = (x1 + x2) / 2; return `M ${x1} ${y1} C ${cx} ${y1} ${cx} ${y2} ${x2} ${y2}` }
  const isHighlighted = (conn: TMapConnection) => {
    if (!hoveredFieldKey) return false
    const inputKey  = conn.inputId.startsWith('transform__') ? conn.inputId.replace('transform__', '') : `${conn.inputId}__${conn.fieldName}`
    const outputKey = `${conn.outputId}__${conn.fieldId}`
    return hoveredFieldKey === inputKey || hoveredFieldKey === outputKey
  }
  return (
    <svg style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 8, overflow: 'visible' }} width="100%" height="100%">
      {connections.map((conn) => {
        let from: { x: number; y: number } | undefined
        if (conn.inputId.startsWith('transform__')) from = transformOutputHandleRefs.get(conn.inputId.replace('transform__', ''))
        else from = inputHandleRefs.get(conn.inputId + '__' + conn.fieldName)
        const to = outputHandleRefs.get(conn.outputId + '__' + conn.fieldId); if (!from || !to) return null
        const d = makePath(from.x, from.y, to.x, to.y); const isHov = hoveredId === conn.id; const isHilit = isHighlighted(conn)
        const stroke = isHov ? '#ff5f57' : isHilit ? '#3ddc84' : conn.color; const strokeW = isHov || isHilit ? 2 : 1; const strokeOp = isHov ? 1 : isHilit ? 0.9 : 0.25
        return (
          <g key={conn.id} style={{ pointerEvents: 'all' }}>
            <path d={d} fill="none" stroke="transparent" strokeWidth={12} style={{ pointerEvents: 'all', cursor: 'pointer' }}
              onMouseEnter={() => setHoveredId(conn.id)} onMouseLeave={() => setHoveredId(null)} onClick={() => onRemove(conn.id)} />
            <path d={d} fill="none" stroke={stroke} strokeDasharray={conn.inputId.startsWith('transform__') ? '5 3' : undefined} strokeWidth={strokeW} strokeOpacity={strokeOp} style={{ pointerEvents: 'none' }} />
            {isHov && (() => { const mx = (from.x + to.x) / 2; const my = (from.y + to.y) / 2; return (<g style={{ pointerEvents: 'none' }}><circle cx={mx} cy={my} r={8} fill="#ff5f57" /><text x={mx} y={my + 4} textAnchor="middle" fontSize={10} fill="#fff" fontWeight="bold">×</text></g>) })()}
          </g>
        )
      })}
      {transforms.flatMap((tr) => tr.inputs.map((inp, i) => {
        const from = inputHandleRefs.get(`${inp.inputId}__${inp.fieldName}`); const to = transformInputHandleRefs.get(`${tr.id}__in__${i}`); if (!from || !to) return null
        const inpColor = tmap ? getInputColor(tmap, inp.inputId) : '#4a5a7a'; const isHilit = hoveredFieldKey === `${inp.inputId}__${inp.fieldName}`
        return (<path key={`${tr.id}__${inp.inputId}__${inp.fieldName}__${i}`} d={makePath(from.x, from.y, to.x, to.y)} fill="none" stroke={isHilit ? '#3ddc84' : inpColor} strokeWidth={isHilit ? 2 : 1} strokeOpacity={isHilit ? 0.9 : 0.25} strokeDasharray="5 3" />)
      }))}
      {dragging && (() => { const from = inputHandleRefs.get(dragging.fromKey); if (!from) return null; return <path d={makePath(from.x, from.y, dragging.x, dragging.y)} fill="none" stroke={dragging.color} strokeWidth={1.5} strokeOpacity={0.5} strokeDasharray="4 3" /> })()}
      {transformDragging && (() => { const from = transformOutputHandleRefs.get(transformDragging.transformId); if (!from) return null; return <path d={makePath(from.x, from.y, transformDragging.x, transformDragging.y)} fill="none" stroke="#a78bfa" strokeWidth={1.5} strokeOpacity={0.6} strokeDasharray="4 3" /> })()}
    </svg>
  )
}

// ─── CenterZone ───────────────────────────────────────────────────
function CenterZone({ nodeId, width, height, onDropTransform, onAddInputToTransform, onRemoveInputFromTransform, onTransformDragStart, transformDragging, dragging, containerRef }: {
  nodeId: string; width: number; height: number
  onDropTransform: (x: number, y: number) => void; onAddInputToTransform: (transformId: string) => void
  onRemoveInputFromTransform: (transformId: string, inputIndex: number) => void
  onTransformDragStart: (transformId: string, x: number, y: number) => void
  transformDragging: { transformId: string; x: number; y: number } | null
  dragging: { fromKey: string; inputId: string; fieldName: string; color: string; x: number; y: number } | null
  containerRef: React.RefObject<HTMLDivElement | null>
}) {
  const storeNode = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateTMapTransform = useFlowStore((s) => s.updateTMapTransform); const deleteTMapTransform = useFlowStore((s) => s.deleteTMapTransform)
  const tmap = storeNode?.data.config?.tmap as TMapConfig | undefined; const transforms = tmap?.transforms ?? []
  const [hoveredHandle, setHoveredHandle] = useState<string | null>(null)

  return (
    <div style={{ width, height, position: 'relative', background: '#0f1117', overflow: 'auto' }}
      onMouseUp={(e) => { if (!dragging) return; const rect = (e.currentTarget as HTMLElement).getBoundingClientRect(); onDropTransform(e.clientX - rect.left, e.clientY - rect.top) }}>
      <div style={{ position: 'sticky', top: 0, fontSize: 9, fontWeight: 600, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: '.08em', background: '#0f1117', padding: '6px 10px', borderBottom: '0.5px solid #2a3349', zIndex: 2, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span>Trasformazioni</span>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {dragging && <span style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic', fontWeight: 400 }}>rilascia qui per creare una trasformazione</span>}
          <button
            onClick={() => {
              const newId = `transform_${Date.now()}`
              useFlowStore.getState().addTMapTransform(nodeId, {
                id:         newId,
                label:      `campo_${Math.random().toString(36).slice(2, 5)}`,
                mode:       'inline',
                inputs:     [],
                expression: '',
                outputName: `campo_${Math.random().toString(36).slice(2, 5)}`,
                outputType: 'string',
              })
            }}
            style={{ background: 'none', border: '0.5px dashed #a78bfa60', borderRadius: 4, padding: '2px 8px', fontSize: 9, color: '#a78bfa', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 3, fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#a78bfa' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#a78bfa60' }}>
            <i className="ti ti-plus" style={{ fontSize: 9 }} /> campo
          </button>
        </div>
      </div>
      {transforms.length === 0 && !dragging && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', fontSize: 11, color: '#2a3349', textAlign: 'center', pointerEvents: 'none' }}>
          <i className="ti ti-drag-drop" style={{ fontSize: 24, display: 'block', marginBottom: 6 }} />Trascina un campo qui
        </div>
      )}
      <div style={{ padding: '8px 6px', display: 'flex', flexDirection: 'column', gap: 4, position: 'relative', zIndex: 15 }}>
        {transforms.map((tr) => {
          const inputVars  = tr.inputs.map((inp) => { const lbl = tmap?.inputs.find((ti) => ti.id === inp.inputId)?.label ?? inp.inputId; return `$${lbl}.${inp.fieldName}` })
          const inputType  = (tmap?.inputs.find((i) => i.id === tr.inputs[0]?.inputId)?.fields.find((f) => f.name === tr.inputs[0]?.fieldName)?.type ?? 'string') as TransformCategory
          const inputTypes = tr.inputs.map((inp) => {
            const field = tmap?.inputs
              .find(i => i.id === inp.inputId)?.fields
              .find(f => f.name === inp.fieldName)
              return (field?.type ?? 'any') as TransformCategory
          })
          const inputColor2 = tr.inputs.length > 0 ? getInputColor(tmap!, tr.inputs[0].inputId) : '#4a5a7a'
          return (
            <div key={tr.id}
              style={{ display: 'flex', alignItems: 'flex-start', gap: 4, background: '#1a2030', border: `1px solid color-mix(in srgb, ${inputColor2} 30%, #2a3349)`, borderRadius: 6, padding: '3px 6px', position: 'relative' }}
              onMouseUp={(e) => { e.stopPropagation(); if (!dragging) return; onAddInputToTransform(tr.id) }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3, flexShrink: 0, paddingTop: 4 }}>
                {tr.inputs.map((inp, i) => {
                  const inpColor = tmap ? getInputColor(tmap, inp.inputId) : '#4a5a7a'
                  const handleKey = `${tr.id}__in__${i}`; const isHov = hoveredHandle === handleKey
                  return (
                    <div key={i}
                      ref={(el) => { if (!el || !containerRef.current) return; const cr = containerRef.current.getBoundingClientRect(); const er = el.getBoundingClientRect(); transformInputHandleRefs.set(handleKey, { x: er.left + er.width / 2 - cr.left, y: er.top + er.height / 2 - cr.top }) }}
                      onMouseEnter={() => setHoveredHandle(handleKey)} onMouseLeave={() => setHoveredHandle(null)}
                      onClick={(e) => { e.stopPropagation(); onRemoveInputFromTransform(tr.id, i) }}
                      style={{ width: 8, height: 8, borderRadius: '50%', background: isHov ? '#ff5f57' : inpColor, border: `2px solid ${isHov ? '#ff5f57' : '#0f1117'}`, flexShrink: 0, cursor: isHov ? 'pointer' : 'default', transition: 'all .1s' }}
                      title={isHov ? `Rimuovi ${inp.fieldName}` : `${inp.inputId}.${inp.fieldName}`} />
                  )
                })}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <FieldTransformEditor
                  value={{ mode: tr.mode as 'inline' | 'script', inputs: tr.inputs ?? [], pipeline: tr.pipeline, cast: tr.cast, expression: tr.expression ?? '', finalFn: (tr as any).finalFn, finalParams: (tr as any).finalParams, outputType: tr.outputType, outputName: tr.outputName, collapsed: (tr as any).collapsed }}
                  inputType={inputType} inputVars={inputVars}
                  inputTypes={inputTypes}
                  onChange={(val) => {
                    const oldOutputName = tr.outputName
                    const newOutputName = val.outputName

                    updateTMapTransform(nodeId, tr.id, {
                      mode:        val.mode,
                      inputs:      val.inputs,
                      pipeline:    val.pipeline,
                      cast:        val.cast,
                      expression:  val.expression,
                      finalFn:     val.finalFn,
                      finalParams: val.finalParams,
                      outputType:  val.outputType,
                      outputName:  val.outputName,
                      collapsed:   val.collapsed,
                    } as any)

                    // Se outputName è cambiato, aggiorna tutti i campi output
                    // che referenziano il vecchio nome
                    if (newOutputName !== oldOutputName && tmap) {
                      const updatedOutputs = tmap.outputs.map(out => ({
                        ...out,
                        fields: out.fields.map(f =>
                          f.expression === oldOutputName
                            ? { ...f, expression: newOutputName }
                            : f
                        ),
                      }))
                      useFlowStore.setState(s => ({
                        nodes: updateNode(s.nodes, nodeId, n => {
                          const t = n.data.config.tmap as TMapConfig | undefined
                          if (!t) return n
                          return {
                            ...n,
                            data: {
                              ...n.data,
                              config: { ...n.data.config, tmap: { ...t, outputs: updatedOutputs } },
                            },
                          }
                        }),
                      }))
                    }
                  }}
                  onDelete={() => { deleteTMapTransform(nodeId, tr.id); const store = useFlowStore.getState(); const cur = (store.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined)?.connections ?? []; store.setTMapConnections(nodeId, cur.filter((c) => c.inputId !== `transform__${tr.id}`)) }}
                  onDragStart={() => { const hp = transformOutputHandleRefs.get(tr.id); if (!hp) return; onTransformDragStart(tr.id, hp.x, hp.y) }}
                  isDragging={transformDragging?.transformId === tr.id} containerRef={containerRef} transformId={tr.id}
                  onRegisterOutputHandle={(el) => { if (!el || !containerRef.current) return; const cr = containerRef.current.getBoundingClientRect(); const er = el.getBoundingClientRect(); transformOutputHandleRefs.set(tr.id, { x: er.right - cr.left, y: er.top + er.height / 2 - cr.top }) }}
                />
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ─── TMapLayout ───────────────────────────────────────────────────
function TMapLayout({ nodeId }: { nodeId: string }) {
  const storeNode             = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateTMapOutputField = useFlowStore((s) => s.updateTMapOutputField)
  const updateTMapInput       = useFlowStore((s) => s.updateTMapInput)
  const setTMapConnections    = useFlowStore((s) => s.setTMapConnections)
  const tmap                  = storeNode?.data.config?.tmap as TMapConfig | undefined

  const containerRef    = useRef<HTMLDivElement>(null)
  const centerRef       = useRef<HTMLDivElement>(null)
  const inputScrollRef  = useRef<HTMLDivElement>(null)
  const outputScrollRef = useRef<HTMLDivElement>(null)

  const [centerSize, setCenterSize]           = useState({ width: 0, height: 0 })
  const [inputColWidth,  setInputColWidth]    = useState(270)
  const [outputColWidth, setOutputColWidth]   = useState(250)
  const connections = (storeNode?.data.config?.tmap as TMapConfig | undefined)?.connections ?? []
  const [tick, setTick]                       = useState(0)
  const [hoveredFieldKey, setHoveredFieldKey] = useState<string | null>(null)
  const [editingLookup, setEditingLookup]     = useState<TMapConfig['inputs'][0] | null>(null)
  // Coppie in anteprima dalla modal aperta — aggiornate in tempo reale
  const [previewPairs, setPreviewPairs]       = useState<{ dstInputId: string; pairs: JoinPair[] } | null>(null)

  const [dragging, setDragging]               = useState<{ fromKey: string; inputId: string; fieldName: string; color: string; x: number; y: number } | null>(null)
  const [transformDragging, setTransformDragging] = useState<{ transformId: string; x: number; y: number } | null>(null)
  const [draggingJoin, setDraggingJoin]       = useState<{ fromKey: string; inputId: string; fieldName: string; color: string; x: number; y: number } | null>(null)

  // Resize colonna sinistra
  const resizingLeft = useRef(false)
  const onColLeftResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); resizingLeft.current = true
    const startX = e.clientX; const startW = inputColWidth
    const onMove = (ev: MouseEvent) => { if (!resizingLeft.current) return; setInputColWidth(Math.max(200, Math.min(500, startW + ev.clientX - startX))); setTick((n) => n + 1) }
    const onUp   = () => { resizingLeft.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [inputColWidth])

  // Resize colonna destra
  const resizingRight = useRef(false)
  const onColRightResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); resizingRight.current = true
    const startX = e.clientX; const startW = outputColWidth
    const onMove = (ev: MouseEvent) => { if (!resizingRight.current) return; setOutputColWidth(Math.max(200, Math.min(500, startW - (ev.clientX - startX)))); setTick((n) => n + 1) }
    const onUp   = () => { resizingRight.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [outputColWidth])

  useEffect(() => { const t = setTimeout(() => setTick((n) => n + 1), 100); return () => clearTimeout(t) }, [])

  useEffect(() => {
    const el = centerRef.current; if (!el) return
    const ro = new ResizeObserver(() => { const r = el.getBoundingClientRect(); if (r.width > 0 && r.height > 0) setCenterSize({ width: Math.round(r.width), height: Math.round(r.height) }) })
    ro.observe(el); return () => ro.disconnect()
  }, [])

  useEffect(() => {
    const onScroll = () => setTick((n) => n + 1)
    const inputEl = inputScrollRef.current; const outputEl = outputScrollRef.current
    inputEl?.addEventListener('scroll', onScroll, { passive: true }); outputEl?.addEventListener('scroll', onScroll, { passive: true })
    return () => { inputEl?.removeEventListener('scroll', onScroll); outputEl?.removeEventListener('scroll', onScroll) }
  }, [])

  useEffect(() => {
    if (!dragging) return
    const onMove = (e: MouseEvent) => { const cr = containerRef.current?.getBoundingClientRect(); if (!cr) return; setDragging((d) => d ? { ...d, x: e.clientX - cr.left, y: e.clientY - cr.top } : null) }
    const onUp = () => setDragging(null)
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [!!dragging])

  useEffect(() => {
    if (!transformDragging) return
    const onMove = (e: MouseEvent) => { const cr = containerRef.current?.getBoundingClientRect(); if (!cr) return; setTransformDragging((d) => d ? { ...d, x: e.clientX - cr.left, y: e.clientY - cr.top } : null) }
    const onUp = () => { setTimeout(() => setTransformDragging(null), 10) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [!!transformDragging])

  // Drag join — qualsiasi flusso → qualsiasi flusso (no vincoli su isMain)
  useEffect(() => {
    if (!draggingJoin) return
    const onMove = (e: MouseEvent) => { const cr = containerRef.current?.getBoundingClientRect(); if (!cr) return; setDraggingJoin((d) => d ? { ...d, x: e.clientX - cr.left, y: e.clientY - cr.top } : null) }
    const onUp = (e: MouseEvent) => {
      const el = document.elementFromPoint(e.clientX, e.clientY)
      const handleEl = el?.closest('[data-join-handle]') as HTMLElement | null
      if (handleEl && draggingJoin && handleEl.dataset.joinInputId !== draggingJoin.inputId) {
        const tgtInputId = handleEl.dataset.joinInputId!
        const tgtField   = handleEl.dataset.joinField!
        if (tmap) addJoinPair(draggingJoin.inputId, draggingJoin.fieldName, draggingJoin.color, tgtInputId, tgtField)
      }
      setDraggingJoin(null)
    }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [!!draggingJoin, draggingJoin?.fromKey, tmap])

  // Aggiunge una coppia join — il flusso destinatario riceve la coppia
  // Nessun vincolo su isMain: lookup2 → lookup3 è valido
  const handleDeletePair = useCallback((dstInputId: string, pairId: string) => {
    if (!tmap) return
    const dstInp = tmap.inputs.find((i) => i.id === dstInputId); if (!dstInp) return
    const existing: JoinPair[] = (dstInp as any).joinPairs ?? []
    updateTMapInput(nodeId, dstInputId, { joinPairs: existing.filter((p) => p.id !== pairId) } as any)
    // Se la modal è aperta sullo stesso lookup, aggiorna anche il preview
    if (editingLookup?.id === dstInputId) {
      setPreviewPairs((pp) => pp ? { ...pp, pairs: pp.pairs.filter((p) => p.id !== pairId) } : null)
    }
  }, [tmap, nodeId, updateTMapInput, editingLookup])

  const openEditLookup = useCallback((inp: TMapConfig['inputs'][0]) => {
    setEditingLookup(inp)
    setPreviewPairs({ dstInputId: inp.id, pairs: (inp as any).joinPairs ?? [] })
  }, [])

  const closeEditLookup = useCallback(() => {
    setEditingLookup(null)
    setPreviewPairs(null)
  }, [])

  const addJoinPair = useCallback((srcInputId: string, srcField: string, srcColor: string, dstInputId: string, dstField: string) => {
    if (!tmap) return

  // ── Normalizzazione direzione drag ──────────────────────────────
    // La pair vive sempre nell'input con indice maggiore (più in basso
    // nella lista = "detail" relativo). Il sorgente è sempre l'input
    // con indice minore (più in alto = "master" relativo).
    // Questo vale sia per main→lookup che per lookup→lookup.
    const srcIdx = tmap.inputs.findIndex((i) => i.id === srcInputId)
    const dstIdx = tmap.inputs.findIndex((i) => i.id === dstInputId)
    if (srcIdx === -1 || dstIdx === -1) return

    // Se src sta SOTTO dst (indice maggiore) → inverti
    const shouldSwap = srcIdx > dstIdx
    const realSrcInputId = shouldSwap ? dstInputId : srcInputId
    const realSrcField   = shouldSwap ? dstField   : srcField
    const realSrcColor   = shouldSwap ? getInputColor(tmap, dstInputId) : srcColor
    const realDstInputId = shouldSwap ? srcInputId : dstInputId
    const realDstField   = shouldSwap ? srcField   : dstField

    const realDstInp = tmap.inputs.find((i) => i.id === realDstInputId)
    if (!realDstInp) return

    const newPair: JoinPair = {
      id: `jp_${Date.now()}`,
      srcColor:    realSrcColor,
      srcInputId:  realSrcInputId,
      srcFields:   [{ id: `jf_${Date.now()}`,     field: realSrcField, fn: 'none', arg1: '', arg2: '' }],
      combineExpr: '',
      dstFields:   [{ id: `jf_${Date.now() + 1}`, field: realDstField, fn: 'none', arg1: '', arg2: '' }],
      dstCombineExpr: '',
    }

    const existing: JoinPair[] = (realDstInp as any).joinPairs ?? []
    updateTMapInput(nodeId, realDstInputId, { joinPairs: [...existing, newPair] } as any)
  }, [tmap, nodeId, updateTMapInput])

  useEffect(() => {
    const validInputKeys  = new Set(tmap?.inputs.flatMap((inp) => inp.fields.map((f) => `${inp.id}__${f.name}`)) ?? [])
    const validOutputKeys = new Set(tmap?.outputs.flatMap((out) => out.fields.map((f) => `${out.id}__${f.id}`)) ?? [])
    inputHandleRefs.forEach((_, key)  => { if (!validInputKeys.has(key))  inputHandleRefs.delete(key) })
    outputHandleRefs.forEach((_, key) => { if (!validOutputKeys.has(key)) outputHandleRefs.delete(key) })
  }, [tmap?.inputs, tmap?.outputs])

  const handleRemoveConnection = useCallback((connId: string) => { setTMapConnections(nodeId, connections.filter((c) => c.id !== connId)) }, [connections, nodeId, setTMapConnections])
  const handleDragStart        = useCallback((key: string, inputId: string, fieldName: string, color: string) => { const hp = inputHandleRefs.get(key); if (!hp) return; setDragging({ fromKey: key, inputId, fieldName, color, x: hp.x, y: hp.y }) }, [])
  const handleJoinDragStart    = useCallback((key: string, inputId: string, fieldName: string, color: string) => { const hp = joinHandleRefs.get(key); if (!hp) return; setDraggingJoin({ fromKey: key, inputId, fieldName, color, x: hp.x, y: hp.y }) }, [])
  const handleTransformDragStart = useCallback((transformId: string, x: number, y: number) => { setTransformDragging({ transformId, x, y }) }, [])

  const handleDrop = useCallback((outputId: string, fieldId: string) => {
    if (!dragging) return
    const inputLabel = tmap?.inputs.find((i) => i.id === dragging.inputId)?.label ?? 'input'
    updateTMapOutputField(nodeId, outputId, fieldId, { expression: `${inputLabel}.${dragging.fieldName}`, sourceInputId: dragging.inputId, sourceFieldName: dragging.fieldName })
    setTMapConnections(nodeId, [...connections.filter((c) => !(c.outputId === outputId && c.fieldId === fieldId)), { id: `${dragging.inputId}__${dragging.fieldName}__${outputId}__${fieldId}`, inputId: dragging.inputId, fieldName: dragging.fieldName, outputId, fieldId, color: dragging.color }])
    setDragging(null)
  }, [dragging, nodeId, tmap, connections, updateTMapOutputField, setTMapConnections])

  const handleDropFromTransform = useCallback((outputId: string, fieldId: string) => {
    if (!transformDragging) return; const tr = tmap?.transforms?.find((t) => t.id === transformDragging.transformId); if (!tr) return
    updateTMapOutputField(nodeId, outputId, fieldId, { expression: tr.outputName, sourceInputId: tr.inputs[0]?.inputId ?? '', sourceFieldName: tr.outputName })
    setTMapConnections(nodeId, [...connections.filter((c) => !(c.outputId === outputId && c.fieldId === fieldId)), { id: `${transformDragging.transformId}__${outputId}__${fieldId}`, inputId: `transform__${transformDragging.transformId}`, fieldName: tr.outputName, outputId, fieldId, color: '#a78bfa' }])
    setTransformDragging(null)
  }, [transformDragging, nodeId, tmap, connections, updateTMapOutputField, setTMapConnections])

  const handleDropOnOutput = useCallback((outputId: string) => {
    if (!dragging) return
    const newFieldId = `field_${Date.now()}`; const inputLabel = tmap?.inputs.find((i) => i.id === dragging.inputId)?.label ?? 'input'; const fieldType = tmap?.inputs.find((i) => i.id === dragging.inputId)?.fields.find((f) => f.name === dragging.fieldName)?.type ?? 'string'
    useFlowStore.setState((s) => ({ nodes: updateNode(s.nodes, nodeId, (n) => { const t = n.data.config.tmap as TMapConfig | undefined; if (!t) return n; return { ...n, data: { ...n.data, config: { ...n.data.config, tmap: { ...t, outputs: t.outputs.map((o) => o.id === outputId ? { ...o, fields: [...o.fields, { id: newFieldId, name: dragging.fieldName, type: fieldType, expression: `${inputLabel}.${dragging.fieldName}` }] } : o) } } } } }) }))
    setTimeout(() => { const s2 = useFlowStore.getState(); const cur = (s2.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined)?.connections ?? []; s2.setTMapConnections(nodeId, [...cur, { id: `${dragging.inputId}__${dragging.fieldName}__${outputId}__${newFieldId}`, inputId: dragging.inputId, fieldName: dragging.fieldName, outputId, fieldId: newFieldId, color: dragging.color }]) }, 50)
    setDragging(null)
  }, [dragging, nodeId, tmap, setTMapConnections])

  const handleDropFromTransformOnOutput = useCallback((outputId: string) => {
    if (!transformDragging) return; const tr = tmap?.transforms?.find((t) => t.id === transformDragging.transformId); if (!tr) return
    const newFieldId = `field_${Date.now()}`
    useFlowStore.setState((s) => ({ nodes: updateNode(s.nodes, nodeId, (n) => { const t = n.data.config.tmap as TMapConfig | undefined; if (!t) return n; return { ...n, data: { ...n.data, config: { ...n.data.config, tmap: { ...t, outputs: t.outputs.map((o) => o.id === outputId ? { ...o, fields: [...o.fields, { id: newFieldId, name: tr.outputName, type: tr.outputType, expression: tr.outputName }] } : o) } } } } }) }))
    setTimeout(() => { const s2 = useFlowStore.getState(); const cur = (s2.nodes.find((n) => n.id === nodeId)?.data.config?.tmap as TMapConfig | undefined)?.connections ?? []; s2.setTMapConnections(nodeId, [...cur, { id: `${transformDragging.transformId}__${outputId}__${newFieldId}`, inputId: `transform__${transformDragging.transformId}`, fieldName: tr.outputName, outputId, fieldId: newFieldId, color: '#a78bfa' }]) }, 50)
    setTransformDragging(null)
  }, [transformDragging, nodeId, tmap, setTMapConnections])

  const handleDropTransform = useCallback((_x: number, _y: number) => {
    if (!dragging) return
    const newId = `transform_${Date.now()}`; const fieldType = tmap?.inputs.find((i) => i.id === dragging.inputId)?.fields.find((f) => f.name === dragging.fieldName)?.type ?? 'string'
    const varName = `$${tmap?.inputs.find((i) => i.id === dragging.inputId)?.label ?? dragging.inputId}.${dragging.fieldName}`
    useFlowStore.getState().addTMapTransform(nodeId, { id: newId, label: `trasf_${Math.random().toString(36).slice(2, 5)}`, mode: 'inline', inputs: [{ inputId: dragging.inputId, fieldName: dragging.fieldName }], expression: varName, outputName: dragging.fieldName, outputType: fieldType as TMapFieldType })
    setDragging(null)
  }, [dragging, nodeId, tmap])

  const handleAddInputToTransform = useCallback((transformId: string) => {
    if (!dragging) return; const tr = tmap?.transforms?.find((t) => t.id === transformId); if (!tr) return
    if (tr.inputs.some((i) => i.inputId === dragging.inputId && i.fieldName === dragging.fieldName)) { setDragging(null); return }
    const newInputs = [...tr.inputs, { inputId: dragging.inputId, fieldName: dragging.fieldName }]
    const inputLabel = tmap?.inputs.find((i) => i.id === dragging.inputId)?.label ?? dragging.inputId; const newVar = `$${inputLabel}.${dragging.fieldName}`; const sep = tr.mode === 'script' ? '\n' : ' + '
    // Costruisce sempre l'espressione con tutti i campi quando è vuota o auto
    const autoExpr = newInputs.map((inp) => {
      const lbl = tmap?.inputs.find((ti) => ti.id === inp.inputId)?.label ?? inp.inputId
      return `$${lbl}.${inp.fieldName}`
    }).join(sep)
    const newExpression = (!tr.expression.trim() || tr.expression.trim() === '$1')
      ? autoExpr
      : tr.expression + sep + newVar
    useFlowStore.getState().updateTMapTransform(nodeId, transformId, { inputs: newInputs, expression: newExpression }); setDragging(null)
  }, [dragging, nodeId, tmap])

  const handleRemoveInputFromTransform = useCallback((transformId: string, inputIndex: number) => {
    const tr = tmap?.transforms?.find((t) => t.id === transformId); if (!tr) return
    const removedInput = tr.inputs[inputIndex]; if (!removedInput) return
    const newInputs = tr.inputs.filter((_, i) => i !== inputIndex); const inputLabel = tmap?.inputs.find((i) => i.id === removedInput.inputId)?.label ?? removedInput.inputId
    const removedVar = `$${inputLabel}.${removedInput.fieldName}`; const sep = tr.mode === 'script' ? '\n' : ' + '
    let newExpression = tr.expression.split(sep).map((p) => p.trim()).filter((p) => p !== removedVar).join(sep).trim()
    if (newExpression === '' && newInputs.length > 0) newExpression = newInputs.map((inp) => { const lbl = tmap?.inputs.find((ti) => ti.id === inp.inputId)?.label ?? inp.inputId; return `$${lbl}.${inp.fieldName}` }).join(sep)
    useFlowStore.getState().updateTMapTransform(nodeId, transformId, { inputs: newInputs, expression: newExpression })
  }, [nodeId, tmap])

  if (!tmap) return <div style={{ color: '#4a5a7a', padding: 20, fontSize: 12 }}>Nessun TMap configurato.</div>

  return (
    <div ref={containerRef} style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
      <ConnectionsOverlay connections={connections} dragging={dragging} onRemove={handleRemoveConnection}
        tick={tick} transforms={tmap?.transforms ?? []} tmap={tmap} transformDragging={transformDragging} hoveredFieldKey={hoveredFieldKey} />

      <InputColumn nodeId={nodeId} tmap={tmap} containerRef={containerRef}
        onDragStart={handleDragStart} onHover={setHoveredFieldKey} scrollRef={inputScrollRef}
        onJoinDragStart={handleJoinDragStart} draggingJoin={draggingJoin} tick={tick}
        width={inputColWidth} onEditLookup={openEditLookup}
        onDeletePair={handleDeletePair} previewPairs={previewPairs} />

      <div onMouseDown={onColLeftResizeStart}
        style={{ width: 5, flexShrink: 0, cursor: 'ew-resize', background: 'color-mix(in srgb, #4a9eff 10%, #0f1117)', transition: 'background .15s', zIndex: 20 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, #4a9eff 30%, #0f1117)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, #4a9eff 10%, #0f1117)' }}>
        <div style={{ width: 1, height: '100%', margin: '0 auto', background: 'color-mix(in srgb, #4a9eff 20%, transparent)' }} />
      </div>

      <div ref={centerRef} style={{ flex: 1, minWidth: 0, position: 'relative' }}>
        {centerSize.width > 0 && centerSize.height > 0 && (
          <CenterZone nodeId={nodeId} width={centerSize.width} height={centerSize.height}
            onDropTransform={handleDropTransform} onAddInputToTransform={handleAddInputToTransform}
            onRemoveInputFromTransform={handleRemoveInputFromTransform} onTransformDragStart={handleTransformDragStart}
            transformDragging={transformDragging} dragging={dragging} containerRef={containerRef} />
        )}
      </div>

      <div onMouseDown={onColRightResizeStart}
        style={{ width: 5, flexShrink: 0, cursor: 'ew-resize', background: 'color-mix(in srgb, #3ddc84 10%, #0f1117)', transition: 'background .15s', zIndex: 20 }}
        onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, #3ddc84 30%, #0f1117)' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, #3ddc84 10%, #0f1117)' }}>
        <div style={{ width: 1, height: '100%', margin: '0 auto', background: 'color-mix(in srgb, #3ddc84 20%, transparent)' }} />
      </div>

      <OutputColumn nodeId={nodeId} tmap={tmap} containerRef={containerRef}
        onDrop={handleDrop} onDropOnOutput={handleDropOnOutput} onDropFromTransform={handleDropFromTransform}
        onDropFromTransformOnOutput={handleDropFromTransformOnOutput} transformDragging={transformDragging}
        onHover={setHoveredFieldKey} scrollRef={outputScrollRef} width={outputColWidth} />

      {editingLookup && tmap && (
        <JoinConfigModal inp={editingLookup} tmap={tmap} nodeId={nodeId}
          onClose={closeEditLookup}
          onPairsChange={(pairs) => setPreviewPairs({ dstInputId: editingLookup.id, pairs })} />
      )}
    </div>
  )
}

// ─── useDraggable ─────────────────────────────────────────────────
function useDraggable() {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null)
  const dragging = useRef(false); const offset = useRef({ x: 0, y: 0 }); const ref = useRef<HTMLDivElement>(null)
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('button')) return
    dragging.current = true; const rect = ref.current?.getBoundingClientRect(); if (!rect) return
    offset.current = { x: e.clientX - rect.left, y: e.clientY - rect.top }; e.preventDefault()
  }, [])
  const reset = useCallback(() => setPos(null), [])
  useEffect(() => {
    const onMove = (e: MouseEvent) => { if (!dragging.current) return; setPos({ x: e.clientX - offset.current.x, y: e.clientY - offset.current.y }) }
    const onUp = () => { dragging.current = false }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])
  return { ref, pos, onMouseDown, reset }
}

// ─── TMapModal ────────────────────────────────────────────────────
type Tab = 'general' | 'mapping' | 'advanced'

export function TMapModal({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
  const node = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const [activeTab, setActiveTab]     = useState<Tab>('mapping')
  const [isMaximized, setIsMaximized] = useState(false)
  const [modalWidth, setModalWidth]   = useState<number | null>(null)
  const resizingRef = useRef(false); const startXRef = useRef(0); const startWidthRef = useRef(0)
  const modalRef = useRef<HTMLDivElement>(null)
  const { ref: dragRef, pos, onMouseDown, reset: resetDrag } = useDraggable()

  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); e.stopPropagation(); resizingRef.current = true; startXRef.current = e.clientX
    startWidthRef.current = modalRef.current?.getBoundingClientRect().width ?? 900
    const onMove = (ev: MouseEvent) => { if (!resizingRef.current) return; setModalWidth(Math.round(Math.max(600, Math.min(window.innerWidth - 48, startWidthRef.current + ev.clientX - startXRef.current)))) }
    const onUp   = () => { resizingRef.current = false; window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
    window.addEventListener('mousemove', onMove); window.addEventListener('mouseup', onUp)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', handler); return () => document.removeEventListener('keydown', handler)
  }, [onClose])
useEffect(() => {
  return () => {
    inputHandleRefs.clear()
    outputHandleRefs.clear()
    joinHandleRefs.clear()
    transformInputHandleRefs.clear()
    transformOutputHandleRefs.clear()
  }
}, [])
  const TABS: { id: Tab; label: string; icon: string }[] = [
    { id: 'general',  label: 'Generale',      icon: 'ti-info-circle' },
    { id: 'mapping',  label: 'Configurazione', icon: 'ti-adjustments' },
    { id: 'advanced', label: 'Avanzate',       icon: 'ti-settings-2' },
  ]

  return createPortal(
    <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: pos ? 'flex-start' : 'center', justifyContent: 'center', zIndex: 20000, padding: 24, pointerEvents: 'none' }}>
      <div
        ref={(el) => { dragRef.current = el; (modalRef as React.MutableRefObject<HTMLDivElement | null>).current = el }}
        onClick={(e) => e.stopPropagation()}
        style={{
          pointerEvents: 'all', background: '#161b27', border: '1px solid #3a4a6a', borderRadius: isMaximized ? 0 : 10,
          width: modalWidth ? `${modalWidth}px` : '90%', maxWidth: isMaximized ? '100vw' : modalWidth ? 'none' : 1200,
          maxHeight: isMaximized ? '100vh' : '90vh', display: 'flex', flexDirection: 'column', overflow: 'hidden',
          boxShadow: '0 24px 64px rgba(0,0,0,.8), 0 0 0 1px #2a3349', position: 'relative',
          ...(pos && !isMaximized ? { position: 'fixed' as const, left: pos.x, top: pos.y } : {}),
          ...(isMaximized ? { position: 'fixed' as const, inset: 0 } : {}),
        }}>
        <div onMouseDown={onMouseDown} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '12px 16px', borderBottom: '1px solid #2a3349', background: '#1a2030', flexShrink: 0, cursor: 'grab', userSelect: 'none' }}>
          <span style={{ fontSize: 20, color: '#a78bfa' }}>⇌</span>
          <div>
            <div style={{ fontSize: 14, fontWeight: 600, color: '#c8d4f0' }}>{node?.data.config.displayName || node?.data.label || 'TMap'}</div>
            <div style={{ fontSize: 11, color: '#4a5a7a', fontFamily: 'monospace' }}>{nodeId} · {node?.data.laneId}</div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
            <button onClick={() => setIsMaximized((m) => { if (!m) { setModalWidth(null); resetDrag() } return !m })}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 8px', cursor: 'pointer', color: '#9a9aaa', display: 'flex', alignItems: 'center' }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a5a7a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              <i className={`ti ${isMaximized ? 'ti-arrows-minimize' : 'ti-arrows-maximize'}`} style={{ fontSize: 13 }} />
            </button>
            <button onClick={onClose}
              style={{ background: 'none', border: '1px solid #2a3349', borderRadius: 4, padding: '4px 12px', cursor: 'pointer', color: '#9a9aaa', fontSize: 12, display: 'flex', alignItems: 'center', gap: 5 }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#4a5a7a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
              <i className="ti ti-x" style={{ fontSize: 12 }} /> chiudi
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', borderBottom: '1px solid #2a3349', flexShrink: 0, overflowX: 'auto', background: '#161b27' }}>
          {TABS.map((t) => (
            <button key={t.id} onClick={() => setActiveTab(t.id)}
              style={{ padding: '9px 16px', fontSize: 11, background: activeTab === t.id ? '#1e2535' : 'transparent', border: 'none', borderBottom: activeTab === t.id ? '2px solid #a78bfa' : '2px solid transparent', color: activeTab === t.id ? '#c8d4f0' : '#4a5a7a', cursor: 'pointer', whiteSpace: 'nowrap', display: 'flex', alignItems: 'center', gap: 6, transition: 'all .15s' }}
              onMouseEnter={(e) => { if (activeTab !== t.id) (e.currentTarget as HTMLElement).style.color = '#9a9aaa' }}
              onMouseLeave={(e) => { if (activeTab !== t.id) (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
              <i className={`ti ${t.icon}`} style={{ fontSize: 13 }} /> {t.label}
            </button>
          ))}
        </div>
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div style={{ display: activeTab === 'general'  ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}><TabGeneral nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'mapping'  ? 'flex' : 'none', flex: 1, minHeight: 0, overflow: 'hidden' }}><TMapLayout nodeId={nodeId} /></div>
          <div style={{ display: activeTab === 'advanced' ? 'flex' : 'none', flexDirection: 'column', flex: 1, overflow: 'auto', padding: 16 }}><TabAdvanced nodeId={nodeId} /></div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8, padding: '10px 16px', borderTop: '1px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>
          <span style={{ fontSize: 11, color: '#4a5a7a', marginRight: 'auto' }}>Le modifiche sono salvate automaticamente</span>
          <button onClick={onClose}
            style={{ padding: '6px 20px', fontSize: 12, borderRadius: 4, cursor: 'pointer', background: '#2a1a4a', color: '#a78bfa', border: '1px solid #4a2a8a', fontWeight: 600 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#3a2a5a' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a1a4a' }}>
            Fatto
          </button>
        </div>
        {!isMaximized && (
          <div onMouseDown={onResizeStart}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 6, cursor: 'ew-resize', background: 'color-mix(in srgb, #a78bfa 15%, #1a2030)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 10, transition: 'background .15s' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, #a78bfa 40%, #1a2030)' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'color-mix(in srgb, #a78bfa 15%, #1a2030)' }}>
            <div style={{ width: 2, height: 32, borderRadius: 1, background: 'color-mix(in srgb, #a78bfa 60%, transparent)' }} />
          </div>
        )}
      </div>
    </div>,
    document.body
  )
}

// 3. In fondo al file — auto-registrazione
registerModuleObjects('TMapModal', [
  { id: 'inputHandleRefs',           label: 'Input handle refs',            type: 'Map', getSize: () => inputHandleRefs.size },
  { id: 'outputHandleRefs',          label: 'Output handle refs',           type: 'Map', getSize: () => outputHandleRefs.size },
  { id: 'joinHandleRefs',            label: 'Join handle refs',             type: 'Map', getSize: () => joinHandleRefs.size },
  { id: 'transformInputHandleRefs',  label: 'Transform input handle refs',  type: 'Map', getSize: () => transformInputHandleRefs.size },
  { id: 'transformOutputHandleRefs', label: 'Transform output handle refs', type: 'Map', getSize: () => transformOutputHandleRefs.size },
])