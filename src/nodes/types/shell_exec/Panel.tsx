/**
 * src/nodes/types/shell_exec/Panel.tsx
 * src/nodes/types/ssh_exec/Panel.tsx
 *
 * Esportati entrambi da questo file:
 *   ShellExecPanel  — per shell_exec
 *   SshExecPanel    — per ssh_exec
 */

import { useFlowStore } from '../../../store/flowStore'
import { CustomSelect } from '../../../components/CustomSelect'

// ─── Stili condivisi ─────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
const textareaStyle: React.CSSProperties = {
  ...inputStyle, resize: 'vertical', minHeight: 80,
  lineHeight: 1.6, fontFamily: 'monospace',
}

function SectionTitle({ label, color }: { label: string; color: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 8 }}>
      {label}
    </div>
  )
}
function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 9, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}
function Row2({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}
function InfoBox({ children, color }: { children: React.ReactNode; color: string }) {
  return (
    <div style={{ padding: '7px 10px', background: `color-mix(in srgb, ${color} 6%, #0f1117)`, borderRadius: 4, border: `0.5px solid ${color}30`, fontSize: 10, color: '#9a9aaa', lineHeight: 1.6 }}>
      {children}
    </div>
  )
}

// ─── SchemaRow — campo output ─────────────────────────────────────
function SchemaRow({ name, type, desc, color }: { name: string; type: string; desc: string; color: string }) {
  return (
    <div style={{ display: 'flex', gap: 8, marginBottom: 3, alignItems: 'baseline' }}>
      <code style={{ color, fontSize: 10, minWidth: 120, flexShrink: 0 }}>{name}</code>
      <span style={{ color: '#3a4a6a', fontSize: 9, minWidth: 50, flexShrink: 0 }}>{type}</span>
      <span style={{ color: '#8593b5', fontSize: 9 }}>{desc}</span>
    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// SHELL EXEC PANEL
// ════════════════════════════════════════════════════════════════

const SHELL_COLOR = '#22d3ee'

export function ShellExecPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)
  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const outputMode = p('outputMode', 'lines')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${SHELL_COLOR} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${SHELL_COLOR}30` }}>
        <i className="ti ti-terminal-2" style={{ fontSize: 16, color: SHELL_COLOR }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: SHELL_COLOR }}>Shell Executor</div>
          <div style={{ fontSize: 9, color: '#8593b5' }}>Runs local bash/shell commands — output into the flow</div>
        </div>
      </div>

      <InfoBox color={SHELL_COLOR}>
        Use <code style={{ color: SHELL_COLOR }}>$field</code> or <code style={{ color: SHELL_COLOR }}>${'{'}field{'}'}</code> to
        insert values from the incoming row or from lane variables into the command.
        Example: <code style={{ color: '#3ddc84', fontSize: 9 }}>kubectl get pods -n $namespace -o json</code>
      </InfoBox>

      {/* Comando */}
      <SectionTitle label="Command" color={SHELL_COLOR} />
      <Field label="Shell command" hint="Supports pipe, redirect, && — runs through /bin/sh">
        <textarea style={textareaStyle} value={p('command', '')} onChange={u('command')}
          placeholder="kubectl get nodes -o wide&#10;docker ps --format json&#10;ls -la /var/log" />
      </Field>
      <Row2>
        <Field label="Working directory (cwd)" hint="Leave empty for home">
          <input style={inputStyle} value={p('cwd', '')} onChange={u('cwd')} placeholder="/home/user/projects" />
        </Field>
        <Field label="Timeout (sec)" hint="0 = no limit">
          <input type="number" style={inputStyle} value={p('timeoutSec', '30')} onChange={u('timeoutSec')} min="0" />
        </Field>
      </Row2>

      {/* Variabili d'ambiente */}
      <SectionTitle label="Additional environment variables" color={SHELL_COLOR} />
      <Field label="Env (JSON)" hint='{"KUBECONFIG": "/home/user/.kube/config", "ENV": "prod"}'>
        <textarea style={{ ...textareaStyle, minHeight: 60 }} value={p('env', '{}')} onChange={u('env')}
          placeholder='{"MY_VAR": "value"}' />
      </Field>

      {/* Output */}
      <SectionTitle label="Output" color={SHELL_COLOR} />
      <Row2>
        <Field label="Output mode">
          <CustomSelect style={inputStyle} value={outputMode} onChange={u('outputMode')}>
            <option value="lines">Lines — each stdout line is a Row</option>
            <option value="json">JSON — parse output as a JSON array</option>
            <option value="jsonl">JSONL — each line is a JSON object</option>
            <option value="summary">Summary — only a final summary row</option>
          </CustomSelect>
        </Field>
        <Field label="Capture stderr">
          <CustomSelect style={inputStyle} value={p('captureStderr', 'true')} onChange={u('captureStderr')}>
            <option value="true">Yes — emits stderr rows into the flow</option>
            <option value="false">No — ignore stderr</option>
          </CustomSelect>
        </Field>
      </Row2>
      <Row2>
        <Field label="Run for each row">
          <CustomSelect style={inputStyle} value={p('runPerRow', 'false')} onChange={u('runPerRow')}>
            <option value="false">No — run only once</option>
            <option value="true">Yes — run for each incoming row</option>
          </CustomSelect>
        </Field>
        <Field label="If exit code ≠ 0">
          <CustomSelect style={inputStyle} value={p('onError', 'stop')} onChange={u('onError')}>
            <option value="stop">Stop the pipeline</option>
            <option value="skip">Continue — emit the rows anyway</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Schema output */}
      <SectionTitle label="Emitted row fields" color={SHELL_COLOR} />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        {outputMode === 'lines' && <>
          <SchemaRow color={SHELL_COLOR} name="line"        type="string"  desc="Text line" />
          <SchemaRow color={SHELL_COLOR} name="line_number" type="integer" desc="Row number (1-based)" />
          <SchemaRow color={SHELL_COLOR} name="stream"      type="string"  desc="'stdout' or 'stderr'" />
          <SchemaRow color={SHELL_COLOR} name="exit_code"   type="integer" desc="Command exit code" />
          <SchemaRow color={SHELL_COLOR} name="duration_ms" type="integer" desc="Execution duration" />
        </>}
        {outputMode === 'json' && <>
          <SchemaRow color={SHELL_COLOR} name="...(JSON fields)" type="any" desc="All fields of the JSON object" />
          <SchemaRow color={SHELL_COLOR} name="_exit_code"      type="integer" desc="Command exit code" />
        </>}
        {outputMode === 'jsonl' && <>
          <SchemaRow color={SHELL_COLOR} name="...(JSON fields)" type="any" desc="Fields of each JSONL line" />
          <SchemaRow color={SHELL_COLOR} name="_exit_code"      type="integer" desc="Command exit code" />
        </>}
        {outputMode === 'summary' && <>
          <SchemaRow color={SHELL_COLOR} name="command"      type="string"  desc="Executed command" />
          <SchemaRow color={SHELL_COLOR} name="exit_code"    type="integer" desc="Exit code" />
          <SchemaRow color={SHELL_COLOR} name="stdout"       type="string"  desc="Full output" />
          <SchemaRow color={SHELL_COLOR} name="stderr"       type="string"  desc="Full errors" />
          <SchemaRow color={SHELL_COLOR} name="stdout_lines" type="integer" desc="Number of stdout lines" />
          <SchemaRow color={SHELL_COLOR} name="duration_ms"  type="integer" desc="Duration in ms" />
          <SchemaRow color={SHELL_COLOR} name="ok"           type="boolean" desc="true if exit_code === 0" />
        </>}
      </div>

    </div>
  )
}

// ════════════════════════════════════════════════════════════════
// SSH EXEC PANEL
// ════════════════════════════════════════════════════════════════

const SSH_COLOR = '#a78bfa'

export function SshExecPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore(s => s.nodes.find(n => n.id === nodeId))
  const updateProp = useFlowStore(s => s.updateNodeProp)
  if (!node) return null

  const p = (key: string, def = '') => String(node.data.props?.[key] ?? def)
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const authType   = p('authType', 'password')
  const outputMode = p('outputMode', 'lines')

  // Risorse SSH disponibili nella lane
  const laneId    = node.data.laneId as string
  const lanes     = useFlowStore(s => s.pool.lanes)
  const sshRes    = lanes.find(l => l.id === laneId)?.resources.filter(r => r.kind === 'ssh') ?? []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Badge */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '7px 10px', background: `color-mix(in srgb, ${SSH_COLOR} 8%, #161b27)`, borderRadius: 6, border: `1px solid ${SSH_COLOR}30` }}>
        <i className="ti ti-server-bolt" style={{ fontSize: 16, color: SSH_COLOR }} />
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: SSH_COLOR }}>SSH Executor</div>
          <div style={{ fontSize: 9, color: '#8593b5' }}>Runs commands on a remote host via SSH</div>
        </div>
      </div>

      <InfoBox color={SSH_COLOR}>
        Use an <strong>SSH resource</strong> from the lane for the credentials, or configure them
        directly below. Use <code style={{ color: SSH_COLOR }}>$field</code> in the command
        to insert values from the incoming row.
      </InfoBox>

      {/* Connessione — risorsa o manuale */}
      <SectionTitle label="Connection" color={SSH_COLOR} />

      {sshRes.length > 0 && (
        <Field label="SSH resource from the lane" hint="Preferable to manual credentials">
          <CustomSelect style={inputStyle} value={p('resourceId', '')}
            onChange={e => updateProp(nodeId, 'resourceId', e.target.value)}>
            <option value="">— no resource (use manual credentials) —</option>
            {sshRes.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </CustomSelect>
        </Field>
      )}

      <Row2>
        <Field label="Host">
          <input style={inputStyle} value={p('host', '')} onChange={u('host')} placeholder="192.168.1.10" />
        </Field>
        <Field label="Port">
          <input type="number" style={inputStyle} value={p('port', '22')} onChange={u('port')} min="1" max="65535" />
        </Field>
      </Row2>
      <Field label="User">
        <input style={inputStyle} value={p('user', '')} onChange={u('user')} placeholder="ubuntu" />
      </Field>

      {/* Autenticazione */}
      <SectionTitle label="Authentication" color={SSH_COLOR} />
      <Field label="Type">
        <CustomSelect style={inputStyle} value={authType} onChange={u('authType')}>
          <option value="password">Password</option>
          <option value="key">Private key (no passphrase)</option>
          <option value="key_passphrase">Private key with passphrase</option>
        </CustomSelect>
      </Field>
      {authType === 'password' && (
        <Field label="Password">
          <input type="password" style={inputStyle} value={p('password', '')} onChange={u('password')} />
        </Field>
      )}
      {(authType === 'key' || authType === 'key_passphrase') && (
        <>
          <Field label="Private key path">
            <input style={inputStyle} value={p('keyPath', '')} onChange={u('keyPath')} placeholder="~/.ssh/id_rsa" />
          </Field>
          {authType === 'key_passphrase' && (
            <Field label="Passphrase">
              <input type="password" style={inputStyle} value={p('keyPassphrase', '')} onChange={u('keyPassphrase')} />
            </Field>
          )}
        </>
      )}
      <Row2>
        <Field label="Connection timeout (sec)">
          <input type="number" style={inputStyle} value={p('connectTimeout', '10')} onChange={u('connectTimeout')} min="1" />
        </Field>
        <Field label="Verify known_hosts">
          <CustomSelect style={inputStyle} value={p('knownHostsCheck', 'false')} onChange={u('knownHostsCheck')}>
            <option value="false">No — accept any host</option>
            <option value="true">Yes — verify known_hosts</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Comando */}
      <SectionTitle label="Remote command" color={SSH_COLOR} />
      <Field label="Command" hint="Run in the remote user's shell">
        <textarea style={textareaStyle} value={p('command', '')} onChange={u('command')}
          placeholder="systemctl status nginx&#10;docker ps --format json&#10;journalctl -n 100 --no-pager" />
      </Field>
      <Row2>
        <Field label="Execution timeout (sec)" hint="0 = no limit">
          <input type="number" style={inputStyle} value={p('timeoutSec', '30')} onChange={u('timeoutSec')} min="0" />
        </Field>
        <Field label="If exit code ≠ 0">
          <CustomSelect style={inputStyle} value={p('onError', 'stop')} onChange={u('onError')}>
            <option value="stop">Stop the pipeline</option>
            <option value="skip">Continue anyway</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Output */}
      <SectionTitle label="Output" color={SSH_COLOR} />
      <Row2>
        <Field label="Output mode">
          <CustomSelect style={inputStyle} value={outputMode} onChange={u('outputMode')}>
            <option value="lines">Lines — each stdout line</option>
            <option value="json">JSON — parse as an array</option>
            <option value="jsonl">JSONL — each line is JSON</option>
            <option value="summary">Summary — summary only</option>
          </CustomSelect>
        </Field>
        <Field label="Run for each row">
          <CustomSelect style={inputStyle} value={p('runPerRow', 'false')} onChange={u('runPerRow')}>
            <option value="false">No — only once</option>
            <option value="true">Yes — for each row</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Schema output */}
      <SectionTitle label="Emitted row fields" color={SSH_COLOR} />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        <SchemaRow color={SSH_COLOR} name="ssh_host"        type="string"  desc="Remote host" />
        <SchemaRow color={SSH_COLOR} name="ssh_user"        type="string"  desc="SSH user" />
        <SchemaRow color={SSH_COLOR} name="ssh_command"     type="string"  desc="Executed command" />
        <SchemaRow color={SSH_COLOR} name="ssh_exit_code"   type="integer" desc="Exit code" />
        <SchemaRow color={SSH_COLOR} name="ssh_duration_ms" type="integer" desc="Duration in ms" />
        {outputMode === 'lines' && <>
          <SchemaRow color={SSH_COLOR} name="line"        type="string"  desc="Output line" />
          <SchemaRow color={SSH_COLOR} name="line_number" type="integer" desc="Row number" />
          <SchemaRow color={SSH_COLOR} name="stream"      type="string"  desc="'stdout' or 'stderr'" />
        </>}
        {outputMode === 'summary' && <>
          <SchemaRow color={SSH_COLOR} name="stdout"       type="string"  desc="Full output" />
          <SchemaRow color={SSH_COLOR} name="stderr"       type="string"  desc="Full errors" />
          <SchemaRow color={SSH_COLOR} name="stdout_lines" type="integer" desc="Number of stdout lines" />
          <SchemaRow color={SSH_COLOR} name="ok"           type="boolean" desc="true if exit_code === 0" />
        </>}
        {(outputMode === 'json' || outputMode === 'jsonl') && <>
          <SchemaRow color={SSH_COLOR} name="...(JSON fields)" type="any" desc="Fields from the JSON output" />
        </>}
      </div>

    </div>
  )
}