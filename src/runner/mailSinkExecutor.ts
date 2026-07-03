/**
 * src/runner/mailSinkExecutor.ts
 * ──────────────────────────────
 * Executor per il nodo mail_sink.
 *
 * Provider supportati:
 *   - smtp     → invoke('mail_send') — comando Rust via lettre
 *   - sendgrid → fetch REST API v3
 *   - ses      → fetch REST API AWS SES v2
 *   - mailgun  → fetch REST API Mailgun
 *
 * Modalità:
 *   - per_row  → una email per ogni riga in ingresso
 *   - batch    → una sola email con tutte le righe (corpo aggregato)
 *
 * Aggiungere in executors.ts:
 *   import { mailSinkExecutor } from './mailSinkExecutor'
 *   // in EXECUTORS[]: mailSinkExecutor
 */

import type { Row, NodeExecutor, ExecutionContext } from './types'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData } from '../types'
import { invoke } from '@tauri-apps/api/core'

// ─── Tipi ─────────────────────────────────────────────────────────

interface MailMessage {
  from:        string          // "Nome <email>"
  to:          string[]
  cc?:         string[]
  bcc?:        string[]
  subject:     string
  html?:       string
  text?:       string
  attachments?: MailAttachment[]
  priority?:   'low' | 'normal' | 'high'
}

interface MailAttachment {
  filename:    string
  content:     string          // base64
  contentType: string
}

interface SmtpConfig {
  host:     string
  port:     number
  user:     string
  pass:     string
  security: 'none' | 'starttls' | 'ssl'
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Sostituisce {campo} con il valore della riga */
function interpolate(template: string, row: Row): string {
  return template.replace(/\{([\w\u00C0-\u024F]+)\}/g, (_, field) => {
    const val = row[field]
    if (val === null || val === undefined) return ''
    return String(val)
  })
}

/** Costruisce la lista destinatari per una riga */
function buildRecipients(props: Record<string, unknown>, row: Row): {
  to: string[]; cc: string[]; bcc: string[]
} {
  const p      = (k: string, d = '') => String(props[k] ?? d)
  const toMode = p('toMode', 'static')
  const to: string[] = []

  if (toMode === 'static' || toMode === 'both') {
    const staticEmails = p('toEmails').split(/[,\n]/).map(s => s.trim()).filter(Boolean)
    to.push(...staticEmails)
  }
  if (toMode === 'field' || toMode === 'both') {
    const fieldName  = p('toField', 'email')
    const fieldValue = row[fieldName]
    if (fieldValue) {
      String(fieldValue).split(',').map(s => s.trim()).filter(Boolean).forEach(e => to.push(e))
    }
  }

  const cc  = p('ccEmails').split(',').map(s => s.trim()).filter(Boolean)
  const bcc = p('bccEmails').split(',').map(s => s.trim()).filter(Boolean)
  return { to, cc, bcc }
}

/** Costruisce il corpo dell'email per una riga */
function buildBody(props: Record<string, unknown>, row: Row): { html?: string; text?: string } {
  const p          = (k: string, d = '') => String(props[k] ?? d)
  const bodySource = p('bodySource', 'field')

  if (bodySource === 'field') {
    const fieldName = p('bodyField', 'content')
    const content   = row[fieldName]
    if (content) {
      const s = String(content)
      // Se sembra HTML lo passa come html, altrimenti come text
      return s.trim().startsWith('<') ? { html: s } : { text: s }
    }
    return { text: '' }
  }

  if (bodySource === 'template') {
    const tmpl = p('bodyTemplate', '')
    const html = interpolate(tmpl, row)
    return { html }
  }

  if (bodySource === 'plain') {
    return { text: interpolate(p('bodyText', ''), row) }
  }

  return {}
}

/** Costruisce l'allegato per una riga (se configurato) */
function buildAttachment(props: Record<string, unknown>, row: Row): MailAttachment | null {
  const p         = (k: string, d = '') => String(props[k] ?? d)
  const fieldName = p('attachmentField', '')
  if (!fieldName) return null

  const content = row[fieldName]
  if (!content) return null

  return {
    filename:    interpolate(p('attachmentName', 'allegato.pdf'), row),
    content:     String(content),
    contentType: p('attachmentMime', 'application/pdf'),
  }
}

// ─── Provider: SMTP via Rust/lettre ──────────────────────────────

async function sendSmtp(msg: MailMessage, cfg: SmtpConfig): Promise<void> {
  await invoke('mail_send', {
    request: {
      smtp: {
        host:     cfg.host,
        port:     cfg.port,
        username: cfg.user,
        password: cfg.pass,
        security: cfg.security,
      },
      from:        msg.from,
      to:          msg.to,
      cc:          msg.cc ?? [],
      bcc:         msg.bcc ?? [],
      subject:     msg.subject,
      html:        msg.html ?? null,
      text:        msg.text ?? null,
      attachments: (msg.attachments ?? []).map(a => ({
        filename:     a.filename,
        content_b64:  a.content,
        content_type: a.contentType,
      })),
    },
  })
}

// ─── Provider: SendGrid ───────────────────────────────────────────

async function sendSendGrid(msg: MailMessage, apiKey: string): Promise<void> {
  const body = {
    personalizations: [{
      to:  msg.to.map(e => ({ email: e })),
      cc:  msg.cc?.map(e => ({ email: e })),
      bcc: msg.bcc?.map(e => ({ email: e })),
    }],
    from:    { email: msg.from },
    subject: msg.subject,
    content: msg.html
      ? [{ type: 'text/html', value: msg.html }]
      : [{ type: 'text/plain', value: msg.text ?? '' }],
    attachments: msg.attachments?.map(a => ({
      content:  a.content,
      filename: a.filename,
      type:     a.contentType,
    })),
  }

  const res = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`SendGrid error ${res.status}: ${err}`)
  }
}

// ─── Provider: Mailgun ────────────────────────────────────────────

async function sendMailgun(msg: MailMessage, apiKey: string, domain: string): Promise<void> {
  const form = new FormData()
  form.append('from',    msg.from)
  form.append('subject', msg.subject)
  msg.to.forEach(e  => form.append('to',  e))
  msg.cc?.forEach(e  => form.append('cc',  e))
  msg.bcc?.forEach(e => form.append('bcc', e))
  if (msg.html) form.append('html', msg.html)
  else if (msg.text) form.append('text', msg.text)
  msg.attachments?.forEach(a => {
    const bytes = Uint8Array.from(atob(a.content), c => c.charCodeAt(0))
    form.append('attachment', new Blob([bytes], { type: a.contentType }), a.filename)
  })

  const res = await fetch(`https://api.mailgun.net/v3/${domain}/messages`, {
    method: 'POST',
    headers: { 'Authorization': 'Basic ' + btoa(`api:${apiKey}`) },
    body: form,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Mailgun error ${res.status}: ${err}`)
  }
}

// ─── Provider: Amazon SES ─────────────────────────────────────────
// Usa SES v2 REST API con firma AWS Signature V4 semplificata.
// Per semplicità invia via endpoint HTTPS con Authorization header.

async function sendSes(msg: MailMessage, apiKey: string, secretKey: string, region: string): Promise<void> {
  // SES v2 — SendEmail endpoint
  const body = {
    FromEmailAddress: msg.from,
    Destination: {
      ToAddresses:  msg.to,
      CcAddresses:  msg.cc  ?? [],
      BccAddresses: msg.bcc ?? [],
    },
    Content: {
      Simple: {
        Subject: { Data: msg.subject, Charset: 'UTF-8' },
        Body: msg.html
          ? { Html: { Data: msg.html, Charset: 'UTF-8' } }
          : { Text: { Data: msg.text ?? '', Charset: 'UTF-8' } },
      },
    },
  }

  // Firma AWS Signature V4 — implementazione base
  const endpoint = `https://email.${region}.amazonaws.com/v2/email/outbound-emails`
  const now      = new Date()
  const dateStr  = now.toISOString().replace(/[:\-]|\.\d{3}/g, '').slice(0, 15) + 'Z'
  const dateOnly = dateStr.slice(0, 8)
  const payload  = JSON.stringify(body)

  // Hash del payload
  const payloadHash = await sha256Hex(payload)

  const canonicalHeaders =
    `content-type:application/json\n` +
    `host:email.${region}.amazonaws.com\n` +
    `x-amz-date:${dateStr}\n`

  const signedHeaders = 'content-type;host;x-amz-date'

  const canonicalRequest = [
    'POST',
    '/v2/email/outbound-emails',
    '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n')

  const credentialScope = `${dateOnly}/`+ region + '/ses/aws4_request'
  const stringToSign    = `AWS4-HMAC-SHA256\n${dateStr}\n${credentialScope}\n${await sha256Hex(canonicalRequest)}`

  const signingKey = await deriveSigningKey(secretKey, dateOnly, region, 'ses')
  const signature  = await hmacHex(signingKey, stringToSign)

  const authHeader = `AWS4-HMAC-SHA256 Credential=${apiKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`

  const res = await fetch(endpoint, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Amz-Date':   dateStr,
      'Authorization': authHeader,
    },
    body: payload,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`SES error ${res.status}: ${err}`)
  }
}

// ─── AWS crypto helpers ───────────────────────────────────────────

async function sha256Hex(data: string): Promise<string> {
  const buf  = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(data))
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hmacHex(key: ArrayBuffer, data: string): Promise<string> {
  const k   = await crypto.subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data))
  return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, '0')).join('')
}

async function hmacBuf(key: ArrayBuffer | string, data: string): Promise<ArrayBuffer> {
  const rawKey = typeof key === 'string' ? new TextEncoder().encode(key) : key
  const k      = await crypto.subtle.importKey('raw', rawKey, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  return crypto.subtle.sign('HMAC', k, new TextEncoder().encode(data))
}

async function deriveSigningKey(secret: string, date: string, region: string, service: string): Promise<ArrayBuffer> {
  const kDate    = await hmacBuf('AWS4' + secret, date)
  const kRegion  = await hmacBuf(kDate, region)
  const kService = await hmacBuf(kRegion, service)
  return hmacBuf(kService, 'aws4_request')
}

// ─── Dispatch al provider corretto ───────────────────────────────

async function dispatchMail(
  msg:   MailMessage,
  props: Record<string, unknown>,
): Promise<void> {
  const p        = (k: string, d = '') => String(props[k] ?? d)
  const provider = p('provider', 'smtp')

  switch (provider) {
    case 'smtp': {
      const cfg: SmtpConfig = {
        host:     p('smtpHost', 'localhost'),
        port:     parseInt(p('smtpPort', '587'), 10),
        user:     p('smtpUser'),
        pass:     p('smtpPass'),
        security: (p('smtpSecurity', 'starttls') as SmtpConfig['security']),
      }
      return sendSmtp(msg, cfg)
    }
    case 'sendgrid':
      return sendSendGrid(msg, p('apiKey'))

    case 'mailgun':
      return sendMailgun(msg, p('apiKey'), p('mailgunDomain'))

    case 'ses':
      return sendSes(msg, p('apiKey'), p('awsSecretKey'), p('awsRegion', 'eu-west-1'))

    default:
      throw new Error(`MailSink: provider '${provider}' non supportato`)
  }
}

// ─── Executor ─────────────────────────────────────────────────────

export const mailSinkExecutor: NodeExecutor = {
  handles: ['mail_sink'],
  requiresCompleteInput: (node) => {
    const sendMode = String(node.data.props?.['sendMode'] ?? 'per_row')
    return sendMode === 'batch'
  },
  async execute(
    node:    FlowNode<NodeData>,
    input:   Row[],
    context: ExecutionContext,
  ): Promise<Map<string, Row[]>> {

    const props    = node.data.props ?? {}
    const p        = (k: string, d = '') => String(props[k] ?? d)
    const sendMode = p('sendMode', 'per_row')
    const provider = p('provider', 'smtp')
    const fromEmail = p('fromEmail')
    const fromName  = p('fromName', 'FlowPilot')
    const from      = fromName ? `${fromName} <${fromEmail}>` : fromEmail
    const retryCount = Math.max(0, Math.min(5, parseInt(p('retryCount', '2'), 10)))

    if (input.length === 0) {
      context.callbacks.onLog('warn', 'MailSink: nessuna riga in ingresso', node.id)
      return new Map([['output', []]])
    }

    if (!fromEmail) throw new Error('MailSink: email mittente non configurata')

    context.callbacks.onLog('info',
      `MailSink [${provider}] — modalità ${sendMode} · ${input.length} righe`,
      node.id,
    )

    let sent = 0, errors = 0

    // ── Modalità batch: una sola email con tutte le righe ─────────
    if (sendMode === 'batch') {
      // Per batch usa la prima riga per destinatari e oggetto,
      // il corpo è la concatenazione di tutte le righe
      const firstRow = input[0]
      const { to, cc, bcc } = buildRecipients(props, firstRow)

      if (to.length === 0) {
        context.callbacks.onLog('warn', 'MailSink batch: nessun destinatario', node.id)
        return new Map([['output', []]])
      }

      const subject  = interpolate(p('subject', 'Report'), firstRow)
      const bodyRows = input.map(row => buildBody(props, row))

      // Aggrega i corpi: se HTML li concatena, se text idem
      const allHtml = bodyRows.map(b => b.html).filter(Boolean).join('\n<hr/>\n')
      const allText = bodyRows.map(b => b.text).filter(Boolean).join('\n---\n')

      const attachment = buildAttachment(props, firstRow)
      const msg: MailMessage = {
        from, to, cc, bcc, subject,
        html: allHtml || undefined,
        text: allText || undefined,
        attachments: attachment ? [attachment] : undefined,
        priority: p('priority', 'normal') as MailMessage['priority'],
      }

      let ok = false
      for (let attempt = 0; attempt <= retryCount && !ok; attempt++) {
        try {
          await dispatchMail(msg, props)
          ok = true
          sent++
        } catch (err) {
          if (attempt < retryCount) {
            context.callbacks.onLog('warn', `MailSink batch: tentativo ${attempt + 1} fallito, riprovo...`, node.id)
            await new Promise(r => setTimeout(r, 1000 * (attempt + 1)))
          } else {
            errors++
            throw new Error(`MailSink batch: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
    } else {
      // ── Modalità per_row: una email per riga ──────────────────
      for (const row of input) {
        if (context.callbacks.isAborted()) break

        const { to, cc, bcc } = buildRecipients(props, row)
        if (to.length === 0) {
          context.callbacks.onLog('warn', 'MailSink: riga senza destinatario — saltata', node.id)
          continue
        }

        const subject    = interpolate(p('subject', 'Notifica'), row)
        const body       = buildBody(props, row)
        const attachment = buildAttachment(props, row)

        const msg: MailMessage = {
          from, to, cc, bcc, subject,
          html: body.html,
          text: body.text,
          attachments: attachment ? [attachment] : undefined,
          priority: p('priority', 'normal') as MailMessage['priority'],
        }

        let ok = false
        for (let attempt = 0; attempt <= retryCount && !ok; attempt++) {
          try {
            await dispatchMail(msg, props)
            ok = true
            sent++
          } catch (err) {
            if (attempt < retryCount) {
              await new Promise(r => setTimeout(r, 500 * (attempt + 1)))
            } else {
              errors++
              context.callbacks.onLog('error',
                `MailSink: errore invio a ${to.join(',')} — ${err instanceof Error ? err.message : String(err)}`,
                node.id,
              )
              if (p('onError', 'continue') === 'stop') {
                throw new Error(`MailSink: invio fallito — ${err instanceof Error ? err.message : String(err)}`)
              }
            }
          }
        }
      }
    }

    context.callbacks.onLog('info',
      `MailSink: ${sent} email inviate, ${errors} errori`,
      node.id,
    )

    return new Map([['output', [{
      _mail_sent:   sent,
      _mail_errors: errors,
      provider,
      completed_at: new Date().toISOString(),
    }]]])
  },
}
