import { useState, useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import { HTTP_DEFAULTS } from '../../../nodes/resourceDefaults'
import { CustomSelect } from '../../../components/CustomSelect'

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

function Field({ label, children, hint }: {
  label: string; children: React.ReactNode; hint?: string
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}

function SectionTitle({ label, color = '#4a9eff' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: '0.5px solid #2a3349', marginBottom: 4 }}>
      {label}
    </div>
  )
}

function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}

function InfoBox({ children, color = '#4a5a7a' }: { children: React.ReactNode; color?: string }) {
  return (
    <div style={{ padding: '6px 10px', fontSize: 10, color, fontStyle: 'italic', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${color}40`, display: 'flex', alignItems: 'flex-start', gap: 5 }}>
      <i className="ti ti-info-circle" style={{ fontSize: 11, flexShrink: 0, marginTop: 1 }} />
      <span>{children}</span>
    </div>
  )
}

// ─── Pill campo ───────────────────────────────────────────────────
function FieldPill({ name, type, onClick }: { name: string; type: string; onClick: () => void }) {
  return (
    <button onClick={onClick}
      title={`Clicca per inserire \${${name}}`}
      style={{ padding: '2px 8px', borderRadius: 10, fontSize: 9, background: '#0f1117', border: '1px solid #2a3349', color: '#3ddc84', cursor: 'pointer', fontFamily: 'monospace', flexShrink: 0, display: 'flex', alignItems: 'center', gap: 4 }}
      onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#3ddc84'; (e.currentTarget as HTMLElement).style.background = '#0d1a0d' }}
      onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.borderColor = '#2a3349'; (e.currentTarget as HTMLElement).style.background = '#0f1117' }}>
      <span>{name}</span>
      <span style={{ color: '#4a5a7a', fontSize: 9 }}>{type}</span>
    </button>
  )
}

function buildAuthHeaders(props: Record<string, string>): Record<string, string> {
  const authType = props['authType'] ?? 'none'
  switch (authType) {
    case 'basic': {
      const creds = btoa(`${props['username'] ?? ''}:${props['password'] ?? ''}`)
      return { 'Authorization': `Basic ${creds}` }
    }
    case 'bearer':
      return { 'Authorization': `Bearer ${props['bearerToken'] ?? ''}` }
    case 'api_key': {
      const pos  = props['apiKeyIn'] ?? 'header'
      const name = props['apiKeyName'] ?? 'X-Api-Key'
      if (pos === 'header') return { [name]: props['apiKeyValue'] ?? '' }
      return {}
    }
    case 'oauth2_ac':
      return { 'Authorization': `Bearer ${props['oauth2AccessToken'] ?? ''}` }
    default:
      return {}
  }
}

function extractFields(obj: unknown): Array<{ name: string; type: string }> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return []
  return Object.entries(obj as Record<string, unknown>).map(([key, val]) => {
    if (val === null)                  return { name: key, type: 'string' }
    if (typeof val === 'boolean')      return { name: key, type: 'boolean' }
    if (typeof val === 'number')       return { name: key, type: Number.isInteger(val) ? 'integer' : 'decimal' }
    if (typeof val === 'string')       return { name: key, type: 'string' }
    return { name: key, type: 'object' }
  })
}

function resolveJsonPath(data: unknown, path: string): unknown {
  if (!path || path === '$') return data
  const parts = path.replace(/^\$\.?/, '').split('.')
  let cur: unknown = data
  for (const part of parts) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[part]
  }
  return cur
}

interface TestResult {
  ok: boolean; statusCode: number; contentType: string
  latencyMs: number; body: string; parsed: unknown
  fields: Array<{ name: string; type: string }>; error?: string
}

const FIXED_SCHEMA = [
  { id: 'f_status_code',  name: 'status_code',  type: 'integer', physicalName: 'status_code'  },
  { id: 'f_content_type', name: 'content_type', type: 'string',  physicalName: 'content_type' },
  { id: 'f_latency_ms',   name: 'latency_ms',   type: 'integer', physicalName: 'latency_ms'   },
  { id: 'f_headers',      name: 'headers',      type: 'object',  physicalName: 'headers'       },
]

const RESPONSE_TYPE_FIXED: Record<string, Array<{ id: string; name: string; type: string; physicalName: string }>> = {
  json_raw: [
    { id: 'f_body',        name: 'body',        type: 'string', physicalName: 'body'        },
    { id: 'f_body_parsed', name: 'body_parsed', type: 'object', physicalName: 'body_parsed' },
  ],
  text:   [{ id: 'f_body',    name: 'body',           type: 'string',  physicalName: 'body'           }],
  xml:    [{ id: 'f_body',    name: 'body',           type: 'string',  physicalName: 'body'           }],
  csv:    [{ id: 'f_body',    name: 'body',           type: 'string',  physicalName: 'body'           }],
  binary: [
    { id: 'f_content',        name: 'content',        type: 'string',  physicalName: 'content'        },
    { id: 'f_content_length', name: 'content_length', type: 'integer', physicalName: 'content_length' },
  ],
  pdf: [
    { id: 'f_content',        name: 'content',        type: 'string',  physicalName: 'content'        },
    { id: 'f_content_length', name: 'content_length', type: 'integer', physicalName: 'content_length' },
  ],
}

export function SourceHttpPanel({ nodeId }: { nodeId: string }) {
  const node         = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp   = useFlowStore((s) => s.updateNodeProp)
  const pool         = useFlowStore((s) => s.pool)
  const updateConfig = useFlowStore((s) => s.updateNodeConfig)
  const edges        = useFlowStore((s) => s.edges)
  const nodes        = useFlowStore((s) => s.nodes)

  const [testing,    setTesting]    = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [showBody,   setShowBody]   = useState(false)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>
  ) => updateProp(nodeId, key, e.target.value)

  const method       = p('method', 'GET')
  const authType     = p('authType', 'none')
  const pagination   = p('pagination', 'none')
  const responseType = p('responseType', 'json')
  const bodyMode     = p('inputBodyMode', 'json')

  const lane    = pool.lanes.find((l) => l.id === node.data.laneId)
  const httpRes = lane?.resources.filter((r) => r.kind === 'http') ?? []
  const resId   = node.data.config.resourceId ?? ''

  // ── Schema nodo in ingresso ───────────────────────────────────
  const incomingSchema = useMemo(() => {
    const inEdge  = edges.find((e) => e.target === nodeId)
    if (!inEdge) return []
    const srcNode = nodes.find((n) => n.id === inEdge.source)
    if (!srcNode) return []
    try {
      const raw = srcNode.data.props['outputSchema']
      if (!raw) return []
      const parsed = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed as Array<{ id: string; name: string; type: string }> : []
    } catch { return [] }
  }, [edges, nodes, nodeId])

  const hasInput    = incomingSchema.length > 0
  const hasBinary   = incomingSchema.some((f) => f.type === 'binary' || f.name === 'content')

  // ── Inserisci ${campo} in un campo di testo ───────────────────
  const insertVar = (targetProp: string, fieldName: string) => {
    const current = p(targetProp)
    updateProp(nodeId, targetProp, current + `\${${fieldName}}`)
  }

  // ── Test connessione ─────────────────────────────────────────
  const handleTest = async () => {
    const url = p('url')
    if (!url) return
    setTesting(true)
    setTestResult(null)
    const t0 = Date.now()
    try {
      const authHeaders = buildAuthHeaders(node.data.props)
      let extraHeaders: Record<string, string> = {}
      try { extraHeaders = JSON.parse(p('headers', '{}')) } catch {}

      const allHeaders: Record<string, string> = {
        'Accept': 'application/json, text/plain, */*',
        ...authHeaders,
        ...extraHeaders,
      }

      let finalUrl = url
      if (authType === 'api_key' && p('apiKeyIn', 'header') === 'query') {
        const sep = url.includes('?') ? '&' : '?'
        finalUrl += `${sep}${p('apiKeyName', 'X-Api-Key')}=${p('apiKeyValue')}`
      }
      try {
        const qp  = JSON.parse(p('queryParams', '{}'))
        const sep = finalUrl.includes('?') ? '&' : '?'
        const qs  = Object.entries(qp).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
        if (qs) finalUrl += sep + qs
      } catch {}

      const init: RequestInit = { method, headers: allHeaders }
      if (['POST', 'PUT', 'PATCH'].includes(method) && p('body')) {
        init.body = p('body')
        if (!allHeaders['Content-Type']) allHeaders['Content-Type'] = p('contentType', 'application/json')
      }

      const res         = await fetch(finalUrl, init)
      const latencyMs   = Date.now() - t0
      const contentType = res.headers.get('content-type') ?? ''
      const bodyText    = await res.text()

      let parsed: unknown = null
      let fields: Array<{ name: string; type: string }> = []

      if (responseType === 'json_raw') {
        try { parsed = JSON.parse(bodyText) } catch {}
      } else if (responseType === 'json' || contentType.includes('json')) {
        try {
          parsed = JSON.parse(bodyText)
          const target = resolveJsonPath(parsed, p('jsonPath', '$'))
          const sample = Array.isArray(target) ? target[0] : target
          fields = extractFields(sample)
        } catch {}
      }

      setTestResult({ ok: res.ok, statusCode: res.status, contentType, latencyMs, body: bodyText.slice(0, 4000), parsed, fields })

      const rtFixed = RESPONSE_TYPE_FIXED[responseType] ?? []
      if (responseType === 'json' && fields.length > 0) {
        const existing: any[] = (() => { try { return JSON.parse(p('customFields', '[]')) } catch { return [] } })()
        const existingNames   = new Set(existing.map((f: any) => f.name))
        const newFields       = fields.filter((f) => !existingNames.has(f.name)).map((f, i) => ({ id: `cf_${Date.now()}_${i}`, name: f.name, type: f.type, fixed: false }))
        const merged          = [...existing, ...newFields]
        updateProp(nodeId, 'customFields', JSON.stringify(merged))
        const schema = [...FIXED_SCHEMA, ...merged.map((f) => ({ id: f.id, name: f.name, type: f.type, physicalName: f.name }))]
        updateProp(nodeId, 'outputSchema', JSON.stringify(schema))
      } else {
        updateProp(nodeId, 'outputSchema', JSON.stringify([...FIXED_SCHEMA, ...rtFixed]))
      }
    } catch (err: any) {
      setTestResult({ ok: false, statusCode: 0, contentType: '', latencyMs: Date.now() - t0, body: '', parsed: null, fields: [], error: err.message })
    } finally {
      setTesting(false)
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* ══ DATI IN INGRESSO ════════════════════════════════════ */}
      {hasInput && (
        <div style={{ background: '#161b27', border: '1px solid #1d6d40', borderRadius: 8, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', background: '#0d3d20', borderBottom: '1px solid #1d6d40', display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className="ti ti-arrow-right" style={{ fontSize: 13, color: '#3ddc84' }} />
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: '#3ddc84' }}>
                Dati in ingresso — {incomingSchema.length} campi disponibili
              </div>
              <div style={{ fontSize: 9, color: '#1d6d40' }}>
                Una chiamata HTTP per ogni riga ricevuta · usa <code style={{ color: '#3ddc84' }}>${'{'}campo{'}'}</code> per interpolare i valori
              </div>
            </div>
          </div>

          <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>

            {/* Campi disponibili */}
            <div>
              <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
                Campi disponibili — clicca per inserire nell'URL
              </div>
              <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                {incomingSchema.map((f) => (
                  <FieldPill key={f.id} name={f.name} type={f.type}
                    onClick={() => insertVar('url', f.name)} />
                ))}
              </div>
            </div>

            {/* Modalità body per ingresso */}
            <div>
              <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em', marginBottom: 5 }}>
                Come inviare i dati in ingresso nella request
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {[
                  { value: 'none',    label: 'Non inviare',      icon: 'ti-minus',        desc: 'Solo interpolazione URL'       },
                  { value: 'json',    label: 'Come JSON body',   icon: 'ti-braces',       desc: 'Mappa campi → proprietà JSON'  },
                  { value: 'raw',     label: 'Campo come body',  icon: 'ti-file-text',    desc: 'Un campo diventa il body'      },
                  { value: 'binary',  label: 'Binario / PDF',    icon: 'ti-file-binary',  desc: 'Campo content → body binario'  },
                ].map((m) => (
                  <button key={m.value} onClick={() => updateProp(nodeId, 'inputBodyMode', m.value)}
                    style={{
                      padding: '6px 8px', borderRadius: 5, cursor: 'pointer', textAlign: 'left',
                      background: bodyMode === m.value ? '#1a3a6a' : '#1e2535',
                      border: bodyMode === m.value ? '1px solid #2a5a9a' : '1px solid #2a3349',
                      display: 'flex', flexDirection: 'column', gap: 2,
                    }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <i className={`ti ${m.icon}`} style={{ fontSize: 11, color: bodyMode === m.value ? '#4a9eff' : '#4a5a7a' }} />
                      <span style={{ fontSize: 10, fontWeight: 600, color: bodyMode === m.value ? '#4a9eff' : '#9a9aaa' }}>{m.label}</span>
                    </div>
                    <span style={{ fontSize: 9, color: bodyMode === m.value ? '#4a7aaa' : '#2a3349' }}>{m.desc}</span>
                  </button>
                ))}
              </div>
            </div>

            {/* Configurazione modalità json */}
            {bodyMode === 'json' && (
              <div style={{ background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  Mapping campi → JSON body
                </div>
                <div style={{ fontSize: 10, color: '#9a9aaa' }}>
                  Tutti i campi in ingresso vengono inclusi nel body JSON automaticamente.
                  Puoi escludere o rinominare campi nel campo template qui sotto.
                </div>
                <Field label="Template JSON body" hint='Lascia vuoto per inviare tutti i campi · usa ${campo} per valori specifici'>
                  <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 60, fontFamily: 'monospace', fontSize: 10 }}
                    value={p('inputBodyTemplate', '')} onChange={u('inputBodyTemplate')}
                    placeholder={'{\n  "id": "${id}",\n  "name": "${name}"\n}'}
                    spellCheck={false} />
                </Field>
                <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                  {incomingSchema.map((f) => (
                    <FieldPill key={f.id} name={f.name} type={f.type}
                      onClick={() => insertVar('inputBodyTemplate', f.name)} />
                  ))}
                </div>
              </div>
            )}

            {/* Configurazione modalità raw */}
            {bodyMode === 'raw' && (
              <div style={{ background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Field label="Campo da usare come body">
                  <CustomSelect style={inputStyle} value={p('inputRawField', '')} onChange={u('inputRawField')}>
                    <option value="">— seleziona campo —</option>
                    {incomingSchema.map((f) => (
                      <option key={f.id} value={f.name}>{f.name} ({f.type})</option>
                    ))}
                  </CustomSelect>
                </Field>
                <Field label="Content-Type da inviare">
                  <input type="text" style={inputStyle} value={p('inputRawContentType', 'text/plain')} onChange={u('inputRawContentType')}
                    placeholder="text/plain, application/xml, ..." />
                </Field>
              </div>
            )}

            {/* Configurazione modalità binary */}
            {bodyMode === 'binary' && (
              <div style={{ background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
                <Field label="Campo contenente il binario (base64)" hint="Tipicamente il campo 'content' da un nodo HTTP o File Input">
                  <CustomSelect style={inputStyle} value={p('inputBinaryField', 'content')} onChange={u('inputBinaryField')}>
                    <option value="">— seleziona campo —</option>
                    {incomingSchema.map((f) => (
                      <option key={f.id} value={f.name}>{f.name} ({f.type})</option>
                    ))}
                  </CustomSelect>
                </Field>
                <Field label="Content-Type da inviare">
                  <CustomSelect style={inputStyle} value={p('inputBinaryContentType', 'application/octet-stream')} onChange={u('inputBinaryContentType')}>
                    <option value="application/octet-stream">application/octet-stream (generico)</option>
                    <option value="application/pdf">application/pdf</option>
                    <option value="image/jpeg">image/jpeg</option>
                    <option value="image/png">image/png</option>
                    <option value="image/gif">image/gif</option>
                    <option value="audio/mpeg">audio/mpeg</option>
                    <option value="video/mp4">video/mp4</option>
                    <option value="application/zip">application/zip</option>
                  </CustomSelect>
                </Field>
                <InfoBox color="#ffb347">
                  Il campo base64 viene decodificato e inviato come body binario. Assicurati che il campo contenga effettivamente un base64 valido.
                </InfoBox>
              </div>
            )}

            {/* Headers dinamici da campi ingresso */}
            <div style={{ background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349', padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 6 }}>
              <div style={{ fontSize: 9, color: '#4a5a7a', textTransform: 'uppercase', letterSpacing: '.06em' }}>
                Header dinamici da campi ingresso (opzionale)
              </div>
              <Field label='Mapping campo → header (JSON)' hint='Es: {"tenant_id": "X-Tenant-Id", "token": "Authorization"}'>
                <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 48, fontFamily: 'monospace', fontSize: 10 }}
                  value={p('inputHeaderMapping', '{}')} onChange={u('inputHeaderMapping')} spellCheck={false} />
              </Field>
            </div>

            {/* Pass-through campi ingresso nello schema output */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', background: '#0f1117', borderRadius: 4, border: '0.5px solid #2a3349' }}>
              <div
                onClick={() => updateProp(nodeId, 'passthroughInput', p('passthroughInput', 'false') === 'true' ? 'false' : 'true')}
                style={{
                  width: 32, height: 16, borderRadius: 8, cursor: 'pointer', flexShrink: 0,
                  background: p('passthroughInput', 'false') === 'true' ? '#4a9eff' : '#2a3349',
                  position: 'relative', transition: 'background .2s',
                }}>
                <div style={{ width: 12, height: 12, borderRadius: '50%', background: '#fff', position: 'absolute', top: 2, left: p('passthroughInput', 'false') === 'true' ? 16 : 2, transition: 'left .2s' }} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                <span style={{ fontSize: 10, color: '#c8d4f0', fontWeight: 500 }}>
                  Includi campi ingresso nello schema output
                </span>
                <span style={{ fontSize: 9, color: '#4a5a7a' }}>
                  Il nodo successivo vede sia la risposta HTTP che i dati originali della riga
                </span>
              </div>
            </div>

          </div>
        </div>
      )}

      {/* ── Risorsa HTTP ─────────────────────────────────────── */}
      {httpRes.length > 0 && (
        <>
          <SectionTitle label="Risorsa HTTP" />
          <Field label="Connessione HTTP" hint="Usa la base URL e l'autenticazione della risorsa">
            <CustomSelect style={inputStyle} value={resId}
              onChange={(e) => updateConfig(nodeId, { resourceId: e.target.value })}>
              <option value="">— configurazione manuale —</option>
              {httpRes.map((r) => (
                <option key={r.id} value={r.id}>{r.label} {r.status === 'ok' ? '✓' : '○'}</option>
              ))}
            </CustomSelect>
          </Field>
        </>
      )}

      {/* ── Endpoint ─────────────────────────────────────────── */}
      <SectionTitle label="Endpoint" />
      <Row>
        <Field label="Metodo">
          <CustomSelect style={inputStyle} value={method} onChange={u('method')}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </CustomSelect>
        </Field>
        <Field label="Timeout (s)">
          <input type="number" style={inputStyle} value={p('timeout', '30')} onChange={u('timeout')} min="1" />
        </Field>
      </Row>

      <Field label="URL" hint={hasInput ? 'Usa ${campo} per interpolare valori dalla riga in ingresso' : undefined}>
        <input type="text" style={inputStyle} value={p('url')}
          onChange={u('url')} placeholder="{HTTP_DEFAULTS.url}/${id}" />
        {hasInput && (
          <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 4 }}>
            {incomingSchema.slice(0, 6).map((f) => (
              <FieldPill key={f.id} name={f.name} type={f.type}
                onClick={() => insertVar('url', f.name)} />
            ))}
            {incomingSchema.length > 6 && (
              <span style={{ fontSize: 9, color: '#4a5a7a', alignSelf: 'center' }}>+{incomingSchema.length - 6} altri</span>
            )}
          </div>
        )}
      </Field>

      <Field label="Query parameters (JSON)" hint={hasInput ? 'Supporta ${campo}' : 'Es: {"page": "1"}'}>
        <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 56, fontFamily: 'monospace' }}
          value={p('queryParams', '{}')} onChange={u('queryParams')} spellCheck={false} />
      </Field>

      {/* ── Body manuale (solo se bodyMode = none o GET) ──────── */}
      {(['POST', 'PUT', 'PATCH'].includes(method) && (!hasInput || bodyMode === 'none')) && (
        <>
          <SectionTitle label="Request body" />
          <Field label="Content-Type">
            <CustomSelect style={inputStyle} value={p('contentType', 'application/json')} onChange={u('contentType')}>
              <option value="application/json">application/json</option>
              <option value="application/x-www-form-urlencoded">form-urlencoded</option>
              <option value="multipart/form-data">multipart/form-data</option>
              <option value="text/plain">text/plain</option>
            </CustomSelect>
          </Field>
          <Field label="Body">
            <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 80, fontFamily: 'monospace', fontSize: 12 }}
              value={p('body', '{}')} onChange={u('body')} spellCheck={false} />
          </Field>
        </>
      )}

      {/* ── Autenticazione ───────────────────────────────────── */}
      <SectionTitle label="Autenticazione" />
      <Field label="Tipo">
        <CustomSelect style={inputStyle} value={authType} onChange={u('authType')}>
          <option value="none">Nessuna</option>
          <option value="basic">Basic Auth</option>
          <option value="bearer">Bearer Token</option>
          <option value="api_key">API Key</option>
          <option value="digest">Digest Auth</option>
          <option value="oauth2_cc">OAuth2 — Client Credentials</option>
          <option value="oauth2_ac">OAuth2 — Authorization Code</option>
        </CustomSelect>
      </Field>

      {authType === 'basic' && (
        <Row>
          <Field label="Username"><input type="text" style={inputStyle} value={p('username')} onChange={u('username')} /></Field>
          <Field label="Password"><input type="password" style={inputStyle} value={p('password')} onChange={u('password')} /></Field>
        </Row>
      )}
      {authType === 'digest' && (
        <>
          <Row>
            <Field label="Username"><input type="text" style={inputStyle} value={p('username')} onChange={u('username')} /></Field>
            <Field label="Password"><input type="password" style={inputStyle} value={p('password')} onChange={u('password')} /></Field>
          </Row>
          <InfoBox>Digest Auth — la password non viene trasmessa in chiaro.</InfoBox>
        </>
      )}
      {authType === 'bearer' && (
        <Field label="Bearer token">
          <input type="password" style={inputStyle} value={p('bearerToken')} onChange={u('bearerToken')} placeholder="eyJ..." />
        </Field>
      )}
      {authType === 'api_key' && (
        <>
          <Row>
            <Field label="Posizione">
              <CustomSelect style={inputStyle} value={p('apiKeyIn', 'header')} onChange={u('apiKeyIn')}>
                <option value="header">Header</option>
                <option value="query">Query parameter</option>
              </CustomSelect>
            </Field>
            <Field label="Nome">
              <input type="text" style={inputStyle} value={p('apiKeyName', 'X-Api-Key')} onChange={u('apiKeyName')} />
            </Field>
          </Row>
          <Field label="API Key"><input type="password" style={inputStyle} value={p('apiKeyValue')} onChange={u('apiKeyValue')} /></Field>
        </>
      )}
      {authType === 'oauth2_cc' && (
        <>
          <InfoBox color="#a78bfa">Token ottenuto automaticamente con client_id e client_secret.</InfoBox>
          <Field label="Token URL">
            <input type="text" style={inputStyle} value={p('oauth2TokenUrl')} onChange={u('oauth2TokenUrl')} placeholder={HTTP_DEFAULTS.url} />
          </Field>
          <Row>
            <Field label="Client ID"><input type="text" style={inputStyle} value={p('oauth2ClientId')} onChange={u('oauth2ClientId')} /></Field>
            <Field label="Client Secret"><input type="password" style={inputStyle} value={p('oauth2ClientSecret')} onChange={u('oauth2ClientSecret')} /></Field>
          </Row>
          <Field label="Scope" hint="Spazio-separati">
            <input type="text" style={inputStyle} value={p('oauth2Scope')} onChange={u('oauth2Scope')} placeholder="openid profile" />
          </Field>
          <Field label="Audience" hint="Opzionale">
            <input type="text" style={inputStyle} value={p('oauth2Audience')} onChange={u('oauth2Audience')} />
          </Field>
          <Row>
            <Field label="Client auth">
              <CustomSelect style={inputStyle} value={p('oauth2ClientAuth', 'body')} onChange={u('oauth2ClientAuth')}>
                <option value="body">Nel body</option>
                <option value="basic">Basic Auth header</option>
              </CustomSelect>
            </Field>
            <Field label="Auto-refresh">
              <CustomSelect style={inputStyle} value={p('oauth2AutoRefresh', 'true')} onChange={u('oauth2AutoRefresh')}>
                <option value="true">Sì</option>
                <option value="false">No</option>
              </CustomSelect>
            </Field>
          </Row>
        </>
      )}
      {authType === 'oauth2_ac' && (
        <>
          <InfoBox color="#ffb347">Authorization Code — incolla il token ottenuto esternamente.</InfoBox>
          <Field label="Access Token">
            <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 56, fontFamily: 'monospace', fontSize: 10 }}
              value={p('oauth2AccessToken')} onChange={u('oauth2AccessToken')} placeholder="eyJ..." spellCheck={false} />
          </Field>
          <Field label="Refresh Token" hint="Opzionale">
            <input type="password" style={inputStyle} value={p('oauth2RefreshToken')} onChange={u('oauth2RefreshToken')} />
          </Field>
          <Field label="Token URL">
            <input type="text" style={inputStyle} value={p('oauth2TokenUrl')} onChange={u('oauth2TokenUrl')} placeholder="https://auth.example.com/oauth/token" />
          </Field>
          <Row>
            <Field label="Client ID"><input type="text" style={inputStyle} value={p('oauth2ClientId')} onChange={u('oauth2ClientId')} /></Field>
            <Field label="Client Secret"><input type="password" style={inputStyle} value={p('oauth2ClientSecret')} onChange={u('oauth2ClientSecret')} /></Field>
          </Row>
        </>
      )}

      {/* ── Headers aggiuntivi ───────────────────────────────── */}
      <SectionTitle label="Headers aggiuntivi" />
      <Field label='Headers (JSON)' hint={hasInput ? 'Supporta ${campo} · es: {"X-Id": "${id}"}' : 'Es: {"Accept": "application/json"}'}>
        <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 56, fontFamily: 'monospace' }}
          value={p('headers', '{}')} onChange={u('headers')} spellCheck={false} />
      </Field>

      {/* ── Tipo risposta ─────────────────────────────────────── */}
      <SectionTitle label="Risposta" />
      <Field label="Tipo risposta attesa">
        <CustomSelect style={inputStyle} value={responseType} onChange={u('responseType')}>
          <option value="json">JSON — estrai campi singoli</option>
          <option value="json_raw">JSON raw — body completo come oggetto</option>
          <option value="text">Testo — stringa grezza</option>
          <option value="xml">XML — stringa grezza</option>
          <option value="binary">Binario — base64</option>
          <option value="pdf">PDF — base64</option>
          <option value="csv">CSV — stringa grezza</option>
        </CustomSelect>
      </Field>
      {responseType === 'json' && (
        <Field label="JSON Path dati" hint="Es: $.data.items · $ = root">
          <input type="text" style={inputStyle} value={p('jsonPath', '$')} onChange={u('jsonPath')} placeholder="$" />
        </Field>
      )}
      {responseType === 'json_raw' && (
        <InfoBox color="#a78bfa">
          Il body sarà disponibile in <code>body</code> (stringa) e <code>body_parsed</code> (oggetto).
        </InfoBox>
      )}

      {/* ── Paginazione ──────────────────────────────────────── */}
      <SectionTitle label="Paginazione" />
      <Row>
        <Field label="Tipo">
          <CustomSelect style={inputStyle} value={pagination} onChange={u('pagination')}>
            <option value="none">Nessuna</option>
            <option value="page">Page number</option>
            <option value="cursor">Cursor based</option>
            <option value="offset">Offset / limit</option>
            <option value="link">Link header</option>
          </CustomSelect>
        </Field>
        <Field label="Page size">
          <input type="number" style={inputStyle} value={p('pageSize', '100')} onChange={u('pageSize')} min="1" />
        </Field>
      </Row>
      {pagination === 'page' && (
        <Row>
          <Field label="Param pagina"><input type="text" style={inputStyle} value={p('pageParam', 'page')} onChange={u('pageParam')} /></Field>
          <Field label="Pagina iniziale"><input type="number" style={inputStyle} value={p('pageStart', '1')} onChange={u('pageStart')} min="0" /></Field>
        </Row>
      )}
      {pagination === 'cursor' && (
        <>
          <Field label="Param cursor"><input type="text" style={inputStyle} value={p('cursorParam', 'cursor')} onChange={u('cursorParam')} /></Field>
          <Field label="JSON Path next cursor"><input type="text" style={inputStyle} value={p('cursorPath', '$.meta.next_cursor')} onChange={u('cursorPath')} /></Field>
        </>
      )}
      {pagination === 'offset' && (
        <Row>
          <Field label="Param offset"><input type="text" style={inputStyle} value={p('offsetParam', 'offset')} onChange={u('offsetParam')} /></Field>
          <Field label="Param limit"><input type="text" style={inputStyle} value={p('limitParam', 'limit')} onChange={u('limitParam')} /></Field>
        </Row>
      )}
      {pagination !== 'none' && (
        <Field label="Massimo pagine" hint="0 = nessun limite">
          <input type="number" style={inputStyle} value={p('maxPages', '0')} onChange={u('maxPages')} min="0" />
        </Field>
      )}

      {/* ── Resilienza ───────────────────────────────────────── */}
      <SectionTitle label="Resilienza" />
      <Row>
        <Field label="Retry su errore"><input type="number" style={inputStyle} value={p('retryCount', '0')} onChange={u('retryCount')} min="0" max="10" /></Field>
        <Field label="Delay retry (s)"><input type="number" style={inputStyle} value={p('retryDelay', '5')} onChange={u('retryDelay')} min="0" /></Field>
      </Row>
      <Field label="Codici HTTP da ritentare" hint="Separati da virgola">
        <input type="text" style={inputStyle} value={p('retryCodes', '429,503,504')} onChange={u('retryCodes')} />
      </Field>

      {/* ══ TEST CONNESSIONE ════════════════════════════════════ */}
      <SectionTitle label="Test connessione" color="#3ddc84" />

      <button onClick={handleTest} disabled={testing || !p('url')}
        style={{
          padding: '9px 16px', fontSize: 12, borderRadius: 6,
          cursor: testing || !p('url') ? 'not-allowed' : 'pointer',
          opacity: !p('url') ? 0.5 : 1,
          background: testing ? '#1a2030' : '#0d3d20',
          color: testing ? '#4a5a7a' : '#3ddc84',
          border: `1px solid ${testing ? '#2a3349' : '#1d6d40'}`,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 8,
          fontWeight: 600, transition: 'all .15s',
        }}
        onMouseEnter={(e) => { if (!testing && p('url')) (e.currentTarget as HTMLElement).style.background = '#1d6d40' }}
        onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = testing ? '#1a2030' : '#0d3d20' }}>
        <i className={`ti ${testing ? 'ti-loader-2' : 'ti-send'}`}
          style={{ fontSize: 14, animation: testing ? 'spin 1s linear infinite' : undefined }} />
        {testing ? 'Chiamata in corso...' : 'Testa connessione'}
      </button>

      {testResult && (
        <div style={{ background: '#0f1117', border: `1px solid ${testResult.ok ? '#1d6d40' : '#5a1a1a'}`, borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ padding: '8px 12px', background: testResult.ok ? '#0d3d20' : '#2a0a0a', display: 'flex', alignItems: 'center', gap: 8 }}>
            <i className={`ti ${testResult.ok ? 'ti-circle-check' : 'ti-circle-x'}`}
              style={{ fontSize: 16, color: testResult.ok ? '#3ddc84' : '#ff5f57' }} />
            <div style={{ flex: 1 }}>
              <span style={{ fontSize: 12, fontWeight: 600, color: testResult.ok ? '#3ddc84' : '#ff5f57' }}>
                {testResult.error ? `Errore: ${testResult.error}` : `HTTP ${testResult.statusCode}`}
              </span>
              {!testResult.error && (
                <span style={{ fontSize: 11, color: '#4a5a7a', marginLeft: 10 }}>
                  {testResult.latencyMs}ms · {testResult.contentType || 'content-type sconosciuto'}
                </span>
              )}
            </div>
          </div>
          {testResult.fields.length > 0 && (
            <div style={{ padding: '8px 12px', borderBottom: '0.5px solid #2a3349' }}>
              <div style={{ fontSize: 10, color: '#3ddc84', fontWeight: 600, marginBottom: 6 }}>
                {testResult.fields.length} campi rilevati — aggiunti al mapping
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {testResult.fields.map((f) => (
                  <div key={f.name} style={{ padding: '2px 8px', background: '#1a2030', borderRadius: 10, border: '0.5px solid #2a3349', display: 'flex', alignItems: 'center', gap: 5 }}>
                    <code style={{ fontSize: 9, color: '#4a9eff' }}>{f.name}</code>
                    <span style={{ fontSize: 9, color: '#4a5a7a' }}>{f.type}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {testResult.body && (
            <div style={{ padding: '6px 12px' }}>
              <button onClick={() => setShowBody((v) => !v)}
                style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#4a5a7a', fontSize: 10, display: 'flex', alignItems: 'center', gap: 4, padding: 0 }}>
                <i className={`ti ${showBody ? 'ti-chevron-down' : 'ti-chevron-right'}`} style={{ fontSize: 10 }} />
                {showBody ? 'Nascondi' : 'Mostra'} body risposta
              </button>
              {showBody && (
                <pre style={{ marginTop: 8, padding: 8, background: '#161b27', borderRadius: 4, fontSize: 10, color: '#9a9aaa', overflow: 'auto', maxHeight: 200, fontFamily: 'monospace', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
                  {(() => { try { return JSON.stringify(JSON.parse(testResult.body), null, 2) } catch { return testResult.body } })()}
                </pre>
              )}
            </div>
          )}
        </div>
      )}

    </div>
  )
}
