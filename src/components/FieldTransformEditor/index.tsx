/**
 * FieldTransformEditor/index.tsx  — v6
 *
 * Modifiche rispetto alla versione precedente:
 * - Hint sulle variabili di lane: si leggono con var("nome")
 *   la casella espressione in modalità inline.
 * - Hint lane.var aggiunto nell'hint dello ScriptEditor.
 * - Gruppo "Lane" aggiunto negli snippet dello ScriptEditor con
 *   due snippet: lane.variabile e ++lane.variabile.
 */

import { useRef, useCallback, useState } from 'react'
import type { TMapTransformInput, TMapFieldType } from '../../types'
import type { TransformCategory } from '../../transforms/catalog'
import type { TransformTemplate } from '../../transforms/catalog'
import { getPresetsForType, findPreset } from '../../transforms/presets'
import { resolveTemplate } from '../../transforms/templateCompiler'
import { TYPE_META, type FieldType } from '../../transforms/presets'
import { CustomSelect } from '../CustomSelect'
import { FunctionPicker, type VoceApplicabile } from '../FunctionPicker'

type TransformMode = 'inline' | 'script'

interface FieldTransform {
  mode:         TransformMode
  inputs:       TMapTransformInput[]
  expression:   string
  finalFn?:     string
  finalParams?: Record<string, string>
  outputName:   string
  outputType:   TMapFieldType
  cast?:        { fromType: TMapFieldType; toType: TMapFieldType }
  collapsed?:   boolean
  pipeline?:    any[]
}

interface Props {
  value:                   FieldTransform
  inputType:               TransformCategory
  inputTypes?:             TransformCategory[]
  inputVars:               string[]
  onChange:                (val: FieldTransform) => void
  onDelete?:               () => void
  onDragStart?:            () => void
  isDragging?:             boolean
  containerRef?:           React.RefObject<HTMLDivElement | null>
  transformId?:            string
  onRegisterOutputHandle?: (el: HTMLDivElement | null) => void
}

const iStyle: React.CSSProperties = {
  background: '#1e2535', border: '1px solid #3a4a6a', borderRadius: 4,
  color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 10, padding: '3px 6px', outline: 'none',
}

function tmeta(type: string) {
  return TYPE_META[type as FieldType] ?? { bg: '#2a2a2a', color: '#9a9aaa', label: type }
}

// ─── Catalogo funzioni per-campo ──────────────────────────────────

interface FnDef {
  id:         string
  label:      string
  outputType: string
  sameType?:  boolean
  /** Espressione FPEL dal catalogo condiviso: `$value`, `$param_<key>`. */
  expression: string
  params?:    ParamDef[]
}

interface ParamDef {
  key:      string
  label:    string
  type:     'text' | 'select' | 'number'
  default?: string
  options?: string[]
  width?:   number
}

// ─── Le funzioni offerte VENGONO DAL CATALOGO CONDIVISO ───────────
//
// Prima qui c'erano due liste locali (`FN_CATALOG`, `FINAL_FNS`) con un campo
// `jsTemplate` che conteneva **JavaScript** (`String($v??"").toUpperCase()`), e
// quel testo finiva DENTRO l'espressione salvata nel piano. Ma il motore è Rust
// e valuta alberi FPEL: quel codice non veniva mai eseguito — attraversava il
// parser producendo risultati senza senso, e senza errore.
//
// Ora le voci sono generate da `getPresetsForType` (che a sua volta legge
// `TRANSFORM_CATALOG`, la fonte unica usata anche dal nodo Transform): una
// funzione aggiunta là compare subito in ENTRAMBI, con la stessa etichetta e lo
// stesso comportamento. Un catalogo solo, un linguaggio solo.
const NESSUNA: FnDef = {
  id: 'none', label: 'nessuna', outputType: '__same__', sameType: true, expression: '$value',
}

/** Voce del catalogo condiviso → voce nella forma usata da questa interfaccia. */
/** Nome della funzione FPEL usata da un template (`concat_ws(...)` → concat_ws). */
function funzioneUsata(expression: string): string | null {
  const m = expression.match(/^\s*([a-z_][a-z0-9_]*)\s*\(/i)
  return m ? m[1] : null
}

function daTemplate(t: TransformTemplate): FnDef {
  // L'etichetta mostra anche la FUNZIONE che verrà scritta: senza, non c'è modo
  // di sapere quale voce corrisponde a `concat_ws` — si sceglie a tentativi.
  const fn = funzioneUsata(t.expression)
  return {
    id:         t.id,
    label:      fn ? `${t.label}  ·  ${fn}` : t.label,
    outputType: t.outputType ?? '__same__',
    sameType:   !t.outputType,
    expression: t.expression,
    params:     t.params as ParamDef[] | undefined,
  }
}

/** Funzione "finale": si applica al risultato — stesse voci, tipo generico. */
const FINAL_FNS: FnDef[] = [{ ...NESSUNA, label: '— nessuna —' },
                            ...getPresetsForType('string' as FieldType).map(daTemplate)]

function fnDef(id: string | undefined): FnDef {
  if (!id || id === 'none') return NESSUNA
  const t = findPreset(id)
  return t ? daTemplate(t) : NESSUNA
}
function finalFnDef(id: string | undefined): FnDef {
  return FINAL_FNS.find(f => f.id === id) ?? FINAL_FNS[0]
}

function applyFinalFnToExpr(expr: string, fn: FnDef, params: Record<string, string>): string {
  if (fn.id === 'none') return expr
  // Le parentesi servono solo se l'espressione è composta: attorno a una
  // chiamata o a un riferimento producevano `upper((replace(…)))`, corretto ma
  // illeggibile — ed è proprio il testo che l'utente si trova sotto gli occhi.
  const gia = /^[A-Za-z_][\w.]*\s*\(.*\)$/.test(expr.trim())
              || /^"[^"]*"\.[\w]+$/.test(expr.trim())
              || /^[\w.]+$/.test(expr.trim())
  const base = gia ? expr.trim() : `(${expr})`
  return resolveTemplate(
    { id: fn.id, label: fn.label, description: '', expression: fn.expression, params: fn.params },
    base, params,
  )
}


// ─── Snippet delle espressioni ────────────────────────────────────
// Erano 32 e ne compilavano DUE: il resto era JavaScript — `String(x ??
// "").trim()`, IIFE con regex, `try { JSON.parse(…) } catch`, `Math.abs`,
// e un gruppo "Lane" con `lane.x`, `++lane.x` e `lane.x = valore`, cioè
// SCRITTURE che nessuna superficie supporta. Passati al parser davano
// "carattere non riconosciuto" o "riferimento qualificato non ammesso".
//
// Un suggerimento che non compila è peggio di nessun suggerimento:
// sembra la sintassi giusta, e chi lo usa perde tempo a capire di chi sia
// la colpa. Queste espressioni finiscono in `tmap.transforms[].expression`
// e le compila `tmapExprConverter` con lo stesso `parseExpression` di
// Script e Transform — un solo parser, un solo IR.
//
// Usano SOLO funzioni presenti in `expr_functions.rs`, verificate una a una.
// Gli snippet delle FUNZIONI vengono dal CATALOGO CONDIVISO: erano una terza
// lista scritta a mano (35 voci) che duplicava le stesse trasformazioni del
// nodo Transform e del menu del TMap. Il contenuto era già FPEL corretto, ma
// una lista separata divergerebbe alla prima aggiunta — è esattamente ciò che
// era successo ai `jsTemplate`. Ora la fonte è una sola: `TRANSFORM_CATALOG`.
//




// ─── ScriptEditor con selettore snippet ──────────────────────────
function ScriptEditor({ expr, outputType, inputVars, onChange }: {
  expr: string; outputType: TMapFieldType; inputVars: string[]; onChange: (v: string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cursorPos   = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
  const [pickerScript, setPickerScript] = useState(false)

  const lines = expr.split('\n')


  function insertVar(varName: string) {
    const ta    = textareaRef.current
    const start = ta ? ta.selectionStart : cursorPos.current.start
    const end   = ta ? ta.selectionEnd   : cursorPos.current.end
    const newExpr = expr.slice(0, start) + varName + expr.slice(end)
    onChange(newExpr)
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      const newPos = start + varName.length
      ta.setSelectionRange(newPos, newPos)
    })
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>

      {/* ── Toolbar: variabili + selettore snippet ── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
        {inputVars.length > 0 && (
          <>
            <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>vars:</span>
            {inputVars.map(v => (
              <button key={v} onClick={() => insertVar(v)}
                style={{ fontSize: 9, padding: '1px 5px', borderRadius: 6, background: '#0f1117',
                  border: '1px solid #2a3349', color: '#4a9eff', cursor: 'pointer',
                  fontFamily: 'monospace', flexShrink: 0 }}
                onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff' }}
                onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}
                title={`Inserisci ${v} al cursore`}>
                {v}
              </button>
            ))}
            <div style={{ width: 1, height: 12, background: '#2a3349', flexShrink: 0 }} />
          </>
        )}
        {/* Selettore UNICO anche qui: prima la modalità script aveva una tendina
            propria, con voci ed etichette diverse da quelle del menu inline. */}
        <button
          onClick={() => setPickerScript(true)}
          title="Scegli una funzione o una trasformazione (con ricerca)"
          style={{ ...iStyle, fontSize: 9, width: 150, cursor: 'pointer', textAlign: 'left', color: '#8aa4d0' }}>
          ƒ applica…
        </button>
        {pickerScript && (
          <FunctionPicker
            tipo={outputType}
            onChiudi={() => setPickerScript(false)}
            onScegli={(voce) => {
              const ta = textareaRef.current
              const start = ta ? ta.selectionStart : cursorPos.current.start
              const end   = ta ? ta.selectionEnd   : cursorPos.current.end
              const sel   = expr.slice(start, end)
              // avvolge la selezione; senza selezione, il primo campo collegato
              const code  = voce.codice.replace(/\$sel/g, sel || inputVars[0] || 'campo')
              onChange(expr.slice(0, start) + code + expr.slice(end))
            }} />
        )}
      </div>

      {/* ── Textarea con numeri riga ── */}
      <div style={{ display: 'flex', background: '#0a0e18', border: '1px solid #3a4a6a', borderRadius: 4, overflow: 'hidden' }}>
        <div style={{ padding: '4px 5px', minWidth: 22, textAlign: 'right', fontFamily: 'monospace',
          fontSize: 9, lineHeight: '15px', color: '#2a3349', borderRight: '1px solid #2a3349',
          userSelect: 'none', flexShrink: 0, background: '#0a0e18' }}>
          {lines.map((_, i) => <div key={i}>{i + 1}</div>)}
          {Array.from({ length: Math.max(0, 3 - lines.length) }).map((_, i) =>
            <div key={`e${i}`} style={{ opacity: 0 }}>0</div>)}
        </div>
        <textarea
          ref={textareaRef}
          value={expr}
          onChange={e => onChange(e.target.value)}
          onSelect={e => { const ta = e.currentTarget; cursorPos.current = { start: ta.selectionStart, end: ta.selectionEnd } }}
          onKeyUp={e => { const ta = e.currentTarget; cursorPos.current = { start: ta.selectionStart, end: ta.selectionEnd } }}
          onMouseUp={e => { const ta = e.currentTarget; cursorPos.current = { start: ta.selectionStart, end: ta.selectionEnd } }}
          style={{ flex: 1, minHeight: 72, resize: 'vertical', background: 'transparent',
            border: 'none', outline: 'none', color: '#c8d4f0',
            fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
            lineHeight: '15px', padding: '4px 6px', tabSize: 2 }}
          placeholder={'espressione FPEL — es: upper(trim(Anagrafica.nome))\ncampo di un ingresso: Anagrafica.nome · con spazi: "Anagrafica clienti".nome · trasformazione: imponibile'}
          spellCheck={false}
        />
      </div>

      {/* ── Hint — aggiunto lane.var ── */}
      <div style={{ fontSize: 9, color: '#2a3349', lineHeight: 1.6 }}>
        <code style={{ color: '#4a9eff' }}>$value</code> = primo campo ·{' '}
        <code style={{ color: '#4a9eff' }}>$label.campo</code> = campo specifico ·{' '}
        <code style={{ color: '#a78bfa' }}>lane.var</code> = variabile di lane ·{' '}
        seleziona testo e scegli snippet per avvolgere
      </div>
    </div>
  )
}

// ─── Sintesi collapsed ─────────────────────────────────────────────

function buildSummary(value: FieldTransform, inputVars: string[]): string {
  if (value.mode === 'script') {
    const line = value.expression?.split('\n')[0]?.trim() ?? ''
    return line.length > 50 ? line.slice(0, 50) + '…' : (line || 'script')
  }
  const ff   = finalFnDef(value.finalFn)
  const expr = value.expression || inputVars.join(' + ') || '(vuota)'
  const full = ff.id !== 'none' ? applyFinalFnToExpr(expr, ff, value.finalParams ?? {}) : expr
  return full.length > 60 ? full.slice(0, 60) + '…' : full
}

// ─── Componente principale ─────────────────────────────────────────

export function FieldTransformEditor({
  value, inputType, inputTypes: inputTypesProp, inputVars,
  onChange, onDelete, onDragStart, isDragging,
  transformId, onRegisterOutputHandle,
}: Props) {
  const [pickerAperto, setPickerAperto] = useState(false)
  // Come una voce del selettore si applica alla casella (v. applicaVoce).
  const [modoApplica, setModoApplica] = useState<'avvolgi' | 'inserisci'>('avvolgi')
  const exprRef  = useRef<HTMLInputElement>(null)
  const caretRef = useRef<{ start: number; end: number }>({ start: 0, end: 0 })

  const nInputs = inputVars.length
  const inputTypes: TransformCategory[] = value.inputs.map((_, i) =>
    inputTypesProp?.[i] ?? (i === 0 ? inputType : 'any')
  )

  const effectiveMode: TransformMode = nInputs >= 3 ? 'script' : (value.mode ?? 'inline')
  const autoExpr    = inputVars.join(' + ')
  const currentExpr = effectiveMode === 'script'
    ? (value.expression ?? '')
    : (value.expression || autoExpr)

  const ff        = finalFnDef(value.finalFn)
  const ffHasType = ff.id !== 'none' && !ff.sameType && ff.outputType !== '__same__'
  const fn0OutType = (inputTypes[0] ?? inputType) as string
  const effectiveOutputType: TMapFieldType = (ffHasType ? ff.outputType : fn0OutType) as TMapFieldType

  const handlePatch = useCallback((patch: Partial<FieldTransform>) => {
    const merged = { ...value, ...patch }
    const fi     = (merged.inputs[0] as any)?.perFieldFn
    const fn0    = fnDef(fi)
    const out0   = fn0.sameType ? inputType : (fn0.outputType === '__same__' ? inputType : fn0.outputType)
    const ffd    = finalFnDef(merged.finalFn)
    const newOut = (ffd.id !== 'none' && !ffd.sameType && ffd.outputType !== '__same__' ? ffd.outputType : out0) as TMapFieldType
    onChange({ ...merged, outputType: newOut })
  }, [value, inputType, onChange])

  function handleDelete() {
    if (window.confirm(`Eliminare la trasformazione "${value.outputName || 'senza nome'}"?\nQuesta operazione non è reversibile.`)) {
      onDelete?.()
    }
  }

  // ── Applicazione delle funzioni alla casella ──────────────────────
  // Il caret dell'input è tenuto in un ref, aggiornato a ogni interazione:
  // quando si clicca il selettore l'input ha già perso il focus, quindi la
  // selezione "viva" non è affidabile.
  function aggiornaCaret() {
    const el = exprRef.current
    if (el) caretRef.current = { start: el.selectionStart ?? 0, end: el.selectionEnd ?? 0 }
  }
  function sostituisciTratto(start: number, end: number, testo: string) {
    const nuovo = currentExpr.slice(0, start) + testo + currentExpr.slice(end)
    const caret = start + testo.length
    handlePatch({ expression: nuovo })
    // Valore controllato: riposiziono il caret dopo il re-render.
    requestAnimationFrame(() => {
      const el = exprRef.current
      if (el) { el.focus(); el.setSelectionRange(caret, caret) }
    })
  }
  /** Chip di un campo: inserisce il suo riferimento qualificato al cursore. */
  function inserisciCampo(rif: string) {
    const { start, end } = caretRef.current
    sostituisciTratto(start, end, rif)
  }
  /** Applica una voce del selettore secondo il modo scelto.
   *  avvolgi + selezione → racchiude la selezione
   *  avvolgi senza sel.  → racchiude l'INTERA espressione
   *  inserisci           → cala il codice al cursore (o attorno alla selezione) */
  function applicaVoce(voce: VoceApplicabile) {
    const { start, end } = caretRef.current
    const sel = currentExpr.slice(start, end)
    if (modoApplica === 'avvolgi' && !sel) {
      const base  = (currentExpr || inputVars[0] || 'campo').trim()
      const nuovo = voce.codice.replace(/\$sel/g, base)
      handlePatch({ expression: nuovo })
      requestAnimationFrame(() => {
        const el = exprRef.current
        if (el) { el.focus(); el.setSelectionRange(nuovo.length, nuovo.length) }
      })
      return
    }
    sostituisciTratto(start, end, voce.codice.replace(/\$sel/g, sel))
  }

  // Si collassa SEMPRE, anche senza ingressi collegati: le trasformazioni
  // scritte a mano (che usano altre trasformazioni, o solo letterali) non ne
  // hanno, ed erano proprio quelle che restavano aperte occupando spazio.
  const isCollapsed = !!value.collapsed
  // Il badge dell'intestazione mostra il tipo DICHIARATO per la trasformazione
  // (quello scelto nella tendina). Prima mostrava `effectiveOutputType`, che è
  // dedotto dai campi collegati: per una trasformazione scritta a mano (nessun
  // campo) ricadeva sempre su 'string' — così da collassata tutte sembravano
  // stringhe, e riaprendole ricomparivano decimal/boolean.
  const om = tmeta((value.outputType ?? effectiveOutputType) as TMapFieldType)

  // ── Collapsed ────────────────────────────────────────────────────
  if (isCollapsed) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, background: '#1a2030',
        border: '1px solid #2a3349', borderRadius: 6, padding: '2px 6px' }}>
        <i className="ti ti-bolt" style={{ fontSize: 10, color: '#a78bfa', flexShrink: 0 }} />
        <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>{effectiveMode}</span>
        <span style={{ fontSize: 9, color: '#c8d4f0', fontFamily: 'monospace', flex: 1,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {buildSummary(value, inputVars)}
        </span>
        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, fontWeight: 600,
          flexShrink: 0, background: om.bg, color: om.color }}>→ {effectiveOutputType}</span>
        <span style={{ fontSize: 9, color: '#4a9eff', fontFamily: 'monospace', flexShrink: 0 }}>
          {value.outputName}
        </span>
        <button onClick={() => onChange({ ...value, collapsed: false })}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}>
          <i className="ti ti-chevron-down" style={{ fontSize: 10 }} />
        </button>
        <button onClick={handleDelete}
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}
          onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
          onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
          <i className="ti ti-x" style={{ fontSize: 10 }} />
        </button>
        <div ref={el => onRegisterOutputHandle?.(el as HTMLDivElement | null)}
          onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onDragStart?.() }}
          style={{ width: 10, height: 10, borderRadius: '50%', background: isDragging ? '#fff' : '#3ddc84',
            border: `2px solid ${isDragging ? '#3ddc84' : '#0f1117'}`,
            flexShrink: 0, cursor: 'crosshair', transition: 'all .1s', marginRight: 2 }} />
      </div>
    )
  }

  // ── Expanded ──────────────────────────────────────────────────────
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ background: '#1a2030', border: '1px solid #2a3349', borderRadius: 6,
        padding: '5px 7px', display: 'flex', flexDirection: 'column', gap: 6 }}>

        {/* Header */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-bolt" style={{ fontSize: 11, color: '#a78bfa', flexShrink: 0 }} />
          {nInputs < 3 ? (
            <CustomSelect value={effectiveMode}
              onChange={e => {
                const newMode = e.target.value as TransformMode
                const newExpr = newMode === 'script' ? '' : autoExpr
                onChange({ ...value, mode: newMode, expression: newExpr, collapsed: false })
              }}
              style={{ ...iStyle, width: 90 }}>
              <option value="inline">inline</option>
              <option value="script">script</option>
            </CustomSelect>
          ) : (
            <span style={{ fontSize: 9, color: '#ff5f57', padding: '2px 6px',
              background: '#2a1010', borderRadius: 4, border: '1px solid #4a2020', flexShrink: 0 }}>
              script ({nInputs})
            </span>
          )}
          <div style={{ flex: 1 }} />
          {ffHasType ? (
            <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, fontWeight: 600,
              flexShrink: 0, background: om.bg, color: om.color, whiteSpace: 'nowrap' }}>
              → {effectiveOutputType}
            </span>
          ) : (
            <CustomSelect
              value={value.outputType ?? 'string'}
              onChange={e => onChange({ ...value, outputType: e.target.value as TMapFieldType })}
              style={{ ...iStyle, fontSize: 9, width: 72, padding: '1px 3px',
                color:      tmeta(value.outputType ?? 'string').color,
                background: tmeta(value.outputType ?? 'string').bg,
                border:     `1px solid ${tmeta(value.outputType ?? 'string').color}40`,
              }}>

              {(['string','number','integer','decimal','boolean','date','object','any'] as TMapFieldType[])
                .map(t => <option key={t} value={t}>{t}</option>)}
            </CustomSelect>
          )}
          <input value={value.outputName ?? ''}
            onChange={e => onChange({ ...value, outputName: e.target.value })}
            style={{ ...iStyle, width: 72, color: '#3ddc84' }}
            placeholder="nome" />
          <button onClick={() => onChange({ ...value, collapsed: true })}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}>
            <i className="ti ti-chevron-up" style={{ fontSize: 10 }} />
          </button>
          <button onClick={handleDelete}
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', padding: '0 2px' }}
            onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#ff5f57' }}
            onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a' }}>
            <i className="ti ti-x" style={{ fontSize: 10 }} />
          </button>
          <div ref={el => onRegisterOutputHandle?.(el as HTMLDivElement | null)}
            onMouseDown={e => { e.preventDefault(); e.stopPropagation(); onDragStart?.() }}
            style={{ width: 10, height: 10, borderRadius: '50%', background: isDragging ? '#fff' : '#3ddc84',
              border: `2px solid ${isDragging ? '#3ddc84' : '#0f1117'}`,
              flexShrink: 0, cursor: 'crosshair', transition: 'all .1s', marginRight: 2 }} />
        </div>

        {/* Corpo */}
        <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 6,
          display: 'flex', flexDirection: 'column', gap: 5 }}>

          {effectiveMode === 'script' || nInputs >= 3 ? (
            <ScriptEditor
              expr={value.expression ?? ''}
              outputType={effectiveOutputType}
              inputVars={inputVars}
              onChange={expr => handlePatch({ expression: expr })}
            />
          ) : (
            <>
              {/* INLINE — casella unica.
                  Prima qui convivevano quattro meccanismi con precedenze
                  implicite (scaletta di campi · funzione per campo · casella ·
                  funzione finale). Ora UNO SOLO: si scrive l'espressione e le si
                  applicano funzioni dal selettore. "Alla selezione" e "a tutto"
                  sono lo STESSO gesto (avvolgi) con $sel legato a cose diverse,
                  distinte dalla presenza di selezione; "inserisci" cala il codice
                  al cursore. I campi collegati sono chip che inseriscono il
                  proprio riferimento qualificato al punto del cursore. */}

              {/* Chip dei campi collegati */}
              {inputVars.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0,
                    textTransform: 'uppercase', letterSpacing: '.05em' }}>campi</span>
                  {inputVars.map((v, i) => (
                    <button key={i}
                      onClick={() => inserisciCampo(v)}
                      title={`Inserisci ${v} al punto del cursore`}
                      style={{ fontSize: 9, padding: '1px 5px', borderRadius: 5, background: '#0f1117',
                        border: '1px solid #2a3349', color: '#4a9eff', cursor: 'pointer', flexShrink: 0,
                        fontFamily: 'monospace' }}>
                      {v}
                    </button>
                  ))}
                </div>
              )}

              {/* Casella espressione + selettore con modo avvolgi/inserisci */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0,
                    textTransform: 'uppercase', letterSpacing: '.05em' }}>espressione</span>
                  <div style={{ flex: 1 }} />
                  {value.expression && value.expression !== autoExpr && inputVars.length > 0 && (
                    <button
                      onClick={() => handlePatch({ expression: autoExpr })}
                      title="Riporta alla concatenazione automatica dei campi"
                      style={{ fontSize: 9, padding: '1px 5px', borderRadius: 5, background: 'none',
                        border: '1px solid #2a3349', color: '#4a5a7a', cursor: 'pointer', flexShrink: 0 }}>
                      ⟳ auto
                    </button>
                  )}
                  <div style={{ display: 'flex', border: '1px solid #2a3349', borderRadius: 5,
                    overflow: 'hidden', flexShrink: 0 }}>
                    {(['avvolgi', 'inserisci'] as const).map(m => (
                      <button key={m}
                        onClick={() => setModoApplica(m)}
                        title={m === 'avvolgi'
                          ? 'La funzione racchiude la selezione, o l’intera espressione se non c’è selezione'
                          : 'La funzione viene inserita al punto del cursore'}
                        style={{ fontSize: 9, padding: '1px 7px', cursor: 'pointer', border: 'none',
                          background: modoApplica === m ? '#2a3349' : 'transparent',
                          color: modoApplica === m ? '#c7d2e8' : '#4a5a7a' }}>
                        {m}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => setPickerAperto(true)}
                    title="Scegli una funzione o una trasformazione (con ricerca)"
                    style={{ ...iStyle, fontSize: 9, width: 96, flexShrink: 0, cursor: 'pointer',
                      textAlign: 'left', color: '#8aa4d0' }}>
                    ƒ applica…
                  </button>
                  {pickerAperto && (
                    <FunctionPicker
                      tipo={fn0OutType}
                      onChiudi={() => setPickerAperto(false)}
                      onScegli={(voce) => applicaVoce(voce)} />
                  )}
                </div>

                <input
                  ref={exprRef}
                  value={currentExpr}
                  onChange={e => handlePatch({ expression: e.target.value })}
                  onSelect={aggiornaCaret}
                  onKeyUp={aggiornaCaret}
                  onClick={aggiornaCaret}
                  onFocus={() => { if (!value.expression && inputVars.length > 0) handlePatch({ expression: autoExpr }) }}
                  style={{ ...iStyle, fontSize: 10, color: '#22d3ee', fontFamily: "'JetBrains Mono', monospace" }}
                  placeholder={autoExpr || 'es: upper(campo)'}
                  spellCheck={false}
                />

                {/* Variabili di lane: l'unica forma è var("nome"), in sola lettura. */}
                <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.5 }}>
                  <code style={{ color: '#a78bfa' }}>var("nome")</code>
                  {' '}per leggere una variabile di lane · es:{' '}
                  <code style={{ color: '#a78bfa', opacity: 0.7 }}>var("prefisso") + "/" + codice</code>
                </div>
              </div>

            </>
          )}
        </div>
      </div>
    </div>
  )
}