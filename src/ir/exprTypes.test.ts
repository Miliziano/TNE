/**
 * Test di inferExprType. Stile di exprParser.test.ts: nessun framework.
 * Si parsa con il parser VERO e si inferisce, così i test provano la
 * catena reale (parse → IR → tipo), non un IR scritto a mano.
 *
 * Esecuzione (non c'è un runner in node_modules):
 *   npx tsc src/ir/exprTypes.test.ts --outDir /tmp/t --module commonjs \
 *     --moduleResolution node --esModuleInterop --skipLibCheck
 *   node /tmp/t/ir/exprTypes.test.js
 */

import { parseExpression } from './exprParser'
import { inferExprType, type InferCtx } from './exprTypes'
import type { FieldType } from '../types/fieldTypes'

// Schema di prova: la riga in ingresso.
const SCHEMA: Record<string, FieldType> = {
  prezzo: 'decimal',
  qta: 'integer',
  nome: 'string',
  attivo: 'boolean',
  creato: 'datetime',
}
const ctx: InferCtx = {
  field: (n) => SCHEMA[n],
  qualified: (_input, field) => SCHEMA[field],
}

let pass = 0,
  fail = 0

function t(expr: string, atteso: FieldType) {
  try {
    const node = parseExpression(expr)
    const got = inferExprType(node, ctx)
    if (got === atteso) {
      pass++
      console.log(`  ok   ${expr}  →  ${got}`)
    } else {
      fail++
      console.log(`  FAIL ${expr}  →  ${got}  (atteso ${atteso})`)
    }
  } catch (e: any) {
    fail++
    console.log(`  FAIL ${expr}  →  errore: ${e.message}`)
  }
}

console.log('\n--- letterali ---')
t('42', 'integer')
t('3.14', 'decimal')
t('"ciao"', 'string')
t('true', 'boolean')

console.log('\n--- campi ---')
t('nome', 'string')
t('prezzo', 'decimal')
t('qta', 'integer')
t('sconosciuto', 'any') // non in schema

console.log('\n--- il fix di P70: ADD sovraccarico ---')
t('"IVA " + to_string(prezzo)', 'string') // concatenazione
t('"a" + nome', 'string')
t('prezzo + qta', 'number') // aritmetica mista
t('qta + qta', 'integer') // interi puri
t('prezzo * qta', 'number')
t('prezzo - 1', 'number')

console.log('\n--- confronti e logica → boolean ---')
t('prezzo > 10', 'boolean')
t('nome == "x"', 'boolean')
t('attivo and true', 'boolean')
t('not attivo', 'boolean')
t('prezzo is null', 'boolean')
t('prezzo is not null', 'boolean')

console.log('\n--- funzioni: tipo dal catalogo ---')
t('upper(nome)', 'string')
t('length(nome)', 'integer')
t('contains(nome, "x")', 'boolean')
t('year(creato)', 'integer') // le 6 nuove
t('month(creato)', 'integer')
t('now()', 'datetime')
t('today()', 'date')
t('add_days(creato, 3)', 'date')
t('to_int(prezzo)', 'integer')
t('to_string(qta)', 'string')

console.log('\n--- funzioni polimorfe ---')
t('coalesce(nome, "x")', 'string')
t('coalesce(prezzo, qta)', 'number') // decimal ∪ integer
t('iif(attivo, nome, "no")', 'string')
t('iif(attivo, prezzo, qta)', 'number')
t('nullif(qta, 0)', 'integer')
t('min(prezzo, qta)', 'number')
t('clamp(prezzo, 0, 100)', 'decimal')
t('coalesce(nome, prezzo)', 'any') // string ∪ decimal = incompatibili

console.log('\n--- ternario e cast ---')
t('attivo ? nome : "no"', 'string') // ternario → iif
t('cast(prezzo as integer)', 'integer')
t('cast(qta as string)', 'string')

console.log('\n--- var / struttura → any (onesto) ---')
t('var("contatore")', 'any')

// ─── Walker tipizzato dello Script ──────────────────────────────────
import { parseScript, campiAssegnatiTipizzati } from './scriptParser'

function ts(code: string, atteso: Record<string, FieldType>, desc: string) {
  try {
    const campi = campiAssegnatiTipizzati(parseScript(code), (n) => SCHEMA[n])
    const got: Record<string, string> = {}
    for (const c of campi) got[c.name] = c.type
    const ok = Object.keys(atteso).length === campi.length &&
      Object.entries(atteso).every(([k, v]) => got[k] === v)
    if (ok) { pass++; console.log(`  ok   ${desc}  →  ${JSON.stringify(got)}`) }
    else { fail++; console.log(`  FAIL ${desc}  →  ${JSON.stringify(got)} (atteso ${JSON.stringify(atteso)})`) }
  } catch (e: any) { fail++; console.log(`  FAIL ${desc}  →  errore: ${e.message}`) }
}

console.log('\n--- campiAssegnatiTipizzati ---')
ts('iva = prezzo * 0.22', { iva: 'number' }, 'campo numerico')
ts('etichetta = "IVA " + to_string(prezzo)', { etichetta: 'string' }, 'concatenazione')
// un campo che ne usa un altro assegnato prima
ts('iva = prezzo * 0.22\ntotale = prezzo + iva', { iva: 'number', totale: 'number' }, 'campo che usa un campo')
// un let risolve via __local
ts('let sc = 0.1\nscontato = prezzo - prezzo * sc', { scontato: 'number' }, 'let come locale')
ts('mese = month(creato)', { mese: 'integer' }, 'funzione data → integer')
// assegnato in due rami con tipi diversi → any
ts('if attivo { x = nome } else { x = prezzo }', { x: 'any' }, 'rami incompatibili → any')
ts('if attivo { x = "a" } else { x = "b" }', { x: 'string' }, 'rami concordi → string')

console.log(`\n=== ${pass} ok, ${fail} fail ===`)
if (fail > 0) process.exit(1)
