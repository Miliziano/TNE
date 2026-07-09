/**
 * src/runner/readers.ts
 * ─────────────────────
 * Lettori per i vari formati file — CSV, TSV, JSON, JSONL, XML, XLSX, TXT.
 * Tutti restituiscono Row[] (array di oggetti).
 */



import type { Row } from './types'

// ─── CSV / TSV ────────────────────────────────────────────────────
export async function readCsv(content: string, delimiter = ','): Promise<Row[]> {
  const { parse } = await import('csv-parse/browser/esm')
  return new Promise((resolve, reject) => {
    parse(content, {
      delimiter,
      columns:          true,
      skip_empty_lines: true,
      trim:             true,
      cast:             true,
      cast_date:        false,
    }, (err, records) => {
      if (err) reject(err)
      else resolve(records as Row[])
    })
  })
}

export async function readTsv(content: string): Promise<Row[]> {
  return readCsv(content, '\t')
}

// ─── JSON ─────────────────────────────────────────────────────────
export function readJson(content: string): Row[] {
  const parsed = JSON.parse(content)
  if (Array.isArray(parsed)) return parsed as Row[]
  if (typeof parsed === 'object' && parsed !== null) {
    return [{ content: parsed, raw: content }]  // ← produce content e raw
  }
  throw new Error('Il file JSON deve contenere un array o un oggetto')

}

// ─── JSONL ────────────────────────────────────────────────────────
export function readJsonl(content: string): Row[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('//'))
    .map((line, i) => {
      try { return JSON.parse(line) as Row }
      catch { throw new Error(`Riga JSONL ${i + 1} non valida: ${line.slice(0, 50)}`) }
    })
}

// ─── XML ──────────────────────────────────────────────────────────
export async function readXml(content: string, rootPath?: string): Promise<Row[]> {
  const { XMLParser } = await import('fast-xml-parser')
  const parser = new XMLParser({
    ignoreAttributes:       false,
    attributeNamePrefix:    '@_',
    allowBooleanAttributes: true,
    parseTagValue:          true,
    parseAttributeValue:    true,
    trimValues:             true,
  })
  const parsed = parser.parse(content)
  if (rootPath) {
    const parts  = rootPath.split('.')
    let current: unknown = parsed
    for (const part of parts) {
      if (typeof current === 'object' && current !== null && part in (current as Record<string, unknown>)) {
        current = (current as Record<string, unknown>)[part]
      } else {
        throw new Error(`Path XML '${rootPath}' non trovato`)
      }
    }
    if (Array.isArray(current)) return current as Row[]
    if (typeof current === 'object' && current !== null) return [current as Row]
    throw new Error(`Il path XML '${rootPath}' non punta a un array o oggetto`)
  }
  return findFirstArray(parsed)
}

function findFirstArray(obj: unknown): Row[] {
  if (Array.isArray(obj)) return obj as Row[]
  if (typeof obj !== 'object' || obj === null) return []
  for (const val of Object.values(obj as Record<string, unknown>)) {
    const found = findFirstArray(val)
    if (found.length > 0) return found
  }
  return [obj as Row]
}

// ─── XLSX ─────────────────────────────────────────────────────────
export async function readXlsx(buffer: ArrayBuffer, sheetName?: string): Promise<Row[]> {
  const XLSX     = await import('xlsx')
  const workbook = XLSX.read(buffer, { type: 'array', cellDates: true })
  const sheet    = sheetName
    ? workbook.Sheets[sheetName]
    : workbook.Sheets[workbook.SheetNames[0]]
  if (!sheet) throw new Error(`Sheet '${sheetName}' non trovato. Disponibili: ${workbook.SheetNames.join(', ')}`)
  return XLSX.utils.sheet_to_json(sheet, { defval: null, raw: false }) as Row[]
}

// ─── TXT ─────────────────────────────────────────────────────────
export function readTxt(content: string, options?: {
  delimiter?: string
  headers?:   string[]
  hasHeader?: boolean
}): Row[] {
  const lines = content.split('\n').map((l) => l.trimEnd()).filter((l) => l.length > 0)
  if (lines.length === 0) return []

  const delimiter = options?.delimiter
  if (!delimiter) {
    return lines.map((line, i) => ({ line, lineNumber: i + 1 }))
  }

  const hasHeader = options?.hasHeader ?? true
  let headers: string[]
  if (options?.headers) {
    headers = options.headers
  } else if (hasHeader) {
    headers = lines[0].split(delimiter).map((h) => h.trim())
    lines.shift()
  } else {
    const cols = lines[0].split(delimiter).length
    headers = Array.from({ length: cols }, (_, i) => `col_${i}`)
  }

  return lines.map((line) => {
    const values = line.split(delimiter)
    const row: Row = {}
    headers.forEach((h, i) => {
      const val = values[i]?.trim() ?? null
      row[h] = val !== null && val !== '' && !isNaN(Number(val)) ? Number(val) : val
    })
    return row
  })
}

// ─── Binary / Base64 ──────────────────────────────────────────────
// Legge qualsiasi file e lo restituisce come singola riga con campo `data`
// contenente il contenuto codificato in base64. Utile per:
// - Salvare file interi in un DB (BLOB o TEXT)
// - Passare file a API HTTP come attachment
// - Archivio documenti (PDF, immagini, ZIP, ecc.)
const MIME_TYPES: Record<string, string> = {
  pdf:  'application/pdf',
  png:  'image/png',
  jpg:  'image/jpeg',
  jpeg: 'image/jpeg',
  gif:  'image/gif',
  webp: 'image/webp',
  svg:  'image/svg+xml',
  zip:  'application/zip',
  gz:   'application/gzip',
  tar:  'application/x-tar',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls:  'application/vnd.ms-excel',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  doc:  'application/msword',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv:  'text/csv',
  txt:  'text/plain',
  json: 'application/json',
  xml:  'application/xml',
  html: 'text/html',
}

export function readBinary(content: string | ArrayBuffer, filename: string): Row[] {
  const ext      = filename.split('.').pop()?.toLowerCase() ?? ''
  const mimeType = MIME_TYPES[ext] ?? 'application/octet-stream'

  let base64: string
  if (content instanceof ArrayBuffer) {
    // ArrayBuffer → base64
    const bytes  = new Uint8Array(content)
    let   binary = ''
    // Processa in chunk per evitare stack overflow su file grandi
    const CHUNK  = 8192
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
    }
    base64 = btoa(binary)
  } else {
    // Stringa testo → base64 (gestisce UTF-8 correttamente)
    base64 = btoa(unescape(encodeURIComponent(content)))
  }

  return [{
    data:      base64,
    mime_type: mimeType,
    filename,
    size:      content instanceof ArrayBuffer ? content.byteLength : (content as string).length,
    encoding:  'base64',
  }]
}

// ─── Router principale ────────────────────────────────────────────
export async function readFileContent(
  content:  string | ArrayBuffer,
  filename: string,
  options?: {
    delimiter?:  string
    rootPath?:   string
    sheetName?:  string
    headers?:    string[]
    hasHeader?:  boolean
    format?:     string   // formato esplicito dal panel (sovrascrive l'estensione)
  }
): Promise<Row[]> {
  const ext    = filename.split('.').pop()?.toLowerCase() ?? ''
  // Il formato esplicito dal panel ha priorità sull'estensione
  const format = options?.format ?? ext

  switch (format) {
    case 'csv':
      return readCsv(content as string, options?.delimiter ?? ',')

    case 'tsv':
      return readTsv(content as string)

    case 'json':
      return readJson(content as string)

    case 'jsonl':
    case 'ndjson':
      return readJsonl(content as string)

   
    case 'xml':
      return [{ content: content as string }]
    case 'xsd':
      return readXml(content as string, options?.rootPath)

    case 'xlsx':
    case 'xls':
    case 'excel':
      return readXlsx(content as ArrayBuffer, options?.sheetName)

    case 'txt':
    case 'text':
      return readTxt(content as string, options)

    case 'raw':
    case 'raw_json':
    case 'raw_xml':
      return [{ content: content as string }]

    // ── Formati binari — producono una sola riga con campo data (base64) ──
    case 'binary':
    case 'bin':
    case 'pdf_binary':
    case 'pdf':
      return readBinary(content, filename)

    // ── Formati testo grezzo — producono campo content per i parser ──
    case 'pdf_text':
      // Il testo estratto da PDF arriva già come stringa
      return [{ text: content as string, pages: 1, metadata: {} }]

    default:
      // Fallback automatico: prova JSON, poi CSV, poi righe
      try { return readJson(content as string) } catch {}
      try { return await readCsv(content as string) } catch {}
      return readTxt(content as string)
  }
}