/**
 * src/ir/fpelVector.test.ts — contratto FPEL fra studio e motore (P389).
 *
 * `vectors/fpel_v1.json` elenca espressioni scritte come le scrive l'utente,
 * l'albero (IR) che lo studio ne ricava e il risultato atteso su una riga.
 * Questo test controlla la metà dello STUDIO: il parser deve produrre
 * esattamente quell'albero. La metà del MOTORE è
 * `src-tauri/tests/fpel_vettori.rs`, che valuta l'albero (interprete ed
 * espressione compilata) e confronta il risultato. Insieme dicono che una
 * espressione scritta nello studio fa nel motore ciò che il manuale promette.
 *
 * Un cambiamento VOLUTO del parser si registra rigenerando gli alberi:
 *   FLOWPILOT_AGGIORNA_VETTORI=1 npx tsx src/ir/fpelVector.test.ts
 * (i risultati attesi non si rigenerano mai da soli: sono scritti a mano).
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compileFpel } from './userFunctions'
import type { DecodeTable } from './decodeTables'

/** `tables` (facoltativo): tabelle di decodifica del progetto per quel caso (P390). */
interface Caso { expr: string; tables?: DecodeTable[]; ir?: unknown; row: Record<string, unknown>; expect: unknown }

const file = join(process.cwd(), 'vectors', 'fpel_v1.json')
const vettore = JSON.parse(readFileSync(file, 'utf8')) as { formatVersion: number; casi: Caso[] }
const aggiorna = !!process.env.FLOWPILOT_AGGIORNA_VETTORI
let pass = 0, fail = 0

for (const c of vettore.casi) {
  let ir: unknown
  try { ir = compileFpel(c.expr, { userFunctions: [], decodeTables: c.tables ?? [] }) } catch (e) {
    fail++; console.log(`  FAIL ${c.expr} → errore: ${(e as Error).message}`); continue
  }
  if (aggiorna) { c.ir = ir; pass++; continue }
  if (JSON.stringify(ir) === JSON.stringify(c.ir)) { pass++; console.log(`  ok   ${c.expr}`) }
  else { fail++; console.log(`  FAIL ${c.expr}\n       atteso  ${JSON.stringify(c.ir)}\n       ottenuto ${JSON.stringify(ir)}`) }
}

if (aggiorna) {
  writeFileSync(file, JSON.stringify(vettore, null, 2) + '\n')
  console.log('alberi rigenerati in vectors/fpel_v1.json: controlla il diff')
}
console.log(`\n=== ${pass} passati, ${fail} falliti ===`)
process.exit(fail > 0 ? 1 : 0)
