import { parseExpression, ExprParseError } from './exprParser'

const labels = new Map([['DB Source Film', 'input_main'], ['Lookup', 'input_2']])
let pass = 0, fail = 0

function ok(expr: string, check: (n: any) => boolean, desc: string, opts: any = {}) {
  try {
    const n = parseExpression(expr, opts)
    if (check(n)) { pass++; console.log(`  ok   ${expr}`) }
    else { fail++; console.log(`  FAIL ${expr} → ${JSON.stringify(n)}`) }
  } catch (e: any) { fail++; console.log(`  FAIL ${expr} → errore: ${e.message}`) }
}
function bad(expr: string, desc: string, opts: any = {}) {
  try { const n = parseExpression(expr, opts); fail++; console.log(`  FAIL ${expr} doveva dare errore, ha dato ${JSON.stringify(n)}`) }
  catch (e) { if (e instanceof ExprParseError) { pass++; console.log(`  ok   ${expr} → errore atteso`) } else { fail++; console.log(`  FAIL ${expr} → errore sbagliato`) } }
}

console.log('\n--- letterali e campi ---')
ok('42', n => n.kind==='Literal' && n.value===42, '')
ok('3.14', n => n.value===3.14, '')
ok('"ciao"', n => n.kind==='Literal' && n.value==='ciao', '')
ok("'ciao'", n => n.value==='ciao', '')
ok('true', n => n.value===true, '')
ok('null', n => n.value===null, '')
ok('nome', n => n.kind==='DirectFieldRef' && n.field==='nome', '')

console.log('\n--- precedenza (il bug del vecchio parser) ---')
ok('a + b * c', n => n.op==='ADD' && n.right.op==='MUL', 'moltiplicazione lega più forte')
ok('(a + b) * c', n => n.op==='MUL' && n.left.op==='ADD', 'parentesi')
ok('a + b + c', n => n.op==='ADD' && n.left.op==='ADD', 'left-assoc')
ok('a > 1 && b < 2', n => n.op==='AND' && n.left.op==='GT', 'confronto lega più di AND')
ok('a || b && c', n => n.op==='OR' && n.right.op==='AND', 'AND lega più di OR')

console.log('\n--- funzioni (che il vecchio parser NON sapeva fare) ---')
ok('upper(nome)', n => n.kind==='FunctionCall' && n.name==='upper', '')
ok('upper(trim(nome))', n => n.args[0].kind==='FunctionCall' && n.args[0].name==='trim', 'annidate')
ok('substring(s, 1, 3)', n => n.args.length===3, 'più argomenti')
ok('now()', n => n.kind==='FunctionCall' && n.args.length===0, 'zero argomenti')
ok('var("suffisso")', n => n.kind==='FunctionCall' && n.name==='var' && n.args[0].value==='suffisso', 'variabile lane')
ok('coalesce(a, b, "x")', n => n.kind==='Coalesce' && n.args.length===3, 'coalesce → nodo IR dedicato')

console.log('\n--- ibridazioni ---')
ok('x is null', n => n.kind==='IsNull', '')
ok('x is not null', n => n.kind==='IsNotNull', '')
ok('a > 1 ? "si" : "no"', n => n.kind==='FunctionCall' && n.name==='iif' && n.args.length===3, 'ternario → iif')
ok('case when a > 1 then "alto" else "basso" end', n => n.kind==='CaseWhen' && n.branches.length===1 && n.default!==null, '')
ok('case when a>2 then "x" when a>1 then "y" end', n => n.kind==='CaseWhen' && n.branches.length===2 && n.default===null, 'multi-ramo senza else')
ok('cast(x as integer)', n => n.kind==='Cast' && n.target_type==='integer', '')

console.log('\n--- unari e concatenazione ---')
ok('!attivo', n => n.kind==='UnaryOp' && n.op==='NOT', '')
ok('-prezzo', n => n.kind==='UnaryOp' && n.op==='NEG', '')
ok('nome + " " + cognome', n => n.op==='ADD', 'concat con +')

console.log('\n--- riferimenti qualificati (nomi con spazi) ---')
ok('"DB Source Film".titolo', n => n.kind==='FieldRef' && n.input==='input_main' && n.field==='titolo', '', {labelToInputId: labels})
ok('Lookup.id', n => n.kind==='FieldRef' && n.input==='input_2', '', {labelToInputId: labels})

console.log('\n--- errori (mai degrado silenzioso a Literal!) ---')
bad('upper(', 'parentesi non chiusa')
bad('a +', 'operando mancante')
bad('"stringa non chiusa', 'quote')
bad('a ? b', 'ternario senza :')
bad('case when a then 1', 'case senza end')
bad('cast(x as pippo)', 'tipo sconosciuto')
bad('Sconosciuto.campo', 'input non noto', {labelToInputId: labels})
bad('a @ b', 'carattere illegale')

console.log('\n--- validazione funzioni ---')
bad('pippo(x)', 'funzione inesistente')
bad('upper()', 'troppo pochi argomenti')
bad('upper(a, b)', 'troppi argomenti')
bad('substring(s)', 'substring vuole almeno 2')
ok('substring(s, 1)', (n:any) => n.args.length===2, 'arita minima')
ok('round(x)', (n:any) => n.name==='round', 'argomento opzionale')
ok('concat(a,b,c,d)', (n:any) => n.args.length===4, 'variadica')
ok('len(s)', (n:any) => n.name==='length', 'alias normalizzato')
ok('nvl(a,b)', (n:any) => n.kind==='Coalesce', 'alias nvl -> Coalesce')
ok('IF(a,b,c)', (n:any) => n.name==='iif', 'case-insensitive + alias')

console.log('\n--- identificatori Unicode e quotati ---')
ok('età', (n:any) => n.kind==='DirectFieldRef' && n.field==='età', 'accenti')
ok('Größe', (n:any) => n.field==='Größe', 'umlaut')
ok('upper(città)', (n:any) => n.args[0].field==='città', 'accento in funzione')
ok('`data ordine`', (n:any) => n.kind==='DirectFieldRef' && n.field==='data ordine', 'backtick: spazio')
ok('`costo/unità` * 2', (n:any) => n.op==='MUL' && n.left.field==='costo/unità', 'backtick: slash')
ok('`case`', (n:any) => n.kind==='DirectFieldRef' && n.field==='case', 'backtick: parola chiave')
ok('`upper`', (n:any) => n.kind==='DirectFieldRef' && n.field==='upper', 'backtick: nome funzione')
ok('"data ordine"', (n:any) => n.kind==='Literal', 'virgolette = stringa, non campo')
bad('`non chiuso', 'backtick non chiuso')
bad('``', 'identificatore vuoto')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)