/**
 * src/nodes/WebhookNode.tsx
 *
 * Componente React Flow dedicato per i tre nodi webhook.
 * Mostra stato live, contatore buffer, e path/URL configurato.
 *
 * Registrare in LaneCanvas.tsx nodeTypes:
 *   webhookReceiverNode:  WebhookReceiverNode,
 *   webhookResponderNode: WebhookResponderNode,
 *   watchdogNode:         WatchdogNode,
 *
 * E in addNode del flowStore aggiungere i mapping rfType:
 *   type === 'webhook_receiver'  ? 'webhookReceiverNode'  :
 *   type === 'webhook_responder' ? 'webhookResponderNode' :
 *   type === 'watchdog'          ? 'watchdogNode'         :
 */

import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import type { NodeData } from '../types'
import { NodeRuntimeBadges } from './RuntimeBadges'

// ─── Stili comuni ─────────────────────────────────────────────────

const baseNode: React.CSSProperties = {
  borderRadius: 8,
  minWidth: 180,
  maxWidth: 220,
  fontSize: 11,
  fontFamily: "'JetBrains Mono', monospace",
  boxShadow: '0 4px 16px rgba(0,0,0,.5)',
  userSelect: 'none',
  position: 'relative',
}

function StatusDot({ status }: { status: string }) {
  const colors: Record<string, string> = {
    idle:      '#2a3349',
    running:   '#3ddc84',
    ok:        '#3ddc84',
    error:     '#ff5f57',
    warn:      '#ffb347',
    listening: '#4a9eff',
    waiting:   '#ffb347',
  }
  const color = colors[status] ?? '#2a3349'
  return (
    <div style={{
      width: 7, height: 7, borderRadius: '50%',
      background: color, flexShrink: 0,
      boxShadow: status === 'running' || status === 'listening'
        ? `0 0 6px ${color}` : 'none',
    }} />
  )
}

function NodeBadge({ label, color }: { label: string; color: string }) {
  return (
    <span style={{
      fontSize: 9, padding: '1px 5px', borderRadius: 4,
      background: `color-mix(in srgb, ${color} 20%, #0f1117)`,
      color, border: `0.5px solid ${color}40`,
      fontWeight: 700, letterSpacing: '.04em',
    }}>{label}</span>
  )
}

// ─── Webhook Receiver ─────────────────────────────────────────────

const RECV_COLOR = '#3ddc84'

export const WebhookReceiverNode = memo(({ id, data }: NodeProps) => {
  const nodeData  = data as NodeData
  const props     = nodeData.props ?? {}
  const path      = String(props['path'] ?? '/webhook')
  const port      = String(props['port'] ?? '9110')
  const hmacOn    = Boolean(props['hmacSecret'])
  const maxBuf    = String(props['maxBuffer'] ?? '1000')
  const status    = nodeData.status ?? 'idle'
  const label     = (nodeData.config?.displayName as string) || nodeData.label || 'Webhook Receiver'

  return (
    <div style={{
      ...baseNode,
      background: '#161b27',
      border: `1.5px solid ${status === 'running' ? RECV_COLOR : '#2a3349'}`,
    }}>
      {/* Header */}
      <div style={{
        padding: '7px 10px',
        background: `color-mix(in srgb, ${RECV_COLOR} 8%, #1a2030)`,
        borderBottom: `1px solid ${RECV_COLOR}20`,
        borderRadius: '6px 6px 0 0',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <StatusDot status={status === 'running' ? 'listening' : status} />
        <i className="ti ti-webhook" style={{ fontSize: 13, color: RECV_COLOR }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: 11, color: '#c8d4f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <NodeBadge label="RECV" color={RECV_COLOR} />
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {/* Path + porta */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-link" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
          <code style={{ fontSize: 10, color: RECV_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            :{port}{path}
          </code>
        </div>

        {/* HMAC */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-shield" style={{
            fontSize: 10,
            color: hmacOn ? '#3ddc84' : '#2a3349',
            flexShrink: 0,
          }} />
          <span style={{ fontSize: 9, color: hmacOn ? '#7a9aaa' : '#2a3349' }}>
            {hmacOn ? 'HMAC verificato' : 'nessuna firma'}
          </span>
        </div>

        {/* Buffer */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-stack" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
          <span style={{ fontSize: 9, color: '#4a5a7a' }}>buffer max {maxBuf}</span>
        </div>

        {/* Stato */}
        {nodeData.statusMessage && (
          <div style={{
            fontSize: 9, color: status === 'error' ? '#ff5f57' : '#4a9eff',
            padding: '2px 5px', background: '#0f1117', borderRadius: 3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {nodeData.statusMessage}
          </div>
        )}
      </div>

      {/* Handle output — a destra */}
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{ background: RECV_COLOR, border: '2px solid #161b27', width: 10, height: 10 }}
      />
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})

WebhookReceiverNode.displayName = 'WebhookReceiverNode'

// ─── Webhook Responder ────────────────────────────────────────────

const RESP_COLOR = '#4a9eff'

export const WebhookResponderNode = memo(({ id, data }: NodeProps) => {
  const nodeData = data as NodeData
  const props   = nodeData.props ?? {}
  const path    = String(props['path'] ?? '/status')
  const port    = String(props['port'] ?? '9111')
  const methods = String(props['methods'] ?? 'HEAD,GET')
  const status  = nodeData.status ?? 'idle'
  const label   = (nodeData.config?.displayName as string) || nodeData.label || 'Webhook Responder'

  // Mostra anteprima header template
  let headerPreview = ''
  try {
    const tpl = JSON.parse(String(props['headerTemplate'] ?? '{}'))
    headerPreview = Object.keys(tpl).slice(0, 2).join(', ')
    if (Object.keys(tpl).length > 2) headerPreview += '…'
  } catch {}

  return (
    <div style={{
      ...baseNode,
      background: '#161b27',
      border: `1.5px solid ${status === 'running' ? RESP_COLOR : '#2a3349'}`,
    }}>
      {/* Handle input — a sinistra */}
      <Handle
        type="target"
        position={Position.Left}
        id="input"
        style={{ background: RESP_COLOR, border: '2px solid #161b27', width: 10, height: 10 }}
      />

      {/* Header */}
      <div style={{
        padding: '7px 10px',
        background: `color-mix(in srgb, ${RESP_COLOR} 8%, #1a2030)`,
        borderBottom: `1px solid ${RESP_COLOR}20`,
        borderRadius: '6px 6px 0 0',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <StatusDot status={status === 'running' ? 'listening' : status} />
        <i className="ti ti-antenna" style={{ fontSize: 13, color: RESP_COLOR }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: 11, color: '#c8d4f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <NodeBadge label="RESP" color={RESP_COLOR} />
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-link" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
          <code style={{ fontSize: 10, color: RESP_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            :{port}{path}
          </code>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-http-get" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
          <span style={{ fontSize: 9, color: '#4a5a7a' }}>{methods}</span>
        </div>
        {headerPreview && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <i className="ti ti-braces" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
            <span style={{ fontSize: 9, color: '#9a9aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {headerPreview}
            </span>
          </div>
        )}
        {nodeData.statusMessage && (
          <div style={{
            fontSize: 9, color: status === 'error' ? '#ff5f57' : RESP_COLOR,
            padding: '2px 5px', background: '#0f1117', borderRadius: 3,
          }}>
            {nodeData.statusMessage}
          </div>
        )}
      </div>

      {/* Handle output — a destra (pass-through) */}
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{ background: RESP_COLOR, border: '2px solid #161b27', width: 10, height: 10 }}
      />
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})

WebhookResponderNode.displayName = 'WebhookResponderNode'

// ─── Watchdog ─────────────────────────────────────────────────────

const WD_COLOR = '#ffb347'

export const WatchdogNode = memo(({ id, data }: NodeProps) => {
  const nodeData   = data as NodeData
  const props      = nodeData.props ?? {}
  const url        = String(props['url'] ?? '')
  const headerName = String(props['headerName'] ?? 'X-Data-Ready')
  const headerVal  = String(props['headerValue'] ?? 'true')
  const intervalSec = String(props['intervalSec'] ?? '30')
  const status     = nodeData.status ?? 'idle'
  const label      = (nodeData.config?.displayName as string) || nodeData.label || 'Watchdog'

  // Tronca l'URL per la visualizzazione
  let urlShort = url
  try {
    const u = new URL(url)
    urlShort = u.hostname + (u.port ? `:${u.port}` : '') + u.pathname
  } catch {}

  const statusIcon = status === 'running'  ? 'ti-loader'
                   : status === 'ok'       ? 'ti-circle-check'
                   : status === 'error'    ? 'ti-circle-x'
                   : 'ti-eye'

  return (
    <div style={{
      ...baseNode,
      background: '#161b27',
      border: `1.5px solid ${status === 'running' ? WD_COLOR : '#2a3349'}`,
    }}>
      {/* Handle input — a sinistra (opzionale — può ricevere righe da passare a valle) */}
      <Handle
        type="target"
        position={Position.Left}
        id="input"
        style={{ background: WD_COLOR, border: '2px solid #161b27', width: 10, height: 10 }}
      />

      {/* Header */}
      <div style={{
        padding: '7px 10px',
        background: `color-mix(in srgb, ${WD_COLOR} 8%, #1a2030)`,
        borderBottom: `1px solid ${WD_COLOR}20`,
        borderRadius: '6px 6px 0 0',
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <StatusDot status={status === 'running' ? 'waiting' : status} />
        <i className={`ti ${statusIcon}${status === 'running' ? ' spin' : ''}`}
          style={{ fontSize: 13, color: WD_COLOR }} />
        <span style={{ flex: 1, fontWeight: 600, fontSize: 11, color: '#c8d4f0', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <NodeBadge label="WD" color={WD_COLOR} />
      </div>

      {/* Body */}
      <div style={{ padding: '8px 10px', display: 'flex', flexDirection: 'column', gap: 5 }}>
        {/* URL */}
        {urlShort ? (
          <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
            <i className="ti ti-world" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
            <code style={{ fontSize: 9, color: WD_COLOR, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {urlShort}
            </code>
          </div>
        ) : (
          <div style={{ fontSize: 9, color: '#2a3349', fontStyle: 'italic' }}>URL non configurato</div>
        )}

        {/* Condizione attesa */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-circle-check" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
          <span style={{ fontSize: 9, color: '#9a9aaa', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <span style={{ color: WD_COLOR }}>{headerName}</span>
            {': '}
            <span style={{ color: '#c8d4f0' }}>{headerVal}</span>
          </span>
        </div>

        {/* Intervallo */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <i className="ti ti-clock" style={{ fontSize: 10, color: '#4a5a7a', flexShrink: 0 }} />
          <span style={{ fontSize: 9, color: '#4a5a7a' }}>ogni {intervalSec}s</span>
        </div>

        {/* Status message */}
        {nodeData.statusMessage && (
          <div style={{
            fontSize: 9, color: status === 'error' ? '#ff5f57' : status === 'ok' ? '#3ddc84' : WD_COLOR,
            padding: '2px 5px', background: '#0f1117', borderRadius: 3,
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>
            {nodeData.statusMessage}
          </div>
        )}
      </div>

      {/* Handle output — a destra */}
      <Handle
        type="source"
        position={Position.Right}
        id="output"
        style={{ background: WD_COLOR, border: '2px solid #161b27', width: 10, height: 10 }}
      />
    {/* Fase 8: contatori runtime */}
      <NodeRuntimeBadges nodeId={id} />
    </div>
  )
})

WatchdogNode.displayName = 'WatchdogNode'