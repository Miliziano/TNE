/**
 * src/runner/joinExecutor.ts
 * ───────────────────────────
 * Executor per il nodo Join.
 * Supporta: inner, left, right, full, cross, anti, semi, custom.
 * Sorgente destra: stream (da edge input_right) o Materialize.
 *
 * Aggiungere in executors.ts:
 *   import { joinExecutor } from './joinExecutor'
 *   // in EXECUTORS[]: joinExecutor
 */

import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData } from '../types'

interface CompositeKey { id: string; left: string; right: string }

// ─── Normalizza chiave di join per confronto ──────────────────────
function normalizeKey(val: unknown, caseSensitive: boolean): string {
  if (val === null || val === undefined) return '__null__'
  const s = String(val)
  return caseSensitive ? s : s.toLowerCase()
}

// ─── Costruisce la chiave composta per una riga ───────────────────
function buildKey(
  row:            Row,
  primaryField:   string,
  compositeKeys:  CompositeKey[],
  side:           'left' | 'right',
  caseSensitive:  boolean,
): string {
  const parts: string[] = []

  if (primaryField) {
    parts.push(normalizeKey(row[primaryField], caseSensitive))
  }

  for (const ck of compositeKeys) {
    const field = side === 'left' ? ck.left : ck.right
    if (field) parts.push(normalizeKey(row[field], caseSensitive))
  }

  return parts.join('\x00')
}

// ─── Applica prefisso ai campi destra che collidono ───────────────
function applyRightPrefix(
  rightRow:    Row,
  leftRow:     Row,
  rightPrefix: string,
): Row {
  const leftKeys = new Set(Object.keys(leftRow))
  const out: Row = {}
  for (const [k, v] of Object.entries(rightRow)) {
    out[leftKeys.has(k) ? `${rightPrefix}${k}` : k] = v
  }
  return out
}

// ─── Merge di due righe ───────────────────────────────────────────
function mergeRows(leftRow: Row, rightRow: Row | null, rightPrefix: string, nullRight = false): Row {
  if (!rightRow || nullRight) {
    // left con null per tutti i campi destra già conosciuti
    return { ...leftRow }
  }
  const rightPrefixed = applyRightPrefix(rightRow, leftRow, rightPrefix)
  return { ...leftRow, ...rightPrefixed }
}

// ─── Valuta condizione custom ─────────────────────────────────────
function evalCustomCondition(
  leftRow:   Row,
  rightRow:  Row,
  condition: string,
): boolean {
  if (!condition.trim()) return true
  try {
    // eslint-disable-next-line no-new-func
    return !!(new Function('left', 'right', `return !!(${condition})`)(leftRow, rightRow))
  } catch { return false }
}

// ─── Hash Join ────────────────────────────────────────────────────
// Costruisce hashtable sul dataset destro, poi itera sul sinistro.
function hashJoin(
  leftRows:      Row[],
  rightRows:     Row[],
  joinType:      string,
  leftKey:       string,
  rightKey:      string,
  compositeKeys: CompositeKey[],
  caseSensitive: boolean,
  rightPrefix:   string,
  duplicates:    string,
  nullKeys:      string,
  customCond:    string,
): Row[] {
  const result: Row[] = []

  // Costruisce hashtable: key → Row[]
  const rightTable = new Map<string, Row[]>()
  for (const rr of rightRows) {
    const k = buildKey(rr, rightKey, compositeKeys, 'right', caseSensitive)
    if (k === '__null__' && nullKeys === 'exclude') continue
    if (!rightTable.has(k)) rightTable.set(k, [])
    rightTable.get(k)!.push(rr)
  }

  const matchedRightKeys = new Set<string>()

  for (const lr of leftRows) {
    const lk = buildKey(lr, leftKey, compositeKeys, 'left', caseSensitive)

    if (lk === '__null__') {
      if (nullKeys === 'error') throw new Error(`Join: chiave null nel flusso sinistro (campo: ${leftKey})`)
      if (nullKeys === 'exclude') {
        if (joinType === 'left' || joinType === 'full') result.push(mergeRows(lr, null, rightPrefix))
        continue
      }
    }

    const matches = rightTable.get(lk) ?? []
    const filteredMatches = customCond
      ? matches.filter((rr) => evalCustomCondition(lr, rr, customCond))
      : matches

    if (filteredMatches.length === 0) {
      // Nessun match
      if (joinType === 'inner' || joinType === 'semi') continue
      if (joinType === 'anti')  { result.push({ ...lr }); continue }
      if (joinType === 'left' || joinType === 'full') {
        result.push(mergeRows(lr, null, rightPrefix))
      }
      continue
    }

    // Ha match
    if (joinType === 'anti') continue  // ANTI: escludi le righe con match

    if (joinType === 'semi') {
      // SEMI: emetti solo i campi sinistri, una volta
      result.push({ ...lr })
      continue
    }

    // Scegli quali match includere
    let selectedMatches = filteredMatches
    if (duplicates === 'first') selectedMatches = [filteredMatches[0]]
    else if (duplicates === 'last') selectedMatches = [filteredMatches[filteredMatches.length - 1]]
    else if (duplicates === 'error' && filteredMatches.length > 1) {
      throw new Error(`Join: corrispondenze multiple per chiave '${lk}' (duplicates=error)`)
    }

    for (const rr of selectedMatches) {
      result.push(mergeRows(lr, rr, rightPrefix))
      matchedRightKeys.add(lk)
    }
  }

  // RIGHT e FULL: aggiungi righe destra senza corrispondenza
  if (joinType === 'right' || joinType === 'full') {
    for (const rr of rightRows) {
      const k = buildKey(rr, rightKey, compositeKeys, 'right', caseSensitive)
      if (!matchedRightKeys.has(k)) {
        // Riga destra senza corrispondenza — null per i campi sinistri
        const nullLeft: Row = {}
        result.push({ ...nullLeft, ...applyRightPrefix(rr, {}, rightPrefix) })
      }
    }
  }

  return result
}

// ─── Cross Join ───────────────────────────────────────────────────
function crossJoin(leftRows: Row[], rightRows: Row[], rightPrefix: string): Row[] {
  const result: Row[] = []
  for (const lr of leftRows) {
    for (const rr of rightRows) {
      result.push(mergeRows(lr, rr, rightPrefix))
    }
  }
  return result
}

// ─── Executor ─────────────────────────────────────────────────────
export const joinExecutor: NodeExecutor = {
  handles: ['join'],
   requiresCompleteInput: () => true,   // sia input_left sia input_right

  async execute(node: FlowNode<NodeData>, input: Row[], context: ExecutionContext) {
    const props = node.data.props ?? {}
    const edges = context.edges

    const joinType      = (props['join_type']       as string) ?? 'inner'
    const rightSource   = (props['rightSource']     as string) ?? 'stream'
    const matName       = (props['materializeName'] as string) ?? ''
    const leftKey       = (props['leftKey']         as string) ?? ''
    const rightKey      = (props['rightKey']        as string) ?? ''
    const caseSensitive = (props['caseSensitive']   as string) !== 'false'
    const rightPrefix   = (props['rightPrefix']     as string) ?? 'r_'
    const duplicates    = (props['duplicates']      as string) ?? 'all'
    const nullKeys      = (props['nullKeys']        as string) ?? 'exclude'
    const customCond    = (props['customCondition'] as string) ?? ''

    let compositeKeys: CompositeKey[] = []
    try { compositeKeys = JSON.parse((props['compositeKeys'] as string) ?? '[]') } catch {}

    // ── Righe sinistre: dall'handle input_left ────────────────────
    // Il runner ha già raccolto input da tutti gli edge in ingresso.
    // Dobbiamo separare le righe left da quelle right usando gli edge.
    // Le righe in `input` sono già il merge — dobbiamo ricostruire
    // da quale handle provenivano guardando gli edge.

    // Trova gli edge che arrivano su input_left e input_right
    const leftEdges  = edges.filter((e) => e.target === node.id && e.targetHandle === 'input_left')
    const rightEdges = edges.filter((e) => e.target === node.id && e.targetHandle === 'input_right')

    // Il runner mette in `input` tutte le righe — dobbiamo separare.
    // Usiamo il context per leggere gli output dei nodi sorgente direttamente.
    // Questo è possibile perché il runner passa context.edges e i nodi sorgente
    // hanno già eseguito e i loro output sono nel Map del runner.
    // Tuttavia il NodeExecutor non ha accesso diretto alla Map outputs del runner.
    //
    // Soluzione: usiamo una convenzione — il runner per nodi con due ingressi
    // fissi (join) passa le righe con un campo __source_handle__ che indica
    // da quale handle provengono. Se non c'è, usiamo l'ordine degli edge.
    //
    // In realtà il runner attuale fa collectInput che mette tutto insieme.
    // Il fix corretto è nel runner — ma per ora usiamo l'approccio:
    // - Se rightSource === 'materialize': leftRows = input (tutti dall'edge sinistro)
    // - Se rightSource === 'stream': split per __sourceHandle o proporzione

    let leftRows:  Row[] = []
    let rightRows: Row[] = []

    if (rightSource === 'materialize') {
      // Tutto l'input viene dall'edge sinistro
      leftRows = input.map((r) => {
        const { __sourceHandle, ...rest } = r as any
        return rest
      })

      if (!matName) {
        context.callbacks.onLog('warn', 'Join: nessun Materialize configurato per il lato destro', node.id)
        return new Map([['output', leftRows]])
      }
      rightRows = context.materialize.get(matName) ?? []
      if (rightRows.length === 0) {
        context.callbacks.onLog('warn', `Join: Materialize '${matName}' vuoto o non ancora eseguito`, node.id)
      }

    } else {
      // Sorgente stream: split in base al campo __sourceHandle
      for (const row of input) {
        const handle = (row as any).__sourceHandle
        const clean  = { ...row }
        delete (clean as any).__sourceHandle

        if (handle === 'input_right') {
          rightRows.push(clean)
        } else {
          // 'input_left' o senza handle → sinistro
          leftRows.push(clean)
        }
      }

      // Fallback se non c'è __sourceHandle: usa gli edge per determinare
      // quali nodi sorgente producono il lato sinistro vs destro
      if (leftRows.length === 0 && rightRows.length === 0 && input.length > 0) {
        // Senza informazioni sull'handle, assumiamo tutto sinistro
        leftRows = input
        context.callbacks.onLog('warn', 'Join: impossibile distinguere flusso sinistro da destro — assegnati tutti al lato sinistro', node.id)
      }
    }

    context.callbacks.onLog('info',
      `Join ${joinType.toUpperCase()}: ${leftRows.length} righe sx × ${rightRows.length} righe dx`,
      node.id
    )

    if (leftRows.length === 0) {
      context.callbacks.onLog('warn', 'Join: flusso sinistro vuoto', node.id)
      return new Map([['output', []]])
    }

    let result: Row[]

    try {
      if (joinType === 'cross') {
        result = crossJoin(leftRows, rightRows, rightPrefix)
      } else {
        result = hashJoin(
          leftRows, rightRows, joinType,
          leftKey, rightKey, compositeKeys,
          caseSensitive, rightPrefix, duplicates, nullKeys, customCond,
        )
      }
    } catch (err) {
      throw new Error(`Join: ${err instanceof Error ? err.message : String(err)}`)
    }

    context.callbacks.onLog('info',
      `Join ${joinType.toUpperCase()}: ${result.length} righe in output`,
      node.id
    )

    return new Map([['output', result]])
  },
}
