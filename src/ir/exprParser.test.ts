import { parseExpression, ExprParseError } from './exprParser'

const labels = new Map([['DB Source Film', 'input_main'], ['Lookup', 'input_2']])
let pass = 0, fail = 0

function ok(expr: string, check: (n: any) => boolean, _desc: string, opts: any = {}) {
  try {
    const n = parseExpression(expr, opts)
    if (check(n)) { pass++; console.log(`  ok   ${expr}`) }
    else { fail++; console.log(`  FAIL ${expr} → ${JSON.stringify(n)}`) }
  } catch (e: any) { fail++; console.log(`  FAIL ${expr} → errore: ${e.message}`) }
}
function bad(expr: string, _desc: string, opts: any = {}) {
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

console.log('\n--- P389: in, between, like, ?? ---')
ok('x in (1, 2, 3)', (n:any) => n.op==='OR' && n.left.op==='OR' && n.right.op==='EQ' && n.right.right.value===3, 'in → catena di ==')
ok('x in ("A")', (n:any) => n.op==='EQ' && n.right.value==='A', 'un solo valore')
ok('x in ()', (n:any) => n.kind==='Literal' && n.value===false, 'elenco vuoto → falso')
ok('x not in (1, 2)', (n:any) => n.kind==='UnaryOp' && n.op==='NOT' && n.expr.op==='OR', 'not in')
ok('x in tags', (n:any) => n.kind==='FunctionCall' && n.name==='contains' && n.args[0].field==='tags' && n.args[1].field==='x', 'in elenco → contains(elenco, x)')
ok('x in [1, 2]', (n:any) => n.name==='contains' && n.args[0].name==='list', 'in elenco letterale')
ok('a > 1 && x in (1, 2)', (n:any) => n.op==='AND' && n.right.op==='OR', 'in lega più di &&')
ok('x between 1 and 10', (n:any) => n.op==='AND' && n.left.op==='GTE' && n.right.op==='LTE' && n.right.right.value===10, 'between')
ok('x between a + 1 and b * 2 and y > 0', (n:any) => n.op==='AND' && n.left.op==='AND' && n.left.right.right.op==='MUL' && n.right.op==='GT', 'between dentro un and')
ok('x not between 1 and 2', (n:any) => n.kind==='UnaryOp' && n.expr.op==='AND', 'not between')
ok('nome like "A%"', (n:any) => n.kind==='FunctionCall' && n.name==='like' && n.args[1].value==='A%', 'like')
ok('nome not like "A%"', (n:any) => n.kind==='UnaryOp' && n.expr.name==='like', 'not like')
ok('a ?? b', (n:any) => n.kind==='Coalesce' && n.args.length===2, '??')
ok('a ?? b ?? "x"', (n:any) => n.kind==='Coalesce' && n.args.length===3, '?? a catena, piatto')
ok('a > 1 ? b ?? 0 : 2', (n:any) => n.name==='iif' && n.args[1].kind==='Coalesce', '?? dentro il ternario')
ok('try(to_int(x), 0)', (n:any) => n.kind==='Coalesce', 'try = coalesce')
ok('like', (n:any) => n.kind==='DirectFieldRef' && n.field==='like', 'like resta un nome di campo valido')
bad('x between 1', 'between senza and')
bad('x not', 'not sospeso')

console.log('\n--- P389: testo con segnaposto ---')
ok('f"Ordine {id} di {cliente}"', (n:any) => n.name==='concat' && n.args.length===4 && n.args[0].value==='Ordine ' && n.args[1].field==='id', 'segnaposto')
ok("f'{a}'", (n:any) => n.name==='concat' && n.args.length===1 && n.args[0].field==='a', 'solo un segnaposto → resta testo')
ok('f"{{x}}"', (n:any) => n.kind==='Literal' && n.value==='{x}', 'graffe doppie = graffe')
ok('f"tot: {round(q * p, 2)} €"', (n:any) => n.name==='concat' && n.args[1].name==='round', 'espressione nel segnaposto')
ok("f\"{replace(x, '}', '')}!\"", (n:any) => n.name==='concat' && n.args[0].name==='replace' && n.args[0].args[1].value==='}', 'graffa dentro una stringa (altre virgolette)')
ok('f"{replace(x, \\"}\\", \\"\\")}!"', (n:any) => n.name==='concat' && n.args[0].name==='replace' && n.args[0].args[1].value==='}', 'graffa dentro una stringa (virgolette del testo, con \\)')
ok('f"riga\\n{a}"', (n:any) => n.args[0].value==='riga\n', 'escape nel testo')
ok('f""', (n:any) => n.kind==='Literal' && n.value==='', 'vuoto')
bad('f"{x"', 'segnaposto non chiuso')
bad('f"x}"', 'graffa chiusa da sola')
bad('f"{}"', 'segnaposto vuoto')
bad('f"{1 +}"', 'espressione sbagliata nel segnaposto')
try { parseExpression('f"ab{1 +}"') } catch (e: any) {
  if (e instanceof ExprParseError && e.pos >= 5) { pass++; console.log('  ok   posizione dell\'errore dentro il segnaposto') }
  else { fail++; console.log(`  FAIL posizione ${e.pos}`) }
}

console.log('\n--- P389: elenchi e funzioni x -> … ---')
ok('[1, 2, 3]', (n:any) => n.name==='list' && n.args.length===3, 'elenco')
ok('[]', (n:any) => n.name==='list' && n.args.length===0, 'elenco vuoto')
ok('filter(righe, r -> r.qty > 0)', (n:any) => n.name==='filter' && n.args[1].name==='lambda' && n.args[1].args[0].value==='r'
   && n.args[1].args[1].op==='GT' && n.args[1].args[1].left.name==='get' && n.args[1].args[1].left.args[0].name==='lambda_arg', 'filter con campo dell\'elemento')
ok('map(xs, x -> x * 2)', (n:any) => n.args[1].args[1].left.name==='lambda_arg', 'map')
ok('any(xs, x -> x > soglia)', (n:any) => n.args[1].args[1].right.kind==='DirectFieldRef', 'nome libero nel corpo = campo della riga')
ok('sum(r, x -> x.a.b)', (n:any) => n.args[1].args[1].name==='get' && n.args[1].args[1].args[0].name==='get', 'campo annidato')
ok('sum(xs)', (n:any) => n.name==='sum' && n.args.length===1, 'sum senza funzione')
ok('any(a, x -> any(b, y -> y == x))', (n:any) => n.args[1].args[1].args[1].args[1].right.name==='lambda_arg' && n.args[1].args[1].args[1].args[1].right.args[0].value==='x', 'annidate: x visibile dentro')
ok('count(xs, x -> f"{x}" == "1")', (n:any) => n.args[1].args[1].left.kind==='FunctionCall', 'parametro dentro un segnaposto')
bad('filter(xs)', 'filter senza funzione')
bad('filter(xs, true)', 'filter con un valore invece di una funzione')
bad('x -> x', 'funzione fuori posto')
bad('upper(x -> x)', 'funzione come argomento di una funzione che non la vuole')
bad('any(xs, x -> x, 3)', 'troppi argomenti')
bad('any(xs, case -> 1)', 'parola chiave come parametro')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)