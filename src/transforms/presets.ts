/**
 * src/transforms/presets.ts
 *
 * Adattatore tra il TRANSFORM_CATALOG (usato da TMap / pipeline)
 * e il formato runtime usato da TransformPanel e transformExecutor.
 *
 * Il catalogo usa espressioni simboliche con funzioni helper
 * (es: trim($value), formatDate($value, "DD/MM/YYYY")).
 * Qui vengono convertite in espressioni JavaScript eseguibili
 * con new Function(), dove $value viene sostituito con il valore reale.
 *
 * Questo file è l'UNICA fonte di verità per le trasformazioni —
 * importalo ovunque serva un elenco di preset per tipo.
 */

import { TRANSFORM_CATALOG, getTransformsForType } from './catalog'
import type { TransformTemplate } from './catalog'
import type { FieldType } from '../types/fieldTypes'

// Alias locale — catalog usa ancora TransformCategory internamente
type TransformCategory = FieldType

export type { FieldType, TMapFieldType, TransformCategory, TypeMeta } from '../types/fieldTypes'
  export { FIELD_TYPES, TYPE_META, typeBadgeStyle, typeSelectStyle } from '../types/fieldTypes'

// ─── Tipo unificato ───────────────────────────────────────────────



export interface Preset {
  id:         string
  label:      string
  desc:       string
  jsExpr:     string        // espressione JS eseguibile, usa $VALUE come placeholder
  outputType?: FieldType
  params?:    Array<{ key: string; label: string; type: 'text' | 'select' | 'number'; options?: string[]; default?: string }>
}

// ─── Mappa funzioni helper → JS puro ─────────────────────────────
// Il catalogo usa funzioni simboliche; qui le mappiamo in JS eseguibile.

function catalogExprToJs(expr: string): string {
  return expr
    // Gestione date
    .replace(/formatDate\(([^,]+),\s*"([^"]+)"\)/g, (_m, v, fmt) => {
      // Converte il formato pattern in JS
      const fmtJs = fmt
        .replace('DD/MM/YYYY', `(() => { const _d=$v; const _p=n=>String(n).padStart(2,'0'); return _d?_p(_d.getDate())+'/'+_p(_d.getMonth()+1)+'/'+_d.getFullYear():null })()`.replace('$v', v.trim()))
        .replace('YYYY-MM-DD', `(() => { const _d=$v; return _d?_d.toISOString().split('T')[0]:null })()`.replace('$v', v.trim()))
        .replace('MM/DD/YYYY', `(() => { const _d=$v; const _p=n=>String(n).padStart(2,'0'); return _d?_p(_d.getMonth()+1)+'/'+_p(_d.getDate())+'/'+_d.getFullYear():null })()`.replace('$v', v.trim()))
      return `((() => { const _dv = new Date(${v.trim()}); if(isNaN(_dv.getTime())) return null; const _d = _dv; return ${fmtJs.includes('_d') ? fmtJs : JSON.stringify(fmt)} })())`
    })
    .replace(/\bgetYear\(([^)]+)\)/g,        (_, v) => `((() => { const _d=new Date(${v.trim()}); return isNaN(_d.getTime())?null:_d.getFullYear() })())`)
    .replace(/\bgetMonth\(([^)]+)\)/g,       (_, v) => `((() => { const _d=new Date(${v.trim()}); return isNaN(_d.getTime())?null:_d.getMonth()+1 })())`)
    .replace(/\bgetDay\(([^)]+)\)/g,         (_, v) => `((() => { const _d=new Date(${v.trim()}); return isNaN(_d.getTime())?null:_d.getDate() })())`)
    .replace(/\bgetDayOfWeek\(([^)]+)\)/g,   (_, v) => `((() => { const _d=new Date(${v.trim()}); return isNaN(_d.getTime())?null:_d.getDay() })())`)
    .replace(/\bgetQuarter\(([^)]+)\)/g,     (_, v) => `((() => { const _d=new Date(${v.trim()}); return isNaN(_d.getTime())?null:Math.ceil((_d.getMonth()+1)/3) })())`)
    .replace(/\btoUnixTimestampMs\(([^)]+)\)/g, (_, v) => `((() => { const _d=new Date(${v.trim()}); return isNaN(_d.getTime())?null:_d.getTime() })())`)
    .replace(/\btoUnixTimestamp\(([^)]+)\)/g,   (_, v) => `((() => { const _d=new Date(${v.trim()}); return isNaN(_d.getTime())?null:Math.floor(_d.getTime()/1000) })())`)
    .replace(/\baddDays\(([^,]+),\s*([^)]+)\)/g, (_, v, n) => `((() => { const _d=new Date(${v.trim()}); _d.setDate(_d.getDate()+(${n.trim()})); return _d.toISOString().split('T')[0] })())`)
    .replace(/\baddMonths\(([^,]+),\s*([^)]+)\)/g, (_, v, n) => `((() => { const _d=new Date(${v.trim()}); _d.setMonth(_d.getMonth()+(${n.trim()})); return _d.toISOString().split('T')[0] })())`)
    .replace(/\baddYears\(([^,]+),\s*([^)]+)\)/g, (_, v, n) => `((() => { const _d=new Date(${v.trim()}); _d.setFullYear(_d.getFullYear()+(${n.trim()})); return _d.toISOString().split('T')[0] })())`)
    .replace(/\bstartOfMonth\(([^)]+)\)/g,   (_, v) => `((() => { const _d=new Date(${v.trim()}); return new Date(_d.getFullYear(),_d.getMonth(),1).toISOString().split('T')[0] })())`)
    .replace(/\bendOfMonth\(([^)]+)\)/g,     (_, v) => `((() => { const _d=new Date(${v.trim()}); return new Date(_d.getFullYear(),_d.getMonth()+1,0).toISOString().split('T')[0] })())`)
    .replace(/\bstartOfYear\(([^)]+)\)/g,    (_, v) => `((() => { const _d=new Date(${v.trim()}); return new Date(_d.getFullYear(),0,1).toISOString().split('T')[0] })())`)
    .replace(/\bisBefore\(([^,]+),\s*now\(\)\)/g, (_, v) => `(new Date(${v.trim()}) < new Date())`)
    .replace(/\bisAfter\(([^,]+),\s*now\(\)\)/g,  (_, v) => `(new Date(${v.trim()}) > new Date())`)
    .replace(/\bisWeekend\(([^)]+)\)/g,      (_, v) => `([0,6].includes(new Date(${v.trim()}).getDay()))`)
    .replace(/\bdiffDays\(([^,]+),\s*now\(\)\)/g, (_, v) => `(Math.floor((new Date().getTime()-new Date(${v.trim()}).getTime())/86400000))`)
    .replace(/\bnow\(\)/g, 'new Date().toISOString()')

    // String helpers
    .replace(/\btrim\(([^)]+)\)/g,           (_, v) => `String(${v.trim()}??'').trim()`)
    .replace(/\btrimLeft\(([^)]+)\)/g,       (_, v) => `String(${v.trim()}??'').trimStart()`)
    .replace(/\btrimRight\(([^)]+)\)/g,      (_, v) => `String(${v.trim()}??'').trimEnd()`)
    .replace(/\btoUpperCase\(([^)]+)\)/g,    (_, v) => `String(${v.trim()}??'').toUpperCase()`)
    .replace(/\btoLowerCase\(([^)]+)\)/g,    (_, v) => `String(${v.trim()}??'').toLowerCase()`)
    .replace(/\bcapitalize\(([^)]+)\)/g,     (_, v) => `(()=>{ const _s=String(${v.trim()}??'').toLowerCase(); return _s.charAt(0).toUpperCase()+_s.slice(1) })()`)
    .replace(/\btitleCase\(([^)]+)\)/g,      (_, v) => `String(${v.trim()}??'').replace(/\\b\\w/g,c=>c.toUpperCase())`)
    .replace(/\btoSlug\(([^)]+)\)/g,         (_, v) => `String(${v.trim()}??'').toLowerCase().trim().replace(/[^a-z0-9]+/g,'-')`)
    .replace(/\bpadLeft\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g, (_, v, n, c) => `String(${v.trim()}??'').padStart(Number(${n.trim()}),${c.trim()})`)
    .replace(/\bpadRight\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g, (_, v, n, c) => `String(${v.trim()}??'').padEnd(Number(${n.trim()}),${c.trim()})`)
    .replace(/\bsubstr\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g,  (_, v, s, l) => `String(${v.trim()}??'').substr(Number(${s.trim()}),Number(${l.trim()}))`)
    .replace(/\breplace\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g, (_, v, f, t) => `String(${v.trim()}??'').split(${f.trim()}).join(${t.trim()})`)
    .replace(/\breplaceRegex\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g, (_, v, p, t) => `String(${v.trim()}??'').replace(new RegExp(${p.trim()},'g'),${t.trim()})`)
    .replace(/\bnullIfEmpty\(([^)]+)\)/g,    (_, v) => `(${v.trim()}===''||${v.trim()}==null?null:${v.trim()})`)
    .replace(/\bifNull\(([^,]+),\s*([^)]+)\)/g, (_, v, d) => `(${v.trim()}??${d.trim()})`)
    .replace(/\bconcat\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g,  (_, v, s, suf) => `String(${v.trim()}??'')+${s.trim()}+String(${suf.trim()}??'')`)
    .replace(/\bremoveAccents\(([^)]+)\)/g,  (_, v) => `String(${v.trim()}??'').normalize('NFD').replace(/[\\u0300-\\u036f]/g,'')`)
    .replace(/\blength\(([^)]+)\)/g,         (_, v) => `String(${v.trim()}??'').length`)
    .replace(/\bmaskEmail\(([^)]+)\)/g,      (_, v) => `(()=>{ const _e=String(${v.trim()}??''); const _i=_e.indexOf('@'); if(_i<2)return _e; return _e.slice(0,2)+'***'+_e.slice(_i) })()`)
    .replace(/\bmaskCard\(([^)]+)\)/g,       (_, v) => `String(${v.trim()}??'').replace(/\\d(?=\\d{4})/g,'*')`)
    .replace(/\bcontains\(([^,]+),\s*([^)]+)\)/g,    (_, v, s) => `String(${v.trim()}??'').includes(${s.trim()})`)
    .replace(/\bstartsWith\(([^,]+),\s*([^)]+)\)/g,  (_, v, p) => `String(${v.trim()}??'').startsWith(${p.trim()})`)
    .replace(/\bendsWith\(([^,]+),\s*([^)]+)\)/g,    (_, v, s) => `String(${v.trim()}??'').endsWith(${s.trim()})`)
    .replace(/\bmatches\(([^,]+),\s*([^)]+)\)/g,     (_, v, p) => `new RegExp(${p.trim()}).test(String(${v.trim()}??''))`)
    .replace(/\bhashMd5\(([^)]+)\)/g,        (_, v) => `String(${v.trim()}??'')`)  // no-op lato browser
    .replace(/\bhashSha256\(([^)]+)\)/g,     (_, v) => `String(${v.trim()}??'')`)  // no-op lato browser
    .replace(/\bbase64Encode\(([^)]+)\)/g,   (_, v) => `btoa(String(${v.trim()}??''))`)
    .replace(/\bbase64Decode\(([^)]+)\)/g,   (_, v) => `atob(String(${v.trim()}??''))`)
    .replace(/\burlEncode\(([^)]+)\)/g,      (_, v) => `encodeURIComponent(String(${v.trim()}??''))`)

    // Number helpers
    .replace(/\bround\(([^,]+),\s*([^)]+)\)/g, (_, v, d) => `Math.round(Number(${v.trim()}??0)*Math.pow(10,${d.trim()}))/Math.pow(10,${d.trim()})`)
    .replace(/\bfloor\(([^)]+)\)/g,          (_, v) => `Math.floor(Number(${v.trim()}??0))`)
    .replace(/\bceil\(([^)]+)\)/g,           (_, v) => `Math.ceil(Number(${v.trim()}??0))`)
    .replace(/\babs\(([^)]+)\)/g,            (_, v) => `Math.abs(Number(${v.trim()}??0))`)
    .replace(/\bnegate\(([^)]+)\)/g,         (_, v) => `(-Number(${v.trim()}??0))`)
    .replace(/\bsign\(([^)]+)\)/g,           (_, v) => `Math.sign(Number(${v.trim()}??0))`)
    .replace(/\bclamp\(([^,]+),\s*([^,]+),\s*([^)]+)\)/g, (_, v, mn, mx) => `Math.min(Math.max(Number(${v.trim()}??0),${mn.trim()}),${mx.trim()})`)
    .replace(/\bpow\(([^,]+),\s*([^)]+)\)/g, (_, v, e) => `Math.pow(Number(${v.trim()}??0),${e.trim()})`)
    .replace(/\bsqrt\(([^)]+)\)/g,           (_, v) => `Math.sqrt(Number(${v.trim()}??0))`)
    .replace(/\blog\(([^)]+)\)/g,            (_, v) => `Math.log(Number(${v.trim()}??0))`)
    .replace(/\bformatNumber\(([^,]+),\s*([^,]+),\s*([^,]+),\s*([^)]+)\)/g, (_, v, d, ds, ts) =>
      `(()=>{ const _n=Number(${v.trim()}??0).toFixed(Number(${d.trim()})); const [_int,_dec]=_n.split('.'); return _int.replace(/\\B(?=(\\d{3})+(?!\\d))/g,${ts.trim()})+(_dec?${ds.trim()}+_dec:'') })()`)
    .replace(/\bmin\(([^,]+),\s*([^)]+)\)/g, (_, v, n) => `Math.min(Number(${v.trim()}??0),${n.trim()})`)
    .replace(/\bmax\(([^,]+),\s*([^)]+)\)/g, (_, v, n) => `Math.max(Number(${v.trim()}??0),${n.trim()})`)

    // Type conversion
    .replace(/\btoInt\(([^)]+)\)/g,     (_, v) => `parseInt(String(${v.trim()}??'0').replace(',',''),10)`)
    .replace(/\btoDecimal\(([^)]+)\)/g, (_, v) => `parseFloat(String(${v.trim()}??'0').replace(',','.'))`)
    .replace(/\btoString\(([^)]+)\)/g,  (_, v) => `String(${v.trim()}??'')`)
    .replace(/\btoJson\(([^)]+)\)/g,    (_, v) => `JSON.stringify(${v.trim()})`)
    .replace(/\btoBool\(([^)]+)\)/g,    (_, v) => `['true','1','yes','si','sì','on'].includes(String(${v.trim()}??'').toLowerCase())`)

    // Object helpers
    .replace(/\bget\(([^,]+),\s*([^)]+)\)/g,     (_, v, k) => `(${v.trim()}??{})[${k.trim()}]`)
    .replace(/\bgetPath\(([^,]+),\s*([^)]+)\)/g, (_, v, p) => `(()=>{ const _p=${p.trim()}.split('.'); let _c=${v.trim()}??{}; for(const _k of _p){ if(_c==null)return null; _c=_c[_k] } return _c })()`)
    .replace(/\bkeys\(([^)]+)\)/g,    (_, v) => `Object.keys(${v.trim()}??{})`)
    .replace(/\bvalues\(([^)]+)\)/g,  (_, v) => `Object.values(${v.trim()}??{})`)
    .replace(/\bmerge\(([^,]+),\s*([^)]+)\)/g, (_, v, e) => `({...(${v.trim()}??{}),...(${e.trim()}?{})})`)
    .replace(/\bisNull\(([^)]+)\)/g,  (_, v) => `(${v.trim()}==null)`)
    .replace(/\bcoalesce\(([^,]+),\s*([^)]+)\)/g, (_, v, d) => `(${v.trim()}??${d.trim()})`)
}

// ─── Converte un TransformTemplate in Preset runtime ─────────────

function templateToPreset(t: TransformTemplate): Preset {
  // Sostituisce $value con __V__ prima, poi alla fine sostituiremo con il valore reale
  let jsExpr = catalogExprToJs(t.expression)

  return {
    id:         t.id,
    label:      t.label,
    desc:       t.description,
    jsExpr,
    outputType: t.outputType as FieldType | undefined,
    params:     t.params,
  }
}

// ─── Preset speciali non nel catalogo ────────────────────────────

const UNIVERSAL_PRESETS: Preset[] = [
  { id: 'passthrough', label: 'Passthrough',    desc: 'Valore invariato',                 jsExpr: '$value' },
  { id: 'null_if_empty', label: 'Null se vuoto', desc: 'null se stringa vuota o null',    jsExpr: '($value===\'\'||$value==null?null:$value)' },
  { id: 'coalesce_empty', label: 'Coalesce ""', desc: 'Stringa vuota se null',             jsExpr: '($value??\'\')', outputType: 'string' },
  { id: 'expr', label: '{ } Espressione custom…', desc: 'Scrivi espressione JavaScript', jsExpr: '' },
]

// ─── API pubblica ─────────────────────────────────────────────────

/**
 * Restituisce i preset disponibili per un tipo campo,
 * inclusi i preset universali in cima.
 * Usa il TRANSFORM_CATALOG come unica fonte di verità.
 */
export function getPresetsForType(type: FieldType): Preset[] {
  const catalogType = (type === 'datetime' ? 'date' : type) as TransformCategory
  const fromCatalog = (TRANSFORM_CATALOG[catalogType] ?? []).map(templateToPreset)

  // Aggiunge preset datetime specifici non nel catalogo date
  const extra: Preset[] = type === 'datetime' ? [
    { id: 'dt_locale_it', label: '→ Locale IT', desc: 'Formato locale italiano', jsExpr: '(()=>{ const _d=new Date($value); return isNaN(_d.getTime())?null:_d.toLocaleString(\'it-IT\') })()' },
    { id: 'dt_time_only', label: '→ Solo ora HH:MM', desc: 'Solo ora', jsExpr: '(()=>{ const _d=new Date($value); if(isNaN(_d.getTime()))return null; const _p=n=>String(n).padStart(2,\'0\'); return _p(_d.getHours())+\':\'+_p(_d.getMinutes()) })()' },
  ] : []

  return [...UNIVERSAL_PRESETS, ...fromCatalog, ...extra]
}

/**
 * Esegue un preset dato il valore in ingresso e i parametri.
 * Sostituisce $value con il valore reale e i $param_key con i parametri.
 */
export function evalPreset(
  preset:  Preset,
  value:   unknown,
  params?: Record<string, string>,
): unknown {
  if (preset.id === 'passthrough') return value
  if (preset.id === 'null_if_empty') return (value === '' || value == null) ? null : value
  if (preset.id === 'coalesce_empty') return value ?? ''

  let expr = preset.jsExpr

  // Sostituisci parametri
  if (params && preset.params) {
    for (const p of preset.params) {
      const v = params[p.key] ?? p.default ?? ''
      expr = expr.replace(new RegExp(`\\$param_${p.key}`, 'g'), JSON.stringify(v))
    }
  }

  // Sostituisci $value con il valore serializzato
  const valueStr = value === null ? 'null'
                 : value === undefined ? 'undefined'
                 : typeof value === 'string' ? JSON.stringify(value)
                 : String(value)

  expr = expr.replace(/\$value/g, valueStr)

  try {
    // eslint-disable-next-line no-new-func
    return new Function(`"use strict"; return (${expr})`)()
  } catch {
    return value
  }
}




export { TRANSFORM_CATALOG, getTransformsForType }
