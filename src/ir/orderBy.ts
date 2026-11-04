/**
 * src/ir/orderBy.ts
 *
 * ORDER BY su più campi (P398) — la stessa lettura del motore
 * (src-tauri/src/engine/ordinamento.rs): "campo [ASC|DESC], …". Un campo senza
 * direzione prende `predefinita` (il vecchio menu Direction della Window).
 */
export interface ChiaveOrdine { campo: string; desc: boolean }

export function leggiOrderBy(testo: string, predefinita = 'asc'): ChiaveOrdine[] {
  const predDesc = predefinita.trim().toLowerCase() === 'desc'
  return testo.split(',').map((parte) => parte.trim()).filter(Boolean).flatMap((p) => {
    const m = /^(.*?)[ \t]+(asc|desc)$/i.exec(p)
    let nome = (m ? m[1] : p).trim()
    const desc = m ? m[2].toLowerCase() === 'desc' : predDesc
    const q = /^(["'`])(.*)\1$/.exec(nome)
    if (q) nome = q[2]
    return nome ? [{ campo: nome, desc }] : []
  })
}

export function scriviOrderBy(chiavi: ChiaveOrdine[]): string {
  return chiavi.filter((k) => k.campo.trim()).map((k) => `${k.campo.trim()} ${k.desc ? 'DESC' : 'ASC'}`).join(', ')
}
