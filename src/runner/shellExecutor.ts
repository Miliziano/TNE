/**
 * src/runner/shellExecutor.ts
 *
 * Executor per il nodo Shell — esegue comandi bash/shell locali
 * tramite Tauri e porta l'output nel flusso come righe.
 *
 * Ogni riga di stdout diventa una Row con campi:
 *   line        — riga di output
 *   line_number — numero riga (1-based)
 *   stream      — 'stdout' | 'stderr'
 *
 * Al termine emette una riga di summary con:
 *   exit_code, stdout_lines, stderr_lines, duration_ms, command
 *
 * Modalità:
 *   lines   — ogni riga stdout è una Row (default)
 *   json    — parse dell'output come JSON array
 *   jsonl   — ogni riga è un JSON object
 *   summary — solo la riga di summary finale
 *
 * Variabili di template nel comando:
 *   $field_name  — sostituisce con il valore del campo della riga in ingresso
 *   ${VAR}       — variabile di lane
 *
 * Registrare in executors.ts:
 *   import { shellExecutor } from './shellExecutor'
 *   EXECUTORS: [..., shellExecutor]
 *
 * Comando Tauri necessario in lib.rs:
 *   shell_exec(command: String, cwd: Option<String>, timeout_sec: Option<u64>, env: Option<HashMap<String,String>>)
 *   → ShellResult { exit_code: i32, stdout: String, stderr: String, duration_ms: u64 }
 */

import type { Row, StreamingNodeExecutor, ExecutionContext } from '../io/types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { invoke } from '@tauri-apps/api/core'

interface ShellResult {
  exit_code:   number
  stdout:      string
  stderr:      string
  duration_ms: number
}

function p(node: FlowNode<NodeData>, key: string, def = ''): string {
  return String(node.data.props?.[key] ?? def)
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}

/** Sostituisce $field e ${field} con i valori della riga o delle variabili di lane */
function resolveTemplate(
  template: string,
  row:      Row,
  laneVars: Record<string, string>,
): string {
  return template
    .replace(/\$\{([^}]+)\}/g, (_, name) =>
      String(row[name] ?? laneVars[name] ?? `\${${name}}`)
    )
    .replace(/\$([a-zA-Z_][a-zA-Z0-9_]*)/g, (_, name) =>
      String(row[name] ?? laneVars[name] ?? `$${name}`)
    )
}

export const shellExecutor: StreamingNodeExecutor = {
  handles:   ['shell_exec'],
  streaming: true,

  async execute(node, input, context, onRow, onDone) {
    const command      = p(node, 'command', '')
    const cwd          = p(node, 'cwd', '')
    const outputMode   = p(node, 'outputMode', 'lines')
    const timeoutSec   = parseInt(p(node, 'timeoutSec', '30'), 10)
    const onError      = p(node, 'onError', 'stop')
    const captureStderr = p(node, 'captureStderr', 'true') === 'true'
    const envRaw       = p(node, 'env', '{}')
    const runPerRow    = p(node, 'runPerRow', 'false') === 'true'

    if (!command.trim()) throw new Error('Shell: comando non configurato')

    // Legge variabili di lane
    const laneVars: Record<string, string> = {}
    const lane = context.lanes.find(l => l.id === (node.data.laneId as string))
    if (lane?.variables) {
      for (const v of lane.variables) laneVars[v.name] = String(v.value ?? '')
    }

    // Parsa env vars addizionali
    let env: Record<string, string> = {}
    try { env = JSON.parse(envRaw) } catch {}

    // Righe da processare — se runPerRow è false, esegui una volta con riga vuota
    const rows = runPerRow && input.length > 0 ? input : [input[0] ?? {}]

    let totalEmitted = 0

    for (const row of rows) {
      if (context.callbacks.isAborted()) break

      const resolvedCommand = resolveTemplate(command, row, laneVars)
      const resolvedCwd     = cwd ? resolveTemplate(cwd, row, laneVars) : undefined

      context.callbacks.onLog('info',
        `Shell: eseguo — ${resolvedCommand}`, node.id)

      let result: ShellResult
      try {
        result = await invoke<ShellResult>('shell_exec', {
          request: {
            command:     resolvedCommand,
            cwd:         resolvedCwd || null,
            timeout_sec: timeoutSec > 0 ? timeoutSec : null,
            env:         Object.keys(env).length > 0 ? env : null,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error', `Shell: invocazione fallita — ${msg}`, node.id)
        if (onError === 'stop') throw new Error(`Shell: ${msg}`)
        continue
      }

      context.callbacks.onLog(
        result.exit_code === 0 ? 'ok' : 'warn',
        `Shell: exit ${result.exit_code} | ${result.duration_ms}ms | stdout: ${result.stdout.split('\n').filter(Boolean).length} righe`,
        node.id
      )

      if (result.stderr && captureStderr) {
        for (const line of result.stderr.split('\n').filter(Boolean)) {
          context.callbacks.onLog('warn', `Shell stderr: ${line}`, node.id)
        }
      }

      // Controllo exit code
      if (result.exit_code !== 0 && onError === 'stop') {
        throw new Error(
          `Shell: exit code ${result.exit_code}\n${result.stderr || result.stdout}`
        )
      }

      // ── Emissione righe in base alla modalità ─────────────────
      if (outputMode === 'summary') {
        await onRow({
          ...row,
          command:      resolvedCommand,
          exit_code:    result.exit_code,
          stdout:       result.stdout,
          stderr:       result.stderr,
          stdout_lines: result.stdout.split('\n').filter(Boolean).length,
          stderr_lines: result.stderr.split('\n').filter(Boolean).length,
          duration_ms:  result.duration_ms,
          ok:           result.exit_code === 0,
        })
        totalEmitted++

      } else if (outputMode === 'json') {
        try {
          const parsed = JSON.parse(result.stdout.trim())
          const arr = Array.isArray(parsed) ? parsed : [parsed]
          for (const item of arr) {
            await onRow({ ...row, ...item, _exit_code: result.exit_code })
            totalEmitted++
          }
        } catch {
          context.callbacks.onLog('warn',
            `Shell [json]: output non è JSON valido — fallback a lines`, node.id)
          for (const [i, line] of result.stdout.split('\n').filter(Boolean).entries()) {
            await onRow({ ...row, line, line_number: i + 1, stream: 'stdout', exit_code: result.exit_code })
            totalEmitted++
          }
        }

      } else if (outputMode === 'jsonl') {
        for (const [i, line] of result.stdout.split('\n').filter(Boolean).entries()) {
          try {
            const parsed = JSON.parse(line)
            await onRow({ ...row, ...parsed, _exit_code: result.exit_code })
          } catch {
            await onRow({ ...row, line, line_number: i + 1, stream: 'stdout', exit_code: result.exit_code })
          }
          totalEmitted++
        }

      } else {
        // lines — default
        const stdoutLines = result.stdout.split('\n').filter(Boolean)
        for (const [i, line] of stdoutLines.entries()) {
          await onRow({ ...row, line, line_number: i + 1, stream: 'stdout', exit_code: result.exit_code, duration_ms: result.duration_ms })
          totalEmitted++
        }
        if (captureStderr) {
          for (const [i, line] of result.stderr.split('\n').filter(Boolean).entries()) {
            await onRow({ ...row, line, line_number: i + 1, stream: 'stderr', exit_code: result.exit_code })
            totalEmitted++
          }
        }
      }
    }

    onDone(totalEmitted)
  },
}
