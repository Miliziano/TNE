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
    id: 'date_is_today', category: 'Date', label: 'È oggi',
    description: 'La data è uguale a oggi',
    params: [{ key: 'field', label: 'Campo data', placeholder: 'created_at' }],
    toCode: (p) => `new Date(row.${p.field}).toDateString() === new Date().toDateString()`,
  },
  {
    id: 'date_is_past', category: 'Date', label: 'È nel passato',
    description: 'La data è precedente a oggi',
    params: [{ key: 'field', label: 'Campo data', placeholder: 'created_at' }],
    toCode: (p) => `new Date(row.${p.field}) < new Date()`,
  },
  {
    id: 'date_is_future', category: 'Date', label: 'È nel futuro',
    description: 'La data è successiva a oggi',
    params: [{ key: 'field', label: 'Campo data', placeholder: 'expiry_at' }],
    toCode: (p) => `new Date(row.${p.field}) > new Date()`,
  },
  {
    id: 'date_range', category: 'Date', label: 'Intervallo date',
    description: 'La data è compresa tra due date',
    params: [
      { key: 'field', label: 'Campo data',    placeholder: 'created_at' },
      { key: 'from',  label: 'Data inizio',   placeholder: '2024-01-01' },
      { key: 'to',    label: 'Data fine',     placeholder: '2024-12-31' },
    ],
    toCode: (p) => `new Date(row.${p.field}) >= new Date('${p.from}') && new Date(row.${p.field}) <= new Date('${p.to}')`,
  },
  {
    id: 'date_is_weekend', category: 'Date', label: 'È weekend',
    description: 'La data cade di sabato o domenica',
    params: [{ key: 'field', label: 'Campo data', placeholder: 'created_at' }],
    toCode: (p) => `[0, 6].includes(new Date(row.${p.field}).getDay())`,
  },

  // ── Numeri ────────────────────────────────────────────────────
  {
    id: 'num_greater', category: 'Numeri', label: 'Maggiore di',
    description: 'Il valore numerico è maggiore della soglia',
    params: [
      { key: 'field',     label: 'Campo',  placeholder: 'amount' },
      { key: 'threshold', label: 'Soglia', placeholder: '100'    },
    ],
    toCode: (p) => `Number(row.${p.field}) > ${p.threshold}`,
  },
  {
    id: 'num_less', category: 'Numeri', label: 'Minore di',
    description: 'Il valore numerico è minore della soglia',
    params: [
      { key: 'field',     label: 'Campo',  placeholder: 'amount' },
      { key: 'threshold', label: 'Soglia', placeholder: '0'      },
    ],
    toCode: (p) => `Number(row.${p.field}) < ${p.threshold}`,
  },
  {
    id: 'num_between', category: 'Numeri', label: 'Compreso tra',
    description: 'Il valore è compreso tra min e max',
    params: [
      { key: 'field', label: 'Campo', placeholder: 'score' },
      { key: 'min',   label: 'Min',   placeholder: '0'     },
      { key: 'max',   label: 'Max',   placeholder: '100'   },
    ],
    toCode: (p) => `Number(row.${p.field}) >= ${p.min} && Number(row.${p.field}) <= ${p.max}`,
  },
  {
    id: 'num_is_zero', category: 'Numeri', label: 'È zero',
    description: 'Il valore è esattamente 0',
    params: [{ key: 'field', label: 'Campo', placeholder: 'quantity' }],
    toCode: (p) => `Number(row.${p.field}) === 0`,
  },
  {
    id: 'num_is_negative', category: 'Numeri', label: 'È negativo',
    description: 'Il valore è minore di 0',
    params: [{ key: 'field', label: 'Campo', placeholder: 'balance' }],
    toCode: (p) => `Number(row.${p.field}) < 0`,
  },

  // ── Stringhe ──────────────────────────────────────────────────
  {
    id: 'str_contains', category: 'Stringhe', label: 'Contiene',
    description: 'Il campo stringa contiene il testo',
    params: [
      { key: 'field', label: 'Campo', placeholder: 'name'   },
      { key: 'text',  label: 'Testo', placeholder: 'mario'  },
    ],
    toCode: (p) => `String(row.${p.field} ?? '').toLowerCase().includes('${(p.text ?? '').toLowerCase()}')`,
  },
  {
    id: 'str_starts', category: 'Stringhe', label: 'Inizia con',
    description: 'Il campo stringa inizia con il prefisso',
    params: [
      { key: 'field',  label: 'Campo',   placeholder: 'code'  },
      { key: 'prefix', label: 'Prefisso', placeholder: 'IT'   },
    ],
    toCode: (p) => `String(row.${p.field} ?? '').startsWith('${p.prefix}')`,
  },
  {
    id: 'str_ends', category: 'Stringhe', label: 'Finisce con',
    description: 'Il campo stringa finisce con il suffisso',
    params: [
      { key: 'field',  label: 'Campo',   placeholder: 'email' },
      { key: 'suffix', label: 'Suffisso', placeholder: '.com' },
    ],
    toCode: (p) => `String(row.${p.field} ?? '').endsWith('${p.suffix}')`,
  },
  {
    id: 'str_regex', category: 'Stringhe', label: 'Match regex',
    description: 'Il campo stringa corrisponde alla regex',
    params: [
      { key: 'field',   label: 'Campo', placeholder: 'phone'       },
      { key: 'pattern', label: 'Regex', placeholder: '^\\+39\\d+$' },
    ],
    toCode: (p) => `new RegExp('${p.pattern}').test(String(row.${p.field} ?? ''))`,
  },
  {
    id: 'str_is_empty', category: 'Stringhe', label: 'È vuoto',
    description: 'Il campo è null, undefined o stringa vuota',
    params: [{ key: 'field', label: 'Campo', placeholder: 'notes' }],
    toCode: (p) => `!row.${p.field} || String(row.${p.field}).trim() === ''`,
  },

  // ── Null ──────────────────────────────────────────────────────
  {
    id: 'is_null', category: 'Null', label: 'È null',
    description: 'Il campo è null o undefined',
    params: [{ key: 'field', label: 'Campo', placeholder: 'deleted_at' }],
    toCode: (p) => `row.${p.field} == null`,
  },
  {
    id: 'is_not_null', category: 'Null', label: 'Non è null',
    description: 'Il campo ha un valore',
    params: [{ key: 'field', label: 'Campo', placeholder: 'email' }],
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
        const f = `row.${clause.field || 'campo'}`
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
