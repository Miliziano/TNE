/**
 * src/ir/serializerTree.ts
 *
 * Alberi dei Serializer JSON e XML (P373/P374): `expr` e `condition` dei
 * nodi sono FPEL e il builder li compila in `exprIr` / `conditionIr`.
 * Prima erano JavaScript che il motore non eseguiva (expr → null,
 * condition → sempre vera). Campi nudi = il flusso del nodo; un altro
 * flusso si legge come `flusso.campo`; il vecchio `row.campo` vale `campo`.
 */
import { compileFpel, type UserFunction } from './userFunctions'
import { ExprParseError, riferimentoInput } from './exprParser'
import { stripRowPrefix } from '../nodes/types/tmap/joinKey'

type AnyNode = Record<string, any> & { children?: AnyNode[] }

/** Gli handle citati dall'albero (più quelli noti dalla config). */
function collectHandles(tree: AnyNode[], known: string[]): Set<string> {
  const handles = new Set<string>(known)
  const walk = (ns: AnyNode[]) => ns.forEach((n) => {
    if (n.sourceHandle) handles.add(n.sourceHandle)
    ;(n.sources ?? []).forEach((x: any) => x?.handle && handles.add(x.handle))
    if (n.iterHandle) handles.add(n.iterHandle)
    walk(n.children ?? [])
  })
  walk(tree)
  return handles
}

/** L'albero con `exprIr` / `conditionIr` compilati. `nameOf` dà il nome
 *  del nodo per i messaggi d'errore. */
export function compileSerializerTree(
  tree:      AnyNode[],
  known:     string[],
  where:     string,
  nameOf:    (n: AnyNode) => string,
  userFns:   UserFunction[],
): AnyNode[] {
  const labelToInputId = new Map([...collectHandles(tree, known)].map((h) => [h, h] as [string, string]))
  const compileNode = (n: AnyNode, path: string): AnyNode => {
    const comp = (src: string | undefined, what: string) => {
      const t = stripRowPrefix((src ?? '').trim())
      if (!t) return undefined
      try { return compileFpel(t, { labelToInputId, userFunctions: userFns }) }
      catch (e) {
        const d = e instanceof ExprParseError ? e.pretty() : String(e)
        throw new Error(`${where}, "${path}", ${what}:\n${d}`, { cause: e })
      }
    }
    return {
      ...n,
      exprIr:      comp(n.expr, 'expression'),
      conditionIr: comp(n.condition, 'condition'),
      children:    (n.children ?? []).map((c) => compileNode(c, `${path}/${nameOf(c)}`)),
    }
  }
  return tree.map((n) => compileNode(n, nameOf(n)))
}

/** Espressione FPEL che unisce più campi trascinati su un nodo (prima
 *  JavaScript `row.a + ' ' + row.b`, mai eseguito). Il primo flusso è
 *  quello del nodo: i suoi campi vanno nudi. */
export function joinSourcesFpel(sources: Array<{ handle: string; field: string }>): string {
  const own = sources[0]?.handle
  return sources
    .map((s) => (s.handle === own ? s.field : `${riferimentoInput(s.handle)}.${s.field}`))
    .join(' + " " + ')
}
