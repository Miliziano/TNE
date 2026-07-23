/**
 * src/ir/scriptParser.ts
 *
 * Parser del linguaggio di ISTRUZIONI del nodo Script.
 * Disegno completo: `src-tauri/docs/design-nodo-script.md`.
 *
 * Le ESPRESSIONI non le tocca: le delega a `parseExpression` (FPEL), lo
 * stesso parser usato da filter, transform, data quality e tmap. Qui si
 * aggiunge solo ciò che un'espressione non può esprimere — assegnare,
 * ramificare, e decidere che una riga non deve uscire.
 *
 * Come per FPEL, il parser vive SOLO nello studio: il motore riceve l'IR
 * già compilato e non conosce questa sintassi. È la stessa divisione di
 * `queryParams.ts` (P28) e per lo stesso motivo — il codegen traduce
 * l'IR, mai il testo.
 */

import { parseExpression, ExprParseError, type ExprNode } from './exprParser'

// ─── IR ─────────────────────────────────────────────────────────────
// Rispecchia `enum ScriptStmt` in src-tauri/src/engine/nodes/script.rs.
// Il discriminante è `kind` (serde `tag = "kind"`).

export type ScriptStmt =
  | { kind: 'Let';    name:  string; expr: ExprNode }
  | { kind: 'Assign'; field: string; expr: ExprNode }
  | { kind: 'If';     cond:  ExprNode; then: ScriptStmt[]; else: ScriptStmt[] }
  | { kind: 'Skip' }
  | { kind: 'Reject'; reason: ExprNode | null }
  | { kind: 'Log';    expr: ExprNode; level: 'info' }
  | { kind: 'Error';  expr: ExprNode }

/** Nome dell'input sintetico sotto cui il motore registra i locali. */
export const LOCAL_INPUT = '__local'

export class ScriptParseError extends Error {
  // Campo dichiarato ed assegnato a mano: il progetto compila con
  // `erasableSyntaxOnly`, che vieta le parameter property (emettono
  // codice). Stessa forma di ExprParseError.
  readonly line: number

  constructor(message: string, line: number) {
    super(message)
    this.name = 'ScriptParseError'
    this.line = line
  }
  pretty(): string {
    return `riga ${this.line}: ${this.message}`
  }
}

// ─── Fase 1: righe logiche ──────────────────────────────────────────
// Toglie i commenti `//` e le righe vuote, conservando il NUMERO DI RIGA
// originale — senza, ogni errore andrebbe cercato a mano.
//
// Lo scanner è consapevole delle stringhe: `log "http://x"` non è un
// commento, e `reject "manca }"` non chiude un blocco. È l'unica parte
// che deve guardare i caratteri uno a uno; il resto lavora su righe.

interface Riga { text: string; n: number }

function righeLogiche(src: string): Riga[] {
  const out: Riga[] = []
  let buf  = ''
  let riga = 1
  let apice: '"' | "'" | null = null

  const chiudi = () => {
    const t = buf.trim()
    if (t) out.push({ text: t, n: riga })
    buf = ''
  }

  for (let i = 0; i < src.length; i++) {
    const c = src[i]

    if (apice) {
      buf += c
      // Escape: il carattere seguente fa parte della stringa qualunque sia.
      if (c === '\\' && i + 1 < src.length) { buf += src[++i]; continue }
      if (c === apice) apice = null
      continue
    }

    if (c === '"' || c === "'") { apice = c; buf += c; continue }

    if (c === '/' && src[i + 1] === '/') {
      while (i < src.length && src[i] !== '\n') i++
      i--                     // il '\n' lo tratta il giro successivo
      continue
    }

    if (c === '\n') { chiudi(); riga++; continue }

    // Le graffe spezzano la riga LOGICA: `{` la chiude restando attaccata,
    // `}` diventa una riga per sé. Così `if z { b = 1 }` scritto su una
    // riga sola e lo stesso `if` scritto su quattro righe arrivano al
    // parser nella stessa forma, e il parser non deve saperne niente.
    if (c === '{') { buf += c; chiudi(); continue }
    if (c === '}') { chiudi(); buf = '}'; chiudi(); continue }

    buf += c
  }
  chiudi()
  return out
}

// ─── Fase 2: risoluzione dei nomi ───────────────────────────────────
// Un identificatore nudo, per FPEL, è un campo della riga
// (`DirectFieldRef`). Se però è stato dichiarato da un `let`, deve
// essere quel locale — e deve COPRIRE un eventuale campo omonimo.
//
// 🔑 La riscrittura avviene QUI, dove i `let` in vista sono noti, e
// produce un `FieldRef` verso un input sintetico. Così l'IR delle
// espressioni non guadagna varianti e `expr.rs` non si tocca: al motore
// basta registrare i locali sotto quel nome di input.
//
// Non basterebbe affidarsi all'ordine di ricerca del motore: `eval`
// consulta la riga PRIMA degli altri input, quindi un campo omonimo
// vincerebbe sul locale — l'opposto di quel che serve.

function risolviLocali(node: ExprNode, locali: Set<string>): ExprNode {
  switch (node.kind) {
    case 'DirectFieldRef':
      return locali.has(node.field)
        ? { kind: 'FieldRef', input: LOCAL_INPUT, field: node.field }
        : node

    case 'BinaryOp':
      return { ...node,
               left:  risolviLocali(node.left,  locali),
               right: risolviLocali(node.right, locali) }

    case 'UnaryOp':
    case 'IsNull':
    case 'IsNotNull':
      return { ...node, expr: risolviLocali(node.expr, locali) }

    case 'Cast':
      return { ...node, expr: risolviLocali(node.expr, locali) }

    case 'FunctionCall':
      return { ...node, args: node.args.map((a) => risolviLocali(a, locali)) }

    case 'Coalesce':
      return { ...node, args: node.args.map((a) => risolviLocali(a, locali)) }

    case 'CaseWhen':
      return { ...node,
               branches: node.branches.map((b) => ({
                 condition: risolviLocali(b.condition, locali),
                 value:     risolviLocali(b.value,     locali),
               })),
               default: node.default ? risolviLocali(node.default, locali) : null }

    // Literal e FieldRef non contengono identificatori da risolvere.
    default:
      return node
  }
}

// ─── Fase 3: istruzioni ─────────────────────────────────────────────

const RE_LET    = /^let\s+([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.+)$/
// `=(?!=)` per non scambiare `a == b` per un'assegnazione.
const RE_ASSIGN = /^([A-Za-z_][A-Za-z0-9_]*)\s*=(?!=)\s*(.+)$/
const RE_IF     = /^if\s+(.+?)\s*\{$/
const RE_ELSEIF = /^else\s+if\s+(.+?)\s*\{$/
const RE_ELSE   = /^else\s*\{$/
const RE_CHIUSA = /^\}$/

/** Parola riservata usata come nome di campo o locale → errore chiaro. */
const RISERVATE = new Set(['let', 'if', 'else', 'skip', 'reject', 'log', 'error'])

interface Cursore { i: number }

function espr(src: string, riga: number, locali: Set<string>): ExprNode {
  let node: ExprNode
  try {
    node = parseExpression(src)
  } catch (e) {
    const dettaglio = e instanceof ExprParseError ? e.pretty() : String(e)
    throw new ScriptParseError(dettaglio, riga)
  }
  return risolviLocali(node, locali)
}

/**
 * Legge le istruzioni fino alla graffa di chiusura del blocco corrente
 * (o alla fine, al livello più esterno).
 *
 * `locali` è una COPIA per ogni blocco: un `let` dentro un `if` vale
 * dentro quell'`if`. Fuori, quel nome torna a essere un campo della
 * riga — con la conseguenza, dichiarata nel disegno, che si legge
 * `null` invece del valore. È il prezzo della regola "identificatore
 * nudo = campo", che è quella che rende leggibile tutto il resto.
 */
function blocco(righe: Riga[], cur: Cursore, locali: Set<string>, annidato: boolean): ScriptStmt[] {
  const out: ScriptStmt[] = []

  while (cur.i < righe.length) {
    const { text, n } = righe[cur.i]

    // Fine del blocco: a consumare la `}` è il chiamante, che deve
    // ancora guardare se segue un `else`.
    if (RE_CHIUSA.test(text)) {
      if (!annidato) {
        throw new ScriptParseError('"}" senza un "if" da chiudere', n)
      }
      return out
    }
    if (RE_ELSE.test(text) || RE_ELSEIF.test(text)) {
      throw new ScriptParseError('"else" senza un "if" a cui riferirsi', n)
    }

    cur.i++

    // ── if … { ──────────────────────────────────────────────────
    const mIf = text.match(RE_IF)
    if (mIf) {
      out.push(leggiIf(righe, cur, locali, mIf[1], n))
      continue
    }

    // Un `if` senza graffa è l'errore di battitura più probabile:
    // vale la pena riconoscerlo e dirlo, invece di lasciarlo cadere
    // nell'assegnazione e produrre un errore incomprensibile.
    if (/^if\b/.test(text)) {
      throw new ScriptParseError('a un "if" deve seguire la condizione e "{" a fine riga', n)
    }
    if (/^else\b/.test(text)) {
      throw new ScriptParseError('a un "else" deve seguire "{" (o "if … {")', n)
    }

    // ── skip ────────────────────────────────────────────────────
    if (text === 'skip') { out.push({ kind: 'Skip' }); continue }

    // ── reject [motivo] ─────────────────────────────────────────
    if (text === 'reject') { out.push({ kind: 'Reject', reason: null }); continue }
    if (/^reject\s+/.test(text)) {
      out.push({ kind: 'Reject', reason: espr(text.slice(7).trim(), n, locali) })
      continue
    }

    // ── log <expr> ──────────────────────────────────────────────
    if (/^log\s+/.test(text)) {
      out.push({ kind: 'Log', expr: espr(text.slice(4).trim(), n, locali), level: 'info' })
      continue
    }

    // ── error <expr> ────────────────────────────────────────────
    if (/^error\s+/.test(text)) {
      out.push({ kind: 'Error', expr: espr(text.slice(6).trim(), n, locali) })
      continue
    }

    // ── let nome = <expr> ───────────────────────────────────────
    const mLet = text.match(RE_LET)
    if (mLet) {
      const nome = mLet[1]
      if (RISERVATE.has(nome)) {
        throw new ScriptParseError(`"${nome}" è una parola riservata e non può essere un nome`, n)
      }
      if (locali.has(nome)) {
        throw new ScriptParseError(`"${nome}" è già dichiarato: scegli un altro nome`, n)
      }
      // L'espressione si risolve PRIMA di dichiarare il nome, così
      // `let x = x + 1` legge il campo `x` e non se stesso.
      const expr = espr(mLet[2], n, locali)
      locali.add(nome)
      out.push({ kind: 'Let', name: nome, expr })
      continue
    }

    // ── campo = <expr> ──────────────────────────────────────────
    const mAss = text.match(RE_ASSIGN)
    if (mAss) {
      if (RISERVATE.has(mAss[1])) {
        throw new ScriptParseError(`"${mAss[1]}" è una parola riservata e non può essere un nome di campo`, n)
      }
      out.push({ kind: 'Assign', field: mAss[1], expr: espr(mAss[2], n, locali) })
      continue
    }

    throw new ScriptParseError(
      `istruzione non riconosciuta. Attese: assegnazione "campo = ...", "let", "if", ` +
      `"skip", "reject", "log", "error"`, n)
  }

  if (annidato) {
    throw new ScriptParseError('manca la "}" che chiude un "if"', righe[righe.length - 1]?.n ?? 1)
  }
  return out
}

function leggiIf(righe: Riga[], cur: Cursore, locali: Set<string>,
                 condSrc: string, rigaIf: number): ScriptStmt {
  const cond = espr(condSrc, rigaIf, locali)
  const rami = blocco(righe, cur, new Set(locali), true)

  if (cur.i >= righe.length || !RE_CHIUSA.test(righe[cur.i].text)) {
    throw new ScriptParseError('manca la "}" che chiude questo "if"', rigaIf)
  }
  cur.i++   // consuma la `}`

  // Segue un `else`? Va guardato DOPO aver consumato la graffa, perché
  // lo scanner le tiene separate.
  if (cur.i < righe.length) {
    const { text, n } = righe[cur.i]

    // else if … {  →  zucchero per  else { if … { … } }
    const mElseIf = text.match(RE_ELSEIF)
    if (mElseIf) {
      cur.i++
      return { kind: 'If', cond, then: rami, else: [leggiIf(righe, cur, locali, mElseIf[1], n)] }
    }

    if (RE_ELSE.test(text)) {
      cur.i++
      const altri = blocco(righe, cur, new Set(locali), true)
      if (cur.i >= righe.length || !RE_CHIUSA.test(righe[cur.i].text)) {
        throw new ScriptParseError('manca la "}" che chiude l\'"else"', n)
      }
      cur.i++
      return { kind: 'If', cond, then: rami, else: altri }
    }
  }

  return { kind: 'If', cond, then: rami, else: [] }
}

// ─── Ingresso ───────────────────────────────────────────────────────

/**
 * Compila il corpo di uno Script nell'IR che il motore esegue.
 * Lancia `ScriptParseError` col numero di riga al primo errore.
 */
export function parseScript(src: string): ScriptStmt[] {
  const righe = righeLogiche(src ?? '')
  const cur: Cursore = { i: 0 }
  const stmts = blocco(righe, cur, new Set<string>(), false)
  if (cur.i < righe.length) {
    throw new ScriptParseError('"}" senza un "if" da chiudere', righe[cur.i].n)
  }
  return stmts
}

/**
 * I campi che lo Script scrive nella riga in uscita, `if` annidati
 * inclusi. Lo schema di uscita è "schema d'ingresso + questi".
 *
 * È il guadagno che la versione JavaScript non poteva dare: un corpo
 * arbitrario può restituire qualunque forma, quindi lo studio non
 * sapeva cosa esce da uno Script e non poteva propagare lo schema a
 * valle. Un elenco di assegnazioni, invece, si legge.
 *
 * Un campo assegnato in un solo ramo esiste comunque nello schema (vale
 * `null` quando quel ramo non passa) — stessa convenzione di un
 * `CASE WHEN` senza `ELSE`.
 */
export function campiAssegnati(stmts: ScriptStmt[]): string[] {
  const visti: string[] = []
  const visita = (lista: ScriptStmt[]) => {
    for (const s of lista) {
      if (s.kind === 'Assign') { if (!visti.includes(s.field)) visti.push(s.field) }
      else if (s.kind === 'If') { visita(s.then); visita(s.else) }
    }
  }
  visita(stmts)
  return visti
}
