// Test standalone: schema di un flusso del JSON Parser con i campi del
// padre (mergeParent) — la regola è quella del motore (json_parser.rs):
// i campi del flusso vincono a parità di nome, scelta vuota = non dichiarabile.
import { jsonParserFlowFields } from '../nodes/types/json_parser/schema'

let pass = 0, fail = 0
const ok = (cond: boolean, desc: string) => { if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}`) } }

const fields = [
  { id: 'a', name: 'sku', jsonPath: '$.sku', type: 'string', transform: 'none', onMissing: 'null' },
  { id: 'b', name: 'qty', jsonPath: '$.qty', type: 'integer', transform: 'none', onMissing: 'null' },
] as any[]
const base = { id: 'flow_1', fields, mergeParent: false, parentFields: [] as string[] }

ok(jsonParserFlowFields(base).map((f) => f.name).join() === 'sku,qty', 'senza padre: solo i campi del flusso')

const merged = jsonParserFlowFields({ ...base, mergeParent: true, parentFields: ['order_id', 'qty'],
  parentSchema: [{ name: 'order_id', type: 'integer' }, { name: 'qty', type: 'string' }] })
ok(merged.map((f) => f.name).join() === 'sku,qty,order_id', 'padre in coda, il campo del flusso vince')
ok(merged.find((f) => f.name === 'qty')!.type === 'integer', 'tipo del campo del flusso, non del padre')
ok(merged.find((f) => f.name === 'order_id')!.type === 'integer', 'tipo del padre da parentSchema')

const noType = jsonParserFlowFields({ ...base, mergeParent: true, parentFields: ['customer'] })
ok(noType[2]?.type === 'any', 'padre senza tipo noto → any')

ok(jsonParserFlowFields({ ...base, mergeParent: true, parentFields: [] }).length === 2, 'scelta vuota (= tutto nel motore): non dichiarata')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail ? 1 : 0)
