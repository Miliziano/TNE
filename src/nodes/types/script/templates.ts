/**
 * src/nodes/types/script/templates.ts
 *
 * Esempi pronti per il nodo Script, nel linguaggio di FlowPilot
 * (istruzioni + espressioni FPEL — v. src-tauri/docs/design-nodo-script.md).
 *
 * Prima questo file conteneva ~120 esempi in TypeScript, Python, Java e
 * Groovy: quattro linguaggi che il motore non ha mai eseguito e che
 * nessun codegen ha mai tradotto. Ora ce n'e' uno solo, ed e' quello che
 * gira davvero.
 *
 * Ogni esempio usa SOLO funzioni che esistono in `expr_functions.rs`.
 * Un template che non funziona e' peggio di un template che manca:
 * insegna una sintassi sbagliata e fa perdere tempo a capire di chi sia
 * la colpa.
 */

export interface ScriptTemplate {
  id:          string
  label:       string
  description: string
  category:    string
  code:        string
}

const T = (...righe: string[]) => righe.join('\n')

export const SCRIPT_TEMPLATES: ScriptTemplate[] = [

  // == Base =====================================================
  {
    id: 'base_trasforma', category: 'Base',
    label: 'Add fields',
    description: 'Computes new fields; the ones you don\'t touch pass through unchanged',
    code: T(
      '// Fields are read by name. Assigning creates or overwrites.',
      '// What you do not assign passes downstream as it was.',
      'processed_on  = today()',
      'full_name = concat_ws(" ", name, last_name)',
    ),
  },
  {
    id: 'base_intermedi', category: 'Base',
    label: 'Intermediate values with let',
    description: 'Helper calculations that don\'t end up in the output row',
    code: T(
      '// "let" does NOT create a field: it only lives inside the script.',
      'let taxable = quantity * unit_price',
      'let vat        = round(taxable * 0.22, 2)',
      '',
      'total = round(taxable + vat, 2)',
    ),
  },
  {
    id: 'base_condizione', category: 'Base',
    label: 'Condition',
    description: 'Different branches based on the row content',
    code: T(
      'if total > 1000 {',
      '  tier = "high"',
      '  log "Order above threshold: " + code',
      '} else if total > 100 {',
      '  tier = "medium"',
      '} else {',
      '  tier = "low"',
      '}',
    ),
  },
  {
    id: 'base_filtro', category: 'Base',
    label: 'Filter (skip)',
    description: 'The rows you don\'t care about exit through no port',
    code: T(
      '// "skip" stops processing of THIS row: it exits through no',
      '// port and the following instructions are not executed.',
      'if status != "active" {',
      '  skip',
      '}',
    ),
  },
  {
    id: 'base_scarto', category: 'Base',
    label: 'Reject with a reason (reject)',
    description: 'Sends the row to the reject port explaining why',
    code: T(
      '// Requires the "reject" port active in the panel. The reason ends up',
      '// in the _reject_reason field of the rejected row.',
      'if email is null {',
      '  reject "email missing"',
      '}',
      'if quantity <= 0 {',
      '  reject "invalid quantity: " + to_string(quantity)',
      '}',
    ),
  },
  {
    id: 'base_errore', category: 'Base',
    label: 'Fail (error)',
    description: 'Stops the node and sends the error to the lane\'s error handler',
    code: T(
      '// Different from reject: here it is the NODE that fails, and the error takes the',
      '// control channel like any other failure.',
      'if record_type is null {',
      '  error "record without type: the file does not have the expected format"',
      '}',
    ),
  },

  // == Piu righe ================================================
  {
    id: 'fanout_ripeti', category: 'Multiple rows',
    label: 'One row -> N copies',
    description: 'Duplicates each row a number of times',
    code: T(
      '// "emit" sends downstream a copy of the row as it is at that moment;',
      '// it interrupts nothing. The final "skip" prevents the original',
      '// from exiting TOO: without it, N copies plus the starting row would exit.',
      'repeat quantity as copy {',
      '  copy_number = copy',
      '  emit',
      '}',
      'skip',
    ),
  },
  {
    id: 'fanout_array', category: 'Multiple rows',
    label: 'Expand an array',
    description: 'A field containing a JSON array becomes one row per element',
    code: T(
      '// The field must contain an array (for example from a JSON Parser).',
      'for element in details {',
      '  detail = element',
      '  emit',
      '}',
      'skip',
    ),
  },
  {
    id: 'gen_serie', category: 'Multiple rows',
    label: 'Generate rows from nothing',
    description: 'Starting node: no input, it produces the rows itself',
    code: T(
      '// Set "Row source" to GENERATE: the input port',
      '// disappears, the body runs ONCE and rows exit only',
      '// through "emit". No "skip" needed here: with no input there is',
      '// no original row to hold back.',
      'repeat 12 as month {',
      '  month_number = month',
      '  label       = "month " + to_string(month)',
      '  emit',
      '}',
    ),
  },

  // == Stringhe =================================================
  {
    id: 'str_normalizza', category: 'Strings',
    label: 'Normalize',
    description: 'Spaces, uppercase, accents',
    code: T(
      'name    = title_case(trim(name))',
      'code    = upper(trim(code))',
      'search  = to_slug(remove_accents(description))',
    ),
  },
  {
    id: 'str_maschera', category: 'Strings',
    label: 'Mask sensitive data',
    description: 'Obfuscated emails and credit cards',
    code: T(
      'public_email = mask_email(email)',
      'public_card = mask_card(card_number)',
    ),
  },
  {
    id: 'str_estrai', category: 'Strings',
    label: 'Extract and replace',
    description: 'Substrings, padding, regular expressions',
    code: T(
      'prefix    = left(code, 3)',
      'serial      = pad_left(to_string(number), 6, "0")',
      'cleaned     = replace_regex(phone, "[^0-9]", "")',
    ),
  },

  // == Date =====================================================
  {
    id: 'data_formatta', category: 'Date',
    label: 'Format a date',
    description: 'From date to string in the format you need',
    code: T(
      '// The pattern accepts both dd/MM/yyyy and %d/%m/%Y.',
      'formatted_date = date_format(order_date, "dd/MM/yyyy")',
      'year_month     = date_format(order_date, "yyyy-MM")',
    ),
  },
  {
    id: 'data_calcoli', category: 'Date',
    label: 'Date calculations',
    description: 'Deadlines, differences, quarters',
    code: T(
      'due_date      = add_days(invoice_date, 30)',
      'days_open     = diff_days(today(), open_date)',
      'quarter_num   = quarter(order_date)',
      '',
      'if is_weekend(delivery_date) {',
      '  note = "weekend delivery"',
      '}',
    ),
  },

  // == Numeri ===================================================
  {
    id: 'num_calcoli', category: 'Numbers',
    label: 'Calculations and rounding',
    description: 'Discounts, totals, values within a range',
    code: T(
      'let valid_discount = clamp(discount_percent, 0, 100)',
      'let discounted     = price * (1 - valid_discount / 100)',
      '',
      'final_price = round(discounted, 2)',
      'savings     = round(price - discounted, 2)',
    ),
  },
  {
    id: 'num_sicuri', category: 'Numbers',
    label: 'Guard against missing values',
    description: 'Default values and safe divisions',
    code: T(
      '// coalesce returns the first non-null value.',
      'let q = coalesce(quantity, 0)',
      'let t = coalesce(total, 0)',
      '',
      '// Division by zero gives null: iif avoids propagating it.',
      'avg_price = iif(q > 0, round(t / q, 2), 0)',
    ),
  },

  // == Controlli ================================================
  {
    id: 'val_obbligatori', category: 'Checks',
    label: 'Required fields',
    description: 'Rejects incomplete rows saying what is missing',
    code: T(
      'if code is null {',
      '  reject "code is missing"',
      '}',
      'if description is null {',
      '  reject "description missing for " + code',
      '}',
      'if length(trim(coalesce(description, ""))) < 3 {',
      '  reject "description too short for " + code',
      '}',
    ),
  },
  {
    id: 'val_formato', category: 'Checks',
    label: 'Field format',
    description: 'Checks the shape with a regular expression',
    code: T(
      'if regex_match(email, "^[^@ ]+@[^@ ]+\\\\.[a-z]{2,}$") == false {',
      '  reject "invalid email: " + email',
      '}',
      'if starts_with(iban, "IT") == false {',
      '  log "foreign IBAN on " + code',
      '  foreign = true',
      '}',
    ),
  },
  {
    id: 'chiave_hash', category: 'Checks',
    label: 'Stable key',
    description: 'A reproducible fingerprint from multiple fields',
    code: T(
      '// concat_ws with a separator prevents "AB"+"C" and "A"+"BC"',
      '// from producing the same key.',
      'key = hash_sha256(concat_ws("|", code, to_string(order_date), customer))',
    ),
  },

  // == Variabili di lane ========================================
  {
    id: 'lane_leggi', category: 'Lane variables',
    label: 'Read a lane variable',
    description: 'Values shared in the lane, read with var()',
    code: T(
      '// var("name") reads a lane variable. Writing them from the',
      '// script is not yet possible: it will come in a later slice.',
      'environment = var("environment")',
      'load_date    = var("run_date")',
      '',
      'if var("environment") == "test" {',
      '  log "row processed in test: " + code',
      '}',
    ),
  },
]

// === Accesso ========================================================

export function getTemplates(): ScriptTemplate[] {
  return SCRIPT_TEMPLATES
}

export function getTemplatesByCategory(): Record<string, ScriptTemplate[]> {
  return SCRIPT_TEMPLATES.reduce((acc, t) => {
    (acc[t.category] ??= []).push(t)
    return acc
  }, {} as Record<string, ScriptTemplate[]>)
}

export function getDefaultTemplate(): string {
  return SCRIPT_TEMPLATES[0]?.code ?? ''
}
