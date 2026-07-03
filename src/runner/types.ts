/**
 * src/runner/types.ts
 *
 * Modifiche rispetto alla versione precedente:
 *
 * - RunnerCallbacks: aggiunto getLaneVariable — legge il valore live
 *   dalla Map condivisa invece dello snapshot stale di context.lanes.
 *
 * - ExecutionContext: aggiunto laneVariables — Map live delle variabili
 *   di lane durante il run. Tutti i nodi che eseguono codice (Script,
 *   TMap, ecc.) leggono e scrivono qui invece che da context.lanes.
 *   Questo garantisce che le scritture di un nodo siano visibili ai
 *   nodi successivi nella stessa esecuzione, e che il comportamento
 *   sia identico negli artifact generati (Java/Python).
 */

import type { Node as FlowNode, Edge } from '@xyflow/react'
import type { NodeData } from '../types'
import type { Lane } from '../types'
import type { TransactionGroupState } from './transactionCoordinator'

export type Row = Record<string, unknown>

export interface NodeResult {
  nodeId:   string
  ok:       boolean
  message?: string
  rowsIn:   number
  rowsOut:  number
}

export interface RunnerCallbacks {
  onLog:       (level: 'info' | 'ok' | 'warn' | 'error' | 'debug', message: string, nodeId?: string) => void
  onNodeStart: (nodeId: string) => void
  onNodeDone:  (result: NodeResult) => void
  isAborted:   () => boolean

  /**
   * Avvia una sub-pipeline partendo da startNodeId nella lane laneId.
   * Usato dal Sequencer per eseguire pipeline indipendenti in sequenza.
   */
  runSubPipeline: (startNodeId: string, laneId: string) => Promise<{ ok: boolean; error?: string }>

  /**
   * Aggiorna una variabile di Lane a runtime.
   *
   * Opera su due livelli:
   * 1. context.laneVariables (Map live) — aggiornamento immediato,
   *    visibile a tutti i nodi successivi nella stessa esecuzione
   * 2. Zustand store — aggiornamento per persistenza UI e run successivi
   *
   * Chiamato da: Proxy lane in Script/TMap/tutti i nodi con codice.
   */
  updateLaneVariable: (laneId: string, varName: string, value: string) => void

  /**
   * Legge il valore corrente di una variabile di Lane.
   *
   * Legge sempre da context.laneVariables (Map live), non dallo snapshot
   * stale di context.lanes. Garantisce che le scritture di un nodo
   * siano visibili ai nodi successivi nella stessa esecuzione.
   *
   * Esempio: Script reinizializza counter=0 → TMap legge counter=0
   * anche se context.lanes contiene ancora il vecchio valore.
   */
  getLaneVariable: (laneId: string, varName: string) => unknown
}

export interface ExecutionContext {
  runId:       string
  nodes:       FlowNode<NodeData>[]
  edges:       Edge[]
  callbacks:   RunnerCallbacks
  materialize: Map<string, Row[]>

  /**
   * Accumulatore errori per l'Error Handler — chiave: id del nodo
   * error_handler della lane, valore: righe enriched raccolte durante
   * l'esecuzione. Popolato da executeNode/executeStreamingNode,
   * consumato da processErrorHandler() alla fine di runLane.
   */
  errorRows: Map<string, Row[]>

  /**
   * Stato dei gruppi transazionali attivi — chiave "laneId::groupId".
   * Vedi transactionCoordinator.ts.
   */
  transactions: Map<string, TransactionGroupState>

  /**
   * Snapshot delle lane al momento dell'avvio del run.
   * SOLO per configurazione iniziale (risorse, metadati).
   * NON usare per leggere variabili a runtime — usare laneVariables.
   */
  lanes: Lane[]

  /**
   * Stato live delle variabili di lane durante il run.
   *
   * Chiave: `${laneId}::${varName}`
   * Valore: valore corrente (già deserializzato — number, boolean, object, string)
   *
   * Inizializzato in runPipeline con i valori delle variabili di lane
   * (deserializzati per tipo). Aggiornato in tempo reale da tutti i nodi
   * che eseguono codice tramite callbacks.updateLaneVariable.
   *
   * Questo è lo stato condiviso e autorevole durante l'esecuzione —
   * context.lanes.variables è solo lo snapshot iniziale.
   *
   * Nell'artifact generato (Java/Python), corrisponde a una HashMap
   * condivisa tra tutti i nodi della lane.
   */
  laneVariables: Map<string, unknown>

  /**
   * Identity maps per i DB Sink in modalità pass-through master-detail.
   */
  identityMaps: Map<string, Map<string, unknown>>

  /**
   * Snapshot delle identity maps al momento dell'avvio del run.
   */
  identityMapSnapshots: Map<string, Map<string, unknown>>
}


// ─── Executor batch standard ──────────────────────────────────────
export interface NodeExecutor {
  handles:  string[]

  requiresCompleteInput?: (node: FlowNode<NodeData>, inputHandle: string) => boolean

  execute:  (
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ) => Promise<Map<string, Row[]>>
}

// ─── Executor streaming ───────────────────────────────────────────
export interface StreamingNodeExecutor {
  handles:   string[]
  streaming: true

  execute: (
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
    onRow:   (row: Row) => Promise<void>,
    onDone:  (totalRows: number) => void,
  ) => Promise<void>
}

export type AnyExecutor = NodeExecutor | StreamingNodeExecutor

// ─── Type guard ───────────────────────────────────────────────────
export function isStreamingExecutor(e: AnyExecutor): e is StreamingNodeExecutor {
  return (e as StreamingNodeExecutor).streaming === true
}

// ─── Helper: costruisce il proxy lane per un nodo ─────────────────
//
// Funzione condivisa da tutti gli executor che eseguono codice
// (Script, TMap, ecc.). Garantisce comportamento identico ovunque.
//
// Il Proxy intercetta:
// - get: legge sempre da laneVariables (valore live)
// - set: aggiorna laneVariables + chiama updateLaneVariable
//        (che aggiorna anche lo store Zustand per la UI)
//
// Sintassi nelle espressioni:
//   lane.counter++          → legge, incrementa, persiste
//   lane.prefix = 'ABC'     → scrive e persiste
//   context.lane.counter++  → identico (context è alias)
//
// Nell'artifact generato (Java/Python):
//   Il Proxy viene sostituito con un oggetto LaneContext
//   che opera sulla stessa HashMap condivisa.
//
export function buildLaneProxy(
  laneId:    string,
  context:   ExecutionContext,
): Record<string, unknown> {
  return new Proxy({} as Record<string, unknown>, {
    get(_target, prop) {
      return context.laneVariables.get(`${laneId}::${prop as string}`)
    },
    set(_target, prop, value) {
      const key = `${laneId}::${prop as string}`
      context.laneVariables.set(key, value)
      // Persiste nello store Zustand per UI e run successivi
      context.callbacks.updateLaneVariable(laneId, prop as string, String(value))
      return true
    },
    has(_target, prop) {
      return context.laneVariables.has(`${laneId}::${prop as string}`)
    },
    ownKeys() {
      const prefix = `${laneId}::`
      return Array.from(context.laneVariables.keys())
        .filter(k => k.startsWith(prefix))
        .map(k => k.slice(prefix.length))
    },
    getOwnPropertyDescriptor(_target, prop) {
      const val = context.laneVariables.get(`${laneId}::${prop as string}`)
      if (val === undefined) return undefined
      return { value: val, writable: true, enumerable: true, configurable: true }
    },
  })
}

// ─── Helper: deserializza un valore variabile per tipo ────────────
export function deserializeLaneValue(value: unknown, type?: string): unknown {
  if (typeof value !== 'string') return value
  if (!type) return value
  switch (type) {
    case 'number':  { const n = Number(value); return isNaN(n) ? value : n }
    case 'boolean': return value === 'true' || value === '1'
    case 'object':
    case 'json':    try { return JSON.parse(value) } catch { return value }
    default:        return value
  }
}