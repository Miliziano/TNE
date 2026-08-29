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

/** Funzioni proposte per un tipo di campo (preset universali + catalogo). */
function funzioniPerTipo(tipo: string): FnDef[] {
  return [NESSUNA, ...getPresetsForType(tipo as FieldType).map(daTemplate)]
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

function buildVarExpr(varName: string, fn: FnDef, params: Record<string, string>): string {
  if (fn.id === 'none') return varName
  // Stesso compilatore del nodo Transform: sostituisce `$param_<key>` (con le
  // virgolette dove servono) e `$value`.
  return resolveTemplate(
    { id: fn.id, label: fn.label, description: '', expression: fn.expression, params: fn.params },
    varName, params,
  )
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

function rebuildExpression(
  currentExpr:  string,
  inputVars:    string[],
  fieldIndex:   number,
  newVarExpr:   string,
  allVarExprs:  string[],
): string {
  const newExprs = [...allVarExprs]
  newExprs[fieldIndex] = newVarExpr
  const oldAutoExpr = allVarExprs.join(' + ')
  if (!currentExpr || currentExpr === oldAutoExpr || currentExpr === inputVars.join(' + ')) {
    return newExprs.join(' + ')
  }
  const oldPart = allVarExprs[fieldIndex]
  if (oldPart && currentExpr.includes(oldPart)) {
    return currentExpr.split(oldPart).join(newVarExpr)
  }
  return newExprs.join(' + ')
}

// ─── Catalogo snippet per lo ScriptEditor ────────────────────────

interface SnippetDef {
  id:    string
  label: string
  group: string
  code:  string
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
// Restano scritti qui solo i costrutti del LINGUAGGIO, che non sono
// trasformazioni di campo e nel catalogo non hanno posto.
const SNIPPET_LINGUAGGIO: SnippetDef[] = [
  { id: 'fn_isnull',   group: 'Condizioni', label: 'è null?',                 code: '$sel is null' },
  { id: 'fn_coalesce', group: 'Condizioni', label: 'primo non nullo',         code: 'coalesce($sel, "predefinito")' },
  { id: 'fn_ternary',  group: 'Condizioni', label: 'se… allora… altrimenti',  code: 'iif($sel is null, "vuoto", "pieno")' },
  { id: 'fn_case',     group: 'Condizioni', label: 'case when…',              code: 'case when $sel > 0 then "positivo" else "altro" end' },
  { id: 'lane_read',   group: 'Lane',       label: 'leggi variabile di lane', code: 'var("nome_variabile")' },
]

/** Categoria del catalogo → gruppo mostrato nella tendina. */
const GRUPPO_PER_CATEGORIA: Record<string, string> = {
  string: 'Stringa', integer: 'Numero', decimal: 'Numero',
  number: 'Numero',  boolean: 'Condizioni', date: 'Data', datetime: 'Data',
}

/**
 * Snippet proposti per il tipo del campo: prima le trasformazioni del catalogo
 * (già in FPEL, con `$value` risolto all'inserimento), poi i costrutti del
 * linguaggio. Una funzione aggiunta al catalogo compare qui da sola.
 */
function snippetPerTipo(tipo: string): SnippetDef[] {
  const daCatalogo = getPresetsForType(tipo as FieldType).map((t) => {
    // I parametri del template (`$param_<key>`) vanno risolti coi loro valori
    // predefiniti — e con le virgolette dove servono, cosa che sa fare solo
    // `resolveTemplate`. Inserirli grezzi produrrebbe espressioni non valide,
    // com'era per `$value` prima di P217.
    // `$value` invece si LASCIA: lo sostituisce l'inserimento col campo vero.
    const valoriDefault = Object.fromEntries(
      (t.params ?? []).map((p) => [p.key, p.default ?? '']),
    )
    return {
      id:    t.id,
      label: t.label,
      group: GRUPPO_PER_CATEGORIA[t.outputType ?? tipo] ?? 'Template',
      code:  resolveTemplate(t, '$value', valoriDefault),
    }
  })
  return [...daCatalogo, ...SNIPPET_LINGUAGGIO]
}


const SNIPPET_GROUPS = ['Template', 'Stringa', 'Numero', 'Data', 'Condizioni', 'Lane']

// ─── ScriptEditor con selettore snippet ──────────────────────────
function ScriptEditor({ expr, outputType, inputVars, onChange }: {
  expr: string; outputType: TMapFieldType; inputVars: string[]; onChange: (v: string) => void
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const cursorPos   = useRef<{ start: number; end: number }>({ start: 0, end: 0 })
  const [snippetSel, setSnippetSel] = useState('')

  const lines = expr.split('\n')

  function insertAtCursor(snippet: SnippetDef) {
    const ta    = textareaRef.current
    const start = ta ? ta.selectionStart : cursorPos.current.start
    const end   = ta ? ta.selectionEnd   : cursorPos.current.end
    const sel   = expr.slice(start, end)
    // `$value` e `$sel` sono SEGNAPOSTO degli snippet, non sintassi FPEL: vanno
    // risolti al momento dell'inserimento, altrimenti finiscono letterali
    // nell'espressione (e il parser li rifiuta, giustamente).
    // Al loro posto: il testo selezionato se c'è, altrimenti il PRIMO campo
    // collegato a questa trasformazione — già nella forma qualificata
    // (`Anagrafica.nome`), così lo snippet inserito è subito valido.
    const rimpiazzo = sel || inputVars[0] || 'campo'
    const code  = snippet.code.replace(/\$sel/g, rimpiazzo).replace(/\$value/g, rimpiazzo)
    const newExpr = expr.slice(0, start) + code + expr.slice(end)
    onChange(newExpr)
    requestAnimationFrame(() => {
      if (!ta) return
      ta.focus()
      const newPos = start + code.length
      ta.setSelectionRange(newPos, newPos)
    })
  }

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
        <CustomSelect
          value={snippetSel}
          onChange={e => {
            const snippet = snippetPerTipo(outputType).find(s => s.id === e.target.value)
            if (snippet) insertAtCursor(snippet)
            setSnippetSel('')
          }}
          style={{ ...iStyle, fontSize: 9, flex: 1, minWidth: 120, maxWidth: 200 }}>
          <option value="" disabled>ƒ inserisci snippet…</option>
          {SNIPPET_GROUPS.map(grp => {
            const items = snippetPerTipo(outputType).filter(s => s.group === grp)
            return (
              <optgroup key={grp} label={grp}>
                {items.map(s => (
                  <option key={s.id} value={s.id}>{s.label}</option>
                ))}
              </optgroup>
            )
          })}
        </CustomSelect>
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

// ─── FieldRow ──────────────────────────────────────────────────────

function FieldRow({ passo, varName, fieldType, fnId, fnParams, varExpr, onChange }: {
  /** Numero del passo nella scaletta (1, 2, …). */
  passo?:    number
  varName:   string; fieldType: TransformCategory
  fnId:      string; fnParams:  Record<string, string>
  varExpr:   string
  onChange:  (fnId: string, params: Record<string, string>, newVarExpr: string) => void
}) {
  const fn         = fnDef(fnId)
  const outputType = fn.sameType ? fieldType : fn.outputType
  const hasConvert = !fn.sameType && fn.outputType !== '__same__'
  const fm         = tmeta(fieldType)
  const tm         = tmeta(outputType)

  function applyFn(newFnId: string, newParams: Record<string, string>) {
    const newFn   = fnDef(newFnId)
    const newExpr = buildVarExpr(varName, newFn, newParams)
    onChange(newFnId, newParams, newExpr)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 3,
      background: '#141920', borderRadius: 5, padding: '5px 7px', border: '0.5px solid #2a3349' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
        <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, fontWeight: 600,
          flexShrink: 0, background: fm.bg, color: fm.color }}>{fieldType}</span>
        {passo != null && (
          <span title={`passo ${passo}`} style={{ fontSize: 9, fontWeight: 700, color: '#4a5a7a',
            width: 14, height: 14, lineHeight: '14px', textAlign: 'center', flexShrink: 0,
            background: '#0f1117', border: '1px solid #2a3349', borderRadius: 4 }}>{passo}</span>
        )}
        <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#9a9aaa',
          flexShrink: 0, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={varName}>{varName}</span>
        <CustomSelect value={fnId} onChange={e => applyFn(e.target.value, fnParams)}
          style={{ ...iStyle, flex: 1, fontSize: 9, minWidth: 0 }}>
          {/* Le voci sono quelle del CATALOGO CONDIVISO valide per il tipo di
              questo campo. Prima erano gruppi fissi con gli id elencati a mano
              (`FN_GROUPS`), che andavano tenuti allineati alla lista locale: una
              funzione aggiunta al catalogo non sarebbe comparsa qui. */}
          {funzioniPerTipo(fieldType).map(f => (
            <option key={f.id} value={f.id}>{f.label}</option>
          ))}
        </CustomSelect>
        {hasConvert && (
          <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, fontWeight: 600,
            flexShrink: 0, background: tm.bg, color: tm.color, whiteSpace: 'nowrap' }}>
            → {outputType}
          </span>
        )}
      </div>
      {fn.params && fn.params.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 4, flexWrap: 'wrap' }}>
          {fn.params.map(p => (
            <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
              <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>{p.label}:</span>
              {p.type === 'select' ? (
                <CustomSelect value={fnParams[p.key] ?? p.default ?? ''}
                  onChange={e => applyFn(fnId, { ...fnParams, [p.key]: e.target.value })}
                  style={{ ...iStyle, fontSize: 9, width: p.width ?? 100 }}>
                  {(p.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                </CustomSelect>
              ) : (
                <input type={p.type === 'number' ? 'number' : 'text'}
                  value={fnParams[p.key] ?? p.default ?? ''}
                  onChange={e => applyFn(fnId, { ...fnParams, [p.key]: e.target.value })}
                  style={{ ...iStyle, fontSize: 9, width: p.width ?? 60 }}
                  placeholder={p.default} />
              )}
            </div>
          ))}
        </div>
      )}
      {fnId !== 'none' && (
        <div style={{ fontSize: 9, fontFamily: 'monospace', color: '#4a9eff',
          padding: '2px 5px', background: '#0a0e18', borderRadius: 3,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={varExpr}>{varExpr}</div>
      )}
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

  const nInputs = inputVars.length
  const inputTypes: TransformCategory[] = value.inputs.map((_, i) =>
    inputTypesProp?.[i] ?? (i === 0 ? inputType : 'any')
  )

  const effectiveMode: TransformMode = nInputs >= 3 ? 'script' : (value.mode ?? 'inline')
  const autoExpr    = inputVars.join(' + ')
  const currentExpr = effectiveMode === 'script'
    ? (value.expression ?? '')
    : (value.expression || autoExpr)

  const fieldFns = value.inputs.map(inp => ({
    fnId:   (inp as any).perFieldFn ?? 'none',
    params: (inp as any).perFieldParams ?? {} as Record<string, string>,
  }))

  const currentVarExprs = inputVars.map((varName, i) =>
    buildVarExpr(varName, fnDef(fieldFns[i]?.fnId), fieldFns[i]?.params ?? {})
  )

  function fieldOutputType(i: number): string {
    const fn = fnDef(fieldFns[i]?.fnId)
    return fn.sameType ? (inputTypes[i] ?? inputType) : (fn.outputType === '__same__' ? (inputTypes[i] ?? inputType) : fn.outputType)
  }

  const ff        = finalFnDef(value.finalFn)
  const ffHasType = ff.id !== 'none' && !ff.sameType && ff.outputType !== '__same__'
  const fn0OutType = fieldOutputType(0)
  const effectiveOutputType: TMapFieldType = (ffHasType ? ff.outputType : fn0OutType) as TMapFieldType

  const type0        = fieldOutputType(0)
  const type1        = nInputs >= 2 ? fieldOutputType(1) : null
  // ⚠️ Qui erano rimaste due righe orfane di un ternario (residuo di una
  // variabile eliminata): JavaScript non spezza la riga prima di `?`, quindi le
  // attaccava a questa — e `typesMismatch` diventava una STRINGA invece di un
  // booleano. Effetto: l'avviso "Tipi diversi" compariva quasi sempre, con il
  // secondo tipo vuoto ("decimal e —").
  const typesMismatch = type1 !== null && type1 !== '' && type0 !== ''
                        && type0 !== type1 && type0 !== 'any' && type1 !== 'any'

  const handlePatch = useCallback((patch: Partial<FieldTransform>) => {
    const merged = { ...value, ...patch }
    const fi     = (merged.inputs[0] as any)?.perFieldFn
    const fn0    = fnDef(fi)
    const out0   = fn0.sameType ? inputType : (fn0.outputType === '__same__' ? inputType : fn0.outputType)
    const ffd    = finalFnDef(merged.finalFn)
    const newOut = (ffd.id !== 'none' && !ffd.sameType && ffd.outputType !== '__same__' ? ffd.outputType : out0) as TMapFieldType
    onChange({ ...merged, outputType: newOut })
  }, [value, inputType, onChange])

  function handleFieldFnChange(i: number, newFnId: string, newParams: Record<string, string>, newVarExpr: string) {
    const newInputs = value.inputs.map((inp, idx) =>
      idx === i
        ? { ...inp, perFieldFn: newFnId === 'none' ? undefined : newFnId, perFieldParams: newParams }
        : inp
    )
    const newExpr = rebuildExpression(currentExpr, inputVars, i, newVarExpr, currentVarExprs)
    handlePatch({ inputs: newInputs as any, expression: newExpr })
  }

  function handleDelete() {
    if (window.confirm(`Eliminare la trasformazione "${value.outputName || 'senza nome'}"?\nQuesta operazione non è reversibile.`)) {
      onDelete?.()
    }
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
                const newExpr = newMode === 'script' ? '' : currentVarExprs.join(' + ')
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
              {/* Righe per-campo */}
              {inputVars.map((varName, i) => (
                <FieldRow key={i}
                  passo={i + 1}
                  varName={varName}
                  fieldType={inputTypes[i] ?? 'any'}
                  fnId={fieldFns[i]?.fnId ?? 'none'}
                  fnParams={fieldFns[i]?.params ?? {}}
                  varExpr={currentVarExprs[i]}
                  onChange={(fnId, params, newVarExpr) => handleFieldFnChange(i, fnId, params, newVarExpr)}
                />
              ))}

              {/* Warning tipi misti */}
              {typesMismatch && (
                <div style={{ fontSize: 9, color: '#ffb347', display: 'flex', alignItems: 'center', gap: 4,
                  padding: '3px 6px', background: '#2a1f00', borderRadius: 4, border: '1px solid #3a3000' }}>
                  ⚠ Tipi diversi: <b>{type0}</b> e <b>{type1}</b> — concatenati come stringhe
                </div>
              )}

              {/* Casella espressione */}
              <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0,
                    textTransform: 'uppercase', letterSpacing: '.05em' }}>espressione</span>
                  {inputVars.map((v, i) => (
                    <button key={i}
                      onClick={() => {
                        const ins = currentVarExprs[i]
                        handlePatch({ expression: currentExpr ? currentExpr + ' + ' + ins : ins })
                      }}
                      /* Colore per ORIGINE: viola = calcolato qui (una
                         trasformazione, che si scrive nuda), azzurro = viene da
                         un ingresso (e si scrive qualificato). È la stessa
                         distinzione del linguaggio, resa visibile. */
                      style={{ fontSize: 9, padding: '1px 5px', borderRadius: 5, background: '#0f1117',
                        border: '1px solid #2a3349',
                        color: v.includes('.') ? '#4a9eff' : '#a78bfa', cursor: 'pointer',
                        fontFamily: 'monospace', flexShrink: 0 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}
                      title={currentVarExprs[i]}>
                      {v}
                    </button>
                  ))}
                  {/* Funzioni pronte anche QUI: prima la tendina degli snippet
                      esisteva solo in modalità script, quindi chi sceglieva
                      "espressione personalizzata" restava davanti a una casella
                      vuota senza un elenco da cui pescare. Le voci sono le stesse
                      del catalogo condiviso; `$value` viene sostituito col primo
                      campo collegato, come nell'inserimento in modalità script. */}
                  <CustomSelect
                    value=""
                    onChange={e => {
                      const sn = snippetPerTipo(fn0OutType).find(x => x.id === e.target.value)
                      if (!sn) return
                      const campo = inputVars[0] ?? 'campo'
                      const code  = sn.code.replace(/\$value/g, campo).replace(/\$sel/g, campo)
                      handlePatch({ expression: currentExpr ? currentExpr + ' + ' + code : code })
                    }}
                    style={{ ...iStyle, fontSize: 9, width: 132, flexShrink: 0 }}>
                    <option value="" disabled>ƒ inserisci funzione…</option>
                    {SNIPPET_GROUPS.map(grp => {
                      const items = snippetPerTipo(fn0OutType).filter(x => x.group === grp)
                      if (!items.length) return null
                      return (
                        <optgroup key={grp} label={grp}>
                          {items.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
                        </optgroup>
                      )
                    })}
                  </CustomSelect>
                  {value.expression && value.expression !== autoExpr && (
                    <button
                      onClick={() => handlePatch({ expression: currentVarExprs.join(' + ') })}
                      style={{ fontSize: 9, padding: '1px 5px', borderRadius: 5, background: 'none',
                        border: '1px solid #2a3349', color: '#4a5a7a', cursor: 'pointer', flexShrink: 0 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.color = '#3ddc84'; (e.currentTarget as HTMLElement).style.borderColor = '#3ddc84' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.color = '#4a5a7a'; (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}>
                      ⟳ auto
                    </button>
                  )}
                </div>

                {/* Casella espressione base (editabile) */}
                <input
                  value={currentExpr}
                  onChange={e => handlePatch({ expression: e.target.value })}
                  onFocus={() => { if (!value.expression) handlePatch({ expression: currentVarExprs.join(' + ') }) }}
                  style={{ ...iStyle, fontSize: 10, color: '#22d3ee', fontFamily: "'JetBrains Mono', monospace" }}
                  placeholder={autoExpr}
                  spellCheck={false}
                />

                {/* ── Variabili di lane ──────────────────────────────────────
                    Questa nota prometteva `lane.variabile`, l'alias
                    `context.lane.variabile` e perfino `++lane.counter`.
                    Nessuna delle tre esiste: passate al parser danno
                    "riferimento qualificato non ammesso qui" le prime due
                    e "espressione attesa" la terza. L'unica forma vera è
                    `var("nome")`, ed è la stessa in Script, Transform e
                    TMap — un solo parser, un solo IR.
                    E sono in SOLA LETTURA: scriverle non è previsto in
                    nessuna delle tre superfici.
                ─────────────────────────────────────────────────────────── */}
                <div style={{ fontSize: 9, color: '#4a5a7a', lineHeight: 1.5 }}>
                  <code style={{ color: '#a78bfa' }}>var("nome")</code>
                  {' '}per leggere una variabile di lane · es:{' '}
                  <code style={{ color: '#a78bfa', opacity: 0.7 }}>var("prefisso") + "/" + codice</code>
                </div>

              </div>

              {/* RISULTATO: l'espressione che finirà nel piano, sempre in vista
                  e in sola lettura. Prima la si vedeva solo passando a script:
                  così invece si impara il linguaggio guardando cosa si compone,
                  e si controlla subito cosa verrà eseguito. */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 5,
                padding: '4px 6px', background: '#0f1117', borderRadius: 4,
                border: '0.5px solid #2a3349' }}>
                <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0,
                  textTransform: 'uppercase', letterSpacing: '.05em', paddingTop: 1 }}>risultato</span>
                <code style={{ fontSize: 10, color: '#8aa4d0', wordBreak: 'break-all', lineHeight: 1.4 }}>
                  {buildSummary(value, inputVars) || '(vuota)'}
                </code>
              </div>

              {/* Funzione finale */}
              <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 5,
                display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  {/* Non più un concetto a parte ("finale"), ma l'ULTIMO PASSO
                      della scaletta: si applica al risultato dei passi
                      precedenti. Stesso badge numerato dei campi. */}
                  <span title={`passo ${inputVars.length + 1} — si applica al risultato`}
                    style={{ fontSize: 9, fontWeight: 700, color: '#4a5a7a',
                      width: 14, height: 14, lineHeight: '14px', textAlign: 'center', flexShrink: 0,
                      background: '#0f1117', border: '1px solid #2a3349', borderRadius: 4 }}>
                    {inputVars.length + 1}
                  </span>
                  <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>poi</span>
                  <CustomSelect
                    value={value.finalFn ?? 'none'}
                    onChange={e => {
                      const newId = e.target.value
                      handlePatch({ finalFn: newId === 'none' ? undefined : newId, finalParams: {} })
                    }}
                    style={{ ...iStyle, fontSize: 9, width: 140 }}>
                    {FINAL_FNS.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
                  </CustomSelect>
                  {ffHasType && (
                    <span style={{ fontSize: 9, padding: '1px 6px', borderRadius: 6, fontWeight: 600,
                      flexShrink: 0, ...(() => { const m = tmeta(ff.outputType); return { background: m.bg, color: m.color } })() }}>
                      → {ff.outputType}
                    </span>
                  )}
                </div>

                {/* PARAMETRI della funzione finale — mancavano del tutto: la
                    funzione veniva applicata coi valori predefiniti e non c'era
                    modo di dire, per esempio, COSA concatenare. Stessa resa dei
                    parametri delle funzioni di campo. */}
                {ff.params && ff.params.length > 0 && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, paddingLeft: 34, flexWrap: 'wrap' }}>
                    {ff.params.map(p => (
                      <div key={p.key} style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                        <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>{p.label}:</span>
                        {p.type === 'select' ? (
                          <CustomSelect
                            value={value.finalParams?.[p.key] ?? p.default ?? ''}
                            onChange={e => handlePatch({ finalParams: { ...(value.finalParams ?? {}), [p.key]: e.target.value } })}
                            style={{ ...iStyle, fontSize: 9, width: p.width ?? 100 }}>
                            {(p.options ?? []).map(o => <option key={o} value={o}>{o}</option>)}
                          </CustomSelect>
                        ) : (
                          <input type={p.type === 'number' ? 'number' : 'text'}
                            value={value.finalParams?.[p.key] ?? p.default ?? ''}
                            onChange={e => handlePatch({ finalParams: { ...(value.finalParams ?? {}), [p.key]: e.target.value } })}
                            style={{ ...iStyle, fontSize: 9, width: p.width ?? 80 }}
                            placeholder={p.default} />
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}