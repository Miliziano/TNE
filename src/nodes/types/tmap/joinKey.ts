/**
 * src/nodes/types/tmap/joinKey.ts
 *
 * Chiavi di join del TMap (P371) — una sola definizione per l'anteprima
 * nella modale e per il builder del piano (src/ir/tmapExprConverter.ts).
 *
 * Prima l'anteprima mostrava JavaScript (`String(row.x??'').trim()`) e la
 * combinazione automatica salvava quel testo in `combineExpr`: il builder lo
 * passava al parser FPEL e il Run si fermava. La "free expression" non
 * scritta come `row.campo` diventava una costante (tutte le righe con la
 * stessa chiave), e "regex extract" usava regex_match (true/false).
 *
 * Ora: ogni funzione ha la sua forma FPEL; la combinazione vuota vuol dire
 * "automatica" (i campi uniti da "-") e non si salva; una combinazione
 * scritta a mano è FPEL, con `$0`, `$1`… al posto dei campi dell'elenco.
 */

export const JOIN_TRANSFORMS: Array<{ id: string; label: string }> = [
  { id: 'none',   label: 'none' },
  { id: 'trim',   label: 'trim' },
  { id: 'lower',  label: 'lowercase' },
  { id: 'upper',  label: 'uppercase' },
  { id: 'year',   label: 'extract year' },
  { id: 'month',  label: 'extract month' },
  { id: 'day',    label: 'extract day' },
  { id: 'date',   label: 'extract date (first 10 chars)' },
  { id: 'substr', label: 'substring(start, length)' },
  { id: 'regex',  label: 'regex extract' },
  { id: 'free',   label: 'FPEL expression' },
]

/** Stringa FPEL fra virgolette doppie. */
function fpelString(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** Il campo in FPEL (nudo: la chiave si calcola su una riga sola); i nomi
 *  con spazi o punteggiatura fra backtick, come nel resto di FPEL. */
function fieldRef(field: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(field) ? field : `\`${field}\``
}

/** Una vecchia espressione libera `row.campo` → `campo`. */
export function stripRowPrefix(expr: string): string {
  return expr.replace(/\brow\.([A-Za-z_][A-Za-z0-9_]*)/g, '$1')
}

/** Il campo con la sua funzione, in FPEL. */
export function joinFieldFpel(field: string, fn: string, arg1 = '', arg2 = ''): string {
  if (!field && fn !== 'free') return ''
  const f = fieldRef(field)
  switch (fn) {
    case 'trim':   return `trim(${f})`
    case 'lower':  return `lower(${f})`
    case 'upper':  return `upper(${f})`
    case 'year':   return `year(${f})`
    case 'month':  return `month(${f})`
    case 'day':    return `day(${f})`
    case 'date':   return `substring(${f}, 0, 10)`
    case 'substr': return `substring(${f}, ${parseInt(arg1 || '0', 10) || 0}, ${parseInt(arg2 || '8', 10) || 8})`
    case 'regex':  return `regex_extract(${f}, ${fpelString(arg1 || '(.+)')})`
    case 'free':   return stripRowPrefix(arg1.trim()) || f
    default:       return f
  }
}

/** La combinazione automatica di più campi (anteprima). */
export function autoCombineFpel(fields: Array<{ field: string; fn: string; arg1: string; arg2: string }>): string {
  return fields
    .map((f) => joinFieldFpel(f.field, f.fn, f.arg1, f.arg2))
    .filter(Boolean)
    .join(' + "-" + ')
}

/** Una combinazione scritta a mano: `$0`, `$1`… diventano i campi. */
export function expandCombine(expr: string, fields: Array<{ field: string; fn: string; arg1: string; arg2: string }>): string {
  return expr.replace(/\$(\d+)/g, (m, i) => {
    const f = fields[Number(i)]
    return f ? `(${joinFieldFpel(f.field, f.fn, f.arg1, f.arg2)})` : m
  })
}

/** Testo salvato dalle versioni precedenti (JavaScript): va scartato. */
export function isLegacyJsKey(expr: string | undefined): boolean {
  return !!expr && /\brow\.|String\(|\?\?|\.match\(|new Date\(/.test(expr)
}
