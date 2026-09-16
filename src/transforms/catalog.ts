/**
 * src/transforms/catalog.ts
 *
 * Catalogo dei template di trasformazione, per il pannello Transform.
 *
 * Le `expression` sono scritte in FPEL (FlowPilot Expression Language),
 * non più in JavaScript: vedi docs/design-linguaggio-espressioni.md.
 * Vengono compilate in ExprNode dal parser (src/ir/exprParser.ts) e
 * valutate dal motore Rust — o, in futuro, tradotte in Rust/Java/Python
 * dal codegen.
 *
 * Segnaposto:
 *   $value        il valore del campo sorgente
 *   $param_<key>  un parametro del template (vedi `params`)
 */
export type { TransformCategory, FieldType } from '../types/fieldTypes'
  import type { FieldType } from '../types/fieldTypes'
  type TransformCategory = FieldType  // alias locale per il catalogo

// ─── Tipi ────────────────────────────────────────────────────────


export interface TransformParam {
  key:      string
  label:    string
  /** `expr` = il valore è un'ESPRESSIONE (es. il riferimento a un altro campo):
   *  viene inserito così com'è, senza virgolette. Gli altri tipi diventano
   *  letterali. */
  type:     'text' | 'select' | 'number' | 'expr'
  options?: string[]
  default?: string
}

export interface TransformTemplate {
  id:          string
  label:       string
  description: string
  // Tipo del valore di uscita (se diverso dall'input)
  outputType?: TransformCategory
  /** Espressione FPEL. $value = valore input, $param_<key> = parametro */
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
      description: 'Removes leading and trailing spaces',
      expression: 'trim($value)',
    },
    {
      id: 'str_trim_left', label: 'Trim left',
      description: 'Removes leading spaces only',
      expression: 'ltrim($value)',
    },
    {
      id: 'str_trim_right', label: 'Trim right',
      description: 'Removes trailing spaces only',
      expression: 'rtrim($value)',
    },
    {
      id: 'str_upper', label: 'UPPERCASE',
      description: 'Convert to uppercase',
      expression: 'upper($value)',
    },
    {
      id: 'str_lower', label: 'lowercase',
      description: 'Convert to lowercase',
      expression: 'lower($value)',
    },
    {
      id: 'str_capitalize', label: 'Capitalize',
      description: 'First letter uppercase',
      expression: 'capitalize($value)',
    },
    {
      id: 'str_title_case', label: 'Title Case',
      description: 'First letter of each word uppercase',
      expression: 'title_case($value)',
    },
    {
      id: 'str_slug', label: 'Slug',
      description: 'Convert to url-friendly format',
      outputType: 'string',
      expression: 'to_slug($value)',
    },
    {
      id: 'str_pad_left', label: 'Pad left',
      description: 'Left-pad with a character',
      expression: 'pad_left($value, $param_length, $param_char)',
      params: [
        { key: 'length', label: 'Total length', type: 'number', default: '10' },
        { key: 'char',   label: 'Fill character',  type: 'text',   default: '0'  },
      ],
    },
    {
      id: 'str_pad_right', label: 'Pad right',
      description: 'Right-pad with a character',
      expression: 'pad_right($value, $param_length, $param_char)',
      params: [
        { key: 'length', label: 'Total length', type: 'number', default: '10' },
        { key: 'char',   label: 'Fill character',  type: 'text',   default: ' '  },
      ],
    },
    {
      id: 'str_substr', label: 'Substring',
      description: 'Extracts a portion of the string',
      expression: 'substring($value, $param_start, $param_length)',
      params: [
        { key: 'start',  label: 'Start (0-based)', type: 'number', default: '0'  },
        { key: 'length', label: 'Length',        type: 'number', default: '10' },
      ],
    },
    {
      id: 'str_replace', label: 'Replace',
      description: 'Replaces all occurrences',
      expression: 'replace($value, $param_from, $param_to)',
      params: [
        { key: 'from', label: 'Find',      type: 'text', default: '' },
        { key: 'to',   label: 'Replace', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_replace_regex', label: 'Replace regex',
      description: 'Replaces using a regular expression',
      expression: 'replace_regex($value, $param_pattern, $param_to)',
      params: [
        { key: 'pattern', label: 'Regex pattern', type: 'text', default: '[^\\d]' },
        { key: 'to',      label: 'Replacement',  type: 'text', default: ''       },
      ],
    },
    {
      id: 'str_null_if_empty', label: 'Empty → null',
      description: 'Returns null if the string is empty',
      expression: 'iif($value == "" or $value is null, null, $value)',
    },
    {
      id: 'str_default', label: 'Default if null',
      description: 'Uses a default value if null or empty',
      expression: 'coalesce($value, $param_default)',
      params: [
        { key: 'default', label: 'Default value', type: 'text', default: 'N/A' },
      ],
    },
    {
      id: 'str_concat', label: 'Concatenate',
      description: 'Concatenates with another value or string',
      expression: 'concat($value, $param_sep, $param_suffix)',
      params: [
        { key: 'sep',    label: 'Separator', type: 'text', default: ' ' },
        { key: 'suffix', label: 'Suffix',   type: 'text', default: ''  },
      ],
    },
    {
      // `concat_ws` esiste da sempre fra le funzioni FPEL ma non era offerta dal
      // menu: chi voleva unire più campi doveva scriverla a mano (o ripiegare su
      // `concat`, che è equivalente ma vuole il separatore ripetuto ogni volta).
      // È il caso più comune del TMap — accorpare campi — e merita una voce.
      id: 'str_join', label: 'Join with separator',
      description: 'Joins the value with another field or text, using a separator written only once',
      expression: 'concat_ws($param_sep, $value, $param_altro)',
      params: [
        { key: 'sep',   label: 'Separator', type: 'text', default: ' ' },
        { key: 'altro', label: 'With (field or "text")', type: 'expr', default: '""' },
      ],
    },
    {
      id: 'str_prefix', label: 'Add prefix',
      description: 'Adds a prefix to the string',
      expression: 'concat($param_prefix, "", $value)',
      params: [
        { key: 'prefix', label: 'Prefix', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_remove_accents', label: 'Remove accents',
      description: 'Normalizes accented characters (è→e, à→a)',
      expression: 'remove_accents($value)',
    },
    {
      id: 'str_only_digits', label: 'Digits only',
      description: 'Removes everything except digits',
      expression: 'replace_regex($value, "[^\\\\d]", "")',
    },
    {
      id: 'str_only_alpha', label: 'Letters only',
      description: 'Removes everything except letters',
      expression: 'replace_regex($value, "[^a-zA-Z]", "")',
    },
    {
      id: 'str_len', label: 'Length',
      description: 'Returns the length of the string',
      outputType: 'integer',
      expression: 'length($value)',
    },
    {
      id: 'str_to_int', label: '→ integer',
      description: 'Converts the string to an integer',
      outputType: 'integer',
      expression: 'to_int($value)',
    },
    {
      id: 'str_to_decimal', label: '→ decimal',
      description: 'Converts the string to a decimal',
      outputType: 'decimal',
      expression: 'to_float($value)',
    },
    {
      id: 'str_to_bool', label: '→ boolean',
      description: 'Converts true/false/1/0 to a boolean',
      outputType: 'boolean',
      expression: 'to_bool($value)',
    },
    {
      id: 'str_to_date', label: '→ date',
      description: 'Parses a string as a date',
      outputType: 'date',
      expression: 'parse_date($value, $param_format)',
      params: [
        { key: 'format', label: 'Input format', type: 'select',
          options: ['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD-MM-YYYY', 'YYYYMMDD'],
          default: 'DD/MM/YYYY' },
      ],
    },
    {
      id: 'str_mask_email', label: 'Mask email',
      description: 'Obscures the local part of the email (ab***@domain.com)',
      expression: 'mask_email($value)',
    },
    {
      id: 'str_mask_card', label: 'Mask card',
      description: 'Obscures the leading digits of the card (**** **** **** 1234)',
      expression: 'mask_card($value)',
    },
    
    {
      id: 'str_hash_sha256', label: 'Hash SHA-256',
      description: 'Computes the SHA-256 hash of the string',
      expression: 'hash_sha256($value)',
    },
    {
      id: 'str_hash_sha512', label: 'Hash SHA-512',
      description: 'Computes the SHA-512 hash of the string',
      outputType: 'string',
      expression: 'hash_sha512($value)',
    },
    {
      id: 'str_hash_sha1', label: 'Hash SHA-1 (deprecated)',
      description: 'Computes SHA-1 hash — only for compatibility with legacy systems',
      outputType: 'string',
      expression: 'hash_sha1($value)',
    },
    {
      id: 'str_base64_encode', label: 'Base64 encode',
      description: 'Encodes to Base64',
      expression: 'base64_encode($value)',
    },
    {
      id: 'str_base64_decode', label: 'Base64 decode',
      description: 'Decodes from Base64',
      expression: 'base64_decode($value)',
    },
    {
      id: 'str_url_encode', label: 'URL encode',
      description: 'Encodes for use in a URL',
      expression: 'url_encode($value)',
    },
    {
      id: 'str_contains', label: 'Contains?',
      description: 'Checks whether the string contains a substring',
      outputType: 'boolean',
      expression: 'contains($value, $param_search)',
      params: [
        { key: 'search', label: 'Find', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_starts_with', label: 'Starts with?',
      description: 'Checks whether it starts with a prefix',
      outputType: 'boolean',
      expression: 'starts_with($value, $param_prefix)',
      params: [
        { key: 'prefix', label: 'Prefix', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_ends_with', label: 'Ends with?',
      description: 'Checks whether it ends with a suffix',
      outputType: 'boolean',
      expression: 'ends_with($value, $param_suffix)',
      params: [
        { key: 'suffix', label: 'Suffix', type: 'text', default: '' },
      ],
    },
    {
      id: 'str_matches', label: 'Matches regex?',
      description: 'Tests the string against a regex pattern',
      outputType: 'boolean',
      expression: 'regex_match($value, $param_pattern)',
      params: [
        { key: 'pattern', label: 'Regex pattern', type: 'text', default: '^\\d+$' },
      ],
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // NUMBER (generico)
  // ══════════════════════════════════════════════════════════════
  number: [
    {
      id: 'num_round', label: 'Round',
      description: 'Rounds to the specified number of decimals',
      expression: 'round($value, $param_decimals)',
      params: [{ key: 'decimals', label: 'Decimals', type: 'number', default: '2' }],
    },
    {
      id: 'num_floor', label: 'Floor',
      description: 'Rounds down',
      outputType: 'integer',
      expression: 'floor($value)',
    },
    {
      id: 'num_ceil', label: 'Ceil',
      description: 'Rounds up',
      outputType: 'integer',
      expression: 'ceil($value)',
    },
    {
      id: 'num_abs', label: 'Absolute value',
      description: 'Removes the negative sign',
      expression: 'abs($value)',
    },
    {
      id: 'num_negate', label: 'Negate',
      description: 'Flips the sign',
      expression: 'negate($value)',
    },
    {
      id: 'num_pct', label: '× 100 (percentage)',
      description: 'Multiplies by 100 (decimal to percentage)',
      expression: '$value * 100',
    },
    {
      id: 'num_div_100', label: '÷ 100 (from pct)',
      description: 'Divides by 100 (percentage to decimal)',
      expression: '$value / 100',
    },
    {
      id: 'num_add', label: 'Add',
      description: 'Adds a fixed value',
      expression: '$value + $param_addend',
      params: [{ key: 'addend', label: 'Addend', type: 'number', default: '0' }],
    },
    {
      id: 'num_multiply', label: 'Multiply',
      description: 'Multiplies by a fixed factor',
      expression: '$value * $param_factor',
      params: [{ key: 'factor', label: 'Factor', type: 'number', default: '1' }],
    },
    {
      id: 'num_mod', label: 'Modulo',
      description: 'Division remainder',
      expression: '$value % $param_divisor',
      params: [{ key: 'divisor', label: 'Divisor', type: 'number', default: '2' }],
    },
    {
      id: 'num_min', label: 'Minimum',
      description: 'Clamps the value to the specified minimum',
      expression: 'max($value, $param_min)',
      params: [{ key: 'min', label: 'Minimum', type: 'number', default: '0' }],
    },
    {
      id: 'num_max', label: 'Maximum',
      description: 'Clamps the value to the specified maximum',
      expression: 'min($value, $param_max)',
      params: [{ key: 'max', label: 'Maximum', type: 'number', default: '100' }],
    },
    {
      id: 'num_clamp', label: 'Clamp',
      description: 'Clamps the value between min and max',
      expression: 'clamp($value, $param_min, $param_max)',
      params: [
        { key: 'min', label: 'Minimum', type: 'number', default: '0'   },
        { key: 'max', label: 'Maximum', type: 'number', default: '100' },
      ],
    },
    {
      id: 'num_null_zero', label: 'Null → 0',
      description: 'Returns 0 if the value is null',
      expression: 'coalesce($value, 0)',
    },
    {
      id: 'num_to_str', label: '→ string',
      description: 'Converts the number to a string',
      outputType: 'string',
      expression: 'to_string($value)',
    },
    {
      id: 'num_format_eu', label: 'EU format',
      description: 'Formats with European separators (1.234,56)',
      outputType: 'string',
      expression: 'format_number($value, $param_decimals, ",", ".")',
      params: [{ key: 'decimals', label: 'Decimals', type: 'number', default: '2' }],
    },
    {
      id: 'num_format_us', label: 'US format',
      description: 'Formats with US separators (1,234.56)',
      outputType: 'string',
      expression: 'format_number($value, $param_decimals, ".", ",")',
      params: [{ key: 'decimals', label: 'Decimals', type: 'number', default: '2' }],
    },
    {
      id: 'num_pow', label: 'Power',
      description: 'Raises the number to a power',
      expression: 'pow($value, $param_exp)',
      params: [{ key: 'exp', label: 'Exponent', type: 'number', default: '2' }],
    },
    {
      id: 'num_sqrt', label: 'Square root',
      description: 'Computes the square root',
      expression: 'sqrt($value)',
    },
    {
      id: 'num_log', label: 'Natural logarithm',
      description: 'Computes the natural logarithm',
      expression: 'log($value)',
    },
    {
      id: 'num_is_positive', label: 'Is positive?',
      description: 'Checks whether the number is positive',
      outputType: 'boolean',
      expression: '$value > 0',
    },
    {
      id: 'num_is_negative', label: 'Is negative?',
      description: 'Checks whether the number is negative',
      outputType: 'boolean',
      expression: '$value < 0',
    },
    {
      id: 'num_is_zero', label: 'Is zero?',
      description: 'Checks whether the number is zero',
      outputType: 'boolean',
      expression: '$value == 0',
    },
    {
      id: 'num_sign', label: 'Sign',
      description: 'Returns 1, -1 or 0',
      outputType: 'integer',
      expression: 'sign($value)',
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // INTEGER
  // ══════════════════════════════════════════════════════════════
  integer: [
    {
      id: 'int_to_str', label: '→ string',
      description: 'Converts to a string',
      outputType: 'string',
      expression: 'to_string($value)',
    },
    {
      id: 'int_pad', label: 'Pad zeros',
      description: 'Formats with zero-padding (e.g. 007)',
      outputType: 'string',
      expression: 'pad_left(to_string($value), $param_length, "0")',
      params: [{ key: 'length', label: 'Length', type: 'number', default: '3' }],
    },
    {
      id: 'int_to_bool', label: '→ boolean',
      description: 'Converts 0/1 to false/true',
      outputType: 'boolean',
      expression: '$value != 0',
    },
    {
      id: 'int_to_decimal', label: '→ decimal',
      description: 'Converts to a decimal number',
      outputType: 'decimal',
      expression: 'to_float($value)',
    },
    {
      id: 'int_mod', label: 'Modulo',
      description: 'Integer division remainder',
      outputType: 'integer',
      expression: '$value % $param_n',
      params: [{ key: 'n', label: 'Divisor', type: 'number', default: '2' }],
    },
    {
      id: 'int_null_zero', label: 'Null → 0',
      description: 'Returns 0 if null',
      expression: 'coalesce($value, 0)',
    },
    {
      id: 'int_abs', label: 'Absolute value',
      description: 'Removes the sign',
      expression: 'abs($value)',
    },
    {
      id: 'int_add', label: 'Add',
      description: 'Adds a fixed value',
      expression: '$value + $param_n',
      params: [{ key: 'n', label: 'Addend', type: 'number', default: '1' }],
    },
    {
      id: 'int_multiply', label: 'Multiply',
      description: 'Multiplies by a factor',
      expression: '$value * $param_n',
      params: [{ key: 'n', label: 'Factor', type: 'number', default: '1' }],
    },
    {
      id: 'int_is_even', label: 'Is even?',
      description: 'Checks whether the number is even',
      outputType: 'boolean',
      expression: '$value % 2 == 0',
    },
    {
      id: 'int_is_odd', label: 'Is odd?',
      description: 'Checks whether the number is odd',
      outputType: 'boolean',
      expression: '$value % 2 != 0',
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // DECIMAL
  // ══════════════════════════════════════════════════════════════
  decimal: [
    {
      id: 'dec_round2', label: 'Round 2 dec',
      description: 'Rounds to 2 decimals',
      expression: 'round($value, 2)',
    },
    {
      id: 'dec_round4', label: 'Round 4 dec',
      description: 'Rounds to 4 decimals',
      expression: 'round($value, 4)',
    },
    {
      id: 'dec_floor', label: 'Floor',
      description: 'Rounds down',
      outputType: 'integer',
      expression: 'floor($value)',
    },
    {
      id: 'dec_ceil', label: 'Ceil',
      description: 'Rounds up',
      outputType: 'integer',
      expression: 'ceil($value)',
    },
    {
      id: 'dec_abs', label: 'Absolute value',
      description: 'Removes the negative sign',
      expression: 'abs($value)',
    },
    {
      id: 'dec_format_eu', label: 'EU format',
      description: '1.234,56',
      outputType: 'string',
      expression: 'format_number($value, 2, ",", ".")',
    },
    {
      id: 'dec_format_us', label: 'US format',
      description: '1,234.56',
      outputType: 'string',
      expression: 'format_number($value, 2, ".", ",")',
    },
    {
      id: 'dec_pct', label: '× 100',
      description: 'Convert from decimal to percentage',
      expression: '$value * 100',
    },
    {
      id: 'dec_to_int', label: '→ integer',
      description: 'Truncates the decimals',
      outputType: 'integer',
      expression: 'to_int($value)',
    },
    {
      id: 'dec_to_str', label: '→ string',
      description: 'Convert to a string',
      outputType: 'string',
      expression: 'to_string($value)',
    },
    {
      id: 'dec_null_zero', label: 'Null → 0.0',
      description: 'Returns 0.0 if null',
      expression: 'coalesce($value, 0.0)',
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
      id: 'bool_to_str', label: '→ string',
      description: '"true" / "false"',
      outputType: 'string',
      expression: 'to_string($value)',
    },
    {
      id: 'bool_to_int', label: '→ integer',
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
      id: 'bool_negate', label: 'Negate',
      description: 'Flips the boolean value',
      expression: '!$value',
    },
    {
      id: 'bool_null_false', label: 'Null → false',
      description: 'Returns false if null',
      expression: 'coalesce($value, false)',
    },
    {
      id: 'bool_and', label: 'AND',
      description: 'Logical AND with a fixed value',
      expression: '$value && $param_operand',
      params: [{ key: 'operand', label: 'Operand', type: 'select', options: ['true', 'false'], default: 'true' }],
    },
    {
      id: 'bool_or', label: 'OR',
      description: 'Logical OR with a fixed value',
      expression: '$value || $param_operand',
      params: [{ key: 'operand', label: 'Operand', type: 'select', options: ['true', 'false'], default: 'false' }],
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // DATE
  // ══════════════════════════════════════════════════════════════
  date: [
    {
      id: 'date_format', label: 'Format',
      description: 'Formats the date in the chosen format',
      outputType: 'string',
      expression: 'date_format($value, $param_format)',
      params: [
        { key: 'format', label: 'Format', type: 'select',
          options: ['DD/MM/YYYY', 'YYYY-MM-DD', 'MM/DD/YYYY', 'DD MMMM YYYY',
                    'YYYY-MM-DDTHH:mm:ssZ', 'DD/MM/YYYY HH:mm', 'HH:mm:ss'],
          default: 'DD/MM/YYYY' },
      ],
    },
    {
      id: 'date_to_ts', label: '→ Timestamp unix',
      description: 'Seconds since epoch (1970-01-01)',
      outputType: 'integer',
      expression: 'to_unix_timestamp($value)',
    },
    {
      id: 'date_to_ts_ms', label: '→ Timestamp ms',
      description: 'Milliseconds since epoch',
      outputType: 'integer',
      expression: 'to_unix_timestamp_ms($value)',
    },
    {
      id: 'date_year', label: 'Year',
      description: 'Extracts the year (YYYY)',
      outputType: 'integer',
      expression: 'year($value)',
    },
    {
      id: 'date_month', label: 'Month',
      description: 'Extracts the month (1-12)',
      outputType: 'integer',
      expression: 'month($value)',
    },
    {
      id: 'date_day', label: 'Day',
      description: 'Extracts the day of the month (1-31)',
      outputType: 'integer',
      expression: 'day($value)',
    },
    {
      id: 'date_day_of_week', label: 'Day of week',
      description: 'Day of the week (0=Sun, 6=Sat)',
      outputType: 'integer',
      expression: 'day_of_week($value)',
    },
    {
      id: 'date_quarter', label: 'Quarter',
      description: 'Quarter (1-4)',
      outputType: 'integer',
      expression: 'quarter($value)',
    },
    {
      id: 'date_add_days', label: 'Add days',
      description: 'Adds N days to the date',
      expression: 'add_days($value, $param_days)',
      params: [{ key: 'days', label: 'Days', type: 'number', default: '1' }],
    },
    {
      id: 'date_add_months', label: 'Add months',
      description: 'Adds N months to the date',
      expression: 'add_months($value, $param_months)',
      params: [{ key: 'months', label: 'Months', type: 'number', default: '1' }],
    },
    {
      id: 'date_add_years', label: 'Add years',
      description: 'Adds N years to the date',
      expression: 'add_years($value, $param_years)',
      params: [{ key: 'years', label: 'Years', type: 'number', default: '1' }],
    },
    {
      id: 'date_diff_days', label: 'Days from today',
      description: 'Difference in days from the current date',
      outputType: 'integer',
      expression: 'diff_days($value, now())',
    },
    {
      id: 'date_start_of_month', label: 'Start of month',
      description: 'First day of the month of the date',
      expression: 'start_of_month($value)',
    },
    {
      id: 'date_end_of_month', label: 'End of month',
      description: 'Last day of the month of the date',
      expression: 'end_of_month($value)',
    },
    {
      id: 'date_start_of_year', label: 'Start of year',
      description: 'First day of the year of the date',
      expression: 'start_of_year($value)',
    },
    {
      id: 'date_is_past', label: 'Is in the past?',
      description: 'Checks whether the date is before today',
      outputType: 'boolean',
      expression: 'is_before($value, now())',
    },
    {
      id: 'date_is_future', label: 'Is in the future?',
      description: 'Checks whether the date is after today',
      outputType: 'boolean',
      expression: 'is_after($value, now())',
    },
    {
      id: 'date_is_weekend', label: 'Is weekend?',
      description: 'Checks whether the date falls on Saturday or Sunday',
      outputType: 'boolean',
      expression: 'is_weekend($value)',
    },
    {
      id: 'date_now', label: 'Current date',
      description: 'Replaces with the current date/time',
      expression: 'now()',
    },
    {
      id: 'date_today', label: 'Today (date only)',
      description: 'Current date without time',
      outputType: 'string',
      expression: 'date_format(now(), "YYYY-MM-DD")',
    },
    {
      id: 'date_null_now', label: 'Null → now',
      description: 'Uses the current date if null',
      expression: 'coalesce($value, now())',
    },
    {
      id: 'date_to_str', label: '→ ISO string',
      description: 'Convert to an ISO 8601 string',
      outputType: 'string',
      expression: 'date_format($value, "YYYY-MM-DD")',
    },
  ],

  // ══════════════════════════════════════════════════════════════
  // OBJECT
  // ══════════════════════════════════════════════════════════════
  object: [
    {
      id: 'obj_to_json', label: '→ JSON string',
      description: 'Serializes the object to a JSON string',
      outputType: 'string',
      expression: 'to_json($value)',
    },
    {
      id: 'obj_get', label: 'Read property',
      description: 'Gets the value of a property',
      expression: 'get($value, $param_key)',
      params: [{ key: 'key', label: 'Key', type: 'text', default: 'id' }],
    },
    {
      id: 'obj_get_nested', label: 'Nested property',
      description: 'Gets a nested property by path (e.g. a.b.c)',
      expression: 'get_path($value, $param_path)',
      params: [{ key: 'path', label: 'Path (dot notation)', type: 'text', default: 'data.id' }],
    },
    {
      id: 'obj_keys', label: 'List keys',
      description: 'Array of the object keys',
      expression: 'keys($value)',
    },
    {
      id: 'obj_values', label: 'List values',
      description: 'Array of the object values',
      expression: 'values($value)',
    },
    {
      id: 'obj_merge', label: 'Merge',
      description: 'Merges two objects (the second overrides)',
      expression: 'merge($value, $param_extra)',
      params: [{ key: 'extra', label: 'Extra object (JSON)', type: 'text', default: '{}' }],
    },
    {
      id: 'obj_is_null', label: 'Is null?',
      description: 'Checks whether the object is null',
      outputType: 'boolean',
      expression: '$value is null',
    },
    ],

  // ══════════════════════════════════════════════════════════════
  // ANY
  // ══════════════════════════════════════════════════════════════
  any: [
    {
      id: 'any_to_str', label: '→ string',
      description: 'Convert any value to a string',
      outputType: 'string',
      expression: 'to_string($value)',
    },
    {
      id: 'any_to_int', label: '→ integer',
      description: 'Convert to an integer',
      outputType: 'integer',
      expression: 'to_int($value)',
    },
    {
      id: 'any_to_decimal', label: '→ decimal',
      description: 'Convert to a decimal',
      outputType: 'decimal',
      expression: 'to_float($value)',
    },
    {
      id: 'any_to_bool', label: '→ boolean',
      description: 'Convert to a boolean',
      outputType: 'boolean',
      expression: 'to_bool($value)',
    },
    {
      id: 'any_is_null', label: 'Is null?',
      description: 'Checks whether the value is null',
      outputType: 'boolean',
      expression: '$value is null',
    },
    {
      id: 'any_is_not_null', label: 'Is not null?',
      description: 'Checks whether the value is not null',
      outputType: 'boolean',
      expression: '$value is not null',
    },
    {
      id: 'any_coalesce', label: 'Coalesce',
      description: 'First non-null value of the two',
      expression: 'coalesce($value, $param_fallback)',
      params: [{ key: 'fallback', label: 'Fallback value', type: 'text', default: 'N/A' }],
    },
    {
      id: 'any_default', label: 'Default if null',
      description: 'Uses a default value if null',
      expression: 'coalesce($value, $param_default)',
      params: [{ key: 'default', label: 'Default', type: 'text', default: '' }],
    },
    {
      id: 'any_ternary', label: 'If/Else',
      description: 'Ternary condition',
      expression: '$value ? $param_then : $param_else',
      params: [
        { key: 'then', label: 'If true',  type: 'text', default: 'Sì' },
        { key: 'else', label: 'If false', type: 'text', default: 'No' },
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