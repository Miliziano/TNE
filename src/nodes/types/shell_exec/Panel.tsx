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
      {hint && <div style={{ fontSize: 9, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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
      <span style={{ color: '#4a5a7a', fontSize: 9 }}>{desc}</span>
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
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>Esegue comandi bash/shell locali — output nel flusso</div>
        </div>
      </div>

      <InfoBox color={SHELL_COLOR}>
        Usa <code style={{ color: SHELL_COLOR }}>$campo</code> o <code style={{ color: SHELL_COLOR }}>${'{'}campo{'}'}</code> per
        inserire valori dalla riga in ingresso o dalle variabili di lane nel comando.
        Esempio: <code style={{ color: '#3ddc84', fontSize: 9 }}>kubectl get pods -n $namespace -o json</code>
      </InfoBox>

      {/* Comando */}
      <SectionTitle label="Comando" color={SHELL_COLOR} />
      <Field label="Comando shell" hint="Supporta pipe, redirect, && — viene eseguito tramite /bin/sh">
        <textarea style={textareaStyle} value={p('command', '')} onChange={u('command')}
          placeholder="kubectl get nodes -o wide&#10;docker ps --format json&#10;ls -la /var/log" />
      </Field>
      <Row2>
        <Field label="Directory di lavoro (cwd)" hint="Lascia vuoto per home">
          <input style={inputStyle} value={p('cwd', '')} onChange={u('cwd')} placeholder="/home/user/progetti" />
        </Field>
        <Field label="Timeout (sec)" hint="0 = nessun limite">
          <input type="number" style={inputStyle} value={p('timeoutSec', '30')} onChange={u('timeoutSec')} min="0" />
        </Field>
      </Row2>

      {/* Variabili d'ambiente */}
      <SectionTitle label="Variabili d'ambiente aggiuntive" color={SHELL_COLOR} />
      <Field label="Env (JSON)" hint='{"KUBECONFIG": "/home/user/.kube/config", "ENV": "prod"}'>
        <textarea style={{ ...textareaStyle, minHeight: 60 }} value={p('env', '{}')} onChange={u('env')}
          placeholder='{"MY_VAR": "valore"}' />
      </Field>

      {/* Output */}
      <SectionTitle label="Output" color={SHELL_COLOR} />
      <Row2>
        <Field label="Modalità output">
          <CustomSelect style={inputStyle} value={outputMode} onChange={u('outputMode')}>
            <option value="lines">Lines — ogni riga stdout è una Row</option>
            <option value="json">JSON — parse output come array JSON</option>
            <option value="jsonl">JSONL — ogni riga è un oggetto JSON</option>
            <option value="summary">Summary — solo riga di riepilogo finale</option>
          </CustomSelect>
        </Field>
        <Field label="Cattura stderr">
          <CustomSelect style={inputStyle} value={p('captureStderr', 'true')} onChange={u('captureStderr')}>
            <option value="true">Sì — emette righe stderr nel flusso</option>
            <option value="false">No — ignora stderr</option>
          </CustomSelect>
        </Field>
      </Row2>
      <Row2>
        <Field label="Esegui per ogni riga">
          <CustomSelect style={inputStyle} value={p('runPerRow', 'false')} onChange={u('runPerRow')}>
            <option value="false">No — esegui una volta sola</option>
            <option value="true">Sì — esegui per ogni riga in ingresso</option>
          </CustomSelect>
        </Field>
        <Field label="Se exit code ≠ 0">
          <CustomSelect style={inputStyle} value={p('onError', 'stop')} onChange={u('onError')}>
            <option value="stop">Interrompi pipeline</option>
            <option value="skip">Continua — emetti comunque le righe</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Schema output */}
      <SectionTitle label="Campi della riga emessa" color={SHELL_COLOR} />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        {outputMode === 'lines' && <>
          <SchemaRow color={SHELL_COLOR} name="line"        type="string"  desc="Riga di testo" />
          <SchemaRow color={SHELL_COLOR} name="line_number" type="integer" desc="Numero riga (1-based)" />
          <SchemaRow color={SHELL_COLOR} name="stream"      type="string"  desc="'stdout' o 'stderr'" />
          <SchemaRow color={SHELL_COLOR} name="exit_code"   type="integer" desc="Exit code del comando" />
          <SchemaRow color={SHELL_COLOR} name="duration_ms" type="integer" desc="Durata esecuzione" />
        </>}
        {outputMode === 'json' && <>
          <SchemaRow color={SHELL_COLOR} name="...(campi JSON)" type="any" desc="Tutti i campi dell'oggetto JSON" />
          <SchemaRow color={SHELL_COLOR} name="_exit_code"      type="integer" desc="Exit code del comando" />
        </>}
        {outputMode === 'jsonl' && <>
          <SchemaRow color={SHELL_COLOR} name="...(campi JSON)" type="any" desc="Campi di ogni riga JSONL" />
          <SchemaRow color={SHELL_COLOR} name="_exit_code"      type="integer" desc="Exit code del comando" />
        </>}
        {outputMode === 'summary' && <>
          <SchemaRow color={SHELL_COLOR} name="command"      type="string"  desc="Comando eseguito" />
          <SchemaRow color={SHELL_COLOR} name="exit_code"    type="integer" desc="Exit code" />
          <SchemaRow color={SHELL_COLOR} name="stdout"       type="string"  desc="Output completo" />
          <SchemaRow color={SHELL_COLOR} name="stderr"       type="string"  desc="Errori completi" />
          <SchemaRow color={SHELL_COLOR} name="stdout_lines" type="integer" desc="Numero righe stdout" />
          <SchemaRow color={SHELL_COLOR} name="duration_ms"  type="integer" desc="Durata in ms" />
          <SchemaRow color={SHELL_COLOR} name="ok"           type="boolean" desc="true se exit_code === 0" />
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
          <div style={{ fontSize: 9, color: '#4a5a7a' }}>Esegue comandi su host remoto via SSH</div>
        </div>
      </div>

      <InfoBox color={SSH_COLOR}>
        Usa una <strong>risorsa SSH</strong> dalla lane per le credenziali, oppure configurale
        direttamente qui sotto. Usa <code style={{ color: SSH_COLOR }}>$campo</code> nel comando
        per inserire valori dalla riga in ingresso.
      </InfoBox>

      {/* Connessione — risorsa o manuale */}
      <SectionTitle label="Connessione" color={SSH_COLOR} />

      {sshRes.length > 0 && (
        <Field label="Risorsa SSH dalla lane" hint="Preferibile alle credenziali manuali">
          <CustomSelect style={inputStyle} value={p('resourceId', '')}
            onChange={e => updateProp(nodeId, 'resourceId', e.target.value)}>
            <option value="">— nessuna risorsa (usa credenziali manuali) —</option>
            {sshRes.map(r => <option key={r.id} value={r.id}>{r.label}</option>)}
          </CustomSelect>
        </Field>
      )}

      <Row2>
        <Field label="Host">
          <input style={inputStyle} value={p('host', '')} onChange={u('host')} placeholder="192.168.1.10" />
        </Field>
        <Field label="Porta">
          <input type="number" style={inputStyle} value={p('port', '22')} onChange={u('port')} min="1" max="65535" />
        </Field>
      </Row2>
      <Field label="Utente">
        <input style={inputStyle} value={p('user', '')} onChange={u('user')} placeholder="ubuntu" />
      </Field>

      {/* Autenticazione */}
      <SectionTitle label="Autenticazione" color={SSH_COLOR} />
      <Field label="Tipo">
        <CustomSelect style={inputStyle} value={authType} onChange={u('authType')}>
          <option value="password">Password</option>
          <option value="key">Chiave privata (senza passphrase)</option>
          <option value="key_passphrase">Chiave privata con passphrase</option>
        </CustomSelect>
      </Field>
      {authType === 'password' && (
        <Field label="Password">
          <input type="password" style={inputStyle} value={p('password', '')} onChange={u('password')} />
        </Field>
      )}
      {(authType === 'key' || authType === 'key_passphrase') && (
        <>
          <Field label="Path chiave privata">
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
        <Field label="Timeout connessione (sec)">
          <input type="number" style={inputStyle} value={p('connectTimeout', '10')} onChange={u('connectTimeout')} min="1" />
        </Field>
        <Field label="Verifica known_hosts">
          <CustomSelect style={inputStyle} value={p('knownHostsCheck', 'false')} onChange={u('knownHostsCheck')}>
            <option value="false">No — accetta qualsiasi host</option>
            <option value="true">Sì — verifica known_hosts</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Comando */}
      <SectionTitle label="Comando remoto" color={SSH_COLOR} />
      <Field label="Comando" hint="Eseguito nella shell dell'utente remoto">
        <textarea style={textareaStyle} value={p('command', '')} onChange={u('command')}
          placeholder="systemctl status nginx&#10;docker ps --format json&#10;journalctl -n 100 --no-pager" />
      </Field>
      <Row2>
        <Field label="Timeout esecuzione (sec)" hint="0 = nessun limite">
          <input type="number" style={inputStyle} value={p('timeoutSec', '30')} onChange={u('timeoutSec')} min="0" />
        </Field>
        <Field label="Se exit code ≠ 0">
          <CustomSelect style={inputStyle} value={p('onError', 'stop')} onChange={u('onError')}>
            <option value="stop">Interrompi pipeline</option>
            <option value="skip">Continua comunque</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Output */}
      <SectionTitle label="Output" color={SSH_COLOR} />
      <Row2>
        <Field label="Modalità output">
          <CustomSelect style={inputStyle} value={outputMode} onChange={u('outputMode')}>
            <option value="lines">Lines — ogni riga stdout</option>
            <option value="json">JSON — parse come array</option>
            <option value="jsonl">JSONL — ogni riga è JSON</option>
            <option value="summary">Summary — solo riepilogo</option>
          </CustomSelect>
        </Field>
        <Field label="Esegui per ogni riga">
          <CustomSelect style={inputStyle} value={p('runPerRow', 'false')} onChange={u('runPerRow')}>
            <option value="false">No — una volta sola</option>
            <option value="true">Sì — per ogni riga</option>
          </CustomSelect>
        </Field>
      </Row2>

      {/* Schema output */}
      <SectionTitle label="Campi della riga emessa" color={SSH_COLOR} />
      <div style={{ padding: '8px 10px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
        <SchemaRow color={SSH_COLOR} name="ssh_host"        type="string"  desc="Host remoto" />
        <SchemaRow color={SSH_COLOR} name="ssh_user"        type="string"  desc="Utente SSH" />
        <SchemaRow color={SSH_COLOR} name="ssh_command"     type="string"  desc="Comando eseguito" />
        <SchemaRow color={SSH_COLOR} name="ssh_exit_code"   type="integer" desc="Exit code" />
        <SchemaRow color={SSH_COLOR} name="ssh_duration_ms" type="integer" desc="Durata in ms" />
        {outputMode === 'lines' && <>
          <SchemaRow color={SSH_COLOR} name="line"        type="string"  desc="Riga di output" />
          <SchemaRow color={SSH_COLOR} name="line_number" type="integer" desc="Numero riga" />
          <SchemaRow color={SSH_COLOR} name="stream"      type="string"  desc="'stdout' o 'stderr'" />
        </>}
        {outputMode === 'summary' && <>
          <SchemaRow color={SSH_COLOR} name="stdout"       type="string"  desc="Output completo" />
          <SchemaRow color={SSH_COLOR} name="stderr"       type="string"  desc="Errori completi" />
          <SchemaRow color={SSH_COLOR} name="stdout_lines" type="integer" desc="Numero righe stdout" />
          <SchemaRow color={SSH_COLOR} name="ok"           type="boolean" desc="true se exit_code === 0" />
        </>}
        {(outputMode === 'json' || outputMode === 'jsonl') && <>
          <SchemaRow color={SSH_COLOR} name="...(campi JSON)" type="any" desc="Campi dall'output JSON" />
        </>}
      </div>

    </div>
  )
}