/**
 * src/codegen/typescript/optimizer_types.ts
 * ──────────────────────────────────────────
 * Tipi esportati dall'optimizer usati da pipeline.ts.
 * File separato per evitare import circular tra ir/ e codegen/.
 */

export type { OptimizationLog, OptimizationResult } from '../../ir/optimizer'
