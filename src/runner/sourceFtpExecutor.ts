/**
 * src/runner/sourceFtpExecutor.ts
 */
import type { Row, NodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { readFileContent } from '../io/readers'
import { ftpList, ftpRead, buildFtpConnection } from '../lib/ftpClient'

export const sourceFtpExecutor: NodeExecutor = {
  handles: ['source_ftp'],

  async execute(
    node:    FlowNode<NodeData>,
    _input:  Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props = node.data.props ?? {}
    const p     = (k: string, d = '') => String(props[k] ?? d)

    // ── Risorsa FTP ───────────────────────────────────────────────
    const laneId     = node.data.laneId
    const resourceId = node.data.config?.resourceId as string | undefined
    const { useFlowStore } = await import('../store/flowStore')
    const store    = useFlowStore.getState()
    const laneData = store.pool.lanes.find((l) => l.id === laneId)
    const resource = laneData?.resources.find((r) => r.id === resourceId)

    if (!resource) {
      throw new Error('source_ftp: nessuna risorsa FTP configurata')
    }

    const conn        = buildFtpConnection(resource, props)
    const remotePath  = p('remotePath', '/')
    const pattern     = p('filePattern') || undefined
    const outputMode  = p('outputMode', 'content')   // 'content' | 'list_files'
    const fileFormat  = p('fileFormat', 'csv')
    const delimiter   = p('delimiter', ',')
    const maxFiles    = parseInt(p('maxFiles', '0'), 10)
    const limit       = parseInt(p('limit', '0'), 10)
    const onFileError = p('onFileError', 'skip')

    context.callbacks.onLog('info', `FTP: connessione a ${conn.host}:${conn.port} (${conn.protocol})`, node.id)

    // ── Lista file ────────────────────────────────────────────────
    const entries = await ftpList(conn, remotePath, pattern, false)

    if (entries.length === 0) {
      context.callbacks.onLog('warn', `FTP: nessun file trovato in '${remotePath}'${pattern ? ` (pattern: ${pattern})` : ''}`, node.id)
      return new Map([['output', []]])
    }

    // ── Modalità LISTA FILE — non scarica, emette metadati ────────
    if (outputMode === 'list_files') {
      context.callbacks.onLog('info', `FTP: trovati ${entries.length} elementi in '${remotePath}'`, node.id)
      const rows: Row[] = entries.map((e) => ({
        name:        e.name,
        path:        e.path,
        is_dir:      e.is_dir,
        size:        e.size,
        modified_at: e.modified_at ?? null,
      }))
      return new Map([['output', rows]])
    }

    // ── Modalità CONTENT — scarica e parsa ────────────────────────
    const files = entries.filter((e) => !e.is_dir)
    if (files.length === 0) {
      context.callbacks.onLog('warn', `FTP: nessun file (solo directory) in '${remotePath}'`, node.id)
      return new Map([['output', []]])
    }

    context.callbacks.onLog('info', `FTP: trovati ${files.length} file`, node.id)
    const filesToRead = maxFiles > 0 ? files.slice(0, maxFiles) : files
    const allRows: Row[] = []

    for (const file of filesToRead) {
      if (context.callbacks.isAborted()) break

      context.callbacks.onLog('info', `FTP: leggo ${file.name}`, node.id)

      try {
        const content = await ftpRead(conn, file.path)

        let rows: Row[]

        if (fileFormat === 'raw') {
          // Grezzo — una riga con il contenuto intero
          rows = [{
            content,
            _filename:    file.name,
            _filepath:    file.path,
            _filesize:    file.size,
            _modified_at: file.modified_at ?? null,
          }]
        } else {
          // Parsing normale
          rows = await readFileContent(content, file.name, {
            format:    fileFormat || undefined,
            delimiter: delimiter  || ',',
          })
          if (limit > 0) rows = rows.slice(0, limit)
          // Aggiunge metadati file
          rows = rows.map((row) => ({
            ...row,
            _filename:    file.name,
            _filepath:    file.path,
            _filesize:    file.size,
            _modified_at: file.modified_at ?? null,
          }))
        }

        allRows.push(...rows)
        context.callbacks.onLog('info', `FTP: ${file.name} — ${rows.length} righe`, node.id)

      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('warn', `FTP: errore su ${file.name} — ${msg}`, node.id)
        if (onFileError === 'stop') throw new Error(`FTP: errore su ${file.name}: ${msg}`)
      }
    }

    context.callbacks.onLog('info', `FTP: ${allRows.length} righe totali da ${filesToRead.length} file`, node.id)
    return new Map([['output', allRows]])
  },
}