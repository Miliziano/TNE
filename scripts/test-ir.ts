/**
 * scripts/test-ir.ts — lancia tutti i test di src/ir (`npm run test:ir`).
 * Ogni file è uno script autonomo che esce con 1 se qualcosa fallisce.
 */
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

const dir   = join(process.cwd(), 'src', 'ir')
const files = readdirSync(dir).filter((f) => f.endsWith('.test.ts')).sort()
const failed: string[] = []
for (const f of files) {
  const r = spawnSync(process.execPath, ['--import', 'tsx', join(dir, f)], { encoding: 'utf8' })
  const lines = (r.stdout ?? '').trim().split('\n')
  console.log(`${r.status === 0 ? 'ok  ' : 'FAIL'} ${f} — ${lines[lines.length - 1] ?? ''}`)
  if (r.status !== 0) {
    failed.push(f)
    console.log(lines.filter((l) => /FAIL/.test(l)).join('\n'))
    if (r.stderr) console.log(r.stderr)
  }
}
console.log(failed.length ? `\n${failed.length} file(s) failed` : `\nall ${files.length} files passed`)
process.exit(failed.length ? 1 : 0)
