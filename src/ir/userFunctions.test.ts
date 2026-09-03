import { parseExpression, type ExprNode } from './exprParser'
import { parseUserFunctions, expandUserFunctions, originOf } from './userFunctions'

let pass = 0, fail = 0
const ok  = (cond: boolean, desc: string) => { if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}`) } }

// Helpers ------------------------------------------------------------
function build(defs: string[]) {
  const { functions, errors } = parseUserFunctions(defs)
  const map = new Map(functions.map((f) => [f.name, f]))
  const arity = new Map(functions.map((f) => [f.name, f.params.length]))
  return { functions, errors, map, arity }
}
function expand(call: string, defs: string[]): ExprNode {
  const { map, arity } = build(defs)
  const ast = parseExpression(call, { userFunctions: arity })
  return expandUserFunctions(ast, map)
}
/** Raccoglie i nomi di FunctionCall ancora presenti nell'albero. */
function callNames(n: ExprNode, out: string[] = []): string[] {
  const any = n as any
  if (n.kind === 'FunctionCall') { out.push(n.name); n.args.forEach((a) => callNames(a, out)) }
  else if (n.kind === 'Coalesce') any.args.forEach((a: ExprNode) => callNames(a, out))
  else if (n.kind === 'BinaryOp') { callNames(any.left, out); callNames(any.right, out) }
  else if (['UnaryOp', 'IsNull', 'IsNotNull', 'Cast'].includes(n.kind)) callNames(any.expr, out)
  else if (n.kind === 'CaseWhen') { any.branches.forEach((b: any) => { callNames(b.condition, out); callNames(b.value, out) }); if (any.default) callNames(any.default, out) }
  return out
}
/** Tutti i valori Literal nell'albero. */
function literals(n: ExprNode, out: any[] = []): any[] {
  const any = n as any
  if (n.kind === 'Literal') out.push((n as any).value)
  else if (n.kind === 'FunctionCall' || n.kind === 'Coalesce') any.args.forEach((a: ExprNode) => literals(a, out))
  else if (n.kind === 'BinaryOp') { literals(any.left, out); literals(any.right, out) }
  else if (['UnaryOp', 'IsNull', 'IsNotNull', 'Cast'].includes(n.kind)) literals(any.expr, out)
  else if (n.kind === 'CaseWhen') { any.branches.forEach((b: any) => { literals(b.condition, out); literals(b.value, out) }); if (any.default) literals(any.default, out) }
  return out
}

const IVA = ['funzione iva(imponibile, aliquota) { ritorna imponibile * aliquota / 100 }']

console.log('\n--- espansione base ---')
{
  const t = expand('iva(100, 22)', IVA)
  ok(!callNames(t).includes('iva'), 'nessuna chiamata a iva resta dopo l\'espansione')
  const lits = literals(t)
  ok(lits.includes(100) && lits.includes(22), 'gli argomenti 100 e 22 sono stati sostituiti nel corpo')
}

console.log('\n--- sostituzione con campi come argomenti ---')
{
  const t = expand('iva(prezzo, 22)', IVA)
  const names: string[] = []
  const collect = (n: any): void => {
    if (n.kind === 'DirectFieldRef') names.push(n.field)
    else if (n.kind === 'BinaryOp') { collect(n.left); collect(n.right) }
    else if (n.args) n.args.forEach(collect)
  }
  collect(t)
  ok(names.includes('prezzo'), 'il campo "prezzo" appare al posto del parametro imponibile')
  ok(!names.includes('imponibile') && !names.includes('aliquota'), 'i nomi dei parametri NON restano nell\'albero')
}

console.log('\n--- funzioni predefinite nel corpo passano invariate ---')
{
  const defs = ['funzione pulisci(s) { ritorna trim(upper(s)) }']
  const t = expand('pulisci(nome)', defs)
  ok(callNames(t).includes('trim') && callNames(t).includes('upper'), 'trim/upper restano come chiamate built-in')
  ok(!callNames(t).includes('pulisci'), 'pulisci è stata inlinata')
}

console.log('\n--- annidamento (una funzione chiama un\'altra) ---')
{
  const defs = ['funzione doppio(x) { ritorna x * 2 }', 'funzione quad(x) { ritorna doppio(doppio(x)) }']
  const t = expand('quad(5)', defs)
  ok(callNames(t).length === 0, 'nessuna chiamata a funzioni utente resta (tutto inlinato)')
  ok(literals(t).filter((v) => v === 2).length === 2, 'il *2 compare due volte (doppio annidato)')
}

console.log('\n--- origine (_origin) ---')
{
  const t = expand('iva(100, 22)', IVA)
  ok(originOf(t)?.fn === 'iva', 'la radice inlinata porta origine fn="iva"')
}

console.log('\n--- errori: arità (al parse) ---')
{
  const { arity } = build(IVA)
  let threw = false
  try { parseExpression('iva(100)', { userFunctions: arity }) } catch { threw = true }
  ok(threw, 'iva(100) con 1 argomento invece di 2 dà errore di parse')
}

console.log('\n--- errori: ombreggiamento di una predefinita ---')
{
  const { errors } = build(['funzione upper(x) { ritorna x }'])
  ok(errors.some((e) => /predefinita/.test(e.message)), 'ridefinire "upper" è rifiutato')
}

console.log('\n--- errori: ricorsione ---')
{
  const { errors } = build(['funzione a(x) { ritorna b(x) }', 'funzione b(x) { ritorna a(x) }'])
  ok(errors.some((e) => /ricorsione/.test(e.message)), 'la ricorsione indiretta a→b→a è rifiutata')
}

console.log('\n--- errori: campo libero nel corpo ---')
{
  const { errors } = build(['funzione somma(x) { ritorna x + y }'])
  ok(errors.some((e) => /non sono suoi parametri|solo i parametri/.test(e.message)), '"y" (non parametro) nel corpo è rifiutato')
}

console.log('\n--- errori: definizione malformata ---')
{
  const { errors } = build(['funzione rotta(a b) ritorna a'])
  ok(errors.some((e) => /non valida/.test(e.message)), 'una definizione senza graffe/forma giusta è rifiutata')
}

console.log('\n--- una funzione valida non produce errori ---')
{
  const { functions, errors } = build(IVA)
  ok(errors.length === 0 && functions.length === 1, 'iva parsa pulita, 0 errori')
}

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
if (fail > 0) process.exit(1)
