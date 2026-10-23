/**
 * src/nodes/types/sink_ftp/schema.ts
 */

/** Riga di stato (outputMode = signal): i campi che il motore emette
 *  (src-tauri/src/engine/nodes/sink_ftp.rs). */
export const SINK_FTP_SIGNAL_SCHEMA = [
  { name: 'status',        type: 'string',  desc: 'Always "ok" (on error the node fails)' },
  { name: 'rows_written',  type: 'integer', desc: 'Number of rows written' },
  { name: 'bytes_written', type: 'integer', desc: 'File size in bytes' },
  { name: 'file_path',     type: 'string',  desc: 'Full path of the file on the server' },
  { name: 'file_name',     type: 'string',  desc: 'Name of the written file' },
  { name: 'completed_at',  type: 'date',    desc: 'Completion timestamp' },
  { name: 'error_message', type: 'string',  desc: 'Always empty' },
  { name: 'duration_ms',   type: 'integer', desc: 'Duration in ms' },
]
