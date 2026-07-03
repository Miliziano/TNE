/**
 * src/codegen/typescript/generators/types.ts
 *
 * Tipi condivisi tra i generatori — file separato per evitare
 * import circolari tra generators/index.ts e i singoli generatori.
 */

import type { LogicalNode, LogicalOperation } from '../../../ir/types'
import type { CodegenContext } from '../index'

export interface NodeGenerator {
  operation: LogicalOperation
  generate(node: LogicalNode, ctx: CodegenContext): string
}
