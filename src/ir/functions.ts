/**
 * src/ir/functions.ts
 *
 * Catalogo delle funzioni FPEL. Fonte di verità per:
 *  - validazione a design-time (nome esistente, arità corretta)
 *  - autocomplete e help nei pannelli
 *  - futuro codegen (ogni backend traduce questo elenco)
 *
 * ALLINEATO A: src-tauri/src/engine/expr.rs (fn eval_function).
 * Se aggiungi una funzione lì, aggiungila qui.
 *
 * NOTA: il motore tollera argomenti mancanti (li tratta come null) e non
 * fallisce mai per arità sbagliata. La validazione deve quindi avvenire
 * QUI, a design-time, altrimenti l'errore passa silenzioso.
 */

import type { FieldType } from '../types/fieldTypes'

export type FnCategory = 'string' | 'number' | 'date' | 'conversion' | 'logic' | 'variable' | 'structure'

export interface FnSignature {
  /** nome canonico (quello che finisce nell'IR) */
  name:     string
  /** alias accettati in scrittura, normalizzati al canonico */
  aliases?: string[]
  category: FnCategory
  /** tipo di ritorno; 'polimorfo' = dipende dagli argomenti (v. exprTypes.ts) */
  returns:  FieldType | 'polimorfo'
  /** numero minimo di argomenti */
  minArgs:  number
  /** numero massimo; null = variadico */
  maxArgs:  number | null
  /** firma leggibile per l'help */
  usage:    string
  desc:     string
}

export const FUNCTIONS: FnSignature[] = [
  // ── Stringhe ──────────────────────────────────────────────────────
  { name: 'trim',        category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'trim(s)',  desc: 'Removes leading and trailing spaces' },
  { name: 'ltrim',       aliases: ['trimleft'],  category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'ltrim(s)', desc: 'Removes leading spaces' },
  { name: 'rtrim',       aliases: ['trimright'], category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'rtrim(s)', desc: 'Removes trailing spaces' },
  { name: 'upper',       aliases: ['touppercase'], category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'upper(s)', desc: 'Uppercase' },
  { name: 'lower',       aliases: ['tolowercase'], category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'lower(s)', desc: 'Lowercase' },
  { name: 'length',      aliases: ['len'], category: 'string', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'length(s)', desc: 'Length' },
  { name: 'substring',   aliases: ['substr'], category: 'string', returns: 'string', minArgs: 2, maxArgs: 3, usage: 'substring(s, start [, length])', desc: 'Substring (0-based index)' },
  { name: 'replace',     category: 'string', returns: 'string', minArgs: 3, maxArgs: 3, usage: 'replace(s, search, replacement)', desc: 'Replaces all occurrences' },
  { name: 'concat',      category: 'string', returns: 'string', minArgs: 1, maxArgs: null, usage: 'concat(a, b, …)', desc: 'Concatenates' },
  { name: 'concat_ws',   category: 'string', returns: 'string', minArgs: 2, maxArgs: null, usage: 'concat_ws(sep, a, b, …)', desc: 'Concatenates with a separator' },
  { name: 'left',        category: 'string', returns: 'string', minArgs: 2, maxArgs: 2, usage: 'left(s, n)',  desc: 'First n characters' },
  { name: 'right',       category: 'string', returns: 'string', minArgs: 2, maxArgs: 2, usage: 'right(s, n)', desc: 'Last n characters' },
  { name: 'contains',    category: 'string', returns: 'boolean', minArgs: 2, maxArgs: 2, usage: 'contains(s, sub)',   desc: 'True if it contains' },
  { name: 'starts_with', aliases: ['startswith'], category: 'string', returns: 'boolean', minArgs: 2, maxArgs: 2, usage: 'starts_with(s, p)',  desc: 'True if it starts with' },
  { name: 'ends_with',   aliases: ['endswith'],   category: 'string', returns: 'boolean', minArgs: 2, maxArgs: 2, usage: 'ends_with(s, p)',    desc: 'True if it ends with' },
  { name: 'pad_left',    aliases: ['lpad', 'padleft'], category: 'string', returns: 'string', minArgs: 2, maxArgs: 3, usage: 'pad_left(s, n [, char])',  desc: 'Pads on the left up to n' },
  { name: 'pad_right',   aliases: ['rpad', 'padright'], category: 'string', returns: 'string', minArgs: 2, maxArgs: 3, usage: 'pad_right(s, n [, char])', desc: 'Pads on the right up to n' },
  { name: 'regex_match', aliases: ['matches'], category: 'string', returns: 'boolean', minArgs: 2, maxArgs: 2, usage: 'regex_match(s, pattern)', desc: 'True if the pattern matches' },

  // ── Numeri ────────────────────────────────────────────────────────
  { name: 'abs',   category: 'number', returns: 'number', minArgs: 1, maxArgs: 1, usage: 'abs(x)',   desc: 'Absolute value' },
  { name: 'round', category: 'number', returns: 'number', minArgs: 1, maxArgs: 2, usage: 'round(x [, decimals])', desc: 'Rounds' },
  { name: 'ceil',  category: 'number', returns: 'number', minArgs: 1, maxArgs: 1, usage: 'ceil(x)',  desc: 'Rounds up' },
  { name: 'floor', category: 'number', returns: 'number', minArgs: 1, maxArgs: 1, usage: 'floor(x)', desc: 'Rounds down' },
  { name: 'sqrt',  category: 'number', returns: 'number', minArgs: 1, maxArgs: 1, usage: 'sqrt(x)',  desc: 'Square root' },
  { name: 'power', aliases: ['pow'], category: 'number', returns: 'number', minArgs: 2, maxArgs: 2, usage: 'power(base, exp)', desc: 'Exponentiation' },
  { name: 'min',   category: 'number', returns: 'polimorfo', minArgs: 2, maxArgs: 2, usage: 'min(a, b)', desc: 'The smaller' },
  { name: 'max',   category: 'number', returns: 'polimorfo', minArgs: 2, maxArgs: 2, usage: 'max(a, b)', desc: 'The larger' },

  // ── Conversioni ───────────────────────────────────────────────────
  { name: 'to_string', aliases: ['str', 'tostring'],   category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'to_string(x)', desc: 'Converts to string' },
  { name: 'to_int',    aliases: ['int', 'toint'],   category: 'conversion', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'to_int(x)',    desc: 'Converts to integer' },
  { name: 'to_float',  aliases: ['float', 'todecimal'], category: 'conversion', returns: 'decimal', minArgs: 1, maxArgs: 1, usage: 'to_float(x)',  desc: 'Converts to decimal' },
  { name: 'to_bool',   aliases: ['bool', 'tobool'],  category: 'conversion', returns: 'boolean', minArgs: 1, maxArgs: 1, usage: 'to_bool(x)',   desc: 'Converts to boolean' },

  // ── Date ──────────────────────────────────────────────────────────
  { name: 'now',   aliases: ['current_timestamp'], category: 'date', returns: 'datetime', minArgs: 0, maxArgs: 0, usage: 'now()',   desc: 'Current date and time' },
  { name: 'today', aliases: ['current_date'],      category: 'date', returns: 'date', minArgs: 0, maxArgs: 0, usage: 'today()', desc: 'Current date' },
  { name: 'date_format', aliases: ['formatdate'], category: 'date', returns: 'string', minArgs: 2, maxArgs: 2, usage: 'date_format(d, format)', desc: 'Formats a date' },
  { name: 'year',   aliases: ['getyear'],  category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'year(d)',   desc: 'Year' },
  { name: 'month',  aliases: ['getmonth'], category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'month(d)',  desc: 'Month (1-12)' },
  { name: 'day',    aliases: ['getday'],   category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'day(d)',    desc: 'Day of the month' },
  { name: 'hour',   category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'hour(d)',   desc: 'Hour (0-23)' },
  { name: 'minute', category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'minute(d)', desc: 'Minutes' },
  { name: 'second', category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'second(d)', desc: 'Seconds' },

  // ── Logica / null ─────────────────────────────────────────────────
  // NB: `coalesce` ha un nodo IR dedicato, ma resta nel catalogo per l'help.
  { name: 'coalesce', aliases: ['ifnull', 'nvl', 'coalesceempty'], category: 'logic', returns: 'polimorfo', minArgs: 2, maxArgs: null, usage: 'coalesce(a, b, …)', desc: 'The first non-null value' },
  { name: 'nullif',   category: 'logic', returns: 'polimorfo', minArgs: 2, maxArgs: 2, usage: 'nullif(a, b)', desc: 'null if a == b, otherwise a' },
  { name: 'iif',      aliases: ['if'], category: 'logic', returns: 'polimorfo', minArgs: 3, maxArgs: 3, usage: 'iif(cond, if_true, if_false)', desc: 'Conditional (equivalent to cond ? a : b)' },

  // ── Variabili di lane ─────────────────────────────────────────────
  { name: 'var', category: 'variable', returns: 'any', minArgs: 1, maxArgs: 1, usage: 'var("name")', desc: 'Reads a lane variable' },

  // ── Date: componenti aggiuntive ───────────────────────────────────
  { name: 'quarter',     aliases: ['getquarter'],   category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'quarter(d)',     desc: 'Quarter (1-4)' },
  { name: 'day_of_week', aliases: ['getdayofweek'], category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'day_of_week(d)', desc: 'Day of week (0=Sunday)' },
  { name: 'is_weekend',  aliases: ['isweekend'],    category: 'date', returns: 'boolean', minArgs: 1, maxArgs: 1, usage: 'is_weekend(d)',  desc: 'True if Saturday or Sunday' },

  // ── Date: aritmetica ──────────────────────────────────────────────
  { name: 'add_days',   aliases: ['adddays'],   category: 'date', returns: 'date', minArgs: 2, maxArgs: 2, usage: 'add_days(d, n)',   desc: 'Adds n days' },
  { name: 'add_months', aliases: ['addmonths'], category: 'date', returns: 'date', minArgs: 2, maxArgs: 2, usage: 'add_months(d, n)', desc: 'Adds n months' },
  { name: 'add_years',  aliases: ['addyears'],  category: 'date', returns: 'date', minArgs: 2, maxArgs: 2, usage: 'add_years(d, n)',  desc: 'Adds n years' },
  { name: 'diff_days',  aliases: ['diffdays'],  category: 'date', returns: 'integer', minArgs: 2, maxArgs: 2, usage: 'diff_days(a, b)',  desc: 'Days from a to b' },

  // ── Date: confini di periodo ──────────────────────────────────────
  { name: 'start_of_month', aliases: ['startofmonth'], category: 'date', returns: 'date', minArgs: 1, maxArgs: 1, usage: 'start_of_month(d)', desc: 'First day of the month' },
  { name: 'end_of_month',   aliases: ['endofmonth'],   category: 'date', returns: 'date', minArgs: 1, maxArgs: 1, usage: 'end_of_month(d)',   desc: 'Last day of the month' },
  { name: 'start_of_year',  aliases: ['startofyear'],  category: 'date', returns: 'date', minArgs: 1, maxArgs: 1, usage: 'start_of_year(d)',  desc: 'First day of the year' },

  // ── Date: confronto e conversione ─────────────────────────────────
  { name: 'is_before', aliases: ['isbefore'], category: 'date', returns: 'boolean', minArgs: 2, maxArgs: 2, usage: 'is_before(a, b)', desc: 'True if a is before b' },
  { name: 'is_after',  aliases: ['isafter'],  category: 'date', returns: 'boolean', minArgs: 2, maxArgs: 2, usage: 'is_after(a, b)',  desc: 'True if a is after b' },
  { name: 'to_unix_timestamp',    aliases: ['tounixtimestamp'],   category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'to_unix_timestamp(d)',    desc: 'Seconds since the epoch' },
  { name: 'to_unix_timestamp_ms', aliases: ['tounixtimestampms'], category: 'date', returns: 'integer', minArgs: 1, maxArgs: 1, usage: 'to_unix_timestamp_ms(d)', desc: 'Milliseconds since the epoch' },
  { name: 'parse_date', aliases: ['parsedate'], category: 'date', returns: 'datetime', minArgs: 1, maxArgs: 2, usage: 'parse_date(text [, format])', desc: 'Parses a text as a date' },

  // ── Numeri aggiuntivi ─────────────────────────────────────────────
  { name: 'sign',   category: 'number', returns: 'number', minArgs: 1, maxArgs: 1, usage: 'sign(x)',   desc: '-1, 0 or 1 depending on the sign' },
  { name: 'negate', category: 'number', returns: 'number', minArgs: 1, maxArgs: 1, usage: 'negate(x)', desc: 'Changes sign' },
  { name: 'clamp',  category: 'number', returns: 'polimorfo', minArgs: 3, maxArgs: 3, usage: 'clamp(x, min, max)', desc: 'Clamps x within the range' },
  { name: 'format_number', aliases: ['formatnumber'], category: 'number', returns: 'string', minArgs: 2, maxArgs: 4, usage: 'format_number(x, dec [, dec_sep [, thou_sep]])', desc: 'Format: format_number(x,2,",",".") → 1.234,56' },
 
  // ── Stringhe aggiuntive ───────────────────────────────────────────
  { name: 'capitalize',     category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'capitalize(s)', desc: 'First letter uppercase' },
  { name: 'title_case',     aliases: ['titlecase'],     category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'title_case(s)',     desc: 'Each Word Capitalized' },
  { name: 'remove_accents', aliases: ['removeaccents'], category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'remove_accents(s)', desc: 'Removes accents' },
  { name: 'to_slug',        aliases: ['toslug'],        category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'to_slug(s)',        desc: 'text-normalized-for-url' },
  { name: 'replace_regex',  aliases: ['replaceregex'],  category: 'string', returns: 'string', minArgs: 3, maxArgs: 3, usage: 'replace_regex(s, pattern, repl)', desc: 'Replaces via regular expression' },
  { name: 'mask_email',     aliases: ['maskemail'],     category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'mask_email(s)',     desc: 'm****@domain.com' },
  { name: 'mask_card',      aliases: ['maskcard'],      category: 'string', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'mask_card(s)',      desc: 'Shows only the last 4 digits' },

  // ── Encoding / hash ───────────────────────────────────────────────
  { name: 'url_encode',    aliases: ['urlencode'],    category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'url_encode(s)',    desc: 'URL-encodes' },
  { name: 'url_decode',    aliases: ['urldecode'],    category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'url_decode(s)',    desc: 'URL-decodes' },
  { name: 'base64_encode', aliases: ['base64encode'], category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'base64_encode(s)', desc: 'Base64-encodes' },
  { name: 'base64_decode', aliases: ['base64decode'], category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'base64_decode(s)', desc: 'Base64-decodes' },
  { name: 'hash_sha256',   aliases: ['hashsha256'],   category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'hash_sha256(s)',   desc: 'SHA-256 digest (hexadecimal)' },
  { name: 'to_json',       aliases: ['tojson'],       category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'to_json(x)',       desc: 'Serializes to JSON' },

  // ── Numeri: logaritmi ─────────────────────────────────────────────
  { name: 'log',   aliases: ['ln'], category: 'number', returns: 'number', minArgs: 1, maxArgs: 1, usage: 'log(x)',   desc: 'Natural logarithm' },
  { name: 'log10', category: 'number', returns: 'number', minArgs: 1, maxArgs: 1, usage: 'log10(x)', desc: 'Base-10 logarithm' },

  // ── Hash (famiglia SHA) ───────────────────────────────────────────
  { name: 'hash_sha1',   aliases: ['hashsha1'],   category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'hash_sha1(s)',   desc: 'SHA-1 (deprecated, compatibility only)' },
  { name: 'hash_sha512', aliases: ['hashsha512'], category: 'conversion', returns: 'string', minArgs: 1, maxArgs: 1, usage: 'hash_sha512(s)', desc: 'SHA-512 digest' },

  // ── Strutture (oggetti / array JSON) ──────────────────────────────
  { name: 'get',      category: 'structure', returns: 'any', minArgs: 2, maxArgs: 2, usage: 'get(object, key)',    desc: 'Value of a key' },
  { name: 'get_path', aliases: ['getpath'], category: 'structure', returns: 'any', minArgs: 2, maxArgs: 2, usage: 'get_path(object, "a.b.0.c")', desc: 'Nested value by path' },
  { name: 'keys',     category: 'structure', returns: 'object', minArgs: 1, maxArgs: 1, usage: 'keys(object)',   desc: 'List of keys' },
  { name: 'values',   category: 'structure', returns: 'object', minArgs: 1, maxArgs: 1, usage: 'values(object)', desc: 'List of values' },
  { name: 'merge',    category: 'structure', returns: 'object', minArgs: 2, maxArgs: 2, usage: 'merge(a, b)',     desc: 'Merges two objects (b wins)' },
]

/** alias → nome canonico */
const ALIAS_TO_NAME = new Map<string, string>()
for (const f of FUNCTIONS) {
  ALIAS_TO_NAME.set(f.name, f.name)
  for (const a of f.aliases ?? []) ALIAS_TO_NAME.set(a, f.name)
}

const BY_NAME = new Map(FUNCTIONS.map(f => [f.name, f]))

/** Risolve un nome (o alias) al nome canonico. null se sconosciuto. */
export function canonicalName(name: string): string | null {
  return ALIAS_TO_NAME.get(name.toLowerCase()) ?? null
}

export function lookupFunction(name: string): FnSignature | null {
  const canon = canonicalName(name)
  return canon ? (BY_NAME.get(canon) ?? null) : null
}

/**
 * Valida nome e arità. Ritorna null se ok, altrimenti il messaggio d'errore.
 * Da chiamare sul FunctionCall dopo il parsing.
 */
export function validateCall(name: string, argCount: number): string | null {
  const fn = lookupFunction(name)
  if (!fn) {
    const suggest = suggestName(name)
    return `unknown function: "${name}"` + (suggest ? ` — did you mean "${suggest}"?` : '')
  }
  if (argCount < fn.minArgs) {
    return `${fn.name} requires at least ${fn.minArgs} arguments (received ${argCount}) — ${fn.usage}`
  }
  if (fn.maxArgs !== null && argCount > fn.maxArgs) {
    return `${fn.name} accepts at most ${fn.maxArgs} arguments (received ${argCount}) — ${fn.usage}`
  }
  return null
}

/** Suggerimento per errore di battitura (distanza di Levenshtein ≤ 2). */
function suggestName(name: string): string | null {
  const lower = name.toLowerCase()
  let best: string | null = null
  let bestDist = 3
  for (const candidate of ALIAS_TO_NAME.keys()) {
    const d = levenshtein(lower, candidate)
    if (d < bestDist) { bestDist = d; best = candidate }
  }
  return best
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}

/** Per l'autocomplete: funzioni raggruppate per categoria. */
export function functionsByCategory(): Record<FnCategory, FnSignature[]> {
  const out = {} as Record<FnCategory, FnSignature[]>
  for (const f of FUNCTIONS) (out[f.category] ??= []).push(f)
  return out
}