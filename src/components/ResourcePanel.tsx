import { useFlowStore } from '../store/flowStore'
import type { LaneResource, ResourceStatus, ResourceAction } from '../types'
import { HTTP_DEFAULTS } from '../nodes/resourceDefaults.ts'
import { CustomSelect } from '../components/CustomSelect'




// ─── stili comuni ─────────────────────────────────────────────────
const inputStyle: React.CSSProperties = {
  width: '100%',
  background: '#1e2535',
  border: '1px solid #3a4a6a',
  borderRadius: 4,
  color: '#c8d4f0',
  fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11,
  padding: '5px 8px',
  outline: 'none',
}

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: '#9a9aaa',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  marginBottom: 4,
  fontWeight: 600,
}

const sectionTitleStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  color: '#4a9eff',
  textTransform: 'uppercase',
  letterSpacing: '.08em',
  padding: '6px 0 4px',
  borderBottom: '0.5px solid #2a3349',
  marginBottom: 4,
}

// ─── Field ────────────────────────────────────────────────────────
function Field({
  label, fieldKey, value, type = 'text', options, laneId, resourceId,
}: {
  label: string
  fieldKey: string
  value: string
  type?: 'text' | 'number' | 'password' | 'select' | 'textarea'
  options?: string[]
  laneId: string
  resourceId: string
}) {
  const updateResourceConfig = useFlowStore((s) => s.updateResourceConfig)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 4,
      padding: '7px 10px', background: '#1a2030',
      borderRadius: 6, border: '0.5px solid #2a3349', marginBottom: 6,
    }}>
      <div style={labelStyle}>{label}</div>
      {type === 'select' ? (
        <CustomSelect
          value={value}
          onChange={(e) => updateResourceConfig(laneId, resourceId, fieldKey, e.target.value)}
          style={inputStyle}
        >
          {options?.map((o) => <option key={o} value={o}>{o}</option>)}
        </CustomSelect>
      ) : type === 'textarea' ? (
        <textarea
          value={value}
          onChange={(e) => updateResourceConfig(laneId, resourceId, fieldKey, e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace' }}
        />
      ) : (
        <input
          type={type}
          value={value}
          onChange={(e) => updateResourceConfig(laneId, resourceId, fieldKey, e.target.value)}
          style={inputStyle}
        />
      )}
    </div>
  )
}

// ─── SectionTitle ─────────────────────────────────────────────────
function SectionTitle({ label }: { label: string }) {
  return <div style={sectionTitleStyle}>{label}</div>
}

// ─── Section ──────────────────────────────────────────────────────
function Section({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ padding: '10px 12px', borderBottom: '0.5px solid #2a3349', background: '#161b27' }}>
      <SectionTitle label={label} />
      {children}
    </div>
  )
}

// ─── StatusBadge ──────────────────────────────────────────────────
function StatusBadge({ status }: { status: ResourceStatus }) {
  const map: Record<ResourceStatus, { color: string; bg: string; border: string; icon: string; label: string }> = {
    untested: { color: '#4a5a7a', bg: '#1e2535', border: '#2a3349', icon: 'ti-circle-dashed', label: 'non testato' },
    testing:  { color: '#ffb347', bg: '#3d2a0a', border: '#854f0b', icon: 'ti-loader',        label: 'test in corso…' },
    ok:       { color: '#3ddc84', bg: '#0d3d20', border: '#1d6d40', icon: 'ti-circle-check',  label: 'connesso' },
    error:    { color: '#ff5f57', bg: '#3d1010', border: '#6d2020', icon: 'ti-circle-x',      label: 'errore' },
  }
  const s = map[status]
  return (
    <span style={{
      fontSize: 10, padding: '2px 8px', borderRadius: 8,
      background: s.bg, color: s.color, border: `0.5px solid ${s.border}`,
      display: 'inline-flex', alignItems: 'center', gap: 4,
    }}>
      <i className={`ti ${s.icon}${status === 'testing' ? ' spin' : ''}`} style={{ fontSize: 11 }} aria-hidden="true" />
      {s.label}
    </span>
  )
}

// ─── Config DB ────────────────────────────────────────────────────
function DbConfig({ res, laneId }: { res: LaneResource; laneId: string }) {
  const c = res.config
  const f = (k: string) => c[k] ?? ''
  const p = { laneId, resourceId: res.id }

  return (
    <>
      <Section label="Connessione">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Dialetto" fieldKey="dialect" value={f('dialect') || f('driver') || 'postgresql'}
            type="select" options={['postgresql','mysql','sqlite','oracle','informix']} {...p} />
          <Field label="Porta" fieldKey="port" value={f('port') || '5432'} type="number" {...p} />
        </div>
        <Field label="Host" fieldKey="host" value={f('host') || 'localhost'} {...p} />
        <Field label="Database" fieldKey="database" value={f('database') || ''} {...p} />
        <Field label="Schema" fieldKey="schema" value={f('schema') || 'public'} {...p} />
      </Section>

      <Section label="Autenticazione">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Utente" fieldKey="user" value={f('user') || f('username') || ''} {...p} />
          <Field label="Password" fieldKey="password" value={f('password')} type="password" {...p} />
        </div>
        <Field label="SSL" fieldKey="ssl" value={f('ssl') || 'false'}
          type="select" options={['false','true','require','verify-ca','verify-full']} {...p} />
      </Section>

      <Section label="Opzioni">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Timeout conn. (s)" fieldKey="connectTimeout" value={f('connectTimeout') || '10'} type="number" {...p} />
          <Field label="Timeout query (s)" fieldKey="timeoutSec"     value={f('timeoutSec')     || '30'} type="number" {...p} />
        </div>
      </Section>
    </>
  )
}

// ─── Config HTTP ──────────────────────────────────────────────────
function HttpConfig({ res, laneId }: { res: LaneResource; laneId: string }) {
  const c = res.config
  const f = (k: string) => c[k] ?? ''
  const p = { laneId, resourceId: res.id }

  return (
    <>
      <Section label="Endpoint">
        <Field label="Base URL" fieldKey="baseUrl" value={f('baseUrl') || HTTP_DEFAULTS.url} {...p} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Metodo default" fieldKey="method" value={f('method') || 'GET'}
            type="select" options={['GET','POST','PUT','PATCH','DELETE']} {...p} />
          <Field label="Timeout s" fieldKey="timeoutSec" value={f('timeoutSec') || '30'} type="number" {...p} />
        </div>
      </Section>

      <Section label="Autenticazione">
        <Field label="Tipo" fieldKey="authType" value={f('authType') || 'none'}
          type="select" options={['none','basic','bearer','oauth2']} {...p} />
        {f('authType') === 'basic' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Username" fieldKey="username" value={f('username')} {...p} />
            <Field label="Password" fieldKey="password" value={f('password')} type="password" {...p} />
          </div>
        )}
        {f('authType') === 'bearer' && (
          <Field label="Bearer token" fieldKey="bearerToken" value={f('bearerToken')} type="password" {...p} />
        )}
      </Section>

      <Section label="Headers aggiuntivi">
        <div style={labelStyle}>JSON (es: {'{"X-Api-Key": "..."}'})</div>
        <textarea
          value={f('headers') || '{}'}
          onChange={(e) => useFlowStore.getState().updateResourceConfig(laneId, res.id, 'headers', e.target.value)}
          rows={3}
          style={{ ...inputStyle, resize: 'vertical', fontFamily: 'monospace', fontSize: 11 }}
        />
      </Section>
    </>
  )
}

// ─── Config Kafka ─────────────────────────────────────────────────
function KafkaConfig({ res, laneId }: { res: LaneResource; laneId: string }) {
  const c = res.config
  const f = (k: string) => c[k] ?? ''
  const p = { laneId, resourceId: res.id }

  return (
    <>
      <Section label="Broker">
        <Field label="Brokers (comma-separated)" fieldKey="brokers" value={f('brokers') || 'localhost:9092'} {...p} />
        <Field label="Client ID" fieldKey="clientId" value={f('clientId') || 'flowpilot-client'} {...p} />
        <Field label="Group ID" fieldKey="groupId"   value={f('groupId')   || 'flowpilot-group'}  {...p} />
      </Section>
      <Section label="Autenticazione">
        <Field label="Tipo" fieldKey="authType" value={f('authType') || 'none'}
          type="select" options={['none','sasl_plain','sasl_ssl']} {...p} />
        {f('authType') !== 'none' && f('authType') !== '' && (
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
            <Field label="Username" fieldKey="username" value={f('username')} {...p} />
            <Field label="Password" fieldKey="password" value={f('password')} type="password" {...p} />
          </div>
        )}
      </Section>
    </>
  )
}

// ─── Config MQTT ──────────────────────────────────────────────────
function MqttConfig({ res, laneId }: { res: LaneResource; laneId: string }) {
  const c = res.config
  const f = (k: string) => c[k] ?? ''
  const p = { laneId, resourceId: res.id }

  return (
    <>
      <Section label="Broker">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Host" fieldKey="broker" value={f('broker') || 'localhost'} {...p} />
          <Field label="Porta" fieldKey="port"  value={f('port')   || '1883'} type="number" {...p} />
        </div>
        <Field label="Client ID" fieldKey="clientId" value={f('clientId') || 'flowpilot'} {...p} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="QoS" fieldKey="qos" value={f('qos') || '0'}
            type="select" options={['0','1','2']} {...p} />
          <Field label="TLS" fieldKey="useTls" value={f('useTls') || 'false'}
            type="select" options={['false','true']} {...p} />
        </div>
      </Section>
      <Section label="Autenticazione">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Username" fieldKey="username" value={f('username')} {...p} />
          <Field label="Password" fieldKey="password" value={f('password')} type="password" {...p} />
        </div>
      </Section>
    </>
  )
}

// ─── Config FTP ───────────────────────────────────────────────────
function FtpConfig({ res, laneId }: { res: LaneResource; laneId: string }) {
  const c = res.config
  const f = (k: string) => c[k] ?? ''
  const p = { laneId, resourceId: res.id }

  return (
    <>
      <Section label="Connessione">
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Protocollo" fieldKey="protocol" value={f('protocol') || 'sftp'}
            type="select" options={['ftp','sftp']} {...p} />
          <Field label="Porta" fieldKey="port" value={f('port') || '22'} type="number" {...p} />
        </div>
        <Field label="Host" fieldKey="host" value={f('host') || ''} {...p} />
      </Section>
      <Section label="Autenticazione">
        <Field label="Tipo" fieldKey="authType" value={f('authType') || 'password'}
          type="select" options={['password','key']} {...p} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Utente"   fieldKey="user"     value={f('user')}     {...p} />
          <Field label="Password" fieldKey="password" value={f('password')} type="password" {...p} />
        </div>
        {f('authType') === 'key' && (
          <Field label="Path chiave privata" fieldKey="keyPath" value={f('keyPath')} {...p} />
        )}
      </Section>
    </>
  )
}

// ─── Config Webhook ───────────────────────────────────────────────
// La risorsa Webhook rappresenta il SERVER HTTP condiviso.
// Più nodi Receiver si registrano su path distinti dello stesso server.
// Responder e Watchdog non usano questa risorsa — sono config inline.
function WebhookConfig({ res, laneId }: { res: LaneResource; laneId: string }) {
  const c = res.config
  const f = (k: string, def = '') => String(c[k] ?? def)
  const p = { laneId, resourceId: res.id }

  // Serializza come stringa per evitare nuovo array ad ogni render (loop infinito Zustand)
  const receiverStr = useFlowStore((s) =>
    s.nodes
      .filter((n) =>
        n.data.laneId === laneId &&
        n.data.type === 'webhook_receiver' &&
        n.data.config?.resourceId === res.id
      )
      .map((n) => [
        n.id,
        String(n.data.props?.['path'] ?? '/webhook'),
        String(n.data.config?.displayName || n.data.label || n.id),
      ].join('|'))
      .join(';')
  )

  const receivers = receiverStr
    ? receiverStr.split(';').map((s) => {
        const [id, path, label] = s.split('|')
        return { id, path, label }
      })
    : []

  return (
    <>
      <Section label="Server HTTP">
        <div style={{ padding: '6px 10px', marginBottom: 8, background: 'color-mix(in srgb, #3ddc84 6%, #0f1117)', borderRadius: 4, border: '0.5px solid #3ddc8430', fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
          Un singolo server sulla porta configurata. Ogni nodo Receiver
          si registra su un path distinto — tutti condividono questa porta.
        </div>
        <Field label="Porta" fieldKey="port" value={f('port', '9110')} type="number" {...p} />
        <Field label="IP Whitelist" fieldKey="ipWhitelist" value={f('ipWhitelist', '')} type="textarea" {...p} />
        <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic', marginTop: -2, marginBottom: 6, paddingLeft: 2 }}>
          Un IP per riga. Vuoto = tutti accettati.
        </div>
      </Section>

      <Section label="Firma HMAC — default per i Receiver">
        <div style={{ padding: '6px 10px', marginBottom: 8, background: 'color-mix(in srgb, #3ddc84 6%, #0f1117)', borderRadius: 4, border: '0.5px solid #3ddc8430', fontSize: 10, color: '#9a9aaa', lineHeight: 1.5 }}>
          Valori di default per i nodi Receiver. Ogni Receiver può sovrascrivere
          secret e header individualmente (es. GitHub vs Stripe con secret diversi).
        </div>
        <Field label="HMAC Secret default" fieldKey="hmacSecret" value={f('hmacSecret')} type="password" {...p} />
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
          <Field label="Header firma" fieldKey="sigHeader" value={f('sigHeader', 'X-Hub-Signature-256')} {...p} />
          <Field label="Algoritmo"    fieldKey="sigAlgo"   value={f('sigAlgo', 'sha256')}
            type="select" options={['sha256','sha1']} {...p} />
        </div>
      </Section>

      {/* Path registrati — sezione informativa live */}
      {receivers.length > 0 && (
        <Section label="Receiver collegati">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {receivers.map((r) => (
              <div key={r.id} style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '5px 8px', borderRadius: 4,
                background: '#1e2535', border: '0.5px solid #2a3349',
              }}>
                <i className="ti ti-webhook" style={{ fontSize: 10, color: '#3ddc84', flexShrink: 0 }} aria-hidden="true" />
                <code style={{ fontSize: 10, color: '#3ddc84', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  :{f('port', '9110')}{r.path}
                </code>
                <span style={{ fontSize: 9, color: '#4a5a7a', flexShrink: 0 }}>
                  {r.label}
                </span>
              </div>
            ))}
          </div>
        </Section>
      )}
    </>
  )
}

// ─── ActionButtons ────────────────────────────────────────────────
function ActionButtons({ resource, laneId }: { resource: LaneResource; laneId: string }) {
  if (resource.actions.length === 0) return null

  const handleAction = (action: ResourceAction) => {
    const store   = useFlowStore.getState()
    store.addNode(action.nodeType, laneId, 80 + Math.random() * 200, 60)
    const nodes   = useFlowStore.getState().nodes
    const newNode = nodes[nodes.length - 1]
    if (newNode) {
      if (Object.keys(action.propsOverride).length > 0) {
        Object.entries(action.propsOverride).forEach(([k, v]) =>
          useFlowStore.getState().updateNodeProp(newNode.id, k, v)
        )
      }
      useFlowStore.getState().updateNodeConfig(newNode.id, { resourceId: resource.id })
    }
  }

  return (
    <Section label="Aggiungi al canvas">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {resource.actions.map((action) => (
          <button key={action.id} onClick={() => handleAction(action)}
            style={{ width: '100%', padding: '7px 10px', fontSize: 11, display: 'flex', alignItems: 'center', gap: 8, borderRadius: 4, cursor: 'pointer', textAlign: 'left', background: '#1a2030', border: '0.5px solid #2a3349', color: '#9a9aaa' }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#1e2535'; (e.currentTarget as HTMLElement).style.color = '#c8d4f0' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a2030'; (e.currentTarget as HTMLElement).style.color = '#9a9aaa' }}>
            <i className="ti ti-plus" style={{ fontSize: 12, color: '#4a9eff' }} aria-hidden="true" />
            {action.label}
          </button>
        ))}
      </div>
    </Section>
  )
}

// ─── UsedBy ───────────────────────────────────────────────────────
function UsedBy({ resource, laneId }: { resource: LaneResource; laneId: string }) {
  // Serializza come stringa per evitare nuovo array ad ogni render (loop infinito Zustand)
  const usedByStr = useFlowStore((s) =>
    s.nodes
      .filter((n) => n.data.laneId === laneId && n.data.config?.resourceId === resource.id)
      .map((n) => `${n.id}|${n.data.label || n.data.type}`)
      .join(';')
  )
  if (!usedByStr) return null
  const nodes = usedByStr.split(';').map((s) => {
    const [id, label] = s.split('|')
    return { id, label }
  })
  return (
    <Section label="Usata da">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {nodes.map((n) => (
          <div key={n.id} style={{ fontSize: 11, padding: '5px 8px', borderRadius: 4, background: '#1e2535', color: '#9a9aaa', border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 6 }}>
            <i className="ti ti-point-filled" style={{ fontSize: 10, color: '#4a9eff' }} aria-hidden="true" />
            {n.label}
          </div>
        ))}
      </div>
    </Section>
  )
}

// ─── ResourcePanel ────────────────────────────────────────────────
export function ResourcePanel({ resource, laneId }: { resource: LaneResource; laneId: string }) {
  const testResource   = useFlowStore((s) => s.testResource)
  const deleteResource = useFlowStore((s) => s.deleteResource)
  const updateResource = useFlowStore((s) => s.updateResource)
  const selectResource = useFlowStore((s) => s.selectResource)

  const liveResource = useFlowStore((s) =>
    s.pool.lanes.find((l) => l.id === laneId)?.resources.find((r) => r.id === resource.id)
  ) ?? resource

  const ICONS: Record<string, string> = {
    db:      'ti-database',
    http:    'ti-api',
    kafka:   'ti-topology-star',
    mqtt:    'ti-antenna',
    ftp:     'ti-server',
    webhook: 'ti-webhook',
  }

  const isWebhook = liveResource.kind === 'webhook'
  const canTest   = !isWebhook

  return (
    <div style={{ display: 'flex', flexDirection: 'column', flex: 1, overflowY: 'auto' }}>

      {/* Header */}
      <div style={{ padding: '10px 12px', borderBottom: '1px solid #2a3349', background: '#1a2030', flexShrink: 0 }}>

        {/* Breadcrumb */}
        <div style={{ fontSize: 10, color: '#4a5a7a', marginBottom: 8, display: 'flex', alignItems: 'center', gap: 4 }}>
          <button onClick={() => selectResource(null)}
            style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: '#4a9eff', fontSize: 10, display: 'flex', alignItems: 'center', gap: 3 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.color = '#6ab4ff' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.color = '#4a9eff' }}>
            <i className="ti ti-chevron-left" style={{ fontSize: 10 }} aria-hidden="true" />
            Risorse
          </button>
          <span>/ {liveResource.label}</span>
        </div>

        {/* Titolo e stato */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
          <i className={`ti ${ICONS[liveResource.kind] ?? 'ti-plug'}`}
            style={{ fontSize: 16, color: '#4a9eff' }} aria-hidden="true" />
          <input
            value={liveResource.label}
            onChange={(e) => updateResource(laneId, liveResource.id, { label: e.target.value })}
            style={{ background: 'none', border: 'none', outline: 'none', fontWeight: 600, fontSize: 13, color: '#c8d4f0', flex: 1, padding: 0 }}
          />
          {/* Webhook non ha stato connessione — badge statico */}
          {isWebhook ? (
            <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 8, background: '#0d3d20', color: '#3ddc84', border: '0.5px solid #1d6d40', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              <i className="ti ti-webhook" style={{ fontSize: 11 }} aria-hidden="true" />
              server HTTP
            </span>
          ) : (
            <StatusBadge status={liveResource.status} />
          )}
        </div>

        {/* Pulsanti */}
        <div style={{ display: 'flex', gap: 6 }}>
          {canTest && (
            <button
              onClick={() => testResource(laneId, liveResource.id)}
              disabled={liveResource.status === 'testing'}
              style={{ flex: 1, padding: '5px 8px', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 5, borderRadius: 4, cursor: liveResource.status === 'testing' ? 'not-allowed' : 'pointer', opacity: liveResource.status === 'testing' ? 0.6 : 1, background: '#1a3a6a', color: '#4a9eff', border: '1px solid #2a5a9a' }}
              onMouseEnter={(e) => { if (liveResource.status !== 'testing') (e.currentTarget as HTMLElement).style.background = '#2a4a7a' }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = '#1a3a6a' }}>
              <i className="ti ti-plug" style={{ fontSize: 12 }} aria-hidden="true" />
              {liveResource.status === 'testing' ? 'Test in corso…' : 'Testa connessione'}
            </button>
          )}
          <button
            onClick={() => { if (confirm(`Eliminare la risorsa "${liveResource.label}"?`)) { deleteResource(laneId, liveResource.id); selectResource(null) } }}
            style={{ padding: '5px 8px', fontSize: 11, borderRadius: 4, cursor: 'pointer', background: 'transparent', color: '#ff5f57', border: '1px solid #3d1010', display: 'flex', alignItems: 'center', gap: 4 }}
            onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = '#2a1010' }}
            onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
            <i className="ti ti-trash" style={{ fontSize: 12 }} aria-hidden="true" />
          </button>
        </div>
      </div>

      {/* Configurazione — usa liveResource, non resource */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {liveResource.kind === 'db'      && <DbConfig      res={liveResource} laneId={laneId} />}
        {liveResource.kind === 'http'    && <HttpConfig    res={liveResource} laneId={laneId} />}
        {liveResource.kind === 'kafka'   && <KafkaConfig   res={liveResource} laneId={laneId} />}
        {liveResource.kind === 'mqtt'    && <MqttConfig    res={liveResource} laneId={laneId} />}
        {liveResource.kind === 'ftp'     && <FtpConfig     res={liveResource} laneId={laneId} />}
        {liveResource.kind === 'webhook' && <WebhookConfig res={liveResource} laneId={laneId} />}

        <ActionButtons resource={liveResource} laneId={laneId} />
        {/* UsedBy è ridondante per Webhook — WebhookConfig mostra già i Receiver collegati */}
        {liveResource.kind !== 'webhook' && (
          <UsedBy resource={liveResource} laneId={laneId} />
        )}
      </div>

    </div>
  )
}