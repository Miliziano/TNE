/**
 * src/ir/functions.ts
 *
 * Catalogo delle funzioni FPEL. Fonte di verità per:
 *  - validazione a design-time (nome esistente, arità corretta)
 *  - autocomplete e help nei pannelli
 *  - futuro codegen (ogni backend traduce questo elenco)
 *
 * ALLINEATO A: src-tauri/src/engine/expr.rs (fn eval_function).
 * Se aggiungi una funzione lì, aggiungila qui.
 *
 * NOTA: il motore tollera argomenti mancanti (li tratta come null) e non
 * fallisce mai per arità sbagliata. La validazione deve quindi avvenire
 * QUI, a design-time, altrimenti l'errore passa silenzioso.
 */

export type FnCategory = 'stringa' | 'numero' | 'data' | 'conversione' | 'logica' | 'variabile' | 'struttura'

export interface FnSignature {
  /** nome canonico (quello che finisce nell'IR) */
  name:     string
  /** alias accettati in scrittura, normalizzati al canonico */
  aliases?: string[]
  category: FnCategory
  /** numero minimo di argomenti */
  minArgs:  number
  /** numero massimo; null = variadico */
  maxArgs:  number | null
  /** firma leggibile per l'help */
  usage:    string
  desc:     string
}

export const FUNCTIONS: FnSignature[] = [
  // ── Stringhe ──────────────────────────────────────────────────────
  { name: 'trim',        category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'trim(s)',  desc: 'Rimuove spazi iniziali e finali' },
  { name: 'ltrim',       aliases: ['trimleft'],  category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'ltrim(s)', desc: 'Rimuove spazi iniziali' },
  { name: 'rtrim',       aliases: ['trimright'], category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'rtrim(s)', desc: 'Rimuove spazi finali' },
  { name: 'upper',       aliases: ['touppercase'], category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'upper(s)', desc: 'Maiuscolo' },
  { name: 'lower',       aliases: ['tolowercase'], category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'lower(s)', desc: 'Minuscolo' },
  { name: 'length',      aliases: ['len'], category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'length(s)', desc: 'Lunghezza' },
  { name: 'substring',   aliases: ['substr'], category: 'stringa', minArgs: 2, maxArgs: 3, usage: 'substring(s, inizio [, lunghezza])', desc: 'Sottostringa (indice da 0)' },
  { name: 'replace',     category: 'stringa', minArgs: 3, maxArgs: 3, usage: 'replace(s, cerca, sostituisci)', desc: 'Sostituisce tutte le occorrenze' },
  { name: 'concat',      category: 'stringa', minArgs: 1, maxArgs: null, usage: 'concat(a, b, …)', desc: 'Concatena' },
  { name: 'concat_ws',   category: 'stringa', minArgs: 2, maxArgs: null, usage: 'concat_ws(sep, a, b, …)', desc: 'Concatena con separatore' },
  { name: 'left',        category: 'stringa', minArgs: 2, maxArgs: 2, usage: 'left(s, n)',  desc: 'Primi n caratteri' },
  { name: 'right',       category: 'stringa', minArgs: 2, maxArgs: 2, usage: 'right(s, n)', desc: 'Ultimi n caratteri' },
  { name: 'contains',    category: 'stringa', minArgs: 2, maxArgs: 2, usage: 'contains(s, sub)',   desc: 'Vero se contiene' },
  { name: 'starts_with', aliases: ['startswith'], category: 'stringa', minArgs: 2, maxArgs: 2, usage: 'starts_with(s, p)',  desc: 'Vero se inizia con' },
  { name: 'ends_with',   aliases: ['endswith'],   category: 'stringa', minArgs: 2, maxArgs: 2, usage: 'ends_with(s, p)',    desc: 'Vero se finisce con' },
  { name: 'pad_left',    aliases: ['lpad', 'padleft'], category: 'stringa', minArgs: 2, maxArgs: 3, usage: 'pad_left(s, n [, car])',  desc: 'Riempie a sinistra fino a n' },
  { name: 'pad_right',   aliases: ['rpad', 'padright'], category: 'stringa', minArgs: 2, maxArgs: 3, usage: 'pad_right(s, n [, car])', desc: 'Riempie a destra fino a n' },
  { name: 'regex_match', aliases: ['matches'], category: 'stringa', minArgs: 2, maxArgs: 2, usage: 'regex_match(s, pattern)', desc: 'Vero se il pattern combacia' },

  // ── Numeri ────────────────────────────────────────────────────────
  { name: 'abs',   category: 'numero', minArgs: 1, maxArgs: 1, usage: 'abs(x)',   desc: 'Valore assoluto' },
  { name: 'round', category: 'numero', minArgs: 1, maxArgs: 2, usage: 'round(x [, decimali])', desc: 'Arrotonda' },
  { name: 'ceil',  category: 'numero', minArgs: 1, maxArgs: 1, usage: 'ceil(x)',  desc: 'Arrotonda per eccesso' },
  { name: 'floor', category: 'numero', minArgs: 1, maxArgs: 1, usage: 'floor(x)', desc: 'Arrotonda per difetto' },
  { name: 'sqrt',  category: 'numero', minArgs: 1, maxArgs: 1, usage: 'sqrt(x)',  desc: 'Radice quadrata' },
  { name: 'power', aliases: ['pow'], category: 'numero', minArgs: 2, maxArgs: 2, usage: 'power(base, esp)', desc: 'Elevamento a potenza' },
  { name: 'min',   category: 'numero', minArgs: 2, maxArgs: 2, usage: 'min(a, b)', desc: 'Il minore' },
  { name: 'max',   category: 'numero', minArgs: 2, maxArgs: 2, usage: 'max(a, b)', desc: 'Il maggiore' },

  // ── Conversioni ───────────────────────────────────────────────────
  { name: 'to_string', aliases: ['str', 'tostring'],   category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'to_string(x)', desc: 'Converte in stringa' },
  { name: 'to_int',    aliases: ['int', 'toint'],   category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'to_int(x)',    desc: 'Converte in intero' },
  { name: 'to_float',  aliases: ['float', 'todecimal'], category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'to_float(x)',  desc: 'Converte in decimale' },
  { name: 'to_bool',   aliases: ['bool', 'tobool'],  category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'to_bool(x)',   desc: 'Converte in booleano' },

  // ── Date ──────────────────────────────────────────────────────────
  { name: 'now',   aliases: ['current_timestamp'], category: 'data', minArgs: 0, maxArgs: 0, usage: 'now()',   desc: 'Data e ora correnti' },
  { name: 'today', aliases: ['current_date'],      category: 'data', minArgs: 0, maxArgs: 0, usage: 'today()', desc: 'Data corrente' },
  { name: 'date_format', aliases: ['formatdate'], category: 'data', minArgs: 2, maxArgs: 2, usage: 'date_format(d, formato)', desc: 'Formatta una data' },
  { name: 'year',   aliases: ['getyear'],  category: 'data', minArgs: 1, maxArgs: 1, usage: 'year(d)',   desc: 'Anno' },
  { name: 'month',  aliases: ['getmonth'], category: 'data', minArgs: 1, maxArgs: 1, usage: 'month(d)',  desc: 'Mese (1-12)' },
  { name: 'day',    aliases: ['getday'],   category: 'data', minArgs: 1, maxArgs: 1, usage: 'day(d)',    desc: 'Giorno del mese' },
  { name: 'hour',   category: 'data', minArgs: 1, maxArgs: 1, usage: 'hour(d)',   desc: 'Ora (0-23)' },
  { name: 'minute', category: 'data', minArgs: 1, maxArgs: 1, usage: 'minute(d)', desc: 'Minuti' },
  { name: 'second', category: 'data', minArgs: 1, maxArgs: 1, usage: 'second(d)', desc: 'Secondi' },

  // ── Logica / null ─────────────────────────────────────────────────
  // NB: `coalesce` ha un nodo IR dedicato, ma resta nel catalogo per l'help.
  { name: 'coalesce', aliases: ['ifnull', 'nvl', 'coalesceempty'], category: 'logica', minArgs: 2, maxArgs: null, usage: 'coalesce(a, b, …)', desc: 'Il primo valore non nullo' },
  { name: 'nullif',   category: 'logica', minArgs: 2, maxArgs: 2, usage: 'nullif(a, b)', desc: 'null se a == b, altrimenti a' },
  { name: 'iif',      aliases: ['if'], category: 'logica', minArgs: 3, maxArgs: 3, usage: 'iif(cond, se_vero, se_falso)', desc: 'Condizionale (equivale a cond ? a : b)' },

  // ── Variabili di lane ─────────────────────────────────────────────
  { name: 'var', category: 'variabile', minArgs: 1, maxArgs: 1, usage: 'var("nome")', desc: 'Legge una variabile di lane' },

  // ── Date: componenti aggiuntive ───────────────────────────────────
  { name: 'quarter',     aliases: ['getquarter'],   category: 'data', minArgs: 1, maxArgs: 1, usage: 'quarter(d)',     desc: 'Trimestre (1-4)' },
  { name: 'day_of_week', aliases: ['getdayofweek'], category: 'data', minArgs: 1, maxArgs: 1, usage: 'day_of_week(d)', desc: 'Giorno settimana (0=domenica)' },
  { name: 'is_weekend',  aliases: ['isweekend'],    category: 'data', minArgs: 1, maxArgs: 1, usage: 'is_weekend(d)',  desc: 'Vero se sabato o domenica' },

  // ── Date: aritmetica ──────────────────────────────────────────────
  { name: 'add_days',   aliases: ['adddays'],   category: 'data', minArgs: 2, maxArgs: 2, usage: 'add_days(d, n)',   desc: 'Aggiunge n giorni' },
  { name: 'add_months', aliases: ['addmonths'], category: 'data', minArgs: 2, maxArgs: 2, usage: 'add_months(d, n)', desc: 'Aggiunge n mesi' },
  { name: 'add_years',  aliases: ['addyears'],  category: 'data', minArgs: 2, maxArgs: 2, usage: 'add_years(d, n)',  desc: 'Aggiunge n anni' },
  { name: 'diff_days',  aliases: ['diffdays'],  category: 'data', minArgs: 2, maxArgs: 2, usage: 'diff_days(a, b)',  desc: 'Giorni da a a b' },

  // ── Date: confini di periodo ──────────────────────────────────────
  { name: 'start_of_month', aliases: ['startofmonth'], category: 'data', minArgs: 1, maxArgs: 1, usage: 'start_of_month(d)', desc: 'Primo giorno del mese' },
  { name: 'end_of_month',   aliases: ['endofmonth'],   category: 'data', minArgs: 1, maxArgs: 1, usage: 'end_of_month(d)',   desc: 'Ultimo giorno del mese' },
  { name: 'start_of_year',  aliases: ['startofyear'],  category: 'data', minArgs: 1, maxArgs: 1, usage: 'start_of_year(d)',  desc: 'Primo giorno dell\'anno' },

  // ── Date: confronto e conversione ─────────────────────────────────
  { name: 'is_before', aliases: ['isbefore'], category: 'data', minArgs: 2, maxArgs: 2, usage: 'is_before(a, b)', desc: 'Vero se a precede b' },
  { name: 'is_after',  aliases: ['isafter'],  category: 'data', minArgs: 2, maxArgs: 2, usage: 'is_after(a, b)',  desc: 'Vero se a segue b' },
  { name: 'to_unix_timestamp',    aliases: ['tounixtimestamp'],   category: 'data', minArgs: 1, maxArgs: 1, usage: 'to_unix_timestamp(d)',    desc: 'Secondi dall\'epoch' },
  { name: 'to_unix_timestamp_ms', aliases: ['tounixtimestampms'], category: 'data', minArgs: 1, maxArgs: 1, usage: 'to_unix_timestamp_ms(d)', desc: 'Millisecondi dall\'epoch' },
  { name: 'parse_date', aliases: ['parsedate'], category: 'data', minArgs: 1, maxArgs: 2, usage: 'parse_date(testo [, formato])', desc: 'Interpreta un testo come data' },

  // ── Numeri aggiuntivi ─────────────────────────────────────────────
  { name: 'sign',   category: 'numero', minArgs: 1, maxArgs: 1, usage: 'sign(x)',   desc: '-1, 0 o 1 secondo il segno' },
  { name: 'negate', category: 'numero', minArgs: 1, maxArgs: 1, usage: 'negate(x)', desc: 'Cambia segno' },
  { name: 'clamp',  category: 'numero', minArgs: 3, maxArgs: 3, usage: 'clamp(x, min, max)', desc: 'Limita x nell\'intervallo' },
  { name: 'format_number', aliases: ['formatnumber'], category: 'numero', minArgs: 2, maxArgs: 4, usage: 'format_number(x, dec [, sep_dec [, sep_mig]])', desc: 'Formatta: format_number(x,2,",",".") → 1.234,56' },
 
  // ── Stringhe aggiuntive ───────────────────────────────────────────
  { name: 'capitalize',     category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'capitalize(s)', desc: 'Prima lettera maiuscola' },
  { name: 'title_case',     aliases: ['titlecase'],     category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'title_case(s)',     desc: 'Ogni Parola Maiuscola' },
  { name: 'remove_accents', aliases: ['removeaccents'], category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'remove_accents(s)', desc: 'Rimuove gli accenti' },
  { name: 'to_slug',        aliases: ['toslug'],        category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'to_slug(s)',        desc: 'Testo-normalizzato-per-url' },
  { name: 'replace_regex',  aliases: ['replaceregex'],  category: 'stringa', minArgs: 3, maxArgs: 3, usage: 'replace_regex(s, pattern, sost)', desc: 'Sostituisce via espressione regolare' },
  { name: 'mask_email',     aliases: ['maskemail'],     category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'mask_email(s)',     desc: 'm****@dominio.it' },
  { name: 'mask_card',      aliases: ['maskcard'],      category: 'stringa', minArgs: 1, maxArgs: 1, usage: 'mask_card(s)',      desc: 'Mostra solo le ultime 4 cifre' },

  // ── Encoding / hash ───────────────────────────────────────────────
  { name: 'url_encode',    aliases: ['urlencode'],    category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'url_encode(s)',    desc: 'Codifica per URL' },
  { name: 'url_decode',    aliases: ['urldecode'],    category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'url_decode(s)',    desc: 'Decodifica da URL' },
  { name: 'base64_encode', aliases: ['base64encode'], category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'base64_encode(s)', desc: 'Codifica in base64' },
  { name: 'base64_decode', aliases: ['base64decode'], category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'base64_decode(s)', desc: 'Decodifica da base64' },
  { name: 'hash_sha256',   aliases: ['hashsha256'],   category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'hash_sha256(s)',   desc: 'Impronta SHA-256 (esadecimale)' },
  { name: 'to_json',       aliases: ['tojson'],       category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'to_json(x)',       desc: 'Serializza in JSON' },

  // ── Numeri: logaritmi ─────────────────────────────────────────────
  { name: 'log',   aliases: ['ln'], category: 'numero', minArgs: 1, maxArgs: 1, usage: 'log(x)',   desc: 'Logaritmo naturale' },
  { name: 'log10', category: 'numero', minArgs: 1, maxArgs: 1, usage: 'log10(x)', desc: 'Logaritmo base 10' },

  // ── Hash (famiglia SHA) ───────────────────────────────────────────
  { name: 'hash_sha1',   aliases: ['hashsha1'],   category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'hash_sha1(s)',   desc: 'SHA-1 (deprecato, solo compatibilità)' },
  { name: 'hash_sha512', aliases: ['hashsha512'], category: 'conversione', minArgs: 1, maxArgs: 1, usage: 'hash_sha512(s)', desc: 'Impronta SHA-512' },

  // ── Strutture (oggetti / array JSON) ──────────────────────────────
  { name: 'get',      category: 'struttura', minArgs: 2, maxArgs: 2, usage: 'get(oggetto, chiave)',    desc: 'Valore di una chiave' },
  { name: 'get_path', aliases: ['getpath'], category: 'struttura', minArgs: 2, maxArgs: 2, usage: 'get_path(oggetto, "a.b.0.c")', desc: 'Valore annidato per percorso' },
  { name: 'keys',     category: 'struttura', minArgs: 1, maxArgs: 1, usage: 'keys(oggetto)',   desc: 'Elenco delle chiavi' },
  { name: 'values',   category: 'struttura', minArgs: 1, maxArgs: 1, usage: 'values(oggetto)', desc: 'Elenco dei valori' },
  { name: 'merge',    category: 'struttura', minArgs: 2, maxArgs: 2, usage: 'merge(a, b)',     desc: 'Unisce due oggetti (b prevale)' },
]

/** alias → nome canonico */
const ALIAS_TO_NAME = new Map<string, string>()
for (const f of FUNCTIONS) {
  ALIAS_TO_NAME.set(f.name, f.name)
  for (const a of f.aliases ?? []) ALIAS_TO_NAME.set(a, f.name)
}

const BY_NAME = new Map(FUNCTIONS.map(f => [f.name, f]))

/** Risolve un nome (o alias) al nome canonico. null se sconosciuto. */
export function canonicalName(name: string): string | null {
  return ALIAS_TO_NAME.get(name.toLowerCase()) ?? null
}

export function lookupFunction(name: string): FnSignature | null {
  const canon = canonicalName(name)
  return canon ? (BY_NAME.get(canon) ?? null) : null
}

/**
 * Valida nome e arità. Ritorna null se ok, altrimenti il messaggio d'errore.
 * Da chiamare sul FunctionCall dopo il parsing.
 */
export function validateCall(name: string, argCount: number): string | null {
  const fn = lookupFunction(name)
  if (!fn) {
    const suggest = suggestName(name)
    return `funzione sconosciuta: "${name}"` + (suggest ? ` — forse intendevi "${suggest}"?` : '')
  }
  if (argCount < fn.minArgs) {
    return `${fn.name} richiede almeno ${fn.minArgs} argomenti (ricevuti ${argCount}) — ${fn.usage}`
  }
  if (fn.maxArgs !== null && argCount > fn.maxArgs) {
    return `${fn.name} accetta al massimo ${fn.maxArgs} argomenti (ricevuti ${argCount}) — ${fn.usage}`
  }
  return null
}

/** Suggerimento per errore di battitura (distanza di Levenshtein ≤ 2). */
function suggestName(name: string): string | null {
  const lower = name.toLowerCase()
  let best: string | null = null
  let bestDist = 3
  for (const candidate of ALIAS_TO_NAME.keys()) {
    const d = levenshtein(lower, candidate)
    if (d < bestDist) { bestDist = d; best = candidate }
  }
  return best
}

function levenshtein(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)])
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
  }
  return dp[a.length][b.length]
}

/** Per l'autocomplete: funzioni raggruppate per categoria. */
export function functionsByCategory(): Record<FnCategory, FnSignature[]> {
  const out = {} as Record<FnCategory, FnSignature[]>
  for (const f of FUNCTIONS) (out[f.category] ??= []).push(f)
  return out
}