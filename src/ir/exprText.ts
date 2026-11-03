/**
 * src/ir/exprText.ts
 *
 * Albero FPEL (IR) → testo leggibile, e figli di un nodo nello STESSO ordine
 * in cui il motore li restituisce in "spiega questo valore"
 * (src-tauri/src/engine/spiega.rs). Serve allo studio per mettere accanto a
 * ogni pezzo del calcolo il pezzo di espressione corrispondente (P391).
 *
 * Il testo non è l'originale scritto dall'utente (spazi e alias si perdono, e
 * `in`, `between`, `??` sono già diventati gli operatori equivalenti): è la
 * forma canonica dell'albero, che è ciò che il motore esegue davvero.
 */
import type { ExprNode } from './exprParser'

const SIMBOLO: Record<string, string> = {
  ADD: '+', SUB: '-', MUL: '*', DIV: '/', MOD: '%',
  EQ: '==', NE: '!=', LT: '<', LTE: '<=', GT: '>', GTE: '>=',
  AND: '&&', OR: '||', CONCAT: '+',
}
const PREC: Record<string, number> = {
  OR: 1, AND: 2, EQ: 3, NE: 3, LT: 4, LTE: 4, GT: 4, GTE: 4, ADD: 5, SUB: 5, CONCAT: 5, MUL: 6, DIV: 6, MOD: 6,
}

function nome(n: string): string {
  return /^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(n) ? n : '`' + n + '`'
}

function letterale(v: unknown): string {
  if (v === null) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  return String(v)
}

/** Testo di un nodo. `prec` = precedenza del contesto (per le parentesi). */
export function exprToText(n: ExprNode, prec = 0): string {
  switch (n.kind) {
    case 'Literal':        return letterale(n.value)
    case 'DirectFieldRef': return nome(n.field)
    case 'FieldRef':       return n.input === '__local' ? nome(n.field) : `${nome(n.input)}.${nome(n.field)}`
    case 'BinaryOp': {
      const p = PREC[n.op] ?? 0
      const t = `${exprToText(n.left, p)} ${SIMBOLO[n.op] ?? n.op} ${exprToText(n.right, p + 1)}`
      return p < prec ? `(${t})` : t
    }
    case 'UnaryOp':   return n.op === 'NOT' ? `!${exprToText(n.expr, 7)}` : `-${exprToText(n.expr, 7)}`
    case 'IsNull':    return `${exprToText(n.expr, 4)} is null`
    case 'IsNotNull': return `${exprToText(n.expr, 4)} is not null`
    case 'Cast':      return `cast(${exprToText(n.expr)} as ${n.target_type})`
    case 'Coalesce': {
      const t = n.args.map((a) => exprToText(a, 2)).join(' ?? ')
      return prec > 1 ? `(${t})` : t
    }
    case 'CaseWhen':
      return 'case ' + n.branches.map((b) => `when ${exprToText(b.condition)} then ${exprToText(b.value)}`).join(' ')
        + (n.default ? ` else ${exprToText(n.default)}` : '') + ' end'
    case 'FunctionCall': {
      const a = n.args
      const lit = (x: ExprNode | undefined) => (x?.kind === 'Literal' ? String(x.value) : '?')
      if (n.name === 'lambda_arg') return lit(a[0]).replace(/#.*$/, '')
      if (n.name === 'lambda')     return `${lit(a[0]).replace(/#.*$/, '')} -> ${exprToText(a[1])}`
      if (n.name === 'get' && a[0]?.kind === 'FunctionCall' && (a[0].name === 'lambda_arg' || a[0].name === 'get')
          && a[1]?.kind === 'Literal') return `${exprToText(a[0])}.${nome(String(a[1].value))}`
      if (n.name === 'list')       return `[${a.map((x) => exprToText(x)).join(', ')}]`
      if (n.name === 'decode_map') {
        const voci = a[1]?.kind === 'FunctionCall' ? a[1].args.length / 2 : 0
        return `decode(${exprToText(a[0])}, ‹table of ${voci}›${a[2] ? ', ' + exprToText(a[2]) : ''})`
      }
      return `${n.name}(${a.map((x) => exprToText(x)).join(', ')})`
    }
  }
}

/** Figli di un nodo nell'ordine di spiega.rs (stessa posizione = stesso pezzo). */
export function exprChildren(n: ExprNode): ExprNode[] {
  switch (n.kind) {
    case 'BinaryOp':  return [n.left, n.right]
    case 'UnaryOp': case 'Cast': case 'IsNull': case 'IsNotNull': return [n.expr]
    case 'Coalesce':  return n.args
    case 'CaseWhen':  return [...n.branches.flatMap((b) => [b.condition, b.value]), ...(n.default ? [n.default] : [])]
    case 'FunctionCall':
      return n.name === 'lambda' || n.name === 'lambda_arg' ? [] : n.args
    default:          return []
  }
}

/** Un passo della spiegazione restituita dal motore. */
export interface Spiegazione { v: unknown; c: Array<Spiegazione | null> }
