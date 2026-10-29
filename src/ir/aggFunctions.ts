/**
 * src/ir/aggFunctions.ts
 * ──────────────────────
 * Catalogo UNICO delle funzioni di aggregazione.
 *
 * Prima esisteva in tre copie divergenti:
 *   - aggregate/Panel.tsx       → array  { value, label, needsField, outputType, desc }
 *   - aggregate/MappingPanel.tsx → Record { label, outputType, color }
 *   - pivot/Panel.tsx            → array  { value, label }  (sottoinsieme)
 * Tre elenchi della stessa cosa: il tipo di ritorno di una funzione è
 * semantica, non grafica, e deve stare in un posto solo — anche perché
 * ora lo legge la propagazione dello schema, non solo i pannelli.
 *
 * Vive nell'IR e non nella UI perché è l'IR a dover derivare lo schema:
 * il verso della dipendenza è UI → IR, mai il contrario. Il colore, che
 * è l'unica cosa davvero grafica, resta nel pannello.
 */
import type { FieldType } from './types'

export interface AggFunctionDef {
  value:      string
  label:      string
  /** false = non richiede un campo (COUNT conta le righe) */
  needsField: boolean
  outputType: FieldType
  desc:       string
}

export const AGG_FUNCTIONS: AggFunctionDef[] = [
  { value: 'count',          label: 'COUNT',          needsField: false, outputType: 'integer', desc: 'Counts the rows of the group'             },
  { value: 'count_distinct', label: 'COUNT DISTINCT', needsField: true,  outputType: 'integer', desc: 'Counts the distinct values of the field'        },
  { value: 'sum',            label: 'SUM',            needsField: true,  outputType: 'decimal', desc: 'Sums the values of the field'              },
  { value: 'avg',            label: 'AVG',            needsField: true,  outputType: 'decimal', desc: 'Average of the field'            },
  { value: 'min',            label: 'MIN',            needsField: true,  outputType: 'any',     desc: 'Minimum value of the field'               },
  { value: 'max',            label: 'MAX',            needsField: true,  outputType: 'any',     desc: 'Maximum value of the field'              },
  { value: 'first',          label: 'FIRST',          needsField: true,  outputType: 'any',     desc: 'First value met'               },
  { value: 'last',           label: 'LAST',           needsField: true,  outputType: 'any',     desc: 'Last value met'              },
  { value: 'std_dev',        label: 'STD DEV',        needsField: true,  outputType: 'decimal', desc: 'Deviazione standard'                   },
  { value: 'variance',       label: 'VARIANCE',       needsField: true,  outputType: 'decimal', desc: 'Variance of the field'                    },
  { value: 'median',         label: 'MEDIAN',         needsField: true,  outputType: 'decimal', desc: 'Median value'                        },
  { value: 'array_agg',      label: 'ARRAY AGG',      needsField: true,  outputType: 'object',  desc: 'Collects all the values into an array'  },
  { value: 'string_agg',     label: 'STRING AGG',     needsField: true,  outputType: 'string',  desc: 'Joins the values with a separator'     },
  { value: 'json_agg',       label: 'JSON AGG',       needsField: true,  outputType: 'object',  desc: 'Collects the values into a JSON array'   },
]

/** Lookup per valore — l'accesso più frequente. */
export const AGG_FUNCTION_BY_VALUE: Record<string, AggFunctionDef> =
  Object.fromEntries(AGG_FUNCTIONS.map((f) => [f.value, f]))

/** Tipo di ritorno di una funzione; 'any' per le sconosciute. */
export function aggOutputType(fn: string): FieldType {
  return AGG_FUNCTION_BY_VALUE[fn]?.outputType ?? 'any'
}
