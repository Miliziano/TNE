/**
 * src/ir/exprParser.ts
 *
 * FlowPilot Expression Language (FPEL) — parser.
 * Vedi docs/design-linguaggio-espressioni.md per la grammatica.
 *
 * Testo → ExprNode (IR). Usato da TUTTI i nodi che valutano espressioni
 * (tmap, transform, filter, data_quality, script, …).
 *
 * Il motore Rust e il codegen partono dall'IR, mai dal testo: il parser
 * vive solo nello studio.
 *
 * PRINCIPIO: un'espressione non valida è un ERRORE, mai un degrado
 * silenzioso a Literal (bug storico: `upper(x)` finiva nel dato come la
 * stringa "upper(x)").
 */

import { validateCall, canonicalName } from './functions'

// ─── IR (allineato a src-tauri/src/engine/expr.rs) ──────────────────

export type ExprNode =
  | { kind: 'Literal'; value: string | number | boolean | null }
  | { kind: 'FieldRef'; input: string; field: string }
  | { kind: 'DirectFieldRef'; field: string }
  | { kind: 'BinaryOp'; op: string; left: ExprNode; right: ExprNode }
  | { kind: 'UnaryOp'; op: string; expr: ExprNode }
  | { kind: 'FunctionCall'; name: string; args: ExprNode[] }
  | { kind: 'CaseWhen'; branches: Array<{ condition: ExprNode; value: ExprNode }>; default: ExprNode | null }
  | { kind: 'Cast'; expr: ExprNode; target_type: string }
  | { kind: 'IsNull'; expr: ExprNode }
  | { kind: 'IsNotNull'; expr: ExprNode }
  | { kind: 'Coalesce'; args: ExprNode[] }

export class ExprParseError extends Error {
  readonly pos: number
  readonly source: string

  constructor(message: string, pos: number, source: string) {
    super(message)
    this.name = 'ExprParseError'
    this.pos = pos
    this.source = source
  }
  /** Messaggio con indicatore di posizione, per il pannello. */
  pretty(): string {
    const caret = ' '.repeat(Math.max(0, this.pos)) + '^'
    return `${this.message}\n  ${this.source}\n  ${caret}`
  }
}

// ─── Tokenizer ──────────────────────────────────────────────────────

type TokKind =
  | 'num' | 'str' | 'fstr' | 'ident' | 'op' | 'lparen' | 'rparen' | 'lbrack' | 'rbrack'
  | 'comma' | 'dot' | 'eof'

interface Token {
  kind: TokKind
  text: string
  pos:  number
  /** per 'num' */ num?: number
  /** per 'str' e 'fstr' (contenuto senza virgolette) */ str?: string
  /** per 'fstr': posizione del primo carattere del contenuto */ contentPos?: number
  /** per 'ident': era racchiuso in backtick → mai una parola chiave */
  quoted?: boolean
}

/** Operatori multi-carattere, ordinati per lunghezza decrescente. */
const OPERATORS = ['??', '->', '==', '!=', '>=', '<=', '&&', '||', '+', '-', '*', '/', '%', '>', '<', '!', '?', ':']

function tokenize(src: string): Token[] {
  const toks: Token[] = []
  let i = 0

  // Identificatori Unicode: i nomi dei campi possono contenere accenti
  // (età, città), lettere non latine, ecc. `\p{L}` = qualsiasi lettera,
  // `\p{N}` = qualsiasi cifra. Il flag `u` abilita le proprietà Unicode.
  const isIdentStart = (c: string) => /[\p{L}_$]/u.test(c)
  const isIdentChar  = (c: string) => /[\p{L}\p{N}_$]/u.test(c)

  while (i < src.length) {
    const c = src[i]

    if (/\s/.test(c)) { i++; continue }

    // Identificatore quotato: `data ordine`, `costo/unità`
    // Distinto dalle stringhe: serve per i nomi di campo che contengono
    // spazi o punteggiatura, come in SQL ("nome") o MySQL (`nome`).
    if (c === '`') {
      const start = i
      i++
      let name = ''
      while (i < src.length && src[i] !== '`') { name += src[i]; i++ }
      if (i >= src.length) throw new ExprParseError('unterminated identifier: missing `', start, src)
      i++
      if (!name) throw new ExprParseError('empty identifier: ``', start, src)
      toks.push({ kind: 'ident', text: name, pos: start, quoted: true })
      continue
    }

    // P389: testo con segnaposto f"Ordine {id} di {cliente}" (anche f'…').
    // Il contenuto si analizza nel parser; qui si cerca solo la fine.
    if ((c === 'f' || c === 'F') && (src[i + 1] === '"' || src[i + 1] === "'")) {
      const quote = src[i + 1]
      const start = i
      i += 2
      let out = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) { out += src[i] + src[i + 1]; i += 2 }
        else { out += src[i]; i++ }
      }
      if (i >= src.length) throw new ExprParseError('unterminated string', start, src)
      i++
      toks.push({ kind: 'fstr', text: src.slice(start, i), pos: start, str: out, contentPos: start + 2 })
      continue
    }

    // Stringa: "..." o '...' con escape \" \' \\ \n \t
    if (c === '"' || c === "'") {
      const quote = c
      const start = i
      i++
      let out = ''
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\\' && i + 1 < src.length) {
          const e = src[i + 1]
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e
          i += 2
        } else {
          out += src[i]; i++
        }
      }
      if (i >= src.length) throw new ExprParseError('unterminated string', start, src)
      i++ // chiude
      toks.push({ kind: 'str', text: src.slice(start, i), pos: start, str: out })
      continue
    }

    // Numero: 42, 3.14, .5
    if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const start = i
      while (i < src.length && /[0-9._]/.test(src[i])) i++
      const raw = src.slice(start, i).replace(/_/g, '')
      const n = Number(raw)
      if (isNaN(n)) throw new ExprParseError(`invalid number: "${raw}"`, start, src)
      toks.push({ kind: 'num', text: raw, pos: start, num: n })
      continue
    }

    // Identificatore / parola chiave
    if (isIdentStart(c)) {
      const start = i
      while (i < src.length && isIdentChar(src[i])) i++
      toks.push({ kind: 'ident', text: src.slice(start, i), pos: start })
      continue
    }

    if (c === '(') { toks.push({ kind: 'lparen', text: '(', pos: i }); i++; continue }
    if (c === ')') { toks.push({ kind: 'rparen', text: ')', pos: i }); i++; continue }
    if (c === '[') { toks.push({ kind: 'lbrack', text: '[', pos: i }); i++; continue }
    if (c === ']') { toks.push({ kind: 'rbrack', text: ']', pos: i }); i++; continue }
    if (c === ',') { toks.push({ kind: 'comma',  text: ',', pos: i }); i++; continue }
    if (c === '.') { toks.push({ kind: 'dot',    text: '.', pos: i }); i++; continue }

    const op = OPERATORS.find(o => src.startsWith(o, i))
    if (op) { toks.push({ kind: 'op', text: op, pos: i }); i += op.length; continue }

    throw new ExprParseError(`unrecognized character: "${c}"`, i, src)
  }

  toks.push({ kind: 'eof', text: '', pos: src.length })
  return toks
}

// ─── Precedenza (dalla più bassa alla più alta) ─────────────────────

const PREC: Record<string, number> = {
  '??': 1,
  '||': 1, 'or': 1,
  '&&': 2, 'and': 2,
  '==': 3, '!=': 3,
  '<': 4, '<=': 4, '>': 4, '>=': 4,
  '+': 5, '-': 5,
  '*': 6, '/': 6, '%': 6,
}

const OP_TO_IR: Record<string, string> = {
  '+': 'ADD', '-': 'SUB', '*': 'MUL', '/': 'DIV', '%': 'MOD',
  '==': 'EQ', '!=': 'NE', '>': 'GT', '<': 'LT', '>=': 'GTE', '<=': 'LTE',
  '&&': 'AND', '||': 'OR', 'and': 'AND', 'or': 'OR',
}

const CAST_TYPES: Record<string, string> = {
  integer: 'integer', int: 'integer',
  float: 'float', double: 'float', decimal: 'decimal',
  string: 'string', text: 'string',
  boolean: 'boolean', bool: 'boolean',
  date: 'date', datetime: 'datetime',
}

/** P389: funzioni che ricevono una funzione `x -> …` come secondo argomento
 *  (allineato a `is_hof` in expr.rs). Per filter e map è obbligatoria. */
const LAMBDA_FNS = new Set(['any', 'all', 'filter', 'map', 'sum', 'count'])
const LAMBDA_REQUIRED = new Set(['filter', 'map'])

/** P389: precedenza di `in`, `between`, `like` (come `==`). */
const PREC_CONFRONTO = 3

/** Costruttori dei nodi che lo studio genera per le funzioni `x -> …`. */
function lambdaNode(param: string, body: ExprNode): ExprNode {
  return { kind: 'FunctionCall', name: 'lambda', args: [{ kind: 'Literal', value: param }, body] }
}
function lambdaArg(param: string): ExprNode {
  return { kind: 'FunctionCall', name: 'lambda_arg', args: [{ kind: 'Literal', value: param }] }
}
/** true se il nodo è una funzione `x -> …` */
export function isLambda(n: ExprNode): boolean {
  return n.kind === 'FunctionCall' && n.name === 'lambda'
}

const KEYWORDS = new Set([
  'true', 'false', 'null', 'and', 'or', 'is', 'not',
  'case', 'when', 'then', 'else', 'end', 'cast', 'as',
])

// ─── Parser (Pratt / precedence climbing) ───────────────────────────

export interface ParseOptions {
  /** Etichette input note (tmap multi-input): "DB Source".campo → FieldRef */
  labelToInputId?: Map<string, string>
  /** Funzioni utente in scope: nome (minuscolo) → numero di parametri. Se
      presente, una chiamata a un nome noto è accettata (arità validata) e resta
      una FunctionCall col nome nudo; l'espansione avviene dopo (userFunctions.ts). */
  userFunctions?: Map<string, number>
}

/**
 * Come si SCRIVE il riferimento a un input in FPEL — regola unica, condivisa da
 * chi genera testo (l'interfaccia) e da chi lo legge (questo parser).
 * Etichetta identificatore → nuda (`Anagrafica`); con spazi o punteggiatura →
 * fra virgolette (`"Anagrafica clienti"`).
 */
export function riferimentoInput(label: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(label)
    ? label
    : `"${label.replace(/"/g, '\\"')}"`
}

export function parseExpression(src: string, opts: ParseOptions = {}): ExprNode {
  const p = new Parser(src, opts)
  const node = p.parseExpr(0)
  p.expect('eof', 'incomplete expression')
  return node
}

class Parser {
  private toks: Token[]
  private i = 0
  private src: string
  private opts: ParseOptions
  /** P389: parametri delle funzioni `x -> …` visibili qui (dall'esterno all'interno) */
  lambdaScope: string[] = []
  /** P389: in questa posizione è ammessa una funzione `x -> …` */
  private lambdaOk = false

  constructor(src: string, opts: ParseOptions) {
    this.src = src
    this.opts = opts
    this.toks = tokenize(src)
  }

  private peek(): Token { return this.toks[this.i] }
  private peekAt(k: number): Token { return this.toks[Math.min(this.i + k, this.toks.length - 1)] }
  private next(): Token { return this.toks[this.i++] }
  private at(kind: TokKind, text?: string): boolean {
    const t = this.peek()
    return t.kind === kind && (text === undefined || t.text.toLowerCase() === text)
  }
  private atKeyword(kw: string): boolean {
    const t = this.peek()
    return t.kind === 'ident' && t.text.toLowerCase() === kw
  }
  expect(kind: TokKind, msg: string): Token {
    if (this.peek().kind !== kind) {
      throw new ExprParseError(`${msg} (found "${this.peek().text || 'end'}")`, this.peek().pos, this.src)
    }
    return this.next()
  }
  private err(msg: string): never {
    throw new ExprParseError(msg, this.peek().pos, this.src)
  }

  /** Espressione con precedenza ≥ minPrec. */
  parseExpr(minPrec: number): ExprNode {
    let left = this.parseUnary()

    for (;;) {
      // Postfix: `is null`, `is not null`
      if (this.atKeyword('is')) {
        this.next()
        const negated = this.atKeyword('not')
        if (negated) this.next()
        if (!this.atKeyword('null')) this.err('expected "null" after "is"')
        this.next()
        left = negated ? { kind: 'IsNotNull', expr: left } : { kind: 'IsNull', expr: left }
        continue
      }

      // Ternario: cond ? a : b   → iif(cond, a, b)
      if (this.at('op', '?') && minPrec === 0) {
        this.next()
        const thenE = this.parseExpr(0)
        if (!this.at('op', ':')) this.err('expected ":" in the ternary')
        this.next()
        const elseE = this.parseExpr(0)
        left = { kind: 'FunctionCall', name: 'iif', args: [left, thenE, elseE] }
        continue
      }

      // P389: `x [not] in (…)`, `x [not] between a and b`, `x [not] like "A%"`
      const negato = this.atKeyword('not') && this.peekAt(1).kind === 'ident'
        && ['in', 'between', 'like'].includes(this.peekAt(1).text.toLowerCase())
      const parola = negato ? this.peekAt(1).text.toLowerCase()
        : (this.peek().kind === 'ident' ? this.peek().text.toLowerCase() : '')
      if (parola === 'in' || parola === 'between' || parola === 'like') {
        if (PREC_CONFRONTO < minPrec) break
        if (negato) this.next()
        this.next()
        const e = parola === 'in' ? this.parseIn(left)
          : parola === 'between' ? this.parseBetween(left)
          : { kind: 'FunctionCall', name: 'like', args: [left, this.parseExpr(PREC_CONFRONTO + 1)] } as ExprNode
        left = negato ? { kind: 'UnaryOp', op: 'NOT', expr: e } : e
        continue
      }

      const t = this.peek()
      const opText = t.kind === 'op' ? t.text : (t.kind === 'ident' ? t.text.toLowerCase() : '')
      const prec = PREC[opText]
      if (prec === undefined || prec < minPrec) break
      // 'and'/'or' come parole: consumale solo se sono operatori noti
      if (t.kind === 'ident' && opText !== 'and' && opText !== 'or') break

      this.next()
      const right = this.parseExpr(prec + 1)  // left-assoc
      // P389: `a ?? b` = coalesce(a, b) (catene piatte: a ?? b ?? c)
      if (opText === '??') {
        left = { kind: 'Coalesce', args: [...(left.kind === 'Coalesce' ? left.args : [left]), right] }
        continue
      }
      const irOp = OP_TO_IR[opText]
      if (!irOp) this.err(`unsupported operator: "${opText}"`)
      left = { kind: 'BinaryOp', op: irOp, left, right }
    }

    return left
  }

  private parseUnary(): ExprNode {
    if (this.at('op', '!')) { this.next(); return { kind: 'UnaryOp', op: 'NOT', expr: this.parseUnary() } }
    if (this.at('op', '-')) { this.next(); return { kind: 'UnaryOp', op: 'NEG', expr: this.parseUnary() } }
    if (this.atKeyword('not')) { this.next(); return { kind: 'UnaryOp', op: 'NOT', expr: this.parseUnary() } }
    return this.parsePrimary()
  }

  private parsePrimary(): ExprNode {
    const t = this.peek()

    if (t.kind === 'num') { this.next(); return { kind: 'Literal', value: t.num! } }
    if (t.kind === 'fstr') { this.next(); return this.parseFString(t) }
    if (t.kind === 'lbrack') {
      // P389: elenco [a, b, c] → list(a, b, c)
      this.next()
      const items: ExprNode[] = []
      if (!this.at('rbrack')) {
        items.push(this.parseItem())
        while (this.at('comma')) { this.next(); items.push(this.parseItem()) }
      }
      this.expect('rbrack', 'expected "]" at the end of the list')
      return { kind: 'FunctionCall', name: 'list', args: items }
    }
    if (t.kind === 'str') { this.next(); return this.maybeQualifiedField(t.str!, t.pos) }

    if (t.kind === 'lparen') {
      this.next()
      const e = this.parseExpr(0)
      this.expect('rparen', 'expected ")"')
      return e
    }

    if (t.kind === 'ident') {
      // Identificatore quotato: sempre un campo, mai parola chiave o funzione.
      if (t.quoted) {
        this.next()
        if (this.at('dot')) {
          this.next()
          const f = this.expect('ident', 'expected a field name after "."')
          return this.qualifiedField(t.text, f.text, t.pos)
        }
        return { kind: 'DirectFieldRef', field: t.text }
      }

      const lower = t.text.toLowerCase()

      // P389: funzione `x -> corpo`, ammessa solo come argomento di
      // any/all/filter/map/sum/count.
      if (this.peekAt(1).kind === 'op' && this.peekAt(1).text === '->') {
        if (!this.lambdaOk) {
          this.err('a function "x -> …" can only be the second argument of any, all, filter, map, sum or count')
        }
        if (KEYWORDS.has(lower)) this.err(`"${t.text}" is a keyword and cannot be a parameter name`)
        this.next(); this.next()
        this.lambdaScope.push(t.text)
        this.lambdaOk = false
        try {
          return lambdaNode(t.text, this.parseExpr(0))
        } finally {
          this.lambdaScope.pop()
        }
      }

      // P389: parametro di una funzione `x -> …` (anche x.campo.sotto)
      if (this.lambdaScope.includes(t.text)) {
        this.next()
        let n: ExprNode = lambdaArg(t.text)
        while (this.at('dot')) {
          this.next()
          const f = this.expect('ident', 'expected a field name after "."')
          n = { kind: 'FunctionCall', name: 'get', args: [n, { kind: 'Literal', value: f.text }] }
        }
        return n
      }

      if (lower === 'true')  { this.next(); return { kind: 'Literal', value: true } }
      if (lower === 'false') { this.next(); return { kind: 'Literal', value: false } }
      if (lower === 'null')  { this.next(); return { kind: 'Literal', value: null } }
      if (lower === 'case')  return this.parseCaseWhen()
      if (lower === 'cast')  return this.parseCast()

      this.next()

      // Chiamata di funzione: nome(...)
      if (this.at('lparen')) {
        this.next()
        const args: ExprNode[] = []
        const conLambda = LAMBDA_FNS.has(canonicalName(lower) ?? '') && !this.opts.userFunctions?.has(lower)
        if (!this.at('rparen')) {
          args.push(this.parseItem())
          while (this.at('comma')) {
            this.next()
            args.push(this.parseItem(conLambda && args.length === 1))
          }
        }
        this.expect('rparen', `expected ")" at the end of ${t.text}(...)`)
        if (conLambda) {
          const canon = canonicalName(lower)!
          if (LAMBDA_REQUIRED.has(canon) && !(args[1] && isLambda(args[1]))) {
            throw new ExprParseError(
              `${canon} needs a function as second argument — e.g. ${canon}(list, x -> ${canon === 'map' ? 'x * 2' : 'x > 0'})`,
              t.pos, this.src)
          }
          if (args[1] && !isLambda(args[1])) {
            throw new ExprParseError(
              `the second argument of ${canon} must be a function "x -> …" — e.g. ${canon}(list, x -> x > 0)`,
              t.pos, this.src)
          }
        }

        // Validazione a design-time: nome esistente e arità corretta.
        // Il motore tollera argomenti mancanti (li tratta come null), quindi
        // se non validiamo qui l'errore passa silenzioso fino al dato.
        // Funzione UTENTE in scope: nome già noto, valido solo l'arità; resta
        // una FunctionCall col nome nudo, l'espansione la inlina dopo.
        const userArity = this.opts.userFunctions?.get(lower)
        if (userArity !== undefined) {
          if (args.length !== userArity) {
            throw new ExprParseError(
              `${lower} requires ${userArity} argument${userArity === 1 ? '' : 's'} (received ${args.length})`,
              t.pos, this.src,
            )
          }
          return { kind: 'FunctionCall', name: lower, args }
        }

        const problem = validateCall(lower, args.length)
        if (problem) throw new ExprParseError(problem, t.pos, this.src)

        const canon = canonicalName(lower)!   // validateCall garantisce che esista
        // coalesce ha un nodo IR dedicato
        if (canon === 'coalesce') return { kind: 'Coalesce', args }
        return { kind: 'FunctionCall', name: canon, args }
      }

      // Riferimento a campo, eventualmente qualificato: Input.campo
      if (this.at('dot')) {
        this.next()
        const f = this.expect('ident', 'expected a field name after "."')
        return this.qualifiedField(t.text, f.text, t.pos)
      }

      if (KEYWORDS.has(lower)) this.err(`unexpected keyword: "${t.text}"`)
      return { kind: 'DirectFieldRef', field: t.text }
    }

    this.err(`expected an expression, found "${t.text || 'end'}"`)
  }

  /** "Nome Con Spazi".campo  →  FieldRef ; altrimenti è un letterale stringa. */
  private maybeQualifiedField(strValue: string, pos: number): ExprNode {
    if (this.at('dot')) {
      this.next()
      const f = this.expect('ident', 'expected a field name after "."')
      return this.qualifiedField(strValue, f.text, pos)
    }
    return { kind: 'Literal', value: strValue }
  }

  private qualifiedField(label: string, field: string, pos: number): ExprNode {
    const map = this.opts.labelToInputId
    if (map) {
      const inputId = map.get(label)
      if (inputId) return { kind: 'FieldRef', input: inputId, field }
      throw new ExprParseError(`unknown input: "${label}"`, pos, this.src)
    }
    // Nessuna mappa (nodo a input singolo): il qualificatore non ha senso.
    throw new ExprParseError(`qualified reference "${label}.${field}" not allowed here`, pos, this.src)
  }

  /** Un elemento di una lista di argomenti; `lambda` = ammessa `x -> …`. */
  private parseItem(lambda = false): ExprNode {
    const prima = this.lambdaOk
    this.lambdaOk = lambda
    try { return this.parseExpr(0) } finally { this.lambdaOk = prima }
  }

  /** P389: `x in (a, b, c)` → x == a || x == b || …; `x in elenco` → contains(elenco, x) */
  private parseIn(left: ExprNode): ExprNode {
    if (this.at('lparen')) {
      this.next()
      const vals: ExprNode[] = []
      if (!this.at('rparen')) {
        vals.push(this.parseItem())
        while (this.at('comma')) { this.next(); vals.push(this.parseItem()) }
      }
      this.expect('rparen', 'expected ")" at the end of the "in" list')
      if (vals.length === 0) return { kind: 'Literal', value: false }
      return vals
        .map((v): ExprNode => ({ kind: 'BinaryOp', op: 'EQ', left, right: v }))
        .reduce((a, b) => ({ kind: 'BinaryOp', op: 'OR', left: a, right: b }))
    }
    const elenco = this.parseExpr(PREC_CONFRONTO + 1)
    return { kind: 'FunctionCall', name: 'contains', args: [elenco, left] }
  }

  /** P389: `x between a and b` → x >= a && x <= b */
  private parseBetween(left: ExprNode): ExprNode {
    const lo = this.parseExpr(PREC_CONFRONTO + 1)
    if (!this.atKeyword('and')) this.err('expected "and" in "between … and …"')
    this.next()
    const hi = this.parseExpr(PREC_CONFRONTO + 1)
    return {
      kind: 'BinaryOp', op: 'AND',
      left:  { kind: 'BinaryOp', op: 'GTE', left, right: lo },
      right: { kind: 'BinaryOp', op: 'LTE', left, right: hi },
    }
  }

  /** P389: f"Ordine {id} di {cliente}" → concat("Ordine ", id, " di ", cliente).
   *  `{{` e `}}` sono le graffe stesse; dentro le graffe c'è un'espressione. */
  private parseFString(t: Token): ExprNode {
    const raw = t.str ?? ''
    const base = t.contentPos ?? t.pos
    const delim = t.text[1] ?? '"'
    const parti: ExprNode[] = []
    let testo = ''
    const chiudiTesto = () => { if (testo) { parti.push({ kind: 'Literal', value: testo }); testo = '' } }
    let i = 0
    while (i < raw.length) {
      const c = raw[i]
      if (c === '\\' && i + 1 < raw.length) {
        const e = raw[i + 1]
        testo += e === 'n' ? '\n' : e === 't' ? '\t' : e
        i += 2; continue
      }
      if (c === '{' && raw[i + 1] === '{') { testo += '{'; i += 2; continue }
      if (c === '}' && raw[i + 1] === '}') { testo += '}'; i += 2; continue }
      if (c === '}') throw new ExprParseError('unmatched "}" in f-string (write "}}" for a brace)', base + i, this.src)
      if (c === '{') {
        // fine del segnaposto: la graffa che chiude, saltando stringhe e graffe annidate
        // Le virgolette del testo esterno, scritte \" dentro il segnaposto,
        // sono virgolette dell'espressione: f"{replace(x, \"}\", \"\")}".
        let j = i + 1, prof = 0, quote = ''
        for (; j < raw.length; j++) {
          let d = raw[j]
          if (d === '\\' && raw[j + 1] === delim) { d = delim; j++ }
          else if (quote && d === '\\') { j++; continue }
          if (quote) { if (d === quote) quote = ''; continue }
          if (d === '"' || d === "'") { quote = d; continue }
          if (d === '{') prof++
          else if (d === '}') { if (prof === 0) break; prof-- }
        }
        if (j >= raw.length) throw new ExprParseError('unterminated "{" in f-string', base + i, this.src)
        const dentro = raw.slice(i + 1, j).split('\\' + delim).join(delim)
        if (!dentro.trim()) throw new ExprParseError('empty "{}" in f-string', base + i, this.src)
        chiudiTesto()
        try {
          const sub = new Parser(dentro, this.opts)
          sub.lambdaScope = [...this.lambdaScope]
          const e = sub.parseExpr(0)
          sub.expect('eof', 'incomplete expression')
          parti.push(e)
        } catch (err) {
          if (err instanceof ExprParseError) throw new ExprParseError(err.message, base + i + 1 + err.pos, this.src)
          throw err
        }
        i = j + 1; continue
      }
      testo += c; i++
    }
    chiudiTesto()
    if (parti.length === 0) return { kind: 'Literal', value: '' }
    if (parti.length === 1 && parti[0].kind === 'Literal') return parti[0]
    return { kind: 'FunctionCall', name: 'concat', args: parti }
  }

  /** case when c1 then v1 [when c2 then v2 …] [else d] end */
  private parseCaseWhen(): ExprNode {
    this.next() // 'case'
    const branches: Array<{ condition: ExprNode; value: ExprNode }> = []
    let def: ExprNode | null = null

    while (this.atKeyword('when')) {
      this.next()
      const condition = this.parseExpr(0)
      if (!this.atKeyword('then')) this.err('expected "then"')
      this.next()
      const value = this.parseExpr(0)
      branches.push({ condition, value })
    }
    if (branches.length === 0) this.err('"case" needs at least one "when"')

    if (this.atKeyword('else')) { this.next(); def = this.parseExpr(0) }
    if (!this.atKeyword('end')) this.err('expected "end" to close "case"')
    this.next()

    return { kind: 'CaseWhen', branches, default: def }
  }

  /** cast(expr as tipo) */
  private parseCast(): ExprNode {
    this.next() // 'cast'
    this.expect('lparen', 'expected "(" after cast')
    const expr = this.parseExpr(0)
    if (!this.atKeyword('as')) this.err('expected "as" in cast(x as type)')
    this.next()
    const t = this.expect('ident', 'expected a type after "as"')
    const target = CAST_TYPES[t.text.toLowerCase()]
    if (!target) this.err(`unknown cast type: "${t.text}"`)
    this.expect('rparen', 'expected ")" at the end of cast')
    return { kind: 'Cast', expr, target_type: target }
  }
}