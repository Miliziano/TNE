/**
 * src/nodes/types/filter/filterTypes.ts
 */

export type ConditionMode = 'visual' | 'template' | 'code'

export type ConditionOperator =
  | '==' | '!=' | '>' | '>=' | '<' | '<='
  | 'contains' | 'starts' | 'ends'
  | 'is_null' | 'not_null'
  | 'in' | 'not_in' | 'regex'

export interface VisualClause {
  id:       string
  field:    string
  operator: ConditionOperator
  value:    string
  logic:    'AND' | 'OR'   // connettore con la clausola precedente
}

export interface FilterCondition {
  id:       string
  label:    string          // nome dell'uscita (es. "adulti", "premium")
  color:    string
  mode:     ConditionMode

  // mode === 'visual'
  clauses?: VisualClause[]

  // mode === 'template'
  templateId?:     string
  templateParams?: Record<string, string>

  // mode === 'code': un'espressione FPEL booleana (es. `amount > 100 &&
  // lower(country) == "it"`). Lo studio la compila in IR al Run; il
  // motore la valuta riga per riga (vera se "truthy").
  code?:     string
  /** Legacy (≤ P353): linguaggio della vecchia modalità code JS/TS/Python.
   *  Non più usato: la modalità code è solo FPEL. */
  lang?:     string
}

/**
 * Modalità di esecuzione dei rami.
 *  parallel     — tutti i rami in streaming insieme (default)
 *  ordered_wait — il ramo #N parte quando la sotto-pipeline del ramo
 *                 #N-1 ha finito (righe trattenute in memoria)
 *  sequential   — legacy: equivale a parallel (nessuna differenza
 *                 osservabile in streaming); il pannello non lo offre più
 */
export type FilterExecMode = 'parallel' | 'ordered_wait' | 'sequential'

export interface FilterConfig {
  conditions: FilterCondition[]   // ordine = priorità (first-match)
  // Opzioni globali
  nullBehavior:  'exclude' | 'include' | 'error'
  caseSensitive: boolean
  execMode?:     FilterExecMode
}

// ─── Template predefiniti ─────────────────────────────────────────

export interface FilterTemplate {
  id:          string
  label:       string
  category:    string
  description: string
  params:      Array<{ key: string; label: string; placeholder: string }>
  /** L'equivalente FPEL (anteprima e passaggio alla modalità code).
   *  `cs` = case sensitive del nodo: governa i template stringa. */
  toFpel:      (params: Record<string, string>, cs: boolean) => string
}

/** Case sensitive effettivo: default sì (era il default mostrato dal
 *  pannello anche quando il motore lo ignorava). */
export function isCaseSensitive(cfg: Partial<FilterConfig> | undefined): boolean {
  return cfg?.caseSensitive !== false
}

/** Modalità effettiva: 'sequential' (legacy) equivale a 'parallel'. */
export function effectiveExecMode(cfg: Partial<FilterConfig> | undefined): 'parallel' | 'ordered_wait' {
  return cfg?.execMode === 'ordered_wait' ? 'ordered_wait' : 'parallel'
}

// ─── Mattoni FPEL ─────────────────────────────────────────────────

const FPEL_KEYWORDS = new Set([
  'true', 'false', 'null', 'and', 'or', 'is', 'not',
  'case', 'when', 'then', 'else', 'end', 'cast', 'as',
])

/** Riferimento a campo: nome nudo se è un identificatore, altrimenti
 *  tra backtick (nomi con spazi, punteggiatura o parole chiave). */
export function fpelField(name: string): string {
  const n = name || 'field'
  if (/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(n) && !FPEL_KEYWORDS.has(n.toLowerCase())) return n
  return '`' + n.replace(/`/g, '') + '`'
}

/** Letterale stringa FPEL (escape di \\ e \"). */
export function fpelString(v: string): string {
  return '"' + (v ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\t/g, '\\t') + '"'
}

/** Letterale numerico se `v` è un numero, altrimenti to_float("v")
 *  (che vale null: il confronto non passa, come nel motore). */
function fpelNumber(v: string): string {
  const t = (v ?? '').trim()
  return t !== '' && !isNaN(Number(t)) ? t : `to_float(${fpelString(t)})`
}

/** Il campo come testo, ripiegato in minuscolo se non case sensitive. */
function fpelText(field: string, cs: boolean): string {
  const t = `to_string(${fpelField(field)})`
  return cs ? t : `lower(${t})`
}
function fpelLit(v: string, cs: boolean): string {
  return fpelString(cs ? v : (v ?? '').toLowerCase())
}
/** Pattern regex con il flag (?i) quando non case sensitive. */
function fpelRegex(pattern: string, cs: boolean): string {
  return fpelString(cs ? pattern : `(?i)${pattern ?? ''}`)
}

export const FILTER_TEMPLATES: FilterTemplate[] = [
  // ── Date ──────────────────────────────────────────────────────
  {
    id: 'date_is_today', category: 'Date', label: 'Is today',
    description: 'The date equals today',
    params: [{ key: 'field', label: 'Date field', placeholder: 'created_at' }],
    toFpel: (p) => `diff_days(today(), ${fpelField(p.field)}) == 0`,
  },
  {
    id: 'date_is_past', category: 'Date', label: 'Is in the past',
    description: 'The date is before now',
    params: [{ key: 'field', label: 'Date field', placeholder: 'created_at' }],
    toFpel: (p) => `is_before(${fpelField(p.field)}, now())`,
  },
  {
    id: 'date_is_future', category: 'Date', label: 'Is in the future',
    description: 'The date is after now',
    params: [{ key: 'field', label: 'Date field', placeholder: 'expiry_at' }],
    toFpel: (p) => `is_after(${fpelField(p.field)}, now())`,
  },
  {
    id: 'date_range', category: 'Date', label: 'Date range',
    description: 'The date is between two dates (inclusive)',
    params: [
      { key: 'field', label: 'Date field',    placeholder: 'created_at' },
      { key: 'from',  label: 'Start date',   placeholder: '2024-01-01' },
      { key: 'to',    label: 'End date',     placeholder: '2024-12-31' },
    ],
    toFpel: (p) => `is_before(${fpelField(p.field)}, ${fpelString(p.from)}) == false && is_after(${fpelField(p.field)}, ${fpelString(p.to)}) == false`,
  },
  {
    id: 'date_is_weekend', category: 'Date', label: 'Is weekend',
    description: 'The date falls on Saturday or Sunday',
    params: [{ key: 'field', label: 'Date field', placeholder: 'created_at' }],
    toFpel: (p) => `is_weekend(${fpelField(p.field)})`,
  },

  // ── Numbers ───────────────────────────────────────────────────
  {
    id: 'num_greater', category: 'Numbers', label: 'Greater than',
    description: 'The numeric value is greater than the threshold',
    params: [
      { key: 'field',     label: 'Field',  placeholder: 'amount' },
      { key: 'threshold', label: 'Threshold', placeholder: '100'    },
    ],
    toFpel: (p) => `to_float(${fpelField(p.field)}) > ${fpelNumber(p.threshold)}`,
  },
  {
    id: 'num_less', category: 'Numbers', label: 'Less than',
    description: 'The numeric value is less than the threshold',
    params: [
      { key: 'field',     label: 'Field',  placeholder: 'amount' },
      { key: 'threshold', label: 'Threshold', placeholder: '0'      },
    ],
    toFpel: (p) => `to_float(${fpelField(p.field)}) < ${fpelNumber(p.threshold)}`,
  },
  {
    id: 'num_between', category: 'Numbers', label: 'Between',
    description: 'The value is between min and max (inclusive)',
    params: [
      { key: 'field', label: 'Field', placeholder: 'score' },
      { key: 'min',   label: 'Min',   placeholder: '0'     },
      { key: 'max',   label: 'Max',   placeholder: '100'   },
    ],
    toFpel: (p) => `to_float(${fpelField(p.field)}) >= ${fpelNumber(p.min)} && to_float(${fpelField(p.field)}) <= ${fpelNumber(p.max)}`,
  },
  {
    id: 'num_is_zero', category: 'Numbers', label: 'Is zero',
    description: 'The value is exactly 0',
    params: [{ key: 'field', label: 'Field', placeholder: 'quantity' }],
    toFpel: (p) => `to_float(${fpelField(p.field)}) == 0`,
  },
  {
    id: 'num_is_negative', category: 'Numbers', label: 'Is negative',
    description: 'The value is less than 0',
    params: [{ key: 'field', label: 'Field', placeholder: 'balance' }],
    toFpel: (p) => `to_float(${fpelField(p.field)}) < 0`,
  },

  // ── Strings ───────────────────────────────────────────────────
  {
    id: 'str_contains', category: 'Strings', label: 'Contains',
    description: 'The string field contains the text',
    params: [
      { key: 'field', label: 'Field', placeholder: 'name'   },
      { key: 'text',  label: 'Text', placeholder: 'john'  },
    ],
    toFpel: (p, cs) => `contains(${fpelText(p.field, cs)}, ${fpelLit(p.text, cs)})`,
  },
  {
    id: 'str_starts', category: 'Strings', label: 'Starts with',
    description: 'The string field starts with the prefix',
    params: [
      { key: 'field',  label: 'Field',   placeholder: 'code'  },
      { key: 'prefix', label: 'Prefix', placeholder: 'IT'   },
    ],
    toFpel: (p, cs) => `starts_with(${fpelText(p.field, cs)}, ${fpelLit(p.prefix, cs)})`,
  },
  {
    id: 'str_ends', category: 'Strings', label: 'Ends with',
    description: 'The string field ends with the suffix',
    params: [
      { key: 'field',  label: 'Field',   placeholder: 'email' },
      { key: 'suffix', label: 'Suffix', placeholder: '.com' },
    ],
    toFpel: (p, cs) => `ends_with(${fpelText(p.field, cs)}, ${fpelLit(p.suffix, cs)})`,
  },
  {
    id: 'str_regex', category: 'Strings', label: 'Match regex',
    description: 'The string field matches the regular expression',
    params: [
      { key: 'field',   label: 'Field', placeholder: 'phone'       },
      { key: 'pattern', label: 'Regex', placeholder: '^\\+39\\d+$' },
    ],
    toFpel: (p, cs) => `regex_match(to_string(${fpelField(p.field)}), ${fpelRegex(p.pattern, cs)})`,
  },
  {
    id: 'str_is_empty', category: 'Strings', label: 'Is empty',
    description: 'The field is null or an empty/blank string',
    params: [{ key: 'field', label: 'Field', placeholder: 'notes' }],
    toFpel: (p) => `${fpelField(p.field)} is null || trim(to_string(${fpelField(p.field)})) == ""`,
  },

  // ── Null ──────────────────────────────────────────────────────
  {
    id: 'is_null', category: 'Null', label: 'Is null',
    description: 'The field is null or missing',
    params: [{ key: 'field', label: 'Field', placeholder: 'deleted_at' }],
    toFpel: (p) => `${fpelField(p.field)} is null`,
  },
  {
    id: 'is_not_null', category: 'Null', label: 'Is not null',
    description: 'The field has a value',
    params: [{ key: 'field', label: 'Field', placeholder: 'email' }],
    toFpel: (p) => `${fpelField(p.field)} is not null`,
  },
]

// Raggruppa template per categoria
export function getTemplatesByCategory(): Record<string, FilterTemplate[]> {
  return FILTER_TEMPLATES.reduce((acc, t) => {
    acc[t.category] = acc[t.category] ?? []
    acc[t.category].push(t)
    return acc
  }, {} as Record<string, FilterTemplate[]>)
}

/** Una clausola visuale in FPEL, con la stessa semantica del motore.
 *  `nullExcludes`: col "Null behavior" exclude/error un campo null rende
 *  falsa la clausola — in FPEL serve la guardia solo dove null darebbe
 *  vero (!= e not in); altrove il null è già falso. */
function clauseToFpel(c: VisualClause, cs: boolean, nullExcludes: boolean): string {
  const f   = fpelField(c.field)
  const txt = fpelText(c.field, cs)
  const lit = fpelLit(c.value, cs)
  const list = () => (c.value || '').split(',').map((v) => `${txt} == ${fpelLit(v.trim(), cs)}`).join(' || ')
  switch (c.operator) {
    case 'is_null':  return `${f} is null`
    case 'not_null': return `${f} is not null`
    case '==':       return `${txt} == ${lit}`
    case '!=':       return nullExcludes ? `${f} is not null && ${txt} != ${lit}` : `${txt} != ${lit}`
    case '>': case '>=': case '<': case '<=':
      return `to_float(${f}) ${c.operator} ${fpelNumber(c.value)}`
    case 'contains': return `contains(${txt}, ${lit})`
    case 'starts':   return `starts_with(${txt}, ${lit})`
    case 'ends':     return `ends_with(${txt}, ${lit})`
    case 'in':       return `(${list()})`
    case 'not_in':   return nullExcludes ? `${f} is not null && !(${list()})` : `!(${list()})`
    case 'regex':    return `regex_match(to_string(${f}), ${fpelRegex(c.value, cs)})`
    default:         return 'true'
  }
}

/**
 * L'FPEL equivalente di una condizione, qualunque sia la modalità:
 * anteprima ("Generated FPEL") e punto di partenza quando si passa alla
 * modalità code. Le clausole visuali si combinano da sinistra a destra
 * (come nel motore: il connettore sta sulla clausola precedente), da
 * cui le parentesi. Il "Null behavior" del nodo vale solo per le
 * clausole visuali: qui si traduce con le guardie `is not null`; in
 * FPEL un confronto con null è falso (semantica SQL).
 */
export function conditionToFpel(
  cond: FilterCondition, caseSensitive: boolean,
  nullBehavior: FilterConfig['nullBehavior'] = 'exclude',
): string {
  const nx = nullBehavior !== 'include'
  switch (cond.mode) {
    case 'code':
      return (cond.code ?? '').trim() || 'true'

    case 'template': {
      const tmpl = FILTER_TEMPLATES.find((t) => t.id === cond.templateId)
      if (!tmpl) return ''
      const params = Object.fromEntries(
        tmpl.params.map((p) => [p.key, cond.templateParams?.[p.key] || p.placeholder])
      )
      return tmpl.toFpel(params, caseSensitive)
    }

    case 'visual': {
      const clauses = cond.clauses ?? []
      if (!clauses.length) return 'true'
      const one = (c: VisualClause) => {
        const x = clauseToFpel(c, caseSensitive, nx)
        return clauses.length > 1 && x.includes(' && ') ? `(${x})` : x
      }
      let acc = one(clauses[0])
      for (let i = 1; i < clauses.length; i++) {
        const op = clauses[i - 1].logic === 'OR' ? '||' : '&&'
        const left = i === 1 ? acc : `(${acc})`
        acc = `${left} ${op} ${one(clauses[i])}`
      }
      return acc
    }

    default:
      return 'true'
  }
}
