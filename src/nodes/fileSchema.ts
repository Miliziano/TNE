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

/** File Input (P357): i formati tabellari, gli unici col mapping dei campi. */
export const SOURCE_TABULAR_FORMATS = ['csv', 'tsv', 'excel']

/** File Input (P357): solo ciò che il motore sa leggere (source_file.rs). */
export const SOURCE_FORMAT_GROUPS = [
  {
    label: 'Tables',
    formats: [
      { value: 'csv',   label: 'CSV' },
      { value: 'tsv',   label: 'TSV' },
      { value: 'excel', label: 'Excel / OpenDocument (.xlsx .xls .ods)' },
    ],
  },
  {
    label: 'Documents (→ JSON / XML Parser)',
    formats: [
      { value: 'json',  label: 'JSON — the document, or one row per element' },
      { value: 'jsonl', label: 'JSON Lines — one row per line' },
      { value: 'xml',   label: 'XML — the whole document in one row' },
    ],
  },
  {
    label: 'Other',
    formats: [
      { value: 'text',       label: 'Plain text — one row per line' },
      { value: 'binary',     label: 'Binary — Base64 / hex' },
      { value: 'pdf_binary', label: 'PDF — binary, Base64 / hex' },
    ],
  },
]

/** I formati di testo: l'encoding conta. */
export const SOURCE_TEXT_FORMATS = ['csv', 'tsv', 'json', 'jsonl', 'xml', 'text']

/** Valori di `format` che il motore riconosce (tabelle + documenti + altro). */
export const SOURCE_FORMATS: string[] = SOURCE_FORMAT_GROUPS.flatMap((g) => g.formats.map((f) => f.value))

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
  !SOURCE_TABULAR_FORMATS.includes(format)

/**
 * Messaggio descrittivo per i formati con schema fisso.
 */
export const FIXED_FORMAT_HINT: Record<string, string> = {
  json:       'The value at the JSON path in one row — or one row per element if Structure is "Array": "content" (object) and "raw" (the JSON text). Connect a JSON Parser to extract the fields.',
  jsonl:      'One row per line of the file: "content" (object) and "raw" (the JSON text). Connect a JSON Parser to extract the fields.',
  xml:        'The whole document in one row, in the "content" field. Connect an XML Parser to extract the fields.',
  text:       'One row per line of the file, with "line" and "line_number".',
  pdf_binary: 'The PDF as Base64 (or hex) in "data", with "mime_type".',
  binary:     'The file as Base64 (or hex) in "data", with "size" and "mime_type".',
  html:       'HTML from the Report Generator. File Output writes the "content" field as an .html file.',
  excel_b64:  'Excel from the Report Generator. File Output decodes "content" (base64) and writes an .xlsx file.',
}
