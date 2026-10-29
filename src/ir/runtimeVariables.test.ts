// Test standalone: dichiarazione delle variabili configurabili al run (P381).
// Il vettore `vectors/manifest_variables_v1.json` è condiviso col Rust
// (runtime/config.rs legge `manifestVariables` con lo stesso codice del runner):
// se lo studio cambia forma, uno dei due test fallisce.
import { manifestVariables, configurableNames, canBeConfigurable } from './runtimeVariables'
import vec from '../../vectors/manifest_variables_v1.json'
import type { Variable } from '../types'

let pass = 0, fail = 0
const ok = (cond: boolean, desc: string) => { if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}`) } }

const vars = vec.poolVariables as unknown as Variable[]
const got = manifestVariables(vars, vec.activeProfile)
ok(JSON.stringify(got) === JSON.stringify(vec.manifestVariables), 'dichiarazione == vettore condiviso col Rust')
if (JSON.stringify(got) !== JSON.stringify(vec.manifestVariables)) console.log(JSON.stringify(got, null, 2))

ok([...configurableNames(vars)].sort().join() === 'DB_HOST,ENABLED,LEVEL,OPTIONS,THRESHOLD', 'nomi configurabili: niente segreti, dataset o variabili non marcate')
ok(!canBeConfigurable({ type: 'secret' }) && !canBeConfigurable({ type: 'materialize' }), 'segreti e dataset mai configurabili')
ok(Object.keys(manifestVariables([], {})).length === 0, 'nessuna variabile → nessuna dichiarazione')

console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail ? 1 : 0)
