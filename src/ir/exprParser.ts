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
  | 'num' | 'str' | 'ident' | 'op' | 'lparen' | 'rparen' | 'comma' | 'dot' | 'eof'

interface Token {
  kind: TokKind
  text: string
  pos:  number
  /** per 'num' */ num?: number
  /** per 'str' */ str?: string
  /** per 'ident': era racchiuso in backtick → mai una parola chiave */
  quoted?: boolean
}

/** Operatori multi-carattere, ordinati per lunghezza decrescente. */
const OPERATORS = ['==', '!=', '>=', '<=', '&&', '||', '+', '-', '*', '/', '%', '>', '<', '!', '?', ':']

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
      if (i >= src.length) throw new ExprParseError('identificatore non chiuso: manca `', start, src)
      i++
      if (!name) throw new ExprParseError('identificatore vuoto: ``', start, src)
      toks.push({ kind: 'ident', text: name, pos: start, quoted: true })
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
      if (i >= src.length) throw new ExprParseError('stringa non chiusa', start, src)
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
      if (isNaN(n)) throw new ExprParseError(`numero non valido: "${raw}"`, start, src)
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
    if (c === ',') { toks.push({ kind: 'comma',  text: ',', pos: i }); i++; continue }
    if (c === '.') { toks.push({ kind: 'dot',    text: '.', pos: i }); i++; continue }

    const op = OPERATORS.find(o => src.startsWith(o, i))
    if (op) { toks.push({ kind: 'op', text: op, pos: i }); i += op.length; continue }

    throw new ExprParseError(`carattere non riconosciuto: "${c}"`, i, src)
  }

  toks.push({ kind: 'eof', text: '', pos: src.length })
  return toks
}

// ─── Precedenza (dalla più bassa alla più alta) ─────────────────────

const PREC: Record<string, number> = {
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

const KEYWORDS = new Set([
  'true', 'false', 'null', 'and', 'or', 'is', 'not',
  'case', 'when', 'then', 'else', 'end', 'cast', 'as',
])

// ─── Parser (Pratt / precedence climbing) ───────────────────────────

export interface ParseOptions {
  /** Etichette input note (tmap multi-input): "DB Source".campo → FieldRef */
  labelToInputId?: Map<string, string>
}

export function parseExpression(src: string, opts: ParseOptions = {}): ExprNode {
  const p = new Parser(src, opts)
  const node = p.parseExpr(0)
  p.expect('eof', 'espressione incompleta')
  return node
}

class Parser {
  private toks: Token[]
  private i = 0
  private src: string
  private opts: ParseOptions

  constructor(src: string, opts: ParseOptions) {
    this.src = src
    this.opts = opts
    this.toks = tokenize(src)
  }

  private peek(): Token { return this.toks[this.i] }
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
      throw new ExprParseError(`${msg} (trovato "${this.peek().text || 'fine'}")`, this.peek().pos, this.src)
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
        if (!this.atKeyword('null')) this.err('atteso "null" dopo "is"')
        this.next()
        left = negated ? { kind: 'IsNotNull', expr: left } : { kind: 'IsNull', expr: left }
        continue
      }

      // Ternario: cond ? a : b   → iif(cond, a, b)
      if (this.at('op', '?') && minPrec === 0) {
        this.next()
        const thenE = this.parseExpr(0)
        if (!this.at('op', ':')) this.err('atteso ":" nel ternario')
        this.next()
        const elseE = this.parseExpr(0)
        left = { kind: 'FunctionCall', name: 'iif', args: [left, thenE, elseE] }
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
      const irOp = OP_TO_IR[opText]
      if (!irOp) this.err(`operatore non supportato: "${opText}"`)
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
    if (t.kind === 'str') { this.next(); return this.maybeQualifiedField(t.str!, t.pos) }

    if (t.kind === 'lparen') {
      this.next()
      const e = this.parseExpr(0)
      this.expect('rparen', 'atteso ")"')
      return e
    }

    if (t.kind === 'ident') {
      // Identificatore quotato: sempre un campo, mai parola chiave o funzione.
      if (t.quoted) {
        this.next()
        if (this.at('dot')) {
          this.next()
          const f = this.expect('ident', 'atteso nome campo dopo "."')
          return this.qualifiedField(t.text, f.text, t.pos)
        }
        return { kind: 'DirectFieldRef', field: t.text }
      }

      const lower = t.text.toLowerCase()

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
        if (!this.at('rparen')) {
          args.push(this.parseExpr(0))
          while (this.at('comma')) { this.next(); args.push(this.parseExpr(0)) }
        }
        this.expect('rparen', `atteso ")" alla fine di ${t.text}(...)`)

        // Validazione a design-time: nome esistente e arità corretta.
        // Il motore tollera argomenti mancanti (li tratta come null), quindi
        // se non validiamo qui l'errore passa silenzioso fino al dato.
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
        const f = this.expect('ident', 'atteso nome campo dopo "."')
        return this.qualifiedField(t.text, f.text, t.pos)
      }

      if (KEYWORDS.has(lower)) this.err(`parola chiave inattesa: "${t.text}"`)
      return { kind: 'DirectFieldRef', field: t.text }
    }

    this.err(`espressione attesa, trovato "${t.text || 'fine'}"`)
  }

  /** "Nome Con Spazi".campo  →  FieldRef ; altrimenti è un letterale stringa. */
  private maybeQualifiedField(strValue: string, pos: number): ExprNode {
    if (this.at('dot')) {
      this.next()
      const f = this.expect('ident', 'atteso nome campo dopo "."')
      return this.qualifiedField(strValue, f.text, pos)
    }
    return { kind: 'Literal', value: strValue }
  }

  private qualifiedField(label: string, field: string, pos: number): ExprNode {
    const map = this.opts.labelToInputId
    if (map) {
      const inputId = map.get(label)
      if (inputId) return { kind: 'FieldRef', input: inputId, field }
      throw new ExprParseError(`input sconosciuto: "${label}"`, pos, this.src)
    }
    // Nessuna mappa (nodo a input singolo): il qualificatore non ha senso.
    throw new ExprParseError(`riferimento qualificato "${label}.${field}" non ammesso qui`, pos, this.src)
  }

  /** case when c1 then v1 [when c2 then v2 …] [else d] end */
  private parseCaseWhen(): ExprNode {
    this.next() // 'case'
    const branches: Array<{ condition: ExprNode; value: ExprNode }> = []
    let def: ExprNode | null = null

    while (this.atKeyword('when')) {
      this.next()
      const condition = this.parseExpr(0)
      if (!this.atKeyword('then')) this.err('atteso "then"')
      this.next()
      const value = this.parseExpr(0)
      branches.push({ condition, value })
    }
    if (branches.length === 0) this.err('"case" richiede almeno un "when"')

    if (this.atKeyword('else')) { this.next(); def = this.parseExpr(0) }
    if (!this.atKeyword('end')) this.err('atteso "end" per chiudere "case"')
    this.next()

    return { kind: 'CaseWhen', branches, default: def }
  }

  /** cast(expr as tipo) */
  private parseCast(): ExprNode {
    this.next() // 'cast'
    this.expect('lparen', 'atteso "(" dopo cast')
    const expr = this.parseExpr(0)
    if (!this.atKeyword('as')) this.err('atteso "as" in cast(x as tipo)')
    this.next()
    const t = this.expect('ident', 'atteso tipo dopo "as"')
    const target = CAST_TYPES[t.text.toLowerCase()]
    if (!target) this.err(`tipo di cast sconosciuto: "${t.text}"`)
    this.expect('rparen', 'atteso ")" alla fine di cast')
    return { kind: 'Cast', expr, target_type: target }
  }
}