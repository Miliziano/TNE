// Test standalone (stesso stile di userFunctions.test.ts): verifica che la
// forma canonica TS coincida col VETTORE CONDIVISO usato anche dal gemello
// Rust (src-tauri/src/signing/canonical.rs → vectors/canonical_plan_v1.json).
import { canonicalPlanString, planHash } from './canonicalPlan'
import vec from '../../vectors/canonical_plan_v1.json'

let pass = 0, fail = 0
const ok = (cond: boolean, desc: string) => { if (cond) { pass++; console.log(`  ok   ${desc}`) } else { fail++; console.log(`  FAIL ${desc}`) } }

async function main() {
  const canon = canonicalPlanString(vec.plan)
  ok(canon === vec.canonical, 'stringa canonica == vettore')

  const h = await planHash(vec.plan)
  ok(h === vec.sha256, `planHash == vettore (${h})`)

  // run_id NON deve influire: due piani identici salvo run_id → stesso hash.
  const p2 = JSON.parse(JSON.stringify(vec.plan))
  p2.run_id = 'export-999'
  ok((await planHash(p2)) === vec.sha256, 'planHash invariante rispetto a run_id')

  console.log(`\ncanonicalPlan: ${pass} ok, ${fail} FAIL`)
  if (fail) process.exit(1)
}
main()
