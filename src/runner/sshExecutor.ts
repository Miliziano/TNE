/**
 * src/runner/sshExecutor.ts
 *
 * Executor per il nodo SSH — esegue comandi su host remoto via SSH.
 * Usa le credenziali della risorsa SSH configurata nel ResourcePanel.
 *
 * Identico a shellExecutor ma aggiunge host/user/auth al comando Tauri.
 *
 * Comando Tauri necessario in lib.rs:
 *   ssh_exec(connection: SshConnection, command: String, timeout_sec: Option<u64>)
 *   → ShellResult { exit_code: i32, stdout: String, stderr: String, duration_ms: u64 }
 *
 *   ssh_test(connection: SshConnection) → { ok: bool, message: String, elapsed_ms: u64 }
 *
 * SshConnection:
 *   { host: String, port: u16, user: String,
 *     auth_type: String,       // "password" | "key" | "key_passphrase"
 *     password: Option<String>,
 *     key_path: Option<String>,
 *     key_passphrase: Option<String>,
 *     known_hosts_check: bool,
 *     connect_timeout_sec: u64 }
 *
 * Registrare in executors.ts:
 *   import { sshExecutor } from './sshExecutor'
 *   EXECUTORS: [..., sshExecutor]
 */

import type { Row, StreamingNodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { invoke } from '@tauri-apps/api/core'

interface ShellResult {
  exit_code:   number
  stdout:      string
  stderr:      string
  duration_ms: number
}

interface SshConnection {
  host:                string
  port:                number
  user:                string
  auth_type:           string
  password?:           string
  key_path?:           string
  key_passphrase?:     string
  known_hosts_check:   boolean
  connect_timeout_sec: number
}

function p(node: FlowNode<NodeData>, key: string, def = ''): string {
  return String(node.data.props?.[key] ?? def)
}

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

function buildConnection(node: FlowNode<NodeData>, context: ExecutionContext): SshConnection {
  // Prima prova a leggere dalla risorsa collegata
  const resourceId = node.data.config?.resourceId as string | undefined
  if (resourceId) {
    for (const lane of context.lanes) {
      const res = lane.resources.find(r => r.id === resourceId)
      if (res?.kind === 'ssh') {
        return {
          host:                String(res.config.host ?? ''),
          port:                parseInt(String(res.config.port ?? '22'), 10),
          user:                String(res.config.user ?? ''),
          auth_type:           String(res.config.authType ?? 'password'),
          password:            res.config.password ? String(res.config.password) : undefined,
          key_path:            res.config.keyPath  ? String(res.config.keyPath)  : undefined,
          key_passphrase:      res.config.keyPassphrase ? String(res.config.keyPassphrase) : undefined,
          known_hosts_check:   String(res.config.knownHostsCheck ?? 'false') === 'true',
          connect_timeout_sec: parseInt(String(res.config.connectTimeout ?? '10'), 10),
        }
      }
    }
  }

  // Fallback: legge direttamente dai props del nodo
  return {
    host:                p(node, 'host', ''),
    port:                parseInt(p(node, 'port', '22'), 10),
    user:                p(node, 'user', ''),
    auth_type:           p(node, 'authType', 'password'),
    password:            p(node, 'password') || undefined,
    key_path:            p(node, 'keyPath')  || undefined,
    key_passphrase:      p(node, 'keyPassphrase') || undefined,
    known_hosts_check:   p(node, 'knownHostsCheck', 'false') === 'true',
    connect_timeout_sec: parseInt(p(node, 'connectTimeout', '10'), 10),
  }
}

export const sshExecutor: StreamingNodeExecutor = {
  handles:   ['ssh_exec'],
  streaming: true,

  async execute(node, input, context, onRow, onDone) {
    const command       = p(node, 'command', '')
    const outputMode    = p(node, 'outputMode', 'lines')
    const timeoutSec    = parseInt(p(node, 'timeoutSec', '30'), 10)
    const onError       = p(node, 'onError', 'stop')
    const captureStderr = p(node, 'captureStderr', 'true') === 'true'
    const runPerRow     = p(node, 'runPerRow', 'false') === 'true'

    if (!command.trim()) throw new Error('SSH: comando non configurato')

    const connection = buildConnection(node, context)
    if (!connection.host) throw new Error('SSH: host non configurato')
    if (!connection.user) throw new Error('SSH: utente non configurato')

    // Variabili di lane
    const laneVars: Record<string, string> = {}
    const lane = context.lanes.find(l => l.id === (node.data.laneId as string))
    if (lane?.variables) {
      for (const v of lane.variables) laneVars[v.name] = String(v.value ?? '')
    }

    const rows = runPerRow && input.length > 0 ? input : [input[0] ?? {}]
    let totalEmitted = 0

    for (const row of rows) {
      if (context.callbacks.isAborted()) break

      const resolvedCommand = resolveTemplate(command, row, laneVars)

      context.callbacks.onLog('info',
        `SSH [${connection.user}@${connection.host}:${connection.port}]: ${resolvedCommand}`, node.id)

      let result: ShellResult
      try {
        result = await invoke<ShellResult>('ssh_exec', {
          request: {
            connection,
            command:     resolvedCommand,
            timeout_sec: timeoutSec > 0 ? timeoutSec : null,
          },
        })
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        context.callbacks.onLog('error', `SSH: connessione fallita — ${msg}`, node.id)
        if (onError === 'stop') throw new Error(`SSH: ${msg}`)
        continue
      }

      context.callbacks.onLog(
        result.exit_code === 0 ? 'ok' : 'warn',
        `SSH: exit ${result.exit_code} | ${result.duration_ms}ms | ${connection.host}`,
        node.id
      )

      if (result.exit_code !== 0 && onError === 'stop') {
        throw new Error(
          `SSH: exit code ${result.exit_code} su ${connection.host}\n${result.stderr || result.stdout}`
        )
      }

      // ── Emissione righe ──────────────────────────────────────
      const meta = {
        ssh_host:     connection.host,
        ssh_user:     connection.user,
        ssh_command:  resolvedCommand,
        ssh_exit_code: result.exit_code,
        ssh_duration_ms: result.duration_ms,
      }

      if (outputMode === 'summary') {
        await onRow({
          ...row, ...meta,
          stdout:       result.stdout,
          stderr:       result.stderr,
          stdout_lines: result.stdout.split('\n').filter(Boolean).length,
          stderr_lines: result.stderr.split('\n').filter(Boolean).length,
          ok:           result.exit_code === 0,
        })
        totalEmitted++

      } else if (outputMode === 'json') {
        try {
          const parsed = JSON.parse(result.stdout.trim())
          const arr = Array.isArray(parsed) ? parsed : [parsed]
          for (const item of arr) {
            await onRow({ ...row, ...meta, ...item })
            totalEmitted++
          }
        } catch {
          for (const [i, line] of result.stdout.split('\n').filter(Boolean).entries()) {
            await onRow({ ...row, ...meta, line, line_number: i + 1, stream: 'stdout' })
            totalEmitted++
          }
        }

      } else if (outputMode === 'jsonl') {
        for (const [i, line] of result.stdout.split('\n').filter(Boolean).entries()) {
          try {
            await onRow({ ...row, ...meta, ...JSON.parse(line) })
          } catch {
            await onRow({ ...row, ...meta, line, line_number: i + 1 })
          }
          totalEmitted++
        }

      } else {
        // lines
        for (const [i, line] of result.stdout.split('\n').filter(Boolean).entries()) {
          await onRow({ ...row, ...meta, line, line_number: i + 1, stream: 'stdout' })
          totalEmitted++
        }
        if (captureStderr) {
          for (const [i, line] of result.stderr.split('\n').filter(Boolean).entries()) {
            await onRow({ ...row, ...meta, line, line_number: i + 1, stream: 'stderr' })
            totalEmitted++
          }
        }
      }
    }

    onDone(totalEmitted)
  },
}
