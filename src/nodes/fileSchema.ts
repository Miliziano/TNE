import type { TMapInputField } from '../types'

// ─── Tipi formato file ────────────────────────────────────────────
export type FileFormat =
  | 'csv' | 'tsv' | 'excel'
  | 'json' | 'jsonl'
  | 'parquet' | 'orc' | 'avro'
  | 'xml' | 'text'
  | 'pdf_text' | 'pdf_binary' | 'binary'
  | 'html' | 'excel_b64'   // ← output Report Generator

/**
 * Formati con schema UTENTE — l'utente definisce i campi nel mapping.
 */
export const STRUCTURED_FORMATS: FileFormat[] = [
  'csv', 'tsv', 'excel', 'parquet', 'orc', 'avro',
]

// ─── Gruppi per la select del formato ────────────────────────────
export const FORMAT_GROUPS = [
  {
    label: 'Testo strutturato',
    formats: [
      { value: 'csv',   label: 'CSV'                  },
      { value: 'tsv',   label: 'TSV'                  },
      { value: 'excel', label: 'Excel (.xlsx / .xls)' },
    ],
  },
  {
    label: 'Semi-strutturato (→ usa Parser)',
    formats: [
      { value: 'json',  label: 'JSON  — contenuto grezzo → JSON Parser' },
      { value: 'jsonl', label: 'JSONL — contenuto grezzo → JSON Parser' },
      { value: 'xml',   label: 'XML   — contenuto grezzo → XML Parser'  },
    ],
  },
  {
    label: 'Binario con schema',
    formats: [
      { value: 'parquet', label: 'Parquet' },
      { value: 'orc',     label: 'ORC'     },
      { value: 'avro',    label: 'Avro'    },
    ],
  },
  {
    label: 'Binario / Non strutturato',
    formats: [
      { value: 'pdf_text',   label: 'PDF — estrai testo'      },
      { value: 'pdf_binary', label: 'PDF — binario Base64'    },
      { value: 'text',       label: 'Testo plain (riga×riga)' },
      { value: 'binary',     label: 'Binario raw (Base64)'    },
    ],
  },
  {
    label: 'Report (da Report Generator)',
    formats: [
      { value: 'html',      label: 'HTML — documento web'                   },
      { value: 'excel_b64', label: 'Excel da base64 (Report Generator)'     },
    ],
  },
]

/**
 * Schema fisso per formati non tabellari.
 */
export const FIXED_SCHEMA: Record<string, TMapInputField[]> = {

  json: [
    { id: 'json_content', name: 'content', type: 'object', physicalName: 'content' },
    { id: 'json_raw',     name: 'raw',     type: 'string', physicalName: 'raw'     },
  ],
  jsonl: [
    { id: 'jsonl_content', name: 'content', type: 'object', physicalName: 'content' },
    { id: 'jsonl_raw',     name: 'raw',     type: 'string', physicalName: 'raw'     },
  ],
  xml: [
    { id: 'xml_content', name: 'content', type: 'string', physicalName: 'content' },
  ],
  text: [
    { id: 'text_line',    name: 'line',        type: 'string',  physicalName: 'line'        },
    { id: 'text_linenum', name: 'line_number', type: 'integer', physicalName: 'line_number' },
  ],
  pdf_text: [
    { id: 'pdf_text',     name: 'text',     type: 'string',  physicalName: 'text'     },
    { id: 'pdf_pages',    name: 'pages',    type: 'integer', physicalName: 'pages'    },
    { id: 'pdf_metadata', name: 'metadata', type: 'object',  physicalName: 'metadata' },
  ],
  pdf_binary: [
    { id: 'pdfbin_data', name: 'data',      type: 'string', physicalName: 'data'      },
    { id: 'pdfbin_mime', name: 'mime_type', type: 'string', physicalName: 'mime_type' },
  ],
  binary: [
    { id: 'bin_data', name: 'data',      type: 'string',  physicalName: 'data'      },
    { id: 'bin_size', name: 'size',      type: 'integer', physicalName: 'size'      },
    { id: 'bin_mime', name: 'mime_type', type: 'string',  physicalName: 'mime_type' },
  ],

  // Report Generator — schema fisso: il contenuto viene scritto tramite raw_field
  html: [
    { id: 'html_content',      name: 'content',      type: 'string',  physicalName: 'content'      },
    { id: 'html_content_type', name: 'content_type', type: 'string',  physicalName: 'content_type' },
    { id: 'html_filename',     name: 'filename',     type: 'string',  physicalName: 'filename'     },
    { id: 'html_row_count',    name: 'row_count',    type: 'integer', physicalName: 'row_count'    },
    { id: 'html_generated_at', name: 'generated_at', type: 'date',    physicalName: 'generated_at' },
  ],
  excel_b64: [
    { id: 'xls_content',      name: 'content',      type: 'string',  physicalName: 'content'      },
    { id: 'xls_content_type', name: 'content_type', type: 'string',  physicalName: 'content_type' },
    { id: 'xls_filename',     name: 'filename',     type: 'string',  physicalName: 'filename'     },
    { id: 'xls_row_count',    name: 'row_count',    type: 'integer', physicalName: 'row_count'    },
    { id: 'xls_generated_at', name: 'generated_at', type: 'date',    physicalName: 'generated_at' },
  ],
}

/**
 * Restituisce true se il formato ha schema fisso non modificabile.
 */
export const isFixedFormat = (format: string): boolean =>
  !STRUCTURED_FORMATS.includes(format as FileFormat)

/**
 * Messaggio descrittivo per i formati con schema fisso.
 */
export const FIXED_FORMAT_HINT: Record<string, string> = {
  json:       'Il formato JSON produce il documento come campo "content" (object) e "raw" (string). Collega questo nodo a un JSON Parser per estrarre i campi strutturati.',
  jsonl:      'Il formato JSONL produce una riga per oggetto JSON, con campo "content" (object) e "raw" (string). Collega a un JSON Parser per estrarre i campi.',
  xml:        'Il formato XML produce il documento come campo "content" (string). Collega questo nodo a un XML Parser per estrarre i campi strutturati.',
  text:       'Il formato testo produce una riga per ogni linea del file, con campo "line" e "line_number".',
  pdf_text:   'Il formato PDF estrae il testo con campi "text", "pages" e "metadata".',
  pdf_binary: 'Il formato PDF binario produce il contenuto come Base64 nel campo "data".',
  binary:     'Il formato binario produce il contenuto come Base64 nel campo "data".',
  html:       'Formato HTML dal Report Generator. Il SinkFile scriverà il campo "content" direttamente su disco come file .html.',
  excel_b64:  'Formato Excel dal Report Generator. Il SinkFile decodificherà il campo "content" (base64) e lo scriverà come file .xlsx binario.',
}