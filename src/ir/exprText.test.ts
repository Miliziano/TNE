/** Test di exprText (P391): il testo canonico di un albero, riletto dal
 *  parser, dà lo stesso albero. Si prova su tutte le espressioni del contratto
 *  FPEL (vectors/fpel_v1.json) e su qualche caso di precedenza. */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseExpression } from './exprParser'
import { exprToText, exprChildren } from './exprText'

let pass = 0, fail = 0
const giro = (src: string) => {
  try {
    const a = parseExpression(src)
    const t = exprToText(a)
    const b = parseExpression(t)
    if (JSON.stringify(a) === JSON.stringify(b)) { pass++; console.log(`  ok   ${src}  ⇒  ${t}`) }
    else { fail++; console.log(`  FAIL ${src}  ⇒  ${t}  (albero diverso)`) }
  } catch (e) { fail++; console.log(`  FAIL ${src} → ${(e as Error).message}`) }
}

console.log('\n--- precedenza e parentesi ---')
for (const s of ['(a + b) * c', 'a - (b - c)', 'a - b - c', '!(a && b)', '-(a + 1)', 'a || b && c', '(a || b) && c',
                 'x is null || y is not null', 'case when a > 1 then "x" else null end', 'cast(a + 1 as integer)',
                 'a ?? b ?? 0', '(a ?? b) + 1', '`data ordine` + 1', 'upper(f"{a}-{b}")']) giro(s)

console.log('\n--- tutte le espressioni del contratto FPEL ---')
const vettore = JSON.parse(readFileSync(join(process.cwd(), 'vectors', 'fpel_v1.json'), 'utf8'))
for (const c of vettore.casi) if (!c.tables) giro(c.expr)

console.log('\n--- figli nell\'ordine di spiega.rs ---')
const ch = (src: string) => exprChildren(parseExpression(src)).length
const prova = (cond: boolean, d: string) => { if (cond) { pass++; console.log(`  ok   ${d}`) } else { fail++; console.log(`  FAIL ${d}`) } }
prova(ch('a + b') === 2, 'binario: sinistra, destra')
prova(ch('case when a then 1 when b then 2 else 3 end') === 5, 'case: cond, valore, cond, valore, default')
prova(ch('filter(xs, x -> x > 0)') === 2, 'funzione con x -> …: elenco e funzione')
prova(exprChildren((parseExpression('filter(xs, x -> x > 0)') as any).args[1]).length === 0, 'la funzione x -> … non si scompone')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)
