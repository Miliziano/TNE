/** Test delle tabelle di decodifica (P390): lettura del testo incollato,
 *  controlli, traduzione di decode(...) in decode_map(...). */
import { parseEntries, formatEntries, validateDecodeTables, type DecodeTable } from './decodeTables'
import { compileFpel, parseUserFunctions } from './userFunctions'
import { ExprParseError } from './exprParser'

let pass = 0, fail = 0
const ok = (cond: boolean, desc: string) => {
  if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}`) }
}

console.log('\n--- testo incollato ---')
ok(JSON.stringify(parseEntries('IT\tItalia\nFR;Francia\n\nDE, Germania, unita')) ===
   JSON.stringify([['IT', 'Italia'], ['FR', 'Francia'], ['DE', 'Germania, unita']]), 'tab, punto e virgola, prima virgola; righe vuote saltate')
ok(JSON.stringify(parseEntries('solo')) === JSON.stringify([['solo', '']]), 'riga senza separatore → valore vuoto')
ok(formatEntries([['a', 'b']]) === 'a\tb', 'ritorno al testo con TAB')

console.log('\n--- controlli ---')
const T: DecodeTable[] = [{ name: 'paesi', entries: [['IT', 'Italia']] }]
ok(validateDecodeTables(T).length === 0, 'tabella valida')
ok(validateDecodeTables([{ name: '1x', entries: [] }]).length === 1, 'nome non valido')
ok(validateDecodeTables([...T, { name: 'PAESI', entries: [] }]).length === 1, 'nomi uguali (senza maiuscole)')
ok(validateDecodeTables([{ name: 't', entries: [['a', '1'], ['a', '2']]}]).length === 1, 'chiave ripetuta')

console.log('\n--- decode → decode_map ---')
const e: any = compileFpel('decode("Paesi", codice, "?")', { userFunctions: [], decodeTables: T })
ok(e.name === 'decode_map' && e.args[0].field === 'codice' && e.args[1].name === 'list'
   && e.args[1].args.length === 2 && e.args[2].value === '?', 'tabella dentro l\'espressione, nome senza maiuscole')
const errore = (src: string, tabs: DecodeTable[], re: RegExp, desc: string) => {
  try { compileFpel(src, { userFunctions: [], decodeTables: tabs }); ok(false, desc) }
  catch (x) { ok(x instanceof ExprParseError && re.test(x.message), desc) }
}
errore('decode("altro", x)', T, /unknown table "altro".*paesi/, 'tabella inesistente: dice quali ci sono')
errore('decode("altro", x)', [], /no decode tables/, 'nessuna tabella nel progetto')
errore('decode(nome_tabella, x)', T, /in quotes/, 'nome calcolato rifiutato')
errore('decode("paesi")', T, /at least 2/, 'arità')
const { functions } = parseUserFunctions(['funzione paese(c) { ritorna decode("paesi", c, "?") }'])
const u: any = compileFpel('paese(x)', { userFunctions: functions, decodeTables: T })
ok(u.name === 'decode_map' && u.args[0].field === 'x', 'decode dentro una funzione utente: risolto dopo l\'espansione')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)
