export type { TransformCategory, FieldType } from '../types/fieldTypes'
  import type { FieldType } from '../types/fieldTypes'
  type TransformCategory = FieldType  // alias locale per il catalogo

// ─── Tipi ────────────────────────────────────────────────────────


export interface TransformParam {
  key:      string
  label:    string
  type:     'text' | 'select' | 'number'
  options?: string[]
  default?: string
}

export interface TransformTemplate {
  id:          string
  label:       string
  description: string
  // Tipo del valore di uscita (se diverso dall'input)
  outputType?: TransformCategory
  // Espressione — $value = valore input, $param_key = parametro
  expression:  string
  params?:     TransformParam[]
}

// ─── Catalogo per tipo ────────────────────────────────────────────

export const TRANSFORM_CATALOG: Record<TransformCategory, TransformTemplate[]> = {

  // ══════════════════════════════════════════════════════════════
  // STRING
  // ══════════════════════════════════════════════════════════════
  string: [
    {
      id: 'str_trim', label: 'Trim',
      description: 'Rimuove spazi iniziali e finali',
      expression: 'trim($value)',
    },
    {
      id: 'str_trim_left', label: 'Trim sinistra',
      description: 'Rimuove spazi solo a sinistra',
      expression: 'trimLeft($value)',
    },
    {
      id: 'str_trim_right', label: 'Trim destra',
      description: 'Rimuove spazi solo a destra',
      expression: 'trimRight($value)',
    },
    {
      id: 'str_upper', label: 'MAIUSCOLO',
      description: 'Converti in uppercase',
      expression: 'toUpperCase($value)',
    },
    {
      id: 'str_lower', label: 'minuscolo',
      description: 'Converti in lowercase',
      expression: 'toLowerCase($value)',
    },
    {
      id: 'str_capitalize', label: 'Capitalize',
      description: 'Prima lettera maiuscola',
      expression: 'capitalize($value)',
    },
    {
      id: 'str_title_case', label: 'Title Case',
      description: 'Prima lettera maiuscola per ogni parola',
      expression: 'titleCase($value)',
    },
    {
      id: 'str_slug', label: 'Slug',
      description: 'Converti in formato url-friendly',
      outputType: 'string',
      expression: 'toSlug($value)',
    },
    {
      id: 'str_pad_left', label: 'Pad sinistra',
      description: 'Padding a sinistra con carattere',
      expression: 'padLeft($value, $param_length, $param_char)',
      params: [
        { key: 'length', label: 'Lunghezza totale', type: 'number', default: '10' },
        { key: 'char',   label: 'Carattere fill',  type: 'text',   default: '0'  },
      ],
    },
    {
      id: 'str_pad_right', label: 'Pad destra',
      description: 'Padding a destra con carattere',
      expression: 'padRight($value, $param_length, $param_char)',
      params: [
        { key: 'length', label: 'Lunghezza totale', type: 'number', default: '10' },
        { key: 'char',   label: 'Carattere fill',  type: 'text',   default: ' '  },
      ],
    },
    {
      id: 'str_substr', label: 'Sottostringa',
      description: 'Estrae una porzione della stringa',
      expression: 'substr($value, $param_start, $param_length)',
      params: [
        { key: 'start',  label: 'Inizio (0-based)', type: 'number', default: '0'  },
        { key: 'length', label: 'Lunghezza',        type: 'number', default: '10' },
      ],
    },
    {
      id: 'str_replace', label: 'Sostituisci',
      description: 'Sostituisce tutte le occorrenze',
      expression: 'replace($value, $param_from, $param_to)',
      params: [
        { key: 'from', label: 'Cerca',      type: 'text', default: '' },
        { key: 'to',   label: 'Sostituisci', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_replace_regex', label: 'Sostituisci regex',
      description: 'Sostituisce con espressione regolare',
      expression: 'replaceRegex($value, $param_pattern, $param_to)',
      params: [
        { key: 'pattern', label: 'Pattern regex', type: 'text', default: '[^\\d]' },
        { key: 'to',      label: 'Sostituzione',  type: 'text', default: ''       },
      ],
    },
    {
      id: 'str_null_if_empty', label: 'Vuoto → null',
      description: 'Restituisce null se la stringa è vuota',
      expression: 'nullIfEmpty($value)',
    },
    {
      id: 'str_default', label: 'Default se null',
      description: 'Usa un valore di default se null o vuoto',
      expression: 'ifNull($value, $param_default)',
      params: [
        { key: 'default', label: 'Valore default', type: 'text', default: 'N/A' },
      ],
    },
    {
      id: 'str_concat', label: 'Concatena',
      description: 'Concatena con un altro valore o stringa',
      expression: 'concat($value, $param_sep, $param_suffix)',
      params: [
        { key: 'sep',    label: 'Separatore', type: 'text', default: ' ' },
        { key: 'suffix', label: 'Suffisso',   type: 'text', default: ''  },
      ],
    },
    {
      id: 'str_prefix', label: 'Aggiungi prefisso',
      description: 'Aggiunge un prefisso alla stringa',
      expression: 'concat($param_prefix, "", $value)',
      params: [
        { key: 'prefix', label: 'Prefisso', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_remove_accents', label: 'Rimuovi accenti',
      description: 'Normalizza caratteri accentati (è→e, à→a)',
      expression: 'removeAccents($value)',
    },
    {
      id: 'str_only_digits', label: 'Solo cifre',
      description: 'Rimuove tutto tranne le cifre',
      expression: 'replaceRegex($value, "[^\\\\d]", "")',
    },
    {
      id: 'str_only_alpha', label: 'Solo lettere',
      description: 'Rimuove tutto tranne le lettere',
      expression: 'replaceRegex($value, "[^a-zA-Z]", "")',
    },
    {
      id: 'str_len', label: 'Lunghezza',
      description: 'Restituisce la lunghezza della stringa',
      outputType: 'integer',
      expression: 'length($value)',
    },
    {
      id: 'str_to_int', label: '→ intero',
      description: 'Converte la stringa in intero',
      outputType: 'integer',
      expression: 'toInt($value)',
    },
    {
      id: 'str_to_decimal', label: '→ decimale',
      description: 'Converte la stringa in decimale',
      outputType: 'decimal',
      expression: 'toDecimal($value)',
    },
    {
      id: 'str_to_bool', label: '→ boolean',
      description: 'Converte true/false/1/0 in booleano',
      outputType: 'boolean',
      expression: 'toBool($value)',
    },
    {
      id: 'str_to_date', label: '→ data',
      description: 'Parsa una stringa come data',
      outputType: 'date',
      expression: 'parseDate($value, $param_format)',
      params: [
        { key: 'format', label: 'Formato input', type: 'select',
          options: ['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD-MM-YYYY', 'YYYYMMDD'],
          default: 'DD/MM/YYYY' },
      ],
    },
    {
      id: 'str_mask_email', label: 'Maschera email',
      description: 'Oscura la parte locale della email (ab***@domain.com)',
      expression: 'maskEmail($value)',
    },
    {
      id: 'str_mask_card', label: 'Maschera carta',
      description: 'Oscura le prime cifre della carta (**** **** **** 1234)',
      expression: 'maskCard($value)',
    },
    {
      id: 'str_hash_md5', label: 'Hash MD5',
      description: 'Calcola hash MD5 della stringa',
      expression: 'hashMd5($value)',
    },
    {
      id: 'str_hash_sha256', label: 'Hash SHA-256',
      description: 'Calcola hash SHA-256 della stringa',
      expression: 'hashSha256($value)',
    },
    {
      id: 'str_base64_encode', label: 'Base64 encode',
      description: 'Codifica in Base64',
      expression: 'base64Encode($value)',
    },
    {
      id: 'str_base64_decode', label: 'Base64 decode',
      description: 'Decodifica da Base64',
      expression: 'base64Decode($value)',
    },
    {
      id: 'str_url_encode', label: 'URL encode',
      description: 'Codifica per uso in URL',
      expression: 'urlEncode($value)',
    },
    {
      id: 'str_contains', label: 'Contiene?',
      description: 'Verifica se la stringa contiene una sottostringa',
      outputType: 'boolean',
      expression: 'contains($value, $param_search)',
      params: [
        { key: 'search', label: 'Cerca', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_starts_with', label: 'Inizia con?',
      description: 'Verifica se inizia con un prefisso',
      outputType: 'boolean',
      expression: 'startsWith($value, $param_prefix)',
      params: [
        { key: 'prefix', label: 'Prefisso', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_ends_with', label: 'Finisce con?',
      description: 'Verifica se finisce con un suffisso',
      outputType: 'boolean',
      expression: 'endsWith($value, $param_suffix)',
      params: [
        { key: 'suffix', label: 'Suffisso', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_matches', label: 'Corrisponde a regex?',
      description: 'Testa la stringa contro un pattern regex',
      outputType: 'boolean',
      expression: 'matches($value, $param_pattern)',
      params: [
        { key: 'pattern', label: 'Pattern regex', type: 'text', default: '^\\d+$' },
      ],
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // NUMBER (generico)
  // ══════════════════════════════════════════════════════════════
  number: [
    {
      id: 'num_round', label: 'Arrotonda',
      description: 'Arrotonda al numero di decimali specificato',
      expression: 'round($value, $param_decimals)',
      params: [{ key: 'decimals', label: 'Decimali', type: 'number', default: '2' }],
    },
    {
      id: 'num_floor', label: 'Floor',
      description: 'Arrotonda verso il basso',
      outputType: 'integer',
      expression: 'floor($value)',
    },
    {
      id: 'num_ceil', label: 'Ceil',
      description: 'Arrotonda verso l\'alto',
      outputType: 'integer',
      expression: 'ceil($value)',
    },
    {
      id: 'num_abs', label: 'Valore assoluto',
      description: 'Rimuove il segno negativo',
      expression: 'abs($value)',
    },
    {
      id: 'num_negate', label: 'Nega',
      description: 'Inverte il segno',
      expression: 'negate($value)',
    },
    {
      id: 'num_pct', label: '× 100 (percentuale)',
      description: 'Moltiplica per 100 (da decimale a percentuale)',
      expression: '$value * 100',
    },
    {
      id: 'num_div_100', label: '÷ 100 (da pct)',
      description: 'Divide per 100 (da percentuale a decimale)',
      expression: '$value / 100',
    },
    {
      id: 'num_add', label: 'Aggiungi',
      description: 'Aggiunge un valore fisso',
      expression: '$value + $param_addend',
      params: [{ key: 'addend', label: 'Addendo', type: 'number', default: '0' }],
    },
    {
      id: 'num_multiply', label: 'Moltiplica',
      description: 'Moltiplica per un fattore fisso',
      expression: '$value * $param_factor',
      params: [{ key: 'factor', label: 'Fattore', type: 'number', default: '1' }],
    },
    {
      id: 'num_mod', label: 'Modulo',
      description: 'Resto della divisione',
      expression: '$value % $param_divisor',
      params: [{ key: 'divisor', label: 'Divisore', type: 'number', default: '2' }],
    },
    {
      id: 'num_min', label: 'Minimo',
      description: 'Limita il valore al minimo specificato',
      expression: 'max($value, $param_min)',
      params: [{ key: 'min', label: 'Minimo', type: 'number', default: '0' }],
    },
    {
      id: 'num_max', label: 'Massimo',
      description: 'Limita il valore al massimo specificato',
      expression: 'min($value, $param_max)',
      params: [{ key: 'max', label: 'Massimo', type: 'number', default: '100' }],
    },
    {
      id: 'num_clamp', label: 'Clamp',
      description: 'Limita il valore tra min e max',
      expression: 'clamp($value, $param_min, $param_max)',
      params: [
        { key: 'min', label: 'Minimo', type: 'number', default: '0'   },
        { key: 'max', label: 'Massimo', type: 'number', default: '100' },
      ],
    },
    {
      id: 'num_null_zero', label: 'Null → 0',
      description: 'Restituisce 0 se il valore è null',
      expression: 'ifNull($value, 0)',
    },
    {
      id: 'num_to_str', label: '→ stringa',
      description: 'Converte il numero in stringa',
      outputType: 'string',
      expression: 'toString($value)',
    },
    {
      id: 'num_format_eu', label: 'Formato EU',
      description: 'Formatta con separatori europei (1.234,56)',
      outputType: 'string',
      expression: 'formatNumber($value, $param_decimals, ",", ".")',
      params: [{ key: 'decimals', label: 'Decimali', type: 'number', default: '2' }],
    },
    {
      id: 'num_format_us', label: 'Formato US',
      description: 'Formatta con separatori americani (1,234.56)',
      outputType: 'string',
      expression: 'formatNumber($value, $param_decimals, ".", ",")',
      params: [{ key: 'decimals', label: 'Decimali', type: 'number', default: '2' }],
    },
    {
      id: 'num_pow', label: 'Potenza',
      description: 'Eleva il numero a potenza',
      expression: 'pow($value, $param_exp)',
      params: [{ key: 'exp', label: 'Esponente', type: 'number', default: '2' }],
    },
    {
      id: 'num_sqrt', label: 'Radice quadrata',
      description: 'Calcola la radice quadrata',
      expression: 'sqrt($value)',
    },
    {
      id: 'num_log', label: 'Logaritmo naturale',
      description: 'Calcola il logaritmo naturale',
      expression: 'log($value)',
    },
    {
      id: 'num_is_positive', label: 'È positivo?',
      description: 'Verifica se il numero è positivo',
      outputType: 'boolean',
      expression: '$value > 0',
    },
    {
      id: 'num_is_negative', label: 'È negativo?',
      description: 'Verifica se il numero è negativo',
      outputType: 'boolean',
      expression: '$value < 0',
    },
    {
      id: 'num_is_zero', label: 'È zero?',
      description: 'Verifica se il numero è zero',
      outputType: 'boolean',
      expression: '$value === 0',
    },
    {
      id: 'num_sign', label: 'Segno',
      description: 'Restituisce 1, -1 o 0',
      outputType: 'integer',
      expression: 'sign($value)',
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // INTEGER
  // ══════════════════════════════════════════════════════════════
  integer: [
    {
      id: 'int_to_str', label: '→ stringa',
      description: 'Converte in stringa',
      outputType: 'string',
      expression: 'toString($value)',
    },
    {
      id: 'int_pad', label: 'Pad zero',
      description: 'Formatta con padding di zeri (es: 007)',
      outputType: 'string',
      expression: 'padLeft(toString($value), $param_length, "0")',
      params: [{ key: 'length', label: 'Lunghezza', type: 'number', default: '3' }],
    },
    {
      id: 'int_to_bool', label: '→ boolean',
      description: 'Converte 0/1 in false/true',
      outputType: 'boolean',
      expression: '$value !== 0',
    },
    {
      id: 'int_to_decimal', label: '→ decimale',
      description: 'Converte in numero decimale',
      outputType: 'decimal',
      expression: 'toDecimal($value)',
    },
    {
      id: 'int_mod', label: 'Modulo',
      description: 'Resto della divisione intera',
      outputType: 'integer',
      expression: '$value % $param_n',
      params: [{ key: 'n', label: 'Divisore', type: 'number', default: '2' }],
    },
    {
      id: 'int_null_zero', label: 'Null → 0',
      description: 'Restituisce 0 se null',
      expression: 'ifNull($value, 0)',
    },
    {
      id: 'int_abs', label: 'Valore assoluto',
      description: 'Rimuove il segno',
      expression: 'abs($value)',
    },
    {
      id: 'int_add', label: 'Aggiungi',
      description: 'Somma un valore fisso',
      expression: '$value + $param_n',
      params: [{ key: 'n', label: 'Addendo', type: 'number', default: '1' }],
    },
    {
      id: 'int_multiply', label: 'Moltiplica',
      description: 'Moltiplica per un fattore',
      expression: '$value * $param_n',
      params: [{ key: 'n', label: 'Fattore', type: 'number', default: '1' }],
    },
    {
      id: 'int_is_even', label: 'È pari?',
      description: 'Verifica se il numero è pari',
      outputType: 'boolean',
      expression: '$value % 2 === 0',
    },
    {
      id: 'int_is_odd', label: 'È dispari?',
      description: 'Verifica se il numero è dispari',
      outputType: 'boolean',
      expression: '$value % 2 !== 0',
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // DECIMAL
  // ══════════════════════════════════════════════════════════════
  decimal: [
    {
      id: 'dec_round2', label: 'Arrotonda 2 dec',
      description: 'Arrotonda a 2 decimali',
      expression: 'round($value, 2)',
    },
    {
      id: 'dec_round4', label: 'Arrotonda 4 dec',
      description: 'Arrotonda a 4 decimali',
      expression: 'round($value, 4)',
    },
    {
      id: 'dec_floor', label: 'Floor',
      description: 'Arrotonda verso il basso',
      outputType: 'integer',
      expression: 'floor($value)',
    },
    {
      id: 'dec_ceil', label: 'Ceil',
      description: 'Arrotonda verso l\'alto',
      outputType: 'integer',
      expression: 'ceil($value)',
    },
    {
      id: 'dec_abs', label: 'Valore assoluto',
      description: 'Rimuove il segno negativo',
      expression: 'abs($value)',
    },
    {
      id: 'dec_format_eu', label: 'Formato EU',
      description: '1.234,56',
      outputType: 'string',
      expression: 'formatNumber($value, 2, ",", ".")',
    },
    {
      id: 'dec_format_us', label: 'Formato US',
      description: '1,234.56',
      outputType: 'string',
      expression: 'formatNumber($value, 2, ".", ",")',
    },
    {
      id: 'dec_pct', label: '× 100',
      description: 'Converti da decimale a percentuale',
      expression: '$value * 100',
    },
    {
      id: 'dec_to_int', label: '→ intero',
      description: 'Tronca i decimali',
      outputType: 'integer',
      expression: 'toInt($value)',
    },
    {
      id: 'dec_to_str', label: '→ stringa',
      description: 'Converti in stringa',
      outputType: 'string',
      expression: 'toString($value)',
    },
    {
      id: 'dec_null_zero', label: 'Null → 0.0',
      description: 'Restituisce 0.0 se null',
      expression: 'ifNull($value, 0.0)',
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // DATETIME
  // ══════════════════════════════════════════════════════════════
  datetime: [
      
  ],
  // ══════════════════════════════════════════════════════════════
  // BOOLEAN
  // ══════════════════════════════════════════════════════════════
  boolean: [
    {
      id: 'bool_to_str', label: '→ stringa',
      description: '"true" / "false"',
      outputType: 'string',
      expression: 'toString($value)',
    },
    {
      id: 'bool_to_int', label: '→ intero',
      description: '1 / 0',
      outputType: 'integer',
      expression: '$value ? 1 : 0',
    },
    {
      id: 'bool_to_yn', label: '→ S/N',
      description: '"Sì" / "No"',
      outputType: 'string',
      expression: '$value ? "Sì" : "No"',
    },
    {
      id: 'bool_to_yn_en', label: '→ Y/N',
      description: '"Yes" / "No"',
      outputType: 'string',
      expression: '$value ? "Yes" : "No"',
    },
    {
      id: 'bool_negate', label: 'Nega',
      description: 'Inverte il valore booleano',
      expression: '!$value',
    },
    {
      id: 'bool_null_false', label: 'Null → false',
      description: 'Restituisce false se null',
      expression: 'ifNull($value, false)',
    },
    {
      id: 'bool_and', label: 'AND',
      description: 'E logico con valore fisso',
      expression: '$value && $param_operand',
      params: [{ key: 'operand', label: 'Operando', type: 'select', options: ['true', 'false'], default: 'true' }],
    },
    {
      id: 'bool_or', label: 'OR',
      description: 'O logico con valore fisso',
      expression: '$value || $param_operand',
      params: [{ key: 'operand', label: 'Operando', type: 'select', options: ['true', 'false'], default: 'false' }],
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // DATE
  // ══════════════════════════════════════════════════════════════
  date: [
    {
      id: 'date_format', label: 'Formatta',
      description: 'Formatta la data nel formato scelto',
      outputType: 'string',
      expression: 'formatDate($value, $param_format)',
      params: [
        { key: 'format', label: 'Formato', type: 'select',
          options: ['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD MMMM YYYY',
                    'YYYY-MM-DDTHH:mm:ssZ', 'DD/MM/YYYY HH:mm', 'HH:mm:ss'],
          default: 'DD/MM/YYYY' },
      ],
    },
    {
      id: 'date_to_ts', label: '→ Timestamp unix',
      description: 'Secondi da epoch (1970-01-01)',
      outputType: 'integer',
      expression: 'toUnixTimestamp($value)',
    },
    {
      id: 'date_to_ts_ms', label: '→ Timestamp ms',
      description: 'Millisecondi da epoch',
      outputType: 'integer',
      expression: 'toUnixTimestampMs($value)',
    },
    {
      id: 'date_year', label: 'Anno',
      description: 'Estrae l\'anno (YYYY)',
      outputType: 'integer',
      expression: 'getYear($value)',
    },
    {
      id: 'date_month', label: 'Mese',
      description: 'Estrae il mese (1-12)',
      outputType: 'integer',
      expression: 'getMonth($value)',
    },
    {
      id: 'date_day', label: 'Giorno',
      description: 'Estrae il giorno del mese (1-31)',
      outputType: 'integer',
      expression: 'getDay($value)',
    },
    {
      id: 'date_day_of_week', label: 'Giorno settimana',
      description: 'Giorno della settimana (0=dom, 6=sab)',
      outputType: 'integer',
      expression: 'getDayOfWeek($value)',
    },
    {
      id: 'date_quarter', label: 'Trimestre',
      description: 'Trimestre (1-4)',
      outputType: 'integer',
      expression: 'getQuarter($value)',
    },
    {
      id: 'date_add_days', label: 'Aggiungi giorni',
      description: 'Aggiunge N giorni alla data',
      expression: 'addDays($value, $param_days)',
      params: [{ key: 'days', label: 'Giorni', type: 'number', default: '1' }],
    },
    {
      id: 'date_add_months', label: 'Aggiungi mesi',
      description: 'Aggiunge N mesi alla data',
      expression: 'addMonths($value, $param_months)',
      params: [{ key: 'months', label: 'Mesi', type: 'number', default: '1' }],
    },
    {
      id: 'date_add_years', label: 'Aggiungi anni',
      description: 'Aggiunge N anni alla data',
      expression: 'addYears($value, $param_years)',
      params: [{ key: 'years', label: 'Anni', type: 'number', default: '1' }],
    },
    {
      id: 'date_diff_days', label: 'Giorni da oggi',
      description: 'Differenza in giorni dalla data corrente',
      outputType: 'integer',
      expression: 'diffDays($value, now())',
    },
    {
      id: 'date_start_of_month', label: 'Inizio mese',
      description: 'Primo giorno del mese della data',
      expression: 'startOfMonth($value)',
    },
    {
      id: 'date_end_of_month', label: 'Fine mese',
      description: 'Ultimo giorno del mese della data',
      expression: 'endOfMonth($value)',
    },
    {
      id: 'date_start_of_year', label: 'Inizio anno',
      description: 'Primo giorno dell\'anno della data',
      expression: 'startOfYear($value)',
    },
    {
      id: 'date_is_past', label: 'È nel passato?',
      description: 'Verifica se la data è precedente ad oggi',
      outputType: 'boolean',
      expression: 'isBefore($value, now())',
    },
    {
      id: 'date_is_future', label: 'È nel futuro?',
      description: 'Verifica se la data è successiva ad oggi',
      outputType: 'boolean',
      expression: 'isAfter($value, now())',
    },
    {
      id: 'date_is_weekend', label: 'È weekend?',
      description: 'Verifica se la data cade di sabato o domenica',
      outputType: 'boolean',
      expression: 'isWeekend($value)',
    },
    {
      id: 'date_now', label: 'Data corrente',
      description: 'Sostituisce con la data/ora corrente',
      expression: 'now()',
    },
    {
      id: 'date_today', label: 'Oggi (solo data)',
      description: 'Data corrente senza ora',
      outputType: 'string',
      expression: 'formatDate(now(), "YYYY-MM-DD")',
    },
    {
      id: 'date_null_now', label: 'Null → ora',
      description: 'Usa la data corrente se null',
      expression: 'ifNull($value, now())',
    },
    {
      id: 'date_to_str', label: '→ stringa ISO',
      description: 'Converti in stringa ISO 8601',
      outputType: 'string',
      expression: 'formatDate($value, "YYYY-MM-DD")',
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // OBJECT
  // ══════════════════════════════════════════════════════════════
  object: [
    {
      id: 'obj_to_json', label: '→ JSON stringa',
      description: 'Serializza l\'oggetto in stringa JSON',
      outputType: 'string',
      expression: 'toJson($value)',
    },
    {
      id: 'obj_get', label: 'Leggi proprietà',
      description: 'Ottieni il valore di una proprietà',
      expression: 'get($value, $param_key)',
      params: [{ key: 'key', label: 'Chiave', type: 'text', default: 'id' }],
    },
    {
      id: 'obj_get_nested', label: 'Proprietà annidata',
      description: 'Ottieni una proprietà annidata con path (es: a.b.c)',
      expression: 'getPath($value, $param_path)',
      params: [{ key: 'path', label: 'Path (dot notation)', type: 'text', default: 'data.id' }],
    },
    {
      id: 'obj_keys', label: 'Elenco chiavi',
      description: 'Array delle chiavi dell\'oggetto',
      expression: 'keys($value)',
    },
    {
      id: 'obj_values', label: 'Elenco valori',
      description: 'Array dei valori dell\'oggetto',
      expression: 'values($value)',
    },
    {
      id: 'obj_merge', label: 'Merge',
      description: 'Unisce due oggetti (il secondo sovrascrive)',
      expression: 'merge($value, $param_extra)',
      params: [{ key: 'extra', label: 'Oggetto extra (JSON)', type: 'text', default: '{}' }],
    },
    {
      id: 'obj_is_null', label: 'È null?',
      description: 'Verifica se l\'oggetto è null',
      outputType: 'boolean',
      expression: 'isNull($value)',
    },
    {
      id: 'obj_null_empty', label: 'Null → {}',
      description: 'Restituisce oggetto vuoto se null',
      expression: 'ifNull($value, {})',
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // ANY
  // ══════════════════════════════════════════════════════════════
  any: [
    {
      id: 'any_to_str', label: '→ stringa',
      description: 'Converti qualsiasi valore in stringa',
      outputType: 'string',
      expression: 'toString($value)',
    },
    {
      id: 'any_to_int', label: '→ intero',
      description: 'Converti in intero',
      outputType: 'integer',
      expression: 'toInt($value)',
    },
    {
      id: 'any_to_decimal', label: '→ decimale',
      description: 'Converti in decimale',
      outputType: 'decimal',
      expression: 'toDecimal($value)',
    },
    {
      id: 'any_to_bool', label: '→ boolean',
      description: 'Converti in boolean',
      outputType: 'boolean',
      expression: 'toBool($value)',
    },
    {
      id: 'any_is_null', label: 'È null?',
      description: 'Verifica se il valore è null',
      outputType: 'boolean',
      expression: 'isNull($value)',
    },
    {
      id: 'any_is_not_null', label: 'Non è null?',
      description: 'Verifica se il valore non è null',
      outputType: 'boolean',
      expression: '!isNull($value)',
    },
    {
      id: 'any_coalesce', label: 'Coalesce',
      description: 'Primo valore non-null tra i due',
      expression: 'coalesce($value, $param_fallback)',
      params: [{ key: 'fallback', label: 'Valore fallback', type: 'text', default: 'N/A' }],
    },
    {
      id: 'any_default', label: 'Default se null',
      description: 'Usa un valore di default se null',
      expression: 'ifNull($value, $param_default)',
      params: [{ key: 'default', label: 'Default', type: 'text', default: '' }],
    },
    {
      id: 'any_ternary', label: 'Se/Altrimenti',
      description: 'Condizione ternaria',
      expression: '$value ? $param_then : $param_else',
      params: [
        { key: 'then', label: 'Se vero',  type: 'text', default: 'Sì' },
        { key: 'else', label: 'Se falso', type: 'text', default: 'No' },
      ],
    },
  ],
}

// ─── Helpers ─────────────────────────────────────────────────────

export function getTransformsForType(type: TransformCategory): TransformTemplate[] {
  // number → fallback a decimal, datetime → fallback a date
  const key = type === 'number' ? 'decimal' : type === 'datetime' ? 'date' : type
  return TRANSFORM_CATALOG[key] ?? TRANSFORM_CATALOG.any ?? []
}

export function getAllTransforms(): TransformTemplate[] {
  return Object.values(TRANSFORM_CATALOG).flat()
}

export function findTransform(id: string): TransformTemplate | undefined {
  return getAllTransforms().find((t) => t.id === id)
}
