/**
 * src/nodes/types/join/schema.ts
 *
 * Schema d'uscita del Join (P365) — la stessa regola del motore
 * (src-tauri/src/engine/nodes/join.rs): i campi sinistri, poi i destri; un
 * campo destro con lo stesso nome di uno sinistro prende il prefisso.
 * ANTI e SEMI: solo i campi sinistri.
 */
export interface JoinField { name: string; type: string }

export interface JoinOutField extends JoinField { side: 'left' | 'right'; physicalName: string }

export function joinOutputFields(left: JoinField[], right: JoinField[], joinType: string, prefix: string): JoinOutField[] {
  const leftNames = new Set(left.map((f) => f.name))
  const out: JoinOutField[] = left.map((f) => ({ name: f.name, type: f.type, side: 'left', physicalName: f.name }))
  if (joinType === 'anti' || joinType === 'semi') return out
  for (const f of right) {
    out.push({ name: leftNames.has(f.name) ? `${prefix}${f.name}` : f.name, type: f.type, side: 'right', physicalName: f.name })
  }
  return out
}
