/**
 * src/nodes/types/source_file/spec.ts
 *
 * La proiezione del mapping che il motore applica (source_file.rs, P357):
 * nome logico, colonna nel file, tipo, trasformazione. Usata dal builder
 * (Toolbar) e dall'anteprima, così leggono il file allo stesso modo.
 * Prima `name` era la colonna fisica e il nome logico si perdeva: una
 * colonna rinominata nel mapping usciva col nome del file.
 */
import { SOURCE_TABULAR_FORMATS } from '../../fileSchema'

export interface SourceFileSpecField { name: string; physical: string; type: string; transform: string }

export function sourceFileSpecFields(props: Record<string, string | undefined>): SourceFileSpecField[] {
  if (!SOURCE_TABULAR_FORMATS.includes(props['format'] ?? 'csv')) return []
  try {
    const raw = props['outputSchema']
    if (!raw) return []
    const schema = JSON.parse(raw) as Array<{ name: string; type: string; physicalName?: string; transform?: string }>
    return schema
      .filter((f) => f.name)
      .map((f) => ({ name: f.name, physical: f.physicalName || f.name, type: f.type, transform: f.transform ?? '' }))
  } catch { return [] }
}
