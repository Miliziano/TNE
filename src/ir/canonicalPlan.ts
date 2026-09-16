// ─── src/ir/canonicalPlan.ts ──────────────────────────────────────
// FORMA CANONICA DEL PIANO — base della firma/integrità dell'artifact.
// (§4 di HANDOFF-firma-artifact.md)
//
// Deve restare IDENTICA bit-per-bit al gemello Rust
// `src-tauri/src/signing/canonical.rs`. Il vettore condiviso che lo
// garantisce è `vectors/canonical_plan_v1.json`; entrambe le
// implementazioni lo verificano nei rispettivi test.
//
// Regole (v1):
//   1) si toglie `run_id` ALLA RADICE — è l'unico campo volatile del
//      piano (`buildRustPlan` restituisce `{ run_id, lanes, bridges }`,
//      con run_id = `export-<timestamp>`). Senza toglierlo, l'hash
//      cambierebbe a ogni export a piano identico.
//   2) le chiavi degli oggetti si ordinano ricorsivamente (ordine di
//      code point; le chiavi del piano sono identificatori ASCII).
//   3) l'ordine degli ARRAY è semantico e si PRESERVA.
//   4) serializzazione JSON compatta (niente spazi), UTF-8.
//
// Nota v1: si assume che il piano contenga solo interi/stringhe/bool/
// null (nessun float): in tal caso la formattazione dei numeri è
// identica tra JS e Rust. I float sono sconsigliati finché non fissiamo
// una regola numerica condivisa (JCS/RFC 8785).

type Json = null | boolean | number | string | Json[] | { [k: string]: Json }

function sortDeep(v: Json): Json {
  if (Array.isArray(v)) return v.map(sortDeep)
  if (v && typeof v === 'object') {
    const out: { [k: string]: Json } = {}
    for (const k of Object.keys(v).sort()) out[k] = sortDeep((v as { [k: string]: Json })[k])
    return out
  }
  return v
}

/** Stringa canonica del piano (senza `run_id`). */
export function canonicalPlanString(plan: unknown): string {
  const p = { ...(plan as { [k: string]: Json }) }
  delete p.run_id
  return JSON.stringify(sortDeep(p))
}

/** Byte canonici (UTF-8) — quello che si hasha e (in seguito) si firma. */
export function canonicalPlanBytes(plan: unknown): Uint8Array {
  return new TextEncoder().encode(canonicalPlanString(plan))
}

/** planHash = "sha256:" + hex(sha256(byte canonici del piano)). */
export async function planHash(plan: unknown): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', canonicalPlanBytes(plan))
  return 'sha256:' + Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, '0')).join('')
}
