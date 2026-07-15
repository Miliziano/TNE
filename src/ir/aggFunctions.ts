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
  { value: 'count',          label: 'COUNT',          needsField: false, outputType: 'integer', desc: 'Conta le righe del gruppo'             },
  { value: 'count_distinct', label: 'COUNT DISTINCT', needsField: true,  outputType: 'integer', desc: 'Conta i valori unici del campo'        },
  { value: 'sum',            label: 'SUM',            needsField: true,  outputType: 'decimal', desc: 'Somma i valori del campo'              },
  { value: 'avg',            label: 'AVG',            needsField: true,  outputType: 'decimal', desc: 'Calcola la media del campo'            },
  { value: 'min',            label: 'MIN',            needsField: true,  outputType: 'any',     desc: 'Valore minimo del campo'               },
  { value: 'max',            label: 'MAX',            needsField: true,  outputType: 'any',     desc: 'Valore massimo del campo'              },
  { value: 'first',          label: 'FIRST',          needsField: true,  outputType: 'any',     desc: 'Primo valore incontrato'               },
  { value: 'last',           label: 'LAST',           needsField: true,  outputType: 'any',     desc: 'Ultimo valore incontrato'              },
  { value: 'std_dev',        label: 'STD DEV',        needsField: true,  outputType: 'decimal', desc: 'Deviazione standard'                   },
  { value: 'variance',       label: 'VARIANCE',       needsField: true,  outputType: 'decimal', desc: 'Varianza del campo'                    },
  { value: 'median',         label: 'MEDIAN',         needsField: true,  outputType: 'decimal', desc: 'Valore mediano'                        },
  { value: 'array_agg',      label: 'ARRAY AGG',      needsField: true,  outputType: 'object',  desc: 'Raccoglie tutti i valori in un array'  },
  { value: 'string_agg',     label: 'STRING AGG',     needsField: true,  outputType: 'string',  desc: 'Concatena i valori con separatore'     },
  { value: 'json_agg',       label: 'JSON AGG',       needsField: true,  outputType: 'object',  desc: 'Raccoglie i valori in un array JSON'   },
]

/** Lookup per valore — l'accesso più frequente. */
export const AGG_FUNCTION_BY_VALUE: Record<string, AggFunctionDef> =
  Object.fromEntries(AGG_FUNCTIONS.map((f) => [f.value, f]))

/** Tipo di ritorno di una funzione; 'any' per le sconosciute. */
export function aggOutputType(fn: string): FieldType {
  return AGG_FUNCTION_BY_VALUE[fn]?.outputType ?? 'any'
}
