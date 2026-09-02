/**
 * src/schema/schemaFile.ts
 *
 * Formato UNICO del "file di campi" (schema portabile), definito una volta
 * sola e usato da ENTRAMBI i lati: l'export (source_db, e in futuro TMap /
 * sink) e l'import-da-file (TMap). Così i due lati non possono divergere —
 * la stessa lezione dei due lettori Postgres.
 *
 * È un JSON piccolo e auto-descrittivo: un tag di versione, una provenienza
 * facoltativa (per chi progetta) e la lista dei campi.
 */

import { isTauri, saveFileDialog, writeFile } from '../lib/tauri'

export interface SchemaFileField {
  name: string
  type: string
  dbType?: string
  nullable?: boolean
}

export interface SchemaFileSource {
  node?: string    // tipo del nodo che ha prodotto lo schema (es. "source_db")
  label?: string   // etichetta del nodo
  table?: string   // tabella/target, se pertinente
}

export interface SchemaFile {
  flowpilot_schema: 1
  source?: SchemaFileSource
  fields: SchemaFileField[]
}

/** Serializza uno schema nel formato file (JSON leggibile). */
export function serializeSchema(fields: SchemaFileField[], source?: SchemaFileSource): string {
  const doc: SchemaFile = {
    flowpilot_schema: 1,
    ...(source ? { source } : {}),
    fields: fields.map((f) => ({
      name: f.name,
      type: f.type,
      ...(f.dbType ? { dbType: f.dbType } : {}),
      ...(f.nullable !== undefined ? { nullable: f.nullable } : {}),
    })),
  }
  return JSON.stringify(doc, null, 2)
}

/**
 * Legge e valida un file di schema. Accetta sia il formato con involucro
 * ({ flowpilot_schema, fields }) sia un semplice array di campi (tollerante).
 * Lancia un errore leggibile se il contenuto non è utilizzabile.
 */
export function parseSchema(text: string): SchemaFileField[] {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('il file non è JSON valido')
  }

  const raw: unknown = Array.isArray(data)
    ? data
    : (data && typeof data === 'object' && Array.isArray((data as { fields?: unknown }).fields))
      ? (data as { fields: unknown[] }).fields
      : null

  if (!raw || !Array.isArray(raw)) {
    throw new Error('formato non riconosciuto: manca l\u2019elenco dei campi')
  }

  const fields: SchemaFileField[] = []
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`campo ${i + 1}: non è un oggetto`)
    }
    const o = item as Record<string, unknown>
    const name = typeof o.name === 'string' ? o.name.trim() : ''
    if (!name) throw new Error(`campo ${i + 1}: nome mancante`)
    fields.push({
      name,
      type: typeof o.type === 'string' && o.type ? o.type : 'string',
      ...(typeof o.dbType === 'string' ? { dbType: o.dbType } : {}),
      ...(typeof o.nullable === 'boolean' ? { nullable: o.nullable } : {}),
    })
  })

  if (fields.length === 0) throw new Error('il file non contiene campi')
  return fields
}

/**
 * Salva uno schema come file .json. Nell'app desktop usa il dialogo di
 * salvataggio + scrittura su disco (il download <a> del browser NON funziona
 * nella webview di Tauri, "non fa niente"). In browser/dev ripiega sul blob.
 */
export async function downloadSchema(
  fields: SchemaFileField[],
  filenameBase: string,
  source?: SchemaFileSource,
): Promise<void> {
  const content = serializeSchema(fields, source)
  const safe    = (filenameBase || 'schema').replace(/[^\w.-]+/g, '_').slice(0, 60)
  const stamp   = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')
  const name    = `flowpilot-schema-${safe}-${stamp}.json`

  if (isTauri()) {
    const path = await saveFileDialog({
      title:       'Esporta schema campi',
      filters:     [{ name: 'Schema JSON', extensions: ['json'] }],
      defaultPath: name,
    })
    if (!path) return   // annullato dall'utente
    try {
      await writeFile(path, content)
    } catch (e) {
      alert(`Impossibile salvare lo schema: ${e instanceof Error ? e.message : String(e)}`)
    }
    return
  }

  // Fallback browser/dev: download via blob.
  const blob = new Blob([content], { type: 'application/json;charset=utf-8' })
  const url  = URL.createObjectURL(blob)
  const a    = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
