/**
 * src/ir/decodeTables.ts
 *
 * TABELLE DI DECODIFICA (P390) — a livello di progetto, come le funzioni utente.
 *
 * Una tabella è un elenco codice → descrizione ("IT" → "Italia"). In FPEL si
 * usa con `decode("paesi", codice)` o `decode("paesi", codice, "sconosciuto")`.
 *
 * Fatto architetturale (come le funzioni utente): si risolve a COMPILE-TIME.
 * `decode("paesi", x, d)` diventa `decode_map(x, list(k1, v1, k2, v2, …), d)`:
 * la tabella viaggia DENTRO l'espressione, quindi l'artifact resta autonomo e
 * il motore non ha bisogno di un registro di tabelle per run. Il motore
 * compila `decode_map` con una tabella costante in una mappa (ricerca in tempo
 * costante, v. `compiled.rs`).
 *
 * Regole:
 *  - il nome della tabella è un TESTO letterale (non calcolato), cercato senza
 *    distinguere maiuscole e minuscole;
 *  - le chiavi si confrontano come testo (`1` e `"1"` sono la stessa chiave);
 *  - chiave assente o nulla → il terzo argomento, o null;
 *  - i valori sono testo; per un numero si converte: `to_float(decode(…))`.
 */

import { ExprParseError, type ExprNode } from './exprParser'

export interface DecodeTable {
  name:    string
  entries: Array<[string, string]>
}

export interface DecodeTableProblem { table?: string; message: string }

const NOME_VALIDO = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Controlla un insieme di tabelle: nomi validi e unici, chiavi non ripetute. */
export function validateDecodeTables(tables: DecodeTable[]): DecodeTableProblem[] {
  const problemi: DecodeTableProblem[] = []
  const visti = new Set<string>()
  for (const t of tables) {
    if (!NOME_VALIDO.test(t.name)) {
      problemi.push({ table: t.name, message: 'invalid name: letters, digits and _ only, not starting with a digit' })
    }
    const lower = t.name.toLowerCase()
    if (visti.has(lower)) problemi.push({ table: t.name, message: 'another table has the same name' })
    visti.add(lower)
    const chiavi = new Set<string>()
    for (const [k] of t.entries) {
      if (chiavi.has(k)) problemi.push({ table: t.name, message: `key "${k}" appears more than once` })
      chiavi.add(k)
    }
  }
  return problemi
}

/**
 * Testo incollato (da un foglio di calcolo o a mano) → righe chiave/valore.
 * Una riga per voce; chiave e valore separati da TAB (copia da Excel), da `;`
 * o dalla prima `,`. Le righe vuote si saltano.
 */
export function parseEntries(testo: string): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (const riga of testo.split(/\r?\n/)) {
    if (!riga.trim()) continue
    const sep = riga.includes('\t') ? '\t' : riga.includes(';') ? ';' : ','
    const i = riga.indexOf(sep)
    if (i < 0) out.push([riga.trim(), ''])
    else out.push([riga.slice(0, i).trim(), riga.slice(i + 1).trim()])
  }
  return out
}

/** Righe chiave/valore → testo modificabile (TAB fra chiave e valore). */
export function formatEntries(entries: Array<[string, string]>): string {
  return entries.map(([k, v]) => `${k}\t${v}`).join('\n')
}

// ── Registro delle tabelle ATTIVE del progetto ───────────────────
// Come per le funzioni utente: lo store lo tiene allineato al pool, così ogni
// compilazione di espressioni (pannelli, validazione, compilazione del piano)
// vede le stesse tabelle.
let ACTIVE: DecodeTable[] = []
export function setActiveDecodeTables(tables: DecodeTable[]): void { ACTIVE = tables }
export function activeDecodeTables(): DecodeTable[] { return ACTIVE }

/**
 * Sostituisce ogni `decode("nome", chiave [, ripiego])` con
 * `decode_map(chiave, list(k1, v1, …) [, ripiego])`. Errore se il nome non è un
 * testo letterale o la tabella non esiste.
 */
export function expandDecodeTables(ast: ExprNode, tables: DecodeTable[], src: string): ExprNode {
  const perNome = new Map(tables.map((t) => [t.name.toLowerCase(), t]))
  const go = (n: ExprNode): ExprNode => {
    switch (n.kind) {
      case 'FunctionCall': {
        const args = n.args.map(go)
        if (n.name !== 'decode') return { ...n, args }
        const nome = args[0]
        if (nome?.kind !== 'Literal' || typeof nome.value !== 'string') {
          throw new ExprParseError('decode: the first argument must be the name of a decode table, in quotes — e.g. decode("countries", code)', 0, src)
        }
        const t = perNome.get(nome.value.toLowerCase())
        if (!t) {
          const nomi = tables.map((x) => x.name)
          throw new ExprParseError(
            `decode: unknown table "${nome.value}"` + (nomi.length ? ` — the project has: ${nomi.join(', ')}` : ' — the project has no decode tables (toolbar → Tables)'),
            0, src)
        }
        const coppie: ExprNode[] = []
        for (const [k, v] of t.entries) coppie.push({ kind: 'Literal', value: k }, { kind: 'Literal', value: v })
        return {
          kind: 'FunctionCall', name: 'decode_map',
          args: [args[1], { kind: 'FunctionCall', name: 'list', args: coppie }, ...args.slice(2)],
        }
      }
      case 'BinaryOp':  return { ...n, left: go(n.left), right: go(n.right) }
      case 'UnaryOp':   return { ...n, expr: go(n.expr) }
      case 'IsNull': case 'IsNotNull': return { ...n, expr: go(n.expr) }
      case 'Cast':      return { ...n, expr: go(n.expr) }
      case 'Coalesce':  return { ...n, args: n.args.map(go) }
      case 'CaseWhen':  return {
        ...n,
        branches: n.branches.map((b) => ({ condition: go(b.condition), value: go(b.value) })),
        default:  n.default ? go(n.default) : null,
      }
      default:          return n
    }
  }
  return go(ast)
}
