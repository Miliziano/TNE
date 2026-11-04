/** Test di quando il Filter dopo un DB Input si spinge nella query (P394). */
import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData } from '../types'
import { filtroDaSpingere } from './pushdown'

let pass = 0, fail = 0
const ok = (cond: boolean, desc: string) => {
  if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}`) }
}
const nodo = (id: string, type: string, props: Record<string, string> = {}, config: Record<string, unknown> = {}): FlowNode<NodeData> =>
  ({ id, type, position: { x: 0, y: 0 }, data: { type, label: id, props, config } as unknown as NodeData })
const arco = (source: string, target: string, sourceHandle = 'output', targetHandle = 'input'): Edge =>
  ({ id: `${source}-${target}-${sourceHandle}`, source, target, sourceHandle, targetHandle })
const conFiltro = { filter: { conditions: [{ id: 'c1', label: 'ok', mode: 'code', code: 'qta > 1' }] } }

const db = nodo('db', 'source_db')
const fl = nodo('fl', 'filter', {}, conFiltro)
const out = nodo('out', 'sink_file')
const base = [db, fl, out]

ok(filtroDaSpingere(db, base, [arco('db', 'fl'), arco('fl', 'out', 'c1')])?.id === 'fl', 'DB Input → Filter: si spinge')
ok(filtroDaSpingere(db, base, [arco('db', 'fl'), arco('db', 'out'), arco('fl', 'out', 'c1')]) === null, 'il DB Input alimenta anche altro: no')
ok(filtroDaSpingere(db, base, [arco('db', 'fl'), arco('fl', 'out', 'reject')]) === null, 'scarto del Filter collegato: no')
ok(filtroDaSpingere(db, [...base, nodo('altro', 'source_file')], [arco('db', 'fl'), arco('altro', 'fl')]) === null, 'il Filter riceve anche da altri: no')
ok(filtroDaSpingere(nodo('db', 'source_db', { pushdown: 'off' }), base, [arco('db', 'fl')]) === null, 'opzione spenta: no')
ok(filtroDaSpingere(db, [db, nodo('fl', 'filter'), out], [arco('db', 'fl')]) === null, 'Filter senza condizioni: no')
ok(filtroDaSpingere(db, base, [arco('db', 'fl'), arco('db', 'out', 'catch')])?.id === 'fl', 'la porta catch non conta')
ok(filtroDaSpingere(db, [db, nodo('tr', 'transform')], [arco('db', 'tr')]) === null, 'dopo il DB Input non c\'è un Filter: no')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)
