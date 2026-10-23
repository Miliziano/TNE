/**
 * src/nodes/types/materialize/schema.ts
 *
 * Materialize (P366): la riga di stato che il motore emette in
 * buffer_signal (src-tauri/src/engine/nodes/materialize.rs) e lo schema del
 * DATASET (le righe in ingresso), letto dai nodi che lo usano per nome.
 */
export const MATERIALIZE_SIGNAL_SCHEMA = [
  { name: 'name',         type: 'string',  desc: 'Materialize name' },
  { name: 'row_count',    type: 'integer', desc: 'Rows stored in the dataset' },
  { name: 'status',       type: 'string',  desc: 'Always "done" (on error the node fails)' },
  { name: 'completed_at', type: 'date',    desc: 'Completion timestamp' },
  { name: 'elapsed_ms',   type: 'integer', desc: 'Duration in ms' },
  { name: 'truncated',    type: 'boolean', desc: 'true if rows beyond the limit were left out' },
]

export const MATERIALIZE_SIGNAL_SCHEMA_JSON = JSON.stringify(
  MATERIALIZE_SIGNAL_SCHEMA.map(({ name, type }) => ({ id: `mat_sig_${name}`, name, type, physicalName: name })),
)

/** Modalità effettiva: il vecchio buffer_replay ri-emetteva le righe → passthrough. */
export function materializeMode(props: Record<string, string | undefined>): string {
  const m = props['matMode'] ?? 'passthrough'
  return m === 'buffer_replay' || m === 'buffer' || m === '' ? 'passthrough' : m
}

/** Lo schema del dataset (grezzo, JSON): le righe in ingresso. In
 *  buffer_signal `outputSchema` è la riga di stato, non il dataset. */
export function materializeDatasetSchemaRaw(props: Record<string, string | undefined>): string {
  return props['incomingSchema'] || (materializeMode(props) === 'buffer_signal' ? '' : (props['outputSchema'] ?? ''))
}
