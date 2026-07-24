/**
 * src/ir/scriptParser.test.ts
 *
 * Casi del linguaggio del nodo Script. Stessa forma di exprParser.test.ts:
 * niente framework, si esegue e conta.
 *
 * Vale come specifica eseguibile della grammatica: se una regola del
 * disegno (docs/design-nodo-script.md) cambia, qui si vede subito.
 */

import { parseScript, campiAssegnati, ScriptParseError } from './scriptParser'

let pass = 0, fail = 0

function ok(nome: string, fn: () => void) {
  try { fn(); pass++ }
  catch (e) { fail++; console.log(`✗ ${nome}\n    ${(e as Error).message}`) }
}

function eq(a: unknown, b: unknown, msg: string) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${msg}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`)
  }
}

function bad(src: string, nome: string, riga?: number) {
  ok(nome, () => {
    try { parseScript(src) }
    catch (e) {
      if (!(e instanceof ScriptParseError)) throw new Error('errore di tipo sbagliato')
      if (riga !== undefined && e.line !== riga) throw new Error(`riga ${e.line} invece di ${riga}`)
      return
    }
    throw new Error('doveva fallire e non è successo')
  })
}

// ─── Istruzioni ─────────────────────────────────────────────────────

ok('assegnazione', () => {
  const r = parseScript('totale = a + b') as any[]
  eq(r.length, 1, 'una istruzione'); eq(r[0].kind, 'Assign', 'kind'); eq(r[0].field, 'totale', 'campo')
})

ok('skip / reject / log / error', () => {
  const r = parseScript('skip\nreject\nreject "perché"\nlog "ciao"\nerror "rotto"') as any[]
  eq(r.map((s) => s.kind), ['Skip', 'Reject', 'Reject', 'Log', 'Error'], 'sequenza')
  eq(r[1].reason, null, 'reject nudo non ha motivo')
})

ok('corpo vuoto', () => { eq(parseScript('').length, 0, 'nessuna istruzione') })

// ─── Locali ─────────────────────────────────────────────────────────

ok('un let diventa FieldRef verso __local', () => {
  const r = parseScript('let iva = imponibile * 0.22\ntotale = imponibile + iva') as any[]
  eq(r[0].kind, 'Let', 'let')
  eq(r[1].expr.left.kind, 'DirectFieldRef', 'imponibile resta un campo')
  eq(r[1].expr.right.kind, 'FieldRef', 'iva diventa un riferimento al locale')
  eq(r[1].expr.right.input, '__local', 'input sintetico')
})

ok('let non si autoriferisce', () => {
  // `let x = x + 1` legge il CAMPO x: il nome si dichiara dopo aver
  // compilato l'espressione.
  const r = parseScript('let x = x + 1') as any[]
  eq(r[0].expr.left.kind, 'DirectFieldRef', 'x a destra è il campo')
})

ok('un locale vale solo nel suo blocco', () => {
  const r = parseScript('if a {\n let t = 1\n x = t\n}\ny = t') as any[]
  eq(r[0].then[1].expr.input, '__local', 'dentro il blocco è il locale')
  eq(r[1].expr.kind, 'DirectFieldRef', 'fuori torna a essere un campo')
})

bad('let x = 1\nlet x = 2', 'let doppio rifiutato', 2)
bad('let if = 1', 'parola riservata come nome')

// ─── Blocchi: gli stili si equivalgono ──────────────────────────────

ok('if su più righe', () => {
  const r = parseScript('if stato == "ko" {\n  skip\n} else {\n  reject "motivo"\n}') as any[]
  eq(r[0].then[0].kind, 'Skip', 'ramo then'); eq(r[0].else[0].kind, 'Reject', 'ramo else')
})

ok('if su una riga sola', () => {
  const r = parseScript('if a > 0 { b = 1 }') as any[]
  eq(r[0].then[0].field, 'b', 'corpo'); eq(r[0].else.length, 0, 'niente else')
})

ok('stile misto', () => {
  const r = parseScript('if a {\n  b = 1\n} else { b = 2 }') as any[]
  eq(r[0].else[0].expr.value, 2, 'else inline dopo un then multiriga')
})

ok('else if è zucchero per else { if } }', () => {
  const r = parseScript('if a > 1 {\n b = 1\n} else if a > 0 {\n b = 2\n} else {\n b = 3\n}') as any[]
  eq(r[0].else.length, 1, "l'else contiene una sola istruzione")
  eq(r[0].else[0].kind, 'If', 'ed è un if')
  eq(r[0].else[0].else[0].expr.value, 3, 'ramo finale')
})

ok('if annidati', () => {
  const r = parseScript('if a {\n if b { c = 1 }\n d = 2\n}') as any[]
  eq(r[0].then.length, 2, 'due istruzioni nel then'); eq(r[0].then[0].kind, 'If', 'annidato')
})

bad('x = 1\nif a {\n y = 2', 'graffa non chiusa')
bad('a = 1\n}', 'graffa in eccesso', 2)
bad('else { a = 1 }', 'else orfano')
bad('if a\n b = 1', 'if senza graffa')

// ─── Scanner: stringhe e commenti ───────────────────────────────────

ok('// dentro una stringa non è un commento', () => {
  const r = parseScript('// commento\nurl = "http://x/y"   // in coda\nmsg = "chiusa }"') as any[]
  eq(r.length, 2, 'due istruzioni')
  eq(r[0].expr.value, 'http://x/y', 'lo schema dell\'URL sopravvive')
  eq(r[1].expr.value, 'chiusa }', 'la graffa in stringa non chiude un blocco')
})

bad('a == b', '== non è un\'assegnazione')

ok('il numero di riga è quello vero', () => {
  try { parseScript('a = 1\nb = 2\nc = (') }
  catch (e) { eq((e as ScriptParseError).line, 3, 'riga segnalata'); return }
  throw new Error('doveva fallire')
})

// ─── Schema di uscita ───────────────────────────────────────────────

ok('i campi assegnati includono i rami', () => {
  const r = parseScript('a = 1\nif z { b = 2 } else { c = 3 }')
  eq(campiAssegnati(r).sort(), ['a', 'b', 'c'], 'schema di uscita')
})

ok('i let non entrano nello schema', () => {
  eq(campiAssegnati(parseScript('let t = 1\na = t')), ['a'], 'solo i campi assegnati')
})

// ─── Fan-out e generatore ───────────────────────────────────────────

ok('emit', () => { eq((parseScript('emit') as any[])[0].kind, 'Emit', 'kind') })

ok('repeat con contatore', () => {
  const r = parseScript('repeat 3 as i {\n n = i\n emit\n}') as any[]
  eq(r[0].kind, 'Repeat', 'kind'); eq(r[0].varName, 'i', 'nome del contatore')
  eq(r[0].body.length, 2, 'corpo')
  eq(r[0].body[0].expr.input, '__local', 'il contatore è un locale')
})

ok('repeat senza contatore', () => {
  const r = parseScript('repeat n_copie { emit }') as any[]
  eq(r[0].varName, null, 'nessun nome')
  eq(r[0].count.kind, 'DirectFieldRef', 'il conteggio può venire da un campo')
})

ok('for su un array', () => {
  const r = parseScript('for riga in dettagli {\n codice = riga\n emit\n}') as any[]
  eq(r[0].kind, 'For', 'kind'); eq(r[0].varName, 'riga', 'nome')
  eq(r[0].body[0].expr.input, '__local', 'la variabile è un locale')
})

ok('la variabile del ciclo non esce dal ciclo', () => {
  const r = parseScript('for x in lista {\n a = x\n}\nb = x') as any[]
  eq(r[0].body[0].expr.kind, 'FieldRef', 'dentro è il locale')
  eq(r[1].expr.kind, 'DirectFieldRef', 'fuori torna a essere un campo')
})

ok('cicli annidati', () => {
  const r = parseScript('repeat 2 as i {\n for y in l {\n emit\n }\n}') as any[]
  eq(r[0].body[0].kind, 'For', 'un for dentro un repeat')
})

ok('i campi assegnati nei cicli entrano nello schema', () => {
  eq(campiAssegnati(parseScript('repeat 3 { a = 1 }\nfor y in l { b = 2 }')).sort(),
     ['a', 'b'], 'schema di uscita')
})

bad('repeat 3\n emit', 'repeat senza graffa')
bad('for x lista { emit }', 'for senza "in"')
bad('let i = 1\nrepeat 3 as i { emit }', 'nome del contatore già preso', 2)
bad('let emit = 1', '"emit" è riservata')
bad('repeat 3 {\n emit', 'graffa del ciclo non chiusa')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)
