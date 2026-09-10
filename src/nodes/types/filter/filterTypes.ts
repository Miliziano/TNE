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

  // mode === 'code'
  lang?:     string         // 'typescript' | 'python' | 'java'
  code?:     string         // (row) => boolean
}

export interface FilterConfig {
  conditions: FilterCondition[]   // ordine = priorità (first-match)
  // Opzioni globali
  nullBehavior:  'exclude' | 'include' | 'error'
  caseSensitive: boolean
}

// ─── Template predefiniti ─────────────────────────────────────────

export interface FilterTemplate {
  id:          string
  label:       string
  category:    string
  description: string
  params:      Array<{ key: string; label: string; placeholder: string }>
  // Genera codice TS dalla condizione
  toCode:      (params: Record<string, string>) => string
}

export const FILTER_TEMPLATES: FilterTemplate[] = [
  // ── Date ──────────────────────────────────────────────────────
  {
    id: 'date_is_today', category: 'Date', label: 'Is today',
    description: 'The date equals today',
    params: [{ key: 'field', label: 'Date field', placeholder: 'created_at' }],
    toCode: (p) => `new Date(row.${p.field}).toDateString() === new Date().toDateString()`,
  },
  {
    id: 'date_is_past', category: 'Date', label: 'Is in the past',
    description: 'The date is before today',
    params: [{ key: 'field', label: 'Date field', placeholder: 'created_at' }],
    toCode: (p) => `new Date(row.${p.field}) < new Date()`,
  },
  {
    id: 'date_is_future', category: 'Date', label: 'Is in the future',
    description: 'The date is after today',
    params: [{ key: 'field', label: 'Date field', placeholder: 'expiry_at' }],
    toCode: (p) => `new Date(row.${p.field}) > new Date()`,
  },
  {
    id: 'date_range', category: 'Date', label: 'Date range',
    description: 'The date is between two dates',
    params: [
      { key: 'field', label: 'Date field',    placeholder: 'created_at' },
      { key: 'from',  label: 'Start date',   placeholder: '2024-01-01' },
      { key: 'to',    label: 'End date',     placeholder: '2024-12-31' },
    ],
    toCode: (p) => `new Date(row.${p.field}) >= new Date('${p.from}') && new Date(row.${p.field}) <= new Date('${p.to}')`,
  },
  {
    id: 'date_is_weekend', category: 'Date', label: 'Is weekend',
    description: 'The date falls on Saturday or Sunday',
    params: [{ key: 'field', label: 'Date field', placeholder: 'created_at' }],
    toCode: (p) => `[0, 6].includes(new Date(row.${p.field}).getDay())`,
  },

  // ── Numeri ────────────────────────────────────────────────────
  {
    id: 'num_greater', category: 'Numbers', label: 'Greater than',
    description: 'The numeric value is greater than the threshold',
    params: [
      { key: 'field',     label: 'Field',  placeholder: 'amount' },
      { key: 'threshold', label: 'Threshold', placeholder: '100'    },
    ],
    toCode: (p) => `Number(row.${p.field}) > ${p.threshold}`,
  },
  {
    id: 'num_less', category: 'Numbers', label: 'Less than',
    description: 'The numeric value is less than the threshold',
    params: [
      { key: 'field',     label: 'Field',  placeholder: 'amount' },
      { key: 'threshold', label: 'Threshold', placeholder: '0'      },
    ],
    toCode: (p) => `Number(row.${p.field}) < ${p.threshold}`,
  },
  {
    id: 'num_between', category: 'Numbers', label: 'Between',
    description: 'The value is between min and max',
    params: [
      { key: 'field', label: 'Field', placeholder: 'score' },
      { key: 'min',   label: 'Min',   placeholder: '0'     },
      { key: 'max',   label: 'Max',   placeholder: '100'   },
    ],
    toCode: (p) => `Number(row.${p.field}) >= ${p.min} && Number(row.${p.field}) <= ${p.max}`,
  },
  {
    id: 'num_is_zero', category: 'Numbers', label: 'Is zero',
    description: 'The value is exactly 0',
    params: [{ key: 'field', label: 'Field', placeholder: 'quantity' }],
    toCode: (p) => `Number(row.${p.field}) === 0`,
  },
  {
    id: 'num_is_negative', category: 'Numbers', label: 'Is negative',
    description: 'The value is less than 0',
    params: [{ key: 'field', label: 'Field', placeholder: 'balance' }],
    toCode: (p) => `Number(row.${p.field}) < 0`,
  },

  // ── Stringhe ──────────────────────────────────────────────────
  {
    id: 'str_contains', category: 'Strings', label: 'Contains',
    description: 'The string field contains the text',
    params: [
      { key: 'field', label: 'Field', placeholder: 'name'   },
      { key: 'text',  label: 'Text', placeholder: 'john'  },
    ],
    toCode: (p) => `String(row.${p.field} ?? '').toLowerCase().includes('${(p.text ?? '').toLowerCase()}')`,
  },
  {
    id: 'str_starts', category: 'Strings', label: 'Starts with',
    description: 'The string field starts with the prefix',
    params: [
      { key: 'field',  label: 'Field',   placeholder: 'code'  },
      { key: 'prefix', label: 'Prefix', placeholder: 'IT'   },
    ],
    toCode: (p) => `String(row.${p.field} ?? '').startsWith('${p.prefix}')`,
  },
  {
    id: 'str_ends', category: 'Strings', label: 'Ends with',
    description: 'The string field ends with the suffix',
    params: [
      { key: 'field',  label: 'Field',   placeholder: 'email' },
      { key: 'suffix', label: 'Suffix', placeholder: '.com' },
    ],
    toCode: (p) => `String(row.${p.field} ?? '').endsWith('${p.suffix}')`,
  },
  {
    id: 'str_regex', category: 'Strings', label: 'Match regex',
    description: 'The string field matches the regex',
    params: [
      { key: 'field',   label: 'Field', placeholder: 'phone'       },
      { key: 'pattern', label: 'Regex', placeholder: '^\\+39\\d+$' },
    ],
    toCode: (p) => `new RegExp('${p.pattern}').test(String(row.${p.field} ?? ''))`,
  },
  {
    id: 'str_is_empty', category: 'Strings', label: 'Is empty',
    description: 'The field is null, undefined or empty string',
    params: [{ key: 'field', label: 'Field', placeholder: 'notes' }],
    toCode: (p) => `!row.${p.field} || String(row.${p.field}).trim() === ''`,
  },

  // ── Null ──────────────────────────────────────────────────────
  {
    id: 'is_null', category: 'Null', label: 'Is null',
    description: 'The field is null or undefined',
    params: [{ key: 'field', label: 'Field', placeholder: 'deleted_at' }],
    toCode: (p) => `row.${p.field} == null`,
  },
  {
    id: 'is_not_null', category: 'Null', label: 'Is not null',
    description: 'The field has a value',
    params: [{ key: 'field', label: 'Field', placeholder: 'email' }],
    toCode: (p) => `row.${p.field} != null`,
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

// Genera il codice di una condizione qualunque sia la modalità
export function conditionToCode(cond: FilterCondition): string {
  switch (cond.mode) {
    case 'code':
      return cond.code ?? 'true'

    case 'template': {
      const tmpl = FILTER_TEMPLATES.find((t) => t.id === cond.templateId)
      if (!tmpl) return '/* seleziona un template */'
      // Sostituisce parametri mancanti con placeholder
      const safeParams = Object.fromEntries(
        tmpl.params.map((p) => [p.key, cond.templateParams?.[p.key] ?? p.placeholder])
      )
      try {
        return tmpl.toCode(safeParams)
      } catch {
        return '/* parametri incompleti */'
      }
    }

    case 'visual': {
      if (!cond.clauses?.length) return 'true'
      return cond.clauses.map((clause, i) => {
        const prefix = i === 0 ? '' : ` ${clause.logic} `
        const f = `row.${clause.field || 'field'}`
        switch (clause.operator) {
          case 'is_null':  return `${prefix}${f} == null`
          case 'not_null': return `${prefix}${f} != null`
          case 'contains': return `${prefix}String(${f} ?? '').includes('${clause.value}')`
          case 'starts':   return `${prefix}String(${f} ?? '').startsWith('${clause.value}')`
          case 'ends':     return `${prefix}String(${f} ?? '').endsWith('${clause.value}')`
          case 'in':       return `${prefix}[${(clause.value || '').split(',').map((v) => `'${v.trim()}'`).join(',')}].includes(String(${f}))`
          case 'not_in':   return `${prefix}![${(clause.value || '').split(',').map((v) => `'${v.trim()}'`).join(',')}].includes(String(${f}))`
          case 'regex':    return `${prefix}new RegExp('${clause.value || ''}').test(String(${f} ?? ''))`
          default:         return `${prefix}${f} ${clause.operator} ${isNaN(Number(clause.value)) ? `'${clause.value}'` : clause.value || '0'}`
        }
      }).join('')
    }

    default:
      return 'true'
  }
}
