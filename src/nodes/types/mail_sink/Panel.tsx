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
      {hint && <div style={{ fontSize: 10, color: '#4a5a7a', fontStyle: 'italic' }}>{hint}</div>}
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
          { value: 'smtp',     label: 'SMTP',      desc: 'Server mail standard' },
          { value: 'sendgrid', label: 'SendGrid',  desc: 'API cloud SendGrid'   },
          { value: 'ses',      label: 'Amazon SES', desc: 'AWS Simple Email'    },
          { value: 'mailgun',  label: 'Mailgun',   desc: 'API cloud Mailgun'    },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'provider', m.value)}
            style={{
              flex: 1, padding: '6px 4px', borderRadius: 4, cursor: 'pointer',
              background: provider === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: provider === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            }}>
            <span style={{ fontSize: 10, fontWeight: 600, color: provider === m.value ? ACCENT : '#4a5a7a' }}>{m.label}</span>
            <span style={{ fontSize: 9, color: provider === m.value ? '#7a9aaa' : '#2a3349' }}>{m.desc}</span>
          </button>
        ))}
      </div>

      {/* SMTP config */}
      {provider === 'smtp' && (
        <>
          <SectionTitle label="Configurazione SMTP" />
          <Row>
            <Field label="Host">
              <input style={inputStyle} value={p('smtpHost', 'smtp.gmail.com')} onChange={u('smtpHost')} />
            </Field>
            <Field label="Porta">
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
          <Field label="Sicurezza">
            <CustomSelect style={inputStyle} value={p('smtpSecurity', 'starttls')} onChange={u('smtpSecurity')}>
              <option value="none">Nessuna</option>
              <option value="starttls">STARTTLS (porta 587)</option>
              <option value="ssl">SSL/TLS (porta 465)</option>
            </CustomSelect>
          </Field>
        </>
      )}

      {/* API key per provider cloud */}
      {provider !== 'smtp' && (
        <>
          <SectionTitle label={`Configurazione ${provider}`} />
          <Field label="API Key">
            <input type="password" style={inputStyle} value={p('apiKey')} onChange={u('apiKey')} placeholder="sk-..." />
          </Field>
          {provider === 'ses' && (
            <Row>
              <Field label="Regione AWS">
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
      <SectionTitle label="Mittente" />
      <Row>
        <Field label="Email mittente">
          <input style={inputStyle} value={p('fromEmail')} onChange={u('fromEmail')} placeholder="noreply@azienda.it" />
        </Field>
        <Field label="Nome mittente">
          <input style={inputStyle} value={p('fromName')} onChange={u('fromName')} placeholder="FlowPilot Reports" />
        </Field>
      </Row>

      {/* Destinatari */}
      <SectionTitle label="Destinatari" />
      <Field label="Modalità destinatari">
        <CustomSelect style={inputStyle} value={toMode} onChange={u('toMode')}>
          <option value="static">Statici — lista email fissa</option>
          <option value="field">Da campo — usa un campo della riga</option>
          <option value="both">Entrambi — campo + lista fissa in CC</option>
        </CustomSelect>
      </Field>
      {(toMode === 'static' || toMode === 'both') && (
        <Field label="Email TO (una per riga o separate da virgola)">
          <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 60 }}
            value={p('toEmails')} onChange={u('toEmails')}
            placeholder="report@azienda.it, manager@azienda.it" />
        </Field>
      )}
      {(toMode === 'field' || toMode === 'both') && (
        <Field label="Campo email destinatario" hint="Campo della riga che contiene l'email">
          {fieldSelect('toField', 'email')}
        </Field>
      )}
      <Row>
        <Field label="CC (opzionale)">
          <input style={inputStyle} value={p('ccEmails')} onChange={u('ccEmails')} placeholder="cc@azienda.it" />
        </Field>
        <Field label="BCC (opzionale)">
          <input style={inputStyle} value={p('bccEmails')} onChange={u('bccEmails')} placeholder="bcc@azienda.it" />
        </Field>
      </Row>

      {/* Oggetto */}
      <SectionTitle label="Messaggio" />
      <Field label="Oggetto" hint="Usa {nome_campo} per includere valori dalla riga">
        <input style={inputStyle} value={p('subject', 'Report {date}')} onChange={u('subject')}
          placeholder="Report {date} — {titolo}" />
      </Field>

      {/* Body */}
      <Field label="Sorgente body">
        <CustomSelect style={inputStyle} value={bodySource} onChange={u('bodySource')}>
          <option value="field">Da campo — usa il campo HTML/testo dalla riga (es. da Report Generator)</option>
          <option value="template">Template inline — scrivi il template qui</option>
          <option value="plain">Testo semplice</option>
        </CustomSelect>
      </Field>

      {bodySource === 'field' && (
        <Field label="Campo body HTML" hint="Di solito il campo 'content' dal nodo Report Generator">
          {fieldSelect('bodyField', 'content')}
        </Field>
      )}

      {bodySource === 'template' && (
        <Field label="Template HTML" hint="Usa {nome_campo} per i valori della riga">
          <textarea
            style={{ ...inputStyle, resize: 'vertical', minHeight: 120, fontFamily: 'monospace', fontSize: 11, lineHeight: 1.5 }}
            value={p('bodyTemplate')} onChange={u('bodyTemplate')}
            placeholder={'<h2>Report del {date}</h2>\n<p>Totale: <strong>{totale}</strong></p>'}
            spellCheck={false}
          />
        </Field>
      )}

      {bodySource === 'plain' && (
        <Field label="Testo body">
          <textarea style={{ ...inputStyle, resize: 'vertical', minHeight: 80 }}
            value={p('bodyText')} onChange={u('bodyText')}
            placeholder="Report generato il {date}..." />
        </Field>
      )}

      {/* Allegati */}
      <SectionTitle label="Allegati" />
      <Field label="Campo allegato" hint="Campo della riga con il contenuto binario (base64) — es. da Report Generator PDF">
        {fieldSelect('attachmentField', 'content')}
      </Field>
      <Row>
        <Field label="Nome file allegato" hint="Usa {nome_campo} per valori dinamici">
          <input style={inputStyle} value={p('attachmentName')} onChange={u('attachmentName')} placeholder="report_{date}.pdf" />
        </Field>
        <Field label="MIME type allegato">
          <CustomSelect style={inputStyle} value={p('attachmentMime', 'application/pdf')} onChange={u('attachmentMime')}>
            <option value="application/pdf">PDF</option>
            <option value="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet">Excel</option>
            <option value="text/csv">CSV</option>
            <option value="text/html">HTML</option>
            <option value="application/octet-stream">Binario generico</option>
          </CustomSelect>
        </Field>
      </Row>

      {/* Opzioni invio */}
      <SectionTitle label="Opzioni invio" />
      <Row>
        <Field label="Priorità">
          <CustomSelect style={inputStyle} value={p('priority', 'normal')} onChange={u('priority')}>
            <option value="low">Bassa</option>
            <option value="normal">Normale</option>
            <option value="high">Alta</option>
          </CustomSelect>
        </Field>
        <Field label="Retry su errore">
          <input type="number" style={inputStyle} value={p('retryCount', '2')} onChange={u('retryCount')} min="0" max="5" />
        </Field>
      </Row>
      <Field label="Modalità invio">
        <CustomSelect style={inputStyle} value={p('sendMode', 'per_row')} onChange={u('sendMode')}>
          <option value="per_row">Per riga — una mail per ogni riga in ingresso</option>
          <option value="batch">Batch — una sola mail con tutte le righe</option>
        </CustomSelect>
      </Field>

      <div style={{ padding: '6px 10px', background: '#1a2030', borderRadius: 4, border: '0.5px solid #2a3349', fontSize: 10, color: '#4a5a7a', display: 'flex', gap: 6 }}>
        <i className="ti ti-info-circle" style={{ fontSize: 11, color: ACCENT, flexShrink: 0, marginTop: 1 }} />
        Pattern tipico: <code style={{ color: '#3ddc84', fontSize: 9 }}>Aggregate → Report Generator → Mail Sink</code>
      </div>
    </div>
  )
}
