/**
 * src/nodes/types/data_quality/dqTypes.ts
 * ─────────────────────────────────────────
 * Tipi per il nuovo componente Data Quality con remediation e trust score.
 */

// ─── Dimensioni del Data Trust Score ─────────────────────────────
export type DQDimension =
  | 'completeness'   // campi presenti e non vuoti
  | 'conformity'     // valori nel formato atteso
  | 'consistency'    // coerenza interna tra campi
  | 'accuracy'       // plausibilità del valore nel dominio

// ─── Tipo di check ────────────────────────────────────────────────
export type DQCheckType =
  // Completeness
  | 'not_null'
  | 'not_empty'
  // Conformity
  | 'pattern'
  | 'is_numeric'
  | 'is_date'
  | 'is_email'
  | 'is_url'
  | 'min_length'
  | 'max_length'
  // Consistency
  | 'range'
  | 'in_list'
  | 'not_in_list'
  | 'compare_fields'  // es. data_fine > data_inizio
  // Accuracy
  | 'referential'     // valore esiste in lookup
  | 'custom'          // espressione JS

// ─── Strategia di repair ──────────────────────────────────────────
export type DQRepairStrategy =
  | 'none'                 // non riparare — solo segnala
  | 'set_default'          // imposta un valore fisso
  | 'set_null'             // forza null
  | 'set_empty_string'     // forza stringa vuota
  | 'copy_from_field'      // copia da altro campo della stessa riga
  | 'concat_fields'        // concatena più campi
  | 'copy_from_previous'   // usa valore del record precedente
  | 'lookup_from_file'     // cerca in file CSV/JSON
  | 'lookup_from_materialize' // cerca in dataset in memoria
  | 'expression'           // espressione JS custom

// ─── Regola DQ completa ───────────────────────────────────────────
export interface DQRule {
  id:        string
  field:     string
  label:     string          // descrizione human-readable
  dimension: DQDimension
  severity:  'error' | 'warn'
  enabled:   boolean

  // Parametri check
  checkType:   DQCheckType
  pattern?:    string        // per pattern, is_date
  min?:        string        // per range, min_length
  max?:        string        // per range, max_length
  list?:       string        // per in_list, not_in_list (CSV)
  matName?:    string        // per referential, lookup_from_materialize
  refField?:   string        // per referential
  compareField?: string      // per compare_fields
  compareOp?:  string        // '>' | '<' | '>=' | '<=' | '==' | '!='
  expression?: string        // per custom

  // Repair
  repair:          DQRepairStrategy
  repairDefault?:  string    // valore fisso per set_default
  repairField?:    string    // campo sorgente per copy_from_field
  repairFields?:   string    // campi per concat_fields (CSV)
  repairSeparator?: string   // separatore per concat_fields
  repairFile?:     string    // path file per lookup_from_file
  repairFileKey?:  string    // colonna chiave nel file
  repairFileValue?: string   // colonna valore nel file
  repairExpression?: string  // per expression
}

// ─── Configurazione dimensioni e pesi ────────────────────────────
export interface DQDimensionWeights {
  completeness: number   // default 0.30
  conformity:   number   // default 0.30
  consistency:  number   // default 0.20
  accuracy:     number   // default 0.20
}

// ─── Configurazione soglie ────────────────────────────────────────
export interface DQThresholds {
  valid:    number   // score >= questo → _dq.valid = true (default 0.8)
  warning:  number   // score >= questo → _dq.level = 'warn' (default 0.6)
}

// ─── Configurazione completa nodo ────────────────────────────────
export interface DQConfig {
  rules:           DQRule[]
  weights:         DQDimensionWeights
  thresholds:      DQThresholds
  outputField:     string   // nome campo aggiunto (default '_dq')
  showOriginal:    boolean  // includi valori originali prima del repair
  scoreBeforeRepair: boolean // calcola score sia prima che dopo repair
}

// ─── Risultato per singola regola (a runtime) ─────────────────────
export interface DQIssue {
  rule:      string          // rule.id
  field:     string
  dimension: DQDimension
  severity:  'error' | 'warn'
  message:   string
  repaired:  boolean
  action?:   DQRepairStrategy
  original?: unknown         // valore prima del repair
  newValue?: unknown         // valore dopo il repair
}

// ─── Risultato per singola riga (a runtime) ───────────────────────
export interface DQResult {
  score:             number   // 0-1 score finale (post-repair)
  scoreOriginal?:    number   // 0-1 score prima del repair
  valid:             boolean  // score >= threshold.valid
  level:             'ok' | 'warn' | 'error'
  repaired:          boolean  // almeno un campo riparato
  issues:            DQIssue[]
  dimensions: {
    completeness: number
    conformity:   number
    consistency:  number
    accuracy:     number
  }
}

// ─── Default config ───────────────────────────────────────────────
export const DEFAULT_DQ_CONFIG: DQConfig = {
  rules:       [],
  weights:     { completeness: 0.30, conformity: 0.30, consistency: 0.20, accuracy: 0.20 },
  thresholds:  { valid: 0.80, warning: 0.60 },
  outputField: '_dq',
  showOriginal: false,
  scoreBeforeRepair: false,
}

// ─── Metadati check per UI ────────────────────────────────────────
export const DQ_CHECK_DEFS: Array<{
  type:      DQCheckType
  label:     string
  dimension: DQDimension
  params:    string[]
  desc:      string
}> = [
  // Completeness
  { type: 'not_null',       label: 'Not Null',        dimension: 'completeness', params: [],                     desc: 'Il campo non può essere null' },
  { type: 'not_empty',      label: 'Not Empty',       dimension: 'completeness', params: [],                     desc: 'Il campo non può essere vuoto' },
  // Conformity
  { type: 'pattern',        label: 'Pattern Regex',   dimension: 'conformity',   params: ['pattern'],            desc: 'Deve corrispondere alla regex' },
  { type: 'is_numeric',     label: 'Numerico',        dimension: 'conformity',   params: [],                     desc: 'Deve essere un numero' },
  { type: 'is_date',        label: 'Data valida',     dimension: 'conformity',   params: ['pattern'],            desc: 'Deve essere una data valida' },
  { type: 'is_email',       label: 'Email',           dimension: 'conformity',   params: [],                     desc: 'Deve essere un indirizzo email' },
  { type: 'is_url',         label: 'URL',             dimension: 'conformity',   params: [],                     desc: 'Deve essere un URL valido' },
  { type: 'min_length',     label: 'Lunghezza min',   dimension: 'conformity',   params: ['min'],                desc: 'Lunghezza minima' },
  { type: 'max_length',     label: 'Lunghezza max',   dimension: 'conformity',   params: ['max'],                desc: 'Lunghezza massima' },
  // Consistency
  { type: 'range',          label: 'Range numerico',  dimension: 'consistency',  params: ['min', 'max'],         desc: 'Valore tra min e max' },
  { type: 'in_list',        label: 'In lista',        dimension: 'consistency',  params: ['list'],               desc: 'Valore in lista ammessa' },
  { type: 'not_in_list',    label: 'Non in lista',    dimension: 'consistency',  params: ['list'],               desc: 'Valore non in lista esclusa' },
  { type: 'compare_fields', label: 'Confronto campi', dimension: 'consistency',  params: ['compareField','compareOp'], desc: 'Confronto tra due campi' },
  // Accuracy
  { type: 'referential',    label: 'Referenziale',    dimension: 'accuracy',     params: ['matName','refField'], desc: 'Valore esiste nel lookup' },
  { type: 'custom',         label: 'Custom JS',       dimension: 'accuracy',     params: ['expression'],         desc: 'Espressione JavaScript custom' },
]

export const DQ_REPAIR_DEFS: Array<{
  strategy: DQRepairStrategy
  label:    string
  params:   string[]
  desc:     string
}> = [
  { strategy: 'none',                    label: 'Solo segnala',          params: [],                                           desc: 'Non modifica il valore — aggiunge solo il problema in _dq.issues' },
  { strategy: 'set_default',             label: 'Valore default',        params: ['repairDefault'],                            desc: 'Sostituisce con un valore fisso configurato' },
  { strategy: 'set_null',                label: 'Forza null',            params: [],                                           desc: 'Imposta il campo a null' },
  { strategy: 'set_empty_string',        label: 'Stringa vuota',         params: [],                                           desc: 'Imposta il campo a stringa vuota' },
  { strategy: 'copy_from_field',         label: 'Copia da campo',        params: ['repairField'],                              desc: 'Copia il valore da un altro campo della stessa riga' },
  { strategy: 'concat_fields',           label: 'Concatena campi',       params: ['repairFields', 'repairSeparator'],          desc: 'Concatena più campi con un separatore' },
  { strategy: 'copy_from_previous',      label: 'Record precedente',     params: [],                                           desc: 'Usa il valore dal record precedente (forward fill)' },
  { strategy: 'lookup_from_file',        label: 'Lookup da file',        params: ['repairFile','repairFileKey','repairFileValue'], desc: 'Cerca il valore in un file CSV di riferimento' },
  { strategy: 'lookup_from_materialize', label: 'Lookup da Materialize', params: ['matName','repairFileKey','repairFileValue'], desc: 'Cerca il valore in un dataset in memoria' },
  { strategy: 'expression',              label: 'Espressione JS',        params: ['repairExpression'],                         desc: 'Calcola il nuovo valore con una espressione JavaScript' },
]
