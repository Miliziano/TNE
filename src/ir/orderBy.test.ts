/** ORDER BY su più campi (P398): stessa lettura del motore (ordinamento.rs). */
import { leggiOrderBy, scriviOrderBy } from './orderBy'

let pass = 0, fail = 0
const ok = (cond: boolean, desc: string) => {
  if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}`) }
}
const j = (x: unknown) => JSON.stringify(x)

ok(j(leggiOrderBy('count DESC, region ASC')) === j([{ campo: 'count', desc: true }, { campo: 'region', desc: false }]), 'due campi con direzione')
ok(j(leggiOrderBy('a, b desc', 'desc')) === j([{ campo: 'a', desc: true }, { campo: 'b', desc: true }]), 'direzione predefinita')
ok(j(leggiOrderBy('conteggio dei movimenti desc, `x y`')) === j([{ campo: 'conteggio dei movimenti', desc: true }, { campo: 'x y', desc: false }]), 'nomi con spazi e tra apici')
ok(leggiOrderBy('descrizione, ascissa')[0].campo === 'descrizione', 'desc/asc solo come parola finale')
ok(leggiOrderBy(' , ').length === 0, 'vuoto')
ok(scriviOrderBy([{ campo: 'a', desc: true }, { campo: ' ', desc: false }, { campo: 'b', desc: false }]) === 'a DESC, b ASC', 'scrittura, righe vuote saltate')
ok(j(leggiOrderBy(scriviOrderBy(leggiOrderBy('x desc, y')))) === j(leggiOrderBy('x desc, y')), 'andata e ritorno')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)
