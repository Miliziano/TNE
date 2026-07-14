/**
 * src/components/ProblemsPanel.tsx
 *
 * Vista Problems del dock inferiore: lista aggregata di tutti gli issue di
 * validazione (uiState.issues di ogni nodo), raggruppata per lane → nodo,
 * errori prima dei warning, con barra riepilogo/filtro. Click su una riga →
 * seleziona il nodo (v1; il centraggio del canvas arriva nel pezzo successivo).
 *
 * collectProblems / problemsToText / problemsToNdjson sono esportati anche per
 * i pulsanti di export nella barra del BottomDock.
 */
import { useMemo, useState } from 'react'
import { useFlowStore } from '../store/flowStore'
import type { Node as FlowNode } from '@xyflow/react'
import type { NodeData, Pool } from '../types'

const RED    = '#ff5f57'
const ORANGE = '#ffb347'

export interface Problem {
  nodeId:    string
  nodeLabel: string
  laneId:    string
  laneLabel: string
  severity:  string
  message:   string
  code:      string
  hint?:     string
}

const sevRank = (s: string) => (s === 'error' ? 0 : s === 'warning' ? 1 : 2)

export function collectProblems(nodes: FlowNode<NodeData>[], pool?: Pool): Problem[] {
  const laneLabel = (id: string) =>
    pool?.lanes.find((l) => l.id === id)?.label ?? id ?? '—'
  const out: Problem[] = []
  for (const n of nodes) {
    const ui = (n.data as any)?.uiState
    const issues = ui?.issues as Array<{ severity: string; message: string; code: string; hint?: string }> | undefined
    if (!issues?.length) continue
    const nodeLabel = String((n.data as any)?.label ?? (n.data as any)?.config?.displayName ?? n.id)
    const laneId    = String((n.data as any)?.laneId ?? '')
    for (const i of issues) {
      out.push({ nodeId: n.id, nodeLabel, laneId, laneLabel: laneLabel(laneId), ...i })
    }
  }
  // errori prima, poi per lane, poi per nodo
  return out.sort((a, b) =>
    sevRank(a.severity) - sevRank(b.severity) ||
    a.laneLabel.localeCompare(b.laneLabel) ||
    a.nodeLabel.localeCompare(b.nodeLabel))
}

export function problemsToText(list: Problem[]): string {
  return list.map((p) =>
    `[${p.severity}] ${p.laneLabel} · ${p.nodeLabel} — ${p.message}`).join('\n')
}

export function problemsToNdjson(list: Problem[]): string {
  return list.map((p) => JSON.stringify({
    severity: p.severity, lane: p.laneLabel, node: p.nodeLabel,
    code: p.code, message: p.message, hint: p.hint,
  })).join('\n')
}

type Filter = 'all' | 'error' | 'warning'

export function ProblemsView() {
  const nodes      = useFlowStore((s) => s.nodes)
  const pool       = useFlowStore((s) => s.pool)
  const selectNode = useFlowStore((s) => s.selectNode)
  const selectedId = useFlowStore((s) => s.selectedNodeId)

  const all = useMemo(() => collectProblems(nodes, pool), [nodes, pool])

  const [filter, setFilter]     = useState<Filter>('all')
  const [collapsed, setColl]    = useState<Set<string>>(new Set())

  const errorCount   = all.filter((p) => p.severity === 'error').length
  const warningCount = all.filter((p) => p.severity === 'warning').length

  const shown = filter === 'all' ? all : all.filter((p) => p.severity === filter)

  // raggruppa per lane
  const byLane = useMemo(() => {
    const m = new Map<string, Problem[]>()
    for (const p of shown) {
      const k = p.laneId || '—'
      m.set(k, [...(m.get(k) ?? []), p])
    }
    return [...m.entries()]
  }, [shown])

  const toggleLane = (id: string) =>
    setColl((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })

  if (all.length === 0) {
    return (
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', flexDirection: 'column', gap: 8, color: '#3ddc84', fontSize: 12 }}>
        <i className="ti ti-circle-check" style={{ fontSize: 22, opacity: 0.8 }} />
        Nessun problema — tutto validato
      </div>
    )
  }

  const chip = (id: Filter, label: string, color: string) => (
    <button onClick={() => setFilter(id)}
      style={{
        background: filter === id ? `${color}22` : 'transparent',
        border: `1px solid ${filter === id ? color + '80' : '#2a3349'}`,
        borderRadius: 4, padding: '1px 8px', cursor: 'pointer',
        fontSize: 10, color: filter === id ? color : '#7a8aa8', fontFamily: 'inherit',
      }}>
      {label}
    </button>
  )

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {/* Barra riepilogo/filtro */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', borderBottom: '0.5px solid #2a3349', flexShrink: 0 }}>
        {chip('all', `Tutti ${all.length}`, '#4a9eff')}
        {chip('error', `⛔ ${errorCount}`, RED)}
        {chip('warning', `⚠ ${warningCount}`, ORANGE)}
      </div>

      {/* Lista raggruppata */}
      <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
        {byLane.map(([laneId, items]) => {
          const laneLabel = items[0]?.laneLabel ?? laneId
          const isColl = collapsed.has(laneId)
          return (
            <div key={laneId}>
              <div onClick={() => toggleLane(laneId)}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '4px 10px', cursor: 'pointer', background: '#141a28', borderBottom: '0.5px solid #222a3d', position: 'sticky', top: 0 }}>
                <i className={`ti ${isColl ? 'ti-chevron-right' : 'ti-chevron-down'}`} style={{ fontSize: 11, color: '#4a5a7a' }} />
                <span style={{ fontSize: 10, fontWeight: 600, color: '#8a9ac0', textTransform: 'uppercase', letterSpacing: '.05em' }}>{laneLabel}</span>
                <span style={{ fontSize: 10, color: '#4a5a7a' }}>{items.length}</span>
              </div>
              {!isColl && items.map((p, i) => {
                const color = p.severity === 'error' ? RED : ORANGE
                const active = p.nodeId === selectedId
                return (
                  <div key={`${p.nodeId}-${p.code}-${i}`}
                    onClick={() => selectNode(p.nodeId)}
                    title={p.hint ?? ''}
                    style={{
                      display: 'flex', alignItems: 'flex-start', gap: 7, padding: '5px 10px 5px 24px',
                      cursor: 'pointer', fontSize: 11, lineHeight: 1.4,
                      background: active ? '#1e2740' : 'transparent',
                      borderLeft: active ? `2px solid ${color}` : '2px solid transparent',
                    }}
                    onMouseEnter={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = '#1a2030' }}
                    onMouseLeave={(e) => { if (!active) (e.currentTarget as HTMLElement).style.background = 'transparent' }}>
                    <i className={`ti ${p.severity === 'error' ? 'ti-alert-circle' : 'ti-alert-triangle'}`}
                       style={{ fontSize: 12, color, flexShrink: 0, marginTop: 1 }} />
                    <span style={{ color: '#8a9ac0', flexShrink: 0, fontWeight: 500 }}>{p.nodeLabel}</span>
                    <span style={{ color: '#c8d4f0', flex: 1 }}>{p.message}</span>
                  </div>
                )
              })}
            </div>
          )
        })}
        {shown.length === 0 && (
          <div style={{ padding: '16px', textAlign: 'center', color: '#4a5a7a', fontSize: 11 }}>
            Nessun elemento per questo filtro.
          </div>
        )}
      </div>
    </div>
  )
}
