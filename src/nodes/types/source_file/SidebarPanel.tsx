/**
 * src/nodes/types/source_file/SidebarPanel.tsx
 *
 * Pannello laterale destro per source_file.
 * Mostra un riassunto sincrono con la configurazione nel NodeEditorModal.
 * Reagisce a pathSource e mostra il campo corretto.
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

const ACCENT = '#4a9eff'

export function SourceFileSidebarPanel({ nodeId }: { nodeId: string }) {
  const node       = useFlowStore((s) => s.nodes.find((n) => n.id === nodeId))
  const updateProp = useFlowStore((s) => s.updateNodeProp)
  const edges      = useFlowStore((s) => s.edges)
  const pool       = useFlowStore((s) => s.pool)

  if (!node) return null

  const p = (key: string, def = '') => node.data.props[key] ?? def
  const u = (key: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) =>
    updateProp(nodeId, key, e.target.value)

  const pathSource = p('pathSource', 'static')
  const hasInput   = edges.some((e) => e.target === nodeId)
  const format     = p('format', 'csv')

  const laneVars: Variable[] = useMemo(() => {
    const lane = pool.lanes.find((l) => l.id === node.data.laneId)
    return (lane?.variables ?? []).filter((v) => v.type === 'string' || v.type === 'object')
  }, [pool, node.data.laneId])

  // Badge sorgente corrente
  const sourceLabel =
    pathSource === 'lane_var' ? '◎ Variabile Lane' :
    pathSource === 'flow'     ? '→ Da flusso'      :
    '📄 Statico'

  const sourceBadgeColor =
    pathSource === 'lane_var' ? '#a78bfa' :
    pathSource === 'flow'     ? '#22d3ee' :
    ACCENT

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* Badge sorgente path */}
      <div style={{
        padding: '5px 10px', borderRadius: 6,
        background: `color-mix(in srgb, ${sourceBadgeColor} 10%, #1a2030)`,
        border: `0.5px solid ${sourceBadgeColor}40`,
        display: 'flex', alignItems: 'center', gap: 6,
      }}>
        <div style={{ width: 6, height: 6, borderRadius: '50%', background: sourceBadgeColor, flexShrink: 0 }} />
        <span style={{ fontSize: 10, color: sourceBadgeColor, fontWeight: 600 }}>{sourceLabel}</span>
        <span style={{ fontSize: 10, color: '#4a5a7a', marginLeft: 'auto' }}>
          {format.toUpperCase()}
        </span>
      </div>

      {/* Campo dinamico in base a pathSource */}
      {pathSource === 'static' && (
        <Field label="Percorso" hint="Path assoluto o relativo">
          <input type="text" style={inputStyle} value={p('path')} onChange={u('path')}
            placeholder="/data/input.csv" />
        </Field>
      )}

      {pathSource === 'lane_var' && (
        <Field label="Variabile Lane" hint="Variabile che contiene il path">
          {laneVars.length > 0 ? (
            <CustomSelect style={inputStyle} value={p('laneVarName')} onChange={u('laneVarName')}>
              <option value="">— seleziona variabile —</option>
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
        <Field
          label="Campo path dal flusso"
          hint={hasInput ? 'Campo della riga con il path del file' : '⚠ Nessun edge in ingresso'}
        >
          <input style={{
            ...inputStyle,
            borderColor: !hasInput ? '#ff5f57' : '#3a4a6a',
          }}
            value={p('pathField', 'path')} onChange={u('pathField')}
            placeholder="path" />
        </Field>
      )}

      {/* Preview path effettivo */}
      {(() => {
        const preview =
          pathSource === 'static'   ? p('path') :
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

      {/* Formato + limite — campi rapidi sempre utili */}
      <Field label="Formato">
        <CustomSelect style={inputStyle} value={format} onChange={u('format')}>
          {['csv', 'json', 'jsonl', 'parquet', 'tsv', 'xml', 'excel'].map((f) => (
            <option key={f} value={f}>{f.toUpperCase()}</option>
          ))}
        </CustomSelect>
      </Field>

      {(format === 'csv' || format === 'tsv') && (
        <Field label="Separatore">
          <input type="text" style={inputStyle}
            value={p('delimiter', ',')} onChange={u('delimiter')} placeholder="," />
        </Field>
      )}

      <Field label="Limite righe" hint="0 = tutte">
        <input type="number" style={inputStyle}
          value={p('limit', '0')} onChange={u('limit')} min="0" />
      </Field>

      {/* Link all'editor completo */}
      <div style={{ fontSize: 10, color: '#4a5a7a', padding: '4px 6px', display: 'flex', alignItems: 'center', gap: 5 }}>
        <i className="ti ti-mouse" style={{ fontSize: 11 }} />
        Doppio click per la configurazione completa
      </div>
    </div>
  )
}
