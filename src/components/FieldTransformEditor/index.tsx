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
import { TRANSFORM_CATALOG } from '../../transforms/catalog'
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
  jsTemplate: string
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

const FN_CATALOG: FnDef[] = [
  { id: 'none', label: 'nessuna', outputType: '__same__', sameType: true, jsTemplate: '$v' },
  // → string
  { id: 'to_string',    label: '→ stringa',            outputType: 'string',  jsTemplate: 'String($v??"")' },
  { id: 'upper',        label: '→ MAIUSCOLO',           outputType: 'string',  sameType: true, jsTemplate: 'String($v??"").toUpperCase()' },
  { id: 'lower',        label: '→ minuscolo',           outputType: 'string',  sameType: true, jsTemplate: 'String($v??"").toLowerCase()' },
  { id: 'capitalize',   label: '→ Prima maiuscola',     outputType: 'string',  sameType: true, jsTemplate: '(()=>{const _s=String($v??"").toLowerCase();return _s.charAt(0).toUpperCase()+_s.slice(1)})()' },
  { id: 'trim',         label: 'trim spazi',            outputType: 'string',  sameType: true, jsTemplate: 'String($v??"").trim()' },
  { id: 'slug',         label: '→ slug',                outputType: 'string',  sameType: true, jsTemplate: 'String($v??"").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-")' },
  { id: 'format_date_str', label: '→ data formattata', outputType: 'string',
    jsTemplate: '(()=>{const _d=new Date($v);if(isNaN(_d.getTime()))return null;const _p=n=>String(n).padStart(2,"0");return "$p_fmt".replace("DD",_p(_d.getDate())).replace("MM",_p(_d.getMonth()+1)).replace("YYYY",String(_d.getFullYear()))})())',
    params: [{ key: 'fmt', label: 'Formato', type: 'select', default: 'DD/MM/YYYY', options: ['DD/MM/YYYY','YYYY-MM-DD','MM/DD/YYYY','DD-MM-YYYY'] }],
  },
  { id: 'format_number_str', label: '→ numero formattato', outputType: 'string',
    jsTemplate: '(()=>{const _n=Number($v??0).toFixed($p_dec);const[_i,_d]=_n.split(".");return _i.replace(/\\B(?=(\\d{3})+(?!\\d))/g,"$p_ts")+(_d?"$p_ds"+_d:"")})())',
    params: [
      { key: 'dec', label: 'Decimali', type: 'number', default: '2', width: 44 },
      { key: 'ds',  label: 'Sep. dec', type: 'text',   default: ',', width: 36 },
      { key: 'ts',  label: 'Sep. mig', type: 'text',   default: '.', width: 36 },
    ],
  },
  { id: 'pad_left', label: 'pad sinistra', outputType: 'string', sameType: true,
    jsTemplate: 'String($v??"").padStart($p_n,"$p_ch")',
    params: [
      { key: 'n',  label: 'Lunghezza', type: 'number', default: '8',  width: 44 },
      { key: 'ch', label: 'Carattere', type: 'text',   default: '0',  width: 36 },
    ],
  },
  { id: 'json_str',   label: '→ JSON stringa', outputType: 'string',  jsTemplate: 'JSON.stringify($v)' },
  // → integer
  { id: 'to_int',    label: '→ intero',         outputType: 'integer', jsTemplate: 'parseInt(String($v??"0").replace(",",""),10)' },
  { id: 'get_year',  label: '→ anno',           outputType: 'integer', jsTemplate: '(()=>{const _d=new Date($v);return isNaN(_d.getTime())?null:_d.getFullYear()})()' },
  { id: 'get_month', label: '→ mese',           outputType: 'integer', jsTemplate: '(()=>{const _d=new Date($v);return isNaN(_d.getTime())?null:_d.getMonth()+1})()' },
  { id: 'get_day',   label: '→ giorno',         outputType: 'integer', jsTemplate: '(()=>{const _d=new Date($v);return isNaN(_d.getTime())?null:_d.getDate()})()' },
  { id: 'str_len',   label: '→ lunghezza str',  outputType: 'integer', jsTemplate: 'String($v??"").length' },
  { id: 'abs',       label: '→ valore assoluto',outputType: 'integer', jsTemplate: 'Math.abs(Number($v??0))' },
  { id: 'round',     label: '→ arrotondato',    outputType: 'integer', jsTemplate: 'Math.round(Number($v??0))' },
  // → decimal
  { id: 'to_decimal', label: '→ decimale',      outputType: 'decimal', jsTemplate: 'parseFloat(String($v??"0").replace(",","."))' },
  { id: 'round_dec',  label: '→ arrotonda dec', outputType: 'decimal',
    jsTemplate: 'Math.round(Number($v??0)*Math.pow(10,$p_dec))/Math.pow(10,$p_dec)',
    params: [{ key: 'dec', label: 'Decimali', type: 'number', default: '2', width: 44 }],
  },
  // → boolean
  { id: 'to_bool',  label: '→ booleano',     outputType: 'boolean', jsTemplate: '["true","1","yes","si","sì","on"].includes(String($v??"").toLowerCase())' },
  { id: 'is_null',  label: '→ è null?',      outputType: 'boolean', jsTemplate: '($v==null)' },
  { id: 'not_null', label: '→ non è null?',  outputType: 'boolean', jsTemplate: '($v!=null)' },
  { id: 'is_empty', label: '→ è vuoto?',     outputType: 'boolean', jsTemplate: '(!$v||String($v).trim()==="")' },
  { id: 'is_even',  label: '→ è pari?',      outputType: 'boolean', jsTemplate: '(Number($v??0)%2===0)' },
  { id: 'is_odd',   label: '→ è dispari?',   outputType: 'boolean', jsTemplate: '(Number($v??0)%2!==0)' },
  // → date
  { id: 'to_date',    label: '→ data (ISO)',   outputType: 'date',   jsTemplate: '(()=>{const _d=new Date($v);return isNaN(_d.getTime())?null:_d.toISOString().split("T")[0]})()' },
  { id: 'parse_date', label: '→ parse data',  outputType: 'date',
    jsTemplate: '(()=>{const _s=String($v??"");const _p=_s.match(/^(\\d{2})[\\/-](\\d{2})[\\/-](\\d{4})$/);if(_p&&"$p_fmt"==="DD/MM/YYYY")return _p[3]+"-"+_p[2]+"-"+_p[1];const _d=new Date(_s);return isNaN(_d.getTime())?null:_d.toISOString().split("T")[0]})())',
    params: [{ key: 'fmt', label: 'Formato input', type: 'select', default: 'DD/MM/YYYY', options: ['DD/MM/YYYY','MM/DD/YYYY','YYYY-MM-DD','DD-MM-YYYY'] }],
  },
  // → object
  { id: 'parse_json', label: '→ parse JSON',   outputType: 'object',  jsTemplate: '(()=>{try{return JSON.parse(String($v))}catch{return null}})()' },
]

const FN_GROUPS: Array<{ label: string; ids: string[] }> = [
  { label: '— nessuna —',  ids: ['none'] },
  { label: '→ stringa',    ids: ['to_string','upper','lower','capitalize','trim','slug','format_date_str','format_number_str','pad_left','json_str'] },
  { label: '→ intero',     ids: ['to_int','get_year','get_month','get_day','str_len','abs','round'] },
  { label: '→ decimale',   ids: ['to_decimal','round_dec'] },
  { label: '→ booleano',   ids: ['to_bool','is_null','not_null','is_empty','is_even','is_odd'] },
  { label: '→ data',       ids: ['to_date','parse_date'] },
  { label: '→ oggetto',    ids: ['parse_json'] },
]

// ─── Funzioni finali ──────────────────────────────────────────────

const FINAL_FNS: FnDef[] = [
  { id: 'none',       label: '— nessuna —',     outputType: '__same__', sameType: true, jsTemplate: '$v' },
  { id: 'trim',       label: 'trim',             outputType: 'string',   sameType: true, jsTemplate: 'String($v??"").trim()' },
  { id: 'upper',      label: 'MAIUSCOLO',        outputType: 'string',   sameType: true, jsTemplate: 'String($v??"").toUpperCase()' },
  { id: 'lower',      label: 'minuscolo',        outputType: 'string',   sameType: true, jsTemplate: 'String($v??"").toLowerCase()' },
  { id: 'capitalize', label: 'Prima maiuscola',  outputType: 'string',   sameType: true, jsTemplate: '(()=>{const _s=String($v??"").toLowerCase();return _s.charAt(0).toUpperCase()+_s.slice(1)})()' },
  { id: 'slug',       label: '→ slug',           outputType: 'string',   sameType: true, jsTemplate: 'String($v??"").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-")' },
  { id: 'null_empty', label: 'null se vuoto',    outputType: '__same__', sameType: true, jsTemplate: '($v===\'\'||$v==null?null:$v)' },
  { id: 'to_string',  label: '→ stringa',        outputType: 'string',   jsTemplate: 'String($v??"")' },
  { id: 'to_int',     label: '→ intero',         outputType: 'integer',  jsTemplate: 'parseInt(String($v??"0").replace(",",""),10)' },
  { id: 'to_decimal', label: '→ decimale',       outputType: 'decimal',  jsTemplate: 'parseFloat(String($v??"0").replace(",","."))' },
  { id: 'to_bool',    label: '→ booleano',       outputType: 'boolean',  jsTemplate: '["true","1","yes","si","sì","on"].includes(String($v??"").toLowerCase())' },
  { id: 'to_date',    label: '→ data ISO',       outputType: 'date',     jsTemplate: '(()=>{const _d=new Date($v);return isNaN(_d.getTime())?null:_d.toISOString().split("T")[0]})()' },
]

function fnDef(id: string | undefined): FnDef {
  return FN_CATALOG.find(f => f.id === id) ?? FN_CATALOG[0]
}
function finalFnDef(id: string | undefined): FnDef {
  return FINAL_FNS.find(f => f.id === id) ?? FINAL_FNS[0]
}

function buildVarExpr(varName: string, fn: FnDef, params: Record<string, string>): string {
  if (fn.id === 'none') return varName
  let tpl = fn.jsTemplate
  if (fn.params) {
    for (const p of fn.params) {
      tpl = tpl.split(`$p_${p.key}`).join(params[p.key] ?? p.default ?? '')
    }
  }
  return tpl.split('$v').join(varName)
}

function applyFinalFnToExpr(expr: string, fn: FnDef, params: Record<string, string>): string {
  if (fn.id === 'none') return expr
  let tpl = fn.jsTemplate
  if (fn.params) {
    for (const p of fn.params) {
      tpl = tpl.split(`$p_${p.key}`).join(params[p.key] ?? p.default ?? '')
    }
  }
  return tpl.split('$v').join(`(${expr})`)
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
const SCRIPT_SNIPPETS: SnippetDef[] = [
  // ── Conversioni ─────────────────────────────────────────────
  { id: 'tpl_str',      group: 'Template',   label: '→ testo',                 code: 'to_string($value)' },
  { id: 'tpl_int',      group: 'Template',   label: '→ intero',                code: 'to_int($value)' },
  { id: 'tpl_dec',      group: 'Template',   label: '→ decimale',              code: 'to_float($value)' },
  { id: 'tpl_bool',     group: 'Template',   label: '→ booleano',              code: 'to_bool($value)' },
  { id: 'tpl_date',     group: 'Template',   label: '→ data ISO',              code: 'date_format(parse_date($value), "yyyy-MM-dd")' },
  { id: 'tpl_null',     group: 'Template',   label: 'null se vuoto',           code: 'nullif(trim(to_string($value)), "")' },
  { id: 'tpl_default',  group: 'Template',   label: 'valore predefinito',      code: 'coalesce($value, "")' },
  { id: 'tpl_if',       group: 'Template',   label: 'se / altrimenti',         code: 'iif($value is null, "mancante", $value)' },
  // ── Stringhe ────────────────────────────────────────────────
  { id: 'fn_upper',     group: 'Stringa',    label: 'MAIUSCOLO',               code: 'upper($sel)' },
  { id: 'fn_lower',     group: 'Stringa',    label: 'minuscolo',               code: 'lower($sel)' },
  { id: 'fn_trim',      group: 'Stringa',    label: 'trim',                    code: 'trim($sel)' },
  { id: 'fn_cap',       group: 'Stringa',    label: 'Prima maiuscola',         code: 'capitalize($sel)' },
  { id: 'fn_title',     group: 'Stringa',    label: 'Ogni Parola Maiuscola',   code: 'title_case($sel)' },
  { id: 'fn_slug',      group: 'Stringa',    label: 'slug',                    code: 'to_slug($sel)' },
  { id: 'fn_pad',       group: 'Stringa',    label: 'riempi a sinistra',       code: 'pad_left(to_string($sel), 8, "0")' },
  { id: 'fn_replace',   group: 'Stringa',    label: 'sostituisci',             code: 'replace($sel, "cerca", "sostituisci")' },
  { id: 'fn_regex',     group: 'Stringa',    label: 'sostituisci (regex)',     code: 'replace_regex($sel, "[^0-9]", "")' },
  { id: 'fn_substr',    group: 'Stringa',    label: 'primi N caratteri',       code: 'left($sel, 8)' },
  { id: 'fn_len',       group: 'Stringa',    label: 'lunghezza',               code: 'length($sel)' },
  { id: 'fn_mask',      group: 'Stringa',    label: 'maschera email',          code: 'mask_email($sel)' },
  // ── Numeri ──────────────────────────────────────────────────
  { id: 'fn_toint',     group: 'Numero',     label: 'a intero',                code: 'to_int($sel)' },
  { id: 'fn_todec',     group: 'Numero',     label: 'a decimale',              code: 'to_float($sel)' },
  { id: 'fn_round',     group: 'Numero',     label: 'arrotonda a 2',           code: 'round($sel, 2)' },
  { id: 'fn_abs',       group: 'Numero',     label: 'valore assoluto',         code: 'abs($sel)' },
  { id: 'fn_clamp',     group: 'Numero',     label: 'limita fra 0 e 100',      code: 'clamp($sel, 0, 100)' },
  // ── Date ────────────────────────────────────────────────────
  { id: 'fn_quarter',   group: 'Data',       label: 'trimestre',               code: 'quarter($sel)' },
  { id: 'fn_fmtdate',   group: 'Data',       label: 'formatta gg/mm/aaaa',     code: 'date_format($sel, "dd/MM/yyyy")' },
  { id: 'fn_parsedate', group: 'Data',       label: 'da testo a data',         code: 'parse_date($sel)' },
  { id: 'fn_adddays',   group: 'Data',       label: 'aggiungi 30 giorni',      code: 'add_days($sel, 30)' },
  { id: 'fn_diffdays',  group: 'Data',       label: 'giorni da oggi',          code: 'diff_days(today(), $sel)' },
  // ── Condizioni ──────────────────────────────────────────────
  { id: 'fn_isnull',    group: 'Condizioni', label: 'è null?',                 code: '$sel is null' },
  { id: 'fn_coalesce',  group: 'Condizioni', label: 'primo non nullo',         code: 'coalesce($sel, "predefinito")' },
  { id: 'fn_ternary',   group: 'Condizioni', label: 'condizione ? a : b',      code: 'iif($sel is null, "vuoto", "pieno")' },
  // ── Lane ────────────────────────────────────────────────────
  // Il gruppo aveva quattro voci: una lettura inesistente e TRE scritture.
  // Resta l'unica forma vera, ed è in sola lettura — scrivere una variabile
  // di lane non è previsto oggi in nessuna superficie.
  { id: 'lane_read',    group: 'Lane',       label: 'leggi variabile di lane', code: 'var("$sel")' },
]

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
    const code  = snippet.code.replace(/\$sel/g, sel || '$value')
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
            const snippet = SCRIPT_SNIPPETS.find(s => s.id === e.target.value)
            if (snippet) insertAtCursor(snippet)
            setSnippetSel('')
          }}
          style={{ ...iStyle, fontSize: 9, flex: 1, minWidth: 120, maxWidth: 200 }}>
          <option value="" disabled>ƒ inserisci snippet…</option>
          {SNIPPET_GROUPS.map(grp => {
            const items = SCRIPT_SNIPPETS.filter(s => s.group === grp)
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
          placeholder={`// js — usa $value per il valore, $label.campo per i campi\nreturn $value`}
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

function FieldRow({ varName, fieldType, fnId, fnParams, varExpr, onChange }: {
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
        <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#9a9aaa',
          flexShrink: 0, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
          title={varName}>{varName}</span>
        <CustomSelect value={fnId} onChange={e => applyFn(e.target.value, fnParams)}
          style={{ ...iStyle, flex: 1, fontSize: 9, minWidth: 0 }}>
          {FN_GROUPS.map(grp => {
            const items = grp.ids.map(id => FN_CATALOG.find(f => f.id === id)).filter(Boolean) as FnDef[]
            if (!items.length) return null
            return (
              <optgroup key={grp.label} label={grp.label}>
                {items.map(f => <option key={f.id} value={f.id}>{f.label}</option>)}
              </optgroup>
            )
          })}
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
  const expr = value.expression || inputVars.join(' + ')
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
  const ffParams  = value.finalParams ?? {}
  const ffHasType = ff.id !== 'none' && !ff.sameType && ff.outputType !== '__same__'
  const fn0OutType = fieldOutputType(0)
  const effectiveOutputType: TMapFieldType = (ffHasType ? ff.outputType : fn0OutType) as TMapFieldType

  const type0        = fieldOutputType(0)
  const type1        = nInputs >= 2 ? fieldOutputType(1) : null
  const typesMismatch = type1 !== null && type0 !== type1 && type0 !== 'any' && type1 !== 'any'

  const exprWithFinal = ff.id !== 'none'
    ? applyFinalFnToExpr(currentExpr, ff, ffParams)
    : currentExpr

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

  const isCollapsed = !!(value.collapsed && nInputs > 0)
  const om = tmeta(effectiveOutputType)

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
                      style={{ fontSize: 9, padding: '1px 5px', borderRadius: 5, background: '#0f1117',
                        border: '1px solid #2a3349', color: '#4a9eff', cursor: 'pointer',
                        fontFamily: 'monospace', flexShrink: 0 }}
                      onMouseEnter={e => { (e.currentTarget as HTMLElement).style.borderColor = '#4a9eff' }}
                      onMouseLeave={e => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349' }}
                      title={currentVarExprs[i]}>
                      {v}
                    </button>
                  ))}
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

                {/* Anteprima con funzione finale applicata */}
                {ff.id !== 'none' && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                    <span style={{ fontSize: 9, color: '#a78bfa', textTransform: 'uppercase',
                      letterSpacing: '.05em' }}>risultato con funzione finale</span>
                    <div style={{ fontFamily: "'JetBrains Mono', monospace", fontSize: 9,
                      color: '#a78bfa', padding: '3px 6px', background: '#1a1030',
                      borderRadius: 4, border: '1px solid #3a2a6a',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                      title={exprWithFinal}>
                      {exprWithFinal}
                    </div>
                  </div>
                )}
              </div>

              {/* Funzione finale */}
              <div style={{ borderTop: '0.5px solid #2a3349', paddingTop: 5,
                display: 'flex', flexDirection: 'column', gap: 4 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>finale:</span>
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
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}