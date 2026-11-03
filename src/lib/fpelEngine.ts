/**
 * src/lib/fpelEngine.ts
 *
 * Chiamate allo studio→motore per FPEL (P391): il calcolo di un'espressione su
 * una riga, pezzo per pezzo ("spiega questo valore"), e la verifica degli
 * ESEMPI delle funzioni utente. A calcolare è sempre il valutatore del motore,
 * lo stesso dei run: lo studio non ha un secondo valutatore che potrebbe dare
 * un risultato diverso.
 */
import { invoke } from '@tauri-apps/api/core'
import type { ExprNode } from '../ir/exprParser'
import type { Spiegazione } from '../ir/exprText'
import { parseUserFunctions, type UserFunctionExample } from '../ir/userFunctions'
import { isTauri } from './tauri'

/** Calcolo di `expr` sulle righe date (`{ row: {...} }` per un ingresso). */
export async function spiegaValore(
  expr: ExprNode, inputs: Record<string, unknown>, variables?: Record<string, unknown>, mainInput?: string,
): Promise<Spiegazione> {
  const res = await invoke<string>('fpel_explain', {
    exprJson: JSON.stringify(expr),
    inputsJson: JSON.stringify(inputs),
    variablesJson: variables ? JSON.stringify(variables) : null,
    mainInput: mainInput ?? null,
  })
  return JSON.parse(res) as Spiegazione
}

export interface EsitoEsempio {
  text: string
  ok:   boolean
  /** per un esempio `a == b`: quanto vale davvero `a` (e quanto `b`) */
  ottenuto?: unknown
  atteso?:   unknown
  errore?:   string
}

/** Verifica gli esempi: ognuno deve valere `true`. */
export async function verificaEsempi(examples: UserFunctionExample[]): Promise<EsitoEsempio[]> {
  const out: EsitoEsempio[] = []
  for (const ex of examples) {
    try {
      const s = await spiegaValore(ex.ast, {})
      const esito: EsitoEsempio = { text: ex.text, ok: s.v === true }
      if (ex.ast.kind === 'BinaryOp' && ex.ast.op === 'EQ') {
        esito.ottenuto = s.c[0]?.v
        esito.atteso = s.c[1]?.v
      }
      out.push(esito)
    } catch (e) {
      out.push({ text: ex.text, ok: false, errore: e instanceof Error ? e.message : String(e) })
    }
  }
  return out
}

/** Una riga leggibile per un esempio che non torna. */
export function descriviEsito(e: EsitoEsempio): string {
  if (e.errore) return `${e.text} — ${e.errore}`
  if ('ottenuto' in e) return `${e.text} — gives ${JSON.stringify(e.ottenuto)}, expected ${JSON.stringify(e.atteso)}`
  return `${e.text} — is not true`
}

/**
 * Esempi del progetto che NON tornano (vuoto = tutto bene, o nessun esempio).
 * Per il Run e la compilazione: fuori dall'app desktop non c'è il motore e si
 * salta (lo dice `motore`).
 */
export async function esempiFalliti(defs: string[]): Promise<{ motore: boolean; falliti: string[] }> {
  if (!isTauri()) return { motore: false, falliti: [] }
  const { examples } = parseUserFunctions(defs)
  if (!examples.length) return { motore: true, falliti: [] }
  const esiti = await verificaEsempi(examples)
  return { motore: true, falliti: esiti.filter((e) => !e.ok).map(descriviEsito) }
}
