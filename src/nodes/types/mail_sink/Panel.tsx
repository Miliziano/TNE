/**
 * src/nodes/types/mail_sink/Panel.tsx
 */

import { useFlowStore } from '../../../store/flowStore'
import { useIncomingSchema } from '../../../nodes/useIncomingSchema'
import { CustomSelect } from '../../../components/CustomSelect'

const inputStyle: React.CSSProperties = {
  width: '100%', background: '#1e2535', border: '1px solid #3a4a6a',
  borderRadius: 4, color: '#c8d4f0', fontFamily: "'JetBrains Mono', monospace",
  fontSize: 11, padding: '5px 8px', outline: 'none',
}
const labelStyle: React.CSSProperties = {
  fontSize: 10, color: '#9a9aaa', textTransform: 'uppercase',
  letterSpacing: '.08em', marginBottom: 4, fontWeight: 600,
}
function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '7px 10px', background: '#1a2030', borderRadius: 6, border: '0.5px solid #2a3349' }}>
      <div style={labelStyle}>{label}</div>
      {children}
      {hint && <div style={{ fontSize: 10, color: '#8593b5', fontStyle: 'italic' }}>{hint}</div>}
    </div>
  )
}
function Row({ children }: { children: React.ReactNode }) {
  return <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>{children}</div>
}
function SectionTitle({ label, color = '#4a9eff' }: { label: string; color?: string }) {
  return (
    <div style={{ fontSize: 10, fontWeight: 600, color, textTransform: 'uppercase', letterSpacing: '.08em', padding: '4px 0', borderBottom: `0.5px solid ${color}30`, marginBottom: 6 }}>
      {label}
    </div>
  )
}

const ACCENT = '#4a9eff'

export function MailSinkPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)


  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    updateProp(nodeId, key, e.target.value)

  const provider   = p('provider', 'smtp')
  const bodySource = p('bodySource', 'field')
  const toMode     = p('toMode', 'static')

  const incomingFields = useIncomingSchema(nodeId)

  const fieldSelect = (key: string, placeholder: string) =>
    incomingFields.length > 0 ? (
      <CustomSelect style={inputStyle} value={p(key)} onChange={u(key)}>
        <option value="">— seleziona campo —</option>
        {incomingFields.map((f) => <option key={f.name} value={f.name}>{f.name} ({f.type})</option>)}
      </CustomSelect>
    ) : (
      <input style={inputStyle} value={p(key)} onChange={u(key)} placeholder={placeholder} />
    )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>

      {/* Provider */}
      <SectionTitle label="Provider" />
      <div style={{ display: 'flex', gap: 6 }}>
        {[
          { value: 'smtp',     label: 'SMTP',      desc: 'Standard mail server' },
          { value: 'sendgrid', label: 'SendGrid',  desc: 'SendGrid cloud API'   },
          { value: 'ses',      label: 'Amazon SES', desc: 'AWS Simple Email'    },
          { value: 'mailgun',  label: 'Mailgun',   desc: 'Mailgun cloud API'    },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'provider', m.value)}
            style={{
              flex: 1, padding: '6px 4px', borderRadius: 4, cursor: 'pointer',
              background: provider === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: provider === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: provider === m.value ? ACCENT : '#8593b5' }}>{m.label}</span>
            <span style={{ fontSize: 9, color: provider === m.value ? '#7a9aaa' : '#2a3349' }}>{m.desc}</span>
          </button>
        ))}
      </div>

      {/* SMTP config */}
      {provider === 'smtp' && (
        <>
          <SectionTitle label="SMTP configuration" />
          <Row>
            <Field label="Host">
              <input style={inputStyle} value={p('smtpHost', 'smtp.gmail.com')} onChange={u('smtpHost')} />
            </Field>
            <Field label="Port">
              <input type="number" style={inputStyle} value={p('smtpPort', '587')} onChange={u('smtpPort')} />
            </Field>
          </Row>
          <Row>
            <Field label="Username">
              <input style={inputStyle} value={p('smtpUser')} onChange={u('smtpUser')} />
            </Field>
            <Field label="Password">
              <input type="password" style={inputStyle} value={p('smtpPass')} onChange={u('smtpPass')} />
            </Field>
          </Row>
          <Field label="Security">
            <CustomSelect style={inputStyle} value={p('smtpSecurity', 'starttls')} onChange={u('smtpSecurity')}>
              <option value="none">None</option>
              <option value="starttls">STARTTLS (port 587)</option>
              <option value="ssl">SSL/TLS (port 465)</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {/* API key per provider cloud */}
      {provider !== 'smtp' && (
        <>
          <SectionTitle label={`${provider} configuration`} />
          <Field label="API Key">
            <input type="password" style={inputStyle} value={p('apiKey')} onChange={u('apiKey')} placeholder="sk-..." />
          </Field>
          {provider === 'ses' && (
            <Row>
              <Field label="AWS region">
                <input style={inputStyle} value={p('awsRegion', 'eu-west-1')} onChange={u('awsRegion')} />
              </Field>
              <Field label="AWS Access Key">
                <input style={inputStyle} value={p('awsAccessKey')} onChange={u('awsAccessKey')} />
              </Field>
            </Row>
          )}
        </>
      )}

      {/* Mittente */}
      <SectionTitle label="Sender" />
      <Row>
        <Field label="Sender email">
          <input style={inputStyle} value={p('fromEmail')} onChange={u('fromEmail')} placeholder="noreply@company.com" />
        </Field>
        <Field label="Sender name">
          <input style={inputStyle} value={p('fromName')} onChange={u('fromName')} placeholder="FlowPilot Reports" />
        </Field>
      </Row>

      {/* Destinatari */}
      <SectionTitle label="Recipients" />
      <Field label="Recipients mode">
        <CustomSelect style={inputStyle} value={toMode} onChange={u('toMode')}>
          <option value="static">Static — fixed email list</option>
          <option value="field">From field — use a row field</option>
          <option value="both">Both — field + fixed list in CC</option>
        </CustomSelect>
      </Field>
      {(toMode === 'static' || toMode === 'both') && (
        <Field label="TO email (one per line or comma-separated)">
          <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }}
            value={p('toEmails')} onChange={u('toEmails')}
            placeholder="report@company.com, manager@company.com" />
        </Field>
      )}
      {(toMode === 'field' || toMode === 'both') && (
        <Field label="Recipient email field" hint="Row field that contains the email">
          {fieldSelect('toField', 'email')}
        </Field>
      )}
      <Row>
        <Field label="CC (optional)">
          <input style={inputStyle} value={p('ccEmails')} onChange={u('ccEmails')} placeholder="cc@company.com" />
        </Field>
        <Field label="BCC (optional)">
          <input style={inputStyle} value={p('bccEmails')} onChange={u('bccEmails')} placeholder="bcc@company.com" />
        </Field>
      </Row>

      {/* Oggetto */}
      <SectionTitle label="Message" />
      <Field label="Subject" hint="Use {field_name} to include row values">
        <input style={inputStyle} value={p('subject', 'Report {date}')} onChange={u('subject')}
          placeholder="Report {date} — {title}" />
      </Field>

      {/* Body */}
      <Field label="Body source">
        <CustomSelect style={inputStyle} value={bodySource} onChange={u('bodySource')}>
          <option value="field">From field — use the HTML/text field from the row (e.g. from Report Generator)</option>
          <option value="template">Inline template — write the template here</option>
          <option value="plain">Plain text</option>
        </CustomSelect>
      </Field>

      {bodySource === 'field' && (
        <Field label="HTML body field" hint="Usually the 'content' field from the Report Generator node">
          {fieldSelect('bodyField', 'content')}
        </Field>
      )}

      {bodySource === 'template' && (
        <Field label="HTML template" hint="Use {field_name} for the row values">
          <textarea
            style={{ ...inputStyle, resize: 'vertical', minHeight: 120, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5 }}
            value={p('bodyTemplate')} onChange={u('bodyTemplate')}
            placeholder={'<h2>Report {date}</h2>\n<p>Total: <strong>{total}</strong></p>'}
            spellCheck={false}
          />
        </Field>
      )}

      {bodySource === 'plain' && (
        <Field label="Body text">
          <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }}
            value={p('bodyText')} onChange={u('bodyText')}
            placeholder="Report generated on {date}..." />
        </Field>
      )}

      {/* Allegati */}
      <SectionTitle label="Attachments" />
      <Field label="Attachment field" hint="Row field with the binary content (base64) — e.g. from Report Generator PDF">
        {fieldSelect('attachmentField', 'content')}
      </Field>
      <Row>
        <Field label="Attachment file name" hint="Use {field_name} for dynamic values">
          <input style={inputStyle} value={p('attachmentName')} onChange={u('attachmentName')} placeholder="report_{date}.pdf" />
        </Field>
        <Field label="Attachment MIME type">
          <CustomSelect style={inputStyle} value={p('attachmentMime', 'application/pdf')} onChange={u('attachmentMime')}>
            <option value="application/pdf">PDF</option>
            <option value="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">Excel</option>
            <option value="text/csv">CSV</option>
            <option value="text/html">HTML</option>
            <option value="application/octet-stream">Generic binary</option>
          </CustomSelect>
        </Field>
      </Row>

      {/* Opzioni invio */}
      <SectionTitle label="Send options" />
      <Row>
        <Field label="Priority">
          <CustomSelect style={inputStyle} value={p('priority', 'normal')} onChange={u('priority')}>
            <option value="low">Low</option>
            <option value="normal">Normal</option>
            <option value="high">High</option>
          </CustomSelect>
        </Field>
        <Field label="Retry on error">
          <input type="number" style={inputStyle} value={p('retryCount', '2')} onChange={u('retryCount')} min="0" max="5" />
        </Field>
      </Row>
      <Field label="Send mode">
        <CustomSelect style={inputStyle} value={p('sendMode', 'per_row')} onChange={u('sendMode')}>
          <option value="per_row">Per row — one email per incoming row</option>
          <option value="batch">Batch — a single email with all rows</option>
        </CustomSelect>
      </Field>

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#8593b5', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0, marginTop: 1 }} />
        Typical pattern: <code style={{ color: '#3ddc84', fontSize: 9 }}>Aggregate → Report Generator → Mail Sink</code>
      </div>
    </div>
  )
}
