/** Test della provenienza dei campi (P393): all'indietro fino alle sorgenti,
 *  in avanti fino ai sink, attraverso Script, Transform, TMap, Aggregate,
 *  Join, Union, Filter e bridge tra lane. */
import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData } from '../types'
import { creaProvenienza, origini, riepilogoProvenienza, provenienzaCsv } from './lineage'

let pass = 0, fail = 0
const ok = (cond: boolean, desc: string) => {
  if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}`) }
}

const nodo = (id: string, type: string, props: Record<string, string> = {}, config: Record<string, unknown> = {}): FlowNode<NodeData> =>
  ({ id, type, position: { x: 0, y: 0 }, data: { type, label: id, laneId: 'l1', props, config } as unknown as NodeData })
const arco = (source: string, target: string, sourceHandle = 'output', targetHandle = 'input'): Edge =>
  ({ id: `${source}-${target}-${targetHandle}`, source, target, sourceHandle, targetHandle })
const schema = (...campi: Array<[string, string?]>) =>
  JSON.stringify(campi.map(([name, phys]) => ({ id: name, name, type: 'string', physicalName: phys ?? name })))

// ordini.csv → script → tmap (+ lookup clienti) → aggregate → sink_db
const nodes: FlowNode<NodeData>[] = [
  nodo('ordini', 'source_file', { path: '/dati/ordini.csv', outputSchema: schema(['id'], ['cliente'], ['qta', 'QTY'], ['prezzo']) }),
  nodo('clienti', 'source_db', { outputSchema: schema(['cod'], ['regione']) }),
  nodo('calcoli', 'script', { code: [
    'let lordo = qta * prezzo',
    'totale = round(lordo * 1.22, 2)',
    'if totale > 100 { fascia = "alta" } else { fascia = "bassa" }',
    'doppio = totale * 2',
  ].join('\n') }),
  nodo('filtro', 'filter'),
  nodo('mappa', 'tmap', {}, { tmap: {
    inputs: [
      { id: 'in_main', label: 'main', isMain: true, joinType: 'none', fields: [{ name: 'cliente', type: 'string' }, { name: 'totale', type: 'decimal' }] },
      { id: 'in_cli', label: 'cli', isMain: false, joinType: 'left', fields: [{ name: 'cod', type: 'string' }, { name: 'regione', type: 'string' }] },
    ],
    outputs: [{ id: 'out', label: 'out', color: '#fff', fields: [
      { id: 'o1', name: 'cliente', type: 'string', expression: 'main.cliente' },
      { id: 'o2', name: 'area', type: 'string', expression: 'upper(cli.regione)' },
      { id: 'o3', name: 'netto', type: 'decimal', expression: 'main.totale - sconto' },
    ] }],
    transforms: [{ id: 't1', label: 'sconto', mode: 'inline', inputs: [], expression: 'main.totale * 0.1', outputName: 'sconto', outputType: 'decimal' }],
  } }),
  nodo('agg', 'aggregate', { group_by: 'area', aggFunctions: JSON.stringify([{ id: 'a', fn: 'sum', field: 'netto', alias: 'tot' }, { id: 'b', fn: 'count', field: '', alias: 'n' }]) }),
  nodo('db', 'sink_db', { table: 'VENDITE', sinkColumns: JSON.stringify([{ dbColumn: 'AREA', sourceField: 'area' }, { dbColumn: 'TOTALE', sourceField: 'tot' }]) }),
  // ramo secondario: transform + join + union + bridge
  nodo('tr', 'transform', { unmappedFields: 'drop', transformFields: JSON.stringify([
    { source: 'id', output: 'codice', type: 'string', presetId: 'expr', params: {}, expression: 'concat("O-", id)', enabled: true },
    { source: 'cliente', output: 'cliente', type: 'string', presetId: 'expr', params: {}, expression: 'cliente', enabled: true },
  ]) }),
  nodo('jn', 'join', { join_type: 'left', rightPrefix: 'r_' }),
  nodo('un', 'union', { unionMapping: JSON.stringify([{ name: 'chi', from: { input_main: 'cliente', in2: 'cod' } }]) }),
  nodo('bo', 'bridge_out', { channelName: 'ch' }),
  nodo('bi', 'bridge_in', { channelName: 'ch' }),
  nodo('file', 'sink_file', { path: '/out/uscita.csv' }),
]
const edges: Edge[] = [
  arco('ordini', 'calcoli'),
  arco('calcoli', 'filtro'),
  arco('filtro', 'mappa', 'output', 'in_main'),
  arco('clienti', 'mappa', 'output', 'in_cli'),
  arco('mappa', 'agg', 'out', 'input'),
  arco('agg', 'db'),
  arco('ordini', 'tr'),
  arco('tr', 'jn', 'output', 'input_left'),
  arco('clienti', 'jn', 'output', 'input_right'),
  arco('jn', 'un', 'output', 'input_main'),
  arco('clienti', 'un', 'output', 'in2'),
  arco('un', 'bo'),
  arco('bi', 'file'),
]
const p = creaProvenienza(nodes, edges)

console.log('\n--- campi in uscita ---')
ok(JSON.stringify(p.campi('calcoli', 'output')) === JSON.stringify(['id', 'cliente', 'qta', 'prezzo', 'totale', 'fascia', 'doppio']),
   'Script: ingresso + campi assegnati, i let no')
ok(JSON.stringify(p.campi('mappa', 'out')) === JSON.stringify(['cliente', 'area', 'netto']), 'TMap: campi dell\'uscita')
ok(JSON.stringify(p.campi('agg', 'output')) === JSON.stringify(['area', 'tot', 'n']), 'Aggregate: chiavi + funzioni')
ok(JSON.stringify(p.campi('tr', 'output')) === JSON.stringify(['codice', 'cliente']), 'Transform in modalità drop: solo i calcolati')
ok(JSON.stringify(p.campi('jn', 'output')) === JSON.stringify(['codice', 'cliente', 'cod', 'regione']), 'Join: sinistra + destra')
ok(JSON.stringify(p.campi('bi', 'output')) === JSON.stringify(['chi']), 'Bridge In: i campi del canale')

console.log('\n--- derivazioni ---')
const tot = p.deriva('calcoli', 'output', 'totale')!
ok(tot.come === 'expr' && tot.testo === 'round(lordo * 1.22, 2)', 'Script: testo dell\'espressione')
ok(tot.da.map((i) => i.field).sort().join() === 'prezzo,qta', 'Script: il let porta alle sue dipendenze')
ok(tot.passi?.[0]?.nome === 'let lordo' && tot.passi[0].testo === 'qta * prezzo', 'Script: il let è un passo intermedio')
const doppio = p.deriva('calcoli', 'output', 'doppio')!
ok(doppio.da.map((i) => i.field).sort().join() === 'prezzo,qta' && doppio.passi?.some((s) => s.nome === 'totale') === true,
   'Script: un campo che legge un campo già assegnato ne eredita la provenienza')
const fascia = p.deriva('calcoli', 'output', 'fascia')!
ok(fascia.condizionale === true && fascia.testo === '"alta"  |  "bassa"', 'Script: assegnazione nei rami di un if')
ok(p.deriva('filtro', 'output', 'qta')?.come === 'pass', 'Filter: passaggio')
const netto = p.deriva('mappa', 'out', 'netto')!
ok(netto.testo === 'main.totale - sconto' || netto.testo === 'in_main.totale - sconto', 'TMap: testo dell\'espressione')
ok(netto.da.length === 1 && netto.da[0].handle === 'in_main' && netto.da[0].field === 'totale' && netto.passi?.[0].nome === 'sconto',
   'TMap: la trasformazione intermedia porta al campo dell\'ingresso')
ok(p.deriva('mappa', 'out', 'area')!.da[0].handle === 'in_cli', 'TMap: campo del lookup sulla sua porta')
const sum = p.deriva('agg', 'output', 'tot')!
ok(sum.come === 'agg' && sum.testo === 'sum(netto)', 'Aggregate: funzione e campo')
ok(p.deriva('agg', 'output', 'n')!.da.length === 0, 'count(*) non dipende da un campo')
ok(p.deriva('jn', 'output', 'cod')!.da[0].handle === 'input_right', 'Join: campo del lato destro')
ok(p.deriva('agg', 'output', 'qta') === null, 'un campo che il nodo non produce → null')

console.log('\n--- all\'indietro ---')
const indietro = p.daIngresso('db', 'input', 'tot')
const foglie = indietro.flatMap(origini)
ok(foglie.length === 2 && foglie.every((f) => f.nodeId === 'ordini' && f.der?.come === 'origin'), 'TOTALE ← due colonne di ordini.csv')
ok(foglie.map((f) => f.field).sort().join() === 'prezzo,qta', '… qta e prezzo')
ok(foglie.find((f) => f.field === 'qta')!.der!.testo === 'column "QTY" of ordini.csv', 'origine: la colonna fisica del file')
const area = p.daIngresso('db', 'input', 'area').flatMap(origini)
ok(area.length === 1 && area[0].nodeId === 'clienti' && area[0].field === 'regione', 'AREA ← clienti.regione (lookup del TMap)')
const chi = p.indietro('bi', 'output', 'chi')
ok(chi.sorgenti[0]?.nodeId === 'bo', 'attraverso il canale del bridge')
const chiOrig = origini(chi)
ok(chiOrig.map((o) => `${o.nodeId}.${o.field}`).sort().join() === 'clienti.cod,ordini.cliente', 'Union: un valore per flusso')

console.log('\n--- in avanti ---')
const usi = p.avanti('ordini', 'output', 'qta')
const piatti: string[] = []
const visita = (u: ReturnType<typeof p.avanti>) => u.forEach((x) => { piatti.push(`${x.nodeId}.${x.field}${x.scritto ? ` → ${x.scritto}` : ''}`); visita(x.usi) })
visita(usi)
ok(piatti.includes('calcoli.totale') && piatti.includes('calcoli.doppio') && piatti.includes('calcoli.qta'), 'qta alimenta totale, doppio e passa')
ok(piatti.includes('mappa.netto') && piatti.includes('agg.tot'), '… poi netto e la somma')
ok(piatti.includes('db.tot → column "TOTALE" of VENDITE'), '… fino alla colonna della tabella')
ok(!piatti.some((x) => x.startsWith('agg.n')), 'count(*) non è un uso di qta')
const usiCod = p.avanti('clienti', 'output', 'cod')
const flat2: string[] = []
const visita2 = (u: ReturnType<typeof p.avanti>) => u.forEach((x) => { flat2.push(`${x.nodeId}.${x.field}${x.scritto ? ` → ${x.scritto}` : ''}`); visita2(x.usi) })
visita2(usiCod)
ok(flat2.includes('bi.chi') && flat2.includes('file.chi → column "chi" of uscita.csv'), 'in avanti attraverso union e bridge, fino al file')

console.log('\n--- riepilogo ---')
const righe = riepilogoProvenienza(nodes, edges)
const rTot = righe.find((r) => r.nodo === 'db' && r.campo === 'tot')!
ok(rTot.origini.length === 2 && rTot.percorso.startsWith('agg.tot = sum(netto) ← mappa.netto'), 'riga del sink con origini e percorso')
const csv = provenienzaCsv(righe)
ok(csv.split('\n')[0] === 'target;port;field;origin;path' && csv.includes('"ordini.qta, ordini.prezzo"') || csv.includes('"ordini.prezzo, ordini.qta"'), 'CSV')

console.log('\n--- cicli e config rotte ---')
const ciclo = creaProvenienza([nodo('a', 'filter'), nodo('b', 'filter')], [arco('a', 'b'), arco('b', 'a')])
ok(Array.isArray(ciclo.campi('a', 'output')), 'un ciclo non blocca il calcolo')
const rotto = creaProvenienza([nodo('s', 'source_file', { outputSchema: schema(['x']) }), nodo('sc', 'script', { code: 'y = (' })], [arco('s', 'sc')])
ok(rotto.deriva('sc', 'output', 'x')?.come === 'assumed', 'Script che non compila: si assume il passaggio')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)
