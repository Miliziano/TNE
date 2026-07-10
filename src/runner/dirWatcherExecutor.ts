/**
 * src/runner/dirWatcherExecutor.ts
 * ──────────────────────────────────
 * Implementa StreamingNodeExecutor — ogni file rilevato viene
 * emesso immediatamente via onRow() invece di accumulare alla fine.
 */

import type { Row, ExecutionContext, StreamingNodeExecutor } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'

interface FileRow extends Row {
  path:        string
  filename:    string
  extension:   string
  directory:   string
  size:        number
  created_at:  string | null
  modified_at: string | null
  event?:      string
}

function globToRegex(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i')
}

function parseFilePath(fullPath: string): { filename: string; extension: string; directory: string } {
  const normalized = fullPath.replace(/\\/g, '/')
  const lastSlash  = normalized.lastIndexOf('/')
  const directory  = lastSlash >= 0 ? normalized.slice(0, lastSlash) : ''
  const filename   = lastSlash >= 0 ? normalized.slice(lastSlash + 1) : normalized
  const dotIdx     = filename.lastIndexOf('.')
  const extension  = dotIdx >= 0 ? filename.slice(dotIdx + 1) : ''
  return { filename, extension, directory }
}

async function listDirectory(path: string): Promise<Array<{
  name: string; path: string; is_dir: boolean; size: number
}>> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<Array<{ name: string; path: string; is_dir: boolean; size: number }>>(
    'list_directory', { path }
  )
}

async function getFileStat(path: string): Promise<{ created_at: string | null; modified_at: string | null; size: number }> {
  try {
    const { stat } = await import('@tauri-apps/plugin-fs')
    const s = await stat(path)
    const mtime = s.mtime ? new Date(s.mtime).toISOString() : null
    return { size: s.size ?? 0, modified_at: mtime, created_at: mtime }
  } catch {
    return { size: 0, created_at: null, modified_at: null }
  }
}

async function scanDirectory(
  dirPath:   string,
  pattern:   RegExp,
  recursive: boolean,
  maxAge:    number,
  minSize:   number,
): Promise<FileRow[]> {
  const entries = await listDirectory(dirPath)
  const rows: FileRow[] = []
//console.log('scanDirectory:', dirPath, 'entries:', entries.length, entries.slice(0,3))
  
  for (const entry of entries) {
     // console.log('entry:', entry.name, 'is_dir:', entry.is_dir, 'matches:', pattern.test(entry.name))

    if (entry.is_dir) {
      if (recursive) rows.push(...await scanDirectory(entry.path, pattern, recursive, maxAge, minSize))
      continue
    }
    if (!pattern.test(entry.name)) continue
    if (minSize > 0 && entry.size < minSize) continue

    const stat = await getFileStat(entry.path)
    if (maxAge > 0 && stat.modified_at) {
      if ((Date.now() - new Date(stat.modified_at).getTime()) / 60000 > maxAge) continue
    }

    const { filename, extension, directory } = parseFilePath(entry.path)
    rows.push({
      path: entry.path, filename, extension, directory,
      size: stat.size || entry.size,
      created_at: stat.created_at, modified_at: stat.modified_at,
    })
  }
  return rows
}

function sortFiles(rows: FileRow[], sortBy: string, sortDir: string): FileRow[] {
  return [...rows].sort((a, b) => {
    let av: string | number, bv: string | number
    switch (sortBy) {
      case 'created':  av = a.created_at  ?? ''; bv = b.created_at  ?? ''; break
      case 'modified': av = a.modified_at ?? ''; bv = b.modified_at ?? ''; break
      case 'size':     av = a.size;               bv = b.size;               break
      default:         av = a.filename.toLowerCase(); bv = b.filename.toLowerCase()
    }
    const cmp = av < bv ? -1 : av > bv ? 1 : 0
    return sortDir === 'desc' ? -cmp : cmp
  })
}

// ─── Dedup in memoria ─────────────────────────────────────────────
const memoryDedup = new Map<string, Set<string>>()

function makeDedupFilter(nodeId: string, dedupMode: string) {
  if (dedupMode === 'none') return () => true
  if (!memoryDedup.has(nodeId)) memoryDedup.set(nodeId, new Set())
  const seen = memoryDedup.get(nodeId)!
  return (row: FileRow): boolean => {
    const key = dedupMode === 'path_mtime'
      ? `${row.path}::${row.modified_at}`
      : row.path
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }
}

// ─── Executor streaming ───────────────────────────────────────────
export const dirWatcherExecutor: StreamingNodeExecutor = {
  handles:   ['dir_watcher'],
  streaming: true,

  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
    onRow:   (row: Row) => Promise<void>,
    onDone:  (totalRows: number) => void,
  ): Promise<void> {
    const props = node.data.props ?? {}

    const mode            = (props['mode']            as string) ?? 'scan'
    const pathSource      = (props['pathSource']      as string) ?? 'static'
    const pattern         = (props['pattern']         as string) ?? '*'
    const recursive       = (props['recursive']       as string) === 'true'
    const minSize         = parseInt((props['minSize']        as string) ?? '0',    10)
    const maxAgeMin       = parseInt((props['maxAgeMin']      as string) ?? '0',    10)
    const dedup           = (props['dedup']           as string) ?? 'path'
    const stabilityMs     = parseInt((props['stabilityMs']    as string) ?? '500',  10)
    const debounceMs      = parseInt((props['debounceMs']     as string) ?? '300',  10)
    const eventsRaw       = (props['events']          as string) ?? 'create'
    const sortBy          = (props['sortBy']          as string) ?? 'name'
    const sortDir         = (props['sortDir']         as string) ?? 'asc'
    const limit           = parseInt((props['limit']          as string) ?? '0',    10)
    const watchTimeoutSec = parseInt(
      (props['watchTimeoutSec'] as string) || '300', 10
    )
    // Gestisce NaN (campo vuoto) e 0 (infinito → timeout molto lungo)
    const effectiveTimeout = isNaN(watchTimeoutSec)
      ? 300
      : watchTimeoutSec === 0
        ? 86400   // 0 = "infinito" → 24 ore come massimo pratico
        : watchTimeoutSec

    const watchEvents = eventsRaw === 'all'
      ? ['create', 'modify', 'delete']
      : eventsRaw.split(',').map((s) => s.trim())

    // ── Risolvi path ──────────────────────────────────────────────
    let directory = ''
    if (pathSource === 'static') {
      directory = (props['directory'] as string) ?? ''
    } else if (pathSource === 'flow') {
      const pathField = (props['pathField'] as string) ?? 'path'
      directory = input.length > 0 ? String(input[0][pathField] ?? '') : ''
    } else {
      directory = (props['directory'] as string) ?? ''
    }

    if (!directory) {
      context.callbacks.onLog('warn', 'DirWatcher: directory non configurata', node.id)
      onDone(0); return
    }

    directory = directory.replace(/\/+$/, '')
    context.callbacks.onLog('info', `DirWatcher (${mode}): ${directory} — pattern: ${pattern}`, node.id)
    context.callbacks.onLog('debug',
      `DirWatcher props: watchTimeoutSec=${props['watchTimeoutSec']}`,
      node.id
    )
    const patternRegex = globToRegex(pattern)
    const filterDedup  = makeDedupFilter(node.id, dedup)
    let   totalRows    = 0

    // ── SCAN — emette ogni file subito ────────────────────────────
    if (mode === 'scan') {
      let rows = await scanDirectory(directory, patternRegex, recursive, maxAgeMin, minSize)
      rows = rows.filter(filterDedup)
      rows = sortFiles(rows, sortBy, sortDir)
      if (limit > 0) rows = rows.slice(0, limit)

      for (const row of rows) {
        if (context.callbacks.isAborted()) break
        context.callbacks.onLog('info', `DirWatcher: ${row.filename}`, node.id)
        await onRow(row)
        totalRows++
      }

      context.callbacks.onLog('ok', `DirWatcher scan: ${totalRows} file emessi`, node.id)
      onDone(totalRows)
      return
    }

    // ── WATCH — emette ogni file rilevato immediatamente ──────────
    if (mode === 'watch') {
      const fsPlugin = await import('@tauri-apps/plugin-fs')
      const watchFn  = fsPlugin.watch

      if (typeof watchFn !== 'function') {
        throw new Error('DirWatcher: watch non disponibile. Aggiungi features = ["watch"] in Cargo.toml.')
      }

      context.callbacks.onLog('info',
        `DirWatcher watch: in ascolto su '${directory}' per ${effectiveTimeout}s — ogni file processato subito`,
        node.id
      )

      const controller = new AbortController()
      const stopTimer = setTimeout(() => controller.abort(), effectiveTimeout * 1000)
      const pollAbort  = setInterval(() => { if (context.callbacks.isAborted()) controller.abort() }, 500)

      let debounceTimer: ReturnType<typeof setTimeout> | null = null
      const pending = new Map<string, string>()  // path → evtName

      const processPending = async () => {
        for (const [filePath, evtName] of [...pending]) {
          pending.delete(filePath)
          if (evtName === 'delete' || controller.signal.aborted) continue

          // Aspetta stabilità file
          if (stabilityMs > 0) await new Promise((r) => setTimeout(r, stabilityMs))
          if (controller.signal.aborted) return

          const stat = await getFileStat(filePath)
          const { filename, extension, directory: dir } = parseFilePath(filePath)

          const row: FileRow = {
            path: filePath, filename, extension,
            directory: dir,
            size: stat.size, created_at: stat.created_at,
            modified_at: stat.modified_at, event: evtName,
          }

          if (!filterDedup(row)) continue

          context.callbacks.onLog('info', `DirWatcher: ${evtName} — ${filename}`, node.id)

          // ← EMISSIONE IMMEDIATA: il runner esegue i nodi a valle ora
          await onRow(row)
          totalRows++
        }
      }

      const unwatch = await watchFn(
        directory,
        (watchEvent: any) => {
          // Struttura Tauri plugin-fs 2.5:
          // { type: { create|modify|access|remove: {...} }, paths: [...] }
          const typeObj  = watchEvent.type ?? {}
          const evtName: string | null =
            'create' in typeObj ? 'create' :
            'modify' in typeObj ? 'modify' :
            'remove' in typeObj ? 'delete' :
            null

          if (!evtName) return  // ignora 'access' e altri
          if (!watchEvents.includes(evtName) && !watchEvents.includes('all')) return

          const evtPaths: string[] = Array.isArray(watchEvent.paths)
            ? watchEvent.paths
            : watchEvent.path ? [watchEvent.path] : []

          for (const p of evtPaths) {
            if (!p) continue
            const fname = p.replace(/\\/g, '/').split('/').pop() ?? ''
            if (!patternRegex.test(fname)) continue
            pending.set(p, evtName)
          }

          // Debounce — evita di processare lo stesso file più volte
          // per eventi multipli ravvicinati (es. create + modify in sequenza)
          if (debounceTimer) clearTimeout(debounceTimer)
          debounceTimer = setTimeout(() => {
            processPending().catch((e) =>
              context.callbacks.onLog('error', `DirWatcher: errore processing — ${e}`, node.id)
            )
          }, debounceMs)
        },
        { recursive: false },
      )

      // Aspetta abort (timeout o stop runner)
      await new Promise<void>((resolve) => {
        controller.signal.addEventListener('abort', () => {
          unwatch?.()
          clearTimeout(stopTimer)
          clearInterval(pollAbort)
          resolve()
        })
      })

      context.callbacks.onLog('ok', `DirWatcher watch terminato: ${totalRows} file processati`, node.id)
      onDone(totalRows)
      return
    }

    onDone(0)
  },
}