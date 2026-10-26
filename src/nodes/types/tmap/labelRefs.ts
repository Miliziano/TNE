/**
 * src/nodes/types/tmap/labelRefs.ts
 *
 * Riferimenti agli ingressi del TMap dentro le espressioni FPEL (P371).
 * Un campo di un ingresso si scrive `Etichetta.campo`, o `"Etichetta con
 * spazi".campo`. Prima rinomina e rimozione cercavano ancora la vecchia
 * forma `$Etichetta.campo`: rinominando un ingresso le trasformazioni
 * restavano con l'etichetta vecchia (Run fermo: ingresso sconosciuto), e
 * togliendo un campo da una trasformazione l'espressione veniva riscritta
 * in quella forma, che FPEL rifiuta.
 */
import { riferimentoInput } from '../../../ir/exprParser'

const IDENT = /^[\p{L}_][\p{L}\p{N}_]*$/u

/** `Etichetta.campo` nella forma FPEL. */
export function inputFieldRef(label: string, field: string): string {
  return `${riferimentoInput(label)}.${IDENT.test(field) ? field : `\`${field}\``}`
}

/** Sostituisce l'etichetta di un ingresso in un'espressione: forma nuda e
 *  forma fra virgolette, solo dove è seguita da un punto; il testo delle
 *  stringhe resta com'è. */
export function renameInputLabel(expr: string, oldLabel: string, newLabel: string): string {
  if (!expr || !oldLabel || !newLabel || oldLabel === newLabel) return expr
  const newRef = riferimentoInput(newLabel)
  let out = ''
  let i = 0
  let plain = ''
  const flushPlain = () => {
    if (!plain) return
    if (IDENT.test(oldLabel)) {
      const esc = oldLabel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      plain = plain.replace(new RegExp(`(^|[^\\p{L}\\p{N}_.$\`])${esc}(?=\\.)`, 'gu'), (_m, pre) => pre + newRef)
    }
    out += plain
    plain = ''
  }
  while (i < expr.length) {
    const c = expr[i]
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1
      while (j < expr.length && expr[j] !== c) j += expr[j] === '\\' ? 2 : 1
      const lit = expr.slice(i, Math.min(j + 1, expr.length))
      flushPlain()
      const inner = lit.slice(1, -1).replace(/\\(.)/g, '$1')
      out += (c === '"' && inner === oldLabel && expr[j + 1] === '.') ? newRef : lit
      i = j + 1
      continue
    }
    plain += c
    i++
  }
  flushPlain()
  return out
}
