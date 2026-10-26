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
// Allineati al motore (src-tauri/src/engine/nodes/data_quality.rs, P368):
// un valore null passa tutti i check tranne not_null/not_empty/custom.
export const DQ_CHECK_DEFS: Array<{
  type:      DQCheckType
  label:     string
  dimension: DQDimension
  params:    string[]
  desc:      string
}> = [
  // Completeness
  { type: 'not_null',       label: 'Not null',          dimension: 'completeness', params: [],                     desc: 'The field must not be null' },
  { type: 'not_empty',      label: 'Not empty',         dimension: 'completeness', params: [],                     desc: 'The field must not be null or blank' },
  // Conformity
  { type: 'pattern',        label: 'Regex pattern',     dimension: 'conformity',   params: ['pattern'],            desc: 'The value must match the regex' },
  { type: 'is_numeric',     label: 'Numeric',           dimension: 'conformity',   params: [],                     desc: 'The value must be a number' },
  { type: 'is_date',        label: 'Valid date',        dimension: 'conformity',   params: [],                     desc: 'The value must be a date: yyyy-MM-dd, dd/MM/yyyy, MM/dd/yyyy or yyyy/MM/dd, time optional' },
  { type: 'is_email',       label: 'Email',             dimension: 'conformity',   params: [],                     desc: 'The value must look like an email address' },
  { type: 'is_url',         label: 'URL',               dimension: 'conformity',   params: [],                     desc: 'The value must start with http:// or https://' },
  { type: 'min_length',     label: 'Min length',        dimension: 'conformity',   params: ['min'],                desc: 'Minimum number of characters' },
  { type: 'max_length',     label: 'Max length',        dimension: 'conformity',   params: ['max'],                desc: 'Maximum number of characters' },
  // Consistency
  { type: 'range',          label: 'Numeric range',     dimension: 'consistency',  params: ['min', 'max'],         desc: 'Number between min and max (an empty bound is open)' },
  { type: 'in_list',        label: 'In list',           dimension: 'consistency',  params: ['list'],               desc: 'The value must be one of the list' },
  { type: 'not_in_list',    label: 'Not in list',       dimension: 'consistency',  params: ['list'],               desc: 'The value must not be one of the list' },
  { type: 'compare_fields', label: 'Compare fields',    dimension: 'consistency',  params: ['compareField','compareOp'], desc: 'Compares the field with another field of the row (numbers if both are numeric, otherwise text)' },
  // Accuracy
  { type: 'referential',    label: 'Referential',       dimension: 'accuracy',     params: ['matName','refField'], desc: 'The value must exist in a column of a Materialize dataset' },
  { type: 'custom',         label: 'FPEL expression',   dimension: 'accuracy',     params: ['expression'],         desc: 'An FPEL condition: true = the row passes' },
]

/** Strategie offerte. `lookup_from_file` non c'è più: il motore non lo fa
 *  (si carica il file con source_file → Materialize e si usa il lookup da
 *  Materialize); una regola salvata con quel valore lo mostra come non
 *  supportato. */
export const DQ_REPAIR_DEFS: Array<{
  strategy: DQRepairStrategy
  label:    string
  params:   string[]
  desc:     string
}> = [
  { strategy: 'none',                    label: 'Report only',           params: [],                                           desc: 'Leaves the value as it is — the problem goes in _dq.issues' },
  { strategy: 'set_default',             label: 'Default value',         params: ['repairDefault'],                            desc: 'Replaces the value with a fixed one' },
  { strategy: 'set_null',                label: 'Set null',              params: [],                                           desc: 'Sets the field to null' },
  { strategy: 'set_empty_string',        label: 'Empty string',          params: [],                                           desc: 'Sets the field to an empty string' },
  { strategy: 'copy_from_field',         label: 'Copy from field',       params: ['repairField'],                              desc: 'Copies the value of another field of the same row' },
  { strategy: 'concat_fields',           label: 'Concatenate fields',    params: ['repairFields', 'repairSeparator'],          desc: 'Joins several fields with a separator (null fields are skipped)' },
  { strategy: 'copy_from_previous',      label: 'Previous row',          params: [],                                           desc: 'Uses the value of the previous row (forward fill)' },
  { strategy: 'lookup_from_materialize', label: 'Lookup in Materialize', params: ['matName','repairFileKey','repairFileValue'], desc: 'Takes the value from a Materialize dataset, by key' },
  { strategy: 'expression',              label: 'FPEL expression',       params: ['repairExpression'],                         desc: 'Computes the new value with an FPEL expression' },
]
