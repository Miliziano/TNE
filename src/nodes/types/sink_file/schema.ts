/**
 * src/nodes/types/sink_file/schema.ts
 *
 * File Output (P361): i formati che il motore sa scrivere e la riga di
 * stato che emette (src-tauri/src/engine/nodes/sink_file.rs).
 */

/** Riga di stato (outputMode = signal): una per file scritto. */
export const SINK_FILE_SIGNAL_SCHEMA = [
  { name: 'status',        type: 'string',  desc: 'Always "ok" (on error the node fails)' },
  { name: 'rows_written',  type: 'integer', desc: 'Rows written to the file' },
  { name: 'bytes_written', type: 'integer', desc: 'File size in bytes' },
  { name: 'file_path',     type: 'string',  desc: 'Actual path of the file' },
  { name: 'completed_at',  type: 'date',    desc: 'Completion timestamp' },
  { name: 'error_message', type: 'string',  desc: 'Always empty' },
  { name: 'duration_ms',   type: 'integer', desc: 'Write duration in ms' },
]

/** Lo schema del segnale come lo salvano le props (`outputSchema`). */
export const SINK_FILE_SIGNAL_SCHEMA_JSON = JSON.stringify(
  SINK_FILE_SIGNAL_SCHEMA.map(({ name, type }) => ({ id: `sf_${name}`, name, type, physicalName: name })),
)

/** Formati in cui si scrivono le righe del flusso. */
export const SINK_ROW_FORMATS = ['csv', 'tsv', 'excel', 'json', 'jsonl', 'xml']

/** Formati in cui si scrive il valore di un campo (testo o base64). */
export const SINK_FIELD_FORMATS: Record<string, 'text' | 'base64'> = {
  html: 'text', text: 'text', excel_b64: 'base64', binary: 'base64',
}

export const SINK_FILE_FORMAT_GROUPS = [
  {
    label: 'Tables',
    formats: [
      { value: 'csv',   label: 'CSV' },
      { value: 'tsv',   label: 'TSV' },
      { value: 'excel', label: 'Excel (.xlsx)' },
    ],
  },
  {
    label: 'Documents',
    formats: [
      { value: 'json',  label: 'JSON — array or one object per line' },
      { value: 'jsonl', label: 'JSON Lines — one object per line' },
      { value: 'xml',   label: 'XML — <records><record>…' },
    ],
  },
  {
    label: 'Value of a field',
    formats: [
      { value: 'html',      label: 'HTML — text field (Report Generator)' },
      { value: 'text',      label: 'Text — one line per row' },
      { value: 'excel_b64', label: 'Excel from base64 (Report Generator)' },
      { value: 'binary',    label: 'Binary — Base64 field decoded (PDF, images…)' },
    ],
  },
]

/** Estensione proposta per formato (binary: si lascia quella del percorso). */
export const SINK_FORMAT_EXT: Record<string, string> = {
  csv: 'csv', tsv: 'tsv', excel: 'xlsx', json: 'json', jsonl: 'jsonl',
  xml: 'xml', html: 'html', text: 'txt', excel_b64: 'xlsx',
}
