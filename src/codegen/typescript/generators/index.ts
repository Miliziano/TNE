/**
 * src/codegen/typescript/generators/index.ts
 *
 * Modifiche rispetto alla versione precedente:
 * - Aggiunto tmapGenerator che gestisce l'operazione 'branch'
 *   quando il nodo è un TMap completo (con config.tmap).
 *   Il vecchio branchGenerator rimane come fallback per nodi
 *   branch semplici (filter con routing).
 *
 * Nota: il TMap viene abbassato a 'branch' nel lowering IR.
 * tmapGenerator sostituisce branchGenerator per i nodi TMap
 * rilevando la presenza di config.tmap nella _uiRef.
 */

import type { LogicalNode, LogicalOperation } from '../../../ir/types'
import type { CodegenContext } from '../index'

import type { NodeGenerator } from './types'
export type { NodeGenerator } from './types'

import { scanGenerator }       from './scan'
import {
  filterGenerator,
  projectionGenerator,
  sinkGenerator,
  transformGenerator,
  parseGenerator,
} from './generators'
import {
  joinGenerator,
  aggregateGenerator,
  windowGenerator,
  unionGenerator,
  sortGenerator,
  limitGenerator,
  branchGenerator,
  mergeGenerator,
} from './remaining'
import { tmapGenerator } from './tmap'

// ── Wrapper branch: dispatch a tmapGenerator se il nodo è un TMap ──
// Il lowering abbassa i nodi TMap a 'branch'. Qui distinguiamo:
//   - nodi con config.tmap → tmapGenerator (pre-materialization + pruning)
//   - nodi branch semplici → branchGenerator originale
const branchDispatcher: NodeGenerator = {
  operation: 'branch',

  generate(node: LogicalNode, ctx: CodegenContext): string {
    const config = (node._uiRef?.config ?? {}) as any
    const isTMap = !!config?.tmap?.inputs?.length

    if (isTMap) {
      return tmapGenerator.generate(node, ctx)
    }
    return branchGenerator.generate(node, ctx)
  },
}

export const generators: Partial<Record<LogicalOperation, NodeGenerator>> = {
  // Sorgenti
  scan:       scanGenerator,

  // Trasformazioni row-at-a-time
  filter:     filterGenerator,
  projection: projectionGenerator,
  transform:  transformGenerator,
  parse:      parseGenerator,

  // branch: TMap completo o branch semplice
  branch:     branchDispatcher,

  // Trasformazioni dataset/stateful
  join:       joinGenerator,
  aggregate:  aggregateGenerator,
  window:     windowGenerator,
  sort:       sortGenerator,
  limit:      limitGenerator,

  // Confluenza
  union:      unionGenerator,
  merge:      mergeGenerator,

  // Destinazioni
  sink:       sinkGenerator,
}