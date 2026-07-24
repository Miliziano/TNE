/**
 * src/nodes/types/dir_watcher/SidebarPanel.tsx
 */
import { useMemo } from 'react'
import { useFlowStore } from '../../../store/flowStore'
import type { Variable } from '../../../types'
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

const ACCENT = '#22d3ee'

export function DirWatcherSidebarPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const edges      = useFlowStore((s) => s.edges)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const mode       = p('mode', 'scan')
  const pathSource = p('pathSource', 'static')
  const hasInput   = edges.some((e) => e.target === nodeId)

  const laneVars: Variable[] = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === node.data.laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'string' || v.type === 'object')
  }, [pool, node.data.laneId])

  const sourceLabel =
    pathSource === 'lane_var' ? '◎ Variabile Lane' :
    pathSource === 'flow'     ? '→ Da flusso'      :
    '📁 Statico'

  const sourceBadgeColor =
    pathSource === 'lane_var' ? '#a78bfa' :
    pathSource === 'flow'     ? '#4a9eff' :
    ACCENT

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* Badge modalità + sorgente */}
      <div style={{ display: 'flex', gap: 6 }}>
        <div style={{
          flex: 1, padding: '5px 8px', borderRadius: 6,
          background: `color-mix(in srgb, ${ACCENT} 10%, #1a2030)`,
          border: `0.5px solid ${ACCENT}40`,
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          <span style={{ fontSize: 11, color: ACCENT }}>
            {mode === 'scan' ? '⊞' : '👁'}
          </span>
          <span style={{ fontSize: 10, color: ACCENT, fontWeight: 600 }}>
            {mode === 'scan' ? 'Scan' : 'Watch'}
          </span>
        </div>
        <div style={{
          flex: 1, padding: '5px 8px', borderRadius: 6,
          background: `color-mix(in srgb, ${sourceBadgeColor} 10%, #1a2030)`,
          border: `0.5px solid ${sourceBadgeColor}40`,
          display: 'flex', alignItems: 'center', gap: 5,
        }}>
          <div style={{ width: 6, height: 6, borderRadius: '50%', background: sourceBadgeColor, flexShrink: 0 }} />
          <span style={{ fontSize: 10, color: sourceBadgeColor, fontWeight: 600 }}>{sourceLabel}</span>
        </div>
      </div>

      {/* Campo sorgente path */}
      {pathSource === 'static' && (
        <Field label="Directory">
          <input type="text" style={inputStyle} value={p('directory')} onChange={u('directory')}
            placeholder="/data/incoming" />
        </Field>
      )}

      {pathSource === 'lane_var' && (
        <Field label="Variabile Lane">
          {laneVars.length > 0 ? (
            <CustomSelect style={inputStyle} value={p('laneVarName')} onChange={u('laneVarName')}>
              <option value="">— seleziona —</option>
              {laneVars.map((v) => (
                <option key={v.id} value={v.name}>
                  {v.name}{v.value ? ` = "${v.value}"` : ''}
                </option>
              ))}
            </CustomSelect>
          ) : (
            <div style={{ fontSize: 10, color: '#ff5f57', fontStyle: 'italic', padding: '4px 0' }}>
              Nessuna variabile stringa nella lane
            </div>
          )}
        </Field>
      )}

      {pathSource === 'flow' && (
        <Field label="Campo path dal flusso" hint={!hasInput ? '⚠ Nessun edge in ingresso' : undefined}>
          <input style={{ ...inputStyle, borderColor: !hasInput ? '#ff5f57' : '#3a4a6a' }}
            value={p('pathField', 'path')} onChange={u('pathField')} placeholder="path" />
        </Field>
      )}

      {/* Preview path */}
      {(() => {
        const preview =
          pathSource === 'static'   ? p('directory') :
          pathSource === 'lane_var' ? (p('laneVarName') ? `var("${p('laneVarName')}")` : null) :
          pathSource === 'flow'     ? (p('pathField')   ? `row.${p('pathField')}`             : null) :
          null
        if (!preview) return null
        return (
          <div style={{ padding: '4px 8px', background: '#0f1117', borderRadius: 4, border: `0.5px solid ${ACCENT}20`, display: 'flex', gap: 5, alignItems: 'center' }}>
            <i className="ti ti-arrow-right" style={{ fontSize: 9, color: ACCENT, flexShrink: 0 }} />
            <code style={{ fontSize: 10, color: ACCENT, fontFamily: 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {preview}
            </code>
          </div>
        )
      })()}

      {/* Pattern glob */}
      <Field label="Pattern file">
        <input style={inputStyle} value={p('pattern', '*')} onChange={u('pattern')} placeholder="*.csv" />
      </Field>

      {/* Modalità */}
      <div style={{ display: 'flex', gap: 4 }}>
        {[
          { value: 'scan',  label: '⊞ Scan'  },
          { value: 'watch', label: '👁 Watch' },
        ].map((m) => (
          <button key={m.value} onClick={() => updateProp(nodeId, 'mode', m.value)}
            style={{
              flex: 1, padding: '5px 8px', borderRadius: 4, cursor: 'pointer', fontSize: 10,
              background: mode === m.value ? `color-mix(in srgb, ${ACCENT} 15%, #1a2030)` : '#1a2030',
              border: mode === m.value ? `1px solid ${ACCENT}` : '1px solid #2a3349',
              color: mode === m.value ? ACCENT : '#4a5a7a',
              fontWeight: mode === m.value ? 600 : 400,
            }}>
            {m.label}
          </button>
        ))}
      </div>

      <div style={{ fontSize: 10, color: '#4a5a7a', padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 5 }}>
        <i className="ti ti-mouse" style={{ fontSize: 11 }} />
        Doppio click per la configurazione completa
      </div>
    </div>
  )
}
