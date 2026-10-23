/**
 * src/nodes/types/source_ftp/schema.ts
 *
 * FTP/SFTP Source (P362): i campi che il motore emette per formato
 * (src-tauri/src/engine/nodes/source_ftp.rs, che legge i file scaricati
 * col lettore del File Input). CSV, TSV ed Excel hanno lo schema scelto
 * nella tab Mapping; i metadati del file si aggiungono sempre.
 */
import type { TMapInputField } from '../../../types'

/** Metadati aggiunti a ogni riga letta (modalità "Download and read"). */
export const FTP_META_FIELDS: TMapInputField[] = [
  { id: 'ftp_filename',    name: '_filename',    type: 'string',  physicalName: '_filename'    },
  { id: 'ftp_filepath',    name: '_filepath',    type: 'string',  physicalName: '_filepath'    },
  { id: 'ftp_filesize',    name: '_filesize',    type: 'integer', physicalName: '_filesize'    },
  { id: 'ftp_modified_at', name: '_modified_at', type: 'date',    physicalName: '_modified_at' },
]

/** Modalità "List files": una riga per file trovato. */
export const FTP_LIST_SCHEMA: TMapInputField[] = [
  { id: 'ftp_name',        name: 'name',        type: 'string',  physicalName: 'name'        },
  { id: 'ftp_path',        name: 'path',        type: 'string',  physicalName: 'path'        },
  { id: 'ftp_is_dir',      name: 'is_dir',      type: 'boolean', physicalName: 'is_dir'      },
  { id: 'ftp_size',        name: 'size',        type: 'integer', physicalName: 'size'        },
  { id: 'ftp_modified_at', name: 'modified_at', type: 'date',    physicalName: 'modified_at' },
]

const f = (id: string, name: string, type: TMapInputField['type']): TMapInputField => ({ id, name, type, physicalName: name })

/** Formati a schema fisso (senza i metadati). */
export const FTP_FORMAT_FIELDS: Record<string, TMapInputField[]> = {
  raw:    [f('ftp_content', 'content', 'string')],
  text:   [f('ftp_line', 'line', 'string'), f('ftp_line_number', 'line_number', 'integer')],
  json:   [f('ftp_content', 'content', 'object'), f('ftp_raw', 'raw', 'string')],
  jsonl:  [f('ftp_content', 'content', 'object'), f('ftp_raw', 'raw', 'string')],
  xml:    [f('ftp_content', 'content', 'string')],
  binary: [f('ftp_data', 'data', 'string'), f('ftp_size', 'size', 'integer'), f('ftp_mime', 'mime_type', 'string')],
}

/** Formati con lo schema scelto dall'utente (tab Mapping). */
export const FTP_TABULAR_FORMATS = ['csv', 'tsv', 'excel']

/** Schema fisso di un formato, metadati compresi (null = schema dell'utente). */
export function ftpFixedSchema(outputMode: string, format: string): TMapInputField[] | null {
  if (outputMode === 'list_files') return FTP_LIST_SCHEMA
  const fields = FTP_FORMAT_FIELDS[format]
  return fields ? [...fields, ...FTP_META_FIELDS] : null
}
