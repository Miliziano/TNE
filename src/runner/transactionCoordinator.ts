/**
 * src/runner/transactionCoordinator.ts
 *
 * Coordinatore per transactionGroup — modalità 'native' (Fase 1) e
 * 'xa' (Fase 2). Vedi TransactionGroupEditor.tsx per la config UI,
 * dagValidation.ts (validateTransactionGroups) per i vincoli già
 * validati a design-time.
 *
 * Stato in ExecutionContext.transactions: Map<"laneId::groupId", state>.
 *
 * ── Modalità 'native' ──────────────────────────────────────────────
 * Connessione condivisa (stessa risorsa per tutti i membri — vincolo
 * TX_NATIVE_RESOURCE_MISMATCH): db_tx_begin/db_tx_write/db_tx_commit
 * /db_tx_rollback su una transazione tenuta aperta in TX_REGISTRY
 * (lato Rust) per tutta la durata del gruppo.
 *
 * ── Modalità 'xa' ───────────────────────────────────────────────────
 * Ogni membro prepara la PROPRIA transazione sulla PROPRIA risorsa
 * (db_tx_xa_prepare: BEGIN/XA START → scritture → PREPARE TRANSACTION
 * / XA PREPARE → connessione chiusa, la transazione preparata persiste
 * nel DB). Quando tutti i membri hanno preparato con successo, il
 * coordinatore chiama db_tx_xa_finish con action='commit' su ciascun
 * partecipante (nuova connessione per ognuno); se anche uno solo ha
 * fallito il prepare, action='rollback' su tutti i preparati.
 *
 * Ciclo comune:
 *  1. ensureGroup()  — al primo membro eseguito, precalcola TUTTI i
 *                      membri del gruppo nella lane.
 *  2. per ogni membro: reportSuccess() / reportFailure() / reportSkipped()
 *     decrementano `remaining`. Quando remaining===0 → finalize().
 *  3. Se un membro fallisce PRIMA che altri abbiano eseguito, il gruppo
 *     viene marcato `aborted` — i membri successivi vedono isAborted()
 *     true e si auto-saltano (reportSkipped).
 *
 * Safety net: runPipeline chiama cleanupAbandoned() nel finally —
 * per 'native' fa rollback di connessioni rimaste aperte; per 'xa' non
 * c'è nulla da chiudere (ogni prepare/finish è già una connessione
 * a sé stante), ma eventuali transazioni preparate e non finalizzate
 * (gruppo abortito a metà) restano "in prepared state" sul DB finché
 * un amministratore non le risolve manualmente (xid loggato per questo).
 */

import { invoke } from '@tauri-apps/api/core'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import type { Row, ExecutionContext } from './types'
import { findErrorHandler } from './errorHandling'

export interface TransactionGroupConfig {
  id:      string
  mode:    'native' | 'xa'
  timeout: number
  onError: 'rollback_all' | 'rollback_self'
}

interface PreparedParticipant {
  nodeId:     string
  nodeType:   string
  connection: unknown
  xid:        string
}

export interface TransactionGroupState {
  mode:      'native' | 'xa'
  members:   string[]   // tutti i nodeId del gruppo nella lane (precalcolato)
  remaining: number
  began:     boolean              // solo 'native'
  prepared:  PreparedParticipant[] // solo 'xa'
  aborted:   boolean
  failure?:  { nodeId: string; nodeType: string; message: string }
}

function groupKey(laneId: string, groupId: string): string {
  return `${laneId}::${groupId}`
}

/** Legge e valida transactionGroup da props — null se assente/non valido. */
export function readTransactionGroup(node: FlowNode<NodeData>): TransactionGroupConfig | null {
  try {
    const raw = node.data.props?.['transactionGroup']
    if (!raw) return null
    const tx = JSON.parse(raw)
    return tx?.id ? tx as TransactionGroupConfig : null
  } catch { return null }
}

/**
 * XID per il prepare XA — deve essere univoco per server/risorsa
 * (più membri dello stesso gruppo possono usare lo stesso server DB,
 * quindi groupId da solo non basta). MySQL limita il gtrid a 64 byte:
 * se "${groupId}::${nodeId}" supera 60 caratteri, usa un hash
 * deterministico per restare entro il limite.
 */
function makeXid(groupId: string, nodeId: string): string {
  const raw = `${groupId}::${nodeId}`
  if (raw.length <= 60) return raw
  let hash = 0
  for (let i = 0; i < raw.length; i++) hash = (hash * 31 + raw.charCodeAt(i)) >>> 0
  return `${groupId.slice(0, 30)}_${hash.toString(16)}`
}

/**
 * Precalcola lo stato del gruppo al primo membro eseguito.
 * Idempotente: se lo stato esiste già, lo restituisce senza modificarlo.
 */
export function ensureGroup(
  context: ExecutionContext,
  laneId:  string,
  tx:      TransactionGroupConfig,
): TransactionGroupState {
  const key = groupKey(laneId, tx.id)
  let state = context.transactions.get(key)
  if (state) return state

  const members = context.nodes
    .filter((n) => {
      if (n.data.laneId !== laneId) return false
      const ntx = readTransactionGroup(n)
      return ntx?.id === tx.id
    })
    .map((n) => n.id)

  state = { mode: tx.mode, members, remaining: members.length, began: false, prepared: [], aborted: false }
  context.transactions.set(key, state)
  return state
}

/** true se un membro precedente ha già fatto fallire il gruppo. */
export function isAborted(context: ExecutionContext, laneId: string, groupId: string): boolean {
  return context.transactions.get(groupKey(laneId, groupId))?.aborted ?? false
}

// ─── Modalità native ────────────────────────────────────────────────

/**
 * Apre la connessione/transazione condivisa (db_tx_begin) — idempotente
 * sia a livello TS (flag `began`) sia lato Rust (idempotente sul txId).
 */
export async function beginTransaction(
  context:    ExecutionContext,
  laneId:     string,
  groupId:    string,
  nodeId:     string,
  nodeType:   string,
  connection: unknown,
): Promise<{ ok: boolean; error?: string }> {
  const state = context.transactions.get(groupKey(laneId, groupId))
  if (!state) return { ok: false, error: 'Gruppo transazionale non inizializzato' }
  if (state.began) return { ok: true }

  try {
    await invoke('db_tx_begin', { request: { txId: groupId, connection } })
    state.began = true
    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await reportFailure(context, laneId, groupId, nodeId, nodeType, `Apertura transazione fallita: ${message}`)
    return { ok: false, error: message }
  }
}

// ─── Modalità XA ────────────────────────────────────────────────────

/**
 * Prepara la transazione XA di questo membro sulla propria risorsa
 * (db_tx_xa_prepare). Se ha successo, registra il partecipante per la
 * fase 2 (finish) e chiama reportSuccess; altrimenti reportFailure.
 *
 * Restituisce il risultato della scrittura (rows_written ecc.) in caso
 * di successo, per costruire l'output del nodo come nel percorso
 * standalone.
 */
export async function prepareXa(
  context:    ExecutionContext,
  laneId:     string,
  groupId:    string,
  nodeId:     string,
  nodeType:   string,
  connection: unknown,
  request:    Record<string, unknown>,
): Promise<{ ok: true; result: any } | { ok: false; error: string }> {
  const xid = makeXid(groupId, nodeId)

  try {
    const result = await invoke('db_tx_xa_prepare', { request: { txId: xid, ...request } })
    const state = context.transactions.get(groupKey(laneId, groupId))
    state?.prepared.push({ nodeId, nodeType, connection, xid })
    await reportSuccess(context, laneId, groupId)
    return { ok: true, result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    await reportFailure(context, laneId, groupId, nodeId, nodeType, message)
    return { ok: false, error: message }
  }
}

// ─── Esiti membri — comuni a native e xa ──────────────────────────

/** Membro completato con successo. */
export async function reportSuccess(
  context: ExecutionContext,
  laneId:  string,
  groupId: string,
): Promise<void> {
  const key   = groupKey(laneId, groupId)
  const state = context.transactions.get(key)
  if (!state) return
  state.remaining--
  if (state.remaining === 0) await finalize(context, laneId, groupId, state)
}

/**
 * Membro fallito — marca il gruppo come abortito (i membri successivi
 * si auto-salteranno) e registra il primo fallimento (i successivi non
 * sovrascrivono — la causa originale è quella interessante).
 */
export async function reportFailure(
  context:  ExecutionContext,
  laneId:   string,
  groupId:  string,
  nodeId:   string,
  nodeType: string,
  message:  string,
): Promise<void> {
  const key   = groupKey(laneId, groupId)
  const state = context.transactions.get(key)
  if (!state) return
  state.aborted = true
  if (!state.failure) state.failure = { nodeId, nodeType, message }
  state.remaining--
  if (state.remaining === 0) await finalize(context, laneId, groupId, state)
}

/** Membro auto-saltato perché il gruppo era già abortito. */
export async function reportSkipped(
  context: ExecutionContext,
  laneId:  string,
  groupId: string,
): Promise<void> {
  const key   = groupKey(laneId, groupId)
  const state = context.transactions.get(key)
  if (!state) return
  state.remaining--
  if (state.remaining === 0) await finalize(context, laneId, groupId, state)
}

// ─── finalize ───────────────────────────────────────────────────────

async function finalize(
  context: ExecutionContext,
  laneId:  string,
  groupId: string,
  state:   TransactionGroupState,
): Promise<void> {
  const key    = groupKey(laneId, groupId)
  const action = state.failure ? 'rollback' : 'commit'

  if (state.mode === 'native') {
    await finalizeNative(context, laneId, groupId, state, action)
  } else {
    await finalizeXa(context, laneId, groupId, state, action)
  }

  context.transactions.delete(key)
}

async function finalizeNative(
  context: ExecutionContext,
  laneId:  string,
  groupId: string,
  state:   TransactionGroupState,
  action:  'commit' | 'rollback',
): Promise<void> {
  if (action === 'rollback') {
    if (state.began) {
      try { await invoke('db_tx_rollback', { request: { txId: groupId } }) }
      catch (err) {
        context.callbacks.onLog('error',
          `Transazione '${groupId}': rollback fallito — ${err instanceof Error ? err.message : err}`,
          state.failure!.nodeId)
      }
    }
    context.callbacks.onLog('error',
      `Transazione '${groupId}' (native): rollback su ${state.members.length} partecipanti — causa: ${state.failure!.nodeId} → ${state.failure!.message}`,
      state.failure!.nodeId)
    pushTransactionErrorRow(context, laneId, groupId, state, 'rollback')
    return
  }

  if (state.began) {
    try { await invoke('db_tx_commit', { request: { txId: groupId } }) }
    catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      context.callbacks.onLog('error', `Transazione '${groupId}' (native): COMMIT fallito — ${message}`, undefined)
      pushTransactionErrorRow(context, laneId, groupId, {
        ...state,
        failure: { nodeId: state.members[state.members.length - 1], nodeType: 'sink_db', message: `COMMIT fallito: ${message}` },
      }, 'commit_failed')
      return
    }
  }
  context.callbacks.onLog('ok', `Transazione '${groupId}' (native): commit (${state.members.length} partecipanti)`, undefined)
}

async function finalizeXa(
  context: ExecutionContext,
  laneId:  string,
  groupId: string,
  state:   TransactionGroupState,
  action:  'commit' | 'rollback',
): Promise<void> {
  if (state.prepared.length === 0) {
    // Nessun membro ha raggiunto il prepare — niente da finalizzare
    // (es. tutti falliti prima del prepare, o gruppo a 0 membri).
    if (action === 'rollback') {
      context.callbacks.onLog('error',
        `Transazione '${groupId}' (xa): nessun partecipante preparato — causa: ${state.failure?.nodeId} → ${state.failure?.message}`,
        state.failure?.nodeId)
      pushTransactionErrorRow(context, laneId, groupId, state, 'rollback')
    }
    return
  }

  const finishErrors: Record<string, string> = {}

  for (const p of state.prepared) {
    try {
      await invoke('db_tx_xa_finish', { request: { txId: p.xid, connection: p.connection, action } })
    } catch (err) {
      finishErrors[p.nodeId] = err instanceof Error ? err.message : String(err)
    }
  }

  if (action === 'rollback') {
    context.callbacks.onLog('error',
      `Transazione '${groupId}' (xa): rollback su ${state.prepared.length} partecipanti preparati (di ${state.members.length} totali) — causa: ${state.failure!.nodeId} → ${state.failure!.message}`,
      state.failure!.nodeId)
    if (Object.keys(finishErrors).length > 0) {
      context.callbacks.onLog('warn',
        `Transazione '${groupId}' (xa): ROLLBACK PREPARED fallito per ${Object.keys(finishErrors).join(', ')} — ` +
        `transazioni preparate rimaste pendenti sul DB, richiedono pulizia manuale (xid: ${state.prepared.map((p) => p.xid).join(', ')})`,
        undefined)
    }
    pushTransactionErrorRow(context, laneId, groupId, state, 'rollback')
    return
  }

  // action === 'commit'
  if (Object.keys(finishErrors).length === 0) {
    context.callbacks.onLog('ok', `Transazione '${groupId}' (xa): commit su ${state.prepared.length} partecipanti`, undefined)
    return
  }

  // Commit parziale — finestra di non-atomicità del 2PC: alcuni
  // partecipanti hanno committato, altri no. È l'errore più grave
  // possibile per questo modello — va segnalato in modo inequivocabile.
  const committed = state.prepared.filter((p) => !(p.nodeId in finishErrors)).map((p) => p.nodeId)
  const failed    = Object.keys(finishErrors)
  context.callbacks.onLog('error',
    `Transazione '${groupId}' (xa): COMMIT PARZIALE — committati: [${committed.join(', ')}], falliti: [${failed.join(', ')}]. ` +
    `Stato inconsistente tra le risorse — richiede intervento manuale. xid falliti: ${state.prepared.filter(p => p.nodeId in finishErrors).map(p => p.xid).join(', ')}`,
    undefined)

  const errorHandler = findErrorHandler(context, laneId)
  if (errorHandler) {
    const row = buildTransactionErrorRow(state, groupId, laneId, 'commit_failed_partial')
    row._transaction_commit_errors = finishErrors
    row._error_message = `Commit parziale: falliti [${failed.join(', ')}] su [${state.prepared.map(p=>p.nodeId).join(', ')}]`
    const bucket = context.errorRows.get(errorHandler.id) ?? []
    bucket.push(row)
    context.errorRows.set(errorHandler.id, bucket)
  }
}

function pushTransactionErrorRow(
  context: ExecutionContext,
  laneId:  string,
  groupId: string,
  state:   TransactionGroupState,
  action:  'rollback' | 'commit_failed',
): void {
  const errorHandler = findErrorHandler(context, laneId)
  if (!errorHandler) return
  const row = buildTransactionErrorRow(state, groupId, laneId, action)
  const bucket = context.errorRows.get(errorHandler.id) ?? []
  bucket.push(row)
  context.errorRows.set(errorHandler.id, bucket)
}

function buildTransactionErrorRow(
  state:   TransactionGroupState,
  groupId: string,
  laneId:  string,
  action:  'rollback' | 'commit_failed' | 'commit_failed_partial',
): Row {
  const f = state.failure!
  return {
    _error_message:   f.message,
    _error_code:      'TRANSACTION_ROLLBACK',
    _error_node_id:   f.nodeId,
    _error_node_type: f.nodeType,
    _error_at:        new Date().toISOString(),
    _error_row:       {},
    _error_lane_id:   laneId,
    _error_source:    'transaction',
    _transaction_group_id:     groupId,
    _transaction_mode:         state.mode,
    _transaction_participants: state.members,
    _transaction_action:       action,
  }
}

// ─── Safety net — chiamato da runPipeline nel finally ─────────────
//
// 'native': se remaining > 0 per qualche gruppo (lane abortita a metà),
//           la connessione resta aperta sul lato Rust — forziamo rollback.
//
// 'xa':     i prepare già fatti restano "in prepared state" sul DB.
//           Non possiamo fare finish in sicurezza qui (non sappiamo se
//           i membri non ancora eseguiti avrebbero fallito o no), ma
//           possiamo almeno fare ROLLBACK PREPARED sui partecipanti già
//           preparati per non lasciare transazioni pendenti indefinite —
//           è la scelta più sicura quando l'esecuzione è stata interrotta.
export async function cleanupAbandoned(context: ExecutionContext): Promise<void> {
  for (const [key, state] of context.transactions) {
    const groupId = key.split('::')[1]

    if (state.mode === 'native') {
      if (state.began) {
        try {
          await invoke('db_tx_rollback', { request: { txId: groupId } })
          context.callbacks.onLog('warn',
            `Transazione '${groupId}' (native): rollback forzato (esecuzione interrotta, ${state.remaining} partecipanti non completati)`,
            undefined)
        } catch { /* best-effort */ }
      }
    } else {
      for (const p of state.prepared) {
        try { await invoke('db_tx_xa_finish', { request: { txId: p.xid, connection: p.connection, action: 'rollback' } }) }
        catch { /* best-effort */ }
      }
      if (state.prepared.length > 0) {
        context.callbacks.onLog('warn',
          `Transazione '${groupId}' (xa): rollback forzato di ${state.prepared.length} partecipanti preparati (esecuzione interrotta, ${state.remaining} non completati)`,
          undefined)
      }
    }
  }
  context.transactions.clear()
}