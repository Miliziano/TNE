// ─── src/nodes/RuntimeBadges.tsx ──────────────────────────────────
//
// Badge runtime condivisi tra TUTTI i tipi di nodo (Fase 8).
// FlowNode li usava in locale; estratti qui perché anche i custom
// node (TMapNode, FilterNode, JoinNode, UnionNode, parser/serializer,
// SequencerNode, ErrorHandlerNode, Bridge, Webhook) possano mostrarli.
//
// USO — in ogni componente nodo, dentro il div radice (che deve avere
// position: 'relative', cosa già vera ovunque ci siano gli Handle):
//
//   import { NodeRuntimeBadges, useNodeRunStats, StatusDot } from './RuntimeBadges'
//   ...
//   <NodeRuntimeBadges nodeId={id} />        // badge contatori sotto il nodo
//
// e, se il componente ha un pallino di stato proprio nell'header:
//
//   const stats = useNodeRunStats(id)
//   const runStatus = stats?.status ?? nodeData.status
//   <StatusDot status={runStatus} />

import { useFlowStore } from '../store/flowStore'
import type { NodeRunStats } from '../store/flowStore'
import type { NodeStatus } from '../types'

export const RUNTIME_STATUS_COLORS: Record<NodeStatus, string> = {
  idle:    '#4a5a7a',
  running: '#ffb347',
  done:    '#3ddc84',
  error:   '#ff5f57',
  warning: '#ffb347',
  ok:      '#3ddc84',
}

// ─── StatusDot ─────────────────────────────────────────────────────
// Pallino stato runtime: grigio (idle) / giallo pulse (running) /
// verde (done|ok) / rosso (error).
export function StatusDot({ status }: { status: NodeStatus }) {
  return (
    <div style={{
      width: 7, height: 7, borderRadius: '50%',
      background: RUNTIME_STATUS_COLORS[status] ?? '#4a5a7a',
      flexShrink: 0,
      animation: status === 'running' ? 'nodePulse 0.6s infinite' : undefined,
      boxShadow: status === 'running' ? `0 0 6px ${RUNTIME_STATUS_COLORS.running}` : undefined,
    }} />
  )
}

// ─── Formatter ─────────────────────────────────────────────────────
export function fmtRows(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 10_000)    return `${Math.round(n / 1_000)}k`
  if (n >= 1_000)     return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}

export function fmtElapsed(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`
  if (ms >= 1_000)  return `${(ms / 1_000).toFixed(1)}s`
  return `${ms}ms`
}

// ─── CounterBadge ──────────────────────────────────────────────────
// Badge contatori sotto il nodo: righe in ingresso / uscita + tempo.
// Visibile solo quando il nodo ha prodotto/consumato qualcosa o gira.
export function CounterBadge({ stats }: { stats: NodeRunStats }) {
  const active = stats.status !== 'idle' || stats.rowsIn > 0 || stats.rowsOut > 0
  if (!active) return null
  const color = RUNTIME_STATUS_COLORS[stats.status] ?? '#4a5a7a'
  return (
    <div style={{
      position: 'absolute', bottom: -22, left: '50%', transform: 'translateX(-50%)',
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '1px 8px', borderRadius: 8, whiteSpace: 'nowrap',
      background: `color-mix(in srgb, ${color} 12%, #0f1117)`,
      border: `1px solid ${color}50`,
      fontFamily: 'monospace', fontSize: 9, fontWeight: 600, color,
      zIndex: 9, cursor: 'default', userSelect: 'none', pointerEvents: 'none',
    }}>
      <span title="righe in ingresso">↓ {fmtRows(stats.rowsIn)}</span>
      <span title="righe in uscita">↑ {fmtRows(stats.rowsOut)}</span>
      {stats.elapsedMs != null && stats.elapsedMs > 0 && (
        <span style={{ opacity: 0.75 }}>{fmtElapsed(stats.elapsedMs)}</span>
      )}
    </div>
  )
}

// ─── Hook — stats runtime del nodo ─────────────────────────────────
// Sottoscrive SOLO la entry di questo nodo: gli altri nodi non
// ri-renderizzano durante il polling.
export function useNodeRunStats(nodeId: string): NodeRunStats | undefined {
  return useFlowStore((s) => s.nodeStats[nodeId])
}

// ─── Wrapper drop-in ───────────────────────────────────────────────
// Da inserire come UNICA riga dentro il div radice di ogni custom
// node. Gestisce da solo sottoscrizione e visibilità.
export function NodeRuntimeBadges({ nodeId }: { nodeId: string }) {
  const stats = useNodeRunStats(nodeId)
  if (!stats) return null
  return <CounterBadge stats={stats} />
}
