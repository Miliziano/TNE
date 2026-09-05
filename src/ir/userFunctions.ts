/**
 * src/ir/userFunctions.ts
 *
 * FUNZIONI UTENTE FPEL — definite nel progetto, espanse a COMPILE-TIME.
 *
 * Fatto architetturale: FPEL si compila nello studio (parser → AST) e il motore
 * riceve solo alberi. Una funzione utente `funzione iva(a, b) { ritorna a * b /
 * 100 }` viene INLINATA: ogni chiamata `iva(x, 22)` diventa l'albero del corpo
 * con i parametri sostituiti dagli argomenti ⇒ ZERO modifiche al motore Rust.
 *
 * Vincoli (dalla nota di progettazione):
 *  - corpo = UNA sola espressione;
 *  - niente ricorsione (nemmeno indiretta);
 *  - vietato ombreggiare le funzioni predefinite;
 *  - nel corpo un nome nudo è SEMPRE un parametro (nessun campo libero).
 *
 * Ogni nodo inlinato conserva l'ORIGINE (`_origin`) per distinguere, in
 * validazione, un errore SULLA CHIAMATA da uno DENTRO la funzione.
 */
import { parseExpression, ExprParseError, type ExprNode } from './exprParser'
import { canonicalName } from './functions'

export interface UserFunction {
  name:   string        // minuscolo
  params: string[]      // nomi dei parametri, in ordine
  body:   ExprNode      // AST del corpo (i parametri vi compaiono come DirectFieldRef)
}

export interface ExprOrigin { fn: string }
type WithOrigin = ExprNode & { _origin?: ExprOrigin }

/** Origine (funzione da cui un nodo è stato inlinato), se presente. */
export function originOf(node: ExprNode): ExprOrigin | undefined {
  return (node as WithOrigin)._origin
}

// ── Parsing delle definizioni ─────────────────────────────────────

const DEF_RE = /^\s*(?:function|funzione)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(([^)]*)\)\s*\{\s*(?:return|ritorna)\s+([\s\S]+?)\s*\}\s*$/i

export interface ParsedFunctions {
  functions: UserFunction[]
  errors:    Array<{ name?: string; message: string }>
}

/**
 * Legge un insieme di definizioni (una per stringa). Due passate: prima le
 * intestazioni (nome + parametri → arità), poi i corpi con TUTTE le funzioni in
 * scope (così una funzione può chiamarne un'altra). Valida i vincoli.
 */
export function parseUserFunctions(defs: string[]): ParsedFunctions {
  const errors: ParsedFunctions['errors'] = []

  // Passata 1: intestazioni
  type Head = { name: string; params: string[]; bodyText: string }
  const heads: Head[] = []
  for (const raw of defs) {
    if (!raw.trim()) continue
    const m = DEF_RE.exec(raw)
    if (!m) {
      errors.push({ message: `definizione non valida: "${raw.trim().slice(0, 40)}…" — attesa la forma «function name(par) { return expression }»` })
      continue
    }
    heads.push({
      name:     m[1].toLowerCase(),
      params:   m[2].trim() ? m[2].split(',').map((s) => s.trim()) : [],
      bodyText: m[3],
    })
  }

  // Validazione intestazioni: ombreggiamento, duplicati, parametri
  const arity = new Map<string, number>()
  const seen  = new Set<string>()
  for (const h of heads) {
    if (canonicalName(h.name)) { errors.push({ name: h.name, message: `"${h.name}" è una funzione predefinita: non si può ridefinire` }); continue }
    if (seen.has(h.name))      { errors.push({ name: h.name, message: `funzione "${h.name}" definita più volte` }); continue }
    let paramOk = true
    for (const p of h.params) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p)) { errors.push({ name: h.name, message: `parametro non valido in "${h.name}": "${p}"` }); paramOk = false }
    }
    if (new Set(h.params).size !== h.params.length) { errors.push({ name: h.name, message: `parametri duplicati in "${h.name}"` }); paramOk = false }
    if (!paramOk) continue
    seen.add(h.name)
    arity.set(h.name, h.params.length)
  }

  // Passata 2: corpi (con tutte le funzioni utente in scope)
  const functions: UserFunction[] = []
  for (const h of heads) {
    if (!arity.has(h.name)) continue   // scartata sopra
    let body: ExprNode
    try {
      body = parseExpression(h.bodyText, { userFunctions: arity })
    } catch (e) {
      errors.push({ name: h.name, message: `corpo di "${h.name}": ${e instanceof ExprParseError ? e.message : String(e)}` })
      continue
    }
    const free = freeReferences(body, new Set(h.params))
    if (free.length) { errors.push({ name: h.name, message: `"${h.name}" usa nomi che non sono suoi parametri: ${free.join(', ')} — il corpo può usare solo i parametri` }); continue }
    functions.push({ name: h.name, params: h.params, body })
  }

  // Vincolo: niente ricorsione (grafo delle chiamate aciclico)
  const cyc = findCycle(functions)
  if (cyc) errors.push({ message: `ricorsione non ammessa: ${cyc.join(' → ')}` })

  return { functions, errors }
}

/** Nomi (nudi o qualificati) usati nel corpo che NON sono parametri. */
function freeReferences(node: ExprNode, params: Set<string>): string[] {
  const found = new Set<string>()
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'DirectFieldRef': if (!params.has(n.field)) found.add(n.field); break
      case 'FieldRef':       found.add(`${n.input}.${n.field}`); break
      case 'BinaryOp':       walk(n.left); walk(n.right); break
      case 'UnaryOp':        walk(n.expr); break
      case 'IsNull': case 'IsNotNull': walk(n.expr); break
      case 'Cast':           walk(n.expr); break
      case 'FunctionCall':   n.args.forEach(walk); break
      case 'Coalesce':       n.args.forEach(walk); break
      case 'CaseWhen':       n.branches.forEach((b) => { walk(b.condition); walk(b.value) }); if (n.default) walk(n.default); break
      case 'Literal':        break
    }
  }
  walk(node)
  return [...found]
}

/** Chiamate ad altre funzioni utente presenti nel corpo di `f`. */
function userCallsIn(f: UserFunction, byName: Map<string, UserFunction>): string[] {
  const out = new Set<string>()
  const walk = (n: ExprNode): void => {
    switch (n.kind) {
      case 'FunctionCall': if (byName.has(n.name)) out.add(n.name); n.args.forEach(walk); break
      case 'Coalesce':     n.args.forEach(walk); break
      case 'BinaryOp':     walk(n.left); walk(n.right); break
      case 'UnaryOp': case 'IsNull': case 'IsNotNull': case 'Cast': walk(n.expr); break
      case 'CaseWhen':     n.branches.forEach((b) => { walk(b.condition); walk(b.value) }); if (n.default) walk(n.default); break
    }
  }
  walk(f.body)
  return [...out]
}

/** Trova un ciclo nel grafo delle chiamate fra funzioni utente (DFS con stati). */
function findCycle(fns: UserFunction[]): string[] | null {
  const byName = new Map(fns.map((f) => [f.name, f]))
  const state  = new Map<string, 1 | 2>()   // 1 = in corso, 2 = fatto
  const path: string[] = []
  const dfs = (name: string): string[] | null => {
    state.set(name, 1); path.push(name)
    const f = byName.get(name)
    if (f) for (const c of userCallsIn(f, byName)) {
      if (state.get(c) === 1) return [...path.slice(path.indexOf(c)), c]
      if (state.get(c) !== 2) { const r = dfs(c); if (r) return r }
    }
    path.pop(); state.set(name, 2)
    return null
  }
  for (const f of fns) if (state.get(f.name) !== 2) { const r = dfs(f.name); if (r) return r }
  return null
}

// ── Espansione a compile-time ─────────────────────────────────────

/**
 * Espande le chiamate a funzioni utente in `ast`, inlinando i corpi coi
 * parametri sostituiti dagli argomenti. Gli argomenti sono espansi PRIMA (così
 * una funzione può ricevere il risultato di un'altra). I nodi inlinati portano
 * `_origin` col nome della funzione (l'origine più interna vince).
 */
export function expandUserFunctions(ast: ExprNode, fns: Map<string, UserFunction>): ExprNode {
  const go = (node: ExprNode): ExprNode => {
    switch (node.kind) {
      case 'FunctionCall': {
        const args = node.args.map(go)
        const fn = fns.get(node.name)
        if (!fn) return { ...node, args }
        const map: Record<string, ExprNode> = {}
        fn.params.forEach((p, i) => { map[p] = args[i] })
        const inlined  = substitute(clone(fn.body), map)
        const expanded = go(inlined)              // espande le chiamate annidate nel corpo
        return tagAll(expanded, fn.name)
      }
      case 'Coalesce':  return { ...node, args: node.args.map(go) }
      case 'BinaryOp':  return { ...node, left: go(node.left), right: go(node.right) }
      case 'UnaryOp':   return { ...node, expr: go(node.expr) }
      case 'IsNull': case 'IsNotNull': return { ...node, expr: go(node.expr) }
      case 'Cast':      return { ...node, expr: go(node.expr) }
      case 'CaseWhen':  return {
        ...node,
        branches: node.branches.map((b) => ({ condition: go(b.condition), value: go(b.value) })),
        default:  node.default ? go(node.default) : null,
      }
      default:          return node   // Literal, FieldRef, DirectFieldRef
    }
  }
  return go(ast)
}

/** Sostituisce, in un corpo clonato, i DirectFieldRef dei parametri con gli argomenti. */
function substitute(node: ExprNode, map: Record<string, ExprNode>): ExprNode {
  switch (node.kind) {
    case 'DirectFieldRef': return node.field in map ? clone(map[node.field]) : node
    case 'BinaryOp':  return { ...node, left: substitute(node.left, map), right: substitute(node.right, map) }
    case 'UnaryOp':   return { ...node, expr: substitute(node.expr, map) }
    case 'IsNull': case 'IsNotNull': return { ...node, expr: substitute(node.expr, map) }
    case 'Cast':      return { ...node, expr: substitute(node.expr, map) }
    case 'FunctionCall': return { ...node, args: node.args.map((a) => substitute(a, map)) }
    case 'Coalesce':  return { ...node, args: node.args.map((a) => substitute(a, map)) }
    case 'CaseWhen':  return {
      ...node,
      branches: node.branches.map((b) => ({ condition: substitute(b.condition, map), value: substitute(b.value, map) })),
      default:  node.default ? substitute(node.default, map) : null,
    }
    default:          return node
  }
}

function clone(node: ExprNode): ExprNode {
  return JSON.parse(JSON.stringify(node))
}

// ── Registro delle funzioni ATTIVE del progetto ──────────────────
// La "tabella dei simboli" FPEL. Lo store la aggiorna quando
// pool.userFunctions cambia; compileFpel la usa come default, così le
// funzioni valgono in OGNI contesto di parsing (script, propagazione
// schema, validazione) senza infilarle a mano nei chiamanti puri.
let ACTIVE: UserFunction[] = []
export function setActiveUserFunctions(defs: string[]): void {
  ACTIVE = parseUserFunctions(defs).functions
}
export function activeUserFunctions(): UserFunction[] { return ACTIVE }

/**
 * Punto UNICO parse+espansione per i convertitori: parsa `src` con le funzioni
 * utente in scope (così le chiamate parsano), le inlina, e TOGLIE `_origin`
 * dall'albero che va al motore. Se non ci sono funzioni utente, è un semplice
 * parseExpression.
 */
export function compileFpel(
  src: string,
  opts: { labelToInputId?: Map<string, string>; userFunctions?: UserFunction[] } = {},
): ExprNode {
  const fns   = opts.userFunctions ?? activeUserFunctions()
  const arity = fns.length ? new Map(fns.map((f) => [f.name, f.params.length])) : undefined
  const ast   = parseExpression(src, { labelToInputId: opts.labelToInputId, userFunctions: arity })
  if (!fns.length) return ast
  const map = new Map(fns.map((f) => [f.name, f]))
  return stripOrigin(expandUserFunctions(ast, map))
}

/** Rimuove `_origin` da tutto l'albero: l'origine serve solo alla diagnostica
 *  dello studio, il motore non deve vederla. */
export function stripOrigin(node: ExprNode): ExprNode {
  delete (node as WithOrigin)._origin
  switch (node.kind) {
    case 'BinaryOp':  stripOrigin(node.left); stripOrigin(node.right); break
    case 'UnaryOp': case 'IsNull': case 'IsNotNull': case 'Cast': stripOrigin(node.expr); break
    case 'FunctionCall': case 'Coalesce': node.args.forEach(stripOrigin); break
    case 'CaseWhen':  node.branches.forEach((b) => { stripOrigin(b.condition); stripOrigin(b.value) }); if (node.default) stripOrigin(node.default); break
  }
  return node
}

/** Marca ogni nodo privo di origine con `fn` (l'origine più interna, già posta, vince). */
function tagAll(node: ExprNode, fn: string): ExprNode {
  if (!(node as WithOrigin)._origin) (node as WithOrigin)._origin = { fn }
  switch (node.kind) {
    case 'BinaryOp':  tagAll(node.left, fn); tagAll(node.right, fn); break
    case 'UnaryOp': case 'IsNull': case 'IsNotNull': case 'Cast': tagAll(node.expr, fn); break
    case 'FunctionCall': case 'Coalesce': node.args.forEach((a) => tagAll(a, fn)); break
    case 'CaseWhen':  node.branches.forEach((b) => { tagAll(b.condition, fn); tagAll(b.value, fn) }); if (node.default) tagAll(node.default, fn); break
  }
  return node
}
