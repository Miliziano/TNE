/**
 * src/lib/tauri.ts
 * ────────────────
 * Bridge tipizzato tra il frontend React e il backend Rust/Tauri.
 * Tutte le chiamate IPC passano da qui — mai invoke() diretto nei componenti.
 */

import { invoke } from '@tauri-apps/api/core'
import { open, save } from '@tauri-apps/plugin-dialog'

// ─── Rilevamento ambiente ─────────────────────────────────────────
export const isTauri = (): boolean => {
  return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window
}

// ─── Tipi ─────────────────────────────────────────────────────────
export interface FileEntry {
  name:   string
  path:   string
  is_dir: boolean
  size:   number
}

// ─── Filesystem ───────────────────────────────────────────────────

/**
 * Legge un file di testo dal filesystem locale.
 */
export async function readFile(path: string): Promise<string> {
  if (!isTauri()) throw new Error('readFile disponibile solo in app desktop')
  return invoke<string>('read_file', { path })
}

/**
 * Legge un file binario dal filesystem locale.
 * Restituisce un ArrayBuffer — usabile da SheetJS, PDF.js, ecc.
 *
 * Il backend Rust legge il file e lo restituisce come stringa base64.
 * Il frontend decodifica il base64 in ArrayBuffer.
 */
export async function readBinaryFile(path: string): Promise<ArrayBuffer> {
  if (!isTauri()) throw new Error('readBinaryFile disponibile solo in app desktop')
  const base64 = await invoke<string>('read_file_bytes', { path })
  // Decodifica base64 → Uint8Array → ArrayBuffer
  const binary = atob(base64)
  const bytes  = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes.buffer
}

/**
 * Scrive un file di testo sul filesystem locale.
 */
export async function writeFile(path: string, content: string): Promise<void> {
  if (!isTauri()) throw new Error('writeFile disponibile solo in app desktop')
  return invoke<void>('write_file', { path, content })
}

/**
 * Scrive un file binario su disco decodificando il contenuto base64.
 */
export async function writeFileBytes(path: string, contentBase64: string): Promise<void> {
  if (!isTauri()) throw new Error('writeFileBytes disponibile solo in app desktop')
  return invoke<void>('write_file_bytes', { path, contentBase64 })
}

/**
 * Lista il contenuto di una directory.
 */
export async function listDirectory(path: string): Promise<FileEntry[]> {
  if (!isTauri()) return []
  return invoke<FileEntry[]>('list_directory', { path })
}

/**
 * Restituisce la directory dati dell'app.
 */
export async function getAppDataDir(): Promise<string> {
  if (!isTauri()) return '/tmp/FlowPilot'
  return invoke<string>('get_app_data_dir')
}

// ─── Dialog ───────────────────────────────────────────────────────

export async function openFileDialog(options?: {
  title?:       string
  filters?:     Array<{ name: string; extensions: string[] }>
  multiple?:    boolean
  directory?:   boolean
  defaultPath?: string
}): Promise<string | string[] | null> {
  if (!isTauri()) return null
  return open({
    title:       options?.title,
    filters:     options?.filters,
    multiple:    options?.multiple ?? false,
    directory:   options?.directory ?? false,
    defaultPath: options?.defaultPath,
  })
}

export async function saveFileDialog(options?: {
  title?:       string
  filters?:     Array<{ name: string; extensions: string[] }>
  defaultPath?: string
}): Promise<string | null> {
  if (!isTauri()) return null
  return save({
    title:       options?.title,
    filters:     options?.filters,
    defaultPath: options?.defaultPath,
  })
}

// ─── Helpers per FlowPilot ────────────────────────────────────────

export async function openDataFileDialog(): Promise<string | null> {
  const result = await openFileDialog({
    title: 'Seleziona file dati',
    filters: [
      { name: 'Dati',         extensions: ['csv', 'txt','json', 'jsonl', 'tsv', 'xml', 'xlsx', 'xls'] },
      { name: 'CSV',          extensions: ['csv', 'tsv'] },
      { name: 'JSON',         extensions: ['json', 'jsonl'] },
      { name: 'Excel',        extensions: ['xlsx', 'xls'] },
      { name: 'Tutti i file', extensions: ['*'] },
    ],
  })
  return Array.isArray(result) ? result[0] : result
}

export async function openDirectoryDialog(): Promise<string | null> {
  const result = await openFileDialog({ title: 'Seleziona directory', directory: true })
  return Array.isArray(result) ? result[0] : result
}

export async function savePlanDialog(): Promise<string | null> {
  return saveFileDialog({
    title:       'Salva pipeline FlowPilot',
    filters:     [{ name: 'FlowPilot Plan', extensions: ['ffplan', 'json'] }],
    defaultPath: 'pipeline.ffplan',
  })
}

export async function openPlanDialog(): Promise<string | null> {
  const result = await openFileDialog({
    title:   'Apri pipeline FlowPilot',
    filters: [{ name: 'FlowPilot Plan', extensions: ['ffplan', 'json'] }],
  })
  return Array.isArray(result) ? result[0] : result
}

// ─── Persistenza progetti ─────────────────────────────────────────

export async function saveProjectLocally(
  projectName: string,
  version:     string,
  planJson:    string,
): Promise<string> {
  const appDir = await getAppDataDir()
  const path   = `${appDir}/projects/${projectName}/${version}.ffplan`
  await writeFile(path, planJson)
  return path
}

export async function loadProjectLocally(
  projectName: string,
  version:     string,
): Promise<string> {
  const appDir = await getAppDataDir()
  const path   = `${appDir}/projects/${projectName}/${version}.ffplan`
  return readFile(path)
}

export async function listLocalProjects(): Promise<FileEntry[]> {
  const appDir = await getAppDataDir()
  try { return listDirectory(`${appDir}/projects`) } catch { return [] }
}